import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPE, type DragEvent } from 'react';
import { engine } from '../core/engine';
import { DEFAULT_GRID_COLOR, MM, popById, sheetGridOpacity, sheetGridStyle, uid, type ChartItem, type PlotItem, type SheetItem, type StatsBoxItem, type TextItem, type Worksheet } from '../core/model';
import { renderChart } from '../render/chart';
import { CanvasPainter, fitCanvasScale, parseSup, withFallback } from '../render/painter';
import { vmetrics } from '../render/fonts';
import { renderStatsBox, textOverflows } from '../render/items';
import { gateMatchesPlot, PT, setPlotPopulation } from '../render/plot';
import { defaultPlotSize, newPlotItem, pickDefaultChannels, useStore } from '../state/store';
import { setCursorInfo } from './cursorBus';
import { addItems, addStatsBelow, arrangeGapMm, copyAsImage, deleteItems, duplicateItems, nudgeItems, populationPlotSpec, reorder, revealItems } from './layoutOps';
import { bodyPt, isPanelLabel, textColorOf } from '../render/figstyle';
import { PlotView } from './PlotView';
import { hexToRgb } from '../render/colormaps';
import { ContextMenu } from './widgets';
import { ChannelMenu } from './ChannelPicker';
import { showPanel } from './shell';

export { addStatsBelow, copyAsImage, copyItems, deleteItems, duplicateItems, pasteItems, reorder } from './layoutOps';

export const DND_TYPE = 'application/x-flowstate';

type Rect = { x: number; y: number; w: number; h: number };
type DragState =
  | { kind: 'move'; x0: number; y0: number; start: Record<string, { x: number; y: number }>; moved: boolean; key: string; clickOnly: string | null }
  | { kind: 'resize'; id: string; handle: string; x0: number; y0: number; r0: Rect; key: string }
  | { kind: 'rubber'; x0: number; y0: number; additive: boolean; base: string[]; rect: Rect | null }
  | { kind: 'pan'; cx: number; cy: number; sl: number; st: number; moved?: boolean; tap?: boolean };

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const KEEP_ON_PAGE = 20; // px of a moved group that stay on the page

// ---------------------------------------------------------------- zoom (shared with the status bar and ribbon)

let pendingAnchor: { px: number; py: number; cx: number; cy: number } | null = null;
let pendingTopLeft = false;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 1000) / 1000));

/** Set the worksheet zoom keeping the page point under (clientX, clientY), or the view center, in place. */
export function setZoom(z: number, at?: { clientX: number; clientY: number }) {
  const st = useStore.getState();
  const nz = clampZoom(z);
  const sc = document.querySelector('.sheet-scroll');
  const page = document.querySelector('.sheet-scroll .page');
  if (sc && page && st.ui.view === 'sheet') {
    const r = page.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    const cx = at?.clientX ?? sr.left + sr.width / 2;
    const cy = at?.clientY ?? sr.top + sr.height / 2;
    pendingAnchor = { px: (cx - r.left) / st.ui.zoom, py: (cy - r.top) / st.ui.zoom, cx, cy };
  }
  st.setUI({ zoom: nz });
}

/** Zoom to z keeping page point (px, py) at the client point (cx, cy) (pinch: zoom and pan in one). */
function zoomAround(z: number, px: number, py: number, cx: number, cy: number) {
  const st = useStore.getState();
  const nz = clampZoom(z);
  if (nz === st.ui.zoom) {
    const sc = document.querySelector('.sheet-scroll');
    const page = document.querySelector('.sheet-scroll .page');
    if (!sc || !page) return;
    const r = page.getBoundingClientRect();
    sc.scrollLeft += r.left + px * nz - cx;
    sc.scrollTop += r.top + py * nz - cy;
    return;
  }
  pendingAnchor = { px, py, cx, cy };
  st.setUI({ zoom: nz });
}

