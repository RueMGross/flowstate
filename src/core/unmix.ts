// Spectral unmixing core: reference signatures from single-stain controls, autofluorescence (AF)
// signatures, OLS / WLS / NNLS unmixing and quality metrics. Pure functions, no UI, no workers.
//
// Model: for one event, y (D detector values) = M a + noise, M = D x K signature matrix whose columns
// are the endmember signatures normalised to max = 1. The abundance a_k is therefore expressed in the
// intensity units of endmember k's peak detector (comparable to raw intensities / compensated values).
//
// Conventions (as in compensation.ts / fcs.ts): event data are Float32Array columns, one per FCS
// parameter (FcsDataset.data); a detector selection is a list of column indices `detectorIndex`, in
// the order of UnmixDef.detectors. All internal math is Float64, outputs are Float32.
//
// Methods:
//  - 'ols'  ordinary least squares, a = (M'M)^-1 M' y via a precomputed pseudo-inverse. Unbiased and
//           linear; the scientific default (negative populations stay centred on 0).
//  - 'wls'  weighted least squares with per-event Poisson-like weights w_d = 1/max(max(s_d,0) + offset_d,
//           floor_d), s = fitted signal (default) or observed signal. Reduces the spreading of bright
//           signals into other endmembers. Per-event K x K normal equations solved by Cholesky.
//  - 'nnls' OLS with a non-negativity constraint (active set). NNLS biases negative / dim populations
//           upwards (their noise can no longer go below zero, so means and spreads are distorted);
//           use it only for display purposes, never for MFI statistics. `nonNegative: true` applies the
//           same constraint to WLS.
//
// Typical use:
//   const { endmember } = signatureFromControl(controlSet, { unstained, name });   // per control
//   const af = afSignatures(unstainedSet).endmembers;                             // optional
//   const def = createUnmixDef({ detectors, endmembers, af, noiseSD: estimateNoiseSD(unstainedSet) });
//   unmixQuality(def);                                     // similarity, complexity, warnings
//   const cols = unmix(def, ds.data, resolveDetectors(def, channelNames));   // unmixOutputNames(def)
//
// Performance (single thread, 2.1 GHz Xeon VM, Node 22, 1M events x 48 detectors x 24 endmembers):
// OLS ~0.3 s, WLS ~3.5 s with the WebAssembly SIMD kernel (JavaScript fallback ~1 s / ~19 s); WLS
// cost per event ~ D K^2 / 2 + K^3 / 6 (64 x 30: ~7 s). NNLS runs in JavaScript (~12-16 s at 48 x 24
// when most events have negative components). Event ranges are independent: for more speed call
// unmixRange(prepareUnmix(def), cols, out, start, end) in Web Workers on slices of the columns
// (PreparedUnmix contains only plain data and typed arrays, so it can be posted to a worker).
import type { FcsDataset } from './fcs';
import { robustSlope } from './autocomp';

// ------------------------------------------------------------------------------------------ types

export type UnmixMethod = 'ols' | 'wls' | 'nnls';

export interface Endmember {
  /** Output channel name, e.g. the fluorochrome ("FITC", "BV711"). */
  name: string;
  /** Signature over UnmixDef.detectors, normalised to max = 1. */
  signature: number[];
  /** Unnormalised signature (median(pos) - median(neg) per detector), raw intensity units. */
  raw?: number[];
  /** Index (into UnmixDef.detectors) of the peak detector. */
  peak?: number;
  /** Provenance, e.g. control sample id or file name. */
  source?: string;
  nPos?: number;
  nNeg?: number;
}

export interface WlsOptions {
  /**
   * Additive variance term in signal units (= electronic noise variance / photo-electron gain),
   * a number or one value per detector. Default: def.noiseSD (heuristic: gain ~ noise SD), else
   * 1e-3 x the typical raw peak signal of the endmembers, else 100.
   */
  offset?: number | number[];
  /** Lower bound of the variance term (default: the offset, or 1 if the offset is 0). */
  floor?: number | number[];
  /** Signal used for the weights: 'fit' (fitted M a from OLS, less biased; default) or 'observed' y. */
  weightFrom?: 'fit' | 'observed';
  /** Re-weighting iterations (IRLS); 1 = weights from the OLS fit. Default 1. */
  iterations?: number;
}

/** Serializable unmixing definition (plain JSON). */
export interface UnmixDef {
  id: string;
  name: string;
  /** Detector channel names ($PnN, usually area channels), the rows of the signature matrix. */
  detectors: string[];
  /** Fluorochrome endmembers (in output order). */
  endmembers: Endmember[];
  /** Autofluorescence signature(s), from afSignatures(). */
  af?: Endmember[];
  /** Unmix AF as extra endmember(s). */
  includeAF: boolean;
  /**
   * With several AF signatures: 'best' (default) = per event the AF signature with the lowest OLS
   * residual is used (one "AF" output + "AF Index"); 'all' = every AF signature is an endmember.
   */
  afMode?: 'all' | 'best';
  method: UnmixMethod;
  /** Non-negativity constraint (implied by 'nnls'); also applicable to 'wls'. */
  nonNegative?: boolean;
  wls?: WlsOptions;
  /** Robust SD of negative/unstained events per detector (raw units), used for WLS defaults. */
  noiseSD?: number[];
  /** Extra output: per-event residual, 'ssr' = sum of squared residuals, 'rms' = sqrt(ssr / D). */
  residual?: 'none' | 'ssr' | 'rms';
  /** Creation time (ISO 8601). */
  created?: string;
}

/** Events of one sample restricted to the selected detectors. */
export interface EventSet {
  /** All parameters of the sample (FcsDataset.data). */
  columns: Float32Array[];
  /** Column index per detector, in UnmixDef.detectors order. */
  detectorIndex: number[];
  /** Event indices (a population); null/undefined = all events. */
  idx?: ArrayLike<number> | null;
  /** $PnR per detector, used for saturation detection (optional). */
  ranges?: number[];
}

// ------------------------------------------------------------------------------- small helpers

function nEventsOf(set: EventSet): number {
  const c = set.columns[set.detectorIndex[0]];
  return c ? c.length : 0;
}

function idxOf(set: EventSet): ArrayLike<number> {
  if (set.idx) return set.idx;
  const n = nEventsOf(set);
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

/** Evenly strided subset of at most `max` indices (deterministic). */
function subsample(idx: ArrayLike<number>, max: number): ArrayLike<number> {
  if (idx.length <= max) return idx;
  const out = new Uint32Array(max);
  const step = idx.length / max;
  for (let i = 0; i < max; i++) out[i] = idx[Math.floor(i * step)];
  return out;
}

function gatherSorted(col: Float32Array, idx: ArrayLike<number>): Float32Array {
  const a = new Float32Array(idx.length);
  let m = 0;
  for (let i = 0; i < idx.length; i++) {
    const v = col[idx[i]];
    if (v === v) a[m++] = v; // skip NaN
  }
  return (m < a.length ? a.subarray(0, m) : a).sort();
}

function quantileSorted(s: ArrayLike<number>, q: number): number {
  const n = s.length;
  if (!n) return NaN;
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function argmax(a: ArrayLike<number>): number {
  let b = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[b]) b = i;
  return b;
}

/** Robust SD (1.4826 x median absolute deviation from `m`) of sorted values. */
function madSD(sorted: ArrayLike<number>, m: number): number {
  const dev = new Float32Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) dev[i] = Math.abs(sorted[i] - m);
  dev.sort();
  return 1.4826 * quantileSorted(dev, 0.5);
}

/**
 * Scatter gate of a single-stain control: events at the maximum of a scatter channel are dropped; when every scatter
 * channel has one narrow main peak (beads: half-width < 0.08 decades), only events within max(6 SD, 0.4 decades)
 * of that peak are kept (singlets and doublets; aggregates and debris of bead controls can be brighter than the beads in
 * some detectors).
 */
export function scatterGate(idx: ArrayLike<number>, scatter: { values: ArrayLike<number>; range?: number }[]): { idx: Uint32Array; beads: boolean } {
  const ok: number[] = [];
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    let bad = false;
    for (const s of scatter) {
      const v = s.values[e];
      if (!(v === v) || (s.range && s.range > 0 && v >= 0.999 * s.range)) bad = true;
    }
    if (!bad) ok.push(e);
  }
  const lg = (v: number) => Math.log10(Math.max(v, 1));
  const peaks: { mode: number; sd: number }[] = [];
  const sub = subsample(ok, 50000);
  for (const s of scatter) {
    const l = new Float32Array(sub.length);
    for (let i = 0; i < sub.length; i++) l[i] = lg(s.values[sub[i]]);
    l.sort();
    const lo = quantileSorted(l, 0.001);
    const hi = quantileSorted(l, 0.999);
    const bw = 0.01;
    const NB = Math.max(1, Math.min(1000, Math.ceil((hi - lo) / bw)));
    const h = new Float64Array(NB);
    for (let i = 0; i < l.length; i++) {
      const b = Math.floor((l[i] - lo) / bw);
      if (b >= 0 && b < NB) h[b]++;
    }
    const sm = new Float64Array(NB);
    for (let i = 0; i < NB; i++) {
      let a = 0;
      let w = 0;
      for (let k = -4; k <= 4; k++) {
        const j = i + k;
        if (j < 0 || j >= NB) continue;
        const kw = Math.exp(-(k * k) / 8);
        a += h[j] * kw;
        w += kw;
      }
      sm[i] = a / w;
    }
    const m = argmax(sm);
    let l1 = m;
    while (l1 > 0 && sm[l1] >= 0.5 * sm[m]) l1--;
    let r1 = m;
    while (r1 < NB - 1 && sm[r1] >= 0.5 * sm[m]) r1++;
    peaks.push({ mode: lo + (m + 0.5) * bw, sd: ((r1 - l1) * bw) / 2 / 1.1774 });
  }
  const beads = ok.length >= 100 && peaks.length > 0 && peaks.every((p) => p.sd < 0.08);
  if (!beads) return { idx: Uint32Array.from(ok), beads: false };
  const keep: number[] = [];
  for (const e of ok) {
    let inside = true;
    scatter.forEach((s, j) => {
      if (Math.abs(lg(s.values[e]) - peaks[j].mode) > Math.max(6 * peaks[j].sd, 0.4)) inside = false;
    });
    if (inside) keep.push(e);
  }
  return { idx: Uint32Array.from(keep), beads: true };
}

/**
 * Peak detectors of common fluorochromes on Cytek Aurora / Northern Lights cytometers (detector names UV1..UV16,
 * V1..V16, B1..B14, YG1..YG10, R1..R8). Used as a hint only: the detector must exist and show a clear signal.
 */
const KNOWN_PEAKS: [string, string][] = [
  ['BUV395', 'UV2-A'],
  ['BUV496', 'UV7-A'],
  ['BUV563', 'UV9-A'],
  ['BUV615', 'UV10-A'],
  ['BUV661', 'UV11-A'],
  ['BUV737', 'UV14-A'],
  ['BUV805', 'UV16-A'],
  ['Spark UV 387', 'UV1-A'],
  ['BV421', 'V1-A'],
  ['Super Bright 436', 'V2-A'],
  ['Pacific Blue', 'V3-A'],
  ['eFluor 450', 'V3-A'],
  ['BV480', 'V5-A'],
  ['StarBright Violet 475', 'V5-A'],
  ['BV510', 'V7-A'],
  ['BV570', 'V8-A'],
  ['BV605', 'V10-A'],
  ['Super Bright 600', 'V10-A'],
  ['BV650', 'V11-A'],
  ['BV711', 'V13-A'],
  ['BV750', 'V15-A'],
  ['BV785', 'V16-A'],
  ['FITC', 'B2-A'],
  ['Alexa Fluor 488', 'B2-A'],
  ['AF488', 'B2-A'],
  ['Real Blue RB 545', 'B3-A'],
  ['RB545', 'B3-A'],
  ['Spark Blue 550', 'B3-A'],
  ['RB744', 'B12-A'],
  ['Real Blue RB 744', 'B12-A'],
  ['PE', 'YG1-A'],
  ['PE-Dazzle 594', 'YG3-A'],
  ['PE-CF594', 'YG3-A'],
  ['PE-eFluor 610', 'YG3-A'],
  ['PE-Texas Red', 'YG3-A'],
  ['PE-Cy5', 'YG5-A'],
  ['PE-Cy7', 'YG9-A'],
  ['APC', 'R1-A'],
  ['Alexa Fluor 647', 'R1-A'],
  ['AF647', 'R1-A'],
  ['Alexa Fluor 700', 'R4-A'],
  ['AF700', 'R4-A'],
  ['APC-R700', 'R4-A'],
  ['APC-Cy7', 'R7-A'],
  ['APC-H7', 'R7-A'],
  ['APC-eFluor 780', 'R7-A'],
  ['APC-Fire 750', 'R7-A'],
];

/** Pattern of a fluorochrome name: its letter / digit groups with optional separators, not inside a longer word. */
function fluorPattern(name: string): RegExp {
  const parts = name.toLowerCase().match(/[a-z]+|[0-9]+/g) ?? [];
  return new RegExp(`(^|[^a-z0-9])${parts.join('[\\s_\\-]*')}($|[^a-z0-9])`, 'i');
}
const KNOWN_PATTERNS = KNOWN_PEAKS.map(([f, d]) => ({ fluor: f, det: d, re: fluorPattern(f), len: f.replace(/[^a-z0-9]/gi, '').length }));

/**
 * The fluorochrome named in `text` (e.g. "Reference Group-A7 iNOS APC-eFluor 780 (Beads)") whose known peak detector
 * is among `detectorNames` (the longest name wins: "APC-eFluor 780" over "APC"), or null.
 */
