// Layout helpers: free-slot placement, align, distribute, same size, grid arrangement, batch duplication across samples,
// fitting a layout to a smaller page, and item operations (add, duplicate, delete, z-order, clipboard).
import { clampItemGeometry, gateParams, MM, PAGE_SIZES, popById, uid, type GateGeom, type PlotItem, type PlotType, type SheetItem, type StatsBoxItem, type TextItem, type Worksheet, type Workspace } from '../core/model';
import { refContextOf, repairItem, RepairNotes } from '../core/repair';
import { figureBounds, renderFigure, type FigureOptions } from '../io/exportFigure';
import { gateMatchesPlot, PT } from '../render/plot';
import { bodyPt, headerLines, isPanelLabel as isLetter, middleEllipsis, panelLabelPt, titleModeOf, type PanelLabelItem, type PlotOptionsX } from '../render/figstyle';
import { measureRich } from '../render/painter';
import { defaultPlotSize, deletePopulation, newPlotItem, pickDefaultChannels, useStore } from '../state/store';

export type ArrangeMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'distH' | 'distV' | 'sameSize' | 'sameWidth' | 'sameHeight' | 'grid';

type Rect = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------- placement

/**
 * Grid-snapped top-left position for a new w×h item that keeps one grid step away from every existing item.
 * With `near`, the same row right of that point wins, then rows below, then the rest; without it, the first free
 * slot in reading order. Slots inside the page are preferred; if none fits, the item goes below everything
 * (grow the page with growPageToFit). `extra` are rects that count as occupied (items about to be added).
 * `view` (page coordinates; by default, with `near`, the part of the sheet visible on screen; null: none) ranks slots
 * by how much of them is visible, so a new plot next to its parent appears without scrolling the parent away.
 */
export function findFreeSlot(sheet: Worksheet, w: number, h: number, near?: { x: number; y: number }, extra: Rect[] = [], view?: Rect | null): { x: number; y: number } {
  const g = sheet.grid > 0 ? sheet.grid : 10;
  const m = g * 2;
  const round = (v: number) => Math.round(v / g) * g;
  const ceil = (v: number) => Math.ceil(v / g - 1e-6) * g;
  const occ: Rect[] = [...sheet.items, ...extra];
  const free = (x: number, y: number) => occ.every((o) => x >= o.x + o.w + g - 0.5 || x + w + g - 0.5 <= o.x || y >= o.y + o.h + g - 0.5 || y + h + g - 0.5 <= o.y);
  const vis = view === undefined ? (near ? visibleSheetRect(sheet.id) : null) : view;
  // share of the new item that would be hidden (scrolled out of view)
  const hidden = (x: number, y: number) => {
    if (!vis) return 0;
    const iw = Math.max(0, Math.min(x + w, vis.x + vis.w) - Math.max(x, vis.x));
    const ih = Math.max(0, Math.min(y + h, vis.y + vis.h) - Math.max(y, vis.y));
    return 1 - (iw * ih) / Math.max(1, w * h);
  };
  const xs = new Set<number>([m]);
  const ys = new Set<number>([m]);
  for (const o of occ) {
    xs.add(round(o.x));
    xs.add(ceil(o.x + o.w + g));
    ys.add(round(o.y));
    ys.add(ceil(o.y + o.h + g));
  }
  if (near) {
    xs.add(round(near.x));
    ys.add(round(near.y));
  }
  const maxX = sheet.page.w - g + 0.5;
  const maxY = sheet.page.h - g + 0.5;
  const cands: { x: number; y: number; c: number }[] = [];
  for (const y of ys) {
    if (y < 0 || y + h > maxY) continue;
    for (const x of xs) {
      if (x < 0 || x + w > maxX) continue;
      let c: number;
      if (near) {
        const dx = x - near.x;
        const dy = y - near.y;
        if (Math.abs(dy) < 0.5) c = dx >= -0.5 ? dx : 3e6 - dx; // same row: right of near, else left
        else if (dy > 0) c = 1e6 + dy * 4 + Math.abs(dx); // below
        else c = 5e6 - dy * 4 + Math.abs(dx); // above
        c += hidden(x, y) * 1e7; // a fully visible slot first; a slot needing a small scroll beats one far away
      } else c = y * 1e4 + x; // reading order
      cands.push({ x, y, c });
    }
  }
  cands.sort((a, b) => a.c - b.c);
  for (const p of cands) if (free(p.x, p.y)) return { x: p.x, y: p.y };
  const bottom = occ.length ? Math.max(...occ.map((o) => o.y + o.h)) : 0;
  return { x: m, y: occ.length ? ceil(bottom + g) : m };
}

/** The part of a worksheet visible in the worksheet view (page coordinates), or null when it is not shown. */
export function visibleSheetRect(sheetId: string): Rect | null {
  if (typeof document === 'undefined') return null;
  const { ui } = useStore.getState();
  if (ui.view !== 'sheet' || ui.activeSheetId !== sheetId) return null;
  const sc = document.querySelector('.sheet-scroll');
  const page = document.querySelector('.sheet-scroll .page');
  if (!sc || !page) return null;
  const s = sc.getBoundingClientRect();
  const p = page.getBoundingClientRect();
  const z = ui.zoom || 1;
  if (!(s.width > 0 && s.height > 0)) return null;
  return { x: (s.left - p.left) / z, y: (s.top - p.top) / z, w: s.width / z, h: s.height / z };
}

/** Grow `sheet.page` in place (inside a store update) so all rects fit with one grid step of margin. Returns true if it grew. */
export function growPageToFit(sheet: Pick<Worksheet, 'page' | 'grid'>, rects: Rect[]): boolean {
  const g = sheet.grid > 0 ? sheet.grid : 10;
  let w = sheet.page.w;
  let h = sheet.page.h;
  for (const r of rects) {
    w = Math.max(w, Math.ceil(r.x + r.w + g));
    h = Math.max(h, Math.ceil(r.y + r.h + g));
  }
  if (w === sheet.page.w && h === sheet.page.h) return false;
  sheet.page = { w, h, name: 'custom' };
  return true;
}

/** Scroll the worksheet so the given items are visible (after the next render). */
export function revealItems(ids: string[]) {
  if (!ids.length || typeof requestAnimationFrame === 'undefined') return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const scroller = document.querySelector('.sheet-scroll');
      const rs = ids
        .map((id) => document.querySelector(`.page [data-item-id="${CSS.escape(id)}"]`)?.getBoundingClientRect())
        .filter((r): r is DOMRect => !!r);
      if (!scroller || !rs.length) return;
      const sr = scroller.getBoundingClientRect();
      const l = Math.min(...rs.map((r) => r.left));
      const t = Math.min(...rs.map((r) => r.top));
      const r = Math.max(...rs.map((x) => x.right));
      const b = Math.max(...rs.map((x) => x.bottom));
      const pad = 24;
      const dx = l < sr.left + pad || r - l > sr.width - 2 * pad ? l - sr.left - pad : r > sr.right - pad ? r - sr.right + pad : 0;
      const dy = t < sr.top + pad || b - t > sr.height - 2 * pad ? t - sr.top - pad : b > sr.bottom - pad ? b - sr.bottom + pad : 0;
      if (dx || dy) scroller.scrollBy({ left: dx, top: dy });
    }),
  );
}

