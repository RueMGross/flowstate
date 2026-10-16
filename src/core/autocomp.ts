// Spillover computation from single-stained controls.
import type { Engine } from './engine';
import type { Workspace } from './model';
import { identity } from './compensation';

export interface ControlSpec {
  sampleId: string;
  channel: string; // primary detector
}

export interface AutoCompResult {
  channels: string[];
  matrix: number[][];
  details: { channel: string; sampleId: string; nPos: number; nNeg: number; threshold: number }[];
  warnings: string[];
}

function medianOf(vals: Float32Array, idx: ArrayLike<number>): number {
  const a = new Float32Array(idx.length);
  for (let i = 0; i < idx.length; i++) a[i] = vals[idx[i]];
  a.sort();
  const n = a.length;
  if (!n) return NaN;
  return n % 2 ? a[n >> 1] : (a[(n >> 1) - 1] + a[n >> 1]) / 2;
}

function quantileOf(vals: Float32Array, idx: ArrayLike<number>, q: number): number {
  const a = new Float32Array(idx.length);
  for (let i = 0; i < idx.length; i++) a[i] = vals[idx[i]];
  a.sort();
  if (!a.length) return NaN;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(a.length - 1, lo + 1);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/**
 * For each control: positives = events brighter than the `posQuantile` of the negative reference in the
 * primary detector; spill[k][j] = (median_pos_j - median_neg_j) / (median_pos_k - median_neg_k).
 * Negative reference: the unstained sample (same population) or, if absent, the dimmest `negFraction` of the control itself.
 * All values are uncompensated.
 */
export function computeSpillover(
  ws: Workspace,
  engine: Engine,
  controls: ControlSpec[],
  opts: { population: string; unstainedId: string | null; posQuantile?: number; negFraction?: number; method?: 'regression' | 'median' },
): AutoCompResult {
  const method = opts.method ?? 'regression';
  const channels = controls.map((c) => c.channel);
  const n = channels.length;
  const M = identity(n);
  const warnings: string[] = [];
  const details: AutoCompResult['details'] = [];
  const posQ = opts.posQuantile ?? 0.995;
  const negFrac = opts.negFraction ?? 0.3;
  const rawOf = (sid: string, ch: string) => {
    const sd = engine.samples.get(sid);
    const i = sd?.index.get(ch);
    return sd && i !== undefined ? sd.ds.data[i] : null;
  };
  // negative medians from unstained
  let unNeg: { idx: Uint32Array } | null = null;
  if (opts.unstainedId && engine.has(opts.unstainedId)) unNeg = { idx: engine.population(ws, opts.unstainedId, opts.population) };
  controls.forEach((c, k) => {
    const idx = engine.population(ws, c.sampleId, opts.population);
    const prim = rawOf(c.sampleId, c.channel);
    if (!prim || idx.length < 50) {
      warnings.push(`${c.channel}: not enough events`);
      return;
    }
    let negMed: number[];
    let thr: number;
    let nNeg: number;
    if (unNeg && opts.unstainedId) {
      const un = opts.unstainedId;
      const uPrim = rawOf(un, c.channel);
      thr = uPrim ? quantileOf(uPrim, unNeg.idx, posQ) : NaN;
      negMed = channels.map((ch) => {
        const v = rawOf(un, ch);
        return v ? medianOf(v, unNeg!.idx) : 0;
      });
      nNeg = unNeg.idx.length;
    } else {
      // internal negatives: dimmest fraction of the control in its primary channel
      const order = Array.from(idx).sort((a, b) => prim[a] - prim[b]);
      const neg = order.slice(0, Math.max(10, Math.floor(order.length * negFrac)));
      thr = quantileOf(prim, neg, posQ);
      negMed = channels.map((ch) => {
        const v = rawOf(c.sampleId, ch);
        return v ? medianOf(v, neg) : 0;
      });
      nNeg = neg.length;
    }
    const pos: number[] = [];
    for (let i = 0; i < idx.length; i++) if (prim[idx[i]] > thr) pos.push(idx[i]);
    if (pos.length < 20) {
      warnings.push(`${c.channel}: only ${pos.length} positive events; check the control`);
      if (!pos.length) return;
    }
    const posMed = channels.map((ch) => {
      const v = rawOf(c.sampleId, ch);
      return v ? medianOf(v, pos) : 0;
    });
    const denom = posMed[k] - negMed[k];
    if (!(denom > 0)) {
      warnings.push(`${c.channel}: positive and negative populations are not separated`);
      return;
    }
    // spread of the positives in the primary detector decides whether a regression is meaningful
    const px = pos.map((e) => prim[e]).sort((a, b) => a - b);
    const spread = (px[Math.floor(px.length * 0.9)] - px[Math.floor(px.length * 0.1)]) / Math.max(1e-9, px[px.length >> 1]);
    const useReg = method === 'regression' && pos.length >= 200 && spread > 0.4;
    for (let j = 0; j < n; j++) {
      if (j === k) continue;
      let v = (posMed[j] - negMed[j]) / denom;
      if (useReg) {
        const yv = rawOf(c.sampleId, channels[j]);
        if (yv) v = robustSlope(prim, yv, pos);
      }
      M[k][j] = Number.isFinite(v) ? Math.max(0, v) : 0;
    }
    details.push({ channel: c.channel, sampleId: c.sampleId, nPos: pos.length, nNeg, threshold: thr });
  });
  return { channels, matrix: M, details, warnings };
}

/** Least-squares slope of y on x over the given events, refitted after removing residual outliers (> 3.5 MAD). */
export function robustSlope(x: Float32Array, y: Float32Array, idx: number[]): number {
  let use = idx;
  let b = 0;
  for (let it = 0; it < 3; it++) {
    let sx = 0,
      sy = 0;
    for (const e of use) {
      sx += x[e];
      sy += y[e];
    }
    const mx = sx / use.length;
    const my = sy / use.length;
    let sxy = 0,
      sxx = 0;
    for (const e of use) {
      sxy += (x[e] - mx) * (y[e] - my);
      sxx += (x[e] - mx) * (x[e] - mx);
    }
    b = sxx > 0 ? sxy / sxx : 0;
    const a = my - b * mx;
    const res = use.map((e) => Math.abs(y[e] - a - b * x[e]));
    const sorted = [...res].sort((p, q) => p - q);
    const mad = sorted[sorted.length >> 1] || 1e-9;
    const keep = use.filter((_, i) => res[i] <= 3.5 * 1.4826 * mad);
    if (keep.length === use.length || keep.length < 50) break;
    use = keep;
  }
  return b;
}

/** Guess the primary detector of a single-stain control from its name or from the brightest channel. */
export function guessControlChannel(ws: Workspace, engine: Engine, sampleId: string, candidates: string[]): string | null {
  const s = ws.samples.find((x) => x.id === sampleId);
  if (!s) return null;
  const name = s.name.toLowerCase().replace(/[_\s]+/g, ' ');
  // by channel name / marker label match (longest match wins)
  let best: { ch: string; len: number } | null = null;
  for (const ch of candidates) {
    const base = ch.replace(/-[AHW]$/i, '').toLowerCase();
    const label = (ws.channelLabels[ch] || s.channels.find((c) => c.name === ch)?.label || '').toLowerCase();
    for (const key of [base, label]) {
      if (key.length >= 2 && new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(name)) {
        if (!best || key.length > best.len) best = { ch, len: key.length };
      }
    }
  }
  if (best) return best.ch;
  // brightest relative to the others (99th percentile)
  const sd = engine.samples.get(sampleId);
  if (!sd) return null;
  let bestQ = -Infinity;
  let bestCh: string | null = null;
  for (const ch of candidates) {
    const i = sd.index.get(ch);
    if (i === undefined) continue;
    const a = sd.ds.data[i];
    const step = Math.max(1, Math.floor(a.length / 20000));
    const sub: number[] = [];
    for (let e = 0; e < a.length; e += step) sub.push(a[e]);
    sub.sort((x, y) => x - y);
    const q = sub[Math.floor(sub.length * 0.99)] / Math.max(1, Math.abs(sub[Math.floor(sub.length * 0.5)]) + 100);
    if (q > bestQ) {
      bestQ = q;
      bestCh = ch;
    }
  }
  return bestCh;
}
