// Workspace data model (serializable JSON). Event data live outside (see engine.ts).
import type { DerivedDef } from './derived';
import type { ScaleDef } from './transforms';

export const APP_NAME = 'FlowState';
/** Older app ids whose workspace files are still accepted. */
export const LEGACY_APP_NAMES = ['FlowCanvas'];
export const WORKSPACE_VERSION = 2; // 2: non-finite numbers stored as {"$n": "Infinity"}

export type Pt = [number, number];

export interface GateScales {
  x?: ScaleDef;
  y?: ScaleDef;
}

/**
 * Gate geometry in raw (compensated) data units.
 * Optional `comp` overrides the sample's compensation for this gate only
 * ('none' = uncompensated, 'file' = the sample's acquisition matrix, or a CompDef id). Used for Gating-ML fidelity.
 */
export type GateGeom = GateGeomBase & { comp?: string };
// Polygon / ellipse gates are evaluated in display space (`scales`, default: the workspace scales). App-drawn gates count
// off-scale events on the axis edge; `strict` gates (imported Gating-ML) do not. Missing flag: strict if `scales` is set.

type GateGeomBase =
  | { type: 'polygon'; x: string; y: string; points: Pt[]; scales?: GateScales; strict?: boolean }
  | { type: 'rect'; x: string; y: string; xmin: number; xmax: number; ymin: number; ymax: number }
  | { type: 'range'; x: string; min: number; max: number }
  | { type: 'ellipse'; x: string; y: string; center: Pt; a: Pt; b: Pt; scales?: GateScales; strict?: boolean } // raw coords; a,b are conjugate semi-axis end points
  | { type: 'quadrant'; x: string; y: string; cx: number; cy: number; quadrant: 'UR' | 'UL' | 'LL' | 'LR'; groupId: string }
  | { type: 'split'; x: string; cut: number; side: 'lo' | 'hi'; groupId: string }
  | { type: 'bool'; op: 'and' | 'or' | 'not'; operands: string[] };

export interface Population {
  id: string;
  name: string;
  parentId: string | null; // null = all events
  gate: GateGeom;
  color: string;
  overrides?: Record<string, GateGeom>; // sample-specific gate geometry
  /** samples the population (and its whole subtree) applies to; missing: all samples (see core/scope.ts) */
  scope?: PopScope;
  /** how the gate was made, when not drawn by hand (e.g. seeded by the AI assistant); informational only */
  provenance?: PopProvenance;
}

/** Origin of an assisted gate: the AI chose a seed, the deterministic auto gate drew the boundary. */
export interface PopProvenance {
  method: 'ai-autogate';
  /** model id (API) or 'claude.ai (<tier>)' */
  model: string;
  /** ISO date-time of the request */
  date: string;
  /** what was asked for, e.g. "lymphocytes" */
  target: string;
  rationale?: string;
  confidence?: number;
  /** seed in plot frame units (0..1, origin bottom-left): a point, a rectangle or a histogram range */
  seed?: number[];
  /** auto gate density threshold when accepted */
  alpha?: number;
  /** the gate was edited by hand afterwards */
  edited?: boolean;
}

/**
 * Samples a population applies to: the listed samples plus the members of the listed groups (group membership is read
 * live). Samples outside the scope show the population as "not applicable" (n/a), not as 0 events.
 */
export interface PopScope {
  groups?: string[];
  samples?: string[];
}

export interface SampleChannel {
  name: string;
  label: string;
  range: number;
  /** physical unit of the values, e.g. 's' for Time scaled by $TIMESTEP */
  unit?: string;
}

export interface SampleRef {
  id: string;
  name: string;
  fileName: string;
  fileSize: number;
  eventCount: number;
  channels: SampleChannel[];
  compId: string | null;
  color?: string;
  info?: Record<string, string>; // selected keywords: date, cytometer, tube ...
  /** instrument key ($CYT, plus $CYTSN when present; see core/instruments.ts), set when the file is loaded */
  instrument?: string;
  /** well of a plate the sample was measured in, normalized ("A01"; see core/plate.ts) */
  well?: string;
  /** name of its plate (Workspace.plates) */
  plate?: string;
  /**
   * Where the well came from: FCS keywords, the sample name, set by hand, or 'none' (looked for, not found). Missing:
   * never looked for (workspaces saved before plates existed: detected when the plate view needs it).
   */
  wellSource?: 'keyword' | 'name' | 'manual' | 'none';
}

