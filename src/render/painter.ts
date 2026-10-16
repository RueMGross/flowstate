// Backend-independent drawing API used for on-screen canvas, SVG and PDF export.
import { advance, faceFor, fontKind, registerScreenFonts, SCREEN_FAMILY } from './fonts';

export interface Stroke {
  color: string;
  width: number;
  dash?: number[];
  opacity?: number;
}

export interface Fill {
  color: string;
  opacity?: number;
}

export interface TextStyle {
  family: string;
  size: number; // px
  weight?: 'normal' | 'bold';
  italic?: boolean;
  color: string;
  align?: 'left' | 'center' | 'right';
  baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
  /** outline drawn under the glyphs (keeps text readable over data without a label box); width in px per side */
  halo?: { color: string; width: number; opacity?: number };
}

export interface TextRun {
  text: string;
  sup?: boolean;
  /** subscript (from Unicode subscript characters) */
  sub?: boolean;
}

export type RichText = string | TextRun[];

export interface Painter {
  readonly kind: 'canvas' | 'svg' | 'pdf';
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  clipRect(x: number, y: number, w: number, h: number): void;
  line(x1: number, y1: number, x2: number, y2: number, s: Stroke): void;
  /** flat [x0,y0,x1,y1,...] */
  path(pts: ArrayLike<number>, closed: boolean, s?: Stroke | null, f?: Fill | null): void;
  rect(x: number, y: number, w: number, h: number, s?: Stroke | null, f?: Fill | null): void;
  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, s?: Stroke | null, f?: Fill | null): void;
  text(x: number, y: number, t: RichText, st: TextStyle, rotate?: number): void;
  /** draw a raster (canvas) into the rectangle */
  image(src: HTMLCanvasElement | OffscreenCanvas, x: number, y: number, w: number, h: number, smooth?: boolean): void;
}

// ------------------------------------------------------------ text metrics

let measureCtx: CanvasRenderingContext2D | null = null;
function mctx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  measureCtx = c.getContext('2d');
  return measureCtx;
}

/**
 * CSS family list with the bundled metric-compatible face (machines without the font) inserted right after the leading
 * families of the same metrics, before any other family or the generic one: "Calibri, Carlito, Arial, sans-serif"
 * becomes 'Calibri, Carlito, "FlowState Humanist", Arial, sans-serif'.
 */
export function withFallback(family: string): string {
  const k = fontKind(family, true);
  if (!k) return family;
  if (family.includes(SCREEN_FAMILY[k])) return family;
  const names = family.split(',').map((s) => s.trim());
  let i = 0;
  while (i < names.length && !/^(sans-serif|serif|system-ui)$/i.test(names[i]) && fontKind(names[i], true) === k) i++;
  names.splice(i, 0, `"${SCREEN_FAMILY[k]}"`);
  return names.join(', ');
}

export function fontString(st: Pick<TextStyle, 'family' | 'size' | 'weight' | 'italic'>, scale = 1): string {
  registerScreenFonts();
  return `${st.italic ? 'italic ' : ''}${st.weight === 'bold' ? 'bold ' : ''}${st.size * scale}px ${withFallback(st.family)}`;
}

export const SUP_SCALE = 0.7;
/** raise of superscripts / drop of subscripts, in em of the surrounding text */
export const SUP_RAISE = 0.38;
export const SUB_DROP = 0.15;

/** Shared baseline offsets (relative to the alphabetic baseline) used by all painters so exports match the screen. */
export function baselineShift(st: Pick<TextStyle, 'size' | 'baseline'>): number {
  switch (st.baseline) {
    case 'top':
      return st.size * 0.8;
    case 'middle':
      return st.size * 0.35;
    case 'bottom':
      return -st.size * 0.22;
    default:
      return 0;
  }
}

