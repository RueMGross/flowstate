// Automatic gating ("Auto gate"): finds the population under a click, or inside a dragged rectangle, from the event
// density in plot display space (0..1 after the plot's scales, so zoom windows are respected). Pure functions without
// store / engine access, so they can be unit tested.
//
// 2D: events are binned on a G x G grid, extended by a margin beyond the frame where off-scale events sit at their true
// display position (so a pile on the axis edge does not dominate the density; the part of a population beyond the frame
// is projected back onto the edge cells, where gates count off-scale events), and lightly smoothed (Gaussian,
// renormalized at the grid border). Statistics are never smoothed. A descending
// sweep over the smoothed density (a priority flood: every local maximum starts a basin, every cell joins the basin of
// its highest processed neighbour) segments the grid. Where two basins meet, the smaller one is merged when it is not a
// separate population: the saddle is >= MERGE_RATIO x its peak (a shoulder), or its prominence is within Poisson noise.
// The seed basin is thresholded at alpha x its peak density, reduced to the 4-connected component containing the peak,
// hole-filled, traced (marching squares on the mask), simplified (Douglas-Peucker) and dilated by half a bin.
// 1D: the same sweep on a smoothed histogram; the range runs to the valleys (neighbouring populations share the cut) or
// to where the density falls below alpha x peak (open towards the axis end for a negative / positive population). Event counts are exact (EventGrid counts events inside a polygon the way polygon gates are evaluated).
import { pointInPolygon } from './gating';

/** Density threshold presets (fraction of the population's peak density). */
export const SENSITIVITY = { tight: 0.2, normal: 0.05, loose: 0.02 } as const;
export type Sensitivity = keyof typeof SENSITIVITY;
/** Range of the tightness slider: alpha at the tight and at the loose end (log-spaced in between). */
export const ALPHA_TIGHTEST = 0.3;
export const ALPHA_LOOSEST = 0.01;
/** Two basins merge when the saddle between them is at least this fraction of the smaller peak. */
export const MERGE_RATIO = 0.6;
/** Prominences within this many Poisson standard deviations are noise. */
const NOISE_Z = 3;
export const MAX_VERTICES = 40;

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Slider position (0 = tightest, 1 = loosest) -> density threshold alpha. */
export function alphaFromTightness(t: number): number {
  return ALPHA_TIGHTEST * Math.pow(ALPHA_LOOSEST / ALPHA_TIGHTEST, clamp01(t));
}

export function tightnessFromAlpha(alpha: number): number {
  return clamp01(Math.log(alpha / ALPHA_TIGHTEST) / Math.log(ALPHA_LOOSEST / ALPHA_TIGHTEST));
}

/** Smoothing for segmentation, in display units: light, wider for few events (Scott-like N^-1/6, N^-1/5 in 1D). */
export function defaultSigma2D(n: number): number {
  return Math.min(0.02, Math.max(0.004, 0.006 * Math.pow(Math.max(n, 1) / 1e5, -1 / 6)));
}

export function defaultSigma1D(n: number): number {
  return Math.min(0.024, Math.max(0.004, 0.006 * Math.pow(Math.max(n, 1) / 1e5, -1 / 5)));
}

// ------------------------------------------------------------------ smoothing

function kernel(sigma: number): Float64Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  return k;
}

/** 1 / (sum of kernel weights inside 0..n-1) per position */
function edgeNorm(k: Float64Array, n: number): Float64Array {
  const r = (k.length - 1) >> 1;
  const out = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let i = Math.max(0, x - r); i <= Math.min(n - 1, x + r); i++) s += k[i - x + r];
    out[x] = s > 0 ? 1 / s : 0;
  }
  return out;
}

/** Separable Gaussian blur (sigma in bins), renormalized at the grid border so edge densities are not underestimated. */
export function blurDensity(src: Float32Array, gx: number, gy: number, sigma: number): Float32Array {
  const out = new Float32Array(gx * gy);
  if (!(sigma > 0)) {
    out.set(src);
    return out;
  }
  const k = kernel(sigma);
  const r = (k.length - 1) >> 1;
  const nx = edgeNorm(k, gx);
  const tmp = gy === 1 ? out : new Float32Array(gx * gy);
  const rowUsed = new Uint8Array(gy);
  for (let y = 0; y < gy; y++) {
    const row = y * gx;
    let any = false;
    for (let x = 0; x < gx; x++)
      if (src[row + x] !== 0) {
        any = true;
        break;
      }
    if (!any) continue;
    rowUsed[y] = 1;
    for (let x = 0; x < gx; x++) {
      let s = 0;
      const a = x - r < 0 ? 0 : x - r;
      const b = x + r >= gx ? gx - 1 : x + r;
      for (let xx = a, ki = a - x + r; xx <= b; xx++, ki++) s += src[row + xx] * k[ki];
      tmp[row + x] = s * nx[x];
    }
  }
  if (gy === 1) return out;
  const ny = edgeNorm(k, gy);
  for (let y = 0; y < gy; y++) {
    const a = y - r < 0 ? 0 : y - r;
    const b = y + r >= gy ? gy - 1 : y + r;
    let any = false;
    for (let yy = a; yy <= b; yy++)
      if (rowUsed[yy]) {
        any = true;
        break;
      }
    if (!any) continue;
    const row = y * gx;
    for (let x = 0; x < gx; x++) {
      let s = 0;
      for (let yy = a, ki = a - y + r; yy <= b; yy++, ki++) s += tmp[yy * gx + x] * k[ki];
      out[row + x] = s * ny[y];
    }
  }
  return out;
}

