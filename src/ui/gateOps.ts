// Gate creation / editing helpers working in plot display space.
import { autoGate1D, autoGate2D, DensityMap1D, DensityMap2D, EventGrid, histogram2D, type Seed1D, type Seed2D } from '../core/autogate';
import { engine } from '../core/engine';
import { gateEvalScales } from '../core/gating';
import { channelDisplayName, popById, popDescendants, uid, type GateGeom, type PlotItem, type PopProvenance, type PopScope, type Population, type Pt, type Workspace } from '../core/model';
import { markerName, quadrantName, rangeName } from '../core/naming';
import { inScope, resolvePopFor } from '../core/scope';
import { makeScale, type ScaleDef } from '../core/transforms';
import { addPopulation, applyFreezePlan, freezePlan, nextGateColor, uniquePopName, useStore, type EvalPair } from '../state/store';

export interface PlotAxes {
  xScale: ScaleDef;
  yScale: ScaleDef | null;
}

/** Scales a gate is evaluated in, per plot axis (null: not a display-space gate). */
export type EvalAxes = { x: ScaleDef; y: ScaleDef | null } | null;

const EDGE = 0.004; // display units: vertex placed just outside the window when snapped to the edge

/** raw value of a vertex snapped to an axis end: beyond the plot edge and, at a true axis end, beyond the gating scale's edge too */
function edgeRaw(plot: ScaleDef, ev: ScaleDef | null | undefined, hi: boolean): number {
  const p = makeScale(plot).inv(hi ? 1 + EDGE : -EDGE);
  // the inner edges of a zoom window are not axis ends
  if (!ev || (plot.type === 'window' && (hi ? plot.u1 < 1 : plot.u0 > 0))) return p;
  const e = makeScale(ev).inv(hi ? 1 + EDGE : -EDGE);
  return hi ? Math.max(p, e) : Math.min(p, e);
}

/** display (u,v) -> raw values of the plot's x/y parameters, snapping to the window edge (ev: gating scales per plot axis) */
export function toRaw(ax: PlotAxes, u: number, v: number, snapPx: { u: number; v: number }, ev?: EvalAxes): [number, number] {
  const sx = makeScale(ax.xScale);
  const sy = ax.yScale ? makeScale(ax.yScale) : null;
  const rx = u <= snapPx.u ? edgeRaw(ax.xScale, ev?.x, false) : u >= 1 - snapPx.u ? edgeRaw(ax.xScale, ev?.x, true) : sx.inv(u);
  if (!sy) return [rx, v];
  const ry = v <= snapPx.v ? edgeRaw(ax.yScale!, ev?.y, false) : v >= 1 - snapPx.v ? edgeRaw(ax.yScale!, ev?.y, true) : sy.inv(v);
  return [rx, ry];
}

/** like toRaw but returns +-Infinity beyond the edges (for rectangle/range bounds) */
export function toRawBound(scale: ScaleDef, u: number, snap: number): number {
  // in a zoomed view, only the true ends of the scale count as open bounds
  const loOpen = scale.type !== 'window' || scale.u0 <= 0;
  const hiOpen = scale.type !== 'window' || scale.u1 >= 1;
  if (u <= snap && loOpen) return -Infinity;
  if (u >= 1 - snap && hiOpen) return Infinity;
  return makeScale(scale).inv(u);
}

/** Gating scales of a gate (gate x / y order), or of a new gate on the plot's axes; null for gates evaluated on raw values. */
export function evalScalesOf(ws: Workspace, g: GateGeom, sampleId?: string | null): { x: ScaleDef; y: ScaleDef } | null {
  return g.type === 'polygon' || g.type === 'ellipse' ? gateEvalScales(g, (ch) => engine.scaleFor(ws, ch, sampleId)) : null;
}

/** Gating scales per plot axis for a new polygon / ellipse drawn on this plot (of the plot's sample's instrument). */
export function plotEvalAxes(ws: Workspace, item: PlotItem, sampleId?: string | null): EvalAxes {
  return { x: engine.scaleFor(ws, item.xParam, sampleId), y: item.plotType === 'histogram' ? null : engine.scaleFor(ws, item.yParam, sampleId) };
}

/** Name of a channel in gate names: the marker label ("CD4") when known, else a short channel name ("AF700"). */
export function axisName(ws: Workspace, ch: string): string {
  return markerName(ws, ch);
}

function nextName(ws: Workspace, prefix: string): string {
  const used = new Set(ws.populations.map((p) => p.name));
  let k = 1;
  while (used.has(`${prefix}${k}`)) k++;
  return `${prefix}${k}`;
}

/**
 * Parent of new gates: the population of the first visible layer (whose gates the plot shows). When that population
 * does not apply to the plot's sample, the population with the same path that does (group-specific gating trees).
 */
export function parentOf(item: PlotItem): string | null {
  const l = item.layers.find((x) => x.visible !== false);
  const p = l?.population ?? 'root';
  if (p === 'root') return null;
  const st = useStore.getState();
  const sid = l && l.sample !== 'active' ? l.sample : st.ui.activeSampleId;
  return sid ? resolvePopFor(st.ws, sid, p) : p;
}

