// Validation and repair of workspace data that comes from outside the running app: workspace files, bundles, templates,
// the autosaved session and the clipboard. A damaged entry (wrong type, missing field, NaN, a reference to something
// that is not there, a parent cycle) is repaired where the intent is clear, else removed; the notes say what was done.
// A valid workspace passes unchanged (same objects, same key order), so saving and reopening stays lossless.
import {
  APP_NAME,
  clampItemGeometry,
  GATE_COLORS,
  gateProblem,
  MM,
  newWorksheet,
  STAT_LABELS,
  uid,
  WORKSPACE_VERSION,
  type Workspace,
} from './model';
import { defaultScaleFor, gateGridInterner, scaleDefProblem, type ScaleDef } from './transforms';
import { normWell } from './plate';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isName = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Check a population's provenance (core/model.ts PopProvenance; informational, shown with the gate): false when it
 * cannot be shown (not an object, or method / model / date / target not text), so it is removed. Damaged optional
 * fields are dropped.
 */
function fixProvenance(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (!isStr(v.method) || !isStr(v.model) || !isStr(v.date) || !isStr(v.target)) return false;
  if (v.rationale !== undefined && !isStr(v.rationale)) delete v.rationale;
  if (v.confidence !== undefined && !(isNum(v.confidence) && v.confidence >= 0 && v.confidence <= 1)) delete v.confidence;
  if (v.alpha !== undefined && !isNum(v.alpha)) delete v.alpha;
  if (v.edited !== undefined && typeof v.edited !== 'boolean') delete v.edited;
  if (v.seed !== undefined && !(Array.isArray(v.seed) && v.seed.length <= 16 && v.seed.every(isNum))) delete v.seed;
  return true;
}
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A workspace that cannot be opened at all (the message says why, for the user). */
export class WorkspaceFileError extends Error {}

/** Notes on what a repair changed, counted per kind (shown as a short list). */
export class RepairNotes {
  private counts = new Map<string, { n: number; text: (n: number) => string }>();
  add(key: string, text: (n: number) => string, n = 1) {
    const e = this.counts.get(key);
    if (e) e.n += n;
    else this.counts.set(key, { n, text });
  }
  get size(): number {
    return this.counts.size;
  }
  list(): string[] {
    return [...this.counts.values()].map((e) => e.text(e.n));
  }
}

/** Ids a worksheet item may refer to (the workspace it is put into). */
export interface RefContext {
  pops: Set<string>;
  samples: Set<string>;
  groups: Set<string>;
  /** a channel for plots without one */
  channel: string;
}

export function refContextOf(ws: Pick<Workspace, 'populations' | 'samples' | 'groups'>): RefContext {
  return {
    pops: new Set(ws.populations.map((p) => p.id)),
    samples: new Set(ws.samples.map((s) => s.id)),
    groups: new Set(ws.groups.map((g) => g.id)),
    channel: ws.samples.find((s) => s.channels.length)?.channels[0]?.name ?? 'FSC-A',
  };
}

// ------------------------------------------------------------------ field helpers (assign only when invalid)

function fixNum(o: Obj, k: string, lo: number, hi: number, dflt: number, opts: { int?: boolean; optional?: boolean } = {}): boolean {
  const v = o[k];
  if (v === undefined && opts.optional) return false;
  if (!isNum(v)) {
    if (opts.optional) delete o[k];
    else o[k] = dflt;
    return true;
  }
  let n = Math.min(hi, Math.max(lo, v));
  if (opts.int) n = Math.round(n);
  if (n === v) return false;
  o[k] = n;
  return true;
}

function fixBool(o: Obj, k: string, dflt: boolean | undefined): boolean {
  const v = o[k];
  if (isBool(v)) return false;
  if (v === undefined && dflt === undefined) return false;
  if (dflt === undefined) delete o[k];
  else o[k] = dflt;
  return true;
}

function fixStr(o: Obj, k: string, dflt: string | undefined): boolean {
  const v = o[k];
  if (isStr(v)) return false;
  if (v === undefined && dflt === undefined) return false;
  if (dflt === undefined) delete o[k];
  else o[k] = dflt;
  return true;
}

function fixEnum(o: Obj, k: string, allowed: readonly string[], dflt: string | undefined): boolean {
  const v = o[k];
  if (isStr(v) && allowed.includes(v)) return false;
  if (v === undefined && dflt === undefined) return false;
  if (dflt === undefined) delete o[k];
  else o[k] = dflt;
  return true;
}

function fixPair(o: Obj, k: string, lo = -Infinity, hi = Infinity, increasing = false): boolean {
  const v = o[k];
  if (v === undefined) return false;
  const ok = Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[0] >= lo && v[1] <= hi && v[0] >= lo && v[1] >= lo && v[0] <= hi && (!increasing || v[1] > v[0]);
  if (ok) return false;
  delete o[k];
  return true;
}

function fixScale(o: Obj, k: string): boolean {
  const v = o[k];
  if (v === undefined || scaleDefProblem(v) === null) return false;
  if (isObj(v) && v.flowjo !== undefined) {
    // a damaged FlowJo biex table: the closest logicle is still there
    const copy = { ...v };
    delete copy.flowjo;
    if (scaleDefProblem(copy) === null) {
      delete v.flowjo;
      return true;
    }
  }
  delete o[k];
  return true;
}

/** A list of strings (kept: those passing `keep`); returns true if it changed. */
function fixIdList(o: Obj, k: string, keep: (s: string) => boolean, optional = true): boolean {
  const v = o[k];
  if (v === undefined && optional) return false;
  if (!Array.isArray(v)) {
    if (optional) delete o[k];
    else o[k] = [];
    return true;
  }
  const seen = new Set<string>();
  const out = v.filter((x): x is string => isStr(x) && keep(x) && !seen.has(x) && !!seen.add(x));
  if (out.length === v.length) return false;
  o[k] = out;
  return true;
}

// ------------------------------------------------------------------ statistics

const STATS = Object.keys(STAT_LABELS);

/**
 * A statistic (table column, stats box row, chart): repaired in place, or null when it cannot be used (not an object,
 * unknown statistic, or its population is missing and `dropMissingPop`).
 */
