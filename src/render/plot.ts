// Renders a PlotItem (dot / pseudocolor / density / contour / zebra / histogram, incl. overlays and gates) onto a Painter.
import type { Engine } from '../core/engine';
import {
  channelDisplayName,
  missingChannelReason,
  popAncestors,
  popById,
  popChildren,
  popDescendants,
  type DensityScale,
  type GateGeom,
  type Layer,
  type PlotItem,
  type PlotOptions,
  type Population,
  type Workspace,
  type Pt,
} from '../core/model';
import { computeTicks, formatLinear, formatTick, makeScale, tickUnit, windowScale, type ScaleDef } from '../core/transforms';
import { gateEvalScales } from '../core/gating';
import { popNotApplicableReason, resolvePopFor } from '../core/scope';
import { scaleFor } from '../core/instruments';
import { colormapLUT, hexToRgb, luminance, mixHex, type CmapSpec } from './colormaps';
import { formatStat } from '../core/stats';
import { binStat, blur1d, blur2d, contourLines, hist1d, hist2d, hist2dEdge, logThresholds, probabilityThresholds, rankBins, sampleGrid } from './density';
import { measureRich, parseSup, runs, type CanvasPainter, type Painter, type RichText, type TextRun, type TextStyle } from './painter';
import { layoutLabelsDetailed, overlapArea, pointInPolygon, type Box, type LabelLine as OutlineLine, type LabelRegion, type LabelRequest, type LayoutResult } from './labels';
import { brightOn, gateLabelPx, histModeOfLabel, isDarkColor, middleEllipsis, MIN_LABEL_PT, optsX, pageColorOf, panelLetterOf, sheetOf, shortenName, titleModeOf } from './figstyle';

export const PT = 96 / 72;

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResolvedLayer {
  layer: Layer;
  sampleId: string;
  popId: string;
  color: string;
  label: string;
}

export interface GateShape {
  popId: string;
  gate: GateGeom;
  kind: GateGeom['type'];
  swapped: boolean;
  /** pixel polygon outline for hit testing (closed) or null; may extend beyond the frame */
  outline: number[] | null;
  /** polygons: outline points per edge (outline[2*k*edgeSamples] is vertex k) */
  edgeSamples?: number;
  /** handle positions (pixels); handles outside the frame are not drawn or grabbed */
  handles: { x: number; y: number; id: string }[];
  /** drawn label box; (bx, by): where the box sits without a custom offset; `full`: the text of a shortened label */
  label?: { x: number; y: number; w: number; h: number; bx: number; by: number; full?: string };
}

export interface PlotGeometry {
  frame: Frame;
  xScale: ScaleDef;
  yScale: ScaleDef | null;
  layers: ResolvedLayer[];
  gates: GateShape[];
  hasData: boolean;
  primaryPop: string;
  primarySample: string | null;
  /** display -> pixel */
  toPx(u: number, v: number): [number, number];
  /** pixel -> display */
  toDisplay(x: number, y: number): [number, number];
}

export interface RenderEnv {
  ws: Workspace;
  engine: Engine;
  activeSampleId: string | null;
  selectedPopId?: string | null;
  rasterScale: number; // device pixels per px for the raster layer
  makeCanvas: (w: number, h: number) => HTMLCanvasElement;
  forExport?: boolean;
  /** per-plot memo for expensive raster/density work */
  cache?: Map<string, { deps: unknown[]; value: unknown }>;
  /** on screen: statistics do not wait for background computations (they show "computing" until those are in) */
  deferStats?: boolean;
  /**
   * The plot is drawn larger than its worksheet item (gating view): gate labels are laid out at this (worksheet) size
   * and carried over, so they sit where the figure will have them.
   */
  labelRef?: { w: number; h: number };
}

function memo<T>(env: RenderEnv, key: string, deps: unknown[], compute: () => T): T {
  const c = env.cache?.get(key);
  if (c && c.deps.length === deps.length && c.deps.every((d, i) => d === deps[i])) return c.value as T;
  const value = compute();
  env.cache?.set(key, { deps, value });
  return value;
}

// ------------------------------------------------------------------ progressive rendering
//
// On screen (a plot with a memo cache), a raster that has to be recomputed again within BURST_MS of its last
// computation (a gate or axis being dragged, the sheet being zoomed) is drawn as a quick preview: the previous raster
// stretched to the new size when only the size changed, else from a subsample of the events. The full raster follows
// once the changes stop (the plot is asked to redraw through engine.notify()). Exports always draw everything.

/** Changes closer together than this are a burst (ms). */
const BURST_MS = 250;
/** Populations up to this size are always drawn in full. */
const PREVIEW_MIN = 120000;
/** Events drawn in a preview. */
const PREVIEW_N = 60000;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface Progress {
  /** set while rendering when a preview (or a pending background result) was drawn */
  preview: boolean;
  /** start of the current render */
  start: number;
}

function progressOf(env: RenderEnv): Progress | null {
  return (env.cache?.get('progress')?.value as Progress | undefined) ?? null;
}

/** Whether a memo entry recomputed now would be part of a burst of changes (screen rendering only). */
function inBurst(env: RenderEnv, key: string): boolean {
  const pr = progressOf(env);
  if (!env.cache || env.forExport || !pr) return false;
  const t = env.cache.get(key + ':t')?.value as number | undefined;
  // computed by an earlier render, shortly before this one
  return t !== undefined && t < pr.start && pr.start - t < BURST_MS;
}

function stamp(env: RenderEnv, key: string) {
  env.cache?.set(key + ':t', { deps: [], value: now() });
}

/** Mark the current render as a preview and ask for a full redraw once the burst is over. */
function previewDrawn(env: RenderEnv) {
  const pr = progressOf(env);
  if (pr) pr.preview = true;
  const c = env.cache;
  if (!c) return;
  const old = c.get('refine')?.value as ReturnType<typeof setTimeout> | undefined;
  if (old) clearTimeout(old);
  const engine = env.engine;
  c.set('refine', {
    deps: [],
    value: setTimeout(() => {
      c.delete('refine');
      engine.notify();
    }, BURST_MS + 30),
  });
}

// ------------------------------------------------------------------ whole-plot snapshot (screen)

/** Glyphs drawn before the bundled faces finished loading are redrawn once they are in. */
let fontEpoch = 0;
try {
  if (typeof document !== 'undefined' && document.fonts?.addEventListener) document.fonts.addEventListener('loadingdone', () => fontEpoch++);
} catch {
  /* no font loading events */
}

interface Snapshot {
  key: unknown[];
  canvas: HTMLCanvasElement;
  geom: PlotGeometry;
  final: boolean;
}

/**
 * Everything a plot's picture depends on, except the item position: the plot item's own fields, the workspace parts
 * plots read, the layout fields of the other plots of its sheet (frame alignment), the engine data version, the render
 * parameters and the canvas. Equal keys give the same picture.
 */
function snapshotKey(item: PlotItem, w: number, h: number, env: RenderEnv, cv: HTMLCanvasElement): unknown[] {
  const { ws } = env;
  const key: unknown[] = [
    item.id, item.plotType, item.xParam, item.yParam, item.layers, item.options, w, h,
    env.activeSampleId, env.selectedPopId ?? null, env.rasterScale, env.engine, env.engine.version, env.labelRef?.w ?? 0, env.labelRef?.h ?? 0,
    ws.samples, ws.groups, ws.compensations, ws.scales, ws.instrumentScales, ws.channelLabels, ws.populations, ws.style, ws.derived,
    cv.width, cv.height, fontEpoch,
  ];
  const sheet = ws.worksheets.find((s) => s.items.some((i) => i.id === item.id));
  if (sheet) {
    key.push(sheet.pageColor ?? '');
    for (const it of sheet.items) {
      if (it.kind === 'plot' && it.id !== item.id) key.push(it.id, it.plotType, it.xParam, it.yParam, it.layers, it.options, it.w, it.h);
      // its panel letter (the title keeps clear of it)
      else if (it.kind === 'text' && (it as { forItem?: string }).forItem === item.id) key.push(it, sheet.items.find((i) => i.id === item.id)?.x, sheet.items.find((i) => i.id === item.id)?.y);
    }
  }
  return key;
}