/** Name and provenance of a gate made from an AI-chosen seed (one undo step with the gate). */
export interface PopExtra {
  name?: string;
  provenance?: PopProvenance;
}

function addPop(name: string, parent: string | null, gate: GateGeom, extra?: PopExtra): Population {
  if (!extra) return addPopulation(name, parent, gate);
  const st = useStore.getState();
  const pop: Population = { id: uid('pop'), name: uniquePopName(st.ws, extra.name?.trim() || name, parent), parentId: parent, gate, color: nextGateColor(st.ws) };
  if (extra.provenance) pop.provenance = extra.provenance;
  st.update((w) => {
    w.populations.push(pop);
  });
  return pop;
}

export function createPolygon(item: PlotItem, pts: Pt[], extra?: PopExtra): Population | null {
  if (pts.length < 3) return null;
  const ws = useStore.getState().ws;
  return addPop(nextName(ws, 'P'), parentOf(item), { type: 'polygon', x: item.xParam, y: item.yParam, points: pts }, extra);
}

export function createRect(item: PlotItem, xmin: number, xmax: number, ymin: number, ymax: number): Population {
  const ws = useStore.getState().ws;
  return addPopulation(nextName(ws, 'R'), parentOf(item), {
    type: 'rect',
    x: item.xParam,
    y: item.yParam,
    xmin: Math.min(xmin, xmax),
    xmax: Math.max(xmin, xmax),
    ymin: Math.min(ymin, ymax),
    ymax: Math.max(ymin, ymax),
  });
}

export function createEllipse(item: PlotItem, c: Pt, a: Pt, b: Pt): Population {
  const ws = useStore.getState().ws;
  return addPopulation(nextName(ws, 'E'), parentOf(item), { type: 'ellipse', x: item.xParam, y: item.yParam, center: c, a, b });
}

export { rangeName };

/** A range gate on the plot's x parameter, named by its position (see rangeName). `_sign` is no longer used. */
export function createRange(item: PlotItem, min: number, max: number, _sign?: '+' | '-', extra?: PopExtra): Population {
  void _sign;
  const ws = useStore.getState().ws;
  const label = axisName(ws, item.xParam);
  const [lo, hi] = [Math.min(min, max), Math.max(min, max)];
  return addPop(uniquePopName(ws, rangeName(label, lo, hi), parentOf(item)), parentOf(item), { type: 'range', x: item.xParam, min: lo, max: hi }, extra);
}

export function createSplit(item: PlotItem, cut: number): Population[] {
  const st = useStore.getState();
  const ws = st.ws;
  const parent = parentOf(item);
  const label = axisName(ws, item.xParam);
  const groupId = uid('split');
  const color = nextGateColor(ws);
  const lo: Population = { id: uid('pop'), name: uniquePopName(ws, `${label}-`, parent), parentId: parent, gate: { type: 'split', x: item.xParam, cut, side: 'lo', groupId }, color: '#5f6b7a' };
  const hi: Population = { id: uid('pop'), name: uniquePopName(ws, `${label}+`, parent), parentId: parent, gate: { type: 'split', x: item.xParam, cut, side: 'hi', groupId }, color };
  st.update((w) => {
    w.populations.push(lo, hi);
  });
  return [lo, hi];
}

export function createQuadrant(item: PlotItem, cx: number, cy: number): Population[] {
  const st = useStore.getState();
  const ws = st.ws;
  const parent = parentOf(item);
  const xl = axisName(ws, item.xParam);
  const yl = axisName(ws, item.yParam);
  const groupId = uid('quad');
  const defs: { q: 'UL' | 'UR' | 'LR' | 'LL'; name: string; color: string }[] = [
    { q: 'UL', name: quadrantName(xl, yl, 'UL'), color: '#1f77b4' },
    { q: 'UR', name: quadrantName(xl, yl, 'UR'), color: '#d62728' },
    { q: 'LR', name: quadrantName(xl, yl, 'LR'), color: '#2ca02c' },
    { q: 'LL', name: quadrantName(xl, yl, 'LL'), color: '#7f7f7f' },
  ];
  const pops = defs.map((d) => ({
    id: uid('pop'),
    name: uniquePopName(ws, d.name, parent),
    parentId: parent,
    gate: { type: 'quadrant', x: item.xParam, y: item.yParam, cx, cy, quadrant: d.q, groupId } as GateGeom,
    color: d.color,
  }));
  st.update((w) => {
    w.populations.push(...pops);
  });
  return pops;
}

/**
 * Move a gate by the pointer offset from display point `from` to `to` (plot u,v). Polygons / ellipses move rigidly in the
 * space they are evaluated in (`ev`, gate x / y order), so their membership shape is kept; raw-value gates shift in plot space.
 */