/** Add items to a sheet (growing the page when needed), select them and scroll them into view. */
export function addItems(sheetId: string, items: SheetItem[], opts: { select?: boolean; key?: string } = {}) {
  if (!items.length) return;
  const st = useStore.getState();
  // positions and sizes within the limits (a pasted or computed item must not make the page grow without bound)
  for (const it of items) clampItemGeometry(it);
  st.update((w) => {
    const sh = w.worksheets.find((s) => s.id === sheetId);
    if (!sh) return;
    sh.items.push(...items);
    growPageToFit(sh, items);
  }, opts.key);
  if (opts.select !== false) st.setUI({ view: 'sheet', activeSheetId: sheetId, selectedItemIds: items.map((i) => i.id), selectedPopId: null, keyItemId: null });
  revealItems(items.map((i) => i.id));
}

export interface PopPlotSpec {
  type: Extract<PlotType, 'pseudo' | 'histogram'>;
  x: string;
  y: string;
}

/** Plot of a gate's channels: one-parameter gates (range, split) give a histogram, Boolean gates nothing. */
function gateSpec(g: GateGeom): PopPlotSpec | null {
  const prm = gateParams(g);
  return prm.length === 1 ? { type: 'histogram', x: prm[0], y: prm[0] } : prm.length === 2 ? { type: 'pseudo', x: prm[0], y: prm[1] } : null;
}

/** Plot type and axes of the first child gate of a population (where the next gating step happens), or null. */
export function childGateSpec(ws: Workspace, popId: string): PopPlotSpec | null {
  for (const k of ws.populations) {
    if ((k.parentId ?? 'root') !== popId) continue;
    const s = gateSpec(k.gate);
    if (s) return s;
  }
  return null;
}

/**
 * Plot type and axes for a new plot of a population (double-click in the tree, population menu, drag onto the page,
 * Inspector): the axes of its first child gate (where the next gate is drawn), else those of its own gate, else forward /
 * side scatter. One-parameter gates (range, split) give a histogram.
 */
export function populationPlotSpec(ws: Workspace, popId: string): PopPlotSpec {
  const kid = childGateSpec(ws, popId);
  if (kid) return kid;
  const own = popId === 'root' ? undefined : popById(ws, popId);
  const s = own ? gateSpec(own.gate) : null;
  if (s) return s;
  const { fsc, ssc } = pickDefaultChannels(ws, { popId: null });
  return { type: 'pseudo', x: fsc, y: ssc };
}

/** New plot of a population at a free slot (below the other items in reading order, or right of `near`). */
export function addPlotAt(sheetId: string, make: (x: number, y: number, w: number, h: number) => PlotItem, near?: { x: number; y: number }): PlotItem | null {
  const sheet = useStore.getState().ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return null;
  const { w, h } = defaultPlotSize();
  const p = findFreeSlot(sheet, w, h, near);
  const it = make(p.x, p.y, w, h);
  addItems(sheetId, [it]);
  return it;
}

// ---------------------------------------------------------------- align / distribute

/** Default gap between items arranged as a grid (mm). */
export const GRID_GAP_MM = 3;

/** Gap for "Arrange as grid" chosen last (mm; kept in this browser). */
export function arrangeGapMm(): number {
  try {
    const v = Number(localStorage.getItem('fs.arrangeGap'));
    return Number.isFinite(v) && v >= 0 && v <= 50 && localStorage.getItem('fs.arrangeGap') !== null ? v : GRID_GAP_MM;
  } catch {
    return GRID_GAP_MM;
  }
}
export function setArrangeGapMm(v: number) {
  try {
    localStorage.setItem('fs.arrangeGap', String(v));
  } catch {
    /* storage unavailable */
  }
}

/** Positions rounded to 1/1000 mm (no drift of repeated float arithmetic). */
const cleanPx = (v: number) => Math.round((v / MM) * 1000) / 1000 * MM;