// Unicode super- and subscript characters become raised / lowered runs (same look in every painter and font)
const SUPER: Record<string, string> = { '\u2070': '0', '\u00b9': '1', '\u00b2': '2', '\u00b3': '3', '\u2071': 'i', '\u207a': '+', '\u207b': '\u2212', '\u207c': '=', '\u207d': '(', '\u207e': ')', '\u207f': 'n' };
const SUB: Record<string, string> = { '\u208a': '+', '\u208b': '\u2212', '\u208c': '=', '\u208d': '(', '\u208e': ')' };
for (let d = 4; d <= 9; d++) SUPER[String.fromCharCode(0x2070 + d)] = String(d);
for (let d = 0; d <= 9; d++) SUB[String.fromCharCode(0x2080 + d)] = String(d);
const SCRIPT_RE = /[\u00b2\u00b3\u00b9\u2070-\u208e]/;

function splitScripts(r: TextRun, out: TextRun[]) {
  if (r.sup || r.sub || !SCRIPT_RE.test(r.text)) {
    out.push(r);
    return;
  }
  let cur: TextRun | null = null;
  for (const ch of r.text) {
    const sp = SUPER[ch];
    const sb = sp === undefined ? SUB[ch] : undefined;
    const kind = sp !== undefined ? 'sup' : sb !== undefined ? 'sub' : '';
    const text = sp ?? sb ?? ch;
    const curKind: string = cur ? (cur.sup ? 'sup' : cur.sub ? 'sub' : '') : '-';
    if (cur && curKind === kind) cur.text += text;
    else {
      cur = kind === 'sup' ? { text, sup: true } : kind === 'sub' ? { text, sub: true } : { text };
      out.push(cur);
    }
  }
}

export function runs(t: RichText): TextRun[] {
  const src = typeof t === 'string' ? [{ text: t }] : t;
  if (!src.some((r) => !r.sup && !r.sub && SCRIPT_RE.test(r.text))) return src;
  const out: TextRun[] = [];
  for (const r of src) splitScripts(r, out);
  return out;
}

/** Smallest superscript / subscript (px): 5 pt, but never larger than the text itself. */
export const MIN_SCRIPT_PX = (5 * 96) / 72;

/** Font size of a run: scripts at 0.7 em, at least 5 pt. */
export function runSize(r: TextRun, size: number): number {
  return r.sup || r.sub ? Math.min(size, Math.max(size * SUP_SCALE, MIN_SCRIPT_PX)) : size;
}

/** Vertical offset of a run's baseline (px, y down). */
export function runShift(r: TextRun, size: number): number {
  return r.sup ? -size * SUP_RAISE : r.sub ? size * SUB_DROP : 0;
}

/** Width of one run: bundled font metrics for the families we embed, the canvas for anything else. */
function runWidth(r: TextRun, st: Pick<TextStyle, 'family' | 'size' | 'weight' | 'italic'>): number {
  const size = runSize(r, st.size);
  if (fontKind(st.family, true)) return (advance(faceFor(st.family, st.weight === 'bold', !!st.italic), r.text) * size) / 1000;
  const ctx = mctx();
  if (!ctx) return (advance(faceFor(st.family, st.weight === 'bold', !!st.italic), r.text) * size) / 1000;
  ctx.font = fontString({ ...st, size });
  return ctx.measureText(r.text).width;
}

export function measureRich(t: RichText, st: Pick<TextStyle, 'family' | 'size' | 'weight' | 'italic'>): number {
  let w = 0;
  for (const r of runs(t)) w += runWidth(r, st);
  return w;
}

/** Widths of the runs of a text (same order as runs(t)). */
export function runWidths(t: RichText, st: Pick<TextStyle, 'family' | 'size' | 'weight' | 'italic'>): { runs: TextRun[]; widths: number[] } {
  const rs = runs(t);
  return { runs: rs, widths: rs.map((r) => runWidth(r, st)) };
}

export function richToPlain(t: RichText): string {
  return runs(t)
    .map((r) => (r.sup ? '^' + r.text : r.text))
    .join('');
}

