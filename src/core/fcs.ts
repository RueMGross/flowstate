// FCS 2.0 / 3.0 / 3.1 / 3.2 reader and FCS 3.1 writer.
// Data are returned as one Float32Array per parameter (linearized for $PnE log-amplified integer and ASCII data,
// divided by the gain $PnG for linear ones; the channel range follows, see toScaleValues).
//
// Reader decisions for non-compliant files (each one leaves a note in FcsDataset.warnings unless it is harmless):
//   - DATA offsets: HEADER and TEXT ($BEGINDATA) can disagree; the offset that does not start inside TEXT, fits the
//     file, matches $TOT x bytes per event and directly follows TEXT wins (chooseDataSegment). $ENDDATA one byte off
//     (last byte vs one past it, a common writer bug) is tolerated silently.
//   - FCS 3.2 $PnDATATYPE (I/F/D per parameter) overrides $DATATYPE.
//   - Duplicate $PnN are made unique ("name (2)"), so channels can be told apart.
//   - Floating-point channels with $PnE f1>0 whose values lie within 0..f1 hold log10 decades (Guava / Muse "HLog"
//     channels: HLog = log10(HLin)); they are linearized to f2 * 10^value, which equals the paired linear channel
//     (Millipore_Guava, 15 wells, and Guava_Muse: 10^HLog / HLin = 1 within 3e-7). FlowIO/FlowKit apply the integer
//     formula f2 * 10^(f1 * value / $PnR) to them (values 1.000 to 1.004), and the FCS 3.1 spec says $PnE must be 0,0
//     for float data (values left in decades); neither gives usable values for these files. Float channels whose
//     values exceed f1 (e.g. BD FACSAria "5,3" on linear float data) are left as they are.
//   - $PnR of 0 / missing: the data maximum.
//   - Files with several data sets: parseFcsSamples splits independent data sets (one per well, e.g. Guava) into
//     samples; the FCS 2.0 + 3.0 copies of a Beckman LMD file are one sample (the FCS 3.0 part, with the instrument
//     keywords and stain names of the 2.0 part it lacks).

export interface FcsChannel {
  index: number; // 0-based
  name: string; // $PnN (short name, e.g. "FITC-A"; made unique when the file repeats a name)
  label: string; // $PnS (stain / marker, may be empty)
  range: number; // $PnR, in the units of the returned values (f2 * 10^f1 for $PnE log channels, $PnR / $PnG with a gain)
  bits: number; // $PnB
  logDecades: number; // $PnE f1 (0 = linear)
  logOffset: number; // $PnE f2
  gain: number; // $PnG
  displayHint: 'lin' | 'log' | '';
  /** unit of the values when the reader converted them (Time scaled by $TIMESTEP: 's') */
  unit?: string;
}

export interface FcsDataset {
  version: string;
  keywords: Record<string, string>; // keys upper-cased
  channels: FcsChannel[];
  eventCount: number;
  data: Float32Array[];
  warnings: string[];
  /** $TIMESTEP the Time channel was multiplied by (values in seconds), if any; see applyTimestep */
  timeStep?: number;
  /** Set when the file holds several independent data sets (e.g. one per well): which one this is (see parseFcsSamples). */
  dataset?: FcsDatasetPart;
}

/** Position of a data set in a file with several independent data sets. */
export interface FcsDatasetPart {
  /** 0-based position in the file */
  index: number;
  /** number of independent data sets in the file */
  count: number;
  /** "#3 A03": position (1-based) and $WELLID / $SMNO / $FIL, used to name the sample */
  label: string;
}

/** One sample of an FCS file (see parseFcsSamples). */
export interface FcsSample {
  ds: FcsDataset;
  /** bytes of a standalone FCS file holding just this data set (the whole file when it has only one sample) */
  bytes: ArrayBuffer;
}

export interface Spillover {
  channels: string[]; // $PnN names (matched to dataset)
  matrix: number[][]; // [source][detector]
  keyword: string;
}

const tdLatin = typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1') : null;

function decodeText(bytes: Uint8Array): string {
  // Try strict UTF-8 first; fall back to latin1 for legacy (FCS 2.0) files.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return tdLatin ? tdLatin.decode(bytes) : String.fromCharCode(...bytes);
  }
}

function asciiInt(bytes: Uint8Array, start: number, end: number): number {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const v = parseInt(s.trim(), 10);
  return Number.isFinite(v) ? v : 0;
}

/** Parse the TEXT segment into a key/value map (keys upper-cased). */
export function parseTextSegment(bytes: Uint8Array): Record<string, string> {
  const text = decodeText(bytes);
  const out: Record<string, string> = {};
  if (text.length < 2) return out;
  const delim = text[0];
  const tokens: string[] = [];
  let cur = '';
  let i = 1;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch !== delim) {
      cur += ch;
      i++;
      continue;
    }
    let k = 1; // length of the run of delimiters
    while (i + k < n && text[i + k] === delim) k++;
    i += k;
    if (tokens.length % 2 === 0 && cur !== '') {
      // after a keyword: separator, then escaped delimiters; an even run ends the value, so "/KEY//NEXT/"
      // is an empty value (sloppy FCS 2.0 writers) and "/KEY///x/" the value "/x"
      tokens.push(cur);
      cur = delim.repeat((k - 1) >> 1);
      if (k % 2 === 0) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    // inside a value: doubled delimiters are escapes, an odd one ends the value
    cur += delim.repeat(k >> 1);
    if (k % 2) {
      tokens.push(cur);
      cur = '';
    }
  }
  if (cur.trim().length) tokens.push(cur);
  for (let k = 0; k + 1 < tokens.length; k += 2) {
    const key = tokens[k].trim().toUpperCase();
    if (!key) continue;
    out[key] = tokens[k + 1];
  }
  return out;
}

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p *= 2;
  return p;
}

function byteOrderLittle(byteord: string | undefined): boolean {
  if (!byteord) return true;
  const s = byteord.replace(/\s/g, '');
  if (s.startsWith('4,3,2,1') || s === '2,1' || s.startsWith('8,7,6,5')) return false;
  return true;
}

function versionNumber(version: string): number {
  const v = parseFloat(version.replace(/^FCS/i, ''));
  return Number.isFinite(v) ? v : 0;
}

/** At most this many parameters ($PAR): far more than any cytometer measures (spectral, mass cytometry: a few hundred). */
export const MAX_PAR = 10000;
/** Plausible $PnR: positive, finite, not absurd (1e308 or a denormal would make the axis useless). */
const MAX_RANGE = 1e15;
const MIN_RANGE = 1e-6;