/** Bounding box (page px) of the selected items of the active sheet, or null. */
function selectionBox(): Rect | null {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((w) => w.id === st.ui.activeSheetId) ?? st.ws.worksheets[0];
  const items = sheet?.items.filter((i) => st.ui.selectedItemIds.includes(i.id)) ?? [];
  if (!items.length) return null;
  const x0 = Math.min(...items.map((i) => i.x));
  const y0 = Math.min(...items.map((i) => i.y));
  const x1 = Math.max(...items.map((i) => i.x + i.w));
  const y1 = Math.max(...items.map((i) => i.y + i.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Keyboard zoom (+ / -): the selected items stay where they are on screen (brought to the middle when out of view);
 * without a selection, the middle of the view stays in place.
 */
export function zoomStep(factor: number) {
  const st = useStore.getState();
  const sc = document.querySelector('.sheet-scroll');
  const page = document.querySelector('.sheet-scroll .page');
  const box = selectionBox();
  if (!sc || !page || !box || st.ui.view !== 'sheet') {
    setZoom(st.ui.zoom * factor);
    return;
  }
  const r = page.getBoundingClientRect();
  const sr = sc.getBoundingClientRect();
  const z = st.ui.zoom;
  const px = box.x + box.w / 2;
  const py = box.y + box.h / 2;
  let cx = r.left + px * z;
  let cy = r.top + py * z;
  if (cx < sr.left || cx > sr.left + sc.clientWidth || cy < sr.top || cy > sr.top + sc.clientHeight) {
    cx = sr.left + sc.clientWidth / 2;
    cy = sr.top + sc.clientHeight / 2;
  }
  zoomAround(z * factor, px, py, cx, cy);
}

/** Zoom levels and scroll positions before "Zoom to selection", for "Back" (Shift+1). */
const zoomHistory: { sheet: string; zoom: number; sl: number; st: number }[] = [];
let pendingScroll: { sl: number; st: number } | null = null;

/** Zoom so the selected items fill the visible worksheet (F or Shift+2); without a selection, fit the page. */
export function zoomToSelection() {
  const st = useStore.getState();
  const sc = document.querySelector('.sheet-scroll');
  if (!sc || st.ui.view !== 'sheet') return;
  const box = selectionBox();
  if (!box) {
    st.toast('Select a plot (or several items) first: Zoom to selection makes them fill the window.', 'info');
    return;
  }
  const pad = 10; // page px around the selection
  const z = clampZoom(Math.min((sc.clientWidth - 16) / (box.w + 2 * pad), (sc.clientHeight - 16) / (box.h + 2 * pad)));
  zoomHistory.push({ sheet: st.ui.activeSheetId, zoom: st.ui.zoom, sl: sc.scrollLeft, st: sc.scrollTop });
  if (zoomHistory.length > 20) zoomHistory.shift();
  const sr = sc.getBoundingClientRect();
  zoomAround(z, box.x + box.w / 2, box.y + box.h / 2, sr.left + sc.clientWidth / 2, sr.top + sc.clientHeight / 2);
}

/** Back to the zoom before the last "Zoom to selection" (Shift+1), else fit the page. */
export function zoomBack() {
  const st = useStore.getState();
  const sc = document.querySelector('.sheet-scroll');
  if (!sc || st.ui.view !== 'sheet') return;
  let prev = zoomHistory.pop();
  while (prev && prev.sheet !== st.ui.activeSheetId) prev = zoomHistory.pop();
  if (!prev) {
    fitZoom('page');
    return;
  }
  pendingAnchor = null;
  if (prev.zoom === st.ui.zoom) sc.scrollTo(prev.sl, prev.st);
  else {
    pendingScroll = { sl: prev.sl, st: prev.st };
    st.setUI({ zoom: prev.zoom });
  }
}

/** Zoom so the whole page (or its width) fits the worksheet view. */
export function fitZoom(mode: 'page' | 'width') {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((w) => w.id === st.ui.activeSheetId) ?? st.ws.worksheets[0];
  const sc = document.querySelector('.sheet-scroll');
  if (!sc || !sheet) return;
  const zw = (sc.clientWidth - 48) / sheet.page.w;
  const zh = (sc.clientHeight - 60) / sheet.page.h;
  pendingAnchor = null;
  pendingTopLeft = true;
  st.setUI({ zoom: clampZoom(Math.floor((mode === 'page' ? Math.min(zw, zh) : zw) * 100) / 100) });
}

/**
 * Large screens: when the page would sit small in a big worksheet area at 100 %, zoom so it fills the view
 * (at most 200 %). Used once when the app opens.
 */
export function fitLargeScreen() {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((w) => w.id === st.ui.activeSheetId) ?? st.ws.worksheets[0];
  const sc = document.querySelector('.sheet-scroll');
  if (!sc || !sheet || st.ui.view !== 'sheet' || st.ui.zoom !== 1) return;
  const z = Math.min((sc.clientWidth - 48) / sheet.page.w, (sc.clientHeight - 60) / sheet.page.h);
  if (z < 1.15) return;
  pendingAnchor = null;
  pendingTopLeft = true;
  st.setUI({ zoom: clampZoom(Math.min(2, Math.floor(z * 20) / 20)) });
}

const mm = (v: number) => (v / MM).toFixed(1);
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest('.modal, .ctx-menu'));

/** The worksheet. readOnly: a viewer (phone layout): pan and zoom only. */
export function SheetView({ readOnly }: { readOnly?: boolean } = {}) {
  const ws = useStore((s) => s.ws);
  const ui = useStore((s) => s.ui);
  const sheet = ws.worksheets.find((w) => w.id === ui.activeSheetId) ?? ws.worksheets[0];
  const zoom = ui.zoom;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const endDragRef = useRef<((cancel: boolean, ev?: PointerEvent) => void) | null>(null);
  const live = useRef({ sheet, zoom });
  live.current = { sheet, zoom };
  const [rubber, setRubber] = useState<Rect | null>(null);
  const [guides, setGuides] = useState<{ v: number[]; h: number[]; gaps?: Rect[] }>({ v: [], h: [] });
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ itemId: string; axis: 'x' | 'y'; x: number; y: number } | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<TextItem | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; itemId: string } | null>(null);
  const [panReady, setPanReady] = useState(false);
  const spaceRef = useRef(false);
  const overRef = useRef(false);
  const lastOver = useRef<{ clientX: number; clientY: number } | null>(null);
  const known = useRef<{ sheet: string; ids: Set<string>; fresh: Map<string, number> } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; z0: number; px: number; py: number } | null>(null);

  // items that were just added and are selected (a new plot from a gate, a drop, a paste) are scrolled into view
  useEffect(() => {
    const ids = sheet.items.map((i) => i.id);
    const now = performance.now();
    const k = known.current;
    if (!k || k.sheet !== sheet.id) {
      known.current = { sheet: sheet.id, ids: new Set(ids), fresh: new Map() };
      return;
    }
    for (const id of ids) if (!k.ids.has(id)) k.fresh.set(id, now);
    k.ids = new Set(ids);
    for (const [id, t] of k.fresh) if (t < now - 2000) k.fresh.delete(id);
    const sel = ui.selectedItemIds;
    const fresh = sel.filter((id) => k.fresh.has(id));
    if (fresh.length && fresh.length === sel.length) {
      for (const id of fresh) k.fresh.delete(id);
      revealItems(fresh);
    }
  }, [sheet.items, sheet.id, ui.selectedItemIds]);

  // popovers inside the sheet (auto-gate tightness, inline rename) are scrolled into view when they open
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver((recs) => {
      for (const r of recs)
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof HTMLElement)) continue;
          const el = n.matches('.ag-pop, .rename-pop') ? n : n.querySelector<HTMLElement>('.ag-pop, .rename-pop');
          if (el) requestAnimationFrame(() => el.isConnected && el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        }
    });
    mo.observe(sc, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  const toPage = (e: { clientX: number; clientY: number }) => {
    const r = pageRef.current!.getBoundingClientRect();
    const z = live.current.zoom;
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  };

  // end any drag and close editors when the sheet changes
  useEffect(() => {
    endDragRef.current?.(true);
    setEditingText(null);
    setDraftText(null);
  }, [sheet.id]);
  useEffect(() => () => endDragRef.current?.(true), []);

  // keep the page point under the cursor (or the view center) in place when zooming
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const page = pageRef.current;
    if (!sc || !page) return;
    if (pendingTopLeft) {
      pendingTopLeft = false;
      sc.scrollTo(0, 0);
    }
    if (pendingScroll) {
      sc.scrollTo(pendingScroll.sl, pendingScroll.st);
      pendingScroll = null;
    }
    const a = pendingAnchor;
    pendingAnchor = null;
    if (!a) return;
    const r = page.getBoundingClientRect();
    sc.scrollLeft += r.left + a.px * zoom - a.cx;
    sc.scrollTop += r.top + a.py * zoom - a.cy;
  }, [zoom]);

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms at the cursor
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      setZoom(live.current.zoom * Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.002), e);
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, []);

  // arrow keys nudge the selected items: 0.5 mm, Shift one grid step, Ctrl/Cmd 0.1 mm (to clean multiples of the step).
  // Gates selected in a plot take the arrows (PlotView); Alt+Up/Down steps through the samples (App).
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.key.startsWith('Arrow') || e.altKey || typing(e.target)) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && t !== document.documentElement && !t.closest?.('.sheet-scroll')) return;
      const st = useStore.getState();
      const ui = st.ui;
      if (ui.view !== 'sheet' || ui.dialog || ui.gatingItemId || !ui.selectedItemIds.length) return;
      const sh = st.ws.worksheets.find((w) => w.id === ui.activeSheetId) ?? st.ws.worksheets[0];
      if (!sh) return;
      // a selected gate drawn in a selected plot: the arrows move the gate (PlotView)
      const pop = ui.selectedPopId ? st.ws.populations.find((q) => q.id === ui.selectedPopId) : undefined;
      if (pop && sh.items.some((i) => i.kind === 'plot' && ui.selectedItemIds.includes(i.id) && (i.layers[0]?.population ?? 'root') === (pop.parentId ?? 'root') && gateMatchesPlot(pop.gate, i).ok)) return;
      const ids = ui.selectedItemIds.filter((id) => sh.items.some((i) => i.id === id));
      if (!ids.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      nudgeItems(sh.id, ids, dx, dy, { shift: e.shiftKey, alt: e.ctrlKey || e.metaKey });
      const moved = useStore.getState().ws.worksheets.find((w) => w.id === sh.id)?.items.filter((i) => ids.includes(i.id)) ?? [];
      if (moved.length) setCursorInfo(`X ${mm(Math.min(...moved.map((i) => i.x)))}   Y ${mm(Math.min(...moved.map((i) => i.y)))} mm`);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [readOnly]);

  // Space + drag pans the worksheet (while the pointer is over it, even if a toolbar button has the focus)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e.target) || useStore.getState().ui.dialog) return;
      const t = e.target as HTMLElement | null;
      if (!overRef.current && !(t === document.body || t?.closest?.('.sheet-scroll'))) return;
      e.preventDefault(); // no page scroll, no button press
      if (e.repeat) return;
      spaceRef.current = true;
      setPanReady(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceRef.current) return;
      e.preventDefault();
      spaceRef.current = false;
      setPanReady(false);
    };
    const blur = () => {
      spaceRef.current = false;
      setPanReady(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // ---------------------------------------------------------------- drags (window listeners: no ghost rubber bands)
  const startDrag = (d: DragState, e: RPE<HTMLElement>) => {
    endDragRef.current?.(true);
    dragRef.current = d;
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* element gone */
    }
    const move = (ev: PointerEvent) => onDragMove(ev);
    const up = (ev: PointerEvent) => end(false, ev);
    const lost = (ev: PointerEvent) => ev.target === el && end(false);
    const cancel = () => end(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end(true);
    };
    const end = (cancelled: boolean, ev?: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('lostpointercapture', lost, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      endDragRef.current = null;
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      finishDrag(cancelled, ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('lostpointercapture', lost, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    endDragRef.current = end;
  };

  const rubberRect = (d: { x0: number; y0: number }, ev: { clientX: number; clientY: number }): Rect => {
    const p = toPage(ev);
    return { x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0) };
  };

  const onDragMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const { sheet, zoom } = live.current;
    const st = useStore.getState();
    if (d.kind === 'pan') {
      const sc = scrollRef.current;
      if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 6) return;
      d.moved = true;
      if (sc) {
        sc.scrollLeft = d.sl - (e.clientX - d.cx);
        sc.scrollTop = d.st - (e.clientY - d.cy);
      }
      return;
    }
    if (d.kind === 'rubber') {
      d.rect = rubberRect(d, e);
      setRubber(d.rect);
      return;
    }
    const p = toPage(e);
    if (d.kind === 'move') {
      let dx = p.x - d.x0;
      let dy = p.y - d.y0;
      if (!d.moved && Math.hypot(dx, dy) * zoom < 3) return;
      d.moved = true;
      const ids = Object.keys(d.start);
      // bounding box of the moving group at start
      const moving = sheet.items.filter((i) => d.start[i.id]);
      if (!moving.length) return;
      const bx = Math.min(...moving.map((i) => d.start[i.id].x));
      const by = Math.min(...moving.map((i) => d.start[i.id].y));
      const bw = Math.max(...moving.map((i) => d.start[i.id].x + i.w)) - bx;
      const bh = Math.max(...moving.map((i) => d.start[i.id].y + i.h)) - by;
      let nx = bx + dx;
      let ny = by + dy;
      // smart guides against other items (not the panel letters lying on them). Precedence: equal spacing, then the
      // edges / middles of the neighbours, then the grid; all measured from where the pointer puts the group (not from
      // a grid-snapped position) with tolerances in screen pixels, so alignment works at any zoom
      const others = sheet.items.filter((i) => !d.start[i.id] && !isPanelLabel(i));
      const tol = GUIDE_TOL_PX / zoom;
      const gv: number[] = [];
      const gh: number[] = [];
      const gaps: Rect[] = [];
      const snapped = alignDrag({ x: nx, y: ny, w: bw, h: bh }, others, { tol, spacingTol: 9 / zoom, grid: sheet.snap && !e.altKey ? sheet.grid : 0, off: e.altKey });
      nx = snapped.x;
      ny = snapped.y;
      gv.push(...snapped.v);
      gh.push(...snapped.h);
      gaps.push(...snapped.gaps);
      // keep part of the group on the page so it stays reachable
      nx = Math.min(sheet.page.w - KEEP_ON_PAGE, Math.max(KEEP_ON_PAGE - bw, nx));
      ny = Math.min(sheet.page.h - KEEP_ON_PAGE, Math.max(KEEP_ON_PAGE - bh, ny));
      setGuides({ v: gv, h: gh, gaps });
      dx = nx - bx;
      dy = ny - by;
      setCursorInfo(`X ${mm(nx)}   Y ${mm(ny)} mm${ids.length > 1 ? `   (${ids.length} items)` : ''}`);
      st.update((w) => {
        const sh = w.worksheets.find((s) => s.id === sheet.id)!;
        for (const it of sh.items)
          if (d.start[it.id]) {
            it.x = d.start[it.id].x + dx;
            it.y = d.start[it.id].y + dy;
          }
      }, d.key);
      return;
    }
    // resize
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    let { x, y, w, h } = d.r0;
    const hd = d.handle;
    const right = d.r0.x + d.r0.w;
    const bottom = d.r0.y + d.r0.h;
    if (hd.includes('e')) w = d.r0.w + dx;
    if (hd.includes('s')) h = d.r0.h + dy;
    if (hd.includes('w')) {
      x = d.r0.x + dx;
      w = d.r0.w - dx;
    }
    if (hd.includes('n')) {
      y = d.r0.y + dy;
      h = d.r0.h - dy;
    }
    if (e.shiftKey && hd.length === 2) {
      const ar = d.r0.w / d.r0.h;
      if (w / h > ar) w = h * ar;
      else h = w / ar;
      if (hd.includes('w')) x = right - w;
      if (hd.includes('n')) y = bottom - h;
    }
    if (sheet.snap && !e.altKey) {
      const g = sheet.grid;
      const r = x + w;
      const b = y + h;
      if (hd.includes('w')) x = snapV(x, g, true);
      if (hd.includes('n')) y = snapV(y, g, true);
      w = (hd.includes('e') ? snapV(r, g, true) : r) - x;
      h = (hd.includes('s') ? snapV(b, g, true) : b) - y;
    }
    // minimum size; the edge opposite to the dragged handle stays put
    if (w < 40) {
      w = 40;
      if (hd.includes('w')) x = right - w;
    }
    if (h < 24) {
      h = 24;
      if (hd.includes('n')) y = bottom - h;
    }
    setCursorInfo(`X ${mm(x)}   Y ${mm(y)}   W ${mm(w)}   H ${mm(h)} mm`);
    st.update((ws2) => {
      const sh = ws2.worksheets.find((s) => s.id === sheet.id)!;
      const it = sh.items.find((i) => i.id === d.id);
      if (!it) return;
      // its panel letter stays in the top-left corner
      const ddx = x - it.x;
      const ddy = y - it.y;
      if (ddx || ddy) for (const l of sh.items) if (isPanelLabel(l) && l.forItem === it.id) Object.assign(l, { x: l.x + ddx, y: l.y + ddy });
      Object.assign(it, { x, y, w, h });
      // a text box sized by hand keeps its height when its text or font changes (see fitTextHeights)
      if (it.kind === 'text' && Math.abs(h - d.r0.h) > 0.01) it.hFixed = true;
    }, d.key);
  };

  const finishDrag = (cancelled: boolean, ev?: PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setGuides({ v: [], h: [] });
    setRubber(null);
    if (!d) return;
    const st = useStore.getState();
    if (d.kind === 'move' || d.kind === 'resize') {
      setCursorInfo('');
      if (cancelled) st.cancelGroup(d.key);
      else if (d.kind === 'move' && !d.moved && d.clickOnly) st.setUI({ selectedItemIds: [d.clickOnly] });
      return;
    }
    if (d.kind === 'pan') {
      // a tap on the page background (touch) deselects, like a click
      if (!cancelled && d.tap && !d.moved) st.setUI({ selectedItemIds: [], selectedPopId: null, keyItemId: null });
      return;
    }
    if (d.kind !== 'rubber') return;
    if (cancelled) {
      st.setUI({ selectedItemIds: d.base });
      return;
    }
    const r = ev ? rubberRect(d, ev) : d.rect;
    if (!r || (r.w * live.current.zoom < 3 && r.h * live.current.zoom < 3)) return;
    const hit = live.current.sheet.items.filter((i) => i.x < r.x + r.w && i.x + i.w > r.x && i.y < r.y + r.h && i.y + i.h > r.y).map((i) => i.id);
    st.setUI({ selectedItemIds: d.additive ? [...new Set([...d.base, ...hit])] : hit });
  };

  // ---------------------------------------------------------------- pointer handling
  const onScrollDownCapture = (e: RPE<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size >= 2) {
        // second finger: pinch zoom; whatever the first finger started is cancelled
        e.preventDefault();
        e.stopPropagation();
        if (touches.current.size === 2) startPinch();
        return;
      }
      const t = e.target as Element;
      // one finger on the page background (or anywhere in the viewer) pans; on items it moves / edits them
      if (readOnly || (!t.closest('.item, .rename-pop, .ag-pop, input, textarea, button, select') && useStore.getState().ui.tool !== 'text')) {
        e.preventDefault();
        e.stopPropagation();
        const sc = scrollRef.current!;
        startDrag({ kind: 'pan', cx: e.clientX, cy: e.clientY, sl: sc.scrollLeft, st: sc.scrollTop, tap: !readOnly }, e);
      }
      return;
    }
    // Space + drag, middle button (or any drag in the viewer): pan
    if (!(spaceRef.current && e.button === 0) && e.button !== 1 && !(readOnly && e.button === 0)) return;
    e.preventDefault();
    e.stopPropagation();
    const sc = scrollRef.current!;
    startDrag({ kind: 'pan', cx: e.clientX, cy: e.clientY, sl: sc.scrollLeft, st: sc.scrollTop }, e);
  };

  const startPinch = () => {
    const [a, b] = [...touches.current.values()];
    endDragRef.current?.(true);
    // a plot that took the first finger (gate drag, drawing) lets go of it
    for (const id of touches.current.keys())
      scrollRef.current?.querySelectorAll('canvas, .item').forEach((el) => {
        try {
          if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
        } catch {
          /* ignore */
        }
      });
    const page = pageRef.current;
    if (!page) return;
    const r = page.getBoundingClientRect();
    const z = live.current.zoom;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    pinch.current = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: z, px: (mx - r.left) / z, py: (my - r.top) / z };
  };

  // touch pointers: pinch moves, and the bookkeeping of fingers on the sheet
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = pinch.current;
      if (!p || touches.current.size < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const [a, b] = [...touches.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAround((p.z0 * d) / p.d0, p.px, p.py, (a.x + b.x) / 2, (a.y + b.y) / 2);
    };
    const up = (e: PointerEvent) => {
      if (!touches.current.delete(e.pointerId)) return;
      if (pinch.current) {
        // the fingers of a pinch do not click anything when lifted
        e.stopPropagation();
        if (!touches.current.size) pinch.current = null;
      }
    };
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, []);

  /** Text tool: open an editor for a new text box at page point p (the item is created when text is entered). */
  const startText = (p: { x: number; y: number }) => {
    if (p.x < 0 || p.y < 0 || p.x > sheet.page.w || p.y > sheet.page.h) return;
    const g = sheet.grid;
    setEditingText(null);
    // the figure font size; no color of its own: the page's text color (light on dark pages, also after a page change)
    setDraftText({ id: uid('txt'), kind: 'text', x: snapV(p.x, g, sheet.snap), y: snapV(p.y, g, sheet.snap), w: g * 12, h: g * 2, text: '', fontSize: bodyPt(useStore.getState().ws, sheet), bold: false, italic: false, align: 'left', color: '' });
    useStore.getState().setUI({ tool: 'select', selectedItemIds: [], selectedPopId: null });
  };

  const onBackgroundDown = (e: RPE<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const st = useStore.getState();
    const p = toPage(e);
    if (st.ui.tool === 'text') {
      startText(p);
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? st.ui.selectedItemIds : [];
    if (!additive) st.setUI({ selectedItemIds: [], selectedPopId: null, keyItemId: null });
    startDrag({ kind: 'rubber', x0: p.x, y0: p.y, additive, base, rect: null }, e);
  };

  const onItemDown = (e: RPE<HTMLDivElement>, it: SheetItem) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = useStore.getState();
    let sel = st.ui.selectedItemIds;
    const tool = st.ui.tool;
    if (tool === 'text') {
      // on a text box: edit it; elsewhere (e.g. over a plot): a new annotation on top
      if (it.kind === 'text') {
        st.setUI({ tool: 'select', selectedItemIds: [it.id], selectedPopId: null });
        setEditingText(it.id);
      } else startText(toPage(e));
      return;
    }
    if (tool !== 'select' && it.kind === 'plot') {
      // gate / zoom tools draw in plots (PlotView); a press it did not take only selects the plot
      if (!sel.includes(it.id)) st.setUI({ selectedItemIds: [it.id], keyItemId: it.id });
      return;
    }
    let clickOnly: string | null = null;
    if (e.shiftKey || e.metaKey || e.ctrlKey) sel = sel.includes(it.id) ? sel.filter((i) => i !== it.id) : [...sel, it.id];
    else if (!sel.includes(it.id)) sel = [it.id];
    else if (sel.length > 1) clickOnly = it.id; // a click without a drag selects only this item
    st.setUI({ selectedItemIds: sel, selectedPopId: null, keyItemId: sel.includes(it.id) ? it.id : st.ui.keyItemId === it.id ? null : st.ui.keyItemId });
    if (!sel.includes(it.id)) return;
    const p = toPage(e);
    const start: Record<string, { x: number; y: number }> = {};
    // panel letters move with their items
    for (const i of sheet.items) if (sel.includes(i.id) || (isPanelLabel(i) && sel.includes(i.forItem ?? ''))) start[i.id] = { x: i.x, y: i.y };
    startDrag({ kind: 'move', x0: p.x, y0: p.y, start, moved: false, key: 'move:' + Object.keys(start).join(','), clickOnly }, e);
  };

  const onHandleDown = (e: RPE<HTMLDivElement>, it: SheetItem, h: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toPage(e);
    startDrag({ kind: 'resize', id: it.id, handle: h, x0: p.x, y0: p.y, r0: { x: it.x, y: it.y, w: it.w, h: it.h }, key: 'resize:' + it.id }, e);
  };

  // ---------------------------------------------------------------- DnD from panels
  const parseDrag = (e: DragEvent): { type: 'sample' | 'population'; id: string } | null => {
    try {
      const raw = e.dataTransfer.getData(DND_TYPE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const isOurDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DND_TYPE);

  const dropOnItem = (e: DragEvent, it: SheetItem) => {
    const d = parseDrag(e);
    setDropOn(null);
    if (!d || it.kind !== 'plot') return;
    e.preventDefault();
    e.stopPropagation();
    const st = useStore.getState();
    const addLayer = it.plotType === 'histogram' || e.shiftKey;
    st.update((w) => {
      const p = w.worksheets.find((s) => s.id === sheet.id)!.items.find((i) => i.id === it.id) as PlotItem;
      if (!p.layers.length) p.layers.push({ id: uid('ly'), sample: 'active', population: 'root' });
      if (d.type === 'sample') {
        if (addLayer) p.layers.push({ id: uid('ly'), sample: d.id, population: p.layers[0].population });
        else p.layers[0].sample = d.id;
      } else {
        if (addLayer) p.layers.push({ id: uid('ly'), sample: p.layers[0].sample, population: d.id });
        else {
          setPlotPopulation(w, p, d.id, st.ui.activeSampleId);
          p.options.labelPos = {};
          p.options.labelOff = {};
        }
      }
      // first overlay layer: make the original one explicit (histogram overlays compare samples)
      if (addLayer && p.layers.length === 2 && d.type === 'sample' && p.layers[0].sample === 'active' && st.ui.activeSampleId) p.layers[0].sample = st.ui.activeSampleId;
    });
    st.setUI({ selectedItemIds: [it.id], selectedPopId: null, keyItemId: it.id });
  };

  const dropOnPage = (e: DragEvent) => {
    const d = parseDrag(e);
    setDropOn(null);
    if (!d) return;
    e.preventDefault();
    const st = useStore.getState();
    // some browsers report (0, 0) for the drop itself: use the last drag-over position then
    const at = e.clientX || e.clientY ? e : lastOver.current ?? e;
    const p = toPage(at);
    const g = sheet.grid;
    const sz = defaultPlotSize();
    // centered on the drop point, snapped, kept on the page
    const x = Math.max(0, Math.min(snapV(p.x - sz.w / 2, g, sheet.snap), Math.max(0, sheet.page.w - sz.w)));
    const y = Math.max(0, Math.min(snapV(p.y - sz.h / 2, g, sheet.snap), Math.max(0, sheet.page.h - sz.h)));
    let item: PlotItem;
    if (d.type === 'sample') {
      // scatter channels of the dropped sample (not of the active one, nor gated channels of a selected population)
      const { fsc, ssc } = pickDefaultChannels(st.ws, { sampleIds: [d.id], popId: null });
      item = newPlotItem('pseudo', fsc, ssc, x, y, undefined, undefined, 'root', d.id);
    } else {
      // the axes of the next gating step (the population's child gates), else of its own gate
      const spec = populationPlotSpec(st.ws, d.id);
      item = newPlotItem(spec.type, spec.x, spec.y, x, y, undefined, undefined, d.id);
    }
    lastOver.current = null;
    addItems(sheet.id, [item]);
  };

  // ---------------------------------------------------------------- render
  const W = sheet.page.w * zoom;
  const H = sheet.page.h * zoom;
  const gridBg = useMemo(() => pageBackground(sheet, zoom), [sheet, zoom]);

  const renamePayload = ui.dialog?.kind === 'renamePop' ? (ui.dialog.payload as { popId: string; itemId: string; x: number; y: number }) : null;
  // (a plot shown in the gating view has its rename box there)
  const renameHere = renamePayload && sheet.items.some((i) => i.id === renamePayload.itemId) && ui.gatingItemId !== renamePayload.itemId ? renamePayload : null;

  return (
    <div
      ref={scrollRef}
      className={`sheet-scroll${panReady ? ' pan-ready' : ''}${readOnly ? ' readonly' : ''}`}
      onPointerDownCapture={onScrollDownCapture}
      onPointerEnter={() => (overRef.current = true)}
      onPointerLeave={() => (overRef.current = false)}
      onPointerDown={(e) => !readOnly && e.target === e.currentTarget && onBackgroundDown(e)}
      onContextMenu={readOnly ? (e) => e.preventDefault() : undefined}
    >
      <div className="sheet-stage" style={{ width: W, height: H }}>
        <div
          ref={pageRef}
          className="page"
          style={{ width: W, height: H, ...gridBg }}
          onPointerDown={readOnly ? undefined : onBackgroundDown}
          onDragOver={(e) => {
            if (isOurDrag(e)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              if (e.clientX || e.clientY) lastOver.current = { clientX: e.clientX, clientY: e.clientY };
            }
          }}
          onDrop={dropOnPage}
        >
          {sheet.items.map((it) => (
            <div
              key={it.id}
              data-item-id={it.id}
              className={`item${ui.selectedItemIds.includes(it.id) ? ' sel' : ''}`}
              style={{ left: it.x * zoom, top: it.y * zoom, width: it.w * zoom, height: it.h * zoom }}
              onPointerDown={(e) => onItemDown(e, it)}
              onDoubleClick={() => it.kind === 'text' && setEditingText(it.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const st = useStore.getState();
                if (!st.ui.selectedItemIds.includes(it.id)) st.setUI({ selectedItemIds: [it.id], selectedPopId: null, keyItemId: it.id });
                setCtx({ x: e.clientX, y: e.clientY, itemId: it.id });
              }}
              onDragOver={(e) => {
                if (it.kind === 'plot' && isOurDrag(e)) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'copy';
                  if (dropOn !== it.id) setDropOn(it.id);
                }
              }}
              onDragLeave={() => dropOn === it.id && setDropOn(null)}
              onDrop={(e) => dropOnItem(e, it)}
            >
              {it.kind === 'plot' ? (
                <PlotView item={it} zoom={zoom} sheetId={sheet.id} onPickAxis={(axis, x, y) => setPicker({ itemId: it.id, axis, x, y })} />
              ) : it.kind === 'text' ? (
                editingText === it.id ? (
                  <TextEditor item={{ ...it, color: textColorOf(it, sheet) }} sheet={sheet} zoom={zoom} family={ws.style.fontFamily} onDone={() => setEditingText(null)} />
                ) : (
                  <>
                    <TextView item={{ ...it, color: textColorOf(it, sheet) }} zoom={zoom} family={ws.style.fontFamily} />
                    {textOverflows(it, ws.style.fontFamily) && (
                      <div className="text-overflow" role="img" aria-label="Text does not fit" title="The text does not fit this box (its height was set by hand): make it taller, or use Fit height to text in the inspector">
                        +
                      </div>
                    )}
                  </>
                )
              ) : it.kind === 'chart' ? (
                <ChartView item={it} zoom={zoom} />
              ) : (
                <StatsBoxView item={it} zoom={zoom} />
              )}
              {dropOn === it.id && <div className="drop-hint" />}
              {ui.selectedItemIds.length === 1 &&
                ui.selectedItemIds[0] === it.id &&
                editingText !== it.id &&
                HANDLES.map((h) => <div key={h} className="handle" style={handleStyle(h, it.w * zoom, it.h * zoom)} onPointerDown={(e) => onHandleDown(e, it, h)} />)}
            </div>
          ))}
          {draftText && (
            <div className="item sel" style={{ left: draftText.x * zoom, top: draftText.y * zoom, width: draftText.w * zoom, height: draftText.h * zoom }} onPointerDown={(e) => e.stopPropagation()}>
              <TextEditor item={draftText} sheet={sheet} zoom={zoom} family={ws.style.fontFamily} isNew onDone={() => setDraftText(null)} />
            </div>
          )}
          {rubber && <div className="rubber" style={{ left: rubber.x * zoom, top: rubber.y * zoom, width: rubber.w * zoom, height: rubber.h * zoom }} />}
          {guides.v.map((x, i) => (
            <div key={'v' + i} className="guide" style={{ left: x * zoom, top: 0, width: 1, height: H }} />
          ))}
          {guides.h.map((y, i) => (
            <div key={'h' + i} className="guide" style={{ top: y * zoom, left: 0, height: 1, width: W }} />
          ))}
          {(guides.gaps ?? []).map((r, i) => (
            <div key={'g' + i} className={`guide-gap${r.h === 0 ? ' hz' : ' vt'}`} style={{ left: r.x * zoom, top: r.y * zoom, width: Math.max(1, r.w * zoom), height: Math.max(1, r.h * zoom) }} />
          ))}
          {renameHere && <RenameBox payload={renameHere} zoom={zoom} />}
        </div>
      </div>
      {picker && <ParamPicker picker={picker} sheet={sheet} onClose={() => setPicker(null)} />}
      {ctx && <ItemMenu ctx={ctx} sheet={sheet} onClose={() => setCtx(null)} />}
      {sheet.items.length === 0 && !draftText && (
        <div className="sheet-empty">
          <div className="sheet-empty-title">Empty worksheet</div>
          <div className="sheet-empty-text">
            {readOnly
              ? 'This worksheet has no plots yet.'
              : 'Drag a sample or population onto the page, or add a plot from the Home or Plot tab. On a touch screen, press and hold a sample or population for "Add plot to sheet".'}
          </div>
        </div>
      )}
    </div>
  );
}