export function fluorPeakHint(text: string, detectorNames: string[]): { fluor: string; detector: number } | null {
  let best: { fluor: string; detector: number; len: number } | null = null;
  const lower = detectorNames.map((d) => d.toLowerCase());
  for (const k of KNOWN_PATTERNS) {
    if (!k.re.test(text)) continue;
    const i = lower.indexOf(k.det.toLowerCase());
    if (i < 0) continue;
    if (!best || k.len > best.len) best = { fluor: k.fluor, detector: i, len: k.len };
  }
  return best ? { fluor: best.fluor, detector: best.detector } : null;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeMax(sig: ArrayLike<number>): number[] {
  let m = -Infinity;
  for (let i = 0; i < sig.length; i++) if (sig[i] > m) m = sig[i];
  if (!(m > 0) || !Number.isFinite(m)) throw new Error('Signature has no positive values');
  return Array.from(sig, (v) => v / m);
}

/** Robust SD of a sorted sample: (q84.13 - q15.87) / 2. */
function robustSD(sorted: ArrayLike<number>): number {
  return (quantileSorted(sorted, 0.8413) - quantileSorted(sorted, 0.1587)) / 2;
}

// ------------------------------------------------------------------------------ linear algebra

/** In-place Cholesky of the lower triangle of an n x n row-major matrix (stride s). false if not SPD. */
function cholesky(L: Float64Array, n: number, s: number): boolean {
  for (let j = 0; j < n; j++) {
    const rj = j * s;
    const d0 = L[rj + j];
    let d = d0;
    for (let k = 0; k < j; k++) d -= L[rj + k] * L[rj + k];
    if (!(d > 1e-13 * d0)) return false; // also catches NaN
    const ljj = Math.sqrt(d);
    L[rj + j] = ljj;
    const inv = 1 / ljj;
    for (let i = j + 1; i < n; i++) {
      const ri = i * s;
      let t = L[ri + j];
      for (let k = 0; k < j; k++) t -= L[ri + k] * L[rj + k];
      L[ri + j] = t * inv;
    }
  }
  return true;
}

/** Solve L L' x = b with the factor from cholesky(); x may alias b. */
function cholSolve(L: Float64Array, n: number, s: number, b: ArrayLike<number>, x: Float64Array): void {
  for (let i = 0; i < n; i++) {
    const ri = i * s;
    let t = b[i];
    for (let k = 0; k < i; k++) t -= L[ri + k] * x[k];
    x[i] = t / L[ri + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let t = x[i];
    for (let k = i + 1; k < n; k++) t -= L[k * s + i] * x[k];
    x[i] = t / L[i * s + i];
  }
}

/** Singular values of a D x K matrix given as K columns (one-sided Jacobi), descending. */
export function singularValues(cols: number[][]): number[] {
  const K = cols.length;
  if (!K) return [];
  const D = cols[0].length;
  const U = cols.map((c) => Float64Array.from(c));
  for (let sweep = 0; sweep < 60; sweep++) {
    let rotated = false;
    for (let p = 0; p < K - 1; p++) {
      for (let q = p + 1; q < K; q++) {
        const up = U[p];
        const uq = U[q];
        let a = 0,
          b = 0,
          g = 0;
        for (let d = 0; d < D; d++) {
          a += up[d] * up[d];
          b += uq[d] * uq[d];
          g += up[d] * uq[d];
        }
        if (Math.abs(g) <= 1e-15 * Math.sqrt(a * b) || g === 0) continue;
        rotated = true;
        const zeta = (b - a) / (2 * g);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const sn = c * t;
        for (let d = 0; d < D; d++) {
          const x = up[d];
          const y = uq[d];
          up[d] = c * x - sn * y;
          uq[d] = sn * x + c * y;
        }
      }
    }
    if (!rotated) break;
  }
  return U.map((u) => Math.sqrt(u.reduce((s, v) => s + v * v, 0))).sort((x, y) => y - x);
}

// ------------------------------------------------------------------------------ saturation

/**
 * Saturation level of a detector column: values >= level are saturated (Infinity if none found).
 * Detected from $PnR (>= 99.95 % of the range) or from a pile-up of >= 3 events at the exact maximum.
 */
export function detectSaturation(values: Float32Array, range?: number): number {
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  if (!Number.isFinite(max)) return Infinity;
  let level = Infinity;
  if (range && range > 0 && max >= range * 0.9995) level = range * 0.9995;
  let atMax = 0;
  for (let i = 0; i < values.length; i++) if (values[i] === max) atMax++;
  if (atMax >= 3 && max > 0) level = Math.min(level, max);
  return level;
}

/** Saturation levels for the detectors of an event set. */
export function saturationLevels(set: EventSet): number[] {
  return set.detectorIndex.map((ci, d) => detectSaturation(set.columns[ci], set.ranges?.[d]));
}

// ------------------------------------------------------------------------- reference signatures

export interface SignatureResult {
  /** Normalised signature (max = 1). */
  signature: number[];
  /** median(pos) - median(neg) per detector. */
  raw: number[];
  /** Detector index of the maximum. */
  peak: number;
  posMedian: number[];
  negMedian: number[];
  /** Robust SD of the negatives per detector. */
  negSD: number[];
  nPos: number;
  nNeg: number;
  /** Positive events saturated in at least one detector. */
  nSaturated: number;
  /** Detectors with saturated positive events. */
  saturatedDetectors: number[];
  /** Estimator actually used. */
  estimator: 'median' | 'regression';
  warnings: string[];
}

/**
 * Signature of one fluorochrome: median(pos) - median(neg) per detector, normalised to max = 1.
 * `pos` and `neg` may come from different samples (e.g. negatives from an unstained control); both
 * must list the same detectors. Statistics use at most `maxEvents` (evenly strided) events.
 * estimator 'regression' (optional): detector d = robust slope of d vs the peak detector over the
 * positives x the peak's median difference, as autocomp's 'regression' method. It is less sensitive
 * to background differences between the positive cells and the negatives; used only when the
 * positives span a range of intensities (>= 200 events, (q90 - q10) / median > 0.4), else median.
 */
export function buildSignature(
  pos: EventSet,
  neg: EventSet,
  opts: { maxEvents?: number; saturation?: number[]; detectorNames?: string[]; estimator?: 'median' | 'regression' } = {},
): SignatureResult {
  const D = pos.detectorIndex.length;
  if (neg.detectorIndex.length !== D) throw new Error('Positive and negative populations have different detector counts');
  const maxEv = opts.maxEvents ?? 200000;
  const warnings: string[] = [];
  const dn = (d: number) => opts.detectorNames?.[d] ?? `detector ${d + 1}`;
  const pAll = idxOf(pos);
  const pIdx = subsample(pAll, maxEv);
  const nIdx = subsample(idxOf(neg), maxEv);
  const sat = opts.saturation ?? saturationLevels(pos);
  // saturated positives
  const satDet = new Uint32Array(D);
  let nSat = 0;
  for (let i = 0; i < pAll.length; i++) {
    const e = pAll[i];
    let any = false;
    for (let d = 0; d < D; d++)
      if (pos.columns[pos.detectorIndex[d]][e] >= sat[d]) {
        satDet[d]++;
        any = true;
      }
    if (any) nSat++;
  }
  const posMedian: number[] = [];
  const negMedian: number[] = [];
  const negSD: number[] = [];
  for (let d = 0; d < D; d++) {
    posMedian.push(quantileSorted(gatherSorted(pos.columns[pos.detectorIndex[d]], pIdx), 0.5));
    const ns = gatherSorted(neg.columns[neg.detectorIndex[d]], nIdx);
    negMedian.push(quantileSorted(ns, 0.5));
    negSD.push(robustSD(ns));
  }
  const raw = posMedian.map((v, d) => v - negMedian[d]);
  let peak = argmax(raw);
  let estimator: 'median' | 'regression' = 'median';
  if (opts.estimator === 'regression' && raw[peak] > 0) {
    const pc = pos.columns[pos.detectorIndex[peak]];
    const ps = gatherSorted(pc, pIdx);
    const spread = (quantileSorted(ps, 0.9) - quantileSorted(ps, 0.1)) / Math.max(1e-9, Math.abs(quantileSorted(ps, 0.5)));
    if (pAll.length >= 200 && spread > 0.4) {
      estimator = 'regression';
      const ev = Array.from(subsample(pAll, 20000));
      const rp = raw[peak];
      for (let d = 0; d < D; d++) if (d !== peak) raw[d] = robustSlope(pc, pos.columns[pos.detectorIndex[d]], ev) * rp;
      peak = argmax(raw);
    } else warnings.push('Regression estimator needs >= 200 positives with a range of intensities: median used');
  }
  let signature: number[];
  if (raw[peak] > 0 && Number.isFinite(raw[peak])) signature = raw.map((v) => v / raw[peak]);
  else {
    signature = raw.map(() => 0);
    warnings.push('No positive signal above the negative population');
  }
  if (pAll.length < 50) warnings.push(`Only ${pAll.length} positive events`);
  if (nIdx.length < 50) warnings.push(`Only ${nIdx.length} negative events`);
  const satList: number[] = [];
  satDet.forEach((c, d) => c && satList.push(d));
  if (nSat) {
    const frac = nSat / Math.max(1, pAll.length);
    warnings.push(
      `${nSat} positive event(s) (${(100 * frac).toFixed(1)} %) saturated in ${satList.map(dn).join(', ')}` +
        (frac > 0.05 ? ': exclude them or reduce the detector gain' : ''),
    );
  }
  const minSig = Math.min(...signature);
  if (minSig < -0.05) warnings.push(`Signature is negative in ${dn(signature.indexOf(minSig))} (${minSig.toFixed(3)}): check the negative population`);
  // separation in the peak detector
  if (raw[peak] > 0 && raw[peak] < 3 * negSD[peak]) warnings.push(`Weak positive signal (${(raw[peak] / Math.max(1e-9, negSD[peak])).toFixed(1)} x negative SD)`);
  return { signature, raw, peak, posMedian, negMedian, negSD, nPos: pAll.length, nNeg: nIdx === neg.idx ? nIdx.length : idxOf(neg).length, nSaturated: nSat, saturatedDetectors: satList, estimator, warnings };
}

export interface AutoSelectOptions {
  /** Fraction of the brightest (non-saturated) events used as positives. Default 0.03. */
  topFraction?: number;
  /** Minimum number of positives taken if available above the negatives (default 100). */
  minEvents?: number;
  /** Fraction of the very brightest events skipped (aggregates, non-linearity). Default 0.001. */
  skipTopFraction?: number;
  /** Unstained sample (same detectors): used to rank detectors and as negative (see negativeFrom). */
  unstained?: EventSet;
  /**
   * Negative population: 'control' = the dimmest mode of the control itself (internal negative),
   * 'unstained' = the unstained sample, 'auto' (default) = the internal negative when the control
   * has a distinct one (>= 5 % and >= 100 events, e.g. bead controls or partially stained cells),
   * else the unstained sample if given. Bead controls should not use unstained cells as negative.
   */
  negativeFrom?: 'auto' | 'control' | 'unstained';
  /** Force the detector used for selection (index into detectors). */
  peakDetector?: number;
  /** Saturation level per detector (default: detectSaturation on the control). */
  saturation?: number[];
  /** Max events used for detector ranking (default 50000). */
  maxEvents?: number;
  detectorNames?: string[];
  /**
   * Text naming the fluorochrome (e.g. the control's sample name "CD11b BV510 (Beads)"): a fluorochrome with a known
   * peak detector on this instrument (fluorPeakHint) is selected in that detector when it shows a clear positive population.
   */
  fluorochrome?: string;
  /**
   * Scatter columns of the control (FSC-A, SSC-A with their $PnR): events at the scatter maximum are excluded, and for
   * bead controls (one narrow scatter peak) so are events outside the bead population (aggregates, debris).
   */
  scatter?: { values: ArrayLike<number>; range?: number }[];
}

export interface AutoSelection {
  /** Detector used for selection (index into detectors). */
  peak: number;
  /** Positive events (idx into the control). */
  positive: EventSet;
  /** Negative events (control or unstained). */
  negative: EventSet;
  negSource: 'control' | 'unstained';
  /** Lowest peak-detector value among the positives. */
  posThreshold: number;
  /** Upper bound of the negative population in the peak detector. */
  negUpper: number;
  /** Events of the control population saturated in any detector (excluded). */
  nSaturated: number;
  /** Robust signal per detector used to rank detectors. */
  scores: number[];
  warnings: string[];
}

/**
 * Locate the negative (dimmest) mode of a distribution: histogram on an asinh scale, the lowest
 * local maximum with >= 3 % of the highest peak. Returns its upper bound (valley to the next peak,
 * or mode + 3 half-widths) in linear units.
 */
function negativeMode(sorted: Float32Array): { mode: number; upper: number; lower: number } {
  const n = sorted.length;
  const qlo = quantileSorted(sorted, 0.002);
  const qhi = quantileSorted(sorted, 0.998);
  let cf = 2 * (quantileSorted(sorted, 0.25) - quantileSorted(sorted, 0.02));
  if (!(cf > 0)) cf = Math.max(1, Math.abs(quantileSorted(sorted, 0.5)) * 0.1);
  const T = (x: number) => Math.asinh(x / cf);
  const Ti = (t: number) => Math.sinh(t) * cf;
  const tlo = T(qlo);
  const thi = T(qhi);
  if (!(thi > tlo)) return { mode: qlo, upper: qhi, lower: qlo };
  const NB = 256;
  const bw = (thi - tlo) / NB;
  const h = new Float64Array(NB);
  for (let i = 0; i < n; i++) {
    const b = Math.floor((T(sorted[i]) - tlo) / bw);
    if (b >= 0 && b < NB) h[b]++;
    else if (b === NB) h[NB - 1]++;
  }
  // gaussian smoothing, sigma = 2 bins
  const sm = new Float64Array(NB);
  const R = 6;
  const ker: number[] = [];
  for (let k = -R; k <= R; k++) ker.push(Math.exp(-(k * k) / 8));
  for (let i = 0; i < NB; i++) {
    let s = 0,
      w = 0;
    for (let k = -R; k <= R; k++) {
      const j = i + k;
      if (j < 0 || j >= NB) continue;
      s += h[j] * ker[k + R];
      w += ker[k + R];
    }
    sm[i] = s / w;
  }
  const hmax = sm[argmax(sm)];
  const peaks: number[] = [];
  for (let i = 0; i < NB; i++) {
    const l = i > 0 ? sm[i - 1] : -1;
    const r = i < NB - 1 ? sm[i + 1] : -1;
    if (sm[i] >= l && sm[i] > r && sm[i] >= 0.03 * hmax) peaks.push(i);
  }
  const m = peaks.length ? peaks[0] : argmax(sm);
  let hw = 1;
  while (m + hw < NB && sm[m + hw] >= 0.5 * sm[m]) hw++;
  let upperBin = Math.min(NB - 1, m + 3 * hw);
  if (peaks.length > 1) {
    let v = m;
    for (let i = m; i <= peaks[1]; i++) if (sm[i] < sm[v]) v = i;
    upperBin = Math.min(upperBin, v);
  }
  return { mode: Ti(tlo + (m + 0.5) * bw), upper: Ti(tlo + (upperBin + 1) * bw), lower: qlo };
}

/**
 * Automatic positive / negative selection for a single-stain control (beads or cells):
 *  0. events at a scatter maximum, outside the bead scatter population (bead controls, see scatterGate) and (spectral
 *     cytometers) bright in all detectors are left out: aggregates and debris;
 *  1. rank detectors by separation q(1 - topFraction) - reference over the square root of the reference's robust SD
 *     (reference = the same quantile of the unstained sample for cell controls, else the median of the control's
 *     lower half) and pick the best; a fluorochrome named in `fluorochrome` with a known peak detector (fluorPeakHint)
 *     takes that detector when it shows a clear positive population;
 *  2. negatives: the dimmest mode of the control in that detector (asinh histogram) or the
 *     unstained sample (see negativeFrom);
 *  3. positives: the brightest `topFraction` of the non-saturated events (an event saturated in any
 *     detector is excluded), above the negative population, skipping the top `skipTopFraction`.
 */
export function autoSelectPopulations(control: EventSet, opts: AutoSelectOptions = {}): AutoSelection {
  const D = control.detectorIndex.length;
  const topFrac = opts.topFraction ?? 0.03;
  const minEv = opts.minEvents ?? 100;
  const skipFrac = opts.skipTopFraction ?? 0.001;
  const maxEv = opts.maxEvents ?? 50000;
  const warnings: string[] = [];
  const dn = (d: number) => opts.detectorNames?.[d] ?? `detector ${d + 1}`;
  const cols = control.detectorIndex.map((ci) => control.columns[ci]);
  const sat = opts.saturation ?? saturationLevels(control);
  const all = idxOf(control);
  // non-saturated events
  const ok = new Uint32Array(all.length);
  let nOk = 0;
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    let s = false;
    for (let d = 0; d < D; d++)
      if (!(cols[d][e] < sat[d])) {
        s = true; // saturated or NaN
        break;
      }
    if (!s) ok[nOk++] = e;
  }
  const good = ok.subarray(0, nOk);
  const nSaturated = all.length - nOk;
  const un = opts.unstained;
  const negFrom = opts.negativeFrom ?? 'auto';
  if (negFrom === 'unstained' && !un) throw new Error('negativeFrom = unstained but no unstained sample given');
  // events of the bead population only (bead controls: aggregates and debris lie outside its narrow scatter peak)
  let pool: ArrayLike<number> = good;
  let nScatterOut = 0;
  let beadGate = false;
  if (opts.scatter?.length) {
    const g = scatterGate(pool, opts.scatter);
    nScatterOut = pool.length - g.idx.length;
    beadGate = g.beads;
    if (g.idx.length >= Math.max(50, 0.2 * pool.length)) pool = g.idx;
  }
  // per-detector negative level and spread: the lower half of the control
  const sub0 = subsample(pool, maxEv);
  const negMed: number[] = [];
  const negSD: number[] = [];
  for (let d = 0; d < D; d++) {
    const s = gatherSorted(cols[d], sub0);
    const lower = s.subarray(0, Math.max(1, Math.ceil(s.length / 2)));
    const m = quantileSorted(lower, 0.5);
    negMed.push(m);
    negSD.push(madSD(lower, m));
  }
  // events bright in every detector of a spectral cytometer: aggregates / debris, not the stain of one fluorochrome
  // (with few detectors, bright tandems or autofluorescent cells can be bright in all of them)
  if (D >= 16) {
    const keep: number[] = [];
    const need = Math.ceil(0.95 * D);
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      let k = 0;
      for (let d = 0; d < D; d++) if (cols[d][e] > negMed[d] + 10 * negSD[d]) k++;
      if (k < need) keep.push(e);
    }
    const nAgg = pool.length - keep.length;
    if (nAgg > 0 && keep.length >= 50) {
      pool = Uint32Array.from(keep);
      if (nAgg >= Math.max(5, 0.005 * good.length)) warnings.push(`${nAgg} event(s) bright in all detectors (aggregates or debris) excluded`);
    }
  }
  if (nScatterOut > 0 && beadGate && nScatterOut >= Math.max(5, 0.01 * good.length))
    warnings.push(`${nScatterOut} event(s) outside the bead scatter population (aggregates or debris) excluded`);
  // 1. detector ranking: separation of the bright events from the negatives, relative to the square root of the
  // negatives' spread (the raw difference favours wide, noisy detectors; a stain index favours quiet ones with little signal)
  const sub = subsample(pool, maxEv);
  const unSub = un ? subsample(idxOf(un), maxEv) : null;
  const scores: number[] = [];
  const sep: number[] = [];
  for (let d = 0; d < D; d++) {
    const s = gatherSorted(cols[d], sub);
    const hi = quantileSorted(s, 1 - topFrac);
    // reference without the stain: the unstained sample at the same quantile (cells: autofluorescence differs between
    // detectors), else (bead controls, no unstained sample) the control's own negatives
    let base = negMed[d];
    let sd = negSD[d];
    if (un && unSub && (!beadGate || negFrom === 'unstained')) {
      const us = gatherSorted(un.columns[un.detectorIndex[d]], unSub);
      base = quantileSorted(us, 1 - topFrac);
      sd = madSD(us, quantileSorted(us, 0.5));
    }
    const sdf = Math.max(sd, 1e-6 * Math.max(1, Math.abs(hi)), 1);
    scores.push((hi - base) / Math.sqrt(sdf));
    sep.push((hi - base) / sdf);
  }
  let peak = opts.peakDetector ?? argmax(scores);
  // the fluorochrome named in the sample: its known peak detector when that shows a clear positive population
  if (opts.peakDetector === undefined && opts.fluorochrome && opts.detectorNames) {
    const hint = fluorPeakHint(opts.fluorochrome, opts.detectorNames);
    if (hint && hint.detector !== peak) {
      if (sep[hint.detector] >= 5) {
        warnings.push(`Peak detector ${dn(hint.detector)} chosen for ${hint.fluor} (from the sample name); ${dn(peak)} has brighter events, possibly debris or another dye: check the control`);
        peak = hint.detector;
      } else warnings.push(`${hint.fluor} usually peaks in ${dn(hint.detector)}, but this control peaks in ${dn(peak)}: check the control and its name`);
    }
  }
  if (!(scores[peak] > 0)) warnings.push('No detector shows a signal above the background');
  const good2 = pool;
  // 2. negatives
  const pv = gatherSorted(cols[peak], good2);
  let negative: EventSet;
  let negUpper: number;
  const nm = negativeMode(pv);
  const internal: number[] = [];
  for (let i = 0; i < good2.length; i++) {
    const v = cols[peak][good2[i]];
    if (v >= nm.lower && v <= nm.upper) internal.push(good2[i]);
  }
  const distinct = internal.length >= Math.max(100, 0.05 * good2.length) && pv.length > 0 && pv[pv.length - 1] > nm.upper;
  const useUnstained = !!un && (negFrom === 'unstained' || (negFrom === 'auto' && !distinct));
  if (useUnstained && un) {
    const uIdx = idxOf(un);
    const us = gatherSorted(un.columns[un.detectorIndex[peak]], subsample(uIdx, 200000));
    negUpper = quantileSorted(us, 0.995);
    negative = { ...un, idx: uIdx };
  } else {
    negUpper = nm.upper;
    negative = { ...control, idx: Uint32Array.from(internal) };
  }
  // 3. positives
  const n = pv.length;
  const skip = Math.floor(n * skipFrac);
  const iHi = n - 1 - skip;
  const nTake = Math.min(n, Math.max(Math.ceil(n * topFrac), minEv));
  const iLo = Math.max(0, iHi - nTake + 1);
  const hiVal = n ? pv[iHi] : NaN;
  const loVal = n ? pv[iLo] : NaN;
  const pos: number[] = [];
  for (let i = 0; i < good2.length; i++) {
    const v = cols[peak][good2[i]];
    if (v >= loVal && v <= hiVal && v > negUpper) pos.push(good2[i]);
  }
  const posThreshold = pos.length ? Math.max(loVal, negUpper) : NaN;
  if (pos.length < 20) warnings.push(`Only ${pos.length} positive events above the negative population in ${dn(peak)}`);
  if (nSaturated) {
    const brightTotal = pos.length + nSaturated;
    const frac = nSaturated / Math.max(1, all.length);
    if (nSaturated > 0.1 * brightTotal) warnings.push(`${nSaturated} saturated event(s) excluded (${(100 * frac).toFixed(2)} % of the control): reduce the detector gain`);
    else warnings.push(`${nSaturated} saturated event(s) excluded`);
  }
  if (!useUnstained && negative.idx && negative.idx.length < 50) warnings.push('No clear negative population: use an unstained / universal negative');
  return {
    peak,
    positive: { ...control, idx: Uint32Array.from(pos) },
    negative,
    negSource: useUnstained ? 'unstained' : 'control',
    posThreshold,
    negUpper,
    nSaturated,
    scores,
    warnings,
  };
}