/** Items in reading order, as rows: an item starts a new row when it lies below the middle of the row's first item. */
export function readingRows<T extends Rect>(items: T[]): T[][] {
  const byY = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];
  for (const it of byY) {
    const row = rows[rows.length - 1];
    if (row && it.y < row[0].y + row[0].h / 2) row.push(it);
    else rows.push([it]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

export function arrange(sheetId: string, ids: string[], mode: ArrangeMode, opts: { cols?: number; gap?: number } = {}) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  // panel letters move with their items (below), they are not arranged themselves
  const items = (ids.map((id) => sheet.items.find((i) => i.id === id)).filter(Boolean) as SheetItem[]).filter((i) => !(isLetter(i) && ids.includes(i.forItem ?? '')));
  if (!items.length) return;
  // reference for "same size": the most recently clicked item, else the first selected
  const ref = items.find((i) => i.id === st.ui.keyItemId) ?? items[0];
  const snap = (v: number) => (sheet.snap && sheet.grid > 0 ? Math.round(v / sheet.grid) * sheet.grid : v);
  const pos: Record<string, Partial<SheetItem>> = {};
  // a single item is aligned to the page
  const one = items.length === 1;
  const minX = one ? 0 : Math.min(...items.map((i) => i.x));
  const minY = one ? 0 : Math.min(...items.map((i) => i.y));
  const maxR = one ? sheet.page.w : Math.max(...items.map((i) => i.x + i.w));
  const maxB = one ? sheet.page.h : Math.max(...items.map((i) => i.y + i.h));
  switch (mode) {
    case 'left':
      items.forEach((i) => (pos[i.id] = { x: minX }));
      break;
    case 'right':
      items.forEach((i) => (pos[i.id] = { x: maxR - i.w }));
      break;
    case 'hcenter': {
      const c = (minX + maxR) / 2;
      items.forEach((i) => (pos[i.id] = { x: c - i.w / 2 }));
      break;
    }
    case 'top':
      items.forEach((i) => (pos[i.id] = { y: minY }));
      break;
    case 'bottom':
      items.forEach((i) => (pos[i.id] = { y: maxB - i.h }));
      break;
    case 'vcenter': {
      const c = (minY + maxB) / 2;
      items.forEach((i) => (pos[i.id] = { y: c - i.h / 2 }));
      break;
    }
    case 'distH': {
      const sorted = [...items].sort((a, b) => a.x - b.x);
      const total = sorted.reduce((a, i) => a + i.w, 0);
      const gap = sorted.length > 1 ? (maxR - minX - total) / (sorted.length - 1) : 0;
      let x = minX;
      for (const i of sorted) {
        pos[i.id] = { x };
        x += i.w + gap;
      }
      break;
    }
    case 'distV': {
      const sorted = [...items].sort((a, b) => a.y - b.y);
      const total = sorted.reduce((a, i) => a + i.h, 0);
      const gap = sorted.length > 1 ? (maxB - minY - total) / (sorted.length - 1) : 0;
      let y = minY;
      for (const i of sorted) {
        pos[i.id] = { y };
        y += i.h + gap;
      }
      break;
    }
    case 'sameSize':
      items.forEach((i) => (pos[i.id] = { w: ref.w, h: ref.h }));
      break;
    case 'sameWidth':
      items.forEach((i) => (pos[i.id] = { w: ref.w }));
      break;
    case 'sameHeight':
      items.forEach((i) => (pos[i.id] = { h: ref.h }));
      break;
    case 'grid': {
      // Reading order; as many columns as the longest row of the current layout (wrapped at the page width), exactly
      // equal gaps (only the grid's top-left corner snaps to the grid), each column as wide as its widest item and each
      // row as tall as its tallest. Same-size plots then share their data frames (render/plot.ts alignedMargins).
      const rows0 = readingRows(items);
      const sorted = rows0.flat();
      const n = sorted.length;
      const gap = opts.gap ?? arrangeGapMm() * MM;
      const gx = snap(Math.min(...items.map((i) => i.x)));
      const gy = snap(Math.min(...items.map((i) => i.y)));
      const wMax = Math.max(...sorted.map((i) => i.w));
      const fit = Math.max(1, Math.floor((sheet.page.w - gx + gap + 0.5) / (wMax + gap)));
      const longest = Math.max(...rows0.map((r) => r.length));
      const cols = Math.max(1, Math.min(n, opts.cols ?? Math.min(longest, fit)));
      const colW: number[] = [];
      const rowH: number[] = [];
      sorted.forEach((i, k) => {
        const r = Math.floor(k / cols);
        const c = k % cols;
        colW[c] = Math.max(colW[c] ?? 0, i.w);
        rowH[r] = Math.max(rowH[r] ?? 0, i.h);
      });
      const xs = [gx];
      for (let c = 1; c < cols; c++) xs[c] = xs[c - 1] + colW[c - 1] + gap;
      const ys = [gy];
      for (let r = 1; r < rowH.length; r++) ys[r] = ys[r - 1] + rowH[r - 1] + gap;
      sorted.forEach((i, k) => {
        pos[i.id] = { x: cleanPx(xs[k % cols]), y: cleanPx(ys[Math.floor(k / cols)]) };
      });
      break;
    }
  }
  // panel letters keep their place on their item
  for (const l of sheet.items) {
    if (!isLetter(l) || !l.forItem || pos[l.id]) continue;
    const host = sheet.items.find((i) => i.id === l.forItem);
    const p = host && pos[host.id];
    if (!host || !p || (p.x === undefined && p.y === undefined)) continue;
    pos[l.id] = { x: l.x + ((p.x ?? host.x) - host.x), y: l.y + ((p.y ?? host.y) - host.y) };
  }
  st.update((w) => {
    const sh = w.worksheets.find((s) => s.id === sheetId)!;
    for (const it of sh.items) if (pos[it.id]) Object.assign(it, pos[it.id]);
  });
}

/**
 * Keyboard nudge of the selected items (their panel letters move along): 0.5 mm, Shift: one grid step (5 mm without a
 * grid), Alt: 0.1 mm. The group lands on a multiple of the step, so positions stay clean (no 2.11 mm drift).
 */
export function nudgeItems(sheetId: string, ids: string[], dx: number, dy: number, mods: { shift?: boolean; alt?: boolean } = {}) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet || (!dx && !dy)) return;
  const moving = sheet.items.filter((i) => ids.includes(i.id));
  if (!moving.length) return;
  // the grid is stored in px rounded to 0.01 px: its step in mm to 0.01 mm (5 mm, not 5.0006 mm)
  const stepMm = mods.alt ? 0.1 : mods.shift ? (sheet.grid > 0 ? Math.round((sheet.grid / MM) * 100) / 100 : 5) : 0.5;
  const step = (v: number, d: number) => {
    if (!d) return v;
    const u = v / MM / stepMm;
    const k = d > 0 ? Math.floor(u + 1e-3) + 1 : Math.ceil(u - 1e-3) - 1;
    return Math.round(k * stepMm * 1000) / 1000;
  };
  const x0 = Math.min(...moving.map((i) => i.x));
  const y0 = Math.min(...moving.map((i) => i.y));
  const ddx = dx ? step(x0, dx) * MM - x0 : 0;
  const ddy = dy ? step(y0, dy) * MM - y0 : 0;
  const all = new Set(ids);
  for (const l of sheet.items) if (isLetter(l) && l.forItem && all.has(l.forItem)) all.add(l.id);
  st.update((w) => {
    const sh = w.worksheets.find((x) => x.id === sheetId)!;
    for (const it of sh.items)
      if (all.has(it.id)) {
        it.x = cleanPx(it.x + ddx);
        it.y = cleanPx(it.y + ddy);
      }
  }, 'nudge:' + ids.join(','));
}

/** Page size of a sheet set to its content plus a margin (the content moved to that margin), one undo step. */
export function fitPageToContent(sheetId: string, marginMm = 2) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
  const box = sheet ? contentBox(sheet.items) : null;
  if (!sheet || !box) {
    st.toast('The sheet is empty: nothing to fit the page to.', 'info');
    return;
  }
  const m = marginMm * MM;
  const dx = m - box.x;
  const dy = m - box.y;
  const w = Math.ceil((box.w + 2 * m) / MM * 10) / 10 * MM;
  const h = Math.ceil((box.h + 2 * m) / MM * 10) / 10 * MM;
  st.update((ws) => {
    const sh = ws.worksheets.find((s) => s.id === sheetId);
    if (!sh) return;
    for (const it of sh.items) {
      it.x = cleanPx(it.x + dx);
      it.y = cleanPx(it.y + dy);
    }
    sh.page = { w, h, name: 'custom' };
  });
  st.toast(`Page set to ${(w / MM).toFixed(1)} x ${(h / MM).toFixed(1)} mm (content plus ${marginMm} mm).`, 'info');
}

// ---------------------------------------------------------------- batch

/** Width of a text in px at `pt` points (rough: average glyph width of Arial / Helvetica). */
function textWidth(text: string, pt: number, bold = false): number {
  return text.length * pt * PT * (bold ? 0.58 : 0.54);
}

/** Name a plot's first layer population goes by in labels and titles. */
function popTitle(t: PlotItem): string {
  const ws = useStore.getState().ws;
  const pid = t.layers[0]?.population ?? 'root';
  return pid === 'root' ? 'All Events' : popById(ws, pid)?.name ?? 'All Events';
}

/** Whether a sample name looks like a control rather than an experimental sample (unstained, beads, compensation). */
export function isControlSampleName(name: string): boolean {
  return /unstain|\bus\b|beads?|\bcomp\b|compensation|control|\bctrl\b|\bblank\b/i.test(name.replace(/[_.-]+/g, ' '));
}

export interface RepeatOptions {
  newSheet: boolean;
  /** label the grid: sample names on one side, population names on the other */
  rowLabels: boolean;
  orientation?: 'rows' | 'columns';
  /** on the same sheet: the template plots are removed and the grid takes their place */
  removeTemplate?: boolean;
}

/**
 * Batch: repeat the given plots for each sample. Samples in rows: one row per sample (row labels = sample names),
 * the template plots side by side in their x order with the population name as column title. Samples in columns:
 * one column per sample (column headers = sample names), the template plots stacked in their y order with the
 * population names as row labels. Each copy is pinned to its sample. Returns the ids of the new items.
 */
