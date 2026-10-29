// Gate membership evaluation. All index arrays are sorted ascending.
import type { GateGeom, Pt } from './model';
import { gateGridBase, gateGridOf, gridChannel, makeScale, type GateGrid, type Scale, type ScaleDef } from './transforms';

export interface GateContext {
  /** compensated raw values of a channel for the current sample (null if channel missing) */
  raw(ch: string): Float32Array | null;
  /** display-space values (0..1 window) of a channel under the given scale */
  display(ch: string, scale: ScaleDef): Float32Array | null;
  /** effective scale of a channel (workspace setting) */
  scaleOf(ch: string): ScaleDef;
  /** resolve another population's indices (for boolean gates) */
  population(id: string): Uint32Array;
  /** whether a population exists (boolean operands); when absent, unknown ids resolve through population() */
  exists?(id: string): boolean;
  eventCount: number;
}

export function pointInPolygon(x: number, y: number, xs: Float64Array, ys: Float64Array): boolean {
  let inside = false;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ys[i];
    const yj = ys[j];
    if (yi > y !== yj > y) {
      const xint = ((xs[j] - xs[i]) * (y - yi)) / (yj - yi) + xs[i];
      if (x < xint) inside = !inside;
    }
  }
  return inside;
}

export function intersectSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(Math.min(a.length, b.length));
  let i = 0,
    j = 0,
    k = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out[k++] = a[i];
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return out.slice(0, k);
}

export function unionSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  let i = 0,
    j = 0,
    k = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) out[k++] = a[i++];
    else if (i >= a.length || b[j] < a[i]) out[k++] = b[j++];
    else {
      out[k++] = a[i];
      i++;
      j++;
    }
  }
  return out.slice(0, k);
}

export function differenceSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length);
  let i = 0,
    j = 0,
    k = 0;
  while (i < a.length) {
    while (j < b.length && b[j] < a[i]) j++;
    if (j < b.length && b[j] === a[i]) {
      i++;
      continue;
    }
    out[k++] = a[i++];
  }
  return out.slice(0, k);
}

/** Ellipse in display space: center c and conjugate semi-axis vectors va, vb. Returns inverse matrix for membership. */
export function ellipseFrame(c: Pt, a: Pt, b: Pt) {
  const va: Pt = [a[0] - c[0], a[1] - c[1]];
  const vb: Pt = [b[0] - c[0], b[1] - c[1]];
  const det = va[0] * vb[1] - vb[0] * va[1];
  if (Math.abs(det) < 1e-15) return null;
  // A = [va vb] (columns) ; A^-1 = 1/det [[vb1, -vb0], [-va1, va0]]
  return { c, va, vb, i00: vb[1] / det, i01: -vb[0] / det, i10: -va[1] / det, i11: va[0] / det };
}

type Shape2D = Extract<GateGeom, { type: 'polygon' | 'ellipse' }>;

/** Strict gates do not count off-scale events on the axis edge. Older gates with explicit scales and no flag are strict. */
export function isStrictGate(g: GateGeom): boolean {
  return g.type === 'polygon' || g.type === 'ellipse' ? g.strict ?? !!g.scales : true;
}

/** Display scales a polygon / ellipse is evaluated in (gate x, gate y). */
export function gateEvalScales(g: Shape2D, scaleOf: (ch: string) => ScaleDef): { x: ScaleDef; y: ScaleDef } {
  return { x: g.scales?.x ?? scaleOf(g.x), y: g.scales?.y ?? scaleOf(g.y) };
}

function filterIdx(parent: Uint32Array, test: (e: number) => boolean): Uint32Array {
  const out = new Uint32Array(parent.length);
  let k = 0;
  for (let i = 0; i < parent.length; i++) {
    const e = parent[i];
    if (test(e)) out[k++] = e;
  }
  return out.slice(0, k);
}

// The gates below run as tight loops over the parent indices (no per-event closure): same comparisons, same results.

/** Events of `parent` with lo <= xs[e] < hi (bounds may be infinite). */
function rangeIdx(parent: Uint32Array, xs: Float32Array, lo: number, hi: number): Uint32Array {
  const out = new Uint32Array(parent.length);
  let k = 0;
  for (let i = 0; i < parent.length; i++) {
    const e = parent[i];
    const x = xs[e];
    if (x >= lo && x < hi) out[k++] = e;
  }
  return out.slice(0, k);
}

