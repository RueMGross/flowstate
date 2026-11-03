// MACSPlex plugin, calculations: method specification v1.1 (decisions D1 to D14, see README.md). Everything goes
// through `fs`; no UI. The same rules are implemented in the Python reference (macsplex_ref); both must give the same
// numbers on the same gates. Each rule names the decision it implements.
import type { GateGeom, PluginContext } from '../api';
import { pointInPolygon } from '../../core/gating';
import { parseCytExpertXit } from '../../core/cytexpert';
import { DEFAULT_REPORTER, ISOTYPES, SINGLES_NAME, TETRASPANINS } from './beads';

export const METHOD_VERSION = '1.3';
export const STATE_VERSION = 1;

// ------------------------------------------------------------------ state (saved with the workspace)

export interface TemplateGate {
  name: string;
  /** parent gate name; null = All Events */
  parent: string | null;
  /** channels by name or marker label, as fs.findChannel takes them (e.g. "B525-FITC-A" or "FL1-A") */
  x: string;
  y: string;
  kind: 'rect' | 'polygon';
  /** raw (linear) values; a rectangle by its 4 corners */
  points: [number, number][];
}

export interface Template {
  source: string;
  gates: TemplateGate[];
}

export interface Limits {
  veryLowEvents: number; // D4
  lowEvents: number; // D4
  lowSingles: number; // D5
  lowAssignment: number; // D14
  earlyStopFraction: number; // D14
  replicateCv: number; // D14, provisional
  blankCv: number; // D14, provisional
  orderRho: number; // D14, provisional
  gateCheck: number; // D2 step 3, provisional
}

export const DEFAULT_LIMITS: Limits = {
  veryLowEvents: 20,
  lowEvents: 50,
  lowSingles: 10000,
  lowAssignment: 0.5,
  earlyStopFraction: 0.95,
  replicateCv: 0.3,
  blankCv: 0.3,
  orderRho: -0.5,
  gateCheck: 0.1,
};

export interface MacsplexState {
  version: 1;
  /** reporter channel, by name or marker label (D3) */
  reporter: string;
  template: Template | null;
  /** D2: template aligned to the beads of the reference well (default) or the template as it is (validation mode) */
  mode: 'auto' | 'template';
  /** population ids made by the plugin */
  singles: string | null;
  beads: Record<string, string>;
  /** the gates as the plugin made them (bead name -> geometry), to tell hand corrections (D2 step 4) */
  created: Record<string, GateGeom>;
  /** reference well for auto-gating (sample id) */
  reference: string | null;
  /** D2 step 5 */
  confirmed: { at: string; signature: string } | null;
  /** D1: the layout CSV as pasted */
  layoutText: string;
  /** D7: model B on/off */
  modelB: boolean;
  limits: Limits;
  /** how the current gates were made (for the run record) */
  gateSource?: string;
}

export const DEFAULT_STATE: MacsplexState = {
  version: 1,
  reporter: DEFAULT_REPORTER,
  template: null,
  mode: 'auto',
  singles: null,
  beads: {},
  created: {},
  reference: null,
  confirmed: null,
  layoutText: '',
  modelB: false,
  limits: DEFAULT_LIMITS,
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPt = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x));

function parseTemplate(v: unknown): Template | null {
  if (!isObj(v) || !Array.isArray(v.gates)) return null;
  const gates: TemplateGate[] = [];
  for (const g of v.gates) {
    if (!isObj(g) || typeof g.name !== 'string' || typeof g.x !== 'string' || typeof g.y !== 'string') return null;
    if ((g.kind !== 'rect' && g.kind !== 'polygon') || !Array.isArray(g.points) || !g.points.every(isPt)) return null;
    if (g.points.length < (g.kind === 'rect' ? 4 : 3)) return null;
    gates.push({ name: g.name, parent: typeof g.parent === 'string' ? g.parent : null, x: g.x, y: g.y, kind: g.kind, points: g.points as [number, number][] });
  }
  return { source: typeof v.source === 'string' ? v.source : 'template', gates };
}

/**
 * Saved state, checked: a copy with defaults for missing fields (states saved before a field existed), or null for
 * anything not understood (another version, a damaged file).
 */
export function parseState(raw: unknown): MacsplexState | null {
  if (!isObj(raw)) return null;
  if (raw.version !== undefined && raw.version !== STATE_VERSION) return null;
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const ids = (v: unknown) => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) : {}) as Record<string, string>;
  const limits = { ...DEFAULT_LIMITS };
  if (isObj(raw.limits))
    for (const k of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[])
      if (typeof raw.limits[k] === 'number' && Number.isFinite(raw.limits[k])) limits[k] = raw.limits[k] as number;
  if (raw.template !== undefined && raw.template !== null && !parseTemplate(raw.template)) return null;
  const confirmed =
    isObj(raw.confirmed) && typeof raw.confirmed.at === 'string' && typeof raw.confirmed.signature === 'string'
      ? { at: raw.confirmed.at, signature: raw.confirmed.signature }
      : null;
  return {
    version: 1,
    reporter: str(raw.reporter, DEFAULT_REPORTER),
    template: raw.template ? parseTemplate(raw.template) : null,
    mode: raw.mode === 'template' ? 'template' : 'auto',
    singles: typeof raw.singles === 'string' ? raw.singles : null,
    beads: ids(raw.beads),
    created: (isObj(raw.created) ? raw.created : {}) as Record<string, GateGeom>,
    reference: typeof raw.reference === 'string' ? raw.reference : null,
    confirmed,
    layoutText: str(raw.layoutText, ''),
    modelB: raw.modelB === true,
    limits,
    ...(typeof raw.gateSource === 'string' ? { gateSource: raw.gateSource } : {}),
  };
}

/** A template pasted as JSON (as the Python reference writes it: `python -m macsplex_ref template --xit ...`). */
export function parseTemplateText(text: string): Template | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: 'not valid JSON' };
  }
  return parseTemplate(v) ?? { error: 'not a gate template (needs gates with name, x, y, kind and points)' };
}

