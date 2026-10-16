// Spillover / compensation math.
// Spillover matrix S: rows = fluorochrome (primary detector), cols = detectors. observed = true * S
// Compensated = observed * S^-1

export function invertMatrix(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((r) => r.slice());
  const inv = m.map((_, i) => m.map((__, j) => (i === j ? 1 : 0)));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-14) throw new Error('Spillover matrix is singular');
    if (piv !== col) {
      [a[piv], a[col]] = [a[col], a[piv]];
      [inv[piv], inv[col]] = [inv[col], inv[piv]];
    }
    const d = a[col][col];
    for (let j = 0; j < n; j++) {
      a[col][j] /= d;
      inv[col][j] /= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) {
        a[r][j] -= f * a[col][j];
        inv[r][j] -= f * inv[col][j];
      }
    }
  }
  return inv;
}

/**
 * Apply compensation in place to copies of the matrix channels.
 * data: all channels of the sample; idx: indices (into data) of the matrix channels, in matrix order.
 * Returns a new array of channels where matrix channels are compensated (others shared).
 */
export function compensate(data: Float32Array[], idx: number[], spill: number[][]): Float32Array[] {
  const n = idx.length;
  const inv = invertMatrix(spill);
  const out = data.slice();
  if (!n) return out;
  const nEv = data[idx[0]].length;
  const src = idx.map((i) => data[i]);
  const dst = idx.map(() => new Float32Array(nEv));
  const row = new Float64Array(n);
  const invFlat = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) invFlat[i * n + j] = inv[i][j];
  for (let e = 0; e < nEv; e++) {
    for (let i = 0; i < n; i++) row[i] = src[i][e];
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += row[i] * invFlat[i * n + j];
      dst[j][e] = s;
    }
  }
  idx.forEach((ci, k) => (out[ci] = dst[k]));
  return out;
}

export function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)));
}

/**
 * Compute a spillover matrix from single-stained controls.
 * For each control k (assigned to channel k): spill[k][j] = (medPos_j - medNeg_j) / (medPos_k - medNeg_k)
 * pos/neg: per control, arrays of (uncompensated) channel values for the positive and negative events.
 */
export function spilloverFromControls(
  controls: { pos: Float32Array[]; neg: Float32Array[] }[], // controls[k].pos[j] = values of detector j in positive events
): number[][] {
  const n = controls.length;
  const S = identity(n);
  for (let k = 0; k < n; k++) {
    const c = controls[k];
    const medPos = c.pos.map(median);
    const medNeg = c.neg.map(median);
    const denom = medPos[k] - medNeg[k];
    for (let j = 0; j < n; j++) {
      if (j === k) continue;
      const v = denom !== 0 ? (medPos[j] - medNeg[j]) / denom : 0;
      S[k][j] = Number.isFinite(v) ? Math.max(0, v) : 0;
    }
  }
  return S;
}

export function median(a: Float32Array): number {
  if (!a.length) return NaN;
  const s = Float32Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