function rectIdx(parent: Uint32Array, xs: Float32Array, ys: Float32Array, xmin: number, xmax: number, ymin: number, ymax: number): Uint32Array {
  const out = new Uint32Array(parent.length);
  let k = 0;
  for (let i = 0; i < parent.length; i++) {
    const e = parent[i];
    const x = xs[e];
    if (x >= xmin && x < xmax) {
      const y = ys[e];
      if (y >= ymin && y < ymax) out[k++] = e;
    }
  }
  return out.slice(0, k);
}

/** Split: x < cut (lo) or x >= cut (hi); NaN on neither side. */
function splitIdx(parent: Uint32Array, xs: Float32Array, cut: number, hi: boolean): Uint32Array {
  const out = new Uint32Array(parent.length);
  let k = 0;
  if (hi) {
    for (let i = 0; i < parent.length; i++) {
      const e = parent[i];
      if (xs[e] >= cut) out[k++] = e;
    }
  } else
    for (let i = 0; i < parent.length; i++) {
      const e = parent[i];
      if (xs[e] < cut) out[k++] = e;
    }
  return out.slice(0, k);
}

/** Quadrant: x on the high side (x >= cx) when hx, else the low side (x < cx); y likewise (NaN is on neither side). */
function quadIdx(parent: Uint32Array, xs: Float32Array, ys: Float32Array, cx: number, cy: number, hx: boolean, hy: boolean): Uint32Array {
  const out = new Uint32Array(parent.length);
  let k = 0;
  for (let i = 0; i < parent.length; i++) {
    const e = parent[i];
    const x = xs[e];
    const y = ys[e];
    if ((hx ? x >= cx : x < cx) && (hy ? y >= cy : y < cy)) out[k++] = e;
  }
  return out.slice(0, k);
}

/** Parents this large use the cell grid of polygonGrid (below it the direct test is as fast). */
const POLY_GRID_MIN = 20000;
const POLY_G = 256;

/**
 * Cell grid over the bounding box of a polygon: 1 = every point of the cell is inside, 0 = outside, 2 = test the point.
 * Every cell within two cells of an edge is tested (edges are sampled at half-cell steps and a 5 x 5 block of cells is
 * marked around each sample), so a decided cell lies more than a whole cell away from the outline, where the crossing
 * test cannot change its answer: the result is exactly that of pointInPolygon for every point.
 */
function polygonGrid(px: Float64Array, py: Float64Array, x0: number, x1: number, y0: number, y1: number): { m: Uint8Array; kx: number; ky: number } | null {
  const G = POLY_G;
  const cw = (x1 - x0) / G;
  const ch = (y1 - y0) / G;
  if (!(cw > 0 && ch > 0) || !Number.isFinite(cw) || !Number.isFinite(ch)) return null;
  const m = new Uint8Array(G * G);
  const n = px.length;
  const mark = (ci: number, cj: number) => {
    for (let j = cj - 2; j <= cj + 2; j++) {
      if (j < 0 || j >= G) continue;
      const row = j * G;
      for (let i = ci - 2; i <= ci + 2; i++) if (i >= 0 && i < G) m[row + i] = 2;
    }
  };
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const ax = (px[b] - x0) / cw;
    const ay = (py[b] - y0) / ch;
    const bx = (px[a] - x0) / cw;
    const by = (py[a] - y0) / ch;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2));
    if (!(steps <= 64 * G)) return null; // degenerate geometry: use the direct test
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      mark(Math.floor(ax + (bx - ax) * t), Math.floor(ay + (by - ay) * t));
    }
  }
  for (let j = 0; j < G; j++) {
    const yc = y0 + (j + 0.5) * ch;
    for (let i = 0; i < G; i++) {
      const c = j * G + i;
      if (m[c] === 2) continue;
      m[c] = pointInPolygon(x0 + (i + 0.5) * cw, yc, px, py) ? 1 : 0;
    }
  }
  return { m, kx: G / (x1 - x0), ky: G / (y1 - y0) };
}

