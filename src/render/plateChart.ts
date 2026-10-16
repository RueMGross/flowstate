// Plate heatmap: a statistic over the wells of a plate (chart item with `plate`), drawn with the painter so the
// worksheet, PNG / TIFF, SVG and PDF show the same figure.
import type { Engine } from '../core/engine';
import { STAT_LABELS, type ChartItem, type PlateChartDef, type StatColumn, type Workspace } from '../core/model';
import { cellRange, fmtWellValue, plateCells, plateLayout, rangeT, ROW_LETTERS, statDecimals, type PlateLayout, type WellCell } from '../core/plate';
import { colormapColor, luminance, type CmapSpec } from './colormaps';
import { measureRich, type Painter, type TextStyle } from './painter';
import { fitText, panelLetterBox, placeTitle, PT, type RenderEnv } from './plot';
import { itemTheme, statTitle } from './chart';
import { pageColorOf, sheetOf } from './figstyle';

export type PlateChartItem = ChartItem & { plate: PlateChartDef };

export function isPlateChart(it: { kind: string }): it is PlateChartItem {
  if (it.kind !== 'chart') return false;
  const p = (it as { plate?: unknown }).plate as PlateChartDef | undefined;
  return !!p && typeof p === 'object' && typeof p.plate === 'string';
}

// the layout of the last workspace samples / plates (and engine state: keywords of files loaded since)
let memo: { samples: unknown; plates: unknown; version: number; layout: PlateLayout } | null = null;

/** Plates and wells of the workspace (core/plate.ts plateLayout, with the keywords of the loaded files), memoized. */
export function layoutOf(ws: Pick<Workspace, 'samples' | 'plates'>, engine: Pick<Engine, 'keywordsOf' | 'version'>): PlateLayout {
  if (memo && memo.samples === ws.samples && memo.plates === ws.plates && memo.version === engine.version) return memo.layout;
  const layout = plateLayout(ws, engine.keywordsOf);
  memo = { samples: ws.samples, plates: ws.plates, version: engine.version, layout };
  return layout;
}

/**
 * Value of a statistic for a sample in a plate heatmap: null when it does not apply (or the file is not loaded),
 * NaN when it has no value; undefined while a background computation runs (`deferred`, on screen).
 */
export function plateStatValue(ws: Workspace, engine: Engine, sid: string, stat: Pick<StatColumn, 'population' | 'stat' | 'channel' | 'percentile' | 'ofPopulation'>, deferred?: boolean): number | null | undefined {
  if (!engine.has(sid) || engine.statNotApplicable(ws, sid, stat)) return null;
  if (!deferred) return engine.stat(ws, sid, stat);
  const v = engine.statForDisplay(ws, sid, stat);
  return v === null ? undefined : v;
}

/** Short label of a statistic for legends and exports: "% Parent", "Median FITC-A". */
export function statShortLabel(stat: StatColumn): string {
  const s = stat.stat === 'percentile' ? `P${stat.percentile ?? 50}` : STAT_LABELS[stat.stat];
  return stat.channel && !['count', 'freqParent', 'freqTotal', 'freqGrandparent', 'freqOf', 'concentration'].includes(stat.stat) ? `${s} ${stat.channel}` : s;
}

export function cmapSpecOf(d: Pick<PlateChartDef, 'colormap' | 'reverse'>): CmapSpec {
  return { name: d.colormap || 'viridis', reverse: !!d.reverse };
}

/** Fill of a well with a value (colormap position in the range). */
export function wellFill(v: number, range: [number, number], spec: CmapSpec): string {
  return colormapColor(spec, rangeT(v, range));
}

/** Diagonal hatching inside a circle (wells without a value). */
function hatchCircle(p: Painter, cx: number, cy: number, r: number, color: string, width: number) {
  const step = Math.max(2.2, r / 2.6);
  for (let c = -2 * r; c <= 2 * r; c += step) {
    // line y - cy = (x - cx) + c, clipped to the circle: (x')^2 + (x' + c)^2 = r^2
    const disc = 2 * r * r - c * c;
    if (disc <= 0) continue;
    const s = Math.sqrt(disc);
    const x1 = (-c - s) / 2;
    const x2 = (-c + s) / 2;
    p.line(cx + x1, cy + x1 + c, cx + x2, cy + x2 + c, { color, width });
  }
}