/** CSS background of the page: its color and the grid (lines or dots, optional major lines every N cells). */
function pageBackground(sheet: Worksheet, zoom: number): React.CSSProperties {
  const out: React.CSSProperties = { backgroundColor: sheet.pageColor ?? '#ffffff' };
  const style = sheetGridStyle(sheet);
  const s = sheet.grid * zoom;
  if (style === 'none' || s < 4) return out;
  const [r, g, b] = hexToRgb(sheet.gridColor ?? DEFAULT_GRID_COLOR);
  const op = sheetGridOpacity(sheet);
  const c = (a: number) => `rgba(${r},${g},${b},${Math.min(1, a)})`;
  const N = sheet.gridMajor ?? 0;
  const img: string[] = [];
  const size: string[] = [];
  if (style === 'lines') {
    if (N > 1) {
      img.push(`linear-gradient(to right, ${c(op * 2.5)} 1px, transparent 1px)`, `linear-gradient(to bottom, ${c(op * 2.5)} 1px, transparent 1px)`);
      size.push(`${s * N}px ${s * N}px`, `${s * N}px ${s * N}px`);
    }
    img.push(`linear-gradient(to right, ${c(op)} 1px, transparent 1px)`, `linear-gradient(to bottom, ${c(op)} 1px, transparent 1px)`);
    size.push(`${s}px ${s}px`, `${s}px ${s}px`);
  } else {
    const d = Math.max(0.8, Math.min(1.4, s / 12));
    if (N > 1) {
      img.push(`radial-gradient(circle at 0 0, ${c(op * 1.6)} ${d * 1.7}px, transparent ${d * 1.7 + 0.8}px)`);
      size.push(`${s * N}px ${s * N}px`);
    }
    img.push(`radial-gradient(circle at 0 0, ${c(op)} ${d}px, transparent ${d + 0.8}px)`);
    size.push(`${s}px ${s}px`);
  }
  out.backgroundImage = img.join(', ');
  out.backgroundSize = size.join(', ');
  return out;
}

