// Performance rewrites must give bit-identical results: each optimized routine is compared with the reference
// implementation it replaced (copied here verbatim).
import { describe, expect, it } from 'vitest';
import { flowJoBiexDef, flowJoBiexTable, Logicle, makeScale, type ScaleDef } from '../src/core/transforms';

/** the original logicle fast forward: binary search over the whole table */
function refFastForward(inv: (u: number) => number, uMin: number, uMax: number, n: number, exact: (v: number) => number) {
  const us = new Float64Array(n);
  const vs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = uMin + ((uMax - uMin) * i) / (n - 1);
    us[i] = u;
    vs[i] = inv(u);
  }
  const vLo = vs[0];
  const vHi = vs[n - 1];
  return (v: number): number => {
    if (!(v > vLo && v < vHi)) return exact(v);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (vs[mid] <= v) lo = mid;
      else hi = mid;
    }
    const t = (v - vs[lo]) / (vs[hi] - vs[lo]);
    return us[lo] + t * (us[hi] - us[lo]);
  };
}

/** the original FlowJo biex forward */
function refBiex(p: { neg: number; width: number; pos: number; max: number }) {
  const R = 4096;
  const xs = flowJoBiexTable(p, R);
  const n = xs.length;
  const x0 = xs[0];
  const x1 = xs[n - 1];
  return (v: number): number => {
    if (v !== v) return NaN;
    if (v <= x0) return 0;
    if (v >= x1) return 1;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= v) lo = mid;
      else hi = mid;
    }
    return (lo + (v - xs[lo]) / (xs[hi] - xs[lo])) / R;
  };
}

function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** values spread over the whole range of a cytometry axis, plus edge cases */
export function testValues(n: number, seed = 1, T = 262144): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.3) out[i] = (r() - 0.5) * 2000; // around zero (linear region)
    else if (k < 0.6) out[i] = Math.pow(10, r() * Math.log10(T * 4)); // log spread
    else if (k < 0.7) out[i] = -Math.pow(10, r() * 5); // negative tail
    else if (k < 0.8) out[i] = (r() - 0.5) * 20; // close to 0
    else out[i] = r() * T;
  }
  const special = [0, -0, 1e-30, -1e-30, 1e-45, NaN, Infinity, -Infinity, T, T * 1.0000001, -T, 3.4e38, -3.4e38, 1, -1, 0.5];
  special.forEach((v, i) => (out[i] = v));
  return out;
}

const sameBits = (a: Float32Array, b: Float32Array) => {
  const ia = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const ib = new Uint32Array(b.buffer, b.byteOffset, b.length);
  let bad = 0;
  for (let i = 0; i < a.length; i++) if (ia[i] !== ib[i] && !(a[i] !== a[i] && b[i] !== b[i])) bad++;
  return bad;
};

describe('exact transforms', () => {
  const logicles: [number, number, number, number][] = [
    [262144, 0.5, 4.5, 0],
    [262144, 0.0, 4.5, 0],
    [262144, 1.2, 4.5, 0.3],
    [16777215, 0.8, 5.75, 0],
    [1000, 0.3, 3, 0],
    [4096, 0.01, 4.5, 0],
  ];
  for (const [T, W, M, A] of logicles)
    it(`logicle T=${T} W=${W} M=${M} A=${A}: fwdArray identical to the binary search`, () => {
      const def: ScaleDef = { type: 'logicle', T, W, M, A };
      const sc = makeScale(def);
      const lg = new Logicle(T, W, M, A);
      const ref = refFastForward((u) => lg.inverse(u), -0.25, 1.25, 1 << 15, (v) => lg.scale(v));
      const vals = testValues(200000, T, T);
      const got = sc.fwdArray(vals);
      const exp = new Float32Array(vals.length);
      for (let i = 0; i < vals.length; i++) exp[i] = ref(vals[i]);
      expect(sameBits(got, exp)).toBe(0);
      // the scalar transform stays the exact logicle
      for (let i = 0; i < 5000; i++) {
        const a = sc.fwd(vals[i]);
        const b = lg.scale(vals[i]);
        if (!(Object.is(a, b) || (a !== a && b !== b))) throw new Error(`fwd(${vals[i]}) = ${a}, expected ${b}`);
      }
      // the table values themselves (exact boundaries of the search)
      const tv = new Float32Array(4096);
      for (let i = 0; i < tv.length; i++) tv[i] = lg.inverse(-0.25 + (1.5 * i) / 4095);
      const g2 = sc.fwdArray(tv);
      const e2 = tv.map((v) => ref(v));
      expect(sameBits(g2, e2)).toBe(0);
    });
  for (const p of [
    { neg: 0, width: -10, pos: 4.42, max: 262144 },
    { neg: 1, width: -100, pos: 4.5, max: 262144 },
    { neg: 0.5, width: -30, pos: 5.2, max: 4194304 },
  ])
    it(`FlowJo biex ${JSON.stringify(p)} identical`, () => {
      const def = flowJoBiexDef(p);
      const sc = makeScale(def);
      const ref = refBiex(p);
      const vals = testValues(100000, 7, p.max);
      const got = sc.fwdArray(vals);
      const exp = vals.map((v) => ref(v));
      expect(sameBits(got, exp)).toBe(0);
      for (let i = 0; i < 2000; i++) expect(Object.is(sc.fwd(vals[i]), ref(vals[i])) || vals[i] !== vals[i]).toBe(true);
    });
});

