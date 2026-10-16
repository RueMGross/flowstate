// Compensation matrix files of other programs: import (delimited text, FlowJo matrix XML, CytExpert .comp) and export
// (tab-separated text / CSV). Matrices are spillover matrices as fractions, [fluorochrome][detector] (see CompDef).
//
// Delimited text (FlowLogic TXT, FlowJo / FCS Express / Excel tables; the FlowLogic layout is not documented):
//   - delimiter: tab, semicolon or comma (whitespace as a last resort); a decimal comma is accepted with tab / semicolon
//   - header row of channel names, with or without a leading corner cell; optional first column of names; a table
//     without any names is rejected (the detectors cannot be known)
//   - percent or fractions, by the diagonal (100 or 1; spill above 1 is real, e.g. BD PE-Cy5 -> PerCP-Cy5.5); see toFractions
//   - rows = fluorochromes. Transposed when the corner cell says so ("Detector \ Fluor") or, failing that, when the
//     detector wavelengths in the names show the spill going mainly to shorter wavelengths (spillover goes mainly to
//     longer ones); each correction is reported in the notes
//   - a compensation matrix (the inverse of the spillover: diagonal 1, negative off-diagonal values) is inverted
import { invertMatrix } from './compensation';
import { parseCytExpertComp, isNrbf } from './nrbf';
import { childrenNamed, child, descendants, parseXml } from './xml';

export interface ChannelRef {
  name: string;
  label?: string;
}

/** A matrix read from a file, before its names are matched to the workspace channels. */
export interface RawMatrix {
  name?: string;
  names: string[];
  /** spillover [fluorochrome][detector], fractions */
  matrix: number[][];
  notes: string[];
}

// ------------------------------------------------------------------ delimited text

const BOM = /^﻿/;

/** Split one line of delimited text (quoted cells with "" escapes). */
export function splitLine(line: string, delim: string): string[] {
  if (!line.includes('"')) return delim === ' ' ? line.trim().split(/\s+/) : line.split(delim);
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
    else if (c === delim || (delim === ' ' && /\s/.test(c))) {
      if (delim !== ' ' || cur !== '') out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Delimiter of a table from its first lines: tab, semicolon, comma, else whitespace. */
export function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 20);
  const count = (d: string) => sample.reduce((a, l) => a + (l.split(d).length - 1), 0);
  for (const d of ['\t', ';']) if (count(d) >= sample.length) return d;
  if (count(',') >= sample.length) return ',';
  if (count('\t') > 0) return '\t';
  if (count(';') > 0) return ';';
  if (count(',') > 0) return ',';
  return ' ';
}

/** A number cell: "0.012", "1,2" (decimal comma, unless the delimiter is a comma), "1.2 %", "1e-3"; NaN otherwise. */
export function parseNumberCell(s: string, delim: string): number {
  let t = s.trim();
  if (!t) return NaN;
  if (t.endsWith('%')) t = t.slice(0, -1).trim();
  if (delim !== ',' && t.includes(',') && !t.includes('.')) t = t.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return NaN;
  return Number(t);
}

export function tableLines(text: string): string[] {
  return text
    .replace(BOM, '')
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
}

/** Rows of cells, trailing empty cells removed (a delimiter at the end of the line). */
function tableCells(lines: string[], delim: string): string[][] {
  return lines.map((l) => {
    const c = splitLine(l, delim).map((x) => x.trim());
    while (c.length > 1 && c[c.length - 1] === '') c.pop();
    return c;
  });
}

const isNum = (s: string, d: string) => Number.isFinite(parseNumberCell(s, d));