/**
 * Parse simple markup: "10^4", "10^-3" and "^{...}" give superscript runs; "CD4^+CD8^-" raises only the signs.
 */
export function parseSup(s: string): TextRun[] {
  const out: TextRun[] = [];
  const re = /\^(?:\{([^}]*)\}|(-?[0-9][0-9A-Za-z.]*|[+\-]|[0-9A-Za-z.]+))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ text: m[1] ?? m[2], sup: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.length ? out : [{ text: '' }];
}

// ------------------------------------------------------------ canvas

export class CanvasPainter implements Painter {
  readonly kind = 'canvas' as const;
  constructor(public ctx: CanvasRenderingContext2D, public pixelScale = 1) {}
  save() {
    this.ctx.save();
  }
  restore() {
    this.ctx.restore();
  }
  translate(x: number, y: number) {
    this.ctx.translate(x, y);
  }
  clipRect(x: number, y: number, w: number, h: number) {
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.ctx.clip();
  }
  private applyStroke(s: Stroke) {
    const c = this.ctx;
    c.strokeStyle = s.color;
    c.lineWidth = s.width;
    c.setLineDash(s.dash ?? []);
    c.globalAlpha = s.opacity ?? 1;
    c.lineJoin = 'round';
    c.lineCap = 'butt';
  }
  private finish(s?: Stroke | null, f?: Fill | null) {
    const c = this.ctx;
    if (f) {
      c.fillStyle = f.color;
      c.globalAlpha = f.opacity ?? 1;
      c.fill();
    }
    if (s) {
      this.applyStroke(s);
      c.stroke();
    }
    c.globalAlpha = 1;
  }
  line(x1: number, y1: number, x2: number, y2: number, s: Stroke) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    this.applyStroke(s);
    c.stroke();
    c.globalAlpha = 1;
  }
  path(pts: ArrayLike<number>, closed: boolean, s?: Stroke | null, f?: Fill | null) {
    if (pts.length < 4) return;
    const c = this.ctx;
    c.beginPath();
    c.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    if (closed) c.closePath();
    this.finish(s, f);
  }
  rect(x: number, y: number, w: number, h: number, s?: Stroke | null, f?: Fill | null) {
    const c = this.ctx;
    c.beginPath();
    c.rect(x, y, w, h);
    this.finish(s, f);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, s?: Stroke | null, f?: Fill | null) {
    const c = this.ctx;
    c.beginPath();
    c.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), rot, 0, Math.PI * 2);
    this.finish(s, f);
  }
  text(x: number, y: number, t: RichText, st: TextStyle, rotate = 0) {
    const c = this.ctx;
    c.save();
    c.translate(x, y);
    if (rotate) c.rotate(rotate);
    const { runs: rs, widths } = runWidths(t, st);
    const total = widths.reduce((a, b) => a + b, 0);
    let ox = st.align === 'center' ? -total / 2 : st.align === 'right' ? -total : 0;
    c.fillStyle = st.color;
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    // no kerning: advances match the measured widths and the PDF/SVG exports
    if ('fontKerning' in c) (c as { fontKerning: string }).fontKerning = 'none';
    const base = baselineShift(st);
    if (st.halo) {
      c.strokeStyle = st.halo.color;
      c.lineWidth = st.halo.width * 2;
      c.lineJoin = 'round';
      c.globalAlpha = st.halo.opacity ?? 1;
      let hx = ox;
      rs.forEach((r, i) => {
        c.font = fontString({ ...st, size: runSize(r, st.size) });
        c.strokeText(r.text, hx, base + runShift(r, st.size));
        hx += widths[i];
      });
      c.globalAlpha = 1;
    }
    rs.forEach((r, i) => {
      c.font = fontString({ ...st, size: runSize(r, st.size) });
      c.fillText(r.text, ox, base + runShift(r, st.size));
      ox += widths[i];
    });
    c.restore();
  }
  image(src: HTMLCanvasElement | OffscreenCanvas, x: number, y: number, w: number, h: number, smooth = false) {
    const c = this.ctx;
    c.imageSmoothingEnabled = smooth;
    c.drawImage(src as CanvasImageSource, x, y, w, h);
    c.imageSmoothingEnabled = true;
  }
}