import { sortFloat32 } from '../src/core/sort';

describe('radix sort', () => {
  it('identical to Float32Array.prototype.sort', () => {
    for (const [n, seed] of [
      [10, 1],
      [3000, 2],
      [100000, 3],
      [262145, 4],
    ]) {
      const v = testValues(n, seed);
      // no NaN for the radix path
      for (let i = 0; i < v.length; i++) if (v[i] !== v[i]) v[i] = -0;
      const a = sortFloat32(v.slice());
      const b = v.slice().sort();
      expect(sameBits(a, b)).toBe(0);
    }
  });
  it('arrays with NaN fall back to the built-in sort', () => {
    const v = testValues(5000, 9);
    v[4000] = NaN;
    const a = sortFloat32(v.slice());
    const b = v.slice().sort();
    expect(sameBits(a, b)).toBe(0);
  });
  it('subarray views', () => {
    const big = testValues(10000, 5).map((x) => (x !== x ? 1 : x));
    const sub = big.subarray(1234, 9000);
    const exp = sub.slice().sort();
    sortFloat32(sub);
    expect(sameBits(sub, exp)).toBe(0);
  });
});

import { applyGate, ellipseFrame, isStrictGate, pointInPolygon, type GateContext } from '../src/core/gating';
import type { GateGeom } from '../src/core/model';