/** The gates of a population and its children as a template (e.g. gates imported from a CytExpert .xit). */
export function templateFromPopulations(fs: PluginContext<MacsplexState>, singlesId: string): Template | { error: string } {
  const pops = fs.populations();
  const top = pops.find((p) => p.id === singlesId);
  if (!top) return { error: 'population not found' };
  const asGate = (name: string, parent: string | null, g: GateGeom): TemplateGate | null => {
    if (g.type === 'rect')
      return {
        name,
        parent,
        x: g.x,
        y: g.y,
        kind: 'rect',
        points: [
          [g.xmin, g.ymin],
          [g.xmax, g.ymin],
          [g.xmax, g.ymax],
          [g.xmin, g.ymax],
        ],
      };
    if (g.type === 'polygon') return { name, parent, x: g.x, y: g.y, kind: 'polygon', points: g.points.map((p) => [p[0], p[1]] as [number, number]) };
    return null;
  };
  const head = asGate(SINGLES_NAME, null, top.gate as GateGeom);
  if (!head || head.kind !== 'rect') return { error: `"${top.name}" is not a rectangle gate` };
  const gates = [head];
  for (const p of pops.filter((x) => x.parentId === singlesId)) {
    const g = asGate(p.name, SINGLES_NAME, p.gate as GateGeom);
    if (g && g.kind === 'polygon') gates.push(g);
  }
  return { source: `populations under "${top.name}"`, gates };
}

/** The gates of a CytExpert experiment file (.xit) as a template: its top rectangle and the polygons under it. */
export function templateFromXit(bytes: Uint8Array, fileName: string): Template | { error: string } {
  let x;
  try {
    x = parseCytExpertXit(bytes);
  } catch (e) {
    return { error: `not a readable CytExpert experiment (${e instanceof Error ? e.message : String(e)})` };
  }
  const top = x.gates.find((g) => !g.parent && g.shape === 'rect');
  if (!top) return { error: 'the experiment has no top-level rectangle gate (single beads)' };
  const beads = x.gates.filter((g) => g.parent === top.uid && g.shape === 'polygon');
  if (!beads.length) return { error: 'no polygon gates under the single-bead rectangle' };
  return {
    source: `${fileName} (${beads.length} beads)`,
    gates: [
      { name: SINGLES_NAME, parent: null, x: top.x, y: top.y, kind: 'rect', points: top.points.map((p) => [p[0], p[1]] as [number, number]) },
      ...beads.map((g) => ({
        name: g.name,
        parent: SINGLES_NAME,
        x: g.x,
        y: g.y,
        kind: 'polygon' as const,
        points: g.points.map((p) => [p[0], p[1]] as [number, number]),
      })),
    ],
  };
}

// ------------------------------------------------------------------ layout (D1)

export type Role = 'sample' | 'blank' | 'unstained' | 'sa_control' | 'isotype_only' | 'empty';
export interface LayoutRow {
  well: string;
  role: Role;
  sample_id: string;
  condition: string;
  dose: string;
  replicate_group: string;
  blank_group: string;
  planned_volume_uL: number | null;
  failed: boolean;
}

/** "A01", " a1" -> "A1"; anything else stripped. */
export function normalizeWell(s: string): string {
  const m = s.trim().match(/^([A-Pa-p])0*(\d{1,2})$/);
  return m ? `${m[1].toUpperCase()}${Number(m[2])}` : s.trim();
}

function splitCsvLine(line: string, d: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') ((cur += '"'), i++);
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) (out.push(cur), (cur = ''));
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const ROLES: Role[] = ['sample', 'blank', 'unstained', 'sa_control', 'isotype_only', 'empty'];

export function parseLayout(text: string): { rows: LayoutRow[]; errors: string[] } {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: ['The layout is empty.'] };
  const first = lines[0];
  const d = ['\t', ';', ','].reduce((a, b) => (first.split(b).length > first.split(a).length ? b : a), ',');
  const head = splitCsvLine(first, d).map((h) => h.toLowerCase());
  const col = (n: string) => head.indexOf(n);
  const errors: string[] = [];
  for (const n of ['well', 'role']) if (col(n) < 0) errors.push(`The layout needs a "${n}" column.`);
  if (errors.length) return { rows: [], errors };
  const rows: LayoutRow[] = [];
  const seen = new Set<string>();
  lines.slice(1).forEach((l, i) => {
    const c = splitCsvLine(l, d);
    const get = (n: string) => (col(n) >= 0 ? (c[col(n)] ?? '') : '');
    const well = normalizeWell(get('well'));
    const role = get('role').toLowerCase() as Role;
    if (!well) return;
    if (!ROLES.includes(role)) errors.push(`Line ${i + 2}: unknown role "${get('role')}" (allowed: ${ROLES.join(', ')}).`);
    if (seen.has(well)) errors.push(`Line ${i + 2}: well ${well} appears twice.`);
    seen.add(well);
    const pv = parseFloat(get('planned_volume_ul'));
    rows.push({
      well,
      role,
      sample_id: get('sample_id'),
      condition: get('condition'),
      dose: get('dose'),
      replicate_group: get('replicate_group'),
      blank_group: get('blank_group'),
      planned_volume_uL: Number.isFinite(pv) ? pv : null,
      failed: ['1', 'yes', 'true', 'x'].includes(get('failed').toLowerCase()),
    });
  });
  return { rows, errors };
}

const LAYOUT_HEAD = ['well', 'role', 'sample_id', 'condition', 'dose', 'replicate_group', 'blank_group', 'planned_volume_uL', 'failed'];

/** Layout rows as CSV text (the form that is saved and shared with the Python reference). */
export function layoutToCsv(rows: LayoutRow[]): string {
  const q = (v: string) => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [
    LAYOUT_HEAD.join(','),
    ...rows.map((r) =>
      [r.well, r.role, r.sample_id, r.condition, r.dose, r.replicate_group, r.blank_group, r.planned_volume_uL ?? '', r.failed ? 'yes' : '']
        .map((v) => q(String(v)))
        .join(','),
    ),
  ].join('\n');
}

const wellRowCol = (w: string) => {
  const m = w.match(/^([A-P])(\d+)$/);
  return m ? { row: m[1], col: Number(m[2]) } : null;
};

