// Fluorescence intensity calibration with multi-intensity bead sets (MESF / ERF / MEFL ...). Pure computation.
// 1. findBeadPeaks: locate the K bead populations on one channel (Area preferred) in a log-like display space.
//    Smoothing is used for peak finding only; reported medians/rCVs come from the raw events in each window.
// 2. fitMesf: log10(reference) = a + b·log10(median) over the non-blank beads (blank = reference 0).
// 3. toMesf: convert MFI values to calibrated units.
// beadSaturation flags bead populations compressed by detector saturation (left out of the fit by default).
import { detectPileUp } from './scattercal';
import { defaultScaleFor, makeScale, type ScaleDef } from './transforms';

export interface PeakFindOptions {
  /** display scale for peak finding (default: automatic logicle from the data, W from negative values) */
  scale?: ScaleDef;
  /** histogram bins over the display range (default 512) */
  bins?: number;
  /** Gaussian smoothing σ in bins, used only to find peaks/valleys (default 1.5; 0 = none) */
  smoothBins?: number;
  /** minimum peak prominence as a fraction of the highest smoothed bin (default 0.01) */
  minProminence?: number;
  /**
   * how the K populations are chosen among significant peaks: 'events' (default; number of events in the peak
   * window, robust to a broad blank vs. narrow doublet peaks) or 'prominence'
   */
  rankBy?: 'events' | 'prominence';
  /**
   * a peak is only accepted as a bead population if its window holds at least this fraction of the typical
   * population size (median event count of the ceil(K/2) largest peaks); default 0.1 (rejects doublet peaks)
   */
  minEventsFraction?: number;
  /**
   * outer window edges stop where the smoothed density drops below this fraction of the peak height (default 0.01,
   * ≈ ±3 SD for a Gaussian peak); between overlapping peaks the valley minimum is used. 0 = pure valley-to-valley.
   */
  tailFraction?: number;
  /** manual windows [lo, hi) in raw units; overrides detection (one peak per window) */
  windows?: Array<[number, number]>;
}

export interface BeadPeak {
  /** window [lo, hi) in raw units (±Infinity for open outer windows) */
  lo: number;
  hi: number;
  count: number;
  median: number;
  mean: number;
  /** robust SD = (P84.13 − P15.87)/2 */
  rsd: number;
  /** robust CV (%) = 100·rSD/|median| */
  rcvPct: number;
  /** display-space position (scale units) of the peak maximum (manual windows: of the median) */
  u: number;
  /** prominence relative to the highest smoothed bin (NaN for manual windows) */
  prominence: number;
  manual: boolean;
}

export interface PeakFindResult {
  /** peaks sorted by ascending intensity */
  peaks: BeadPeak[];
  requested: number;
  /** true when exactly `requested` peaks were found */
  ok: boolean;
  warnings: string[];
  /** display scale used for finding */
  scale: ScaleDef;
  /** histogram on the display scale (for plotting / QC) */
  histogram: { u0: number; u1: number; counts: Float32Array; smoothed: Float32Array };
  /** all significant local maxima (display units, raw value, relative prominence) */
  candidates: { u: number; value: number; prominence: number; selected: boolean }[];
}

function quantileSorted(s: Float64Array, q: number): number {
  const n = s.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function windowStats(values: Float32Array, lo: number, hi: number): { count: number; median: number; mean: number; rsd: number; rcvPct: number } {
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v >= lo && v < hi) n++;
  }
  const s = new Float64Array(n);
  let k = 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v >= lo && v < hi) {
      s[k++] = v;
      sum += v;
    }
  }
  s.sort();
  const median = quantileSorted(s, 0.5);
  const rsd = (quantileSorted(s, 0.8413) - quantileSorted(s, 0.1587)) / 2;
  return { count: n, median, mean: n ? sum / n : NaN, rsd, rcvPct: median !== 0 ? (100 * rsd) / Math.abs(median) : NaN };
}

/** Automatic logicle display scale for bead data (top at 1.25 × the 99.9th percentile). */
export function autoBeadScale(values: Float32Array): ScaleDef {
  const step = Math.max(1, Math.floor(values.length / 100000));
  const sub: number[] = [];
  for (let i = 0; i < values.length; i += step) if (Number.isFinite(values[i])) sub.push(values[i]);
  sub.sort((a, b) => a - b);
  const q = sub.length ? sub[Math.min(sub.length - 1, Math.floor(0.999 * sub.length))] : 1;
  const T = Math.max(q * 1.25, 1);
  return defaultScaleFor('bead', T, values, 'log');
}

