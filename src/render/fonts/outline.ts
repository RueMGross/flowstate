// Glyph outlines of the bundled TrueType subsets (glyf / loca tables), for drawing text halos as plain vector paths:
// a halo drawn as a second copy of the text would be extracted twice by text tools ("CD4+CD4+") and edited as a
// second text object in Illustrator.
import { ttfBytes, type EmbedFace } from './index';

/** A glyph contour in font units (y up): points with their on-curve flags (TrueType quadratic B-splines). */
export type Contour = { x: number; y: number; on: boolean }[];

interface Parsed {
  view: DataView;
  upm: number;
  glyf: number;
  loca: (gid: number) => [number, number];
  cache: Map<number, Contour[]>;
}

const parsed = new WeakMap<EmbedFace['data'], Parsed | null>();

function parse(face: EmbedFace): Parsed | null {
  if (parsed.has(face.data)) return parsed.get(face.data) ?? null;
  let out: Parsed | null = null;
  try {
    const bytes = ttfBytes(face);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = view.getUint16(4);
    const tables = new Map<string, { off: number; len: number }>();
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      const tag = String.fromCharCode(view.getUint8(r), view.getUint8(r + 1), view.getUint8(r + 2), view.getUint8(r + 3));
      tables.set(tag, { off: view.getUint32(r + 8), len: view.getUint32(r + 12) });
    }
    const head = tables.get('head');
    const loca = tables.get('loca');
    const glyf = tables.get('glyf');
    const maxp = tables.get('maxp');
    if (head && loca && glyf && maxp) {
      const upm = view.getUint16(head.off + 18);
      const long = view.getInt16(head.off + 50) === 1;
      const numGlyphs = view.getUint16(maxp.off + 4);
      out = {
        view,
        upm,
        glyf: glyf.off,
        loca: (gid) => {
          if (gid < 0 || gid >= numGlyphs) return [0, 0];
          return long
            ? [view.getUint32(loca.off + gid * 4), view.getUint32(loca.off + gid * 4 + 4)]
            : [view.getUint16(loca.off + gid * 2) * 2, view.getUint16(loca.off + gid * 2 + 2) * 2];
        },
        cache: new Map(),
      };
    }
  } catch {
    out = null;
  }
  parsed.set(face.data, out);
  return out;
}

function glyphContours(p: Parsed, gid: number, depth = 0): Contour[] {
  const hit = p.cache.get(gid);
  if (hit) return hit;
  const [a, b] = p.loca(gid);
  const out: Contour[] = [];
  if (b > a && depth < 8) {
    const v = p.view;
    let o = p.glyf + a;
    const nc = v.getInt16(o);
    o += 10;
    if (nc >= 0) {
      const ends: number[] = [];
      for (let i = 0; i < nc; i++, o += 2) ends.push(v.getUint16(o));
      const np = nc ? ends[nc - 1] + 1 : 0;
      o += 2 + v.getUint16(o); // instructions
      const flags: number[] = [];
      while (flags.length < np) {
        const f = v.getUint8(o++);
        flags.push(f);
        if (f & 8) {
          const rep = v.getUint8(o++);
          for (let k = 0; k < rep; k++) flags.push(f);
        }
      }
      const xs: number[] = [];
      let x = 0;
      for (const f of flags) {
        if (f & 2) {
          const d = v.getUint8(o++);
          x += f & 16 ? d : -d;
        } else if (!(f & 16)) {
          x += v.getInt16(o);
          o += 2;
        }
        xs.push(x);
      }
      let y = 0;
      const ys: number[] = [];
      for (const f of flags) {
        if (f & 4) {
          const d = v.getUint8(o++);
          y += f & 32 ? d : -d;
        } else if (!(f & 32)) {
          y += v.getInt16(o);
          o += 2;
        }
        ys.push(y);
      }
      let s = 0;
      for (const e of ends) {
        const c: Contour = [];
        for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
        if (c.length) out.push(c);
        s = e + 1;
      }
    } else {
      // composite glyph: components with offsets and an optional scale / 2 x 2 matrix
      let more = true;
      while (more) {
        const f = v.getUint16(o);
        const g = v.getUint16(o + 2);
        o += 4;
        let dx: number;
        let dy: number;
        if (f & 1) {
          dx = v.getInt16(o);
          dy = v.getInt16(o + 2);
          o += 4;
        } else {
          dx = v.getInt8(o);
          dy = v.getInt8(o + 1);
          o += 2;
        }
        let m = [1, 0, 0, 1];
        const f2 = (q: number) => v.getInt16(q) / 16384;
        if (f & 8) {
          const sc = f2(o);
          m = [sc, 0, 0, sc];
          o += 2;
        } else if (f & 0x40) {
          m = [f2(o), 0, 0, f2(o + 2)];
          o += 4;
        } else if (f & 0x80) {
          m = [f2(o), f2(o + 2), f2(o + 4), f2(o + 6)];
          o += 8;
        }
        if (!(f & 2)) dx = dy = 0; // point-matched components: not used by these fonts
        for (const c of glyphContours(p, g, depth + 1)) out.push(c.map((q) => ({ x: m[0] * q.x + m[2] * q.y + dx, y: m[1] * q.x + m[3] * q.y + dy, on: q.on })));
        more = !!(f & 0x20);
      }
    }
  }
  p.cache.set(gid, out);
  return out;
}