export function translateGate(g: GateGeom, ax: PlotAxes, from: [number, number], to: [number, number], swapped: boolean, ev?: { x: ScaleDef; y: ScaleDef } | null): GateGeom {
  const sx = makeScale(ax.xScale);
  const sy = ax.yScale ? makeScale(ax.yScale) : null;
  const du = to[0] - from[0];
  const dv = to[1] - from[1];
  if ((g.type === 'polygon' || g.type === 'ellipse') && ev && sy) {
    const ex = makeScale(ev.x);
    const ey = makeScale(ev.y);
    const rawAt = (p: [number, number]): Pt => (swapped ? [sy.inv(p[1]), sx.inv(p[0])] : [sx.inv(p[0]), sy.inv(p[1])]);
    const a = rawAt(from);
    const b = rawAt(to);
    const dx = ex.fwd(b[0]) - ex.fwd(a[0]);
    const dy = ey.fwd(b[1]) - ey.fwd(a[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return g;
    const mv = (p: Pt): Pt => [ex.inv(ex.fwd(p[0]) + dx), ey.inv(ey.fwd(p[1]) + dy)];
    return g.type === 'polygon' ? { ...g, points: g.points.map(mv) } : { ...g, center: mv(g.center), a: mv(g.a), b: mv(g.b) };
  }
  // shift in gate's own coordinate order
  const shiftX = (raw: number) => (swapped ? (sy ? sy.inv(sy.fwd(raw) + dv) : raw) : sx.inv(sx.fwd(raw) + du));
  const shiftY = (raw: number) => (swapped ? sx.inv(sx.fwd(raw) + du) : sy ? sy.inv(sy.fwd(raw) + dv) : raw);
  const fin = (f: (v: number) => number) => (v: number) => (Number.isFinite(v) ? f(v) : v);
  switch (g.type) {
    case 'polygon':
      return { ...g, points: g.points.map((p) => [shiftX(p[0]), shiftY(p[1])] as Pt) };
    case 'rect':
      return { ...g, xmin: fin(shiftX)(g.xmin), xmax: fin(shiftX)(g.xmax), ymin: fin(shiftY)(g.ymin), ymax: fin(shiftY)(g.ymax) };
    case 'ellipse':
      return { ...g, center: [shiftX(g.center[0]), shiftY(g.center[1])], a: [shiftX(g.a[0]), shiftY(g.a[1])], b: [shiftX(g.b[0]), shiftY(g.b[1])] };
    case 'quadrant':
      return { ...g, cx: shiftX(g.cx), cy: shiftY(g.cy) };
    case 'range':
      return { ...g, min: fin(shiftX)(g.min), max: fin(shiftX)(g.max) };
    case 'split':
      return { ...g, cut: shiftX(g.cut) };
    default:
      return g;
  }
}

const clamp01 = (u: number) => (u < 0 ? 0 : u > 1 ? 1 : u);

/**
 * New geometry when a handle is dragged to plot display position (u,v). `ev`: gating scales (gate x / y order) of a
 * polygon / ellipse; ellipse axes are edited in that space (the opposite handle mirrors through the center there).
 */
export function editHandle(g: GateGeom, handle: string, u: number, v: number, ax: PlotAxes, swapped: boolean, tol: { u: number; v: number }, ev?: { x: ScaleDef; y: ScaleDef } | null): GateGeom | null {
  const sx = makeScale(ax.xScale);
  const sy = ax.yScale ? makeScale(ax.yScale) : null;
  const gp = (r: [number, number]): Pt => (swapped ? [r[1], r[0]] : [r[0], r[1]]);
  switch (g.type) {
    case 'polygon': {
      const i = parseInt(handle.slice(1), 10);
      if (!(i >= 0 && i < g.points.length)) return null;
      const pts = g.points.slice();
      pts[i] = gp(toRaw(ax, u, v, tol, ev ? { x: swapped ? ev.y : ev.x, y: swapped ? ev.x : ev.y } : undefined));
      return { ...g, points: pts };
    }
    case 'rect': {
      // only the two sides touched by the dragged corner change; the others keep their raw values (incl. open bounds)
      const left = handle === 'tl' || handle === 'bl';
      const top = handle === 'tl' || handle === 'tr';
      const bx = toRawBound(ax.xScale, u, tol.u); // plot x
      const by = ax.yScale ? toRawBound(ax.yScale, v, tol.v) : v; // plot y
      // null bounds (Infinity cloned through plain JSON) are open
      const r = { xmin: g.xmin ?? -Infinity, xmax: g.xmax ?? Infinity, ymin: g.ymin ?? -Infinity, ymax: g.ymax ?? Infinity };
      if (!swapped) {
        if (left) r.xmin = bx;
        else r.xmax = bx;
        if (top) r.ymax = by;
        else r.ymin = by;
      } else {
        if (left) r.ymin = bx;
        else r.ymax = bx;
        if (top) r.xmax = by;
        else r.xmin = by;
      }
      return { ...g, xmin: Math.min(r.xmin, r.xmax), xmax: Math.max(r.xmin, r.xmax), ymin: Math.min(r.ymin, r.ymax), ymax: Math.max(r.ymin, r.ymax) };
    }
    case 'ellipse': {
      if (!sy) return null;
      const e = ev ?? { x: swapped ? ax.yScale! : ax.xScale, y: swapped ? ax.xScale : ax.yScale! };
      const ex = makeScale(e.x);
      const ey = makeScale(e.y);
      const r = gp([sx.inv(u), sy.inv(v)]);
      let p: Pt = [ex.fwd(r[0]), ey.fwd(r[1])];
      if (handle.endsWith('2')) p = [2 * ex.fwd(g.center[0]) - p[0], 2 * ey.fwd(g.center[1]) - p[1]];
      const raw: Pt = [ex.inv(p[0]), ey.inv(p[1])];
      if (!Number.isFinite(raw[0]) || !Number.isFinite(raw[1])) return null;
      return handle.startsWith('a') ? { ...g, a: raw } : { ...g, b: raw };
    }
    case 'quadrant': {
      // the center stays on the visible axes; a divider line moves only along its own axis
      const px = handle === 'hline' ? (swapped ? g.cy : g.cx) : sx.inv(clamp01(u));
      const py = handle === 'vline' ? (swapped ? g.cx : g.cy) : sy ? sy.inv(clamp01(v)) : 0;
      const r = gp([px, py]);
      return { ...g, cx: r[0], cy: r[1] };
    }
    case 'range': {
      const val = toRawBound(ax.xScale, u, tol.u);
      if (handle === 'min') return { ...g, min: Math.min(val, g.max ?? Infinity) };
      return { ...g, max: Math.max(val, g.min ?? -Infinity) };
    }
    case 'split':
      return { ...g, cut: sx.inv(clamp01(u)) };
    default:
      return null;
  }
}

/** Apply a gate change; quadrant/split groups are updated together. Per-sample overrides are respected. */
export function commitGate(popId: string, g: GateGeom, sampleOverride: string | null, historyKey: string) {
  const st = useStore.getState();
  st.update((ws) => {
    const pop = ws.populations.find((p) => p.id === popId);
    if (!pop) return;
    const setGeom = (p: Population, geom: GateGeom) => {
      if (sampleOverride && p.overrides?.[sampleOverride]) p.overrides[sampleOverride] = geom;
      else p.gate = geom;
      if (p.provenance && !p.provenance.edited) p.provenance.edited = true;
    };
    if (g.type === 'quadrant' || g.type === 'split') {
      for (const p of ws.populations) {
        const pg = sampleOverride && p.overrides?.[sampleOverride] ? p.overrides[sampleOverride] : p.gate;
        if (pg.type === 'quadrant' && g.type === 'quadrant' && pg.groupId === g.groupId) setGeom(p, { ...pg, cx: g.cx, cy: g.cy });
        if (pg.type === 'split' && g.type === 'split' && pg.groupId === g.groupId) setGeom(p, { ...pg, cut: g.cut });
      }
    } else setGeom(pop, g);
  }, historyKey);
}

// ------------------------------------------------------------------ auto gate (see core/autogate.ts)

const AUTO_BINS = 256;
const AUTO_MARGIN = 32;

/** Cached density / segmentation of the population a plot shows (reused while the slider moves and across clicks). */
export type AutoSession =
  | { kind: '2d'; deps: unknown[]; map: DensityMap2D; grid: EventGrid; ev: { x: ScaleDef; y: ScaleDef }; parentCount: number }
  | { kind: '1d'; deps: unknown[]; map: DensityMap1D; raw: Float32Array; idx: Uint32Array; parentCount: number };

export type AutoSeed = Seed2D | Seed1D;

/** anchor: the detected peak as a click seed (display units), so recomputing (other sample, tightness) follows the population */
export type AutoResult =
  | { kind: '2d'; display: [number, number][]; raw: Pt[]; count: number; parentCount: number; anchor: AutoSeed | null }
  | { kind: '1d'; lo: number; hi: number; min: number; max: number; count: number; parentCount: number; anchor: AutoSeed | null };

/**
 * Density session for auto gating on a plot: the events of `popId` in `sampleId`, in the plot's display space (axes),
 * and an exact counter in the space the new gate is evaluated in. `prev` is reused when its inputs are unchanged.
 */
export function autoSession(ws: Workspace, item: PlotItem, axes: PlotAxes, sampleId: string, popId: string, prev?: AutoSession | null): AutoSession | null {
  const idx = engine.population(ws, sampleId, popId);
  if (item.plotType === 'histogram') {
    const dx = engine.display(ws, sampleId, item.xParam, axes.xScale);
    const raw = engine.raw(ws, sampleId, item.xParam);
    if (!dx || !raw) return null;
    const deps = [idx, dx, raw];
    if (prev?.kind === '1d' && prev.deps.every((d, i) => d === deps[i])) return prev;
    return { kind: '1d', deps, map: DensityMap1D.fromEvents(dx, idx, { bins: AUTO_BINS }), raw, idx, parentCount: idx.length };
  }
  if (!axes.yScale) return null;
  const ev = { x: engine.scaleFor(ws, item.xParam, sampleId), y: engine.scaleFor(ws, item.yParam, sampleId) };
  const dx = engine.display(ws, sampleId, item.xParam, axes.xScale);
  const dy = engine.display(ws, sampleId, item.yParam, axes.yScale);
  const ex = engine.display(ws, sampleId, item.xParam, ev.x);
  const ey = engine.display(ws, sampleId, item.yParam, ev.y);
  if (!dx || !dy || !ex || !ey) return null;
  const deps = [idx, dx, dy, ex, ey];
  if (prev?.kind === '2d' && prev.deps.every((d, i) => d === deps[i])) return prev;
  const dropX = axes.xScale.type === 'window';
  const dropY = axes.yScale.type === 'window';
  let grid: EventGrid;
  let H: Float32Array;
  if (dx === ex && dy === ey && !dropX && !dropY) {
    // the plot shows the gating space itself: one pass bins both
    const GE = AUTO_BINS + 2 * AUTO_MARGIN;
    H = new Float32Array(GE * GE);
    grid = new EventGrid(ex, ey, idx, AUTO_BINS, { M: AUTO_MARGIN, H });
  } else {
    H = histogram2D(dx, dy, idx, AUTO_BINS, AUTO_MARGIN, dropX, dropY);
    grid = new EventGrid(ex, ey, idx, AUTO_BINS);
  }
  return { kind: '2d', deps, map: new DensityMap2D(H, AUTO_BINS, AUTO_MARGIN), grid, ev, parentCount: idx.length };
}

/** The population detected at a seed (display units of the plot) with density threshold alpha, or null. */
export function autoGateAt(s: AutoSession, axes: PlotAxes, seed: AutoSeed, alpha: number): AutoResult | null {
  if (s.kind === '1d') {
    if (!('u' in seed) && !('range' in seed)) return null;
    const r = autoGate1D(s.map, seed as Seed1D, alpha);
    if (!r) return null;
    // valleys at the axis ends become open bounds, like drawn range gates
    const min = toRawBound(axes.xScale, r.lo, 0);
    const max = toRawBound(axes.xScale, r.hi, 0);
    let count = 0;
    const { raw, idx } = s;
    for (let i = 0; i < idx.length; i++) {
      const v = raw[idx[i]];
      if (v >= min && v < max) count++;
    }
    const pu = (r.located.start + 0.5) / s.map.B;
    return { kind: '1d', lo: r.lo, hi: r.hi, min, max, count, parentCount: s.parentCount, anchor: 'u' in seed ? { u: pu } : null };
  }
  if (!('v' in seed) && !('rect' in seed)) return null;
  const r = autoGate2D(s.map, seed as Seed2D, alpha);
  if (!r || r.polygon.length < 3) return null;
  // vertices on or beyond the frame edge go beyond the gating scale's edge, so off-scale events piled there count
  const evAxes: EvalAxes = { x: s.ev.x, y: s.ev.y };
  const raw = r.polygon.map(([u, v]) => toRaw(axes, u, v, { u: 0, v: 0 }, evAxes) as Pt);
  const sx = makeScale(s.ev.x);
  const sy = makeScale(s.ev.y);
  const px = new Float64Array(raw.map((p) => sx.fwd(p[0])));
  const py = new Float64Array(raw.map((p) => sy.fwd(p[1])));
  const { G, M, GE } = s.map;
  const au = ((r.located.start % GE) - M + 0.5) / G;
  const av = (Math.floor(r.located.start / GE) - M + 0.5) / G;
  const anchor = 'u' in seed && au >= 0 && au <= 1 && av >= 0 && av <= 1 ? { u: au, v: av } : null;
  return { kind: '2d', display: r.polygon, raw, count: s.grid.count(px, py), parentCount: s.parentCount, anchor };
}

// ------------------------------------------------------------------ auto gate preview requested from outside a plot

/** Shown with the preview (AI assistant): why this population was chosen; `extra` names the gate and records provenance. */
export interface AutoPreviewMeta {
  title: string;
  note?: string;
  extra?: PopExtra;
}

export interface AutoPreviewRequest {
  itemId: string;
  /** display units of the plot (frame 0..1) */
  seed: AutoSeed;
  alpha: number;
  meta: AutoPreviewMeta;
  /** called once: the created population, or null (cancelled, discarded, nothing found) */
  onDone?: (popId: string | null) => void;
}

export interface AutoPreviewHandle {
  ok(): void;
  cancel(): void;
}

type PreviewSub = (r: AutoPreviewRequest) => AutoPreviewHandle | 'none' | undefined;
const previewSubs = new Set<PreviewSub>();

/** A plot view registers here (undefined: the request is not for it, or it has not been drawn yet). */
export function onAutoPreview(f: PreviewSub): () => void {
  previewSubs.add(f);
  return () => previewSubs.delete(f);
}

/**
 * Show the auto gate preview (tightness slider, OK / Cancel) on a plot of the active sheet, from a seed chosen elsewhere.
 * Returns a handle, 'none' when the auto gate finds no population there, or null when the plot is not on screen.
 */
export function requestAutoPreview(r: AutoPreviewRequest): AutoPreviewHandle | 'none' | null {
  for (const f of previewSubs) {
    const h = f(r);
    if (h) return h;
  }
  return null;
}

// ------------------------------------------------------------------ copy / paste gates

/** A set of copied gates: populations in workspace order (parents before children), the top-level ones, a label. */
export interface GateClip {
  pops: Population[];
  roots: Set<string>;
  label: string;
  /**
   * The axis scales of the workspace the gates were copied from (polygon / ellipse gates drawn in the app follow them):
   * pasted where a sample is evaluated on other scales, those gates keep the ones they were drawn in (see cloneGates).
   */
  scales?: { scales: Workspace['scales']; instrumentScales?: Workspace['instrumentScales'] };
}

/** Gates copied in the population tree (in-app clipboard). */
let gateClip: GateClip | null = null;
const clipSubs = new Set<() => void>();

/** The gates on the clipboard ('X' or 'X and 3 subpopulations'), or null. */
export function gateClipLabel(): string | null {
  return gateClip?.label ?? null;
}

export function onGateClip(f: () => void): () => void {
  clipSubs.add(f);
  return () => clipSubs.delete(f);
}

/**
 * The gates to copy for population `popId` (with its subpopulations if `withSubtree`). Quadrant and split gates are
 * taken as a whole (all regions). Null when the population does not exist.
 */
export function collectGates(ws: Workspace, popId: string, withSubtree: boolean): GateClip | null {
  const pop = popById(ws, popId);
  if (!pop) return null;
  const g = pop.gate;
  const roots = new Set<string>([pop.id]);
  if (g.type === 'quadrant' || g.type === 'split')
    for (const p of ws.populations) if (p.parentId === pop.parentId && p.gate.type === g.type && p.gate.groupId === g.groupId) roots.add(p.id);
  const ids = new Set(roots);
  if (withSubtree) for (const r of roots) popDescendants(ws, r).forEach((d) => ids.add(d));
  // structuredClone keeps open (+-Infinity) gate bounds
  const pops = ws.populations.filter((p) => ids.has(p.id)).map((p) => structuredClone(p) as Population);
  const subs = ids.size - roots.size;
  const head = roots.size > 1 ? `${pop.gate.type === 'quadrant' ? 'quadrant' : 'split'} gate '${pop.name}' (${roots.size} regions)` : `'${pop.name}'`;
  return { pops, roots, label: `${head}${subs ? ` with ${subs} subpopulation${subs === 1 ? '' : 's'}` : ''}`, scales: { scales: ws.scales, instrumentScales: ws.instrumentScales } };
}

/**
 * New populations from copied gates under `parentId` (null: all events), with new ids and quadrant / split groups;
 * Boolean gates use the copies of operands copied along. Top-level names get " 2", " 3"... when a sibling has the name,
 * unless `keepNames` (group-specific copies keep the names, so tables match them by name). `scope` replaces the scope of
 * the top-level copies (their subpopulations lose theirs and inherit it). Not added to the workspace.
 */
export function cloneGates(ws: Workspace, clip: GateClip, parentId: string | null, opts: { keepNames?: boolean; scope?: PopScope; notes?: string[] } = {}): Population[] {
  const idMap = new Map<string, string>();
  const groupMap = new Map<string, string>();
  for (const p of clip.pops) idMap.set(p.id, uid('pop'));
  // gates copied in another workspace may refer to its gates, samples, groups and matrices: those references are
  // removed here (references that exist in `ws` are kept)
  const popIds = new Set(ws.populations.map((p) => p.id));
  const sampleIds = new Set(ws.samples.map((s) => s.id));
  const groupIds = new Set(ws.groups.map((g) => g.id));
  const compIds = new Set(ws.compensations.map((c) => c.id));
  const count = { ops: 0, bools: 0, overrides: 0, scopes: 0, comps: 0, frozen: 0 };
  const skip = new Set<string>(); // Boolean gates that cannot be evaluated here (and their subpopulations)
  const remap = (g: GateGeom): GateGeom => {
    const c = structuredClone(g) as GateGeom;
    if (c.type === 'quadrant' || c.type === 'split') {
      let gid = groupMap.get(c.groupId);
      if (!gid) groupMap.set(c.groupId, (gid = uid(c.type === 'quadrant' ? 'quad' : 'split')));
      c.groupId = gid;
    }
    if (c.type === 'bool') {
      const ops = c.operands.map((o) => {
        const neg = o.startsWith('!');
        const id = idMap.get(o.replace(/^!/, ''));
        return id ? (neg ? '!' : '') + id : o;
      });
      const ok = ops.filter((o) => [...idMap.values()].includes(o.replace(/^!/, '')) || popIds.has(o.replace(/^!/, '')));
      if (ok.length !== ops.length) count.ops += ops.length - ok.length;
      c.operands = ok;
    }
    if (c.comp && !['none', 'uncompensated', 'file', 'FCS'].includes(c.comp) && !compIds.has(c.comp)) {
      delete c.comp;
      count.comps++;
    }
    return c;
  };
  const taken = new Set(ws.populations.filter((p) => p.parentId === parentId).map((p) => p.name));
  const made: Population[] = [];
  for (const p of clip.pops) {
    const top = clip.roots.has(p.id);
    let name = p.name;
    if (top && !opts.keepNames) {
      for (let k = 2; taken.has(name); k++) name = `${p.name} ${k}`;
      taken.add(name);
    }
    const np: Population = { ...p, id: idMap.get(p.id)!, name, parentId: top ? parentId : idMap.get(p.parentId ?? '') ?? parentId, gate: remap(p.gate) };
    if (p.gate.type === 'bool' && np.gate.type === 'bool' && np.gate.operands.length < p.gate.operands.length && (p.gate.op !== 'or' || !np.gate.operands.length)) {
      // AND / NOT with an operand that is not here (or an OR without any) cannot be evaluated: not pasted
      skip.add(np.id);
      count.bools++;
    }
    if (p.overrides) {
      const kept = Object.entries(p.overrides).filter(([k]) => sampleIds.has(k));
      count.overrides += Object.keys(p.overrides).length - kept.length;
      if (kept.length) np.overrides = Object.fromEntries(kept.map(([k, g]) => [k, remap(g)]));
      else delete np.overrides;
    }
    if (opts.scope) {
      if (top) np.scope = structuredClone(opts.scope);
      else delete np.scope;
    } else if (p.scope) {
      const groups = (p.scope.groups ?? []).filter((g) => groupIds.has(g));
      const samples = (p.scope.samples ?? []).filter((x) => sampleIds.has(x));
      if (groups.length !== (p.scope.groups ?? []).length || samples.length !== (p.scope.samples ?? []).length) {
        count.scopes++;
        // none of its groups / samples are here: it applies to all samples (an empty scope would apply to none)
        if (!groups.length && !samples.length) delete np.scope;
        else np.scope = { ...(groups.length ? { groups } : {}), ...(samples.length ? { samples } : {}) };
      }
    }
    if (clip.scales) keepEvalScales(ws, clip.scales, np, count);
    made.push(np);
  }
  // subpopulations of gates that were not pasted go too
  let out = made;
  if (skip.size) {
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of out) if (!skip.has(p.id) && p.parentId && skip.has(p.parentId)) skip.add(p.id), (grew = true);
    }
    out = made.filter((p) => !skip.has(p.id));
  }
  if (opts.notes) {
    const n = opts.notes;
    if (count.bools) n.push(`${count.bools} Boolean gate${count.bools > 1 ? 's were' : ' was'} not pasted: ${count.bools > 1 ? 'they use' : 'it uses'} gates that are not in this workspace`);
    else if (count.ops) n.push(`${count.ops} Boolean operand${count.ops > 1 ? 's' : ''} that ${count.ops > 1 ? 'are' : 'is'} not in this workspace ${count.ops > 1 ? 'were' : 'was'} left out`);
    if (count.overrides) n.push(`${count.overrides} sample-specific gate position${count.overrides > 1 ? 's' : ''} of samples that are not here ${count.overrides > 1 ? 'were' : 'was'} dropped`);
    if (count.scopes) n.push(`group / sample limits of ${count.scopes} gate${count.scopes > 1 ? 's' : ''} referred to groups or samples that are not here and were adjusted`);
    if (count.comps) n.push(`${count.comps} gate${count.comps > 1 ? 's use' : ' uses'} the samples' compensation (${count.comps > 1 ? 'their matrix is' : 'its matrix is'} not in this workspace)`);
    if (count.frozen) n.push(`${count.frozen} polygon / ellipse gate${count.frozen > 1 ? 's keep' : ' keeps'} the axis scales ${count.frozen > 1 ? 'they were' : 'it was'} drawn in, which differ here, so ${count.frozen > 1 ? 'they select' : 'it selects'} the same events`);
  }
  return out;
}