// ------------------------------------------------------------------ segmentation

interface Segmentation {
  /** basin (root cell) of every cell, -1 where the density is 0 */
  comp: Int32Array;
  /** peak density of each root */
  peak: Float32Array;
  /** cell of the highest peak of each root */
  peakCell: Int32Array;
}

/** Cells with density > 0, in ascending order of density (LSD radix sort on the float32 bit patterns). */
function sortCells(S: Float32Array): Uint32Array {
  const n = S.length;
  // non-negative float32 bit patterns sort like the values
  const bits = new Uint32Array(S.buffer, S.byteOffset, n);
  let m = 0;
  for (let c = 0; c < n; c++) if (S[c] > 0) m++;
  let ka = new Uint32Array(m);
  let va = new Uint32Array(m);
  let kb = new Uint32Array(m);
  let vb = new Uint32Array(m);
  m = 0;
  for (let c = 0; c < n; c++)
    if (S[c] > 0) {
      ka[m] = bits[c];
      va[m++] = c;
    }
  const cnt = new Uint32Array(2048);
  for (let shift = 0; shift < 32; shift += 11) {
    cnt.fill(0);
    for (let i = 0; i < m; i++) cnt[(ka[i] >>> shift) & 2047]++;
    let sum = 0;
    for (let b = 0; b < 2048; b++) {
      const t = cnt[b];
      cnt[b] = sum;
      sum += t;
    }
    for (let i = 0; i < m; i++) {
      const p = cnt[(ka[i] >>> shift) & 2047]++;
      kb[p] = ka[i];
      vb[p] = va[i];
    }
    [ka, kb] = [kb, ka];
    [va, vb] = [vb, va];
  }
  return va;
}

/**
 * Priority flood over the smoothed density (cells in descending order) with union-find merging of basins.
 * 8-connected in 2D (gy > 1), left / right neighbours in 1D.
 */
function segment(S: Float32Array, gx: number, gy: number, noiseK: number): Segmentation {
  const n = gx * gy;
  const order = sortCells(S);
  const parent = new Int32Array(n).fill(-1);
  const peak = new Float32Array(n);
  const peakCell = new Int32Array(n).fill(-1);
  const find = (x: number) => {
    while (parent[x] !== x) {
      const g = parent[parent[x]];
      parent[x] = g;
      x = g;
    }
    return x;
  };
  const roots = new Int32Array(8);
  const twoD = gy > 1;
  const offs = twoD ? [-gx - 1, -gx, -gx + 1, -1, 1, gx - 1, gx, gx + 1] : [-1, 1];
  const dxs = twoD ? [-1, 0, 1, -1, 1, -1, 0, 1] : [-1, 1];
  const dys = twoD ? [-1, -1, -1, 0, 0, 1, 1, 1] : [0, 0];
  const nOff = offs.length;
  const merge1 = 1 - MERGE_RATIO;
  for (let k = order.length - 1; k >= 0; k--) {
    const c = order[k];
    const s = S[c];
    const cx = c % gx;
    const cy = (c - cx) / gx;
    const border = cx === 0 || cx === gx - 1 || (twoD && (cy === 0 || cy === gy - 1));
    let nr = 0;
    let best = -1;
    let bestS = -1;
    for (let q = 0; q < nOff; q++) {
      if (border) {
        const xx = cx + dxs[q];
        const yy = cy + dys[q];
        if (xx < 0 || xx >= gx || yy < 0 || yy >= gy) continue;
      }
      const nb = c + offs[q];
      if (parent[nb] < 0) continue;
      const r = find(nb);
      const sn = S[nb];
      if (sn > bestS) {
        bestS = sn;
        best = r;
      }
      let dup = false;
      for (let t = 0; t < nr; t++) if (roots[t] === r) dup = true;
      if (!dup) roots[nr++] = r;
    }
    if (nr === 0) {
      // a new local maximum
      parent[c] = c;
      peak[c] = s;
      peakCell[c] = c;
      continue;
    }
    if (nr > 1) {
      // basins meet at this cell: the pass between them is at height s (cells come in descending order); the lower
      // basin is merged unless it is a population of its own (prominent relative to its height and to the noise)
      for (let i = 1; i < nr; i++) {
        const v = roots[i];
        let j = i - 1;
        while (j >= 0 && peak[roots[j]] < peak[v]) {
          roots[j + 1] = roots[j];
          j--;
        }
        roots[j + 1] = v;
      }
      for (let i = 1; i < nr; i++) {
        for (let j = 0; j < i; j++) {
          const a = find(roots[j]);
          const b = find(roots[i]);
          if (a === b) break;
          const hi = peak[a] >= peak[b] ? a : b;
          const lo = hi === a ? b : a;
          const pLo = peak[lo];
          const prom = pLo - s;
          if (prom <= merge1 * pLo || prom <= noiseK * Math.sqrt(pLo + s)) {
            parent[lo] = hi;
            break;
          }
        }
      }
    }
    parent[c] = find(best);
  }
  const comp = new Int32Array(n).fill(-1);
  for (let c = 0; c < n; c++) if (parent[c] >= 0) comp[c] = find(c);
  return { comp, peak, peakCell };
}

// ------------------------------------------------------------------ 2D

export type Seed2D = { u: number; v: number } | { rect: [number, number, number, number] };

export interface Located2D {
  root: number;
  /** cell of the extended grid the region grows from (the seed peak) */
  start: number;
  /** density the threshold is relative to */
  peakRef: number;
  /** drag: rectangle in frame grid units [x0, y0, x1, y1]; sides at the frame edge are open (+-Infinity) */
  rect: [number, number, number, number] | null;
}

