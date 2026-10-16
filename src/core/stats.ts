// Population statistics on (compensated) raw values.
import type { StatKind } from './model';
import { sortFloat32 } from './sort';
import { makeScale, type ScaleDef } from './transforms';

export function gather(values: Float32Array, idx: Uint32Array): Float32Array {
  const out = new Float32Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = values[idx[i]];
  return out;
}

function quantileSorted(s: Float32Array, q: number): number {
  const n = s.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const t = pos - lo;
  return s[lo] * (1 - t) + s[hi] * t;
}

/** Values of the events `idx` that are finite (NaN / ±Infinity, e.g. events outside a calibration range, are left out). */
export function gatherFinite(values: Float32Array, idx: Uint32Array): Float32Array {
  const out = new Float32Array(idx.length);
  let k = 0;
  for (let i = 0; i < idx.length; i++) {
    const v = values[idx[i]];
    if (v - v === 0) out[k++] = v; // finite
  }
  return k === idx.length ? out : out.slice(0, k);
}

export interface ChannelStats {
  /** number of events with a finite value: every statistic is based on these */
  n: number;
  /** events in the population, including events without a value in this channel */
  nEvents: number;
  /** events left out because their value is not finite (derived channels: outside the calibrated range, not computable) */
  excluded: number;
  mean: number;
  median: number;
  geomean: number;
  sd: number;
  cv: number;
  rsd: number;
  rcv: number;
  min: number;
  max: number;
  mode: number;
  /** the finite values, ascending */
  sorted: Float32Array;
}

/**
 * Mode: peak of a 256-bin histogram on the display scale (as in a histogram plot), between the
 * 0.5th and 99.5th percentile and within the visible axis; the peak bin center is transformed back.
 */
function modeSorted(sorted: Float32Array, scale?: ScaleDef): number {
  const n = sorted.length;
  const sc = scale ? makeScale(scale) : null;
  // display coordinates keep the sort order (all scales are monotonic)
  const u = sc ? sc.fwdArray(sorted) : sorted;
  let lo = quantileSorted(u, 0.005);
  let hi = quantileSorted(u, 0.995);
  if (sc && Math.max(lo, 0) < Math.min(hi, 1)) {
    // off-scale events (e.g. values <= 0 on a log axis) pile up at the axis edge: leave them out
    lo = Math.max(lo, 0);
    hi = Math.min(hi, 1);
  }
  if (!(hi > lo)) return quantileSorted(sorted, 0.5);
  const NB = 256;
  const bins = new Uint32Array(NB);
  const k = NB / (hi - lo);
  for (let i = 0; i < n; i++) {
    const b = Math.floor((u[i] - lo) * k);
    if (b >= 0 && b < NB) bins[b]++;
  }
  let best = 0;
  for (let b = 1; b < NB; b++) if (bins[b] > bins[best]) best = b;
  const c = lo + (best + 0.5) / k;
  return sc ? sc.inv(c) : c;
}

/**
 * Statistics of one channel over the events `idx`. Only finite values count: events without a value (NaN, e.g. derived
 * channels outside their calibrated range) are excluded from every statistic and reported in `excluded`.
 * `scale`: the channel's display scale, used for the mode.
 * The order statistics (median, robust SD / CV, min, max, `sorted`) are computed on first use and the mode on its own
 * first use (a mean needs no sorting); the values are the same as when computed right away.
 */
