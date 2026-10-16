// Pure helpers of the spectral unmixing view: detector grouping by laser, control / unstained name heuristics,
// spectra CSV import / export, complexity interpretation, definition comparison and plot planning.
import type { UnmixDef } from '../../core/unmix';

// ------------------------------------------------------------------ detectors by laser

export type LaserId = 'UV' | 'V' | 'B' | 'G' | 'YG' | 'Y' | 'R' | 'IR' | 'other';

export const LASERS: { id: LaserId; label: string }[] = [
  { id: 'UV', label: 'Ultraviolet' },
  { id: 'V', label: 'Violet' },
  { id: 'B', label: 'Blue' },
  { id: 'G', label: 'Green' },
  { id: 'YG', label: 'Yellow-green' },
  { id: 'Y', label: 'Yellow' },
  { id: 'R', label: 'Red' },
  { id: 'IR', label: 'Infrared' },
  { id: 'other', label: 'Other' },
];

/** Laser of an excitation wavelength in nm (FCS 3.1 $PnL). */
export function laserOfWavelength(nm: number): LaserId {
  if (!(nm > 0)) return 'other';
  if (nm < 380) return 'UV';
  if (nm < 450) return 'V';
  if (nm < 520) return 'B';
  if (nm < 545) return 'G';
  if (nm < 580) return 'YG';
  if (nm < 610) return 'Y';
  if (nm < 700) return 'R';
  return 'IR';
}

/**
 * Laser of a detector from its name. Detector-coded names (CytoFLEX "V7-A", Aurora "YG3-A", Symphony "B530-A",
 * Attune "BL1-A") use their letter prefix; fluorochrome-named detectors (BD "BV421-A", "PE-Cy7-A", "Alexa Fluor 647-A")
 * use the fluorochrome's usual laser. Unknown names: 'other'.
 */
export function laserOf(name: string, wavelength?: number): LaserId {
  if (wavelength && wavelength > 0) return laserOfWavelength(wavelength);
  const n = name.replace(/[\s_-]+[AHW]$/i, '').trim();
  const m = /^(UV|IR|YG|U|V|B|G|Y|R)L?[\s_-]?(\d{1,3})([\s_/-]\d+)?$/i.exec(n);
  if (m) {
    const p = m[1].toUpperCase();
    return (p === 'U' ? 'UV' : p) as LaserId;
  }
  const f = n.toUpperCase();
  if (/^BUV|^UV\d|INDO|DAPI|HOECHST|ALEXA ?FLUOR ?350|^AF ?350|^BUV/.test(f)) return 'UV';
  if (/^BV\d|^SB ?\d|SUPER ?BRIGHT|PACIFIC|^PB ?\d|^KO ?\d|KROME|ALEXA ?FLUOR ?4(05|30)|^AF ?4(05|30)|HORIZON|^V ?\d{3}|VIOLET|AMCYAN|QDOT|^QD ?\d|EFLUOR ?450|^EF ?450|AQUA|ZOMBIE|^BV/.test(f)) return 'V';
  if (/^APC|ALEXA ?FLUOR ?(633|647|660|680|700|750)|^AF ?(633|647|660|680|700|750)|^CY5|^R ?7\d\d|DRAQ|^RL?\d|^EF ?660|EFLUOR ?660|SPARK ?NIR|NIR/.test(f)) return 'R';
  if (/FITC|GFP|ALEXA ?FLUOR ?488|^AF ?488|^BB ?\d|PERCP|^PC ?5\.5|7-?AAD|^PI$|PROPIDIUM|CFSE|^RB ?\d|SPARK ?BLUE|^NFB/.test(f)) return 'B';
  if (/^PE\b|^PE[-_ ]|^ECD|^PC ?5\b|^PC ?7|MCHERRY|RFP|TEXAS ?RED|ALEXA ?FLUOR ?(532|546|555|568|594)|DSRED|TOMATO|^RY ?\d/.test(f)) return 'YG';
  if (/ALEXA ?FLUOR ?790|IRDYE|^IR/.test(f)) return 'IR';
  return 'other';
}

export interface DetectorGroup {
  id: LaserId;
  label: string;
  detectors: string[];
}

