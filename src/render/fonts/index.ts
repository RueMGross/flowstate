// Metric-compatible open fonts: FlowState Sans (Arial / Helvetica metrics), FlowState Serif (Times New Roman) and
// FlowState Humanist (Calibri), renamed subsets of Liberation Sans / Serif and Carlito (SIL OFL 1.1, see gen-fonts.py).
// Glyph widths for text measurement on every painter, and the TrueType subsets embedded in PDF exports.
import { unzlibSync } from 'fflate';
import { CPS, FACES, type FaceData } from './data';

export type FontKind = 'sans' | 'serif' | 'carlito';

export interface EmbedFace {
  data: FaceData;
  /** PDF resource name, e.g. "FFlowStateSansBold" */
  res: string;
  /** synthetic oblique (no true italic face in the subset set) */
  oblique: boolean;
  widths: Uint16Array; // per glyph id, 1/1000 em
  gid: Map<number, number>; // code point -> glyph id
}

const decodeB36 = (s: string, n: number) => {
  const out = new Array<number>(s.length / n);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * n, n), 36);
  return out;
};

let cps: number[] | null = null;
const faces = new Map<string, EmbedFace>();

function load(key: string): EmbedFace | null {
  const hit = faces.get(key);
  if (hit) return hit;
  const data = FACES.find((f) => f.key === key);
  if (!data) return null;
  cps ??= decodeB36(CPS, 4);
  const g = decodeB36(data.gids, 2);
  const gid = new Map<number, number>();
  cps.forEach((cp, i) => {
    if (g[i]) gid.set(cp, g[i]);
  });
  const f: EmbedFace = { data, res: 'F' + data.base.replace(/[^A-Za-z0-9]/g, ''), oblique: false, widths: Uint16Array.from(decodeB36(data.widths, 3)), gid };
  faces.set(key, f);
  return f;
}

/** Font of a CSS family list (first family we know; generic serif / sans-serif decide otherwise). Null: unknown family. */
export function fontKind(family: string, strict = false): FontKind | null {
  const names = family.split(',').map((s) => s.replace(/['"]/g, '').trim().toLowerCase());
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (/^(arial|helvetica|helvetica neue|liberation sans|arimo|flowstate sans|sans-serif|system-ui)$/.test(n)) return 'sans';
    if (/^(times new roman|times|liberation serif|tinos|flowstate serif|serif)$/.test(n)) return 'serif';
    if (/^(calibri|carlito|flowstate humanist)$/.test(n)) return 'carlito';
    if (strict && i === 0) return null; // an unknown first choice is drawn with it on screen
  }
  return strict ? null : /serif/.test(family.toLowerCase()) && !/sans/.test(family.toLowerCase()) ? 'serif' : 'sans';
}

/** Face used for a style; falls back to the upright face with a synthetic slant when no italic face is bundled. */
export function faceFor(family: string, bold: boolean, italic: boolean): EmbedFace {
  const k = fontKind(family) ?? 'sans';
  const base = k + (bold ? '-b' : '');
  if (italic) {
    const it = load(k + (bold ? '-bi' : '-i'));
    if (it) return it;
    const up = load(base) ?? load('sans')!;
    const key = base + '#oblique';
    let ob = faces.get(key);
    if (!ob) {
      ob = { ...up, oblique: true };
      faces.set(key, ob);
    }
    return ob;
  }
  return load(base) ?? load('sans')!;
}

// characters outside the subsets: closest glyph we have (-1: drop)
const SUBST: Record<number, number> = {
  0x2011: 0x2d, 0x2010: 0x2d, 0x2012: 0x2013, 0x2015: 0x2014, 0x2043: 0x2d, 0x22c5: 0xb7, 0x2219: 0xb7, 0x2032: 0x27, 0x2033: 0x22,
  0x2002: 0x20, 0x2003: 0x20, 0x2007: 0x20, 0x2008: 0x20, 0x2009: 0x20, 0x200a: 0x20, 0x202f: 0x20, 0x00ad: -1,
  0x200b: -1, 0x200c: -1, 0x200d: -1, 0xfeff: -1, 0x2060: -1, 0x00a0: 0x20, 0x03bc: 0xb5, 0x2126: 0x3a9, 0x2206: 0x394,
};

/** Glyph id for a code point (0: none, -1: drop the character). */
export function glyphOf(f: EmbedFace, cp: number): number {
  const g = f.gid.get(cp);
  if (g) return g;
  const s = SUBST[cp];
  if (s === -1) return -1;
  if (s !== undefined) {
    const g2 = f.gid.get(s) ?? (s === 0xb7 ? f.gid.get(0x2219) : undefined);
    if (g2) return g2;
  }
  return f.gid.get(0x3f) ?? 0; // '?'
}

/** Advance width of a string in 1/1000 em. */
export function advance(f: EmbedFace, text: string): number {
  let w = 0;
  for (const ch of text) {
    const g = glyphOf(f, ch.codePointAt(0)!);
    if (g >= 0) w += f.widths[g] ?? 0;
  }
  return w;
}

/** Vertical metrics (fractions of the em; descent positive). */
export function vmetrics(family: string): { asc: number; desc: number } {
  const f = faceFor(family, false, false).data;
  return { asc: f.asc / 1000, desc: -f.desc / 1000 };
}

/** Uncompressed TrueType bytes of a face (for FontFace registration). */
export function ttfBytes(f: EmbedFace): Uint8Array {
  return unzlibSync(b64(f.data.ttf));
}

/** Raw zlib stream of the TrueType subset (embedded as is, /FlateDecode). */
export function ttfZlib(f: EmbedFace): Uint8Array {
  return b64(f.data.ttf);
}

function b64(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Uint8Array((globalThis as any).Buffer.from(s, 'base64'));
}

/** Family names under which the bundled subsets are registered for the screen (own names: OFL Reserved Font Names may
 * not be used for modified versions). */
export const SCREEN_FAMILY: Record<FontKind, string> = { sans: 'FlowState Sans', serif: 'FlowState Serif', carlito: 'FlowState Humanist' };

let registered = false;
/**
 * Register the bundled faces with the document so that machines without Arial / Times New Roman / Calibri draw text in a
 * metric-compatible face (fontString inserts the fallback family after the requested families of the same metrics).
 */
export function registerScreenFonts() {
  if (registered) return;
  registered = true;
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) return;
  try {
    for (const d of FACES) {
      const kind = d.key.split('-')[0] as FontKind;
      const f = load(d.key)!;
      const face = new FontFace(SCREEN_FAMILY[kind], ttfBytes(f) as unknown as ArrayBuffer, {
        weight: d.key.includes('-b') ? 'bold' : 'normal',
        style: d.key.endsWith('-i') || d.key.endsWith('-bi') ? 'italic' : 'normal',
      });
      document.fonts.add(face);
      face.load().catch(() => undefined);
    }
  } catch {
    /* fonts are a fallback only */
  }
}