/** Polygon gate in display space (see applyGate): exact, with the cell grid for large parents. */
function polygonIdx(parent: Uint32Array, dx: Float32Array, dy: Float32Array, px: Float64Array, py: Float64Array, clampOff: boolean): Uint32Array {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (let i = 0; i < px.length; i++) {
    x0 = Math.min(x0, px[i]);
    x1 = Math.max(x1, px[i]);
    y0 = Math.min(y0, py[i]);
    y1 = Math.max(y1, py[i]);
  }
  const out = new Uint32Array(parent.length);
  let k = 0;
  const grid = parent.length >= POLY_GRID_MIN ? polygonGrid(px, py, x0, x1, y0, y1) : null;
  if (!grid) {
    for (let i = 0; i < parent.length; i++) {
      const e = parent[i];
      let x = dx[e];
      let y = dy[e];
      if (clampOff) {
        x = x < 0 ? 0 : x > 1 ? 1 : x;
        y = y < 0 ? 0 : y > 1 ? 1 : y;
      }
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (pointInPolygon(x, y, px, py)) out[k++] = e;
    }
    return out.slice(0, k);
  }
  const { m, kx, ky } = grid;
  const G1 = POLY_G - 1;
  for (let i = 0; i < parent.length; i++) {
    const e = parent[i];
    let x = dx[e];
    let y = dy[e];
    if (clampOff) {
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      y = y < 0 ? 0 : y > 1 ? 1 : y;
    }
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if (x !== x || y !== y) {
      // NaN passes the box test; the crossing test decides, as before
      if (pointInPolygon(x, y, px, py)) out[k++] = e;
      continue;
    }
    let ci = Math.floor((x - x0) * kx);
    let cj = Math.floor((y - y0) * ky);
    if (ci < 0) ci = 0;
    else if (ci > G1) ci = G1;
    if (cj < 0) cj = 0;
    else if (cj > G1) cj = G1;
    const c = m[cj * POLY_G + ci];
    if (c === 1 || (c === 2 && pointInPolygon(x, y, px, py))) out[k++] = e;
  }
  return out.slice(0, k);
}

// ------------------------------------------------------------------ FlowJo's gate grid (see GateGrid in transforms.ts)

/**
 * Lattice points of a closed polygon with integer vertices, row by row (rows y0..y1): for each row the sorted, disjoint
 * inclusive x intervals of the points inside the polygon or on its outline (even-odd rule, as java.awt.Polygon).
 */
function latticeRows(vx: Float64Array, vy: Float64Array, y0: number, y1: number): Float64Array[] {
  const n = vx.length;
  const rows: Float64Array[] = [];
  const cross: number[] = [];
  const iv: number[][] = [];
  for (let y = y0; y <= y1; y++) {
    cross.length = 0;
    iv.length = 0;
    for (let a = n - 1, b = 0; b < n; a = b++) {
      const xa = vx[a];
      const ya = vy[a];
      const xb = vx[b];
      const yb = vy[b];
      // interior: crossings of the row (half-open in y, so a vertex on the row counts once)
      if (ya > y !== yb > y) cross.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
      // outline: lattice points of the edge on this row (exact integer arithmetic)
      if (ya === y && yb === y) iv.push([Math.min(xa, xb), Math.max(xa, xb)]);
      else if (y >= Math.min(ya, yb) && y <= Math.max(ya, yb)) {
        const num = (y - ya) * (xb - xa);
        const den = yb - ya;
        if (num % den === 0) {
          const x = xa + num / den;
          iv.push([x, x]);
        }
      }
    }
    cross.sort((p, q) => p - q);
    // a point exactly on a crossing lies on the outline (added above); others are at least 1/|dy| from it
    for (let k = 0; k + 1 < cross.length; k += 2) {
      const lo = Math.ceil(cross[k] - 1e-9);
      const hi = Math.floor(cross[k + 1] + 1e-9);
      if (lo <= hi) iv.push([lo, hi]);
    }
    iv.sort((p, q) => p[0] - q[0]);
    const merged: number[] = [];
    for (const [lo, hi] of iv) {
      const m = merged.length;
      if (m && lo <= merged[m - 1] + 1) merged[m - 1] = Math.max(merged[m - 1], hi);
      else merged.push(lo, hi);
    }
    rows.push(Float64Array.from(merged));
  }
  return rows;
}

/** Display values are float32: within this many channels of a rounding step the channel is computed from the raw value. */
const GRID_SLACK = 1e-6;

/** Channel (0..n-1) of an event from its float32 display value, exact from the raw value near a rounding step. */
function eventChannel(u: number, raw: number, sc: Scale, g: GateGrid, slack: number): number {
  const t = g.nearest ? u * g.n + 0.5 : u * g.n;
  let c = Math.floor(t);
  if (t - c < slack || c + 1 - t < slack) c = gridChannel(sc.fwd(raw), g);
  return c < 0 ? 0 : c > g.n - 1 ? g.n - 1 : c;
}

/**
 * Polygon gate on FlowJo's gate grid: events and vertices as integer channels, the outline included, events beyond an
 * axis on its first / last channel (FlowJo's evaluation of its polygon gates, see GateGrid).
 */
