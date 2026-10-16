// Minimal vector PDF writer implementing the Painter interface (embedded TrueType subsets, raster images with alpha).
import { zlibSync } from 'fflate';
import { baselineShift, runs, runShift, runSize, type Fill, type Painter, type RichText, type Stroke, type TextStyle } from './painter';
import { advance, faceFor, glyphOf, ttfZlib, type EmbedFace } from './fonts';
import { glyphPathPdf } from './fonts/outline';
import { hexToRgb } from './colormaps';
import { APP_NAME } from '../core/model';

const enc = new TextEncoder();

function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

function rgb(c: string): string {
  const [r, g, b] = hexToRgb(c);
  return `${num(r / 255)} ${num(g / 255)} ${num(b / 255)}`;
}

function pdfLiteral(codes: number[]): string {
  let out = '';
  for (const code of codes) {
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += '\\' + String.fromCharCode(code);
    else if (code < 32 || code > 126) out += '\\' + code.toString(8).padStart(3, '0');
    else out += String.fromCharCode(code);
  }
  return `(${out})`;
}

/** PDF text string for the document information dictionary (UTF-16BE when not plain ASCII). */
function pdfTextString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return pdfLiteral([...s].map((c) => c.charCodeAt(0)));
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

interface ImgObj {
  name: string;
  w: number;
  h: number;
  rgb: Uint8Array;
  alpha: Uint8Array | null;
  smooth: boolean;
}

export class PdfPainter implements Painter {
  readonly kind = 'pdf' as const;
  private ops: string[] = [];
  private images: ImgObj[] = [];
  private gstates = new Map<string, string>();
  private fontsUsed = new Map<string, EmbedFace>();