/**
 * Find K bead populations on a 1D distribution.
 * @param values one channel (raw / compensated units), e.g. FITC-A of a rainbow-bead file
 * @param k expected number of populations including the blank
 */
export function findBeadPeaks(values: Float32Array, k: number, opts: PeakFindOptions = {}): PeakFindResult {
  const warnings: string[] = [];
  const scaleDef = opts.scale ?? autoBeadScale(values);
  const sc = makeScale(scaleDef);
  const emptyHist = { u0: 0, u1: 1, counts: new Float32Array(0), smoothed: new Float32Array(0) };

  if (opts.windows && opts.windows.length) {
    const peaks = opts.windows
      .map(([lo, hi]): BeadPeak => {
        const st = windowStats(values, Math.min(lo, hi), Math.max(lo, hi));
        return { lo: Math.min(lo, hi), hi: Math.max(lo, hi), ...st, u: sc.fwd(st.median), prominence: NaN, manual: true };
      })
      .sort((a, b) => a.median - b.median);
    for (const p of peaks) if (p.count === 0) warnings.push(`manual window [${p.lo}, ${p.hi}) contains no events`);
    return { peaks, requested: k, ok: peaks.length === k, warnings, scale: scaleDef, histogram: emptyHist, candidates: [] };
  }

  // display coordinates of finite events
  const u = sc.fwdArray(values);
  const fin: number[] = [];
  const stepQ = Math.max(1, Math.floor(u.length / 100000));
  for (let i = 0; i < u.length; i += stepQ) if (Number.isFinite(u[i])) fin.push(u[i]);
  if (fin.length < 10) {
    warnings.push('too few events');
    return { peaks: [], requested: k, ok: false, warnings, scale: scaleDef, histogram: emptyHist, candidates: [] };
  }
  fin.sort((a, b) => a - b);
  const qa = fin[Math.floor(0.0005 * (fin.length - 1))];
  const qb = fin[Math.ceil(0.9995 * (fin.length - 1))];
  const pad = Math.max(0.02, 0.02 * (qb - qa));
  const u0 = Math.max(-0.25, qa - pad);
  const u1 = Math.min(1.25, qb + pad);
  const nb = Math.max(16, Math.round(opts.bins ?? 512));
  const bw = (u1 - u0) / nb;
  const counts = new Float32Array(nb);
  for (let i = 0; i < u.length; i++) {
    const b = Math.floor((u[i] - u0) / bw);
    if (b >= 0 && b < nb) counts[b]++;
  }
  // Gaussian smoothing (finding only)
  const sig = opts.smoothBins ?? 1.5;
  let h: Float32Array = counts;
  if (sig > 0) {
    const r = Math.ceil(4 * sig);
    const ker = new Float64Array(2 * r + 1);
    let ks = 0;
    for (let j = -r; j <= r; j++) ks += ker[j + r] = Math.exp(-(j * j) / (2 * sig * sig));
    for (let j = 0; j < ker.length; j++) ker[j] /= ks;
    h = new Float32Array(nb);
    for (let i = 0; i < nb; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) {
        const t = i + j;
        if (t >= 0 && t < nb) s += ker[j + r] * counts[t];
      }
      h[i] = s;
    }
  }
  let hMax = 0;
  for (let i = 0; i < nb; i++) hMax = Math.max(hMax, h[i]);
  // local maxima + topographic prominence
  const cand: { i: number; prom: number }[] = [];
  for (let i = 0; i < nb; i++) {
    const left = i > 0 ? h[i - 1] : -1;
    const right = i < nb - 1 ? h[i + 1] : -1;
    if (!(h[i] > 0 && h[i] > left && h[i] >= right)) continue;
    let lmin = h[i];
    for (let j = i - 1; j >= 0 && h[j] <= h[i]; j--) lmin = Math.min(lmin, h[j]);
    let rmin = h[i];
    for (let j = i + 1; j < nb && h[j] <= h[i]; j++) rmin = Math.min(rmin, h[j]);
    const prom = h[i] - Math.max(lmin, rmin);
    cand.push({ i, prom });
  }
  const minProm = (opts.minProminence ?? 0.01) * hMax;
  // Poisson noise of a smoothed bin: Var ≈ h / (2√π σ) (σ in bins)
  const effBins = sig > 0 ? 2 * Math.sqrt(Math.PI) * sig : 1;
  const significant = cand.filter((c) => c.prom >= minProm && c.prom >= 2.5 * Math.sqrt(Math.max(h[c.i], 1) / effBins));
  const sigIdx = significant.map((c) => c.i).sort((a, b) => a - b);
  const tail = opts.tailFraction ?? 0.01;
  const binCenter = (b: number) => u0 + (b + 0.5) * bw;
  const valley = (a: number, b: number): number => {
    // index of the minimum of h strictly between a and b (middle of the first flat minimum run)
    if (b - a < 2) return Math.round((a + b) / 2);
    let m = Infinity;
    for (let j = a + 1; j < b; j++) m = Math.min(m, h[j]);
    let first = a + 1;
    while (h[first] !== m) first++;
    let last = first;
    while (last + 1 < b && h[last + 1] === m) last++;
    return Math.round((first + last) / 2);
  };
  // window (boundary bins, exclusive of the peak's events beyond them) and event mass of every significant peak
  const win = significant.map((c) => {
    const p = c.i;
    const leftN = sigIdx.filter((j) => j < p).pop();
    const rightN = sigIdx.find((j) => j > p);
    let vL = leftN !== undefined ? valley(leftN, p) : -1;
    let vR = rightN !== undefined ? valley(p, rightN) : nb;
    if (tail > 0) {
      const thr = tail * h[p];
      let j = p;
      while (j - 1 > vL && h[j - 1] >= thr) j--;
      if (j - 1 > vL) vL = j - 1; // first bin below threshold
      j = p;
      while (j + 1 < vR && h[j + 1] >= thr) j++;
      if (j + 1 < vR) vR = j + 1;
    }
    let mass = 0;
    for (let j = Math.max(0, vL); j <= Math.min(nb - 1, vR); j++) mass += counts[j];
    return { c, vL, vR, mass };
  });
  // rank: by event mass (robust to broad blanks vs. narrow doublet peaks) or by prominence
  const rankBy = opts.rankBy ?? 'events';
  const byMass = [...win].sort((a, b) => b.mass - a.mass);
  const top = byMass.slice(0, Math.max(1, Math.ceil(k / 2)));
  const typical = top[Math.floor((top.length - 1) / 2)]?.mass ?? 0;
  const minMass = (opts.minEventsFraction ?? 0.1) * typical;
  const ranked = win.filter((w) => w.mass >= minMass).sort((a, b) => (rankBy === 'events' ? b.mass - a.mass : b.c.prom - a.c.prom));
  const selected = ranked.slice(0, k).sort((a, b) => a.c.i - b.c.i);
  if (selected.length < k) warnings.push(`found ${selected.length} of ${k} expected populations`);
  const peaks: BeadPeak[] = selected.map(({ c, vL, vR }) => {
    const lo = vL >= 0 ? sc.inv(binCenter(vL)) : -Infinity;
    const hi = vR < nb ? sc.inv(binCenter(vR)) : Infinity;
    const st = windowStats(values, lo, hi);
    return { lo, hi, ...st, u: binCenter(c.i), prominence: hMax > 0 ? c.prom / hMax : NaN, manual: false };
  });
  for (let i = 1; i < peaks.length; i++) if (peaks[i].median <= peaks[i - 1].median) warnings.push('peak medians are not increasing (overlapping populations?)');
  const selSet = new Set(selected.map((w) => w.c.i));
  return {
    peaks,
    requested: k,
    ok: peaks.length === k,
    warnings,
    scale: scaleDef,
    histogram: { u0, u1, counts, smoothed: h },
    candidates: significant
      .sort((a, b) => a.i - b.i)
      .map((c) => ({ u: binCenter(c.i), value: sc.inv(binCenter(c.i)), prominence: hMax > 0 ? c.prom / hMax : NaN, selected: selSet.has(c.i) })),
  };
}