export function channelStats(values: Float32Array, idx: Uint32Array, scale?: ScaleDef): ChannelStats {
  const v = gatherFinite(values, idx);
  const n = v.length;
  const nEvents = idx.length;
  const excluded = nEvents - n;
  if (!n) return { n: 0, nEvents, excluded, mean: NaN, median: NaN, geomean: NaN, sd: NaN, cv: NaN, rsd: NaN, rcv: NaN, min: NaN, max: NaN, mode: NaN, sorted: v };
  let sum = 0;
  let logSum = 0;
  let logN = 0;
  for (let i = 0; i < n; i++) {
    sum += v[i];
    if (v[i] > 0) {
      logSum += Math.log(v[i]);
      logN++;
    }
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (v[i] - mean) * (v[i] - mean);
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  let ord: { sorted: Float32Array; median: number; rsd: number; rcv: number } | null = null;
  const order = () => {
    if (ord) return ord;
    const sorted = sortFloat32(v); // in place, as v.sort()
    const median = quantileSorted(sorted, 0.5);
    const p16 = quantileSorted(sorted, 0.1587);
    const p84 = quantileSorted(sorted, 0.8413);
    const rsd = (p84 - p16) / 2;
    ord = { sorted, median, rsd, rcv: median !== 0 ? (100 * rsd) / Math.abs(median) : NaN };
    return ord;
  };
  let mode: number | undefined;
  return {
    n,
    nEvents,
    excluded,
    mean,
    get median() {
      return order().median;
    },
    geomean: logN ? Math.exp(logSum / logN) : NaN,
    sd,
    cv: mean !== 0 ? (100 * sd) / Math.abs(mean) : NaN,
    get rsd() {
      return order().rsd;
    },
    get rcv() {
      return order().rcv;
    },
    get min() {
      return order().sorted[0];
    },
    get max() {
      return order().sorted[n - 1];
    },
    get mode() {
      if (mode === undefined) mode = modeSorted(order().sorted, scale);
      return mode;
    },
    get sorted() {
      return order().sorted;
    },
  };
}

/** Short note when a statistic is based on fewer events than the population has, else null. */
export function excludedNote(cs: Pick<ChannelStats, 'n' | 'nEvents' | 'excluded'> | null | undefined): string | null {
  if (!cs || !cs.excluded) return null;
  const pct = (100 * cs.excluded) / Math.max(1, cs.nEvents);
  return `Based on ${cs.n.toLocaleString('en-US')} of ${cs.nEvents.toLocaleString('en-US')} events: ${cs.excluded.toLocaleString('en-US')} (${pct < 0.1 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)} %) have no value in this channel (e.g. outside the calibrated range).`;
}

export function statFromChannel(cs: ChannelStats, kind: StatKind, percentile = 50): number {
  switch (kind) {
    case 'mean':
      return cs.mean;
    case 'median':
      return cs.median;
    case 'geomean':
      return cs.geomean;
    case 'sd':
      return cs.sd;
    case 'cv':
      return cs.cv;
    case 'rsd':
      return cs.rsd;
    case 'rcv':
      return cs.rcv;
    case 'min':
      return cs.min;
    case 'max':
      return cs.max;
    case 'mode':
      return cs.mode;
    case 'percentile':
      return quantileSorted(cs.sorted, Math.min(1, Math.max(0, percentile / 100)));
    default:
      return NaN;
  }
}

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

/** 7.14×10⁹ (3 significant digits). */
export function formatSci(v: number, digits = 3): string {
  const [m, e] = v.toExponential(Math.max(0, digits - 1)).split('e');
  return `${m}×10${String(Number(e)).replace(/./g, (c) => SUP[c] ?? c)}`;
}

/**
 * Display text of a statistic (tables, stats boxes, legends): grouped integers from 100 (713,912), fixed decimals
 * below, scientific notation only from 10⁹. Exports (CSV / XLSX) keep the full-precision number instead.
 */
export function formatStat(v: number, kind: StatKind): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e9) return formatSci(v);
  if (kind === 'count') return Math.round(v).toLocaleString('en-US');
  if (kind.startsWith('freq') || kind === 'cv' || kind === 'rcv') return v.toFixed(v < 10 ? 2 : 1);
  if (kind === 'concentration') return v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1);
  if (a >= 100) return Math.round(v).toLocaleString('en-US');
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return '0';
  if (a < 1e-3) return formatSci(v);
  return v.toPrecision(3);
}