/**
 * A starting layout from the loaded samples, to be checked and completed by the user: one row per well ($SMNO),
 * condition = the tube name without its well, role "blank" when the name says beads only / blank / buffer, replicates
 * = same name in the same plate column. Blank groups are left empty (see pairBlanks).
 */
export function draftLayout(fs: PluginContext<MacsplexState>, plannedVolume: number | null = null): LayoutRow[] {
  const rows: LayoutRow[] = [];
  for (const s of fs.samples()) {
    const well = normalizeWell(s.keywords['$SMNO'] ?? s.well ?? '');
    if (!well || rows.some((r) => r.well === well)) continue;
    const name = (s.keywords['$TBNM'] ?? s.name).trim();
    const condition =
      name
        .replace(new RegExp(`[-_ ]*${well}$`, 'i'), '')
        .replace(/[-_ ]*[A-P]0?\d{1,2}$/, '')
        .trim() || name;
    const rc = wellRowCol(well);
    rows.push({
      well,
      role: /beads?\s*-?only|blank|buffer/i.test(name) ? 'blank' : 'sample',
      sample_id: '',
      condition,
      dose: '',
      replicate_group: rc ? `${condition} | col ${rc.col}` : condition,
      blank_group: '',
      planned_volume_uL: plannedVolume,
      failed: false,
    });
  }
  const order = (w: string) => {
    const rc = wellRowCol(w);
    return rc ? rc.col * 100 + rc.row.charCodeAt(0) : 1e9;
  };
  return rows.sort((a, b) => order(a.well) - order(b.well));
}

/**
 * Pair the wells of each plate column (by = 'column') or row (by = 'row') with the blank wells in it. Blanks next to
 * each other form one blank group; every other well takes the nearest blank group before it (above / to the left),
 * or the first one after it when there is none before. So a column with blanks in rows A and E pairs B to D with A and
 * F to H with E. Wells in a column / row without blanks keep their blank group.
 */
export function pairBlanks(rows: LayoutRow[], by: 'column' | 'row'): LayoutRow[] {
  const out = rows.map((r) => ({ ...r }));
  const lines = new Map<string, { pos: number; i: number }[]>();
  out.forEach((r, i) => {
    const rc = wellRowCol(r.well);
    if (!rc) return;
    const key = by === 'column' ? `col ${rc.col}` : `row ${rc.row}`;
    const pos = by === 'column' ? rc.row.charCodeAt(0) : rc.col;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key)!.push({ pos, i });
  });
  for (const [key, line] of lines) {
    line.sort((a, b) => a.pos - b.pos);
    // blank groups: runs of neighbouring blank wells
    const groups: { start: number; name: string }[] = [];
    line.forEach((w, k) => {
      if (out[w.i].role !== 'blank') return;
      const prev = line[k - 1];
      const joins = prev && out[prev.i].role === 'blank' && w.pos - prev.pos === 1;
      if (!joins) groups.push({ start: k, name: `blank ${key} ${out[w.i].well}` });
      out[w.i].blank_group = groups[groups.length - 1].name;
    });
    if (!groups.length) continue;
    line.forEach((w, k) => {
      if (out[w.i].role === 'blank') return;
      const before = groups.filter((g) => g.start < k);
      out[w.i].blank_group = (before.length ? before[before.length - 1] : groups[0]).name;
    });
  }
  return out;
}

// ------------------------------------------------------------------ statistics helpers (D3, D13)

/** Quantile of sorted values, as FlowState's Statistics tables compute it (linear interpolation, type 7). */
function quantileSorted(s: Float32Array, q: number): number {
  const n = s.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const t = pos - lo;
  return s[lo] * (1 - t) + s[hi] * t;
}

function finiteSorted(v: Float32Array): Float32Array {
  const out = v.filter((x) => Number.isFinite(x));
  out.sort();
  return out;
}

/**
 * Distribution-free CI of the median (D13): sorted values x(k) and x(n-k+1), k the largest rank with
 * P(Binomial(n, 0.5) <= k - 1) <= (1 - level) / 2. None below 6 events (95%). The binomial CDF is summed term by term
 * in log space, the same arithmetic as the Python reference.
 */
export function medianCi(values: Float32Array, level = 0.95): [number, number] | null {
  const x = finiteSorted(values);
  const n = x.length;
  if (!n) return null;
  const a = (1 - level) / 2;
  let logTerm = -n * Math.log(2);
  let cdf = Math.exp(logTerm);
  let k = 0;
  while (k + 1 <= Math.floor(n / 2) && cdf <= a) {
    k++;
    logTerm += Math.log((n - k + 1) / k);
    cdf += Math.exp(logTerm);
  }
  return k ? [x[k - 1], x[n - k]] : null;
}

const mean = (v: number[]) => {
  const ok = v.filter((x) => Number.isFinite(x));
  return ok.length ? ok.reduce((s, x) => s + x, 0) / ok.length : NaN;
};
const sd1 = (v: number[]) => {
  const ok = v.filter((x) => Number.isFinite(x));
  if (ok.length < 2) return NaN;
  const m = ok.reduce((s, x) => s + x, 0) / ok.length;
  return Math.sqrt(ok.reduce((s, x) => s + (x - m) * (x - m), 0) / (ok.length - 1));
};