  constructor(public widthPx: number, public heightPx: number) {
    // map CSS px (y down) to PDF points (y up)
    this.ops.push(`0.75 0 0 -0.75 0 ${num(heightPx * 0.75)} cm`);
  }
  save() {
    this.ops.push('q');
  }
  restore() {
    this.ops.push('Q');
  }
  translate(x: number, y: number) {
    this.ops.push(`1 0 0 1 ${num(x)} ${num(y)} cm`);
  }
  clipRect(x: number, y: number, w: number, h: number) {
    this.ops.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re W n`);
  }
  private alpha(a: number, kind: 'CA' | 'ca'): string {
    const key = `${kind}${Math.round(a * 1000)}`;
    let name = this.gstates.get(key);
    if (!name) {
      name = `GS${this.gstates.size + 1}`;
      this.gstates.set(key, name);
    }
    return `/${name} gs`;
  }
  private paint(s?: Stroke | null, f?: Fill | null) {
    const pre: string[] = [];
    if (f) {
      pre.push(`${rgb(f.color)} rg`);
      if (f.opacity !== undefined && f.opacity < 1) pre.push(this.alpha(f.opacity, 'ca'));
    }
    if (s) {
      pre.push(`${rgb(s.color)} RG ${num(s.width)} w 1 j`);
      pre.push(s.dash?.length ? `[${s.dash.map(num).join(' ')}] 0 d` : '[] 0 d');
      if (s.opacity !== undefined && s.opacity < 1) pre.push(this.alpha(s.opacity, 'CA'));
    }
    const op = f && s ? 'B' : f ? 'f' : s ? 'S' : 'n';
    return { pre: pre.join(' '), op };
  }
  private shape(path: string, s?: Stroke | null, f?: Fill | null) {
    if (!s && !f) return;
    const { pre, op } = this.paint(s, f);
    const needQ = (f?.opacity !== undefined && f.opacity < 1) || (s?.opacity !== undefined && s.opacity < 1);
    this.ops.push(`${needQ ? 'q ' : ''}${pre} ${path} ${op}${needQ ? ' Q' : ''}`);
  }
  line(x1: number, y1: number, x2: number, y2: number, s: Stroke) {
    this.shape(`${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l`, s, null);
  }
  path(pts: ArrayLike<number>, closed: boolean, s?: Stroke | null, f?: Fill | null) {
    if (pts.length < 4) return;
    let d = `${num(pts[0])} ${num(pts[1])} m`;
    for (let i = 2; i < pts.length; i += 2) d += ` ${num(pts[i])} ${num(pts[i + 1])} l`;
    if (closed) d += ' h';
    this.shape(d, s, f);
  }
  rect(x: number, y: number, w: number, h: number, s?: Stroke | null, f?: Fill | null) {
    this.shape(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`, s, f);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, s?: Stroke | null, f?: Fill | null) {
    const k = 0.5522847498;
    const c = Math.cos(rot),
      sn = Math.sin(rot);
    const T = (x: number, y: number) => `${num(cx + x * c - y * sn)} ${num(cy + x * sn + y * c)}`;
    const d = [
      `${T(rx, 0)} m`,
      `${T(rx, ry * k)} ${T(rx * k, ry)} ${T(0, ry)} c`,
      `${T(-rx * k, ry)} ${T(-rx, ry * k)} ${T(-rx, 0)} c`,
      `${T(-rx, -ry * k)} ${T(-rx * k, -ry)} ${T(0, -ry)} c`,
      `${T(rx * k, -ry)} ${T(rx, -ry * k)} ${T(rx, 0)} c h`,
    ].join(' ');
    this.shape(d, s, f);
  }
  text(x: number, y: number, t: RichText, st: TextStyle, rotate = 0) {
    const face = faceFor(st.family, st.weight === 'bold', !!st.italic);
    this.fontsUsed.set(face.data.base, face);
    const rs = runs(t).filter((r) => r.text);
    const widths = rs.map((r) => (advance(face, r.text) * runSize(r, st.size)) / 1000);
    const total = widths.reduce((a, b) => a + b, 0);
    const ox = st.align === 'center' ? -total / 2 : st.align === 'right' ? -total : 0;
    const dy = baselineShift(st);
    const ops: string[] = ['q', `1 0 0 1 ${num(x)} ${num(y)} cm`];
    if (rotate) ops.push(`${num(Math.cos(rotate))} ${num(Math.sin(rotate))} ${num(-Math.sin(rotate))} ${num(Math.cos(rotate))} 0 0 cm`);
    const slant = face.oblique ? 0.2126 : 0; // synthetic italic (12 degrees) when no italic face is bundled
    const hexes = rs.map((r) => {
      let hex = '';
      for (const ch of r.text) {
        const g = glyphOf(face, ch.codePointAt(0)!);
        if (g >= 0) hex += g.toString(16).padStart(4, '0');
      }
      return hex;
    });
    const show = (x0: number) => {
      let xx = x0;
      rs.forEach((r, i) => {
        if (hexes[i]) ops.push(`/${face.res} ${num(runSize(r, st.size))} Tf 1 0 ${num(slant)} -1 ${num(xx)} ${num(dy + runShift(r, st.size))} Tm <${hexes[i]}> Tj`);
        xx += widths[i];
      });
    };
    if (st.halo) {
      // the halo: the glyph outlines stroked as plain paths (an artifact, not a second copy of the text: text extraction
      // and editing programs see each label once)
      const a = st.halo.opacity ?? 1;
      let path = '';
      let xx = ox;
      rs.forEach((r, i) => {
        const sz = runSize(r, st.size);
        let gx = xx;
        for (const ch of r.text) {
          const g = glyphOf(face, ch.codePointAt(0)!);
          if (g < 0) continue;
          const gp = glyphPathPdf(face, g, gx, dy + runShift(r, st.size), sz, slant, num);
          if (gp) path += (path ? ' ' : '') + gp;
          gx += ((face.widths[g] ?? 0) * sz) / 1000;
        }
        xx += widths[i];
      });
      if (path) ops.push(`/Artifact BMC q ${a < 1 ? this.alpha(a, 'CA') + ' ' : ''}${rgb(st.halo.color)} RG ${num(st.halo.width * 2)} w 1 j 1 J [] 0 d ${path} S Q EMC`);
    }
    ops.push(`${rgb(st.color)} rg BT 0 Tr`);
    show(ox);
    ops.push('ET', 'Q');
    this.ops.push(ops.join(' '));
  }
  image(src: HTMLCanvasElement | OffscreenCanvas, x: number, y: number, w: number, h: number, smooth = false) {
    const cv = src as HTMLCanvasElement;
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) return;
    const { width: iw, height: ih } = cv;
    const data = ctx.getImageData(0, 0, iw, ih).data;
    const rgbA = new Uint8Array(iw * ih * 3);
    const alpha = new Uint8Array(iw * ih);
    let hasAlpha = false;
    for (let i = 0, j = 0, k = 0; i < data.length; i += 4, j += 3, k++) {
      rgbA[j] = data[i];
      rgbA[j + 1] = data[i + 1];
      rgbA[j + 2] = data[i + 2];
      alpha[k] = data[i + 3];
      if (data[i + 3] !== 255) hasAlpha = true;
    }
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, w: iw, h: ih, rgb: rgbA, alpha: hasAlpha ? alpha : null, smooth });
    // image space: unit square, flipped because our CTM has y down
    this.ops.push(`q ${num(w)} 0 0 ${num(-h)} ${num(x)} ${num(y + h)} cm /${name} Do Q`);
  }

  /** Assemble a single-page PDF. */
  toBytes(meta: { title?: string } = {}): Uint8Array {
    return buildPdf([this], meta);
  }

  /** internal: page resources for document assembly */
  _parts() {
    return { ops: this.ops, images: this.images, gstates: this.gstates, fonts: this.fontsUsed, w: this.widthPx, h: this.heightPx };
  }
}