/** Emission wavelength (nm) suggested by a channel name: "B531", "BL1 525/40", "FITC-A"... (NaN if unknown). */
const FLUOR_NM: [RegExp, number][] = [
  [/BUV\s?395/i, 395], [/BUV\s?496/i, 496], [/BUV\s?563/i, 563], [/BUV\s?615/i, 615], [/BUV\s?661/i, 661], [/BUV\s?737/i, 737], [/BUV\s?805/i, 805],
  [/BV\s?421|pacific\s?blue|V450|DAPI|hoechst/i, 425], [/BV\s?480/i, 480], [/BV\s?510|V500|pacific\s?orange|aqua/i, 510], [/BV\s?570/i, 570], [/BV\s?605/i, 605], [/BV\s?650/i, 650], [/BV\s?711/i, 711], [/BV\s?786/i, 786],
  [/PE[-_ ]?Cy\s?7|PE[-_ ]?Fire\s?780/i, 780], [/PE[-_ ]?Cy\s?5\.5/i, 700], [/PE[-_ ]?Cy\s?5|PE[-_ ]?Dazzle|PE[-_ ]?CF594|PE[-_ ]?Texas|ECD/i, 640],
  [/APC[-_ ]?(Cy|H)\s?7|APC[-_ ]?Fire\s?750|APC[-_ ]?eF780/i, 780], [/APC[-_ ]?R700|Alexa\s?(Fluor\s?)?700/i, 715], [/PerCP[-_ ]?Cy\s?5\.5|PerCP[-_ ]?eF710/i, 695], [/PerCP/i, 678],
  [/FITC|Alexa\s?(Fluor\s?)?488|GFP|CFSE|BB515|AF488/i, 520], [/^PE\b|^PE[-_ ]?A\b|\bPE$|R-?PE|Alexa\s?(Fluor\s?)?555/i, 575], [/APC|Alexa\s?(Fluor\s?)?647/i, 660],
];
export function wavelengthOf(name: string): number {
  const n = name.replace(/[-_ ]?[AHW]$/, '');
  const m = /(?:^|[^\d])([3-8]\d\d)(?:[/\s_-]?\d{1,3})?(?:$|[^\d])/.exec(n);
  if (m) return Number(m[1]);
  for (const [re, nm] of FLUOR_NM) if (re.test(n)) return nm;
  return NaN;
}

/**
 * Whether the matrix seems to have rows = detectors: with wavelengths for most names, the off-diagonal mass going to
 * shorter wavelengths (row -> column) is more than twice the mass going to longer ones. null: cannot tell.
 */
export function rowsLookLikeDetectors(names: string[], m: number[][]): boolean | null {
  const nm = names.map(wavelengthOf);
  if (nm.filter(Number.isFinite).length < Math.max(2, Math.ceil(names.length * 0.6))) return null;
  let red = 0;
  let blue = 0;
  for (let i = 0; i < m.length; i++)
    for (let j = 0; j < m.length; j++) {
      if (i === j || !Number.isFinite(nm[i]) || !Number.isFinite(nm[j]) || nm[i] === nm[j]) continue;
      const v = Math.abs(m[i][j]);
      if (nm[j] > nm[i]) red += v;
      else blue += v;
    }
  if (red + blue < 1e-6) return null;
  if (blue > 2 * red) return true;
  if (red > 2 * blue) return false;
  return null;
}

/**
 * A compensation (inverse spillover) matrix: diagonal about 1, the off-diagonal values mostly negative (by magnitude;
 * second-order terms can be positive), and its inverse mostly positive.
 */
export function looksInverted(m: number[][]): boolean {
  const n = m.length;
  if (n < 2 || m.some((r, i) => Math.abs(r[i] - 1) > 0.05)) return false;
  const mass = (a: number[][]) => {
    let neg = 0;
    let pos = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) a[i][j] < 0 ? (neg -= a[i][j]) : (pos += a[i][j]);
    return { neg, pos };
  };
  const s = mass(m);
  if (!(s.neg > 1e-6 && s.neg > 3 * s.pos)) return false;
  try {
    const inv = mass(invertMatrix(m));
    return inv.pos > 3 * inv.neg;
  } catch {
    return false;
  }
}

/** A diagonal value of about 1 (fractions) or about 100 (percent). */
const aboutOne = (v: number) => Math.abs(v - 1) < 0.05;
const aboutHundred = (v: number) => Math.abs(v - 100) < 5;

/**
 * Percent or fraction values, returned as fractions. The diagonal decides: about 100 means percent, about 1 fractions
 * whatever the values off the diagonal (real spillover exceeds 1: BD PE-Cy5 into the PerCP-Cy5.5 detector, up to 1.29
 * in FlowKit's 100715 / 113548 files, which the matrix export writes as such). With a diagonal of 1, only spill above
 * 300 % (impossible as fractions) is read as percent with 1 on the diagonal (the Beckman $COMP layout). A diagonal that
 * says neither falls back to the values off it (any above 1: percent). A diagonal value of 1 is never scaled.
 */