function fixStatColumn(c: unknown, ctx: RefContext, notes: RepairNotes, dropMissingPop: boolean): Obj | null {
  if (!isObj(c)) return null;
  if (!isStr(c.stat) || !STATS.includes(c.stat)) return null;
  if (!isName(c.id)) c.id = uid('col');
  const popOk = (id: unknown) => id === 'root' || (isStr(id) && ctx.pops.has(id));
  if (!popOk(c.population)) {
    if (dropMissingPop) return null;
    c.population = 'root';
    notes.add('ref', (n) => `${n} ${plural(n, 'reference', 'references')} to missing gates or samples ${plural(n, 'was', 'were')} reset (to All Events or the active sample)`);
  }
  if (c.ofPopulation !== undefined && !popOk(c.ofPopulation)) delete c.ofPopulation;
  fixStr(c, 'channel', undefined);
  fixStr(c, 'header', undefined);
  fixNum(c, 'percentile', 0, 100, 50, { optional: true });
  return c;
}

// ------------------------------------------------------------------ worksheet items

const PLOT_TYPES = ['dot', 'pseudo', 'density', 'contour', 'zebra', 'histogram'] as const;
const BGS = ['white', 'transparent', 'dark', 'black', 'custom'] as const;

/** Required plot options (missing: the values of plots made before the field existed). */
const PLOT_REQUIRED: Record<string, unknown> = {
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
  histSmooth: 0,
  histFill: true,
  histOffset: 0,
  histLineWidth: 1,
  contourLevels: 10,
  contourOutliers: true,
  fontSize: 10,
  lineWidth: 1,
  legend: true,
  frame: true,
};

function fixPlotOptions(o: Obj): boolean {
  let ch = false;
  const R = PLOT_REQUIRED;
  for (const k of ['showTitle', 'showGates', 'histFill', 'contourOutliers', 'legend', 'frame']) ch = fixBool(o, k, R[k] as boolean) || ch;
  ch = fixEnum(o, 'gateLabel', ['none', 'name', 'percent', 'name+percent', 'name+count'], R.gateLabel as string) || ch;
  ch = fixEnum(o, 'colorMode', ['single', 'density', 'population', 'param'], R.colorMode as string) || ch;
  ch = fixEnum(o, 'histMode', ['count', 'normalized'], R.histMode as string) || ch;
  ch = fixStr(o, 'dotColor', R.dotColor as string) || ch;
  ch = fixStr(o, 'colormap', R.colormap as string) || ch;
  ch = fixNum(o, 'dotSize', 0.05, 50, 1) || ch;
  ch = fixNum(o, 'maxEvents', 0, 1e9, 0, { int: true }) || ch;
  ch = fixNum(o, 'bins', 2, 4096, 256, { int: true }) || ch;
  ch = fixNum(o, 'histSmooth', 0, 100, 0) || ch;
  ch = fixNum(o, 'histOffset', 0, 1, 0) || ch;
  ch = fixNum(o, 'histLineWidth', 0, 50, 1) || ch;
  ch = fixNum(o, 'contourLevels', 1, 100, 10, { int: true }) || ch;
  ch = fixNum(o, 'fontSize', 1, 200, 10) || ch;
  ch = fixNum(o, 'lineWidth', 0, 50, 1) || ch;
  // optional fields: invalid ones are removed (missing reproduces the look of older plots)
  for (const k of ['title', 'xLabel', 'yLabel', 'dotColor', 'bgColor', 'colorParam', 'contourLineColor', 'histFillColor', 'gateColor']) ch = fixStr(o, k, undefined) || ch;
  for (const k of ['cmapReverse', 'contourFill', 'histHideY', 'boldLabels']) ch = fixBool(o, k, undefined) || ch;
  for (const k of ['xScale', 'yScale', 'colorParamScale']) ch = fixScale(o, k) || ch;
  ch = fixEnum(o, 'legendStat', ['none', 'median', 'mean', 'geomean', 'count', 'freqParent'], undefined) || ch;
  ch = fixEnum(o, 'densityScale', ['linear', 'sqrt', 'log', 'rank'], undefined) || ch;
  ch = fixEnum(o, 'colorStat', ['median', 'mean'], undefined) || ch;
  ch = fixEnum(o, 'colorBar', ['none', 'right', 'top'], undefined) || ch;
  ch = fixEnum(o, 'dotShape', ['square', 'circle'], undefined) || ch;
  ch = fixEnum(o, 'drawOrder', ['file', 'random', 'density'], undefined) || ch;
  ch = fixEnum(o, 'bg', BGS, undefined) || ch;
  ch = fixEnum(o, 'contourMode', ['probability', 'log'], undefined) || ch;
  ch = fixEnum(o, 'contourLines', ['single', 'level', 'none'], undefined) || ch;
  ch = fixEnum(o, 'histFillStyle', ['solid', 'semi', 'outline', 'gradient'], undefined) || ch;
  ch = fixEnum(o, 'tickDir', ['out', 'in'], undefined) || ch;
  ch = fixEnum(o, 'legendPos', ['auto', 'inside', 'outside-right', 'below'], undefined) || ch;
  ch = fixNum(o, 'densityBins', 4, 2048, 128, { int: true, optional: true }) || ch;
  ch = fixNum(o, 'densitySmooth', 0, 50, 0, { optional: true }) || ch;
  ch = fixNum(o, 'dotOpacity', 0, 1, 1, { optional: true }) || ch;
  ch = fixNum(o, 'contourBandwidth', 0.01, 50, 1.25, { optional: true }) || ch;
  ch = fixPair(o, 'colorRange', 0, 100) || ch;
  ch = fixPair(o, 'xWin', -1e6, 1e6, true) || ch;
  ch = fixPair(o, 'yWin', -1e6, 1e6, true) || ch;
  if (o.cmapStops !== undefined && !(Array.isArray(o.cmapStops) && o.cmapStops.every(isStr))) {
    delete o.cmapStops;
    ch = true;
  }
  for (const k of ['labelPos', 'labelOff']) {
    const m = o[k];
    if (m === undefined) continue;
    if (!isObj(m)) {
      delete o[k];
      ch = true;
      continue;
    }
    for (const [pk, v] of Object.entries(m))
      if (!(Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]))) {
        delete m[pk];
        ch = true;
      }
  }
  return ch;
}