export interface Region2D {
  /** frame grid (G x G); parts beyond the frame are projected onto the edge cells, where gates count off-scale events */
  mask: Uint8Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cells: number;
  /** binned (unsmoothed) events in the region, incl. off-scale ones */
  events: number;
  /** whether the region extends beyond the frame (left, bottom, right, top) */
  beyond: [boolean, boolean, boolean, boolean];
}

export interface DensityOptions {
  /** bins per axis across the frame */
  bins?: number;
  /** extra bins beyond each frame edge for off-scale events (default bins / 8) */
  margin?: number;
  /** smoothing in bins (default: from the event count) */
  sigma?: number;
  /** zoom window axes: events outside 0..1 are not shown, so they are dropped */
  dropX?: boolean;
  dropY?: boolean;
}

/**
 * 2D histogram on the frame grid (G bins per axis) extended by M bins beyond each edge. Off-scale events are binned at
 * their display position beyond the frame (the plot piles them on the edge; spreading them keeps the edge pile from
 * dominating the density) and clamped into the outermost margin bins; values exactly on the frame edge (clamped by the
 * scale itself, e.g. FlowJo log) go to the middle of the margin. On zoom window axes events outside 0..1 are dropped.
 */
export function histogram2D(dx: Float32Array, dy: Float32Array, idx: Uint32Array, G: number, M: number, dropX = false, dropY = false): Float32Array {
  const GE = G + 2 * M;
  const H = new Float32Array(GE * GE);
  // extended-grid bin of an off-frame (or exactly-on-edge) value; -1: not binned
  const slow = (u: number, drop: boolean): number => {
    if (u !== u) return -1;
    if (drop) return u === 0 ? M : u === 1 ? M + G - 1 : -1;
    if (u === 0) return M >> 1;
    if (u === 1) return M + G + (M >> 1);
    const b = Math.floor(u * G) + M;
    return b < 0 ? 0 : b >= GE ? GE - 1 : b;
  };
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    const u = dx[e];
    const v = dy[e];
    const bx = u > 0 && u < 1 ? ((u * G) | 0) + M : slow(u, dropX);
    const by = v > 0 && v < 1 ? ((v * G) | 0) + M : slow(v, dropY);
    if (bx < 0 || by < 0) continue;
    H[by * GE + bx]++;
  }
  return H;
}

export class DensityMap2D {
  /** extended grid size (G + 2M) */
  readonly GE: number;
  readonly S: Float32Array;
  readonly comp: Int32Array;
  readonly peak: Float32Array;
  readonly peakCell: Int32Array;
  readonly sigma: number;
  readonly total: number;
  /** noise std of the smoothed density per sqrt(count) */
  readonly noiseK: number;

  /** H: extended histogram (GE x GE, see histogram2D) */
  constructor(
    readonly H: Float32Array,
    readonly G: number,
    readonly M: number,
    sigma?: number,
  ) {
    const GE = G + 2 * M;
    if (H.length !== GE * GE) throw new Error('autogate: histogram size');
    this.GE = GE;
    let total = 0;
    for (let i = 0; i < H.length; i++) total += H[i];
    this.total = total;
    this.sigma = sigma ?? defaultSigma2D(total) * G;
    this.S = blurDensity(H, GE, GE, this.sigma);
    // variance of a Gaussian-smoothed Poisson count: lambda / (4 pi sigma^2)
    this.noiseK = NOISE_Z / Math.sqrt(4 * Math.PI * this.sigma * this.sigma);
    const seg = segment(this.S, GE, GE, this.noiseK);
    this.comp = seg.comp;
    this.peak = seg.peak;
    this.peakCell = seg.peakCell;
  }

  static fromEvents(dx: Float32Array, dy: Float32Array, idx: Uint32Array, opts: DensityOptions = {}): DensityMap2D {
    const G = opts.bins ?? 256;
    const M = opts.margin ?? G >> 3;
    return new DensityMap2D(histogram2D(dx, dy, idx, G, M, opts.dropX, opts.dropY), G, M, opts.sigma);
  }

  /** a density peak that is not Poisson noise */
  significant(p: number): boolean {
    return p > this.noiseK * this.noiseK;
  }

  /** extended grid cell of a frame display coordinate */
  private cellOf(u: number) {
    const b = Math.floor(u * this.G);
    return this.M + (b < 0 ? 0 : b >= this.G ? this.G - 1 : b);
  }