function toFractions(m: number[][], notes: string[]): number[][] {
  const n = m.length;
  const diag = m.map((r, i) => r[i]);
  if (diag.every(aboutHundred)) {
    notes.push('values in percent (diagonal 100) were converted to fractions');
    return m.map((r) => r.map((v) => v / 100));
  }
  let maxOff = 0; // largest value off the diagonal (spill is positive; a compensation matrix has negative values)
  let maxAbsOff = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j) {
        maxOff = Math.max(maxOff, m[i][j]);
        maxAbsOff = Math.max(maxAbsOff, Math.abs(m[i][j]));
      }
  const fractions = diag.every(aboutOne);
  const percent = fractions ? maxOff > 3 : maxAbsOff > 1;
  if (!percent) return m;
  notes.push(
    fractions
      ? `values off the diagonal up to ${Number(maxOff.toPrecision(4))} can only be percent (the diagonal of 1 was kept); they were converted to fractions`
      : 'values in percent were converted to fractions',
  );
  return m.map((r, i) => r.map((v, j) => (i === j && aboutOne(v) ? v : v / 100)));
}

/**
 * Read a square matrix from delimited text (see the notes at the top of the file). Throws an Error saying why the text
 * is not a matrix.
 */
export function parseDelimitedMatrix(text: string): RawMatrix {
  const lines = tableLines(text);
  if (lines.length < 2) throw new Error('The file holds fewer than two lines: not a compensation matrix.');
  const d = detectDelimiter(lines);
  const rows = tableCells(lines, d);
  const notes: string[] = [];
  const first = rows[0];
  const header = first.slice(1).some((c) => c !== '' && !isNum(c, d));
  const body = header ? rows.slice(1) : rows;
  if (!body.length) throw new Error('The file holds a header row only: not a compensation matrix.');
  const rowNames = body.every((r) => r.length > 0 && !isNum(r[0], d));
  let n: number;
  let colNames: string[] | null = null;
  let corner = '';
  if (header) {
    const width = Math.max(...body.map((r) => r.length));
    if (rowNames && first.length === width) {
      // as wide as the rows (name + values): the first cell is a corner cell
      corner = first[0];
      colNames = first.slice(1);
    } else colNames = !rowNames && first[0] === '' ? first.slice(1) : first;
    n = colNames.length;
  } else n = body[0].length - (rowNames ? 1 : 0);
  if (n < 1) throw new Error('No matrix columns were found.');
  // extra lines after the matrix (e.g. a "Mask" or "Offset" line of a spectral reference table) make it no matrix
  if (body.length !== n) throw new Error(`The table has ${body.length} rows of values for ${n} columns: not a square compensation matrix.`);
  const values = body.map((r, i) => {
    const cells = rowNames ? r.slice(1) : r;
    if (cells.length < n) throw new Error(`Row ${i + 1} has ${cells.length} values for ${n} columns.`);
    return cells.slice(0, n).map((c, j) => {
      const v = parseNumberCell(c, d);
      if (!Number.isFinite(v)) throw new Error(`Row ${i + 1}, column ${j + 1}: "${c.slice(0, 20)}" is not a number.`);
      return v;
    });
  });
  const rNames = rowNames ? body.map((r) => r[0]) : null;
  let names: string[];
  let m = values;
  if (colNames && rNames) {
    names = colNames;
    const lc = (s: string) => s.toLowerCase();
    const sameSet = rNames.length === colNames.length && rNames.every((r) => colNames!.some((c) => lc(c) === lc(r))) && new Set(rNames.map(lc)).size === rNames.length;
    if (sameSet && rNames.some((r, i) => lc(r) !== lc(colNames![i]))) {
      // rows in another order than the columns: reorder them
      m = colNames.map((c) => values[rNames.findIndex((r) => lc(r) === lc(c))]);
      notes.push('the rows were put in the order of the columns');
    } else if (!sameSet) notes.push(`the row names (${rNames.slice(0, 2).join(', ')}...) differ from the column names; rows were taken in column order`);
  } else if (colNames) names = colNames;
  else if (rNames) names = rNames;
  else throw new Error('The matrix has no channel names (no header row or first column of names).');
  if (new Set(names).size !== names.length) throw new Error('The matrix names a channel twice.');
  m = toFractions(m, notes);
  // a table of numbers without row names is only a matrix if its diagonal says so
  if (!rNames && !m.every((r, i) => Math.abs(r[i] - 1) < 0.02)) throw new Error('The table is square, but its diagonal is not 1 (or 100 %): not a compensation matrix.');
  if (m.some((r, i) => Math.abs(r[i] - 1) > 1e-3)) notes.push('the diagonal is not 1 everywhere; values were kept as they are');
  if (looksInverted(m)) {
    m = invertMatrix(m);
    notes.push('the file holds a compensation matrix (inverse of the spillover: negative values off the diagonal); it was inverted to the spillover matrix');
  }
  // orientation: the corner cell can tell; else the detector wavelengths
  const c = corner.toLowerCase();
  const cornerDet = /^\s*(det|channel|parameter)[^\\/]*[\\/]/.test(c);
  const cornerFluor = /^\s*(fluor|source|dye|stain|marker)[^\\/]*[\\/]/.test(c);
  if (cornerDet) {
    m = transpose(m);
    notes.push(`rows are detectors ("${corner}"); the matrix was transposed to rows = fluorochromes`);
  } else if (!cornerFluor && rowsLookLikeDetectors(names, m)) {
    m = transpose(m);
    notes.push('the spill went mainly from longer to shorter wavelengths, so rows were read as detectors and the matrix was transposed (check the result)');
  }
  return { names, matrix: m, notes };
}

