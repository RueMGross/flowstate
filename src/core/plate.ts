// Well plates: the plate and well each sample was measured in (FCS keywords, sample / file names, folders), plate
// formats, block selection of wells, heatmap matrices and their export. Pure functions: no store, no DOM.
//
// Where instruments put the well (checked on files of each, see tests/plate.test.ts):
// - FCS 3.1: $WELLID, $PLATEID, $PLATENAME (Attune, NovoCyte, Sony ID7000 / SA3800, Cytek Aurora, Guava, Apogee,
//   MACSQuant, CytExpert for the CytoFLEX LX / mosaic: $PLATENAME "01", $WELLID "A1")
// - BD FACSDiva (HTS): "WELL ID", "PLATE NAME" (often the plate type, "96 Well - U bottom"), "PLATE ID" (a GUID),
//   "TUBE NAME"; file names "<specimen>_<tube>_<well>" ("Specimen_001_C2_C02")
// - CytExpert (CytoFLEX): PLTNO (plate number), $SMNO (well), TBNM (tube name, by default "<plate>-Well-<well>",
//   e.g. "10-Well-D8"); FCS files are saved in the experiment's folder under the tube name
// - Guava / Muse: GTI$WELL and $WELLID, one data set per well in one file; BD FACSCalibur HTS: BDPM$WELL
// - MACSQuant: $SRC holds the well ("A1"); Aurora: PLATEROWS / PLATECOLS give the format
import type { PlateDef, Workspace } from './model';

export const ROW_LETTERS = 'ABCDEFGHIJKLMNOP';

export interface PlateFormat {
  rows: number;
  cols: number;
}

/** Standard plate formats (wells, rows x columns). */
export const PLATE_FORMATS: (PlateFormat & { wells: number })[] = [
  { wells: 6, rows: 2, cols: 3 },
  { wells: 12, rows: 3, cols: 4 },
  { wells: 24, rows: 4, cols: 6 },
  { wells: 48, rows: 6, cols: 8 },
  { wells: 96, rows: 8, cols: 12 },
  { wells: 384, rows: 16, cols: 24 },
];

export const DEFAULT_FORMAT: PlateFormat = { rows: 8, cols: 12 };

export function formatOfWells(n: number): PlateFormat | undefined {
  const f = PLATE_FORMATS.find((x) => x.wells === n);
  return f ? { rows: f.rows, cols: f.cols } : undefined;
}

// ------------------------------------------------------------------ wells

export interface WellPos {
  row: number; // 0-based (A = 0)
  col: number; // 0-based (1 = 0)
}

const WELL_RE = /^\s*(?:well[\s_-]*)?([A-Pa-p])\s*0{0,2}([1-9]\d?)\s*$/i;

/** "A1", "A01", "a001", "Well A1" -> row / column (0-based); null when not a well of a plate up to 384 wells. */
export function parseWell(s: unknown): WellPos | null {
  if (typeof s !== 'string') return null;
  const m = WELL_RE.exec(s);
  if (!m) return null;
  const col = parseInt(m[2], 10);
  if (col < 1 || col > 24) return null;
  return { row: m[1].toUpperCase().charCodeAt(0) - 65, col: col - 1 };
}

/** Normalized well id: row letter and two-digit column ("A01", "H12", "P24"). */
export const wellId = (row: number, col: number) => `${ROW_LETTERS[row] ?? '?'}${String(col + 1).padStart(2, '0')}`;

/** A well written any way ("a1", "A001", "Well A1") as its normalized id ("A01"), or null. */
export function normWell(s: unknown): string | null {
  const p = parseWell(s);
  return p ? wellId(p.row, p.col) : null;
}

/** Short form for labels: "A1" (no leading zero). */
export const shortWell = (w: string) => w.replace(/^([A-P])0(\d)$/, '$1$2');

// ------------------------------------------------------------------ keywords

const clean = (v: string | undefined) => {
  const t = (v ?? '').trim();
  return !t || /^(na|n\/a|none|null|undefined|-1|0+)$/i.test(t) ? '' : t;
};

/** Plate keywords present (any vendor). */
function hasPlateKeywords(kw: Record<string, string>): boolean {
  return !!(clean(kw['$PLATENAME']) || clean(kw['PLATE NAME']) || clean(kw['$PLATEID']) || clean(kw['PLATE ID']) || clean(kw['PLTNO']));
}

const WELL_KEYS = ['$WELLID', 'WELL ID', 'WELLID', 'GTI$WELL', 'BDPM$WELL', '$SMNO', '$LOCATIONID'];

/** The well a file's keywords name, normalized ("A01"), or null. */
export function keywordWell(kw: Record<string, string> | undefined): string | null {
  if (!kw) return null;
  for (const k of WELL_KEYS) {
    const w = normWell(kw[k] ?? '');
    if (w) return w;
  }
  // BD FACSDiva names the tubes of a plate after their well ("C10"); MACSQuant writes the well as the source
  if (hasPlateKeywords(kw)) {
    const w = normWell(kw['TUBE NAME'] ?? '');
    if (w) return w;
  }
  if (/macsquant/i.test(kw['$CYT'] ?? '')) {
    const w = normWell(kw['$SRC'] ?? '');
    if (w) return w;
  }
  return null;
}

/** A plate type rather than a plate ("96 Well - U bottom", "96-Well Plate", "Chill 96 rack", "40 Tube Rack"). */
export function isPlateTypeName(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/^(plate|default|untitled|new plate|plate type)$/i.test(t)) return true;
  return /\b\d+\s*-?\s*(well|tube)s?\b/i.test(t) || /\brack\b/i.test(t);
}

