// Plot images for the AI assistant: the plot drawn offscreen (512 px, axes and ticks, no title) with a light coordinate
// grid in plot-frame units (0..1, origin bottom-left) labelled along the top and right edges, so the model can report
// positions that map 1:1 onto the auto gate's display space. With names hidden the plot is drawn from a copy of the
// workspace whose samples are named "Sample 1..n" (as in the text sent), without typed layer labels or axis titles, so a
// legend (overlay, legend statistic) or any automatic title shows no sample or file name.
import { engine } from '../core/engine';
import type { PlotItem, Workspace } from '../core/model';
import { CanvasPainter } from '../render/painter';
import { renderPlot, type PlotGeometry } from '../render/plot';
import { anon } from './context';

export interface AiPlotImage {
  blob: Blob;
  /** object URL for the preview (revoke when done) */
  url: string;
  geom: PlotGeometry;
}

export interface AiRenderOptions {
  /** output size in device pixels (square) */
  px?: number;
  grid?: boolean;
  /** gate label style on the image */
  gateLabel?: PlotItem['options']['gateLabel'];
}

/** logical size of the drawing (fonts are in pt, so this sets the text size relative to the image) */
const L = 340;
const GRID = '#0b4fd6';

/**
 * What the AI image is drawn from: a copy of the plot (own id, so no margin alignment with the sheet; pseudocolor; no
 * title / legend / color bar; white background) and the workspace, with sample and file names replaced by "Sample n"
 * (and typed layer labels / axis titles left out) while names are hidden. Settings are read now, at render time.
 */
export function aiRenderInput(ws: Workspace, item: PlotItem, o: AiRenderOptions = {}): { ws: Workspace; item: PlotItem } {
  const hist = item.plotType === 'histogram';
  const grid = o.grid !== false;
  const padT = grid ? 20 : 4;
  const padR = grid && !hist ? 30 : 8;
  const hide = anon();
  const it: PlotItem = {
    ...item,
    id: 'ai-render',
    x: 0,
    y: 0,
    w: L - padR,
    h: L - padT,
    plotType: hist ? 'histogram' : 'pseudo',
    // typed layer labels may name samples or donors: the automatic label ("Sample n" / population) instead
    layers: hide ? item.layers.map((l) => ({ ...l, label: undefined })) : item.layers,
    options: {
      ...item.options,
      showTitle: false,
      title: undefined,
      titleMode: undefined,
      legend: false,
      colorBar: 'none',
      colorMode: 'density',
      colormap: 'flowjo',
      cmapReverse: false,
      bg: 'white',
      fontSize: 9,
      lineWidth: 1,
      boldLabels: false,
      gateLabel: o.gateLabel ?? 'name',
      gateColor: undefined,
      labelOff: undefined,
      labelPos: undefined,
      // typed axis titles are free text: the channel / marker names (as in the text sent) instead
      ...(hide ? { xLabel: undefined, yLabel: undefined } : {}),
    },
  };
  // the legend (legend statistic, overlays) and automatic titles name samples by ws.samples[i].name
  const w: Workspace = hide ? { ...ws, samples: ws.samples.map((s, i) => ({ ...s, name: `Sample ${i + 1}`, fileName: `Sample ${i + 1}.fcs` })) } : ws;
  return { ws: w, item: it };
}

export function renderAiCanvas(ws: Workspace, item: PlotItem, sampleId: string, o: AiRenderOptions = {}): { canvas: HTMLCanvasElement; geom: PlotGeometry } {
  const px = o.px ?? 512;
  const hist = item.plotType === 'histogram';
  const grid = o.grid !== false;
  const padT = grid ? 20 : 4;
  const k = px / L;
  const cv = document.createElement('canvas');
  cv.width = px;
  cv.height = px;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const p = new CanvasPainter(ctx, k);
  const { ws: w, item: it } = aiRenderInput(ws, item, o);
  p.save();
  p.translate(0, padT);
  const geom = renderPlot(p, it, it.w, it.h, { ws: w, engine, activeSampleId: sampleId, selectedPopId: null, rasterScale: k, makeCanvas: canvasOf, forExport: true });
  p.restore();
  if (grid && geom.hasData) drawGrid(p, geom, padT, hist);
  return { canvas: cv, geom };
}

function canvasOf(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawGrid(p: CanvasPainter, g: PlotGeometry, dy: number, hist: boolean) {
  const f = { x: g.frame.x, y: g.frame.y + dy, w: g.frame.w, h: g.frame.h };
  const st = { family: 'Arial, Helvetica, sans-serif', size: 9.5, weight: 'bold' as const, color: GRID, halo: { color: '#ffffff', width: 2.2, opacity: 0.9 } };
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const x = f.x + t * f.w;
    const major = i % 5 === 0;
    const line = { color: GRID, width: major ? 0.8 : 0.5, opacity: major ? 0.5 : 0.32 };
    p.line(x, f.y, x, f.y + f.h, line);
    p.text(x, f.y - 3, t.toFixed(1), { ...st, align: i === 0 ? 'left' : i === 10 ? 'right' : 'center', baseline: 'bottom' });
    if (hist) continue;
    const y = f.y + (1 - t) * f.h;
    p.line(f.x, y, f.x + f.w, y, line);
    p.text(f.x + f.w + 3, y, t.toFixed(1), { ...st, align: 'left', baseline: i === 0 ? 'bottom' : i === 10 ? 'top' : 'middle' });
  }
}

export async function renderAiImage(ws: Workspace, item: PlotItem, sampleId: string, o: AiRenderOptions = {}): Promise<AiPlotImage> {
  const { canvas, geom } = renderAiCanvas(ws, item, sampleId, o);
  const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not encode the plot image'))), 'image/png'));
  return { blob, url: URL.createObjectURL(blob), geom };
}
