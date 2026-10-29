// Axis / data transformations. All scales map raw values to a normalized display coordinate
// where the visible range is [0, 1]. Logicle follows Moore & Parks (Cytometry A 2012) and the
// Gating-ML 2.0 definition; arcsinh/log/linear follow Gating-ML 2.0 (flin, flog, fasinh) where possible.

// `grid`: FlowJo's gate grid on this axis (only on the scales of imported FlowJo 10 polygon gates, see GateGrid)
export type BaseScaleDef =
  | { type: 'linear'; min: number; max: number; grid?: GateGrid }
  | { type: 'log'; min: number; max: number; clampLow?: boolean; grid?: GateGrid } // clampLow: values below min sit on the axis (FlowJo log)
  | { type: 'logicle'; T: number; W: number; M: number; A: number; flowjo?: FlowJoBiexParams; grid?: GateGrid }
  | { type: 'arcsinh'; T: number; M: number; A: number; grid?: GateGrid };

/**
 * FlowJo 10 evaluates polygon gates on its display channel grid, not on the continuous display values: with the gate's
 * resolution n (attribute gateResolution, 256 or 1024), every event and every vertex becomes an integer channel
 * 0..n-1 of each axis, and an event is in the gate when its channel point lies inside the polygon or on its outline.
 * Linear and log axes round to the nearest channel (Java Math.round, halves up); biex and logicle truncate. Events beyond an
 * axis sit on its first / last channel. Rectangles are not affected (FlowJo tests them on raw values).
 * Measured against the counts FlowJo 10.5-10.10 stored in its workspaces: every polygon-gated population matches exactly
 * (e.g. all 288 counts of an ICS workspace whose cytokine gates differed by up to 30 % when evaluated exactly, as FlowKit
 * does), see tests/flowjo_grid.test.ts and tests/flowjo.test.ts. Not covered: ellipses (FlowJo's geometry is unknown).
 */
export interface GateGrid {
  /** channels per axis (gateResolution) */
  n: number;
  /** round to the nearest channel (linear axes); else truncate */
  nearest: boolean;
}

/** The valid gate grid of a scale definition, or null (none, or damaged). */
export function gateGridOf(def: ScaleDef | null | undefined): GateGrid | null {
  if (!def || def.type === 'window') return null;
  const g = def.grid as Partial<GateGrid> | undefined;
  if (!g || typeof g !== 'object') return null;
  const n = g.n;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 2 || n > 1 << 16) return null;
  // log axes always round (FlowJo does; gates imported before this was known were stored with nearest: false)
  return { n, nearest: g.nearest === true || def.type === 'log' };
}

/** Channel of a display value (0..1 = the axis) on a gate grid; not clamped to the axis (NaN stays NaN). */
export function gridChannel(u: number, g: GateGrid): number {
  return g.nearest ? Math.floor(u * g.n + 0.5) : Math.floor(u * g.n);
}

const gridDefs = new WeakMap<object, Map<string, BaseScaleDef>>();
const gridBases = new WeakMap<object, BaseScaleDef>();

/** A scale definition with a gate grid (memoized per definition object: stable identity for the engine's caches). */
export function withGateGrid(def: BaseScaleDef, grid: GateGrid): BaseScaleDef {
  let m = gridDefs.get(def);
  if (!m) gridDefs.set(def, (m = new Map()));
  const key = `${grid.n}|${grid.nearest ? 1 : 0}`;
  let d = m.get(key);
  if (!d) {
    m.set(key, (d = { ...def, grid: { n: grid.n, nearest: grid.nearest } }));
    gridBases.set(d, def);
  }
  return d;
}

/**
 * The definition a gate-grid definition was made from (same display values; lets the engine share the display arrays
 * of the plots' scale), or the definition itself.
 */
export function gateGridBase(def: ScaleDef): ScaleDef {
  return gridBases.get(def) ?? def;
}

/**
 * Re-link gate-grid scale definitions read from a file or session (JSON keeps no object identity, so every gate axis
 * would be its own definition with its own display arrays): returns a function that maps a definition to one shared
 * object per distinct definition, made with withGateGrid from its base (the same definition without the grid). Bases
 * are taken from `bases` when equal (e.g. the workspace scales, whose display arrays the plots compute anyway), else
 * shared among the gates. Definitions without a grid are returned as they are.
 */
export function gateGridInterner(bases: unknown[]): (def: ScaleDef) => ScaleDef {
  const baseByKey = new Map<string, BaseScaleDef>();
  for (const b of bases) {
    const d = b as BaseScaleDef | null | undefined;
    if (!d || typeof d !== 'object' || (d as ScaleDef).type === 'window' || d.grid !== undefined) continue;
    const k = JSON.stringify(d);
    if (!baseByKey.has(k)) baseByKey.set(k, d);
  }
  const done = new Map<string, ScaleDef>();
  return (def) => {
    const grid = gateGridOf(def);
    if (!grid || def.type === 'window') return def;
    const key = JSON.stringify(def);
    const hit = done.get(key);
    if (hit) return hit;
    const { grid: _g, ...rest } = def;
    const bk = JSON.stringify(rest);
    let base = baseByKey.get(bk);
    if (!base) baseByKey.set(bk, (base = rest as BaseScaleDef));
    const out = withGateGrid(base, grid);
    done.set(key, out);
    return out;
  };
}

/**
 * FlowJo 10 "biex" transform (FlowJo's lookup-table biexponential, imported from .wsp files).
 * Stored on a logicle scale definition whose T/W/M/A are the closest logicle (see flowJoBiexLogicle); the exact FlowJo
 * table is used only while T/W/M/A still have exactly those values, so editing the scale turns it into a plain logicle.
 */