export function repeatForSamples(sheetId: string, itemIds: string[], sampleIds: string[], opts: RepeatOptions): string[] {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return [];
  const cols = opts.orientation === 'columns';
  const templ = sheet.items.filter((i) => itemIds.includes(i.id) && i.kind === 'plot').sort((a, b) => (cols ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y)) as PlotItem[];
  if (!templ.length || !sampleIds.length) return [];
  // plots with exactly equal gaps (the gap of Arrange as grid), labels at the figure font size (bold)
  const g = arrangeGapMm() * MM;
  const cw = Math.max(...templ.map((t) => t.w));
  const ch = Math.max(...templ.map((t) => t.h));
  const labels = opts.rowLabels;
  const fpt = bodyPt(st.ws, sheet);
  const fst = { family: st.ws.style.fontFamily, size: fpt * PT, weight: 'bold' as const };
  const measure = (t: string) => measureRich(t, fst);
  const sampleName = (sid: string) => st.ws.samples.find((x) => x.id === sid)?.name ?? '';
  // left label column: sample names (rows) or population names (columns); long names wrap at _ - . or are shortened
  // in the middle (the start and the end of a file name tell samples apart)
  const leftTexts = cols ? templ.map((t) => (t.options.title && t.options.title !== '' ? t.options.title : popTitle(t))) : sampleIds.map(sampleName);
  const maxLabelW = 35 * MM;
  const labelW = labels ? Math.min(maxLabelW, Math.max(8 * MM, Math.ceil(Math.max(...leftTexts.map((t) => Math.max(...headerLines(t, maxLabelW - g - 1.5 * MM, measure).map(measure)))) + g + 1.5 * MM))) : 0;
  const lineH = Math.ceil(fpt * PT * 1.25 * 10) / 10;
  const colHeads = cols && labels ? sampleIds.map((sid) => headerLines(sampleName(sid), cw + g * 0.5, measure)) : [];
  const headH = cols && labels ? Math.max(...colHeads.map((l) => l.length)) * lineH + 1 * MM : 0;
  // block size, then its origin: top-left of a new sheet, the template's place, or a free slot on this sheet
  const nx = cols ? sampleIds.length : templ.length;
  const ny = cols ? templ.length : sampleIds.length;
  const blockW = labelW + nx * (cw + g) - g;
  const blockH = headH + ny * (ch + g) - g;
  const remove = !opts.newSheet && !!opts.removeTemplate;
  const tplIds = new Set(templ.map((t) => t.id));
  const attached = (i: SheetItem) => tplIds.has(i.id) || (i.kind === 'text' && tplIds.has((i as PanelLabel).forItem ?? ''));
  let o: { x: number; y: number };
  if (opts.newSheet) o = { x: g * 2, y: g * 2 };
  else if (remove) {
    const rest: Worksheet = { ...sheet, items: sheet.items.filter((i) => !attached(i)) };
    const tx = Math.max(0, Math.min(...templ.map((t) => t.x)) - labelW);
    const ty = Math.max(0, Math.min(...templ.map((t) => t.y)) - headH);
    o = findFreeSlot(rest, blockW, blockH, { x: tx, y: ty }, [], null);
  } else o = findFreeSlot(sheet, blockW, blockH, { x: g * 2, y: Math.max(0, ...sheet.items.map((i) => i.y + i.h)) + g * 2 }, [], null);
  const x0 = o.x;
  const y0 = o.y;
  const repin = (t: PlotItem, sid: string): PlotItem => {
    const cp: PlotItem = JSON.parse(JSON.stringify(t));
    cp.id = uid('plot');
    // layers that follow the active sample, or show the template's own sample, follow the new sample
    const primary = t.layers[0]?.sample;
    cp.layers = cp.layers.map((l) => ({ ...l, id: uid('ly'), sample: l.sample === 'active' || l.sample === primary ? sid : l.sample }));
    return cp;
  };
  // no color of their own: the page's text color (light on dark pages)
  const text = (x: number, y: number, w: number, h: number, t: string, align: TextItem['align'], sid?: string): TextItem => ({
    id: uid('txt'),
    kind: 'text',
    x,
    y,
    w,
    h,
    text: t,
    fontSize: fpt,
    bold: true,
    italic: false,
    align,
    color: '',
    // a sample name: follows renames of the sample until the text is edited by hand (see syncSampleHeaders)
    ...(sid ? { sampleHeader: { sample: sid, auto: t } } : {}),
  });
  const leftLabel = (y: number, t: string, sid?: string) => {
    const ls = headerLines(t, labelW - g, measure);
    return text(x0, y - (ls.length * lineH) / 2, labelW - g, ls.length * lineH + 1, ls.join('\n'), 'right', sid);
  };
  const out: SheetItem[] = [];
  if (cols) {
    // samples as columns (sample names on top), template plots stacked vertically (population names on the left)
    if (labels) templ.forEach((t, r) => out.push(leftLabel(y0 + headH + r * (ch + g) + ch / 2, leftTexts[r])));
    sampleIds.forEach((sid, c) => {
      const x = x0 + labelW + c * (cw + g);
      // the header spans its column (the plot and half the gap on each side)
      const ls = colHeads[c] ?? [];
      if (labels) out.push(text(x - g * 0.25, y0 + headH - ls.length * lineH - 1 * MM * 0.5, cw + g * 0.5, ls.length * lineH + 1, ls.join('\n'), 'center', sid));
      templ.forEach((t, r) => {
        const cp = repin(t, sid);
        cp.x = x;
        cp.y = y0 + headH + r * (ch + g);
        if (labels) cp.options.showTitle = false;
        out.push(cp);
      });
    });
  } else
    sampleIds.forEach((sid, r) => {
      const y = y0 + r * (ch + g);
      if (labels) out.push(leftLabel(y + ch / 2, sampleName(sid), sid));
      templ.forEach((t, c) => {
        const cp = repin(t, sid);
        cp.x = x0 + labelW + c * (cw + g);
        cp.y = y;
        if (labels) {
          // column titles: the population (the sample is in the row label), shown once on the first row; automatic,
          // so a renamed population renames the column
          cp.options.showTitle = r === 0;
          if (titleModeOf(t.options) !== 'custom') {
            (cp.options as PlotOptionsX).titleMode = 'population';
            delete cp.options.title;
          }
        }
        out.push(cp);
      });
    });
  if (opts.newSheet) {
    const id = uid('ws');
    st.update((w) => {
      const sh: Worksheet = { ...JSON.parse(JSON.stringify(sheet)), id, name: `${sheet.name} (batch)`, items: out };
      growPageToFit(sh, out);
      w.worksheets.push(sh);
    });
    st.setUI({ activeSheetId: id, selectedItemIds: [], view: 'sheet' });
  } else if (remove) {
    st.update((w) => {
      const sh = w.worksheets.find((s) => s.id === sheetId);
      if (!sh) return;
      sh.items = sh.items.filter((i) => !attached(i as SheetItem));
      sh.items.push(...out);
      growPageToFit(sh, out);
    });
    st.setUI({ view: 'sheet', activeSheetId: sheetId, selectedItemIds: out.map((i) => i.id), selectedPopId: null, keyItemId: null });
    revealItems(out.map((i) => i.id));
  } else addItems(sheetId, out);
  return out.map((i) => i.id);
}