/** Alignment guide tolerance in screen pixels (the page distance is this divided by the zoom). */
export const GUIDE_TOL_PX = 6;

/**
 * Where a dragged box (page px) goes: equal spacing with its neighbours first, else an edge or middle aligned with a
 * neighbour's edge or middle (within `tol`, from the unsnapped position), else the grid (`grid` 0: off). `off` (Alt):
 * free placement. Returns the position and the guides to show.
 */
export function alignDrag(b: Rect, others: Rect[], o: { tol: number; spacingTol: number; grid: number; off: boolean }): { x: number; y: number; v: number[]; h: number[]; gaps: Rect[] } {
  let { x, y } = b;
  const v: number[] = [];
  const h: number[] = [];
  const gaps: Rect[] = [];
  if (o.off) return { x, y, v, h, gaps };
  const sx = spacingSnap(x, b.w, y, b.h, others, 'x', o.spacingTol);
  const sy = spacingSnap(y, b.h, x, b.w, others, 'y', o.spacingTol);
  const best = (cands: number[], lines: number[]) => {
    let r: { d: number; adj: number; at: number } | null = null;
    for (const l of lines)
      for (const c of cands) {
        const dd = Math.abs(c - l);
        if (dd < o.tol && (!r || dd < r.d)) r = { d: dd, adj: l - c, at: l };
      }
    return r;
  };
  if (sx) {
    x = sx.pos;
    gaps.push(...sx.marks);
  } else {
    const bX = best([x, x + b.w / 2, x + b.w], others.flatMap((q) => [q.x, q.x + q.w / 2, q.x + q.w]));
    if (bX) {
      x += bX.adj;
      v.push(bX.at);
    } else if (o.grid) x = snapV(x, o.grid, true);
  }
  if (sy) {
    y = sy.pos;
    gaps.push(...sy.marks);
  } else {
    const bY = best([y, y + b.h / 2, y + b.h], others.flatMap((q) => [q.y, q.y + q.h / 2, q.y + q.h]));
    if (bY) {
      y += bY.adj;
      h.push(bY.at);
    } else if (o.grid) y = snapV(y, o.grid, true);
  }
  return { x, y, v, h, gaps };
}