/**
 * Repair one worksheet item in place against the workspace it belongs to (or is pasted into); null when it cannot be
 * used (not an object, unknown kind). References to populations / samples / groups that `ctx` does not have are reset
 * (layers: All Events, the active sample) or removed (statistic rows). `ids`: item ids taken so far (duplicates get a
 * new one).
 */
export function repairItem(raw: unknown, ctx: RefContext, notes: RepairNotes, ids?: Set<string>): Obj | null {
  if (!isObj(raw) || !['plot', 'text', 'stats', 'chart'].includes(raw.kind as string)) {
    notes.add('item-removed', (n) => `${n} damaged worksheet ${plural(n, 'item was', 'items were')} removed`);
    return null;
  }
  const it = raw;
  const kind = it.kind as string;
  let fixed = false;
  const ref = () => notes.add('ref', (n) => `${n} ${plural(n, 'reference', 'references')} to missing gates or samples ${plural(n, 'was', 'were')} reset (to All Events or the active sample)`);
  if (!isName(it.id) || ids?.has(it.id)) {
    it.id = uid(kind);
    if (ids) notes.add('dup-item', (n) => `${n} duplicate item ${plural(n, 'id was', 'ids were')} replaced`);
  }
  ids?.add(it.id as string);
  if (clampItemGeometry(it as never)) fixed = true;
  const sampleOk = (s: unknown) => s === 'active' || (isStr(s) && ctx.samples.has(s));
  const popOk = (p: unknown) => p === 'root' || (isStr(p) && ctx.pops.has(p));
  if (kind === 'plot') {
    fixed = fixEnum(it, 'plotType', PLOT_TYPES, 'pseudo') || fixed;
    if (!isName(it.xParam)) {
      it.xParam = isName(it.yParam) ? it.yParam : ctx.channel;
      fixed = true;
    }
    if (!isName(it.yParam)) {
      it.yParam = it.xParam;
      fixed = true;
    }
    if (!Array.isArray(it.layers)) {
      it.layers = [];
      fixed = true;
    }
    const layers = it.layers as unknown[];
    const kept: Obj[] = [];
    for (const l of layers) {
      if (!isObj(l)) {
        fixed = true;
        continue;
      }
      if (!isName(l.id)) l.id = uid('ly');
      if (!sampleOk(l.sample)) {
        l.sample = 'active';
        ref();
      }
      if (!popOk(l.population)) {
        l.population = 'root';
        ref();
      }
      fixStr(l, 'color', undefined);
      fixStr(l, 'label', undefined);
      fixBool(l, 'visible', undefined);
      kept.push(l);
    }
    if (kept.length !== layers.length) it.layers = kept;
    if (!kept.length) {
      it.layers = [{ id: uid('ly'), sample: 'active', population: 'root' }];
      fixed = true;
    }
    if (it.keepGates !== undefined && !(Array.isArray(it.keepGates) && it.keepGates.every(isStr))) {
      delete it.keepGates;
      fixed = true;
    }
    if (!isObj(it.options)) {
      it.options = { ...PLOT_REQUIRED };
      fixed = true;
    } else fixed = fixPlotOptions(it.options) || fixed;
  } else if (kind === 'text') {
    fixed = fixStr(it, 'text', '') || fixed;
    fixed = fixNum(it, 'fontSize', 1, 400, 10) || fixed;
    fixed = fixBool(it, 'bold', false) || fixed;
    fixed = fixBool(it, 'italic', false) || fixed;
    fixed = fixEnum(it, 'align', ['left', 'center', 'right'], 'left') || fixed;
    fixed = fixStr(it, 'color', '#000000') || fixed;
    fixed = fixBool(it, 'hFixed', undefined) || fixed;
    // a repeat header of a sample (optional): dropped when damaged or its sample is gone (the text stays as it is)
    if (it.sampleHeader !== undefined) {
      const h = it.sampleHeader as Obj;
      if (!isObj(h) || typeof h.sample !== 'string' || typeof h.auto !== 'string' || !sampleOk(h.sample) || h.sample === 'active') {
        delete it.sampleHeader;
        fixed = true;
      }
    }
  } else if (kind === 'stats') {
    if (!sampleOk(it.sample)) {
      if (it.sample !== undefined) ref();
      it.sample = 'active';
    }
    if (!Array.isArray(it.rows)) {
      it.rows = [];
      fixed = true;
    }
    const rows = it.rows as unknown[];
    const kept = rows.map((r) => fixStatColumn(r, ctx, notes, true)).filter((r): r is Obj => !!r);
    if (kept.length !== rows.length) {
      it.rows = kept;
      notes.add('stat-removed', (n) => `${n} ${plural(n, 'statistic', 'statistics')} of missing gates ${plural(n, 'was', 'were')} removed`, rows.length - kept.length);
    }
    fixed = fixNum(it, 'fontSize', 1, 200, 8) || fixed;
    fixed = fixEnum(it, 'bg', BGS, undefined) || fixed;
    fixed = fixStr(it, 'bgColor', undefined) || fixed;
  } else {
    const stat = fixStatColumn(it.stat, ctx, notes, false);
    if (!stat) {
      it.stat = { id: uid('col'), population: 'root', stat: 'count' };
      fixed = true;
    }
    fixed = fixEnum(it, 'mode', ['samples', 'groups'], 'samples') || fixed;
    if (!isName(it.sampleSet)) {
      if (it.sampleSet !== undefined) fixed = true;
      it.sampleSet = 'all';
    }
    // fixed sample / group lists may name samples removed since (the chart skips them): only their form is checked
    if (fixIdList(it, 'samples', () => true)) fixed = true;
    if (fixIdList(it, 'groups', () => true)) fixed = true;
    fixed = fixEnum(it, 'style', ['bar', 'dot'], 'bar') || fixed;
    fixed = fixEnum(it, 'errorBars', ['sd', 'sem', 'none'], 'sd') || fixed;
    fixed = fixBool(it, 'showPoints', true) || fixed;
    fixed = fixStr(it, 'color', '#5b8fd1') || fixed;
    fixed = fixBool(it, 'useGroupColors', true) || fixed;
    fixed = fixStr(it, 'title', undefined) || fixed;
    fixed = fixStr(it, 'yLabel', undefined) || fixed;
    fixed = fixNum(it, 'fontSize', 1, 200, 8) || fixed;
    fixed = fixNum(it, 'lineWidth', 0, 50, 1) || fixed;
    if (it.yMax !== undefined && !(isNum(it.yMax) && it.yMax > 0)) {
      delete it.yMax;
      fixed = true;
    }
    fixed = fixEnum(it, 'bg', BGS, undefined) || fixed;
    fixed = fixStr(it, 'bgColor', undefined) || fixed;
    // a plate heatmap (optional): its plate name and look; damaged beyond use, the item is a statistic chart again
    if (it.plate !== undefined) {
      const pl = it.plate;
      if (!isObj(pl) || !isStr(pl.plate)) {
        delete it.plate;
        fixed = true;
      } else fixed = fixPlateLook(pl) || fixed;
    }
  }
  if (fixed) notes.add('item-fixed', (n) => `${n} worksheet ${plural(n, 'item had', 'items had')} missing or invalid settings (reset to defaults)`);
  return it;
}