function gridPolygonIdx(
  parent: Uint32Array,
  dx: Float32Array,
  dy: Float32Array,
  rx: Float32Array,
  ry: Float32Array,
  scX: Scale,
  scY: Scale,
  gx: GateGrid,
  gy: GateGrid,
  points: Pt[],
): Uint32Array {
  const vx = new Float64Array(points.map((p) => gridChannel(scX.fwd(p[0]), gx)));
  const vy = new Float64Array(points.map((p) => gridChannel(scY.fwd(p[1]), gy)));
  if (!vx.every(Number.isFinite) || !vy.every(Number.isFinite)) return new Uint32Array(0);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < vy.length; i++) {
    y0 = Math.min(y0, vy[i]);
    y1 = Math.max(y1, vy[i]);
  }
  // events sit on channels 0..n-1: rows beyond them are never asked for
  y0 = Math.max(y0, 0);
  y1 = Math.min(y1, gy.n - 1);
  if (y0 > y1) return new Uint32Array(0);
  const rows = latticeRows(vx, vy, y0, y1);
  const sx = GRID_SLACK * gx.n;
  const sy = GRID_SLACK * gy.n;
  const out = new Uint32Array(parent.length);
  let k = 0;
  for (let i = 0; i < parent.length; i++) {
    const e = parent[i];
    const ux = dx[e];
    const uy = dy[e];
    if (ux !== ux || uy !== uy) continue;
    const cy = eventChannel(uy, ry[e], scY, gy, sy);
    if (cy < y0 || cy > y1) continue;
    const r = rows[cy - y0];
    if (!r.length) continue;
    const cx = eventChannel(ux, rx[e], scX, gx, sx);
    for (let j = 0; j < r.length; j += 2) {
      if (cx < r[j]) break;
      if (cx <= r[j + 1]) {
        out[k++] = e;
        break;
      }
    }
  }
  return out.slice(0, k);
}

/** FlowJo's gate grids of a polygon (on the gate's own scales, both axes), or null for continuous evaluation. */
export function polygonGateGrids(g: GateGeom): { x: GateGrid; y: GateGrid } | null {
  if (g.type !== 'polygon') return null;
  const x = gateGridOf(g.scales?.x);
  const y = gateGridOf(g.scales?.y);
  return x && y ? { x, y } : null;
}

/** Ellipse gate in display space (see applyGate). */
function ellipseIdx(parent: Uint32Array, dx: Float32Array, dy: Float32Array, cx: number, cy: number, i00: number, i01: number, i10: number, i11: number, clampOff: boolean): Uint32Array {
  const out = new Uint32Array(parent.length);
  let k = 0;
  for (let i = 0; i < parent.length; i++) {
    const e = parent[i];
    let x = dx[e];
    let y = dy[e];
    if (clampOff) {
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      y = y < 0 ? 0 : y > 1 ? 1 : y;
    }
    const qx = x - cx;
    const qy = y - cy;
    const u = i00 * qx + i01 * qy;
    const v = i10 * qx + i11 * qy;
    if (u * u + v * v <= 1) out[k++] = e;
  }
  return out.slice(0, k);
}

/**
 * Strict gates on a log axis (Gating-ML flog): values at or below 0 have no log value and are in no gate, as in other
 * Gating-ML software. The display puts them just below the axis, where a gate reaching below the axis would catch them.
 * Null when a channel is missing.
 */
function strictLogParent(parent: Uint32Array, g: Shape2D, sx: ScaleDef, sy: ScaleDef, ctx: GateContext): Uint32Array | null {
  let p = parent;
  for (const [ch, def] of [
    [g.x, sx],
    [g.y, sy],
  ] as const) {
    const b = def.type === 'window' ? def.base : def;
    if (b.type !== 'log' || b.clampLow) continue;
    const raw = ctx.raw(ch);
    if (!raw) return null;
    p = filterIdx(p, (e) => raw[e] > 0);
  }
  return p;
}