/** autoSelectPopulations + buildSignature, returning a ready Endmember. */
export function signatureFromControl(
  control: EventSet,
  opts: AutoSelectOptions & { name?: string; source?: string; estimator?: 'median' | 'regression' } = {},
): { endmember: Endmember; selection: AutoSelection; result: SignatureResult } {
  const selection = autoSelectPopulations(control, opts);
  const result = buildSignature(selection.positive, selection.negative, { saturation: opts.saturation, detectorNames: opts.detectorNames, estimator: opts.estimator });
  const endmember: Endmember = {
    name: opts.name ?? opts.source ?? 'Endmember',
    signature: result.signature,
    raw: result.raw,
    peak: result.peak,
    source: opts.source,
    nPos: result.nPos,
    nNeg: result.nNeg,
  };
  return { endmember, selection, result: { ...result, warnings: [...selection.warnings, ...result.warnings] } };
}

// ------------------------------------------------------------------------------ autofluorescence

export interface AfResult {
  endmembers: Endmember[];
  /** Number of (clustered) events per signature. */
  sizes: number[];
  warnings: string[];
}

/**
 * Autofluorescence signature(s) from an unstained sample. k = 1 (default): the per-detector median of
 * all events, normalised to max = 1. k > 1: k-means (k-means++ init, cosine geometry) on the
 * L2-normalised spectra of the brighter half of the events (dim events are noise-dominated); each
 * cluster's signature is the median spectrum of its members. Sorted by cluster size.
 */
export function afSignatures(unstained: EventSet, opts: { k?: number; maxEvents?: number; seed?: number; iterations?: number; name?: string } = {}): AfResult {
  const k = Math.max(1, Math.floor(opts.k ?? 1));
  const D = unstained.detectorIndex.length;
  const cols = unstained.detectorIndex.map((ci) => unstained.columns[ci]);
  const warnings: string[] = [];
  const base = opts.name ?? 'AF';
  const idx = subsample(idxOf(unstained), opts.maxEvents ?? (k === 1 ? 200000 : 20000));
  const medianSpectrum = (ev: ArrayLike<number>) => cols.map((c) => quantileSorted(gatherSorted(c, ev), 0.5));
  const mk = (raw: number[], name: string, n: number): Endmember => {
    const peak = argmax(raw);
    if (!(raw[peak] > 0)) warnings.push(`${name}: no positive autofluorescence signal`);
    return { name, signature: raw[peak] > 0 ? raw.map((v) => v / raw[peak]) : raw.map(() => 0), raw, peak, source: 'unstained', nPos: n };
  };
  if (k === 1 || idx.length < 10 * k) {
    if (k > 1) warnings.push('Too few events for AF clustering; using one AF signature');
    return { endmembers: [mk(medianSpectrum(idx), base, idx.length)], sizes: [idx.length], warnings };
  }
  // unit-norm spectra (negatives clipped) of the brighter half
  const norms = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    let s = 0;
    for (let d = 0; d < D; d++) {
      const v = Math.max(0, cols[d][idx[i]]);
      s += v * v;
    }
    norms[i] = Math.sqrt(s);
  }
  const medNorm = quantileSorted(Float64Array.from(norms).sort(), 0.5);
  const use: number[] = [];
  for (let i = 0; i < idx.length; i++) if (norms[i] >= medNorm && norms[i] > 0) use.push(i);
  const N = use.length;
  const X = new Float64Array(N * D);
  use.forEach((i, r) => {
    for (let d = 0; d < D; d++) X[r * D + d] = Math.max(0, cols[d][idx[i]]) / norms[i];
  });
  const rand = rng(opts.seed ?? 1);
  const C = new Float64Array(k * D);
  // k-means++
  const dist = new Float64Array(N).fill(Infinity);
  let first = Math.floor(rand() * N);
  for (let c = 0; c < k; c++) {
    if (c > 0) {
      let tot = 0;
      for (let r = 0; r < N; r++) tot += dist[r];
      let t = rand() * tot;
      first = N - 1;
      for (let r = 0; r < N; r++) {
        t -= dist[r];
        if (t <= 0) {
          first = r;
          break;
        }
      }
    }
    for (let d = 0; d < D; d++) C[c * D + d] = X[first * D + d];
    for (let r = 0; r < N; r++) {
      let s = 0;
      for (let d = 0; d < D; d++) {
        const z = X[r * D + d] - C[c * D + d];
        s += z * z;
      }
      if (s < dist[r]) dist[r] = s;
    }
  }
  const assign = new Int32Array(N).fill(-1);
  for (let it = 0; it < (opts.iterations ?? 50); it++) {
    let changed = 0;
    for (let r = 0; r < N; r++) {
      let best = 0,
        bd = Infinity;
      for (let c = 0; c < k; c++) {
        let s = 0;
        for (let d = 0; d < D; d++) {
          const z = X[r * D + d] - C[c * D + d];
          s += z * z;
        }
        if (s < bd) {
          bd = s;
          best = c;
        }
      }
      if (assign[r] !== best) {
        assign[r] = best;
        changed++;
      }
    }
    C.fill(0);
    const cnt = new Float64Array(k);
    for (let r = 0; r < N; r++) {
      cnt[assign[r]]++;
      for (let d = 0; d < D; d++) C[assign[r] * D + d] += X[r * D + d];
    }
    for (let c = 0; c < k; c++) {
      let s = 0;
      for (let d = 0; d < D; d++) s += C[c * D + d] * C[c * D + d];
      const nrm = Math.sqrt(s) || 1;
      for (let d = 0; d < D; d++) C[c * D + d] /= nrm;
    }
    if (!changed) break;
  }
  const groups: number[][] = Array.from({ length: k }, () => []);
  for (let r = 0; r < N; r++) groups[assign[r]].push(idx[use[r]]);
  const res = groups
    .filter((g) => g.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((g, i) => ({ em: mk(medianSpectrum(g), `${base}${i + 1}`, g.length), n: g.length }));
  if (res.length < k) warnings.push(`Only ${res.length} non-empty AF clusters`);
  return { endmembers: res.map((r) => r.em), sizes: res.map((r) => r.n), warnings };
}

// ------------------------------------------------------------------------------ quality metrics

/** Cosine similarity between signatures (K x K). */
export function similarityMatrix(signatures: number[][]): number[][] {
  const nrm = signatures.map((s) => Math.sqrt(s.reduce((a, v) => a + v * v, 0)));
  return signatures.map((a, i) =>
    signatures.map((b, j) => {
      if (i === j) return 1;
      let s = 0;
      for (let d = 0; d < a.length; d++) s += a[d] * b[d];
      return nrm[i] > 0 && nrm[j] > 0 ? s / (nrm[i] * nrm[j]) : 0;
    }),
  );
}

/**
 * Complexity index: condition number (sigma_max / sigma_min) of the D x K matrix of signatures
 * normalised to max = 1. 1 = orthogonal signatures; Infinity = linearly dependent (unmixable).
 */
export function complexityIndex(signatures: number[][]): number {
  if (!signatures.length) return NaN;
  const sv = singularValues(signatures.map((s) => normalizeMax(s)));
  const lo = sv[sv.length - 1];
  return lo > 1e-12 * sv[0] ? sv[0] / lo : Infinity;
}

export interface QualityReport {
  names: string[];
  similarity: number[][];
  complexity: number;
  /** Pairs with cosine similarity above the threshold. */
  similarPairs: { a: string; b: string; similarity: number }[];
  warnings: string[];
}

/** Similarity, complexity and warnings for the endmembers that a definition would unmix with. */
export function unmixQuality(def: UnmixDef, opts: { similarityThreshold?: number } = {}): QualityReport {
  const thr = opts.similarityThreshold ?? 0.98;
  const ems = [...def.endmembers, ...(def.includeAF ? def.af ?? [] : [])];
  const names = ems.map((e) => e.name);
  const sigs = ems.map((e) => e.signature);
  const similarity = similarityMatrix(sigs);
  let complexity = NaN;
  const warnings: string[] = [];
  try {
    complexity = complexityIndex(sigs);
  } catch (e) {
    warnings.push(String((e as Error).message));
  }
  const similarPairs: QualityReport['similarPairs'] = [];
  for (let i = 0; i < ems.length; i++)
    for (let j = i + 1; j < ems.length; j++)
      if (similarity[i][j] > thr) {
        similarPairs.push({ a: names[i], b: names[j], similarity: similarity[i][j] });
        warnings.push(`${names[i]} and ${names[j]} are too similar (${similarity[i][j].toFixed(3)} > ${thr}): expect large spreading or unmixing errors`);
      }
  if (ems.length > def.detectors.length) warnings.push(`More endmembers (${ems.length}) than detectors (${def.detectors.length}): not solvable`);
  else if (!Number.isFinite(complexity)) warnings.push('Signature matrix is singular');
  else if (complexity > 100) warnings.push(`High complexity index (${complexity.toFixed(1)})`);
  return { names, similarity, complexity, similarPairs, warnings };
}

export interface SpreadInput {
  /** Endmember (output index) of the single-stain control. */
  endmember: number;
  /** Unmixed abundance columns of the positive events, one per output endmember. */
  pos: Float32Array[];
  /** Unmixed abundance columns of the negative events. */
  neg: Float32Array[];
}

/**
 * Spillover spreading matrix (Nguyen et al., Cytometry A 2013), here on unmixed data:
 * SS[i][j] = sqrt(max(0, rSD_j(pos)^2 - rSD_j(neg)^2)) / sqrt(median_i(pos) - median_i(neg)),
 * with rSD = 84.13th percentile - median, i = the control's endmember, j = any other endmember.
 * Units sqrt(intensity). Rows without a control and the diagonal are NaN.
 */