/** Detectors grouped by laser (laser order UV, violet, blue ... infrared, other); order within a group is kept. */
export function groupDetectors(names: string[], wavelengths: Record<string, number> = {}): DetectorGroup[] {
  const by = new Map<LaserId, string[]>();
  for (const n of names) {
    const l = laserOf(n, wavelengths[n]);
    if (!by.has(l)) by.set(l, []);
    by.get(l)!.push(n);
  }
  return LASERS.filter((l) => by.has(l.id)).map((l) => ({ id: l.id, label: l.label, detectors: by.get(l.id)! }));
}

/** Excitation wavelengths per channel from FCS 3.1 $PnL keywords (first wavelength if several). */
export function channelWavelengths(keywords: Record<string, string>, channelNames: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  channelNames.forEach((n, i) => {
    const v = parseFloat((keywords[`$P${i + 1}L`] ?? '').split(',')[0]);
    if (v > 200 && v < 1200) out[n] = v;
  });
  return out;
}

/** Candidate detectors of a sample for unmixing: no scatter, time, width or event-count channels (heights only on request). */
export function detectorCandidates(channelNames: string[], includeHeightWidth = false): string[] {
  return channelNames.filter((n) => {
    if (/^(FSC|SSC|FS|SS)([\s_-]|$)|SSC|FSC|^Time$|^Event|^Sort|^Index|^Width$|Width$/i.test(n)) return false;
    if (!includeHeightWidth && /-[HW]$/i.test(n)) return false;
    return true;
  });
}

// ------------------------------------------------------------------ sample name heuristics

/** Unstained / blank / autofluorescence controls. */
export function looksLikeUnstained(name: string): boolean {
  const s = name.replace(/\.(fcs|lmd)$/i, '');
  return /unstain|(^|[\s_-])unst([\s_\-\d]|$)|blank|no[\s_-]*stain|autofluo|(^|[\s_-])AF([\s_-]+(ctrl|control|only|cells?)\b|$)|(^|[\s_-])(neg|negative)([\s_\-\d]|$)|(^|[\s_-])US([\s_\-\d]|$)/i.test(s);
}