/**
 * Look of a plate heatmap (chart item `plate`, required fields; Workspace.plateView with `optional`): colormap, range,
 * reverse, values, decimals, legend.
 */
function fixPlateLook(o: Obj, optional = false): boolean {
  let ch = false;
  ch = fixStr(o, 'colormap', 'viridis') || ch;
  ch = fixBool(o, 'reverse', undefined) || ch;
  ch = fixPair(o, 'range', -1e300, 1e300, true) || ch;
  ch = fixBool(o, 'shared', undefined) || ch;
  ch = fixNum(o, 'decimals', 0, 6, 1, { int: true, optional }) || ch;
  ch = fixBool(o, 'values', optional ? undefined : true) || ch;
  if (!optional) ch = fixBool(o, 'legend', true) || ch;
  return ch;
}

// ------------------------------------------------------------------ gates

/**
 * Repair the optional fields of a gate geometry (in place). A matrix id that is not in the workspace is kept: the engine
 * evaluates such a gate uncompensated, as it did before the file was saved.
 */
function fixGateExtras(g: Obj): boolean {
  let ch = false;
  if (g.comp !== undefined && !isName(g.comp)) {
    delete g.comp;
    ch = true;
  }
  if (g.scales !== undefined) {
    if (!isObj(g.scales)) {
      delete g.scales;
      ch = true;
    } else {
      ch = fixScale(g.scales, 'x') || ch;
      ch = fixScale(g.scales, 'y') || ch;
    }
  }
  ch = fixBool(g, 'strict', undefined) || ch;
  return ch;
}

// ------------------------------------------------------------------ the workspace

/**
 * Validate and repair a parsed workspace object in place. Returns the workspace and notes on what was repaired; throws
 * WorkspaceFileError when it cannot be used at all.
 */