// ------------------------------------------------------------------ regression

export interface MesfFitOptions {
  /**
   * 'log' (default): log10(ref) = a + b·log10(MFI), ordinary least squares;
   * 'weightedLog': same, weighted by count/rCV² of each peak (∝ 1/variance of log median; needs BeadPeak input);
   * 'linear': ref = a + b·MFI.
   */
  method?: 'log' | 'weightedLog' | 'linear';
  /** indices of beads to leave out (e.g. a saturated brightest peak) */
  exclude?: number[];
  /** unit label carried along, e.g. 'MESF', 'MEFL', 'ERF' */
  unit?: string;
  /** names of the beads in warnings, paired with `peaks` (e.g. the kit's "P1".."P8"); default "bead 1", "bead 2" ... */
  labels?: string[];
}

/** A median for a message: 4 significant digits, no float noise ("-151.7", "93.93", "1098"). */
function fmtMedian(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1e5) return Math.round(v).toLocaleString('en-US');
  return String(Number(v.toPrecision(4)));
}

export interface MesfPoint {
  index: number;
  median: number;
  reference: number | null;
  blank: boolean;
  used: boolean;
  /** calibrated value of the median under the fit */
  fitted: number;
  /** 100·(fitted − reference)/reference (non-blank beads) */
  residualPct: number;
  count?: number;
  rcvPct?: number;
}