/** $PnR as the reader uses it: a plausible range, else the data maximum (else 1). */
export function usableRange(range: number, data: Float32Array): number {
  if (range > 0 && range <= MAX_RANGE && range >= MIN_RANGE) return range;
  const mx = colMinMax(data)[1];
  return mx > 0 && Number.isFinite(mx) ? mx : 1;
}

/**
 * $PAR, checked before anything is allocated per parameter: a whole number from 1 to MAX_PAR, and every parameter named
 * ($PnN). Files without any $PnN (some FCS 2.0 writers) get "P1", "P2", ...; a $PAR larger than the parameters the file
 * describes (some named, the rest not) means a damaged file.
 */
function parameterCount(kw: Record<string, string>, version: string, warnings: string[]): number {
  const raw = (kw['$PAR'] ?? '').trim();
  if (!raw) throw new Error('The $PAR keyword (number of parameters) is missing. The file is damaged or not an FCS file.');
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid $PAR "${raw.slice(0, 20)}": the number of parameters must be a whole number from 1 to ${MAX_PAR}. The file is damaged.`);
  const n = Number(raw);
  if (n < 1) throw new Error('$PAR is 0: the file has no parameters.');
  if (n > MAX_PAR) throw new Error(`$PAR is ${raw.slice(0, 20)}: more parameters than any cytometer measures (at most ${MAX_PAR} are supported). The file is damaged.`);
  const named = (p: number) => (kw[`$P${p}N`] ?? '').trim() !== '';
  let missing = 0;
  let first = 0;
  for (let p = 1; p <= n; p++)
    if (!named(p)) {
      missing++;
      if (!first) first = p;
    }
  if (missing === n) warnings.push(`The parameters have no names ($PnN); they are called P1 to P${n}`);
  else if (missing) {
    // FCS 3.x requires $PnN; a few unnamed parameters among named ones (or a $PAR beyond them) mean a damaged TEXT segment
    if (versionNumber(version) >= 3 || missing > Math.max(2, n / 2))
      throw new Error(`$PAR says ${n} parameters, but ${missing === 1 ? `parameter ${first} has` : `${missing} of them (from parameter ${first}) have`} no name ($P${first}N). The file is damaged.`);
    warnings.push(`${missing} parameter(s) without a name ($PnN) are called P<n>`);
  }
  return n;
}

function parseChannels(kw: Record<string, string>, nPar: number): FcsChannel[] {
  const chans: FcsChannel[] = [];
  for (let p = 1; p <= nPar; p++) {
    const name = (kw[`$P${p}N`] ?? `P${p}`).trim();
    const label = (kw[`$P${p}S`] ?? '').trim();
    const range = parseFloat(kw[`$P${p}R`] ?? '0') || 0;
    const bitsStr = (kw[`$P${p}B`] ?? '32').trim();
    const bits = bitsStr === '*' ? 0 : parseInt(bitsStr, 10) || 32;
    let logDecades = 0;
    let logOffset = 0;
    const e = kw[`$P${p}E`];
    if (e) {
      const parts = e.split(',').map((x) => parseFloat(x));
      logDecades = Number.isFinite(parts[0]) ? parts[0] : 0;
      logOffset = Number.isFinite(parts[1]) ? parts[1] : 0;
    }
    const gain = parseFloat(kw[`$P${p}G`] ?? '1') || 1;
    let displayHint: 'lin' | 'log' | '' = '';
    const disp = (kw[`P${p}DISPLAY`] ?? kw[`$P${p}D`] ?? '').toUpperCase();
    if (disp.startsWith('LOG')) displayHint = 'log';
    else if (disp.startsWith('LIN')) displayHint = 'lin';
    chans.push({ index: p - 1, name, label: label === name ? '' : label, range, bits, logDecades, logOffset, gain, displayHint });
  }
  return chans;
}

/** Repeated $PnN get " (2)", " (3)" ... so every channel has its own name; returns a warning, or null. */
function uniqueNames(chans: FcsChannel[]): string | null {
  const taken = new Set(chans.map((c) => c.name));
  const seen = new Map<string, number[]>();
  const renamed: string[] = [];
  for (const c of chans) {
    const list = seen.get(c.name);
    if (!list) {
      seen.set(c.name, [c.index + 1]);
      continue;
    }
    list.push(c.index + 1);
    let k = list.length;
    while (taken.has(`${c.name} (${k})`)) k++;
    const nn = `${c.name} (${k})`;
    taken.add(nn);
    renamed.push(`$P${c.index + 1} "${nn}"`);
    c.name = nn;
  }
  if (!renamed.length) return null;
  const dups = [...seen.entries()].filter(([, l]) => l.length > 1).map(([n, l]) => `"${n}" (${l.map((p) => '$P' + p).join(', ')})`);
  return `Parameter names occur more than once: ${dups.join('; ')}; renamed ${renamed.join(', ')}`;
}

type DataType = 'I' | 'F' | 'D' | 'A';

/** Data type of each parameter: $DATATYPE, overridden by FCS 3.2 $PnDATATYPE (I, F or D). */
function parameterTypes(kw: Record<string, string>, version: string, nPar: number): string[] {
  const dt = (kw['$DATATYPE'] ?? 'F').trim().toUpperCase();
  const v32 = versionNumber(version) >= 3.2 && dt !== 'A';
  const out: string[] = [];
  for (let p = 1; p <= nPar; p++) {
    const t = v32 ? (kw[`$P${p}DATATYPE`] ?? '').trim().toUpperCase() : '';
    out.push(t === 'I' || t === 'F' || t === 'D' ? t : dt);
  }
  return out;
}

function bytesOf(type: string, c: FcsChannel): number {
  return type === 'F' ? 4 : type === 'D' ? 8 : type === 'I' ? Math.max(1, Math.ceil((c.bits || 16) / 8)) : 0;
}

/**
 * Channel values of integer and ASCII parameters (`which`) to scale values, with $PnR following them:
 *   - log-amplified ($PnE f1>0): f2 * 10^(f1 * value / $PnR) (f2 0 counts as 1, as FCS says), range f2 * 10^f1
 *   - linear with an amplifier gain ($PnG, FCS 3.1): value / gain, range / gain (not Time)
 * Not for floating-point data: e.g. CytoFLEX stores detector gains in $PnG (float decades: linearizeFloatDecades).
 */
function toScaleValues(chans: FcsChannel[], which: boolean[], out: Float32Array[], warnings: string[]) {
  chans.forEach((c, p) => {
    if (!which[p]) return;
    const arr = out[p];
    const n = arr.length;
    if (c.logDecades > 0) {
      const f2 = c.logOffset > 0 ? c.logOffset : 1;
      const r = c.range > 0 ? c.range : nextPow2(Math.max(...Array.from(arr.subarray(0, Math.min(n, 5000)))) + 1);
      for (let e = 0; e < n; e++) arr[e] = f2 * Math.pow(10, (c.logDecades * arr[e]) / r);
      c.range = f2 * Math.pow(10, c.logDecades);
    } else if (c.gain > 0 && c.gain !== 1 && !/^time/i.test(c.name)) {
      for (let e = 0; e < n; e++) arr[e] = arr[e] / c.gain;
      if (c.range > 0) c.range /= c.gain;
      warnings.push(`${c.name}: values divided by $P${p + 1}G=${c.gain}`);
    }
  });
}

function readData(
  buf: ArrayBuffer,
  start: number,
  kw: Record<string, string>,
  chans: FcsChannel[],
  types: string[],
  nEvents: number,
  warnings: string[],
): Float32Array[] {
  const little = byteOrderLittle(kw['$BYTEORD']);
  const nPar = chans.length;
  const bad = types.find((t) => t !== 'I' && t !== 'F' && t !== 'D' && t !== 'A');
  if (bad !== undefined) throw new Error(`Unsupported $DATATYPE "${bad}"`);
  if (types.every((t) => t === 'A') && !chans.every((c) => c.bits > 0)) {
    // delimited ASCII: as many events as there are complete rows of values (at most $TOT)
    const s = decodeText(new Uint8Array(buf, Math.min(start, buf.byteLength)));
    const vals = s.split(/[\s,]+/).filter((x) => x.length).map(Number);
    const n = Math.min(nEvents, Math.floor(vals.length / Math.max(1, nPar)));
    if (n < nEvents) warnings.push(`The DATA segment holds ${n} complete events of ${nPar} ASCII values, not $TOT ${nEvents}`);
    const cols: Float32Array[] = chans.map(() => new Float32Array(n));
    for (let e = 0, k = 0; e < n; e++) for (let p = 0; p < nPar; p++) cols[p][e] = vals[k++];
    for (const a of cols) for (let e = 0; e < n; e++) if (!Number.isFinite(a[e])) a[e] = 0;
    toScaleValues(chans, chans.map(() => true), cols, warnings);
    for (const a of cols) for (let e = 0; e < n; e++) if (!Number.isFinite(a[e])) a[e] = 0;
    if (warnings.length > 20) warnings.length = 20;
    return cols;
  }
  const out: Float32Array[] = chans.map(() => new Float32Array(nEvents));
  const dv = new DataView(buf);
  const uniform: DataType | null = types.every((t) => t === types[0]) ? (types[0] as DataType) : null;
  if (uniform === 'F' || uniform === 'D') {
    const bpv = uniform === 'F' ? 4 : 8;
    const total = nEvents * nPar;
    if (start + total * bpv > buf.byteLength) throw new Error('DATA segment truncated');
    // Fast path: little-endian aligned float32 on little-endian host
    const hostLittle = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (uniform === 'F' && little === hostLittle && start % 4 === 0) {
      const all = new Float32Array(buf, start, total);
      for (let e = 0, o = 0; e < nEvents; e++) {
        for (let p = 0; p < nPar; p++, o++) out[p][e] = all[o];
      }
    } else {
      let off = start;
      for (let e = 0; e < nEvents; e++) {
        for (let p = 0; p < nPar; p++) {
          out[p][e] = bpv === 4 ? dv.getFloat32(off, little) : dv.getFloat64(off, little);
          off += bpv;
        }
      }
    }
  } else if (uniform === 'A') {
    // ASCII data, fixed width ($PnB digits; delimited data are read above)
    const bytes = new Uint8Array(buf, Math.min(start, buf.byteLength));
    let pos = 0;
    for (let e = 0; e < nEvents; e++) {
      for (let p = 0; p < nPar; p++) {
        const w = chans[p].bits;
        out[p][e] = asciiInt(bytes, pos, pos + w);
        pos += w;
      }
    }
    toScaleValues(chans, chans.map(() => true), out, warnings);
  } else {
    // integer data, or (FCS 3.2) a mix of integer and floating-point parameters
    const size = chans.map((c, p) => bytesOf(types[p], c));
    const isInt = types.map((t) => t === 'I');
    const masks = chans.map((c) => {
      const bits = c.bits || 16;
      if (c.range > 0 && c.range < Math.pow(2, bits)) return nextPow2(c.range) - 1;
      return bits >= 32 ? 0xffffffff : Math.pow(2, bits) - 1;
    });
    const rowBytes = size.reduce((a, b) => a + b, 0);
    if (start + rowBytes * nEvents > buf.byteLength) throw new Error('DATA segment truncated');
    let off = start;
    for (let e = 0; e < nEvents; e++) {
      for (let p = 0; p < nPar; p++) {
        const b = size[p];
        if (!isInt[p]) {
          out[p][e] = b === 4 ? dv.getFloat32(off, little) : dv.getFloat64(off, little);
          off += b;
          continue;
        }
        let v: number;
        if (b === 1) v = dv.getUint8(off);
        else if (b === 2) v = dv.getUint16(off, little);
        else if (b === 4) v = dv.getUint32(off, little);
        else if (b === 8) v = Number(dv.getBigUint64(off, little));
        else {
          // odd byte sizes (3, 5, ...)
          v = 0;
          for (let k = 0; k < b; k++) {
            const byte = dv.getUint8(off + (little ? k : b - 1 - k));
            v += byte * Math.pow(256, k);
          }
        }
        const m = masks[p];
        if (m !== 0xffffffff && b <= 4) v = v & m;
        else if (b <= 4) v = v >>> 0;
        out[p][e] = v;
        off += b;
      }
    }
    // (the bit masks above use $PnR as written, before toScaleValues changes the range)
    toScaleValues(chans, isInt, out, warnings);
  }
  // sanitise NaN/Inf
  for (let p = 0; p < nPar; p++) {
    const a = out[p];
    for (let e = 0; e < nEvents; e++) if (!Number.isFinite(a[e])) {
      a[e] = 0;
    }
  }
  if (warnings.length > 20) warnings.length = 20;
  return out;
}

function colMinMax(a: Float32Array): [number, number] {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return [mn, mx];
}

/**
 * Floating-point channels with $PnE f1>0 whose values lie within 0..f1 hold log10 decades (Guava / Muse "HLog"
 * channels, HLog = log10(HLin)): linearized to f2 * 10^value, range f2 * 10^f1. See the notes at the top of the file.
 */
function linearizeFloatDecades(chans: FcsChannel[], types: string[], data: Float32Array[], warnings: string[]) {
  const done: string[] = [];
  let note = '';
  chans.forEach((c, p) => {
    if (types[p] !== 'F' && types[p] !== 'D') return;
    const f1 = c.logDecades;
    if (!(f1 > 0) || !data[p].length) return;
    const [mn, mx] = colMinMax(data[p]);
    // decades: within [-f1, f1] (with float rounding) while a linear channel of this range would go far beyond f1
    if (!(mx > 0) || mx > f1 * (1 + 1e-4) || mn < -f1 || !(c.range > 10 * f1 || c.range === 0)) return;
    const f2 = c.logOffset > 0 ? c.logOffset : 1;
    const a = data[p];
    for (let i = 0; i < a.length; i++) a[i] = f2 * Math.pow(10, a[i]);
    c.range = f2 * Math.pow(10, f1);
    done.push(c.name);
    if (!note) note = `$PnE=${f1},${c.logOffset}: values 0..${f1} read as log10 decades and converted to linear values ${f2}..${(f2 * Math.pow(10, f1)).toLocaleString('en-US')} (f2 x 10^value)`;
  });
  if (done.length) warnings.push(`${done.join(', ')}: floating-point data with ${note}`);
}

/** Candidate DATA segment (offsets relative to the data set's HEADER). */
interface DataSeg {
  src: 'HEADER' | 'TEXT';
  start: number;
  end: number;
}

/**
 * Choose between the HEADER and TEXT ($BEGINDATA / $ENDDATA) DATA offsets. Writers get either one wrong (Accuri C6: a
 * stale $BEGINDATA inside TEXT; CyAn: a TEXT offset 46 bytes too far; FlowIO's test file: a HEADER offset inside TEXT).
 * The offset that does not start inside TEXT, lets the data fit in the file, matches $TOT x bytes per event and directly
 * follows TEXT (or supplemental TEXT) wins; ties go to TEXT for FCS 3.x (the standard makes it authoritative) and to
 * HEADER for FCS 2.0. Disagreement is reported in `warnings`.
 */
function chooseDataSegment(
  header: DataSeg,
  text: DataSeg,
  textSeg: [number, number],
  stextEnd: number,
  expected: number | null,
  available: number,
  version: string,
  warnings: string[],
): { start: number; end: number } {
  const cands = [header, text].filter((c) => c.start > 0 || c.end > 0);
  if (!cands.length) return { start: 0, end: 0 };
  if (cands.length === 1 || (cands[0].start === cands[1].start && cands[0].end === cands[1].end)) return cands[0];
  const v3 = versionNumber(version) >= 3;
  const facts = cands.map((c) => {
    const len = c.end - c.start + 1;
    return {
      c,
      inText: c.start >= textSeg[0] && c.start <= textSeg[1],
      fits: expected === null || c.start + expected <= available,
      lenOk: expected !== null && Math.abs(len - expected) <= 1,
      adjacent: c.start === textSeg[1] + 1 || (stextEnd > 0 && c.start === stextEnd + 1),
      preferred: v3 ? c.src === 'TEXT' : c.src === 'HEADER',
    };
  });
  const key = (f: (typeof facts)[number]) => [!f.inText, f.fits, f.lenOk, f.adjacent, f.preferred].map((b) => (b ? 1 : 0));
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  };
  facts.sort((a, b) => cmp(key(a), key(b)));
  const [best, other] = facts;
  if (best.c.start === other.c.start) {
    // same start, different end (one byte off is a common, harmless writer bug; otherwise checked against $TOT later)
    if (best.lenOk && !other.lenOk && Math.abs(best.c.end - other.c.end) > 1)
      warnings.push(`DATA end offsets of HEADER (${header.end}) and TEXT $ENDDATA (${text.end}) disagree; using ${best.c.src} (matches $TOT x bytes per event)`);
    return best.c;
  }
  const why = other.inText
    ? 'starts inside the TEXT segment'
    : !other.fits
      ? 'would run past the end of the file'
      : !other.lenOk && best.lenOk
        ? `does not match the data length ($TOT x bytes per event = ${expected})`
        : best.adjacent && !other.adjacent
          ? 'does not follow the TEXT segment, the other does'
          : `the ${best.c.src} offset is preferred for FCS ${v3 ? '3.x' : '2.0'}`;
  const otherName = other.c.src === 'TEXT' ? `TEXT $BEGINDATA ${other.c.start}` : `HEADER ${other.c.start}`;
  const bestName = best.c.src === 'TEXT' ? `TEXT $BEGINDATA ${best.c.start}` : `HEADER ${best.c.start}`;
  warnings.push(`DATA offsets of HEADER and TEXT disagree; using ${bestName}, ignoring ${otherName} (${why})`);
  return best.c;
}

interface ParsedSet {
  ds: FcsDataset;
  /** absolute offset of this data set's HEADER */
  base: number;
  /** absolute offset of the next data set (0 = none) */
  next: number;
}

function parseOneDataset(buf: ArrayBuffer, base: number): ParsedSet {
  const bytes = new Uint8Array(buf);
  const warnings: string[] = [];
  const version = String.fromCharCode(...bytes.subarray(base, base + 6)).trim();
  if (!version.startsWith('FCS')) throw new Error('Not an FCS file (missing FCS header)');
  const textStartRel = asciiInt(bytes, base + 10, base + 18);
  const textEndRel = asciiInt(bytes, base + 18, base + 26);
  const textStart = textStartRel + base;
  const textEnd = textEndRel + base;
  const hStart = asciiInt(bytes, base + 26, base + 34);
  const hEnd = asciiInt(bytes, base + 34, base + 42);
  if (textEnd <= textStart || textEnd >= bytes.length) throw new Error('Invalid TEXT segment offsets');
  const kw = parseTextSegment(bytes.subarray(textStart, textEnd + 1));
  // Supplemental TEXT
  const sts = parseInt(kw['$BEGINSTEXT'] ?? '0', 10);
  const ste = parseInt(kw['$ENDSTEXT'] ?? '0', 10);
  let stextEnd = 0;
  if (sts > 0 && ste > sts && base + ste < bytes.length) {
    try {
      const sup = parseTextSegment(bytes.subarray(base + sts, base + ste + 1));
      for (const [k, v] of Object.entries(sup)) if (!(k in kw)) kw[k] = v;
      stextEnd = ste;
    } catch {
      warnings.push('Could not parse supplemental TEXT segment');
    }
  }
  const nPar = parameterCount(kw, version, warnings);
  const chans = parseChannels(kw, nPar);
  const dupNote = uniqueNames(chans);
  if (dupNote) warnings.push(dupNote);
  const types = parameterTypes(kw, version, nPar);
  let nEvents = parseInt(kw['$TOT'] ?? '0', 10) || 0;
  if (nEvents < 0) {
    warnings.push(`$TOT is ${nEvents}; the number of events is taken from the DATA segment`);
    nEvents = 0;
  }
  const declaredTot = nEvents;
  const rowBytes = types.includes('A') ? 0 : chans.reduce((a, c, p) => a + bytesOf(types[p], c), 0);
  const seg = chooseDataSegment(
    { src: 'HEADER', start: hStart, end: hEnd },
    { src: 'TEXT', start: parseInt(kw['$BEGINDATA'] ?? '0', 10) || 0, end: parseInt(kw['$ENDDATA'] ?? '0', 10) || 0 },
    [textStartRel, textEndRel],
    stextEnd,
    rowBytes && nEvents ? rowBytes * nEvents : null,
    buf.byteLength - base,
    version,
    warnings,
  );
  let dataStart = seg.start + base;
  const dataEnd = seg.end + base;
  const noData = dataStart === base && dataEnd === base; // empty DATA segment (0/0 offsets)
  if (!nEvents && rowBytes && !noData) nEvents = Math.floor((dataEnd - dataStart + 1) / rowBytes);
  if (types.includes('A') && nEvents > 0) {
    // ASCII data: every value takes at least its $PnB digits (fixed width) or one digit and a separator (delimited), so
    // the DATA segment bounds the number of events (a damaged $TOT must not allocate gigabytes)
    const avail = Math.max(0, buf.byteLength - dataStart);
    const fixed = chans.every((c) => c.bits > 0);
    const perEvent = fixed ? chans.reduce((a, c) => a + c.bits, 0) : 2 * nPar - 1;
    const most = Math.floor((avail + (fixed ? 0 : 1)) / Math.max(1, perEvent));
    if (nEvents > most) {
      warnings.push(`$TOT (${nEvents}) is more than the file holds (at most ${most} events of ${nPar} ASCII values); reading ${most}`);
      nEvents = most;
    }
  }
  if (rowBytes && !(noData && nEvents === 0)) {
    const expected = rowBytes * nEvents;
    const declared = dataEnd - dataStart + 1;
    if (declared !== expected) {
      // $ENDDATA one byte off (last byte vs one past it) is a common writer bug and harmless: no note
      if (Math.abs(declared - expected) > 1) warnings.push(`DATA segment length (${declared}) differs from expected (${expected}); using $TOT`);
      if (dataStart + expected > buf.byteLength) {
        // try anchoring at the declared end instead
        const alt = dataEnd + 1 - expected;
        if (alt > textEnd && alt + expected <= buf.byteLength) dataStart = alt;
        else nEvents = Math.max(0, Math.floor((buf.byteLength - dataStart) / rowBytes));
      }
    }
  }
  if (rowBytes && nEvents === 0 && declaredTot > 0 && !noData)
    throw new Error(`The DATA segment is too short for even one event ($PAR ${nPar}, ${rowBytes} bytes per event, $TOT ${declaredTot}). The file is damaged.`);
  const data = readData(buf, dataStart, kw, chans, types, nEvents, warnings);
  if (data.length && data[0].length !== nEvents) nEvents = data[0].length; // delimited ASCII with fewer values than $TOT
  linearizeFloatDecades(chans, types, data, warnings);
  // $PnR 0 or missing: the data maximum; so is a range no instrument has (infinite, 1e308, a denormal): it would
  // make the axis useless
  const badRange: string[] = [];
  chans.forEach((c, p) => {
    if (c.range > 0 && c.range <= MAX_RANGE && c.range >= MIN_RANGE) return;
    if (c.range !== 0) badRange.push(`$P${p + 1}R "${(kw[`$P${p + 1}R`] ?? '').trim().slice(0, 20)}"`);
    c.range = usableRange(0, data[p]);
  });
  if (badRange.length) warnings.push(`Implausible ranges ${badRange.slice(0, 3).join(', ')}${badRange.length > 3 ? ` and ${badRange.length - 3} more` : ''}; the data maximum is used instead`);
  const next = parseInt(kw['$NEXTDATA'] ?? '0', 10);
  if ((kw['$TIMESTEP'] ?? '').trim() && timestepOf(kw) === null && timeChannelIndex(chans) >= 0)
    warnings.push(`$TIMESTEP "${kw['$TIMESTEP'].trim().slice(0, 20)}" is not usable; Time is shown in instrument ticks`);
  const ds: FcsDataset = { version, keywords: kw, channels: chans, eventCount: nEvents, data, warnings };
  applyTimestep(ds);
  return { ds, base, next: next > 0 ? base + next : 0 };
}

/** The Time channel ($PnN "Time", any case), as FlowIO / FlowKit identify it; -1 if none. */
export function timeChannelIndex(channels: { name: string }[]): number {
  return channels.findIndex((c) => /^time$/i.test(c.name.trim()));
}

/** $TIMESTEP of a dataset (seconds per tick), or null when missing / invalid. */
export function timestepOf(keywords: Record<string, string>): number | null {
  const v = parseFloat((keywords['$TIMESTEP'] ?? '').trim());
  // beyond these, Time in seconds overflows single precision or loses all resolution: a damaged keyword
  return Number.isFinite(v) && v >= 1e-12 && v <= 1e6 ? v : null;
}

/**
 * Time in seconds: the Time channel is multiplied by $TIMESTEP (and its $PnR with it), as FlowIO / FlowKit
 * (default preprocessing) and FlowJo do. Idempotent (ds.timeStep records the factor); parseFcs calls it, datasets built
 * in code (e.g. the example data) get it when they are added to the workspace.
 */
export function applyTimestep(ds: FcsDataset): void {
  if (ds.timeStep !== undefined) return;
  const ti = timeChannelIndex(ds.channels);
  const step = timestepOf(ds.keywords);
  if (ti < 0 || step === null) return;
  ds.timeStep = step;
  const ch = ds.channels[ti];
  ch.unit = 's';
  if (step === 1) return;
  const a = ds.data[ti];
  if (a) for (let i = 0; i < a.length; i++) a[i] *= step;
  if (ch.range > 0) ch.range *= step;
}

function parseSets(buf: ArrayBuffer): ParsedSet[] {
  if (!buf.byteLength) throw new Error('Empty file (0 bytes): it holds no data.');
  if (buf.byteLength < 58) throw new Error(`The file is too short to be an FCS file (${buf.byteLength} bytes): it may have been cut off.`);
  const out: ParsedSet[] = [];
  let base = 0;
  const seen = new Set<number>();
  while (base >= 0 && base < buf.byteLength && !seen.has(base)) {
    seen.add(base);
    try {
      const set = parseOneDataset(buf, base);
      out.push(set);
      if (!set.next) break;
      base = set.next;
    } catch (e) {
      if (out.length === 0) throw e;
      out[0].ds.warnings.push(`Data set ${out.length + 1} (at byte ${base}) could not be read: ${(e as Error).message}`);
      break;
    }
  }
  return out;
}

/** Parse all datasets in an FCS/LMD file (as stored: the two copies of a Beckman LMD file are both returned). */
export function parseFcsAll(buf: ArrayBuffer): FcsDataset[] {
  return parseSets(buf).map((s) => s.ds);
}

/**
 * Beckman Coulter LMD files hold the same events twice: an FCS 2.0 data set (channel numbers) and an FCS 3.0 data set
 * (full resolution). Several data sets with different FCS versions and the same event count are such copies.
 */
function isCopySet(all: FcsDataset[]): boolean {
  if (all.length < 2) return false;
  const versions = new Set(all.map((d) => d.version));
  return versions.size === all.length && all.every((d) => d.eventCount === all[0].eventCount);
}

/** Keywords that describe the data layout or a single parameter: never copied between the data sets of a file. */
const LAYOUT_KEY = /^(\$(BEGIN|END)(ANALYSIS|DATA|STEXT)|\$NEXTDATA|\$PAR|\$TOT|\$DATATYPE|\$BYTEORD|\$MODE|\$TIMESTEP|\$SPILLOVER|\$SPILL|SPILL|SPILLOVER|\$COMP|COMP|\$?@?P\d+.*|@P\d+.*)$/;

/** First word of a Beckman parameter name: "FL1 INT LOG" / "FL1-A" -> "FL1". */
const detectorOf = (name: string) => name.trim().toUpperCase().split(/[\s-]/)[0];

/**
 * The FCS 3.0 part of an LMD file lacks the instrument keywords ($CYT, $DATE, $OP, ...) and the stain names of the
 * FCS 2.0 part: copy those it does not have (stain names by detector, "FL1 INT LOG" -> "FL1-A", when unambiguous).
 */
function mergeCopyKeywords(main: FcsDataset, others: FcsDataset[]) {
  for (const o of others) {
    for (const [k, v] of Object.entries(o.keywords)) if (!(k in main.keywords) && !LAYOUT_KEY.test(k)) main.keywords[k] = v;
    const labels = new Map<string, Set<string>>();
    for (const c of o.channels) {
      const s = (o.keywords[`$P${c.index + 1}S`] ?? '').trim();
      if (!s || s.toUpperCase() === c.name.toUpperCase()) continue;
      const d = detectorOf(c.name);
      if (!labels.has(d)) labels.set(d, new Set());
      labels.get(d)!.add(s);
    }
    for (const c of main.channels) {
      if (c.label) continue;
      const set = labels.get(detectorOf(c.name));
      if (!set || set.size !== 1) continue;
      const s = [...set][0];
      if (s === c.name) continue;
      c.label = s;
      if (!main.keywords[`$P${c.index + 1}S`]) main.keywords[`$P${c.index + 1}S`] = s;
    }
  }
}

/** The data set of a copy set to use: the highest FCS version (most events on a tie). */
function preferredIndex(all: FcsDataset[]): number {
  let best = 0;
  for (let i = 1; i < all.length; i++) {
    const v = versionNumber(all[i].version);
    const bv = versionNumber(all[best].version);
    if (v > bv || (v === bv && all[i].eventCount > all[best].eventCount)) best = i;
  }
  return best;
}

function copyNote(all: FcsDataset[], chosen: number): string {
  return `File contains ${all.length} data sets (${all.map((d) => `${d.version}, ${d.eventCount} events`).join('; ')}); only data set ${chosen + 1} is loaded`;
}

/** "#3 A03": position and well / sample number / file name of a data set. */
function partLabel(ds: FcsDataset, index: number): string {
  const k = ds.keywords;
  const well = (k['$WELLID'] ?? k['WELL ID'] ?? k['GTI$WELL'] ?? '').trim();
  const smno = (k['$SMNO'] ?? '').trim();
  const fil = (k['$FIL'] ?? '').trim().split(/[\\/]/).pop() ?? '';
  const what = well || (smno ? `sample ${smno}` : '') || fil.replace(/\.(fcs|lmd)$/i, '');
  return `#${index + 1}${what ? ' ' + what : ''}`;
}