/** "Plate_001", "plate-2", "PLATE 3" -> "Plate 1" ...; other text unchanged. */
export function prettyPlateName(s: string): string {
  const t = s.trim();
  const m = /^(?:plate|plt|pl|p)[\s_\-#.]*0*(\d{1,4})$/i.exec(t);
  if (m) return `Plate ${parseInt(m[1], 10)}`;
  if (/^\d{1,4}$/.test(t)) return `Plate ${parseInt(t, 10)}`;
  return t;
}

interface KwPlate {
  key: string;
  label: string;
  /** names a particular plate (id, number, name); false: only a plate type and maybe the experiment */
  identity: boolean;
  format?: PlateFormat;
  /** experiment / project name (tells plates of the same name apart) */
  exp?: string;
}

/** Format named by keywords: Aurora PLATEROWS / PLATECOLS, or the plate type ("96 Well - U bottom"). */
function keywordFormat(kw: Record<string, string>, typeName: string): PlateFormat | undefined {
  const r = parseInt(kw['PLATEROWS'] ?? '', 10);
  const c = parseInt(kw['PLATECOLS'] ?? '', 10);
  if (r > 0 && r <= 16 && c > 0 && c <= 24) return { rows: r, cols: c };
  const m = /\b(\d+)\s*-?\s*well/i.exec(typeName);
  return m ? formatOfWells(parseInt(m[1], 10)) : undefined;
}

/** The plate a file's keywords name (null: none). */
export function keywordPlate(kw: Record<string, string> | undefined): KwPlate | null {
  if (!kw) return null;
  const first = (...keys: string[]) => keys.map((k) => clean(kw[k])).find(Boolean) ?? '';
  const name = first('$PLATENAME', 'PLATE NAME', 'PLATENAME');
  const id = first('$PLATEID', 'PLATE ID', 'PLATEID');
  const no = first('PLTNO');
  if (!name && !id && !no) return null;
  const exp = first('EXPERIMENT NAME', '$PROJ').replace(/\.(ncf|xit|exp)$/i, '');
  const typeLike = isPlateTypeName(name);
  const trailingNo = typeLike ? /[-–]\s*(\d{1,3})\s*$/.exec(name)?.[1] : undefined;
  let label = '';
  let identity = true;
  if (name && !typeLike) label = prettyPlateName(name);
  else if (no) label = /^\d+$/.test(no) ? `Plate ${parseInt(no, 10)}` : no;
  else if (trailingNo) label = `Plate ${parseInt(trailingNo, 10)}`;
  else if (/^\d{1,3}$/.test(id)) label = `Plate ${parseInt(id, 10)}`;
  else {
    // a plate id (GUID) names a plate but not in words: the experiment (else numbered); a plate type is no name
    identity = !!id;
    label = exp;
  }
  return { key: [exp, id, name, no].join('|'), label, identity, format: keywordFormat(kw, name), exp: exp || undefined };
}

// ------------------------------------------------------------------ wells in names

interface WellCand {
  well: string;
  row: number;
  col: number;
  start: number;
  end: number;
  strong: boolean;
  keys: string[];
}

/**
 * Well ids in a name, each delimited (start / end of the name, space, _ - . ( ) # and other punctuation, or a "Well"
 * prefix): "CD8", "H2O", "A549", "HEK293T" have none. A well written twice ("C2_C02", BD FACSDiva) counts once. Strong
 * candidates: after "Well" ("Sample_Well_A02", "01-Well-A1", "A01 Well - A01"), written twice, the whole name ("G11"),
 * or after a data set number ("<file> #3 A03").
 */
export function wellCandidates(name: string): WellCand[] {
  const re = /(?<![A-Za-z0-9])(well[\s_-]*)?([A-Pa-p])(0{0,2}[1-9]\d?)(?![A-Za-z0-9])/gi;
  const raw: { well: string; row: number; col: number; start: number; end: number; prefixed: boolean; lower: boolean }[] = [];
  for (let m = re.exec(name); m; m = re.exec(name)) {
    const col = parseInt(m[3], 10);
    if (col > 24) continue;
    const row = m[2].toUpperCase().charCodeAt(0) - 65;
    const tokStart = m.index + (m[1]?.length ?? 0);
    raw.push({ well: wellId(row, col - 1), row, col: col - 1, start: tokStart, end: m.index + m[0].length, prefixed: !!m[1], lower: m[2] !== m[2].toUpperCase() });
  }
  // BD: "<tube>_<well>" with the same well twice, e.g. "C2_C02"
  const merged: (typeof raw[number] & { pair: boolean })[] = [];
  for (const c of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.well === c.well && c.start - prev.end === 1 && /[_\s-]/.test(name[prev.end])) {
      prev.end = c.end;
      prev.pair = true;
      continue;
    }
    merged.push({ ...c, pair: false });
  }
  const whole = name.trim();
  return merged.map((c, i) => {
    const before = name.slice(0, c.start);
    // (a whole name like "L1" is a well only in rows A to H: rows I to P are rare, short file names are not)
    const strong = c.prefixed || c.pair || (whole === name.slice(c.start, c.end).trim() && c.row < 8) || /#\d+\s+$/.test(before);
    // position from the left / right, with the shape around it (start of the name or not, end or not): "ctrl_A1" and
    // "B6 mice" do not share a pattern
    const after = name.slice(c.end);
    const shape = (c.start === 0 || !before.trim() ? '^' : '-') + (!after.trim() || /^\.\d*$/.test(after.trim()) ? '$' : '-');
    // lower case ("a1") only counts in a consistent pattern, never alone; strong and weak candidates, upper and lower
    // case, are separate patterns (a weak token never rides along with the strong ones of other names)
    const isStrong = strong && !(c.lower && !c.prefixed);
    const tag = (isStrong ? 's' : 'w') + (c.lower ? 'l' : '');
    const keys = [`L${i}${shape}${tag}`, `R${merged.length - 1 - i}${shape}${tag}`];
    if (c.prefixed) keys.push('W' + tag);
    if (c.pair) keys.push('P' + tag);
    return { well: c.well, row: c.row, col: c.col, start: c.start, end: c.end, strong: isStrong, keys };
  });
}