export interface FlowJoBiexParams {
  neg: number; // extra negative decades
  width: number; // width basis (negative, e.g. -10)
  pos: number; // positive decades
  max: number; // top of scale (maxRange)
}

/** A zoomed view [u0,u1] (in display units) of another scale; used for plot zoom only. */
export type WindowScaleDef = { type: 'window'; base: BaseScaleDef; u0: number; u1: number };

export type ScaleDef = BaseScaleDef | WindowScaleDef;

const winCache = new WeakMap<object, Map<string, WindowScaleDef>>();

/** Memoized window scale (stable object identity for caching). */
export function windowScale(base: ScaleDef, u0: number, u1: number): ScaleDef {
  const b = base.type === 'window' ? base.base : base;
  if (base.type === 'window') {
    const span = base.u1 - base.u0;
    [u0, u1] = [base.u0 + u0 * span, base.u0 + u1 * span];
  }
  if (Math.abs(u0) < 1e-9 && Math.abs(u1 - 1) < 1e-9) return b;
  let m = winCache.get(b);
  if (!m) {
    m = new Map();
    winCache.set(b, m);
  }
  const key = `${u0.toFixed(6)}:${u1.toFixed(6)}`;
  let w = m.get(key);
  if (!w) {
    w = { type: 'window', base: b, u0, u1 };
    m.set(key, w);
  }
  return w;
}

export interface Scale {
  def: ScaleDef;
  /** raw value -> display (0..1 is the visible window) */
  fwd(v: number): number;
  /** display -> raw value */
  inv(u: number): number;
  /** transform a whole array into a new Float32Array */
  fwdArray(src: Float32Array, out?: Float32Array): Float32Array;
}

const LN10 = Math.LN10;
const EPS = 2.220446049250313e-16;
const TAYLOR_LENGTH = 16;

/*
 * Copyright (c) 2009, 2011, 2012, The Board of Trustees of The Leland Stanford Junior University.
 * All rights reserved.
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice, this list of conditions and
 *   the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice, this list of conditions
 *   and the following disclaimer in the documentation and/or other materials provided with the
 *   distribution.
 *
 * * Neither the name of the Leland Stanford Junior University nor the names of its contributors may be
 *   used to endorse or promote products derived from this software without specific prior written
 *   permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
 * IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
 * THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * TypeScript translation of the Logicle reference implementation by Wayne A. Moore (Moore & Parks, Cytometry A
 * 81A:273-277, 2012). Changes: translated to TypeScript.
 */
export class Logicle {
  readonly T: number;
  readonly W: number;
  readonly M: number;
  readonly A: number;
  a: number;
  b: number;
  c: number;
  d: number;
  f: number;
  w: number;
  x0: number;
  x1: number;
  x2: number;
  xTaylor: number;
  taylor: Float64Array;

  constructor(T: number, W: number, M: number, A: number) {
    if (T <= 0) throw new Error('Logicle: T must be > 0');
    if (W < 0) throw new Error('Logicle: W must be >= 0');
    if (M <= 0) throw new Error('Logicle: M must be > 0');
    if (2 * W > M) throw new Error('Logicle: W too large for M');
    if (-A > W || A + W > M - W) throw new Error('Logicle: A out of range');
    this.T = T;
    this.W = W;
    this.M = M;
    this.A = A;
    this.w = W / (M + A);
    this.x2 = A / (M + A);
    this.x1 = this.x2 + this.w;
    this.x0 = this.x2 + 2 * this.w;
    this.b = (M + A) * LN10;
    this.d = Logicle.solve(this.b, this.w);
    const cA = Math.exp(this.x0 * (this.b + this.d));
    const mfA = Math.exp(this.b * this.x1) - cA / Math.exp(this.d * this.x1);
    this.a = T / (Math.exp(this.b) - mfA - cA / Math.exp(this.d));
    this.c = cA * this.a;
    this.f = -mfA * this.a;
    this.xTaylor = this.x1 + this.w / 4;
    let posCoef = this.a * Math.exp(this.b * this.x1);
    let negCoef = -this.c / Math.exp(this.d * this.x1);
    this.taylor = new Float64Array(TAYLOR_LENGTH);
    for (let i = 0; i < TAYLOR_LENGTH; i++) {
      posCoef *= this.b / (i + 1);
      negCoef *= -this.d / (i + 1);
      this.taylor[i] = posCoef + negCoef;
    }
    this.taylor[1] = 0;
  }

  static solve(b: number, w: number): number {
    if (w === 0) return b;
    const tolerance = 2 * b * EPS;
    let dLo = 0;
    let dHi = b;
    let d = (dLo + dHi) / 2;
    let lastDelta = dHi - dLo;
    let delta: number;
    const fB = -2 * Math.log(b) + w * b;
    let f = 2 * Math.log(d) + w * d + fB;
    let lastF = NaN;
    for (let i = 1; i < 40; i++) {
      const df = 2 / d + w;
      if (((d - dHi) * df - f) * ((d - dLo) * df - f) >= 0 || Math.abs(1.9 * f) > Math.abs(lastDelta * df)) {
        delta = (dHi - dLo) / 2;
        d = dLo + delta;
        if (d === dLo) return d;
      } else {
        delta = f / df;
        const t = d;
        d -= delta;
        if (d === t) return d;
      }
      if (Math.abs(delta) < tolerance) return d;
      lastDelta = delta;
      f = 2 * Math.log(d) + w * d + fB;
      if (f === 0 || f === lastF) return d;
      lastF = f;
      if (f < 0) dLo = d;
      else dHi = d;
    }
    return d;
  }