export function spilloverSpreadingMatrix(controls: SpreadInput[], nEndmembers: number): number[][] {
  const M = Array.from({ length: nEndmembers }, () => new Array<number>(nEndmembers).fill(NaN));
  const rsd = (s: Float32Array) => quantileSorted(s, 0.8413) - quantileSorted(s, 0.5);
  for (const c of controls) {
    const i = c.endmember;
    const pi = Float32Array.from(c.pos[i]).sort();
    const ni = Float32Array.from(c.neg[i]).sort();
    const dF = quantileSorted(pi, 0.5) - quantileSorted(ni, 0.5);
    for (let j = 0; j < nEndmembers; j++) {
      if (j === i) continue;
      const pj = Float32Array.from(c.pos[j]).sort();
      const nj = Float32Array.from(c.neg[j]).sort();
      const v = rsd(pj) ** 2 - rsd(nj) ** 2;
      M[i][j] = dF > 0 ? Math.sqrt(Math.max(0, v)) / Math.sqrt(dF) : NaN;
    }
  }
  return M;
}

export interface ControlRef {
  /** Index of the control's endmember among the unmix outputs. */
  endmember: number;
  pos: EventSet;
  neg: EventSet;
}

/**
 * Unmix the positive and negative events of single-stain controls and report
 *  - ssm: spillover spreading matrix (see spilloverSpreadingMatrix),
 *  - leakage[i][j] = (median_j(pos) - median_j(neg)) / (median_i(pos) - median_i(neg)): residual
 *    signal of control i in endmember j after unmixing (0 = perfect, 1 on the diagonal).
 */
export function controlSpread(def: UnmixDef, controls: ControlRef[]): { names: string[]; ssm: number[][]; leakage: number[][] } {
  const prep = prepareUnmix(def);
  const K = prep.nAbund;
  const sub = (s: EventSet) => {
    const idx = idxOf(s);
    const cols = s.detectorIndex.map((ci) => {
      const src = s.columns[ci];
      const a = new Float32Array(idx.length);
      for (let i = 0; i < idx.length; i++) a[i] = src[idx[i]];
      return a;
    });
    return unmixPrepared(prep, cols, cols.map((_, d) => d)).slice(0, K);
  };
  const inputs: SpreadInput[] = controls.map((c) => ({ endmember: c.endmember, pos: sub(c.pos), neg: sub(c.neg) }));
  const ssm = spilloverSpreadingMatrix(inputs, K);
  const leakage = Array.from({ length: K }, () => new Array<number>(K).fill(NaN));
  const med = (a: Float32Array) => quantileSorted(Float32Array.from(a).sort(), 0.5);
  for (const c of inputs) {
    const i = c.endmember;
    const dF = med(c.pos[i]) - med(c.neg[i]);
    for (let j = 0; j < K; j++) leakage[i][j] = (med(c.pos[j]) - med(c.neg[j])) / dF;
  }
  return { names: prep.outNames.slice(0, K), ssm, leakage };
}

// ------------------------------------------------------------------------------ unmixing

interface Solver {
  K: number;
  /** D x K, [d * K + k]. */
  M: Float64Array;
  /** K x D, [k * D + d] (= M'). */
  MT: Float64Array;
  /** K x D pseudo-inverse (M'M)^-1 M'. */
  pinv: Float64Array;
  /** K x K M'M (full). */
  gram: Float64Array;
  /**
   * Outer products m_d m_d' per detector for the WLS normal matrix, packed lower row-major
   * (p = i(i+1)/2 + j, j <= i), pair-interleaved: [(p >> 1) * 2D + 2d + (p & 1)] (WLS only).
   */
  OT: Float64Array | null;
  /** Packed index -> full row-major index (i, j). */
  lowerOf: Int32Array;
  /** Packed index -> full row-major index (j, i). */
  upperOf: Int32Array;
}

export interface PreparedUnmix {
  def: UnmixDef;
  D: number;
  nFluor: number;
  /** Abundance outputs (fluorochromes + AF outputs). */
  nAbund: number;
  /** All output names (abundances, then "AF Index" and residual if present). */
  outNames: string[];
  solvers: Solver[];
  afBest: boolean;
  weighted: boolean;
  nonNeg: boolean;
  weightFromFit: boolean;
  iterations: number;
  offset: Float64Array;
  floor: Float64Array;
  residual: 'none' | 'ssr' | 'rms';
}

function makeSolver(sigs: number[][], D: number, weighted: boolean, names: string[]): Solver {
  const K = sigs.length;
  if (K > D) throw new Error(`More endmembers (${K}) than detectors (${D})`);
  const M = new Float64Array(D * K);
  const MT = new Float64Array(K * D);
  sigs.forEach((s, k) => {
    if (s.length !== D) throw new Error(`Signature of ${names[k]} has ${s.length} values, expected ${D}`);
    const n = normalizeMax(s);
    for (let d = 0; d < D; d++) {
      if (!Number.isFinite(n[d])) throw new Error(`Signature of ${names[k]} is not finite`);
      M[d * K + k] = n[d];
      MT[k * D + d] = n[d];
    }
  });
  const gram = new Float64Array(K * K);
  for (let i = 0; i < K; i++)
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let d = 0; d < D; d++) s += MT[i * D + d] * MT[j * D + d];
      gram[i * K + j] = s;
      gram[j * K + i] = s;
    }
  const L = Float64Array.from(gram);
  if (!cholesky(L, K, K)) {
    const sim = similarityMatrix(sigs);
    let bi = 0,
      bj = 1,
      bs = -1;
    for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) if (sim[i][j] > bs) [bi, bj, bs] = [i, j, sim[i][j]];
    throw new Error(`Signature matrix is singular (most similar: ${names[bi]} / ${names[bj]}, ${bs.toFixed(4)})`);
  }
  const pinv = new Float64Array(K * D);
  const col = new Float64Array(K);
  for (let d = 0; d < D; d++) {
    for (let k = 0; k < K; k++) col[k] = M[d * K + k];
    cholSolve(L, K, K, col, col);
    for (let k = 0; k < K; k++) pinv[k * D + d] = col[k];
  }
  const P = (K * (K + 1)) / 2;
  const lowerOf = new Int32Array(P);
  const upperOf = new Int32Array(P);
  let OT: Float64Array | null = null;
  if (weighted) OT = new Float64Array(((P + 1) >> 1) * 2 * D);
  let p = 0;
  for (let i = 0; i < K; i++)
    for (let j = 0; j <= i; j++) {
      lowerOf[p] = i * K + j;
      upperOf[p] = j * K + i;
      if (OT) for (let d = 0; d < D; d++) OT[(p >> 1) * 2 * D + 2 * d + (p & 1)] = M[d * K + i] * M[d * K + j];
      p++;
    }
  return { K, M, MT, pinv, gram, OT, lowerOf, upperOf };
}

/** Output channel names of a definition, made unique against `existing` channel names. */
export function unmixOutputNames(def: UnmixDef, existing: string[] = []): string[] {
  const afs = def.includeAF ? def.af ?? [] : [];
  const afBest = afs.length > 1 && (def.afMode ?? 'best') === 'best';
  const names = def.endmembers.map((e) => e.name);
  if (afs.length) {
    if (afBest) names.push('AF', 'AF Index');
    else names.push(...afs.map((a) => a.name || 'AF'));
  }
  const res = def.residual ?? 'none';
  if (res !== 'none') names.push(res === 'rms' ? 'Residual RMS' : 'Residual');
  const taken = new Set(existing);
  return names.map((n) => {
    let s = n || 'Endmember';
    if (taken.has(s)) s = `${s} (unmixed)`;
    let i = 2;
    const b = s;
    while (taken.has(s)) s = `${b} ${i++}`;
    taken.add(s);
    return s;
  });
}

function perDetector(v: number | number[] | undefined, D: number, dflt: (d: number) => number): Float64Array {
  const out = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    const x = typeof v === 'number' ? v : Array.isArray(v) ? v[d] : undefined;
    out[d] = x !== undefined && Number.isFinite(x) ? x : dflt(d);
  }
  return out;
}

/** Precompute pseudo-inverses etc. Throws if the signature matrix is singular or malformed. */
export function prepareUnmix(def: UnmixDef): PreparedUnmix {
  const D = def.detectors.length;
  const fl = def.endmembers;
  if (!D) throw new Error('No detectors');
  if (!fl.length && !(def.includeAF && def.af?.length)) throw new Error('No endmembers');
  const afs = def.includeAF ? def.af ?? [] : [];
  const afBest = afs.length > 1 && (def.afMode ?? 'best') === 'best';
  const weighted = def.method === 'wls';
  const nonNeg = def.method === 'nnls' || !!def.nonNegative;
  const flSigs = fl.map((e) => e.signature);
  const flNames = fl.map((e) => e.name);
  const solvers = afBest
    ? afs.map((a) => makeSolver([...flSigs, a.signature], D, weighted, [...flNames, a.name]))
    : [makeSolver([...flSigs, ...afs.map((a) => a.signature)], D, weighted, [...flNames, ...afs.map((a) => a.name)])];
  const nAbund = fl.length + (afBest ? 1 : afs.length);
  // WLS noise model defaults
  const peaks = [...fl, ...afs].map((e) => (e.raw && e.peak !== undefined ? e.raw[e.peak] : NaN)).filter((v) => v > 0);
  peaks.sort((a, b) => a - b);
  const typical = peaks.length ? peaks[peaks.length >> 1] : NaN;
  const offset = perDetector(def.wls?.offset, D, (d) => {
    const sd = def.noiseSD?.[d];
    if (sd !== undefined && sd > 0) return sd;
    return typical > 0 ? 1e-3 * typical : 100;
  });
  const floor = perDetector(def.wls?.floor, D, (d) => (offset[d] > 0 ? offset[d] : 1));
  for (let d = 0; d < D; d++) if (!(floor[d] > 0)) floor[d] = 1e-9;
  return {
    def,
    D,
    nFluor: fl.length,
    nAbund,
    outNames: unmixOutputNames(def),
    solvers,
    afBest,
    weighted,
    nonNeg,
    weightFromFit: (def.wls?.weightFrom ?? 'fit') === 'fit',
    iterations: Math.max(1, Math.floor(def.wls?.iterations ?? 1)),
    offset,
    floor,
    residual: def.residual ?? 'none',
  };
}

/** Workspace for one solver (preallocated, reused across events). */
interface Work {
  Y: Float64Array; // D x 4 interleaved
  A: Float64Array; // K x 4
  W: Float64Array; // D x 4 weights
  WY: Float64Array; // D x 4
  G4: Float64Array; // P x 4 packed normal matrices
  Bv: Float64Array; // K x 4
  Gf: Float64Array; // K x K full
  b: Float64Array; // K
  x: Float64Array; // K
  // NNLS
  passive: Uint8Array;
  pidx: Int32Array;
  S: Float64Array;
  rhs: Float64Array;
  s: Float64Array;
  xs: Float64Array;
}

function makeWork(D: number, K: number): Work {
  const P = (K * (K + 1)) / 2;
  return {
    Y: new Float64Array(D * 4),
    A: new Float64Array(K * 4),
    W: new Float64Array(D * 4),
    WY: new Float64Array(D * 4),
    G4: new Float64Array((P + 1) * 4),
    Bv: new Float64Array(K * 4),
    Gf: new Float64Array(K * K),
    b: new Float64Array(K),
    x: new Float64Array(K),
    passive: new Uint8Array(K),
    pidx: new Int32Array(K),
    S: new Float64Array(K * K),
    rhs: new Float64Array(K),
    s: new Float64Array(K),
    xs: new Float64Array(K),
  };
}

/** Solve G_PP s_P = b_P for the passive set; s = 0 elsewhere. false if singular. */
function solvePassive(G: Float64Array, b: Float64Array, K: number, w: Work): boolean {
  const { passive, pidx, S, rhs, s, xs } = w;
  let n = 0;
  for (let k = 0; k < K; k++) if (passive[k]) pidx[n++] = k;
  s.fill(0);
  if (!n) return true;
  for (let i = 0; i < n; i++) {
    const gi = pidx[i] * K;
    for (let j = 0; j <= i; j++) S[i * n + j] = G[gi + pidx[j]];
    rhs[i] = b[pidx[i]];
  }
  if (!cholesky(S, n, n)) return false;
  cholSolve(S, n, n, rhs, xs);
  for (let i = 0; i < n; i++) s[pidx[i]] = xs[i];
  return true;
}

/**
 * Non-negative least squares on the normal equations: min 1/2 a'Ga - b'a, a >= 0 (Lawson-Hanson
 * active set, warm-started from the unconstrained solution in x). Result in x.
 */
function nnls(G: Float64Array, b: Float64Array, K: number, x: Float64Array, w: Work): void {
  const { passive, s } = w;
  for (let k = 0; k < K; k++) passive[k] = x[k] > 0 ? 1 : 0;
  // feasible start: drop negatives until the passive-set solution is positive
  for (let guard = 0; guard <= K; guard++) {
    if (!solvePassive(G, b, K, w)) {
      s.fill(0);
      passive.fill(0);
      break;
    }
    let neg = false;
    for (let k = 0; k < K; k++)
      if (passive[k] && !(s[k] > 0)) {
        passive[k] = 0;
        neg = true;
      }
    if (!neg) break;
  }
  for (let k = 0; k < K; k++) x[k] = passive[k] ? s[k] : 0;
  let bmax = 0;
  for (let k = 0; k < K; k++) bmax = Math.max(bmax, Math.abs(b[k]));
  const tol = 1e-10 * bmax;
  for (let outer = 0; outer < 3 * K; outer++) {
    let t = -1;
    let wmax = tol;
    for (let k = 0; k < K; k++) {
      if (passive[k]) continue;
      let g = b[k];
      const gk = k * K;
      for (let l = 0; l < K; l++) g -= G[gk + l] * x[l];
      if (g > wmax) {
        wmax = g;
        t = k;
      }
    }
    if (t < 0) break;
    passive[t] = 1;
    for (let inner = 0; inner < 3 * K; inner++) {
      if (!solvePassive(G, b, K, w)) {
        passive[t] = 0;
        return;
      }
      let alpha = Infinity;
      for (let k = 0; k < K; k++)
        if (passive[k] && !(s[k] > 0)) {
          const a = x[k] / (x[k] - s[k]);
          if (a < alpha) alpha = a;
        }
      if (alpha === Infinity) {
        for (let k = 0; k < K; k++) x[k] = passive[k] ? s[k] : 0;
        break;
      }
      let scale = 0;
      for (let k = 0; k < K; k++) scale = Math.max(scale, Math.abs(x[k]), Math.abs(s[k]));
      for (let k = 0; k < K; k++) {
        if (!passive[k]) continue;
        x[k] += alpha * (s[k] - x[k]);
        if (x[k] <= 1e-12 * scale) {
          x[k] = 0;
          passive[k] = 0;
        }
      }
    }
  }
}

/**
 * Packed weighted normal matrices of 4 events: G4[p*4 + l] = sum_d W[d*4 + l] * O_p(d), with the
 * pair-interleaved outer products of Solver.OT (2 packed entries x 4 events per pass).
 */
function gram4(OT: Float64Array, P: number, D: number, W: Float64Array, G4: Float64Array): void {
  const D4 = 4 * D;
  for (let p = 0, ob = 0; p < P; p += 2) {
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0,
      t0 = 0,
      t1 = 0,
      t2 = 0,
      t3 = 0;
    for (let x = 0; x < D4; x += 4, ob += 2) {
      const o = OT[ob];
      const q = OT[ob + 1];
      const a0 = W[x],
        a1 = W[x + 1],
        a2 = W[x + 2],
        a3 = W[x + 3];
      s0 += a0 * o;
      s1 += a1 * o;
      s2 += a2 * o;
      s3 += a3 * o;
      t0 += a0 * q;
      t1 += a1 * q;
      t2 += a2 * q;
      t3 += a3 * q;
    }
    const g = p * 4;
    G4[g] = s0;
    G4[g + 1] = s1;
    G4[g + 2] = s2;
    G4[g + 3] = s3;
    G4[g + 4] = t0;
    G4[g + 5] = t1;
    G4[g + 6] = t2;
    G4[g + 7] = t3;
  }
}