/** A standalone FCS file of one data set: its bytes, with $NEXTDATA set to zeros (same width). */
function standaloneBytes(buf: ArrayBuffer, set: ParsedSet, end: number): ArrayBuffer {
  const out = buf.slice(set.base, end);
  const b = new Uint8Array(out);
  const ts = asciiInt(b, 10, 18);
  const te = asciiInt(b, 18, 26);
  if (te > ts && te < b.length) {
    const d = String.fromCharCode(b[ts]).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const text = tdLatin ? tdLatin.decode(b.subarray(ts, te + 1)) : '';
    const m = new RegExp(`${d}\\$NEXTDATA${d}(\\s*\\d+\\s*)${d}`, 'i').exec(text);
    if (m) {
      const at = ts + m.index + m[0].length - 1 - m[1].length;
      for (let i = 0; i < m[1].length; i++) b[at + i] = 0x30; // '0'
    }
  }
  return out;
}

/**
 * Split an FCS file into samples. Files with several independent data sets (Guava / Muse: one per well) give one sample
 * per data set, each with `ds.dataset` set (position, count, label) and the bytes of a standalone FCS file of just that
 * data set (so saving and reopening the sample gives the same data). The FCS 2.0 + 3.0 copies of a Beckman LMD file
 * give one sample (the FCS 3.0 data set, completed with the keywords of the 2.0 part) with the whole file as bytes.
 */