/** Assemble a (multi-page) PDF document from painters. */
export function buildPdf(pages: PdfPainter[], meta: { title?: string } = {}): Uint8Array {
  const objs: (Uint8Array | string)[] = [];
  const add = (o: Uint8Array | string) => {
    objs.push(o);
    return objs.length;
  };
  const stream = (dict: string, bytes: Uint8Array) => {
    const head = enc.encode(`<< ${dict} /Length ${bytes.length} >>\nstream\n`);
    const tail = enc.encode('\nendstream');
    const out = new Uint8Array(head.length + bytes.length + tail.length);
    out.set(head, 0);
    out.set(bytes, head.length);
    out.set(tail, head.length + bytes.length);
    return out;
  };
  const catalogId = add('');
  const pagesId = add('');
  const fontIds: Record<string, number> = {};
  /** Type0 font with an Identity-H CIDFontType2 descendant: the TrueType subset embedded as FontFile2, widths and ToUnicode */
  const addFont = (f: EmbedFace): number => {
    const d = f.data;
    let h = 0;
    for (const ch of d.base) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    let tag = '';
    for (let i = 0; i < 6; i++, h = Math.floor(h / 26)) tag += String.fromCharCode(65 + (h % 26));
    const name = `${tag}+${d.base}`;
    const z = ttfZlib(f);
    const file = add(stream(`/Length1 ${d.len} /Filter /FlateDecode`, z));
    const desc = add(
      `<< /Type /FontDescriptor /FontName /${name} /Flags ${d.flags} /FontBBox [${d.bbox.join(' ')}] /ItalicAngle ${num(d.italic)} /Ascent ${d.asc} /Descent ${d.desc} /CapHeight ${d.cap} /StemV ${d.stemV} /FontFile2 ${file} 0 R >>`,
    );
    const ws: string[] = [];
    for (let g = 0; g < f.widths.length; g++) ws.push(String(f.widths[g]));
    const cid = add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 /W [0 [${ws.join(' ')}]] /CIDToGIDMap /Identity >>`,
    );
    // ToUnicode: every glyph to its (first) code point, so text can be searched and copied
    const uni = new Map<number, number>();
    [...f.gid.entries()].sort((a, b) => a[0] - b[0]).forEach(([cp, g]) => {
      if (!uni.has(g)) uni.set(g, cp);
    });
    const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
    const entries = [...uni.entries()].sort((a, b) => a[0] - b[0]);
    let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    for (let i = 0; i < entries.length; i += 100) {
      const blk = entries.slice(i, i + 100);
      cmap += `${blk.length} beginbfchar\n${blk.map(([g, cp]) => `<${hex4(g)}> <${hex4(cp)}>`).join('\n')}\nendbfchar\n`;
    }
    cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
    const tu = add(stream('/Filter /FlateDecode', zlibSync(enc.encode(cmap))));
    return add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`);
  };
  const pageIds: number[] = [];
  for (const pg of pages) {
    const { ops, images, gstates, fonts, w, h } = pg._parts();
    for (const f of fonts.values()) if (!fontIds[f.res]) fontIds[f.res] = addFont(f);
    const imgIds: Record<string, number> = {};
    for (const im of images) {
      let smaskRef = '';
      if (im.alpha) {
        const sid = add(stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, zlibSync(im.alpha)));
        smaskRef = ` /SMask ${sid} 0 R`;
      }
      imgIds[im.name] = add(
        stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${im.smooth ? ' /Interpolate true' : ''}${smaskRef}`, zlibSync(im.rgb)),
      );
    }
    const gsIds: Record<string, number> = {};
    for (const [key, name] of gstates) {
      const kind = key.slice(0, 2);
      const v = Number(key.slice(2)) / 1000;
      gsIds[name] = add(`<< /Type /ExtGState /${kind} ${num(v)} >>`);
    }
    const contentId = add(stream('/Filter /FlateDecode', zlibSync(enc.encode(ops.join('\n')))));
    const res = `<< /Font << ${[...new Set([...fonts.values()].map((f) => f.res))].map((r) => `/${r} ${fontIds[r]} 0 R`).join(' ')} >> /XObject << ${Object.entries(imgIds)
      .map(([n, id]) => `/${n} ${id} 0 R`)
      .join(' ')} >> /ExtGState << ${Object.entries(gsIds)
      .map(([n, id]) => `/${n} ${id} 0 R`)
      .join(' ')} >> >>`;
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(w * 0.75)} ${num(h * 0.75)}] /Resources ${res} /Contents ${contentId} 0 R >>`));
  }
  objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const infoId = add(`<< /Producer ${pdfTextString(APP_NAME)} /Title ${pdfTextString(meta.title ?? 'Figure')} >>`);
  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array) => {
    parts.push(b);
    offset += b.length;
  };
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(offset);
    push(enc.encode(`${i + 1} 0 obj\n`));
    push(typeof o === 'string' ? enc.encode(o) : o);
    push(enc.encode('\nendobj\n'));
  });
  const xref = offset;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) x += `${String(o).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(enc.encode(x));
  const out = new Uint8Array(offset);
  let p = 0;
  for (const b of parts) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}
