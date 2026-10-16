// 2D/1D binning, Gaussian smoothing and contour extraction (marching squares).
import { sortFloat32 } from '../core/sort';

export function hist2d(dx: Float32Array, dy: Float32Array, idx: Uint32Array, gx: number, gy: number): Float32Array {
  const h = new Float32Array(gx * gy);
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    const bx = Math.floor(dx[e] * gx);
    const by = Math.floor(dy[e] * gy);
    if (bx < 0 || by < 0 || bx >= gx || by >= gy) continue;
    h[by * gx + bx]++;
  }
  return h;
}

function kernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

export function blur2d(src: Float32Array, gx: number, gy: number, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice();
  const k = kernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(gx * gy);
  const out = new Float32Array(gx * gy);
  for (let y = 0; y < gy; y++) {
    const row = y * gx;
    for (let x = 0; x < gx; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= gx) continue;
        s += src[row + xx] * k[i + r];
      }
      tmp[row + x] = s;
    }
  }
  for (let x = 0; x < gx; x++) {
    for (let y = 0; y < gy; y++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy < 0 || yy >= gy) continue;
        s += tmp[yy * gx + x] * k[i + r];
      }
      out[y * gx + x] = s;
    }
  }
  return out;
}

export function blur1d(src: Float32Array, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice();
  const k = kernel(sigma);
  const r = (k.length - 1) / 2;
  const out = new Float32Array(src.length);
  for (let x = 0; x < src.length; x++) {
    let s = 0;
    let w = 0;
    for (let i = -r; i <= r; i++) {
      const xx = x + i;
      if (xx < 0 || xx >= src.length) continue;
      s += src[xx] * k[i + r];
      w += k[i + r];
    }
    out[x] = w > 0 ? s / w : 0;
  }
  return out;
}

export function hist1d(d: Float32Array, idx: Uint32Array, bins: number): Float32Array {
  const h = new Float32Array(bins);
  for (let i = 0; i < idx.length; i++) {
    const b = Math.floor(d[idx[i]] * bins);
    if (b >= 0 && b < bins) h[b]++;
    else if (b === bins && d[idx[i]] <= 1) h[bins - 1]++;
  }
  return h;
}

/**
 * Probability-contour thresholds: returns density thresholds t_k such that the region where density >= t_k
 * contains approximately fractions[k] of all events.
 */
export function probabilityThresholds(dens: Float32Array, fractions: number[]): number[] {
  const vals = sortFloat32(Float32Array.from(dens)).reverse(); // radix sort: same order as .sort()
  let total = 0;
  for (let i = 0; i < vals.length; i++) total += vals[i];
  if (total <= 0) return fractions.map(() => Infinity);
  const out: number[] = [];
  for (const f of fractions) {
    let cum = 0;
    let t = vals[vals.length - 1];
    for (let i = 0; i < vals.length; i++) {
      cum += vals[i];
      if (cum >= f * total) {
        t = vals[i];
        break;
      }
    }
    out.push(t);
  }
  return out;
}

/**
 * Marching squares on a grid (values at cell centers). Returns polylines in grid coordinates (x in [0,gx), y in [0,gy)),
 * where grid point (i,j) sits at (i+0.5, j+0.5).
 */
export function contourLines(z: Float32Array, gx: number, gy: number, level: number): number[][] {
  const segs: number[] = [];
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= gx || j >= gy ? 0 : z[j * gx + i]);
  for (let j = -1; j < gy; j++) {
    for (let i = -1; i < gx; i++) {
      const v0 = at(i, j); // bottom-left (in grid y up)
      const v1 = at(i + 1, j);
      const v2 = at(i + 1, j + 1);
      const v3 = at(i, j + 1);
      let c = 0;
      if (v0 >= level) c |= 1;
      if (v1 >= level) c |= 2;
      if (v2 >= level) c |= 4;
      if (v3 >= level) c |= 8;
      if (c === 0 || c === 15) continue;
      const x0 = i + 0.5;
      const y0 = j + 0.5;
      const lerp = (a: number, b: number) => (a === b ? 0.5 : (level - a) / (b - a));
      const eB = () => [x0 + lerp(v0, v1), y0];
      const eR = () => [x0 + 1, y0 + lerp(v1, v2)];
      const eT = () => [x0 + lerp(v3, v2), y0 + 1];
      const eL = () => [x0, y0 + lerp(v0, v3)];
      const push = (a: number[], b: number[]) => segs.push(a[0], a[1], b[0], b[1]);
      switch (c) {
        case 1:
        case 14:
          push(eL(), eB());
          break;
        case 2:
        case 13:
          push(eB(), eR());
          break;
        case 3:
        case 12:
          push(eL(), eR());
          break;
        case 4:
        case 11:
          push(eR(), eT());
          break;
        case 6:
        case 9:
          push(eB(), eT());
          break;
        case 7:
        case 8:
          push(eL(), eT());
          break;
        case 5:
        case 10: {
          const center = (v0 + v1 + v2 + v3) / 4;
          if ((c === 5) === center >= level) {
            push(eL(), eT());
            push(eB(), eR());
          } else {
            push(eL(), eB());
            push(eR(), eT());
          }
          break;
        }
      }
    }
  }
  return joinSegments(segs);
}