  private series(scale: number): number {
    const x = scale - this.x1;
    const t = this.taylor;
    let sum = t[TAYLOR_LENGTH - 1] * x;
    for (let i = TAYLOR_LENGTH - 2; i >= 2; i--) sum = (sum + t[i]) * x;
    return (sum * x + t[0]) * x;
  }

  /** data value -> logicle scale (0..1) */
  scale(value: number): number {
    if (value === 0) return this.x1;
    const negative = value < 0;
    if (negative) value = -value;
    let x: number;
    if (value < this.f) x = this.x1 + value / this.taylor[0];
    else x = Math.log(value / this.a) / this.b;
    let tolerance = 3 * EPS;
    if (x > 1) tolerance = 3 * x * EPS;
    for (let i = 0; i < 20; i++) {
      const ae2bx = this.a * Math.exp(this.b * x);
      const ce2mdx = this.c / Math.exp(this.d * x);
      let y: number;
      if (x < this.xTaylor) y = this.series(x) - value;
      else y = ae2bx + this.f - (ce2mdx + value);
      const abe2bx = this.b * ae2bx;
      const cde2mdx = this.d * ce2mdx;
      const dy = abe2bx + cde2mdx;
      const ddy = this.b * abe2bx - this.d * cde2mdx;
      const delta = y / (dy * (1 - (y * ddy) / (2 * dy * dy)));
      x -= delta;
      if (Math.abs(delta) < tolerance) break;
    }
    return negative ? 2 * this.x1 - x : x;
  }

  /** logicle scale -> data value */
  inverse(scale: number): number {
    const negative = scale < this.x1;
    if (negative) scale = 2 * this.x1 - scale;
    let inv: number;
    if (scale < this.xTaylor) inv = this.series(scale);
    else inv = this.a * Math.exp(this.b * scale) + this.f - this.c / Math.exp(this.d * scale);
    return negative ? -inv : inv;
  }
}

// ------------------------------------------------------------ FlowJo biex

/*
 * Ported from FlowKit, (c) 2018 Scott White, BSD-3-Clause (FlowKit's generate_biex_lut; license text in
 * THIRD_PARTY_NOTICES.md). Changes: translated to TypeScript; the root of the biexponential equation is computed with
 * Logicle.solve above (same equation, 2 ln d + w d = 2 ln b - w b) instead of FlowKit's own root finder.
 */
/**
 * FlowJo's biex lookup table: raw value of every display channel 0..channelRange (FlowJo uses 4096 channels).
 * Matches the tables FlowJo exports to within 5e-6 (relative).
 */
export function flowJoBiexTable(p: FlowJoBiexParams, channelRange = 4096): Float64Array {
  const ln10 = Math.log(10);
  let decades = p.pos;
  const width0 = Math.log10(-p.width);
  decades -= width0 / 2;
  let extra = p.neg < 0 ? 0 : p.neg;
  extra += width0 / 2;
  let zeroPoint = Math.trunc((extra * channelRange) / (extra + decades));
  zeroPoint = Math.trunc(Math.min(zeroPoint, channelRange / 2));
  if (zeroPoint > 0) decades = (extra * channelRange) / zeroPoint;
  const width = width0 / (2 * decades);
  const positiveRange = ln10 * decades;
  const minimum = p.max / Math.exp(positiveRange);
  const negativeRange = Logicle.solve(positiveRange, width);
  const n = channelRange + 1;
  const pos = new Float64Array(n);
  const neg = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pos[i] = Math.exp((i / n) * positiveRange);
    neg[i] = Math.exp((i / n) * -negativeRange);
  }
  let s = Math.exp((positiveRange + negativeRange) * (width + extra / decades));
  for (let i = 0; i < n; i++) neg[i] *= s;
  s = pos[zeroPoint] - neg[zeroPoint];
  for (let i = zeroPoint; i < n; i++) pos[i] = minimum * (pos[i] - neg[i] - s);
  for (let i = 0; i < zeroPoint; i++) pos[i] = -pos[2 * zeroPoint - i];
  return pos;
}

/** The logicle parameters closest to a FlowJo biex (used for axis ticks and Gating-ML export; always valid). */
export function flowJoBiexLogicle(p: FlowJoBiexParams): { T: number; W: number; M: number; A: number } {
  const T = p.max > 0 ? p.max : 262144;
  const M = p.pos > 0 ? p.pos : 4.5;
  const A = Math.max(0, Math.min(p.neg || 0, M / 2));
  let W = Math.log10(-p.width) / 2;
  if (!Number.isFinite(W) || W < 0) W = 0.5;
  W = Math.min(W, (M - A) / 2, M / 2);
  return { T, W, M, A };
}

/** True while a logicle definition still carries the exact parameters derived from its FlowJo biex. */
export function isFlowJoBiexActive(def: { T: number; W: number; M: number; A: number; flowjo?: FlowJoBiexParams }): boolean {
  if (!def.flowjo) return false;
  const L = flowJoBiexLogicle(def.flowjo);
  return def.T === L.T && def.W === L.W && def.M === L.M && def.A === L.A;
}

/** Scale definition for a FlowJo biex transform. */
export function flowJoBiexDef(p: FlowJoBiexParams): BaseScaleDef {
  return { type: 'logicle', ...flowJoBiexLogicle(p), flowjo: { ...p } };
}

const fjBiexCache = new Map<string, { fwd: (v: number) => number; inv: (u: number) => number; fwdArray: (src: Float32Array, out: Float32Array) => Float32Array }>();

// ---------------------------------------------------------------- exact accelerated table lookup