export function renderPlateChart(p: Painter, it: PlateChartItem, env: RenderEnv) {
  const { ws, engine } = env;
  const d = it.plate;
  const fs = it.fontSize * PT;
  const lw = Math.max(0.35, it.lineWidth * PT * 0.6);
  const th = itemTheme(it.bg, it.bgColor, pageColorOf(sheetOf(ws, it.id)));
  const fg = th.fg;
  const muted = th.dark ? '#7c8794' : '#9aa3ad';
  const st: TextStyle = { family: ws.style.fontFamily, size: fs, color: fg };
  if (th.bg) p.rect(0, 0, it.w, it.h, null, { color: th.bg });
  const layout = layoutOf(ws, engine);
  const plate = layout.plates.find((x) => x.name === d.plate);
  const title = it.title ?? `${d.plate}: ${statTitle(it, env)}`;
  const T = title ? fs * 1.7 : fs * 0.5;
  if (title) {
    const bst: TextStyle = { ...st, weight: 'bold' };
    const t = placeTitle(title, it.w / 2, it.w - fs * 0.6, it.w, fs * 1.15, bst, panelLetterBox(ws, it.id));
    p.text(t.x, fs * 1.15, t.text, { ...bst, size: t.size, align: 'center' });
  }
  if (!plate) {
    const mst: TextStyle = { ...st, color: muted, align: 'center', baseline: 'middle' };
    p.text(it.w / 2, it.h / 2, fitText(`Plate "${d.plate}" not found`, it.w * 0.9, mst), mst);
    return;
  }
  const valueOf = (sid: string) => plateStatValue(ws, engine, sid, it.stat, env.deferStats);
  const { cells, pending } = plateCells(plate, valueOf);
  // automatic range of this plate, or of all plates (`shared`), unless fixed
  const range = cellRange(d.shared && !d.range ? layout.plates.map((x) => (x === plate ? cells : plateCells(x, valueOf).cells)) : [cells], d.range ?? null);
  const spec = cmapSpecOf(d);
  const dec = statDecimals(it.stat, d.decimals);
  // geometry: row letters left, column numbers on top, legend right
  const hst: TextStyle = { ...st, size: fs * 0.9, color: fg };
  const rowW = Math.max(...Array.from({ length: plate.rows }, (_, r) => measureRich(ROW_LETTERS[r], hst))) + fs * 0.5;
  const legendW = d.legend && range ? fs * 0.9 + fs * 0.4 + Math.max(measureRich(fmtWellValue(range[0], dec, range), hst), measureRich(fmtWellValue(range[1], dec, range), hst)) + fs * 0.6 : 0;
  const colH = fs * 1.2;
  const pad = fs * 0.4;
  const cell = Math.max(2, Math.min((it.w - rowW - legendW - 2 * pad) / plate.cols, (it.h - T - colH - pad) / plate.rows));
  const gw = cell * plate.cols;
  const gh = cell * plate.rows;
  const x0 = rowW + Math.max(pad, (it.w - rowW - legendW - gw) / 2);
  const y0 = T + colH;
  // headers (every column when they fit, else every other one)
  const every = measureRich('24', hst) > cell * 0.95 ? 2 : 1;
  for (let c = 0; c < plate.cols; c++) if (c % every === 0 || c === plate.cols - 1) p.text(x0 + cell * (c + 0.5), y0 - fs * 0.3, String(c + 1), { ...hst, align: 'center', baseline: 'bottom' });
  for (let r = 0; r < plate.rows; r++) p.text(x0 - fs * 0.35, y0 + cell * (r + 0.5), ROW_LETTERS[r], { ...hst, align: 'right', baseline: 'middle' });
  const rad = cell * 0.43;
  const vst: TextStyle = { ...st, size: Math.min(fs, cell * 0.3), align: 'center', baseline: 'middle' };
  const drawCell = (c: WellCell, cx: number, cy: number) => {
    if (!c.samples.length) {
      p.ellipse(cx, cy, rad, rad, 0, { color: muted, width: lw * 0.8 }, null);
      return;
    }
    const v = c.value;
    if (v === null || !Number.isFinite(v) || !range) {
      // no value (n/a, not computed, file missing): hatched
      p.ellipse(cx, cy, rad, rad, 0, { color: fg, width: lw }, th.bg ? { color: th.bg } : null);
      hatchCircle(p, cx, cy, rad * 0.92, muted, lw * 0.7);
      return;
    }
    const fill = wellFill(v, range, spec);
    p.ellipse(cx, cy, rad, rad, 0, { color: fg, width: lw * 0.6 }, { color: fill });
    if (d.values) {
      const txt = fmtWellValue(v, dec, range);
      const w = measureRich(txt, vst);
      const size = w > rad * 1.9 ? (vst.size * rad * 1.9) / w : vst.size;
      if (size >= 3) p.text(cx, cy, txt, { ...vst, size, color: luminance(fill) > 0.18 ? '#000000' : '#ffffff' });
    }
  };
  cells.forEach((row, r) => row.forEach((c, k) => drawCell(c, x0 + cell * (k + 0.5), y0 + cell * (r + 0.5))));
  // legend: color bar with the range
  if (legendW && range) {
    const bx = x0 + gw + fs * 0.9;
    const bw = fs * 0.9;
    const by = y0;
    const bh = gh;
    const n = 48;
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      p.rect(bx, by + bh * (1 - (i + 1) / n), bw, bh / n + 0.3, null, { color: colormapColor(spec, t0 + 0.5 / n) });
    }
    p.rect(bx, by, bw, bh, { color: fg, width: lw * 0.6 }, null);
    const lx = bx + bw + fs * 0.3;
    p.text(lx, by, fmtWellValue(range[1], dec, range), { ...hst, baseline: 'top' });
    p.text(lx, by + bh, fmtWellValue(range[0], dec, range), { ...hst, baseline: 'bottom' });
  }
  if (pending) {
    const mst: TextStyle = { ...st, size: fs * 0.8, color: muted, align: 'right', baseline: 'bottom' };
    p.text(it.w - 2, it.h - 2, 'computing…', mst);
  }
  void gw;
}