/** A well plate: its format and its layout (per-well annotations such as compound and concentration). */
export interface PlateDef {
  /** unique; SampleRef.plate refers to it */
  name: string;
  rows: number;
  cols: number;
  /** what identified the plate when it was detected (keywords, name, folder), so later files and re-detection join it */
  key?: string;
  /** well ("A01") -> key -> value, e.g. { Compound: 'Drug A', 'Concentration (uM)': '10' } */
  annotations?: Record<string, Record<string, string>>;
}

/** Settings of the plate view (heatmap of a statistic over the wells). */
export interface PlateViewSettings {
  stat: StatColumn;
  colormap: string;
  reverse?: boolean;
  /** fixed color range; missing: from the values (all plates) */
  range?: [number, number];
  /** print the values in the wells */
  values?: boolean;
  decimals?: number;
  /** plates side by side ('row') or stacked ('column') */
  arrange?: 'row' | 'column';
  /** annotation key shown in the wells */
  overlay?: string;
  /** color the wells by the statistic (default) or by the shown annotation */
  colorBy?: 'stat' | 'overlay';
}

/** A plate heatmap on a worksheet: a chart item (its `stat`) drawn as the wells of one plate. */
export interface PlateChartDef {
  plate: string;
  colormap: string;
  reverse?: boolean;
  /** fixed color range; missing: from the plate's values (or of all plates: `shared`) */
  range?: [number, number];
  /** automatic range from the values of all plates (heatmaps of several plates compare like in the plate view) */
  shared?: boolean;
  values: boolean;
  decimals: number;
  legend: boolean;
}

export interface CompDef {
  id: string;
  name: string;
  channels: string[];
  matrix: number[][]; // spillover, [source][detector]
  /** 'imported': read from a matrix file of another program (FlowJo .mtx, FlowLogic / CSV text, CytExpert .comp) */
  source: 'file' | 'manual' | 'computed' | 'gatingml' | 'imported';
}

export interface Group {
  id: string;
  name: string;
  sampleIds: string[];
  color?: string;
}

export type PlotType = 'dot' | 'pseudo' | 'density' | 'contour' | 'zebra' | 'histogram';

export interface Layer {
  id: string;
  sample: string; // 'active' or sample id
  population: string; // 'root' or population id
  color?: string;
  visible?: boolean;
  label?: string;
}