const SCR_F32 = new Float32Array(1);
const SCR_I32 = new Int32Array(SCR_F32.buffer);
/** Bucket shift: buckets on the float32 bit pattern keep 9 mantissa bits (log-like spacing, 0.1-0.2 % wide). */
const KEY_SHIFT = 14;
/** Magnitudes below 2^-24 share one bucket per sign (keeps the bucket table small). */
const KEY_MIN = (127 - 24) << (23 - KEY_SHIFT);

/** Monotone (non-decreasing) bucket key of a float32 bit pattern; negative values get negative keys. */
function keyOfBits(b: number): number {
  if (b >= 0) {
    const k = b >> KEY_SHIFT;
    return k > KEY_MIN ? k - KEY_MIN : 0;
  }
  const k = (b & 0x7fffffff) >> KEY_SHIFT;
  return k > KEY_MIN ? KEY_MIN - k - 1 : -1;
}

function keyOfValue(v: number): number {
  SCR_F32[0] = v;
  return keyOfBits(SCR_I32[0]);
}

/**
 * Index of an ascending table for the search "last i with xs[i] <= v" (xs[0] < v < xs[n-1]), exactly the index a binary
 * search over the whole table finds, in a few steps: buckets on the float32 bit pattern of v narrow the range. Every
 * narrowed range is checked (xs[lo] <= v < xs[hi]); a value outside it falls back to the full binary search.
 */
interface TableIndex {
  /** last i with xs[i] <= v, for xs[0] < v < xs[n-1] and `bits` the float32 bit pattern of v (as int32) */
  find(v: number, bits: number): number;
  /** first[b]: first table index whose bucket key is >= kLo + b (b = 0..nb) */
  first: Int32Array;
  kLo: number;
  nb: number;
  /** binary search over the whole table */
  full(v: number): number;
}

function tableIndex(xs: Float64Array): TableIndex {
  const n = xs.length;
  const kLo = keyOfValue(xs[0]);
  const kHi = keyOfValue(xs[n - 1]);
  const nb = kHi - kLo + 1;
  const first = new Int32Array(nb + 1);
  let i = 0;
  for (let b = 0; b <= nb; b++) {
    const k = kLo + b;
    while (i < n && keyOfValue(xs[i]) < k) i++;
    first[b] = i;
  }
  const full = (v: number): number => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= v) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  return {
    first,
    kLo,
    nb,
    full,
    find(v: number, bits: number): number {
      const b = keyOfBits(bits) - kLo;
      if (b < 0 || b >= nb) return full(v);
      let lo = first[b] - 1;
      if (lo < 0) lo = 0;
      let hi = first[b + 1];
      if (hi > n - 1) hi = n - 1;
      if (!(xs[lo] <= v && xs[hi] > v)) return full(v);
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= v) lo = mid;
        else hi = mid;
      }
      return lo;
    },
  };
}

/** Bit patterns of a Float32Array (a view, no copy). */
function bitsView(src: Float32Array): Int32Array {
  return new Int32Array(src.buffer, src.byteOffset, src.length);
}

/**
 * FlowJo biex as display transform: linear interpolation in the 4096-channel table, display = channel / 4096.
 * Values beyond the table are placed on the axis edge (0 or 1), as FlowJo and FlowKit do.
 */
export function flowJoBiexScale(p: FlowJoBiexParams): { fwd: (v: number) => number; inv: (u: number) => number; fwdArray: (src: Float32Array, out: Float32Array) => Float32Array } {
  const key = `${p.neg}|${p.width}|${p.pos}|${p.max}`;
  const hit = fjBiexCache.get(key);
  if (hit) return hit;
  const R = 4096;
  const xs = flowJoBiexTable(p, R);
  const n = xs.length;
  const x0 = xs[0];
  const x1 = xs[n - 1];
  const ti = tableIndex(xs);
  const fwd = (v: number): number => {
    if (v !== v) return NaN;
    if (v <= x0) return 0;
    if (v >= x1) return 1;
    SCR_F32[0] = v;
    const lo = ti.find(v, SCR_I32[0]);
    const hi = lo + 1;
    return (lo + (v - xs[lo]) / (xs[hi] - xs[lo])) / R;
  };
  const fwdArray = (src: Float32Array, out: Float32Array): Float32Array => {
    const bits = bitsView(src);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v !== v) out[i] = NaN;
      else if (v <= x0) out[i] = 0;
      else if (v >= x1) out[i] = 1;
      else {
        const lo = ti.find(v, bits[i]);
        const hi = lo + 1;
        out[i] = (lo + (v - xs[lo]) / (xs[hi] - xs[lo])) / R;
      }
    }
    return out;
  };
  const inv = (u: number): number => {
    if (u !== u) return NaN;
    const c = u * R;
    if (c <= 0) return x0;
    if (c >= R) return x1;
    const i = Math.min(n - 2, Math.floor(c));
    return xs[i] + (c - i) * (xs[i + 1] - xs[i]);
  };
  const sc = { fwd, inv, fwdArray };
  if (fjBiexCache.size > 64) fjBiexCache.clear();
  fjBiexCache.set(key, sc);
  return sc;
}

/**
 * Table-accelerated forward transform for monotonic inverse functions: linear interpolation in a table of the inverse
 * (n points, uMin..uMax); values outside the table use the exact transform. `fwdArray` is the same transform for a
 * whole array (bucketed table search, see tableIndex).
 */