  /** The basin under a click (the nearest one within ~3 % of the axes) or the highest peak inside a rectangle. */
  locate(seed: Seed2D): Located2D | null {
    const { G, GE, S, comp, peak, peakCell } = this;
    if ('rect' in seed) {
      const [a, b, c, d] = seed.rect;
      const u0 = Math.min(a, c);
      const u1 = Math.max(a, c);
      const v0 = Math.min(b, d);
      const v1 = Math.max(b, d);
      // sides dragged onto the frame edge stay open, so off-scale events beyond it can be included
      const open = 0.5 / G;
      const rect: [number, number, number, number] = [
        u0 <= open ? -Infinity : u0 * G,
        v0 <= open ? -Infinity : v0 * G,
        u1 >= 1 - open ? Infinity : u1 * G,
        v1 >= 1 - open ? Infinity : v1 * G,
      ];
      const [i0, j0, i1, j1] = this.rectCells(rect);
      let best = -1;
      let bs = 0;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cell = j * GE + i;
          if (comp[cell] >= 0 && S[cell] > bs) {
            bs = S[cell];
            best = cell;
          }
        }
      if (best < 0 || !this.significant(bs)) return null;
      return { root: comp[best], start: best, peakRef: bs, rect };
    }
    const ci = this.cellOf(seed.u);
    const cj = this.cellOf(seed.v);
    const R = Math.max(2, Math.round(0.03 * G));
    for (let r = 0; r <= R; r++) {
      let best = -1;
      let bs = 0;
      for (let j = cj - r; j <= cj + r; j++) {
        if (j < 0 || j >= GE) continue;
        const ring = j === cj - r || j === cj + r;
        for (let i = ci - r; i <= ci + r; i += ring ? 1 : 2 * r) {
          if (i >= 0 && i < GE) {
            const cell = j * GE + i;
            const root = comp[cell];
            if (root >= 0 && this.significant(peak[root]) && S[cell] >= ALPHA_LOOSEST * peak[root] && S[cell] > bs) {
              bs = S[cell];
              best = cell;
            }
          }
          if (r === 0) break;
        }
      }
      if (best >= 0) {
        const root = comp[best];
        return { root, start: peakCell[root], peakRef: peak[root], rect: null };
      }
    }
    return null;
  }

  /** extended-grid cell range [i0, j0, i1, j1] of the cells overlapping a frame-unit rectangle */
  private rectCells(rect: [number, number, number, number] | null): [number, number, number, number] {
    const { M, GE } = this;
    if (!rect) return [0, 0, GE - 1, GE - 1];
    const lo = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(GE - 1, Math.floor(v) + M)) : 0);
    const hi = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(GE - 1, Math.ceil(v) - 1 + M)) : GE - 1);
    return [lo(rect[0]), lo(rect[1]), hi(rect[2]), hi(rect[3])];
  }

  /**
   * Cells of the seed basin with density >= alpha x peak (the component containing the peak), projected onto the frame
   * grid (off-scale parts onto the edge cells), holes filled.
   */
  region(loc: Located2D, alpha: number): Region2D | null {
    const { G, M, GE, S, comp, H } = this;
    const thr = alpha * loc.peakRef;
    const root = loc.root;
    const [ri0, rj0, ri1, rj1] = this.rectCells(loc.rect);
    const ok = (c: number) => {
      if (comp[c] !== root || S[c] < thr) return false;
      const i = c % GE;
      const j = (c - i) / GE;
      return i >= ri0 && i <= ri1 && j >= rj0 && j <= rj1;
    };
    if (!ok(loc.start)) return null;
    const ext = new Uint8Array(GE * GE);
    const mask = new Uint8Array(G * G);
    const queue = new Int32Array(GE * GE);
    let qh = 0,
      qt = 0;
    queue[qt++] = loc.start;
    ext[loc.start] = 1;
    let x0 = G,
      y0 = G,
      x1 = -1,
      y1 = -1;
    let events = 0;
    const beyond: [boolean, boolean, boolean, boolean] = [false, false, false, false];
    while (qh < qt) {
      const c = queue[qh++];
      events += H[c];
      const I = c % GE;
      const J = (c - I) / GE;
      // projection onto the frame grid
      let i = I - M;
      let j = J - M;
      if (i < 0) (i = 0), (beyond[0] = true);
      else if (i >= G) (i = G - 1), (beyond[2] = true);
      if (j < 0) (j = 0), (beyond[1] = true);
      else if (j >= G) (j = G - 1), (beyond[3] = true);
      mask[j * G + i] = 1;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < y0) y0 = j;
      if (j > y1) y1 = j;
      if (I > 0 && !ext[c - 1] && ok(c - 1)) (ext[c - 1] = 1), (queue[qt++] = c - 1);
      if (I < GE - 1 && !ext[c + 1] && ok(c + 1)) (ext[c + 1] = 1), (queue[qt++] = c + 1);
      if (J > 0 && !ext[c - GE] && ok(c - GE)) (ext[c - GE] = 1), (queue[qt++] = c - GE);
      if (J < GE - 1 && !ext[c + GE] && ok(c + GE)) (ext[c + GE] = 1), (queue[qt++] = c + GE);
    }
    // fill holes: background not 4-connected to the outside of the bounding box (no pinch points remain)
    const W = x1 - x0 + 3;
    const Hh = y1 - y0 + 3;
    const seen = new Uint8Array(W * Hh);
    const isBg = (li: number, lj: number) => {
      const i = x0 - 1 + li;
      const j = y0 - 1 + lj;
      return i < 0 || j < 0 || i >= G || j >= G || !mask[j * G + i];
    };
    qh = qt = 0;
    const seed = (l: number) => {
      if (!seen[l]) (seen[l] = 1), (queue[qt++] = l);
    };
    for (let li = 0; li < W; li++) seed(li), seed((Hh - 1) * W + li);
    for (let lj = 1; lj < Hh - 1; lj++) seed(lj * W), seed(lj * W + W - 1);
    while (qh < qt) {
      const l = queue[qh++];
      const li = l % W;
      const lj = (l - li) / W;
      if (li > 0 && !seen[l - 1] && isBg(li - 1, lj)) (seen[l - 1] = 1), (queue[qt++] = l - 1);
      if (li < W - 1 && !seen[l + 1] && isBg(li + 1, lj)) (seen[l + 1] = 1), (queue[qt++] = l + 1);
      if (lj > 0 && !seen[l - W] && isBg(li, lj - 1)) (seen[l - W] = 1), (queue[qt++] = l - W);
      if (lj < Hh - 1 && !seen[l + W] && isBg(li, lj + 1)) (seen[l + W] = 1), (queue[qt++] = l + W);
    }
    let cells = 0;
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        const c = j * G + i;
        if (!mask[c] && !seen[(j - y0 + 1) * W + (i - x0 + 1)]) mask[c] = 1;
        if (mask[c]) cells++;
      }
    return { mask, x0, y0, x1, y1, cells, events, beyond };
  }

  /** Gate polygon (display units) around a region: traced, smoothed, simplified, dilated by half a bin. */
  outline(reg: Region2D, loc: Located2D, maxVertices = MAX_VERTICES): [number, number][] {
    const G = this.G;
    let pts = traceMask(reg.mask, G, reg.x0, reg.y0, reg.x1, reg.y1);
    pts = smoothClosed(pts);
    let keep = simplifyClosed(pts, 0.5);
    for (let eps = 0.5; keep.length / 2 > maxVertices; ) {
      eps *= 1.3;
      keep = simplifyClosed(pts, eps);
    }
    let poly = offsetClosed(keep, 0.5);
    if (loc.rect) poly = clipRect(poly, loc.rect);
    const out: [number, number][] = [];
    for (let k = 0; k < poly.length; k += 2) out.push([poly[k] / G, poly[k + 1] / G]);
    return out;
  }
}