export interface PlotOptions {
  title?: string;
  showTitle: boolean;
  showGates: boolean;
  gateLabel: 'none' | 'name' | 'percent' | 'name+percent' | 'name+count';
  colorMode: 'single' | 'density' | 'population' | 'param';
  dotSize: number;
  dotColor: string;
  colormap: string;
  maxEvents: number; // display subsampling (0 = all)
  bins: number;
  histMode: 'count' | 'normalized';
  histSmooth: number;
  histFill: boolean;
  histOffset: number; // 0..1 vertical stagger between overlay layers
  histLineWidth: number;
  contourLevels: number;
  contourOutliers: boolean;
  fontSize: number;
  lineWidth: number;
  xLabel?: string;
  yLabel?: string;
  xScale?: ScaleDef; // per-plot override of the workspace scale
  yScale?: ScaleDef;
  legend: boolean;
  frame: boolean;
  labelPos?: Record<string, [number, number]>; // legacy: absolute gate label positions (display units)
  labelOff?: Record<string, [number, number]>; // gate label offsets from their default position (fractions of the plot frame, x right / y down)
  legendStat?: 'none' | 'median' | 'mean' | 'geomean' | 'count' | 'freqParent'; // statistic appended to legend entries
  labelBox?: boolean; // gate labels on a background box
  titleMode?: 'population' | 'sample' | 'custom'; // automatic title form (custom = `title`)
  xWin?: [number, number]; // zoom window in display units of the x scale
  yWin?: [number, number];
  // ---- appearance (all optional: a missing field reproduces the look of plots saved before it existed)
  cmapReverse?: boolean;
  cmapStops?: string[]; // 2-3 colors of the custom gradient (colormap 'custom')
  densityScale?: DensityScale; // color mapping of density (missing: power 0.55, the v1 look)
  colorRange?: [number, number]; // % of the color scale mapped onto the colormap (clipping)
  densityBins?: number; // 2D bins per axis of the density estimate (missing: v1 grid per plot type)
  densitySmooth?: number; // pseudocolor / density image: Gaussian sigma in % of the axis range, 0 = off (missing: v1 smoothing)
  colorParam?: string; // colorMode 'param': third parameter coloring the events
  colorParamScale?: ScaleDef; // scale of the third parameter (missing: workspace scale)
  colorStat?: 'median' | 'mean'; // density image colored by a parameter: statistic per bin
  colorBar?: 'none' | 'right' | 'top';
  dotShape?: 'square' | 'circle';
  dotOpacity?: number; // 0..1
  drawOrder?: 'file' | 'random' | 'density'; // density: densest (or highest parameter value) drawn last (default)
  bg?: PlotBackground;
  bgColor?: string; // bg 'custom'
  contourMode?: 'probability' | 'log'; // level spacing: equal probability or log density
  contourBandwidth?: number; // contour / zebra: Gaussian sigma in % of the axis range (missing: 1.25)
  contourLines?: 'single' | 'level' | 'none'; // line color (missing: 'single', zebra 'none')
  contourLineColor?: string;
  contourFill?: boolean; // contour: fill the bands with the colormap
  histFillStyle?: 'solid' | 'semi' | 'outline' | 'gradient'; // missing: from histFill
  histFillColor?: string; // single-layer solid fill
  histHideY?: boolean; // hide the y axis (offset overlays)
  tickDir?: 'out' | 'in';
  boldLabels?: boolean; // bold axis titles
  legendPos?: 'auto' | 'inside' | 'outside-right' | 'below'; // missing: 'auto' (outside right when an overlay legend would cover data or labels)
  gateColor?: string; // one color for all gate outlines and labels of this plot (missing: each population's color)
}

export type DensityScale = 'linear' | 'sqrt' | 'log' | 'rank';
export type PlotBackground = 'white' | 'transparent' | 'dark' | 'black' | 'custom';

export interface ItemBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlotItem extends ItemBase {
  kind: 'plot';
  plotType: PlotType;
  xParam: string;
  yParam: string;
  layers: Layer[];
  options: PlotOptions;
  /** gates the plot showed before its population was changed: still drawn when on its axes (see plotGatePops) */
  keepGates?: string[];
}

export interface TextItem extends ItemBase {
  kind: 'text';
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  color: string; // '' = automatic (page text colour); panel labels carry tag/forItem (see render/figstyle.ts)
  /**
   * A sample name made by "Repeat for samples" (column header or row label): `auto` is the text as made. While the
   * text is unchanged it follows renames of the sample; edited by hand, it stays.
   */
  sampleHeader?: { sample: string; auto: string };
  /**
   * The height was set by hand (inspector, resize handles): kept when the text, its size or the box width change (an
   * overflow mark on screen and a note in the export dialog say when the text no longer fits). Missing: the box grows to
   * fit its text.
   */
  hFixed?: boolean;
}

export interface StatsBoxItem extends ItemBase {
  kind: 'stats';
  sample: string; // 'active' | id
  rows: StatColumn[]; // each row one statistic
  fontSize: number;
  bg?: PlotBackground; // missing: white
  bgColor?: string; // bg 'custom'
}

export interface ChartItem extends ItemBase {
  kind: 'chart';
  /** calibration panel data (bead fit, size curve, MESF regression) drawn instead of a statistic chart */
  calib?: import('../render/calibPanel').CalibPanel;
  /** plate heatmap: the statistic over the wells of a plate, drawn instead of a bar / dot chart */
  plate?: PlateChartDef;
  stat: StatColumn;
  mode: 'samples' | 'groups';
  sampleSet: 'all' | string; // for 'samples' mode
  /** 'samples' mode: the samples fixed when the chart was made (in this order); missing: sampleSet (live) */
  samples?: string[];
  groups?: string[]; // group ids for 'groups' mode (all groups if empty)
  style: 'bar' | 'dot';
  errorBars: 'sd' | 'sem' | 'none';
  showPoints: boolean;
  color: string;
  useGroupColors: boolean;
  title?: string;
  yLabel?: string;
  fontSize: number;
  lineWidth: number;
  yMax?: number;
  bg?: PlotBackground; // missing: white
  bgColor?: string; // bg 'custom'
}