export interface MesfFit {
  method: 'log' | 'weightedLog' | 'linear';
  unit: string;
  /** slope b (log: exponent; ideal ≈ 1 for a linear detector) */
  slope: number;
  /** intercept a (log: log10 units) */
  intercept: number;
  /** coefficient of determination in the fitted space */
  r2: number;
  /** number of beads used */
  n: number;
  points: MesfPoint[];
  /** detection threshold estimate from the blank bead */
  blank?: {
    median: number;
    rsd: number;
    /** blank median in calibrated units (NaN if ≤ 0 under a log fit) */
    value: number;
    /** blank median + 2·rSD (MFI) */
    thresholdMfi: number;
    /** that threshold in calibrated units */
    thresholdValue: number;
  };
  /** intensity range covered by the beads used in the fit (values outside it are extrapolated) */
  calibratedRange: MesfCalibratedRange;
  warnings: string[];
}

/**
 * Range a calibration is supported by: the lowest and highest median (MFI) of the beads used in the fit and the
 * calibrated values of those medians under the fit (`mesf`, in the calibration's unit: MESF, MEFL, ERF ...). Values
 * outside it are extrapolated from the regression. With a blank bead, its detection threshold (blank median + 2 rSD)
 * in both units.
 */
export interface MesfCalibratedRange {
  mfi: [number, number];
  mesf: [number, number];
  blankThresholdMfi?: number;
  blankThresholdMesf?: number;
}

/** Where a calibrated value lies relative to a calibrated range ('in' within a relative tolerance of 1e-6). */
export function calibratedRangePosition(range: Pick<MesfCalibratedRange, 'mesf'>, value: number): 'below' | 'in' | 'above' | null {
  const [lo, hi] = range.mesf;
  if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (value < lo - 1e-6 * Math.abs(lo)) return 'below';
  if (value > hi + 1e-6 * Math.abs(hi)) return 'above';
  return 'in';
}

/**
 * Fit the calibration curve. `peaks` and `references` are paired by index (both in ascending intensity order);
 * a reference of 0 marks the blank (excluded from the regression), null = unknown (excluded).
 */