export function snapV(v: number, g: number, on: boolean) {
  return on && g > 0 ? Math.round(v / g) * g : v;
}

/**
 * Equal-spacing snap of a moving box along `axis` (x: its row neighbours, y: its column neighbours): the gaps already
 * used between neighbours in that row, the default arrange gap, or the middle between the two neighbours. Returns the
 * position within `tol` of `pos` closest to it, with markers of the gaps it matches, or null.
 */
function spacingSnap(pos: number, size: number, cross: number, crossSize: number, others: Rect[], axis: 'x' | 'y', tol: number): { pos: number; marks: Rect[] } | null {
  const a0 = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const len = (r: Rect) => (axis === 'x' ? r.w : r.h);
  const c0 = (r: Rect) => (axis === 'x' ? r.y : r.x);
  const clen = (r: Rect) => (axis === 'x' ? r.h : r.w);
  // neighbours: overlapping the moving box across the axis by at least a third
  const band = others.filter((o) => Math.min(c0(o) + clen(o), cross + crossSize) - Math.max(c0(o), cross) > Math.min(clen(o), crossSize) / 3).sort((p, q) => a0(p) - a0(q));
  if (!band.length) return null;
  const mid = pos + size / 2;
  const before = band.filter((o) => a0(o) + len(o) / 2 < mid);
  const after = band.filter((o) => a0(o) + len(o) / 2 >= mid);
  const L = before.length ? before.reduce((p, q) => (a0(q) + len(q) > a0(p) + len(p) ? q : p)) : null;
  const R = after.length ? after.reduce((p, q) => (a0(q) < a0(p) ? q : p)) : null;
  // gaps between neighbours in the band (and the default arrange gap)
  const used: { gap: number; from: Rect; to: Rect }[] = [];
  for (let i = 0; i + 1 < band.length; i++) {
    const g = a0(band[i + 1]) - (a0(band[i]) + len(band[i]));
    if (g > 0.5 && g < 40 * MM) used.push({ gap: g, from: band[i], to: band[i + 1] });
  }
  const gaps = [...new Set([...used.map((u) => Math.round(u.gap * 1000) / 1000), arrangeGapMm() * MM])];
  const cands: { pos: number; gap: number; side: 'L' | 'R' | 'C' }[] = [];
  for (const g of gaps) {
    if (L) cands.push({ pos: a0(L) + len(L) + g, gap: g, side: 'L' });
    if (R) cands.push({ pos: a0(R) - g - size, gap: g, side: 'R' });
  }
  if (L && R && a0(R) - (a0(L) + len(L)) > size) {
    const g = (a0(R) - (a0(L) + len(L)) - size) / 2;
    cands.push({ pos: a0(L) + len(L) + g, gap: g, side: 'C' });
  }
  let best: (typeof cands)[number] | null = null;
  for (const c of cands) if (Math.abs(c.pos - pos) < tol && (!best || Math.abs(c.pos - pos) < Math.abs(best.pos - pos))) best = c;
  if (!best) return null;
  // markers: the matched gap(s) of the moving box and the equal gaps between the neighbours
  const crossMid = cross + crossSize / 2;
  const mark = (from: number, to: number, at: number): Rect => (axis === 'x' ? { x: from, y: at, w: to - from, h: 0 } : { x: at, y: from, w: 0, h: to - from });
  const marks: Rect[] = [];
  if (L && (best.side === 'L' || best.side === 'C')) marks.push(mark(a0(L) + len(L), best.pos, crossMid));
  if (R && (best.side === 'R' || best.side === 'C')) marks.push(mark(best.pos + size, a0(R), crossMid));
  for (const u of used) if (Math.abs(u.gap - best.gap) < 0.01) marks.push(mark(a0(u.from) + len(u.from), a0(u.to), c0(u.from) + clen(u.from) / 2));
  return { pos: best.pos, marks };
}