function sameKey(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ------------------------------------------------------------------ appearance

export interface Theme {
  bg: string | null; // null: transparent
  fg: string; // axes, text
  labelBg: string; // gate label / legend boxes
  dark: boolean;
}

export const BG_COLORS = { white: '#ffffff', dark: '#1d2026', black: '#000000' };

/**
 * Colors of a plot (or chart / statistics box). `page`: the color of the page it sits on. A background left unset is
 * white on light pages and transparent on dark ones (no gray boxes on a dark slide); a transparent item takes its text
 * color from the page.
 */
export function plotTheme(o: Pick<PlotOptions, 'bg' | 'bgColor'>, page?: string | null): Theme {
  const pg = page ?? '#ffffff';
  const b = o.bg ?? (isDarkColor(pg) ? 'transparent' : 'white');
  const bg = b === 'transparent' ? null : b === 'custom' ? o.bgColor ?? '#ffffff' : BG_COLORS[b] ?? '#ffffff';
  const dark = luminance(bg ?? pg) < 0.18;
  return { bg, fg: dark ? '#e8eaed' : '#000000', labelBg: bg ?? pg, dark };
}

/** The theme of a plot on its worksheet (page color from the sheet holding it). */
export function itemPlotTheme(o: Pick<PlotOptions, 'bg' | 'bgColor'>, ws: Workspace, itemId: string): Theme {
  return plotTheme(o, pageColorOf(sheetOf(ws, itemId)));
}

/**
 * A data color that stays visible on the background: default near-black dots and lines turn light on dark plots, and
 * the default gate / overlay palette takes brighter variants there.
 */
function visibleOn(c: string, th: Theme): string {
  if (!th.dark) return c;
  if (luminance(c) < 0.03) return th.fg;
  return brightOn(c, th.bg ?? '#1d2026');
}

export function cmapOf(o: PlotOptions): CmapSpec {
  return { name: o.colormap, reverse: o.cmapReverse, stops: o.cmapStops };
}

/** Plot type and color mode that use a colormap / color scale. */
export function usesColormap(item: PlotItem): boolean {
  const o = item.options;
  switch (item.plotType) {
    case 'pseudo':
    case 'density':
    case 'zebra':
      return true;
    case 'contour':
      return !!o.contourFill || o.contourLines === 'level';
    case 'dot':
      return o.colorMode === 'density' || o.colorMode === 'param';
    default:
      return false;
  }
}

/** Where the color bar goes (null: none). */
export function colorBarPos(item: PlotItem): 'right' | 'top' | null {
  const cb = item.options.colorBar ?? 'none';
  return cb !== 'none' && usesColormap(item) ? cb : null;
}

export function resolveLayers(item: PlotItem, ws: Workspace, activeSampleId: string | null, engine: Engine): ResolvedLayer[] {
  const out: ResolvedLayer[] = [];
  item.layers.forEach((l, i) => {
    if (l.visible === false) return;
    const sampleId = l.sample === 'active' ? activeSampleId : l.sample;
    if (!sampleId || !engine.has(sampleId)) return;
    const s = ws.samples.find((x) => x.id === sampleId);
    const pop = l.population === 'root' ? null : popById(ws, l.population);
    if (l.population !== 'root' && !pop) return;
    const popName = pop ? pop.name : 'All Events';
    const label = l.label || (item.layers.length > 1 ? (sameSampleAcross(item) ? popName : samePopAcross(item) ? s?.name ?? '' : `${s?.name ?? ''}${l.population !== 'root' ? ' / ' + popName : ''}`) : popName);
    const sampleColor = item.layers.length > 1 && l.sample !== 'active' ? s?.color : undefined;
    // a population that does not apply to the sample stands for its group-specific copy that does (same path of
    // names), so a gating sheet shows each sample's own gates (gate editing resolves the same way: gateOps.parentOf)
    const popId = l.population === 'root' ? 'root' : resolvePopFor(ws, sampleId, l.population);
    out.push({ layer: l, sampleId, popId, color: l.color || sampleColor || defaultLayerColor(i, item), label });
  });
  return out;
}

function sameSampleAcross(item: PlotItem) {
  return item.layers.every((l) => l.sample === item.layers[0].sample);
}

/** one population in several samples: the legend names the samples (the title names the population) */
function samePopAcross(item: PlotItem) {
  const vis = item.layers.filter((l) => l.visible !== false);
  return vis.length > 1 && vis.every((l) => l.population === vis[0].population && l.sample !== 'active');
}

function defaultLayerColor(i: number, item: PlotItem) {
  if (i === 0 && item.layers.length === 1) return item.options.dotColor;
  const palette = ['#1f1f1f', '#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#8c564b'];
  return palette[i % palette.length];
}

/**
 * Scale of a plot axis: the plot's own (override), else the scale of `ch` for the plot's sample (its instrument's own
 * scale when the workspace has per-instrument scales, see core/instruments.ts), else the workspace scale.
 */
export function effectiveScale(ws: Workspace, ch: string, override?: ScaleDef, sampleId?: string | null): ScaleDef {
  return override ?? scaleFor(ws, ch, sampleId) ?? { type: 'linear', min: 0, max: 262144 };
}

/** The sample whose scales a plot's axes use: that of its first visible layer ('active' = the active sample). */
export function plotSampleId(item: PlotItem, activeSampleId: string | null | undefined): string | null {
  const l = item.layers.find((x) => x.visible !== false) ?? item.layers[0];
  if (!l) return activeSampleId ?? null;
  return l.sample === 'active' ? activeSampleId ?? null : l.sample;
}

/** Scale of the third (color) parameter, windowed to the color range. */
export function colorParamScale(ws: Workspace, o: PlotOptions, sampleId?: string | null): ScaleDef | null {
  if (!o.colorParam) return null;
  const base = effectiveScale(ws, o.colorParam, o.colorParamScale, sampleId);
  const [lo, hi] = rangeOf(o);
  return lo > 0 || hi < 1 ? windowScale(base, lo, hi) : base;
}

function rgba(hex: string, a = 255): number {
  const [r, g, b] = hexToRgb(hex);
  // little-endian ABGR for Uint32 view on ImageData
  return ((a & 255) << 24) | (b << 16) | (g << 8) | r;
}

function cssRgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

const lut32Cache = new WeakMap<Uint8Array, Uint32Array>();
function lut32(spec: CmapSpec): Uint32Array {
  const lut = colormapLUT(spec);
  let c = lut32Cache.get(lut);
  if (!c) {
    c = new Uint32Array(256);
    for (let i = 0; i < 256; i++) c[i] = (255 << 24) | (lut[i * 3 + 2] << 16) | (lut[i * 3 + 1] << 8) | lut[i * 3];
    lut32Cache.set(lut, c);
  }
  return c;
}
const lutHex = (spec: CmapSpec, t: number) => {
  const lut = colormapLUT(spec);
  const i = Math.max(0, Math.min(255, Math.round(t * 255)));
  return '#' + [lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
};

/** Color range as fractions [lo, hi] of the color scale. */
function rangeOf(o: PlotOptions): [number, number] {
  const r = o.colorRange ?? [0, 100];
  const lo = Math.min(Math.max(r[0], 0), 99) / 100;
  const hi = Math.max(Math.min(r[1], 100) / 100, lo + 0.01);
  return [lo, hi];
}

interface DensMap {
  f: (c: number) => number; // events per bin -> [0,1]
  inv: (t: number) => number;
}

/** Mapping of a density (events per bin) onto the color scale; a missing scale reproduces v1 (power 0.55). */
function densityMap(scale: DensityScale | undefined, max: number): DensMap {
  const m = max > 0 ? max : 1;
  switch (scale) {
    case 'linear':
      return { f: (c) => c / m, inv: (t) => t * m };
    case 'sqrt':
      return { f: (c) => Math.sqrt(c / m), inv: (t) => t * t * m };
    case 'log': {
      const L = Math.log1p(m);
      return { f: (c) => Math.log1p(c) / L, inv: (t) => Math.expm1(t * L) };
    }
    default:
      return { f: (c) => Math.pow(c / m, 0.55), inv: (t) => Math.pow(t, 1 / 0.55) * m };
  }
}

/**
 * Largest bin value away from the grid border. Events beyond the axis ends pile up in the border bins; they keep the
 * top color but do not compress the color scale of the populations inside the plot.
 */
function interiorMax(grid: Float32Array, g: number): number {
  let mx = 0;
  for (let y = 1; y < g - 1; y++) for (let x = 1, r = y * g; x < g - 1; x++) if (grid[r + x] > mx) mx = grid[r + x];
  if (mx > 0) return mx;
  for (let i = 0; i < grid.length; i++) if (grid[i] > mx) mx = grid[i];
  return mx;
}

/** What the color bar shows. */
export interface ColorInfo {
  /** end: label of a clipped end of the color range (drawn first) */
  ticks: { t: number; label: RichText; end?: boolean }[];
  title: string;
  /** the colors start at this colormap position (contour fills on dark backgrounds, see fillStart) */
  from?: number;
}

/** Compact value label (one or two significant digits beyond the integer part, K / M units, true minus sign). */
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (!(a > 0)) return '0';
  const step = Math.pow(10, Math.floor(Math.log10(a)) - 1);
  return formatTick(v, step, tickUnit(a, step));
}

/** End labels for a clipped color range: values beyond the ends take the end colors. */
function clipEnds(lo: number, hi: number, v0: number, v1: number, fmt: (v: number) => RichText): ColorInfo['ticks'] {
  const out: ColorInfo['ticks'] = [];
  const pre = (sym: string, l: RichText): RichText => (typeof l === 'string' ? sym + l : [{ text: sym }, ...l]);
  if (lo > 0.001) out.push({ t: 0, label: pre('\u2264', fmt(v0)), end: true });
  if (hi < 0.999) out.push({ t: 1, label: pre('\u2265', fmt(v1)), end: true });
  return out;
}

function fmtCount(v: number): RichText {
  if (v >= 1e4) {
    const e = Math.log10(v);
    if (Math.abs(e - Math.round(e)) < 1e-6) return [{ text: '10' }, { text: String(Math.round(e)), sup: true }];
  }
  return v >= 10 || v === 0 ? Math.round(v).toLocaleString('en-US') : String(Number(v.toPrecision(2)));
}

/** Color bar ticks for a density mapping (events per bin), honouring the color range. */
function densityTicks(scale: DensityScale | undefined, m: DensMap, lo: number, hi: number): ColorInfo['ticks'] {
  const c0 = m.inv(lo);
  const c1 = m.inv(hi);
  let vals: number[];
  if (scale === 'log') {
    vals = [];
    for (let v = 1; v <= c1 * 1.0001; v *= 10) vals.push(v);
    if (c0 <= 0) vals.unshift(0);
  } else vals = computeTicks({ type: 'linear', min: c0, max: c1 }, { target: 4 }).filter((t) => t.major).map((t) => t.value);
  return [
    ...clipEnds(lo, hi, c0, c1, (v) => fmtCount(v >= 10 ? Number(v.toPrecision(2)) : v)),
    ...vals.map((v) => ({ t: (m.f(v) - lo) / (hi - lo), label: fmtCount(v) })).filter((x) => x.t >= -1e-6 && x.t <= 1 + 1e-6),
  ];
}

const RANK_TICKS = (lo: number, hi: number) =>
  [0, 25, 50, 75, 100].map((p) => ({ t: (p / 100 - lo) / (hi - lo), label: `${p}` })).filter((x) => x.t >= -1e-6 && x.t <= 1 + 1e-6);

// ------------------------------------------------------------------ layout (margins from measured text)

// one typographic system: legends at the body size of the plot (gate labels: gateLabelPx); color bar scales a little
// smaller (like a secondary axis), never below 6 pt
const LEGEND_SCALE = 1;
const cbSize = (fs: number) => Math.min(fs, Math.max(fs * 0.9, MIN_LABEL_PT * PT));

/** Axis titles ('' when hidden). */
function axisTitleX(item: PlotItem, ws: Workspace): string {
  return item.options.xLabel ?? channelDisplayName(ws, item.xParam);
}
function axisTitleY(item: PlotItem, ws: Workspace): string {
  const o = item.options;
  if (item.plotType === 'histogram') {
    const def = o.histMode === 'normalized' ? 'Normalized to mode' : 'Count';
    if (o.yLabel === undefined) return def;
    // a typed title naming the other mode ("% of max" on a count axis) is out of date: the axis says what it shows
    const named = histModeOfLabel(o.yLabel);
    return named && named !== o.histMode ? def : o.yLabel;
  }
  return o.yLabel ?? channelDisplayName(ws, item.yParam);
}

const xTarget = (fw: number, fs: number) => Math.max(3, Math.round(fw / (fs * 5)));
const yTarget = (fh: number, fs: number) => Math.max(3, Math.round(fh / (fs * 3)));
const histYDef = (ymax: number): ScaleDef => ({ type: 'linear', min: 0, max: ymax || 1 });
/** tick label gap from the axis line */
const tickGap = (o: PlotOptions, fs: number) => (o.tickDir === 'in' ? fs * 0.3 : fs * 0.42 + fs * 0.25);

/** Width of the color bar (thinner on small plots). */
function colorBarWidth(item: PlotItem, fs: number): number {
  return Math.max(fs * 0.35, Math.min(fs * 0.6, Math.min(item.w, item.h) * 0.028));
}
/** Width reserved for color bar tick labels unless the actual labels are wider. */
function cbLabelTemplate(st: TextStyle): number {
  return measureRich('100', { ...st, size: cbSize(st.size) });
}

interface LegendBoxSize {
  pos: 'outside-right' | 'below';
  w: number;
  h: number;
}

interface LayoutIn {
  item: PlotItem;
  w: number;
  h: number;
  ws: Workspace;
  xs: ScaleDef;
  ys: ScaleDef | null;
  histYMax: number;
  cbLabelW: number;
  legend: LegendBoxSize | null;
  /** panel letter on the item (item coordinates): the frame starts below it */
  letter?: Box | null;
  /** room reserved above or right of the frame for gate labels that find no clear place in it */
  zone?: LabelZoneSpec | null;
}

/** Room for gate labels outside the frame (see chooseLabelZone in renderPlotBody). */
interface LabelZoneSpec {
  side: 'top' | 'right';
  /** px, including the gap to the frame */
  size: number;
}

/** Margins with the room of a label zone added (on this plot only: aligned plots keep theirs). */
function withZone(m: Margins, z: LabelZoneSpec | null | undefined): Margins {
  if (!z) return m;
  return z.side === 'top' ? { ...m, T: m.T + z.size } : { ...m, R: m.R + z.size };
}

interface Margins {
  L: number;
  R: number;
  T: number;
  B: number;
}

/** Margins around the data frame from the measured tick labels, axis titles, color bar and outside legend. */
function plotMargins(a: LayoutIn): Margins {
  const o = a.item.options;
  const fs = o.fontSize * PT;
  const st: TextStyle = { family: a.ws.style.fontFamily, size: fs, color: '#000000' };
  const hideY = a.item.plotType === 'histogram' && !!o.histHideY;
  const gap = tickGap(o, fs);
  const cb = colorBarPos(a.item);
  let T = (o.showTitle ? fs * 1.6 : fs * 0.62) + (cb === 'top' ? colorBarTopH(a.item, fs) : 0);
  // a panel letter in the top-left corner: the frame (and its top tick label) starts below it
  if (a.letter && a.letter.y < fs * 2) T = Math.max(T, a.letter.y + a.letter.h + (o.showTitle ? 0 : fs * 0.35));
  let B = gap + fs * 1.02 + (axisTitleX(a.item, a.ws) !== '' ? fs * 1.28 : 0) + fs * 0.14 + (a.legend?.pos === 'below' ? a.legend.h + fs * 0.25 : 0);
  let L = fs * 0.45;
  if (!hideY) {
    const fh = Math.max(10, a.h - T - B);
    let wy = 0;
    for (const t of computeTicks(a.ys ?? histYDef(a.histYMax), { target: yTarget(fh, fs) })) if (t.major && t.label) wy = Math.max(wy, measureRich(tickLabelRuns(t.label), st));
    L = gap + wy + (axisTitleY(a.item, a.ws) !== '' ? fs * 0.3 + fs * 0.95 : 0) + fs * 0.18;
  }
  let R = fs * 0.35;
  if (cb === 'right') R = fs * 0.45 + colorBarWidth(a.item, fs) + fs * 0.42 + a.cbLabelW + fs * 0.3 + cbSize(fs) * 0.95 + fs * 0.15;
  if (a.legend?.pos === 'outside-right') R += a.legend.w + fs * 0.45;
  // titles that need two lines get the room for the second one
  const tst: TextStyle = o.boldLabels ? { ...st, weight: 'bold' } : st;
  const xl = axisTitleX(a.item, a.ws);
  if (xl) {
    const f = fitAxisTitle(xl, axisTitleAltX(a.item, a.ws), xTitleRoom({ x: L, y: T, w: Math.max(10, a.w - L - R), h: Math.max(10, a.h - T - B) }, a.w), tst);
    if (f.lines.length > 1) B += f.size * 1.15;
  }
  if (!hideY) {
    const yl = axisTitleY(a.item, a.ws);
    if (yl) {
      const f = fitAxisTitle(yl, axisTitleAltY(a.item, a.ws), yTitleRoom({ x: L, y: T, w: Math.max(10, a.w - L - R), h: Math.max(10, a.h - T - B) }), tst);
      if (f.lines.length > 1) L += f.size * 1.15;
    }
  }
  // the first / last x tick labels are centered on the frame corners
  const fw = Math.max(10, a.w - L - R);
  const lab = computeTicks(a.xs, { target: xTarget(fw, fs) }).filter((t) => t.major && t.label);
  if (lab.length) {
    const f = lab[0];
    const l = lab[lab.length - 1];
    // (any label reaching beyond the frame edge, e.g. "1.0M" at 95 % of a linear axis with a large font)
    L = Math.max(L, measureRich(tickLabelRuns(f.label!), st) / 2 - f.u * fw + 1);
    if (cb !== 'right' && a.legend?.pos !== 'outside-right') R = Math.max(R, measureRich(tickLabelRuns(l.label!), st) / 2 - (1 - l.u) * fw + 1);
  }
  return { L, R, T, B };
}

/** Height of a color bar above the frame (bar, ticks and labels). */
function colorBarTopH(item: PlotItem, fs: number): number {
  return fs * 0.35 + colorBarWidth(item, fs) * 0.85 + fs * 0.3 + fs * 0.1 + cbSize(fs) * 0.95;
}

/** Plots of one size and layout options on a sheet share their data frame (aligned grids). */
function layoutKey(it: PlotItem, w: number, h: number): string {
  const o = it.options;
  const lp = o.legendPos === 'outside-right' || o.legendPos === 'below' ? o.legendPos : '';
  return [Math.round(w * 2), Math.round(h * 2), o.fontSize, !!o.showTitle, colorBarPos(it) ?? '', it.plotType === 'histogram' && !!o.histHideY, o.tickDir ?? 'out', lp].join('|');
}

export function plotScales(item: PlotItem, ws: Workspace, sampleId?: string | null): { xs: ScaleDef; ys: ScaleDef | null } {
  const o = item.options;
  const xBase = effectiveScale(ws, item.xParam, o.xScale, sampleId);
  const xs = o.xWin ? windowScale(xBase, o.xWin[0], o.xWin[1]) : xBase;
  if (item.plotType === 'histogram') return { xs, ys: null };
  const yBase = effectiveScale(ws, item.yParam, o.yScale, sampleId);
  return { xs, ys: o.yWin ? windowScale(yBase, o.yWin[0], o.yWin[1]) : yBase };
}

/** Margins of the plot, widened to those of same-size plots with the same layout options on its worksheet. */
function alignedMargins(a: LayoutIn, env: RenderEnv): Margins {
  const m = plotMargins(a);
  const sheet = env.ws.worksheets.find((s) => s.items.some((i) => i.id === a.item.id));
  if (!sheet) return m;
  const key = layoutKey(a.item, a.w, a.h);
  const fs = a.item.options.fontSize * PT;
  const tpl = cbLabelTemplate({ family: env.ws.style.fontFamily, size: fs, color: '#000000' });
  const env0: RenderEnv = { ...env, cache: undefined };
  for (const it of sheet.items) {
    if (it.kind !== 'plot' || it.id === a.item.id || layoutKey(it, it.w, it.h) !== key) continue;
    const { xs, ys } = plotScales(it, env.ws, plotSampleId(it, env.activeSampleId));
    let histYMax = 100;
    let layers: ResolvedLayer[] | null = null;
    if (it.plotType === 'histogram' && it.options.histMode !== 'normalized') {
      layers = resolveLayers(it, env.ws, env.activeSampleId, env.engine);
      histYMax = layers.length ? histPeak(it, layers, xs, env0) : 1;
    }
    let legend: LegendBoxSize | null = null;
    const lp = it.options.legendPos;
    if (lp === 'outside-right' || lp === 'below') {
      layers ??= resolveLayers(it, env.ws, env.activeSampleId, env.engine);
      const spec = legendSpec(it, layers, env0, plotTheme(it.options), null);
      if (spec) legend = legendSize(spec, lp, it.w, it.h, { family: env.ws.style.fontFamily, size: fs, color: '#000000' });
    }
    const s = plotMargins({ item: it, w: it.w, h: it.h, ws: env.ws, xs, ys, histYMax, cbLabelW: tpl, legend, letter: panelLetterBox(env.ws, it.id) });
    m.L = Math.max(m.L, s.L);
    m.R = Math.max(m.R, s.R);
    m.T = Math.max(m.T, s.T);
    m.B = Math.max(m.B, s.B);
  }
  return m;
}

const peakCache = new WeakMap<Float32Array, WeakMap<Uint32Array, Map<string, number>>>();
/** y maximum of a count histogram of another plot (cached per data, for frame alignment) */
function histPeak(item: PlotItem, layers: ResolvedLayer[], xs: ScaleDef, env: RenderEnv): number {
  const { ws, engine } = env;
  const o = item.options;
  const bins = Math.max(16, Math.min(1024, o.bins || 256));
  let ymax = 0;
  for (const L of layers) {
    const dx = engine.display(ws, L.sampleId, item.xParam, xs);
    if (!dx) continue;
    const idx = engine.population(ws, L.sampleId, L.popId);
    let m = peakCache.get(dx);
    if (!m) peakCache.set(dx, (m = new WeakMap()));
    let byIdx = m.get(idx);
    if (!byIdx) m.set(idx, (byIdx = new Map()));
    const key = `${bins}|${o.histSmooth}`;
    let pk = byIdx.get(key);
    if (pk === undefined) {
      const h = hist1d(dx, idx, bins);
      const c = o.histSmooth > 0 ? blur1d(h, o.histSmooth) : h;
      pk = 0;
      for (let i = 0; i < c.length; i++) pk = Math.max(pk, c[i]);
      byIdx.set(key, pk);
    }
    ymax = Math.max(ymax, pk);
  }
  return ymax > 0 ? ymax * 1.05 : 1;
}

const frameOf = (m: Margins, w: number, h: number): Frame => ({ x: m.L, y: m.T, w: Math.max(10, w - m.L - m.R), h: Math.max(10, h - m.T - m.B) });

/**
 * Text of a plot that does not fit and is drawn shortened (axis titles, plot title), for the inspector and the export
 * dialog: exports never shorten text without saying so. Uses the standalone frame (no worksheet alignment, no legend).
 */
export function plotFitNotes(item: PlotItem, ws: Workspace, activeSampleId: string | null, engine?: Engine): string[] {
  const o = item.options;
  const fr = plotFrame(item, item.w, item.h, ws, activeSampleId);
  const fs = o.fontSize * PT;
  const st: TextStyle = { family: ws.style.fontFamily, size: fs, color: '#000000', ...(o.boldLabels ? { weight: 'bold' as const } : {}) };
  const out: string[] = [];
  const tst: TextStyle = o.boldLabels ? { ...st, weight: 'bold' } : st;
  const xl = axisTitleX(item, ws);
  const xf = xl ? fitAxisTitle(xl, axisTitleAltX(item, ws), xTitleRoom(fr, item.w), tst) : null;
  if (xf?.cut) out.push(`X axis title "${xl}" is shortened to "${xf.lines.join(' ')}"`);
  const yl = item.plotType === 'histogram' && o.histHideY ? '' : axisTitleY(item, ws);
  const yf = yl ? fitAxisTitle(yl, axisTitleAltY(item, ws), yTitleRoom(fr), tst) : null;
  if (yf?.cut) out.push(`Y axis title "${yl}" is shortened to "${yf.lines.join(' ')}"`);
  if (o.showTitle) {
    const title = titleModeOf(o) === 'custom' ? o.title ?? '' : engine ? plotTitleText(item, resolveLayers(item, ws, activeSampleId, engine), ws) : '';
    if (title) {
      const t = placeTitle(title, fr.x + fr.w / 2, fr.w + 2 * Math.min(fr.x, item.w - fr.x - fr.w) * 0.85, item.w, fr.y - fs * 0.6, { ...st, weight: 'bold' }, panelLetterBox(ws, item.id));
      if (t.cut) out.push(`Title "${title}" is shortened`);
    }
  }
  return out;
}

/** Data frame of a plot item (standalone, without worksheet alignment). */
export function plotFrame(item: PlotItem, w: number, h: number, ws: Workspace, activeSampleId?: string | null): Frame {
  const { xs, ys } = plotScales(item, ws, plotSampleId(item, activeSampleId));
  const fs = item.options.fontSize * PT;
  const tpl = cbLabelTemplate({ family: ws.style.fontFamily, size: fs, color: '#000000' });
  return frameOf(plotMargins({ item, w, h, ws, xs, ys, histYMax: 100, cbLabelW: tpl, legend: null, letter: panelLetterBox(ws, item.id) }), w, h);
}

// ------------------------------------------------------------------ data occupancy (for legend placement)

/** Fraction of a display-space box [u0,u1] x [v0,v1] (v up) covered by data. */
type Occupancy = (u0: number, v0: number, u1: number, v1: number) => number;

/**
 * Where the data are, for placing legends and labels: `occ` the share of a box with events, `dens` the mean data
 * density under it (0 empty .. 1 dense; scattered single events count little, a dense cloud fully).
 */
interface DataMask {
  occ: Occupancy;
  dens: Occupancy;
}

const OCC_G = 64;

/** Summed-area table of a G x G grid (row-major, v up), with a box query in display units. */
function satQuery(grid: Float32Array, G: number): Occupancy {
  const S = new Float64Array((G + 1) * (G + 1));
  for (let j = 0; j < G; j++) {
    let row = 0;
    for (let i = 0; i < G; i++) {
      row += grid[j * G + i];
      S[(j + 1) * (G + 1) + i + 1] = S[j * (G + 1) + i + 1] + row;
    }
  }
  return (u0, v0, u1, v1) => {
    const i0 = Math.max(0, Math.min(G, Math.floor(u0 * G)));
    const i1 = Math.max(0, Math.min(G, Math.ceil(u1 * G - 1e-9)));
    const j0 = Math.max(0, Math.min(G, Math.floor(v0 * G)));
    const j1 = Math.max(0, Math.min(G, Math.ceil(v1 * G - 1e-9)));
    const n = (i1 - i0) * (j1 - j0);
    if (n <= 0) return 0;
    const W = G + 1;
    return (S[j1 * W + i1] - S[j0 * W + i1] - S[j1 * W + i0] + S[j0 * W + i0]) / n;
  };
}

function occupancy2d(item: PlotItem, layers: ResolvedLayer[], xs: ScaleDef, ys: ScaleDef, env: RenderEnv): DataMask {
  const { ws, engine } = env;
  const deps: unknown[] = [xs, ys];
  for (const L of layers) deps.push(drawableEvents(ws, engine, L.sampleId, L.popId, item.xParam, item.yParam).idx, engine.display(ws, L.sampleId, item.xParam, xs), engine.display(ws, L.sampleId, item.yParam, ys));
  return memo(env, 'occ', deps, () => {
    const G = OCC_G;
    const c = new Float32Array(G * G);
    let total = 0;
    for (const L of layers) {
      const dx = engine.display(ws, L.sampleId, item.xParam, xs);
      const dy = engine.display(ws, L.sampleId, item.yParam, ys);
      if (!dx || !dy) continue;
      const idx = subsample(drawableEvents(ws, engine, L.sampleId, L.popId, item.xParam, item.yParam).idx, 40000);
      for (let i = 0; i < idx.length; i++) {
        // events beyond the axis ends are drawn on the frame edge: they count there
        let u = dx[idx[i]];
        let v = dy[idx[i]];
        if (!(u === u) || !(v === v)) continue;
        if ((xs.type === 'window' && (u < 0 || u > 1)) || (ys.type === 'window' && (v < 0 || v > 1))) continue;
        u = u < 0 ? 0 : u > 0.99999 ? 0.99999 : u;
        v = v < 0 ? 0 : v > 0.99999 ? 0.99999 : v;
        c[Math.floor(v * G) * G + Math.floor(u * G)]++;
        total++;
      }
    }
    const thr = Math.max(1, total * 0.0002);
    const occ = new Float32Array(G * G);
    const nz: number[] = [];
    for (let i = 0; i < c.length; i++) {
      if (c[i] >= thr) occ[i] = 1;
      if (c[i] > 0) nz.push(c[i]);
    }
    nz.sort((a, b) => a - b);
    // density relative to the busy part of the plot: the 80th percentile of occupied cells counts as dense
    const ref = Math.max(4, nz.length ? nz[Math.floor(nz.length * 0.8)] : 4);
    const L = Math.log1p(ref);
    const dens = new Float32Array(G * G);
    for (let i = 0; i < c.length; i++) if (c[i] > 0) dens[i] = Math.min(1, 0.12 + (0.88 * Math.log1p(c[i])) / L);
    return { occ: satQuery(occ, G), dens: satQuery(dens, G) };
  });
}

function occupancyHist(hd: HistData): DataMask {
  const G = 96;
  const tops = new Float32Array(G);
  hd.curves.forEach((c, li) => {
    const base = li * hd.shift;
    for (let i = 0; i < c.length; i++) {
      const col = Math.min(G - 1, Math.floor(((i + 0.5) / c.length) * G));
      const v = base + ((c[i] * hd.norms[li]) / hd.ymax) * hd.scaleH;
      if (v > tops[col]) tops[col] = v;
    }
  });
  const occ: Occupancy = (u0, v0, u1, v1) => {
    const i0 = Math.max(0, Math.floor(u0 * G));
    const i1 = Math.min(G - 1, Math.floor(u1 * G - 1e-9));
    let s = 0;
    let k = 0;
    for (let i = i0; i <= i1; i++, k++) s += Math.max(0, Math.min(1, (Math.min(tops[i] + 0.02, v1) - v0) / Math.max(1e-6, v1 - v0)));
    return k ? s / k : 0;
  };
  return { occ, dens: occ };
}

// ------------------------------------------------------------------ main

export function renderPlot(p: Painter, item: PlotItem, w: number, h: number, env: RenderEnv): PlotGeometry {
  // On screen, a plot whose inputs did not change is copied from its last picture (moving other items, selecting,
  // drafting a gate and other store updates that do not concern it redraw nothing). PlotView clears its canvas and
  // calls renderPlot first, so the canvas then holds exactly this plot.
  const cache = env.cache;
  const ctx = cache && !env.forExport && p.kind === 'canvas' ? (p as CanvasPainter).ctx : null;
  const cv = ctx?.canvas;
  let key: unknown[] | null = null;
  if (cache && ctx && cv && typeof cv.width === 'number' && typeof document !== 'undefined') {
    key = snapshotKey(item, w, h, env, cv);
    const snap = cache.get('snapshot')?.value as Snapshot | undefined;
    if (snap && snap.final && sameKey(snap.key, key)) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(snap.canvas, 0, 0);
      ctx.restore();
      return snap.geom;
    }
  }
  const screen = !!cache && !env.forExport;
  const progress: Progress = { preview: false, start: now() };
  if (screen) cache.set('progress', { deps: [], value: progress });
  // on screen, expensive results computed in the background are drawn when they are in (see Engine.deferred)
  const geom = screen ? env.engine.deferred(() => renderPlotBody(p, item, w, h, env)) : renderPlotBody(p, item, w, h, env);
  if (cache && ctx && cv && key) {
    const old = cache.get('snapshot')?.value as Snapshot | undefined;
    let sc = old?.canvas;
    if (!sc || sc.width !== cv.width || sc.height !== cv.height) sc = env.makeCanvas(cv.width, cv.height);
    const sctx = sc.getContext('2d');
    if (sctx) {
      sctx.clearRect(0, 0, sc.width, sc.height);
      sctx.drawImage(cv, 0, 0);
      cache.set('snapshot', { deps: [], value: { key, canvas: sc, geom, final: !progress.preview } satisfies Snapshot });
    }
  }
  return geom;
}

