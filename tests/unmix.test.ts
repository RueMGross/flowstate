import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseFcs, type FcsDataset } from '../src/core/fcs';
import { compensate } from '../src/core/compensation';
import { Engine } from '../src/core/engine';
import { emptyWorkspace } from '../src/core/model';
import { computeSpillover } from '../src/core/autocomp';
import {
  afSignatures,
  autoSelectPopulations,
  buildSignature,
  complexityIndex,
  controlSpread,
  createUnmixDef,
  defaultDetectors,
  endmemberNameFromSample,
  estimateNoiseSD,
  prepareUnmix,
  resolveDetectors,
  setUnmixWasm,
  signatureFromControl,
  similarityMatrix,
  singularValues,
  spilloverSpreadingMatrix,
  unmix,
  unmixOutputNames,
  unmixQuality,
  unmixRange,
  unmixWasmAvailable,
  type Endmember,
  type EventSet,
  type UnmixDef,
} from '../src/core/unmix';

// ------------------------------------------------------------------ synthetic data helpers

function makeRng(seed: number) {
  let s = seed | 0;
  const u = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let a = 0;
    while (a === 0) a = u();
    const b = u();
    const r = Math.sqrt(-2 * Math.log(a));
    spare = r * Math.sin(2 * Math.PI * b);
    return r * Math.cos(2 * Math.PI * b);
  };
  const poisson = (lam: number) => {
    if (lam <= 0) return 0;
    if (lam < 30) {
      const L = Math.exp(-lam);
      let k = 0,
        p = 1;
      do {
        k++;
        p *= u();
      } while (p > L);
      return k - 1;
    }
    return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss()));
  };
  return { u, gauss, poisson };
}

/**
 * Realistic-looking spectra: D detectors on `lasers` lasers; each fluor has a primary laser, Gaussian
 * emission over the detectors of each laser (shifted per laser) and random cross-laser excitation.
 */
function makeSignatures(D: number, K: number, seed: number, lasers = 4): number[][] {
  const r = makeRng(seed);
  const per = Math.ceil(D / lasers);
  const sigs: number[][] = [];
  for (let k = 0; k < K; k++) {
    const L = k % lasers;
    const slot = Math.floor(k / lasers);
    const nSlot = Math.ceil(K / lasers);
    const c = ((slot + 0.5) / nSlot) * per + (r.u() - 0.5) * 1.2;
    const w = 0.9 + 1.4 * r.u();
    const exc = Array.from({ length: lasers }, (_, l) => (l === L ? 1 : l > L ? 0.04 + 0.35 * r.u() : 0.02 * r.u()));
    const s = Array.from({ length: D }, (_, d) => {
      const l = Math.floor(d / per);
      const pos = d - l * per;
      const shift = (l - L) * 1.5; // red-shifted emission on longer-wavelength lasers
      return exc[l] * Math.exp(-0.5 * ((pos - c - shift) / w) ** 2) + 0.003;
    });
    const m = Math.max(...s);
    sigs.push(s.map((v) => v / m));
  }
  return sigs;
}

/** Simulate D detector columns: y_d = g * Poisson((sum_k a_k S_kd + bg_d) / g) + N(0, sigma0^2). */
function simulate(
  sigs: number[][],
  abund: (e: number, a: Float64Array) => void,
  n: number,
  opts: { g: number; sigma0: number; seed: number; bg?: number[]; clip?: number },
): Float32Array[] {
  const D = sigs[0].length;
  const K = sigs.length;
  const r = makeRng(opts.seed);
  const cols = Array.from({ length: D }, () => new Float32Array(n));
  const a = new Float64Array(K);
  for (let e = 0; e < n; e++) {
    abund(e, a);
    for (let d = 0; d < D; d++) {
      let s = opts.bg ? opts.bg[d] : 0;
      for (let k = 0; k < K; k++) s += a[k] * sigs[k][d];
      let v = opts.g * r.poisson(s / opts.g) + opts.sigma0 * r.gauss();
      if (opts.clip !== undefined && v > opts.clip) v = opts.clip;
      cols[d][e] = v;
    }
  }
  return cols;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const names = (n: number, p = 'D') => range(n).map((i) => `${p}${i + 1}`);

function stats(a: Float32Array, idx?: ArrayLike<number>) {
  let s = 0,
    ss = 0;
  const n = idx ? idx.length : a.length;
  for (let i = 0; i < n; i++) {
    const v = a[idx ? idx[i] : i];
    s += v;
    ss += v * v;
  }
  const mean = s / n;
  const sd = Math.sqrt(Math.max(0, ss / n - mean * mean));
  return { mean, sd, se: sd / Math.sqrt(n) };
}

function defFor(sigs: number[][], extra: Partial<UnmixDef> = {}): UnmixDef {
  const D = sigs[0].length;
  return createUnmixDef({
    name: 'test',
    detectors: names(D),
    endmembers: sigs.map((s, k) => ({ name: `F${k + 1}`, signature: s })),
    ...extra,
  });
}

const cos = (a: number[], b: number[]) => {
  let s = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return s / Math.sqrt(na * nb);
};

// ------------------------------------------------------------------ quality metrics

describe('quality metrics', () => {
  it('similarity matrix and complexity index', () => {
    const I = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ];
    const sim = similarityMatrix(I);
    expect(sim[0][1]).toBe(0);
    expect(sim[1][1]).toBe(1);
    expect(complexityIndex(I)).toBeCloseTo(1, 10);
    expect(singularValues([
      [3, 0, 0],
      [0, 2, 0],
      [0, 0, 1],
    ]).map((v) => +v.toFixed(12))).toEqual([3, 2, 1]);
    // scaled copy: similarity 1, singular
    expect(similarityMatrix([[1, 2, 3], [2, 4, 6]])[0][1]).toBeCloseTo(1, 12);
    expect(complexityIndex([[1, 2, 3], [2, 4, 6]])).toBe(Infinity);
    // complexity grows with overlap
    const gauss = (c: number, w: number) => range(16).map((d) => Math.exp(-0.5 * ((d - c) / w) ** 2));
    const ci = [4, 2, 1, 0.5].map((sep) => complexityIndex([gauss(7, 1.5), gauss(7 + sep, 1.5)]));
    for (let i = 1; i < ci.length; i++) expect(ci[i]).toBeGreaterThan(ci[i - 1]);
    // the 2x2 condition number of max-normalised Gaussians with known cosine c is sqrt((1+c)/(1-c))
    const c = similarityMatrix([gauss(7, 1.5), gauss(8, 1.5)])[0][1];
    expect(complexityIndex([gauss(7, 1.5), gauss(8, 1.5)])).toBeCloseTo(Math.sqrt((1 + c) / (1 - c)), 3);
  });

  it('warns about too similar signatures', () => {
    const a = range(16).map((d) => Math.exp(-0.5 * ((d - 7) / 2) ** 2));
    const b = range(16).map((d) => Math.exp(-0.5 * ((d - 7.3) / 2) ** 2));
    const q = unmixQuality(defFor([a, b]));
    expect(q.similarity[0][1]).toBeGreaterThan(0.98);
    expect(q.similarPairs.length).toBe(1);
    expect(q.warnings.join(' ')).toMatch(/too similar/);
    expect(() => prepareUnmix(defFor([a, a.map((v) => v * 2)]))).toThrow(/singular/);
  });
});