export function parseFcsSamples(buf: ArrayBuffer): FcsSample[] {
  const sets = parseSets(buf);
  const all = sets.map((s) => s.ds);
  if (all.length === 1) return [{ ds: all[0], bytes: buf }];
  if (isCopySet(all)) {
    const i = preferredIndex(all);
    const ds = all[i];
    mergeCopyKeywords(
      ds,
      all.filter((_, j) => j !== i),
    );
    ds.warnings.unshift(copyNote(all, i));
    return [{ ds, bytes: buf }];
  }
  return sets.map((s, i) => {
    const end = i + 1 < sets.length && sets[i + 1].base > s.base ? sets[i + 1].base : buf.byteLength;
    s.ds.dataset = { index: i, count: sets.length, label: partLabel(s.ds, i) };
    return { ds: s.ds, bytes: standaloneBytes(buf, s, Math.max(end, s.base + 58)) };
  });
}

/**
 * Parse an FCS file and return one data set: the only one, the FCS 3.0 part of a Beckman LMD file, or (files with
 * several independent data sets, see parseFcsSamples) the highest FCS version with the most events, with a note.
 */
export function parseFcs(buf: ArrayBuffer): FcsDataset {
  const sets = parseSets(buf);
  const all = sets.map((s) => s.ds);
  if (all.length === 1) return all[0];
  const i = preferredIndex(all);
  if (isCopySet(all))
    mergeCopyKeywords(
      all[i],
      all.filter((_, j) => j !== i),
    );
  all[i].warnings.unshift(copyNote(all, i));
  return all[i];
}