function handleStyle(h: string, w: number, hh: number): React.CSSProperties {
  const c = -5;
  const pos: React.CSSProperties = {};
  if (h.includes('n')) pos.top = c;
  else if (h.includes('s')) pos.top = hh + c;
  else pos.top = hh / 2 + c;
  if (h.includes('w')) pos.left = c;
  else if (h.includes('e')) pos.left = w + c;
  else pos.left = w / 2 + c;
  const cursors: Record<string, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  pos.cursor = cursors[h];
  return pos;
}

const textStyle = (item: TextItem, zoom: number, family: string): React.CSSProperties => ({
  fontFamily: withFallback(family), // the bundled metric-compatible face where the font is missing (as measured)
  fontSize: item.fontSize * PT * zoom,
  fontWeight: item.bold ? 700 : 400,
  fontStyle: item.italic ? 'italic' : 'normal',
  textAlign: item.align,
  color: item.color || '#000000',
});

/**
 * Browsers round the font ascent and the half-leading of a line to whole pixels (Chrome: at the zoomed size), which puts
 * the text up to 1 px above or below where the exports draw it (render/items.ts, renderText). Measure the first baseline
 * and shift the text box onto the exported position.
 */
function useExportBaseline(ref: React.RefObject<HTMLDivElement>, item: TextItem, zoom: number, family: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const first = el.firstElementChild;
      if (!first) return;
      el.style.transform = '';
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      first.insertBefore(probe, first.firstChild);
      const box = el.getBoundingClientRect();
      const h = parseFloat(getComputedStyle(el).height);
      const scale = h > 0 ? box.height / h : 1; // CSS transforms of ancestors
      const dom = (probe.getBoundingClientRect().top - box.top) / (scale || 1);
      probe.remove();
      const vm = vmetrics(family);
      const want = ((1.2 - (vm.asc + vm.desc)) / 2 + vm.asc) * item.fontSize * PT * zoom;
      const dy = want - dom;
      if (Math.abs(dy) > 0.01 && Math.abs(dy) < item.fontSize * PT * zoom * 0.5) el.style.transform = `translateY(${dy.toFixed(3)}px)`;
    };
    fit();
    const fonts = document.fonts;
    fonts?.addEventListener?.('loadingdone', fit);
    return () => fonts?.removeEventListener?.('loadingdone', fit);
  }, [ref, item.text, item.fontSize, item.bold, item.italic, zoom, family]);
}