/** Convenience: locate, threshold and outline. */
export function autoGate2D(map: DensityMap2D, seed: Seed2D, alpha: number): { polygon: [number, number][]; region: Region2D; located: Located2D } | null {
  const located = map.locate(seed);
  if (!located) return null;
  const region = map.region(located, alpha);
  if (!region) return null;
  return { polygon: map.outline(region, located), region, located };
}

// ------------------------------------------------------------------ contour helpers (grid units: cell i spans [i, i+1])

// marching-squares segments per case, oriented with the inside on the left: [from, to] edges (0 B, 1 R, 2 T, 3 L)
const MS: number[][] = [[], [0, 3], [1, 0], [1, 3], [2, 1], [0, 3, 2, 1], [2, 0], [2, 3], [3, 2], [0, 2], [1, 0, 3, 2], [1, 2], [3, 1], [0, 1], [3, 0], []];

/** Outer boundary of a hole-free 4-connected mask (marching squares on cell centers), counter-clockwise. */
export function traceMask(mask: Uint8Array, G: number, x0: number, y0: number, x1: number, y1: number): number[] {
  const P = G + 2;
  const next = new Int32Array(2 * P * P).fill(-1);
  const M = (i: number, j: number) => (i < 0 || j < 0 || i >= G || j >= G ? 0 : mask[j * G + i]);
  // edge ids: kind 0 between cells (a,b),(a+1,b); kind 1 between (a,b),(a,b+1)
  const hId = (a: number, b: number) => 2 * ((b + 1) * P + (a + 1));
  const vId = (a: number, b: number) => 2 * ((b + 1) * P + (a + 1)) + 1;
  let start = -1;
  for (let j = y0 - 1; j <= y1; j++)
    for (let i = x0 - 1; i <= x1; i++) {
      const c = M(i, j) | (M(i + 1, j) << 1) | (M(i + 1, j + 1) << 2) | (M(i, j + 1) << 3);
      const segs = MS[c];
      if (!segs.length) continue;
      const ids = [hId(i, j), vId(i + 1, j), hId(i, j + 1), vId(i, j)];
      for (let s = 0; s < segs.length; s += 2) {
        next[ids[segs[s]]] = ids[segs[s + 1]];
        if (start < 0) start = ids[segs[s]];
      }
    }
  const pts: number[] = [];
  if (start < 0) return pts;
  let e = start;
  for (let guard = 0; guard < next.length; guard++) {
    const kind = e & 1;
    const cell = e >> 1;
    const a = (cell % P) - 1;
    const b = Math.floor(cell / P) - 1;
    if (kind === 0) pts.push(a + 1, b + 0.5);
    else pts.push(a + 0.5, b + 1);
    e = next[e];
    if (e === start || e < 0) break;
  }
  return pts;
}

function smoothClosed(p: number[]): number[] {
  const n = p.length / 2;
  if (n < 4) return p;
  const out = new Array<number>(p.length);
  for (let k = 0; k < n; k++) {
    const a = (k + n - 1) % n;
    const b = (k + 1) % n;
    out[2 * k] = (p[2 * a] + 2 * p[2 * k] + p[2 * b]) / 4;
    out[2 * k + 1] = (p[2 * a + 1] + 2 * p[2 * k + 1] + p[2 * b + 1]) / 4;
  }
  return out;
}