function renderPlotBody(p: Painter, item: PlotItem, w: number, h: number, env: RenderEnv): PlotGeometry {
  const { ws, engine } = env;
  const o = item.options;
  const fs = o.fontSize * PT;
  const lw = o.lineWidth * PT * 0.75;
  const family = ws.style.fontFamily;
  const th = itemPlotTheme(o, ws, item.id);
  const textSt: TextStyle = { family, size: fs, color: th.fg };
  const isHist = item.plotType === 'histogram';
  const { xs: xScale, ys: yScale } = plotScales(item, ws, plotSampleId(item, env.activeSampleId));
  const layers = resolveLayers(item, ws, env.activeSampleId, engine);
  const primary = layers[0];
  const hd = isHist && layers.length ? histData(item, layers, xScale, env) : null;
  const histYMax = hd ? hd.yTop : 0;
  const cb = colorBarPos(item);
  const legend = legendSpec(item, layers, env, th, hd);
  const lpos = o.legendPos ?? 'auto';
  const tpl = cbLabelTemplate(textSt);
  const cached = env.cache?.get('cbw')?.value as number | undefined;
  const lin: LayoutIn = { item, w, h, ws, xs: xScale, ys: yScale, histYMax, cbLabelW: Math.max(tpl, cached ?? 0), legend: null, letter: panelLetterBox(ws, item.id) };
  if (legend && (lpos === 'outside-right' || lpos === 'below')) lin.legend = legendSize(legend, lpos, w, h, textSt);
  const frameFor = (L: LayoutIn, ww = w, hh = h) => frameOf(withZone(alignedMargins(L, env), L.zone), ww, hh);
  let fr = frameFor(lin);

  const contourish = item.plotType === 'contour' || item.plotType === 'zebra';
  const mask: DataMask | null = !layers.length ? null : hd ? occupancyHist(hd) : yScale ? occupancy2d(item, layers, xScale, yScale, env) : null;
  const occ: Occupancy | null = mask?.occ ?? null;
  const gatesOn = o.showGates && !!primary;
  // quadrant labels with the values only (see chooseLabelZone)
  let quadValues = false;
  const geomAt = (f: Frame, ww: number) => gateGeometry(item, f, xScale, yScale, layers, env, textSt, lw, th, ww, quadValues);
  let gates = gatesOn ? geomAt(fr, w) : [];
  let legendInside = null as Box | null;
  const placeLegend = () => {
    legendInside = null;
    if (!legend || lin.legend) return;
    const pick = legendCorner(legend, fr, textSt, occ, gates);
    // automatic: an overlay legend that would hide data or gate labels goes outside the frame (right, or below when
    // the plot would get too narrow)
    if (lpos === 'auto' && pick.cover > 0.05) {
      const right = legendSize(legend, 'outside-right', w, h, textSt);
      const frR = frameOf(alignedMargins({ ...lin, legend: right }, env), w, h);
      lin.legend = frR.w >= fr.w * 0.62 && right.h <= h - frR.y - fs * 0.2 ? right : legendSize(legend, 'below', w, h, textSt);
      fr = frameFor(lin);
      if (gatesOn) gates = geomAt(fr, w);
      return;
    }
    legendInside = pick.box;
  };
  placeLegend();

  // gate labels that find no clear place in the frame (small plots, crowded gates) go outside it: room is reserved above
  // or right of the frame, only when that gives them a clear place. In the gating view (an enlarged copy of a worksheet
  // plot) this is decided at the worksheet size, so the labels are placed as on the sheet (and in the figure).
  const ref = env.labelRef && gatesOn && (Math.abs(env.labelRef.w - w) > 0.5 || Math.abs(env.labelRef.h - h) > 0.5) ? env.labelRef : null;
  const labelGap = gateLabelPx(fs) * 0.25;
  const zoneBoxes = (f: Frame, z: LabelZoneSpec | null | undefined, ww = w): Box[] =>
    !z ? [] : z.side === 'top' ? [{ x: f.x, y: f.y - z.size + 0.5, w: Math.max(f.w, ww - f.x - 1), h: z.size - labelGap - 0.5 }] : [{ x: f.x + f.w + labelGap, y: f.y, w: z.size - labelGap - 0.5, h: f.h }];
  const labelObstacles = lin.letter ? [lin.letter] : [];
  const legendFor = (L: LayoutIn, f: Frame, gs: GateItem[]) => (legend && !L.legend ? legendCorner(legend, f, textSt, occ, gs).box : null);
  const refLayout = (L: LayoutIn): LayoutIn => (ref ? { ...L, w: ref.w, h: ref.h, legend: L.legend && legend ? legendSize(legend, L.legend.pos, ref.w, ref.h, textSt) : null } : L);
  let first: { fr: Frame; gates: GateItem[]; legend: Box | null; res: LayoutResult } | null = null;
  /** labels without a clear place (on another gate, or on data and outlines), or only with a shortened name (the last
   * resort, after places outside the frame) */
  const stuckOf = (gs: GateItem[], r: LayoutResult) =>
    gs.filter((g) => {
      const inf = g.req && !g.req.fixed ? r.info.get(g.req.id) : undefined;
      return !!inf && !!g.forms?.length && (inf.hard || inf.score >= 6 || !!g.forms[inf.form + 1]?.short);
    });
  const isQuad = (g: GateItem) => g.shape.kind === 'quadrant';
  const chooseLabelZone = (L: LayoutIn): LabelZoneSpec | null => {
    const own = L === lin;
    const f0 = own ? fr : frameFor(L, L.w, L.h);
    let g0 = own ? gates : geomAt(f0, L.w);
    let leg0 = own ? legendInside : legendFor(L, f0, g0);
    let r0 = placeGateLabels(g0, f0, mask, leg0, [], labelObstacles);
    // quadrant labels with their names that find no clear place in their corners: the values alone (as when the names
    // do not fit the quadrants), rather than a frame made smaller for them
    if (stuckOf(g0, r0).some(isQuad)) {
      quadValues = true;
      const g1 = geomAt(f0, L.w);
      const leg1 = own ? (legend && legendInside ? legendCorner(legend, f0, textSt, occ, g1).box : null) : legendFor(L, f0, g1);
      const r1 = placeGateLabels(g1, f0, mask, leg1, [], labelObstacles);
      if (r1.hard < r0.hard || (r1.hard === r0.hard && r1.total < r0.total)) {
        g0 = g1;
        leg0 = leg1;
        r0 = r1;
        if (own) {
          gates = g1;
          legendInside = leg1;
        }
      } else quadValues = false;
    }
    if (own) first = { fr: f0, gates: g0, legend: leg0, res: r0 };
    const stuck = stuckOf(g0, r0);
    if (!stuck.length) return null;
    // the room fits each stuck label on one line at its own size (a label squeezed into a strip at the smallest size is
    // hard to read), else in its smallest form
    const fullForms = (g: GateItem) => g.forms!.filter((f) => f.size >= g.forms![0].size - 1e-6 && !f.short);
    const need = (dim: 'w' | 'h', full: boolean) => Math.max(...stuck.map((g) => Math.min(...(full && fullForms(g).length ? fullForms(g) : g.forms!).map((f) => f[dim]))));
    let best: { z: LabelZoneSpec | null; hard: number; cost: number } = { z: null, hard: r0.hard, cost: r0.total };
    const sides: LabelZoneSpec[] = [];
    for (const full of [true, false]) {
      const add = (z: LabelZoneSpec) => !sides.some((o) => o.side === z.side && Math.abs(o.size - z.size) < 0.5) && sides.push(z);
      if (cb !== 'top') add({ side: 'top', size: need('h', full) + labelGap + 0.5 });
      if (cb !== 'right') add({ side: 'right', size: need('w', full) + labelGap + 0.5 });
    }
    for (const z of sides) {
      const L2: LayoutIn = { ...L, zone: z };
      const f2 = frameFor(L2, L.w, L.h);
      if (f2.w < f0.w * 0.6 || f2.h < f0.h * 0.6) continue;
      const g2 = geomAt(f2, L.w);
      const r2 = placeGateLabels(g2, f2, mask, legendFor(L2, f2, g2), zoneBoxes(f2, z, L.w), labelObstacles);
      // room is reserved only for a label placed in it (a frame made smaller for nothing leaves an empty strip); quadrant
      // labels stay in their corners (above or beside the frame they would name another quadrant)
      const out = g2.filter((g) => g.req && r2.info.get(g.req.id)?.outside);
      if (!out.length || out.some(isQuad)) continue;
      // a smaller frame costs, too
      const cost = r2.total + 10 * (1 - (f2.w * f2.h) / (f0.w * f0.h));
      if (r2.hard < best.hard || (r2.hard === best.hard && cost < best.cost - (best.z ? 0 : 1))) best = { z, hard: r2.hard, cost };
    }
    return best.z;
  };
  if (gatesOn && gates.some((g) => g.req && !g.req.fixed)) {
    const z = chooseLabelZone(refLayout(lin));
    // (decided at the worksheet size in the gating view: the gates of this size follow)
    if (z || (quadValues && first === null)) {
      if (z) lin.zone = z;
      fr = frameFor(lin);
      gates = geomAt(fr, w);
      if (legend && legendInside) legendInside = legendCorner(legend, fr, textSt, occ, gates).box;
    }
  }

  // raster of dot-type plots first: color bar labels may need more room than reserved
  let dots: { cv: HTMLCanvasElement; info?: ColorInfo } | null = null;
  if (layers.length && !isHist && !contourish) {
    dots = rasterDots(item, layers, fr, xScale, yScale!, env, th);
    if (cb && dots.info) {
      const need = Math.max(tpl, cbLabelsWidth(dots.info, textSt));
      env.cache?.set('cbw', { deps: [], value: need });
      if (Math.abs(need - lin.cbLabelW) > 0.5) {
        lin.cbLabelW = need;
        fr = frameFor(lin);
        if (gatesOn) gates = geomAt(fr, w);
        if (legend && legendInside) legendInside = legendCorner(legend, fr, textSt, occ, gates).box;
        dots = rasterDots(item, layers, fr, xScale, yScale!, env, th);
      }
    }
  }

  const toPx = (u: number, v: number): [number, number] => [fr.x + u * fr.w, fr.y + (1 - v) * fr.h];
  const toDisplay = (x: number, y: number): [number, number] => [(x - fr.x) / fr.w, 1 - (y - fr.y) / fr.h];
  const geom: PlotGeometry = {
    frame: fr,
    xScale,
    yScale,
    layers,
    gates: [],
    hasData: layers.length > 0,
    primaryPop: primary?.popId ?? item.layers.find((l) => l.visible !== false)?.population ?? 'root',
    primarySample: primary?.sampleId ?? null,
    toPx,
    toDisplay,
  };

  p.save();
  if (th.bg) p.rect(0, 0, w, h, null, { color: th.bg });

  // ---------------- data layer
  let cinfo: ColorInfo | undefined;
  if (layers.length) {
    p.save();
    p.clipRect(fr.x, fr.y, fr.w, fr.h);
    if (hd) drawHistograms(p, item, layers, fr, hd, env, th);
    else if (contourish) cinfo = drawContours(p, item, layers, fr, xScale, yScale!, env, lw, th);
    else if (dots) {
      // smoothed density images are interpolated; everything else keeps crisp pixels
      p.image(dots.cv, fr.x, fr.y, fr.w, fr.h, false);
      cinfo = dots.info;
    }
    p.restore();
  }

  // ---------------- axes, color bar, title
  drawAxes(p, item, fr, xScale, yScale, histYMax, textSt, lw, ws, w);
  if (cb && cinfo) drawColorBar(p, item, fr, cinfo, cb, textSt, lw, env);
  if (o.showTitle) {
    const title = plotTitleText(item, layers, ws);
    const ty = (cb === 'top' ? fr.y - colorBarTopH(item, fs) - fs * 0.6 : fr.y - fs * 0.6) - (lin.zone?.side === 'top' ? lin.zone.size : 0);
    const bst: TextStyle = { ...textSt, weight: 'bold' };
    const t = placeTitle(title, fr.x + fr.w / 2, fr.w + 2 * Math.min(fr.x, w - fr.x - fr.w) * 0.85, w, ty, bst, panelLetterBox(ws, item.id));
    p.text(t.x, ty, t.text, { ...bst, size: t.size, align: 'center', baseline: 'alphabetic' });
  }
  const missing = primary ? [item.xParam, ...(isHist ? [] : [item.yParam])].filter((ch) => !engine.raw(ws, primary.sampleId, ch)) : [];
  const computing = primary ? missing.filter((ch) => engine.isPending(ws, primary.sampleId, ch)) : [];
  if (computing.length) {
    const pr = progressOf(env);
    if (pr) pr.preview = true;
    const mst = { ...textSt, size: textSt.size * 0.9, color: '#8a94a3', align: 'center' as const, baseline: 'middle' as const };
    p.text(fr.x + fr.w / 2, fr.y + fr.h / 2, fitText(`Computing ${computing.map((ch) => channelDisplayName(ws, ch, 'short')).join(', ')}…`, fr.w * 0.94, mst), mst);
  } else if (missing.length) {
    const mst = { ...textSt, size: textSt.size * 0.9, color: '#8a94a3', align: 'center' as const, baseline: 'middle' as const };
    p.text(fr.x + fr.w / 2, fr.y + fr.h / 2, fitText(missing.map((ch) => missingChannelReason(ws, ch, primary!.sampleId)).join('; '), fr.w * 0.94, mst), mst);
  }
  // the population shown does not apply to the sample (another group's gates, a gate on a channel it lacks); overlays
  // say so only when no layer applies (else the legend / statistics show n/a for that layer)
  const na = primary && !missing.length && layers.every((L) => !engine.applies(ws, L.sampleId, L.popId)) ? popNotApplicableReason(ws, primary.sampleId, primary.popId) : null;
  if (na) {
    const mst = { ...textSt, size: textSt.size * 0.9, color: '#8a94a3', align: 'center' as const, baseline: 'middle' as const };
    // two lines, so the reason is not cut short in small plots
    p.text(fr.x + fr.w / 2, fr.y + fr.h / 2 - mst.size * 0.65, fitText('Not applicable:', fr.w * 0.94, mst), mst);
    p.text(fr.x + fr.w / 2, fr.y + fr.h / 2 + mst.size * 0.65, fitText(na, fr.w * 0.94, mst), mst);
  }
  if (!layers.length) {
    const mst = { ...textSt, color: '#8a94a3', align: 'center' as const, baseline: 'middle' as const };
    p.text(fr.x + fr.w / 2, fr.y + fr.h / 2, fitText(item.layers.some((l) => l.sample === 'active') ? 'No sample selected' : 'Sample not loaded', fr.w * 0.94, mst), mst);
  }

  // ---------------- gates, legend and labels (laid out together so that nothing overlaps)
  if (gatesOn) {
    p.save();
    p.clipRect(fr.x, fr.y, fr.w, fr.h);
    for (const g of gates) g.draw(p);
    p.restore();
  }
  // (the layout made while choosing the label zone, when nothing changed since)
  const f1 = first as { fr: Frame; gates: GateItem[]; legend: Box | null; res: LayoutResult } | null;
  const same = !!f1 && !lin.zone && f1.gates === gates && f1.legend === legendInside && f1.fr.x === fr.x && f1.fr.y === fr.y && f1.fr.w === fr.w && f1.fr.h === fr.h;
  let placed = same ? f1!.res.boxes : placeGateLabels(gates, fr, mask, legend && legendInside ? legendInside : null, zoneBoxes(fr, lin.zone), labelObstacles).boxes;
  if (ref && gatesOn) {
    // laid out at the worksheet size, then carried over to this (larger) drawing
    const linR = refLayout(lin);
    const frR = frameFor(linR, ref.w, ref.h);
    const gR = geomAt(frR, ref.w);
    const legR = legend && legendInside ? legendCorner(legend, frR, textSt, occ, gR).box : null;
    placed = carryLabels(gates, gR, placeGateLabels(gR, frR, mask, legR, zoneBoxes(frR, lin.zone, ref.w), labelObstacles).boxes, placed, frR, fr, zoneBoxes(fr, lin.zone));
  }
  if (legend) {
    if (legendInside) drawLegend(p, legend, legendInside, 'column', textSt, lw, th, true);
    else if (lin.legend) {
      const box = lin.legend.pos === 'outside-right' ? { x: w - lin.legend.w - fs * 0.15, y: fr.y, w: lin.legend.w, h: lin.legend.h } : { x: fs * 0.15, y: h - lin.legend.h - fs * 0.1, w: lin.legend.w, h: lin.legend.h };
      drawLegend(p, legend, box, lin.legend.pos === 'below' ? 'rows' : 'column', textSt, lw, th, false);
    }
  }
  const boxed = !!optsX(o).labelBox;
  geom.gates = gates.map((g) => {
    const shape = g.shape;
    const b = g.req ? placed.get(g.req.id) : undefined;
    if (g.req && b && g.lines) {
      const lead = leaderLine(shape, b, fr, g.size);
      if (lead) p.line(lead[0], lead[1], lead[2], lead[3], { color: g.lineColor, width: Math.max(0.5, lw * 0.6) });
      drawLabelBox(p, b, g.lines, g.size, textSt, th, g.align, boxed, g.halo ?? true);
      shape.label = { x: b.x, y: b.y, w: b.w, h: b.h, bx: g.base!.x, by: g.base!.y, ...(g.short && g.full ? { full: g.full } : {}) };
    }
    return shape;
  });
  p.restore();
  return geom;
}

/**
 * Lay out the gate labels of a plot: off each other, the legend, the data (density mask) and the gate outlines where
 * there is room (never on another gate's outline or in its interior when there is another place), near their gate when
 * possible, else in an empty part of the frame (with a leader line, see leaderLine), in another form (smaller, one line,
 * shortened) or in `zones` outside the frame. Sets each gate item's label form and whether it needs a halo.
 */
function placeGateLabels(gates: GateItem[], fr: Frame, mask: DataMask | null, legendBox: Box | null, zones: Box[] = [], obstacles0: Box[] = []): LayoutResult {
  const obstacles: Box[] = [...obstacles0];
  if (legendBox) obstacles.push(legendBox);
  const lines: OutlineLine[] = [];
  const regions: LabelRegion[] = [];
  for (const g of gates) {
    lines.push(...g.outlines);
    const k = g.shape.kind;
    if ((k === 'polygon' || k === 'ellipse' || k === 'rect') && g.shape.outline) regions.push({ owner: g.shape.popId, pts: g.shape.outline });
  }
  const reqs: LabelRequest[] = [];
  for (const g of gates) if (g.req) reqs.push(g.req);
  // data under a label: the mean density and the densest part (3 x 2 cells of the box), so that a label half over a
  // dense cloud counts nearly as much as one fully over it; nothing outside the frame
  const dens = mask
    ? (b0: Box) => {
        const x0 = Math.max(fr.x, b0.x - 1);
        const y0 = Math.max(fr.y, b0.y - 1);
        const w = Math.min(fr.x + fr.w, b0.x + b0.w + 1) - x0;
        const h = Math.min(fr.y + fr.h, b0.y + b0.h + 1) - y0;
        if (w <= 0 || h <= 0) return 0;
        const q = (ax: number, ay: number, bx: number, by: number) => mask.dens((ax - fr.x) / fr.w, 1 - (by - fr.y) / fr.h, (bx - fr.x) / fr.w, 1 - (ay - fr.y) / fr.h);
        const mean = q(x0, y0, x0 + w, y0 + h);
        let mx = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) mx = Math.max(mx, q(x0 + (w * i) / 3, y0 + (h * j) / 2, x0 + (w * (i + 1)) / 3, y0 + (h * (j + 1)) / 2));
        // a label partly outside the frame: the part over the data counts
        return (0.5 * mean + 0.5 * mx) * ((w * h) / Math.max(1, (b0.w + 2) * (b0.h + 2)));
      }
    : undefined;
  const res = layoutLabelsDetailed(reqs, obstacles, undefined, { density: dens, lines, regions, densityWeight: 10, lineWeight: 4, zones: zones.map((box) => ({ box, cost: 2.5 })), clip: fr });
  for (const g of gates) {
    const info = g.req ? res.info.get(g.req.id) : undefined;
    if (!info) continue;
    const f = g.forms?.[info.form + 1];
    if (f) {
      g.lines = f.lines;
      g.size = f.size;
      g.short = f.short;
    }
    // a halo only where the label sits on data or outlines
    g.halo = info.overData > 0.02 || info.overLines;
  }
  return res;
}

/**
 * Label boxes laid out in a reference frame `frR` (gates `gR`) carried over to frame `fr` (gates `gs`, same order): a
 * label next to its gate keeps its distance and side to the nearest outline point; one placed away from it keeps its
 * relative place in the frame; one outside the frame (a label zone, `zones` here) keeps its distance from the frame.
 * The labels keep the form chosen there (size, one line, shortened). Labels without a reference keep `own`.
 */
function carryLabels(gs: GateItem[], gR: GateItem[], ref: Map<string, Box>, own: Map<string, Box>, frR: Frame, fr: Frame, zones: Box[] = []): Map<string, Box> {
  const out = new Map(own);
  const widen: { g: GateItem; b: Box; bd: Box; anchor: [number, number] }[] = [];
  const mapX = (x: number) => fr.x + ((x - frR.x) / frR.w) * fr.w;
  const mapY = (y: number) => fr.y + ((y - frR.y) / frR.h) * fr.h;
  gs.forEach((g, i) => {
    const r = g.req;
    const gr = gR[i];
    const b = r && gr?.req ? ref.get(gr.req.id) : undefined;
    if (!r || !b || r.fixed || gr.shape.popId !== g.shape.popId) return;
    g.lines = gr.lines;
    g.size = gr.size;
    g.short = gr.short;
    g.halo = gr.halo;
    let x: number;
    let y: number;
    let bd = r.bounds;
    if (b.y + b.h <= frR.y + 0.5 || b.x >= frR.x + frR.w - 0.5) {
      // in a zone outside the frame
      const top = b.y + b.h <= frR.y + 0.5;
      x = top ? mapX(b.x + b.w / 2) - b.w / 2 : fr.x + fr.w + (b.x - frR.x - frR.w);
      y = top ? fr.y - (frR.y - b.y) : mapY(b.y + b.h / 2) - b.h / 2;
      bd = zones.find((z) => (top ? z.y + z.h <= fr.y + 0.5 : z.x >= fr.x + fr.w - 0.5)) ?? { x: x, y: y, w: b.w, h: b.h };
    } else {
      const near = nearestOutlinePoint(gr.shape, b, frR);
      if (near && near[2] < gr.size * 2) {
        x = mapX(near[0]) + (b.x - near[0]);
        y = mapY(near[1]) + (b.y - near[1]);
      } else {
        x = mapX(b.x + b.w / 2) - b.w / 2;
        y = mapY(b.y + b.h / 2) - b.h / 2;
      }
    }
    x = Math.min(Math.max(x, bd.x), Math.max(bd.x, bd.x + bd.w - b.w));
    y = Math.min(Math.max(y, bd.y), Math.max(bd.y, bd.y + bd.h - b.h));
    out.set(r.id, { x, y, w: b.w, h: b.h });
    if (gr.short) widen.push({ g, b: { x, y, w: b.w, h: b.h }, bd, anchor: anchorOf(gr, b, frR) });
  });
  // a name shortened for the worksheet size is shown in full here where its own form (laid out at this size) fits at
  // the same place: same side of the gate, inside its region, off the other labels
  for (const { g, b, bd, anchor } of widen) {
    const id = g.req?.id;
    if (!id) continue;
    // the first full form (in order of preference: as it is, smaller, on one line) that fits there
    for (const f of g.forms ?? []) {
      if (f.short || f.w > bd.w + 0.5 || f.h > bd.h + 0.5) continue;
      const x = Math.min(Math.max(b.x + (b.w - f.w) * anchor[0], bd.x), bd.x + bd.w - f.w);
      const y = Math.min(Math.max(b.y + (b.h - f.h) * anchor[1], bd.y), bd.y + bd.h - f.h);
      const nb = { x, y, w: f.w, h: f.h };
      if ([...out].some(([k, o]) => k !== id && overlapArea(nb, o) > 0)) continue;
      g.lines = f.lines;
      g.size = f.size;
      g.short = false;
      out.set(id, nb);
      break;
    }
  }
  return out;
}