export { headerLines } from '../render/figstyle';

/** Text item tagged as a panel letter of an item (the tag is an optional extra field, kept in saved workspaces). */
type PanelLabel = PanelLabelItem;

/**
 * A panel letter inside the top-left corner of its item: left-aligned with the item (the y axis title side), on the
 * line of the plot title, so it neither leaves the page nor touches the neighbouring plot. Bold, body + 2 pt (at most
 * 9 pt); no color of its own: it takes the page's text color (light on dark pages).
 */
export function panelLetterFor(p: Rect & { id: string }, text: string, ws: Pick<Workspace, 'style'>, sheet?: Pick<Worksheet, 'fontSize'> | null): PanelLabel {
  const pt = panelLabelPt(ws, sheet);
  const size = pt * PT;
  return {
    id: uid('txt'),
    kind: 'text',
    tag: 'panelLabel',
    forItem: p.id,
    x: p.x,
    y: p.y,
    w: Math.max(size * 1.2, Math.ceil(textWidth(text, pt, true) + size * 0.3)),
    h: Math.ceil(size * 1.25),
    text,
    fontSize: pt,
    bold: true,
    italic: false,
    align: 'left',
    color: '',
  };
}

/** Items that get panel letters by default: plots and stat charts (statistics boxes when asked for). */
export const panelLabelKinds = (withStats = false): SheetItem['kind'][] => (withStats ? ['plot', 'chart', 'stats'] : ['plot', 'chart']);

/**
 * Add bold panel letters (A, B, C …) at the top-left corner of figure items in reading order (rows top to bottom,
 * left to right in a row); replaces earlier panel letters. The selected items are labelled (any kind but text), else
 * every plot and stat chart of the sheet (and statistics boxes with `withStats`).
 */