/** Douglas-Peucker on a closed polyline; returns the kept points (at least 3 when the input has 3). */
export function simplifyClosed(p: number[], eps: number): number[] {
  const n = p.length / 2;
  if (n <= 3) return p.slice();
  // anchors: point 0 and the point farthest from it
  let far = 0;
  let fd = -1;
  for (let k = 1; k < n; k++) {
    const d = (p[2 * k] - p[0]) ** 2 + (p[2 * k + 1] - p[1]) ** 2;
    if (d > fd) {
      fd = d;
      far = k;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ];
  const X = (k: number) => p[2 * (k % n)];
  const Y = (k: number) => p[2 * (k % n) + 1];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = X(a),
      ay = Y(a),
      bx = X(b),
      by = Y(b);
    const dx = bx - ax,
      dy = by - ay;
    const L = Math.hypot(dx, dy);
    let best = -1;
    let bd = -1;
    for (let k = a + 1; k < b; k++) {
      const d = L > 0 ? Math.abs((X(k) - ax) * dy - (Y(k) - ay) * dx) / L : Math.hypot(X(k) - ax, Y(k) - ay);
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (bd > eps) {
      keep[best % n] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(p[2 * k], p[2 * k + 1]);
  if (out.length < 6) {
    // a sliver: keep a third point (the farthest from the anchor chord)
    const third = Math.floor(far / 2) || 1;
    return [p[0], p[1], p[2 * third], p[2 * third + 1], p[2 * far], p[2 * far + 1]];
  }
  return out;
}

/** Offset a counter-clockwise polygon outwards by d (miter joins, limited). */
export function offsetClosed(p: number[], d: number): number[] {
  const n = p.length / 2;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const b = (k + 1) % n;
    const ex = p[2 * b] - p[2 * k];
    const ey = p[2 * b + 1] - p[2 * k + 1];
    const L = Math.hypot(ex, ey) || 1;
    // right-hand normal points outwards for a counter-clockwise polygon
    nx[k] = ey / L;
    ny[k] = -ex / L;
  }
  const out = new Array<number>(p.length);
  for (let k = 0; k < n; k++) {
    const a = (k + n - 1) % n;
    const mx = nx[a] + nx[k];
    const my = ny[a] + ny[k];
    const den = Math.max(0.32, 1 + nx[a] * nx[k] + ny[a] * ny[k]);
    out[2 * k] = p[2 * k] + (d * mx) / den;
    out[2 * k + 1] = p[2 * k + 1] + (d * my) / den;
  }
  return out;
}

/** Sutherland-Hodgman clip of a polygon to [x0,x1] x [y0,y1] (infinite sides do not clip). */
export function clipRect(p: number[], r: [number, number, number, number]): number[] {
  const [x0, y0, x1, y1] = r;
  let poly = p;
  const clip = (inside: (x: number, y: number) => boolean, cut: (ax: number, ay: number, bx: number, by: number) => [number, number]) => {
    const n = poly.length / 2;
    if (!n) return;
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k + n - 1) % n;
      const ax = poly[2 * a],
        ay = poly[2 * a + 1],
        bx = poly[2 * k],
        by = poly[2 * k + 1];
      const ia = inside(ax, ay),
        ib = inside(bx, by);
      if (ib) {
        if (!ia) out.push(...cut(ax, ay, bx, by));
        out.push(bx, by);
      } else if (ia) out.push(...cut(ax, ay, bx, by));
    }
    poly = out;
  };
  const atX = (x: number) => (ax: number, ay: number, bx: number, by: number): [number, number] => [x, ay + ((x - ax) * (by - ay)) / (bx - ax)];
  const atY = (y: number) => (ax: number, ay: number, bx: number, by: number): [number, number] => [ax + ((y - ay) * (bx - ax)) / (by - ay), y];
  if (Number.isFinite(x0)) clip((x) => x >= x0, atX(x0));
  if (Number.isFinite(x1)) clip((x) => x <= x1, atX(x1));
  if (Number.isFinite(y0)) clip((_, y) => y >= y0, atY(y0));
  if (Number.isFinite(y1)) clip((_, y) => y <= y1, atY(y1));
  return poly;
}

// ------------------------------------------------------------------ 1D

export type Seed1D = { u: number } | { range: [number, number] };

export interface Located1D {
  root: number;
  start: number;
  peakRef: number;
}

/** 1D histogram as the plot shows it (events outside the axis are not shown). */
export function histogram1D(d: Float32Array, idx: Uint32Array, B: number): Float32Array {
  const H = new Float32Array(B);
  for (let i = 0; i < idx.length; i++) {
    const u = d[idx[i]];
    let b = Math.floor(u * B);
    if (b !== b || b < 0) continue;
    if (b >= B) {
      if (u > 1) continue;
      b = B - 1;
    }
    H[b]++;
  }
  return H;
}

export class DensityMap1D {
  readonly S: Float32Array;
  readonly comp: Int32Array;
  readonly peak: Float32Array;
  readonly peakCell: Int32Array;
  readonly sigma: number;
  readonly total: number;
  readonly noiseK: number;

  constructor(
    readonly H: Float32Array,
    sigma?: number,
  ) {
    const B = H.length;
    let total = 0;
    for (let i = 0; i < B; i++) total += H[i];
    this.total = total;
    this.sigma = sigma ?? defaultSigma1D(total) * B;
    this.S = blurDensity(H, B, 1, this.sigma);
    // variance of a Gaussian-smoothed Poisson count in 1D: lambda / (2 sqrt(pi) sigma)
    this.noiseK = NOISE_Z / Math.sqrt(2 * Math.sqrt(Math.PI) * this.sigma);
    const seg = segment(this.S, B, 1, this.noiseK);
    this.comp = seg.comp;
    this.peak = seg.peak;
    this.peakCell = seg.peakCell;
  }

  static fromEvents(d: Float32Array, idx: Uint32Array, opts: { bins?: number; sigma?: number } = {}): DensityMap1D {
    return new DensityMap1D(histogram1D(d, idx, opts.bins ?? 256), opts.sigma);
  }

  get B() {
    return this.H.length;
  }

  significant(p: number): boolean {
    return p > this.noiseK * this.noiseK;
  }

