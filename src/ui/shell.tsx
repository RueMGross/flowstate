// Window layout of the app shell: side panel widths (resizable, persisted), docked / collapsed / drawer state, the
// screen-size modes (wide, compact = side panels as drawers, phone = read-only viewer) and touch helpers.
import { useEffect, useState, type KeyboardEvent as RKE, type PointerEvent as RPE } from 'react';
import { create } from 'zustand';
import { bumpData } from '../state/store';

export type Side = 'left' | 'right';

/** Width limits of the side panels (CSS px). */
export const PANEL_LIMITS: Record<Side, { min: number; max: number }> = { left: { min: 200, max: 520 }, right: { min: 240, max: 560 } };
/** Room the worksheet keeps next to docked panels. */
const CENTER_MIN = 440;

/** Default panel width for the window width: a bit wider on large screens. */
export const defaultPanelWidth = (side: Side, vw: number) => Math.round(Math.max(side === 'left' ? 260 : 272, Math.min(side === 'left' ? 340 : 360, vw * 0.19)));

interface Persisted {
  leftW: number | null;
  rightW: number | null;
  leftOpen: boolean;
  rightOpen: boolean;
  /** ribbon shows only its tabs (null: automatic, minimized on short windows) */
  ribbonMin: boolean | null;
  /** share of the left panel taken by the sample list (0..1) */
  split: number | null;
  /** the sample panel shows a list or the plate */
  sampleView: 'list' | 'plate';
  /** share of the left panel taken by the samples while they show the plate (0..1) */
  splitPlate: number | null;
}

interface LayoutState extends Persisted {
  /** side panel shown as an overlay drawer (compact mode) */
  drawer: Side | null;
  /** ribbon body shown while the ribbon is minimized */
  ribbonPeek: boolean;
  set: (patch: Partial<LayoutState>) => void;
}

const KEY = 'fs.layout';
const DEFAULTS: Persisted = { leftW: null, rightW: null, leftOpen: true, rightOpen: true, ribbonMin: null, split: null, sampleView: 'list', splitPlate: null };