function buildFastForward(inv: (u: number) => number, uMin: number, uMax: number, n: number, exact: (v: number) => number) {
  const us = new Float64Array(n);
  const vs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = uMin + ((uMax - uMin) * i) / (n - 1);
    us[i] = u;
    vs[i] = inv(u);
  }
  const vLo = vs[0];
  const vHi = vs[n - 1];
  const ti = tableIndex(vs);
  const fast = (v: number): number => {
    if (!(v > vLo && v < vHi)) return v !== v ? NaN : exact(v);
    SCR_F32[0] = v;
    const lo = ti.find(v, SCR_I32[0]);
    const hi = lo + 1;
    const t = (v - vs[lo]) / (vs[hi] - vs[lo]);
    return us[lo] + t * (us[hi] - us[lo]);
  };
  const { first, kLo, nb, full } = ti;
  const last = n - 1;
  const fwdArray = (src: Float32Array, out: Float32Array): Float32Array => {
    const bits = bitsView(src);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v > vLo && v < vHi) {
        // ti.find, inlined
        const bb = bits[i];
        let b: number;
        if (bb >= 0) {
          const k = bb >> KEY_SHIFT;
          b = (k > KEY_MIN ? k - KEY_MIN : 0) - kLo;
        } else {
          const k = (bb & 0x7fffffff) >> KEY_SHIFT;
          b = (k > KEY_MIN ? KEY_MIN - k - 1 : -1) - kLo;
        }
        let lo: number;
        if (b < 0 || b >= nb) lo = full(v);
        else {
          lo = first[b] - 1;
          if (lo < 0) lo = 0;
          let hi = first[b + 1];
          if (hi > last) hi = last;
          if (!(vs[lo] <= v && vs[hi] > v)) lo = full(v);
          else
            while (hi - lo > 1) {
              const mid = (lo + hi) >> 1;
              if (vs[mid] <= v) lo = mid;
              else hi = mid;
            }
        }
        const hi = lo + 1;
        const t = (v - vs[lo]) / (vs[hi] - vs[lo]);
        out[i] = us[lo] + t * (us[hi] - us[lo]);
      } else out[i] = v !== v ? NaN : exact(v);
    }
    return out;
  };
  return { fast, fwdArray };
}

const scaleCache = new WeakMap<ScaleDef, Scale>();

const SCALE_NUMS: Record<string, string[]> = { linear: ['min', 'max'], log: ['min', 'max'], logicle: ['T', 'W', 'M', 'A'], arcsinh: ['T', 'M', 'A'] };

/**
 * What is wrong with a scale definition from outside (a workspace file, Gating-ML), or null when it is usable: a known
 * type, finite parameters the transform accepts (logicle limits), finite results. Used before a definition reaches
 * makeScale, so damaged files cannot throw while drawing.
 */
export function scaleDefProblem(def: unknown, nested = false): string | null {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return 'not a scale definition';
  const d = def as Record<string, unknown>;
  if (d.type === 'window') {
    if (nested) return 'a zoom window inside a zoom window';
    const b = scaleDefProblem(d.base, true);
    if (b) return b;
    const u0 = d.u0;
    const u1 = d.u1;
    return typeof u0 === 'number' && typeof u1 === 'number' && Number.isFinite(u0) && Number.isFinite(u1) && u1 > u0 ? null : 'invalid zoom window';
  }
  const keys = SCALE_NUMS[d.type as string];
  if (!keys) return `unknown scale type "${String(d.type).slice(0, 20)}"`;
  for (const k of keys) if (typeof d[k] !== 'number' || !Number.isFinite(d[k] as number)) return `${k} is not a number`;
  if ((d.type === 'linear' || d.type === 'log') && !((d.max as number) > (d.min as number))) return 'the maximum is not above the minimum';
  if (d.type === 'log' && !((d.max as number) > 0)) return 'a log axis needs a positive maximum';
  if (d.flowjo !== undefined) {
    const f = d.flowjo as Record<string, unknown> | null;
    if (!f || typeof f !== 'object' || !['neg', 'width', 'pos', 'max'].every((k) => typeof f[k] === 'number' && Number.isFinite(f[k] as number))) return 'invalid FlowJo biex parameters';
  }
  try {
    const sc = makeScale(def as ScaleDef);
    if (![0, 1, 1000].every((v) => Number.isFinite(sc.fwd(v))) || !Number.isFinite(sc.inv(0.5))) return 'the transform gives no finite values';
  } catch (e) {
    return (e as Error)?.message || 'invalid parameters';
  }
  return null;
}