/**
 * End point key of joinSegments: (round(x * 1000), round(y * 1000)) packed into one number (grid coordinates are small,
 * so the packing is exact and keys are equal exactly when the rounded pairs are); a string beyond that range.
 */
function endKey(x: number, y: number): number | string {
  const a = Math.round(x * 1000);
  const b = Math.round(y * 1000);
  if (a > -524288 && a < 524288 && b > -524288 && b < 524288) return (a + 524288) * 1048576 + (b + 524288);
  return `${a},${b}`;
}

function joinSegments(segs: number[]): number[][] {
  const key = endKey;
  const nSeg = segs.length / 4;
  const used = new Uint8Array(nSeg);
  const ends = new Map<number | string, number[]>();
  for (let s = 0; s < nSeg; s++) {
    for (const k of [key(segs[s * 4], segs[s * 4 + 1]), key(segs[s * 4 + 2], segs[s * 4 + 3])]) {
      let a = ends.get(k);
      if (!a) {
        a = [];
        ends.set(k, a);
      }
      a.push(s);
    }
  }
  const lines: number[][] = [];
  for (let s = 0; s < nSeg; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const line = [segs[s * 4], segs[s * 4 + 1], segs[s * 4 + 2], segs[s * 4 + 3]];
    // extend forward
    for (let dir = 0; dir < 2; dir++) {
      let guard = 0;
      while (guard++ < 100000) {
        const lx = dir === 0 ? line[line.length - 2] : line[0];
        const ly = dir === 0 ? line[line.length - 1] : line[1];
        const lk = key(lx, ly);
        const cand = ends.get(lk);
        const next = cand?.find((t) => !used[t]);
        if (next === undefined) break;
        used[next] = 1;
        const ax = segs[next * 4],
          ay = segs[next * 4 + 1],
          bx = segs[next * 4 + 2],
          by = segs[next * 4 + 3];
        const matchA = key(ax, ay) === lk;
        const nx = matchA ? bx : ax;
        const ny = matchA ? by : ay;
        if (dir === 0) line.push(nx, ny);
        else line.unshift(nx, ny);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** 2D histogram in which events displayed beyond the axis ends count in the edge bins (they are drawn there), except on zoomed axes. */
export function hist2dEdge(dx: Float32Array, dy: Float32Array, idx: Uint32Array, gx: number, gy: number, dropX: boolean, dropY: boolean): Float32Array {
  const h = new Float32Array(gx * gy);
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    const u = dx[e];
    const v = dy[e];
    if (!(u === u) || !(v === v)) continue;
    if ((dropX && (u < 0 || u > 1)) || (dropY && (v < 0 || v > 1))) continue;
    const bx = u <= 0 ? 0 : u >= 1 ? gx - 1 : Math.min(gx - 1, Math.floor(u * gx));
    const by = v <= 0 ? 0 : v >= 1 ? gy - 1 : Math.min(gy - 1, Math.floor(v * gy));
    h[by * gx + bx]++;
  }
  return h;
}

/** Bilinear interpolation of a grid with values at cell centers; (u, v) in display units [0, 1]. */
export function sampleGrid(z: Float32Array, gx: number, gy: number, u: number, v: number): number {
  let x = u * gx - 0.5;
  let y = v * gy - 0.5;
  x = x < 0 ? 0 : x > gx - 1 ? gx - 1 : x;
  y = y < 0 ? 0 : y > gy - 1 ? gy - 1 : y;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < gx ? x0 + 1 : x0;
  const y1 = y0 + 1 < gy ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const a = z[y0 * gx + x0] + (z[y0 * gx + x1] - z[y0 * gx + x0]) * fx;
  const b = z[y1 * gx + x0] + (z[y1 * gx + x1] - z[y1 * gx + x0]) * fx;
  return a + (b - a) * fy;
}

/** Density thresholds spaced logarithmically from `lo` (e.g. the peak of a single event's kernel) to the maximum (n levels). */
export function logThresholds(dens: Float32Array, n: number, lo: number): number[] {
  let mx = 0;
  for (let i = 0; i < dens.length; i++) if (dens[i] > mx) mx = dens[i];
  if (!(mx > 0) || n < 1) return [];
  const a = Math.min(lo, mx * 0.5);
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(a * Math.pow(mx / a, k / n));
  return out;
}

/**
 * Equalized (rank) value of every bin: the fraction of events sitting in bins of lower value, plus half of the bin's own
 * events (`weights` = events per bin). Bins without events get 0.
 */
export function rankBins(vals: Float32Array, weights: Float32Array): Float32Array {
  const ids: number[] = [];
  let total = 0;
  for (let i = 0; i < vals.length; i++)
    if (weights[i] > 0) {
      ids.push(i);
      total += weights[i];
    }
  ids.sort((a, b) => vals[a] - vals[b]);
  const out = new Float32Array(vals.length);
  let cum = 0;
  for (let j = 0; j < ids.length; ) {
    // ties share one rank
    let k = j;
    let w = 0;
    while (k < ids.length && vals[ids[k]] === vals[ids[j]]) w += weights[ids[k++]];
    const r = total > 0 ? (cum + w / 2) / total : 0;
    for (let m = j; m < k; m++) out[ids[m]] = r;
    cum += w;
    j = k;
  }
  return out;
}

/** Per-bin median or mean of `w` (display values of a third parameter); NaN where a bin has no events. */
export function binStat(dx: Float32Array, dy: Float32Array, w: Float32Array, idx: Uint32Array, gx: number, gy: number, stat: 'median' | 'mean', dropX: boolean, dropY: boolean): Float32Array {
  const n = gx * gy;
  const bin = new Int32Array(idx.length);
  const cnt = new Uint32Array(n + 1);
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    const u = dx[e];
    const v = dy[e];
    if (!(u === u) || !(v === v) || !(w[e] === w[e]) || (dropX && (u < 0 || u > 1)) || (dropY && (v < 0 || v > 1))) {
      bin[i] = -1;
      continue;
    }
    const bx = u <= 0 ? 0 : u >= 1 ? gx - 1 : Math.min(gx - 1, Math.floor(u * gx));
    const by = v <= 0 ? 0 : v >= 1 ? gy - 1 : Math.min(gy - 1, Math.floor(v * gy));
    bin[i] = by * gx + bx;
    cnt[bin[i] + 1]++;
  }
  const out = new Float32Array(n).fill(NaN);
  if (stat === 'mean') {
    const sum = new Float64Array(n);
    for (let i = 0; i < idx.length; i++) if (bin[i] >= 0) sum[bin[i]] += w[idx[i]];
    for (let b = 0; b < n; b++) if (cnt[b + 1]) out[b] = sum[b] / cnt[b + 1];
    return out;
  }
  // counting sort of the values by bin, then the median of every bin's run
  for (let b = 0; b < n; b++) cnt[b + 1] += cnt[b];
  const pos = cnt.slice(0, n);
  const vals = new Float32Array(cnt[n]);
  for (let i = 0; i < idx.length; i++) if (bin[i] >= 0) vals[pos[bin[i]]++] = w[idx[i]];
  for (let b = 0; b < n; b++) {
    const a = cnt[b];
    const z = cnt[b + 1];
    if (z === a) continue;
    const run = vals.subarray(a, z).sort();
    const m = run.length >> 1;
    out[b] = run.length & 1 ? run[m] : (run[m - 1] + run[m]) / 2;
  }
  return out;
}
