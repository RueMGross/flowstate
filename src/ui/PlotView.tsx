import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPE } from 'react';
import { alphaFromTightness, SENSITIVITY, tightnessFromAlpha, warmUpAutoGate } from '../core/autogate';
import { engine } from '../core/engine';
import { pointInPolygon } from '../core/gating';
import { popNotApplicableReason } from '../core/scope';
import { gateParams, popById, uid, type GateGeom, type PlotItem, type Population, type Pt, type Workspace } from '../core/model';
import { formatLinear, makeScale } from '../core/transforms';
import { setCursorInfo } from './cursorBus';
import { CanvasPainter, fitCanvasScale } from '../render/painter';
import { omittedEvents, renderPlot, type GateShape, type PlotGeometry } from '../render/plot';
import { newPlotItem, nextGateColor, useStore } from '../state/store';
import './autogate.css';
import {
  autoGateAt,
  autoSession,
  commitGate,
  createEllipse,
  createPolygon,
  createQuadrant,
  createRange,
  createRect,
  createSplit,
  defaultNextAxes,
  editHandle,
  evalScalesOf,
  onAutoPreview,
  plotEvalAxes,
  toRaw,
  toRawBound,
  translateGate,
  type AutoPreviewMeta,
  type AutoPreviewRequest,
  type AutoResult,
  type AutoSeed,
  type AutoSession,
  type PlotAxes,
} from './gateOps';
import { childGateSpec, findFreeSlot, growPageToFit } from './layoutOps';
import { openGatingView } from './GatingView';

type Draft =
  | { kind: 'poly'; pts: [number, number][]; cur: [number, number] | null }
  | { kind: 'rect' | 'ellipse' | 'range' | 'auto'; a: [number, number]; b: [number, number] }
  | { kind: 'zoom'; a: [number, number]; b: [number, number]; out: boolean };

// (cx0, cy0): client position of the press; positions are re-derived from it so a layout shift cannot jump the drag
type Drag = { popId: string; cx0: number; cy0: number; moved: boolean } & (
  | { kind: 'gate'; g0: GateGeom; swapped: boolean; override: string | null }
  | { kind: 'handle'; g0: GateGeom; handle: string; swapped: boolean; override: string | null }
  | { kind: 'label'; off0: [number, number] }
);

interface Props {
  item: PlotItem;
  zoom: number;
  sheetId: string;
  onPickAxis?: (axis: 'x' | 'y', clientX: number, clientY: number) => void;
  /** shown in the gating view (GatingView.tsx): `item` may be enlarged; the worksheet item has the same id */
  inGatingView?: boolean;
  /** the worksheet size of an enlarged `item`: gate labels are placed as on the worksheet (and so in the figure) */
  labelLayoutSize?: { w: number; h: number };
}

const dpr = () => Math.min(3, window.devicePixelRatio || 1);
const canvasFactory = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

// One gate draft at a time across all plots: starting a draft cancels the others, and only its owner handles keys.
const drafts = { owner: null as object | null, subs: new Set<(owner: object) => void>() };
function claimDraft(me: object) {
  if (drafts.owner === me) return;
  drafts.owner = me;
  drafts.subs.forEach((f) => f(me));
}

const isEditable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/** handles outside the frame (e.g. far vertices of a zoomed plot) are neither drawn nor grabbed */
const onFrame = (g: PlotGeometry, h: { x: number; y: number }, pad = 6) =>
  h.x >= g.frame.x - pad && h.x <= g.frame.x + g.frame.w + pad && h.y >= g.frame.y - pad && h.y <= g.frame.y + g.frame.h + pad;

function inOutline(s: GateShape, x: number, y: number): boolean {
  if (!s.outline) return false;
  const n = s.outline.length / 2;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    xs[k] = s.outline[2 * k];
    ys[k] = s.outline[2 * k + 1];
  }
  return pointInPolygon(x, y, xs, ys);
}

export function hitTest(geom: PlotGeometry, x: number, y: number, selectedPopId: string | null): { shape: GateShape; part: 'handle' | 'body' | 'label'; handle?: string } | null {
  const near = (hx: number, hy: number, r: number) => Math.hypot(hx - x, hy - y) <= r;
  const fr = geom.frame;
  const sel = geom.gates.find((s) => s.popId === selectedPopId);
  if (sel) for (const h of sel.handles) if (onFrame(geom, h) && near(h.x, h.y, 6)) return { shape: sel, part: 'handle', handle: h.id };
  const inside = x >= fr.x - 2 && x <= fr.x + fr.w + 2 && y >= fr.y - 2 && y <= fr.y + fr.h + 2;
  for (const s of geom.gates) {
    if (s.kind === 'range') {
      const h = s.handles.find((hh) => onFrame(geom, hh) && near(hh.x, hh.y, 6));
      if (h) return { shape: s, part: 'handle', handle: h.id };
    }
    // quadrant / split gates are dragged by their center and divider lines only
    if ((s.kind === 'quadrant' || s.kind === 'split') && inside && s.handles[0]) {
      const c = s.handles[0];
      const inX = c.x >= fr.x && c.x <= fr.x + fr.w;
      const inY = s.kind === 'quadrant' && c.y >= fr.y && c.y <= fr.y + fr.h;
      const handle = inX && inY && near(c.x, c.y, 6) ? 'center' : inX && Math.abs(x - c.x) <= 4 ? (s.kind === 'quadrant' ? 'vline' : 'cut') : inY && Math.abs(y - c.y) <= 4 ? 'hline' : null;
      if (handle) {
        // the region under the pointer becomes the selected population
        const gid = (s.gate as { groupId: string }).groupId;
        const region = geom.gates.find((o) => (o.gate as { groupId?: string }).groupId === gid && inOutline(o, x, y)) ?? s;
        return { shape: region, part: 'handle', handle };
      }
    }
  }
  for (const s of geom.gates) if (s.label && x >= s.label.x && x <= s.label.x + s.label.w && y >= s.label.y && y <= s.label.y + s.label.h) return { shape: s, part: 'label' };
  if (!inside) return null;
  for (let i = geom.gates.length - 1; i >= 0; i--) {
    const s = geom.gates[i];
    if (s.kind !== 'quadrant' && s.kind !== 'split' && inOutline(s, x, y)) return { shape: s, part: 'body' };
  }
  // quadrant / split regions last (they cover the whole plot)
  for (const s of geom.gates) if ((s.kind === 'quadrant' || s.kind === 'split') && inOutline(s, x, y)) return { shape: s, part: 'body' };
  return null;
}

/** drop vertices within 3 px of the previous one (repeated clicks) and closing duplicates of the first */
function dedupe(g: PlotGeometry, pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  const px = (p: [number, number]) => g.toPx(p[0], p[1]);
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q) {
      const [a, b] = [px(p), px(q)];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 3) continue;
    }
    out.push(p);
  }
  while (out.length > 1) {
    const [a, b] = [px(out[out.length - 1]), px(out[0])];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= 3) break;
    out.pop();
  }
  return out;
}