export function makeScale(def: ScaleDef): Scale {
  const cached = scaleCache.get(def);
  if (cached) return cached;
  let fwd: (v: number) => number;
  let inv: (u: number) => number;
  let fast: (v: number) => number;
  // whole-array transform (same values as `fast` element by element, in a tight loop)
  let arr: ((src: Float32Array, out: Float32Array) => Float32Array) | null = null;
  switch (def.type) {
    case 'linear': {
      const span = def.max - def.min || 1;
      const min = def.min;
      fwd = (v) => (v - min) / span;
      inv = (u) => min + u * span;
      fast = fwd;
      arr = (src, out) => {
        for (let i = 0; i < src.length; i++) out[i] = (src[i] - min) / span;
        return out;
      };
      break;
    }
    case 'log': {
      // the axis spans min..max as set, also less than one decade (Gating-ML flog with M < 1); one decade only when
      // max is not above min
      const lo = Math.max(def.min, 1e-12);
      const lmin = Math.log10(lo);
      const lmax = Math.log10(def.max > lo ? def.max : lo * 10);
      const span = lmax - lmin || 1;
      // values <= 0 are placed just below the axis (off-scale low); FlowJo's log puts everything below min on the axis
      if (def.clampLow) fwd = (v) => (v > def.min ? (Math.log10(v) - lmin) / span : v === v ? 0 : NaN);
      else fwd = (v) => (v > 0 ? (Math.log10(v) - lmin) / span : v === v ? -0.02 : NaN);
      inv = (u) => Math.pow(10, lmin + u * span);
      fast = fwd;
      break;
    }
    case 'logicle': {
      if (def.flowjo && isFlowJoBiexActive(def)) {
        const fj = flowJoBiexScale(def.flowjo);
        fwd = fj.fwd;
        inv = fj.inv;
        fast = fwd;
        arr = fj.fwdArray;
        break;
      }
      const lg = new Logicle(def.T, def.W, def.M, def.A);
      fwd = (v) => lg.scale(v);
      inv = (u) => lg.inverse(u);
      const ff = buildFastForward(inv, -0.25, 1.25, 1 << 15, fwd);
      fast = ff.fast;
      arr = ff.fwdArray;
      break;
    }
    case 'window': {
      const b = makeScale(def.base);
      const span = def.u1 - def.u0 || 1;
      fwd = (v) => (b.fwd(v) - def.u0) / span;
      inv = (u) => b.inv(def.u0 + u * span);
      fast = fwd;
      const sc: Scale = {
        def,
        fwd,
        inv,
        fwdArray(src, out) {
          const o = b.fwdArray(src, out);
          for (let i = 0; i < o.length; i++) o[i] = (o[i] - def.u0) / span;
          return o;
        },
      };
      scaleCache.set(def, sc);
      return sc;
    }
    case 'arcsinh': {
      // Gating-ML 2.0 fasinh
      const { T, M, A } = def;
      const sinhM = Math.sinh(M * LN10);
      const denom = (M + A) * LN10;
      fwd = (v) => (Math.asinh((v * sinhM) / T) + A * LN10) / denom;
      inv = (u) => (T * Math.sinh(u * denom - A * LN10)) / sinhM;
      fast = fwd;
      break;
    }
  }
  const whole = arr;
  const sc: Scale = {
    def,
    fwd,
    inv,
    fwdArray(src, out) {
      const o = out ?? new Float32Array(src.length);
      if (whole) return whole(src, o);
      for (let i = 0; i < src.length; i++) o[i] = fast(src[i]);
      return o;
    },
  };
  scaleCache.set(def, sc);
  return sc;
}

// ------------------------------------------------------------- defaults

export function isScatterOrTime(name: string): boolean {
  const n = name.toUpperCase().trim();
  if (/FSC|SSC/.test(n)) return true; // FSC-A, SSC-H, VSSC-A, SSC-B-A ...
  if (/^(FS|SS)([\s_-]|$)/.test(n)) return true; // Beckman Gallios/Navios "FS INT", "SS PEAK"
  if (/^TIME/.test(n) || /^EVENT/.test(n)) return true;
  return false;
}

export function isTimeChannel(name: string): boolean {
  return /^time/i.test(name.trim());
}

export function quantile(sorted: Float32Array | Float64Array | number[], q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const t = pos - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

/** Estimate logicle W from negative data (FlowJo / flowCore estimateLogicle approach). */
export function estimateLogicleW(values: Float32Array, T: number, M: number): number {
  const step = Math.max(1, Math.floor(values.length / 200000));
  let m = 0;
  for (let i = 0; i < values.length; i += step) if (values[i] < 0) m++;
  if (m < 20) return 0.5;
  // numeric typed-array sort: the same order as sort((a, b) => a - b) for these (finite, negative) values, much faster
  const neg = new Float64Array(m);
  m = 0;
  for (let i = 0; i < values.length; i += step) if (values[i] < 0) neg[m++] = values[i];
  neg.sort();
  const r = Math.abs(quantile(neg, 0.05));
  if (!(r > 0)) return 0.5;
  let w = (M - Math.log10(T / r)) / 2;
  if (!Number.isFinite(w)) w = 0.5;
  return Math.min(Math.max(w, 0), M / 2 - 0.01, 2.5);
}

function niceCeil(v: number, fine = false): number {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  if (fine) {
    // axis ends need not be ticks: round up finely so the data fill the plot
    const m = v / p;
    const step = m < 2 ? 0.1 : m < 5 ? 0.25 : 0.5;
    return Math.round(Math.ceil(m / step - 1e-9) * step * 1e6) / 1e6 * p;
  }
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v * (1 - 1e-9)) return m * p;
  return 10 * p;
}

/** Sorted finite subsample (at most ~50k values) below `below`; the last one is reused (several quantiles per scale). */
let robustLast: { sample: WeakRef<Float32Array> | Float32Array; below: number; sub: Float64Array } | null = null;

function robustSorted(sample: Float32Array, below: number): Float64Array {
  const prev = robustLast;
  if (prev && prev.below === below && (typeof WeakRef !== 'undefined' ? (prev.sample as WeakRef<Float32Array>).deref() : prev.sample) === sample) return prev.sub;
  const step = Math.max(1, Math.floor(sample.length / 50000));
  let k = 0;
  for (let i = 0; i < sample.length; i += step) if (Number.isFinite(sample[i]) && sample[i] < below) k++;
  const sub = new Float64Array(k);
  k = 0;
  for (let i = 0; i < sample.length; i += step) if (Number.isFinite(sample[i]) && sample[i] < below) sub[k++] = sample[i];
  // numeric typed-array sort: the same order as sort((a, b) => a - b) for finite values (-0 / +0 aside, equal anyway)
  sub.sort();
  robustLast = { sample: typeof WeakRef !== 'undefined' ? new WeakRef(sample) : sample, below, sub };
  return sub;
}

function robustQuantile(sample: Float32Array, q: number, below = Infinity): number {
  const sub = robustSorted(sample, below);
  if (!sub.length) return NaN;
  return sub[Math.min(sub.length - 1, Math.floor(sub.length * q))];
}