/**
 * In-place Cholesky (G = L L') of 4 K x K matrices stored packed lower row-major and lane-interleaved:
 * element (i, j <= i) of lane l at G[(i(i+1)/2 + j) * 4 + l]. Stores 1/L(i,i) in inv[i*4 + l];
 * ok[l] = 0 for lanes that are not (numerically) positive definite.
 */
function chol4(G: Float64Array, K: number, inv: Float64Array, ok: Uint8Array): void {
  ok[0] = ok[1] = ok[2] = ok[3] = 1;
  for (let i = 0; i < K; i++) {
    const ri = ((i * (i + 1)) >> 1) * 4;
    for (let j = 0; j <= i; j++) {
      const rj = ((j * (j + 1)) >> 1) * 4;
      const e = ri + j * 4;
      let s0 = G[e],
        s1 = G[e + 1],
        s2 = G[e + 2],
        s3 = G[e + 3];
      for (let k = 0, a = ri, b = rj; k < j; k++, a += 4, b += 4) {
        s0 -= G[a] * G[b];
        s1 -= G[a + 1] * G[b + 1];
        s2 -= G[a + 2] * G[b + 2];
        s3 -= G[a + 3] * G[b + 3];
      }
      if (j < i) {
        const v = j * 4;
        G[e] = s0 * inv[v];
        G[e + 1] = s1 * inv[v + 1];
        G[e + 2] = s2 * inv[v + 2];
        G[e + 3] = s3 * inv[v + 3];
      } else {
        const v = i * 4;
        const s = [s0, s1, s2, s3];
        for (let l = 0; l < 4; l++) {
          let d = s[l];
          if (!(d > 1e-13 * G[e + l])) {
            ok[l] = 0;
            d = 1;
          }
          const u = Math.sqrt(d);
          G[e + l] = u;
          inv[v + l] = 1 / u;
        }
      }
    }
  }
}

/** Solve L L' x = b for 4 lanes (factor from chol4); b (K x 4 interleaved) is overwritten by x. */
function solve4(L: Float64Array, K: number, inv: Float64Array, b: Float64Array): void {
  for (let i = 0; i < K; i++) {
    const ri = ((i * (i + 1)) >> 1) * 4;
    const q = i * 4;
    let s0 = b[q],
      s1 = b[q + 1],
      s2 = b[q + 2],
      s3 = b[q + 3];
    for (let k = 0, a = ri, t = 0; k < i; k++, a += 4, t += 4) {
      s0 -= L[a] * b[t];
      s1 -= L[a + 1] * b[t + 1];
      s2 -= L[a + 2] * b[t + 2];
      s3 -= L[a + 3] * b[t + 3];
    }
    b[q] = s0 * inv[q];
    b[q + 1] = s1 * inv[q + 1];
    b[q + 2] = s2 * inv[q + 2];
    b[q + 3] = s3 * inv[q + 3];
  }
  for (let i = K - 1; i >= 0; i--) {
    const ri = ((i * (i + 1)) >> 1) * 4;
    const q = i * 4;
    const x0 = (b[q] *= inv[q]),
      x1 = (b[q + 1] *= inv[q + 1]),
      x2 = (b[q + 2] *= inv[q + 2]),
      x3 = (b[q + 3] *= inv[q + 3]);
    for (let k = 0, a = ri, t = 0; k < i; k++, a += 4, t += 4) {
      b[t] -= L[a] * x0;
      b[t + 1] -= L[a + 1] * x1;
      b[t + 2] -= L[a + 2] * x2;
      b[t + 3] -= L[a + 3] * x3;
    }
  }
}

/** out[k*4 + l] = sum_d T[k*D + d] * X[d*4 + l] for k < K (4 lanes, 2 rows at a time). */
function matvec4(T: Float64Array, K: number, D: number, X: Float64Array, out: Float64Array): void {
  let k = 0;
  for (; k + 1 < K; k += 2) {
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0,
      t0 = 0,
      t1 = 0,
      t2 = 0,
      t3 = 0;
    const kb = k * D;
    const kb2 = kb + D;
    for (let d = 0, y = 0; d < D; d++, y += 4) {
      const q = T[kb + d];
      const r = T[kb2 + d];
      const y0 = X[y],
        y1 = X[y + 1],
        y2 = X[y + 2],
        y3 = X[y + 3];
      s0 += q * y0;
      s1 += q * y1;
      s2 += q * y2;
      s3 += q * y3;
      t0 += r * y0;
      t1 += r * y1;
      t2 += r * y2;
      t3 += r * y3;
    }
    const a = k * 4;
    out[a] = s0;
    out[a + 1] = s1;
    out[a + 2] = s2;
    out[a + 3] = s3;
    out[a + 4] = t0;
    out[a + 5] = t1;
    out[a + 6] = t2;
    out[a + 7] = t3;
  }
  for (; k < K; k++) {
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0;
    const kb = k * D;
    for (let d = 0, y = 0; d < D; d++, y += 4) {
      const q = T[kb + d];
      s0 += q * X[y];
      s1 += q * X[y + 1];
      s2 += q * X[y + 2];
      s3 += q * X[y + 3];
    }
    const a = k * 4;
    out[a] = s0;
    out[a + 1] = s1;
    out[a + 2] = s2;
    out[a + 3] = s3;
  }
}

/**
 * Core kernel dispatcher: unmix events (list ? list[i] : i) for i in [start, end) with one solver.
 * Contiguous OLS/WLS ranges run in the WebAssembly SIMD kernel when available (about 2-3x faster),
 * everything else (NNLS, event lists) in the JavaScript kernel, which is also the reference.
 */
function runSolver(
  pu: PreparedUnmix,
  sv: Solver,
  cols: Float32Array[],
  out: Float32Array[],
  resid: Float32Array | null,
  list: Uint32Array | null,
  start: number,
  end: number,
): void {
  if (!list && !pu.nonNeg && end - start >= 64) {
    const wasm = getWasm();
    if (wasm) {
      runSolverWasm(wasm, pu, sv, cols, out, resid, start, end);
      return;
    }
  }
  runSolverJS(pu, sv, cols, out, resid, list, start, end);
}

/**
 * JavaScript kernel: blocks of 4 events with lane-interleaved, preallocated buffers.
 * cols: D detector columns; out: the solver's K abundance outputs; resid: optional residual output.
 */
function runSolverJS(
  pu: PreparedUnmix,
  sv: Solver,
  cols: Float32Array[],
  out: Float32Array[],
  resid: Float32Array | null,
  list: Uint32Array | null,
  start: number,
  end: number,
): void {
  const D = pu.D;
  const { K, M, MT, pinv, gram, OT, lowerOf, upperOf } = sv;
  const P = (K * (K + 1)) / 2;
  const w = makeWork(D, K);
  const { Y, A, W, WY, G4, Bv, Gf, b, x } = w;
  const Yh = new Float64Array(D * 4);
  const Gc = pu.nonNeg && pu.weighted ? new Float64Array((P + 1) * 4) : null;
  const inv = new Float64Array(K * 4);
  const ok = new Uint8Array(4);
  const weighted = pu.weighted && !!OT;
  const nonNeg = pu.nonNeg;
  const fromFit = pu.weightFromFit;
  const iters = pu.iterations;
  const offset = pu.offset;
  const floor = pu.floor;
  const rms = pu.residual === 'rms';
  const ev = new Int32Array(4);
  for (let i = start; i < end; i += 4) {
    const nb = end - i < 4 ? end - i : 4;
    const direct = !list && nb === 4;
    // load (a short block is padded with zeros)
    if (direct) {
      for (let d = 0, y = 0; d < D; d++, y += 4) {
        const c = cols[d];
        Y[y] = c[i];
        Y[y + 1] = c[i + 1];
        Y[y + 2] = c[i + 2];
        Y[y + 3] = c[i + 3];
      }
    } else {
      for (let j = 0; j < 4; j++) ev[j] = j < nb ? (list ? list[i + j] : i + j) : -1;
      for (let d = 0, y = 0; d < D; d++, y += 4) {
        const c = cols[d];
        for (let j = 0; j < 4; j++) Y[y + j] = ev[j] >= 0 ? c[ev[j]] : 0;
      }
    }
    // OLS
    matvec4(pinv, K, D, Y, A);
    if (weighted && OT) {
      for (let it = 0; it < iters; it++) {
        if (fromFit) matvec4(M, D, K, A, Yh);
        const H = fromFit ? Yh : Y;
        for (let d = 0, y = 0; d < D; d++, y += 4) {
          const off = offset[d];
          const fl = floor[d];
          for (let l = 0; l < 4; l++) {
            const h = H[y + l];
            const v = (h > 0 ? h : 0) + off;
            const wt = 1 / (v > fl ? v : fl);
            W[y + l] = wt;
            WY[y + l] = wt * Y[y + l];
          }
        }
        gram4(OT, P, D, W, G4);
        matvec4(MT, K, D, WY, Bv);
        if (Gc) Gc.set(G4);
        chol4(G4, K, inv, ok);
        solve4(G4, K, inv, Bv);
        for (let l = 0; l < nb; l++) if (ok[l]) for (let k = 0; k < K; k++) A[k * 4 + l] = Bv[k * 4 + l];
      }
    }
    if (nonNeg) {
      for (let l = 0; l < nb; l++) {
        let anyNeg = false;
        for (let k = 0; k < K; k++) if (A[k * 4 + l] < 0) anyNeg = true;
        if (!anyNeg) continue;
        let G: Float64Array;
        if (weighted && Gc) {
          for (let p = 0; p < P; p++) {
            const g = Gc[p * 4 + l];
            Gf[lowerOf[p]] = g;
            Gf[upperOf[p]] = g;
          }
          for (let k = 0; k < K; k++) {
            let s = 0;
            const kb = k * D;
            for (let d = 0; d < D; d++) s += MT[kb + d] * WY[d * 4 + l];
            b[k] = s;
          }
          G = Gf;
        } else {
          for (let k = 0; k < K; k++) {
            let s = 0;
            const kb = k * D;
            for (let d = 0; d < D; d++) s += MT[kb + d] * Y[d * 4 + l];
            b[k] = s;
          }
          G = gram;
        }
        for (let k = 0; k < K; k++) x[k] = A[k * 4 + l];
        nnls(G, b, K, x, w);
        for (let k = 0; k < K; k++) A[k * 4 + l] = x[k];
      }
    }
    // write
    if (direct) {
      for (let k = 0, a = 0; k < K; k++, a += 4) {
        const o = out[k];
        o[i] = A[a];
        o[i + 1] = A[a + 1];
        o[i + 2] = A[a + 2];
        o[i + 3] = A[a + 3];
      }
    } else {
      for (let k = 0, a = 0; k < K; k++, a += 4) {
        const o = out[k];
        for (let l = 0; l < nb; l++) o[ev[l]] = A[a + l];
      }
    }
    if (resid) {
      matvec4(M, D, K, A, Yh);
      for (let l = 0; l < nb; l++) {
        let ss = 0;
        for (let d = 0, y = l; d < D; d++, y += 4) {
          const r = Y[y] - Yh[y];
          ss += r * r;
        }
        resid[direct ? i + l : ev[l]] = rms ? Math.sqrt(ss / D) : ss;
      }
    }
  }
}

// ------------------------------------------------------------------------------ WebAssembly kernel

/**
 * WebAssembly (SIMD, f64x2) version of the OLS/WLS block kernel, 3 kB, compiled from the WAT source
 * at the end of this file (wabt: `wat2wasm --enable-simd kernel.wat`, then base64). Same math and
 * memory layout as runSolverJS; the tests check both kernels against each other.
 */