export function addPanelLabels(sheetId: string, ids: string[], opts: { withStats?: boolean } = {}) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  const kinds = panelLabelKinds(opts.withStats);
  const allTargets = sheet.items.filter((i) => kinds.includes(i.kind));
  let targetsList = sheet.items.filter((i) => ids.includes(i.id) && i.kind !== 'text');
  if (!targetsList.length) targetsList = allTargets.length ? allTargets : sheet.items.filter((i) => i.kind === 'stats');
  if (!targetsList.length) return;
  const targets = new Set(targetsList.map((p) => p.id));
  const all = allTargets.every((i) => targets.has(i.id));
  const labelled = (i: SheetItem) => sheet.items.some((p) => p.id === (i as PanelLabel).forItem);
  const isOld = (i: SheetItem) => i.kind === 'text' && (i as PanelLabel).tag === 'panelLabel' && (all || targets.has((i as PanelLabel).forItem ?? '') || !labelled(i));
  // reading order: an item starts a new row when it lies below the middle of the current row's first item
  const byY = [...targetsList].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: SheetItem[][] = [];
  for (const it of byY) {
    const row = rows[rows.length - 1];
    if (row && it.y < row[0].y + row[0].h / 2) row.push(it);
    else rows.push([it]);
  }
  const ordered = rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
  const labels: PanelLabel[] = ordered.map((p, i) => panelLetterFor(p, i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`, st.ws, sheet));
  st.update((w) => {
    const sh = w.worksheets.find((s) => s.id === sheetId)!;
    sh.items = sh.items.filter((i) => !isOld(i as SheetItem));
    sh.items.push(...labels);
  });
  st.setUI({ selectedItemIds: labels.map((l) => l.id), selectedPopId: null });
  revealItems(labels.map((l) => l.id));
}

/**
 * Build a "gating strategy" worksheet: one plot per gating step (parent population with the gate's
 * parameters), in hierarchy order, wrapped into rows. Quadrant / split groups get one plot.
 */
export function buildGatingStrategySheet(sampleId: string | 'active') {
  const st = useStore.getState();
  const ws = st.ws;
  const steps: { parent: string; x: string; y: string; hist: boolean }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null) => {
    for (const p of ws.populations.filter((q) => q.parentId === parent)) {
      const g = p.gate;
      if (g.type !== 'bool') {
        const hist = g.type === 'range' || g.type === 'split';
        const x = g.x;
        const y = hist ? g.x : (g as { y: string }).y;
        const key = `${parent ?? 'root'}|${x}|${y}|${hist}`;
        if (!seen.has(key)) {
          seen.add(key);
          steps.push({ parent: parent ?? 'root', x, y, hist });
        }
      }
      walk(p.id);
    }
  };
  walk(null);
  if (!steps.length) {
    st.toast('Draw some gates first; the strategy is built from the gating tree.', 'info');
    return;
  }
  const sheetName = 'Gating strategy';
  const g = 5 * (96 / 25.4);
  const { w: W, h: H } = defaultPlotSize();
  const a4 = PAGE_SIZES['A4 landscape'];
  const pageW = a4.w;
  const cols = Math.max(1, Math.floor((pageW - g * 4 + g) / (W + g)));
  const items: SheetItem[] = steps.map((s, i) => {
    const it = newPlotItem(s.hist ? 'histogram' : 'pseudo', s.x, s.y, g * 2 + (i % cols) * (W + g), g * 2 + Math.floor(i / cols) * (H + g), W, H, s.parent, sampleId);
    // titled by the population (automatic: follows renames), not a fixed text
    (it.options as PlotOptionsX).titleMode = 'population';
    delete it.options.title;
    return it;
  });
  const rows = Math.ceil(steps.length / cols);
  const id = uid('ws');
  st.update((w) => {
    w.worksheets.push({
      id,
      name: sheetName,
      page: { w: pageW, h: Math.max(a4.h, g * 4 + rows * (H + g)), name: rows * (H + g) + g * 4 > a4.h ? 'custom' : 'A4 landscape' },
      grid: g,
      snap: true,
      showGrid: true,
      items,
    });
  });
  st.setUI({ activeSheetId: id, view: 'sheet', selectedItemIds: [] });
}

// ---------------------------------------------------------------- item operations

const bbox = (items: Rect[]): Rect => {
  const x = Math.min(...items.map((i) => i.x));
  const y = Math.min(...items.map((i) => i.y));
  return { x, y, w: Math.max(...items.map((i) => i.x + i.w)) - x, h: Math.max(...items.map((i) => i.y + i.h)) - y };
};

/**
 * Copies of items with fresh ids, moved as a group to a free slot (preferring `near`, else right of the originals).
 * Items copied in another workspace (or another tab) may refer to gates, samples and groups this one does not have:
 * such references are reset (plots: All Events / the active sample) or removed (statistics of missing gates), and a
 * toast says so; references that exist here are kept.
 */
function placeCopies(sheet: Worksheet, src: SheetItem[], near?: { x: number; y: number }, view?: Rect | null): SheetItem[] {
  const b = bbox(src);
  const p = findFreeSlot(sheet, b.w, b.h, near ?? { x: b.x + b.w + (sheet.grid || 10), y: b.y }, [], view);
  const ctx = refContextOf(useStore.getState().ws);
  const notes = new RepairNotes();
  const out = src
    .map((i) => {
      // a structured copy (a JSON copy would turn +-Infinity into null)
      const it = structuredClone(i) as SheetItem;
      it.id = uid(i.kind);
      it.x = i.x - b.x + p.x;
      it.y = i.y - b.y + p.y;
      if (it.kind === 'plot' && Array.isArray(it.layers)) it.layers = it.layers.map((l) => ({ ...l, id: uid('ly') }));
      return repairItem(it, ctx, notes) as SheetItem | null;
    })
    .filter((it): it is SheetItem => !!it);
  const list = notes.list().filter((n) => !/settings \(reset to defaults\)/.test(n));
  if (list.length) useStore.getState().toast(`Pasted with changes: ${list.join('; ')}.`, 'info', { duration: 9000 });
  return out;
}

export function duplicateItems(sheetId: string, ids: string[]) {
  const sheet = useStore.getState().ws.worksheets.find((s) => s.id === sheetId);
  const src = sheet?.items.filter((i) => ids.includes(i.id)) ?? [];
  if (!sheet || !src.length) return;
  addItems(sheetId, placeCopies(sheet, src));
}

export function deleteItems(sheetId: string, ids: string[]) {
  const st = useStore.getState();
  st.update((w) => {
    const sh = w.worksheets.find((s) => s.id === sheetId)!;
    // the panel letters of deleted items go with them
    sh.items = sh.items.filter((i) => !ids.includes(i.id) && !(isLetter(i as SheetItem) && ids.includes((i as PanelLabel).forItem ?? '')));
  });
  st.setUI({ selectedItemIds: [], keyItemId: null });
}

export function reorder(sheetId: string, ids: string[], where: 'front' | 'back' | 'forward' | 'backward') {
  useStore.getState().update((w) => {
    const sh = w.worksheets.find((s) => s.id === sheetId)!;
    const sel = (i: SheetItem) => ids.includes(i.id);
    if (where === 'front' || where === 'back') {
      const moving = sh.items.filter(sel);
      const rest = sh.items.filter((i) => !sel(i));
      sh.items = where === 'front' ? [...rest, ...moving] : [...moving, ...rest];
      return;
    }
    const a = sh.items.slice();
    if (where === 'forward') {
      for (let i = a.length - 2; i >= 0; i--) if (sel(a[i]) && !sel(a[i + 1])) [a[i], a[i + 1]] = [a[i + 1], a[i]];
    } else for (let i = 1; i < a.length; i++) if (sel(a[i]) && !sel(a[i - 1])) [a[i], a[i - 1]] = [a[i - 1], a[i]];
    if (a.some((x, i) => x !== sh.items[i])) sh.items = a;
  });
}

/** Delete what the Delete key / button targets: the selected population (a gate picked in a plot or the tree), else the items. */
export function deleteSelection(target: 'auto' | 'population' = 'auto') {
  const { ws, ui } = useStore.getState();
  const sheet = ws.worksheets.find((s) => s.id === ui.activeSheetId) ?? ws.worksheets[0];
  if (ui.selectedPopId && (target === 'population' || ui.selectedItemIds.length <= 1)) deletePopulation(ui.selectedPopId);
  else if (ui.selectedItemIds.length && sheet) deleteItems(sheet.id, ui.selectedItemIds);
}

// ---------------------------------------------------------------- worksheets

export function duplicateSheet(sheetId: string) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  const copy: Worksheet = JSON.parse(JSON.stringify(sheet));
  const ids = new Map<string, string>();
  copy.id = uid('ws');
  copy.name = sheet.name + ' copy';
  for (const it of copy.items) {
    ids.set(it.id, uid(it.kind));
    it.id = ids.get(it.id)!;
    if (it.kind === 'plot') it.layers = it.layers.map((l) => ({ ...l, id: uid('ly') }));
  }
  for (const it of copy.items as PanelLabel[]) if (it.forItem) it.forItem = ids.get(it.forItem);
  const i = st.ws.worksheets.findIndex((s) => s.id === sheetId);
  st.update((w) => {
    w.worksheets.splice(i + 1, 0, copy);
  });
  st.setUI({ activeSheetId: copy.id, selectedItemIds: [], view: 'sheet' });
}

/** Ask, then delete a worksheet (the last one is never deleted). */
export function confirmDeleteSheet(sheetId: string) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet || st.ws.worksheets.length < 2) return;
  const n = sheet.items.length;
  st.setUI({
    dialog: {
      kind: 'confirm',
      payload: {
        title: `Delete worksheet '${sheet.name}'?`,
        text: n ? `Its ${n} item${n === 1 ? '' : 's'} will be removed. Gates and populations are kept. You can undo this with Ctrl+Z.` : 'The worksheet is empty. You can undo this with Ctrl+Z.',
        ok: 'Delete worksheet',
        danger: true,
        onOk: () => {
          const s = useStore.getState();
          const i = s.ws.worksheets.findIndex((x) => x.id === sheetId);
          s.update((w) => {
            w.worksheets = w.worksheets.filter((x) => x.id !== sheetId);
          });
          const left = useStore.getState().ws.worksheets;
          if (s.ui.activeSheetId === sheetId) s.setUI({ activeSheetId: left[Math.min(i, left.length - 1)]?.id ?? '', selectedItemIds: [] });
        },
      } satisfies ConfirmPayload,
    },
  });
}

export interface ConfirmPayload {
  title: string;
  text: string;
  ok: string;
  danger?: boolean;
  onOk: () => void;
}

/** Move a worksheet tab to position `to` (index among worksheets). */
export function moveSheet(sheetId: string, to: number) {
  useStore.getState().update((w) => {
    const i = w.worksheets.findIndex((s) => s.id === sheetId);
    if (i < 0) return;
    const [sh] = w.worksheets.splice(i, 1);
    w.worksheets.splice(Math.max(0, Math.min(w.worksheets.length, to > i ? to - 1 : to)), 0, sh);
  });
}

// ---------------------------------------------------------------- clipboard (system clipboard with an in-app fallback)

const CLIP_MARK = 'application/x-flowstate-items';
let clipboard: SheetItem[] = [];

export function clipText(items: SheetItem[]): string {
  return JSON.stringify({ [CLIP_MARK]: 1, items });
}

/** Why a clipboard item cannot be pasted (missing or wrong essential fields), or null. */
function clipItemProblem(i: unknown): string | null {
  if (!i || typeof i !== 'object' || Array.isArray(i)) return 'not an item';
  const o = i as Record<string, unknown>;
  if (!['plot', 'text', 'stats', 'chart'].includes(o.kind as string)) return 'unknown kind';
  const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!fin(o.x) || !fin(o.y) || !fin(o.w) || !fin(o.h) || !((o.w as number) > 0 && (o.h as number) > 0)) return 'no valid position and size';
  if (o.kind === 'plot' && !(Array.isArray(o.layers) && o.layers.length && o.options && typeof o.options === 'object' && typeof o.xParam === 'string')) return 'incomplete plot';
  if (o.kind === 'text' && typeof o.text !== 'string') return 'no text';
  if (o.kind === 'stats' && !Array.isArray(o.rows)) return 'no statistics';
  if (o.kind === 'chart' && !(o.stat && typeof o.stat === 'object')) return 'no statistic';
  return null;
}

/**
 * Clipboard text: `ours` when written by clipText; `items` the usable items (checked and repaired like the items of a
 * workspace file: values, layers, options, references), null when none. Damaged items are left out with a message.
 */
export function readClip(text: string | null | undefined): { ours: boolean; items: SheetItem[] | null } {
  if (!text || !text.includes(CLIP_MARK)) return { ours: false, items: null };
  let o: { items?: unknown } & Record<string, unknown>;
  try {
    o = JSON.parse(text);
  } catch {
    return { ours: false, items: null };
  }
  if (!o || typeof o !== 'object' || !o[CLIP_MARK]) return { ours: false, items: null };
  const st = useStore.getState();
  const raw = Array.isArray(o.items) ? o.items : [];
  const notes = new RepairNotes();
  const ctx = refContextOf(st.ws);
  const items = raw
    .filter((i) => clipItemProblem(i) === null)
    .map((i) => repairItem(i, ctx, notes) as SheetItem | null)
    .filter((i): i is SheetItem => !!i);
  const dropped = raw.length - items.length;
  if (!items.length) st.toast('The clipboard holds damaged FlowState items; nothing was pasted.', 'error');
  else if (dropped) st.toast(`${dropped} damaged clipboard item${dropped > 1 ? 's were' : ' was'} left out.`, 'info');
  return { ours: true, items: items.length ? items : null };
}

/** Items from clipboard text written by clipText (see readClip), or null for any other text or no usable item. */
export function parseClip(text: string | null | undefined): SheetItem[] | null {
  return readClip(text).items;
}

/** Copy items: in-app clipboard, plus the system clipboard (via the copy event's DataTransfer when given). */
export function copyItems(sheetId: string, ids: string[], data?: DataTransfer | null) {
  const sheet = useStore.getState().ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  clipboard = JSON.parse(JSON.stringify(sheet.items.filter((i) => ids.includes(i.id))));
  if (!clipboard.length) return;
  const text = clipText(clipboard);
  if (data) data.setData('text/plain', text);
  else navigator.clipboard?.writeText?.(text).catch(() => undefined);
  useStore.getState().toast(`Copied ${clipboard.length} item${clipboard.length > 1 ? 's' : ''}`, 'info');
}

/** Paste items (from the system clipboard when given, else the in-app clipboard) at the same place if free, else next to it. */
export function pasteItems(sheetId: string, items?: SheetItem[] | null) {
  // null / undefined: the in-app clipboard; an empty list: nothing usable on the system clipboard (already reported)
  const src = items ?? clipboard;
  if (!src.length) return;
  const sheet = useStore.getState().ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  const b = bbox(src);
  // the same place if free (no preference for the visible part: pasting keeps positions)
  addItems(sheetId, placeCopies(sheet, src, { x: b.x, y: b.y }, null));
}

/** Statistics table below a plot, listing the gates drawn in it. */
export function addStatsBelow(sheetId: string, plotId: string) {
  const st = useStore.getState();
  const ws = st.ws;
  const sheet = ws.worksheets.find((s) => s.id === sheetId);
  const plot = sheet?.items.find((i) => i.id === plotId) as PlotItem | undefined;
  if (!sheet || !plot) return;
  const parent = plot.layers[0]?.population ?? 'root';
  const kids = ws.populations.filter((p) => (p.parentId ?? 'root') === parent && p.gate.type !== 'bool' && gateMatchesPlot(p.gate, plot).ok);
  const rows = (kids.length ? kids : [{ id: parent }]).map((p) => ({ id: uid('row'), population: p.id, stat: 'freqParent' as const }));
  const g = sheet.grid || 10;
  const lh = ((bodyPt(ws, sheet) * 96) / 72) * 1.45;
  const h = Math.ceil((lh * (rows.length + 1) + 8) / g) * g;
  const pos = findFreeSlot(sheet, plot.w, h, { x: plot.x, y: plot.y + plot.h + g }, [], null);
  const box: StatsBoxItem = { id: uid('stats'), kind: 'stats', x: pos.x, y: pos.y, w: plot.w, h, sample: plot.layers[0]?.sample ?? 'active', fontSize: bodyPt(ws, sheet), rows };
  addItems(sheetId, [box]);
}

/** Base64 of bytes (chunked: large images exceed the argument limit of String.fromCharCode). */
function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

/**
 * Copy items as an image: PNG at `dpi`, plus HTML with the picture at its true physical size (Word, PowerPoint and
 * Google Docs read the size from it; the bare PNG on the clipboard loses its resolution) and SVG where the browser
 * allows it. The toast tells the size the picture should have once pasted.
 */
export function copyAsImage(sheetId: string, ids: string[], dpi = 300) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  const items = sheet.items.filter((i) => ids.includes(i.id));
  if (!items.length) return;
  const opts: FigureOptions = { format: 'png', scope: 'selection', dpi, margin: items.length > 1 ? 2 * MM : 0, transparent: false };
  const b = figureBounds(sheet, items, opts);
  const wmm = (b.w / MM).toFixed(1);
  const hmm = (b.h / MM).toFixed(1);
  const fail = () => st.toast('Copying images is blocked here. Use Export (PNG / TIFF / SVG / PDF) instead.', 'error');
  try {
    // the ClipboardItem gets promises so the copy stays inside the user gesture (Safari) while the image renders
    const bytes = Promise.resolve(renderFigure(sheet, ids, opts)).then((res) => res.bytes as Uint8Array);
    const data: Record<string, Promise<Blob>> = {
      'image/png': bytes.then((u) => new Blob([u as BlobPart], { type: 'image/png' })),
      'text/html': bytes.then(
        (u) =>
          new Blob([`<img alt="Figure" width="${Math.round(b.w)}" height="${Math.round(b.h)}" style="width:${wmm}mm;height:${hmm}mm" src="data:image/png;base64,${base64(u)}">`], {
            type: 'text/html',
          }),
      ),
    };
    const CI = ClipboardItem as unknown as { supports?: (t: string) => boolean };
    if (CI.supports?.('image/svg+xml')) {
      data['image/svg+xml'] = Promise.resolve(renderFigure(sheet, ids, { ...opts, format: 'svg' })).then((res) => new Blob([res.bytes as BlobPart], { type: 'image/svg+xml' }));
    }
    const px = `${Math.round((b.w * dpi) / 96)} x ${Math.round((b.h * dpi) / 96)} px`;
    navigator.clipboard
      .write([new ClipboardItem(data)])
      .then(() =>
        st.toast(`Copied ${wmm} x ${hmm} mm at ${dpi} dpi (${px}). Programs that read the size from the clipboard paste it at ${wmm} x ${hmm} mm; if one pastes it larger, set the picture to that size (it stays sharp).`, 'success', { duration: 10000 }),
      )
      .catch(fail);
  } catch {
    fail();
  }
}

// ---------------------------------------------------------------- page size changes

/** Bounding box of all items, or null for an empty sheet. */
export function contentBox(items: Rect[]): Rect | null {
  return items.length ? bbox(items) : null;
}

/** How the layout follows a page size change: shrink it, wrap it into rows of the new width, or leave it. */
export type PageFitMode = 'scale' | 'reflow' | 'keep';

type PageSize = { w: number; h: number; name: string };

const isPanelLabel = (i: SheetItem): i is PanelLabel => i.kind === 'text' && (i as PanelLabel).tag === 'panelLabel';

/** Lines a text box needs at its width (greedy estimate, like the renderer's word wrap). */
function textLines(t: TextItem, w: number): number {
  const cw = t.fontSize * PT * (t.bold ? 0.58 : 0.54);
  return t.text.split('\n').reduce((n, para) => n + Math.max(1, Math.ceil((para.length * cw) / Math.max(10, w - 2))), 0);
}

/** Text boxes keep their font size: at a narrower width they may need more height. */
function fitTextHeight(t: TextItem): number {
  return Math.max(t.h, Math.ceil(textLines(t, t.w) * t.fontSize * PT * 1.2 + 2));
}

/**
 * Layout of `items` on a page of size `page`. 'scale': plots and charts are scaled (positions and sizes, about the
 * top-left margin) so everything fits, font sizes stay; text boxes and statistics boxes keep their size (text stays
 * readable) and move with the layout. 'reflow': sizes stay, items (with their panel letters and annotations) wrap
 * into rows of the page width in reading order; a new row of the original layout starts a new row. Returns the new
 * positions / sizes and the page height needed (at least the page's own).
 */
export function fitLayout(items: SheetItem[], page: { w: number; h: number }, grid: number, mode: 'scale' | 'reflow'): { items: SheetItem[]; pageH: number; scale: number } {
  const g = grid > 0 ? grid : 10;
  const box = contentBox(items);
  if (!box) return { items, pageH: page.h, scale: 1 };
  const mx = Math.min(Math.max(0, box.x), g * 2);
  const my = Math.min(Math.max(0, box.y), g * 2);
  const out = items.map((i) => JSON.parse(JSON.stringify(i)) as SheetItem);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  let scale = 1;
  if (mode === 'scale') {
    scale = Math.min(1, (page.w - 2 * mx) / box.w, (page.h - 2 * my) / box.h);
    for (const it of out) {
      it.x = r2(mx + (it.x - box.x) * scale);
      it.y = r2(my + (it.y - box.y) * scale);
      if (it.kind === 'plot' || it.kind === 'chart') {
        it.w = r2(it.w * scale);
        it.h = r2(it.h * scale);
      } else if (it.kind === 'text' && !isPanelLabel(it)) {
        it.w = r2(Math.max(Math.min(it.w, page.w - mx - it.x), Math.min(it.w, g * 4)));
        it.h = fitTextHeight(it);
      }
    }
    // panel letters stay at the corner of their item
    for (const it of out)
      if (isPanelLabel(it)) {
        const src = items.find((i) => i.id === it.forItem);
        const tgt = out.find((i) => i.id === it.forItem);
        if (src && tgt) {
          const orig = items.find((i) => i.id === it.id)!;
          it.x = r2(tgt.x + (orig.x - src.x));
          it.y = r2(tgt.y + (orig.y - src.y));
        }
      }
  } else {
    // units: an item with the panel letters and small annotations lying on it
    const ids = new Set(out.map((i) => i.id));
    const owner = new Map<string, string>();
    for (const it of out) {
      if (isPanelLabel(it) && it.forItem && ids.has(it.forItem)) owner.set(it.id, it.forItem);
      else if (it.kind === 'text') {
        const host = out.find((o) => o !== it && o.kind !== 'text' && it.x >= o.x - 1 && it.y >= o.y - 1 && it.x + it.w <= o.x + o.w + 1 && it.y + it.h <= o.y + o.h + 1);
        if (host) owner.set(it.id, host.id);
      }
    }
    const units = out
      .filter((i) => !owner.has(i.id))
      .map((lead) => {
        // an item wider than the new page: text and statistics boxes get narrower, plots and charts smaller
        const avail = page.w - 2 * mx;
        if (lead.w > avail) {
          if (lead.kind === 'text') {
            lead.w = avail;
            lead.h = fitTextHeight(lead);
          } else if (lead.kind === 'stats') lead.w = avail;
          else {
            const k = avail / lead.w;
            lead.w = r2(avail);
            lead.h = r2(lead.h * k);
          }
        }
        const members = [lead, ...out.filter((i) => owner.get(i.id) === lead.id)];
        return { lead, members, box: bbox(members) };
      });
    // reading order by the original rows
    units.sort((a, b) => a.lead.y - b.lead.y || a.lead.x - b.lead.x);
    const rows: (typeof units)[] = [];
    for (const u of units) {
      const row = rows[rows.length - 1];
      if (row && u.lead.y < row[0].lead.y + row[0].lead.h / 2) row.push(u);
      else rows.push([u]);
    }
    let y = my;
    for (const row of rows) {
      row.sort((a, b) => a.lead.x - b.lead.x);
      let x = mx;
      let rowH = 0;
      for (const u of row) {
        if (x > mx && x + u.box.w > page.w - mx + 0.5) {
          x = mx;
          y += rowH + g;
          rowH = 0;
        }
        const dx = x - u.box.x;
        const dy = y - u.box.y;
        for (const m of u.members) {
          m.x = r2(m.x + dx);
          m.y = r2(m.y + dy);
        }
        x = Math.ceil((x + u.box.w + g) / g - 1e-6) * g;
        rowH = Math.max(rowH, u.box.h);
      }
      y = Math.ceil((y + rowH + g) / g - 1e-6) * g;
    }
  }
  const bottom = Math.max(...out.map((i) => i.y + i.h));
  return { items: out, pageH: Math.max(page.h, Math.ceil(bottom + my)), scale };
}

/** Change a sheet's page size, fitting the layout as asked (one undo step). */
export function applyPageSize(sheetId: string, page: PageSize, mode: PageFitMode) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  if (mode === 'keep' || !sheet.items.length) {
    st.update((w) => {
      const sh = w.worksheets.find((s) => s.id === sheetId);
      if (sh) sh.page = { ...page };
    });
    return;
  }
  const r = fitLayout(sheet.items, page, sheet.grid, mode);
  const grown = r.pageH > page.h + 0.5;
  st.update((w) => {
    const sh = w.worksheets.find((s) => s.id === sheetId);
    if (!sh) return;
    const pos = new Map(r.items.map((i) => [i.id, i]));
    for (const it of sh.items) {
      const n = pos.get(it.id);
      if (n) Object.assign(it, { x: n.x, y: n.y, w: n.w, h: n.h });
    }
    sh.page = grown ? { w: page.w, h: r.pageH, name: 'custom' } : { ...page };
  });
  const label = page.name === 'custom' ? 'the page' : page.name;
  if (mode === 'scale') st.toast(`Layout scaled to ${Math.round(r.scale * 100)} % to fit ${label}; font sizes kept.${grown ? ` Page height grown to ${Math.round(r.pageH / MM)} mm for text boxes.` : ''}`, 'info');
  else st.toast(`Layout re-flowed to the width of ${label}.${grown ? ` Page height grown to ${Math.round(r.pageH / MM)} mm.` : ''}`, 'info');
}