export type SheetItem = PlotItem | TextItem | StatsBoxItem | ChartItem;

export interface Worksheet {
  id: string;
  name: string;
  page: { w: number; h: number; name: string };
  grid: number; // px
  snap: boolean; // independent of the grid's visibility
  /** legacy visibility flag, kept in sync with gridStyle for older readers */
  showGrid?: boolean;
  gridStyle?: GridStyle; // missing: from showGrid
  gridColor?: string;
  gridOpacity?: number; // 0..1 (missing: per style)
  gridMajor?: number; // stronger line / dot every N cells (0 = none)
  pageColor?: string; // missing: white
  exportPage?: boolean; // paint the page color in exports (missing: true)
  exportGrid?: boolean; // the grid is an editing aid; exported only when set
  /** figure font size (pt) of this sheet, overriding the workspace figure style (Workspace.style.fontSize); missing: that */
  fontSize?: number;
  items: SheetItem[];
}

export type GridStyle = 'lines' | 'dots' | 'none';

export function sheetGridStyle(s: Worksheet): GridStyle {
  return s.gridStyle ?? (s.showGrid === false ? 'none' : 'lines');
}

/** Set the grid style, keeping the legacy showGrid flag in sync for older readers. */
export function setGridStyle(s: Worksheet, v: GridStyle) {
  s.gridStyle = v;
  s.showGrid = v !== 'none';
}

export const DEFAULT_GRID_COLOR = '#1463b8';
export function sheetGridOpacity(s: Worksheet): number {
  return s.gridOpacity ?? (sheetGridStyle(s) === 'dots' ? 0.4 : 0.1);
}

export type StatKind =
  | 'count'
  | 'freqParent'
  | 'freqTotal'
  | 'freqGrandparent'
  | 'mean'
  | 'median'
  | 'geomean'
  | 'sd'
  | 'cv'
  | 'rsd'
  | 'rcv'
  | 'min'
  | 'max'
  | 'percentile'
  | 'mode'
  | 'freqOf'
  | 'concentration';

export const STAT_LABELS: Record<StatKind, string> = {
  count: 'Count',
  freqParent: '% Parent',
  freqTotal: '% Total',
  freqGrandparent: '% Grandparent',
  mean: 'Mean',
  median: 'Median',
  geomean: 'Geo. Mean',
  sd: 'SD',
  cv: 'CV %',
  rsd: 'Robust SD',
  rcv: 'Robust CV %',
  min: 'Min',
  max: 'Max',
  percentile: 'Percentile',
  mode: 'Mode',
  freqOf: '% of …',
  concentration: 'Events / µL',
};

export const STAT_NEEDS_CHANNEL: Record<StatKind, boolean> = {
  count: false,
  freqParent: false,
  freqTotal: false,
  freqGrandparent: false,
  mean: true,
  median: true,
  geomean: true,
  sd: true,
  cv: true,
  rsd: true,
  rcv: true,
  min: true,
  max: true,
  percentile: true,
  mode: true,
  freqOf: false,
  concentration: false,
};

export interface StatColumn {
  id: string;
  population: string;
  stat: StatKind;
  channel?: string;
  percentile?: number;
  header?: string;
  ofPopulation?: string; // for 'freqOf': reference population (ancestor)
}

export interface TableDef {
  id: string;
  name: string;
  columns: StatColumn[];
  sampleSet: 'all' | string; // group id
  hiddenSamples?: string[]; // sample ids left out of this table's rows
}

export interface PlotStyleDefaults {
  fontFamily: string;
  fontSize: number; // pt, used for new plots
  lineWidth: number;
  plotW?: number; // mm, size of new plots
  plotH?: number;
  preset?: string; // style preset (render/presets.ts) applied to new plots
}