const WASM_KERNEL =
  'AGFzbQEAAAABHQRgBX9/f39/AGAHf39/f39/fwBgBH9/f38AYAAAAwcGAAEAAgIDBQMBAAEHDQIDbWVtAgADcnVuAAUKhRcG2gMCBX8IewJAA0AgBUECaiABSg0B/QwAAAAAAAAAAAAAAAAAAAAAIQr9DAAAAAAAAAAAAAAAAAAAAAAhC/0MAAAAAAAAAAAAAAAAAAAAACEM/QwAAAAAAAAAAAAAAAAAAAAAIQ0gACAFIAJsQQN0aiEHIAcgAkEDdGohCCADIQkgAiEGA0AgB/0KAwAhDiAI/QoDACEPIAn9AAQAIRAgCf0ABBAhESAKIA4gEP3yAf3wASEKIAsgDiAR/fIB/fABIQsgDCAPIBD98gH98AEhDCANIA8gEf3yAf3wASENIAdBCGohByAIQQhqIQggCUEgaiEJIAZBAWshBiAGDQALIAQgBUEFdGohCSAJIAr9CwQAIAkgC/0LBBAgCSAM/QsEICAJIA39CwQwIAVBAmohBQwACwsgBSABSARA/QwAAAAAAAAAAAAAAAAAAAAAIQr9DAAAAAAAAAAAAAAAAAAAAAAhCyAAIAUgAmxBA3RqIQcgAyEJIAIhBgNAIAf9CgMAIQ4gCiAOIAn9AAQA/fIB/fABIQogCyAOIAn9AAQQ/fIB/fABIQsgB0EIaiEHIAlBIGohCSAGQQFrIQYgBg0ACyAEIAVBBXRqIQkgCSAK/QsEACAJIAv9CwQQCwv8AQICfwR7IAAhBwNAIAP9CgMAIQkgBP0KAwAhCv0MAAAAAAAA8D8AAAAAAADwPyAB/QAEAP0MAAAAAAAAAAAAAAAAAAAAAP31ASAJ/fABIAr99QH98wEhC/0MAAAAAAAA8D8AAAAAAADwPyAB/QAEEP0MAAAAAAAAAAAAAAAAAAAAAP31ASAJ/fABIAr99QH98wEhDCAFIAv9CwQAIAUgDP0LBBAgBiALIAL9AAQA/fIB/QsEACAGIAwgAv0ABBD98gH9CwQQIAFBIGohASACQSBqIQIgBUEgaiEFIAZBIGohBiADQQhqIQMgBEEIaiEEIAdBAWshByAHDQALC5ICAgN/CHsgA0EBakEBdiEFA0D9DAAAAAAAAAAAAAAAAAAAAAAhCP0MAAAAAAAAAAAAAAAAAAAAACEJ/QwAAAAAAAAAAAAAAAAAAAAAIQr9DAAAAAAAAAAAAAAAAAAAAAAhCyABIQcgBCEGA0AgB/0ABAAhDCAH/QAEECENIAD9CgMAIQ4gAP0KAwghDyAIIAwgDv3yAf3wASEIIAkgDSAO/fIB/fABIQkgCiAMIA/98gH98AEhCiALIA0gD/3yAf3wASELIAdBIGohByAAQRBqIQAgBkEBayEGIAYNAAsgAiAI/QsEACACIAn9CwQQIAIgCv0LBCAgAiAL/QsEMCACQcAAaiECIAVBAWshBSAFDQALC5gEAgh/B3v9DP////////////////////8hEP0M/////////////////////yERAkADQCAEIAFODQEgACAEIARBAWpsQQF2QQV0aiEHQQAhBQNAIAAgBSAFQQFqbEEBdkEFdGohCCAHIAVBBXRqIQkgCf0ABAAhDCAJ/QAEECENIAchCiAIIQsgBSEGAkADQCAGRQ0BIAwgCv0ABAAgC/0ABAD98gH98QEhDCANIAr9AAQQIAv9AAQQ/fIB/fEBIQ0gCkEgaiEKIAtBIGohCyAGQQFrIQYMAAsLIAUgBEgEQCACIAVBBXRqIQogCSAMIAr9AAQA/fIB/QsEACAJIA0gCv0ABBD98gH9CwQQBSAMIAn9AAQA/QyCdklowiU8PYJ2SWjCJTw9/fIB/UohDiANIAn9AAQQ/QyCdklowiU8PYJ2SWjCJTw9/fIB/UohDyAQIA79TiEQIBEgD/1OIREgAiAEQQV0aiEKIAz9DAAAAAAAAPA/AAAAAAAA8D8gDv1S/e8BIRIgCSAS/QsEACAK/QwAAAAAAADwPwAAAAAAAPA/IBL98wH9CwQAIA39DAAAAAAAAPA/AAAAAAAA8D8gD/1S/e8BIRIgCSAS/QsEECAK/QwAAAAAAADwPwAAAAAAAPA/IBL98wH9CwQQCyAFQQFqIQUgBSAETA0ACyAEQQFqIQQMAAsLIAMgEP0LBAAgAyAR/QsEEAuaAwIFfwJ7AkADQCAEIAFODQEgACAEIARBAWpsQQF2QQV0aiEGIAMgBEEFdGohByAH/QAEACEJIAf9AAQQIQogAyEIIAQhBQJAA0AgBUUNASAJIAb9AAQAIAj9AAQA/fIB/fEBIQkgCiAG/QAEECAI/QAEEP3yAf3xASEKIAZBIGohBiAIQSBqIQggBUEBayEFDAALCyACIARBBXRqIQggByAJIAj9AAQA/fIB/QsEACAHIAogCP0ABBD98gH9CwQQIARBAWohBAwACwsgASEEAkADQCAERQ0BIARBAWshBCAAIAQgBEEBamxBAXZBBXRqIQYgAyAEQQV0aiEHIAIgBEEFdGohCCAH/QAEACAI/QAEAP3yASEJIAf9AAQQIAj9AAQQ/fIBIQogByAJ/QsEACAHIAr9CwQQIAMhCCAEIQUCQANAIAVFDQEgCCAI/QAEACAG/QAEACAJ/fIB/fEB/QsEACAIIAj9AAQQIAb9AAQQIAr98gH98QH9CwQQIAZBIGohBiAIQSBqIQggBUEBayEFDAALCwwACwsL3gcDIX8EewF8QQAoAgAhAEEEKAIAIQFBCCgCACECQQwoAgAhA0EQKAIAIQRBFCgCACEFQRgoAgAhBkEcKAIAIQdBICgCACEIQSQoAgAhCUEoKAIAIQpBLCgCACELQTAoAgAhDEE0KAIAIQ1BOCgCACEOQTwoAgAhD0HAACgCACEQQcQAKAIAIRFByAAoAgAhEkHMACgCACETQdAAKAIAIRRB1AAoAgAhFUHYACgCACEWQdwAKAIAIRcgASABQQFqbEEBdiEYAkADQCAZIANODQEgAyAZayEaIBpBBEoEQEEEIRoLQQAhGwNAIBUgGyACbCAZakECdGohHyAMIBtBBXRqISAgGkEERgRAICAgH/1dAwD9X/0LBAAgICAf/V0DCP1f/QsEEAVBACEdA0AgHSAaSARAICAgHUEDdGogHyAdQQJ0aioCALs5AwAFICAgHUEDdGpEAAAAAAAAAAA5AwALIB1BAWohHSAdQQRIDQALCyAbQQFqIRsgGyAASA0ACyAGIAEgACAMIBAQACAEQQFxBEAgBSEeA0AgBEECcQRAIAcgACABIBAgDRAAIAAgDSAMIAogCyAOIA8QAQUgACAMIAwgCiALIA4gDxABCyAJIA4gEyAYIAAQAiAIIAEgACAPIBEQACATIAEgEiAUEAMgEyABIBIgERAEIBT9AAQAISEgFP0ABBAhIkEAIRwDQCARIBxBBXRqIR8gECAcQQV0aiEgICAgH/0ABAAgIP0ABAAgIf1S/QsEACAgIB/9AAQQICD9AAQQICL9Uv0LBBAgHEEBaiEcIBwgAUgNAAsgHkEBayEeIB5BAEoNAAsLQQAhHANAIBAgHEEFdGohHyAWIBwgAmwgGWpBAnRqISBBACEdA0AgICAdQQJ0aiAfIB1BA3RqKwMAtjgCACAdQQFqIR0gHSAaSA0ACyAcQQFqIRwgHCABSA0ACyAEQQRxBEAgByAAIAEgECANEAD9DAAAAAAAAAAAAAAAAAAAAAAhI/0MAAAAAAAAAAAAAAAAAAAAACEkQQAhGwNAIAwgG0EFdGohHyANIBtBBXRqISAgH/0ABAAgIP0ABAD98QEhISAf/QAEECAg/QAEEP3xASEiICMgISAh/fIB/fABISMgJCAiICL98gH98AEhJCAbQQFqIRsgGyAASA0ACyAEQQhxBEAgALf9FCEhICMgIf3zAf3vASEjICQgIf3zAf3vASEkCyANICP9CwQAIA0gJP0LBBBBACEdA0AgFyAZIB1qQQJ0aiANIB1BA3RqKwMAtjgCACAdQQFqIR0gHSAaSA0ACwsgGUEEaiEZDAALCws=';

interface WasmKernel {
  mem: WebAssembly.Memory;
  run: () => void;
}

let wasmState: WasmKernel | null | undefined;
let wasmEnabled = true;

/** Enable / disable the WebAssembly kernel (default enabled when the runtime supports WASM SIMD). */
export function setUnmixWasm(enabled: boolean): void {
  wasmEnabled = enabled;
}

/** Whether the WebAssembly SIMD kernel is available and enabled. */
export function unmixWasmAvailable(): boolean {
  return !!getWasm();
}

function getWasm(): WasmKernel | null {
  if (!wasmEnabled) return null;
  if (wasmState !== undefined) return wasmState;
  wasmState = null;
  try {
    if (typeof WebAssembly === 'undefined' || typeof atob !== 'function') return null;
    const bin = atob(WASM_KERNEL);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!WebAssembly.validate(bytes)) return null; // no SIMD support
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    wasmState = { mem: inst.exports.mem as WebAssembly.Memory, run: inst.exports.run as () => void };
  } catch {
    wasmState = null;
  }
  return wasmState;
}

/** Events per chunk copied into WASM memory. */
const WASM_CHUNK = 2048;

function runSolverWasm(wasm: WasmKernel, pu: PreparedUnmix, sv: Solver, cols: Float32Array[], out: Float32Array[], resid: Float32Array | null, start: number, end: number): void {
  const D = pu.D;
  const { K, M, MT, pinv, OT } = sv;
  const P = (K * (K + 1)) / 2;
  const weighted = pu.weighted && !!OT;
  const cap = WASM_CHUNK;
  // byte layout (16-byte aligned), header of 32 i32 slots at 0
  let at = 128;
  const alloc = (bytes: number) => {
    const o = at;
    at += Math.ceil(bytes / 16) * 16;
    return o;
  };
  const oPinv = alloc(K * D * 8);
  const oM = alloc(D * K * 8);
  const oMT = alloc(K * D * 8);
  const oOT = alloc(weighted && OT ? OT.length * 8 : 0);
  const oOff = alloc(D * 8);
  const oFl = alloc(D * 8);
  const oY = alloc(D * 32);
  const oYh = alloc(D * 32);
  const oW = alloc(D * 32);
  const oWY = alloc(D * 32);
  const oA = alloc(K * 32);
  const oB = alloc(K * 32);
  const oInv = alloc(K * 32);
  const oG = alloc((P + 1) * 32);
  const oOK = alloc(32);
  const oIn = alloc(D * cap * 4);
  const oOut = alloc(K * cap * 4);
  const oRes = alloc(cap * 4);
  const need = Math.ceil(at / 65536) - wasm.mem.buffer.byteLength / 65536;
  if (need > 0) wasm.mem.grow(need);
  const buf = wasm.mem.buffer;
  const hdr = new Int32Array(buf, 0, 32);
  const f64 = new Float64Array(buf);
  const f32 = new Float32Array(buf);
  let flags = 0;
  if (weighted) flags |= 1;
  if (pu.weightFromFit) flags |= 2;
  if (resid) flags |= 4;
  if (pu.residual === 'rms') flags |= 8;
  hdr.set([D, K, cap, 0, flags, pu.iterations, oPinv, oM, oMT, oOT, oOff, oFl, oY, oYh, oW, oWY, oA, oB, oInv, oG, oOK, oIn, oOut, oRes]);
  f64.set(pinv, oPinv / 8);
  f64.set(M, oM / 8);
  f64.set(MT, oMT / 8);
  if (weighted && OT) f64.set(OT, oOT / 8);
  f64.set(pu.offset, oOff / 8);
  f64.set(pu.floor, oFl / 8);
  for (let s = start; s < end; s += cap) {
    const n = Math.min(cap, end - s);
    for (let d = 0; d < D; d++) f32.set(cols[d].subarray(s, s + n), oIn / 4 + d * cap);
    hdr[3] = n;
    wasm.run();
    for (let k = 0; k < K; k++) out[k].set(f32.subarray(oOut / 4 + k * cap, oOut / 4 + k * cap + n), s);
    if (resid) resid.set(f32.subarray(oRes / 4, oRes / 4 + n), s);
  }
}

/** Events per chunk for the per-event AF choice (bounded temporary memory). */
const AF_CHUNK = 32768;

/** Per event, index of the AF candidate with the lowest OLS residual (chunked, uses the fast kernels). */
function chooseAF(pu: PreparedUnmix, cols: Float32Array[], start: number, end: number): Uint8Array {
  const n = end - start;
  const choice = new Uint8Array(n);
  const best = new Float32Array(n).fill(Infinity);
  const olsPu: PreparedUnmix = { ...pu, weighted: false, nonNeg: false, residual: 'ssr' };
  const cap = Math.min(AF_CHUNK, n);
  const K = pu.nAbund;
  const tmp = Array.from({ length: K }, () => new Float32Array(cap));
  const res = new Float32Array(cap);
  for (let s = start; s < end; s += cap) {
    const m = Math.min(cap, end - s);
    const cs = cols.map((c) => c.subarray(s, s + m));
    const ts = tmp.map((t) => t.subarray(0, m));
    const rs = res.subarray(0, m);
    pu.solvers.forEach((sv, c) => {
      runSolver(olsPu, sv, cs, ts, rs, null, 0, m);
      for (let i = 0; i < m; i++) {
        const e = s - start + i;
        if (rs[i] < best[e]) {
          best[e] = rs[i];
          choice[e] = c;
        }
      }
    });
  }
  return choice;
}

/**
 * Unmix events [start, end) into preallocated outputs (one Float32Array per prep.outNames entry,
 * full event length). Ranges are independent, so callers can split the work across Web Workers.
 * cols: the D detector columns in UnmixDef.detectors order.
 */
export function unmixRange(pu: PreparedUnmix, cols: Float32Array[], out: Float32Array[], start: number, end: number): void {
  if (cols.length !== pu.D) throw new Error(`Expected ${pu.D} detector columns, got ${cols.length}`);
  if (out.length !== pu.outNames.length) throw new Error(`Expected ${pu.outNames.length} output columns`);
  const resid = pu.residual !== 'none' ? out[out.length - 1] : null;
  if (!pu.afBest) {
    runSolver(pu, pu.solvers[0], cols, out.slice(0, pu.nAbund), resid, null, start, end);
    return;
  }
  // several AF signatures, 'best' mode: choose per event, then unmix each group gathered into
  // contiguous chunks (so the fast kernels apply) and scatter the results back
  const choice = chooseAF(pu, cols, start, end);
  const afIdxCol = out[pu.nAbund];
  const K = pu.nAbund;
  const cap = Math.min(AF_CHUNK, end - start);
  const gc = cols.map(() => new Float32Array(cap));
  const go = Array.from({ length: K }, () => new Float32Array(cap));
  const gr = resid ? new Float32Array(cap) : null;
  const list = new Uint32Array(cap);
  pu.solvers.forEach((sv, c) => {
    let i = 0;
    while (i < choice.length) {
      let m = 0;
      for (; i < choice.length && m < cap; i++) if (choice[i] === c) list[m++] = start + i;
      if (!m) break;
      for (let d = 0; d < cols.length; d++) {
        const src = cols[d];
        const dst = gc[d];
        for (let j = 0; j < m; j++) dst[j] = src[list[j]];
      }
      runSolver(pu, sv, gc.map((g) => g.subarray(0, m)), go.map((g) => g.subarray(0, m)), gr ? gr.subarray(0, m) : null, null, 0, m);
      for (let k = 0; k < K; k++) {
        const o = out[k];
        const g = go[k];
        for (let j = 0; j < m; j++) o[list[j]] = g[j];
      }
      if (resid && gr) for (let j = 0; j < m; j++) resid[list[j]] = gr[j];
      for (let j = 0; j < m; j++) afIdxCol[list[j]] = c + 1;
    }
  });
}

/** Unmix with a prepared definition; columns/detectorIndex as in unmix(). */
export function unmixPrepared(pu: PreparedUnmix, columns: Float32Array[], detectorIndex: number[]): Float32Array[] {
  if (detectorIndex.length !== pu.D) throw new Error(`Expected ${pu.D} detectors, got ${detectorIndex.length}`);
  const cols = detectorIndex.map((ci, d) => {
    const c = columns[ci];
    if (!c) throw new Error(`Detector ${pu.def.detectors[d]} not found`);
    return c;
  });
  const n = cols.length ? cols[0].length : 0;
  const out = pu.outNames.map(() => new Float32Array(n));
  unmixRange(pu, cols, out, 0, n);
  return out;
}

/**
 * Unmix all events. columns: all parameters of a sample (FcsDataset.data); detectorIndex: column of
 * each detector in def.detectors order (see resolveDetectors). Returns one Float32Array per
 * unmixOutputNames(def): endmember abundances (peak-detector intensity scale), then AF output(s),
 * "AF Index" (afMode 'best' with several AF signatures) and the residual if requested.
 */
export function unmix(def: UnmixDef, columns: Float32Array[], detectorIndex: number[]): Float32Array[] {
  return unmixPrepared(prepareUnmix(def), columns, detectorIndex);
}

// ------------------------------------------------------------------------------ convenience

/** Column index of each detector of the definition in a channel list (-1 if missing). */
export function resolveDetectors(def: Pick<UnmixDef, 'detectors'>, channelNames: string[]): number[] {
  return def.detectors.map((d) => {
    let i = channelNames.indexOf(d);
    if (i < 0) i = channelNames.findIndex((c) => c.toLowerCase() === d.toLowerCase());
    return i;
  });
}

/** Default detectors of a dataset: fluorescence area channels (no scatter, time or width). */
export function defaultDetectors(ds: Pick<FcsDataset, 'channels'>): string[] {
  const nonFluor = (n: string) => /^(FSC|SSC)|SSC-|^Time$|Width|^Event|^Sort|^Index/i.test(n);
  const area = ds.channels.filter((c) => /-A$/.test(c.name) && !nonFluor(c.name)).map((c) => c.name);
  if (area.length) return area;
  return ds.channels.filter((c) => !nonFluor(c.name) && !/-[HW]$/.test(c.name)).map((c) => c.name);
}