/**
 * The data set of `samples` that belongs to a workspace sample: by data set position (`index`, from the sample's
 * 'Data set' info), else by event count, else the first.
 */
export function pickSample(samples: FcsSample[], want: { index?: number; eventCount?: number }): FcsSample {
  if (samples.length === 1) return samples[0];
  if (want.index !== undefined) {
    const s = samples.find((x) => x.ds.dataset?.index === want.index);
    if (s) return s;
  }
  if (want.eventCount !== undefined) {
    const s = samples.find((x) => x.ds.eventCount === want.eventCount);
    if (s) return s;
  }
  return samples[0];
}

// ---------------------------------------------------------------- spillover

/** Keywords that may carry an acquisition spillover matrix. */
export const SPILL_KEYS = ['$SPILLOVER', 'SPILL', 'SPILLOVER', '$SPILL', '$COMP', 'COMP'];

type SpillSource = { keywords: Record<string, string>; channels: { name: string; label: string }[] };

/** Scatter, time and other non-fluorescence parameters (Beckman "FS INT", "SS-A", "TIME"; BD "FSC-A", "SSC-H" ...). */
const NON_FLUO = /FSC|SSC|^(FS|SS)([\s_-]|$)|^TIME|^EVENT|^WIDTH$/i;

/**
 * Values of a matrix keyword. A decimal comma (German locale, e.g. BD Accuri C6: "1,000,0,012,...") doubles the value
 * tokens; it is recognised by the token count (n names + 2 n^2 tokens instead of n^2) and joined back.
 */