/**
 * A pasted population whose polygon / ellipse gates follow the axes (drawn in the app, no own scales): where the target
 * workspace evaluates a sample on other scales than the source workspace would (other axis settings, or per-instrument
 * scales), the gate gets the source's scales (per sample where instruments differ, see freezePlan), so it selects the
 * same events as the copied gate. Within the same workspace nothing changes.
 */
function keepEvalScales(ws: Workspace, src: NonNullable<GateClip['scales']>, np: Population, count: { frozen: number }) {
  // the target's samples (and their instruments) with the source's scales
  const from: Workspace = { ...ws, scales: src.scales, instrumentScales: src.instrumentScales };
  if (!from.instrumentScales) delete from.instrumentScales;
  type Shape = Extract<GateGeom, { type: 'polygon' | 'ellipse' }>;
  const ev = (w: Workspace, g: Shape, sid: string | null): EvalPair => gateEvalScales(g, (ch) => engine.scaleFor(w, ch, sid));
  const follows = (g: GateGeom | undefined): g is Shape => !!g && (g.type === 'polygon' || g.type === 'ellipse') && !(g.scales?.x && g.scales?.y);
  let frozen = false;
  // sample-specific gates: each on its own sample
  for (const [sid, og] of Object.entries(np.overrides ?? {})) {
    if (!follows(og)) continue;
    const plan = freezePlan([sid], (s) => ev(from, og, s ?? sid), (s) => ev(ws, og, s ?? sid));
    if (!plan) continue;
    const own = plan.perSample[0]?.[1] ?? plan.shared!;
    np.overrides![sid] = { ...og, scales: { x: own.x, y: own.y }, strict: og.strict ?? false };
    frozen = true;
  }
  const g = np.gate;
  if (follows(g)) {
    const sids = ws.samples.filter((s) => !np.overrides?.[s.id] && inScope(ws, np.scope, s.id)).map((s) => s.id);
    const plan = freezePlan(sids, (s) => ev(from, g, s), (s) => ev(ws, g, s));
    if (plan) {
      applyFreezePlan(np, g, plan);
      frozen = true;
    }
  }
  if (frozen) count.frozen++;
}