/** the original gate evaluation (closure per event) */
function refApplyGate(g: GateGeom, parent: Uint32Array, ctx: GateContext): Uint32Array {
  const filterIdx = (test: (e: number) => boolean) => {
    const out = new Uint32Array(parent.length);
    let k = 0;
    for (let i = 0; i < parent.length; i++) if (test(parent[i])) out[k++] = parent[i];
    return out.slice(0, k);
  };
  switch (g.type) {
    case 'rect': {
      const xs = ctx.raw(g.x)!;
      const ys = ctx.raw(g.y)!;
      const xmin = g.xmin ?? -Infinity, xmax = g.xmax ?? Infinity, ymin = g.ymin ?? -Infinity, ymax = g.ymax ?? Infinity;
      return filterIdx((e) => xs[e] >= xmin && xs[e] < xmax && ys[e] >= ymin && ys[e] < ymax);
    }
    case 'range': {
      const xs = ctx.raw(g.x)!;
      const min = g.min ?? -Infinity, max = g.max ?? Infinity;
      return filterIdx((e) => xs[e] >= min && xs[e] < max);
    }
    case 'split': {
      const xs = ctx.raw(g.x)!;
      return g.side === 'lo' ? filterIdx((e) => xs[e] < g.cut) : filterIdx((e) => xs[e] >= g.cut);
    }
    case 'quadrant': {
      const xs = ctx.raw(g.x)!;
      const ys = ctx.raw(g.y)!;
      const { cx, cy } = g;
      if (g.quadrant === 'UR') return filterIdx((e) => xs[e] >= cx && ys[e] >= cy);
      if (g.quadrant === 'UL') return filterIdx((e) => xs[e] < cx && ys[e] >= cy);
      if (g.quadrant === 'LL') return filterIdx((e) => xs[e] < cx && ys[e] < cy);
      return filterIdx((e) => xs[e] >= cx && ys[e] < cy);
    }
    case 'polygon': {
      const sx = g.scales?.x ?? ctx.scaleOf(g.x), sy = g.scales?.y ?? ctx.scaleOf(g.y);
      const dx = ctx.display(g.x, sx)!, dy = ctx.display(g.y, sy)!;
      const px = new Float64Array(g.points.map((p) => makeScale(sx).fwd(p[0])));
      const py = new Float64Array(g.points.map((p) => makeScale(sy).fwd(p[1])));
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < px.length; i++) {
        x0 = Math.min(x0, px[i]); x1 = Math.max(x1, px[i]); y0 = Math.min(y0, py[i]); y1 = Math.max(y1, py[i]);
      }
      const clampOff = !isStrictGate(g);
      return filterIdx((e) => {
        let x = dx[e], y = dy[e];
        if (clampOff) {
          x = x < 0 ? 0 : x > 1 ? 1 : x;
          y = y < 0 ? 0 : y > 1 ? 1 : y;
        }
        if (x < x0 || x > x1 || y < y0 || y > y1) return false;
        return pointInPolygon(x, y, px, py);
      });
    }
    case 'ellipse': {
      const sx = g.scales?.x ?? ctx.scaleOf(g.x), sy = g.scales?.y ?? ctx.scaleOf(g.y);
      const dx = ctx.display(g.x, sx)!, dy = ctx.display(g.y, sy)!;
      const X = makeScale(sx), Y = makeScale(sy);
      const fr = ellipseFrame([X.fwd(g.center[0]), Y.fwd(g.center[1])], [X.fwd(g.a[0]), Y.fwd(g.a[1])], [X.fwd(g.b[0]), Y.fwd(g.b[1])])!;
      const { c, i00, i01, i10, i11 } = fr;
      const clampOff = !isStrictGate(g);
      return filterIdx((e) => {
        let x = dx[e], y = dy[e];
        if (clampOff) {
          x = x < 0 ? 0 : x > 1 ? 1 : x;
          y = y < 0 ? 0 : y > 1 ? 1 : y;
        }
        const qx = x - c[0], qy = y - c[1];
        const u = i00 * qx + i01 * qy, v = i10 * qx + i11 * qy;
        return u * u + v * v <= 1;
      });
    }
  }
  throw new Error('not covered');
}