/** Single-stained controls: "Compensation-FITC", "Beads20_BV711", "CD3 BV421 single stain", "SS_PE", "Ref PE-Cy7" ... */
export function looksLikeControl(name: string): boolean {
  if (looksLikeUnstained(name)) return false;
  const s = name.replace(/\.(fcs|lmd)$/i, '');
  return /(^|[\s_-])(comp(ensation)?|single[\s_-]*stain(ed)?|single|ss|stained|beads?|ctrls?|controls?|ref(erence)?s?)([\s_\-\d(]|$)/i.test(s);
}

// ------------------------------------------------------------------ spectra CSV

export interface SpectraTable {
  detectors: string[];
  endmembers: { name: string; signature: number[] }[];
  warnings: string[];
}

function csvCell(s: string): string {
  return /[",;\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '';
  return String(Number(v.toPrecision(6)));
}

/** CSV with one row per detector and one column per endmember (normalized signatures). */
export function spectraToCsv(detectors: string[], endmembers: { name: string; signature: number[] }[]): string {
  const lines = [['Detector', ...endmembers.map((e) => e.name)].map(csvCell).join(',')];
  detectors.forEach((d, i) => lines.push([csvCell(d), ...endmembers.map((e) => fmtNum(e.signature[i]))].join(',')));
  return lines.join('\n') + '\n';
}

/**
 * Spillover spreading matrix (and leakage) after unmixing as CSV: one row per control (the endmember that spreads),
 * one column per unmixed channel (the channel it spreads into). Empty cells: not measured (diagonal, missing control).
 */
export function spreadToCsv(names: string[], rows: number[], ssm: number[][], leakage: number[][]): string {
  const cell = (v: number) => (Number.isFinite(v) ? String(Number(v.toPrecision(6))) : '');
  const block = (title: string, m: number[][]) => [
    [title, ...names].map(csvCell).join(','),
    ...rows.map((i) => [csvCell(names[i]), ...names.map((_, j) => (j === i ? '' : cell(m[i]?.[j])))].join(',')),
  ];
  return [...block('Spreading (row spreads into column)', ssm), '', ...block('Leakage (row into column)', leakage)].join('\n') + '\n';
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const looksDetector = (s: string) => /-[AHW]$/i.test(s) || laserOf(s) !== 'other';

/** Size limits of a spectra table (rows or columns; detectors). */
export const MAX_SPECTRA_ROWS = 5000;
export const MAX_DETECTORS = 2000;

/**
 * Parse reference spectra from CSV (comma, semicolon or tab separated; decimal commas with semicolons).
 * Accepts detectors x endmembers (rows = detectors, as written by spectraToCsv) or the transpose; the orientation is
 * chosen by matching row and column labels against `knownDetectors` (else by detector-like names). Signatures are
 * normalised to max = 1. Throws on malformed input.
 */
export function parseSpectraCsv(text: string, knownDetectors: string[] = []): SpectraTable {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() && !/^\s*#/.test(l));
  if (lines.length < 2) throw new Error('The file has no data rows');
  // one row per detector or per spectrum: far fewer than this (and no spread of huge arrays below)
  if (lines.length > MAX_SPECTRA_ROWS + 1)
    throw new Error(`The file has ${lines.length.toLocaleString('en-US')} rows; a spectra table has one row per detector or per fluorochrome (at most ${MAX_SPECTRA_ROWS}). Is it the right file?`);
  const first = lines[0];
  const count = (c: string) => first.split(c).length - 1;
  const sep = count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows = lines.map((l) => splitCsvLine(l, sep));
  let width = 0;
  for (const r of rows) if (r.length > width) width = r.length;
  if (width > MAX_SPECTRA_ROWS + 1) throw new Error(`The file has ${width.toLocaleString('en-US')} columns; a spectra table has one column per detector or per fluorochrome (at most ${MAX_SPECTRA_ROWS}).`);
  if (width < 2) throw new Error('Expected at least two columns (detector and one spectrum)');
  const header = rows[0];
  const body = rows.slice(1);
  const rowLabels = body.map((r) => r[0] ?? '');
  const colLabels = header.slice(1);
  const known = new Set(knownDetectors.map((d) => d.toLowerCase()));
  const score = (labels: string[]) => labels.filter((l) => (known.size ? known.has(l.toLowerCase()) : looksDetector(l))).length;
  const transposed = score(colLabels) > score(rowLabels);
  const num = (s: string, where: string) => {
    const t = sep === ';' ? s.replace(',', '.') : s;
    if (t === '') return 0;
    const v = Number(t);
    if (!Number.isFinite(v)) throw new Error(`${where}: "${s}" is not a number`);
    return v;
  };
  const warnings: string[] = [];
  let detectors: string[];
  let names: string[];
  let values: number[][]; // [endmember][detector]
  if (!transposed) {
    detectors = rowLabels;
    names = colLabels;
    values = names.map((_, k) => body.map((r, d) => num(r[k + 1] ?? '', `${detectors[d]}, ${names[k]}`)));
  } else {
    detectors = colLabels;
    names = rowLabels;
    values = body.map((r, k) => detectors.map((det, d) => num(r[d + 1] ?? '', `${names[k]}, ${det}`)));
  }
  if (detectors.some((d) => !d)) throw new Error('Every detector needs a name');
  const dup = detectors.find((d, i) => detectors.indexOf(d) !== i);
  if (dup) throw new Error(`Detector "${dup}" appears twice`);
  if (detectors.length > MAX_DETECTORS) throw new Error(`${detectors.length} detectors: at most ${MAX_DETECTORS} are supported`);
  const endmembers = names.map((n, k) => {
    const v = values[k];
    let mx = -Infinity;
    for (const x of v) if (x > mx) mx = x;
    if (!(mx > 0)) throw new Error(`Spectrum "${n || k + 1}" has no positive values`);
    if (Math.abs(mx - 1) > 1e-3) warnings.push(`"${n}" normalised to a maximum of 1`);
    return { name: n || `Spectrum ${k + 1}`, signature: v.map((x) => x / mx) };
  });
  if (!endmembers.length) throw new Error('No spectra found');
  return { detectors, endmembers, warnings };
}

/** Name of an imported spectrum that represents autofluorescence. */
export function isAfName(name: string): boolean {
  return /^(af|autofluorescence)[\s_-]*\d{0,2}$/i.test(name.trim());
}

// ------------------------------------------------------------------ quality interpretation

export interface ComplexityInfo {
  level: 'low' | 'moderate' | 'high' | 'very high' | 'singular' | 'none';
  text: string;
}

export function complexityInfo(ci: number): ComplexityInfo {
  if (Number.isNaN(ci)) return { level: 'none', text: 'Add at least one control to compute the complexity index.' };
  if (!Number.isFinite(ci)) return { level: 'singular', text: 'Singular: a signature is a combination of the others, so these fluorochromes cannot be unmixed together.' };
  if (ci <= 5) return { level: 'low', text: 'Low: the signatures are well separated; unmixing adds little spread.' };
  if (ci <= 20) return { level: 'moderate', text: 'Moderate: typical for panels with some overlapping fluorochromes; expect spreading between the most similar pairs.' };
  if (ci <= 50) return { level: 'high', text: 'High: similar fluorochromes will spread into each other. Put co-expressed or dim markers on dissimilar fluorochromes.' };
  return { level: 'very high', text: 'Very high: strong spreading expected. Check the most similar pairs and consider replacing one fluorochrome of each.' };
}

// ------------------------------------------------------------------ definitions

function sameNums(a: number[] | undefined, b: number[] | undefined, tol: number): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) <= tol)) return false;
  return true;
}