export function defaultScaleFor(name: string, range: number, sample?: Float32Array, hint?: 'lin' | 'log' | ''): ScaleDef {
  let max = range > 0 ? range : 262144;
  const q = sample && sample.length ? robustQuantile(sample, 0.998) : NaN;
  // declared range clearly inconsistent with the data (bogus $PnR): follow the data
  if (Number.isFinite(q) && q > 0 && q > max * 1.5) max = niceCeil(q * 1.2);
  if (isTimeChannel(name)) {
    let mx = 0;
    if (sample) for (let i = 0; i < sample.length; i++) if (sample[i] > mx) mx = sample[i];
    return { type: 'linear', min: 0, max: mx > 0 ? mx * 1.02 : max };
  }
  if (hint === 'lin' || (hint !== 'log' && isScatterOrTime(name))) {
    // scatter: zoom to where the events are when the instrument range is much larger (e.g. CytoFLEX 2^24): the main
    // populations fill the plot; a sparse tail of large events / doublets beyond P99.5 piles up at the axis end
    // (saturated events at the top of the range are left out: they pile up at the axis end anyway)
    const sat = max * 0.999;
    const q50 = sample && sample.length ? robustQuantile(sample, 0.5, sat) : NaN;
    const q99 = sample && sample.length ? robustQuantile(sample, 0.99, sat) : NaN;
    const q995 = sample && sample.length ? robustQuantile(sample, 0.995, sat) : NaN;
    if (hint !== 'lin' && !isTimeChannel(name) && q50 > 0 && q99 / q50 > 25) {
      // events spread over decades (e.g. Accuri FSC / SSC): no linear range shows the bulk, use a logicle axis
      const M = Math.max(4.5, Math.round((4.5 + Math.max(0, Math.log10(max) - Math.log10(262144))) * 4) / 4);
      return { type: 'logicle', T: max, W: Math.round(estimateLogicleW(sample!, max, M) * 100) / 100, M, A: 0 };
    }
    if (Number.isFinite(q99) && q99 > 0) {
      const top = niceCeil(Math.min(Math.max(q995 * 1.1, q99 * 1.02), q99 * 1.25), true);
      if (top < max * 0.7) max = top; // native ranges stay when the events fill most of them
    }
    return { type: 'linear', min: 0, max };
  }
  const T = max;
  const M = Math.max(4.5, Math.round((4.5 + Math.max(0, Math.log10(T) - Math.log10(262144))) * 4) / 4);
  let W = 0.5;
  if (sample) W = estimateLogicleW(sample, T, M);
  W = Math.round(W * 100) / 100;
  return { type: 'logicle', T, W, M, A: 0 };
}

/** Share of events at or below 0 up to which data count as positive (see positiveLogScaleFor). */
export const LOG_AXIS_MAX_NONPOSITIVE = 0.01;

/**
 * Pure log axis for data without meaningful values at or below 0, used for the scatter channels of nanoscale
 * instruments: EV users read violet side scatter in log decades, and a logicle axis adds a 0 and a negative region the
 * data do not use. Decided from the data: null when more than LOG_AXIS_MAX_NONPOSITIVE (1 %) of the finite events are
 * at or below 0 (e.g. baseline-restored or noise-dominated channels; a logicle axis shows those events), so the caller
 * keeps the logicle default. Top: the channel range (the data when the range is implausible), as defaultScaleFor;
 * bottom: the decade at or below the 0.1th percentile of the positive events, 1 to 8 decades below the top. The few
 * events at or below 0 sit just below the axis.
 */
export function positiveLogScaleFor(range: number, sample: Float32Array, anyway = false): Extract<BaseScaleDef, { type: 'log' }> | null {
  const step = Math.max(1, Math.floor(sample.length / 50000));
  const pos: number[] = [];
  let n = 0;
  for (let i = 0; i < sample.length; i += step) {
    const v = sample[i];
    if (!Number.isFinite(v)) continue;
    n++;
    if (v > 0) pos.push(v);
  }
  // (`anyway`: a log axis is wanted whatever the share at or below 0, e.g. refitting an existing log axis)
  if (n < 10 || pos.length < 10 || (!anyway && n - pos.length > LOG_AXIS_MAX_NONPOSITIVE * n)) return null;
  pos.sort((a, b) => a - b);
  const at = (q: number) => pos[Math.min(pos.length - 1, Math.floor(q * (pos.length - 1)))];
  let max = range > 0 ? range : 262144;
  const hi = at(0.998);
  if (hi > max * 1.5) max = niceCeil(hi * 1.2);
  let min = Math.pow(10, Math.floor(Math.log10(at(0.001))));
  min = Math.max(min, Math.pow(10, Math.ceil(Math.log10(max / 1e8))));
  if (min > max / 10) min = Math.pow(10, Math.floor(Math.log10(max / 10)));
  return { type: 'log', min, max };
}

// ---------------------------------------------------------------- ticks

export interface Tick {
  u: number; // display coordinate
  value: number;
  major: boolean;
  label?: { base: string; exp?: string }; // rendered as base^exp
}

/** At most this many ticks are asked for (computeTicks caps the target). */
export const MAX_TICK_TARGET = 50;

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const nice = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  return nice * p;
}

export function formatLinear(v: number, step: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 && step >= 1e5) return trimNum(v / 1e6, step / 1e6) + 'M';
  if (a >= 1e3 && step >= 100) return trimNum(v / 1e3, step / 1e3) + 'K';
  return trimNum(v, step);
}

function trimNum(v: number, step: number): string {
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return v.toFixed(decimals);
}

const MINUS = '\u2212';
/** Tick label of a linear axis: one unit (none, K or M) for all labels of the axis, true minus sign. */
export function formatTick(v: number, step: number, unit: '' | 'K' | 'M'): string {
  if (v === 0) return '0';
  const div = unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  const s = trimNum(Math.abs(v) / div, step / div) + unit;
  return v < 0 ? MINUS + s : s;
}