describe('exact gates', () => {
  const N = 300000;
  const r = rng(11);
  // clustered data so that polygon edges cut through dense regions; special values included
  const X = new Float32Array(N);
  const Y = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const c = r() < 0.5;
    X[i] = (c ? 2e4 : 9e4) + (r() + r() + r() - 1.5) * 4e4;
    Y[i] = (c ? 3e4 : 1.2e5) + (r() + r() + r() - 1.5) * 5e4;
  }
  [NaN, Infinity, -Infinity, 0, -0, 262144, -5000].forEach((v, i) => {
    X[i * 7] = v;
    Y[i * 11 + 1] = v;
  });
  const lin: ScaleDef = { type: 'linear', min: 0, max: 262144 };
  const lgc: ScaleDef = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
  const scales: Record<string, ScaleDef> = { X: lin, Y: lgc };
  const ctx: GateContext = {
    raw: (ch) => (ch === 'X' ? X : ch === 'Y' ? Y : null),
    display: (ch, def) => makeScale(def).fwdArray(ch === 'X' ? X : Y),
    scaleOf: (ch) => scales[ch],
    population: () => new Uint32Array(0),
    eventCount: N,
  };
  const all = new Uint32Array(N).map((_, i) => i);
  const half = all.filter((i) => i % 3 !== 1);
  const gates: GateGeom[] = [
    { type: 'rect', x: 'X', y: 'Y', xmin: 1e4, xmax: 8e4, ymin: -1e3, ymax: 9e4 },
    { type: 'range', x: 'X', min: 2e4, max: Infinity },
    { type: 'split', x: 'X', cut: 3e4, side: 'lo', groupId: 's' },
    { type: 'split', x: 'X', cut: 3e4, side: 'hi', groupId: 's' },
    ...(['UR', 'UL', 'LL', 'LR'] as const).map((q) => ({ type: 'quadrant' as const, x: 'X', y: 'Y', cx: 5e4, cy: 6e4, quadrant: q, groupId: 'q' })),
    { type: 'polygon', x: 'X', y: 'Y', points: [[5e3, 1e3], [1.1e5, 2e3], [1.4e5, 1.5e5], [6e4, 2e5], [1e4, 8e4]] },
    { type: 'polygon', x: 'X', y: 'Y', points: [[0, -2e3], [2.6e5, -2e3], [2.6e5, 2.6e5], [1.3e5, 1e3], [0, 2.6e5]], strict: true, scales: { x: lin, y: lgc } },
    // star-shaped (concave) polygon with many vertices, off-scale clamping
    { type: 'polygon', x: 'X', y: 'Y', points: Array.from({ length: 40 }, (_, k) => [6e4 + Math.cos((k / 40) * 2 * Math.PI) * (k % 2 ? 9e4 : 3e4), 6e4 + Math.sin((k / 40) * 2 * Math.PI) * (k % 2 ? 1e5 : 2e4)] as [number, number]) },
    { type: 'polygon', x: 'X', y: 'Y', points: [[-1e5, -1e5], [4e5, -1e5], [4e5, 4e5]] },
    { type: 'ellipse', x: 'X', y: 'Y', center: [6e4, 5e4], a: [1.2e5, 7e4], b: [5e4, 1.2e5] },
  ];
  gates.forEach((g, gi) =>
    it(`gate ${gi} (${g.type}) identical to the per-event closure`, () => {
      for (const parent of [all, half, all.subarray(0, 5000)]) {
        const a = applyGate(g, parent, ctx);
        const b = refApplyGate(g, parent, ctx);
        expect(a.length).toBe(b.length);
        let same = true;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false;
        expect(same).toBe(true);
      }
    }),
  );
});


import { blur2d, contourLines, hist2d, probabilityThresholds } from '../src/render/density';

// ---- original contour code (verbatim, renamed)
function refProbabilityThresholds(dens: Float32Array, fractions: number[]): number[] {
  const vals = Float32Array.from(dens).sort().reverse();
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

function refContourLines(z: Float32Array, gx: number, gy: number, level: number): number[][] {
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
  return refJoinSegments(segs);
}

function refJoinSegments(segs: number[]): number[][] {
  const key = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const nSeg = segs.length / 4;
  const used = new Uint8Array(nSeg);
  const ends = new Map<string, number[]>();
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
        const cand = ends.get(key(lx, ly));
        const next = cand?.find((t) => !used[t]);
        if (next === undefined) break;
        used[next] = 1;
        const ax = segs[next * 4],
          ay = segs[next * 4 + 1],
          bx = segs[next * 4 + 2],
          by = segs[next * 4 + 3];
        const matchA = key(ax, ay) === key(lx, ly);
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


describe('exact contours', () => {
  it('contour lines and probability thresholds identical to the original', () => {
    const r = rng(5);
    for (const g of [64, 128, 200]) {
      const n = 50000;
      const dx = new Float32Array(n);
      const dy = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const c = r() < 0.4;
        dx[i] = (c ? 0.3 : 0.65) + (r() + r() + r() - 1.5) * 0.15;
        dy[i] = (c ? 0.35 : 0.6) + (r() + r() + r() - 1.5) * 0.2;
      }
      const idx = new Uint32Array(n).map((_, i) => i);
      const dens = blur2d(hist2d(dx, dy, idx, g, g), g, g, 1.6);
      const fr = [0.9, 0.7, 0.5, 0.3, 0.1, 0.02];
      const t1 = probabilityThresholds(dens, fr);
      const t2 = refProbabilityThresholds(dens, fr);
      expect(t1).toEqual(t2);
      for (const t of t1) expect(contourLines(dens, g, g, t)).toEqual(refContourLines(dens, g, g, t));
    }
  });
});