export interface Workspace {
  app: string;
  version: number;
  name: string;
  samples: SampleRef[];
  groups: Group[];
  compensations: CompDef[];
  scales: Record<string, ScaleDef>;
  channelLabels: Record<string, string>;
  populations: Population[];
  worksheets: Worksheet[];
  tables: TableDef[];
  style: PlotStyleDefaults;
  /** computed channels (unmixing, MESF, size calibration), in evaluation order */
  derived?: DerivedDef[];
  /**
   * Axis scales of particular instruments (instrument key -> channel -> scale), for channels whose range differs between
   * the cytometers of the workspace; everything else uses `scales` (see core/instruments.ts scaleFor).
   */
  instrumentScales?: Record<string, Record<string, ScaleDef>>;
  /**
   * FlowJo's own event counts of an imported .wsp (sample id -> population id, 'root' = all events -> count; -1: not
   * computed by FlowJo), kept with the workspace so the comparison (Gate > FlowJo counts) works after saving and
   * reopening. Optional.
   */
  flowjoCounts?: { fileName: string; counts: Record<string, Record<string, number>> };
  /** well plates (formats, layouts); samples refer to them by name (SampleRef.plate). Optional. */
  plates?: PlateDef[];
  /** settings of the plate view (heatmap statistic, colors). Optional. */
  plateView?: PlateViewSettings;
  /** what the analysis needs (chosen for a new analysis, changed any time): unset shows every tool. Optional. */
  setup?: ExperimentSetup;
}

/**
 * Kind of experiment and the calibration tools it needs. Tools not needed are hidden (ribbon, views); a calibration
 * that exists in the workspace keeps its tool shown.
 */
export interface ExperimentSetup {
  kind: 'conventional' | 'nanoscale';
  /** fluorescence calibration with intensity beads (MESF / ERF / ABC) */
  mesf: boolean;
  /** light-scatter calibration in nm² and diameter (Mie) */
  size: boolean;
}

/** The setup suggested for a kind of experiment: nanoscale runs calibrate scatter and fluorescence. */
export const setupFor = (kind: ExperimentSetup['kind']): ExperimentSetup => ({ kind, mesf: kind === 'nanoscale', size: kind === 'nanoscale' });

/** Which calibration tools to show: those of the setup, and those already used in the workspace. */
export function calibTools(ws: Pick<Workspace, 'setup' | 'derived'>): { mesf: boolean; size: boolean } {
  const s = ws.setup;
  const used = (k: string) => !!ws.derived?.some((d) => d.kind === k);
  return { mesf: !s || s.mesf || used('mesf'), size: !s || s.size || used('size') };
}