  /** The basin under a click (or the nearest within ~3 % of the axis), or the highest peak in a dragged range. */
  locate(seed: Seed1D): Located1D | null {
    const { S, comp, peak, peakCell } = this;
    const B = this.B;
    const bin = (u: number) => Math.min(B - 1, Math.max(0, Math.floor(u * B)));
    if ('range' in seed) {
      const a = bin(Math.min(seed.range[0], seed.range[1]));
      const b = bin(Math.max(seed.range[0], seed.range[1]));
      let best = -1;
      let bs = 0;
      for (let i = a; i <= b; i++)
        if (comp[i] >= 0 && S[i] > bs) {
          bs = S[i];
          best = i;
        }
      if (best < 0 || !this.significant(bs) || !this.significant(peak[comp[best]])) return null;
      const root = comp[best];
      return { root, start: peakCell[root], peakRef: peak[root] };
    }
    const c = bin(seed.u);
    const R = Math.max(2, Math.round(0.03 * B));
    for (let r = 0; r <= R; r++) {
      let best = -1;
      let bs = 0;
      for (const i of r ? [c - r, c + r] : [c]) {
        if (i < 0 || i >= B) continue;
        const root = comp[i];
        if (root < 0 || !this.significant(peak[root]) || S[i] < ALPHA_LOOSEST * peak[root]) continue;
        if (S[i] > bs) {
          bs = S[i];
          best = i;
        }
      }
      if (best >= 0) {
        const root = comp[best];
        return { root, start: peakCell[root], peakRef: peak[root] };
      }
    }
    return null;
  }

  /**
   * Range (display units) of the seed basin above alpha x peak. Each side ends
   *  - at a valley (the next bin belongs to another population): exactly on the bin edge there, so the ranges of two
   *    neighbouring populations share one cut instead of overlapping;
   *  - at the axis end: lo < 0 / hi > 1 (an open bound);
   *  - where the density falls below the threshold: half a bin further out. When there is no other population on that
   *    side but there is one on the other side (a negative / positive population), the side stays open instead.
   */
  range(loc: Located1D, alpha: number): { lo: number; hi: number; i0: number; i1: number; events: number } {
    const { S, comp, H } = this;
    const B = this.B;
    const thr = alpha * loc.peakRef;
    const ok = (i: number) => comp[i] === loc.root && S[i] >= thr;
    let i0 = loc.start;
    let i1 = loc.start;
    while (i0 > 0 && ok(i0 - 1)) i0--;
    while (i1 < B - 1 && ok(i1 + 1)) i1++;
    let events = 0;
    for (let i = i0; i <= i1; i++) events += H[i];
    // another (significant) population below / above the range
    const other = (a: number, b: number) => {
      for (let i = a; i < b; i++) if (comp[i] !== loc.root && this.significant(this.peak[comp[i]])) return true;
      return false;
    };
    const below = other(0, i0);
    const above = other(i1 + 1, B);
    let lo: number;
    if (i0 === 0) lo = -0.5 / B;
    else if (comp[i0 - 1] !== loc.root) lo = i0 / B;
    else if (!below && above) lo = -1 / B;
    else lo = (i0 - 0.5) / B;
    let hi: number;
    if (i1 === B - 1) hi = (B + 0.5) / B;
    else if (comp[i1 + 1] !== loc.root) hi = (i1 + 1) / B;
    else if (!above && below) hi = (B + 1) / B;
    else hi = (i1 + 1.5) / B;
    return { lo, hi, i0, i1, events };
  }
}

export function autoGate1D(map: DensityMap1D, seed: Seed1D, alpha: number) {
  const located = map.locate(seed);
  if (!located) return null;
  return { ...map.range(located, alpha), located };
}

// ------------------------------------------------------------------ exact counts

/**
 * Events assigned to the cells of a G x G grid over the gate evaluation space (display units of the gating scales,
 * events clamped onto 0..1 like app-drawn gates). Counting the events inside a polygon classifies the cells first:
 * only events in cells the polygon's edges pass through are tested. Same result as evaluating the polygon gate.
 */
export class EventGrid {
  /** frame cell of each event of idx (-1: not a number) */
  readonly cell: Int32Array;

  /**
   * ext: also fill the extended density histogram (see histogram2D, margin M) in the same pass, when the plot shows
   * exactly these coordinates (no zoom window, gating scales = plot scales).
   */
  constructor(
    readonly xs: Float32Array,
    readonly ys: Float32Array,
    readonly idx: Uint32Array,
    readonly G = 256,
    ext?: { M: number; H: Float32Array },
  ) {
    const cell = new Int32Array(idx.length);
    const M = ext?.M ?? 0;
    const GE = G + 2 * M;
    const EH = ext?.H;
    const extBin = (u: number) => {
      if (u === 0) return M >> 1;
      if (u === 1) return M + G + (M >> 1);
      const b = Math.floor(u * G) + M;
      return b < 0 ? 0 : b >= GE ? GE - 1 : b;
    };
    for (let i = 0; i < idx.length; i++) {
      const e = idx[i];
      const x = xs[e];
      const y = ys[e];
      if (x !== x || y !== y) {
        cell[i] = -1;
        continue;
      }
      // clamped onto the frame like app-drawn gates
      const inX = x > 0 && x < 1;
      const inY = y > 0 && y < 1;
      const bx = inX ? (x * G) | 0 : x > 0 ? G - 1 : 0;
      const by = inY ? (y * G) | 0 : y > 0 ? G - 1 : 0;
      cell[i] = by * G + bx;
      if (EH) EH[(inY ? by + M : extBin(y)) * GE + (inX ? bx + M : extBin(x))]++;
    }
    this.cell = cell;
  }