/** Words of control file names that are not part of the fluorochrome / marker name. */
const CTRL_PREFIX = /^(compensation|comps?|reference|refs?|controls?|ctrls?|specimen|single|ss|group(-?[A-P]?\d+)?)$/i;
const CTRL_NOISE = /^(\(?(beads?|cells?)\d*\)?|raw|unmixed|stain(ed)?|controls?|ctrls?|colou?r|single|ss|comps?|compensation|references?|refs?|specimen|group(-?[A-P]?\d+)?|plate[\s_-]*\d*|well|tube|sample|-+|(19|20)\d{6,12}|\d{6,8})$/i;
const WELL_ID = /^[A-P]\d{1,2}$/;

/**
 * Endmember name from a control sample name, e.g. "Compensation-FITC.fcs" -> "FITC", "Beads20_BV711" -> "BV711",
 * "Reference Group-A5 CD206 PE (Beads)" -> "CD206 PE" (Cytek Aurora reference controls), "A01_Beads_20_BV421_Raw" ->
 * "BV421". Experiment / plate / group prefixes, well ids, bead / cell notes, sample numbers and time stamps are left out.
 */
export function endmemberNameFromSample(name: string): string {
  let s = name.replace(/\.(fcs|lmd)$/i, '').trim();
  // trailing time stamps, copies and run / sample numbers: "_20250709183851", " (2)", "_Run_1", "_001", "_Raw"
  for (let k = 0; k < 6; k++) {
    const before = s;
    s = s
      .replace(/[\s_-]+(19|20)\d{6,12}$/, '')
      .replace(/[\s_]*\(\d+\)$/, '')
      .replace(/[\s_-]+run[\s_-]*\d+$/i, '')
      .replace(/_\d{1,3}$/, '')
      .replace(/[\s_-]+(raw|unmixed)$/i, '')
      .trim();
    if (s === before) break;
  }
  s = s.replace(/^(compensation|comps?|single[\s_-]*stain(ed)?|reference|ref|controls?|ctrl)-+/i, '');
  let tokens = s.split(/[\s_]+/).filter(Boolean);
  // everything up to the last "Compensation" / "Reference" / "Specimen" / "Group-A5" word that still has a name after it
  const named = (from: number) => tokens.slice(from).some((t) => !CTRL_NOISE.test(t) && !WELL_ID.test(t) && !/^\d+$/.test(t));
  let cut = -1;
  tokens.forEach((t, i) => {
    if (CTRL_PREFIX.test(t) && named(i + 1)) cut = i;
  });
  tokens = tokens.slice(cut + 1);
  const out: string[] = [];
  tokens.forEach((t, i) => {
    if (CTRL_NOISE.test(t)) return;
    // a number after "Beads" ("Beads_20") or before the name (sample / tube number)
    if (/^\d+$/.test(t) && (!out.length || /^beads?$/i.test(tokens[i - 1] ?? ''))) return;
    out.push(t);
  });
  // well ids ("A5", "B04"), when something else is left
  const kept = out.filter((t) => !WELL_ID.test(t));
  let r = (kept.length ? kept : out).join(' ');
  r = r.replace(/\s*\((beads?|cells?)\)\s*$/i, '').replace(/-[AHW]$/, '').trim();
  if (r) return r;
  // nothing but control words: the older, simpler rules
  let f = name.replace(/\.(fcs|lmd)$/i, '').trim();
  f = f.replace(/^(compensation|comp|single[\s_-]*stain(ed)?|ss|reference|ref|controls?|ctrl)([\s_-]*controls?)?[\s_-]+/i, '');
  f = f.replace(/^(beads?|cells?)\d*[\s_-]+/i, '').replace(/[\s_-]+(beads?|cells?)\d*$/i, '');
  f = f.replace(/\s*\((beads?|cells?)\)\s*$/i, '');
  f = f.replace(/-[AHW]$/, '').trim();
  return f || name;
}

/** Robust SD (q84 - q16)/2 per detector of an event set, e.g. unstained cells (for UnmixDef.noiseSD). */
export function estimateNoiseSD(set: EventSet, maxEvents = 200000): number[] {
  const idx = subsample(idxOf(set), maxEvents);
  return set.detectorIndex.map((ci) => robustSD(gatherSorted(set.columns[ci], idx)));
}