function TextView({ item, zoom, family }: { item: TextItem; zoom: number; family: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useExportBaseline(ref, item, zoom, family);
  return (
    <div ref={ref} className="text-item" style={textStyle(item, zoom, family)}>
      {item.text.split('\n').map((line, i) => (
        <div key={i}>{line.includes('^') ? parseSup(line).map((r, k) => (r.sup ? <sup key={k}>{r.text}</sup> : <span key={k}>{r.text}</span>)) : line || ' '}</div>
      ))}
    </div>
  );
}

/** Size of a new text box that fits its text (grid-snapped). */
function fitTextBox(item: TextItem, text: string, family: string, sheet: Worksheet): { w: number; h: number } {
  const g = sheet.grid || 10;
  const size = item.fontSize * PT;
  const lines = text.split('\n');
  let wMax = 0;
  const cx = document.createElement('canvas').getContext('2d');
  if (cx) {
    cx.font = `${item.italic ? 'italic ' : ''}${item.bold ? 'bold ' : ''}${size}px ${family}`;
    for (const l of lines) wMax = Math.max(wMax, cx.measureText(l).width);
  }
  const w = Math.min(Math.max(g * 4, Math.ceil((wMax + 8) / g) * g), Math.max(g * 4, sheet.page.w - item.x));
  const h = Math.max(g * 2, Math.ceil((lines.length * size * 1.2 + 4) / g) * g);
  return { w, h };
}

function TextEditor({ item, sheet, zoom, family, onDone, isNew }: { item: TextItem; sheet: Worksheet; zoom: number; family: string; onDone: () => void; isNew?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [val, setVal] = useState(item.text);
  const done = useRef(false);
  useEffect(() => {
    // focus after the pressing pointer event has finished (else the press takes the focus back and the editor closes)
    const id = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const st = useStore.getState();
    const text = val.replace(/\s+$/, '');
    if (isNew) {
      if (save && text.trim()) addItems(sheet.id, [{ ...item, text, ...fitTextBox(item, text, family, sheet) }]);
    } else if (save && !text.trim()) {
      // an emptied text box is removed
      st.update((w) => {
        const sh = w.worksheets.find((s) => s.id === sheet.id)!;
        sh.items = sh.items.filter((i) => i.id !== item.id);
      });
      st.setUI({ selectedItemIds: [] });
    } else if (save && text !== item.text)
      st.update((w) => {
        const it = w.worksheets.find((s) => s.id === sheet.id)!.items.find((i) => i.id === item.id) as TextItem | undefined;
        if (it) it.text = text;
      }, 'txt' + item.id);
    onDone();
  };
  return (
    <textarea
      ref={ref}
      className="text-edit"
      value={val}
      placeholder="Type text"
      aria-label="Text"
      style={textStyle({ ...item, color: textColorOf(item, sheet) }, zoom, family)}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) finish(true);
      }}
    />
  );
}