export function applyGate(g: GateGeom, parent: Uint32Array, ctx: GateContext): Uint32Array {
  switch (g.type) {
    case 'rect': {
      const xs = ctx.raw(g.x);
      const ys = ctx.raw(g.y);
      if (!xs || !ys) return new Uint32Array(0);
      // null bounds (Infinity cloned through plain JSON) mean unbounded
      const xmin = g.xmin ?? -Infinity;
      const xmax = g.xmax ?? Infinity;
      const ymin = g.ymin ?? -Infinity;
      const ymax = g.ymax ?? Infinity;
      return rectIdx(parent, xs, ys, xmin, xmax, ymin, ymax);
    }
    case 'range': {
      const xs = ctx.raw(g.x);
      if (!xs) return new Uint32Array(0);
      const min = g.min ?? -Infinity;
      const max = g.max ?? Infinity;
      return rangeIdx(parent, xs, min, max);
    }
    case 'split': {
      const xs = ctx.raw(g.x);
      if (!xs) return new Uint32Array(0);
      const cut = g.cut;
      return splitIdx(parent, xs, cut, g.side !== 'lo');
    }
    case 'quadrant': {
      const xs = ctx.raw(g.x);
      const ys = ctx.raw(g.y);
      if (!xs || !ys) return new Uint32Array(0);
      const { cx, cy } = g;
      switch (g.quadrant) {
        case 'UR':
          return quadIdx(parent, xs, ys, cx, cy, true, true);
        case 'UL':
          return quadIdx(parent, xs, ys, cx, cy, false, true);
        case 'LL':
          return quadIdx(parent, xs, ys, cx, cy, false, false);
        case 'LR':
          return quadIdx(parent, xs, ys, cx, cy, true, false);
      }
      return new Uint32Array(0);
    }
    case 'polygon': {
      const { x: sx, y: sy } = gateEvalScales(g, (ch) => ctx.scaleOf(ch));
      // (a gate-grid scale has the display values of the scale it was made from: shared display arrays)
      const dx = ctx.display(g.x, gateGridBase(sx));
      const dy = ctx.display(g.y, gateGridBase(sy));
      if (!dx || !dy || g.points.length < 3) return new Uint32Array(0);
      const scX = makeScale(sx);
      const scY = makeScale(sy);
      const grids = polygonGateGrids(g);
      if (grids) {
        // imported FlowJo polygon: FlowJo's channel grid (the raw values settle channels at rounding steps)
        const rx = ctx.raw(g.x);
        const ry = ctx.raw(g.y);
        if (!rx || !ry) return new Uint32Array(0);
        return gridPolygonIdx(parent, dx, dy, rx, ry, scX, scY, grids.x, grids.y, g.points);
      }
      const px = new Float64Array(g.points.map((p) => scX.fwd(p[0])));
      const py = new Float64Array(g.points.map((p) => scY.fwd(p[1])));
      // Gates drawn in the app treat off-scale events as sitting on the axis edge, exactly where they are displayed.
      // Imported Gating-ML gates keep strict semantics.
      const strict = isStrictGate(g);
      const from = strict ? strictLogParent(parent, g, sx, sy, ctx) : parent;
      if (!from) return new Uint32Array(0);
      return polygonIdx(from, dx, dy, px, py, !strict);
    }
    case 'ellipse': {
      const { x: sx, y: sy } = gateEvalScales(g, (ch) => ctx.scaleOf(ch));
      const dx = ctx.display(g.x, sx);
      const dy = ctx.display(g.y, sy);
      if (!dx || !dy) return new Uint32Array(0);
      const scX = makeScale(sx);
      const scY = makeScale(sy);
      const fr = ellipseFrame(
        [scX.fwd(g.center[0]), scY.fwd(g.center[1])],
        [scX.fwd(g.a[0]), scY.fwd(g.a[1])],
        [scX.fwd(g.b[0]), scY.fwd(g.b[1])],
      );
      if (!fr) return new Uint32Array(0);
      const { c, i00, i01, i10, i11 } = fr;
      const strict = isStrictGate(g);
      const from = strict ? strictLogParent(parent, g, sx, sy, ctx) : parent;
      if (!from) return new Uint32Array(0);
      return ellipseIdx(from, dx, dy, c[0], c[1], i00, i01, i10, i11, !strict);
    }
    case 'bool': {
      // operand ids prefixed with '!' are used as complement; a missing operand is an empty set, which empties NOT and AND
      const none = new Uint32Array(0);
      const missing = (id: string) => !!ctx.exists && !ctx.exists(id.replace(/^!/, ''));
      if ((g.op !== 'or' && g.operands.some(missing)) || !g.operands.length) return none;
      const ops = g.operands.map((id) =>
        missing(id) ? none : id.startsWith('!') ? differenceSorted(allIndices(ctx.eventCount), ctx.population(id.slice(1))) : ctx.population(id),
      );
      let res: Uint32Array;
      if (g.op === 'not') {
        res = differenceSorted(parent, ops[0]);
      } else if (g.op === 'and') {
        res = ops.reduce((a, b) => intersectSorted(a, b));
        res = intersectSorted(res, parent);
      } else {
        res = ops.reduce((a, b) => unionSorted(a, b));
        res = intersectSorted(res, parent);
      }
      return res;
    }
  }
}

export function allIndices(n: number): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

export function makeScaleSafe(def: ScaleDef): Scale {
  return makeScale(def);
}