function matrixValues(tokens: string[], n: number): number[] | null {
  const nn = n * n;
  while (tokens.length > nn && tokens[tokens.length - 1] === '') tokens = tokens.slice(0, -1);
  if (tokens.length === 2 * nn && tokens.every((t, i) => (i % 2 === 0 ? /^[+-]?\d+$/.test(t) : /^\d+([eE][+-]?\d+)?$/.test(t)))) {
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i += 2) out.push(Number(`${tokens[i]}.${tokens[i + 1]}`));
    return out;
  }
  if (tokens.length >= nn) return tokens.slice(0, nn).map((t) => (t === '' ? NaN : Number(t)));
  return null;
}

/** A parameter reference of a spillover keyword: a $PnN (or $PnS), else a parameter number (Gallios, Accuri, Apogee). */
function resolveRefs(ds: SpillSource, refs: string[]): string[] | null {
  const byName = refs.map(
    (nm) =>
      ds.channels.find((c) => c.name === nm) ??
      ds.channels.find((c) => c.name.toLowerCase() === nm.toLowerCase()) ??
      ds.channels.find((c) => c.label && c.label === nm),
  );
  if (byName.every((c) => c)) return byName.map((c) => c!.name);
  if (refs.every((r) => /^\d+$/.test(r))) {
    const idx = refs.map((r) => parseInt(r, 10));
    if (idx.every((k) => k >= 1 && k <= ds.channels.length) && new Set(idx).size === idx.length) return idx.map((k) => ds.channels[k - 1].name);
  }
  return null;
}