function readPersisted(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Persisted>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      leftW: num(raw.leftW),
      rightW: num(raw.rightW),
      leftOpen: raw.leftOpen !== false,
      rightOpen: raw.rightOpen !== false,
      ribbonMin: typeof raw.ribbonMin === 'boolean' ? raw.ribbonMin : null,
      split: num(raw.split),
      sampleView: raw.sampleView === 'plate' ? 'plate' : 'list',
      splitPlate: num(raw.splitPlate),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const useLayout = create<LayoutState>((set, get) => ({
  ...readPersisted(),
  drawer: null,
  ribbonPeek: false,
  set: (patch) => {
    set(patch);
    const s = get();
    try {
      const p: Persisted = { leftW: s.leftW, rightW: s.rightW, leftOpen: s.leftOpen, rightOpen: s.rightOpen, ribbonMin: s.ribbonMin, split: s.split, sampleView: s.sampleView, splitPlate: s.splitPlate };
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable: the layout is kept for this session only */
    }
  },
}));

// ---------------------------------------------------------------- screen-size modes

export const PHONE_QUERY = '(max-width: 640px), (max-height: 500px) and (max-width: 960px) and (pointer: coarse)';
export const COMPACT_QUERY = '(max-width: 1199.98px)';
/** Windows so short that the ribbon is minimized unless the user pinned it. */
export const SHORT_QUERY = '(max-height: 540px)';

export const ribbonMinimized = (s: Pick<LayoutState, 'ribbonMin'>, short = !!window.matchMedia?.(SHORT_QUERY).matches) => s.ribbonMin ?? short;

/** Minimize the ribbon to its tabs, or show it again (Ctrl+F1, the button at the end of the tab row). */
export function toggleRibbon() {
  const s = useLayout.getState();
  s.set({ ribbonMin: !ribbonMinimized(s), ribbonPeek: false });
}

export function useMedia(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return m;
}

export type ShellMode = 'phone' | 'compact' | 'wide';
let currentMode: ShellMode = 'wide';
/** The mode of the last render (for code outside React, e.g. keyboard shortcuts). */
export const shellMode = () => currentMode;

export function useShellMode(): ShellMode {
  const phone = useMedia(PHONE_QUERY);
  const compact = useMedia(COMPACT_QUERY);
  currentMode = phone ? 'phone' : compact ? 'compact' : 'wide';
  return currentMode;
}

export function useViewportWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

/** Panel widths for this window (stored width or default, clamped so the worksheet keeps its room). */
export function panelWidths(vw: number, s: Pick<LayoutState, 'leftW' | 'rightW' | 'leftOpen' | 'rightOpen'>, mode: ShellMode) {
  const clamp = (side: Side, w: number) => Math.round(Math.min(PANEL_LIMITS[side].max, Math.max(PANEL_LIMITS[side].min, w)));
  let left = clamp('left', s.leftW ?? defaultPanelWidth('left', vw));
  let right = clamp('right', s.rightW ?? defaultPanelWidth('right', vw));
  if (mode === 'compact') {
    // drawers: never wider than the window allows
    const cap = Math.max(220, vw - 56);
    return { left: Math.min(left, cap), right: Math.min(right, cap) };
  }
  const room = vw - CENTER_MIN;
  const l = s.leftOpen ? left : 0;
  const r = s.rightOpen ? right : 0;
  if (l + r > room && l + r > 0) {
    const k = Math.max(0, room) / (l + r);
    left = Math.max(PANEL_LIMITS.left.min, Math.round(left * k));
    right = Math.max(PANEL_LIMITS.right.min, Math.round(right * k));
  }
  return { left, right };
}

/** Show or hide a side panel: docked panels collapse, in compact mode the drawer opens or closes. */
export function togglePanel(side: Side) {
  const s = useLayout.getState();
  if (currentMode !== 'wide') s.set({ drawer: s.drawer === side ? null : side });
  else s.set(side === 'left' ? { leftOpen: !s.leftOpen } : { rightOpen: !s.rightOpen });
}

/** Make sure a side panel is visible (e.g. "Properties" opens the inspector). */
export function showPanel(side: Side) {
  const s = useLayout.getState();
  if (currentMode !== 'wide') s.set({ drawer: side });
  else s.set(side === 'left' ? { leftOpen: true } : { rightOpen: true });
}

export const isPanelShown = (side: Side, mode: ShellMode, s: Pick<LayoutState, 'drawer' | 'leftOpen' | 'rightOpen'>) =>
  mode === 'wide' ? (side === 'left' ? s.leftOpen : s.rightOpen) : s.drawer === side;

// ---------------------------------------------------------------- resize handle of a side panel

/** Drag handle on the inner edge of a side panel (also keyboard: arrows, Home / End; double-click: default width). */
export function SplitHandle({ side, width, label }: { side: Side; width: number; label: string }) {
  const lim = PANEL_LIMITS[side];
  const setW = (w: number) => useLayout.getState().set(side === 'left' ? { leftW: Math.round(Math.min(lim.max, Math.max(lim.min, w))) } : { rightW: Math.round(Math.min(lim.max, Math.max(lim.min, w))) });
  const [drag, setDrag] = useState(false);
  const down = (e: RPE<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const x0 = e.clientX;
    const w0 = width;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setDrag(true);
    const move = (ev: PointerEvent) => setW(w0 + (side === 'left' ? ev.clientX - x0 : x0 - ev.clientX));
    const up = () => {
      setDrag(false);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const key = (e: RKE<HTMLDivElement>) => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    const step = e.shiftKey ? 48 : 16;
    if (e.key === grow) setW(width + step);
    else if (e.key === shrink) setW(width - step);
    else if (e.key === 'Home') setW(lim.min);
    else if (e.key === 'End') setW(lim.max);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      className={`split-handle ${side}${drag ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={lim.min}
      aria-valuemax={lim.max}
      tabIndex={0}
      title={`${label}: drag to resize, double-click for the default width`}
      onPointerDown={down}
      onKeyDown={key}
      onDoubleClick={() => useLayout.getState().set(side === 'left' ? { leftW: null } : { rightW: null })}
    />
  );
}

/** Share of the left panel the samples take: the list 42 %, the plate 56 % (each remembered on its own). */
export const sampleSplit = (s: Pick<LayoutState, 'split' | 'splitPlate' | 'sampleView'>) => (s.sampleView === 'plate' ? s.splitPlate ?? 0.56 : s.split ?? 0.42);

/** Handle between the sample list and the population tree (drag, arrows; double-click: default). */
export function PaneSplit() {
  const split = useLayout(sampleSplit);
  const plate = useLayout((s) => s.sampleView === 'plate');
  const set = (v: number) => {
    const x = Math.min(0.85, Math.max(0.12, v));
    useLayout.getState().set(plate ? { splitPlate: x } : { split: x });
  };
  const down = (e: RPE<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const box = el.parentElement?.getBoundingClientRect();
    if (!box || box.height < 40) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const move = (ev: PointerEvent) => set((ev.clientY - box.top) / box.height);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <div
      className="pane-split"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Height of the sample list"
      aria-valuenow={Math.round(split * 100)}
      aria-valuemin={12}
      aria-valuemax={85}
      tabIndex={0}
      title="Drag to share the height between samples and populations; double-click resets"
      onPointerDown={down}
      onDoubleClick={() => useLayout.getState().set(plate ? { splitPlate: null } : { split: null })}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        e.stopPropagation();
        set(split + (e.key === 'ArrowDown' ? 0.04 : -0.04));
      }}
    />
  );
}

// ---------------------------------------------------------------- icons of the shell

const svg = (d: string, extra?: JSX.Element) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
    {extra}
  </svg>
);
export const ShellIcon = {
  panelLeft: () => svg('M4 5h16v14H4zM9.5 5v14', <path d="M6 9h1.5M6 12h1.5" />),
  panelRight: () => svg('M4 5h16v14H4zM14.5 5v14', <path d="M16.5 9H18M16.5 12H18" />),
  more: () => svg('M5 12h.01M12 12h.01M19 12h.01', undefined),
  chevronUp: () => svg('M6 15l6-6 6 6'),
  chevronDown: () => svg('M6 9l6 6 6-6'),
  addToSheet: () => svg('M4 4h11v16H4zM18 9v6M15 12h6'),
};

// ---------------------------------------------------------------- touch: long press opens the context menu

/**
 * A long press with a finger or pen (no movement) sends a contextmenu event to the pressed element, so every
 * right-click menu also opens on touch screens. Browsers that fire their own contextmenu on long press are not
 * doubled.
 */
export function installLongPress(ms = 520): () => void {
  let timer = 0;
  let start: { x: number; y: number; id: number; target: EventTarget | null } | null = null;
  let firedId: number | null = null;
  let firedAt = -1e9;
  let clickGuardUntil = -1e9;
  const clear = () => {
    window.clearTimeout(timer);
    start = null;
  };
  const down = (e: PointerEvent) => {
    clear();
    firedId = null;
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    // text fields keep the browser's own long-press (select, paste)
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, target: e.target };
    timer = window.setTimeout(() => {
      const s = start;
      start = null;
      if (!s || !(s.target instanceof Element) || !s.target.isConnected) return;
      firedId = s.id;
      firedAt = performance.now();
      s.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: s.x, clientY: s.y, button: 2, buttons: 0, view: window }));
    }, ms);
  };
  const move = (e: PointerEvent) => {
    if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clear();
  };
  const up = (e: PointerEvent) => {
    if (start && e.pointerId === start.id) clear();
    // the click that ends a long press must not also press the menu item that opened under the finger
    if (firedId !== null && e.pointerId === firedId) clickGuardUntil = performance.now() + 400;
    firedId = null;
  };
  const ctx = (e: MouseEvent) => {
    if (!e.isTrusted) return;
    if (start) clear(); // the browser opens its own long-press menu event: no second one from here
    else if (performance.now() - firedAt < 1500) {
      // the browser's (late) long-press event after ours
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const click = (e: MouseEvent) => {
    if (performance.now() > clickGuardUntil) return;
    clickGuardUntil = -1e9;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('contextmenu', ctx, true);
  window.addEventListener('click', click, true);
  return () => {
    clear();
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    window.removeEventListener('contextmenu', ctx, true);
    window.removeEventListener('click', click, true);
  };
}

// ---------------------------------------------------------------- canvases follow the device pixel ratio

/**
 * Plots draw at zoom x devicePixelRatio. When the ratio changes (browser zoom, window moved to another screen) they
 * are drawn again so they stay sharp.
 */
export function watchPixelRatio(): () => void {
  let mq: MediaQueryList | null = null;
  let stopped = false;
  const arm = () => {
    if (stopped || !window.matchMedia) return;
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener?.('change', fire, { once: true });
  };
  const fire = () => {
    bumpData();
    arm();
  };
  arm();
  return () => {
    stopped = true;
    mq?.removeEventListener?.('change', fire);
  };
}