/**
 * Which edge of a label box stays put when it grows (0 = left / top, 1 = right / bottom, 0.5 = centre): the side
 * facing its gate (a label left of the gate keeps its right edge), the frame side of a label outside the frame.
 */
function anchorOf(g: GateItem, b: Box, fr: Frame): [number, number] {
  if (b.y + b.h <= fr.y + 0.5) return [0.5, 1];
  if (b.x >= fr.x + fr.w - 0.5) return [0, 0.5];
  const near = nearestOutlinePoint(g.shape, b, fr);
  if (!near || near[2] >= g.size * 2) return [0.5, 0.5];
  const ax = b.x + b.w <= near[0] + 0.5 ? 1 : b.x >= near[0] - 0.5 ? 0 : 0.5;
  const ay = b.y + b.h <= near[1] + 0.5 ? 1 : b.y >= near[1] - 0.5 ? 0 : 0.5;
  return [ax, ay];
}

/** Nearest point (x, y, distance) of a gate outline inside the frame to box b; null for outline-less gates. */
function nearestOutlinePoint(shape: GateShape, b: Box, fr: Frame): [number, number, number] | null {
  const ol = shape.outline;
  if (!ol) return null;
  const pts: number[] = [];
  const n = ol.length >> 1;
  for (let k = 0; k < n; k++) {
    const x0 = ol[2 * k];
    const y0 = ol[2 * k + 1];
    const x1 = ol[(2 * k + 2) % ol.length];
    const y1 = ol[(2 * k + 3) % ol.length];
    const m = Math.max(1, Math.min(64, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2)));
    for (let i = 0; i < m; i++) pts.push(x0 + ((x1 - x0) * i) / m, y0 + ((y1 - y0) * i) / m);
  }
  let best: [number, number, number] | null = null;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < fr.x - 0.5 || x > fr.x + fr.w + 0.5 || y < fr.y - 0.5 || y > fr.y + fr.h + 0.5) continue;
    const d = Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h));
    if (!best || d < best[2]) best = [x, y, d];
  }
  return best;
}

/**
 * Leader line (x0, y0, x1, y1) from a label placed away from its gate to the nearest point of the gate outline; null
 * when the label sits in or next to its gate.
 */
function leaderLine(shape: GateShape, b: Box, fr: Frame, size: number): [number, number, number, number] | null {
  const ol = shape.outline;
  if (!ol || !(shape.kind === 'polygon' || shape.kind === 'ellipse' || shape.kind === 'rect')) return null;
  // a label inside its own gate needs no line
  if (pointInPolygon(b.x + b.w / 2, b.y + b.h / 2, ol)) return null;
  // points along every edge (polygons may store only their vertices), inside the frame
  const pts: number[] = [];
  const n = ol.length >> 1;
  for (let k = 0; k < n; k++) {
    const x0 = ol[2 * k];
    const y0 = ol[2 * k + 1];
    const x1 = ol[(2 * k + 2) % ol.length];
    const y1 = ol[(2 * k + 3) % ol.length];
    const m = Math.max(1, Math.min(64, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2)));
    for (let i = 0; i < m; i++) pts.push(x0 + ((x1 - x0) * i) / m, y0 + ((y1 - y0) * i) / m);
  }
  // the nearest outline point; among (nearly) as near ones the one closest to the label's middle (a short, straight line
  // that does not run along another gate's edge)
  let best: [number, number, number] | null = null;
  let bestS = Infinity;
  const mx = b.x + b.w / 2;
  const my = b.y + b.h / 2;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < fr.x || x > fr.x + fr.w || y < fr.y || y > fr.y + fr.h) continue;
    const d = Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h));
    const sc = d + 0.15 * Math.hypot(x - mx, y - my);
    if (sc < bestS) {
      bestS = sc;
      best = [x, y, d];
    }
  }
  if (!best || best[2] <= size * 0.9) return null;
  const [x, y] = best;
  const bx = Math.min(Math.max(x, b.x + 1), b.x + b.w - 1);
  const by = Math.min(Math.max(y, b.y + 1), b.y + b.h - 1);
  // start just outside the text box, end a little before the outline
  const len = Math.hypot(x - bx, y - by) || 1;
  const k = Math.min(1, 1.2 / len);
  return [bx, by, x - (x - bx) * k, y - (y - by) * k];
}


/** Widest color bar tick label. */
function cbLabelsWidth(info: ColorInfo, st: TextStyle): number {
  const ls: TextStyle = { ...st, size: cbSize(st.size) };
  let w = 0;
  for (const t of info.ticks) w = Math.max(w, measureRich(t.label, ls));
  return w;
}

/** The title of a plot by its title mode: the typed text, the population, or sample: population (automatic). */
export function plotTitleText(item: PlotItem, layers: ResolvedLayer[], ws: Workspace): string {
  const o = item.options;
  const mode = titleModeOf(o);
  if (mode === 'custom') return o.title ?? '';
  if (mode === 'population') {
    const pid = layers[0]?.popId ?? item.layers.find((l) => l.visible !== false)?.population ?? 'root';
    return pid === 'root' ? 'All Events' : popById(ws, pid)?.name ?? '';
  }
  return defaultTitle(item, layers, ws);
}

/** Box (item coordinates) of the panel letter sitting on an item, or null. */
export function panelLetterBox(ws: Workspace, itemId: string): Box | null {
  const sheet = sheetOf(ws, itemId);
  const it = sheet?.items.find((i) => i.id === itemId);
  const l = it && sheet ? panelLetterOf(sheet, it) : undefined;
  if (!it || !l) return null;
  const size = l.fontSize * PT;
  const tw = measureRich(rich(l.text), { family: ws.style.fontFamily, size, weight: l.bold ? 'bold' : 'normal' });
  const x = l.x - it.x + (l.align === 'right' ? l.w - tw : l.align === 'center' ? (l.w - tw) / 2 : 0);
  // overlapping the item at all
  if (x > it.w || l.y - it.y > it.h || x + tw < 0 || l.y - it.y + size * 1.2 < 0) return null;
  return { x, y: l.y - it.y, w: tw, h: size * 1.2 };
}

/**
 * A title centered at `cx` within `room`, kept clear of a panel letter on the same line (moved right, within the item
 * width `w`), else a little smaller, else shortened.
 */
export function placeTitle(title: string, cx: number, room: number, w: number, baseline: number, st: TextStyle, letter: Box | null): { x: number; text: RichText; size: number; cut: boolean } {
  let lo = cx - room / 2;
  let hi = cx + room / 2;
  if (letter && letter.y < baseline + st.size * 0.25 && letter.y + letter.h > baseline - st.size) {
    lo = Math.max(lo, letter.x + letter.w + st.size * 0.5);
    hi = Math.max(hi, Math.min(w - st.size * 0.2, lo + room));
  }
  const minSize = Math.min(st.size, Math.max(st.size * 0.8, 5.5 * PT));
  for (const k of [1, 0.9, 0.8]) {
    const size = Math.max(minSize, st.size * k);
    const tw = measureRich(rich(title), { ...st, size });
    if (tw <= hi - lo) {
      const x = Math.min(Math.max(cx, lo + tw / 2), hi - tw / 2);
      return { x, text: rich(title), size, cut: false };
    }
  }
  const text = fitText(title, hi - lo, { ...st, size: minSize });
  return { x: (lo + hi) / 2, text, size: minSize, cut: true };
}

export function defaultTitle(item: PlotItem, layers: ResolvedLayer[], ws: Workspace): string {
  const l = layers[0];
  if (!l) return 'Plot';
  const s = ws.samples.find((x) => x.id === l.sampleId);
  const pop = l.popId === 'root' ? 'All Events' : popById(ws, l.popId)?.name ?? '';
  if (layers.length > 1 && !layers.every((x) => x.sampleId === l.sampleId)) return pop;
  return `${s?.name ?? ''}: ${pop}`;
}

/** Text with optional ^superscript markup (e.g. "CD4^+", "10^{3}"). */
export function rich(t: string): RichText {
  return t.includes('^') ? parseSup(t) : t;
}