export function fitMesf(peaks: ReadonlyArray<number | BeadPeak>, references: ReadonlyArray<number | null>, opts: MesfFitOptions = {}): MesfFit {
  if (peaks.length !== references.length) throw new Error(`fitMesf: ${peaks.length} peaks but ${references.length} reference values`);
  const method = opts.method ?? 'log';
  const warnings: string[] = [];
  const excl = new Set(opts.exclude ?? []);
  const med = peaks.map((p) => (typeof p === 'number' ? p : p.median));
  const name = (i: number) => opts.labels?.[i]?.trim() || `bead ${i + 1}`;
  let blankIdx = -1;
  const pts: MesfPoint[] = peaks.map((p, i) => {
    const ref = references[i];
    const isBlank = ref === 0 && blankIdx < 0;
    if (isBlank) blankIdx = i;
    else if (ref === 0) warnings.push(`${name(i)}: more than one blank (reference 0); ignored`);
    let used = !isBlank && ref !== null && ref > 0 && !excl.has(i) && Number.isFinite(med[i]);
    if (used && method !== 'linear' && !(med[i] > 0)) {
      used = false;
      warnings.push(`${name(i)}: median ${fmtMedian(med[i])} is not above 0 and cannot enter a log fit (left out)`);
    }
    if (ref === null) warnings.push(`${name(i)}: no reference value (enter the lot value)`);
    return {
      index: i,
      median: med[i],
      reference: ref,
      blank: isBlank,
      used,
      fitted: NaN,
      residualPct: NaN,
      count: typeof p === 'number' ? undefined : p.count,
      rcvPct: typeof p === 'number' ? undefined : p.rcvPct,
    };
  });
  const use = pts.filter((p) => p.used);
  if (use.length < 2) throw new Error('fitMesf: need at least 2 non-blank beads with reference values');
  if (use.length < 3) warnings.push('only 2 beads in the fit: no residual check possible');
  const xs = use.map((p) => (method === 'linear' ? p.median : Math.log10(p.median)));
  const ys = use.map((p) => (method === 'linear' ? (p.reference as number) : Math.log10(p.reference as number)));
  const ws = use.map((p) => {
    if (method !== 'weightedLog') return 1;
    if (p.count === undefined || !(p.rcvPct! > 0)) return 1;
    return p.count / Math.max(p.rcvPct!, 0.1) ** 2;
  });
  if (method === 'weightedLog' && use.some((p) => p.count === undefined)) warnings.push('weightedLog without peak statistics: equal weights used');
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i];
    sx += ws[i] * xs[i];
    sy += ws[i] * ys[i];
  }
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += ws[i] * (xs[i] - mx) ** 2;
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
    syy += ws[i] * (ys[i] - my) ** 2;
  }
  if (!(sxx > 0)) throw new Error('fitMesf: bead medians are identical');
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssr = 0;
  for (let i = 0; i < xs.length; i++) ssr += ws[i] * (ys[i] - (intercept + slope * xs[i])) ** 2;
  const fit: MesfFit = {
    method,
    unit: opts.unit ?? 'MESF',
    slope,
    intercept,
    r2: syy > 0 ? 1 - ssr / syy : 1,
    n: use.length,
    points: pts,
    calibratedRange: { mfi: [NaN, NaN], mesf: [NaN, NaN] },
    warnings,
  };
  const mLo = Math.min(...use.map((p) => p.median));
  const mHi = Math.max(...use.map((p) => p.median));
  fit.calibratedRange = { mfi: [mLo, mHi], mesf: [mesfValue(fit, mLo), mesfValue(fit, mHi)] };
  for (const p of pts) {
    p.fitted = mesfValue(fit, p.median);
    if (!p.blank && p.reference !== null && p.reference > 0) p.residualPct = (100 * (p.fitted - p.reference)) / p.reference;
  }
  if (method !== 'linear' && Math.abs(slope - 1) > 0.1)
    warnings.push(`slope ${slope.toFixed(3)} deviates from 1 by more than 10% (detector non-linearity, wrong peak assignment or saturation?)`);
  if (blankIdx >= 0) {
    const bp = peaks[blankIdx];
    const rsd = typeof bp === 'number' ? NaN : bp.rsd;
    const thr = med[blankIdx] + 2 * rsd;
    fit.blank = { median: med[blankIdx], rsd, value: mesfValue(fit, med[blankIdx]), thresholdMfi: thr, thresholdValue: mesfValue(fit, thr) };
    if (Number.isFinite(thr) && Number.isFinite(fit.blank.thresholdValue)) {
      fit.calibratedRange.blankThresholdMfi = thr;
      fit.calibratedRange.blankThresholdMesf = fit.blank.thresholdValue;
    }
  }
  return fit;
}

// ------------------------------------------------------------------ detector saturation

/**
 * Level from which values of a channel count as saturated, or null: the pile-up level of detectPileUp (as on the size
 * calibration page), else the channel maximum when at least max(20, 0.05 %) of the events sit exactly at it (clipped at
 * the detector or ADC maximum without the pile-up pattern, e.g. a bright bead tail cut at $PnR).
 */
export function saturationLevel(values: ArrayLike<number>, range?: number): number | null {
  const pile = detectPileUp(values, range);
  if (pile) return pile.level;
  let mx = -Infinity;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === v && v !== Infinity && v !== -Infinity) {
      n++;
      if (v > mx) mx = v;
    }
  }
  if (!(mx > 0)) return null;
  const lv = mx * (1 - 1e-6);
  let k = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= lv && values[i] !== Infinity) k++;
  return k >= Math.max(20, 0.0005 * n) ? lv : null;
}

export interface BeadSaturation {
  /** per peak (order of `peaks`): the population is compressed by detector saturation */
  saturated: boolean[];
  /** per peak: why it is flagged (empty when not flagged) */
  reasons: string[][];
  /** per peak: fraction of its events at the saturation level of the channel or its height channel */
  topFraction: number[];
  /** saturation level of the channel and of its height channel (null: none found) */
  level: number | null;
  heightLevel: number | null;
}