/**
 * Outline path of a glyph as PDF path operators (m / l / c, closed with h), the glyph's origin at (x, y) in a y-down
 * space, `size` px per em, `slant` the synthetic italic shear. Empty for a glyph without outline (space) or an
 * unreadable font.
 */
export function glyphPathPdf(face: EmbedFace, gid: number, x: number, y: number, size: number, slant: number, fmt: (v: number) => string): string {
  const p = parse(face);
  if (!p) return '';
  const k = size / p.upm;
  const P = (q: { x: number; y: number }) => `${fmt(x + (q.x + slant * q.y) * k)} ${fmt(y - q.y * k)}`;
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const ops: string[] = [];
  for (const c of glyphContours(p, gid)) {
    const n = c.length;
    if (n < 2) continue;
    // start at an on-curve point (or the midpoint of two off-curve points)
    let si = c.findIndex((q) => q.on);
    let start: { x: number; y: number };
    if (si < 0) {
      start = mid(c[0], c[1]);
      si = 0;
    } else start = c[si];
    ops.push(`${P(start)} m`);
    let cur = start;
    let ctrl: { x: number; y: number } | null = null;
    for (let i = 1; i <= n; i++) {
      const q = c[(si + i) % n];
      if (q.on) {
        if (ctrl) {
          // quadratic -> cubic
          const c1 = { x: cur.x + ((ctrl.x - cur.x) * 2) / 3, y: cur.y + ((ctrl.y - cur.y) * 2) / 3 };
          const c2 = { x: q.x + ((ctrl.x - q.x) * 2) / 3, y: q.y + ((ctrl.y - q.y) * 2) / 3 };
          ops.push(`${P(c1)} ${P(c2)} ${P(q)} c`);
          ctrl = null;
        } else ops.push(`${P(q)} l`);
        cur = q;
      } else {
        if (ctrl) {
          const m = mid(ctrl, q);
          const c1 = { x: cur.x + ((ctrl.x - cur.x) * 2) / 3, y: cur.y + ((ctrl.y - cur.y) * 2) / 3 };
          const c2 = { x: m.x + ((ctrl.x - m.x) * 2) / 3, y: m.y + ((ctrl.y - m.y) * 2) / 3 };
          ops.push(`${P(c1)} ${P(c2)} ${P(m)} c`);
          cur = m;
        }
        ctrl = q;
      }
    }
    if (ctrl) {
      const c1 = { x: cur.x + ((ctrl.x - cur.x) * 2) / 3, y: cur.y + ((ctrl.y - cur.y) * 2) / 3 };
      const c2 = { x: start.x + ((ctrl.x - start.x) * 2) / 3, y: start.y + ((ctrl.y - start.y) * 2) / 3 };
      ops.push(`${P(c1)} ${P(c2)} ${P(start)} c`);
    }
    ops.push('h');
  }
  return ops.join(' ');
}