/** Text (with ^ markup) shortened with an ellipsis to fit `maxW`; no space is left before the ellipsis. */
export function fitText(t: string, maxW: number, st: TextStyle): RichText {
  const full = rich(t);
  if (measureRich(full, st) <= maxW) return full;
  const rs = runs(full);
  const chars: { ch: string; sup?: boolean; sub?: boolean }[] = [];
  for (const r of rs) for (const ch of r.text) chars.push({ ch, sup: r.sup, sub: r.sub });
  const build = (n: number): TextRun[] => {
    let k = n;
    while (k > 0 && /\s/.test(chars[k - 1].ch)) k--; // no space before the ellipsis
    while (k > 0 && /[(/,;:–-]/.test(chars[k - 1].ch) && k > 1) k--;
    const out: TextRun[] = [];
    for (let i = 0; i < k; i++) {
      const c = chars[i];
      const last = out[out.length - 1];
      if (last && !!last.sup === !!c.sup && !!last.sub === !!c.sub) last.text += c.ch;
      else out.push({ text: c.ch, ...(c.sup ? { sup: true } : {}), ...(c.sub ? { sub: true } : {}) });
    }
    out.push({ text: '…' });
    return out;
  };
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureRich(build(mid), st) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  const out = build(Math.max(lo, Math.min(1, chars.length)));
  return out.length === 2 && !out[0].sup && !out[0].sub ? out[0].text + '…' : out;
}

// ------------------------------------------------------------------ dots

/**
 * Plots dots of D raster px (square or round) into an ImageData. With opacity < 1 dots are composited ("over") in a
 * premultiplied float buffer; call flush() before putImageData.
 */
function dotWriter(img: ImageData, D: number, circle: boolean, alpha: number) {
  const RW = img.width;
  const RH = img.height;
  const buf = new Uint32Array(img.data.buffer);
  const offs: number[] = [];
  const r = D / 2;
  for (let yy = 0; yy < D; yy++)
    for (let xx = 0; xx < D; xx++) {
      const cx = xx + 0.5 - r;
      const cy = yy + 0.5 - r;
      if (circle && D > 2 && cx * cx + cy * cy > r * r + 0.3) continue;
      offs.push(xx - (D >> 1), yy - (D >> 1));
    }
  const opaque = alpha >= 0.999;
  const acc = opaque ? null : new Float32Array(RW * RH * 4);
  const b = 1 - alpha;
  const put = (p: number, col: number) => {
    if (!acc) {
      buf[p] = col;
      return;
    }
    const i = p * 4;
    acc[i] = (col & 255) * alpha + acc[i] * b;
    acc[i + 1] = ((col >> 8) & 255) * alpha + acc[i + 1] * b;
    acc[i + 2] = ((col >> 16) & 255) * alpha + acc[i + 2] * b;
    acc[i + 3] = alpha + acc[i + 3] * b;
  };
  const one = D === 1;
  const round = circle && D > 2;
  /** (px, py): pixel of the event; py may be RH for events on the bottom edge */
  const plot = (px: number, py: number, col: number) => {
    if (one) {
      put((py < RH ? py : RH - 1) * RW + px, col);
      return;
    }
    if (!round) {
      // squares are moved inside the raster at its edges (as in v1)
      const x0 = Math.max(0, px - (D >> 1));
      const y0 = Math.max(0, py - (D >> 1));
      const x1 = Math.min(RW, x0 + D);
      const y1 = Math.min(RH, y0 + D);
      for (let y = y0; y < y1; y++) for (let x = x0, row = y * RW; x < x1; x++) put(row + x, col);
      return;
    }
    if (py >= RH) py = RH - 1;
    for (let j = 0; j < offs.length; j += 2) {
      const x = px + offs[j];
      const y = py + offs[j + 1];
      if (x >= 0 && y >= 0 && x < RW && y < RH) put(y * RW + x, col);
    }
  };
  /** composite the dots over what the image already holds */
  plot.flush = () => {
    if (!acc) return;
    const d8 = img.data;
    for (let i = 0; i < acc.length; i += 4) {
      const a = acc[i + 3];
      if (a <= 0) continue;
      const under = (d8[i + 3] / 255) * (1 - a);
      const na = a + under;
      d8[i] = (acc[i] + d8[i] * under) / na;
      d8[i + 1] = (acc[i + 1] + d8[i + 1] * under) / na;
      d8[i + 2] = (acc[i + 2] + d8[i + 2] * under) / na;
      d8[i + 3] = na * 255;
    }
  };
  return plot;
}

const permCache = new Map<number, Uint32Array>();
/** Deterministic pseudo-random permutation of 0..n-1 (stable between renders). */
function permutation(n: number): Uint32Array {
  let p = permCache.get(n);
  if (p) return p;
  p = new Uint32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  let s = 0x9e3779b9 ^ n;
  for (let i = n - 1; i > 0; i--) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const j = (s >>> 0) % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  if (permCache.size > 8) permCache.clear();
  permCache.set(n, p);
  return p;
}

/** Order of events by color index (counting sort; highest drawn last). */
function orderByIndex(ci: Uint8Array): Uint32Array {
  const buckets = new Uint32Array(257);
  for (let i = 0; i < ci.length; i++) buckets[ci[i] + 1]++;
  for (let c = 1; c <= 256; c++) buckets[c] += buckets[c - 1];
  const order = new Uint32Array(ci.length);
  const pos = buckets.slice(0, 256);
  for (let i = 0; i < ci.length; i++) order[pos[ci[i]]++] = i;
  return order;
}

function subsample(idx: Uint32Array, max: number): Uint32Array {
  if (!(max > 0) || idx.length <= max) return idx;
  const step = idx.length / max;
  const sub = new Uint32Array(max);
  for (let i = 0; i < max; i++) sub[i] = idx[Math.floor(i * step)];
  return sub;
}

// ------------------------------------------------------------------ events without a value

interface Drawable {
  /** events of the population with a value in every plotted channel */
  idx: Uint32Array;
  /** events left out (NaN in a plotted channel, e.g. outside the range of a size calibration) */
  omitted: number;
  rx: Float32Array | null;
  ry: Float32Array | null;
}
const drawCache = new WeakMap<Uint32Array, WeakMap<Float32Array, WeakMap<object, Drawable>>>();
const NO_Y = {};

/**
 * The events of a layer that can be drawn in a 2D plot: those with a value in both channels. An event without one
 * (NaN: a diameter outside the calibrated range, an unsized particle) has no position; drawing it at an axis end would
 * pile such events up as a stripe along the axis. Histograms leave them out the same way. Cached per data.
 */
export function drawableEvents(ws: Workspace, engine: Engine, sampleId: string, popId: string, xCh: string, yCh: string | null): Drawable {
  const idx = engine.population(ws, sampleId, popId);
  const rx = engine.raw(ws, sampleId, xCh);
  const ry = yCh ? engine.raw(ws, sampleId, yCh) : null;
  if (!rx || (yCh && !ry)) return { idx, omitted: 0, rx, ry };
  let m1 = drawCache.get(idx);
  if (!m1) drawCache.set(idx, (m1 = new WeakMap()));
  let m2 = m1.get(rx);
  if (!m2) m1.set(rx, (m2 = new WeakMap()));
  const key: object = ry ?? NO_Y;
  let r = m2.get(key);
  if (!r) {
    let bad = 0;
    for (let i = 0; i < idx.length; i++) {
      const e = idx[i];
      if (rx[e] !== rx[e] || (ry && ry[e] !== ry[e])) bad++;
    }
    if (!bad) r = { idx, omitted: 0, rx, ry };
    else {
      const out = new Uint32Array(idx.length - bad);
      let k = 0;
      for (let i = 0; i < idx.length; i++) {
        const e = idx[i];
        if (!(rx[e] !== rx[e] || (ry && ry[e] !== ry[e]))) out[k++] = e;
      }
      r = { idx: out, omitted: bad, rx, ry };
    }
    m2.set(key, r);
  }
  return r;
}

/**
 * Events of a plot's layers that are not drawn because they have no value in a plotted channel (for the inspector and
 * hover; figures do not show it). Null when every event is drawn.
 */
export function omittedEvents(item: PlotItem, ws: Workspace, engine: Engine, activeSampleId: string | null): { omitted: number; total: number; channels: string[] } | null {
  let omitted = 0;
  let total = 0;
  const chans = new Set<string>();
  for (const L of resolveLayers(item, ws, activeSampleId, engine)) {
    const y = item.plotType === 'histogram' ? null : item.yParam;
    const d = drawableEvents(ws, engine, L.sampleId, L.popId, item.xParam, y);
    if (!d.omitted) continue;
    omitted += d.omitted;
    total += d.idx.length + d.omitted;
    const ix = engine.population(ws, L.sampleId, L.popId);
    for (let i = 0; i < ix.length && chans.size < 2; i++) {
      const e = ix[i];
      if (d.rx && d.rx[e] !== d.rx[e]) chans.add(item.xParam);
      if (d.ry && d.ry[e] !== d.ry[e]) chans.add(item.yParam);
    }
  }
  return omitted ? { omitted, total, channels: [...chans] } : null;
}

/** Raster of a dot-type plot (pseudocolor, dot, density image) for the frame size, with its color bar info. */
function rasterDots(item: PlotItem, layers: ResolvedLayer[], fr: Frame, xs: ScaleDef, ys: ScaleDef, env: RenderEnv, th: Theme): { cv: HTMLCanvasElement; info?: ColorInfo } {
  const { ws, engine } = env;
  const o = item.options;
  const k = env.rasterScale;
  const RW = Math.max(1, Math.round(fr.w * k));
  const RH = Math.max(1, Math.round(fr.h * k));
  const cps = colorParamScale(ws, o, layers[0]?.sampleId);
  // the raster size first (a size-only change is recognized by the other entries)
  const deps: unknown[] = [RW, RH, item.plotType, xs, ys, o.colorMode, o.colormap, o.cmapReverse, o.cmapStops, o.densityScale, o.colorRange, o.densityBins, o.densitySmooth, o.colorStat, o.dotSize, o.dotShape, o.dotOpacity, o.drawOrder, o.maxEvents, o.dotColor, th.dark, cps, o.colorParam];
  for (const L of layers) {
    deps.push(drawableEvents(ws, engine, L.sampleId, L.popId, item.xParam, item.yParam).idx, engine.display(ws, L.sampleId, item.xParam, xs), engine.display(ws, L.sampleId, item.yParam, ys), L.color);
  }
  if (layers[0] && cps && o.colorParam) deps.push(engine.display(ws, layers[0].sampleId, o.colorParam, cps));
  if (o.colorMode === 'population' && layers[0]) {
    for (const pp of ws.populations) deps.push(pp.color, pp.parentId, engine.population(ws, layers[0].sampleId, pp.id));
  }
  const c = env.cache?.get('dots');
  if (c && c.deps.length === deps.length && c.deps.every((d, i) => d === deps[i])) return c.value as { cv: HTMLCanvasElement; info?: ColorInfo };
  // progressive: within a burst of changes draw a quick preview, the full raster once the changes stop
  if (inBurst(env, 'dots')) {
    // only the size changed (zooming the sheet): the last raster, stretched
    if (c && c.value && c.deps.length === deps.length && c.deps.every((d, i) => i < 2 || d === deps[i])) {
      stamp(env, 'dots');
      previewDrawn(env);
      return c.value as { cv: HTMLCanvasElement; info?: ColorInfo };
    }
    let n = 0;
    for (const L of layers) n += Math.min(engine.population(ws, L.sampleId, L.popId).length, o.maxEvents > 0 ? o.maxEvents : Infinity);
    if (n > PREVIEW_MIN && o.colorMode !== 'population') {
      stamp(env, 'dots');
      previewDrawn(env);
      // the preview is not memoized as the final raster: the next full render computes it
      const pv = renderDotsCanvas(item, layers, RW, RH, xs, ys, env, th, Math.max(1000, Math.round(PREVIEW_N / layers.length)));
      env.cache?.set('dots', { deps: [...deps, 'preview'], value: pv });
      return pv;
    }
  }
  stamp(env, 'dots');
  const value = renderDotsCanvas(item, layers, RW, RH, xs, ys, env, th);
  env.cache?.set('dots', { deps, value });
  return value;
}

/** `previewMax`: draw at most this many events per layer (quick preview), else o.maxEvents. */
function renderDotsCanvas(item: PlotItem, layers: ResolvedLayer[], RW: number, RH: number, xs: ScaleDef, ys: ScaleDef, env: RenderEnv, th: Theme, previewMax?: number): { cv: HTMLCanvasElement; info?: ColorInfo } {
  const { ws, engine } = env;
  const o = item.options;
  const k = env.rasterScale;
  const cv = env.makeCanvas(RW, RH);
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(RW, RH);
  const buf = new Uint32Array(img.data.buffer);
  const isDensity = item.plotType === 'density';
  const pseudo = item.plotType === 'pseudo' || (item.plotType === 'dot' && o.colorMode === 'density');
  const byParam = o.colorMode === 'param' && (item.plotType === 'dot' || isDensity) && !!o.colorParam;
  const D = Math.max(1, Math.round(o.dotSize * k));
  const put = dotWriter(img, D, o.dotShape === 'circle', Math.min(1, Math.max(0.02, o.dotOpacity ?? 1)));
  const cmap = lut32(cmapOf(o));
  const [lo, hi] = rangeOf(o);
  const clip = (t: number) => {
    const x = (t - lo) / (hi - lo);
    return x < 0 ? 0 : x > 1 ? 1 : x;
  };
  const legacy = o.densitySmooth === undefined; // plots saved before the unsmoothed default keep their look
  const zx = xs.type === 'window';
  const zy = ys.type === 'window';
  let info: ColorInfo | undefined;

  layers.forEach((L, li) => {
    const dx = engine.display(ws, L.sampleId, item.xParam, xs);
    const dy = engine.display(ws, L.sampleId, item.yParam, ys);
    if (!dx || !dy) return;
    // events without a value in a plotted channel are not drawn (see drawableEvents)
    const dr = drawableEvents(ws, engine, L.sampleId, L.popId, item.xParam, item.yParam);
    const full = dr.idx;
    const nanX = dr.omitted ? dr.rx : null;
    const nanY = dr.omitted ? dr.ry : null;
    const idx = subsample(full, previewMax && (!(o.maxEvents > 0) || o.maxEvents > previewMax) ? previewMax : o.maxEvents);
    const plot = (e: number, col: number) => {
      let u = dx[e];
      let v = dy[e];
      if (!(u === u) || !(v === v)) return;
      if ((nanX && nanX[e] !== nanX[e]) || (nanY && nanY[e] !== nanY[e])) return;
      if ((zx && (u < 0 || u > 1)) || (zy && (v < 0 || v > 1))) return;
      u = u < 0 ? 0 : u > 0.99999 ? 0.99999 : u;
      v = v < 0 ? 0 : v > 0.99999 ? 0.99999 : v;
      put(Math.floor(u * RW), Math.floor((1 - v) * RH), col);
    };
    // The same drawing in tight loops: raster position of every event of idx once (py * RW + px, -1 = not drawn,
    // exactly as `plot` decides), then the dots in the same order; one opaque pixel per dot is written directly
    // (what dotWriter does for D = 1), larger or translucent dots go through `put`.
    const RWH = RW * RH;
    const positions = (): Int32Array => {
      const pos = new Int32Array(idx.length);
      for (let i = 0; i < idx.length; i++) {
        const e = idx[i];
        let u = dx[e];
        let v = dy[e];
        if (!(u === u) || !(v === v) || (zx && (u < 0 || u > 1)) || (zy && (v < 0 || v > 1))) {
          pos[i] = -1;
          continue;
        }
        u = u < 0 ? 0 : u > 0.99999 ? 0.99999 : u;
        v = v < 0 ? 0 : v > 0.99999 ? 0.99999 : v;
        pos[i] = Math.floor((1 - v) * RH) * RW + Math.floor(u * RW);
      }
      return pos;
    };
    const direct = D === 1 && Math.min(1, Math.max(0.02, o.dotOpacity ?? 1)) >= 0.999;
    const drawAt = (q: number, col: number) => {
      if (direct) buf[q >= RWH ? q - RW : q] = col; // a dot on the bottom edge (py = RH) goes into the last row
      else {
        const py = (q / RW) | 0;
        put(q - py * RW, py, col);
      }
    };
    const drawOrdered = (ci: Uint8Array, cols: Uint32Array) => {
      const ord = o.drawOrder ?? 'density';
      const pos = positions();
      if (ord === 'density') {
        // by color index, events of one index in their order (a stable counting sort, as orderByIndex)
        const start = new Uint32Array(257);
        for (let i = 0; i < ci.length; i++) if (pos[i] >= 0) start[ci[i] + 1]++;
        for (let c = 1; c <= 256; c++) start[c] += start[c - 1];
        const at = start.slice(0, 256);
        const sorted = new Int32Array(start[256]);
        for (let i = 0; i < ci.length; i++) {
          const q = pos[i];
          if (q >= 0) sorted[at[ci[i]]++] = q;
        }
        for (let c = 0; c < 256; c++) {
          const col = cols[c];
          const end = start[c + 1];
          if (direct) for (let j = start[c]; j < end; j++) {
            const q = sorted[j];
            buf[q >= RWH ? q - RW : q] = col;
          }
          else for (let j = start[c]; j < end; j++) drawAt(sorted[j], col);
        }
      } else if (ord === 'random') {
        const perm = permutation(idx.length);
        for (let j = 0; j < perm.length; j++) {
          const q = pos[perm[j]];
          if (q >= 0) drawAt(q, cols[ci[perm[j]]]);
        }
      } else
        for (let i = 0; i < idx.length; i++) {
          const q = pos[i];
          if (q >= 0) drawAt(q, cols[ci[i]]);
        }
    };

    if (isDensity && li === 0) {
      // density image: one colored cell per bin, empty bins transparent
      let g: number;
      let grid: Float32Array;
      let show: (b: number) => boolean;
      let tOf: (b: number) => number;
      if (byParam) {
        g = o.densityBins ?? 128;
        const cps = colorParamScale(ws, o, layers[0]?.sampleId)!;
        const dp = engine.display(ws, L.sampleId, o.colorParam!, cps);
        if (!dp) return;
        grid = binStat(dx, dy, dp, idx, g, g, o.colorStat ?? 'median', zx, zy);
        show = (b) => grid[b] === grid[b];
        tOf = (b) => Math.min(1, Math.max(0, grid[b]));
        info = { ticks: paramTicks(cps, o), title: `${o.colorStat === 'mean' ? 'Mean' : 'Median'} ${channelDisplayName(ws, o.colorParam!, 'label')}` };
      } else {
        g = o.densityBins ?? Math.max(32, Math.min(512, Math.round(Math.min(RW, RH) / Math.max(1, k))));
        const counts = legacy ? hist2d(dx, dy, idx, g, g) : hist2dEdge(dx, dy, idx, g, g, zx, zy);
        const sigma = legacy ? 0.8 : ((o.densitySmooth ?? 0) / 100) * g;
        grid = sigma > 0 ? blur2d(counts, g, g, sigma) : counts;
        let mx = 0;
        if (legacy) for (let i = 0; i < grid.length; i++) mx = Math.max(mx, grid[i]);
        else mx = interiorMax(grid, g);
        // smoothed: hide the faint halo around isolated events (a single event peaks at 1 / (2 pi sigma^2))
        const thr = legacy ? mx * 0.002 : sigma > 0 ? Math.max(mx * 0.0015, 0.35 / (2 * Math.PI * sigma * sigma)) : 0.5;
        show = (b) => grid[b] > thr;
        const scale = o.densityScale ?? 'sqrt';
        let tOfV: (d: number) => number;
        let rk: Float32Array | null = null;
        if (scale === 'rank') {
          rk = rankBins(grid, counts);
          tOf = (b) => clip(rk![b]);
          tOfV = (d) => clip(d);
          info = { ticks: RANK_TICKS(lo, hi), title: 'Density percentile' };
        } else {
          const m = densityMap(scale, mx);
          tOf = (b) => clip(m.f(grid[b]));
          tOfV = (d) => clip(m.f(d));
          info = { ticks: densityTicks(scale, m, lo, hi), title: 'Events / bin' };
        }
        if (sigma > 0 && !legacy) {
          // smooth density: bilinear between bin centers, so the image has smooth edges at any size
          for (let py = 0; py < RH; py++) {
            const v = 1 - (py + 0.5) / RH;
            for (let px = 0; px < RW; px++) {
              const u = (px + 0.5) / RW;
              const d = sampleGrid(grid, g, g, u, v);
              if (d > thr) buf[py * RW + px] = cmap[Math.min(255, Math.floor(tOfV(rk ? sampleGrid(rk, g, g, u, v) : d) * 255))];
            }
          }
          return;
        }
      }
      for (let py = 0; py < RH; py++) {
        const by = Math.min(g - 1, Math.floor((1 - (py + 0.5) / RH) * g));
        for (let px = 0; px < RW; px++) {
          const b = by * g + Math.min(g - 1, Math.floor(((px + 0.5) / RW) * g));
          if (show(b)) buf[py * RW + px] = cmap[Math.min(255, Math.floor(tOf(b) * 255))];
        }
      }
      return;
    }
    if (pseudo && li === 0) {
      // every event colored by the density at its position: events per bin of a fine grid (smoothed only on request)
      const g = o.densityBins ?? 200;
      const counts = legacy ? hist2d(dx, dy, idx, g, g) : hist2dEdge(dx, dy, idx, g, g, zx, zy);
      const sigma = legacy ? 1.2 : ((o.densitySmooth ?? 0) / 100) * g;
      const grid = sigma > 0 ? blur2d(counts, g, g, sigma) : counts;
      let mx = 0;
      if (legacy) for (let i = 0; i < grid.length; i++) mx = Math.max(mx, grid[i]);
      else mx = interiorMax(grid, g);
      const scale = o.densityScale;
      const lut = new Uint8Array(grid.length);
      if (scale === 'rank') {
        const rk = rankBins(grid, counts);
        for (let b = 0; b < grid.length; b++) lut[b] = Math.min(255, Math.floor(clip(rk[b]) * 255));
        info = { ticks: RANK_TICKS(lo, hi), title: 'Density percentile' };
      } else {
        const m = densityMap(scale, mx);
        for (let b = 0; b < grid.length; b++) if (grid[b] > 0) lut[b] = Math.min(255, Math.floor(clip(m.f(grid[b])) * 255));
        info = { ticks: densityTicks(scale, m, lo, hi), title: 'Events / bin' };
      }
      const ci = new Uint8Array(idx.length);
      for (let i = 0; i < idx.length; i++) {
        const e = idx[i];
        const u = dx[e];
        const v = dy[e];
        const bx = u <= 0 || !(u === u) ? 0 : Math.min(g - 1, Math.floor(u * g));
        const by = v <= 0 || !(v === v) ? 0 : Math.min(g - 1, Math.floor(v * g));
        ci[i] = lut[by * g + bx];
      }
      drawOrdered(ci, cmap);
      return;
    }
    if (byParam && li === 0) {
      // third parameter: every event colored by its value on the parameter's (windowed) scale
      const cps = colorParamScale(ws, o, layers[0]?.sampleId)!;
      const dp = engine.display(ws, L.sampleId, o.colorParam!, cps);
      if (dp) {
        const ci = new Uint8Array(idx.length);
        for (let i = 0; i < idx.length; i++) {
          const t = dp[idx[i]];
          ci[i] = t === t ? Math.floor((t < 0 ? 0 : t > 1 ? 1 : t) * 255.999) : 0;
        }
        drawOrdered(ci, cmap);
        info = { ticks: paramTicks(cps, o), title: channelDisplayName(ws, o.colorParam!, 'label') };
        return;
      }
    }
    if (o.colorMode === 'population' && li === 0) {
      // backgating: all events grey, every gated subpopulation in its color, children drawn over their parents
      const pops = backgatePops(ws, L.popId);
      for (let i = 0; i < idx.length; i++) plot(idx[i], rgba(BACKGATE_GREY));
      let mask: Uint8Array | null = null;
      if (idx !== full) {
        mask = new Uint8Array(engine.eventCount(L.sampleId));
        for (let i = 0; i < idx.length; i++) mask[idx[i]] = 1;
      }
      for (const q of pops) {
        const pi = engine.population(ws, L.sampleId, q.id);
        const col = rgba(q.color);
        for (let i = 0; i < pi.length; i++) if (!mask || mask[pi[i]]) plot(pi[i], col);
      }
      return;
    }
    const col = rgba(visibleOn(L.color, th));
    const pos = positions();
    for (let i = 0; i < idx.length; i++) {
      const q = pos[i];
      if (q >= 0) drawAt(q, col);
    }
  });
  put.flush();
  ctx.putImageData(img, 0, 0);
  return { cv, info };
}

/** Color bar ticks of a third parameter on its (windowed) scale. */
function paramTicks(def: ScaleDef, o?: PlotOptions): ColorInfo['ticks'] {
  const ticks = computeTicks(def, { target: 4 })
    .filter((t) => t.major && t.label && t.u >= -1e-6 && t.u <= 1 + 1e-6)
    .map((t) => ({ t: t.u, label: tickLabelRuns(t.label!) }));
  if (!o) return ticks;
  const [lo, hi] = rangeOf(o);
  const sc = makeScale(def);
  return [...clipEnds(lo, hi, sc.inv(0), sc.inv(1), fmtCompact), ...ticks];
}

// ------------------------------------------------------------------ contour / zebra

interface ContourData {
  dens: Float32Array;
  g: number;
  thr: number[]; // ascending (outermost first)
  lines: number[][][]; // per threshold, in grid coordinates
}

function contourData(env: RenderEnv, item: PlotItem, L: ResolvedLayer, li: number, xs: ScaleDef, ys: ScaleDef): ContourData | null {
  const { ws, engine } = env;
  const o = item.options;
  const dx = engine.display(ws, L.sampleId, item.xParam, xs);
  const dy = engine.display(ws, L.sampleId, item.yParam, ys);
  if (!dx || !dy) return null;
  const idx = drawableEvents(ws, engine, L.sampleId, L.popId, item.xParam, item.yParam).idx;
  if (!idx.length) return null;
  const legacy = o.contourBandwidth === undefined;
  const g = legacy ? 128 : Math.max(32, Math.min(512, o.densityBins ?? 128));
  const sigma = ((o.contourBandwidth ?? 1.25) / 100) * g;
  const nLevels = Math.max(1, Math.min(50, o.contourLevels || 10));
  const deps = [dx, dy, idx, g, sigma, o.contourMode, nLevels];
  const mk = 'contour' + li;
  const c = env.cache?.get(mk);
  if (c && c.deps.length === deps.length && c.deps.every((d, i) => d === deps[i])) return c.value as ContourData;
  // progressive (see rasterDots): within a burst, contours of a subsample of a large population
  let use = idx;
  if (inBurst(env, mk) && idx.length > PREVIEW_MIN) {
    use = subsample(idx, PREVIEW_N);
    previewDrawn(env);
  }
  stamp(env, mk);
  return memo(env, mk, use === idx ? deps : [...deps, 'preview'], () => {
    const dens = blur2d(hist2d(dx, dy, use, g, g), g, g, sigma);
    const step = nLevels / 100;
    const fractions: number[] = [];
    for (let f = 1 - step; f > 0.001; f -= step) fractions.push(f);
    let thr =
      o.contourMode === 'log'
        ? logThresholds(dens, fractions.length, sigma > 0.3 ? 1 / (2 * Math.PI * sigma * sigma) : 1)
        : probabilityThresholds(dens, fractions);
    thr = thr.filter((t, i) => Number.isFinite(t) && t > 0 && (i === 0 || t > thr[i - 1]));
    return { dens, g, thr, lines: thr.map((t) => contourLines(dens, g, g, t)) };
  });
}

/**
 * Where contour / zebra fills start in the colormap (0..0.5): 0 on light backgrounds; on a dark one the first position
 * whose color has a contrast ratio of at least 3 against it (WCAG non-text contrast).
 */
export function fillStart(spec: CmapSpec, bg: string): number {
  const lb = luminance(bg);
  if (lb > 0.2) return 0;
  for (let t = 0; t <= 0.5 + 1e-9; t += 0.02) if ((luminance(lutHex(spec, t)) + 0.05) / (lb + 0.05) >= 3) return t;
  return 0.5;
}

function drawContours(p: Painter, item: PlotItem, layers: ResolvedLayer[], fr: Frame, xs: ScaleDef, ys: ScaleDef, env: RenderEnv, lw: number, th: Theme): ColorInfo | undefined {
  const { ws, engine } = env;
  const o = item.options;
  const zebra = item.plotType === 'zebra';
  const legacy = o.contourBandwidth === undefined;
  const spec = cmapOf(o);
  const lineMode = o.contourLines ?? (zebra ? 'none' : 'single');
  const filled = zebra || !!o.contourFill;
  let info: ColorInfo | undefined;
  layers.forEach((L, li) => {
    const cd = contourData(env, item, L, li, xs, ys);
    if (!cd) return;
    const { dens, g, thr, lines } = cd;
    const n = thr.length;
    // on a dark background the fills start where the colormap stands out from it (the outermost band of turbo or
    // viridis, dark purple, would disappear on a dark slide)
    const bgEff = th.bg ?? (th.dark ? pageColorOf(sheetOf(ws, item.id)) || BG_COLORS.dark : '#ffffff');
    const t0 = filled ? fillStart(spec, bgEff) : 0;
    const levelColor = (j: number) => lutHex(spec, t0 + (1 - t0) * (n > 1 ? j / (n - 1) : 1));
    const single = layers.length > 1 ? L.color : visibleOn(o.contourLineColor ?? '#1f1f1f', th);
    if (li === 0 && n && (filled || o.contourOutliers)) {
      // raster: filled bands (bilinear density, same estimate as the lines) and outlier dots below the outermost level
      const k = env.rasterScale;
      const RW = Math.max(1, Math.round(fr.w * k));
      const RH = Math.max(1, Math.round(fr.h * k));
      const bgc = bgEff;
      const outCol = filled ? levelColor(0) : single;
      const cv = memo(env, 'contourRaster', [cd, RW, RH, filled, zebra, o.contourOutliers, colormapLUT(spec), bgc, outCol, o.dotSize, o.dotShape, o.maxEvents, legacy], () => {
        const c = env.makeCanvas(RW, RH);
        const ctx = c.getContext('2d')!;
        const img = ctx.createImageData(RW, RH);
        const buf = new Uint32Array(img.data.buffer);
        if (filled) {
          const bands = new Uint32Array(n);
          for (let j = 0; j < n; j++) bands[j] = rgba(zebra && j % 2 === 1 ? mixHex(levelColor(j), bgc, 0.55) : levelColor(j));
          for (let py = 0; py < RH; py++) {
            const v = 1 - (py + 0.5) / RH;
            for (let px = 0; px < RW; px++) {
              const d = sampleGrid(dens, g, g, (px + 0.5) / RW, v);
              if (d < thr[0]) continue;
              let j = 0;
              while (j + 1 < n && d >= thr[j + 1]) j++;
              buf[py * RW + px] = bands[j];
            }
          }
        }
        if (o.contourOutliers) {
          const dx = engine.display(ws, L.sampleId, item.xParam, xs)!;
          const dy = engine.display(ws, L.sampleId, item.yParam, ys)!;
          const idx = subsample(drawableEvents(ws, engine, L.sampleId, L.popId, item.xParam, item.yParam).idx, o.maxEvents);
          const col = rgba(outCol);
          const put = legacy ? null : dotWriter(img, Math.max(1, Math.round(o.dotSize * k)), o.dotShape === 'circle', 1);
          for (let i = 0; i < idx.length; i++) {
            const e = idx[i];
            const u0 = dx[e];
            const v0 = dy[e];
            if (!(u0 === u0) || !(v0 === v0)) continue;
            if (legacy) {
              const bx = Math.min(g - 1, Math.max(0, Math.floor(u0 * g)));
              const by = Math.min(g - 1, Math.max(0, Math.floor(v0 * g)));
              if (dens[by * g + bx] >= thr[0]) continue;
            } else if (sampleGrid(dens, g, g, u0, v0) >= thr[0]) continue;
            if ((xs.type === 'window' && (u0 < 0 || u0 > 1)) || (ys.type === 'window' && (v0 < 0 || v0 > 1))) continue;
            const u = Math.min(0.99999, Math.max(0, u0));
            const v = Math.min(0.99999, Math.max(0, v0));
            const px = Math.floor(u * RW);
            const py = Math.floor((1 - v) * RH);
            if (put) put(px, py, col);
            else buf[Math.min(RH - 1, py) * RW + px] = col;
          }
          put?.flush();
        }
        ctx.putImageData(img, 0, 0);
        return c;
      });
      p.image(cv, fr.x, fr.y, fr.w, fr.h, false);
    }
    const mode = li === 0 ? lineMode : 'single';
    if (mode !== 'none')
      lines.forEach((set, j) => {
        const color = mode === 'level' ? levelColor(j) : single;
        for (const line of set) {
          const pts = new Array(line.length);
          for (let i = 0; i < line.length; i += 2) {
            pts[i] = fr.x + (line[i] / g) * fr.w;
            pts[i + 1] = fr.y + (1 - line[i + 1] / g) * fr.h;
          }
          const closed = Math.hypot(line[0] - line[line.length - 2], line[1] - line[line.length - 1]) < 1e-6;
          p.path(pts, closed, { color, width: lw * 0.8 });
        }
      });
    if (li === 0 && (filled || lineMode === 'level')) {
      const step = Math.max(1, Math.min(50, o.contourLevels || 10));
      let inner = 100 - step;
      while (inner - step > 0.1) inner -= step;
      info = {
        ticks: [
          { t: 0, label: o.contourMode === 'log' ? 'low' : String(100 - step) },
          { t: 1, label: o.contourMode === 'log' ? 'high' : String(Math.round(inner * 10) / 10) },
        ],
        title: o.contourMode === 'log' ? 'Density' : '% of events inside',
        ...(filled && t0 > 0 ? { from: t0 } : {}),
      };
    }
  });
  return info;
}

// ------------------------------------------------------------------ histogram

interface HistData {
  curves: Float32Array[];
  ymax: number; // y of the frame top (curve units)
  yTop: number; // y axis maximum (100 when normalized)
  shift: number; // stagger per layer (fraction of the frame)
  scaleH: number;
  norms: number[];
}

function histData(item: PlotItem, layers: ResolvedLayer[], xs: ScaleDef, env: RenderEnv): HistData {
  const { ws, engine } = env;
  const o = item.options;
  const bins = Math.max(16, Math.min(1024, o.bins || 256));
  const curves = layers.map((L, li) => {
    const dx = engine.display(ws, L.sampleId, item.xParam, xs);
    if (!dx) return new Float32Array(bins);
    const idx = engine.population(ws, L.sampleId, L.popId);
    return memo(env, 'hist' + li, [dx, idx, bins, o.histSmooth], () => {
      const h = hist1d(dx, idx, bins);
      return o.histSmooth > 0 ? blur1d(h, o.histSmooth) : h; // display only: statistics never use this curve
    });
  });
  let ymax = 0;
  if (o.histMode === 'normalized') ymax = 100;
  else for (const c of curves) for (let i = 0; i < c.length; i++) ymax = Math.max(ymax, c[i]);
  if (ymax <= 0) ymax = 1;
  ymax *= o.histMode === 'normalized' ? 1 : 1.05;
  const n = curves.length;
  const shift = n > 1 ? Math.min(Math.max(0, o.histOffset), 0.8 / (n - 1)) : 0;
  const norms = curves.map((c) => {
    let peak = 0;
    for (let i = 0; i < c.length; i++) peak = Math.max(peak, c[i]);
    return o.histMode === 'normalized' ? (peak > 0 ? 100 / peak : 0) : 1;
  });
  return { curves, ymax, yTop: o.histMode === 'normalized' ? 100 : ymax, shift, scaleH: 1 - (n - 1) * shift, norms };
}

function drawHistograms(p: Painter, item: PlotItem, layers: ResolvedLayer[], fr: Frame, hd: HistData, env: RenderEnv, th: Theme) {
  const o = item.options;
  const { curves, ymax, shift, scaleH, norms } = hd;
  const n = curves.length;
  const bins = curves[0]?.length ?? 0;
  const style = o.histFillStyle ?? (o.histFill ? (n === 1 ? 'solid' : 'semi') : 'outline');
  const width = Math.max(0.5, o.histLineWidth) * PT * 0.75;
  // draw back-to-front so the first layer ends on top when staggered
  for (let li = n - 1; li >= 0; li--) {
    const c = curves[li];
    const norm = norms[li];
    const base = li * shift;
    const pts: number[] = [];
    pts.push(fr.x, fr.y + fr.h * (1 - base));
    for (let i = 0; i < bins; i++) {
      const u = (i + 0.5) / bins;
      const v = base + ((c[i] * norm) / ymax) * scaleH;
      pts.push(fr.x + u * fr.w, fr.y + (1 - v) * fr.h);
    }
    pts.push(fr.x + fr.w, fr.y + fr.h * (1 - base));
    const col = visibleOn(layers[li].color, th);
    let fill: { color: string; opacity?: number } | null = null;
    if (style === 'solid') fill = n === 1 ? { color: o.histFillColor ?? (layers[li].color.toLowerCase() === '#1f1f1f' ? '#9aa6b2' : mixHex(col, th.bg ?? '#ffffff', 0.5)) } : { color: col };
    else if (style === 'semi') fill = { color: col, opacity: 0.28 };
    else if (style === 'gradient') p.image(gradientFill(env, fr, pts, col), fr.x, fr.y, fr.w, fr.h, true);
    p.path(pts, true, { color: col, width }, fill);
  }
}

/** Histogram area filled with the layer color fading towards the baseline (raster, so all painters show the same). */
function gradientFill(env: RenderEnv, fr: Frame, pts: number[], color: string): HTMLCanvasElement {
  const k = env.rasterScale;
  const cv = env.makeCanvas(Math.max(1, Math.round(fr.w * k)), Math.max(1, Math.round(fr.h * k)));
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(cv.width / fr.w, 0, 0, cv.height / fr.h, -fr.x * (cv.width / fr.w), -fr.y * (cv.height / fr.h));
  let top = Infinity;
  for (let i = 1; i < pts.length; i += 2) top = Math.min(top, pts[i]);
  const bottom = pts[1];
  const gr = ctx.createLinearGradient(0, top, 0, bottom);
  gr.addColorStop(0, cssRgba(color, 0.85));
  gr.addColorStop(1, cssRgba(color, 0.06));
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fillStyle = gr;
  ctx.fill();
  return cv;
}

// ------------------------------------------------------------------ axes

function tickLabelRuns(label: { base: string; exp?: string }): RichText {
  return label.exp !== undefined ? [{ text: label.base }, { text: label.exp, sup: true }] : label.base;
}

/**
 * Ticks thinned in pixels: the zero tick and labelled ticks first, then other major and minor ticks, each only when it
 * keeps a small gap to the ticks already drawn (no black blob of crowded ticks around zero on logicle axes).
 */
function thinTicks<T extends { u: number; major: boolean; label?: unknown; value: number }>(ticks: T[], len: number): T[] {
  const prio = (t: T) => (t.value === 0 ? 0 : t.major && t.label ? 1 : t.major ? 2 : 3);
  const order = [...ticks].sort((a, b) => prio(a) - prio(b));
  const kept: number[] = [];
  const out: T[] = [];
  for (const t of order) {
    const x = t.u * len;
    const gap = t.major ? 2.6 : 2.2;
    if (kept.some((k) => Math.abs(k - x) < gap)) continue;
    kept.push(x);
    out.push(t);
  }
  return out.sort((a, b) => a.u - b.u);
}

function drawAxes(p: Painter, item: PlotItem, fr: Frame, xs: ScaleDef, ys: ScaleDef | null, histYMax: number, st: TextStyle, lw: number, ws: Workspace, W = item.w) {
  const o = item.options;
  const fs = st.size;
  const tl = fs * 0.42;
  const inward = o.tickDir === 'in';
  const hideY = item.plotType === 'histogram' && !!o.histHideY;
  const axis = { color: st.color, width: lw };
  const tick = { color: st.color, width: lw * 0.9 };
  if (o.frame && !hideY) p.rect(fr.x, fr.y, fr.w, fr.h, axis, null);
  else {
    if (!hideY) p.line(fr.x, fr.y, fr.x, fr.y + fr.h, axis);
    p.line(fr.x, fr.y + fr.h, fr.x + fr.w, fr.y + fr.h, axis);
  }
  const lblGap = tickGap(o, fs);
  // X ticks
  const xt = thinTicks(computeTicks(xs, { target: xTarget(fr.w, fs), zeroGap: 2.6 / fr.w }), fr.w);
  for (const t of xt) {
    const x = fr.x + t.u * fr.w;
    const len = t.major ? tl : tl * 0.55;
    p.line(x, fr.y + fr.h, x, fr.y + fr.h + (inward ? -len : len), tick);
  }
  // labels: zero first, then the others in order; a label that would touch a placed one is left out
  const xUsed: [number, number][] = [];
  for (const t of xt.filter((q) => q.major && q.label).sort((a, b) => (a.value === 0 ? -1 : b.value === 0 ? 1 : a.u - b.u))) {
    const x = fr.x + t.u * fr.w;
    const r = tickLabelRuns(t.label!);
    const wdt = measureRich(r, st);
    // at least about half an em between neighbouring labels ("0" and "10³" of a biexponential axis)
    const a = x - wdt / 2 - fs * 0.3;
    const b = x + wdt / 2 + fs * 0.3;
    if (xUsed.some(([u0, u1]) => a < u1 && b > u0)) continue;
    xUsed.push([a, b]);
    p.text(x, fr.y + fr.h + lblGap, r, { ...st, align: 'center', baseline: 'top' });
  }
  // Y ticks
  let wy = 0;
  if (!hideY) {
    const yt = thinTicks(computeTicks(ys ?? histYDef(histYMax), { target: yTarget(fr.h, fs), zeroGap: 2.6 / fr.h }), fr.h);
    for (const t of yt) {
      const y = fr.y + (1 - t.u) * fr.h;
      const len = t.major ? tl : tl * 0.55;
      p.line(fr.x + (inward ? len : -len), y, fr.x, y, tick);
    }
    const yUsed: [number, number][] = [];
    for (const t of yt.filter((q) => q.major && q.label).sort((a, b) => (a.value === 0 ? -1 : b.value === 0 ? 1 : a.u - b.u))) {
      const y = fr.y + (1 - t.u) * fr.h;
      const a = y - fs * 0.68;
      const b = y + fs * 0.68;
      if (yUsed.some(([u0, u1]) => a < u1 && b > u0)) continue;
      yUsed.push([a, b]);
      const r = tickLabelRuns(t.label!);
      wy = Math.max(wy, measureRich(r, st));
      p.text(fr.x - lblGap, y, r, { ...st, align: 'right', baseline: 'middle' });
    }
  }
  // Axis titles: shrunk a little or wrapped onto two lines when they do not fit (never cut silently, see plotFitNotes)
  const tst: TextStyle = o.boldLabels ? { ...st, weight: 'bold' } : st;
  const xl = axisTitleX(item, ws);
  if (xl) {
    const span = xTitleSpan(fr, W);
    const f = fitAxisTitle(xl, axisTitleAltX(item, ws), span.hi - span.lo, tst);
    const fst = { ...tst, size: f.size };
    // centered on the frame, moved inwards where the item ends (never cut at its edge); its lines share one center
    const tw = Math.max(...f.lines.map((l) => measureRich(rich(l), fst)));
    const cx = Math.min(Math.max(fr.x + fr.w / 2, span.lo + tw / 2), span.hi - tw / 2);
    f.lines.forEach((l, i) => p.text(cx, fr.y + fr.h + lblGap + fs * 1.22 + i * f.size * 1.15, f.cut ? fitText(l, span.hi - span.lo, fst) : rich(l), { ...fst, align: 'center', baseline: 'top' }));
  }
  if (hideY) return;
  const yl = axisTitleY(item, ws);
  // right of the title (its descender side) keeps a gap to the widest tick label; a second line goes further left
  if (yl) {
    const f = fitAxisTitle(yl, axisTitleAltY(item, ws), yTitleRoom(fr), tst);
    const fst = { ...tst, size: f.size };
    const x0 = fr.x - lblGap - wy - fs * 0.3 - fs * 0.56;
    const n = f.lines.length;
    f.lines.forEach((l, i) => p.text(x0 - (n - 1 - i) * f.size * 1.15, fr.y + fr.h / 2, f.cut ? fitText(l, yTitleRoom(fr), fst) : rich(l), { ...fst, align: 'center', baseline: 'middle' }, -Math.PI / 2));
  }
}

/** Horizontal room of the x axis title: the frame and part of the margin left of it, never beyond the item (width W). */
const xTitleSpan = (fr: Frame, W: number) => {
  const m = Math.min(fr.x, 40) * 0.8;
  return { lo: fr.x - m, hi: Math.max(fr.x + fr.w, Math.min(fr.x + fr.w + m, W - 1)) };
};
const xTitleRoom = (fr: Frame, W: number) => {
  const s = xTitleSpan(fr, W);
  return s.hi - s.lo;
};
const yTitleRoom = (fr: Frame) => fr.h + Math.min(fr.y, 20);

/** The marker label alone (no channel name) as the shorter form of an automatic axis title, or null. */
function axisTitleAltX(item: PlotItem, ws: Workspace): string | null {
  if (item.options.xLabel !== undefined) return null;
  const l = channelDisplayName(ws, item.xParam, 'label');
  return l && l !== axisTitleX(item, ws) ? l : null;
}
function axisTitleAltY(item: PlotItem, ws: Workspace): string | null {
  if (item.plotType === 'histogram' || item.options.yLabel !== undefined) return null;
  const l = channelDisplayName(ws, item.yParam, 'label');
  return l && l !== axisTitleY(item, ws) ? l : null;
}

/**
 * An axis title in `room` px: as it is (smaller or on two lines, see fitTitle), else shortened: the marker label alone
 * ("CD69" for "CD69 (APC-A)"), else an ellipsis in the middle, so no glyph is ever cut at the item's edge. `cut`: the
 * title is drawn shortened (reported by plotFitNotes, shown in `lines`).
 */
export function fitAxisTitle(text: string, alt: string | null, room: number, st: TextStyle): TitleFit {
  const f = fitTitle(text, room, st);
  if (!f.cut) return f;
  if (alt) {
    const g = fitTitle(alt, room, st);
    if (!g.cut) return { ...g, cut: true };
  }
  const fst = { ...st, size: f.size };
  const fits = (t: string) => measureRich(rich(t), fst) <= room;
  // (markup such as superscripts is not split: an ellipsis at the end there)
  const t = text.includes('^') ? text : middleEllipsis(text, fits);
  return { size: f.size, lines: [t], cut: true };
}

export interface TitleFit {
  size: number;
  lines: string[];
  /** still too long at the smallest size on two lines: drawn shortened (and reported) */
  cut: boolean;
}

/**
 * Fit an axis title into `room`: the full size, else a little smaller (down to 80 %, not below 5.5 pt), else two lines
 * (split at the space that balances them), else shortened with an ellipsis (`cut`).
 */
export function fitTitle(text: string, room: number, st: TextStyle): TitleFit {
  const w = (t: string, size: number) => measureRich(rich(t), { ...st, size });
  const minSize = Math.min(st.size, Math.max(st.size * 0.8, 5.5 * PT));
  for (const k of [1, 0.9, 0.8]) {
    const size = Math.max(minSize, st.size * k);
    if (w(text, size) <= room) return { size, lines: [text], cut: false };
  }
  const words = text.split(' ');
  if (words.length > 1)
    for (const size of [st.size, minSize]) {
      let best: { a: string; b: string; m: number } | null = null;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' ');
        const b = words.slice(i).join(' ');
        const m = Math.max(w(a, size), w(b, size));
        if (!best || m < best.m) best = { a, b, m };
      }
      if (best && best.m <= room) return { size, lines: [best.a, best.b], cut: false };
    }
  return { size: minSize, lines: [text], cut: true };
}