// ------------------------------------------------------------------ synthetic unmixing

describe('synthetic unmixing', () => {
  const configs = [
    { D: 16, K: 5, seed: 11 },
    { D: 32, K: 12, seed: 12 },
    { D: 64, K: 20, seed: 13 },
  ];
  for (const cfg of configs) {
    it(`OLS recovers abundances without bias (D=${cfg.D}, K=${cfg.K})`, () => {
      const { D, K, seed } = cfg;
      const sigs = makeSignatures(D, K, seed);
      const ci = complexityIndex(sigs);
      const sim = similarityMatrix(sigs);
      let maxSim = 0;
      for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) maxSim = Math.max(maxSim, sim[i][j]);
      // three populations with fixed abundances (negative, mixed, bright)
      const r = makeRng(seed + 100);
      const pops = [new Float64Array(K), Float64Array.from(range(K), () => (r.u() < 0.5 ? 0 : 2000 + 20000 * r.u())), Float64Array.from(range(K), () => 50000 * r.u())];
      const n = 3000;
      const cols = simulate(sigs, (e, a) => a.set(pops[Math.floor(e / n)]), 3 * n, { g: 40, sigma0: 150, seed });
      const out = unmix(defFor(sigs), cols, range(D));
      expect(out.length).toBe(K);
      let worstZ = 0;
      pops.forEach((truth, p) => {
        const idx = range(n).map((i) => p * n + i);
        for (let k = 0; k < K; k++) {
          const st = stats(out[k], idx);
          worstZ = Math.max(worstZ, Math.abs(st.mean - truth[k]) / st.se);
        }
      });
      console.log(`OLS D=${D} K=${K}: complexity ${ci.toFixed(2)}, max similarity ${maxSim.toFixed(3)}, worst |bias|/SE ${worstZ.toFixed(2)}`);
      expect(worstZ).toBeLessThan(5);
    });
  }

  it('square OLS unmixing equals compensation with the same matrix', () => {
    const D = 8;
    // one peak detector per fluor, overlapping tails
    const sigs = range(D).map((k) => range(D).map((d) => Math.exp(-0.5 * ((d - k) / 0.9) ** 2) + 0.05 * Math.exp(-0.5 * ((d - k - 3) / 1.5) ** 2)));
    const r = makeRng(5);
    const cols = simulate(sigs, (e, a) => a.forEach((_, k) => (a[k] = r.u() < 0.3 ? 30000 * r.u() : 0)), 5000, { g: 30, sigma0: 100, seed: 3 });
    // spillover matrix rows = signatures normalised at the primary (= peak) detector
    const prim = sigs.map((s) => s.indexOf(Math.max(...s)));
    expect(new Set(prim).size).toBe(D);
    const order = range(D).sort((a, b) => prim[a] - prim[b]); // fluor whose primary is detector j
    const S = order.map((k) => sigs[k].map((v) => v / sigs[k][prim[k]]));
    const comp = compensate(cols, range(D), S);
    const un = unmix(defFor(sigs), cols, range(D));
    let maxRel = 0;
    order.forEach((k, j) => {
      for (let e = 0; e < 5000; e++) maxRel = Math.max(maxRel, Math.abs(un[k][e] - comp[j][e]) / (Math.abs(comp[j][e]) + 100));
    });
    let changed = 0;
    for (let j = 0; j < D; j++) for (let e = 0; e < 5000; e++) changed = Math.max(changed, Math.abs(comp[j][e] - cols[j][e]) / (Math.abs(cols[j][e]) + 100));
    expect(changed).toBeGreaterThan(0.05); // the comparison is not vacuous
    console.log(`square OLS vs compensate(): max relative difference ${maxRel.toExponential(2)}`);
    expect(maxRel).toBeLessThan(1e-5);
  });

  it('WLS reduces spreading (matches the Gauss-Markov bound) and stays nearly unbiased', () => {
    const D = 32,
      K = 10;
    const sigs = makeSignatures(D, K, 31);
    const sim = similarityMatrix(sigs);
    let bi = 0,
      bj = 1;
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) if (i !== j && sim[i][j] > sim[bi][bj]) [bi, bj] = [i, j];
    const g = 50,
      sigma0 = 120;
    const n = 6000;
    // pop 0: bright F_i, dim others; pop 1: all negative; pop 2: dim F_i only
    const pops = [Float64Array.from(range(K), (k) => (k === bi ? 200000 : k === bj ? 0 : 500)), new Float64Array(K), Float64Array.from(range(K), (k) => (k === bi ? 3000 : 0))];
    const cols = simulate(sigs, (e, a) => a.set(pops[Math.floor(e / n)]), 3 * n, { g, sigma0, seed: 77 });
    const ols = unmix(defFor(sigs), cols, range(D));
    const wls = unmix(defFor(sigs, { method: 'wls', wls: { offset: (sigma0 * sigma0) / g } }), cols, range(D));
    const wlsDefault = unmix(defFor(sigs, { method: 'wls', noiseSD: new Array(D).fill(sigma0) }), cols, range(D));
    // theory for pop 0: Cov(OLS) = P S P', Cov(best linear unbiased) = (M' S^-1 M)^-1, S = diag(g * signal + sigma0^2)
    const sv = prepareUnmix(defFor(sigs)).solvers[0];
    const truth = pops[0];
    const s2 = range(D).map((d) => g * range(K).reduce((s, k) => s + truth[k] * sigs[k][d], 0) + sigma0 * sigma0);
    const olsT = range(K).map((k) => Math.sqrt(range(D).reduce((s, d) => s + sv.pinv[k * D + d] ** 2 * s2[d], 0)));
    const A = range(K).map((i) => [...range(K).map((j) => range(D).reduce((s, d) => s + (sigs[i][d] * sigs[j][d]) / s2[d], 0)), ...range(K).map((j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < K; c++) {
      const piv = A[c][c];
      for (let j = 0; j < 2 * K; j++) A[c][j] /= piv;
      for (let r2 = 0; r2 < K; r2++) if (r2 !== c) for (let j = 2 * K - 1; j >= 0; j--) A[r2][j] -= A[r2][c] * A[c][j];
    }
    const wlsT = range(K).map((k) => Math.sqrt(A[k][K + k]));
    const idx0 = range(n);
    const lines: string[] = [];
    let worstDev = 0,
      vo = 0,
      vw = 0;
    for (let k = 0; k < K; k++) {
      const so = stats(ols[k], idx0).sd;
      const sw = stats(wls[k], idx0).sd;
      worstDev = Math.max(worstDev, Math.abs(so / olsT[k] - 1), Math.abs(sw / wlsT[k] - 1));
      if (k !== bi) {
        vo += so * so;
        vw += sw * sw;
      }
      lines.push(`F${k + 1}: OLS sd ${so.toFixed(0)} (theory ${olsT[k].toFixed(0)}), WLS sd ${sw.toFixed(0)} (bound ${wlsT[k].toFixed(0)}), WLS default noise model ${stats(wlsDefault[k], idx0).sd.toFixed(0)}`);
    }
    let worstBias = 0;
    pops.forEach((t, p) => {
      const idx = range(n).map((i) => p * n + i);
      for (let k = 0; k < K; k++) {
        const st = stats(wls[k], idx);
        worstBias = Math.max(worstBias, (Math.abs(st.mean - t[k]) - 3 * st.se) / st.sd);
      }
    });
    console.log(`bright F${bi + 1} (200000) population:\n${lines.join('\n')}\nworst deviation from theory ${worstDev.toFixed(3)}, variance of the other endmembers WLS/OLS ${(vw / vo).toFixed(3)}, worst WLS bias ${worstBias.toFixed(3)} x per-event SD`);
    expect(worstDev).toBeLessThan(0.06);
    expect(vw).toBeLessThan(0.8 * vo);
    let vd = 0;
    for (let k = 0; k < K; k++) if (k !== bi) vd += stats(wlsDefault[k], idx0).sd ** 2;
    expect(vd).toBeLessThan(0.85 * vo);
    // negative and dim populations: no loss vs OLS
    for (const p of [1, 2]) {
      const idx = range(n).map((i) => p * n + i);
      for (let k = 0; k < K; k++) expect(stats(wls[k], idx).sd).toBeLessThan(1.05 * stats(ols[k], idx).sd);
    }
    expect(worstBias).toBeLessThan(0.1);
  });

  it('WLS kernel equals a naive per-event weighted least squares', () => {
    const D = 12,
      K = 5;
    const sigs = makeSignatures(D, K, 33);
    const r = makeRng(4);
    const n = 37; // not a multiple of the 4-event block
    const cols = simulate(sigs, (e, a) => a.forEach((_, k) => (a[k] = r.u() < 0.5 ? 0 : 1e5 * r.u())), n, { g: 30, sigma0: 100, seed: 6 });
    const offset = 250;
    for (const weightFrom of ['fit', 'observed'] as const) {
      const out = unmix(defFor(sigs, { method: 'wls', wls: { offset, weightFrom, iterations: 2 } }), cols, range(D));
      const ols = unmix(defFor(sigs), cols, range(D));
      let worst = 0;
      for (let e = 0; e < n; e++) {
        const y = range(D).map((d) => cols[d][e]);
        let a = range(K).map((k) => ols[k][e]);
        for (let it = 0; it < 2; it++) {
          const s = weightFrom === 'fit' ? range(D).map((d) => a.reduce((t, v, k) => t + v * sigs[k][d], 0)) : y;
          const w = s.map((v) => 1 / Math.max(Math.max(v, 0) + offset, offset));
          const A = range(K).map((i) => [...range(K).map((j) => range(D).reduce((t, d) => t + w[d] * sigs[i][d] * sigs[j][d], 0)), range(D).reduce((t, d) => t + w[d] * sigs[i][d] * y[d], 0)]);
          for (let c = 0; c < K; c++) {
            const piv = A[c][c];
            for (let j = 0; j <= K; j++) A[c][j] /= piv;
            for (let r2 = 0; r2 < K; r2++) if (r2 !== c) for (let j = K; j >= 0; j--) A[r2][j] -= A[r2][c] * A[c][j];
          }
          a = range(K).map((k) => A[k][K]);
        }
        for (let k = 0; k < K; k++) worst = Math.max(worst, Math.abs(out[k][e] - a[k]) / (Math.abs(a[k]) + 10));
      }
      expect(worst).toBeLessThan(1e-5);
    }
  });

  it('NNLS removes negatives but biases negative populations (OLS stays centred)', () => {
    const D = 24,
      K = 8;
    const sigs = makeSignatures(D, K, 41);
    const n = 4000;
    const pops = [new Float64Array(K), Float64Array.from(range(K), (k) => 10000 + 3000 * k)];
    const cols = simulate(sigs, (e, a) => a.set(pops[Math.floor(e / n)]), 2 * n, { g: 40, sigma0: 150, seed: 9 });
    const ols = unmix(defFor(sigs), cols, range(D));
    const nn = unmix(defFor(sigs, { method: 'nnls' }), cols, range(D));
    const wnn = unmix(defFor(sigs, { method: 'wls', nonNegative: true }), cols, range(D));
    let minV = Infinity;
    for (const out of [nn, wnn]) for (const c of out) for (const v of c) minV = Math.min(minV, v);
    expect(minV).toBeGreaterThanOrEqual(0);
    const neg = range(n);
    const pos = range(n).map((i) => n + i);
    const lines: string[] = [];
    for (let k = 0; k < K; k++) {
      const so = stats(ols[k], neg);
      const sn = stats(nn[k], neg);
      lines.push(`F${k + 1}: OLS ${so.mean.toFixed(1)} +- ${so.sd.toFixed(1)}, NNLS ${sn.mean.toFixed(1)} +- ${sn.sd.toFixed(1)}`);
      expect(Math.abs(so.mean)).toBeLessThan(5 * so.se);
      expect(sn.mean).toBeGreaterThan(10 * sn.se); // biased upwards
      // bright population: constraint inactive -> identical to OLS
      expect(stats(nn[k], pos).mean).toBeCloseTo(stats(ols[k], pos).mean, 0);
    }
    console.log(`negative population:\n${lines.join('\n')}`);
    // exact NNLS: brute force over all 2^K passive sets for 150 events
    const obj = (e: number, a: number[]) => range(D).reduce((s, d) => s + (cols[d][e] - a.reduce((t, v, k) => t + v * sigs[k][d], 0)) ** 2, 0);
    let worst = 0;
    for (let e = 0; e < 150; e++) {
      let best = Infinity;
      for (let mask = 0; mask < 1 << K; mask++) {
        const P = range(K).filter((k) => mask & (1 << k));
        if (!P.length) {
          best = Math.min(best, obj(e, new Array(K).fill(0)));
          continue;
        }
        const A = P.map((i) => [...P.map((j) => range(D).reduce((t, d) => t + sigs[i][d] * sigs[j][d], 0)), range(D).reduce((t, d) => t + sigs[i][d] * cols[d][e], 0)]);
        const m = P.length;
        for (let c = 0; c < m; c++) {
          const piv = A[c][c];
          for (let j = 0; j <= m; j++) A[c][j] /= piv;
          for (let r2 = 0; r2 < m; r2++) if (r2 !== c) for (let j = m; j >= 0; j--) A[r2][j] -= A[r2][c] * A[c][j];
        }
        if (A.some((row) => row[m] < 0)) continue;
        const a = new Array(K).fill(0);
        P.forEach((k, i) => (a[k] = A[i][m]));
        best = Math.min(best, obj(e, a));
      }
      const mine = obj(e, range(K).map((k) => nn[k][e]));
      worst = Math.max(worst, (mine - best) / best);
    }
    console.log(`NNLS vs brute force (150 events): worst relative objective excess ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-4);
  });

  it('residual output', () => {
    const D = 20,
      K = 6;
    const sigs = makeSignatures(D, K, 51);
    const extra = makeSignatures(D, 1, 99)[0];
    const n = 1000;
    const clean = simulate(sigs, (e, a) => a.forEach((_, k) => (a[k] = 5000 * ((e + k) % 3))), n, { g: 1e-6, sigma0: 0, seed: 1 });
    const dirty = simulate([...sigs, extra], (e, a) => a.forEach((_, k) => (a[k] = k === K ? 20000 : 5000 * ((e + k) % 3))), n, { g: 1e-6, sigma0: 0, seed: 1 });
    const def = defFor(sigs, { residual: 'rms' });
    expect(unmixOutputNames(def)).toEqual([...range(K).map((k) => `F${k + 1}`), 'Residual RMS']);
    const a = unmix(def, clean, range(D));
    const b = unmix(def, dirty, range(D));
    expect(stats(a[K]).mean).toBeLessThan(1); // only the tiny simulated shot noise remains
    expect(stats(b[K]).mean).toBeGreaterThan(1000);
    const ssr = unmix(defFor(sigs, { residual: 'ssr', method: 'wls' }), dirty, range(D));
    expect(stats(ssr[K]).mean).toBeGreaterThan(1e6);
  });

  it('autofluorescence: k-means signatures, AF endmember, per-event best AF', () => {
    const D = 32,
      K = 6;
    const sigs = makeSignatures(D, K, 61);
    // two AF spectra: broad UV/violet-ish and a red-shifted one
    const af1 = range(D).map((d) => 0.2 + Math.exp(-0.5 * ((d - 5) / 4) ** 2));
    const af2 = range(D).map((d) => 0.1 + Math.exp(-0.5 * ((d - 20) / 5) ** 2));
    const n = 6000;
    const r = makeRng(3);
    // unstained: half af1-type cells, half af2-type cells
    const unst = simulate([af1, af2], (e, a) => {
      const f = 3000 * Math.exp(0.3 * r.gauss());
      a[0] = e % 2 ? 0 : f;
      a[1] = e % 2 ? f : 0;
    }, n, { g: 30, sigma0: 80, seed: 4 });
    const set: EventSet = { columns: unst, detectorIndex: range(D) };
    const one = afSignatures(set);
    expect(one.endmembers.length).toBe(1);
    expect(one.endmembers[0].name).toBe('AF');
    expect(Math.max(...one.endmembers[0].signature)).toBe(1);
    const two = afSignatures(set, { k: 2 });
    expect(two.endmembers.length).toBe(2);
    const sims = two.endmembers.map((em) => Math.max(cos(em.signature, af1), cos(em.signature, af2)));
    console.log(`AF k=2 cluster sizes ${two.sizes}, cosine to truth ${sims.map((v) => v.toFixed(4))}`);
    for (const s of sims) expect(s).toBeGreaterThan(0.995);
    expect(cos(two.endmembers[0].signature, two.endmembers[1].signature)).toBeLessThan(0.9);
    // stained cells with AF (af1 or af2 per cell)
    const truth = Float64Array.from(range(K), (k) => 4000 + 2000 * k);
    const cells = simulate([...sigs, af1, af2], (e, a) => {
      a.set(truth);
      a[K] = e % 2 ? 0 : 3000;
      a[K + 1] = e % 2 ? 3000 : 0;
    }, n, { g: 30, sigma0: 80, seed: 5 });
    const base = defFor(sigs);
    const noAF = unmix(base, cells, range(D));
    const withAF = unmix({ ...base, af: two.endmembers, includeAF: true, afMode: 'all' }, cells, range(D));
    const best = unmix({ ...base, af: two.endmembers, includeAF: true, afMode: 'best' }, cells, range(D));
    expect(unmixOutputNames({ ...base, af: two.endmembers, includeAF: true })).toEqual([...range(K).map((k) => `F${k + 1}`), 'AF', 'AF Index']);
    let biasNo = 0,
      biasAF = 0,
      biasBest = 0;
    for (let k = 0; k < K; k++) {
      biasNo = Math.max(biasNo, Math.abs(stats(noAF[k]).mean - truth[k]));
      biasAF = Math.max(biasAF, Math.abs(stats(withAF[k]).mean - truth[k]));
      biasBest = Math.max(biasBest, Math.abs(stats(best[k]).mean - truth[k]));
    }
    // AF index: which AF signature corresponds to af1?
    const af1Idx = cos(two.endmembers[0].signature, af1) > cos(two.endmembers[1].signature, af1) ? 1 : 2;
    let correct = 0;
    for (let e = 0; e < n; e++) if ((best[K + 1][e] === af1Idx) === (e % 2 === 0)) correct++;
    console.log(`max |bias| of fluor abundances: no AF ${biasNo.toFixed(0)}, AF (all) ${biasAF.toFixed(0)}, AF (best) ${biasBest.toFixed(0)}; AF index correct ${((100 * correct) / n).toFixed(1)} %`);
    expect(biasNo).toBeGreaterThan(200);
    expect(biasAF).toBeLessThan(60);
    expect(biasBest).toBeLessThan(60);
    expect(correct / n).toBeGreaterThan(0.95);
  });

  it('spillover spreading matrix matches the Poisson theory and is lower with WLS', () => {
    const D = 24,
      K = 6;
    const sigs = makeSignatures(D, K, 71);
    const g = 50,
      sigma0 = 100,
      F = 100000,
      n = 8000;
    // one single-stain control per fluor: first n positive (F), next n negative
    const controls = sigs.map((_, i) =>
      simulate(sigs, (e, a) => {
        a.fill(0);
        if (e < n) a[i] = F;
      }, 2 * n, { g, sigma0, seed: 200 + i }),
    );
    const refs = (cols: Float32Array[], i: number) => ({
      endmember: i,
      pos: { columns: cols, detectorIndex: range(D), idx: Uint32Array.from(range(n)) },
      neg: { columns: cols, detectorIndex: range(D), idx: Uint32Array.from(range(n), (x) => x + n) },
    });
    const ols = controlSpread(defFor(sigs), controls.map(refs));
    const wls = controlSpread(defFor(sigs, { method: 'wls', wls: { offset: (sigma0 * sigma0) / g } }), controls.map(refs));
    // theory (OLS): SS_ij = sqrt(g * sum_d P_jd^2 M_di)
    const pu = prepareUnmix(defFor(sigs));
    const P = pu.solvers[0].pinv;
    let worst = 0,
      maxT = 0;
    const theory = range(K).map((i) => range(K).map((j) => (i === j ? NaN : Math.sqrt(g * range(D).reduce((s, d) => s + P[j * D + d] ** 2 * sigs[i][d], 0)))));
    theory.forEach((row) => row.forEach((v) => v > maxT && (maxT = v)));
    for (let i = 0; i < K; i++)
      for (let j = 0; j < K; j++) if (i !== j && theory[i][j] > 0.25 * maxT) worst = Math.max(worst, Math.abs(ols.ssm[i][j] / theory[i][j] - 1));
    let sumO = 0,
      sumW = 0,
      maxLeak = 0;
    for (let i = 0; i < K; i++)
      for (let j = 0; j < K; j++)
        if (i !== j) {
          sumO += ols.ssm[i][j];
          sumW += wls.ssm[i][j];
          maxLeak = Math.max(maxLeak, Math.abs(ols.leakage[i][j]));
        }
    const fmt = (m: number[][]) => m.map((r) => r.map((v) => (Number.isFinite(v) ? v.toFixed(2).padStart(6) : '     -')).join(' ')).join('\n');
    console.log(`SSM (OLS):\n${fmt(ols.ssm)}\nSSM theory:\n${fmt(theory)}\nSSM (WLS):\n${fmt(wls.ssm)}\nworst relative deviation from theory ${worst.toFixed(3)}, total spread OLS ${sumO.toFixed(1)} vs WLS ${sumW.toFixed(1)}, max leakage ${maxLeak.toExponential(2)}`);
    expect(worst).toBeLessThan(0.15);
    expect(sumW).toBeLessThan(0.9 * sumO);
    expect(maxLeak).toBeLessThan(0.005);
    // direct API
    const direct = spilloverSpreadingMatrix([{ endmember: 0, pos: [new Float32Array([10, 11, 12]), new Float32Array([0, 0, 0])], neg: [new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0])] }], 2);
    expect(direct[0][1]).toBe(0);
    expect(direct[1][0]).toBeNaN();
  });

  it('auto selection and signatures from synthetic single-stain controls (cells and beads)', () => {
    const D = 40,
      K = 8;
    const sigs = makeSignatures(D, K, 81);
    const af = range(D).map((d) => 0.15 + Math.exp(-0.5 * ((d - 6) / 5) ** 2));
    const clip = 4e6;
    const r = makeRng(17);
    const n = 20000;
    const i0 = 3;
    // cells: 8 % positive (lognormal), AF on all cells, a few saturated events
    const cells = simulate([sigs[i0], af], (e, a) => {
      a[0] = e % 12 === 0 ? 150000 * Math.exp(0.5 * r.gauss()) : 0;
      if (e % 997 === 0) a[0] = 8e6; // saturated
      a[1] = 2000 * Math.exp(0.3 * r.gauss());
    }, n, { g: 40, sigma0: 120, seed: 21, clip });
    const unst = simulate([af], (e, a) => (a[0] = 2000 * Math.exp(0.3 * r.gauss())), n, { g: 40, sigma0: 120, seed: 22, clip });
    const ranges = new Array(D).fill(clip / 0.9995 + 1);
    const ctrl: EventSet = { columns: cells, detectorIndex: range(D), ranges };
    const un: EventSet = { columns: unst, detectorIndex: range(D), ranges };
    const truePeak = sigs[i0].indexOf(1);
    for (const mode of ['control', 'unstained'] as const) {
      const { endmember, selection, result } = signatureFromControl(ctrl, { unstained: un, negativeFrom: mode, name: 'X' });
      const err = Math.max(...endmember.signature.map((v, d) => Math.abs(v - sigs[i0][d])));
      console.log(`cells (${mode} negative): peak ${selection.peak} (true ${truePeak}), nPos ${result.nPos}, nNeg ${result.nNeg}, saturated excluded ${selection.nSaturated}, max |error| ${err.toFixed(4)}, cos ${cos(endmember.signature, sigs[i0]).toFixed(5)}; warnings: ${result.warnings.join('; ')}`);
      expect(selection.peak).toBe(truePeak);
      expect(result.nSaturated).toBe(0);
      expect(selection.nSaturated).toBeGreaterThan(10);
      expect(result.warnings.join(' ')).toMatch(/saturated/);
      expect(err).toBeLessThan(0.02);
      expect(cos(endmember.signature, sigs[i0])).toBeGreaterThan(0.9995);
      expect(endmember.raw![truePeak]).toBeGreaterThan(50000);
    }
    // beads: 50 % positive, tight peaks, no unstained
    const i1 = 6;
    const beads = simulate([sigs[i1]], (e, a) => (a[0] = e % 2 ? 80000 * Math.exp(0.05 * r.gauss()) : 0), 4000, { g: 40, sigma0: 120, seed: 23 });
    const bsel = signatureFromControl({ columns: beads, detectorIndex: range(D) }, {});
    const berr = Math.max(...bsel.endmember.signature.map((v, d) => Math.abs(v - sigs[i1][d])));
    console.log(`beads: nPos ${bsel.result.nPos}, nNeg ${bsel.result.nNeg}, max |error| ${berr.toFixed(4)}`);
    expect(bsel.selection.negSource).toBe('control');
    expect(berr).toBeLessThan(0.02);
    // manual populations through buildSignature: identical to median differences
    const res = buildSignature({ columns: beads, detectorIndex: range(D), idx: Uint32Array.from(range(2000), (i) => 2 * i + 1) }, { columns: beads, detectorIndex: range(D), idx: Uint32Array.from(range(2000), (i) => 2 * i) });
    expect(res.peak).toBe(sigs[i1].indexOf(1));
    expect(Math.max(...res.signature)).toBe(1);
    expect(res.raw[res.peak]).toBeGreaterThan(70000);
  });

  it('definitions are plain JSON and the range API matches unmix()', () => {
    const D = 16,
      K = 5;
    const sigs = makeSignatures(D, K, 91);
    const r = makeRng(1);
    const cols = simulate(sigs, (e, a) => a.forEach((_, k) => (a[k] = r.u() * 20000)), 1003, { g: 30, sigma0: 100, seed: 2 });
    const def = defFor(sigs, { method: 'wls', residual: 'ssr', noiseSD: new Array(D).fill(100) });
    const copy = JSON.parse(JSON.stringify(def)) as UnmixDef;
    expect(copy).toEqual(def);
    const a = unmix(def, cols, range(D));
    const b = unmix(copy, cols, range(D));
    expect(b).toEqual(a);
    // chunked (worker-style) evaluation, odd chunk boundaries
    const pu = prepareUnmix(def);
    const out = pu.outNames.map(() => new Float32Array(1003));
    for (const [s, e] of [[0, 5], [5, 501], [501, 1003]]) unmixRange(pu, cols, out, s, e);
    expect(out).toEqual(a);
    // detector mapping by name, extra columns ignored
    const shuffled = [cols[3], new Float32Array(1003), ...cols];
    const chNames = ['X', 'Time', ...def.detectors];
    chNames[0] = 'D4-dup';
    const di = resolveDetectors(def, chNames);
    expect(di).toEqual(range(D).map((d) => d + 2));
    expect(unmix(def, shuffled, di)).toEqual(a);
  });

  it('WebAssembly SIMD kernel matches the JavaScript kernel', () => {
    expect(unmixWasmAvailable()).toBe(true);
    const D = 40,
      K = 15;
    const sigs = makeSignatures(D, K, 95);
    const r = makeRng(12);
    const n = 5003; // > 2 WASM chunks, not a multiple of 4
    const cols = simulate(sigs, (e, a) => a.forEach((_, k) => (a[k] = r.u() < 0.5 ? 0 : 1e5 * r.u() ** 2)), n, { g: 30, sigma0: 100, seed: 8 });
    const defs: Partial<UnmixDef>[] = [
      { method: 'ols' },
      { method: 'ols', residual: 'ssr' },
      { method: 'wls', noiseSD: new Array(D).fill(100), residual: 'rms' },
      { method: 'wls', wls: { offset: 300, weightFrom: 'observed', iterations: 3 } },
      // two AF signatures, per-event best AF (gather / scatter path)
      {
        method: 'wls',
        residual: 'ssr',
        includeAF: true,
        af: [
          { name: 'AF1', signature: range(D).map((d) => 0.2 + Math.exp(-0.5 * ((d - 5) / 4) ** 2)) },
          { name: 'AF2', signature: range(D).map((d) => 0.1 + Math.exp(-0.5 * ((d - 25) / 5) ** 2)) },
        ],
      },
    ];
    for (const extra of defs) {
      const def = defFor(sigs, extra);
      setUnmixWasm(false);
      const js = unmix(def, cols, range(D));
      setUnmixWasm(true);
      const wa = unmix(def, cols, range(D));
      let worst = 0;
      js.forEach((c, k) => {
        let scale = 0;
        for (let e = 0; e < n; e++) scale = Math.max(scale, Math.abs(c[e]));
        for (let e = 0; e < n; e++) worst = Math.max(worst, Math.abs(c[e] - wa[k][e]) / (Math.abs(c[e]) + 1e-6 * scale));
      });
      expect(worst).toBeLessThan(1e-5);
    }
  });

  it('naming helpers', () => {
    expect(endmemberNameFromSample('Compensation-FITC.fcs')).toBe('FITC');
    expect(endmemberNameFromSample('Beads20_BV711.fcs')).toBe('BV711');
    expect(endmemberNameFromSample('Unstained_Cells.fcs')).toBe('Unstained');
    expect(endmemberNameFromSample('PE-Cy7 (Beads)')).toBe('PE-Cy7');
    expect(endmemberNameFromSample('Comp Controls_APC Stained Control.fcs')).toBe('APC');
    expect(endmemberNameFromSample('Alexa Fluor 488-A')).toBe('Alexa Fluor 488');
    const def = createUnmixDef({ detectors: ['A'], endmembers: [{ name: 'PE', signature: [1] }, { name: 'PE', signature: [1] }] });
    expect(def.endmembers.map((e) => e.name)).toEqual(['PE', 'PE 2']);
    expect(unmixOutputNames({ ...def, endmembers: [def.endmembers[0]] }, ['PE'])).toEqual(['PE (unmixed)']);
  });

  it('control names: well ids, group / plate / specimen prefixes, bead notes and numbers are left out', () => {
    // Cytek Aurora reference controls (zenodo 17457137) and other instruments' file names in the test data
    const dir = '/home/claude/testdata/online/zenodo_17457137_aurora_refctrl';
    const aurora: Record<string, string> = {
      'Reference Group-A1 Unstained (Cells).fcs': 'Unstained',
      'Reference Group-A5 CD206 PE (Beads).fcs': 'CD206 PE',
      'Reference Group-A9 CD3 BV605 (Beads).fcs': 'CD3 BV605',
      'Reference Group-B4 CD8 FITC (Beads).fcs': 'CD8 FITC',
    };
    const onDisk = existsSync(dir) ? readdirSync(dir).filter((f) => /^Reference Group/.test(f)) : Object.keys(aurora);
    for (const f of onDisk) expect(endmemberNameFromSample(f)).toBe(aurora[f]);
    const cases: [string, string][] = [
      // BD (compensation tubes) and CytoFLEX controls
      ['Compensation-APC-Cy7.fcs', 'APC-Cy7'],
      ['Compensation-7AAD.fcs', '7AAD'],
      ['Compensation-AF700.fcs', 'AF700'],
      ['Compensation_Controls_PE_Stained_Control.fcs', 'PE'],
      ['Beads20_PerCP.fcs', 'PerCP'],
      ['A01_Beads_20_BV421_Raw.fcs', 'BV421'],
      ['Beads_2_PerCP_Run_1_20250709183851.fcs', 'PerCP'],
      ['Reference_Control_Specimen_Beads_CCR6_BV711.fcs', 'CCR6 BV711'],
      ['Comps_APC R660.fcs', 'APC R660'],
      ['Single_color_FITC_Raw.fcs', 'FITC'],
      ['Plate1_A01_CD3 FITC.fcs', 'CD3 FITC'],
      ['Specimen_001_CD3 FITC_001.fcs', 'CD3 FITC'],
      ['CD4 BUV395 (Cells) (2).fcs', 'CD4 BUV395'],
      ['Comp_Alexa Fluor 647.fcs', 'Alexa Fluor 647'],
      ['CD3 BV421 single stain.fcs', 'CD3 BV421'],
    ];
    for (const [f, want] of cases) expect(endmemberNameFromSample(f)).toBe(want);
  });
});

// ------------------------------------------------------------------ real data

function loadFcs(path: string): FcsDataset {
  const b = readFileSync(path);
  return parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

function setFor(ds: FcsDataset, detectors: string[], idx?: ArrayLike<number> | null): EventSet {
  const chNames = ds.channels.map((c) => c.name);
  const detectorIndex = detectors.map((d) => chNames.indexOf(d));
  if (detectorIndex.some((i) => i < 0)) throw new Error('missing detector');
  return { columns: ds.data, detectorIndex, idx, ranges: detectorIndex.map((i) => ds.channels[i].range) };
}

const fmtM = (m: number[][], digits = 3) => m.map((r) => r.map((v) => (Number.isFinite(v) ? v.toFixed(digits).padStart(digits + 4) : '-'.padStart(digits + 4))).join(' ')).join('\n');

// reference files (not part of the repository): each test is skipped when its folder is missing
const CYTOFLEX_DIR = '/home/claude/testdata/cytoflex';
const BD_COMP_DIR = '/home/claude/testdata/comp';

describe('real data', () => {
  it.skipIf(!existsSync(CYTOFLEX_DIR))('CytoFLEX LX single-stain beads + unstained cells', () => {
    const dir = CYTOFLEX_DIR;
    const bv = loadFcs(join(dir, 'Beads20_BV711.fcs'));
    const pc = loadFcs(join(dir, 'Beads20_PerCP.fcs'));
    const un = loadFcs(join(dir, 'Unstained_Cells.fcs'));
    const det = defaultDetectors(bv);
    expect(det.length).toBe(81);
    expect(det).not.toContain('FSC-A');
    const controls = [
      { ds: bv, name: endmemberNameFromSample('Beads20_BV711.fcs') },
      { ds: pc, name: endmemberNameFromSample('Beads20_PerCP.fcs') },
    ];
    // unstained cells are given, but bead controls have their own negative beads: 'auto' must use those
    const built = controls.map((c) => ({ ...c, ...signatureFromControl(setFor(c.ds, det), { unstained: setFor(un, det), name: c.name, source: c.name, detectorNames: det }) }));
    for (const b of built) expect(b.selection.negSource).toBe('control');
    for (const b of built)
      console.log(`${b.name}: selection detector ${det[b.selection.peak]}, signature peak ${det[b.result.peak]}, nPos ${b.result.nPos}, nNeg ${b.result.nNeg}, raw peak ${b.result.raw[b.result.peak].toFixed(0)}; ${b.result.warnings.join('; ')}`);
    expect(det[built[0].result.peak]).toMatch(/^V1[2-5]-A$/); // BV711 ~ 710 nm on the violet laser
    expect(det[built[1].result.peak]).toMatch(/^(B[6-9]|V1[0-3]|Y[4-6])-A$/); // PerCP ~ 678 nm
    const afr = afSignatures(setFor(un, det));
    const af = afr.endmembers[0];
    console.log(`AF peak ${det[af.peak!]} (raw ${af.raw![af.peak!].toFixed(0)})`);
    const def = createUnmixDef({ name: 'CytoFLEX', detectors: det, endmembers: built.map((b) => b.endmember), af: [af], includeAF: true, residual: 'rms', noiseSD: estimateNoiseSD(setFor(un, det)) });
    const q = unmixQuality(def);
    console.log(`similarity BV711/PerCP ${q.similarity[0][1].toFixed(3)}, BV711/AF ${q.similarity[0][2].toFixed(3)}, PerCP/AF ${q.similarity[1][2].toFixed(3)}, complexity ${q.complexity.toFixed(2)}`);
    expect(q.complexity).toBeGreaterThan(1);
    expect(q.complexity).toBeLessThan(20);
    for (const method of ['ols', 'wls'] as const) {
      const d2 = { ...def, method };
      const sp = controlSpread(
        d2,
        built.map((b, i) => ({ endmember: i, pos: b.selection.positive, neg: b.selection.negative })),
      );
      console.log(`${method} leakage (rows = control, cols = ${sp.names.join(', ')}):\n${fmtM(sp.leakage, 4)}\nSSM:\n${fmtM(sp.ssm, 2)}`);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) if (i !== j) expect(Math.abs(sp.leakage[i][j])).toBeLessThan(0.01);
      // the whole control files unmix to their own endmember
      const outBV = unmix(d2, bv.data, resolveDetectors(def, bv.channels.map((c) => c.name)));
      const posIdx = built[0].selection.positive.idx!;
      const med = (a: Float32Array, idx: ArrayLike<number>) => Float32Array.from(Array.from(idx, (i) => a[i])).sort()[idx.length >> 1];
      console.log(`${method}: BV711 positives -> BV711 ${med(outBV[0], posIdx).toFixed(0)}, PerCP ${med(outBV[1], posIdx).toFixed(0)}, AF ${med(outBV[2], posIdx).toFixed(0)}, residual RMS ${med(outBV[3], posIdx).toFixed(0)}`);
    }
  });

  it.skipIf(!existsSync(BD_COMP_DIR))('BD single-stain controls: non-square unmixing and equivalence with autocomp compensation', () => {
    const dir = BD_COMP_DIR;
    const files = readdirSync(dir).filter((f) => f.endsWith('.fcs')).sort();
    const data = new Map(files.map((f) => [f, loadFcs(join(dir, f))]));
    const unName = files.find((f) => /Unstained/i.test(f))!;
    const un = data.get(unName)!;
    const det = defaultDetectors(un);
    expect(det.length).toBe(11);
    const ctrlFiles = files.filter((f) => f !== unName);
    const built = ctrlFiles.map((f) => {
      const ds = data.get(f)!;
      const name = endmemberNameFromSample(f);
      return { f, ds, name, ...signatureFromControl(setFor(ds, det), { unstained: setFor(un, det), name, source: f, detectorNames: det }) };
    });
    for (const b of built)
      console.log(`${b.name.padEnd(8)} peak ${det[b.result.peak].padEnd(18)} nPos ${b.result.nPos} nNeg ${b.result.nNeg} sig ${b.endmember.signature.map((v) => v.toFixed(2)).join(' ')}${b.result.warnings.length ? '  [' + b.result.warnings.join('; ') + ']' : ''}`);
    const expectPeak: Record<string, RegExp> = { FITC: /488/, PE: /^PE-A/, APC: /647/, AF700: /700/, 'APC-Cy7': /APC-Cy7/, '7AAD': /7-AAD/ };
    for (const b of built) expect(det[b.result.peak]).toMatch(expectPeak[b.name]);
    const af = afSignatures(setFor(un, det)).endmembers[0];
    const def = createUnmixDef({ name: 'BD', detectors: det, endmembers: built.map((b) => b.endmember), af: [af], includeAF: true, noiseSD: estimateNoiseSD(setFor(un, det)) });
    const q = unmixQuality(def);
    console.log(`BD panel (6 fluors + AF on 11 detectors): complexity ${q.complexity.toFixed(2)}, max similarity ${Math.max(...q.similarity.flatMap((r, i) => r.filter((_, j) => j !== i))).toFixed(3)}`);
    for (const [method, includeAF] of [['ols', false], ['ols', true], ['wls', true]] as const) {
      const sp = controlSpread({ ...def, method, includeAF }, built.map((b, i) => ({ endmember: i, pos: b.selection.positive, neg: b.selection.negative })));
      console.log(`${method}${includeAF ? ' + AF' : ''} leakage (rows = controls, cols = ${sp.names.join(', ')}):\n${fmtM(sp.leakage, 4)}\n${method} SSM:\n${fmtM(sp.ssm, 2)}`);
      for (let i = 0; i < built.length; i++) for (let j = 0; j < built.length; j++) if (i !== j) expect(Math.abs(sp.leakage[i][j])).toBeLessThan(0.03);
    }

    // ---- square case: the 6 primary detectors, compared with autocomp.computeSpillover + compensate()
    const prim = built.map((b) => det[b.result.peak]);
    const eng = new Engine();
    const ws = emptyWorkspace();
    for (const f of files) {
      const ds = data.get(f)!;
      eng.addSample(f, ds);
      ws.samples.push({ id: f, name: f.replace('.fcs', ''), fileName: f, fileSize: 0, eventCount: ds.eventCount, channels: ds.channels.map((c) => ({ name: c.name, label: c.label, range: c.range })), compId: null });
    }
    const auto = computeSpillover(ws, eng, built.map((b, k) => ({ sampleId: b.f, channel: prim[k] })), { population: 'root', unstainedId: unName, method: 'median' });
    // my signatures restricted to the primary detectors, normalised at the primary detector
    const sq = built.map((b) => signatureFromControl(setFor(b.ds, prim), { unstained: setFor(un, prim), name: b.name }));
    // (different positive gates: autocomp takes all events above the unstained 99.5th percentile,
    // the unmixing helper the brightest 3 %, so small differences are expected)
    let maxDiff = 0;
    let where = '';
    const mine = sq.map((s, k) => s.result.raw.map((v) => v / s.result.raw[k]));
    mine.forEach((row, k) => {
      for (let j = 0; j < prim.length; j++)
        if (j !== k && Math.abs(row[j] - auto.matrix[k][j]) > maxDiff) {
          maxDiff = Math.abs(row[j] - auto.matrix[k][j]);
          where = `${built[k].name} -> ${prim[j]}`;
        }
    });
    console.log(`autocomp spillover (median method):\n${fmtM(auto.matrix, 4)}\nunmixing signatures normalised at the primary detector:\n${fmtM(mine, 4)}\nmax |difference| ${maxDiff.toFixed(4)} (${where})`);
    expect(maxDiff).toBeLessThan(0.05);
    // OLS with the square signature matrix S (rows = autocomp spillover) == compensation with S
    const sqDef = createUnmixDef({ detectors: prim, endmembers: auto.matrix.map((row, k) => ({ name: built[k].name, signature: row })) });
    const scale = auto.matrix.map((row) => Math.max(...row)); // abundance (peak units) * max = primary-detector units
    let maxRel = 0;
    for (const b of built) {
      const idx = resolveDetectors(sqDef, b.ds.channels.map((c) => c.name));
      const comp = compensate(b.ds.data, idx, auto.matrix);
      const un2 = unmix(sqDef, b.ds.data, idx);
      for (let k = 0; k < prim.length; k++) {
        const c = comp[idx[k]];
        expect(c).not.toBe(b.ds.data[idx[k]]);
        for (let e = 0; e < c.length; e++) maxRel = Math.max(maxRel, Math.abs(un2[k][e] * scale[k] - c[e]) / (Math.abs(c[e]) + 1));
      }
    }
    console.log(`square OLS unmixing vs compensate() on 6 x 50000 events: max relative difference ${maxRel.toExponential(2)}`);
    expect(maxRel).toBeLessThan(1e-4);
  });
});

// ------------------------------------------------------------------ performance

describe('performance', () => {
  it('1M events x 48 detectors x 24 endmembers (OLS and WLS)', () => {
    const D = 48,
      K = 24,
      N = 1_000_000;
    // WLS / NNLS cost ~ D*K^2/2 + K^3/6 per event: timed on a subset unless UNMIX_BENCH_FULL=1
    const nWls = process.env.UNMIX_BENCH_FULL ? N : 100_000;
    const sigs = makeSignatures(D, K, 5, 6);
    const r = makeRng(8);
    const cols = Array.from({ length: D }, () => new Float32Array(N));
    // cheap synthetic events: random abundances + gaussian noise (the kernel cost does not depend on values)
    const a = new Float64Array(K);
    const first = new Float64Array(K);
    for (let e = 0; e < N; e++) {
      if ((e & 63) === 0) for (let k = 0; k < K; k++) a[k] = r.u() < 0.4 ? 0 : 50000 * r.u();
      if (e === 0) first.set(a);
      for (let d = 0; d < D; d++) {
        let s = 0;
        for (let k = 0; k < K; k++) s += a[k] * sigs[k][d];
        cols[d][e] = s + 200 * (r.u() - 0.5);
      }
    }
    const res: string[] = [`WebAssembly SIMD kernel: ${unmixWasmAvailable() ? 'yes' : 'no (JavaScript kernel)'}`];
    // JavaScript kernel (fallback when WASM SIMD is unavailable) on 100k events
    setUnmixWasm(false);
    for (const method of ['ols', 'wls'] as const) {
      const pu = prepareUnmix(defFor(sigs, { method, noiseSD: new Array(D).fill(100) }));
      const out = pu.outNames.map(() => new Float32Array(N));
      unmixRange(pu, cols, out, 0, 4096);
      const t0 = performance.now();
      unmixRange(pu, cols, out, 0, 100_000);
      res.push(`${method.toUpperCase()} (JavaScript kernel): ${(((performance.now() - t0) / 100_000) * 1e3).toFixed(2)} s per 1M events`);
    }
    setUnmixWasm(true);
    for (const method of ['ols', 'wls', 'nnls'] as const) {
      const def = defFor(sigs, { method, noiseSD: new Array(D).fill(100) });
      const n = method === 'ols' ? N : nWls;
      const pu = prepareUnmix(def);
      const out = pu.outNames.map(() => new Float32Array(N));
      unmixRange(pu, cols, out, 0, 4096); // warm-up
      const t0 = performance.now();
      unmixRange(pu, cols, out, 0, n);
      const dt = performance.now() - t0;
      res.push(`${method.toUpperCase()}: ${n.toLocaleString('en-US')} events in ${(dt / 1000).toFixed(2)} s -> ${((dt / n) * 1e3).toFixed(2)} s per 1M events`);
      // sanity: the first event reproduces its abundances
      for (let k = 0; k < K; k++) expect(Math.abs(out[k][0] - first[k])).toBeLessThan(3000);
    }
    const t1 = performance.now();
    const outR = unmix(defFor(sigs, { residual: 'ssr' }), cols, range(D));
    res.push(`OLS + residual: ${((performance.now() - t1) / 1000).toFixed(2)} s for 1M (incl. allocation)`);
    expect(outR.length).toBe(K + 1);
    console.log(`benchmark (single thread; note: vitest's default 'forks' pool runs this ~2x slower than plain node / browser V8):\n${res.join('\n')}`);
  }, 300_000);
});