function StatsBoxView({ item, zoom }: { item: StatsBoxItem; zoom: number }) {
  const ws = useStore((s) => s.ws);
  const active = useStore((s) => s.ui.activeSampleId);
  const dv = useStore((s) => s.ui.dataVersion);
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const k = fitCanvasScale(item.w, item.h, zoom * Math.min(3, window.devicePixelRatio || 1));
    cv.width = Math.max(1, Math.round(item.w * k));
    cv.height = Math.max(1, Math.round(item.h * k));
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    renderStatsBox(new CanvasPainter(ctx, k), item, ws, engine, active, { deferred: true });
  }, [ws, item, active, dv, zoom]);
  return <canvas ref={ref} />;
}

function ChartView({ item, zoom }: { item: ChartItem; zoom: number }) {
  const ws = useStore((s) => s.ws);
  const active = useStore((s) => s.ui.activeSampleId);
  const dv = useStore((s) => s.ui.dataVersion);
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const k = fitCanvasScale(item.w, item.h, zoom * Math.min(3, window.devicePixelRatio || 1));
    cv.width = Math.max(1, Math.round(item.w * k));
    cv.height = Math.max(1, Math.round(item.h * k));
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    renderChart(new CanvasPainter(ctx, k), item, {
      ws,
      engine,
      activeSampleId: active,
      rasterScale: k,
      makeCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
      deferStats: true,
    });
  }, [ws, item, active, dv, zoom]);
  return <canvas ref={ref} />;
}

export function RenameBox({ payload, zoom }: { payload: { popId: string; x: number; y: number }; zoom: number }) {
  const ws = useStore((s) => s.ws);
  const pop = popById(ws, payload.popId);
  const [val, setVal] = useState(pop?.name ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);
  if (!pop) return null;
  const close = () => useStore.getState().setUI({ dialog: null });
  const commit = () => {
    const v = val.trim();
    if (v && v !== pop.name)
      useStore.getState().update((w) => {
        const p = w.populations.find((x) => x.id === pop.id);
        if (p) p.name = v;
      });
    close();
  };
  return (
    <div className="rename-pop" style={{ left: payload.x * zoom + 6, top: payload.y * zoom + 6 }} onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        value={val}
        aria-label="Population name"
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') close();
        }}
        onBlur={commit}
      />
    </div>
  );
}

export function ParamPicker({ picker, sheet, onClose }: { picker: { itemId: string; axis: 'x' | 'y'; x: number; y: number }; sheet: Worksheet; onClose: () => void }) {
  const it = sheet.items.find((i) => i.id === picker.itemId) as PlotItem | undefined;
  if (!it) return null;
  const cur = picker.axis === 'x' ? it.xParam : it.yParam;
  const active = useStore.getState().ui.activeSampleId;
  const samples = [...new Set(it.layers.map((l) => (l.sample === 'active' ? active : l.sample)).filter((x): x is string => !!x))];
  return (
    <ChannelMenu
      x={picker.x}
      y={picker.y}
      value={cur}
      samples={samples}
      title={picker.axis === 'x' ? 'X axis channel' : 'Y axis channel'}
      onClose={onClose}
      onPick={(ch) => {
        if (ch !== cur)
          useStore.getState().update((w) => {
            const p = w.worksheets.find((s) => s.id === sheet.id)!.items.find((i) => i.id === it.id) as PlotItem;
            // a new parameter starts unzoomed on its own scale
            if (picker.axis === 'x') {
              p.xParam = ch;
              if (p.plotType === 'histogram') p.yParam = ch;
              p.options.xScale = undefined;
              p.options.xWin = undefined;
            } else {
              p.yParam = ch;
              p.options.yScale = undefined;
              p.options.yWin = undefined;
            }
            p.options.labelPos = {};
            p.options.labelOff = {};
          });
      }}
    />
  );
}

function ItemMenu({ ctx, sheet, onClose }: { ctx: { x: number; y: number; itemId: string }; sheet: Worksheet; onClose: () => void }) {
  const st = useStore.getState();
  const sel = st.ui.selectedItemIds.length ? st.ui.selectedItemIds : [ctx.itemId];
  const one = sel.length === 1 ? sheet.items.find((i) => i.id === sel[0]) : undefined;
  const plotItem = one && one.kind === 'plot' ? one : undefined;
  const k = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  return (
    <ContextMenu x={ctx.x} y={ctx.y} onClose={onClose}>
      <button onClick={() => duplicateItems(sheet.id, sel)}>Duplicate</button>
      <button onClick={() => reorder(sheet.id, sel, 'front')}>Bring to front ({k}Shift+])</button>
      <button onClick={() => reorder(sheet.id, sel, 'forward')}>Bring forward ({k}])</button>
      <button onClick={() => reorder(sheet.id, sel, 'backward')}>Send backward ({k}[)</button>
      <button onClick={() => reorder(sheet.id, sel, 'back')}>Send to back ({k}Shift+[)</button>
      <hr />
      {plotItem && <button onClick={() => addStatsBelow(sheet.id, plotItem.id)}>Statistics below plot</button>}
      {plotItem && (plotItem.options.xWin || plotItem.options.yWin) && (
        <button
          onClick={() =>
            st.update((w) => {
              const it = w.worksheets.find((x) => x.id === sheet.id)!.items.find((i) => i.id === plotItem.id) as PlotItem;
              it.options.xWin = undefined;
              it.options.yWin = undefined;
            })
          }
        >
          Reset zoom
        </button>
      )}
      <button onClick={() => copyAsImage(sheet.id, sel)}>Copy as image</button>
      <button onClick={() => st.setUI({ dialog: { kind: 'batch', payload: { itemIds: sel } } })}>Repeat for samples…</button>
      <button onClick={() => st.setUI({ dialog: { kind: 'export', payload: { scope: 'selection' } } })}>Export selection…</button>
      <button onClick={() => showPanel('right')}>Properties</button>
      <hr />
      <button onClick={() => deleteItems(sheet.id, sel)} style={{ color: 'var(--danger)' }}>
        Delete
      </button>
    </ContextMenu>
  );
}