/** An auto-detected gate shown as a preview until OK (Enter) or Cancel (Escape); the tightness slider recomputes it. */
interface AutoPending {
  seed: AutoSeed;
  alpha: number;
  /** Shift was held: keep the tool after OK (no rename) */
  keep: boolean;
  res: AutoResult;
  color: string;
  /** the plot axes / population the seed refers to */
  sig: string;
  /** requested from outside (AI assistant): note shown in the popover, name / provenance, completion callback */
  ai?: { meta: AutoPreviewMeta; onDone?: (popId: string | null) => void; settled?: boolean };
}

/** report the outcome of an externally requested preview once */
function settleAi(p: AutoPending | null | undefined, popId: string | null) {
  if (!p?.ai || p.ai.settled) return;
  p.ai.settled = true;
  p.ai.onDone?.(popId);
}

/** tightness of the last auto gate; the next one starts there */
let autoAlpha: number = SENSITIVITY.normal;

const plotSig = (it: PlotItem) => {
  const o = it.options;
  return JSON.stringify([it.plotType === 'histogram', it.xParam, it.plotType === 'histogram' ? '' : it.yParam, it.layers.find((l) => l.visible !== false) ?? null, o.xWin, o.yWin, o.xScale, o.yScale]);
};

type DblEvent = { clientX: number; clientY: number; shiftKey: boolean; stopPropagation(): void };

const fmtPct = (p: number) => (!Number.isFinite(p) ? '-' : p < 10 ? p.toFixed(2) : p.toFixed(1));

/** Gates on this plot that were seeded by the AI assistant, as tooltip lines (empty: none). */
function aiGateNotes(ws: Workspace, item: PlotItem): string[] {
  const parent = item.layers.find((l) => l.visible !== false)?.population ?? 'root';
  const axes = item.plotType === 'histogram' ? [item.xParam] : [item.xParam, item.yParam];
  return ws.populations
    .filter((p) => p.provenance && (p.parentId ?? 'root') === parent && gateParams(p.gate).length === axes.length && gateParams(p.gate).every((c) => axes.includes(c)))
    .map((p) => {
      const v = p.provenance!;
      return `${p.name}: seeded by AI (${String(v.model ?? '?')}, ${typeof v.date === 'string' ? v.date.slice(0, 10) : '?'}, asked for "${String(v.target ?? '')}"), boundary from the auto gate${v.edited ? ', edited since' : ''}`;
    });
}

const badge: CSSProperties = { font: '600 10px/14px system-ui, sans-serif', height: 14, borderRadius: 7, color: '#ffffff', userSelect: 'none', whiteSpace: 'nowrap' };