interface NameWell {
  well: string;
  start: number;
  end: number;
}

/**
 * Wells from names, chosen by the pattern the names share: for each position of the candidates (n-th from the left /
 * right, after "Well", the doubled BD form) the number of distinct wells it gives. The best position is used for the
 * names that have it, then the best one of the rest, and so on. A position of weak candidates only counts when it
 * gives at least 3 different wells spread over rows and columns (or 8 in one row / column, all within A1..H12 unless
 * there are 8 or more) and no well more than 8 times: "B6 mice", "D1 / D2 / D3" (days) or one "P3" are not wells.
 * `context`: names of samples placed before (inform the pattern, are not assigned).
 */
export function wellsFromNames(names: string[], context: string[] = []): (NameWell | null)[] {
  const all = [...names, ...context];
  const cands = all.map((n) => wellCandidates(n));
  const out: (NameWell | null)[] = names.map(() => null);
  let left = new Set(all.map((_, i) => i).filter((i) => cands[i].length > 0));
  for (let round = 0; round < 8 && left.size; round++) {
    const byKey = new Map<string, { i: number; c: WellCand }[]>();
    for (const i of left)
      for (const c of cands[i])
        for (const k of c.keys) {
          const l = byKey.get(k) ?? [];
          if (!l.some((x) => x.i === i)) l.push({ i, c });
          byKey.set(k, l);
        }
    let best: { key: string; score: number; members: { i: number; c: WellCand }[] } | null = null;
    for (const [key, members] of byKey) {
      const n = members.length;
      const count = new Map<string, number>();
      for (const m of members) count.set(m.c.well, (count.get(m.c.well) ?? 0) + 1);
      const d = count.size;
      const strong = members.every((m) => m.c.strong);
      const rows = new Set(members.map((m) => m.c.row)).size;
      const cols = new Set(members.map((m) => m.c.col)).size;
      const in96 = members.every((m) => m.c.row < 8 && m.c.col < 12);
      const maxMult = Math.max(...count.values());
      const ok = strong ? true : d >= 3 && maxMult <= 8 && ((rows >= 2 && cols >= 2) || d >= 8) && (in96 || d >= 8);
      if (!ok) continue;
      // a position only of samples placed before: no new information
      if (!members.some((m) => m.i < names.length)) continue;
      const score = d * 4 + n + (strong ? 2 * n : 0) + (key.startsWith('W') || key.startsWith('P') ? 1 : 0) + (key.startsWith('R') ? 0.5 : 0);
      if (!best || score > best.score) best = { key, score, members };
    }
    if (!best) break;
    for (const m of best.members) if (m.i < names.length) out[m.i] = { well: m.c.well, start: m.c.start, end: m.c.end };
    left = new Set([...left].filter((i) => !best!.members.some((m) => m.i === i)));
  }
  return out;
}

// ------------------------------------------------------------------ plates in names