export function transpose(m: number[][]): number[][] {
  return m.map((r, i) => r.map((_, j) => m[j][i]));
}

// ------------------------------------------------------------------ FlowJo matrix XML

/** FlowJo spillover matrices (transforms:spilloverMatrix) of an XML document (.mtx, or any XML that holds them). */
export function parseFlowJoMatrixXml(text: string): RawMatrix[] {
  const doc = parseXml(text);
  const sms = descendants(doc, 'spilloverMatrix');
  if (!sms.length) throw new Error('The XML file holds no spillover matrix (spilloverMatrix element).');
  return sms.map((sm, k) => {
    const label = sm.attrs['name'] || `matrix ${k + 1}`;
    if (sm.attrs['spectral'] === '1') throw new Error(`"${label}" is a spectral (unmixing) matrix, which cannot be imported as a compensation matrix.`);
    const pe = child(sm, 'parameters');
    const names = (pe ? childrenNamed(pe, 'parameter') : []).map((p) => (p.attrs['name'] ?? '').trim()).filter(Boolean);
    const n = names.length;
    if (!n) throw new Error(`"${label}" names no parameters.`);
    const idx = new Map(names.map((x, i) => [x, i]));
    const matrix: number[][] = names.map((_, i) => names.map((__, j) => (i === j ? 1 : 0)));
    const rows = childrenNamed(sm, 'spillover');
    if (rows.length !== n) throw new Error(`"${label}" has ${rows.length} rows for ${n} parameters.`);
    for (const r of rows) {
      const i = idx.get((r.attrs['parameter'] ?? '').trim());
      if (i === undefined) throw new Error(`"${label}": a row refers to the unknown parameter "${r.attrs['parameter'] ?? ''}".`);
      childrenNamed(r, 'coefficient').forEach((c, jj) => {
        const j = idx.get((c.attrs['parameter'] ?? '').trim()) ?? jj;
        const v = Number(c.attrs['value']);
        if (j < n && Number.isFinite(v)) matrix[i][j] = v;
      });
    }
    const prefix = sm.attrs['prefix'];
    return { name: label, names, matrix, notes: prefix && prefix !== 'Comp-' ? [`FlowJo prefix "${prefix}"`] : [] };
  });
}

// ------------------------------------------------------------------ channel names

const SUFFIX = /-[AHW]$/i;

/** Name forms other programs use for a channel: " :: label" (FlowJo / FlowState CSV), "Comp-" / "FJComp-" prefixes. */
function baseForms(name: string): string[] {
  const out = [name.trim()];
  const add = (s: string) => {
    s = s.trim();
    if (s && !out.includes(s)) out.push(s);
  };
  for (const s of [...out]) add(s.split(' :: ')[0]);
  for (const s of [...out]) add(s.replace(/^(FJ)?Comp[-_ ]/i, ''));
  for (const s of [...out]) add(s.replace(/\s*<[^>]*>\s*$/, '')); // "FITC-A <CD3>"
  return out;
}

