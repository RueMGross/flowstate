// Figure export of a worksheet (or a selection of items) to SVG, PDF, PNG and TIFF.
import { engine } from '../core/engine';
import { MM, type SheetItem, type Worksheet } from '../core/model';
import { renderItem, renderPageBackground, renderSheet } from '../render/items';
import { CanvasPainter, SvgPainter } from '../render/painter';
import { buildPdf, PdfPainter } from '../render/pdf';
import { strToU8, zipSync } from 'fflate';
import type { RenderEnv } from '../render/plot';
import { useStore } from '../state/store';
import { safeName, saveFile } from './files';
import { crc32, PngWriter } from './pngEncode';
import { rgbaRow, TiffWriter } from './tiff';

export type FigureFormat = 'svg' | 'pdf' | 'png' | 'tiff';

export interface FigureOptions {
  format: FigureFormat;
  scope: 'page' | 'selection';
  pages?: 'current' | 'perSample' | 'allSheets';
  sampleIds?: string[];
  dpi: number; // png / tiff resolution, and raster resolution of dot layers in svg/pdf
  margin: number; // px around a selection
  transparent: boolean; // no page background (also when the sheet's page color is not exported); plot backgrounds follow each plot's setting
  /** whole-page export: also include items lying (partly) outside the page; the exported area grows to hold them */
  includeOutside?: boolean;
}

/** Largest bitmap export (pixels); beyond it PDF / SVG or a lower resolution is the way. */
export const MAX_EXPORT_PIXELS = 400e6;
/** Bitmaps up to this size are drawn on one canvas and encoded by the browser; larger ones in bands. */
const SINGLE_CANVAS_PIXELS = 100e6;
const SINGLE_CANVAS_SIDE = 16000;

type Box = { x: number; y: number; w: number; h: number };

const canvasFactory = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** Items lying (partly) outside the page (0.5 px tolerance). */
export function itemsOutsidePage(sheet: Worksheet, items: SheetItem[] = sheet.items): SheetItem[] {
  return items.filter((i) => i.x < -0.5 || i.y < -0.5 || i.x + i.w > sheet.page.w + 0.5 || i.y + i.h > sheet.page.h + 0.5);
}