/** A plate named in a sample / file name: "Plate 2", "Plate_02", "Plt-3", "Plate B", CytExpert "02-Well-A1". */
export function namePlate(name: string, well?: { start: number; end: number }): { label: string; kind: 'plate' | 'p' } | null {
  let m = /^\s*(\d{1,3})-Well-[A-Pa-p]\d{1,3}(?![A-Za-z0-9])/i.exec(name);
  if (m) return { label: `Plate ${parseInt(m[1], 10)}`, kind: 'plate' };
  m = /(?:^|[^A-Za-z0-9])(?:plate|plt)[\s_\-#.]*0*(\d{1,4})(?![0-9])/i.exec(name);
  if (m) return { label: `Plate ${parseInt(m[1], 10)}`, kind: 'plate' };
  m = /(?:^|[^A-Za-z0-9])plate[\s_\-#]+([A-Za-z])(?![A-Za-z0-9])/i.exec(name);
  if (m) return { label: `Plate ${m[1].toUpperCase()}`, kind: 'plate' };
  // "P1", "P2": a plate when it is not the well (P1 to P24 are wells of a 384-well plate)
  const re = /(?<![A-Za-z0-9])P(\d{1,2})(?![A-Za-z0-9])/g;
  for (let p = re.exec(name); p; p = re.exec(name)) {
    if (well && p.index >= well.start && p.index < well.end) continue;
    return { label: `Plate ${parseInt(p[1], 10)}`, kind: 'p' };
  }
  return null;
}

/** Name tokens (split at delimiters) with the well token removed, for telling plates apart. */
function nameTokens(name: string, well?: { start: number; end: number }): string[] {
  const s = well ? name.slice(0, well.start) + ' ' + name.slice(well.end) : name;
  return s.split(/[\s_\-.()#,;+]+/).filter(Boolean);
}

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ------------------------------------------------------------------ plate assignment

export type WellSource = 'keyword' | 'name' | 'manual' | 'none';

export interface PlateInput {
  id: string;
  /** sample name (file name without extension; data sets of a file with several add "#3 A03") */
  name: string;
  fileName?: string;
  /** folder of the file relative to the folder opened ("Export/Plate 2"), if opened as a folder */
  folder?: string;
  keywords?: Record<string, string>;
  /** one of several data sets of its file (Guava: one file per plate) */
  multi?: boolean;
}

export interface Placement {
  well?: string;
  plate?: string;
  source: Exclude<WellSource, 'manual'>;
}

export interface PlacedWell {
  plate: string;
  well: string;
}

export interface AssignResult {
  placements: Map<string, Placement>;
  /** all plates: the existing ones (formats grown where needed) followed by the new ones */
  plates: PlateDef[];
  /** how plates were told apart when wells repeat (for a note to the user) */
  notes: string[];
}

interface Member {
  inp: PlateInput;
  well: string;
  source: 'keyword' | 'name';
  nameWell?: NameWell | null;
}

interface PGroup {
  key: string;
  label: string;
  /** experiment named by keywords (prefixed to labels that two plates share) */
  exp?: string;
  /** a plate named by keywords (id, number or name): repeated wells are kept (e.g. raw and unmixed file of a well) */
  identity: boolean;
  format?: PlateFormat;
  members: Member[];
}

/** Format holding the wells: a hint (keywords, the plate's format) when it fits, else 96 (or 384), or a completely used 24- / 48-well plate. */
export function formatForWells(wells: Iterable<string>, hint?: PlateFormat): PlateFormat {
  let maxR = -1;
  let maxC = -1;
  const set = new Set<string>();
  for (const w of wells) {
    const p = parseWell(w);
    if (!p) continue;
    set.add(w);
    maxR = Math.max(maxR, p.row);
    maxC = Math.max(maxC, p.col);
  }
  if (hint && maxR < hint.rows && maxC < hint.cols) return { ...hint };
  if (maxR < 8 && maxC < 12) {
    // all 24 (A1..D6) or 48 (A1..F8) wells used: that plate; fewer wells are a corner of a 96-well plate (a 6- or 12-well
    // plate needs keywords naming it, or the format chosen in the plate view)
    for (const f of PLATE_FORMATS)
      if ((f.wells === 24 || f.wells === 48) && maxR < f.rows && maxC < f.cols && set.size === f.wells) return { rows: f.rows, cols: f.cols };
    return { ...DEFAULT_FORMAT };
  }
  if (maxR < 16 && maxC < 24) return { rows: 16, cols: 24 };
  return { rows: Math.min(16, maxR + 1), cols: Math.min(24, maxC + 1) };
}

const hasRepeats = (ms: Member[]) => new Set(ms.map((m) => m.well)).size < ms.length;

/**
 * Tell apart the plates of a group whose wells repeat (no plate keywords, names or folders said which plate): by the
 * experiment or date keywords, then by a name token that differs between the plates (a date, a barcode), else in
 * the order of loading (each sample to the first plate where its well is free).
 */
function splitRepeats(g: PGroup, notes: string[]): PGroup[] {
  const ms = g.members;
  const tryBy = (val: (m: Member) => string | undefined, what: string): PGroup[] | null => {
    const vals = ms.map(val);
    if (vals.some((v) => !v)) return null;
    const by = new Map<string, Member[]>();
    ms.forEach((m, i) => by.set(vals[i]!, [...(by.get(vals[i]!) ?? []), m]));
    if (by.size < 2 || by.size > ms.length / 2 || [...by.values()].some(hasRepeats)) return null;
    notes.push(`plates told apart by ${what}`);
    return [...by.entries()].map(([v, list]) => ({ ...g, key: `${g.key}#${v}`, label: g.label ? `${g.label} ${v}` : v, members: list }));
  };
  for (const k of ['EXPERIMENT NAME', '$PROJ', '$DATE']) {
    const r = tryBy((m) => clean(m.inp.keywords?.[k]) || undefined, k === '$DATE' ? 'the date ($DATE)' : 'the experiment name');
    if (r) return r;
  }
  // a name token that differs between plates (same position from the left or right in every name)
  const toks = ms.map((m) => nameTokens(m.inp.name, m.nameWell ?? undefined));
  const minLen = Math.min(...toks.map((t) => t.length));
  for (let k = 0; k < Math.min(minLen, 6); k++)
    for (const fromRight of [false, true]) {
      const r = tryBy((m) => {
        const t = toks[ms.indexOf(m)];
        return fromRight ? t[t.length - 1 - k] : t[k];
      }, 'a part of the sample names');
      if (r) return r;
    }
  // in the order of loading
  const parts: Member[][] = [];
  for (const m of ms) {
    const p = parts.find((x) => !x.some((y) => y.well === m.well));
    if (p) p.push(m);
    else parts.push([m]);
  }
  notes.push('wells repeat without a plate name: plates assigned in the order the files were loaded');
  // (without any plate information the parts stay unkeyed: later files fill the first plate where their wells are free)
  return parts.map((list, i) => ({ ...g, key: g.key ? `${g.key}#${i + 1}` : '', label: g.label ? `${g.label} (${i + 1})` : '', members: list }));
}

/**
 * Which plate and well each input was measured in. Wells: keywords first, then the names (see wellsFromNames).
 * Plates: keywords (plate id / name / CytExpert plate number), else a plate named in the sample name, the folder (when
 * the files of different plates are in different folders), the file of a multi-data-set file, else one plate; wells
 * that repeat with nothing else to tell the plates apart are split (see splitRepeats). `existing`: plates of the
 * workspace (a group with the same key joins its plate; plates without a key take further samples whose wells are
 * free) and the wells taken there; `context` names inform the name pattern.
 */
export function assignPlates(inputs: PlateInput[], existing: { plates?: PlateDef[]; placed?: PlacedWell[]; contextNames?: string[] } = {}): AssignResult {
  const notes: string[] = [];
  const placements = new Map<string, Placement>();
  const kwWells = inputs.map((x) => keywordWell(x.keywords));
  const needName = inputs.map((_, i) => !kwWells[i]);
  const nameWells = wellsFromNames(
    inputs.filter((_, i) => needName[i]).map((x) => x.name),
    existing.contextNames ?? [],
  );
  const nameWellOf = new Map<number, NameWell | null>();
  let k = 0;
  inputs.forEach((_, i) => {
    if (needName[i]) nameWellOf.set(i, nameWells[k++]);
  });
  // even with a keyword well, the position of the well in the name (to find a plate token elsewhere in it)
  const members: Member[] = [];
  inputs.forEach((inp, i) => {
    const nw = needName[i] ? nameWellOf.get(i) ?? null : wellCandidates(inp.name).find((c) => c.well === kwWells[i]) ?? null;
    const well = kwWells[i] ?? nw?.well;
    if (!well) {
      placements.set(inp.id, { source: 'none' });
      return;
    }
    members.push({ inp, well, source: kwWells[i] ? 'keyword' : 'name', nameWell: nw });
  });
  // folders: when the files are in different folders, the part that differs names the plate
  const dirs = members.map((m) => (m.inp.folder ?? '').split('/').filter(Boolean));
  const dirKeys = new Set(dirs.map((d) => d.join('/')));
  let common = 0;
  if (dirKeys.size > 1) {
    const minD = Math.min(...dirs.map((d) => d.length));
    while (common < minD && dirs.every((d) => d[common] === dirs[0][common])) common++;
  }
  // "P1" / "P2" tokens are plates only when they differ between the samples
  const pTokens = new Set(members.map((m) => namePlate(m.inp.name, m.nameWell ?? undefined)).filter((p) => p?.kind === 'p').map((p) => p!.label));
  const namePlates = new Set(members.map((m) => namePlate(m.inp.name, m.nameWell ?? undefined)?.label ?? ''));
  const groups = new Map<string, PGroup>();
  members.forEach((m, i) => {
    const kp = keywordPlate(m.inp.keywords);
    let key: string;
    let label: string;
    let identity = false;
    const format = kp?.format;
    if (kp && kp.identity) {
      key = 'kw:' + kp.key;
      label = kp.label;
      identity = true;
    } else {
      const parts: string[] = [];
      const labels: string[] = [];
      if (kp) parts.push('kw:' + kp.key);
      const np = namePlate(m.inp.name, m.nameWell ?? undefined);
      if (np && (np.kind === 'plate' || pTokens.size > 1)) {
        parts.push('name:' + np.label);
        // (the same "Plate 1" in the names of all folders, e.g. CytExpert "01-Well-A1" in each experiment folder: the
        // folders name the plates)
        if (!(dirKeys.size > 1 && namePlates.size === 1)) labels.push(np.label);
      }
      const dir = dirs[i];
      if (dirKeys.size > 1) {
        const rest = dir.slice(common).join('/');
        parts.push('dir:' + dir.join('/'));
        if (rest) labels.push(prettyPlateName(rest));
      } else if (dir.length) parts.push('dir:' + dir.join('/'));
      if (m.inp.multi && m.inp.fileName) {
        const stem = m.inp.fileName.replace(/\.(fcs|lmd)$/i, '');
        parts.push('file:' + stem);
        labels.push(stem);
      }
      key = parts.join('|');
      label = labels.length ? labels.join(' / ') : kp?.label || (dir.length ? dir[dir.length - 1] : '');
    }
    const g = groups.get(key) ?? { key, label, identity, format, exp: kp?.exp, members: [] };
    g.members.push(m);
    if (!g.format && format) g.format = format;
    groups.set(key, g);
  });
  // repeated wells in a plate without a plate id: more than one plate
  let final: PGroup[] = [];
  for (const g of groups.values()) final.push(...(!g.identity && hasRepeats(g.members) ? splitRepeats(g, notes) : [g]));
  // plate names: an existing plate with the same key, else the label (unique), else "Plate N"
  const plates: PlateDef[] = (existing.plates ?? []).map((p) => ({ ...p }));
  const taken = new Set(plates.map((p) => p.name));
  const occupied = new Map<string, Set<string>>();
  for (const pw of existing.placed ?? []) {
    const s = occupied.get(pw.plate) ?? new Set<string>();
    s.add(pw.well);
    occupied.set(pw.plate, s);
  }
  const unique = (label: string) => {
    if (!taken.has(label)) return label;
    for (let n = 2; ; n++) if (!taken.has(`${label} (${n})`)) return `${label} (${n})`;
  };
  const nextNumbered = () => {
    for (let n = 1; ; n++) if (!taken.has(`Plate ${n}`)) return `Plate ${n}`;
  };
  // the same label for plates of different experiments ("Plate 1" of two runs): with the experiment name
  const labelCount = new Map<string, Set<string>>();
  for (const g of final) if (g.label) labelCount.set(g.label, (labelCount.get(g.label) ?? new Set()).add(g.key));
  for (const g of final) if (g.label && g.exp && labelCount.get(g.label)!.size > 1 && !g.label.includes(g.exp)) g.label = `${g.exp} ${g.label}`;
  // (plates in the order of their first sample: files are loaded in natural order, so Plate 2 before Plate 10, and the
  // first plate measured first)
  const before = new Set(plates.map((p) => p.name));
  const clash = (d: PlateDef, g: PGroup) => g.members.some((m) => occupied.get(d.name)?.has(m.well));
  for (const g of final) {
    let def = g.key ? plates.find((p) => p.key === g.key) : undefined;
    if (def && !g.identity && before.has(def.name) && clash(def, g)) {
      // a plate of an earlier load with these wells taken (a second experiment saved under the same names, e.g.
      // "01-Well-A1" again): a new plate, not two samples per well
      const taken0 = def.name;
      def = undefined;
      let n = 2;
      for (; ; n++) {
        const d = plates.find((p) => p.key === `${g.key}#${n}`);
        if (!d) break;
        if (!clash(d, g)) {
          def = d;
          break;
        }
      }
      if (!def) {
        const name = unique(g.label || taken0);
        def = { name, ...formatForWells(g.members.map((m) => m.well), g.format), key: `${g.key}#${n}` };
        plates.push(def);
        taken.add(name);
      }
      notes.push(`"${taken0}" already holds samples loaded before in these wells, so this is a new plate`);
    }
    if (!def && !g.key) {
      // no plate information at all: the first unkeyed plate where these wells are free
      const wells = g.members.map((m) => m.well);
      def = plates.find((p) => !p.key && !wells.some((w) => occupied.get(p.name)?.has(w)));
    }
    if (!def) {
      const name = g.label ? unique(g.label) : nextNumbered();
      def = { name, ...formatForWells(g.members.map((m) => m.well), g.format), ...(g.key ? { key: g.key } : {}) };
      plates.push(def);
      taken.add(name);
    }
    const occ = occupied.get(def.name) ?? new Set<string>();
    for (const m of g.members) {
      placements.set(m.inp.id, { well: m.well, plate: def.name, source: m.source });
      occ.add(m.well);
    }
    occupied.set(def.name, occ);
    // the format grows to hold the wells
    const f = formatForWells(occ, { rows: def.rows, cols: def.cols });
    if (f.rows > def.rows || f.cols > def.cols) {
      def.rows = Math.max(def.rows, f.rows);
      def.cols = Math.max(def.cols, f.cols);
    }
  }
  return { placements, plates, notes: [...new Set(notes)] };
}

// ------------------------------------------------------------------ the layout of a workspace

export interface PlateView {
  name: string;
  rows: number;
  cols: number;
  /** well -> sample ids (workspace order) */
  wells: Map<string, string[]>;
  def?: PlateDef;
}

export interface PlateLayout {
  plates: PlateView[];
  /** samples on no plate */
  unplaced: string[];
  /** placements computed for samples never placed (older workspaces), not stored yet */
  derived: Map<string, Placement>;
  /** plate definitions including those of derived placements */
  defs: PlateDef[];
}

/** What a workspace sample tells for plate assignment (keywords from its loaded file, if any). */
export function plateInputOf(s: Workspace['samples'][number], keywordsOf?: (id: string) => Record<string, string> | undefined): PlateInput {
  return {
    id: s.id,
    name: s.name,
    fileName: s.fileName,
    folder: s.info?.['Folder'],
    keywords: keywordsOf?.(s.id),
    multi: !!s.info?.['Data set'],
  };
}

/**
 * Plates and wells of the workspace's samples: as stored (SampleRef.well / plate), and for samples never placed (no
 * wellSource: workspaces saved before plates existed) as detected now (not stored until the user changes the plates).
 */
export function plateLayout(ws: Pick<Workspace, 'samples' | 'plates'>, keywordsOf?: (id: string) => Record<string, string> | undefined): PlateLayout {
  const lazy = ws.samples.filter((s) => s.wellSource === undefined);
  let derived = new Map<string, Placement>();
  let defs = (ws.plates ?? []).map((p) => p);
  if (lazy.length) {
    const placed = ws.samples.filter((s) => s.wellSource !== undefined && s.well && s.plate).map((s) => ({ plate: s.plate!, well: s.well! }));
    const r = assignPlates(
      lazy.map((s) => plateInputOf(s, keywordsOf)),
      { plates: ws.plates ?? [], placed, contextNames: ws.samples.filter((s) => s.wellSource === 'name').map((s) => s.name) },
    );
    derived = r.placements;
    defs = r.plates;
  }
  const where = (s: Workspace['samples'][number]): { plate?: string; well?: string } => (s.wellSource === undefined ? derived.get(s.id) ?? {} : { plate: s.plate, well: s.well });
  const views = new Map<string, PlateView>();
  for (const d of defs) views.set(d.name, { name: d.name, rows: d.rows, cols: d.cols, wells: new Map(), def: d });
  const unplaced: string[] = [];
  for (const s of ws.samples) {
    const p = where(s);
    const w = normWell(p.well);
    if (!w) {
      unplaced.push(s.id);
      continue;
    }
    const name = p.plate || 'Plate 1';
    let v = views.get(name);
    if (!v) {
      v = { name, ...DEFAULT_FORMAT, wells: new Map() };
      views.set(name, v);
    }
    const l = v.wells.get(w) ?? [];
    l.push(s.id);
    v.wells.set(w, l);
  }
  // formats hold their wells (a damaged or outdated definition)
  for (const v of views.values()) {
    if (!v.wells.size) continue;
    const f = formatForWells(v.wells.keys(), { rows: v.rows, cols: v.cols });
    v.rows = Math.max(v.rows, f.rows);
    v.cols = Math.max(v.cols, f.cols);
  }
  // plates without samples are shown when they carry a layout (annotations)
  const plates = [...views.values()].filter((v) => v.wells.size > 0 || Object.keys(v.def?.annotations ?? {}).length > 0);
  return { plates, unplaced, derived, defs };
}

// ------------------------------------------------------------------ selection

/** Wells of the rectangle spanned by two wells, row by row. */
export function wellsBetween(a: string, b: string): string[] {
  const p = parseWell(a);
  const q = parseWell(b);
  if (!p || !q) return [];
  const out: string[] = [];
  for (let r = Math.min(p.row, q.row); r <= Math.max(p.row, q.row); r++) for (let c = Math.min(p.col, q.col); c <= Math.max(p.col, q.col); c++) out.push(wellId(r, c));
  return out;
}

export const rowWells = (f: PlateFormat, row: number) => Array.from({ length: f.cols }, (_, c) => wellId(row, c));
export const colWells = (f: PlateFormat, col: number) => Array.from({ length: f.rows }, (_, r) => wellId(r, col));
export const allWells = (f: PlateFormat) => Array.from({ length: f.rows * f.cols }, (_, i) => wellId(Math.floor(i / f.cols), i % f.cols));

/** Samples of the given wells of a plate, in reading order (A01, A02, ... B01 ...). */
export function samplesIn(p: PlateView, wells: Iterable<string>): string[] {
  const set = new Set(wells);
  const out: string[] = [];
  for (const w of allWells(p)) if (set.has(w)) out.push(...(p.wells.get(w) ?? []));
  return out;
}

export interface PlateSel {
  selected: string[];
  active: string | null;
}

/**
 * New sample selection after picking wells: 'set' replaces the selection, 'add' adds, 'toggle' removes the wells'
 * samples when all are selected, else adds them. `focus`: the well clicked (its first sample becomes active when it
 * has one; a removed active sample hands over to the last one still selected).
 */
export function pickWells(prev: PlateSel, p: PlateView, wells: string[], mode: 'set' | 'add' | 'toggle', focus?: string): PlateSel {
  const ids = samplesIn(p, wells);
  const cur = prev.selected.length ? prev.selected : prev.active ? [prev.active] : [];
  let selected: string[];
  let removing = false;
  if (mode === 'set') selected = ids;
  else if (mode === 'toggle' && ids.length && ids.every((id) => cur.includes(id))) {
    removing = true;
    selected = cur.filter((id) => !ids.includes(id));
  } else selected = [...cur, ...ids.filter((id) => !cur.includes(id))];
  let active = prev.active;
  const focusIds = focus ? p.wells.get(focus) ?? [] : [];
  if (!removing && focusIds.length) active = focusIds[0];
  else if (!removing && mode === 'set' && ids.length && !(active && ids.includes(active))) active = ids[0];
  else if (removing && active && !selected.includes(active)) active = selected[selected.length - 1] ?? active;
  return { selected, active };
}

/** The well `steps` away in a direction, clamped to the plate. */
export function stepWell(f: PlateFormat, well: string, dr: number, dc: number): string {
  const p = parseWell(well) ?? { row: 0, col: 0 };
  return wellId(Math.min(f.rows - 1, Math.max(0, p.row + dr)), Math.min(f.cols - 1, Math.max(0, p.col + dc)));
}

/**
 * The next well holding samples in a direction (arrow keys): along the row / column, continuing on the next row /
 * column at the edge (reading order); null when there is none.
 */
export function nextOccupied(p: PlateView, well: string, dr: number, dc: number): string | null {
  const s = parseWell(well);
  if (!s) return null;
  const order = dc !== 0 ? allWells(p) : Array.from({ length: p.rows * p.cols }, (_, i) => wellId(i % p.rows, Math.floor(i / p.rows)));
  let i = order.indexOf(wellId(s.row, s.col));
  const d = dr + dc > 0 ? 1 : -1;
  for (i += d; i >= 0 && i < order.length; i += d) if (p.wells.get(order[i])?.length) return order[i];
  return null;
}

/** The well of a sample on a plate (first one), if any. */
export function wellOfSample(p: PlateView, sampleId: string): string | null {
  for (const [w, ids] of p.wells) if (ids.includes(sampleId)) return w;
  return null;
}

// ------------------------------------------------------------------ heatmap values

export interface WellCell {
  well: string;
  samples: string[];
  /** mean of the samples' values; null: not applicable to any of them (n/a), NaN: no value */
  value: number | null;
}

/**
 * Cells of a plate ([row][col]) with the value of each well: the statistic of its sample (mean when several samples
 * share the well). `valueOf`: null = not applicable (n/a), NaN = no value; undefined = not computed yet (pending).
 */
export function plateCells(p: PlateView, valueOf: (sampleId: string) => number | null | undefined): { cells: WellCell[][]; pending: number } {
  let pending = 0;
  const cells: WellCell[][] = [];
  for (let r = 0; r < p.rows; r++) {
    const row: WellCell[] = [];
    for (let c = 0; c < p.cols; c++) {
      const well = wellId(r, c);
      const samples = p.wells.get(well) ?? [];
      let value: number | null = null;
      if (samples.length) {
        const vals = samples.map(valueOf);
        pending += vals.filter((v) => v === undefined).length;
        const nums = vals.filter((v): v is number => typeof v === 'number');
        const fin = nums.filter((v) => Number.isFinite(v));
        value = fin.length ? fin.reduce((a, b) => a + b, 0) / fin.length : nums.length ? NaN : null;
      }
      row.push({ well, samples, value });
    }
    cells.push(row);
  }
  return { cells, pending };
}

/** Value range of cells (finite values; `fixed` overrides), null when there is none. A flat range is widened. */
export function cellRange(cellSets: WellCell[][][], fixed?: [number, number] | null): [number, number] | null {
  if (fixed && Number.isFinite(fixed[0]) && Number.isFinite(fixed[1]) && fixed[1] > fixed[0]) return fixed;
  let lo = Infinity;
  let hi = -Infinity;
  for (const cells of cellSets)
    for (const row of cells)
      for (const c of row)
        if (c.value !== null && Number.isFinite(c.value)) {
          lo = Math.min(lo, c.value);
          hi = Math.max(hi, c.value);
        }
  if (!(hi >= lo)) return null;
  if (hi === lo) return [lo - (Math.abs(lo) || 1) * 0.5, hi + (Math.abs(hi) || 1) * 0.5];
  return [lo, hi];
}

/** Position of a value in the range (0..1, clamped). */
export const rangeT = (v: number, r: [number, number]) => Math.min(1, Math.max(0, (v - r[0]) / (r[1] - r[0])));

/** Decimals for a statistic: counts are whole numbers. */
export const statDecimals = (stat: { stat: string }, decimals: number | undefined) => (stat.stat === 'count' ? 0 : decimals ?? 1);

/** Value text with a fixed number of decimals ("12.3"); "" for no value. */
export function fmtValue(v: number | null, decimals: number): string {
  if (v === null || !Number.isFinite(v)) return '';
  const d = Math.max(0, Math.min(6, Math.round(decimals)));
  const a = Math.abs(v);
  // large values (counts, MFI) without decimals that only add noise; very large ones in exponent form
  if (a >= 1e7) return v.toExponential(Math.min(d, 2));
  return v.toFixed(a >= 1e4 ? 0 : d);
}

/** A number in 3 significant digits and a unit (the same precision for all): 950, 2.57k, 16.5k, 41.0k, 100k, 1.23M. */
export function compactNumber(v: number): string {
  const a = Math.abs(v);
  if (a < 999.5) return String(Math.round(v));
  for (const [d, unit] of [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
  ] as const)
    if (a >= d * 0.9995) return (v / d).toPrecision(3) + unit;
  return String(Math.round(v));
}

/**
 * A value written in a well, the same way for all wells of a heatmap (its color range `range`): plates with values of
 * 10,000 and more in short form (2.57k, 16.5k, 100k: a well holds 5 characters), of 1,000 and more without decimals,
 * else with the decimals chosen. Tooltips and exports keep the full value (fmtValue).
 */
export function fmtWellValue(v: number | null, decimals: number, range?: [number, number] | null): string {
  if (v === null || !Number.isFinite(v)) return '';
  const top = range ? Math.max(Math.abs(range[0]), Math.abs(range[1]), Math.abs(v)) : Math.abs(v);
  if (top >= 1e4) return compactNumber(v);
  if (top >= 1e3) return v.toFixed(0);
  return fmtValue(v, decimals);
}

// ------------------------------------------------------------------ export

export type Cell = string | number | null;

/**
 * Export tables of plate heatmaps: `layout` = per plate a block (title row, column numbers, one row per plate row,
 * values; empty for no value or n/a, means for shared wells), blocks separated by an empty row; `long` = one row per
 * sample (plate, well, sample, value, then the annotation keys).
 */
export function plateExportTables(
  plates: PlateView[],
  valueOf: (sampleId: string) => number | null | undefined,
  statLabel: string,
  sampleName: (id: string) => string,
  annotationKeys: string[] = [],
): { layout: Cell[][]; long: Cell[][] } {
  const layout: Cell[][] = [];
  const num = (v: number | null | undefined): Cell => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  plates.forEach((p, i) => {
    if (i) layout.push([]);
    layout.push([`Plate: ${p.name}`, statLabel]);
    layout.push(['', ...Array.from({ length: p.cols }, (_, c) => c + 1)]);
    const { cells } = plateCells(p, valueOf);
    cells.forEach((row, r) => layout.push([ROW_LETTERS[r], ...row.map((c) => num(c.value))]));
  });
  const long: Cell[][] = [['Plate', 'Well', 'Sample', statLabel, ...annotationKeys]];
  for (const p of plates)
    for (const w of allWells(p))
      for (const id of p.wells.get(w) ?? []) {
        const ann = p.def?.annotations?.[w] ?? {};
        long.push([p.name, w, sampleName(id), num(valueOf(id)), ...annotationKeys.map((k) => ann[k] ?? '')]);
      }
  return { layout, long };
}

/** CSV text of rows (RFC 4180 quoting; numbers in full precision, empty cells for null). */
export function csvText(rows: Cell[][]): string {
  const cell = (v: Cell) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}

// ------------------------------------------------------------------ plate layouts (annotations)

/** Annotation keys used on any plate, in order of first use. */
/**
 * A sample name without its plate number and well: what was typed for the tube, e.g. CytExpert "02-Liposomes stained-C1"
 * -> "Liposomes stained", "01-Donor 3-A1" -> "Donor 3", an FCMPASS export "02-Beads sized-A4 FCMPASS" ->
 * "Beads sized". CytExpert's default tube name ("02-Well-B7") gives '' (no description). Names without a
 * plate number or well are returned as they are (trimmed).
 * @param well the sample's well (e.g. "A04"): only this well is removed; without it, any well-like last part
 */
export function tubeName(name: string, well?: string | null): string {
  let s = name.trim();
  const p = well ? parseWell(well) : null;
  // the well: the sample's own (any case, also after a space), else only an upper-case well after "-" or "_"
  // ("EV d7" keeps its "d7", "Donor A1" its "A1")
  const m = p
    ? s.match(new RegExp(`^(.*\\S)[-_ ]+(?:${ROW_LETTERS[p.row]}0?${p.col + 1})(?:[-_ ][^-_]*)?$`, 'i'))
    : s.match(/^(.*\S)[-_]+[A-P]0?\d{1,2}(?:[-_ ][^-_]*)?$/);
  if (m) {
    s = m[1];
    // the plate number in front ("02-"), only together with a well and only before "-" / "_" ("200 nm beads" stays)
    s = s.replace(/^\d{1,3}[-_]+(?=\S)/, '');
  }
  s = s.trim();
  return /^well$/i.test(s) ? '' : s;
}

export function annotationKeys(plates: Pick<PlateDef, 'annotations'>[]): string[] {
  const out: string[] = [];
  for (const p of plates) for (const a of Object.values(p.annotations ?? {})) for (const k of Object.keys(a)) if (!out.includes(k)) out.push(k);
  return out;
}

/** Distinct values of an annotation key and the samples in wells with each value (all plates), values in natural order. */
export function annotationGroups(plates: PlateView[], key: string): { value: string; sampleIds: string[]; wells: number }[] {
  const by = new Map<string, { ids: string[]; wells: number }>();
  for (const p of plates)
    for (const [w, a] of Object.entries(p.def?.annotations ?? {})) {
      const v = a[key];
      if (v === undefined || v === '') continue;
      const e = by.get(v) ?? { ids: [], wells: 0 };
      e.wells++;
      for (const id of p.wells.get(w) ?? []) if (!e.ids.includes(id)) e.ids.push(id);
      by.set(v, e);
    }
  // numbers by value (0.125, 0.25, 0.5, 1 ...: a dilution series), else in natural order (Donor 2 before Donor 10)
  const num = (v: string) => (/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(v) ? parseFloat(v) : NaN);
  const allNum = [...by.keys()].every((v) => Number.isFinite(num(v)));
  return [...by.entries()]
    .sort((a, b) => (allNum ? num(a[0]) - num(b[0]) : natural.compare(a[0], b[0])))
    .map(([value, e]) => ({ value, sampleIds: e.ids, wells: e.wells }));
}