/**
 * $COMP without parameter names (Beckman Kaluza / CXP): an n x n matrix over all $PAR parameters (or over the
 * fluorescence parameters) in order. Checked against the $SPILLOVER of Gallios files that have both: $COMP is the
 * transposed spillover matrix with the off-diagonal values in percent ($COMP[detector][source] = 100 x spill) and 1 on
 * the diagonal. Only the fluorescence block is used.
 */
function compKeyword(ds: SpillSource, n: number, vals: number[]): { channels: string[]; matrix: number[][] } | null {
  const nPar = ds.channels.length;
  const fluo = ds.channels.map((c, i) => i).filter((i) => !NON_FLUO.test(ds.channels[i].name.trim()));
  let rows: number[];
  let sub: number[];
  if (n === nPar) {
    rows = ds.channels.map((_, i) => i);
    sub = fluo;
  } else if (n === fluo.length) {
    rows = fluo;
    sub = fluo;
  } else return null;
  if (!sub.length) return null;
  const at = (r: number, c: number) => vals[rows.indexOf(r) * n + rows.indexOf(c)];
  // percent or fractions, by the diagonal where it tells: 100 means percent, whatever the values off it. A diagonal of
  // 1 does not tell here: Kaluza / CXP write percent with 1 on the diagonal (Gallios files: values up to 71.9 off it),
  // so then values off it above 1 mean percent (unlike matrix files, see matrixio toFractions). The diagonal stays 1.
  let percent = sub.every((i) => Math.abs(at(i, i) - 100) < 1e-6);
  if (!percent) for (const i of sub) for (const j of sub) if (i !== j && Math.abs(at(i, j)) > 1) percent = true;
  const matrix = sub.map((src) => sub.map((det) => (src === det ? 1 : at(det, src) / (percent ? 100 : 1))));
  if (sub.some((i) => !(Math.abs(at(i, i) - 1) < 1e-6 || (percent && Math.abs(at(i, i) - 100) < 1e-6)))) return null;
  return { channels: sub.map((i) => ds.channels[i].name), matrix };
}

/** A $SPILLOVER keyword value: n, the n $PnN names, then the n x n values row by row ([fluorochrome][detector]). */
export function spilloverKeyword(channels: string[], matrix: number[][]): string {
  const num = (v: number) => (Math.abs(v) < 1e-15 ? '0' : String(Number(v.toPrecision(10))));
  return [String(channels.length), ...channels.map((c) => c.replace(/,/g, '_')), ...matrix.flatMap((r) => r.map(num))].join(',');
}