/** The exported region in page coordinates (px). */
export function figureBounds(sheet: Worksheet, items: SheetItem[], opts: Pick<FigureOptions, 'scope' | 'margin' | 'includeOutside'>): Box {
  if (opts.scope === 'page' || !items.length) {
    const b = { x: 0, y: 0, w: sheet.page.w, h: sheet.page.h };
    if (!opts.includeOutside || !itemsOutsidePage(sheet, items).length) return b;
    const x0 = Math.min(0, ...items.map((i) => i.x));
    const y0 = Math.min(0, ...items.map((i) => i.y));
    const x1 = Math.max(sheet.page.w, ...items.map((i) => i.x + i.w));
    const y1 = Math.max(sheet.page.h, ...items.map((i) => i.y + i.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const m = Math.max(0, opts.margin);
  const x0 = Math.min(...items.map((i) => i.x)) - m;
  const y0 = Math.min(...items.map((i) => i.y)) - m;
  const x1 = Math.max(...items.map((i) => i.x + i.w)) + m;
  const y1 = Math.max(...items.map((i) => i.y + i.h)) + m;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Pixel size of a bitmap export of region `b` at `dpi`: whole pixels covering the region (rounded up, so the last row and
 * column are not cut; the page color fills them, see fillDevice).
 */
export function rasterSize(b: Pick<Box, 'w' | 'h'>, dpi: number): { w: number; h: number; pixels: number } {
  const k = dpi / 96;
  const w = Math.max(1, Math.ceil(b.w * k - 1e-6));
  const h = Math.max(1, Math.ceil(b.h * k - 1e-6));
  return { w, h, pixels: w * h };
}

/**
 * Opaque exports: paint the page color over the whole canvas in device pixels first. The page rectangle in CSS px ends
 * inside the last pixel column / row when the size is not a whole number of pixels; without this, those pixels would be
 * half transparent (a faint line at the right and bottom edges).
 */
function fillDevice(ctx: CanvasRenderingContext2D, sheet: Worksheet, transparent: boolean) {
  if (transparent || sheet.exportPage === false) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = sheet.pageColor ?? '#ffffff';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/** Message when a bitmap export would be too large, else null. */
export function rasterTooLarge(b: Pick<Box, 'w' | 'h'>, dpi: number): string | null {
  const r = rasterSize(b, dpi);
  if (r.pixels <= MAX_EXPORT_PIXELS) return null;
  return `At ${dpi} dpi the image would be ${r.w.toLocaleString('en-US')} x ${r.h.toLocaleString('en-US')} pixels (${Math.round(r.pixels / 1e6)} megapixels), more than this browser can make (${Math.round(MAX_EXPORT_PIXELS / 1e6)} megapixels). Choose a lower resolution, or PDF / SVG (vector, any size).`;
}

function envFor(rasterScale: number, sampleId?: string | null): RenderEnv {
  const { ws, ui } = useStore.getState();
  return { ws, engine, activeSampleId: sampleId !== undefined ? sampleId : ui.activeSampleId, selectedPopId: null, rasterScale, makeCanvas: canvasFactory, forExport: true };
}

const sheetItems = (sheet: Worksheet, itemIds: string[], opts: FigureOptions) => (opts.scope === 'selection' ? sheet.items.filter((i) => itemIds.includes(i.id)) : sheet.items);

export function renderFigure(sheet: Worksheet, itemIds: string[], opts: FigureOptions, sampleId?: string | null): { bytes: Uint8Array | Blob | string; ext: string } | Promise<{ bytes: Uint8Array; ext: string }> {
  const items = sheetItems(sheet, itemIds, opts);
  const b = figureBounds(sheet, items, opts);
  const rasterScale = Math.max(1, opts.dpi / 96);
  if (opts.format === 'svg') {
    const p = new SvgPainter('f');
    renderPageBackground(p, sheet, b, opts.transparent);
    renderSheet(p, sheet, items, envFor(rasterScale, sampleId), b);
    const wmm = (b.w / MM).toFixed(2);
    const hmm = (b.h / MM).toFixed(2);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${wmm}mm" height="${hmm}mm" viewBox="0 0 ${b.w.toFixed(2)} ${b.h.toFixed(2)}">\n${p.toString()}\n</svg>\n`;
    return { bytes: svg, ext: 'svg' };
  }
  if (opts.format === 'pdf') {
    return { bytes: pdfPage(sheet, itemIds, opts, sampleId).toBytes({ title: sheet.name }), ext: 'pdf' };
  }
  return renderBitmap(sheet, items, b, opts, sampleId);
}

async function renderBitmap(sheet: Worksheet, items: SheetItem[], b: Box, opts: FigureOptions, sampleId?: string | null): Promise<{ bytes: Uint8Array; ext: string }> {
  const tooLarge = rasterTooLarge(b, opts.dpi);
  if (tooLarge) throw new Error(tooLarge);
  const k = opts.dpi / 96;
  const { w: W, h: H, pixels } = rasterSize(b, opts.dpi);
  // PNG: flat RGB unless a transparent background was asked for (or the page color is not exported)
  const pngChannels: 3 | 4 = opts.transparent || sheet.exportPage === false ? 4 : 3;
  if (opts.format === 'png' && pixels <= SINGLE_CANVAS_PIXELS && W <= SINGLE_CANVAS_SIDE && H <= SINGLE_CANVAS_SIDE) {
    const cv = canvasFactory(W, H);
    // RGB PNGs are read back from the canvas in bands: several readbacks of one canvas are faster from memory
    // (willReadFrequently); a single readback (or the browser's own encoder) keeps the accelerated canvas
    const bands = pngChannels === 3 ? Math.ceil(H / Math.max(1, Math.min(H, Math.floor(16e6 / (W * 4))))) : 1;
    const ctx = bands > 1 ? cv.getContext('2d', { willReadFrequently: true }) : cv.getContext('2d');
    if (ctx) {
      fillDevice(ctx, sheet, opts.transparent);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      const cp = new CanvasPainter(ctx, k);
      renderPageBackground(cp, sheet, b, opts.transparent);
      renderSheet(cp, sheet, items, envFor(k, sampleId), b);
      if (pngChannels === 3) {
        // RGB: encoded here from the canvas in bands (the browser's encoder always writes RGBA)
        const pw = new PngWriter(W, H, 3, opts.dpi);
        const BH = Math.max(1, Math.min(H, Math.floor(16e6 / (W * 4))));
        const row = new Uint8Array(W * 3);
        for (let y = 0; y < H; y += BH) {
          const bh = Math.min(BH, H - y);
          const d = ctx.getImageData(0, y, W, bh).data;
          const out = new Uint8Array(W * bh * 3);
          for (let r = 0; r < bh; r++) {
            rgbaRow(d, r * W * 4, W, row, 3);
            out.set(row, r * W * 3);
          }
          pw.addRows(out, bh);
          if (H > BH) await new Promise((res) => setTimeout(res, 0));
        }
        cv.width = cv.height = 0;
        return { bytes: new Uint8Array(await pw.finish().arrayBuffer()), ext: 'png' };
      }
      const blob = await new Promise<Blob | null>((resolve) => cv.toBlob(resolve, 'image/png'));
      cv.width = cv.height = 0;
      if (blob) return { bytes: withPngDpi(new Uint8Array(await blob.arrayBuffer()), opts.dpi), ext: 'png' };
    }
    // the browser could not make this canvas: fall through to banded rendering
  }
  if (opts.format === 'tiff') {
    // journals want flat RGB images: transparency only when asked for
    const channels: 3 | 4 = opts.transparent ? 4 : 3;
    const tw = new TiffWriter({ width: W, height: H, channels, dpi: opts.dpi });
    const row = new Uint8Array(W * channels);
    await rasterBands(sheet, items, b, k, opts.transparent, sampleId, (rgba, width, rows) => {
      for (let r = 0; r < rows; r++) {
        rgbaRow(rgba, r * width * 4, width, row, channels);
        tw.addRows(row, 1);
      }
    });
    return { bytes: new Uint8Array(await tw.finish().arrayBuffer()), ext: 'tif' };
  }
  const channels = pngChannels;
  const pw = new PngWriter(W, H, channels, opts.dpi);
  await rasterBands(sheet, items, b, k, opts.transparent, sampleId, (rgba, width, rows) => {
    if (channels === 4) pw.addRows(new Uint8Array(rgba.buffer, rgba.byteOffset, width * rows * 4), rows);
    else {
      const out = new Uint8Array(width * rows * 3);
      const row = new Uint8Array(width * 3);
      for (let r = 0; r < rows; r++) {
        rgbaRow(rgba, r * width * 4, width, row, 3);
        out.set(row, r * width * 3);
      }
      pw.addRows(out, rows);
    }
  });
  return { bytes: new Uint8Array(await pw.finish().arrayBuffer()), ext: 'png' };
}

/**
 * Render region `b` at `k` device pixels per px in horizontal bands (each band in tiles of at most 4096 px), so images
 * larger than any canvas can be made. Each item is rasterized once on its own canvas (at a whole-pixel offset, so no
 * resampling) and composited into the tiles it touches; rasters are freed once the bands have passed them.
 */
async function rasterBands(
  sheet: Worksheet,
  items: SheetItem[],
  b: Box,
  k: number,
  transparent: boolean,
  sampleId: string | null | undefined,
  sink: (rgba: Uint8ClampedArray, width: number, rows: number) => void,
) {
  const { w: W, h: H } = rasterSize(b, k * 96);
  const TW = Math.min(W, 4096);
  const BH = Math.max(16, Math.min(H, Math.floor(24e6 / (W * 4))));
  const env = envFor(k, sampleId);
  type Raster = { cv: HTMLCanvasElement; px: number; py: number } | null;
  const cache = new Map<string, Raster>();
  const pix = (it: SheetItem) => {
    const x0 = (it.x - b.x) * k;
    const y0 = (it.y - b.y) * k;
    return { x0, y0, x1: x0 + it.w * k, y1: y0 + it.h * k };
  };
  const rasterOf = (it: SheetItem): Raster => {
    const r = pix(it);
    const px = Math.floor(r.x0);
    const py = Math.floor(r.y0);
    const cw = Math.max(1, Math.ceil(r.x1) - px);
    const ch = Math.max(1, Math.ceil(r.y1) - py);
    if (cw > 8192 || ch > 8192 || cw * ch > 48e6) return null; // drawn into each tile instead
    const cv = canvasFactory(cw, ch);
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(k, 0, 0, k, r.x0 - px, r.y0 - py);
    const p = new CanvasPainter(ctx, k);
    p.save();
    p.clipRect(0, 0, it.w, it.h);
    renderItem(p, it, env);
    p.restore();
    return { cv, px, py };
  };
  for (let y = 0; y < H; y += BH) {
    const bh = Math.min(BH, H - y);
    const band = new Uint8ClampedArray(W * bh * 4);
    for (let x = 0; x < W; x += TW) {
      const tw = Math.min(TW, W - x);
      const cv = canvasFactory(tw, bh);
      const ctx = cv.getContext('2d');
      if (!ctx) throw new Error('The browser could not allocate an image tile.');
      fillDevice(ctx, sheet, transparent);
      ctx.setTransform(k, 0, 0, k, -x, -y);
      renderPageBackground(new CanvasPainter(ctx, k), sheet, b, transparent);
      for (const it of items) {
        const r = pix(it);
        if (r.x1 <= x || r.x0 >= x + tw || r.y1 <= y || r.y0 >= y + bh) continue;
        let ras = cache.get(it.id);
        if (ras === undefined) {
          ras = rasterOf(it);
          cache.set(it.id, ras);
        }
        if (ras) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(ras.cv, ras.px - x, ras.py - y);
        } else {
          ctx.setTransform(k, 0, 0, k, -x, -y);
          renderSheet(new CanvasPainter(ctx, k), sheet, [it], env, b);
        }
      }
      const img = ctx.getImageData(0, 0, tw, bh).data;
      for (let r = 0; r < bh; r++) band.set(img.subarray(r * tw * 4, (r + 1) * tw * 4), (r * W + x) * 4);
      cv.width = cv.height = 0;
    }
    // rasters of items that end above the next band are done
    for (const it of items) {
      const ras = cache.get(it.id);
      if (ras !== undefined && pix(it).y1 <= y + bh) {
        if (ras) ras.cv.width = ras.cv.height = 0;
        cache.delete(it.id);
      }
    }
    sink(band, W, bh);
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive between bands
  }
  for (const ras of cache.values()) if (ras) ras.cv.width = ras.cv.height = 0;
}

function pdfPage(sheet: Worksheet, itemIds: string[], opts: FigureOptions, sampleId?: string | null): PdfPainter {
  const items = sheetItems(sheet, itemIds, opts);
  const b = figureBounds(sheet, items, opts);
  const p = new PdfPainter(b.w, b.h);
  renderPageBackground(p, sheet, b, opts.transparent);
  renderSheet(p, sheet, items, envFor(Math.max(1, opts.dpi / 96), sampleId), b);
  return p;
}

export async function exportFigure(sheetId: string, itemIds: string[], opts: FigureOptions) {
  const st = useStore.getState();
  const ws = st.ws;
  const sheet = ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  if (opts.scope === 'selection' && !itemIds.length && opts.pages !== 'allSheets') {
    st.toast('Select items on the worksheet first, or export the whole page.', 'info');
    return;
  }
  type Job = { sheet: Worksheet; ids: string[]; sampleId?: string | null; label: string };
  let jobs: Job[];
  if (opts.pages === 'allSheets') jobs = ws.worksheets.map((sh) => ({ sheet: sh, ids: [], label: sh.name }));
  else if (opts.pages === 'perSample') {
    const ids = (opts.sampleIds ?? ws.samples.map((s) => s.id)).filter((id) => engine.has(id));
    jobs = ids.map((id) => ({ sheet, ids: itemIds, sampleId: id, label: ws.samples.find((s) => s.id === id)?.name ?? id }));
  } else jobs = [{ sheet, ids: itemIds, label: sheet.name }];
  const o: FigureOptions = opts.pages === 'allSheets' ? { ...opts, scope: 'page' } : opts;
  const base = `${safeName(ws.name)}_${safeName(sheet.name)}${o.scope === 'selection' ? '_selection' : ''}`;
  if (o.format === 'pdf') {
    const pages = jobs.map((j) => pdfPage(j.sheet, j.ids, o, j.sampleId));
    const bytes = buildPdf(pages, { title: jobs.length > 1 ? ws.name : sheet.name });
    const name = opts.pages === 'allSheets' ? `${safeName(ws.name)}_all_sheets.pdf` : opts.pages === 'perSample' ? `${base}_per_sample.pdf` : `${base}.pdf`;
    await saveFile(name, bytes);
    return;
  }
  if (jobs.length === 1) {
    const res = await renderFigure(jobs[0].sheet, jobs[0].ids, o, jobs[0].sampleId);
    await saveFile(`${base}.${res.ext}`, res.bytes as Uint8Array | string);
    return;
  }
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const j of jobs) {
    const res = await renderFigure(j.sheet, j.ids, o, j.sampleId);
    let nm = `${safeName(j.label)}.${res.ext}`;
    let k = 2;
    while (used.has(nm)) nm = `${safeName(j.label)}_${k++}.${res.ext}`;
    used.add(nm);
    files[nm] = typeof res.bytes === 'string' ? strToU8(res.bytes) : (res.bytes as Uint8Array);
  }
  await saveFile(`${base}_${opts.pages === 'allSheets' ? 'sheets' : 'per_sample'}_${o.format}.zip`, zipSync(files));
}

// ------------------------------------------------------------ PNG pHYs

/** Insert a pHYs chunk so image editors and journals see the intended physical resolution. */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  dv.setUint32(17, (crc32(chunk.subarray(4, 17)) ^ 0xffffffff) >>> 0);
  // IHDR chunk ends at 8 (sig) + 8 + 13 + 4 = 33
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, 33), 0);
  out.set(chunk, 33);
  out.set(png.subarray(33), 33 + chunk.length);
  return out;
}