/**
 * The workspace channel a matrix name refers to: the same $PnN (exactly, or ignoring case), with or without an -A
 * suffix, without FlowJo's "Comp-" prefix or " :: marker" suffix, or by the marker / stain label ($PnS; also a label
 * ending in the name, e.g. CytExpert "Atto488 B531-A" for "B531-A"). Area channels are preferred. `taken`: channels
 * already used by other names of the matrix.
 */
export function mapChannelName(name: string, chans: ChannelRef[], taken: Set<string> = new Set()): { channel: string; how: string } | null {
  const free = chans.filter((c) => !taken.has(c.name));
  const lc = (s: string) => s.toLowerCase();
  const pick = (list: ChannelRef[]) => list.find((c) => /-A$/i.test(c.name)) ?? list.find((c) => !/-[HW]$/i.test(c.name)) ?? list[0];
  for (const f of baseForms(name)) {
    const tries: [string, (c: ChannelRef) => boolean][] = [
      ['same name', (c) => c.name === f],
      ['name ignoring case', (c) => lc(c.name) === lc(f)],
      ['Area channel of the name', (c) => !SUFFIX.test(f) && lc(c.name) === lc(f) + '-a'],
      ['name without -A', (c) => /-A$/i.test(f) && lc(c.name) === lc(f.slice(0, -2))],
      ['label', (c) => !!c.label && lc(c.label) === lc(f)],
      ['label', (c) => !SUFFIX.test(f) && !!c.label && lc(c.label) === lc(f) + '-a'],
      ['label', (c) => !!c.label && f.length >= 3 && lc(c.label).endsWith(' ' + lc(f))],
    ];
    for (const [how, ok] of tries) {
      const hit = free.filter(ok);
      if (hit.length) {
        // a label shared by several channels (CD3 on FITC-A and FITC-H): the Area one
        const c = pick(hit);
        return { channel: c.name, how: how === 'same name' ? how : `${how} ("${name}" -> ${c.name})` };
      }
    }
  }
  return null;
}

/** Map all names of a matrix; unmatched names are kept as they are (compensation ignores channels a sample lacks). */
export function mapMatrixNames(names: string[], chans: ChannelRef[]): { channels: string[]; unmapped: string[]; renamed: string[] } {
  const taken = new Set<string>();
  const out: string[] = [];
  const unmapped: string[] = [];
  const renamed: string[] = [];
  // exact names first, so a fuzzy match cannot take another name's own channel
  const exact = names.map((n) => (chans.some((c) => c.name === n) ? n : null));
  for (const e of exact) if (e) taken.add(e);
  names.forEach((n, i) => {
    if (exact[i]) {
      out.push(n);
      return;
    }
    const m = chans.length ? mapChannelName(n, chans, taken) : null;
    if (m) {
      taken.add(m.channel);
      out.push(m.channel);
      renamed.push(`${n} -> ${m.channel}`);
    } else {
      out.push(n);
      if (chans.length) unmapped.push(n);
    }
  });
  // unmatched names cannot collide with a channel name: those were matched exactly first
  return { channels: out, unmapped, renamed };
}

// ------------------------------------------------------------------ files

export interface ImportedMatrix {
  name: string;
  channels: string[];
  matrix: number[][];
  notes: string[];
  unmapped: string[];
  renamed: string[];
}

const stem = (fileName: string) => fileName.replace(/^.*[\\/]/, '').replace(/\.(txt|csv|tsv|mtx|comp|xml)$/i, '');