export function PlotView({ item, zoom, sheetId, onPickAxis, inGatingView, labelLayoutSize }: Props) {
  const ws = useStore((s) => s.ws);
  const activeSampleId = useStore((s) => s.ui.activeSampleId);
  const selectedPopId = useStore((s) => s.ui.selectedPopId);
  const dataVersion = useStore((s) => s.ui.dataVersion);
  const tool = useStore((s) => s.ui.tool);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geomRef = useRef<PlotGeometry | null>(null);
  // events not drawn (no value in a plotted channel), for the read-out: computed once per drawing
  const omitRef = useRef<{ geom: PlotGeometry | null; text: string }>({ geom: null, text: '' });
  const cacheRef = useRef(new Map<string, { deps: unknown[]; value: unknown }>());
  const me = useRef({}).current;
  const [draft, setDraftState] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const lastFinish = useRef(0);
  const itemRef = useRef(item);
  itemRef.current = item;
  const [cursor, setCursor] = useState('default');
  // the full text of a gate label drawn shortened, shown on hover
  const [hoverTitle, setHoverTitle] = useState('');
  const [pending, setPendingState] = useState<AutoPending | null>(null);
  const pendingRef = useRef<AutoPending | null>(null);
  const sessRef = useRef<AutoSession | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [popAbove, setPopAbove] = useState(false);
  const setPending = (p: AutoPending | null) => {
    const prev = pendingRef.current;
    if (prev?.ai && prev.ai !== p?.ai) settleAi(prev, null);
    pendingRef.current = p;
    setPendingState(p);
  };

  const setDraft = (d: Draft | null) => {
    draftRef.current = d;
    if (d) claimDraft(me);
    else if (drafts.owner === me) drafts.owner = null;
    setDraftState(d);
  };

  // another plot started a draft: drop ours
  useEffect(() => {
    const f = (owner: object) => {
      if (owner === me || !draftRef.current) return;
      draftRef.current = null;
      setDraftState(null);
    };
    drafts.subs.add(f);
    return () => {
      drafts.subs.delete(f);
      if (drafts.owner === me) drafts.owner = null;
    };
  }, [me]);

  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const isHistPlot = item.plotType === 'histogram';
    const k = fitCanvasScale(item.w, item.h, zoom * dpr());
    const W = Math.max(1, Math.round(item.w * k));
    const H = Math.max(1, Math.round(item.h * k));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const p = new CanvasPainter(ctx, k);
    let geom: PlotGeometry;
    const t0 = performance.now();
    try {
      geom = renderPlot(p, item, item.w, item.h, {
        ws,
        engine,
        activeSampleId,
        selectedPopId,
        rasterScale: k,
        makeCanvas: canvasFactory,
        cache: cacheRef.current,
        labelRef: labelLayoutSize,
      });
    } catch (e) {
      console.error(e);
      ctx.fillStyle = '#c0352b';
      ctx.font = '12px sans-serif';
      ctx.fillText('Render error: ' + (e as Error).message, 8, 20);
      return;
    }
    geomRef.current = geom;
    if ((window as unknown as { __fcPerf?: boolean }).__fcPerf) console.log(`render ${item.plotType} ${(performance.now() - t0).toFixed(1)}ms`);
    const toPx = (u: number, v: number) => geom.toPx(u, v);
    // handles of the selected gate (screen only)
    const sel = selectedPopId ? geom.gates.find((s) => s.popId === selectedPopId) : undefined;
    if (sel && !draft) {
      const col = popById(ws, sel.popId)?.color ?? '#e8890c';
      for (const h of sel.handles) if (onFrame(geom, h, 1)) p.rect(h.x - 2.5, h.y - 2.5, 5, 5, { color: col, width: 1 }, { color: '#ffffff' });
    }
    // draft overlay
    if (draft) {
      const fr = geom.frame;
      const stroke = { color: '#e8890c', width: 1.4, dash: [4, 3] };
      if (draft.kind === 'poly') {
        const pts: number[] = [];
        draft.pts.forEach(([u, v]) => pts.push(...toPx(u, v)));
        const first = toPx(draft.pts[0][0], draft.pts[0][1]);
        const cur = draft.cur ? toPx(draft.cur[0], draft.cur[1]) : null;
        if (cur) pts.push(...cur);
        p.path(pts, false, stroke);
        const closing = !!cur && draft.pts.length >= 3 && Math.hypot(cur[0] - first[0], cur[1] - first[1]) < 7;
        // preview of the closing edge
        if (cur && draft.pts.length >= 2 && !closing) p.line(cur[0], cur[1], first[0], first[1], { color: '#e8890c', width: 1, dash: [2, 3] });
        draft.pts.forEach(([u, v], i) => {
          const [x, y] = toPx(u, v);
          if (i === 0 && closing) p.rect(x - 4, y - 4, 8, 8, { color: '#e8890c', width: 1.5 }, { color: '#e8890c' });
          else p.rect(x - 2.5, y - 2.5, 5, 5, { color: '#e8890c', width: 1 }, { color: '#ffffff' });
        });
      } else {
        const [x0, y0] = toPx(draft.a[0], draft.a[1]);
        const [x1, y1] = toPx(draft.b[0], draft.b[1]);
        if (draft.kind === 'zoom') {
          const zx = isHistPlot ? fr.y : Math.min(y0, y1);
          const zh = isHistPlot ? fr.h : Math.abs(y1 - y0);
          p.rect(Math.min(x0, x1), zx, Math.abs(x1 - x0), zh, { color: '#1463b8', width: 1, dash: [3, 3] }, { color: '#1463b8', opacity: 0.08 });
        } else if (draft.kind === 'auto') {
          // a drag (not a click): the rectangle the population is searched in
          if (Math.abs(x1 - x0) >= 4 || (!isHistPlot && Math.abs(y1 - y0) >= 4)) {
            const ry = isHistPlot ? fr.y : Math.min(y0, y1);
            const rh = isHistPlot ? fr.h : Math.abs(y1 - y0);
            p.rect(Math.min(x0, x1), ry, Math.abs(x1 - x0), rh, stroke, { color: '#e8890c', opacity: 0.06 });
          }
        } else if (draft.kind === 'rect') p.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), stroke);
        else if (draft.kind === 'ellipse') p.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, stroke);
        else {
          const y = fr.y + fr.h * 0.15;
          p.line(x0, y, x1, y, stroke);
          p.line(x0, y - 5, x0, y + 5, stroke);
          p.line(x1, y - 5, x1, y + 5, stroke);
        }
      }
    }
  }, [ws, item, activeSampleId, selectedPopId, dataVersion, zoom, draft]);

  // pending auto gate: drawn on an overlay so moving the tightness slider does not re-render the plot
  useLayoutEffect(() => {
    const cv = overlayRef.current;
    const g = geomRef.current;
    if (!cv || !g || !pending) return;
    const k = fitCanvasScale(item.w, item.h, zoom * dpr());
    const W = Math.max(1, Math.round(item.w * k));
    const H = Math.max(1, Math.round(item.h * k));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const p = new CanvasPainter(ctx, k);
    const fr = g.frame;
    const col = pending.color;
    // dashed gate color over a white halo: visible on dense pseudocolor areas too
    const halo = { color: '#ffffff', width: 3.4, opacity: 0.85 };
    const stroke = { color: col, width: 1.7, dash: [5, 3] };
    p.save();
    p.clipRect(fr.x, fr.y, fr.w, fr.h);
    if (pending.res.kind === '2d') {
      const pts: number[] = [];
      for (const [u, v] of pending.res.display) pts.push(...g.toPx(u, v));
      p.path(pts, true, null, { color: col, opacity: 0.14 });
      p.path(pts, true, halo);
      p.path(pts, true, stroke);
    } else {
      const [x0] = g.toPx(Math.max(-0.02, pending.res.lo), 0);
      const [x1] = g.toPx(Math.min(1.02, pending.res.hi), 0);
      p.rect(x0, fr.y, x1 - x0, fr.h, null, { color: col, opacity: 0.14 });
      for (const x of [x0, x1]) {
        p.line(x, fr.y, x, fr.y + fr.h, halo);
        p.line(x, fr.y, x, fr.y + fr.h, stroke);
      }
    }
    p.restore();
  }, [pending, ws, item, activeSampleId, selectedPopId, dataVersion, zoom]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * item.w, y: ((e.clientY - r.top) / r.height) * item.h };
  };
  const axesOf = (g: PlotGeometry): PlotAxes => ({ xScale: g.xScale, yScale: g.yScale });
  const snapTol = (g: PlotGeometry) => ({ u: 3 / g.frame.w, v: 3 / g.frame.h });
  const inFrame = (g: PlotGeometry, x: number, y: number, pad = 0) =>
    x >= g.frame.x - pad && x <= g.frame.x + g.frame.w + pad && y >= g.frame.y - pad && y <= g.frame.y + g.frame.h + pad;
  /** display coordinates of a pixel position snapped onto the frame */
  const frameUV = (g: PlotGeometry, x: number, y: number) => {
    const fr = g.frame;
    return g.toDisplay(Math.min(Math.max(x, fr.x), fr.x + fr.w), Math.min(Math.max(y, fr.y), fr.y + fr.h));
  };
  const updateItem = (fn: (it: PlotItem) => void, key?: string) =>
    useStore.getState().update((w) => {
      const it = w.worksheets.find((s) => s.id === sheetId)?.items.find((i) => i.id === item.id);
      if (it && it.kind === 'plot') fn(it);
    }, key);
  const resetZoom = () =>
    updateItem((it) => {
      it.options.xWin = undefined;
      it.options.yWin = undefined;
    });

  /** a gate is complete: back to Select and rename it, or (Shift) keep the tool for the next gate */
  const finishGate = (popIds: string[], at: { x: number; y: number }, keepTool: boolean) => {
    const st = useStore.getState();
    lastFinish.current = performance.now();
    if (keepTool) {
      st.setUI({ selectedPopId: popIds[0] ?? null });
      return;
    }
    st.setUI({ tool: 'select', selectedPopId: popIds[0] ?? null });
    if (popIds.length === 1) st.setUI({ dialog: { kind: 'renamePop', payload: { popId: popIds[0], itemId: item.id, x: item.x + at.x, y: item.y + at.y } } });
  };

  // ---------------------------------------------------------------- auto gate

  /** detect the population at a seed (display units) in the population this plot shows */
  const autoCompute = (seed: AutoSeed, alpha: number): AutoResult | null => {
    const g = geomRef.current;
    if (!g || !g.primarySample) return null;
    const ws0 = useStore.getState().ws;
    const s = autoSession(ws0, itemRef.current, axesOf(g), g.primarySample, g.primaryPop, sessRef.current);
    sessRef.current = s;
    return s ? autoGateAt(s, axesOf(g), seed, alpha) : null;
  };

  // with the Auto gate tool, hovering a plot builds its density session in the background so the click is instant
  const prepTimer = useRef(0);
  const prepareAuto = () => {
    if (prepTimer.current) return;
    prepTimer.current = window.setTimeout(() => {
      prepTimer.current = 0;
      const g = geomRef.current;
      if (useStore.getState().ui.tool !== 'autogate' || !g || !g.primarySample || draftRef.current) return;
      sessRef.current = autoSession(useStore.getState().ws, itemRef.current, axesOf(g), g.primarySample, g.primaryPop, sessRef.current);
    }, 40);
  };
  const cancelPrepare = () => {
    window.clearTimeout(prepTimer.current);
    prepTimer.current = 0;
  };
  useEffect(() => cancelPrepare, []);

  /** a click or drag with the Auto gate tool: preview the detected population (Shift: keep the pending one too) */
  const runAuto = (seed: AutoSeed, shift: boolean) => {
    const st = useStore.getState();
    const prev = pendingRef.current;
    const alpha = prev?.alpha ?? autoAlpha;
    const t0 = performance.now();
    const res = autoCompute(seed, alpha);
    if ((window as unknown as { __fcPerf?: boolean }).__fcPerf) console.log(`autogate ${(performance.now() - t0).toFixed(1)}ms`);
    if (!res || res.count === 0) {
      st.toast('No population found here', 'info');
      return;
    }
    if (prev && shift) commitPending('silent');
    st.setUI({ selectedPopId: null });
    setPending({ seed: res.anchor ?? seed, alpha, keep: shift, res, color: nextGateColor(useStore.getState().ws), sig: plotSig(itemRef.current) });
  };

  /** create the pending gate: 'ok' runs the usual finish (rename, back to Select unless Shift), 'silent' only selects it */
  const commitPending = (mode: 'ok' | 'silent', shiftNow = false) => {
    const p = pendingRef.current;
    if (!p) return;
    if (p.ai) p.ai.settled = true; // reported below, with the new population
    setPending(null);
    const g = geomRef.current;
    const it = itemRef.current;
    let pop: Population | null;
    let at = { x: 0, y: 0 };
    const extra = p.ai?.meta.extra && { ...p.ai.meta.extra, provenance: p.ai.meta.extra.provenance && { ...p.ai.meta.extra.provenance, alpha: p.alpha } };
    if (p.res.kind === '2d') {
      pop = createPolygon(it, p.res.raw, extra);
      const top = p.res.display.reduce((a, b) => (b[1] > a[1] ? b : a));
      if (g) {
        const [px, py] = g.toPx(Math.min(1, Math.max(0, top[0])), Math.min(1, top[1]));
        at = { x: px, y: py };
      }
    } else {
      // named by position: "X-" / "X+" for a negative / positive population, else "X range"
      pop = createRange(it, p.res.min, p.res.max, undefined, extra);
      if (g) {
        const [px, py] = g.toPx(Math.max(0, p.res.lo), 0.85);
        at = { x: px, y: py };
      }
    }
    p.ai?.onDone?.(pop?.id ?? null);
    if (!pop) return;
    if (mode === 'ok' && !p.ai) finishGate([pop.id], at, p.keep || shiftNow);
    else {
      lastFinish.current = performance.now();
      useStore.getState().setUI({ selectedPopId: pop.id });
    }
  };

  const setTightness = (t: number) => {
    const p = pendingRef.current;
    if (!p) return;
    const alpha = alphaFromTightness(t);
    const res = autoCompute(p.seed, alpha);
    autoAlpha = alpha;
    if (res) setPending({ ...p, alpha, res });
  };

  // a preview requested from outside (AI assistant): the seed goes through the same auto gate as a click
  const previewReq = useRef<(r: AutoPreviewRequest) => ReturnType<Parameters<typeof onAutoPreview>[0]>>();
  previewReq.current = (r) => {
    const g = geomRef.current;
    if (r.itemId !== itemRef.current.id || !g || !g.primarySample) return undefined;
    const res = autoCompute(r.seed, r.alpha);
    if (!res || res.count === 0) return 'none';
    setPending(null);
    useStore.getState().setUI({ selectedPopId: null });
    const ai: NonNullable<AutoPending['ai']> = { meta: r.meta, onDone: r.onDone };
    setPending({ seed: res.anchor ?? r.seed, alpha: r.alpha, keep: false, res, color: nextGateColor(useStore.getState().ws), sig: plotSig(itemRef.current), ai });
    return {
      ok: () => pendingRef.current?.ai === ai && commitPending('ok'),
      cancel: () => pendingRef.current?.ai === ai && setPending(null),
    };
  };
  useEffect(() => {
    const off = onAutoPreview((r) => previewReq.current!(r));
    return () => {
      off();
      settleAi(pendingRef.current, null); // the plot went away with a requested preview: nothing was created
    };
  }, []);

  const isHist = item.plotType === 'histogram';
  const overrideOf = (g: PlotGeometry, popId: string) => {
    const pop = popById(useStore.getState().ws, popId);
    const sid = g.primarySample;
    return sid && pop?.overrides?.[sid] ? sid : null;
  };

  /** Alt-click on the selected polygon: remove the vertex under the pointer or insert one on the edge */
  const altEdit = (g: PlotGeometry, x: number, y: number): boolean => {
    const st = useStore.getState();
    const shape = g.gates.find((s) => s.popId === st.ui.selectedPopId);
    if (!shape || shape.gate.type !== 'polygon' || !shape.outline) return false;
    const gate = shape.gate;
    const override = overrideOf(g, shape.popId);
    const vi = shape.handles.findIndex((h) => onFrame(g, h) && Math.hypot(h.x - x, h.y - y) <= 6);
    if (vi >= 0) {
      if (gate.points.length <= 3) st.toast('A polygon needs at least 3 vertices.', 'info');
      else commitGate(shape.popId, { ...gate, points: gate.points.filter((_, i) => i !== vi) }, override, 'vertex:' + shape.popId);
      return true;
    }
    const ol = shape.outline;
    const n = ol.length / 2;
    let best = { d: Infinity, j: -1, x: 0, y: 0 };
    for (let j = 0; j < n; j++) {
      const ax = ol[2 * j],
        ay = ol[2 * j + 1];
      const dx = ol[(2 * j + 2) % ol.length] - ax,
        dy = ol[(2 * j + 3) % ol.length] - ay;
      const L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
      const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
      if (d < best.d) best = { d, j, x: ax + t * dx, y: ay + t * dy };
    }
    if (best.d > 5 || !inFrame(g, best.x, best.y)) return false;
    const [u, v] = g.toDisplay(best.x, best.y);
    const r = toRaw(axesOf(g), u, v, { u: 0, v: 0 });
    const pts = gate.points.slice();
    pts.splice(Math.floor(best.j / (shape.edgeSamples ?? 1)) + 1, 0, shape.swapped ? [r[1], r[0]] : r);
    commitGate(shape.popId, { ...gate, points: pts }, override, 'vertex:' + shape.popId);
    return true;
  };

  const onPointerDown = (e: RPE<HTMLCanvasElement>) => {
    const g = geomRef.current;
    if (!g || e.button !== 0) return;
    const { x, y } = local(e);
    const st = useStore.getState();
    // drawing tools take presses anywhere on the plot and snap them onto the frame
    const [u, v] = frameUV(g, x, y);
    if (tool === 'zoom') {
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDraft({ kind: 'zoom', a: [u, v], b: [u, v], out: e.altKey });
      return;
    }
    const gateTool = tool !== 'select' && tool !== 'text';
    if (gateTool) {
      e.stopPropagation();
      if (!g.hasData) {
        st.toast('Load a sample first to draw gates.', 'info');
        return;
      }
      const t = tool;
      // no gates on a population that does not apply to the sample shown (other group's tree, missing channel)
      const na = g.primarySample ? popNotApplicableReason(st.ws, g.primarySample, g.primaryPop) : null;
      if (na) {
        st.toast(`Not applicable to this sample: ${na}. Pick a sample it applies to, or change "Apply to" in the population menu.`, 'info');
        return;
      }
      if (t === 'autogate') {
        // a click picks the population under the pointer, a drag searches the rectangle (range on histograms)
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDraft({ kind: 'auto', a: [u, v], b: [u, v] });
        return;
      }
      if (isHist && !(t === 'range' || t === 'split')) {
        st.toast('On histograms use the Range or Split gate.', 'info');
        return;
      }
      if (!isHist && (t === 'range' || t === 'split')) {
        st.toast('Range and Split gates work on histograms.', 'info');
        return;
      }
      const [px, py] = g.toPx(u, v);
      if (t === 'polygon') {
        const d = draftRef.current;
        if (!d || d.kind !== 'poly') {
          // the second click of a double-click that just closed a polygon
          if (performance.now() - lastFinish.current < 400) return;
          setDraft({ kind: 'poly', pts: [[u, v]], cur: [u, v] });
          return;
        }
        const first = g.toPx(d.pts[0][0], d.pts[0][1]);
        const last = g.toPx(d.pts[d.pts.length - 1][0], d.pts[d.pts.length - 1][1]);
        if (d.pts.length >= 3 && Math.hypot(first[0] - px, first[1] - py) < 7) finishPolygon(d.pts, e.shiftKey);
        else if (Math.hypot(last[0] - px, last[1] - py) >= 3) setDraft({ ...d, pts: [...d.pts, [u, v]] });
        return;
      }
      if (t === 'quadrant') {
        const [rx, ry] = toRaw(axesOf(g), u, v, { u: 0, v: 0 });
        const pops = createQuadrant(item, rx, ry);
        finishGate([pops[1].id, pops[0].id], { x: px, y: py }, e.shiftKey);
        return;
      }
      if (t === 'split') {
        const pops = createSplit(item, makeScale(g.xScale).inv(u));
        finishGate([pops[1].id, pops[0].id], { x: px, y: py }, e.shiftKey);
        return;
      }
      if (t === 'rect' || t === 'ellipse' || t === 'range') {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDraft({ kind: t, a: [u, v], b: [u, v] });
      }
      return;
    }
    if (tool !== 'select') return;
    if (e.altKey && altEdit(g, x, y)) {
      e.stopPropagation();
      return;
    }
    const hit = hitTest(g, x, y, selectedPopId);
    if (hit) {
      const pop = popById(st.ws, hit.shape.popId);
      if (!pop) return;
      const mod = e.shiftKey || e.ctrlKey || e.metaKey;
      // handles and labels are grabbed directly; a gate body only once the gate is selected (quadrant / split regions never)
      const grab = !mod && (hit.part !== 'body' || (pop.id === selectedPopId && hit.shape.kind !== 'quadrant' && hit.shape.kind !== 'split'));
      if (!grab) {
        // the sheet selects (Shift / Ctrl: toggles) and moves the plot; the population is selected after it
        if (!mod) queueMicrotask(() => useStore.getState().setUI({ selectedPopId: pop.id }));
        return;
      }
      e.stopPropagation();
      const sel = st.ui.selectedItemIds.includes(item.id) ? st.ui.selectedItemIds : [item.id];
      st.setUI({ selectedPopId: pop.id, selectedItemIds: sel });
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const override = overrideOf(g, pop.id);
      const at = { popId: pop.id, cx0: e.clientX, cy0: e.clientY, moved: false };
      if (hit.part === 'label') {
        const lb = hit.shape.label!;
        dragRef.current = { ...at, kind: 'label', off0: [lb.x - lb.bx, lb.y - lb.by] };
      } else if (hit.part === 'handle') {
        dragRef.current = { ...at, kind: 'handle', g0: hit.shape.gate, handle: hit.handle!, swapped: hit.shape.swapped, override };
      } else {
        dragRef.current = { ...at, kind: 'gate', g0: hit.shape.gate, swapped: hit.shape.swapped, override };
      }
      return;
    }
    // axis title zones -> parameter picker
    const fr = g.frame;
    const fs = item.options.fontSize * (96 / 72);
    if (x >= fr.x && x <= fr.x + fr.w && y > fr.y + fr.h + fs * 1.3) {
      e.stopPropagation();
      onPickAxis?.('x', e.clientX, e.clientY);
      return;
    }
    if (!isHist && x < fr.x - fs * 3.4 && y >= fr.y && y <= fr.y + fr.h) {
      e.stopPropagation();
      onPickAxis?.('y', e.clientX, e.clientY);
      return;
    }
    // click on empty data area deselects gate (and lets the item move)
    if (inFrame(g, x, y)) st.setUI({ selectedPopId: null });
  };

  const finishPolygon = (pts: [number, number][], keepTool: boolean) => {
    const g = geomRef.current;
    if (!g) return;
    const P = dedupe(g, pts);
    if (P.length < 3) return;
    setDraft(null);
    const ev = plotEvalAxes(useStore.getState().ws, item, g.primarySample);
    const raw = P.map(([u, v]) => toRaw(axesOf(g), u, v, snapTol(g), ev) as Pt);
    const pop = createPolygon(item, raw);
    if (pop) {
      const top = P.reduce((a, b) => (b[1] > a[1] ? b : a));
      const [px, py] = g.toPx(top[0], top[1]);
      finishGate([pop.id], { x: px, y: py }, keepTool);
    }
  };

  const onPointerMove = (e: RPE<HTMLCanvasElement>) => {
    const g = geomRef.current;
    if (!g) return;
    const { x, y } = local(e);
    const dr = draftRef.current;
    if (dr) {
      const [u, v] = frameUV(g, x, y);
      if (dr.kind === 'poly') setDraft({ ...dr, cur: [u, v] });
      else setDraft({ ...dr, b: [u, v] });
      return;
    }
    const [u, v] = g.toDisplay(x, y);
    const d = dragRef.current;
    if (d) {
      e.stopPropagation();
      const ax = axesOf(g);
      const ws0 = useStore.getState().ws;
      // a click with a little jitter changes nothing
      if (!d.moved && Math.hypot(e.clientX - d.cx0, e.clientY - d.cy0) < 2) return;
      d.moved = true;
      const s0 = local({ clientX: d.cx0, clientY: d.cy0 });
      if (d.kind === 'label') {
        const off: [number, number] = [(d.off0[0] + x - s0.x) / g.frame.w, (d.off0[1] + y - s0.y) / g.frame.h];
        updateItem((it) => {
          it.options.labelOff = { ...(it.options.labelOff ?? {}), [d.popId]: off };
          if (it.options.labelPos?.[d.popId]) {
            const lp = { ...it.options.labelPos };
            delete lp[d.popId];
            it.options.labelPos = lp;
          }
        }, 'label:' + d.popId);
        return;
      }
      if (d.kind === 'gate') {
        commitGate(d.popId, translateGate(d.g0, ax, g.toDisplay(s0.x, s0.y), [u, v], d.swapped, evalScalesOf(ws0, d.g0, g.primarySample)), d.override, 'gate:' + d.popId);
        return;
      }
      const ng = editHandle(d.g0, d.handle, u, v, ax, d.swapped, snapTol(g), evalScalesOf(ws0, d.g0, g.primarySample));
      if (ng) commitGate(d.popId, ng, d.override, 'gate:' + d.popId);
      return;
    }
    // value read-out
    if (inFrame(g, x, y)) {
      const fx = (v: number) => (Math.abs(v) >= 1000 ? formatLinear(v, Math.abs(v) / 1000) : v.toPrecision(3));
      const rx = makeScale(g.xScale).inv(u);
      if (omitRef.current.geom !== g) {
        const om = omittedEvents(item, useStore.getState().ws, engine, useStore.getState().ui.activeSampleId);
        omitRef.current = { geom: g, text: om ? `   (${om.omitted.toLocaleString('en-US')} events without a value not drawn)` : '' };
      }
      if (g.yScale) setCursorInfo(`${item.xParam} ${fx(rx)}   ${item.yParam} ${fx(makeScale(g.yScale).inv(v))}${omitRef.current.text}`);
      else setCursorInfo(`${item.xParam} ${fx(rx)}${omitRef.current.text}`);
    } else setCursorInfo('');
    if (tool === 'autogate' && g.hasData) prepareAuto();
    // hover cursor
    if (tool !== 'select' && tool !== 'text') {
      setCursor(tool === 'zoom' ? (e.altKey ? 'zoom-out' : 'zoom-in') : 'crosshair');
      return;
    }
    const hit = tool === 'select' ? hitTest(g, x, y, selectedPopId) : null;
    const full = hit?.part === 'label' ? hit.shape.label?.full ?? '' : '';
    if (full !== hoverTitle) setHoverTitle(full);
    const fr = g.frame;
    const fs = item.options.fontSize * (96 / 72);
    const onAxisTitle = (x >= fr.x && x <= fr.x + fr.w && y > fr.y + fr.h + fs * 1.3) || (!isHist && x < fr.x - fs * 3.4 && y >= fr.y && y <= fr.y + fr.h);
    const grabBody = hit?.part === 'body' && hit.shape.popId === selectedPopId && hit.shape.kind !== 'quadrant' && hit.shape.kind !== 'split';
    setCursor(
      hit?.part === 'handle'
        ? hit.handle === 'vline' || hit.handle === 'cut'
          ? 'col-resize'
          : hit.handle === 'hline'
            ? 'row-resize'
            : 'pointer'
        : hit?.part === 'label' || grabBody
          ? 'move'
          : onAxisTitle
            ? 'context-menu'
            : 'default',
    );
  };

  /** zoom by factor f keeping display point (u,v) in place */
  const zoomAt = (u: number, v: number, f: number) =>
    updateItem((it) => {
      const z = (win: [number, number] | undefined, c: number): [number, number] | undefined => {
        const [w0, w1] = win ?? [0, 1];
        const span = Math.max(1e-4, Math.min(1.2, (w1 - w0) / f));
        if (f < 1 && span >= 1) return undefined;
        const at = w0 + c * (w1 - w0);
        const a = Math.max(-0.1, Math.min(1.1 - span, at - c * span));
        return [a, a + span];
      };
      it.options.xWin = z(it.options.xWin, u);
      if (!isHist) it.options.yWin = z(it.options.yWin, v);
    });

  const onPointerUp = (e: RPE<HTMLCanvasElement>) => {
    const g = geomRef.current;
    const d = dragRef.current;
    dragRef.current = null;
    if (d) {
      e.stopPropagation();
      return;
    }
    const dr = draftRef.current;
    if (!g || !dr || dr.kind === 'poly') return;
    e.stopPropagation();
    const [u0, v0] = dr.a;
    const [u1, v1] = dr.b;
    setDraft(null);
    const pxW = Math.abs(u1 - u0) * g.frame.w;
    const pxH = Math.abs(v1 - v0) * g.frame.h;
    const tol = snapTol(g);
    const keep = e.shiftKey;
    if (dr.kind === 'auto') {
      const click = pxW < 4 && (isHist || pxH < 4);
      const [ua, ub] = [Math.min(u0, u1), Math.max(u0, u1)];
      const [va, vb] = [Math.min(v0, v1), Math.max(v0, v1)];
      const seed: AutoSeed = isHist ? (click ? { u: u0 } : { range: [ua, ub] }) : click ? { u: u0, v: v0 } : { rect: [ua, va, ub, vb] };
      runAuto(seed, keep);
      return;
    }
    if (dr.kind === 'zoom') {
      if (pxW < 4 && (isHist || pxH < 4)) {
        zoomAt(u0, v0, dr.out || e.altKey ? 0.5 : 2);
        return;
      }
      if (pxW < 4 || (!isHist && pxH < 4)) return;
      const comp = (win: [number, number] | undefined, a: number, b: number): [number, number] => {
        const [w0, w1] = win ?? [0, 1];
        const lo = Math.max(-0.1, Math.min(a, b));
        const hi = Math.min(1.1, Math.max(a, b));
        return [w0 + lo * (w1 - w0), w0 + hi * (w1 - w0)];
      };
      updateItem((it) => {
        it.options.xWin = comp(it.options.xWin, u0, u1);
        if (!isHist) it.options.yWin = comp(it.options.yWin, v0, v1);
      });
      return;
    }
    if (dr.kind === 'range') {
      if (pxW < 3) return;
      const pop = createRange(item, toRawBound(g.xScale, Math.min(u0, u1), tol.u), toRawBound(g.xScale, Math.max(u0, u1), tol.u));
      const [px, py] = g.toPx(Math.min(u0, u1), 0.85);
      finishGate([pop.id], { x: px, y: py }, keep);
      return;
    }
    if (pxW < 3 || pxH < 3) return;
    if (dr.kind === 'rect') {
      const pop = createRect(
        item,
        toRawBound(g.xScale, Math.min(u0, u1), tol.u),
        toRawBound(g.xScale, Math.max(u0, u1), tol.u),
        toRawBound(g.yScale!, Math.min(v0, v1), tol.v),
        toRawBound(g.yScale!, Math.max(v0, v1), tol.v),
      );
      const [px, py] = g.toPx(Math.min(u0, u1), Math.max(v0, v1));
      finishGate([pop.id], { x: px, y: py }, keep);
    } else {
      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      const sx = makeScale(g.xScale);
      const sy = makeScale(g.yScale!);
      const R = (uu: number, vv: number): Pt => [sx.inv(uu), sy.inv(vv)];
      const pop = createEllipse(item, R(cu, cv), R(Math.max(u0, u1), cv), R(cu, Math.max(v0, v1)));
      const [px, py] = g.toPx(cu, Math.max(v0, v1));
      finishGate([pop.id], { x: px, y: py }, keep);
    }
  };

  /** pen / touch interrupted or capture lost: end drags, drop shape drafts */
  const endPointer = () => {
    dragRef.current = null;
    const dr = draftRef.current;
    if (dr && dr.kind !== 'poly') setDraft(null);
  };

  // A press on the empty data area is taken by the worksheet (to move the plot), which then also receives the
  // double-click: listen on the item element too, so a double-click inside a range gate's span opens it as well.
  const dblRef = useRef<(e: DblEvent) => void>(() => undefined);
  useEffect(() => {
    const el = canvasRef.current?.closest('.item');
    if (!(el instanceof HTMLElement)) return;
    const h = (ev: MouseEvent) => {
      if (ev.target === el) dblRef.current(ev);
    };
    el.addEventListener('dblclick', h);
    return () => el.removeEventListener('dblclick', h);
  }, []);

  const onDoubleClick = (e: DblEvent) => {
    const g = geomRef.current;
    if (!g) return;
    const dr = draftRef.current;
    if (dr && dr.kind === 'poly') {
      e.stopPropagation();
      const pts = dedupe(g, dr.pts);
      if (pts.length >= 3) finishPolygon(pts, e.shiftKey);
      else setDraft({ ...dr, pts });
      return;
    }
    // the double-click that completed a gate
    if (performance.now() - lastFinish.current < 500) {
      e.stopPropagation();
      return;
    }
    if (tool === 'zoom') {
      e.stopPropagation();
      resetZoom();
      return;
    }
    if (tool !== 'select') return;
    const { x, y } = local(e);
    const hit = hitTest(g, x, y, null);
    // a range gate is drawn as a bar near the top, but the whole span under it is the population: a double-click
    // anywhere inside the span opens it (the nearest bar wins; a range is more specific than a split region)
    if ((!hit || (hit.part === 'body' && (hit.shape.kind === 'split' || hit.shape.kind === 'quadrant'))) && inFrame(g, x, y)) {
      let best: { id: string; d: number } | null = null;
      for (const s of g.gates) {
        if (s.kind !== 'range' || s.handles.length < 2) continue;
        const x0 = Math.max(g.frame.x, Math.min(s.handles[0].x, s.handles[1].x));
        const x1 = Math.min(g.frame.x + g.frame.w, Math.max(s.handles[0].x, s.handles[1].x));
        if (x < x0 || x > x1) continue;
        const d = Math.abs(y - s.handles[0].y);
        if (!best || d < best.d) best = { id: s.popId, d };
      }
      if (best) {
        e.stopPropagation();
        openPopulationPlot(best.id);
        return;
      }
    }
    if (hit && hit.part !== 'handle') {
      e.stopPropagation();
      openPopulationPlot(hit.shape.popId);
      return;
    }
    // the empty data area: open this plot large in the gating view
    if (!hit && !inGatingView && inFrame(g, x, y)) {
      e.stopPropagation();
      openGatingView(item.id);
    }
  };

  dblRef.current = onDoubleClick;

  const openPopulationPlot = (popId: string) => {
    const st = useStore.getState();
    const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
    if (!sheet) return;
    // the worksheet item (the gating view shows an enlarged copy)
    const item = (sheet.items.find((i) => i.id === itemRef.current.id && i.kind === 'plot') as PlotItem | undefined) ?? itemRef.current;
    const pop = popById(st.ws, popId);
    // gated further: the axes of the next gate (as a double-click in the population tree); else guess the next step
    const next = childGateSpec(st.ws, popId);
    const isRange = next ? next.type === 'histogram' : !!pop && (pop.gate.type === 'range' || pop.gate.type === 'split');
    const [nx, ny] = next ? [next.x, next.y] : isRange ? [item.xParam, item.yParam] : defaultNextAxes(st.ws, item);
    const { x, y } = findFreeSlot(sheet, item.w, item.h, { x: item.x + item.w + sheet.grid, y: item.y });
    const np = newPlotItem(isRange ? 'histogram' : item.plotType === 'histogram' ? 'pseudo' : item.plotType, nx, ny, x, y, item.w, item.h, popId, item.layers[0]?.sample ?? 'active');
    // style carries over; per-plot scales, zoom and label positions do not
    np.options = { ...item.options, title: undefined, labelPos: {}, labelOff: {}, xScale: undefined, yScale: undefined, xWin: undefined, yWin: undefined };
    np.id = uid('plot');
    st.update((ws) => {
      const sh = ws.worksheets.find((s) => s.id === sheetId)!;
      sh.items.push(np);
      growPageToFit(sh, [np]);
    });
    st.setUI({ selectedItemIds: [np.id] });
    // in the gating view the next step is shown there
    if (inGatingView) st.setUI({ gatingItemId: np.id, keyItemId: np.id, selectedPopId: null });
  };

  // keyboard while drafting (owner only): Escape cancels the draft (the tool stays), Backspace / Delete remove the
  // last polygon vertex, Enter closes the polygon (Shift+Enter keeps the tool)
  useEffect(() => {
    if (!draft) return;
    const onKey = (ev: KeyboardEvent) => {
      const d = draftRef.current;
      if (!d || drafts.owner !== me || isEditable(ev.target)) return;
      const swallow = () => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      if (ev.key === 'Escape') {
        swallow();
        setDraft(null);
      } else if (d.kind === 'poly' && (ev.key === 'Backspace' || ev.key === 'Delete')) {
        swallow();
        setDraft(d.pts.length > 1 ? { ...d, pts: d.pts.slice(0, -1) } : null);
      } else if (d.kind === 'poly' && ev.key === 'Enter') {
        swallow();
        if (d.pts.length >= 3) finishPolygon(d.pts, ev.shiftKey);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // arrow keys nudge the selected gate shown in this (selected) plot: 1 % of the axis, Ctrl/Cmd 0.1 %, Shift 5 % (Alt+Up/Down steps samples)
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || !ev.key.startsWith('Arrow') || ev.altKey || isEditable(ev.target)) return;
      // keys aimed at a focused list or tree (sample list, population tree) are theirs
      const t = ev.target as HTMLElement | null;
      if (t && t !== document.body && t !== document.documentElement && !t.closest?.('.sheet-scroll')) return;
      const st = useStore.getState();
      const g = geomRef.current;
      const popId = st.ui.selectedPopId;
      if (!g || !popId || st.ui.view !== 'sheet' || !st.ui.selectedItemIds.includes(itemRef.current.id)) return;
      const shape = g.gates.find((s) => s.popId === popId);
      if (!shape) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const step = ev.ctrlKey || ev.metaKey ? 0.001 : ev.shiftKey ? 0.05 : 0.01;
      const du = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
      const dv = !g.yScale ? 0 : ev.key === 'ArrowDown' ? -step : ev.key === 'ArrowUp' ? step : 0;
      if (!du && !dv) return;
      const from: [number, number] = [0.5, 0.5];
      const ng = translateGate(shape.gate, axesOf(g), from, [from[0] + du, from[1] + dv], shape.swapped, evalScalesOf(st.ws, shape.gate, g.primarySample));
      commitGate(popId, ng, overrideOf(g, popId), 'nudge:' + popId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // cancel drafts when tool changes; a pending auto gate is kept (created)
  useLayoutEffect(() => {
    setDraft(null);
    if (pendingRef.current && tool !== 'autogate') commitPending('silent');
    if (tool === 'autogate') window.setTimeout(warmUpAutoGate, 0);
    else sessRef.current = null; // free the density / count grids
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps

  // pending auto gate: Enter = OK (Shift+Enter keeps the tool), Escape / Delete / Ctrl+Z = cancel, Left / Right = tighter / looser
  useEffect(() => {
    if (!pending) return;
    const onKey = (ev: KeyboardEvent) => {
      const p = pendingRef.current;
      if (!p || useStore.getState().ui.dialog) return;
      const inPop = !!popRef.current && popRef.current.contains(ev.target as Node);
      if (!inPop && isEditable(ev.target)) return;
      const swallow = () => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      const mod = ev.ctrlKey || ev.metaKey;
      // a focused OK / Cancel button handles Enter / Space itself
      if (inPop && (ev.target as HTMLElement).tagName === 'BUTTON' && (ev.key === 'Enter' || ev.key === ' ')) return;
      if (ev.key === 'Enter') {
        swallow();
        commitPending('ok', ev.shiftKey);
      } else if (ev.key === 'Escape' || ev.key === 'Delete' || ev.key === 'Backspace' || (mod && ev.key.toLowerCase() === 'z')) {
        swallow();
        setPending(null);
      } else if (!inPop && !mod && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        swallow();
        setTightness(tightnessFromAlpha(p.alpha) + (ev.key === 'ArrowLeft' ? -0.05 : 0.05) * (ev.shiftKey ? 3 : 1));
      }
    };
    // a press anywhere else (another plot, the ribbon, the page) keeps the pending gate
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      // the AI assistant panel steers the preview itself (OK / Skip there)
      if (t && (popRef.current?.contains(t) || t === canvasRef.current || (t as Element).closest?.('[data-ag-keep]'))) return;
      commitPending('silent');
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  // the data changed under a pending auto gate (other sample, edited parent gate, undo): recompute it, or drop it when
  // the plot now shows other axes / another population
  useEffect(() => {
    const p = pendingRef.current;
    if (!p) return;
    if (p.sig !== plotSig(item)) {
      setPending(null);
      return;
    }
    const res = autoCompute(p.seed, p.alpha);
    if (!res || !res.count) {
      setPending(null);
      useStore.getState().toast('The auto gate found no population here in this sample; it was discarded.', 'info');
    } else if (res.count !== p.res.count || JSON.stringify(res) !== JSON.stringify(p.res)) setPending({ ...p, res });
  }, [ws, item, activeSampleId, dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // the popover sits under the plot; above it when there is no room below in the visible sheet
  useLayoutEffect(() => {
    const el = popRef.current;
    const cv = canvasRef.current;
    const sc = el?.closest('.sheet-scroll');
    if (!el || !cv || !sc) return;
    const h = el.getBoundingClientRect().height;
    const r = cv.getBoundingClientRect();
    const box = sc.getBoundingClientRect();
    const fitsBelow = r.bottom + 4 + h <= box.bottom - 4;
    const fitsAbove = r.top - 4 - h >= box.top + 4;
    const want = !fitsBelow && fitsAbove;
    if (want !== popAbove) setPopAbove(want);
  }, [pending !== null, item.h, item.y, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  const o = item.options;
  const zoomed = !!(o.xWin || (!isHist && o.yWin));
  const differs = (ov: unknown, ch: string) => !!ov && JSON.stringify(ov) !== JSON.stringify(engine.scaleFor(ws, ch, geomRef.current?.primarySample ?? null));
  const scaleWarn = differs(o.xScale, item.xParam) || (!isHist && differs(o.yScale, item.yParam));
  const aiNotes = aiGateNotes(ws, item);

  const pend = pending;
  const fr = geomRef.current?.frame;
  const popStyle: CSSProperties = {
    left: Math.round((fr ? fr.x + fr.w / 2 : item.w / 2) * zoom),
    // the gating view has no room around the plot: the popover sits on the plot's lower edge
    ...(inGatingView ? { bottom: 4 } : popAbove ? { bottom: item.h * zoom + 4 } : { top: item.h * zoom + 4 }),
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ cursor, touchAction: 'none' }}
        title={hoverTitle || undefined}
        onPointerLeave={() => {
          setHoverTitle('');
          setCursorInfo('');
          cancelPrepare();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          if (draftRef.current) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
      {pend && (
        <>
          <canvas ref={overlayRef} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} />
          <div
            ref={popRef}
            className="ag-pop"
            style={popStyle}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            {pend.ai && (
              <div className="ag-ai" title={pend.ai.meta.note}>
                <b>{pend.ai.meta.title}</b>
                {pend.ai.meta.note && <span>{pend.ai.meta.note}</span>}
              </div>
            )}
            <div className="ag-row" title="How far the gate reaches into the population's sparse edges (Left / Right arrow keys)">
              <span className="ag-end">Tight</span>
              <input
                type="range"
                min={0}
                max={1000}
                step={1}
                value={Math.round(tightnessFromAlpha(pend.alpha) * 1000)}
                list="ag-presets"
                aria-label="Gate tightness"
                onChange={(e) => setTightness(Number(e.target.value) / 1000)}
              />
              <datalist id="ag-presets">
                {Object.values(SENSITIVITY).map((a) => (
                  <option key={a} value={Math.round(tightnessFromAlpha(a) * 1000)} />
                ))}
              </datalist>
              <span className="ag-end">Loose</span>
            </div>
            <div className="ag-row">
              <span className="ag-swatch" style={{ background: pend.color }} />
              <span className="ag-count" title={`${pend.res.count.toLocaleString('en-US')} of ${pend.res.parentCount.toLocaleString('en-US')} events of the parent population`}>
                <b>{pend.res.count.toLocaleString('en-US')}</b> events · {fmtPct(pend.res.parentCount ? (100 * pend.res.count) / pend.res.parentCount : NaN)} %
              </span>
              <button className="btn xs" title="Discard (Esc)" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button className="btn xs primary" title="Create the gate (Enter)" onClick={(e) => commitPending('ok', e.shiftKey)}>
                OK
              </button>
            </div>
          </div>
        </>
      )}
      {(zoomed || scaleWarn || aiNotes.length > 0) && (
        <div style={{ position: 'absolute', left: 3, bottom: 3, display: 'flex', gap: 3, zIndex: 2 }}>
          {zoomed && (
            <div
              style={{ ...badge, background: '#1463b8', padding: '0 6px', cursor: 'pointer' }}
              title="Zoomed in. Click to show the full axes."
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                resetZoom();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              zoomed ×
            </div>
          )}
          {scaleWarn && (
            <div style={{ ...badge, background: '#e8890c', width: 14, textAlign: 'center' }} title="Axis scale differs from the gating scale; gates are evaluated on the workspace scale">
              !
            </div>
          )}
          {aiNotes.length > 0 && (
            <div className="ag-ai-badge" style={badge} title={aiNotes.join('\n')}>
              AI
            </div>
          )}
        </div>
      )}
    </>
  );
}