// ----------------------------------------------------------- helpers

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${idCounter.toString(36)}`;
}

const MM_PX = 96 / 25.4;
export const PAGE_SIZES: Record<string, { w: number; h: number }> = {
  // CSS px at 96 dpi, not rounded: an 85 mm page exports as 85 mm
  'Journal 1 column (85 mm)': { w: 85 * MM_PX, h: 110 * MM_PX },
  'Journal 1.5 column (120 mm)': { w: 120 * MM_PX, h: 120 * MM_PX },
  'Journal 2 columns (180 mm)': { w: 180 * MM_PX, h: 150 * MM_PX },
  'A4 portrait': { w: 210 * MM_PX, h: 297 * MM_PX },
  'A4 landscape': { w: 297 * MM_PX, h: 210 * MM_PX },
  'Letter portrait': { w: 816, h: 1056 },
  'Letter landscape': { w: 1056, h: 816 },
  'Screen (wide)': { w: 1400, h: 900 },
};

export const MM = 96 / 25.4; // px per mm

/** Worksheet item geometry limits (px): sizes from 1 mm to 5000 mm, positions within 5000 mm of the page origin. */
export const ITEM_MIN_SIZE = 1 * MM;
export const ITEM_MAX_SIZE = 5000 * MM;
export const ITEM_MAX_POS = 5000 * MM;

/**
 * Keep an item's position and size finite and within the limits above (in place); returns true if anything changed.
 * Non-numbers become `fallback` values. A height of 1e9 mm (typed into the inspector, or in a damaged file) would
 * otherwise ask for millions of axis ticks or canvas pixels.
 */
export function clampItemGeometry(it: { x: unknown; y: unknown; w: unknown; h: unknown }, fallback: { w: number; h: number } = { w: 60 * MM, h: 54 * MM }): boolean {
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  const r = it as { x: number; y: number; w: number; h: number };
  const x = clamp(r.x, -ITEM_MAX_POS, ITEM_MAX_POS, 0);
  const y = clamp(r.y, -ITEM_MAX_POS, ITEM_MAX_POS, 0);
  const w = clamp(r.w, ITEM_MIN_SIZE, ITEM_MAX_SIZE, fallback.w);
  const h = clamp(r.h, ITEM_MIN_SIZE, ITEM_MAX_SIZE, fallback.h);
  const changed = x !== r.x || y !== r.y || w !== r.w || h !== r.h;
  if (changed) Object.assign(r, { x, y, w, h });
  return changed;
}

export const GATE_COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22'];
export const LAYER_COLORS = ['#1f1f1f', '#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#8c564b', '#e377c2', '#bcbd22'];

let newPlotStyle: Partial<PlotOptions> = {};
/** Appearance of new plots (the workspace's default style preset); kept in sync with the workspace by ui/stylePresets.ts. */
export function setNewPlotStyle(o: Partial<PlotOptions>) {
  newPlotStyle = o;
}

export function defaultPlotOptions(): PlotOptions {
  return {
    showTitle: true,
    showGates: true,
    gateLabel: 'name+percent',
    colorMode: 'density',
    dotSize: 1,
    dotColor: '#1f1f1f',
    colormap: 'flowjo',
    maxEvents: 0,
    bins: 256,
    histMode: 'normalized',
    histSmooth: 0, // no smoothing unless switched on
    histFill: true,
    histOffset: 0,
    histLineWidth: 1,
    contourLevels: 10,
    contourOutliers: true,
    fontSize: 10,
    lineWidth: 1,
    legend: true,
    frame: true,
    densityScale: 'log',
    densityBins: 128,
    densitySmooth: 0,
    contourBandwidth: 1.25,
    ...newPlotStyle,
  };
}

export function emptyWorkspace(): Workspace {
  return {
    app: APP_NAME,
    version: WORKSPACE_VERSION,
    name: 'Untitled workspace',
    samples: [],
    groups: [],
    compensations: [],
    scales: {},
    channelLabels: {},
    populations: [],
    worksheets: [newWorksheet('Sheet 1')],
    tables: [],
    style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 8, lineWidth: 1, plotW: 60, plotH: 54 },
  };
}

export function newWorksheet(name: string): Worksheet {
  return { id: uid('ws'), name, page: { ...PAGE_SIZES['A4 landscape'], name: 'A4 landscape' }, grid: Math.round(5 * MM * 100) / 100, snap: true, showGrid: true, gridStyle: 'lines', items: [] };
}

export function popById(ws: Workspace, id: string): Population | undefined {
  return ws.populations.find((p) => p.id === id);
}

export function popPath(ws: Workspace, id: string): string {
  if (id === 'root') return 'All Events';
  const names: string[] = [];
  const seen = new Set<string>();
  let p = popById(ws, id);
  // `seen`: a damaged workspace may have a parent cycle
  while (p && !seen.has(p.id)) {
    seen.add(p.id);
    names.unshift(p.name);
    p = p.parentId ? popById(ws, p.parentId) : undefined;
  }
  return names.join(' / ');
}

export function popChildren(ws: Workspace, parent: string | null): Population[] {
  return ws.populations.filter((p) => (p.parentId ?? null) === parent);
}

/** All populations below `id` (children first, depth first). Iterative, and safe with parent cycles. */
export function popDescendants(ws: Workspace, id: string): string[] {
  const kids = new Map<string, string[]>();
  for (const c of ws.populations)
    if (c.parentId) {
      const l = kids.get(c.parentId);
      if (l) l.push(c.id);
      else kids.set(c.parentId, [c.id]);
    }
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const stack: { list: string[]; i: number }[] = [{ list: kids.get(id) ?? [], i: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i >= top.list.length) {
      stack.pop();
      continue;
    }
    const c = top.list[top.i++];
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    const k = kids.get(c);
    if (k) stack.push({ list: k, i: 0 });
  }
  return out;
}

/** Ancestors of a population, nearest first (safe with parent cycles). */
export function popAncestors(ws: Workspace, id: string): Population[] {
  const out: Population[] = [];
  const seen = new Set<string>([id]);
  let p = popById(ws, id);
  while (p?.parentId && !seen.has(p.parentId)) {
    seen.add(p.parentId);
    const par = popById(ws, p.parentId);
    if (!par) break;
    out.push(par);
    p = par;
  }
  return out;
}

export function gateParams(g: GateGeom): string[] {
  switch (g.type) {
    case 'range':
    case 'split':
      return [g.x];
    case 'bool':
      return [];
    default:
      return [g.x, g.y];
  }
}

const isName = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const isFin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** A gate bound: a number, open (+-Infinity) allowed, NaN not. */
const isBound = (v: unknown) => typeof v === 'number' && !Number.isNaN(v);
const isPt = (p: unknown) => Array.isArray(p) && p.length >= 2 && isFin(p[0]) && isFin(p[1]);

/**
 * What is wrong with a gate geometry from outside (a file, the clipboard), or null when it can be evaluated: a known
 * type, named channels, finite coordinates (bounds may be open), the fields its type needs. Optional fields (comp,
 * scales, strict) are checked where they are repaired (core/repair.ts).
 */
export function gateProblem(g: unknown): string | null {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return 'no gate geometry';
  const o = g as Record<string, unknown>;
  const twoD = () => (isName(o.x) && isName(o.y) ? null : 'a dimension has no channel name');
  switch (o.type) {
    case 'polygon': {
      if (twoD()) return twoD();
      if (!Array.isArray(o.points)) return 'the polygon has no vertices';
      if (o.points.length < 3) return `a polygon needs at least 3 vertices (it has ${o.points.length})`;
      return o.points.every(isPt) ? null : 'a vertex coordinate is not a number';
    }
    case 'rect':
      if (twoD()) return twoD();
      return [o.xmin, o.xmax, o.ymin, o.ymax].every(isBound) ? null : 'a bound is not a number';
    case 'range':
      if (!isName(o.x)) return 'the gate has no channel name';
      return isBound(o.min) && isBound(o.max) ? null : 'a bound is not a number';
    case 'ellipse':
      if (twoD()) return twoD();
      return isPt(o.center) && isPt(o.a) && isPt(o.b) ? null : 'the ellipse center or axes are not numbers';
    case 'quadrant':
      if (twoD()) return twoD();
      if (!isFin(o.cx) || !isFin(o.cy)) return 'a divider value is not a number';
      if (!['UR', 'UL', 'LL', 'LR'].includes(o.quadrant as string)) return 'unknown quadrant';
      return isName(o.groupId) ? null : 'the quadrant has no group';
    case 'split':
      if (!isName(o.x)) return 'the gate has no channel name';
      if (!isFin(o.cut)) return 'the split value is not a number';
      if (o.side !== 'lo' && o.side !== 'hi') return 'unknown split side';
      return isName(o.groupId) ? null : 'the split has no group';
    case 'bool':
      if (!['and', 'or', 'not'].includes(o.op as string)) return 'unknown Boolean operator';
      return Array.isArray(o.operands) && o.operands.every(isName) ? null : 'invalid Boolean operands';
    default:
      return `unknown gate type "${String(o.type).slice(0, 20)}"`;
  }
}

/** Letters and digits only, lower case: "FITC-A (MESF)" and "FITC-A MESF" compare equal. */
function normName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Label of a derived output as shown in channel names. Older size calibrations stored "Diameter (nm), <particle model>";
 * the model belongs in the report, not in every axis title and table header.
 */
function shortDerivedLabel(label: string): string {
  const m = /^(Diameter \(nm\)|Scattering cross section \(nm²\)),\s.+$/.exec(label);
  return m ? m[1] : label;
}

/**
 * Unit of a computed channel: as stored with its output, else (older workspaces) nm / nm² for the outputs of a size
 * calibration. None when the label already names it ("Diameter (nm)").
 */
function derivedUnit(ws: Workspace, ch: string, label: string): string | undefined {
  for (const d of ws.derived ?? []) {
    const k = d.outputs.findIndex((o) => o.name === ch);
    if (k < 0) continue;
    const u = d.outputs[k].unit ?? (d.kind === 'size' ? (k === 0 ? 'nm' : 'nm²') : undefined);
    if (!u || label.includes(`(${u})`) || ch.includes(`(${u})`)) return undefined;
    return u;
  }
  return undefined;
}

export function channelDisplayName(ws: Workspace, ch: string, mode: 'short' | 'label' | 'both' = 'both'): string {
  const derivedLabel = ws.derived?.flatMap((d) => d.outputs).find((o) => o.name === ch)?.label;
  const label =
    ws.channelLabels[ch] ??
    ws.samples.map((s) => s.channels.find((c) => c.name === ch)?.label).find((l) => !!l) ??
    (derivedLabel ? shortDerivedLabel(derivedLabel) : undefined) ??
    '';
  const unit = ws.samples.map((s) => s.channels.find((c) => c.name === ch)?.unit).find((u) => !!u) ?? derivedUnit(ws, ch, label);
  const nm = unit ? `${ch} (${unit})` : ch;
  if (mode === 'short' || !label) return nm;
  if (mode === 'label') return label;
  // do not repeat a label that the name already says (or the other way round)
  const nl = normName(label);
  const nc = normName(ch);
  if (!nl || nc.includes(nl)) return nm;
  if (nl.includes(nc)) return label;
  return `${label} (${nm})`;
}

export function allChannels(ws: Workspace): SampleChannel[] {
  const seen = new Map<string, SampleChannel>();
  for (const s of ws.samples) for (const c of s.channels) if (!seen.has(c.name)) seen.set(c.name, c);
  for (const d of ws.derived ?? []) for (const o of d.outputs) if (!seen.has(o.name)) seen.set(o.name, { name: o.name, label: o.label ?? '', range: o.range });
  return [...seen.values()];
}

/** Whether a channel is computed (derived) rather than measured. */
export function isDerivedChannel(ws: Workspace, ch: string): boolean {
  return !!ws.derived?.some((d) => d.outputs.some((o) => o.name === ch));
}

/** Whether `ancestorId` ('root' = All Events) is an ancestor of population `popId` (a population is not its own ancestor). */
export function isAncestorPop(ws: Workspace, ancestorId: string, popId: string): boolean {
  if (!ancestorId || ancestorId === 'root') return true;
  if (!popId || popId === 'root') return false;
  const seen = new Set<string>();
  let p = popById(ws, popId);
  while (p && p.parentId && !seen.has(p.id)) {
    seen.add(p.id);
    if (p.parentId === ancestorId) return true;
    p = popById(ws, p.parentId);
  }
  return false;
}

/**
 * Whether a sample has a channel: measured in its file, or the output of a derived definition that applies to the sample
 * and whose inputs the sample has (chained definitions, e.g. MESF of an unmixed channel, are followed).
 */
export function sampleHasChannel(ws: Workspace, sampleId: string, ch: string, depth = 0): boolean {
  const s = ws.samples.find((x) => x.id === sampleId);
  if (!s) return false;
  if (s.channels.some((c) => c.name === ch)) return true;
  if (depth > 8) return false;
  const def = ws.derived?.find((d) => d.outputs.some((o) => o.name === ch));
  if (!def || (def.samples && !def.samples.includes(sampleId))) return false;
  if (def.kind === 'unmix') {
    const have = new Set(s.channels.map((c) => c.name.toLowerCase()));
    return def.unmix.detectors.every((d) => have.has(d.toLowerCase()));
  }
  return sampleHasChannel(ws, sampleId, def.channel, depth + 1);
}

/**
 * Why a channel has no values in a sample (for plots and tables), e.g. "FITC-A not measured in this sample" or
 * "VSSC1-A diameter (nm) is not available (calibration/unmixing removed)". Kept short so it fits a plot frame.
 */
export function missingChannelReason(ws: Workspace, ch: string, sampleId?: string): string {
  const def = ws.derived?.find((d) => d.outputs.some((o) => o.name === ch));
  if (def) {
    if (sampleId && def.samples && !def.samples.includes(sampleId)) return `${ch} is not computed for this sample`;
    const inputs = def.kind === 'unmix' ? def.unmix.detectors : [def.channel];
    const lacking = sampleId ? inputs.filter((i) => !sampleHasChannel(ws, sampleId, i)) : [];
    if (lacking.length) return `${ch} needs ${lacking.length > 2 ? `${lacking.slice(0, 2).join(', ')} and ${lacking.length - 2} more` : lacking.join(', ')}, missing here`;
    return `${ch} could not be computed for this sample`;
  }
  if (!ws.samples.some((s) => s.channels.some((c) => c.name === ch))) return `${ch} is not available (calibration/unmixing removed)`;
  return `${ch} not measured in this sample`;
}