/**
 * Copy a gate (with its subpopulations if `withSubtree`) to paste it under another population. Quadrant and split
 * gates are copied as a whole (all regions); Boolean gates keep their operands unless those are copied along.
 */
export function copyGates(popId: string, withSubtree: boolean): void {
  const st = useStore.getState();
  const clip = collectGates(st.ws, popId, withSubtree);
  if (!clip) return;
  gateClip = clip;
  clipSubs.forEach((f) => f());
  st.toast(`Copied ${gateClip.label}. Right-click a population and choose "Paste gate here".`, 'info');
}

/** Paste the copied gates under `parentId` (null: all events) as new populations. Returns the new top-level ones. */
export function pasteGates(parentId: string | null): Population[] {
  const st = useStore.getState();
  if (!gateClip) return [];
  const ws = st.ws;
  if (parentId && !popById(ws, parentId)) return [];
  const notes: string[] = [];
  const made = cloneGates(ws, gateClip, parentId, { notes });
  if (!made.length) {
    st.toast(`Nothing was pasted: ${notes.join('; ') || 'the copied gates cannot be used here'}.`, 'error');
    return [];
  }
  st.update((w) => {
    w.populations.push(...made);
  });
  const where = parentId ? `'${popById(ws, parentId)?.name}'` : 'All Events';
  if (notes.length) st.toast(`Pasted ${gateClip.label} under ${where}, with changes: ${notes.join('; ')}.`, 'info', { duration: 12000 });
  else st.toast(`Pasted ${gateClip.label} under ${where}`, 'success');
  return made.filter((p) => p.parentId === parentId);
}