// ------------------------------------------------------------------ color bar

function drawColorBar(p: Painter, item: PlotItem, fr: Frame, info: ColorInfo, pos: 'right' | 'top', st: TextStyle, lw: number, env: RenderEnv) {
  const o = item.options;
  const fs = st.size;
  const ls: TextStyle = { ...st, size: cbSize(fs) };
  const lut = colormapLUT(cmapOf(o));
  const vertical = pos === 'right';
  const cv = env.makeCanvas(vertical ? 1 : 256, vertical ? 256 : 1);
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(cv.width, cv.height);
  const from = info.from ?? 0;
  for (let i = 0; i < 256; i++) {
    const j = (vertical ? 255 - i : i) * 4;
    const k = Math.min(255, Math.round(from * 255 + i * (1 - from)));
    img.data[j] = lut[k * 3];
    img.data[j + 1] = lut[k * 3 + 1];
    img.data[j + 2] = lut[k * 3 + 2];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const frameStroke = { color: st.color, width: lw * 0.7 };
  const tl = fs * 0.3;
  const bw = colorBarWidth(item, fs);
  // clipped ends of the color range are labelled first; regular labels that would collide are dropped
  const ticks = [...info.ticks].sort((a, b) => (a.end === b.end ? a.t - b.t : a.end ? -1 : 1));
  if (vertical) {
    const x = fr.x + fr.w + fs * 0.45;
    const y = fr.y;
    const h = fr.h;
    p.image(cv, x, y, bw, h, true);
    p.rect(x, y, bw, h, frameStroke, null);
    const used: [number, number][] = [];
    let maxW = 0;
    for (const t of ticks) {
      const yy = y + (1 - t.t) * h;
      p.line(x + bw, yy, x + bw + tl, yy, frameStroke);
      const half = ls.size * 0.55;
      if (used.some(([a, b]) => yy + half > a && yy - half < b)) continue;
      used.push([yy - half, yy + half]);
      p.text(x + bw + tl + fs * 0.12, yy, t.label, { ...ls, align: 'left', baseline: 'middle' });
      maxW = Math.max(maxW, measureRich(t.label, ls));
    }
    p.text(x + bw + tl + fs * 0.12 + maxW + fs * 0.3 + ls.size * 0.37, y + h / 2, fitText(info.title, h, ls), { ...ls, align: 'center', baseline: 'middle' }, -Math.PI / 2);
    return;
  }
  const bh = bw * 0.85;
  const y = fr.y - fs * 0.35 - bh;
  const w = fr.w * 0.5;
  const x = fr.x + fr.w - w;
  p.image(cv, x, y, w, bh, true);
  p.rect(x, y, w, bh, frameStroke, null);
  const used: [number, number][] = [];
  for (const t of ticks) {
    const xx = x + t.t * w;
    p.line(xx, y, xx, y - tl, frameStroke);
    const wd = measureRich(t.label, ls);
    const a = Math.min(Math.max(xx - wd / 2, x - wd * 0.3), x + w + wd * 0.3 - wd);
    if (used.some(([u0, u1]) => a < u1 + ls.size * 0.3 && a + wd > u0 - ls.size * 0.3)) continue;
    used.push([a, a + wd]);
    p.text(a, y - tl - fs * 0.1, t.label, { ...ls, align: 'left', baseline: 'bottom' });
  }
  p.text(x - fs * 0.5, y + bh / 2, fitText(info.title, fr.w * 0.5 - fs, ls), { ...ls, align: 'right', baseline: 'middle' });
}

// ------------------------------------------------------------------ gates

function gateFor(pop: Population, sampleId: string): GateGeom {
  return pop.overrides?.[sampleId] ?? pop.gate;
}

export function gateMatchesPlot(g: GateGeom, item: PlotItem): { ok: boolean; swapped: boolean } {
  if (g.type === 'bool') return { ok: false, swapped: false };
  if (item.plotType === 'histogram') {
    if ((g.type === 'range' || g.type === 'split') && g.x === item.xParam) return { ok: true, swapped: false };
    return { ok: false, swapped: false };
  }
  if (g.type === 'range' || g.type === 'split') return { ok: false, swapped: false };
  if (g.x === item.xParam && g.y === item.yParam) return { ok: true, swapped: false };
  if (g.x === item.yParam && g.y === item.xParam) return { ok: true, swapped: true };
  return { ok: false, swapped: false };
}

const fmtPct = (pct: number) => (Number.isFinite(pct) ? (pct < 10 ? pct.toFixed(2) : pct.toFixed(1)) : '–');

interface LabelLine {
  text: string;
  color: string;
  /** a line in several colors (name and value on one line): drawn part by part */
  parts?: { text: string; color: string }[];
}

/** One form of a gate label (full, smaller, on one line, shortened): its lines, text size and box size. */
interface LabelFormSpec {
  lines: LabelLine[];
  size: number;
  w: number;
  h: number;
  /** the name is shortened (the full name is shown on hover) */
  short: boolean;
}

/** Extra layout cost of a label with a shortened name: the last resort, after smaller forms and places outside the frame. */
const SHORTENED_COST = 10;

/** A line shortened to `maxW`: the gate name in the middle ("CD4+…cells"), other text at its end. */
function fitLine(l: LabelLine, name: string, maxW: number, st: TextStyle, others: string[] = []): { line: LabelLine; short: boolean } {
  const w = (t: string) => measureRich(rich(t), st);
  if (w(l.text) <= maxW) return { line: l, short: false };
  if (name && l.text.startsWith(name)) {
    const rest = l.text.slice(name.length);
    const nm = shortenName(name, (t) => w(t + rest) <= maxW, others);
    const text = nm + rest;
    const parts = l.parts ? [{ ...l.parts[0], text: nm }, ...l.parts.slice(1)] : undefined;
    return { line: { ...l, text, ...(parts ? { parts } : {}) }, short: true };
  }
  const t = fitText(l.text, maxW, st);
  return { line: { ...l, text: typeof t === 'string' ? t : t.map((r) => (r.sup ? `^{${r.text}}` : r.text)).join(''), parts: undefined }, short: true };
}

/**
 * Forms of a gate label, the first one the label as it is, then (with `alt`) in order of preference: smaller (down to
 * the smallest label size), name and value on one line, and as a last resort a shortened name (the value is kept).
 * Every form fits `maxW` (a longer name is shortened in the middle). `cost`: extra layout cost of the form.
 */
function labelForms(lines: LabelLine[], name: string, size: number, maxW: number, st: TextStyle, alt: boolean, wideW = maxW, others: string[] = []): { lines: LabelLine[]; size: number; cost: number; short: boolean }[] {
  const out: { lines: LabelLine[]; size: number; cost: number; short: boolean }[] = [];
  const add = (ls: LabelLine[], sz: number, cost: number) => {
    addW(ls, sz, cost, maxW);
    // (also as wide as a zone above the frame may be: such forms only fit there)
    if (wideW > maxW + 0.5) addW(ls, sz, cost, wideW);
  };
  const addW = (ls: LabelLine[], sz: number, cost: number, maxW: number) => {
    const fitted = ls.map((l) => fitLine(l, name, maxW, { ...st, size: sz }, others));
    const short = fitted.some((f) => f.short);
    const f = { lines: fitted.map((x) => x.line), size: sz, cost: cost + (short ? SHORTENED_COST : 0), short };
    const key = JSON.stringify([f.lines.map((l) => l.text), sz]);
    if (!out.some((o) => JSON.stringify([o.lines.map((l) => l.text), o.size]) === key)) out.push(f);
  };
  add(lines, size, 0);
  if (!alt) return out;
  const minPx = MIN_LABEL_PT * PT;
  const sizes = [1, 0.85, 0.75].map((k, i) => ({ s: size * k, c: [0, 0.5, 0.9][i] })).filter((x, i) => i === 0 || x.s >= minPx - 1e-6);
  for (const x of sizes.slice(1)) add(lines, x.s, x.c);
  // name and value on one line (shorter: fits above a gate close to the frame edge)
  const named = lines.length === 2 && lines[0].text === name && !!name;
  const oneLine = (nm: string): LabelLine[] => [{ text: `${nm} ${lines[1].text}`, color: lines[0].color, parts: [{ text: nm, color: lines[0].color }, { text: ' ' + lines[1].text, color: lines[1].color }] }];
  if (named) for (const x of sizes) add(oneLine(name), x.s, 0.6 + x.c);
  // overlays (one value per layer, a stack that may not fit a small frame): the values side by side in their colors,
  // under the name or on its line, then with one decimal less
  const head = lines[0]?.text === name && !!name ? 1 : 0;
  const values = lines.slice(head);
  if (values.length > 1) {
    const fewer = (t: string) => (/^\d+\.\d+$/.test(t) ? Number(t).toFixed(Math.max(0, t.split('.')[1].length - 1)) : t);
    const row = (vs: LabelLine[], nm?: string): LabelLine => {
      const parts = [...(nm ? [{ text: nm, color: lines[0].color }] : []), ...vs.map((v, i) => ({ text: (nm || i ? ' ' : '') + v.text, color: v.color }))];
      return { text: parts.map((q) => q.text).join(''), color: (nm ? lines[0] : vs[0]).color, parts };
    };
    // (dearer than the stack itself: used when the stack has no place, e.g. taller than a small frame)
    for (const [vs, extra] of [
      [values, 0],
      [values.map((v) => ({ ...v, text: fewer(v.text) })), 2],
    ] as [LabelLine[], number][]) {
      if (extra && vs.every((v, i) => v.text === values[i].text)) continue;
      for (const x of sizes) {
        if (head) add([lines[0], row(vs)], x.s, 2.5 + extra + x.c);
        add([row(vs, head ? name : undefined)], x.s, 3 + extra + x.c);
      }
    }
  }
  // last resort: a shortened name, the value kept
  if (name && [...name].length > 4 && lines[0].text === name) {
    const s0 = sizes[sizes.length - 1].s;
    const full = measureRich(rich(name), { ...st, size: s0 });
    for (const k of [0.6, 0.4]) {
      const nm = shortenName(name, (t) => measureRich(rich(t), { ...st, size: s0 }) <= Math.max(full * k, s0 * 2), others);
      if (nm === name) continue;
      const ls = [{ ...lines[0], text: nm }, ...lines.slice(1)];
      const before = out.length;
      add(ls, s0, SHORTENED_COST + (k === 0.6 ? 0 : 1.5));
      if (named) add(oneLine(nm), s0, SHORTENED_COST + (k === 0.6 ? 0.3 : 1.8));
      for (const f of out.slice(before)) f.short = true;
    }
  }
  return [out[0], ...out.slice(1).sort((a, b) => a.cost - b.cost)];
}

/** Lines of a gate label; overlays get one value per layer in the layer's color. */
function labelLines(item: PlotItem, pop: Population, color: string, vals: { pct: number; count: number; color: string; na?: boolean }[], fg: string): LabelLine[] {
  const mode = item.options.gateLabel;
  if (mode === 'none') return [];
  const name = { text: pop.name, color };
  if (mode === 'name') return [name];
  const multi = vals.length > 1;
  const vs = vals.map((v) => ({ text: v.na ? 'n/a' : mode === 'name+count' ? v.count.toLocaleString('en-US') : fmtPct(v.pct), color: multi ? v.color : fg }));
  return mode === 'percent' ? vs.map((v) => (multi ? v : { ...v, color })) : [name, ...vs];
}

interface GateItem {
  shape: GateShape;
  draw: (p: Painter) => void;
  req?: LabelRequest;
  base?: { x: number; y: number };
  lines?: LabelLine[];
  size: number;
  align: 'left' | 'center' | 'right';
  /** the drawn outline (px), kept clear of labels */
  outlines: OutlineLine[];
  /** color of the gate (leader lines) */
  lineColor: string;
  /** forms of the label: [0] the request's own (req.w x req.h), then req.forms in order */
  forms?: LabelFormSpec[];
  /** the label's full text (plain), for the hover */
  full?: string;
  /** the label is drawn shortened */
  short?: boolean;
  /** draw the label with a halo (it sits on data or outlines) */
  halo?: boolean;
}

const LIM = 1e4;
/** finite display coordinate; gates are not clamped to the window (their drawing is clipped to the frame) */
const finU = (u: number) => (u === u ? (u > LIM ? LIM : u < -LIM ? -LIM : u) : 0);

/** whether display coordinates of `ev` map affinely onto the plot axis `plot` (straight edges stay straight) */
function affineAxis(plot: ScaleDef, ev: ScaleDef): boolean {
  const b = plot.type === 'window' ? plot.base : plot;
  return b === ev || (b.type === 'linear' && ev.type === 'linear') || JSON.stringify(b) === JSON.stringify(ev);
}

const EDGE_SAMPLES = 24;

/** Contrasting outline under a gate whose color disappears in the colormap (e.g. a red gate on a heat map). */
function gateHalo(item: PlotItem, color: string, th: Theme): string | null {
  if (!usesColormap(item)) return null;
  const lut = colormapLUT(cmapOf(item.options));
  const [r, g, b] = hexToRgb(color);
  let close = false;
  for (let i = 64; i < 256 && !close; i += 8) {
    const dr = lut[i * 3] - r;
    const dg = lut[i * 3 + 1] - g;
    const db = lut[i * 3 + 2] - b;
    // redmean color distance
    const rm = (lut[i * 3] + r) / 2;
    const d = Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
    if (d < 150) close = true;
  }
  if (!close) return null;
  return luminance(color) > 0.35 || th.dark ? '#000000' : '#ffffff';
}

/** Gate outlines (drawn later) and their label requests for the layout pass. */
function gateGeometry(item: PlotItem, fr: Frame, xs: ScaleDef, ys: ScaleDef | null, layers: ResolvedLayer[], env: RenderEnv, st: TextStyle, lw: number, th: Theme, plotW = fr.x + fr.w, quadValues = false): GateItem[] {
  const { ws, engine } = env;
  const o = item.options;
  const primary = layers[0];
  const out: GateItem[] = [];
  const parentId = primary.popId === 'root' ? null : primary.popId;
  const kids = popChildren(ws, parentId);
  // names shown together: shortened names stay apart from each other ("CD4 S…", not "CD…ve" twice)
  const gateNames = kids.map((k) => k.name);
  const sx = makeScale(xs);
  const sy = ys ? makeScale(ys) : null;
  // overlays of one population in several samples: one value per layer (compared by the layer's population, as each
  // sample may resolve it to its own group-specific copy)
  const statLayers = layers.filter(
    (L, i) => i === 0 || (L.layer.population === primary.layer.population && !layers.slice(0, i).some((M) => M.sampleId === L.sampleId && M.layer.population === L.layer.population)),
  );
  const parentCounts = statLayers.map((L) => engine.count(ws, L.sampleId, L.popId));
  const labelSize = gateLabelPx(st.size);
  const toPx = (u: number, v: number): [number, number] => [fr.x + u * fr.w, fr.y + (1 - v) * fr.h];
  // plot display of a raw value; open bounds sit just beyond the frame
  const uOf = (sc: { fwd(v: number): number }, v: number | null, open: number) => (v == null || !Number.isFinite(v) ? (v === Infinity || (v == null && open > 0) ? 1.05 : -0.05) : finU(sc.fwd(v)));
  const cx = (x: number) => Math.min(Math.max(x, fr.x), fr.x + fr.w);
  const cy = (y: number) => Math.min(Math.max(y, fr.y), fr.y + fr.h);
  const bbox = (pts: number[]) => {
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]);
      y1 = Math.max(y1, pts[i + 1]);
    }
    return { x0, x1, y0, y1 };
  };
  const visible = (pts: number[]) => {
    const b = bbox(pts);
    return b.x1 >= fr.x && b.x0 <= fr.x + fr.w && b.y1 >= fr.y && b.y0 <= fr.y + fr.h;
  };
  /** topmost outline point inside the frame (label anchor) */
  const topOf = (pts: number[]): [number, number] => {
    let best: [number, number] = [fr.x, fr.y];
    let minY = Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const y = cy(pts[i + 1]);
      if (y < minY) {
        minY = y;
        best = [cx(pts[i]), y];
      }
    }
    return best;
  };
  const doneQuads = new Set<string>();
  const quads: { group: string; kFull: number | null; kVal: number | null; hasVals: boolean; finalize: (drop: boolean, k: number) => void }[] = [];
  // quadrant labels may shrink, but not below the smallest label size
  const shrink = [1, 0.85, 0.75].filter((k) => k === 1 || labelSize * k >= MIN_LABEL_PT * PT - 1e-6);
  const minK = shrink[shrink.length - 1];
  const labelPos = o.labelPos ?? {};
  const labelOff = o.labelOff ?? {};
  const bounds: Box = { x: fr.x + 1, y: fr.y + 1, w: fr.w - 2, h: fr.h - 2 };
  for (const pop of kids) {
    // gates of other groups (scoped populations) and gates on channels the sample lacks are not shown
    if (!engine.applies(ws, primary.sampleId, pop.id)) continue;
    const g = gateFor(pop, primary.sampleId);
    const m = gateMatchesPlot(g, item);
    if (!m.ok) continue;
    const color = visibleOn(o.gateColor ?? pop.color, th);
    const selected = env.selectedPopId === pop.id;
    const specific = !!pop.overrides?.[primary.sampleId];
    const stroke = { color, width: selected ? lw * 2 : lw * 1.3, dash: specific && !env.forExport ? [5, 3] : undefined };
    const halo = gateHalo(item, color, th);
    const haloStroke = halo ? { color: halo, width: stroke.width + Math.max(1.2, lw * 1.4), dash: stroke.dash, opacity: halo === '#ffffff' ? 0.85 : 0.6 } : null;
    const fill = selected ? { color, opacity: 0.08 } : null;
    const vals = statLayers.map((L, i) => {
      // other layers: their sample's copy of this gate (same path of names); n/a where none applies
      const q = i === 0 ? pop.id : resolvePopFor(ws, L.sampleId, pop.id);
      const na = i > 0 && !engine.applies(ws, L.sampleId, q);
      const count = na ? 0 : engine.count(ws, L.sampleId, q);
      return { count, pct: !na && parentCounts[i] ? (100 * count) / parentCounts[i] : NaN, color: visibleOn(L.color, th), na };
    });
    // staggered histograms list the values top trace first, like the stack
    if (item.plotType === 'histogram' && o.histOffset > 0 && layers.length > 1) vals.reverse();
    // map raw (gate x,y) -> pixel respecting swap; open bounds (+-Infinity / null) go beyond the frame
    const P = (gx: number, gy: number, openX = 0, openY = 0): [number, number] => {
      const [rx, ry, ox, oy] = m.swapped ? [gy, gx, openY, openX] : [gx, gy, openX, openY];
      return toPx(uOf(sx, rx, ox), sy ? uOf(sy, ry, oy) : 0);
    };
    const shape: GateShape = { popId: pop.id, gate: g, kind: g.type, swapped: m.swapped, outline: null, handles: [] };
    const it: GateItem = { shape, draw: () => undefined, size: labelSize, align: 'left', outlines: [], lineColor: color };
    // quadrant names in the axis color, other gates in their own color
    let lines = labelLines(item, pop, g.type === 'quadrant' ? o.gateColor ?? th.fg : color, vals, th.fg);
    type Cand = { x: number; y: number; cost: number };
    /**
     * Label request from candidate positions (top-left of the text) for a text of tw x th px. With `alt`, the label
     * also gets smaller, one-line and (last resort) shortened forms, each with candidates of its own; a name wider than
     * the room is shortened in the middle (full name on hover).
     */
    const request = (
      candsFor: (tw: number, th: number) => Cand[],
      align: GateItem['align'] = 'left',
      nudgeFor?: (tw: number, th: number) => LabelRequest['nudge'],
      size = labelSize,
      scan: LabelRequest['scan'] = true,
      scanBounds?: Box,
      alt = true,
    ) => {
      if (!lines.length) return;
      const reg = scanBounds ?? bounds;
      // forms fitted to the region, and (for the room above the frame, see chooseLabelZone) to the frame's left edge to
      // the plot's right edge
      const specs = labelForms(lines, pop.name, size, Math.max(st.size * 2, reg.w - 4), st, alt, alt ? Math.max(st.size * 2, reg.w - 4, plotW - fr.x - 5) : undefined, gateNames);
      const made = specs.map((sp) => {
        const tw = Math.max(0, ...sp.lines.map((l) => measureRich(rich(l.text), { ...st, size: sp.size })));
        const th = sp.size * 1.12 * sp.lines.length;
        return { sp, tw, th, W: tw + 4, H: th + 2, cands: candsFor(tw, th).map((c) => ({ x: c.x - 2, y: c.y - 1, cost: c.cost })) };
      });
      const f0 = made[0];
      if (!f0.cands.length) return;
      const W = f0.W;
      const H = f0.H;
      const base = { x: f0.cands[0].x, y: f0.cands[0].y };
      const off = labelOff[pop.id];
      const legacy = off ? undefined : labelPos[pop.id];
      let fixed: { x: number; y: number } | undefined;
      if (off || legacy) {
        let fx = legacy ? toPx(legacy[0], legacy[1])[0] - 2 : base.x + off![0] * fr.w;
        let fy = legacy ? toPx(legacy[0], legacy[1])[1] - 1 : base.y + off![1] * fr.h;
        if (!Number.isFinite(fx)) fx = base.x;
        if (!Number.isFinite(fy)) fy = base.y;
        fixed = { x: Math.min(Math.max(fx, fr.x), fr.x + fr.w - W), y: Math.min(Math.max(fy, fr.y), fr.y + fr.h - H) };
      }
      it.req = {
        id: pop.id,
        w: W,
        h: H,
        fixed,
        cands: f0.cands,
        bounds: reg,
        nudge: nudgeFor?.(f0.tw, f0.th),
        scan,
        owner: pop.id,
        cost: f0.sp.cost,
        forms: fixed ? undefined : made.slice(1).filter((m) => m.cands.length).map((m) => ({ w: m.W, h: m.H, cost: m.sp.cost, cands: m.cands, nudge: nudgeFor?.(m.tw, m.th) })),
      };
      it.forms = [f0, ...(fixed ? [] : made.slice(1).filter((m) => m.cands.length))].map((m) => ({ lines: m.sp.lines, size: m.sp.size, w: m.W, h: m.H, short: m.sp.short }));
      it.base = base;
      it.lines = f0.sp.lines;
      it.size = f0.sp.size;
      it.short = f0.sp.short;
      it.full = lines.map((l) => l.text).join(' ');
      it.align = align;
    };
    const textH = (n = lines.length, size = labelSize) => size * 1.12 * n;
    const textW = (size = labelSize) => Math.max(0, ...lines.map((l) => measureRich(rich(l.text), { ...st, size })));
    switch (g.type) {
      case 'polygon':
      case 'ellipse': {
        // drawn in the space the gate is evaluated in (straight polygon edges there), then mapped onto this plot's axes
        const ev = gateEvalScales(g, (ch) => engine.scaleFor(ws, ch, primary.sampleId));
        const ex = makeScale(ev.x);
        const ey = makeScale(ev.y);
        const E = (a: number, b: number) => P(ex.inv(a), ey.inv(b));
        const lin = !!ys && affineAxis(m.swapped ? ys : xs, ev.x) && affineAxis(m.swapped ? xs : ys, ev.y);
        const pts: number[] = [];
        if (g.type === 'polygon') {
          const V = g.points.map((pt) => [ex.fwd(pt[0]), ey.fwd(pt[1])]);
          const K = lin ? 1 : EDGE_SAMPLES;
          V.forEach((a, i) => {
            const b = V[(i + 1) % V.length];
            const [x, y] = E(a[0], a[1]);
            shape.handles.push({ x, y, id: `v${i}` });
            pts.push(x, y);
            for (let k = 1; k < K; k++) pts.push(...E(a[0] + ((b[0] - a[0]) * k) / K, a[1] + ((b[1] - a[1]) * k) / K));
          });
          shape.edgeSamples = K;
        } else {
          const c = [ex.fwd(g.center[0]), ey.fwd(g.center[1])];
          const va = [ex.fwd(g.a[0]) - c[0], ey.fwd(g.a[1]) - c[1]];
          const vb = [ex.fwd(g.b[0]) - c[0], ey.fwd(g.b[1]) - c[1]];
          for (let i = 0; i < 72; i++) {
            const t = (i / 72) * Math.PI * 2;
            pts.push(...E(c[0] + Math.cos(t) * va[0] + Math.sin(t) * vb[0], c[1] + Math.cos(t) * va[1] + Math.sin(t) * vb[1]));
          }
          const H = (s: number, v: number[], id: string) => {
            const [x, y] = E(c[0] + s * v[0], c[1] + s * v[1]);
            return { x, y, id };
          };
          shape.handles = [H(1, va, 'a'), H(-1, va, 'a2'), H(1, vb, 'b'), H(-1, vb, 'b2')];
        }
        it.draw = (pp) => {
          if (haloStroke) pp.path(pts, true, haloStroke, null);
          pp.path(pts, true, stroke, fill);
        };
        shape.outline = pts;
        it.outlines.push({ pts, closed: true, owner: pop.id });
        if (visible(pts)) {
          const [tx, ty] = topOf(pts);
          const b = bbox(pts);
          const ax = g.type === 'polygon' ? tx + 2 : tx - st.size;
          request(
            (tw, th0) => {
              const midY = (cy(b.y0) + cy(b.y1)) / 2 - th0 / 2;
              return [
                { x: ax, y: ty - th0 - labelSize * 0.25, cost: 0 },
                { x: ax, y: cy(b.y1) + labelSize * 0.25, cost: 1 },
                { x: cx(b.x1) + 3, y: midY, cost: 1.4 },
                { x: cx(b.x0) - tw - 5, y: midY, cost: 1.6 },
                { x: tx - tw / 2, y: ty + labelSize * 0.35, cost: 2 },
              ];
            },
            'left',
          );
        }
        break;
      }
      case 'rect': {
        const [x0, y0] = P(g.xmin, g.ymin, -1, -1);
        const [x1, y1] = P(g.xmax, g.ymax, 1, 1);
        const rx = Math.min(x0, x1),
          ry = Math.min(y0, y1),
          rw = Math.abs(x1 - x0),
          rh = Math.abs(y1 - y0);
        // open bounds (-inf / +inf): those sides are not drawn; a small arrow from the drawn side points into the gate
        const nf = (v: number | null | undefined) => v == null || !Number.isFinite(v);
        const [oL, oR, oB, oT] = m.swapped ? [nf(g.ymin), nf(g.ymax), nf(g.xmin), nf(g.xmax)] : [nf(g.xmin), nf(g.xmax), nf(g.ymin), nf(g.ymax)];
        const open = oL || oR || oB || oT;
        const segs: number[][] = [];
        if (open) {
          if (!oL) segs.push([rx, ry, rx, ry + rh]);
          if (!oR) segs.push([rx + rw, ry, rx + rw, ry + rh]);
          if (!oT) segs.push([rx, ry, rx + rw, ry]);
          if (!oB) segs.push([rx, ry + rh, rx + rw, ry + rh]);
          const a = Math.max(4, st.size * 0.9);
          const hd = a * 0.38;
          const arrow = (x0: number, y0: number, dx: number, dy: number) => {
            const x1 = x0 + dx * a;
            const y1 = y0 + dy * a;
            segs.push([x0, y0, x1, y1], [x1, y1, x1 - dx * hd - dy * hd * 0.8, y1 - dy * hd - dx * hd * 0.8], [x1, y1, x1 - dx * hd + dy * hd * 0.8, y1 - dy * hd + dx * hd * 0.8]);
          };
          if (oL !== oR && !(oT && oB && oL && oR)) {
            const ya = Math.max(ry, fr.y);
            const yb = Math.min(ry + rh, fr.y + fr.h);
            if (yb > ya) arrow(oR ? rx : rx + rw, (ya + yb) / 2, oR ? 1 : -1, 0);
          }
          if (oT !== oB) {
            const xa = Math.max(rx, fr.x);
            const xb = Math.min(rx + rw, fr.x + fr.w);
            if (xb > xa) arrow((xa + xb) / 2, oT ? ry + rh : ry, 0, oT ? -1 : 1);
          }
        }
        it.draw = (pp) => {
          if (!open) {
            if (haloStroke) pp.rect(rx, ry, rw, rh, haloStroke, null);
            pp.rect(rx, ry, rw, rh, stroke, fill);
            return;
          }
          if (fill) pp.rect(rx, ry, rw, rh, null, fill);
          // single lines without a halo: a contrasting outline on both sides would read as a narrow strip
          for (const q of segs) pp.line(q[0], q[1], q[2], q[3], stroke);
        };
        shape.outline = [rx, ry, rx + rw, ry, rx + rw, ry + rh, rx, ry + rh];
        if (open) for (const q of segs) it.outlines.push({ pts: q, closed: false, owner: pop.id });
        else it.outlines.push({ pts: shape.outline, closed: true, owner: pop.id });
        shape.handles = [
          { x: rx, y: ry, id: 'tl' },
          { x: rx + rw, y: ry, id: 'tr' },
          { x: rx + rw, y: ry + rh, id: 'br' },
          { x: rx, y: ry + rh, id: 'bl' },
        ];
        if (visible(shape.outline)) {
          const lx = cx(rx) + 2;
          request(
            (tw, th0) => [
              { x: lx, y: cy(ry) - th0 - labelSize * 0.25, cost: 0 },
              { x: lx, y: cy(ry + rh) + labelSize * 0.25, cost: 1 },
              { x: lx, y: cy(ry) + labelSize * 0.25, cost: 1.3 },
              { x: cx(rx + rw) + 3, y: cy(ry), cost: 1.5 },
              { x: cx(rx) - tw - 5, y: cy(ry), cost: 1.7 },
            ],
            'left',
          );
        }
        break;
      }
      case 'quadrant': {
        const [qx, qy] = P(g.cx, g.cy);
        if (!doneQuads.has(g.groupId)) {
          doneQuads.add(g.groupId);
          const qs = { color: o.gateColor ?? th.fg, width: selected ? lw * 1.8 : lw * 1.1 };
          it.draw = (pp) => {
            pp.line(qx, fr.y, qx, fr.y + fr.h, qs);
            pp.line(fr.x, qy, fr.x + fr.w, qy, qs);
          };
          it.outlines.push({ pts: [qx, fr.y, qx, fr.y + fr.h], closed: false }, { pts: [fr.x, qy, fr.x + fr.w, qy], closed: false });
        }
        // which visual corner is this quadrant in?
        let q = g.quadrant;
        if (m.swapped) q = ({ UR: 'UR', LL: 'LL', UL: 'LR', LR: 'UL' } as const)[q];
        const left = q === 'UL' || q === 'LL';
        const top = q === 'UL' || q === 'UR';
        const x0 = left ? fr.x : cx(qx);
        const x1 = left ? cx(qx) : fr.x + fr.w;
        const y0 = top ? fr.y : cy(qy);
        const y1 = top ? cy(qy) : fr.y + fr.h;
        shape.outline = [x0, y0, x1, y0, x1, y1, x0, y1];
        shape.handles = [{ x: qx, y: qy, id: 'center' }];
        if (x1 - x0 >= 1 && y1 - y0 >= 1 && lines.length) {
          // too wide for its quadrant: smaller text, then the values without the names (the same for all four labels)
          const room = Math.max(x1 - x0, fr.w * 0.25) - 6;
          const full = lines;
          const vals = full.length > 1 && o.gateLabel !== 'name' ? full.slice(1) : null;
          const fit = (ls: LabelLine[]) => {
            for (const k of shrink) if (Math.max(...ls.map((l) => measureRich(rich(l.text), { ...st, size: labelSize * k }))) <= room) return k;
            return null;
          };
          quads.push({
            group: g.groupId,
            kFull: fit(full),
            kVal: vals ? fit(vals) : null,
            hasVals: !!vals,
            finalize: (drop: boolean, k: number) => {
              lines = drop && vals ? vals : full;
              const size = labelSize * k;
              const pad = st.size * 0.3;
              const tw = textW(size);
              const th0 = textH(lines.length, size);
              // the outer corner of the frame first, then the other outer corners of the quadrant, then any empty place
              // inside the quadrant (never across the divider lines)
              const xo = left ? fr.x + pad : fr.x + fr.w - pad - tw;
              const yo = top ? fr.y + pad : fr.y + fr.h - pad - th0;
              const xi = left ? x1 - pad - tw : x0 + pad;
              const yi = top ? y1 - pad - th0 : y0 + pad;
              const qbox: Box = { x: x0 + 1, y: y0 + 1, w: Math.max(0, x1 - x0 - 2), h: Math.max(0, y1 - y0 - 2) };
              const inQuad = qbox.w >= tw + 4 && qbox.h >= th0 + 2;
              request(
                () => [
                  { x: xo, y: yo, cost: 0 },
                  { x: xo, y: yi, cost: 1.1 },
                  { x: xi, y: yo, cost: 1.3 },
                ],
                left ? 'left' : 'right',
                () => ({ dx: 0, dy: (top ? 1 : -1) * th0 * 0.5, n: 4 }),
                size,
                qbox,
                // the label stays in its quadrant when it fits there
                inQuad ? qbox : undefined,
                false,
              );
            },
          });
        }
        break;
      }
      case 'range': {
        const [x0] = P(g.min, 0, -1);
        const [x1] = P(g.max, 0, 1);
        const yIdx = out.filter((s) => s.shape.kind === 'range').length;
        const y = fr.y + fr.h * (0.12 + 0.09 * (yIdx % 6));
        const tick = st.size * 0.5;
        it.draw = (pp) => {
          for (const s of haloStroke ? [haloStroke, stroke] : [stroke]) {
            pp.line(x0, y, x1, y, s);
            pp.line(x0, y - tick, x0, y + tick, s);
            pp.line(x1, y - tick, x1, y + tick, s);
          }
        };
        shape.outline = [x0, y - tick, x1, y - tick, x1, y + tick, x0, y + tick];
        shape.handles = [
          { x: x0, y, id: 'min' },
          { x: x1, y, id: 'max' },
        ];
        it.outlines.push(
          { pts: [x0, y, x1, y], closed: false, owner: pop.id },
          { pts: [x0, y - tick, x0, y + tick], closed: false, owner: pop.id },
          { pts: [x1, y - tick, x1, y + tick], closed: false, owner: pop.id },
        );
        if (visible(shape.outline)) {
          if (statLayers.length < 2 && lines.length === 2) lines = [{ text: `${lines[0].text} ${lines[1].text}`, color, parts: [{ text: lines[0].text, color }, { text: ' ' + lines[1].text, color: lines[1].color }] }];
          const a = cx(x0);
          const b = cx(x1);
          const mid = (a + b) / 2;
          request(
            (tw, th0) => {
              const above = y - tick - th0 - labelSize * 0.1;
              const below = y + tick + labelSize * 0.15;
              // centered above the bar first, then anywhere along it (above or below) where the curves leave room
              const cands = [
                { x: mid - tw / 2, y: above, cost: 0 },
                { x: mid - tw / 2, y: below, cost: 1 },
              ];
              const span = Math.max(1, b - a - tw);
              for (let k = 0; k <= 8; k++) {
                const xx = a + (span * k) / 8;
                const off = Math.abs(xx + tw / 2 - mid) / Math.max(1, b - a);
                cands.push({ x: xx, y: above, cost: 0.3 + off * 1.2 }, { x: xx, y: below, cost: 1.2 + off * 1.2 });
              }
              // beside the bar ends, on its height (where peaks fill the room above and below the bar)
              const side = y - th0 / 2 - 1;
              cands.push({ x: b + tick + 2, y: side, cost: 0.8 }, { x: a - tick - tw - 6, y: side, cost: 0.9 });
              return cands;
            },
            'center',
            (tw) => ({ dx: tw * 0.35, dy: 0, n: 2 }),
            labelSize,
            true,
          );
        }
        break;
      }
      case 'split': {
        const [xc] = P(g.cut, 0);
        if (!doneQuads.has(g.groupId)) {
          doneQuads.add(g.groupId);
          const ss = { color: o.gateColor ?? th.fg, width: selected ? lw * 1.8 : lw * 1.1 };
          it.draw = (pp) => pp.line(xc, fr.y, xc, fr.y + fr.h, ss);
          it.outlines.push({ pts: [xc, fr.y, xc, fr.y + fr.h], closed: false });
        }
        const lo = g.side === 'lo';
        const xk = cx(xc);
        shape.outline = lo ? [fr.x, fr.y, xk, fr.y, xk, fr.y + fr.h, fr.x, fr.y + fr.h] : [xk, fr.y, fr.x + fr.w, fr.y, fr.x + fr.w, fr.y + fr.h, xk, fr.y + fr.h];
        shape.handles = [{ x: xc, y: fr.y + fr.h / 2, id: 'cut' }];
        const pad = st.size * 0.35;
        if ((lo ? xk - fr.x : fr.x + fr.w - xk) >= 1) {
          const tw0 = textW();
          const sx0 = lo ? fr.x : xk;
          const sx1 = lo ? xk : fr.x + fr.w;
          const side: Box = { x: sx0 + 1, y: fr.y + 1, w: Math.max(0, sx1 - sx0 - 2), h: fr.h - 2 };
          request(
            (tw) => [{ x: lo ? xk - pad - tw : xk + pad, y: fr.y + pad, cost: 0 }],
            lo ? 'right' : 'left',
            (_tw, th0) => ({ dx: 0, dy: th0 * 0.5, n: 5 }),
            labelSize,
            side,
            side.w >= tw0 + 4 ? side : undefined,
          );
        }
        break;
      }
    }
    out.push(it);
  }
  // quadrant labels of one group share their size and form
  for (const gid of new Set(quads.map((q) => q.group))) {
    const qs = quads.filter((q) => q.group === gid);
    let drop = false;
    let k = minK;
    // (`quadValues`: the names find no clear place, see chooseLabelZone)
    if (qs.every((q) => q.kFull !== null) && !(quadValues && qs.every((q) => q.hasVals))) k = Math.min(...qs.map((q) => q.kFull!));
    else if (qs.every((q) => q.hasVals)) {
      drop = true;
      k = Math.min(...qs.map((q) => q.kVal ?? minK));
    }
    for (const q of qs) q.finalize(drop, k);
  }
  return out;
}