/** Extract the acquisition-defined spillover matrix, if any. */
export function getSpillover(ds: SpillSource): Spillover | null {
  for (const key of SPILL_KEYS) {
    const raw = ds.keywords[key];
    if (!raw) continue;
    const parts = raw.split(',').map((s) => s.trim());
    const n = parseInt(parts[0], 10);
    if (!/^\d+$/.test(parts[0]) || !n || n < 1) continue;
    let channels: string[] | null = null;
    let matrix: number[][] | null = null;
    // n parameter references, then n^2 values (decimal point, or a decimal comma doubling the value tokens)
    const named = parts.length >= 1 + n ? matrixValues(parts.slice(1 + n), n) : null;
    if (named) {
      channels = resolveRefs(ds, parts.slice(1, 1 + n));
      if (channels) {
        matrix = [];
        for (let i = 0; i < n; i++) matrix.push(named.slice(i * n, i * n + n));
      }
    }
    if (!matrix && /COMP$/.test(key)) {
      // $COMP without names: n then n^2 values
      const vals = matrixValues(parts.slice(1), n);
      const r = vals ? compKeyword(ds, n, vals) : null;
      if (r) {
        channels = r.channels;
        matrix = r.matrix;
      }
    }
    if (!matrix || !channels || matrix.some((row) => row.some((v) => !Number.isFinite(v)))) continue;
    // identity matrices carry no information
    const isIdentity = matrix.every((row, i) => row.every((v, j) => (i === j ? Math.abs(v - 1) < 1e-9 : Math.abs(v) < 1e-9)));
    if (isIdentity) return { channels, matrix, keyword: key + ' (identity)' };
    return { channels, matrix, keyword: key };
  }
  return null;
}

// ---------------------------------------------------------------- writer

export interface FcsWriteOptions {
  /** Pass the source FcsChannel to get a correct $PnR for data that were linearized on reading ($PnE log). */
  channels: { name: string; label?: string; range: number; logDecades?: number; logOffset?: number }[];
  data: Float32Array[]; // per channel, same length (linear scale values)
  keywords?: Record<string, string>; // extra keywords (non-reserved)
}

// $TIMESTEP is not written: values are written as given, i.e. as the reader returns them (Time already in seconds),
// so a reader must not multiply them again (FlowIO drops it the same way when it writes preprocessed events)
const RESERVED = /^\$(BEGINANALYSIS|ENDANALYSIS|BEGINDATA|ENDDATA|BEGINSTEXT|ENDSTEXT|BYTEORD|DATATYPE|MODE|NEXTDATA|PAR|TOT|TIMESTEP|P\d+[BENRSGD]|P\d+CALIBRATION|P\d+DISPLAY)$/i;
const DELIMS = ['|', '/', '\\', '!', '~', '^', '\x0c'];

/** Largest offset the 8-digit HEADER fields hold. */
const HEADER_MAX_OFFSET = 99999999;

/**
 * The 58-byte HEADER: version, then the begin / end offsets of TEXT, DATA and ANALYSIS. A segment that does not lie
 * entirely within the first 99,999,999 bytes gets 0 for both offsets (FCS 3.1; readers take them from $BEGINDATA /
 * $ENDDATA etc.), never a begin without its end.
 */
export function fcsHeader(version: string, segs: [number, number][]): string {
  let s = version.padEnd(10, ' ');
  for (const [b, e] of segs) {
    const fits = b >= 0 && e >= 0 && b <= HEADER_MAX_OFFSET && e <= HEADER_MAX_OFFSET;
    s += String(fits ? b : 0).padStart(8, ' ') + String(fits ? e : 0).padStart(8, ' ');
  }
  return s;
}

export function writeFcs(opts: FcsWriteOptions): Uint8Array {
  const nPar = opts.channels.length;
  const nEv = nPar ? opts.data[0].length : 0;
  const kw: [string, string][] = [];
  kw.push(['$BEGINANALYSIS', '0'], ['$ENDANALYSIS', '0'], ['$BEGINSTEXT', '0'], ['$ENDSTEXT', '0']);
  kw.push(['$BEGINDATA', '0'.repeat(20)], ['$ENDDATA', '0'.repeat(20)]);
  kw.push(['$BYTEORD', '1,2,3,4'], ['$DATATYPE', 'F'], ['$MODE', 'L'], ['$NEXTDATA', '0']);
  kw.push(['$PAR', String(nPar)], ['$TOT', String(nEv)]);
  opts.channels.forEach((c, i) => {
    const p = i + 1;
    // Values are written as linear floats: $PnR must cover them (log-amplified sources span f2..f2*10^f1).
    let range = c.logDecades && c.logDecades > 0 ? (c.logOffset && c.logOffset > 0 ? c.logOffset : 1) * Math.pow(10, c.logDecades) : c.range;
    let maxAbs = 0;
    const col = opts.data[i];
    for (let e = 0; e < col.length; e++) {
      const a = Math.abs(col[e]);
      if (a > maxAbs) maxAbs = a;
    }
    range = Math.max(1, Math.ceil(range) || 0, Math.ceil(maxAbs) + 1);
    kw.push([`$P${p}N`, c.name], [`$P${p}B`, '32'], [`$P${p}E`, '0,0'], [`$P${p}G`, '1'], [`$P${p}R`, String(range)]);
    if (c.label) kw.push([`$P${p}S`, c.label]);
  });
  for (const [k, v] of Object.entries(opts.keywords ?? {})) {
    if (RESERVED.test(k)) continue;
    if (v === undefined || v === null || String(v) === '') continue;
    kw.push([k, String(v)]);
  }
  // a delimiter that occurs in no keyword or value needs no escaping (escapes at value edges confuse many readers)
  const delim = DELIMS.find((d) => kw.every(([k, v]) => !k.includes(d) && !v.includes(d))) ?? '|';
  const esc = (s: string) => s.split(delim).join(delim + delim);
  const buildText = () => delim + kw.map(([k, v]) => esc(k) + delim + esc(v)).join(delim) + delim;
  const enc = new TextEncoder();
  const textStart = 256;
  let textBytes = enc.encode(buildText());
  let dataStart = textStart + textBytes.length;
  const dataLen = nEv * nPar * 4;
  let dataEnd = dataStart + dataLen - 1;
  const pad20 = (n: number) => String(n).padStart(20, '0');
  // an empty DATA segment is written as end = begin - 1 in both HEADER and TEXT (as FlowIO does; 0/0 reads as 1 byte)
  kw[4][1] = pad20(dataStart);
  kw[5][1] = pad20(dataEnd);
  textBytes = enc.encode(buildText());
  // length unchanged since fixed width
  dataStart = textStart + textBytes.length;
  dataEnd = dataStart + dataLen - 1;
  kw[4][1] = pad20(dataStart);
  kw[5][1] = pad20(dataEnd);
  textBytes = enc.encode(buildText());
  const total = dataStart + dataLen;
  const out = new Uint8Array(total);
  const hdr = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  out.fill(32, 0, textStart);
  hdr(
    fcsHeader('FCS3.1', [
      [textStart, textStart + textBytes.length - 1],
      [dataStart, dataEnd],
      [0, 0],
    ]),
    0,
  );
  out.set(textBytes, textStart);
  const dv = new DataView(out.buffer, dataStart, dataLen);
  let o = 0;
  for (let e = 0; e < nEv; e++) {
    for (let p = 0; p < nPar; p++) {
      dv.setFloat32(o, opts.data[p][e], true);
      o += 4;
    }
  }
  return out;
}