/** Whether two definitions unmix identically (names, detectors, method, signatures within `tol`). */
export function defsEquivalent(a: UnmixDef, b: UnmixDef, tol = 1e-6): boolean {
  if (a.name !== b.name || a.method !== b.method || (a.residual ?? 'none') !== (b.residual ?? 'none')) return false;
  if (!!a.nonNegative !== !!b.nonNegative) return false;
  if (a.detectors.join('\n') !== b.detectors.join('\n')) return false;
  if (a.endmembers.length !== b.endmembers.length) return false;
  for (let i = 0; i < a.endmembers.length; i++) {
    if (a.endmembers[i].name !== b.endmembers[i].name) return false;
    if (!sameNums(a.endmembers[i].signature, b.endmembers[i].signature, tol)) return false;
  }
  const afA = a.includeAF ? a.af ?? [] : [];
  const afB = b.includeAF ? b.af ?? [] : [];
  if (afA.length !== afB.length) return false;
  if (afA.length > 1 && (a.afMode ?? 'best') !== (b.afMode ?? 'best')) return false;
  for (let i = 0; i < afA.length; i++) if (!sameNums(afA[i].signature, afB[i].signature, tol)) return false;
  return true;
}

/**
 * Display range of each output of unmixOutputNames(def): an endmember's range is that of its peak detector (abundances
 * are in peak-detector units), "AF Index" ranges over the AF signatures, the residual over the largest detector range.
 */
export function unmixOutputRanges(def: UnmixDef, rangeOf: (detector: string) => number): number[] {
  const D = def.detectors;
  const maxR = Math.max(1, ...D.map(rangeOf).filter((r) => r > 0));
  const peakRange = (sig: number[], peak?: number) => {
    let p = peak ?? 0;
    if (peak === undefined) for (let i = 1; i < sig.length; i++) if (sig[i] > sig[p]) p = i;
    const r = rangeOf(D[p]);
    return r > 0 ? r : maxR;
  };
  const out = def.endmembers.map((e) => peakRange(e.signature, e.peak));
  const afs = def.includeAF ? def.af ?? [] : [];
  if (afs.length) {
    if (afs.length > 1 && (def.afMode ?? 'best') === 'best') out.push(Math.max(...afs.map((a) => peakRange(a.signature, a.peak))), afs.length);
    else out.push(...afs.map((a) => peakRange(a.signature, a.peak)));
  }
  const res = def.residual ?? 'none';
  if (res !== 'none') out.push(res === 'ssr' ? maxR * maxR : maxR);
  return out;
}

/**
 * For each endmember, the other endmembers to plot it against: the most similar first (where unmixing errors and
 * spreading show), at most `max`.
 */
export function plotPartners(similarity: number[][], max = 5): number[][] {
  return similarity.map((row, i) =>
    row
      .map((s, j) => ({ s, j }))
      .filter((x) => x.j !== i)
      .sort((a, b) => b.s - a.s || a.j - b.j)
      .slice(0, max)
      .map((x) => x.j),
  );
}

/** Evenly strided subset of at most `max` indices (deterministic). */
export function capIndices(idx: ArrayLike<number>, max: number): Uint32Array {
  const n = idx.length;
  if (n <= max) return Uint32Array.from(idx);
  const out = new Uint32Array(max);
  const step = n / max;
  for (let i = 0; i < max; i++) out[i] = idx[Math.floor(i * step)];
  return out;
}

/** Unique name among `taken` ("PE", "PE 2", ...). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  if (!t.has(base)) return base;
  let i = 2;
  while (t.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}