/** New definition with defaults (OLS, no AF, no residual). */
export function createUnmixDef(p: Partial<UnmixDef> & Pick<UnmixDef, 'detectors' | 'endmembers'>): UnmixDef {
  const seen = new Map<string, number>();
  const endmembers = p.endmembers.map((e) => {
    const c = seen.get(e.name) ?? 0;
    seen.set(e.name, c + 1);
    return c ? { ...e, name: `${e.name} ${c + 1}` } : e;
  });
  return {
    id: p.id ?? `unmix_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: p.name ?? 'Spectral unmixing',
    detectors: p.detectors,
    endmembers,
    af: p.af,
    includeAF: p.includeAF ?? !!(p.af && p.af.length),
    afMode: p.afMode,
    method: p.method ?? 'ols',
    nonNegative: p.nonNegative,
    wls: p.wls,
    noiseSD: p.noiseSD,
    residual: p.residual ?? 'none',
    created: p.created ?? new Date().toISOString(),
  };
}

// ------------------------------------------------------------------------------ WAT source of WASM_KERNEL
/*
;; FlowState spectral unmixing kernel (OLS / WLS for blocks of 4 events, f64x2 SIMD).
;; Layout: lane-interleaved f64 buffers [row*4 + lane] (32 bytes per row); packed lower-triangular
;; normal matrices [(i(i+1)/2 + j) * 4 + lane]. All offsets are byte addresses read from a header of
;; i32 slots at address 0 (see HDR in unmix.ts).
(module
  (memory (export "mem") 1)

  ;; out[r] = sum_c T[r*C + c] * X[c]   (T: R x C f64 row-major; X, out: 4-lane rows)
  (func $matvec (param $T i32) (param $R i32) (param $C i32) (param $X i32) (param $O i32)
    (local $r i32) (local $c i32) (local $t i32) (local $t2 i32) (local $x i32)
    (local $a v128) (local $b v128) (local $e v128) (local $f v128)
    (local $p v128) (local $q v128) (local $x0 v128) (local $x1 v128)
    (block $done2 (loop $rows2
      (br_if $done2 (i32.gt_s (i32.add (local.get $r) (i32.const 2)) (local.get $R)))
      (local.set $a (v128.const f64x2 0 0)) (local.set $b (v128.const f64x2 0 0))
      (local.set $e (v128.const f64x2 0 0)) (local.set $f (v128.const f64x2 0 0))
      (local.set $t (i32.add (local.get $T) (i32.shl (i32.mul (local.get $r) (local.get $C)) (i32.const 3))))
      (local.set $t2 (i32.add (local.get $t) (i32.shl (local.get $C) (i32.const 3))))
      (local.set $x (local.get $X))
      (local.set $c (local.get $C))
      (loop $cols
        (local.set $p (v128.load64_splat (local.get $t)))
        (local.set $q (v128.load64_splat (local.get $t2)))
        (local.set $x0 (v128.load (local.get $x)))
        (local.set $x1 (v128.load offset=16 (local.get $x)))
        (local.set $a (f64x2.add (local.get $a) (f64x2.mul (local.get $p) (local.get $x0))))
        (local.set $b (f64x2.add (local.get $b) (f64x2.mul (local.get $p) (local.get $x1))))
        (local.set $e (f64x2.add (local.get $e) (f64x2.mul (local.get $q) (local.get $x0))))
        (local.set $f (f64x2.add (local.get $f) (f64x2.mul (local.get $q) (local.get $x1))))
        (local.set $t (i32.add (local.get $t) (i32.const 8)))
        (local.set $t2 (i32.add (local.get $t2) (i32.const 8)))
        (local.set $x (i32.add (local.get $x) (i32.const 32)))
        (local.set $c (i32.sub (local.get $c) (i32.const 1)))
        (br_if $cols (local.get $c)))
      (local.set $x (i32.add (local.get $O) (i32.shl (local.get $r) (i32.const 5))))
      (v128.store (local.get $x) (local.get $a))
      (v128.store offset=16 (local.get $x) (local.get $b))
      (v128.store offset=32 (local.get $x) (local.get $e))
      (v128.store offset=48 (local.get $x) (local.get $f))
      (local.set $r (i32.add (local.get $r) (i32.const 2)))
      (br $rows2)))
    (if (i32.lt_s (local.get $r) (local.get $R)) (then
      (local.set $a (v128.const f64x2 0 0)) (local.set $b (v128.const f64x2 0 0))
      (local.set $t (i32.add (local.get $T) (i32.shl (i32.mul (local.get $r) (local.get $C)) (i32.const 3))))
      (local.set $x (local.get $X))
      (local.set $c (local.get $C))
      (loop $cols1
        (local.set $p (v128.load64_splat (local.get $t)))
        (local.set $a (f64x2.add (local.get $a) (f64x2.mul (local.get $p) (v128.load (local.get $x)))))
        (local.set $b (f64x2.add (local.get $b) (f64x2.mul (local.get $p) (v128.load offset=16 (local.get $x)))))
        (local.set $t (i32.add (local.get $t) (i32.const 8)))
        (local.set $x (i32.add (local.get $x) (i32.const 32)))
        (local.set $c (i32.sub (local.get $c) (i32.const 1)))
        (br_if $cols1 (local.get $c)))
      (local.set $x (i32.add (local.get $O) (i32.shl (local.get $r) (i32.const 5))))
      (v128.store (local.get $x) (local.get $a))
      (v128.store offset=16 (local.get $x) (local.get $b)))))

  ;; W = 1 / max(max(H, 0) + off_d, floor_d);  WY = W * Y
  (func $weights (param $D i32) (param $H i32) (param $Y i32) (param $Off i32) (param $Fl i32) (param $W i32) (param $WY i32)
    (local $d i32) (local $o i32) (local $off v128) (local $fl v128) (local $w0 v128) (local $w1 v128)
    (local.set $d (local.get $D))
    (loop $det
      (local.set $off (v128.load64_splat (local.get $Off)))
      (local.set $fl (v128.load64_splat (local.get $Fl)))
      (local.set $w0 (f64x2.div (v128.const f64x2 1 1)
        (f64x2.max (f64x2.add (f64x2.max (v128.load (local.get $H)) (v128.const f64x2 0 0)) (local.get $off)) (local.get $fl))))
      (local.set $w1 (f64x2.div (v128.const f64x2 1 1)
        (f64x2.max (f64x2.add (f64x2.max (v128.load offset=16 (local.get $H)) (v128.const f64x2 0 0)) (local.get $off)) (local.get $fl))))
      (v128.store (local.get $W) (local.get $w0))
      (v128.store offset=16 (local.get $W) (local.get $w1))
      (v128.store (local.get $WY) (f64x2.mul (local.get $w0) (v128.load (local.get $Y))))
      (v128.store offset=16 (local.get $WY) (f64x2.mul (local.get $w1) (v128.load offset=16 (local.get $Y))))
      (local.set $H (i32.add (local.get $H) (i32.const 32)))
      (local.set $Y (i32.add (local.get $Y) (i32.const 32)))
      (local.set $W (i32.add (local.get $W) (i32.const 32)))
      (local.set $WY (i32.add (local.get $WY) (i32.const 32)))
      (local.set $Off (i32.add (local.get $Off) (i32.const 8)))
      (local.set $Fl (i32.add (local.get $Fl) (i32.const 8)))
      (local.set $d (i32.sub (local.get $d) (i32.const 1)))
      (br_if $det (local.get $d))))

  ;; G[p] = sum_d W[d] * O_p(d); OT pair-interleaved [(p>>1)*2D + 2d + (p&1)]
  (func $gram (param $OT i32) (param $W i32) (param $G i32) (param $P i32) (param $D i32)
    (local $q i32) (local $d i32) (local $w i32)
    (local $s0 v128) (local $s1 v128) (local $t0 v128) (local $t1 v128)
    (local $wa v128) (local $wb v128) (local $o v128) (local $p v128)
    (local.set $q (i32.shr_u (i32.add (local.get $P) (i32.const 1)) (i32.const 1)))
    (loop $pairs
      (local.set $s0 (v128.const f64x2 0 0)) (local.set $s1 (v128.const f64x2 0 0))
      (local.set $t0 (v128.const f64x2 0 0)) (local.set $t1 (v128.const f64x2 0 0))
      (local.set $w (local.get $W))
      (local.set $d (local.get $D))
      (loop $det
        (local.set $wa (v128.load (local.get $w)))
        (local.set $wb (v128.load offset=16 (local.get $w)))
        (local.set $o (v128.load64_splat (local.get $OT)))
        (local.set $p (v128.load64_splat offset=8 (local.get $OT)))
        (local.set $s0 (f64x2.add (local.get $s0) (f64x2.mul (local.get $wa) (local.get $o))))
        (local.set $s1 (f64x2.add (local.get $s1) (f64x2.mul (local.get $wb) (local.get $o))))
        (local.set $t0 (f64x2.add (local.get $t0) (f64x2.mul (local.get $wa) (local.get $p))))
        (local.set $t1 (f64x2.add (local.get $t1) (f64x2.mul (local.get $wb) (local.get $p))))
        (local.set $w (i32.add (local.get $w) (i32.const 32)))
        (local.set $OT (i32.add (local.get $OT) (i32.const 16)))
        (local.set $d (i32.sub (local.get $d) (i32.const 1)))
        (br_if $det (local.get $d)))
      (v128.store (local.get $G) (local.get $s0))
      (v128.store offset=16 (local.get $G) (local.get $s1))
      (v128.store offset=32 (local.get $G) (local.get $t0))
      (v128.store offset=48 (local.get $G) (local.get $t1))
      (local.set $G (i32.add (local.get $G) (i32.const 64)))
      (local.set $q (i32.sub (local.get $q) (i32.const 1)))
      (br_if $pairs (local.get $q))))

  ;; in-place Cholesky G = L L' (packed lower, 4 lanes); Inv[i] = 1/L(i,i); OK = lane masks (2 x v128)
  (func $chol (param $G i32) (param $K i32) (param $Inv i32) (param $OK i32)
    (local $i i32) (local $j i32) (local $k i32) (local $ri i32) (local $rj i32) (local $e i32) (local $a i32) (local $b i32)
    (local $s0 v128) (local $s1 v128) (local $m0 v128) (local $m1 v128) (local $ok0 v128) (local $ok1 v128) (local $u v128)
    (local.set $ok0 (v128.const i64x2 -1 -1))
    (local.set $ok1 (v128.const i64x2 -1 -1))
    (block $idone (loop $iloop
      (br_if $idone (i32.ge_s (local.get $i) (local.get $K)))
      (local.set $ri (i32.add (local.get $G) (i32.shl (i32.shr_u (i32.mul (local.get $i) (i32.add (local.get $i) (i32.const 1))) (i32.const 1)) (i32.const 5))))
      (local.set $j (i32.const 0))
      (loop $jloop
        (local.set $rj (i32.add (local.get $G) (i32.shl (i32.shr_u (i32.mul (local.get $j) (i32.add (local.get $j) (i32.const 1))) (i32.const 1)) (i32.const 5))))
        (local.set $e (i32.add (local.get $ri) (i32.shl (local.get $j) (i32.const 5))))
        (local.set $s0 (v128.load (local.get $e)))
        (local.set $s1 (v128.load offset=16 (local.get $e)))
        (local.set $a (local.get $ri))
        (local.set $b (local.get $rj))
        (local.set $k (local.get $j))
        (block $kdone (loop $kloop
          (br_if $kdone (i32.eqz (local.get $k)))
          (local.set $s0 (f64x2.sub (local.get $s0) (f64x2.mul (v128.load (local.get $a)) (v128.load (local.get $b)))))
          (local.set $s1 (f64x2.sub (local.get $s1) (f64x2.mul (v128.load offset=16 (local.get $a)) (v128.load offset=16 (local.get $b)))))
          (local.set $a (i32.add (local.get $a) (i32.const 32)))
          (local.set $b (i32.add (local.get $b) (i32.const 32)))
          (local.set $k (i32.sub (local.get $k) (i32.const 1)))
          (br $kloop)))
        (if (i32.lt_s (local.get $j) (local.get $i))
          (then
            (local.set $a (i32.add (local.get $Inv) (i32.shl (local.get $j) (i32.const 5))))
            (v128.store (local.get $e) (f64x2.mul (local.get $s0) (v128.load (local.get $a))))
            (v128.store offset=16 (local.get $e) (f64x2.mul (local.get $s1) (v128.load offset=16 (local.get $a)))))
          (else
            (local.set $m0 (f64x2.gt (local.get $s0) (f64x2.mul (v128.load (local.get $e)) (v128.const f64x2 1e-13 1e-13))))
            (local.set $m1 (f64x2.gt (local.get $s1) (f64x2.mul (v128.load offset=16 (local.get $e)) (v128.const f64x2 1e-13 1e-13))))
            (local.set $ok0 (v128.and (local.get $ok0) (local.get $m0)))
            (local.set $ok1 (v128.and (local.get $ok1) (local.get $m1)))
            (local.set $a (i32.add (local.get $Inv) (i32.shl (local.get $i) (i32.const 5))))
            (local.set $u (f64x2.sqrt (v128.bitselect (local.get $s0) (v128.const f64x2 1 1) (local.get $m0))))
            (v128.store (local.get $e) (local.get $u))
            (v128.store (local.get $a) (f64x2.div (v128.const f64x2 1 1) (local.get $u)))
            (local.set $u (f64x2.sqrt (v128.bitselect (local.get $s1) (v128.const f64x2 1 1) (local.get $m1))))
            (v128.store offset=16 (local.get $e) (local.get $u))
            (v128.store offset=16 (local.get $a) (f64x2.div (v128.const f64x2 1 1) (local.get $u)))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br_if $jloop (i32.le_s (local.get $j) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $iloop)))
    (v128.store (local.get $OK) (local.get $ok0))
    (v128.store offset=16 (local.get $OK) (local.get $ok1)))

  ;; solve L L' x = B in place (4 lanes)
  (func $solve (param $L i32) (param $K i32) (param $Inv i32) (param $B i32)
    (local $i i32) (local $k i32) (local $ri i32) (local $bi i32) (local $t i32)
    (local $s0 v128) (local $s1 v128)
    (block $fdone (loop $floop
      (br_if $fdone (i32.ge_s (local.get $i) (local.get $K)))
      (local.set $ri (i32.add (local.get $L) (i32.shl (i32.shr_u (i32.mul (local.get $i) (i32.add (local.get $i) (i32.const 1))) (i32.const 1)) (i32.const 5))))
      (local.set $bi (i32.add (local.get $B) (i32.shl (local.get $i) (i32.const 5))))
      (local.set $s0 (v128.load (local.get $bi)))
      (local.set $s1 (v128.load offset=16 (local.get $bi)))
      (local.set $t (local.get $B))
      (local.set $k (local.get $i))
      (block $kd (loop $kl
        (br_if $kd (i32.eqz (local.get $k)))
        (local.set $s0 (f64x2.sub (local.get $s0) (f64x2.mul (v128.load (local.get $ri)) (v128.load (local.get $t)))))
        (local.set $s1 (f64x2.sub (local.get $s1) (f64x2.mul (v128.load offset=16 (local.get $ri)) (v128.load offset=16 (local.get $t)))))
        (local.set $ri (i32.add (local.get $ri) (i32.const 32)))
        (local.set $t (i32.add (local.get $t) (i32.const 32)))
        (local.set $k (i32.sub (local.get $k) (i32.const 1)))
        (br $kl)))
      (local.set $t (i32.add (local.get $Inv) (i32.shl (local.get $i) (i32.const 5))))
      (v128.store (local.get $bi) (f64x2.mul (local.get $s0) (v128.load (local.get $t))))
      (v128.store offset=16 (local.get $bi) (f64x2.mul (local.get $s1) (v128.load offset=16 (local.get $t))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $floop)))
    (local.set $i (local.get $K))
    (block $bdone (loop $bloop
      (br_if $bdone (i32.eqz (local.get $i)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (local.set $ri (i32.add (local.get $L) (i32.shl (i32.shr_u (i32.mul (local.get $i) (i32.add (local.get $i) (i32.const 1))) (i32.const 1)) (i32.const 5))))
      (local.set $bi (i32.add (local.get $B) (i32.shl (local.get $i) (i32.const 5))))
      (local.set $t (i32.add (local.get $Inv) (i32.shl (local.get $i) (i32.const 5))))
      (local.set $s0 (f64x2.mul (v128.load (local.get $bi)) (v128.load (local.get $t))))
      (local.set $s1 (f64x2.mul (v128.load offset=16 (local.get $bi)) (v128.load offset=16 (local.get $t))))
      (v128.store (local.get $bi) (local.get $s0))
      (v128.store offset=16 (local.get $bi) (local.get $s1))
      (local.set $t (local.get $B))
      (local.set $k (local.get $i))
      (block $kd2 (loop $kl2
        (br_if $kd2 (i32.eqz (local.get $k)))
        (v128.store (local.get $t) (f64x2.sub (v128.load (local.get $t)) (f64x2.mul (v128.load (local.get $ri)) (local.get $s0))))
        (v128.store offset=16 (local.get $t) (f64x2.sub (v128.load offset=16 (local.get $t)) (f64x2.mul (v128.load offset=16 (local.get $ri)) (local.get $s1))))
        (local.set $ri (i32.add (local.get $ri) (i32.const 32)))
        (local.set $t (i32.add (local.get $t) (i32.const 32)))
        (local.set $k (i32.sub (local.get $k) (i32.const 1)))
        (br $kl2)))
      (br $bloop))))

  ;; header slots (i32 at byte 4*slot): 0 D, 1 K, 2 cap, 3 n, 4 flags (1 weighted, 2 weights from fit,
  ;; 4 residual, 8 rms), 5 iterations, 6 pinv, 7 M, 8 MT, 9 OT, 10 offset, 11 floor, 12 Y, 13 Yh, 14 W,
  ;; 15 WY, 16 A, 17 B, 18 Inv, 19 G, 20 OK, 21 in (f32 [d*cap + e]), 22 out (f32 [k*cap + e]), 23 res (f32)
  (func (export "run")
    (local $D i32) (local $K i32) (local $cap i32) (local $n i32) (local $flags i32) (local $iters i32)
    (local $pinv i32) (local $M i32) (local $MT i32) (local $OT i32) (local $off i32) (local $fl i32)
    (local $Y i32) (local $Yh i32) (local $W i32) (local $WY i32) (local $A i32) (local $B i32)
    (local $Inv i32) (local $G i32) (local $OK i32) (local $in i32) (local $out i32) (local $res i32)
    (local $P i32) (local $e0 i32) (local $nb i32) (local $d i32) (local $k i32) (local $l i32) (local $it i32)
    (local $src i32) (local $dst i32) (local $m0 v128) (local $m1 v128) (local $r0 v128) (local $r1 v128) (local $x f64)
    (local.set $D (i32.load (i32.const 0)))   (local.set $K (i32.load (i32.const 4)))
    (local.set $cap (i32.load (i32.const 8))) (local.set $n (i32.load (i32.const 12)))
    (local.set $flags (i32.load (i32.const 16))) (local.set $iters (i32.load (i32.const 20)))
    (local.set $pinv (i32.load (i32.const 24))) (local.set $M (i32.load (i32.const 28)))
    (local.set $MT (i32.load (i32.const 32))) (local.set $OT (i32.load (i32.const 36)))
    (local.set $off (i32.load (i32.const 40))) (local.set $fl (i32.load (i32.const 44)))
    (local.set $Y (i32.load (i32.const 48))) (local.set $Yh (i32.load (i32.const 52)))
    (local.set $W (i32.load (i32.const 56))) (local.set $WY (i32.load (i32.const 60)))
    (local.set $A (i32.load (i32.const 64))) (local.set $B (i32.load (i32.const 68)))
    (local.set $Inv (i32.load (i32.const 72))) (local.set $G (i32.load (i32.const 76)))
    (local.set $OK (i32.load (i32.const 80))) (local.set $in (i32.load (i32.const 84)))
    (local.set $out (i32.load (i32.const 88))) (local.set $res (i32.load (i32.const 92)))
    (local.set $P (i32.shr_u (i32.mul (local.get $K) (i32.add (local.get $K) (i32.const 1))) (i32.const 1)))
    (block $done (loop $blocks
      (br_if $done (i32.ge_s (local.get $e0) (local.get $n)))
      (local.set $nb (i32.sub (local.get $n) (local.get $e0)))
      (if (i32.gt_s (local.get $nb) (i32.const 4)) (then (local.set $nb (i32.const 4))))
      ;; load 4 events (f32 -> f64, zero padded)
      (local.set $d (i32.const 0))
      (loop $ld
        (local.set $src (i32.add (local.get $in) (i32.shl (i32.add (i32.mul (local.get $d) (local.get $cap)) (local.get $e0)) (i32.const 2))))
        (local.set $dst (i32.add (local.get $Y) (i32.shl (local.get $d) (i32.const 5))))
        (if (i32.eq (local.get $nb) (i32.const 4))
          (then
            (v128.store (local.get $dst) (f64x2.promote_low_f32x4 (v128.load64_zero (local.get $src))))
            (v128.store offset=16 (local.get $dst) (f64x2.promote_low_f32x4 (v128.load64_zero offset=8 (local.get $src)))))
          (else
            (local.set $l (i32.const 0))
            (loop $lanes
              (if (i32.lt_s (local.get $l) (local.get $nb))
                (then (f64.store (i32.add (local.get $dst) (i32.shl (local.get $l) (i32.const 3)))
                        (f64.promote_f32 (f32.load (i32.add (local.get $src) (i32.shl (local.get $l) (i32.const 2)))))))
                (else (f64.store (i32.add (local.get $dst) (i32.shl (local.get $l) (i32.const 3))) (f64.const 0))))
              (local.set $l (i32.add (local.get $l) (i32.const 1)))
              (br_if $lanes (i32.lt_s (local.get $l) (i32.const 4))))))
        (local.set $d (i32.add (local.get $d) (i32.const 1)))
        (br_if $ld (i32.lt_s (local.get $d) (local.get $D))))
      ;; OLS
      (call $matvec (local.get $pinv) (local.get $K) (local.get $D) (local.get $Y) (local.get $A))
      ;; WLS
      (if (i32.and (local.get $flags) (i32.const 1)) (then
        (local.set $it (local.get $iters))
        (loop $irls
          (if (i32.and (local.get $flags) (i32.const 2))
            (then
              (call $matvec (local.get $M) (local.get $D) (local.get $K) (local.get $A) (local.get $Yh))
              (call $weights (local.get $D) (local.get $Yh) (local.get $Y) (local.get $off) (local.get $fl) (local.get $W) (local.get $WY)))
            (else
              (call $weights (local.get $D) (local.get $Y) (local.get $Y) (local.get $off) (local.get $fl) (local.get $W) (local.get $WY))))
          (call $gram (local.get $OT) (local.get $W) (local.get $G) (local.get $P) (local.get $D))
          (call $matvec (local.get $MT) (local.get $K) (local.get $D) (local.get $WY) (local.get $B))
          (call $chol (local.get $G) (local.get $K) (local.get $Inv) (local.get $OK))
          (call $solve (local.get $G) (local.get $K) (local.get $Inv) (local.get $B))
          (local.set $m0 (v128.load (local.get $OK)))
          (local.set $m1 (v128.load offset=16 (local.get $OK)))
          (local.set $k (i32.const 0))
          (loop $sel
            (local.set $src (i32.add (local.get $B) (i32.shl (local.get $k) (i32.const 5))))
            (local.set $dst (i32.add (local.get $A) (i32.shl (local.get $k) (i32.const 5))))
            (v128.store (local.get $dst) (v128.bitselect (v128.load (local.get $src)) (v128.load (local.get $dst)) (local.get $m0)))
            (v128.store offset=16 (local.get $dst) (v128.bitselect (v128.load offset=16 (local.get $src)) (v128.load offset=16 (local.get $dst)) (local.get $m1)))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br_if $sel (i32.lt_s (local.get $k) (local.get $K))))
          (local.set $it (i32.sub (local.get $it) (i32.const 1)))
          (br_if $irls (i32.gt_s (local.get $it) (i32.const 0))))))
      ;; store abundances
      (local.set $k (i32.const 0))
      (loop $st
        (local.set $src (i32.add (local.get $A) (i32.shl (local.get $k) (i32.const 5))))
        (local.set $dst (i32.add (local.get $out) (i32.shl (i32.add (i32.mul (local.get $k) (local.get $cap)) (local.get $e0)) (i32.const 2))))
        (local.set $l (i32.const 0))
        (loop $sl
          (f32.store (i32.add (local.get $dst) (i32.shl (local.get $l) (i32.const 2)))
            (f32.demote_f64 (f64.load (i32.add (local.get $src) (i32.shl (local.get $l) (i32.const 3))))))
          (local.set $l (i32.add (local.get $l) (i32.const 1)))
          (br_if $sl (i32.lt_s (local.get $l) (local.get $nb))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br_if $st (i32.lt_s (local.get $k) (local.get $K))))
      ;; residual
      (if (i32.and (local.get $flags) (i32.const 4)) (then
        (call $matvec (local.get $M) (local.get $D) (local.get $K) (local.get $A) (local.get $Yh))
        (local.set $r0 (v128.const f64x2 0 0)) (local.set $r1 (v128.const f64x2 0 0))
        (local.set $d (i32.const 0))
        (loop $rd
          (local.set $src (i32.add (local.get $Y) (i32.shl (local.get $d) (i32.const 5))))
          (local.set $dst (i32.add (local.get $Yh) (i32.shl (local.get $d) (i32.const 5))))
          (local.set $m0 (f64x2.sub (v128.load (local.get $src)) (v128.load (local.get $dst))))
          (local.set $m1 (f64x2.sub (v128.load offset=16 (local.get $src)) (v128.load offset=16 (local.get $dst))))
          (local.set $r0 (f64x2.add (local.get $r0) (f64x2.mul (local.get $m0) (local.get $m0))))
          (local.set $r1 (f64x2.add (local.get $r1) (f64x2.mul (local.get $m1) (local.get $m1))))
          (local.set $d (i32.add (local.get $d) (i32.const 1)))
          (br_if $rd (i32.lt_s (local.get $d) (local.get $D))))
        (if (i32.and (local.get $flags) (i32.const 8)) (then
          (local.set $m0 (f64x2.splat (f64.convert_i32_s (local.get $D))))
          (local.set $r0 (f64x2.sqrt (f64x2.div (local.get $r0) (local.get $m0))))
          (local.set $r1 (f64x2.sqrt (f64x2.div (local.get $r1) (local.get $m0))))))
        (v128.store (local.get $Yh) (local.get $r0))
        (v128.store offset=16 (local.get $Yh) (local.get $r1))
        (local.set $l (i32.const 0))
        (loop $rl
          (f32.store (i32.add (local.get $res) (i32.shl (i32.add (local.get $e0) (local.get $l)) (i32.const 2)))
            (f32.demote_f64 (f64.load (i32.add (local.get $Yh) (i32.shl (local.get $l) (i32.const 3))))))
          (local.set $l (i32.add (local.get $l) (i32.const 1)))
          (br_if $rl (i32.lt_s (local.get $l) (local.get $nb))))))
      (local.set $e0 (i32.add (local.get $e0) (i32.const 4)))
      (br $blocks))))
)
*/