/** Outline in the background color around label glyphs: readable over data without boxes that wash the data out. */
function labelHalo(th: Theme, size: number): TextStyle['halo'] {
  return { color: th.labelBg ?? (th.dark ? '#000000' : '#ffffff'), width: Math.max(1, size * 0.14), opacity: 0.92 };
}

/**
 * Gate label lines: a halo keeps them readable where they sit on data or outlines (`halo`); with `boxed` (option
 * labelBox) on a background box. A line in several colors (name and value on one line) is drawn part by part.
 */
function drawLabelBox(p: Painter, b: Box, lines: LabelLine[], size: number, st: TextStyle, th: Theme, align: 'left' | 'center' | 'right' = 'left', boxed = false, haloOn = true) {
  const ls: TextStyle = { ...st, size };
  const halo = boxed || !haloOn ? undefined : labelHalo(th, size);
  const lh = size * 1.12;
  if (boxed) p.rect(b.x, b.y, b.w, b.h, null, { color: th.labelBg, opacity: 0.88 });
  const x = align === 'left' ? b.x + 2 : align === 'right' ? b.x + b.w - 2 : b.x + b.w / 2;
  lines.forEach((l, i) => {
    const y = b.y + 1 + i * lh;
    if (!l.parts?.length) {
      p.text(x, y, rich(l.text), { ...ls, color: l.color, baseline: 'top', align, halo });
      return;
    }
    const ws = l.parts.map((q) => measureRich(rich(q.text), ls));
    const total = ws.reduce((a, v) => a + v, 0);
    let xx = align === 'left' ? x : align === 'right' ? x - total : x - total / 2;
    l.parts.forEach((q, k) => {
      p.text(xx, y, rich(q.text), { ...ls, color: q.color, baseline: 'top', align: 'left', halo });
      xx += ws[k];
    });
  });
}