/**
 * Detector saturation of bead populations on one channel (and its -H twin when given, aligned event by event): a
 * population is flagged when its window holds >= `minFraction` (default 2 %) events at the saturation level (see
 * saturationLevel; same detection as the size calibration), when its median is at the top of the range (>= 0.99 x
 * `range`, the channel's $PnR) or when it has no spread (rCV below 0.1 %: events clipped at one value).
 */
export function beadSaturation(
  values: ArrayLike<number>,
  peaks: ReadonlyArray<Pick<BeadPeak, 'lo' | 'hi' | 'median' | 'rcvPct' | 'count'>>,
  opts: { range?: number; height?: ArrayLike<number> | null; heightRange?: number; minFraction?: number } = {},
): BeadSaturation {
  const la = saturationLevel(values, opts.range);
  const h = opts.height && opts.height.length === values.length ? opts.height : null;
  const lh = h ? saturationLevel(h, opts.heightRange) : null;
  const minF = opts.minFraction ?? 0.02;
  const topMedian = opts.range && opts.range > 0 ? 0.99 * opts.range : Infinity;
  const out: BeadSaturation = { saturated: [], reasons: [], topFraction: [], level: la, heightLevel: lh };
  for (const p of peaks) {
    let n = 0;
    let k = 0;
    if (la !== null || lh !== null) {
      for (let j = 0; j < values.length; j++) {
        const v = values[j];
        if (!(v >= p.lo && v < p.hi)) continue;
        n++;
        if ((la !== null && v >= la) || (lh !== null && h![j] >= lh)) k++;
      }
    }
    const f = n ? k / n : 0;
    const why: string[] = [];
    if (f >= minF) why.push(`${(100 * f).toFixed(f < 0.1 ? 1 : 0)} % of its events at the top of the range`);
    if (p.median >= topMedian) why.push('median at the top of the range');
    if (p.count >= 10 && p.rcvPct >= 0 && p.rcvPct < 0.1) why.push('no spread (rCV about 0)');
    out.saturated.push(why.length > 0);
    out.reasons.push(why);
    out.topFraction.push(f);
  }
  return out;
}

/** Calibrated value of one MFI (NaN for MFI ≤ 0 under a log fit). */
export function mesfValue(fit: Pick<MesfFit, 'method' | 'slope' | 'intercept'>, mfi: number): number {
  if (fit.method === 'linear') return fit.intercept + fit.slope * mfi;
  return mfi > 0 ? Math.pow(10, fit.intercept + fit.slope * Math.log10(mfi)) : NaN;
}

/** Inverse: MFI that corresponds to a calibrated value. */
export function mfiFromMesf(fit: Pick<MesfFit, 'method' | 'slope' | 'intercept'>, value: number): number {
  if (fit.method === 'linear') return (value - fit.intercept) / fit.slope;
  return value > 0 ? Math.pow(10, (Math.log10(value) - fit.intercept) / fit.slope) : NaN;
}

/**
 * Convert MFI values (e.g. a whole channel) to calibrated units.
 * Linear fits convert every finite MFI, including values at or below 0 (an offset-free detector reports small negative
 * values for dim events; they map onto calibrated values near the intercept).
 * Log fits (log / weightedLog) are undefined for MFI <= 0: those events become `opts.nonPositive`, NaN by default (no
 * calibrated value) or 0. 0 is the limit of the power law a·MFI^b for MFI -> 0+ (b > 0), so the events keep their rank:
 * medians and percentiles of dim populations stay those of the MFI (calibrated channels use it; dropping the events
 * instead would compute order statistics over the MFI > 0 events only). With b <= 0 'zero' gives NaN as well.
 * Non-finite MFI always gives NaN.
 */
export function toMesf(fit: Pick<MesfFit, 'method' | 'slope' | 'intercept'>, values: Float32Array | Float64Array, opts: { nonPositive?: 'nan' | 'zero' } = {}): Float32Array {
  const out = new Float32Array(values.length);
  const np = opts.nonPositive === 'zero' && fit.slope > 0 ? 0 : NaN;
  const { slope: b, intercept: a } = fit;
  if (fit.method === 'linear') {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      out[i] = v - v === 0 ? a + b * v : NaN;
    }
  } else {
    const A = Math.pow(10, a);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      out[i] = v > 0 ? (v === Infinity ? NaN : A * Math.pow(v, b)) : v === v ? np : NaN;
    }
  }
  return out;
}