// ------------------------------------------------------------ svg

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Math.round(v * 100) / 100).toString();

export class SvgPainter implements Painter {
  readonly kind = 'svg' as const;
  parts: string[] = [];
  private stack: number[] = [];
  private clipId = 0;
  private haloClasses = new Map<string, string>();
  constructor(private idPrefix = 'p') {}
  save() {
    this.stack.push(0);
  }
  restore() {
    const opened = this.stack.pop() ?? 0;
    for (let i = 0; i < opened; i++) this.parts.push('</g>');
  }
  private open(tag: string) {
    this.parts.push(tag);
    if (this.stack.length) this.stack[this.stack.length - 1]++;
    else this.stack.push(1);
  }
  translate(x: number, y: number) {
    this.open(`<g transform="translate(${n(x)},${n(y)})">`);
  }
  clipRect(x: number, y: number, w: number, h: number) {
    const id = `${this.idPrefix}c${this.clipId++}`;
    this.parts.push(`<clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/></clipPath>`);
    this.open(`<g clip-path="url(#${id})">`);
  }
  private sAttr(s?: Stroke | null) {
    if (!s) return ' stroke="none"';
    return ` stroke="${s.color}" stroke-width="${n(s.width)}"${s.dash?.length ? ` stroke-dasharray="${s.dash.map(n).join(' ')}"` : ''}${s.opacity !== undefined && s.opacity < 1 ? ` stroke-opacity="${n(s.opacity)}"` : ''} stroke-linejoin="round"`;
  }
  private fAttr(f?: Fill | null) {
    if (!f) return ' fill="none"';
    return ` fill="${f.color}"${f.opacity !== undefined && f.opacity < 1 ? ` fill-opacity="${n(f.opacity)}"` : ''}`;
  }
  line(x1: number, y1: number, x2: number, y2: number, s: Stroke) {
    this.parts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"${this.sAttr(s)}/>`);
  }
  path(pts: ArrayLike<number>, closed: boolean, s?: Stroke | null, f?: Fill | null) {
    if (pts.length < 4) return;
    let d = `M${n(pts[0])} ${n(pts[1])}`;
    for (let i = 2; i < pts.length; i += 2) d += `L${n(pts[i])} ${n(pts[i + 1])}`;
    if (closed) d += 'Z';
    this.parts.push(`<path d="${d}"${this.sAttr(s)}${this.fAttr(f)}/>`);
  }
  rect(x: number, y: number, w: number, h: number, s?: Stroke | null, f?: Fill | null) {
    this.parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${this.sAttr(s)}${this.fAttr(f)}/>`);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, s?: Stroke | null, f?: Fill | null) {
    const deg = (rot * 180) / Math.PI;
    this.parts.push(
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(Math.max(0, rx))}" ry="${n(Math.max(0, ry))}"${deg ? ` transform="rotate(${n(deg)} ${n(cx)} ${n(cy)})"` : ''}${this.sAttr(s)}${this.fAttr(f)}/>`,
    );
  }
  text(x: number, y: number, t: RichText, st: TextStyle, rotate = 0) {
    // Illustrator ignores dominant-baseline: shift y manually instead for robust output
    const dyShift = baselineShift(st);
    const tr = rotate ? ` transform="rotate(${n((rotate * 180) / Math.PI)} ${n(x)} ${n(y)})"` : '';
    const { runs: rs, widths } = runWidths(t, st);
    const parts = rs.map((r, i) => ({ r, w: widths[i] })).filter((q) => q.r.text);
    let inner = '';
    let anchor = st.align === 'center' ? 'middle' : st.align === 'right' ? 'end' : 'start';
    if (parts.length === 1 && !parts[0].r.sup && !parts[0].r.sub) inner = esc(parts[0].r.text);
    else {
      // Several runs (superscripts): every run at its own absolute position (x from the bundled font metrics, y with
      // the script raise), anchored at the start. Relative dy shifts are drawn differently by some renderers (cairo
      // puts a gap before "³" in "10³"); absolute positions read the same in browsers, librsvg, cairo and Illustrator.
      const total = parts.reduce((a, q) => a + q.w, 0);
      let ox = x - (st.align === 'center' ? total / 2 : st.align === 'right' ? total : 0);
      anchor = 'start';
      for (const { r, w } of parts) {
        const sz = runSize(r, st.size);
        inner += `<tspan x="${n(ox)}" y="${n(y + dyShift + runShift(r, st.size))}"${sz !== st.size ? ` font-size="${n(sz)}"` : ''}>${esc(r.text)}</tspan>`;
        ox += w;
      }
    }
    // halo: one text element, stroked under its fill (paint-order). The stroke is set by a style rule that applies only
    // where paint-order works (@supports): a renderer without it would paint the stroke over the glyphs, so it draws the
    // text without a halo instead. Never a second copy of the text (text tools would read it twice).
    let cls = '';
    if (st.halo) {
      const key = `${st.halo.color}|${n(st.halo.width * 2)}|${n(st.halo.opacity ?? 1)}`;
      cls = this.haloClasses.get(key) ?? '';
      if (!cls) {
        cls = `${this.idPrefix}h${this.haloClasses.size}`;
        this.haloClasses.set(key, cls);
        const op = st.halo.opacity !== undefined && st.halo.opacity < 1 ? ` stroke-opacity: ${n(st.halo.opacity)};` : '';
        this.parts.push(
          `<style>@supports (paint-order: stroke) { .${cls} { stroke: ${st.halo.color}; stroke-width: ${n(st.halo.width * 2)}px;${op} stroke-linejoin: round; paint-order: stroke markers fill; } }</style>`,
        );
      }
    }
    const attrs = `x="${n(x)}" y="${n(y + dyShift)}" xml:space="preserve" style="white-space:pre" font-family="${esc(st.family)}" font-size="${n(st.size)}"${st.weight === 'bold' ? ' font-weight="bold"' : ''}${st.italic ? ' font-style="italic"' : ''} text-anchor="${anchor}"${tr}${cls ? ` class="${cls}"` : ''}`;
    this.parts.push(`<text ${attrs} fill="${st.color}">${inner}</text>`);
  }
  image(src: HTMLCanvasElement | OffscreenCanvas, x: number, y: number, w: number, h: number, smooth = false) {
    let url = '';
    if ('toDataURL' in src) url = (src as HTMLCanvasElement).toDataURL('image/png');
    this.parts.push(
      `<image x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"${smooth ? '' : ' style="image-rendering:pixelated"'} href="${url}" xlink:href="${url}"/>`,
    );
  }
  toString() {
    return this.parts.join('');
  }
}

/** Largest canvas side and area browsers draw reliably (Chrome: 32767 px per side, ~268 M px area; Safari less). */
const CANVAS_MAX_SIDE = 16384;
const CANVAS_MAX_AREA = 64 * 1024 * 1024;

/**
 * Device pixels per CSS pixel for a w x h item drawn at scale `k` (zoom x device pixel ratio): `k`, reduced so the
 * canvas stays within the size browsers can allocate (a huge item is drawn blurred instead of not at all).
 */
export function fitCanvasScale(w: number, h: number, k: number): number {
  const side = Math.max(1, w, h);
  let kk = Math.min(k, CANVAS_MAX_SIDE / side);
  const area = Math.max(1, w) * Math.max(1, h) * kk * kk;
  if (area > CANVAS_MAX_AREA) kk *= Math.sqrt(CANVAS_MAX_AREA / area);
  return Number.isFinite(kk) && kk > 0 ? kk : 1;
}