export function repairWorkspace(obj: unknown): { ws: Workspace; notes: string[] } {
  if (!isObj(obj)) throw new WorkspaceFileError(`Not a ${APP_NAME} workspace file (no workspace data in it).`);
  if (!Array.isArray(obj.samples)) throw new WorkspaceFileError(`Not a ${APP_NAME} workspace file (it has no list of samples).`);
  const w = obj;
  const notes = new RepairNotes();
  const other = () => notes.add('other', (n) => `${n} other damaged ${plural(n, 'value was', 'values were')} reset to defaults`);
  if (!isStr(w.name)) {
    w.name = 'Untitled workspace';
    other();
  }
  if (!isStr(w.app)) w.app = APP_NAME;
  if (!isNum(w.version)) w.version = WORKSPACE_VERSION;
  for (const k of ['groups', 'compensations', 'populations', 'worksheets', 'tables'])
    if (!Array.isArray(w[k])) {
      if (w[k] !== undefined) notes.add('list-' + k, () => `The ${k} of the workspace were damaged and could not be read`);
      w[k] = [];
    }
  if (w.derived !== undefined && !Array.isArray(w.derived)) {
    notes.add('list-derived', () => 'The computed channels (unmixing, calibration) of the workspace were damaged and could not be read');
    delete w.derived;
  }
  for (const k of ['scales', 'channelLabels'])
    if (!isObj(w[k])) {
      if (w[k] !== undefined) other();
      w[k] = {};
    }

  // ---- compensations
  const compIds = new Set<string>();
  {
    const list = w.compensations as unknown[];
    const kept = list.filter((c) => {
      if (!isObj(c) || !isName(c.id) || compIds.has(c.id)) return false;
      const n = Array.isArray(c.channels) ? c.channels.length : -1;
      const ok =
        n > 0 &&
        (c.channels as unknown[]).every(isName) &&
        Array.isArray(c.matrix) &&
        c.matrix.length === n &&
        (c.matrix as unknown[]).every((r) => Array.isArray(r) && r.length === n && r.every(isNum));
      if (!ok) return false;
      if (!isStr(c.name)) c.name = c.id;
      fixEnum(c, 'source', ['file', 'manual', 'computed', 'gatingml', 'imported'], 'manual');
      compIds.add(c.id);
      return true;
    });
    if (kept.length !== list.length) {
      notes.add('comp', (n) => `${n} damaged compensation ${plural(n, 'matrix was', 'matrices were')} removed; samples and gates using ${plural(n, 'it', 'them')} are now uncompensated`, list.length - kept.length);
      w.compensations = kept;
    }
  }

  // ---- samples
  const sampleIds = new Set<string>();
  {
    const list = w.samples as unknown[];
    let channelFixes = 0;
    let plateFixes = 0;
    const kept = list.filter((s, i) => {
      if (!isObj(s)) return false;
      if (!isName(s.id) || sampleIds.has(s.id)) {
        if (isName(s.id)) return false; // a duplicate: its file and gates belong to the first one
        if (!isName(s.fileName) && !isName(s.name)) return false;
        s.id = uid('smp');
      }
      sampleIds.add(s.id as string);
      if (!isStr(s.name)) s.name = isStr(s.fileName) ? s.fileName.replace(/\.(fcs|lmd)$/i, '') : `Sample ${i + 1}`;
      if (!isStr(s.fileName)) s.fileName = `${s.name}.fcs`;
      fixNum(s, 'fileSize', 0, Number.MAX_SAFE_INTEGER, 0);
      fixNum(s, 'eventCount', 0, Number.MAX_SAFE_INTEGER, 0, { int: true });
      if (!Array.isArray(s.channels)) {
        s.channels = [];
        channelFixes++;
      }
      const chans = s.channels as unknown[];
      const names = new Set<string>();
      const okChans = chans.filter((c) => {
        if (!isObj(c) || !isName(c.name) || names.has(c.name)) return false;
        names.add(c.name);
        if (!isStr(c.label)) c.label = '';
        if (!isNum(c.range) || c.range < 0) c.range = 0;
        fixStr(c, 'unit', undefined);
        return true;
      });
      if (okChans.length !== chans.length) {
        s.channels = okChans;
        channelFixes++;
      }
      if (s.compId === undefined) s.compId = null;
      if (s.compId !== null && !(isStr(s.compId) && compIds.has(s.compId))) s.compId = null;
      fixStr(s, 'color', undefined);
      if (s.instrument !== undefined && !isStr(s.instrument)) delete s.instrument;
      if (s.info !== undefined) {
        if (!isObj(s.info)) delete s.info;
        else for (const [k, v] of Object.entries(s.info)) if (!isStr(v)) delete s.info[k];
      }
      // plate and well (optional): a well that is no well, a plate that is no text, an unknown source are dropped
      if (s.well !== undefined) {
        const w = normWell(s.well);
        if (!w) {
          delete s.well;
          plateFixes++;
        } else if (w !== s.well) s.well = w;
      }
      if (s.plate !== undefined && !isName(s.plate)) {
        delete s.plate;
        plateFixes++;
      }
      if (s.wellSource !== undefined && !['keyword', 'name', 'manual', 'none'].includes(s.wellSource as string)) {
        delete s.wellSource;
        plateFixes++;
      }
      // a well without its plate (or the other way round) is no placement: detected again when needed
      if ((s.well === undefined) !== (s.plate === undefined) && s.wellSource !== 'none') {
        delete s.well;
        delete s.plate;
        delete s.wellSource;
        plateFixes++;
      }
      return true;
    });
    if (kept.length !== list.length) {
      notes.add('sample', (n) => `${n} damaged sample ${plural(n, 'entry was', 'entries were')} removed`, list.length - kept.length);
      w.samples = kept;
    }
    if (channelFixes) notes.add('channels', (n) => `The channel lists of ${n} ${plural(n, 'sample were', 'samples were')} damaged and repaired`, channelFixes);
    if (plateFixes) notes.add('sample-well', (n) => `${n} damaged plate / well ${plural(n, 'entry', 'entries')} of samples ${plural(n, 'was', 'were')} removed (wells are detected again)`, plateFixes);
  }

  // ---- plates (formats and layouts)
  if (w.plates !== undefined) {
    if (!Array.isArray(w.plates)) {
      delete w.plates;
      notes.add('plates', () => 'The plate layouts of the workspace were damaged and could not be read');
    } else {
      const names = new Set<string>();
      let bad = 0;
      let fixedAnn = 0;
      const kept = (w.plates as unknown[]).filter((p) => {
        if (!isObj(p) || !isName(p.name) || names.has(p.name)) {
          bad++;
          return false;
        }
        names.add(p.name);
        if (fixNum(p, 'rows', 1, 16, 8, { int: true }) || fixNum(p, 'cols', 1, 24, 12, { int: true })) fixedAnn++;
        fixStr(p, 'key', undefined);
        if (p.annotations !== undefined) {
          if (!isObj(p.annotations)) {
            delete p.annotations;
            fixedAnn++;
          } else {
            const ann = p.annotations;
            for (const [well, a] of Object.entries(ann)) {
              const nw = normWell(well);
              if (!nw || !isObj(a)) {
                delete ann[well];
                fixedAnn++;
                continue;
              }
              for (const [k, v] of Object.entries(a))
                if (!isName(k) || !isStr(v)) {
                  delete a[k];
                  fixedAnn++;
                }
              if (nw !== well) {
                ann[nw] = { ...(isObj(ann[nw]) ? (ann[nw] as Obj) : {}), ...a };
                delete ann[well];
              }
              if (!Object.keys(ann[nw] ?? {}).length) delete ann[nw];
            }
          }
        }
        return true;
      });
      if (bad) notes.add('plates-bad', (n) => `${n} damaged ${plural(n, 'plate was', 'plates were')} removed`, bad);
      if (fixedAnn) notes.add('plates-fix', (n) => `${n} damaged plate ${plural(n, 'setting or annotation was', 'settings or annotations were')} repaired`, fixedAnn);
      if (kept.length !== (w.plates as unknown[]).length) w.plates = kept;
    }
  }

  // ---- groups
  const groupIds = new Set<string>();
  {
    const list = w.groups as unknown[];
    const kept = list.filter((g) => {
      if (!isObj(g) || !isName(g.id) || groupIds.has(g.id)) return false;
      groupIds.add(g.id);
      if (!isStr(g.name)) g.name = 'Group';
      fixIdList(g, 'sampleIds', () => true, false);
      fixStr(g, 'color', undefined);
      return true;
    });
    if (kept.length !== list.length) {
      notes.add('group', (n) => `${n} damaged ${plural(n, 'group was', 'groups were')} removed`, list.length - kept.length);
      w.groups = kept;
    }
  }

  // ---- channel names and their ranges (for axis defaults)
  const rangeOf = new Map<string, number>();
  for (const s of w.samples as Obj[]) for (const c of s.channels as Obj[]) if (!rangeOf.has(c.name as string) && (c.range as number) > 0) rangeOf.set(c.name as string, c.range as number);

  // ---- computed channels
  if (Array.isArray(w.derived)) {
    const list = w.derived as unknown[];
    const ids = new Set<string>();
    const kept = list.filter((d) => {
      if (!isObj(d) || !isName(d.id) || ids.has(d.id) || !['unmix', 'mesf', 'size'].includes(d.kind as string)) return false;
      if (!Array.isArray(d.outputs) || !d.outputs.length) return false;
      for (const o of d.outputs as unknown[]) {
        if (!isObj(o) || !isName(o.name)) return false;
        if (!(isNum(o.range) && o.range > 0)) o.range = 262144;
        fixStr(o, 'label', undefined);
        fixStr(o, 'unit', undefined);
      }
      if (d.kind === 'unmix') {
        const u = d.unmix;
        if (!isObj(u) || !Array.isArray(u.detectors) || !u.detectors.length || !u.detectors.every(isName)) return false;
        const D = u.detectors.length;
        const em = (e: unknown) => isObj(e) && isStr(e.name) && Array.isArray(e.signature) && e.signature.length === D && e.signature.every(isNum);
        if (!Array.isArray(u.endmembers) || !u.endmembers.length || !u.endmembers.every(em)) return false;
        if (u.af !== undefined && !(Array.isArray(u.af) && u.af.every(em))) delete u.af;
        if (!['ols', 'wls', 'nnls'].includes(u.method as string)) return false;
        fixBool(u, 'includeAF', false);
        if (u.noiseSD !== undefined && !(Array.isArray(u.noiseSD) && u.noiseSD.length === D && u.noiseSD.every(isNum))) delete u.noiseSD;
      } else {
        if (!isName(d.channel)) return false;
        if (d.kind === 'mesf') {
          const f = d.fit;
          if (!isObj(f) || !isNum(f.slope) || !isNum(f.intercept)) return false;
          if (!isStr(d.unit)) d.unit = 'MESF';
        } else {
          if (!(isNum(d.nm2PerAu) && d.nm2PerAu > 0) || !isObj(d.setup) || !isObj(d.model)) return false;
          const st = d.setup;
          if (!isNum(st.wavelengthNm) || !isNum(st.nMedium) || !isObj(st.geometry)) return false;
        }
      }
      if (!isStr(d.name)) d.name = d.id;
      fixIdList(d, 'samples', () => true);
      ids.add(d.id);
      return true;
    });
    if (kept.length !== list.length) {
      notes.add('derived', (n) => `${n} damaged computed channel ${plural(n, 'definition', 'definitions')} (unmixing / calibration) removed`, list.length - kept.length);
      w.derived = kept;
    }
  }

  // ---- axis scales and channel labels
  {
    const scales = w.scales as Obj;
    let reset = 0;
    for (const [ch, def] of Object.entries(scales)) {
      if (scaleDefProblem(def) === null) continue;
      const o = { def };
      fixScale(o, 'def');
      if (o.def !== undefined) scales[ch] = o.def;
      else scales[ch] = defaultScaleFor(ch, rangeOf.get(ch) ?? 262144);
      reset++;
    }
    if (reset) notes.add('scale', (n) => `The axis settings of ${n} ${plural(n, 'channel were', 'channels were')} damaged and reset`, reset);
    // per-instrument scales: a damaged entry is dropped (those samples use the workspace scale)
    if (w.instrumentScales !== undefined) {
      if (!isObj(w.instrumentScales)) {
        delete w.instrumentScales;
        other();
      } else {
        const inst = w.instrumentScales as Obj;
        for (const [k, m] of Object.entries(inst)) {
          if (!isObj(m)) {
            delete inst[k];
            other();
            continue;
          }
          for (const [ch, def] of Object.entries(m))
            if (scaleDefProblem(def) !== null) {
              delete m[ch];
              other();
            }
          if (!Object.keys(m).length) delete inst[k];
        }
        if (!Object.keys(inst).length) delete w.instrumentScales;
      }
    }
    const labels = w.channelLabels as Obj;
    for (const [k, v] of Object.entries(labels))
      if (!isStr(v)) {
        delete labels[k];
        other();
      }
  }

  // ---- populations
  {
    const list = w.populations as unknown[];
    const ids = new Set<string>();
    let bad = 0;
    // structure first: id, name, gate
    let pops = list.filter((p) => {
      if (!isObj(p) || !isName(p.id) || ids.has(p.id) || gateProblem(p.gate) !== null) {
        bad++;
        return false;
      }
      ids.add(p.id);
      return true;
    }) as Obj[];
    const dropped = new Set<string>(); // gates removed below (their subtrees go too)
    for (const p of pops) {
      if (!isStr(p.name)) p.name = p.id;
      if (p.parentId === undefined || p.parentId === '' || p.parentId === 'root') p.parentId = null;
      if (!isStr(p.color)) p.color = GATE_COLORS[0];
      fixGateExtras(p.gate as Obj);
      if (p.overrides !== undefined) {
        if (!isObj(p.overrides)) delete p.overrides;
        else
          for (const [sid, g] of Object.entries(p.overrides)) {
            // (variants of samples no longer in the workspace are harmless and kept)
            if (gateProblem(g) !== null) {
              delete p.overrides[sid];
              notes.add('override', (n) => `${n} damaged sample-specific gate ${plural(n, 'variant was', 'variants were')} removed`);
            } else fixGateExtras(g as Obj);
          }
      }
      if (p.scope !== undefined) {
        if (!isObj(p.scope)) delete p.scope;
        else {
          // (ids of removed groups / samples select nothing and are harmless: only the form is checked)
          fixIdList(p.scope, 'groups', () => true);
          fixIdList(p.scope, 'samples', () => true);
        }
      }
      if (p.provenance !== undefined && !fixProvenance(p.provenance)) {
        delete p.provenance;
        notes.add('provenance', (n) => `${n} damaged gate ${plural(n, 'origin note (AI assistant) was', 'origin notes (AI assistant) were')} removed`);
      }
    }
    // parents: missing parent -> the subtree goes (its gates were relative to it)
    const byId = new Map(pops.map((p) => [p.id as string, p]));
    for (const p of pops) if (p.parentId !== null && !(isStr(p.parentId) && byId.has(p.parentId))) dropped.add(p.id as string);
    // parent cycles: broken at the first member (in list order), which then applies to all events
    let cycles = 0;
    const state = new Map<string, 1 | 2>(); // 1 on the current path, 2 done
    for (const p of pops) {
      const path: Obj[] = [];
      let cur: Obj | undefined = p;
      while (cur && !state.has(cur.id as string)) {
        state.set(cur.id as string, 1);
        path.push(cur);
        cur = cur.parentId ? byId.get(cur.parentId as string) : undefined;
      }
      if (cur && state.get(cur.id as string) === 1) {
        const cyc = path.slice(path.indexOf(cur));
        const first = cyc.reduce((a, b) => (pops.indexOf(a) <= pops.indexOf(b) ? a : b));
        first.parentId = null;
        cycles++;
      }
      for (const q of path) state.set(q.id as string, 2);
    }
    if (cycles) notes.add('cycle', (n) => `${n} parent ${plural(n, 'cycle', 'cycles')} (gates inside each other) ${plural(n, 'was', 'were')} broken; the first gate of each now applies to all events`, cycles);
    // a Boolean gate that depends on itself (an operand inside it, or a chain of such): removed
    for (let again = true; again; ) {
      again = false;
      for (const p of pops) {
        const g = p.gate as Obj;
        if (g.type !== 'bool' || dropped.has(p.id as string)) continue;
        const seen = new Set<string>();
        const stack = (g.operands as string[]).map((o) => o.replace(/^!/, ''));
        let self = false;
        while (stack.length && !self) {
          const id = stack.pop()!;
          if (id === p.id) self = true;
          if (seen.has(id) || dropped.has(id)) continue;
          seen.add(id);
          const q = byId.get(id);
          if (!q) continue;
          if (q.parentId) stack.push(q.parentId as string);
          const qg = q.gate as Obj;
          if (qg.type === 'bool') for (const o of qg.operands as string[]) stack.push(o.replace(/^!/, ''));
        }
        if (self) {
          dropped.add(p.id as string);
          notes.add('bool-cycle', (n) => `${n} Boolean ${plural(n, 'gate', 'gates')} that depended on ${plural(n, 'itself', 'themselves')} (an operand inside the gate) ${plural(n, 'was', 'were')} removed`);
          again = true;
        }
      }
    }
    // Boolean operands: OR ignores missing ones; AND / NOT with a missing operand cannot be evaluated
    for (const p of pops) {
      const g = p.gate as Obj;
      if (g.type !== 'bool') continue;
      const ops = g.operands as string[];
      const ok = ops.filter((o) => o.replace(/^!/, '') !== p.id && byId.has(o.replace(/^!/, '')) && !dropped.has(o.replace(/^!/, '')));
      if (ok.length === ops.length) continue;
      if (g.op === 'or' && ok.length) g.operands = ok;
      else {
        dropped.add(p.id as string);
        notes.add('bool', (n) => `${n} Boolean ${plural(n, 'gate', 'gates')} that used missing gates ${plural(n, 'was', 'were')} removed`);
      }
    }
    // the subtrees of removed gates
    if (dropped.size) {
      const kids = new Map<string, string[]>();
      for (const p of pops)
        if (p.parentId) {
          const l = kids.get(p.parentId as string);
          if (l) l.push(p.id as string);
          else kids.set(p.parentId as string, [p.id as string]);
        }
      const stack = [...dropped];
      while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) if (!dropped.has(k)) dropped.add(k), stack.push(k);
      const before = pops.length;
      pops = pops.filter((p) => !dropped.has(p.id as string));
      notes.add('pop-orphan', (n) => `${n} ${plural(n, 'gate', 'gates')} whose parent or Boolean operands were missing or damaged ${plural(n, 'was', 'were')} removed`, before - pops.length);
      // Boolean gates of removed gates go too (repeat until stable)
      for (let grew = true; grew; ) {
        grew = false;
        const alive = new Set(pops.map((p) => p.id as string));
        const next = pops.filter((p) => {
          const g = p.gate as Obj;
          if (g.type !== 'bool') return true;
          const ops = (g.operands as string[]).filter((o) => alive.has(o.replace(/^!/, '')));
          if (ops.length === (g.operands as string[]).length) return true;
          if (g.op === 'or' && ops.length) {
            g.operands = ops;
            return true;
          }
          return false;
        });
        if (next.length !== pops.length) {
          grew = true;
          pops = next;
        }
      }
    }
    if (bad) notes.add('pop-bad', (n) => `${n} damaged ${plural(n, 'gate was', 'gates were')} removed`, bad);
    if (pops.length !== list.length) w.populations = pops;
  }

  const ctx = refContextOf(w as unknown as Workspace);

  // ---- tables
  {
    const list = w.tables as unknown[];
    const ids = new Set<string>();
    let cols = 0;
    const kept = list.filter((t) => {
      if (!isObj(t) || !isName(t.id) || ids.has(t.id)) return false;
      ids.add(t.id);
      if (!isStr(t.name)) t.name = 'Table';
      if (!Array.isArray(t.columns)) t.columns = [];
      const c0 = t.columns as unknown[];
      const c1 = c0.map((c) => fixStatColumn(c, ctx, notes, true)).filter((c): c is Obj => !!c);
      if (c1.length !== c0.length) {
        t.columns = c1;
        cols += c0.length - c1.length;
      }
      if (!isName(t.sampleSet)) t.sampleSet = 'all';
      if (t.hiddenSamples !== undefined && !(Array.isArray(t.hiddenSamples) && t.hiddenSamples.every(isStr))) delete t.hiddenSamples;
      return true;
    });
    if (cols) notes.add('stat-removed', (n) => `${n} ${plural(n, 'statistic', 'statistics')} of missing gates ${plural(n, 'was', 'were')} removed`, cols);
    if (kept.length !== list.length) {
      notes.add('table', (n) => `${n} damaged ${plural(n, 'table was', 'tables were')} removed`, list.length - kept.length);
      w.tables = kept;
    }
  }

  // ---- experiment setup (optional): damaged means "show every tool"
  if (w.setup !== undefined) {
    const su = w.setup as Record<string, unknown>;
    if (!isObj(su) || (su.kind !== 'conventional' && su.kind !== 'nanoscale') || typeof su.mesf !== 'boolean' || typeof su.size !== 'boolean') {
      delete w.setup;
      other();
    }
  }

  // ---- plate view settings (optional): a damaged statistic shows All Events, a damaged look the defaults
  if (w.plateView !== undefined) {
    const pv = w.plateView;
    if (!isObj(pv)) {
      delete w.plateView;
      other();
    } else {
      const stat = fixStatColumn(pv.stat, ctx, notes, false);
      if (!stat) {
        pv.stat = { id: uid('col'), population: 'root', stat: 'count' };
        other();
      }
      if (fixPlateLook(pv, true)) other();
      fixEnum(pv, 'arrange', ['row', 'column'], undefined);
      fixStr(pv, 'overlay', undefined);
      fixEnum(pv, 'colorBy', ['stat', 'overlay'], undefined);
    }
  }

  // ---- worksheets and their items
  {
    const list = w.worksheets as unknown[];
    const ids = new Set<string>();
    const itemIds = new Set<string>();
    const kept = list.filter((sh, i) => {
      if (!isObj(sh)) return false;
      if (!isName(sh.id) || ids.has(sh.id)) sh.id = uid('ws');
      ids.add(sh.id as string);
      if (!isStr(sh.name)) sh.name = `Sheet ${i + 1}`;
      const page = sh.page;
      if (!isObj(page)) sh.page = { ...newWorksheet('x').page };
      else {
        if (fixNum(page, 'w', 10 * MM, 20000 * MM, 297 * MM) || fixNum(page, 'h', 10 * MM, 20000 * MM, 210 * MM)) other();
        fixStr(page, 'name', 'custom');
      }
      if (fixNum(sh, 'grid', 0.5, 500, Math.round(5 * MM * 100) / 100)) other();
      fixBool(sh, 'snap', true);
      fixBool(sh, 'showGrid', undefined);
      fixEnum(sh, 'gridStyle', ['lines', 'dots', 'none'], undefined);
      fixStr(sh, 'gridColor', undefined);
      fixNum(sh, 'gridOpacity', 0, 1, 0.1, { optional: true });
      fixNum(sh, 'gridMajor', 0, 1000, 0, { int: true, optional: true });
      fixStr(sh, 'pageColor', undefined);
      fixBool(sh, 'exportPage', undefined);
      fixBool(sh, 'exportGrid', undefined);
      // the sheet's own figure font size (optional)
      fixNum(sh, 'fontSize', 1, 400, 8, { optional: true });
      if (!Array.isArray(sh.items)) {
        if (sh.items !== undefined) notes.add('item-removed', (n) => `${n} damaged worksheet ${plural(n, 'item was', 'items were')} removed`);
        sh.items = [];
      }
      const items = sh.items as unknown[];
      const ok = items.map((it) => repairItem(it, ctx, notes, itemIds)).filter((it): it is Obj => !!it);
      if (ok.length !== items.length) sh.items = ok;
      return true;
    });
    if (kept.length !== list.length) {
      notes.add('sheet', (n) => `${n} damaged ${plural(n, 'worksheet was', 'worksheets were')} removed`, list.length - kept.length);
      w.worksheets = kept;
    }
    if (!(w.worksheets as unknown[]).length) w.worksheets = [newWorksheet('Sheet 1')];
  }

  // ---- figure style
  {
    if (!isObj(w.style)) {
      if (w.style !== undefined) other();
      w.style = { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 8, lineWidth: 1, plotW: 60, plotH: 54 };
    }
    const st = w.style as Obj;
    fixStr(st, 'fontFamily', 'Arial, Helvetica, sans-serif');
    fixNum(st, 'fontSize', 1, 100, 8);
    fixNum(st, 'lineWidth', 0, 50, 1);
    fixNum(st, 'plotW', 1, 5000, 60, { optional: true });
    fixNum(st, 'plotH', 1, 5000, 54, { optional: true });
    fixStr(st, 'preset', undefined);
  }

  // ---- FlowJo's stored counts (optional, for the comparison table): entries of unknown samples or populations and
  // values that are not counts are dropped; nothing left, or damaged: the field goes (the comparison is not offered)
  if (w.flowjoCounts !== undefined) {
    const fj = w.flowjoCounts as Obj;
    const sids = new Set((w.samples as Obj[]).map((s) => s.id));
    const pids = new Set(['root', ...(w.populations as Obj[]).map((p) => p.id)]);
    if (!isObj(fj) || !isObj(fj.counts)) {
      delete w.flowjoCounts;
      other();
    } else {
      if (!isStr(fj.fileName)) fj.fileName = 'FlowJo workspace';
      const counts = fj.counts as Obj;
      let damaged = 0;
      for (const [sid, m] of Object.entries(counts)) {
        // (samples and gates removed since: their counts simply go)
        if (!sids.has(sid) || !isObj(m)) {
          if (!isObj(m)) damaged++;
          delete counts[sid];
          continue;
        }
        for (const [pid, n] of Object.entries(m)) {
          const bad = typeof n !== 'number' || !Number.isFinite(n) || Math.round(n) !== n;
          if (bad || !pids.has(pid)) {
            delete m[pid];
            if (bad) damaged++;
          }
        }
        if (!Object.keys(m).length) delete counts[sid];
      }
      if (damaged) other();
      if (!Object.keys(counts).length) delete w.flowjoCounts;
    }
  }

  // ---- FlowJo gate grids: one shared definition per distinct grid scale, linked to its base (as when imported), so
  // the engine shares the display arrays of the gates again
  {
    const intern = gateGridInterner([...Object.values(w.scales as Obj), ...(isObj(w.instrumentScales) ? Object.values(w.instrumentScales).flatMap((m) => (isObj(m) ? Object.values(m) : [])) : [])]);
    for (const p of w.populations as Obj[])
      for (const g of [p.gate, ...(isObj(p.overrides) ? Object.values(p.overrides) : [])] as Obj[]) {
        const sc = g && (g.type === 'polygon' || g.type === 'ellipse') && isObj(g.scales) ? (g.scales as Obj) : null;
        if (!sc) continue;
        for (const ax of ['x', 'y']) if (isObj(sc[ax])) sc[ax] = intern(sc[ax] as unknown as ScaleDef);
      }
  }
  return { ws: w as unknown as Workspace, notes: notes.list() };
}