export function populationLabel(ws: Workspace, id: string): string {
  if (id === 'root') return 'All Events';
  return popById(ws, id)?.name ?? '?';
}

/** Axes of the plot that follows `item` in a gating strategy (scatter -> singlets -> fluorescence), on the plot's sample. */
export function defaultNextAxes(ws: Workspace, item: PlotItem): [string, string] {
  const ui = useStore.getState().ui;
  const ls = item.layers[0]?.sample;
  const sid = ls && ls !== 'active' ? ls : ui.activeSampleId;
  const s = ws.samples.find((x) => x.id === sid) ?? ws.samples.find((x) => engine.has(x.id)) ?? ws.samples[0];
  const chans = s?.channels.map((c) => c.name) ?? [];
  const isScatter = (c: string) => /FSC|SSC|^FS|^SS/i.test(c);
  const flAll = chans.filter((c) => !isScatter(c) && !/time/i.test(c) && !/width|-W$/i.test(c));
  const flA = flAll.filter((c) => /-A$|INT|AREA/i.test(c));
  const fl = flA.length >= 2 ? flA : flAll;
  if (isScatter(item.xParam) && isScatter(item.yParam)) {
    // singlet plot first if area/height exist and not yet used
    const fa = chans.find((c) => /^FSC[-_ ]?A$/i.test(c));
    const fh = chans.find((c) => /^FSC[-_ ]?H$/i.test(c));
    if (fa && fh && !(item.xParam === fa && item.yParam === fh)) return [fa, fh];
    if (fl.length >= 2) return [fl[0], fl[1]];
  }
  if (/^FSC[-_ ]?A$/i.test(item.xParam) && /^FSC[-_ ]?H$/i.test(item.yParam)) {
    if (fl.length >= 2) return [fl[0], fl[1]];
  }
  return [item.xParam, item.yParam];
}

export { channelDisplayName };