/** Unit for the labels of a linear axis with ticks every `step` up to |value| `maxAbs`. */
export function tickUnit(maxAbs: number, step: number): '' | 'K' | 'M' {
  if (maxAbs >= 1e6 && step >= 1e5) return 'M';
  if (maxAbs >= 1e3 && step >= 100) return 'K';
  return '';
}

export function computeTicks(def: ScaleDef, opts: { target?: number; /** min. distance of ticks from zero (display units) */ zeroGap?: number } = {}): Tick[] {
  if (def.type === 'window') {
    const span = def.u1 - def.u0;
    let base: Tick[];
    if (def.base.type === 'linear') {
      const b = makeScale(def.base);
      base = computeTicks({ type: 'linear', min: b.inv(def.u0), max: b.inv(def.u1) }, opts).map((t) => ({ ...t, u: def.u0 + t.u * span }));
    } else base = computeTicks(def.base, opts);
    return base.filter((t) => t.u >= def.u0 - 1e-9 && t.u <= def.u1 + 1e-9).map((t) => ({ ...t, u: (t.u - def.u0) / span }));
  }
  const sc = makeScale(def);
  const ticks: Tick[] = [];
  // the target comes from the axis length in some callers: a huge item (1e9 mm) must not ask for millions of ticks
  const target = Math.min(MAX_TICK_TARGET, Math.max(1, Number.isFinite(opts.target) ? (opts.target as number) : 5));
  if (def.type === 'linear') {
    if (!(Number.isFinite(def.min) && Number.isFinite(def.max) && def.max > def.min)) return [];
    const step = niceStep(def.max - def.min, target);
    if (!(step > 0) || !Number.isFinite(step) || (def.max - def.min) / step > 10 * MAX_TICK_TARGET) return [];
    const start = Math.ceil(def.min / step) * step;
    const last = Math.floor((def.max + step * 1e-9) / step) * step;
    const unit = tickUnit(Math.max(Math.abs(start), Math.abs(last)), step);
    for (let i = 0, v = start; v <= def.max + step * 1e-9; i++, v = start + i * step) {
      const vv = Math.abs(v) < step * 1e-9 ? 0 : v;
      ticks.push({ u: sc.fwd(vv), value: vv, major: true, label: { base: formatTick(vv, step, unit) } });
      // minor
      for (let k = 1; k < 5; k++) {
        const mv = vv + (step * k) / 5;
        if (mv < def.max) ticks.push({ u: sc.fwd(mv), value: mv, major: false });
      }
    }
    return ticks.filter((t) => t.u >= -1e-9 && t.u <= 1 + 1e-9);
  }
  const lo = sc.inv(0);
  const hi = sc.inv(1);
  const addDecades = (sign: 1 | -1) => {
    const lim = sign > 0 ? hi : -lo;
    if (!(lim > 0) || !Number.isFinite(lim)) return;
    const maxE = Math.min(330, Math.floor(Math.log10(lim)));
    const minE = Math.max(-330, def.type === 'log' && sign > 0 ? Math.floor(Math.log10(Math.max(lo, 1e-12))) : 0);
    for (let e = minE; e <= maxE; e++) {
      const base = Math.pow(10, e);
      for (let m = 1; m <= 9; m++) {
        const v = sign * m * base;
        const u = sc.fwd(v);
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        if (m === 1) {
          ticks.push({ u, value: v, major: true, label: { base: sign < 0 ? MINUS + '10' : '10', exp: e < 0 ? MINUS + String(-e) : String(e) } });
        } else ticks.push({ u, value: v, major: false });
      }
    }
  };
  addDecades(1);
  if (def.type !== 'log') {
    addDecades(-1);
    const u0 = sc.fwd(0);
    if (u0 >= 0 && u0 <= 1) ticks.push({ u: u0, value: 0, major: true, label: { base: '0' } });
  }
  ticks.sort((a, b) => a.u - b.u);
  // For logicle, linear-region decades crowd around zero: drop labels that are too close to 0, demote the decades of
  // the linear region to minor ticks and drop ticks that would merge with the zero tick
  if (def.type === 'logicle' || def.type === 'arcsinh') {
    const zero = ticks.find((t) => t.value === 0);
    if (zero) {
      const gap = opts.zeroGap ?? 0.012;
      const keep: Tick[] = [];
      for (const t of ticks) {
        if (t.value !== 0) {
          const d = Math.abs(t.u - zero.u);
          if (d < Math.max(gap, t.major ? 0 : 0.015)) continue;
          if (t.label && d < 0.06) {
            t.label = undefined;
            t.major = false;
          }
        }
        keep.push(t);
      }
      return keep;
    }
  }
  return ticks;
}

export function describeScale(def: ScaleDef): string {
  switch (def.type) {
    case 'linear':
      return `Linear ${formatLinear(def.min, 1)}..${formatLinear(def.max, 1)}`;
    case 'log':
      return `Log ${def.min}..${def.max}`;
    case 'logicle':
      if (def.flowjo && isFlowJoBiexActive(def))
        return `FlowJo biex (width=${def.flowjo.width}, neg=${def.flowjo.neg}, pos=${def.flowjo.pos}, max=${formatLinear(def.flowjo.max, 1)})`;
      return `Logicle (T=${formatLinear(def.T, 1)}, W=${def.W}, M=${def.M}, A=${def.A})`;
    case 'arcsinh':
      return `Arcsinh (T=${formatLinear(def.T, 1)}, M=${def.M}, A=${def.A})`;
    case 'window':
      return describeScale(def.base) + ' (zoomed)';
  }
}