  /** Events inside the polygon (evaluation-space display units), as a polygon gate counts them. */
  count(px: Float64Array, py: Float64Array): number {
    const n = px.length;
    if (n < 3) return 0;
    const G = this.G;
    const EPS = 1e-7;
    const X = new Float64Array(n);
    const Y = new Float64Array(n);
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (let k = 0; k < n; k++) {
      X[k] = px[k] * G;
      Y[k] = py[k] * G;
      if (!(Number.isFinite(X[k]) && Number.isFinite(Y[k]))) return 0;
      minX = Math.min(minX, X[k]);
      maxX = Math.max(maxX, X[k]);
      minY = Math.min(minY, Y[k]);
      maxY = Math.max(maxY, Y[k]);
    }
    if (maxX < 0 || maxY < 0 || minX > G || minY > G) return 0;
    const cl = (v: number) => (v < 0 ? 0 : v > G - 1 ? G - 1 : v);
    const ix0 = cl(Math.floor(minX - EPS));
    const ix1 = cl(Math.floor(maxX + EPS));
    const iy0 = cl(Math.floor(minY - EPS));
    const iy1 = cl(Math.floor(maxY + EPS));
    // cell status: 0 outside, 1 inside, 2 an edge passes through (conservatively): its events are tested one by one
    const status = new Uint8Array(G * G);
    for (let k = 0; k < n; k++) {
      const b = (k + 1) % n;
      const xa = X[k],
        ya = Y[k],
        xb = X[b],
        yb = Y[b];
      const r0 = Math.max(iy0, Math.floor(Math.min(ya, yb) - EPS));
      const r1 = Math.min(iy1, Math.floor(Math.max(ya, yb) + EPS));
      for (let r = r0; r <= r1; r++) {
        let xl: number, xr: number;
        if (ya === yb) {
          xl = Math.min(xa, xb);
          xr = Math.max(xa, xb);
        } else {
          let t0 = (r - EPS - ya) / (yb - ya);
          let t1 = (r + 1 + EPS - ya) / (yb - ya);
          if (t0 > t1) [t0, t1] = [t1, t0];
          t0 = Math.max(0, t0);
          t1 = Math.min(1, t1);
          if (t0 > t1) continue;
          const xA = xa + (xb - xa) * t0;
          const xB = xa + (xb - xa) * t1;
          xl = Math.min(xA, xB);
          xr = Math.max(xA, xB);
        }
        const c0 = Math.max(ix0, Math.floor(xl - EPS));
        const c1 = Math.min(ix1, Math.floor(xr + EPS));
        for (let c = c0; c <= c1; c++) status[r * G + c] = 2;
      }
    }
    // other cells: inside / outside from the crossings of the row's center line
    const cross = new Float64Array(n);
    for (let r = iy0; r <= iy1; r++) {
      const yc = r + 0.5;
      let m = 0;
      for (let k = 0; k < n; k++) {
        const b = (k + 1) % n;
        if (Y[k] > yc !== Y[b] > yc) cross[m++] = X[k] + ((yc - Y[k]) * (X[b] - X[k])) / (Y[b] - Y[k]);
      }
      for (let i = 1; i < m; i++) {
        const v = cross[i];
        let j = i - 1;
        while (j >= 0 && cross[j] > v) {
          cross[j + 1] = cross[j];
          j--;
        }
        cross[j + 1] = v;
      }
      let p = 0;
      for (let c = ix0; c <= ix1; c++) {
        const xc = c + 0.5;
        while (p < m && cross[p] < xc) p++;
        const q = r * G + c;
        if (status[q] !== 2 && p & 1) status[q] = 1;
      }
    }
    const { xs, ys, idx, cell } = this;
    let total = 0;
    for (let i = 0; i < cell.length; i++) {
      const c = cell[i];
      if (c < 0) continue;
      const st = status[c];
      if (st === 1) total++;
      else if (st === 2) {
        const e = idx[i];
        if (pointInPolygon(clamp01(xs[e]), clamp01(ys[e]), px, py)) total++;
      }
    }
    return total;
  }
}

/** Events of a population inside a polygon by direct test (reference for EventGrid.count). */
export function countPolygonDirect(xs: Float32Array, ys: Float32Array, idx: Uint32Array, px: Float64Array, py: Float64Array): number {
  let n = 0;
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    const x = xs[e];
    const y = ys[e];
    if (x !== x || y !== y) continue;
    if (pointInPolygon(clamp01(x), clamp01(y), px, py)) n++;
  }
  return n;
}

let warmed = false;

/**
 * Run the whole pipeline once on a small synthetic data set so the JIT has optimized it before the first real click
 * (a cold first run on a large sample is several times slower). Idempotent.
 */
export function warmUpAutoGate(): void {
  if (warmed) return;
  warmed = true;
  let a = 12345;
  const rnd = () => ((a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const n = 40000;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i % 3;
    xs[i] = (k === 0 ? 0.3 : k === 1 ? 0.7 : 0.02) + 0.05 * gauss();
    ys[i] = (k === 2 ? 0.5 : 0.35 + 0.3 * k) + 0.05 * gauss();
    idx[i] = i;
  }
  const M = 32;
  const H = new Float32Array((256 + 2 * M) ** 2);
  const grid = new EventGrid(xs, ys, idx, 256, { M, H });
  const map = new DensityMap2D(H, 256, M);
  for (const seed of [{ u: 0.3, v: 0.35 }, { rect: [0.5, 0.4, 0.9, 0.9] as [number, number, number, number] }, { u: 0.02, v: 0.5 }]) {
    const r = autoGate2D(map, seed, SENSITIVITY.normal);
    if (r) grid.count(new Float64Array(r.polygon.map((p) => p[0])), new Float64Array(r.polygon.map((p) => p[1])));
  }
  autoGate1D(DensityMap1D.fromEvents(xs, idx), { u: 0.3 }, SENSITIVITY.normal);
}