function avgRanks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as [number, number]).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation (average ranks for ties, as scipy.stats.spearmanr). */
export function spearman(a: number[], b: number[]): number {
  if (a.length < 3) return NaN;
  const ra = avgRanks(a);
  const rb = avgRanks(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let sab = 0,
    saa = 0,
    sbb = 0;
  for (let i = 0; i < ra.length; i++) {
    sab += (ra[i] - ma) * (rb[i] - mb);
    saa += (ra[i] - ma) ** 2;
    sbb += (rb[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** FCS $DATE (dd-mmm-yyyy) and $BTIM (hh:mm:ss[.cc]) as a time in ms; NaN when not readable. */
export function acquisitionTime(date: string, btim: string): number {
  const d = date.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  const t = btim.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:([.:])(\d+))?$/);
  if (!t) return NaN;
  const day = d ? Date.UTC(Number(d[3]), MONTHS.indexOf(d[2].toLowerCase()), Number(d[1])) : 0;
  if (d && MONTHS.indexOf(d[2].toLowerCase()) < 0) return NaN;
  // fraction: ".cc" hundredths (FCS 3.1), ":tt" sixtieths of a second (FCS 3.0)
  const frac = t[5] ? (t[4] === ':' ? Number(t[5]) / 60 : Number(`0.${t[5]}`)) : 0;
  return day + ((Number(t[1]) * 60 + Number(t[2])) * 60 + Number(t[3])) * 1000 + frac * 1000;
}

const flags = (...pairs: [boolean, string][]) =>
  pairs
    .filter(([c]) => c)
    .map(([, n]) => n)
    .join(';');

// ------------------------------------------------------------------ results

export interface WellRow {
  well: string;
  sampleId: string;
  file: string;
  role: Role;
  sample_id: string;
  replicate_group: string;
  blank_group: string;
  start_time: string;
  volume_uL: number;
  total_events: number;
  single_beads: number;
  singles_per_uL: number;
  pct_assigned: number;
  acq_order: number;
  flags: string;
}

export interface BeadRow {
  well: string;
  bead: string;
  role: Role;
  events: number;
  median: number;
  ci_low: number;
  ci_high: number;
  blank_group: string;
  blank_mean: number;
  blank_n: number;
  model_A: number;
  model_B: number;
  normalized: number;
  flags: string;
}

export interface SummaryRow {
  group: string;
  bead: string;
  n: number;
  mean_A: number;
  sd_A: number;
  cv_A: number;
  mean_B: number;
  mean_normalized: number;
  min_events: number;
  flags: string;
}

export interface BlankRow {
  blank_group: string;
  bead: string;
  blank_mean: number;
  blank_sd: number;
  n: number;
  blank_cv: number;
  flags: string;
}

export interface Results {
  wells: WellRow[];
  beads: BeadRow[];
  summary: SummaryRow[];
  blanks: BlankRow[];
  run: Record<string, string | number>;
  notes: string[];
}

/** The template's top rectangle (single beads) and the bead polygons under it, whatever the rectangle is called. */
export function templateParts(t: Template | null): { head: TemplateGate | null; beads: TemplateGate[] } {
  const head = t?.gates.find((g) => g.parent === null && g.kind === 'rect') ?? null;
  return { head, beads: head ? t!.gates.filter((g) => g.parent === head.name && g.kind === 'polygon') : [] };
}

/** The bead names in the analysis: the template's bead gates that have a population. */
export function beadNames(st: MacsplexState): string[] {
  const t = st.template ? templateParts(st.template).beads.map((g) => g.name) : Object.keys(st.beads);
  return t.filter((b) => st.beads[b]);
}

/** Samples that have their own gate (API: sampleGates) for the plugin's singles population or a bead population. */
function ownGates(fs: PluginContext<MacsplexState>, st: MacsplexState): { singles: Set<string>; beads: Map<string, Set<string>> } {
  const pops = fs.populations();
  const of = (id: string | null) => new Set(pops.find((p) => p.id === id)?.sampleGates ?? []);
  return { singles: of(st.singles), beads: new Map(Object.entries(st.beads).map(([b, id]) => [b, of(id)])) };
}

export function analyse(fs: PluginContext<MacsplexState>, st: MacsplexState): Results | { error: string } {
  const L = st.limits;
  const reporter = fs.findChannel(st.reporter);
  if (!reporter) return { error: `Reporter channel "${st.reporter}" not found in the samples.` };
  if (!st.singles || !fs.populations().some((p) => p.id === st.singles)) return { error: 'Create the gates first (Gating).' };
  const beads = beadNames(st);
  if (!beads.length) return { error: 'No bead gates yet (Gating).' };
  const notes: string[] = [];
  let layout: LayoutRow[];
  if (!st.layoutText.trim()) {
    // no layout yet: every well as a sample without blank, so medians, events and CIs are shown (no corrections)
    layout = fs.samples().map((s) => ({
      well: normalizeWell(s.keywords['$SMNO'] ?? '') || s.name,
      role: 'sample' as Role,
      sample_id: '',
      condition: '',
      dose: '',
      replicate_group: '',
      blank_group: '',
      planned_volume_uL: null,
      failed: false,
    }));
    notes.push('No plate layout yet: medians, events and CIs only; no blank subtraction, normalization or replicate summary.');
  } else {
    const p = parseLayout(st.layoutText);
    if (p.errors.length) return { error: p.errors.join(' ') };
    layout = p.rows;
  }

  // D1: wells by $SMNO
  const samples = fs.samples();
  const byWell = new Map<string, (typeof samples)[number]>();
  for (const s of samples) {
    const w = normalizeWell(s.keywords['$SMNO'] ?? '') || (st.layoutText.trim() ? '' : s.name);
    if (!w) continue;
    if (byWell.has(w)) return { error: `Two samples for well ${w} ($SMNO).` };
    byWell.set(w, s);
  }
  const missing = layout.filter((r) => !byWell.has(r.well)).map((r) => r.well);
  if (missing.length) return { error: `Layout wells without a sample: ${missing.join(', ')}.` };
  const extra = [...byWell.keys()].filter((w) => !layout.some((r) => r.well === w));
  if (extra.length) return { error: `Samples for wells not in the layout: ${extra.join(', ')}.` };
  const notLoaded = layout.filter((r) => !byWell.get(r.well)!.loaded).map((r) => r.well);
  const lay = new Map(layout.map((r) => [r.well, r]));
  const wellsInOrder = [...byWell.keys()];
  const own = ownGates(fs, st);

  // per well x bead: events, median (fs.stat), CI (fs.events)  (D3, D13)
  const B: BeadRow[] = [];
  const idx = new Map<string, BeadRow>();
  for (const w of wellsInOrder) {
    const s = byWell.get(w)!;
    const r = lay.get(w)!;
    for (const b of beads) {
      const pop = st.beads[b];
      const n = fs.count(s.id, pop) ?? 0;
      const med = fs.stat(s.id, pop, 'median', reporter);
      const ev = fs.events(s.id, reporter, pop);
      const ci = ev ? medianCi(ev) : null;
      const row: BeadRow = {
        well: w,
        bead: b,
        role: r.role,
        events: n,
        median: med,
        ci_low: ci ? ci[0] : NaN,
        ci_high: ci ? ci[1] : NaN,
        blank_group: r.blank_group,
        blank_mean: NaN,
        blank_n: 0,
        model_A: NaN,
        model_B: NaN,
        normalized: NaN,
        flags: '',
      };
      B.push(row);
      idx.set(`${w}\u0000${b}`, row);
    }
  }
  const at = (w: string, b: string) => idx.get(`${w}\u0000${b}`)!;
  const failed = (x: BeadRow) => lay.get(x.well)!.failed;

  // D6, D8: blank = mean of the blank group's medians (same bead); failed blank wells left out (v1.3)
  const blankStats = new Map<string, { mean: number; sd: number; n: number }>();
  const blankGroups = [...new Set(layout.filter((r) => r.role === 'blank').map((r) => r.blank_group))];
  for (const g of blankGroups)
    for (const b of beads) {
      const v = B.filter((x) => x.role === 'blank' && x.blank_group === g && x.bead === b && !failed(x))
        .map((x) => x.median)
        .filter(Number.isFinite);
      blankStats.set(`${g}\u0000${b}`, { mean: mean(v), sd: sd1(v), n: v.length });
    }
  for (const x of B) {
    const bs = blankStats.get(`${x.blank_group}\u0000${x.bead}`);
    x.blank_mean = bs ? bs.mean : NaN;
    x.blank_n = bs ? bs.n : 0;
    if (x.role !== 'blank' && x.blank_group) x.model_A = x.median - x.blank_mean;
  }

  // D7: model B (optional); failed unstained wells left out of the offsets (v1.3)
  if (st.modelB) {
    const u = new Map(beads.map((b) => [b, mean(B.filter((x) => x.role === 'unstained' && x.bead === b && !failed(x)).map((x) => x.median))]));
    for (const w of wellsInOrder) {
      const iso = mean(ISOTYPES.filter((b) => beads.includes(b)).map((b) => at(w, b).median - u.get(b)!));
      for (const b of beads) {
        const x = at(w, b);
        if (x.role !== 'blank') x.model_B = x.median - u.get(b)! - iso;
      }
    }
  }

  // D9: normalized to the mean of CD9, CD63, CD81 (model A) in the same well
  const tsp = TETRASPANINS.filter((b) => beads.includes(b));
  if (tsp.length < TETRASPANINS.length)
    notes.push(`Tetraspanin beads missing from the template (${TETRASPANINS.filter((b) => !tsp.includes(b)).join(', ')}): normalization uses the others.`);
  for (const w of wellsInOrder) {
    const tm = mean(tsp.map((b) => at(w, b).model_A));
    const tmin = Math.min(...tsp.map((b) => at(w, b).events));
    const ok = tsp.length > 0 && tmin > 0 && tm > 0;
    const f = lay.get(w)!.failed;
    const sid = byWell.get(w)!.id;
    for (const b of beads) {
      const x = at(w, b);
      const corr = x.role !== 'blank' && !!x.blank_group;
      if (ok) x.normalized = x.model_A / tm;
      x.flags = flags(
        [x.events === 0, 'empty_gate'],
        [x.events > 0 && x.events < L.veryLowEvents, 'very_low_events'],
        [x.events >= L.veryLowEvents && x.events < L.lowEvents, 'low_events'],
        [x.model_A < 0, 'below_background'],
        [corr && x.blank_n === 0, 'missing_blank'],
        [corr && !ok, 'norm_not_computed'],
        [corr && ok && tmin > 0 && tmin < L.lowEvents, 'norm_low_events'],
        [f, 'failed_well'],
        [!!own.beads.get(b)?.has(sid) || own.singles.has(sid), 'own_gate'],
      );
    }
  }

  // per well (D1, D5, D14)
  const W: WellRow[] = wellsInOrder.map((w) => {
    const s = byWell.get(w)!;
    const r = lay.get(w)!;
    const kw = s.keywords;
    const vol = kw['$VOL'] ? parseFloat(kw['$VOL']) / 1000 : NaN; // $VOL in nL (checked on the CytoFLEX LX)
    const singles = fs.count(s.id, st.singles) ?? 0;
    const assigned = beads.reduce((a, b) => a + at(w, b).events, 0);
    const isoNeg = ISOTYPES.some((b) => beads.includes(b) && at(w, b).model_A < 0);
    const ownAny = own.singles.has(s.id) || beads.some((b) => own.beads.get(b)?.has(s.id));
    return {
      well: w,
      sampleId: s.id,
      file: s.fileName,
      role: r.role,
      sample_id: r.sample_id,
      replicate_group: r.replicate_group,
      blank_group: r.blank_group,
      start_time: `${kw['$DATE'] ?? ''} ${kw['$BTIM'] ?? ''}`.trim(),
      volume_uL: vol,
      total_events: s.eventCount,
      single_beads: singles,
      singles_per_uL: vol ? singles / vol : NaN,
      pct_assigned: singles ? (100 * assigned) / singles : NaN,
      acq_order: NaN,
      flags: flags(
        [!s.loaded, 'not_loaded'],
        [r.failed, 'failed_well'],
        [!Number.isFinite(vol), 'no_volume'],
        [r.planned_volume_uL !== null && vol < L.earlyStopFraction * r.planned_volume_uL, 'early_stop'],
        [singles < L.lowSingles, 'low_singles'],
        [singles > 0 && assigned / singles < L.lowAssignment, 'low_assignment'],
        [isoNeg, 'negative_isotype'],
        [ownAny, 'own_gate'],
      ),
    };
  });
  // acquisition order over the wells with a time; the trend leaves out wells with the role "empty" (v1.3)
  const times = W.map((w) => acquisitionTime(byWell.get(w.well)!.keywords['$DATE'] ?? '', byWell.get(w.well)!.keywords['$BTIM'] ?? ''));
  const timed = W.map((w, i) => [times[i], i] as [number, number])
    .filter(([t]) => Number.isFinite(t))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  timed.forEach(([, i], k) => (W[i].acq_order = k + 1));
  const withOrder = W.filter((w) => Number.isFinite(w.acq_order) && w.role !== 'empty');
  const rho =
    withOrder.length >= 3
      ? spearman(
          withOrder.map((w) => w.acq_order),
          withOrder.map((w) => w.single_beads),
        )
      : NaN;

  // D10: replicate summary over non-failed wells with events in that bead; n = the values used (v1.3)
  const S: SummaryRow[] = [];
  const groups = new Map<string, BeadRow[]>();
  for (const x of B) {
    const r = lay.get(x.well)!;
    if (x.role === 'blank' || r.failed || x.events === 0 || !r.replicate_group) continue;
    const k = `${r.replicate_group}\u0000${x.bead}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(x);
  }
  for (const [k, d] of groups) {
    const [g, b] = k.split('\u0000');
    const a = d.map((x) => x.model_A).filter(Number.isFinite);
    const n = a.length;
    const m = mean(a);
    const sd = n >= 2 ? sd1(a) : NaN;
    const cv = n >= 2 && m !== 0 ? sd / Math.abs(m) : NaN;
    S.push({
      group: g,
      bead: b,
      n,
      mean_A: m,
      sd_A: sd,
      cv_A: cv,
      mean_B: mean(d.map((x) => x.model_B)),
      mean_normalized: mean(d.map((x) => x.normalized)),
      min_events: Math.min(...d.map((x) => x.events)),
      flags: flags(
        [n < 2, 'n_lt_2'],
        [Number.isFinite(cv) && cv > L.replicateCv, 'replicate_cv'],
        [d.some((x) => x.events < L.veryLowEvents), 'very_low_events'],
        [d.some((x) => x.events >= L.veryLowEvents && x.events < L.lowEvents), 'low_events'],
        [m < 0, 'below_background'],
      ),
    });
  }
  const BL: BlankRow[] = [...blankStats].map(([k, v]) => {
    const [g, b] = k.split('\u0000');
    const cv = v.sd / Math.abs(v.mean);
    return {
      blank_group: g,
      bead: b,
      blank_mean: v.mean,
      blank_sd: v.sd,
      n: v.n,
      blank_cv: cv,
      flags: flags([cv > L.blankCv, 'blank_cv'], [v.n < 3, 'blank_n_lt_3']),
    };
  });
  if (notLoaded.length) notes.push(`Not loaded (FCS file missing): ${notLoaded.join(', ')}; their values are empty.`);
  const ownWells = W.filter((w) => w.flags.split(';').includes('own_gate')).map((w) => w.well);
  if (ownWells.length) notes.push(`Wells with their own gate (against one gate set per plate): ${ownWells.join(', ')}. Use the plate gate again in Gating.`);

  const ref = st.reference ? samples.find((s) => s.id === st.reference) : undefined;
  const run: Record<string, string | number> = {
    method_version: METHOD_VERSION,
    plugin_version: fs.plugin.version,
    gate_source: `${st.gateSource || (st.mode === 'template' ? 'template gates as they are (validation mode)' : 'template aligned to the beads of the reference well')}; template: ${st.template?.source ?? 'none'}`,
    reference_well: ref ? normalizeWell(ref.keywords['$SMNO'] ?? '') || ref.name : '',
    gates_confirmed: st.confirmed && st.confirmed.signature === gateSignature(fs, st) ? st.confirmed.at : '',
    wells: W.length,
    beads: beads.length,
    order_rho: rho,
    plate_flags: flags(
      [Number.isFinite(rho) && rho < L.orderRho, 'order_trend'],
      [st.mode === 'template', 'gates_template'],
      [ownWells.length > 0, 'own_gate'],
    ),
    files: W.map((w) => `${w.file} (${w.total_events} events, ${w.start_time})`).join(' | '),
    ...Object.fromEntries(Object.entries(L).map(([k, v]) => [`setting_${k}`, v])),
    setting_reporter: st.reporter,
    setting_modelB: st.modelB ? 'on' : 'off',
  };
  return { wells: W, beads: B, summary: S, blanks: BL, run, notes };
}

// ------------------------------------------------------------------ gating in steps (D2)

const LIN = { type: 'linear' as const, min: 0, max: 16777215 };

export interface AlignOptions {
  /** search area: the polygon enlarged around its centre by this factor (log space) */
  enlarge: number;
  iterations: number;
  /** stop when a step moves less than this (decades) */
  tolerance: number;
}
export const ALIGN: AlignOptions = { enlarge: 1.3, iterations: 5, tolerance: 0.002 };

const log10c = (v: number) => Math.log10(Math.max(v, 1));
const median64 = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Area centroid of a polygon (shoelace); the vertex mean when the area is (nearly) zero. */
export function polygonCentroid(P: number[][]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const f = P[j][0] * P[i][1] - P[i][0] * P[j][1];
    a += f;
    cx += (P[j][0] + P[i][0]) * f;
    cy += (P[j][1] + P[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) return [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * D2 step 2 (method v1.3): move a template polygon onto its bead population without changing its shape. In log10 space,
 * repeatedly: take the events inside the polygon enlarged by `enlarge` around its area centroid, and move the polygon
 * so its centroid lies on their median position. Event values below 1 count as 1. A polygon with a vertex at or below
 * 1 is not aligned (`refused`), because moving it in log space would distort it. Deterministic; the Python reference
 * does the same. Returns the moved polygon (raw values) and the total shift in decades.
 */
export function alignPolygon(
  points: [number, number][],
  ex: Float32Array,
  ey: Float32Array,
  o: AlignOptions = ALIGN,
): { points: [number, number][]; dx: number; dy: number; n: number; refused?: string } {
  if (points.some(([x, y]) => !(x > 1) || !(y > 1))) return { points, dx: 0, dy: 0, n: 0, refused: 'a vertex at or below 1' };
  const lx = Float64Array.from(ex, log10c);
  const ly = Float64Array.from(ey, log10c);
  let P = points.map(([x, y]) => [Math.log10(x), Math.log10(y)]);
  let dx = 0;
  let dy = 0;
  let n = 0;
  for (let it = 0; it < o.iterations; it++) {
    const [cx, cy] = polygonCentroid(P);
    const xs = Float64Array.from(P, (p) => cx + o.enlarge * (p[0] - cx));
    const ys = Float64Array.from(P, (p) => cy + o.enlarge * (p[1] - cy));
    const sx: number[] = [];
    const sy: number[] = [];
    for (let i = 0; i < lx.length; i++) if (pointInPolygon(lx[i], ly[i], xs, ys)) (sx.push(lx[i]), sy.push(ly[i]));
    n = sx.length;
    if (n < 3) break;
    const sdx = median64(sx) - cx;
    const sdy = median64(sy) - cy;
    P = P.map(([x, y]) => [x + sdx, y + sdy]);
    dx += sdx;
    dy += sdy;
    if (Math.abs(sdx) < o.tolerance && Math.abs(sdy) < o.tolerance) break;
  }
  const fx = 10 ** dx;
  const fy = 10 ** dy;
  return { points: points.map(([x, y]) => [x * fx, y * fy]), dx, dy, n };
}

/**
 * Steps 1 and 2: the singles rectangle from the template, then every bead's template polygon, moved onto its bead
 * population in the reference well (mode 'auto', see alignPolygon) or as it is (mode 'template', validation). Gates
 * are evaluated in linear space, exactly as the template. Replaces the plugin's earlier gates; one undo step.
 * Returns { error } (and changes nothing) when the template, a channel or the reference well is missing; otherwise
 * notes for single beads that could not be aligned.
 */
export function createGates(fs: PluginContext<MacsplexState>, st: MacsplexState, referenceId: string): { error: string } | { notes: string[] } {
  const { head, beads: tBeads } = templateParts(st.template);
  if (!st.template || !head) return { error: 'The template has no single-bead rectangle at its top.' };
  if (!tBeads.length) return { error: `The template has no bead polygons under "${head.name}".` };
  // everything is checked before the old gates are touched
  const ch = (n: string) => fs.findChannel(n);
  const hx = ch(head.x);
  const hy = ch(head.y);
  const missingCh = [...new Set([head, ...tBeads].flatMap((g) => [g.x, g.y]).filter((c) => !ch(c)))];
  if (!hx || !hy || missingCh.length) return { error: `Channels not found in the samples: ${missingCh.join(', ')}. No gates were changed.` };
  const ref = fs.samples().find((s) => s.id === referenceId);
  if (st.mode === 'auto' && !ref?.loaded)
    return { error: 'The reference well is not loaded (its FCS file is needed for the alignment). No gates were changed.' };
  const notes: string[] = [];
  return fs.transaction(() => {
    if (st.singles && fs.populations().some((p) => p.id === st.singles)) fs.removePopulation(st.singles);
    const xs = head.points.map((p) => p[0]);
    const ys = head.points.map((p) => p[1]);
    const singles = fs.addGate({
      name: head.name,
      gate: { type: 'rect', x: hx, y: hy, xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) },
    });
    const beads: Record<string, string> = {};
    const created: Record<string, GateGeom> = {};
    const evCache = new Map<string, Float32Array | null>();
    const ev = (c: string) => {
      if (!evCache.has(c)) evCache.set(c, fs.events(referenceId, c, singles));
      return evCache.get(c)!;
    };
    for (const g of tBeads) {
      const x = ch(g.x)!;
      const y = ch(g.y)!;
      let pts = g.points.map((p) => [p[0], p[1]] as [number, number]);
      if (st.mode === 'auto') {
        const ex = ev(x);
        const ey = ev(y);
        const a = ex && ey ? alignPolygon(pts, ex, ey) : null;
        if (!a) notes.push(`${g.name}: no events in the reference well; template position kept.`);
        else if (a.refused) notes.push(`${g.name}: not aligned (${a.refused}); template position kept.`);
        else if (a.n < 3) notes.push(`${g.name}: too few events near its template position in the reference well; template position kept.`);
        else pts = a.points;
      }
      const gate: GateGeom = { type: 'polygon', x, y, points: pts, scales: { x: LIN, y: LIN }, strict: true };
      beads[g.name] = fs.addGate({ name: g.name, parent: singles, gate });
      created[g.name] = gate;
    }
    const gateSource = st.mode === 'template' ? 'template gates as they are (validation mode)' : 'template aligned to the beads of the reference well';
    fs.setState((s) => ({ ...(s ?? DEFAULT_STATE), ...st, singles, beads, created, reference: referenceId, confirmed: null, gateSource }));
    return { notes };
  });
}

/**
 * The current gates of the plugin's populations, including every sample's own gate, as one string (D2 step 5: a
 * confirmation holds for exactly these gates).
 */
export function gateSignature(fs: PluginContext<MacsplexState>, st: MacsplexState): string {
  const pops = fs.populations();
  const ids = [st.singles, ...Object.values(st.beads)].filter((x): x is string => !!x);
  return JSON.stringify(
    ids.map((id) => {
      const p = pops.find((q) => q.id === id);
      if (!p) return null;
      return { gate: p.gate, own: [...p.sampleGates].sort().map((s) => [s, fs.gateFor(id, s)]) };
    }),
  );
}

/** Give a sample the plate gates again: removes its own gates of the plugin's populations. One undo step. */
export function usePlateGates(fs: PluginContext<MacsplexState>, st: MacsplexState, sampleId: string): number {
  const pops = fs.populations();
  const ids = [st.singles, ...Object.values(st.beads)].filter((x): x is string => !!x);
  let k = 0;
  fs.transaction(() => {
    for (const id of ids)
      if (pops.find((p) => p.id === id)?.sampleGates.includes(sampleId)) {
        fs.clearSampleGate(id, sampleId);
        k++;
      }
  });
  return k;
}

export interface GateCheckRow {
  bead: string;
  template_events: number;
  template_median: number;
  events: number;
  median: number;
  events_diff: number;
  median_diff: number;
  all_wells_template_events: number;
  all_wells_events: number;
  corrected: boolean;
  own_gate_wells: number;
  flags: string;
}

/**
 * Events and reporter median of every template bead polygon among a sample's single beads (raw linear space). The
 * events are read once per sample, and the result is cached: it depends only on the template, the sample and its
 * single-bead gate, not on the bead gates being checked.
 */
const tplCache = new WeakMap<Template, Map<string, Map<string, { n: number; median: number }>>>();
function templateStats(fs: PluginContext<MacsplexState>, st: MacsplexState, sampleId: string, reporter: string): Map<string, { n: number; median: number }> {
  const t = st.template!;
  const key = `${sampleId}\u0000${reporter}\u0000${st.singles}\u0000${JSON.stringify(st.singles ? fs.gateFor(st.singles, sampleId) : null)}`;
  let perT = tplCache.get(t);
  if (!perT) tplCache.set(t, (perT = new Map()));
  const hit = perT.get(key);
  if (hit) return hit;
  const out = new Map<string, { n: number; median: number }>();
  const evs = new Map<string, Float32Array | null>();
  const ev = (c: string | null) => {
    if (!c) return null;
    if (!evs.has(c)) evs.set(c, fs.events(sampleId, c, st.singles));
    return evs.get(c)!;
  };
  const er = ev(reporter);
  for (const g of templateParts(t).beads) {
    const ex = ev(fs.findChannel(g.x));
    const ey = ev(fs.findChannel(g.y));
    if (!ex || !ey || !er) {
      out.set(g.name, { n: NaN, median: NaN });
      continue;
    }
    const px = Float64Array.from(g.points.map((p) => p[0]));
    const py = Float64Array.from(g.points.map((p) => p[1]));
    const vals: number[] = [];
    for (let i = 0; i < ex.length; i++) if (pointInPolygon(ex[i], ey[i], px, py)) vals.push(er[i]);
    out.set(g.name, { n: vals.length, median: quantileSorted(finiteSorted(Float32Array.from(vals)), 0.5) });
  }
  perT.set(key, out);
  return out;
}

/**
 * Step 3: each bead's current gate against its template gate, in the reference well and summed over all loaded
 * wells. A missing population, missing events or a non-finite value is a failed check (`gate_check`), never a pass.
 */
export function gateCheck(fs: PluginContext<MacsplexState>, st: MacsplexState): GateCheckRow[] {
  const reporter = fs.findChannel(st.reporter);
  const ref = st.reference;
  if (!reporter || !ref || !st.template) return [];
  const pops = fs.populations();
  const singlesOk = !!st.singles && pops.some((p) => p.id === st.singles);
  const loaded = fs.samples().filter((s) => s.loaded);
  const lim = st.limits.gateCheck;
  // relative difference; anything not finite counts as a failed check
  const off = (a: number, b: number) => !Number.isFinite(a) || !Number.isFinite(b) || (b ? Math.abs(a - b) / Math.abs(b) > lim : a !== 0);
  const rel = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) ? (b ? Math.abs(a - b) / Math.abs(b) : a ? Infinity : 0) : NaN);
  const refT = singlesOk ? templateStats(fs, st, ref, reporter) : new Map();
  const allT = new Map<string, number>();
  if (singlesOk) for (const s of loaded) for (const [b, v] of templateStats(fs, st, s.id, reporter)) allT.set(b, (allT.get(b) ?? 0) + v.n);
  return templateParts(st.template)
    .beads.filter((g) => st.beads[g.name])
    .map((g) => {
      const id = st.beads[g.name];
      const p = pops.find((q) => q.id === id);
      const t = refT.get(g.name) ?? { n: NaN, median: NaN };
      const n = p && singlesOk ? (fs.count(ref, id) ?? NaN) : NaN;
      const med = p && singlesOk ? fs.stat(ref, id, 'median', reporter) : NaN;
      const allC = p && singlesOk ? loaded.reduce((a, s) => a + (fs.count(s.id, id) ?? NaN), 0) : NaN;
      const corrected = !!p && JSON.stringify(p.gate) !== JSON.stringify(st.created[g.name]);
      const own = p?.sampleGates.length ?? 0;
      return {
        bead: g.name,
        template_events: t.n,
        template_median: t.median,
        events: n,
        median: med,
        events_diff: rel(n, t.n),
        median_diff: rel(med, t.median),
        all_wells_template_events: allT.get(g.name) ?? NaN,
        all_wells_events: allC,
        corrected,
        own_gate_wells: own,
        flags: flags(
          [!p || !singlesOk, 'gate_missing'],
          [off(n, t.n) || off(med, t.median) || off(allC, allT.get(g.name) ?? NaN), 'gate_check'],
          [corrected, 'gate_corrected'],
          [own > 0, 'own_gate'],
        ),
      };
    });
}

// ------------------------------------------------------------------ export rows

type Cell = string | number | null;
const cell = (v: unknown): Cell =>
  typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'boolean' ? (v ? 'yes' : '') : v == null ? null : String(v);

export function tableRows<T extends object>(rows: T[], cols: (keyof T)[]): Cell[][] {
  return [cols.map(String), ...rows.map((r) => cols.map((c) => cell(r[c])))];
}

export const WELL_COLS: (keyof WellRow)[] = [
  'well',
  'file',
  'role',
  'sample_id',
  'replicate_group',
  'blank_group',
  'start_time',
  'volume_uL',
  'total_events',
  'single_beads',
  'singles_per_uL',
  'pct_assigned',
  'acq_order',
  'flags',
];
export const BEAD_COLS: (keyof BeadRow)[] = [
  'well',
  'bead',
  'role',
  'events',
  'median',
  'ci_low',
  'ci_high',
  'blank_group',
  'blank_mean',
  'blank_n',
  'model_A',
  'model_B',
  'normalized',
  'flags',
];
export const SUMMARY_COLS: (keyof SummaryRow)[] = ['group', 'bead', 'n', 'mean_A', 'sd_A', 'cv_A', 'mean_B', 'mean_normalized', 'min_events', 'flags'];
export const BLANK_COLS: (keyof BlankRow)[] = ['blank_group', 'bead', 'blank_mean', 'blank_sd', 'n', 'blank_cv', 'flags'];
export const GATE_COLS: (keyof GateCheckRow)[] = [
  'bead',
  'template_events',
  'template_median',
  'events',
  'median',
  'events_diff',
  'median_diff',
  'all_wells_template_events',
  'all_wells_events',
  'corrected',
  'own_gate_wells',
  'flags',
];