// ------------------------------------------------------------------ legend

interface LegendEntry {
  label: string;
  color: string;
  swatch: 'hist' | 'dot';
  /** label = name + two spaces + value (a statistic): shortening takes from the name, never the value */
  name?: string;
  value?: string;
}

/**
 * Lines of a legend entry in `maxW` px: the label as it is when it fits; else, with `wrap` (a column legend with room),
 * the value on a line of its own under the name; else the name shortened in the middle and the value kept.
 */
function legendEntryLines(e: LegendEntry, maxW: number, ls: TextStyle, wrap: boolean): RichText[] {
  const w = (t: string) => measureRich(rich(t), ls);
  if (w(e.label) <= maxW) return [rich(e.label)];
  if (e.value !== undefined && e.name) {
    if (wrap) return [rich(middleEllipsis(e.name, (t) => w(t) <= maxW)), fitText(e.value, maxW, ls)];
    const tail = '  ' + e.value;
    const budget = maxW - w(tail);
    if (budget > ls.size * 1.5) return [rich(middleEllipsis(e.name, (t) => w(t) <= budget) + tail)];
  }
  return [fitText(e.label, maxW, ls)];
}

/** Whether a column legend of `lw` px label width wraps its long entries: when that still fits `maxH`. */
function legendWraps(spec: LegendSpec, lw: number, ls: TextStyle, maxH: number): boolean {
  const n = spec.entries.reduce((a, e) => a + legendEntryLines(e, lw, ls, true).length, 0);
  return n > spec.entries.length && n * ls.size * 1.3 + 4 <= maxH;
}

interface LegendSpec {
  entries: LegendEntry[];
  /** several layers or populations */
  overlay: boolean;
}

/** Populations drawn in a backgating plot, parents before children. */
function backgatePops(ws: Workspace, popId: string): Population[] {
  const ids = popId === 'root' ? ws.populations.map((x) => x.id) : popDescendants(ws, popId);
  const depth = (id: string) => popAncestors(ws, id).length;
  return ids
    .map((id) => popById(ws, id))
    .filter((q): q is Population => !!q && q.gate.type !== 'bool')
    .map((q) => ({ q, d: depth(q.id) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.q);
}

const BACKGATE_GREY = '#9aa3ad';

function legendSpec(item: PlotItem, layers: ResolvedLayer[], env: RenderEnv, th: Theme, hd: HistData | null): LegendSpec | null {
  const { ws, engine } = env;
  const o = item.options;
  if (!layers.length) return null;
  if (item.plotType === 'dot' && o.colorMode === 'population') {
    // backgating: what the colors mean
    if (!o.legend) return null;
    const pops = backgatePops(ws, layers[0].popId);
    if (!pops.length) return null;
    return { entries: [{ label: layers[0].label, color: BACKGATE_GREY, swatch: 'dot' }, ...pops.map((q) => ({ label: q.name, color: q.color, swatch: 'dot' as const }))], overlay: true };
  }
  const ls = o.legendStat ?? 'none';
  if (!((o.legend && layers.length > 1) || ls !== 'none')) return null;
  const entries = layers.map((L) => {
    let label = L.label;
    if (ls !== 'none') {
      const col = { population: L.popId, stat: ls, channel: item.xParam };
      const na = engine.statNotApplicable(ws, L.sampleId, col);
      const v = na ? NaN : engine.stat(ws, L.sampleId, col);
      const tag = ls === 'median' ? 'MFI' : ls === 'geomean' ? 'gMFI' : ls === 'mean' ? 'Mean' : ls === 'count' ? 'n =' : '';
      const val = na ? 'n/a' : formatStat(v, ls);
      const lbl = layers.length > 1 || o.legend ? L.label : '';
      const value = `${tag} ${val}${ls === 'freqParent' && !na ? ' %' : ''}`.trim();
      label = `${lbl}${lbl ? '  ' : ''}${value}`.trim();
      if (lbl) return { label, name: lbl, value, color: visibleOn(L.color, th), swatch: item.plotType === 'histogram' ? ('hist' as const) : ('dot' as const) };
    }
    return { label, color: visibleOn(L.color, th), swatch: item.plotType === 'histogram' ? ('hist' as const) : ('dot' as const) };
  });
  // staggered histograms: the top trace first, as stacked
  if (hd && hd.shift > 0) entries.reverse();
  return { entries, overlay: layers.length > 1 };
}

/** Size of a legend: one column (inside / right of the plot) or rows below the plot. */
/** Legend swatch width and the gap to its label (em). */
const SWATCH_EM = 1.2;
const SWATCH_GAP_EM = 0.6;

function legendSize(spec: LegendSpec, pos: 'column' | 'outside-right' | 'below', w: number, h: number, st: TextStyle, maxW?: number): LegendBoxSize & { w: number; h: number } {
  const ls: TextStyle = { ...st, size: st.size * LEGEND_SCALE };
  const lh = ls.size * 1.3;
  const sw = 1 + ls.size * (SWATCH_EM + SWATCH_GAP_EM);
  const widths = spec.entries.map((e) => measureRich(rich(e.label), ls));
  if (pos === 'below') {
    const avail = w - st.size * 0.3;
    let rows = 1;
    let x = 0;
    for (const ew of widths) {
      const ww = Math.min(avail, sw + ew + ls.size * 1.1);
      if (x > 0 && x + ww > avail) {
        rows++;
        x = 0;
      }
      x += ww;
    }
    return { pos: 'below', w: avail, h: rows * lh + 2 };
  }
  const limit = maxW ?? (pos === 'outside-right' ? w * 0.42 : w * 0.6);
  const lw = Math.min(limit - sw - ls.size * 0.4, Math.max(...widths));
  void h;
  // entries that do not fit take two lines (name, value) where the height allows, else their names are shortened
  const wrap = legendWraps(spec, lw + 0.5, ls, pos === 'outside-right' ? h * 0.85 : h * 0.5);
  const lines = spec.entries.reduce((a, e) => a + legendEntryLines(e, lw + 0.5, ls, wrap).length, 0);
  return { pos: 'outside-right', w: sw + lw + ls.size * 0.4, h: lh * lines + 4 };
}

/** Inside legend: the frame corner that hides the least data and no gate labels. */
function legendCorner(spec: LegendSpec, fr: Frame, st: TextStyle, occ: Occupancy | null, gates: GateItem[]): { box: Box; cover: number } {
  const sz = legendSize(spec, 'column', fr.w, fr.h, st, fr.w * 0.92);
  const W = sz.w;
  const H = sz.h;
  const m = 3;
  const corners = [
    { x: fr.x + fr.w - W - m, y: fr.y + m, c: 0 },
    { x: fr.x + m, y: fr.y + m, c: 0.15 },
    { x: fr.x + fr.w - W - m, y: fr.y + fr.h - H - m, c: 0.3 },
    { x: fr.x + m, y: fr.y + fr.h - H - m, c: 0.45 },
  ];
  const labelBoxes = gates.filter((g) => g.req).map((g) => (g.req!.fixed ? { ...g.req!.fixed, w: g.req!.w, h: g.req!.h } : { x: g.req!.cands[0].x, y: g.req!.cands[0].y, w: g.req!.w, h: g.req!.h }));
  const gateBoxes = gates
    .filter((g) => g.shape.outline && (g.shape.kind === 'polygon' || g.shape.kind === 'ellipse' || g.shape.kind === 'rect'))
    .map((g) => {
      const o = g.shape.outline!;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = 0; i < o.length; i += 2) {
        x0 = Math.min(x0, o[i]);
        x1 = Math.max(x1, o[i]);
        y0 = Math.min(y0, o[i + 1]);
        y1 = Math.max(y1, o[i + 1]);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    });
  let best = { box: { x: corners[0].x, y: corners[0].y, w: W, h: H }, cover: 1, score: Infinity };
  for (const c of corners) {
    const box = { x: c.x, y: c.y, w: W, h: H };
    const a = W * H;
    const data = occ ? occ((box.x - fr.x) / fr.w, 1 - (box.y + H - fr.y) / fr.h, (box.x + W - fr.x) / fr.w, 1 - (box.y - fr.y) / fr.h) : 0;
    let lab = 0;
    for (const b of labelBoxes) lab += overlapArea(box, b);
    let gat = 0;
    for (const b of gateBoxes) gat += overlapArea(box, b);
    const cover = data + lab / a;
    const score = c.c + 10 * data + 10 * (lab / a) + 2 * Math.min(1, gat / a);
    if (score < best.score) best = { box, cover, score };
  }
  return best;
}

function drawLegend(p: Painter, spec: LegendSpec, box: Box, mode: 'column' | 'rows', st: TextStyle, lw: number, th: Theme, inside: boolean, maxW?: number) {
  const ls: TextStyle = { ...st, size: st.size * LEGEND_SCALE };
  const lh = ls.size * 1.3;
  // swatch, a gap of about half an em, then the label (the same spacing inside, right of and below the plot)
  const sw = 1 + ls.size * (SWATCH_EM + SWATCH_GAP_EM);
  const halo = inside ? labelHalo(th, ls.size) : undefined;
  const swatch = (e: LegendEntry, x: number, yy: number) => {
    if (e.swatch === 'hist') p.rect(x + 1, yy - ls.size * 0.35, ls.size * SWATCH_EM - 1, ls.size * 0.7, { color: e.color, width: lw }, { color: e.color, opacity: 0.3 });
    else p.rect(x + 1 + ls.size * (SWATCH_EM / 2 - 0.3), yy - ls.size * 0.3, ls.size * 0.6, ls.size * 0.6, null, { color: e.color });
  };
  if (mode === 'column') {
    let row = 0;
    // (wrapped when the box was sized for it, see legendSize)
    const lw0 = box.w - sw - ls.size * 0.4 + 0.5;
    const wrap = legendWraps(spec, lw0, ls, box.h + 0.5);
    for (const e of spec.entries) {
      const ls2 = legendEntryLines(e, lw0, ls, wrap);
      const yy = box.y + 2 + lh * row + lh / 2;
      swatch(e, box.x, yy);
      ls2.forEach((t, k) => p.text(box.x + sw, yy + lh * k, t, { ...ls, baseline: 'middle', halo }));
      row += ls2.length;
    }
    return;
  }
  const avail = maxW ?? box.w;
  let x = 0;
  let row = 0;
  for (const e of spec.entries) {
    const tw = Math.min(avail - sw - ls.size * 1.1, measureRich(rich(e.label), ls));
    const ww = sw + tw + ls.size * 1.1;
    if (x > 0 && x + ww > avail) {
      row++;
      x = 0;
    }
    const yy = box.y + 1 + lh * row + lh / 2;
    swatch(e, box.x + x, yy);
    p.text(box.x + x + sw, yy, legendEntryLines(e, tw + 0.5, ls, false)[0], { ...ls, baseline: 'middle' });
    x += ww;
  }
}

export function formatAxisValue(v: number): string {
  return formatLinear(v, Math.abs(v) / 10 || 1);
}

export type { Pt };