/** Is this file a compensation matrix by its content (CytExpert binary, FlowJo XML, or a square named table)? */
export function sniffMatrix(fileName: string, bytes: Uint8Array): boolean {
  if (isNrbf(bytes)) return true;
  if (bytes.length > 4e6) return false;
  const text = new TextDecoder('utf-8').decode(bytes);
  if (/^\s*</.test(text.replace(BOM, ''))) return /spilloverMatrix/.test(text) && !/(Rectangle|Polygon|Ellipsoid|Quadrant|Boolean)Gate\b/.test(text);
  try {
    parseDelimitedMatrix(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a matrix file and match its names to the workspace channels `chans` (all channels of the loaded samples).
 * CytExpert .comp: Height and Area matrices become one block-diagonal matrix over the -H and -A channels, as CytExpert
 * writes $SPILLOVER; detectors are matched through the $PnS labels ("B531-A").
 */
export function readMatrixFile(fileName: string, bytes: Uint8Array, chans: ChannelRef[]): ImportedMatrix[] {
  const base = stem(fileName);
  if (isNrbf(bytes)) {
    const { matrices, notes } = parseCytExpertComp(bytes);
    const names: string[] = [];
    const blocks: { at: number; m: number[][]; kind: string }[] = [];
    for (const mx of matrices) {
      const suffix = mx.kind === 'H' ? '-H' : mx.kind === 'A' ? '-A' : '';
      blocks.push({ at: names.length, m: mx.spill, kind: mx.kind === 'H' ? 'Height ' : mx.kind === 'A' ? 'Area ' : '' });
      names.push(...mx.detectors.map((d) => d + suffix));
    }
    const n = names.length;
    const big: number[][] = names.map((_, i) => names.map((__, j) => (i === j ? 1 : 0)));
    for (const b of blocks) b.m.forEach((r, i) => r.forEach((v, j) => (big[b.at + i][b.at + j] = v)));
    const mapped = mapMatrixNames(names, chans);
    // a block none of whose detectors a loaded sample has is left out (e.g. Height when only Area was recorded), unless
    // nothing matches at all (no samples yet: everything is kept under CytExpert's names)
    const lost = new Set(mapped.unmapped);
    const deadBlocks = blocks.filter((b) => names.slice(b.at, b.at + b.m.length).every((x) => lost.has(x)));
    const drop = deadBlocks.length < blocks.length ? deadBlocks : [];
    const keep = names.map((_, i) => i).filter((i) => !drop.some((b) => i >= b.at && i < b.at + b.m.length));
    const out: ImportedMatrix = {
      name: `${base} (CytExpert)`,
      channels: keep.map((i) => mapped.channels[i]),
      matrix: keep.map((i) => keep.map((j) => big[i][j])),
      notes: [...notes, ...drop.map((b) => `the ${b.kind}matrix was left out: no loaded sample has its channels`)],
      unmapped: mapped.unmapped.filter((x) => keep.some((i) => names[i] === x)),
      renamed: mapped.renamed,
    };
    if (n && !keep.length) throw new Error('The CytExpert file holds no detectors.');
    return [out];
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  const raws: RawMatrix[] = /^\s*</.test(text.replace(BOM, '')) ? parseFlowJoMatrixXml(text) : [parseDelimitedMatrix(text)];
  return raws.map((r, k) => {
    const mapped = mapMatrixNames(r.names, chans);
    return {
      name: raws.length > 1 ? `${base} (${r.name ?? k + 1})` : r.name && r.name !== 'Acquisition-defined' ? `${base} (${r.name})` : base,
      channels: mapped.channels,
      matrix: r.matrix,
      notes: r.notes,
      unmapped: mapped.unmapped,
      renamed: mapped.renamed,
    };
  });
}

// ------------------------------------------------------------------ export

/** Shortest decimal form of a value (fractions, full precision). */
const fmt = (v: number) => (Math.abs(v) < 1e-15 ? '0' : String(Number(v.toPrecision(10))));

/**
 * A spillover matrix as delimited text: a header row of channel names after an empty corner cell, then one row per
 * fluorochrome (its name, then the spill into each detector as a fraction). Tab-separated for FlowLogic / FlowJo
 * (.txt), comma-separated for spreadsheets (.csv).
 */
export function matrixToText(comp: { channels: string[]; matrix: number[][] }, delim: '\t' | ','): string {
  const cell = (s: string) => (delim === ',' && /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : delim === '\t' ? s.replace(/\t/g, ' ') : s);
  const lines = [['', ...comp.channels].map(cell).join(delim)];
  comp.channels.forEach((c, i) => lines.push([cell(c), ...comp.matrix[i].map(fmt)].join(delim)));
  return lines.join('\r\n') + '\r\n';
}
