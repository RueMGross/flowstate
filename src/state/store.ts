import { create } from 'zustand';
import { current, isDraft, produce, type Draft } from 'immer';
import { engine } from '../core/engine';
import { applyTimestep, getSpillover, parseFcsSamples, pickSample, type FcsDataset, type FcsSample } from '../core/fcs';
import { eventTableDataset, parseEventStream, TABLE_ORIGIN_KEY } from '../core/eventtable';
import {
  defaultPlotOptions,
  emptyWorkspace,
  GATE_COLORS,
  newWorksheet,
  gateParams,
  popDescendants,
  uid,
  type Layer,
  type CompDef,
  type PlotItem,
  type PlotType,
  type SampleRef,
  type Workspace,
  type Population,
  type GateGeom,
  type SampleChannel,
  type ChartItem,
  type StatColumn,
  type SheetItem,
} from '../core/model';
import { flowJoChannelRenames, renameWorkspaceChannels } from '../core/flowjo';
import { applyRenames, autoNameRenames, changedLabelChannels } from '../core/naming';
import { defaultScaleFor, isScatterOrTime, isTimeChannel, positiveLogScaleFor, type ScaleDef } from '../core/transforms';
import { instrumentKeyOf, instrumentScaleKey, sampleInstrument } from '../core/instruments';
import { inScopeChain } from '../core/scope';
import { gateEvalScales } from '../core/gating';
import { bodyPt, headerLines } from '../render/figstyle';
import { assignPlates, plateInputOf, type Placement } from '../core/plate';
import { folderOf, relativePathOf } from '../io/folders';
import { measureRich } from '../render/painter';
import { textLines } from '../render/items';

/** Natural order of names ("A2" before "A10"). */
const NATURAL = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const PT_PX = 96 / 72;

export type Tool = 'select' | 'polygon' | 'rect' | 'ellipse' | 'quadrant' | 'range' | 'split' | 'text' | 'zoom' | 'autogate';
export type View = 'sheet' | 'tables' | 'comp' | 'unmix' | 'calib' | 'plate';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  text: string;
  kind: 'info' | 'error' | 'success';
  action?: ToastAction;
}

export interface UIState {
  activeSampleId: string | null;
  activeSheetId: string;
  selectedItemIds: string[];
  selectedPopId: string | null;
  tool: Tool;
  zoom: number;
  view: View;
  activeTableId: string | null;
  ribbonTab: string;
  /** active page of the calibration view */
  calibMode?: 'mesf' | 'size';
  dataVersion: number;
  toasts: Toast[];
  dialog: null | { kind: string; payload?: unknown };
  missingFiles: string[]; // file names referenced by workspace but not loaded
  selectedSampleIds: string[];
  sampleFilter: string; // 'all' or group id
  keyItemId: string | null; // most recently clicked item (reference for "same size")
  /** FlowJo's stored counts of the last opened .wsp, for the comparison table (Gate > FlowJo counts) */
  flowjoCounts?: FlowJoCounts | null;
  /** the "Imported from FlowJo: compare counts" notice of the population panel was dismissed */
  flowjoNoticeDismissed?: boolean;
  /** plot shown large in the gating view (null: closed) */
  gatingItemId?: string | null;
  /** plate shown in the sample panel's plate view (name; null / missing: the first) */
  activePlate?: string | null;
}

/** FlowJo's own event counts from an imported .wsp: sample id -> population id ('root' = all events) -> count. */
export interface FlowJoCounts {
  fileName: string;
  counts: Record<string, Record<string, number>>;
}

/** Undo steps kept (past and future alike). */
export const HISTORY_LIMIT = 150;

interface Store {
  ws: Workspace;
  ui: UIState;
  past: Workspace[];
  future: Workspace[];
  lastKey: string | null;
  lastTime: number;
  update: (recipe: (ws: Draft<Workspace>) => void, key?: string) => void;
  setUI: (patch: Partial<UIState> | ((ui: UIState) => Partial<UIState>)) => void;
  undo: () => void;
  redo: () => void;
  /** Load another workspace. keepHistory: the current one stays reachable with Undo (else history is cleared). */
  replaceWorkspace: (ws: Workspace, opts?: { keepHistory?: boolean }) => void;
  /** Show a toast; with `action` it gets a button (e.g. Undo) and stays longer. Returns its id. */
  toast: (text: string, kind?: Toast['kind'], opts?: { action?: ToastAction; duration?: number }) => string;
  dismissToast: (id: string) => void;
  /** Start a new undo step for the next update, whatever its key (called on every pointerdown / focus change). */
  breakGroup: () => void;
  /** Revert the current undo step if it was made with `key` (cancels a gesture such as a drag). */
  cancelGroup: (key: string) => void;
}

const initialWs = emptyWorkspace();

let replacements = 0;
/** Changes with each replaceWorkspace (another workspace opened), not with edits: tells the two apart. */
export const replacementCount = () => replacements;

const replaceHooks = new Set<() => void>();
/** Run `fn` after another workspace was opened or a new one started (e.g. to drop UI drafts of the previous one). */
export function onWorkspaceReplaced(fn: () => void): () => void {
  replaceHooks.add(fn);
  return () => replaceHooks.delete(fn);
}

/**
 * The sample the user chose last (sample list, stepping, opening): undo / redo that take it away and bring it back return
 * to it instead of leaving the first sample active.
 */
let stickyActive: string | null = null;
/** set while UI references are corrected after undo / redo (not a choice of the user) */
let fixingUi = false;

/** Undo key shared by all updates of one file load (one undo step), see loadFcsFiles. */
let loadKey: string | null = null;

/** Who made an undo step, when not the user (see runAs): the workspace the step led to -> actor (e.g. 'ai'). */
const stepActors = new WeakMap<Workspace, string>();
let actor: string | null = null;

/** Run `fn` with the workspace updates it makes marked as made by `name` (e.g. 'ai'; see ai/history.ts squashSince). */
export function runAs<T>(name: string, fn: () => T): T {
  const prev = actor;
  actor = name;
  try {
    return fn();
  } finally {
    actor = prev;
  }
}

/** Mark the undo step that led to `ws` (default: the current one) as made by `name` (e.g. a gate an AI preview made). */
export function markStep(name: string, ws: Workspace = useStore.getState().ws) {
  stepActors.set(ws, name);
}

/** Who made the undo step that led to `ws` (undefined: the user). */
export function stepActor(ws: Workspace): string | undefined {
  return stepActors.get(ws);
}

export const useStore = create<Store>((set, get) => ({
  ws: initialWs,
  ui: {
    activeSampleId: null,
    activeSheetId: initialWs.worksheets[0].id,
    selectedItemIds: [],
    selectedPopId: null,
    tool: 'select',
    zoom: 1,
    view: 'sheet',
    activeTableId: null,
    ribbonTab: 'home',
    dataVersion: 0,
    toasts: [],
    dialog: null,
    missingFiles: [],
    selectedSampleIds: [],
    sampleFilter: 'all',
    keyItemId: null,
  },
  past: [],
  future: [],
  lastKey: null,
  lastTime: 0,
  update: (recipe, key) => {
    const { ws, past, lastKey } = get();
    let next = produce(ws, recipe);
    if (next === ws) return;
    next = syncBoolNames(ws, next);
    next = syncSampleHeaders(ws, next);
    next = fitTextHeights(ws, next);
    if (next.channelLabels !== ws.channelLabels) offerLabelRenames(ws, next);
    const now = Date.now();
    // updates with the same key form one undo step until the next pointerdown / focus change (breakGroup)
    const coalesce = key && key === lastKey && past.length > 0;
    const by = actor ?? (coalesce ? stepActors.get(ws) : undefined);
    if (by) stepActors.set(next, by);
    set({
      ws: next,
      past: coalesce ? past : [...past, ws].slice(-HISTORY_LIMIT),
      future: [],
      lastKey: key ?? null,
      lastTime: now,
    });
  },
  setUI: (patch) =>
    set((s) => {
      const ui = { ...s.ui, ...(typeof patch === 'function' ? patch(s.ui) : patch) };
      if (!fixingUi && ui.activeSampleId && ui.activeSampleId !== s.ui.activeSampleId) stickyActive = ui.activeSampleId;
      // the reference item for "same size" belongs to the sheet shown (a new or other sheet: none)
      if (ui.keyItemId && (ui.activeSheetId !== s.ui.activeSheetId || ui.keyItemId !== s.ui.keyItemId)) {
        const sheet = s.ws.worksheets.find((w) => w.id === ui.activeSheetId);
        if (!sheet?.items.some((i) => i.id === ui.keyItemId)) ui.keyItemId = null;
      }
      return { ui };
    }),
  undo: () => {
    const { past, ws, future } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({ ws: prev, past: past.slice(0, -1), future: [ws, ...future].slice(0, HISTORY_LIMIT), lastKey: null });
    fixUiRefs(true);
    noteUndoneLoad(ws, prev);
  },
  redo: () => {
    const { past, ws, future } = get();
    if (!future.length) return;
    const nxt = future[0];
    set({ ws: nxt, past: [...past, ws].slice(-HISTORY_LIMIT), future: future.slice(1), lastKey: null });
    fixUiRefs(true);
  },
  replaceWorkspace: (ws, opts = {}) => {
    replacements++;
    stickyActive = null;
    set((s) => {
      // another workspace starts on its worksheet (a saved view is restored afterwards, see restoreSavedUi)
      const ui: UIState = {
        ...s.ui,
        activeSheetId: ws.worksheets[0]?.id ?? '',
        selectedItemIds: [],
        selectedPopId: null,
        selectedSampleIds: [],
        keyItemId: null,
        activeSampleId: null,
        activeTableId: null,
        view: 'sheet',
        tool: 'select',
        sampleFilter: 'all',
        // FlowJo's counts of an imported workspace come back with it (saved in the workspace file)
        flowjoCounts: ws.flowjoCounts ?? null,
        flowjoNoticeDismissed: false,
        gatingItemId: null,
      };
      const past = opts.keepHistory ? [...s.past, s.ws].slice(-HISTORY_LIMIT) : [];
      return { ws, past, future: [], lastKey: null, ui: { ...ui, ...validUi(ws, ui) } };
    });
    for (const f of [...replaceHooks]) {
      try {
        f();
      } catch (e) {
        console.warn(e);
      }
    }
  },
  toast: (text, kind = 'info', opts = {}) => {
    const id = uid('t');
    set((s) => ({ ui: { ...s.ui, toasts: [...s.ui.toasts, { id, text, kind, action: opts.action }] } }));
    setTimeout(() => get().dismissToast(id), opts.duration ?? (opts.action ? 8000 : kind === 'error' ? 7000 : 3500));
    return id;
  },
  dismissToast: (id) => set((s) => (s.ui.toasts.some((t) => t.id === id) ? { ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== id) } } : s)),
  breakGroup: () => {
    if (get().lastKey !== null) set({ lastKey: null });
  },
  cancelGroup: (key) => {
    const { past, lastKey } = get();
    if (lastKey !== key || !past.length) return;
    set({ ws: past[past.length - 1], past: past.slice(0, -1), lastKey: null });
  },
}));

/** UI fields that no longer match the workspace (after undo/redo or loading another workspace), corrected. */
function validUi(ws: Workspace, ui: UIState): Partial<UIState> {
  const patch: Partial<UIState> = {};
  if (!ws.worksheets.find((w) => w.id === ui.activeSheetId)) patch.activeSheetId = ws.worksheets[0]?.id ?? '';
  if (ui.selectedPopId && !ws.populations.find((p) => p.id === ui.selectedPopId)) patch.selectedPopId = null;
  const sheet = ws.worksheets.find((w) => w.id === (patch.activeSheetId ?? ui.activeSheetId));
  const ids = new Set(sheet?.items.map((i) => i.id));
  if (ui.selectedItemIds.some((i) => !ids.has(i))) patch.selectedItemIds = ui.selectedItemIds.filter((i) => ids.has(i));
  if (ui.keyItemId && !ids.has(ui.keyItemId)) patch.keyItemId = null;
  const sids = new Set(ws.samples.map((s) => s.id));
  if (stickyActive && stickyActive !== ui.activeSampleId && sids.has(stickyActive) && engine.has(stickyActive)) {
    // the sample the user chose is there again (redo of its loading, undo of its removal): back to it
    patch.activeSampleId = stickyActive;
  } else if (!ui.activeSampleId || !sids.has(ui.activeSampleId)) {
    const next = ws.samples.find((x) => engine.has(x.id))?.id ?? ws.samples[0]?.id ?? null;
    if (next !== ui.activeSampleId) patch.activeSampleId = next;
  }
  if (ui.selectedSampleIds.some((i) => !sids.has(i))) patch.selectedSampleIds = ui.selectedSampleIds.filter((i) => sids.has(i));
  if (ui.sampleFilter !== 'all' && !ws.groups.some((g) => g.id === ui.sampleFilter)) patch.sampleFilter = 'all';
  if (!ui.activeTableId || !ws.tables.some((t) => t.id === ui.activeTableId)) {
    const t = ws.tables[0]?.id ?? null;
    if (t !== ui.activeTableId) patch.activeTableId = t;
  }
  const missing = ws.samples.filter((x) => !engine.has(x.id)).map((x) => x.fileName);
  if (missing.join('\n') !== ui.missingFiles.join('\n')) patch.missingFiles = missing;
  return patch;
}

/** Name the Boolean dialog gives a Boolean gate from its operands' names (null if an operand is unknown). */
export function boolAutoName(g: Extract<GateGeom, { type: 'bool' }>, nameOf: (id: string) => string | undefined): string | null {
  const names: string[] = [];
  for (const o of g.operands) {
    const n = nameOf(o.replace(/^!/, ''));
    if (n === undefined) return null;
    names.push((o.startsWith('!') ? 'not ' : '') + n);
  }
  if (!names.length) return null;
  if (g.op === 'not') return `NOT ${names[0]}`;
  return names.join(g.op === 'and' ? ' AND ' : ' OR ');
}

/**
 * Column headers / row labels made by "Repeat for samples" (TextItem.sampleHeader) follow renamed samples while their
 * text is the one they were made with (an edited text stays): the new name, wrapped as the header was, the box keeping
 * its bottom (column headers) or its middle (row labels).
 */
/**
 * Text boxes keep showing all their text: when the text, its font size or style, the box width or the figure font
 * change, a box grows to fit (unless its height was set by hand, hFixed: then the sheet marks the overflow and the export
 * dialog says so). Headers of "Repeat for samples" fit their lines both ways and stay on their plots: column headers
 * grow upwards (they sit on their column), row labels around their middle; other boxes grow downwards.
 */
export function fitTextHeights(prev: Workspace, next: Workspace): Workspace {
  const famChanged = prev.style.fontFamily !== next.style.fontFamily;
  if (prev.worksheets === next.worksheets && !famChanged) return next;
  const family = next.style.fontFamily;
  const todo: { sheet: string; id: string; h: number; dy: number }[] = [];
  for (const sh of next.worksheets) {
    const old = prev.worksheets.find((x) => x.id === sh.id);
    if (old === sh && !famChanged) continue;
    const before = new Map((old?.items ?? []).map((i) => [i.id, i]));
    for (const it of sh.items) {
      if (it.kind !== 'text' || it.hFixed || !it.text.trim()) continue;
      const o = before.get(it.id);
      if (o === it && !famChanged) continue;
      // only a change of what decides the lines (new boxes: when they overflow)
      if (o && o.kind === 'text' && !famChanged && o.text === it.text && o.fontSize === it.fontSize && o.bold === it.bold && o.italic === it.italic && o.w === it.w) continue;
      const n = textLines(it, family).length;
      const size = it.fontSize * PT_PX;
      let h: number;
      if (it.sampleHeader) h = n * (Math.ceil(size * 1.25 * 10) / 10) + 1;
      else {
        const need = n * size * 1.2;
        if (need <= it.h + 0.5) continue;
        h = Math.ceil((need + 1) * 10) / 10;
      }
      if (Math.abs(h - it.h) < 0.05) continue;
      const dy = it.sampleHeader ? (it.align === 'center' ? it.h - h : (it.h - h) / 2) : 0;
      todo.push({ sheet: sh.id, id: it.id, h, dy });
    }
  }
  if (!todo.length) return next;
  return produce(next, (w) => {
    for (const t of todo) {
      const it = w.worksheets.find((x) => x.id === t.sheet)?.items.find((i) => i.id === t.id);
      if (!it) continue;
      it.y += t.dy;
      it.h = t.h;
    }
  });
}

export function syncSampleHeaders(prev: Workspace, next: Workspace): Workspace {
  if (prev.samples === next.samples) return next;
  const old = new Map(prev.samples.map((s) => [s.id, s.name]));
  const renamed = new Map(next.samples.filter((s) => old.has(s.id) && old.get(s.id) !== s.name).map((s) => [s.id, s.name]));
  if (!renamed.size) return next;
  const hit = (it: SheetItem) => it.kind === 'text' && !!it.sampleHeader && renamed.has(it.sampleHeader.sample) && it.text === it.sampleHeader.auto;
  if (!next.worksheets.some((sh) => sh.items.some(hit))) return next;
  return produce(next, (w) => {
    for (const sh of w.worksheets)
      for (const it of sh.items) {
        if (!hit(it as SheetItem) || it.kind !== 'text' || !it.sampleHeader) continue;
        const name = renamed.get(it.sampleHeader.sample)!;
        const st = { family: w.style.fontFamily, size: it.fontSize * PT_PX, weight: it.bold ? ('bold' as const) : ('normal' as const) };
        const text = headerLines(name, it.w, (t) => measureRich(t, st)).join('\n');
        const lineH = Math.ceil(it.fontSize * PT_PX * 1.25 * 10) / 10;
        const h = text.split('\n').length * lineH + 1;
        if (it.align === 'center') it.y += it.h - h;
        else it.y += (it.h - h) / 2;
        it.h = h;
        it.text = text;
        it.sampleHeader.auto = text;
      }
  });
}

/**
 * Boolean gates that still carry their automatic name ("A AND B", maybe with a " 2" suffix) follow renamed operands
 * (also through Booleans of Booleans); a Boolean the user named keeps its name.
 */
function syncBoolNames(prev: Workspace, next: Workspace): Workspace {
  if (prev.populations === next.populations) return next;
  const oldNames = new Map(prev.populations.map((p) => [p.id, p.name]));
  if (!next.populations.some((p) => oldNames.has(p.id) && oldNames.get(p.id) !== p.name)) return next;
  if (!next.populations.some((p) => p.gate.type === 'bool')) return next;
  const cur = new Map(next.populations.map((p) => [p.id, p.name]));
  const renames = new Map<string, string>();
  for (let pass = 0; pass < 16; pass++) {
    let grew = false;
    for (const p of next.populations) {
      if (p.gate.type !== 'bool' || renames.has(p.id)) continue;
      const was = oldNames.get(p.id);
      if (was === undefined || was !== p.name) continue; // new, or renamed by the user in this very change
      const before = boolAutoName(p.gate, (id) => oldNames.get(id));
      const after = boolAutoName(p.gate, (id) => cur.get(id));
      if (!before || !after || before === after) continue;
      const rest = was.slice(before.length);
      if (!was.startsWith(before) || (rest && !/^ \d+$/.test(rest))) continue;
      renames.set(p.id, after + rest);
      cur.set(p.id, after + rest);
      grew = true;
    }
    if (!grew) break;
  }
  if (!renames.size) return next;
  return produce(next, (w) => {
    for (const p of w.populations) {
      const n = renames.get(p.id);
      if (n) p.name = n;
    }
  });
}

/**
 * A marker label was set or changed: offer to rename the quadrant / range / split gates that still carry the automatic
 * name made from the channel name or the previous label (names the user typed are not touched).
 */
function offerLabelRenames(prev: Workspace, next: Workspace) {
  const chans = changedLabelChannels(prev, next);
  if (!chans.length) return;
  const renames = autoNameRenames(prev, next, chans);
  if (!renames.length) return;
  // after the update is committed
  setTimeout(() => {
    const st = useStore.getState();
    const ex = renames[0];
    st.toast(
      `Marker label set. Rename ${renames.length === 1 ? `gate '${ex.from}' to '${ex.to}'` : `${renames.length} gates named after the channel (e.g. '${ex.from}' to '${ex.to}')`}?`,
      'info',
      {
        duration: 15000,
        action: {
          label: renames.length === 1 ? 'Rename' : `Rename ${renames.length}`,
          run: () => {
            const cur = useStore.getState();
            // only gates whose name is still the one offered
            const live = renames.filter((r) => cur.ws.populations.some((p) => p.id === r.id && p.name === r.from));
            if (!live.length) return;
            cur.update((w) => applyRenames(w.populations as Population[], live));
            cur.toast(`Renamed ${live.length} gate${live.length > 1 ? 's' : ''}`, 'success');
          },
        },
      },
    );
  }, 0);
}

function fixUiRefs(bump = false) {
  const { ws, ui, setUI } = useStore.getState();
  const patch = validUi(ws, ui);
  if (bump) patch.dataVersion = ui.dataVersion + 1;
  if (ui.gatingItemId && !ws.worksheets.some((w) => w.items.some((i) => i.id === ui.gatingItemId))) patch.gatingItemId = null;
  if (!Object.keys(patch).length) return;
  fixingUi = true;
  try {
    setUI(patch);
  } finally {
    fixingUi = false;
  }
}

/** Undo took loaded samples away again (it undid their loading): say so, it is easy to miss. */
function noteUndoneLoad(from: Workspace, to: Workspace) {
  if (from.samples === to.samples) return;
  const ids = new Set(to.samples.map((s) => s.id));
  const before = new Set(from.samples.map((s) => s.id));
  const gone = from.samples.filter((s) => !ids.has(s.id));
  // only when the step added samples to the ones still there (not when it went back to another workspace)
  if (!gone.length || !to.samples.every((s) => before.has(s.id))) return;
  const n = gone.length;
  useStore
    .getState()
    .toast(`Undo removed ${n === 1 ? `the sample '${gone[0].name}'` : `${n} samples`} loaded in that step. Redo (Ctrl+Y) loads ${n === 1 ? 'it' : 'them'} again.`, 'info', { duration: 9000 });
}

// --------------------------------------------------------------- UI state kept with a workspace

/** Where the user was (sample, sheet, view, table): saved with the workspace and the autosave, restored on open / reload. */
export interface SavedUi {
  activeSampleId?: string | null;
  activeSheetId?: string;
  view?: View;
  activeTableId?: string | null;
  calibMode?: 'mesf' | 'size';
  sampleFilter?: string;
  activePlate?: string | null;
}

/** The current UI state worth restoring. */
export function savedUiOf(ui: UIState = useStore.getState().ui): SavedUi {
  return { activeSampleId: ui.activeSampleId, activeSheetId: ui.activeSheetId, view: ui.view, activeTableId: ui.activeTableId, calibMode: ui.calibMode, sampleFilter: ui.sampleFilter, activePlate: ui.activePlate ?? null };
}

const VIEWS: View[] = ['sheet', 'tables', 'comp', 'unmix', 'calib', 'plate'];

/** Restore a saved UI state onto the current workspace (references that no longer exist are skipped). */
export function restoreSavedUi(saved: SavedUi | null | undefined) {
  if (!saved || typeof saved !== 'object') return;
  const { ws, setUI } = useStore.getState();
  const patch: Partial<UIState> = {};
  if (saved.activeSampleId && ws.samples.some((s) => s.id === saved.activeSampleId) && engine.has(saved.activeSampleId)) {
    patch.activeSampleId = saved.activeSampleId;
    patch.selectedSampleIds = [saved.activeSampleId];
  }
  if (saved.activeSheetId && ws.worksheets.some((w) => w.id === saved.activeSheetId)) patch.activeSheetId = saved.activeSheetId;
  if (saved.activeTableId && ws.tables.some((t) => t.id === saved.activeTableId)) patch.activeTableId = saved.activeTableId;
  if (saved.view && VIEWS.includes(saved.view)) patch.view = saved.view;
  if (saved.calibMode === 'mesf' || saved.calibMode === 'size') patch.calibMode = saved.calibMode;
  if (saved.sampleFilter && (saved.sampleFilter === 'all' || ws.groups.some((g) => g.id === saved.sampleFilter))) patch.sampleFilter = saved.sampleFilter;
  if (typeof saved.activePlate === 'string') patch.activePlate = saved.activePlate;
  if (Object.keys(patch).length) setUI({ ...patch, selectedItemIds: [], keyItemId: null });
}

export const getWs = () => useStore.getState().ws;
export const getUI = () => useStore.getState().ui;
export const bumpData = () => useStore.getState().setUI((u) => ({ dataVersion: u.dataVersion + 1 }));

// --------------------------------------------------------------- samples

function matrixEqual(a: CompDef, ch: string[], m: number[][]) {
  if (a.channels.length !== ch.length || a.channels.some((c, i) => c !== ch[i])) return false;
  return a.matrix.every((row, i) => row.every((v, j) => Math.abs(v - m[i][j]) < 1e-9));
}

const INFO_KEYS: [string, string][] = [
  ['$DATE', 'Date'],
  ['$CYT', 'Cytometer'],
  ['$SRC', 'Source'],
  ['TUBE NAME', 'Tube'],
  ['$FIL', 'File'],
  ['$BTIM', 'Start'],
  ['$ETIM', 'End'],
  ['CREATOR', 'Software'],
  ['$OP', 'Operator'],
  ['$VOL', 'Volume'],
  ['WELL ID', 'Well'],
  ['$TBNM', 'Tube'],
  [TABLE_ORIGIN_KEY, 'Origin'],
];

/**
 * Sample name: the file name without extension; a data set of a file with several (one per well, see parseFcsSamples)
 * adds its position and well / sample number, e.g. "plate1 #3 A03".
 */
export function sampleNameFrom(fileName: string, ds: FcsDataset): string {
  const base = fileName.replace(/\.(fcs|lmd|csv|tsv|txt)$/i, '');
  return ds.dataset ? `${base} ${ds.dataset.label}` : base;
}

/** Info entry of a sample that is one of several data sets of its file: "3 of 15" (used to relink the right one). */
export const DATASET_INFO = 'Data set';

/** 0-based data set position of a workspace sample (see DATASET_INFO), if it came from a file with several. */
export function datasetIndexOf(s: SampleRef): number | undefined {
  const m = /^(\d+) of \d+$/.exec(s.info?.[DATASET_INFO] ?? '');
  return m ? parseInt(m[1], 10) - 1 : undefined;
}

// ---------------------------------------------------------------- time unit of older workspaces

/**
 * Workspaces saved before Time was read in seconds (raw ticks x $TIMESTEP) hold Time gates and scales in ticks. They are
 * opened with `timeUnit: 'ticks'` (see io/files.ts parseWorkspace) and converted once a sample tells the factor.
 */
export type TimeUnitMark = { timeUnit?: 'ticks' };

export const hasTicksTime = (ws: Workspace) => (ws as Workspace & TimeUnitMark).timeUnit === 'ticks';

const isTimeCh = (ch: string | undefined) => !!ch && /^time$/i.test(ch.trim());

function mulScale<S extends ScaleDef>(s: S, k: number): S {
  switch (s.type) {
    case 'linear':
    case 'log':
      return { ...s, min: s.min * k, max: s.max * k };
    case 'logicle':
      return { ...s, T: s.T * k, ...(s.flowjo ? { flowjo: { ...s.flowjo, max: s.flowjo.max * k } } : {}) };
    case 'arcsinh':
      return { ...s, T: s.T * k };
    case 'window':
      return { ...s, base: mulScale(s.base, k) };
  }
  return s;
}

function mulGate(g: Draft<GateGeom>, k: number) {
  const m = (v: number) => v * k; // keeps +-Infinity
  switch (g.type) {
    case 'polygon':
    case 'ellipse': {
      const pts = g.type === 'polygon' ? g.points : [g.center, g.a, g.b];
      for (const p of pts) {
        if (isTimeCh(g.x)) p[0] = m(p[0]);
        if (isTimeCh(g.y)) p[1] = m(p[1]);
      }
      if (g.scales?.x && isTimeCh(g.x)) g.scales.x = mulScale(g.scales.x as ScaleDef, k);
      if (g.scales?.y && isTimeCh(g.y)) g.scales.y = mulScale(g.scales.y as ScaleDef, k);
      break;
    }
    case 'rect':
      if (isTimeCh(g.x)) [g.xmin, g.xmax] = [m(g.xmin), m(g.xmax)];
      if (isTimeCh(g.y)) [g.ymin, g.ymax] = [m(g.ymin), m(g.ymax)];
      break;
    case 'range':
      if (isTimeCh(g.x)) [g.min, g.max] = [m(g.min), m(g.max)];
      break;
    case 'split':
      if (isTimeCh(g.x)) g.cut = m(g.cut);
      break;
    case 'quadrant':
      if (isTimeCh(g.x)) g.cx = m(g.cx);
      if (isTimeCh(g.y)) g.cy = m(g.cy);
      break;
  }
}

/** Convert a workspace with Time in ticks (see TimeUnitMark) to seconds: gates, scales and ranges times $TIMESTEP. */
export function convertTicksTime(ws: Draft<Workspace>, timestep: number) {
  delete (ws as Draft<Workspace> & TimeUnitMark).timeUnit;
  const k = timestep;
  if (!(k > 0) || k === 1) return;
  for (const p of ws.populations) {
    mulGate(p.gate, k);
    if (p.overrides) for (const o of Object.values(p.overrides)) mulGate(o, k);
  }
  for (const sc of [ws.scales, ...Object.values(ws.instrumentScales ?? {})])
    for (const ch of Object.keys(sc)) if (isTimeCh(ch)) sc[ch] = mulScale(sc[ch] as ScaleDef, k);
  for (const sh of ws.worksheets)
    for (const it of sh.items) {
      if (it.kind !== 'plot') continue;
      if (it.options.xScale && isTimeCh(it.xParam)) it.options.xScale = mulScale(it.options.xScale as ScaleDef, k);
      if (it.options.yScale && isTimeCh(it.yParam)) it.options.yScale = mulScale(it.options.yScale as ScaleDef, k);
    }
  for (const s of ws.samples) for (const c of s.channels) if (isTimeCh(c.name) && c.range > 0) c.range *= k;
}

/** Sample channel description of an FCS channel (with its unit, e.g. Time in seconds). */
export function sampleChannelOf(c: { name: string; label: string; range: number; unit?: string }): SampleChannel {
  const out: SampleChannel & { unit?: string } = { name: c.name, label: c.label, range: c.range };
  if (c.unit) out.unit = c.unit;
  return out;
}

/**
 * Whether a data set comes from a nanoscale (small particle) cytometer: $CYT names one (e.g. "CytoFLEX nano"), or its
 * channels are the numbered violet side scatters / violet forward scatter of such instruments (VSSC1, VSSC2, VFSC).
 * Their scatter spans many decades (noise to 1 µm beads) and is shown on log-like axes.
 */
export function isNanoscaleData(ds: Pick<FcsDataset, 'keywords' | 'channels'>): boolean {
  if (/nano/i.test(ds.keywords['$CYT'] ?? '')) return true;
  return ds.channels.some((c) => [c.name, c.label ?? ''].some((n) => /^(VSSC\d|VFSC)/i.test(n.trim()) || /violet[\s_-]*SSC/i.test(n)));
}

/**
 * Whether a channel is scatter of a nanoscale instrument (see isNanoscaleData), or any scatter in an analysis set up as
 * nanoscale (`nanoSetup`, Workspace.setup).
 */
const isNanoScatter = (ds: FcsDataset, c: FcsDataset['channels'][number], nanoSetup = false) => isScatterOrTime(c.name) && !isTimeChannel(c.name) && (nanoSetup || isNanoscaleData(ds));

/** Display hint of a new channel's default scale: scatter of nanoscale instruments (or setups) is logarithmic. */
function scaleHintOf(ds: FcsDataset, c: FcsDataset['channels'][number], nanoSetup = false): 'lin' | 'log' | '' {
  if (isNanoScatter(ds, c, nanoSetup)) return 'log';
  return c.displayHint ?? '';
}

/**
 * Default scale of a channel from its events (`arr`, compensated). Scatter of nanoscale instruments gets a pure log axis
 * when the data have no meaningful values at or below 0 (at most 1 %, see positiveLogScaleFor), else a logicle axis,
 * as do log-like channels; `hint` overrides the kind (e.g. the kind of an existing axis).
 */
function newChannelScale(ds: FcsDataset, c: FcsDataset['channels'][number], range: number, arr: Float32Array, hint: 'lin' | 'log' | '' = scaleHintOf(ds, c), nanoSetup = false): ScaleDef {
  if (hint === 'log' && isNanoScatter(ds, c, nanoSetup)) {
    const lg = positiveLogScaleFor(range, arr);
    if (lg) return lg;
  }
  return defaultScaleFor(c.name, range, arr, hint);
}

/** Register a parsed dataset as a new sample in the workspace. Returns the sample id. */
export function addDataset(fileName: string, fileSize: number, ds: FcsDataset, bytes?: ArrayBuffer | Blob, presetId?: string): string {
  const id = presetId ?? uid('smp');
  applyTimestep(ds); // datasets built in code (example data) have not been through the FCS reader
  engine.addSample(id, ds, bytes);
  const st = useStore.getState();
  const spill = getSpillover(ds);
  const key = loadKey ?? 'load:' + id;
  const instrument = instrumentKeyOf(ds.keywords);
  st.update((ws) => {
    // an older workspace with Time in ticks: this file tells the factor
    if (hasTicksTime(ws as Workspace)) convertTicksTime(ws, ds.timeStep ?? 1);
    let compId: string | null = null;
    if (spill && !spill.keyword.includes('identity')) {
      const existing = ws.compensations.find((c) => c.source === 'file' && matrixEqual(c as CompDef, spill.channels, spill.matrix));
      if (existing) compId = existing.id;
      else {
        compId = uid('comp');
        const n = ws.compensations.filter((c) => c.source === 'file').length + 1;
        ws.compensations.push({ id: compId, name: `Acquisition matrix ${n}`, channels: spill.channels, matrix: spill.matrix, source: 'file' });
      }
    }
    const info: Record<string, string> = {};
    for (const [k, label] of INFO_KEYS) if (ds.keywords[k] && !info[label]) info[label] = ds.keywords[k].trim();
    if (ds.dataset) info[DATASET_INFO] = `${ds.dataset.index + 1} of ${ds.dataset.count}`;
    const ref: SampleRef = {
      id,
      name: sampleNameFrom(fileName, ds),
      fileName,
      fileSize,
      eventCount: ds.eventCount,
      channels: ds.channels.map(sampleChannelOf),
      compId,
      info,
      instrument,
    };
    const existingIdx = ws.samples.findIndex((s) => s.id === id);
    if (existingIdx >= 0) {
      // a FlowJo workspace names "LIVE/DEAD Aqua-A" as "LIVE_DEAD Aqua-A": its gates, scales and matrices follow the file
      const ren = flowJoChannelRenames(
        ws.samples[existingIdx].channels.map((c) => c.name),
        ds.channels.map((c) => c.name),
        loadedChannelNames(id),
      );
      renameWorkspaceChannels(ws as Workspace, ren);
      ws.samples[existingIdx] = { ...ws.samples[existingIdx], fileSize, eventCount: ds.eventCount, channels: ref.channels, instrument };
    } else ws.samples.push(ref);
  }, key);
  // default scales for new channels (computed on compensated data of this sample)
  const committed = useStore.getState().ws;
  const scales: Record<string, ReturnType<typeof defaultScaleFor>> = {};
  // (an analysis set up as nanoscale shows scatter on log axes, whatever the instrument; existing axes stay)
  const nanoSetup = committed.setup?.kind === 'nanoscale';
  ds.channels.forEach((c, i) => {
    if (committed.scales[c.name]) return;
    const arr = engine.raw(committed, id, c.name) ?? ds.data[i];
    scales[c.name] = newChannelScale(ds, c, c.range, arr, scaleHintOf(ds, c, nanoSetup), nanoSetup);
  });
  if (Object.keys(scales).length)
    useStore.getState().update((ws) => {
      Object.assign(ws.scales, scales);
    }, key);
  return id;
}

/**
 * A workspace sample waiting for this file: same name, preferably same event count (and size, if known). For a data set
 * of a file with several (`dataset` = its position), only samples made from that data set qualify.
 */
function relinkTarget(name: string, size: number, events: number, dataset?: number): SampleRef | undefined {
  const st = useStore.getState();
  // file names compare without case, as on Windows / macOS file systems (and as FlowJo workspaces are linked)
  const sameName = st.ws.samples.filter((s) => !engine.has(s.id) && s.fileName.toLowerCase() === name.toLowerCase());
  const cands = dataset === undefined ? sameName : sameName.filter((s) => datasetIndexOf(s) === dataset);
  // a sample saved before files with several data sets were split into samples has no position: same event count only
  if (dataset !== undefined && !cands.length) return sameName.find((s) => datasetIndexOf(s) === undefined && s.eventCount === events);
  if (!cands.length) return undefined;
  const byCount = cands.filter((s) => s.eventCount === events);
  const exact = byCount.filter((s) => !s.fileSize || s.fileSize === size);
  const best = exact.length ? exact : byCount;
  if (best.length > 1) st.toast(`${name}: ${best.length} workspace samples have this file name and event count; linked to '${best[0].name}'. Check the sample list.`, 'info');
  if (best.length) return best[0];
  if (cands.length === 1) {
    st.toast(`${name}: event count differs from the workspace sample (${events} vs ${cands[0].eventCount}); linked by file name.`, 'info');
    return cands[0];
  }
  st.toast(`${name}: ${cands.length} workspace samples have this name but none has ${events} events; added as a new sample.`, 'info');
  return undefined;
}

/** Channel names of the files of the loaded samples (other than `except`). */
function loadedChannelNames(except?: string): Set<string> {
  const out = new Set<string>();
  for (const [id, sd] of engine.samples) if (id !== except) for (const c of sd.ds.channels) out.add(c.name);
  return out;
}

/** What a dropped data set tells for finding the workspace sample waiting for it. */
export interface LinkCandidate {
  name: string; // file name
  events: number;
  fil?: string; // $FIL keyword
  date?: string; // $DATE
  btim?: string; // $BTIM
  dataset?: number; // position in a file with several data sets
}

export function linkCandidateOf(name: string, ds: FcsDataset): LinkCandidate {
  const k = ds.keywords;
  return { name, events: ds.eventCount, fil: k['$FIL'], date: k['$DATE'], btim: k['$BTIM'], dataset: ds.dataset?.index };
}

const fileBase = (s: string) => (s.split(/[\\/]/).pop() ?? s).trim().toLowerCase();
const fileStem = (s: string) => fileBase(s).replace(/\.(fcs|lmd)$/i, '');

/**
 * Match data sets of dropped files to workspace samples whose file names differ (e.g. FlowJo's sample "Specimen_001_C2_C02
 * Peptide.fcs" and the file "HC Specimen_001_C2_C02 Peptide.fcs"): the same event count is required, plus the file's
 * $FIL keyword equal to the sample's (from the workspace's keywords) or one file name contained in the other; $DATE /
 * $BTIM must agree where both are known. Each sample is linked at most once and only when the best match is unique;
 * otherwise the file is reported with its candidates (`ambiguous`). Same-name matches are handled by the caller.
 */
export function matchByContent(files: LinkCandidate[], waiting: SampleRef[]): { sample?: SampleRef; ambiguous?: SampleRef[]; how?: string }[] {
  const score = (f: LinkCandidate, s: SampleRef): number => {
    if (!(s.eventCount > 0) || s.eventCount !== f.events) return 0;
    if (f.dataset !== undefined && datasetIndexOf(s) !== undefined && datasetIndexOf(s) !== f.dataset) return 0;
    const info = s.info ?? {};
    const same = (a?: string, b?: string) => !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase();
    if (!same(info['Date'], f.date) || !same(info['Start'], f.btim)) return 0;
    const fil = !!f.fil && !!info['File'] && fileBase(f.fil) === fileBase(info['File']);
    const a = fileStem(f.name);
    const b = fileStem(s.fileName);
    const contained = a !== b && Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a));
    if (!fil && !contained) return 0;
    return (contained ? 2 : 0) + (fil ? 1 : 0) + (info['Date'] && f.date ? 0.5 : 0) + (info['Start'] && f.btim ? 0.5 : 0);
  };
  const scores = files.map((f) => waiting.map((s) => score(f, s)));
  const top = scores.map((row) => {
    const m = Math.max(0, ...row);
    return m > 0 ? waiting.filter((_, j) => row[j] === m) : [];
  });
  // a sample that is the best match of several files is not linked to any of them
  const claims = new Map<string, number>();
  for (const t of top) if (t.length === 1) claims.set(t[0].id, (claims.get(t[0].id) ?? 0) + 1);
  return files.map((f, i) => {
    const t = top[i];
    if (!t.length) return {};
    if (t.length === 1 && claims.get(t[0].id) === 1) {
      const s = t[0];
      const fil = !!f.fil && fileBase(f.fil) === fileBase(s.info?.['File'] ?? '');
      return { sample: s, how: fil ? '$FIL keyword and event count' : 'file name and event count' };
    }
    return { ambiguous: t };
  });
}

/** Instrument of a sample: $CYT and channel ranges. */
export interface InstrumentOf {
  cyt: string;
  channels: { name: string; range: number }[];
}

/**
 * Whether a data set comes from another instrument than (some of) the samples there before: a different $CYT, or the
 * same channel with a $PnR range more than 10x different. Example data (no file) do not count.
 */
export function otherInstrument(ds: FcsDataset, before: InstrumentOf[]): boolean {
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  const cyt = norm(ds.keywords['$CYT']);
  const range = new Map(ds.channels.filter((c) => c.range > 0 && !isTimeCh(c.name)).map((c) => [c.name, c.range]));
  for (const o of before) {
    if (cyt && norm(o.cyt) && cyt !== norm(o.cyt)) return true;
    for (const c of o.channels) {
      const r = range.get(c.name);
      if (r && c.range > 0 && Math.max(r, c.range) > 10 * Math.min(r, c.range)) return true;
    }
  }
  return false;
}

/** Instruments of the workspace's samples from files (loaded, or waiting for their file); example data do not count. */
function instrumentsBefore(): InstrumentOf[] {
  const out: InstrumentOf[] = [];
  for (const s of useStore.getState().ws.samples) {
    const sd = engine.samples.get(s.id);
    if (sd) {
      if (sd.bytes) out.push({ cyt: sd.ds.keywords['$CYT'] ?? '', channels: sd.ds.channels });
    } else out.push({ cyt: s.info?.['Cytometer'] ?? '', channels: s.channels });
  }
  return out;
}

/**
 * Gate dimensions that none of the loaded samples has (in its file or as a computed channel): channel -> a population
 * gated on it. Such gates select no events (e.g. a renamed parameter); empty while no sample is loaded.
 */
export function gateChannelsMissing(ws: Workspace): Map<string, string> {
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  const out = new Map<string, string>();
  if (!loaded.length) return out;
  const derived = new Set((ws.derived ?? []).flatMap((d) => d.outputs.map((o) => o.name)));
  const known = new Set<string>();
  for (const s of loaded) for (const ch of engine.samples.get(s.id)!.index.keys()) known.add(ch);
  for (const p of ws.populations)
    for (const g of [p.gate, ...Object.values(p.overrides ?? {})])
      for (const ch of gateParams(g)) if (!known.has(ch) && !derived.has(ch) && !out.has(ch)) out.set(ch, p.name);
  return out;
}

export function warnMissingGateChannels(m: Map<string, string>) {
  const list = [...m].slice(0, 3).map(([ch, pop]) => `"${ch}" (gate "${pop}")`).join(', ') + (m.size > 3 ? ` and ${m.size - 3} more` : '');
  useStore
    .getState()
    .toast(`Gates use parameters that none of the loaded files has: ${list}. These gates and the populations below them count 0 events.`, 'error', { duration: 20000 });
}

// ---------------------------------------------------------------- very large loads

/**
 * Event data (bytes of FCS files) that one browser tab keeps without asking: a quarter of the device memory as the
 * browser tells it (Chrome caps it at 8 GB), 1 to 2 GB; 1.5 GB when it does not tell. A computer with much memory can
 * allow more: localStorage "fs.loadBudgetMB" (e.g. 6000).
 */
export function loadBudgetBytes(): number {
  try {
    const mb = Number(localStorage.getItem('fs.loadBudgetMB'));
    if (mb > 0) return mb * 1024 * 1024;
  } catch {
    /* no storage: the default */
  }
  const dm = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  const gb = typeof dm === 'number' && dm > 0 ? Math.min(2, Math.max(1, dm / 4)) : 1.5;
  return gb * 1024 ** 3;
}

/** What a load plan needs of a file: a File, or an entry of a zip bundle not unpacked yet. */
export interface SizedFile {
  name: string;
  size: number;
}

export interface LargeLoad<T extends SizedFile = SizedFile> {
  /** bytes of the files to load plus the event data already open */
  total: number;
  /** of which the event data already open */
  open: number;
  budget: number;
  /** the largest files, left out to stay within the budget (largest first) */
  skip: T[];
}
export type LargeLoadChoice = 'skip' | 'all' | 'cancel';

/**
 * Whether loading `files` would exceed the memory budget, and which files to leave out then: the largest first (files
 * of at least 20 MB), until the rest fits. Nanoscale runs often hold cleaning and buffer tubes of several hundred MB
 * to GB each (millions of noise events), which a whole experiment folder brings along.
 */
export function largeLoadPlan<T extends SizedFile>(files: T[], openBytes: number, budget = loadBudgetBytes()): LargeLoad<T> | null {
  const adds = files.reduce((a, f) => a + f.size, 0);
  const total = openBytes + adds;
  if (total <= budget) return null;
  const skip: T[] = [];
  let rest = total;
  for (const f of [...files].sort((a, b) => b.size - a.size)) {
    if (rest <= budget || f.size < 20 * 1024 * 1024) break;
    skip.push(f);
    rest -= f.size;
  }
  // nothing would be left: no point offering to leave everything out
  if (skip.length === files.length) skip.length = 0;
  // a few small files on top of much data already open: not worth asking
  if (!skip.length && adds < 50 * 1024 * 1024) return null;
  return { total, open: openBytes, budget, skip };
}

/** Event data (and original files kept in memory) of the samples open now, in bytes. */
export function openDataBytes(): number {
  const m = engine.memory();
  return (m.sampleDataMB + m.fileBytesMB) * 1024 * 1024;
}

let largeLoadPrompt: ((plan: LargeLoad) => Promise<LargeLoadChoice>) | null = null;
/** The question asked before a load that exceeds the memory budget (set by the app; without it everything loads). */
export function setLargeLoadPrompt(f: ((plan: LargeLoad) => Promise<LargeLoadChoice>) | null) {
  largeLoadPrompt = f;
}

/**
 * Ask before loading `files` when they exceed the memory budget (largeLoadPlan, set up by setLargeLoadPrompt): the files
 * to load (all of them, or without the largest when the user leaves those out) and those left out (reported in a toast
 * ending with `leftOutHint`); null when the user cancelled. `asked`: the question was shown. Without a prompt (no UI)
 * everything loads.
 */
export async function confirmLargeLoad<T extends SizedFile>(
  files: T[],
  opts: { openBytes?: number; leftOutHint?: (n: number) => string } = {},
): Promise<{ load: T[]; skipped: T[]; asked: boolean } | null> {
  const plan = largeLoadPrompt && files.length ? largeLoadPlan(files, opts.openBytes ?? openDataBytes()) : null;
  if (!plan || !largeLoadPrompt) return { load: files, skipped: [], asked: false };
  const choice = await largeLoadPrompt(plan);
  if (choice === 'cancel') return null;
  if (choice !== 'skip' || !plan.skip.length) return { load: files, skipped: [], asked: true };
  const sk = new Set<T>(plan.skip);
  const mb = plan.skip.reduce((a, f) => a + f.size, 0) / 1e6;
  const n = plan.skip.length;
  const hint = opts.leftOutHint?.(n) ?? (n === 1 ? 'Open it on its own if you need it.' : 'Open them on their own if you need them.');
  useStore
    .getState()
    .toast(
      `Left out ${n} large file${n === 1 ? '' : 's'} (${mb >= 1000 ? (mb / 1000).toFixed(1) + ' GB' : Math.round(mb) + ' MB'}): ${plan.skip
        .slice(0, 3)
        .map((f) => f.name)
        .join(', ')}${n > 3 ? ` and ${n - 3} more` : ''}. ${hint}`,
      'info',
      { duration: 15000 },
    );
  return { load: files.filter((f) => !sk.has(f)), skipped: plan.skip, asked: true };
}

// ---------------------------------------------------------------- file loads while a session is restored

let loadHold: Promise<void> | null = null;

/**
 * Hold file loads until `p` settles: restoring the last session (or opening an earlier one) replaces the workspace and
 * its data, so files opened meanwhile would be dropped with the workspace they went into. They are added once it is done.
 */
export function holdFileLoads<T>(p: Promise<T>): Promise<T> {
  const h = p.then(
    () => undefined,
    () => undefined,
  );
  loadHold = h;
  void h.then(() => {
    if (loadHold === h) loadHold = null;
  });
  return p;
}

/** Wait while a session is being restored (holdFileLoads); true when it had to wait. */
export async function fileLoadsReady(): Promise<boolean> {
  if (!loadHold) return false;
  useStore.getState().toast('The files are added once the last session is restored.', 'info');
  while (loadHold) await loadHold;
  return true;
}

/**
 * Load FCS files as samples (relinking samples that wait for them). `preparsed`: data sets already read for some of
 * the files (e.g. event tables converted to FCS, see core/eventtable.ts), used instead of reading the file as FCS.
 * `noPrompt`: the large-load question was answered already for these files (see confirmLargeLoad).
 */
export async function loadFcsFiles(files: File[], preparsed?: Map<File, FcsSample[]>, opts: { noPrompt?: boolean } = {}): Promise<string[]> {
  // files opened while the last session is restored are added to it afterwards (not dropped with the workspace)
  await fileLoadsReady();
  // in natural order of their paths / names (A2 before A10, Plate 2 before Plate 10): samples, wells and plates come in
  // the order they were measured, whatever order the system handed the files over in
  files = [...files].sort((a, b) => NATURAL.compare(relativePathOf(a) || a.name, relativePathOf(b) || b.name));
  const ids: string[] = [];
  const st = useStore.getState();
  // more event data than the browser tab can keep: ask (leave out the largest files, load all anyway, or cancel)
  if (!opts.noPrompt) {
    const ok = await confirmLargeLoad(files.filter((f) => !preparsed?.has(f)));
    if (!ok) return [];
    if (ok.skipped.length) {
      const sk = new Set(ok.skipped);
      files = files.filter((f) => !sk.has(f));
    }
  }
  const mismatch = new Map<string, string>(); // channel -> sample name whose data do not fit the existing axis
  // one sample per independent data set (e.g. one per well); the two copies in a Beckman LMD file are one sample
  const parsed: { f: File; parts: FcsSample[] }[] = [];
  for (const f of files) {
    try {
      const parts = preparsed?.get(f) ?? parseFcsSamples(await f.arrayBuffer());
      if (!parts.length) throw new Error('Empty file: it holds no data set.');
      parsed.push({ f, parts });
    } catch (e) {
      st.toast(`${f.name}: ${readableError(e)}`, 'error');
    }
  }
  // data sets no waiting sample of the same file name is there for: matched by $FIL / name and event count
  const waitingNow = () => useStore.getState().ws.samples.filter((s) => !engine.has(s.id));
  const nameWaiting = new Set(waitingNow().map((s) => s.fileName.toLowerCase()));
  const byContent = parsed.flatMap(({ f, parts }) => (nameWaiting.has(f.name.toLowerCase()) ? [] : parts.map((p) => ({ f, ds: p.ds }))));
  const nameClaimed = new Set(parsed.map((p) => p.f.name.toLowerCase()));
  const content = matchByContent(
    byContent.map((c) => linkCandidateOf(c.f.name, c.ds)),
    waitingNow().filter((s) => !nameClaimed.has(s.fileName.toLowerCase())),
  );
  const contentOf = new Map(byContent.map((c, i) => [c.ds, content[i]]));
  const relinked: string[] = [];
  // instruments of the samples there before this load (their scales must not change)
  const instBefore = new Set(useStore.getState().ws.samples.map((s) => sampleInstrument(useStore.getState().ws, s.id, engine.keywordsOf)));
  // new instrument -> channel -> files whose data do not fit the existing axis (instrument scales are made for them)
  const instMismatch = new Map<string, Map<string, string>>();
  // folder of each new sample (files opened as a folder): tells plates apart
  const folders = new Map<string, string>();
  // all samples of this load are one undo step (with the instrument scales it makes)
  loadKey = 'load:' + uid('batch');
  const batchKey = loadKey;
  let placed: PlaceSummary | null = null;
  try {
  for (const { f, parts } of parsed) {
    if (parts.length > 1) st.toast(`${f.name}: ${parts.length} data sets, loaded as ${parts.length} samples`, 'info');
    for (const { ds, bytes } of parts) {
      try {
        // notes worth seeing at once: several data sets, and a damaged file read in part or with implausible keywords
        // (all notes are in the sample's keyword dialog)
        for (const w of userWarnings(ds).filter((x) => /data sets|more than the file holds|complete events of|Implausible ranges|is not usable|have no names|without a name/.test(x)).slice(0, 2))
          st.toast(`${f.name}: ${w}`, 'info', { duration: 9000 });
        let waiting = relinkTarget(f.name, f.size, ds.eventCount, ds.dataset?.index);
        const cm = contentOf.get(ds);
        let renamed = false;
        if (!waiting && cm?.sample && !engine.has(cm.sample.id)) {
          waiting = cm.sample;
          renamed = true;
        } else if (!waiting && cm?.ambiguous?.length) {
          const names = cm.ambiguous.slice(0, 3).map((s) => `'${s.name}'`).join(', ');
          st.toast(`${f.name} could belong to ${cm.ambiguous.length > 1 ? 'several workspace samples' : 'a workspace sample another file also matches'} (${names}); it was not loaded. Link it by hand: right-click the sample, "Locate file".`, 'info', { duration: 15000 });
          continue;
        }
        // instruments of the samples there so far: axes set for another instrument are worth a note, the same one's not
        const other = instrumentsBefore();
        const had = new Set(Object.keys(useStore.getState().ws.scales));
        // a file of one data set is kept as the File (read again only to save or store it), not as a second copy
        // of its bytes in memory
        const id = addDataset(f.name, f.size, ds, parts.length === 1 && !preparsed?.has(f) ? f : bytes, waiting?.id);
        if (renamed && waiting) {
          const prev = waiting.fileName;
          useStore.getState().update((w) => {
            const x = w.samples.find((y) => y.id === id);
            if (x) x.fileName = f.name; // later relinks look for this file
          }, loadKey ?? 'load:' + id);
          relinked.push(`${f.name} -> '${waiting.name}' (${prev}, by ${cm?.how ?? 'event count'})`);
        }
        ids.push(id);
        const dir = folderOf(f);
        if (dir) folders.set(id, dir);
        const inst = instrumentKeyOf(ds.keywords);
        // more files of an instrument the workspace already has: its samples were there with these axes before (their
        // own scales, or the workspace's), nothing to note
        if (otherInstrument(ds, other) && !(inst && instBefore.has(inst))) {
          const own = !!inst && !renamed && !waiting;
          for (const ch of scaleMismatches(useStore.getState().ws, id, had)) {
            if (own) {
              const m = instMismatch.get(inst) ?? new Map<string, string>();
              instMismatch.set(inst, m);
              if (!m.has(ch)) m.set(ch, f.name);
            } else if (!mismatch.has(ch)) mismatch.set(ch, f.name);
          }
        }
      } catch (e) {
        st.toast(`${f.name}: ${readableError(e)}`, 'error');
      }
    }
  }
  if (ids.length) {
    const s0 = useStore.getState();
    if (!s0.ui.activeSampleId || !engine.has(s0.ui.activeSampleId)) s0.setUI({ activeSampleId: ids[0] });
    ensureStarterPlots();
    // plates and wells of the new samples (same undo step); relinked samples keep theirs
    placed = placeSamples(ids, { key: batchKey, folders });
  }
  } finally {
    loadKey = null;
  }
  if (relinked.length)
    st.toast(
      `${relinked.length} file${relinked.length > 1 ? 's were' : ' was'} linked to workspace samples with other file names: ${relinked.slice(0, 2).join('; ')}${relinked.length > 2 ? ` and ${relinked.length - 2} more` : ''}.`,
      'info',
      { duration: 12000 },
    );
  const gm = gateChannelsMissing(useStore.getState().ws);
  if (ids.length && gm.size) warnMissingGateChannels(gm);
  if (ids.length) {
    const s = useStore.getState();
    if (!s.ui.activeSampleId || !engine.has(s.ui.activeSampleId)) s.setUI({ activeSampleId: ids[0] });
    s.setUI((u) => ({ dataVersion: u.dataVersion + 1, missingFiles: useStore.getState().ws.samples.filter((x) => !engine.has(x.id)).map((x) => x.fileName) }));
    s.toast(
      `${ids.length > files.length ? `Loaded ${ids.length} samples from ${files.length} file${files.length > 1 ? 's' : ''}` : `Loaded ${ids.length} file${ids.length > 1 ? 's' : ''}`}. Undo (Ctrl+Z) removes ${ids.length > 1 ? 'them' : 'it'} again in one step.`,
      'success',
    );
    if (instMismatch.size) {
      // the same undo step as the samples: "Undo removes it again in one step" holds
      addInstrumentScales(instMismatch, batchKey);
    }
    if (placed && placed.wells > 0) {
      const p = placed;
      s.toast(
        `Wells found for ${p.wells} of ${ids.length} sample${ids.length > 1 ? 's' : ''} (${p.fromKeywords ? 'FCS keywords' : 'sample names'}) on ${p.plates.length === 1 ? `plate "${p.plates[0]}"` : `${p.plates.length} plates (${p.plates.slice(0, 3).join(', ')}${p.plates.length > 3 ? ', ...' : ''})`}${p.notes.length ? `; ${p.notes.join('; ')}` : ''}.`,
        'info',
        { duration: 10000, action: { label: 'Show plate', run: () => showPlateHook?.() } },
      );
    }
    // nanoscale data in an analysis set up as conventional: offer the calibrations hidden for it
    const su = useStore.getState().ws.setup;
    if (su?.kind === 'conventional' && (!su.size || !su.mesf) && ids.some((id) => { const sd = engine.samples.get(id); return !!sd && isNanoscaleData(sd.ds); }))
      s.toast('These files come from a nanoscale setup (violet side scatter). Show the size and MESF calibrations for it?', 'info', {
        duration: 15000,
        action: {
          label: 'Nanoscale',
          run: () =>
            useStore.getState().update((w) => {
              w.setup = { kind: 'nanoscale', mesf: true, size: true };
            }),
        },
      });
    if (mismatch.size) {
      const chans = [...mismatch.keys()];
      const list = chans.slice(0, 3).join(', ') + (chans.length > 3 ? ` and ${chans.length - 3} more` : '');
      s.toast(`Axis ranges were set for another instrument: ${list} of the new files lie far outside the current axes.`, 'info', {
        duration: 15000,
        action: { label: 'Fit axes to data', run: () => fitScalesToData(chans) },
      });
    }
  }
  return ids;
}

// --------------------------------------------------------------- axis ranges of another instrument

/** Upper end of a scale in data units (linear / log max, logicle / arcsinh T). */
function scaleTop(def: ScaleDef): number {
  switch (def.type) {
    case 'linear':
    case 'log':
      return def.max;
    case 'logicle':
    case 'arcsinh':
      return def.T;
    case 'window':
      return scaleTop(def.base);
  }
  return NaN;
}

/** High quantile of the finite values (subsampled), for comparing a data range with an axis. */
function highValue(v: Float32Array, q = 0.998): number {
  const step = Math.max(1, Math.floor(v.length / 20000));
  const a: number[] = [];
  for (let i = 0; i < v.length; i += step) if (Number.isFinite(v[i])) a.push(v[i]);
  if (!a.length) return NaN;
  a.sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))];
}

/**
 * Channels of sample `id` whose workspace scale existed before it was loaded (`had`) and does not fit its data by more
 * than 10x: values far above the axis top, or (scatter) an axis far wider than the data and the instrument's range,
 * e.g. CytoFLEX FSC-A up to ~80 million on a BD axis of 262,144 or the other way round.
 */
export function scaleMismatches(ws: Workspace, id: string, had: Set<string>): string[] {
  const s = ws.samples.find((x) => x.id === id);
  if (!s) return [];
  const out: string[] = [];
  for (const c of s.channels) {
    if (!had.has(c.name) || isTimeCh(c.name)) continue;
    const def = engine.scaleFor(ws, c.name, id);
    const top = def ? scaleTop(def as ScaleDef) : NaN;
    const v = engine.raw(ws, id, c.name);
    if (!(top > 0) || !v) continue;
    const hi = highValue(v);
    if (!(hi > 0)) continue;
    // data far above the axis; or a scatter axis far wider than this instrument's whole range (dim beads on a cell axis
    // of the same instrument are fine)
    if (hi > 10 * top || (isScatterOrTime(c.name) && hi * 10 < top && c.range > 0 && top > 10 * c.range)) out.push(c.name);
  }
  return out;
}

/**
 * Files of a new instrument whose data do not fit the existing axes (instrument -> channel -> a file name): give that
 * instrument its own scales of these channels (Workspace.instrumentScales), computed from its loaded samples as for new
 * channels. The samples of the other instruments keep their scales (and counts). One undo step, with a toast.
 */
export function addInstrumentScales(mismatch: Map<string, Map<string, string>>, undoKey?: string) {
  const st = useStore.getState();
  const ws = st.ws;
  const made: { inst: string; chans: string[] }[] = [];
  const next: Record<string, Record<string, ScaleDef>> = {};
  for (const [inst, chans] of mismatch) {
    const ids = ws.samples.filter((s) => engine.has(s.id) && sampleInstrument(ws, s.id, engine.keywordsOf) === inst).map((s) => s.id);
    if (!ids.length) continue;
    const out: Record<string, ScaleDef> = {};
    for (const ch of chans.keys()) {
      const parts: Float32Array[] = [];
      let range = 0;
      let hint: 'lin' | 'log' | '' = '';
      let like: { ds: FcsDataset; c: FcsDataset['channels'][number] } | null = null;
      for (const id of ids) {
        const sd = engine.samples.get(id)!;
        const i = sd.index.get(ch);
        const v = engine.raw(ws, id, ch);
        if (i === undefined || !v || !v.length) continue;
        range = Math.max(range, sd.ds.channels[i].range || 0);
        hint = scaleHintOf(sd.ds, sd.ds.channels[i]) || hint;
        like ??= { ds: sd.ds, c: sd.ds.channels[i] };
        const n = Math.min(v.length, 20000);
        const sub = new Float32Array(n);
        for (let j = 0; j < n; j++) sub[j] = v[Math.floor((j * v.length) / n)];
        parts.push(sub);
      }
      if (!parts.length) continue;
      const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      // the kind of axis follows the shared scale (linear stays linear, log-like stays log-like) unless the instrument
      // has its own default (nanoscale scatter: log)
      const cur = ws.scales[ch] as ScaleDef | undefined;
      const base = cur?.type === 'window' ? cur.base : cur;
      if (!hint) hint = !base ? '' : base.type === 'linear' ? 'lin' : 'log';
      // (a pure log shared axis: a pure log own axis)
      const lg = base?.type === 'log' && hint === 'log' ? positiveLogScaleFor(range, all, true) : null;
      out[ch] = lg ?? (like ? newChannelScale(like.ds, like.c, range, all, hint) : defaultScaleFor(ch, range, all, hint));
    }
    if (Object.keys(out).length) {
      next[inst] = out;
      made.push({ inst, chans: Object.keys(out) });
    }
  }
  if (!made.length) return;
  st.update((w) => {
    const map = (w.instrumentScales ??= {});
    for (const [inst, chans] of Object.entries(next)) map[inst] = { ...(map[inst] ?? {}), ...chans } as Draft<Record<string, ScaleDef>>;
    // samples loaded before instrument keys were kept: theirs, so their scales stay the shared ones
    for (const smp of w.samples) if (smp.instrument === undefined) smp.instrument = sampleInstrument(w as Workspace, smp.id, engine.keywordsOf);
  }, undoKey ?? 'instscales:' + uid('i'));
  st.setUI((u) => ({ dataVersion: u.dataVersion + 1 }));
  const after = useStore.getState().ws;
  const list = (a: string[]) => a.slice(0, 3).join(', ') + (a.length > 3 ? ` and ${a.length - 3} more` : '');
  const first = made[0];
  const others = [...new Set(ws.samples.map((x) => sampleInstrument(ws, x.id, engine.keywordsOf)).filter((k) => k && !next[k]))];
  const all = [...others, ...made.map((m) => m.inst)];
  st.toast(
    `${made.length === 1 ? `"${instrumentDisplayName(first.inst, all)}"` : `${made.length} instruments`} got ${made.length === 1 ? 'its' : 'their'} own axis scales for ${list([...new Set(made.flatMap((m) => m.chans))])}: the ranges differ more than 10x from ${others.length ? `"${instrumentDisplayName(others[0], all)}"` : 'the other samples'}. The other samples keep their axes and counts.`,
    'info',
    // as part of a file load, Undo of the load removes them too (one step, see loadFcsFiles)
    { duration: 15000, ...(undoKey ? {} : { action: undoAction(after) }) },
  );
}

/**
 * Short name of an instrument key for messages and labels: without the serial numbers in parentheses and naming a model
 * family once, e.g. "CytoFLEX mosaic 88 & CytoFLEX LX (BJ08011 & BJ09005)" -> "CytoFLEX mosaic 88 & LX". The key itself
 * (SampleRef.instrument, Workspace.instrumentScales) is unchanged. `others`: keys shown alongside; when one of them
 * would read the same, the full key is shown.
 */
export function instrumentDisplayName(key: string, others: string[] = []): string {
  const short = (k: string): string => {
    let s = k.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (!s) return k;
    const parts = s.split(/\s+&\s+/);
    if (parts.length > 1) {
      const fam = parts[0].split(' ')[0].toLowerCase();
      s = [parts[0], ...parts.slice(1).map((p) => (p.toLowerCase().startsWith(fam + ' ') ? p.slice(fam.length + 1) : p))].join(' & ');
    }
    return s.length > 32 ? s.slice(0, 31).trimEnd() + '\u2026' : s;
  };
  const mine = short(key);
  return others.some((o) => o !== key && short(o) === mine) ? key : mine;
}

// --------------------------------------------------------------- gates keep their events when axis scales change

/** Display scales a polygon / ellipse is evaluated in (gate x, gate y). */
export type EvalPair = { x: ScaleDef; y: ScaleDef };

type FreeShape = Extract<GateGeom, { type: 'polygon' | 'ellipse' }>;

/** A polygon / ellipse that follows the axis scales (no own scales of both axes): drawn in the app. */
const followsAxes = (g: GateGeom | undefined): g is FreeShape => !!g && (g.type === 'polygon' || g.type === 'ellipse') && !(g.scales?.x && g.scales?.y);

const scaleJson = new WeakMap<object, string>();
const scaleKey = (s: ScaleDef): string => {
  let k = scaleJson.get(s);
  if (k === undefined) scaleJson.set(s, (k = JSON.stringify(s)));
  return k;
};
const sameScale = (a: ScaleDef, b: ScaleDef) => a === b || scaleKey(a) === scaleKey(b);
const samePair = (a: EvalPair, b: EvalPair) => sameScale(a.x, b.x) && sameScale(a.y, b.y);

/** How a gate keeps its events: own scales for the shared gate (null: unchanged) and sample-specific copies. */
export interface FreezePlan {
  shared: EvalPair | null;
  perSample: [string, EvalPair][];
}

/**
 * What is known about a gate's events (freezePlan): lets samples without events in the gate (e.g. the samples of
 * another instrument, or with an empty parent) share scales other than their own.
 */
export interface FreezeEvidence {
  /** events of the gate in a sample before the change (0 for a sample without data) */
  members(sid: string): number;
  /**
   * Whether a sample without events in the gate still has none when the gate is evaluated in `pair` (exact, on the
   * sample's data; false when that cannot be checked, e.g. without data).
   */
  staysEmpty(sid: string, pair: EvalPair): boolean;
}

/**
 * Keep the events of a polygon / ellipse gate that follows the axes while the scales it is evaluated in change:
 * `before(sid)` / `after(sid)` are the evaluation scales of sample `sid` (null: the workspace scale) then and now. Null
 * when no sample's events change. A sample keeps its events on a choice of scales when they are the ones it was
 * evaluated in, or (with `evidence`) when it had no events in the gate and still has none there: the gate then belongs
 * to the instrument(s) on whose samples it has events. Of the choices (keep following the axes, or the former scales of
 * the workspace or of a sample as the gate's own `shared` scales), the one with the fewest sample-specific copies
 * (`perSample`, with the sample's former scales) wins, then the one whose copies hold the fewest events (the gate keeps
 * the scales of the samples it has events on), then following the axes, then the workspace scale. Copies are only made
 * for samples that have events in the gate on scales that differ from the shared gate's (or cannot be checked).
 * Without samples, the workspace scale decides.
 */
export function freezePlan(sids: string[], before: (sid: string | null) => EvalPair, after: (sid: string | null) => EvalPair, evidence?: FreezeEvidence): FreezePlan | null {
  if (!sids.length) {
    const o = before(null);
    return samePair(o, after(null)) ? null : { shared: o, perSample: [] };
  }
  const olds = sids.map((s) => before(s));
  const news = sids.map((s) => after(s));
  if (sids.every((_, i) => samePair(olds[i], news[i]))) return null;
  const members = sids.map((s) => evidence?.members(s) ?? 0);
  // whether sample i keeps its events when evaluated in `pair`
  const keeps = (i: number, pair: EvalPair) => samePair(olds[i], pair) || (!!evidence && members[i] === 0 && evidence.staysEmpty(sids[i], pair));
  /** samples that need a copy with their former scales when the shared gate is evaluated in `c` (null: follows the axes) */
  const copiesFor = (c: EvalPair | null) => sids.flatMap((_, i) => (keeps(i, c ?? news[i]) ? [] : [i]));
  const weigh = (idx: number[]) => idx.reduce((a, i) => a + members[i], 0);
  let best: EvalPair | null = null;
  let bestIdx = copiesFor(null);
  if (!bestIdx.length) return null;
  let bestW = weigh(bestIdx);
  // candidates for the shared gate's own scales: the workspace scale, then each sample's former scales
  const cands: EvalPair[] = [];
  for (const o of [before(null), ...olds]) if (!cands.some((c) => samePair(c, o))) cands.push(o);
  for (const c of cands) {
    const idx = copiesFor(c);
    const w = weigh(idx);
    if (idx.length < bestIdx.length || (idx.length === bestIdx.length && w < bestW)) {
      best = c;
      bestIdx = idx;
      bestW = w;
    }
  }
  return { shared: best, perSample: bestIdx.map((i): [string, EvalPair] => [sids[i], olds[i]]) };
}

/**
 * Apply a freeze plan to a population's shared gate (`target` = p.gate: sample-specific copies are added for
 * plan.perSample) or to one of its sample-specific gates (`target` = an override: only plan.shared applies). The gates
 * keep the off-scale handling of gates drawn in the app (not strict).
 */
export function applyFreezePlan(p: Draft<Population> | Population, target: Draft<GateGeom> | GateGeom, plan: FreezePlan) {
  if (target.type !== 'polygon' && target.type !== 'ellipse') return;
  const strict = target.strict ?? false;
  if (target === p.gate && plan.perSample.length) {
    const base = structuredClone(isDraft(target) ? current(target) : target) as FreeShape;
    const ov = (p.overrides ??= {}) as Record<string, GateGeom>;
    for (const [sid, sc] of plan.perSample) ov[sid] = { ...base, scales: { x: sc.x, y: sc.y }, strict };
  }
  if (plan.shared) {
    (target as FreeShape).scales = { x: plan.shared.x, y: plan.shared.y };
    target.strict = strict;
  }
}

/**
 * Gate changes that keep the events of every sample when the scales of `before` are replaced by those of `after` (same
 * populations and samples; only `scales` / `instrumentScales` differ): polygon and ellipse gates drawn in the app follow
 * the axis scale of each sample's instrument, so a refitted axis would move their boundary over the events. Only gates
 * whose events actually change for some sample are touched (see freezePlan): a gate with events on the samples of one
 * instrument keeps that instrument's former scales as its own (samples of other instruments without events in it keep
 * none); sample-specific copies (`split`) only where a gate has events on samples evaluated on different scales (or
 * would select events of a sample it has none in now). Null when no gate changes.
 */
export function scaleChangeFreeze(
  before: Workspace,
  after: Workspace,
): { apply: (w: Draft<Workspace>) => void; gates: number; split: { pop: string; name: string; samples: string[]; empty?: string[] }[] } | null {
  const ev = (ws: Workspace, g: FreeShape, sid: string | null): EvalPair => gateEvalScales(g, (ch) => engine.scaleFor(ws, ch, sid));
  const todo: { pop: string; override?: string; plan: FreezePlan }[] = [];
  const known = new Set(before.samples.map((s) => s.id));
  /** the gate's events in a sample (0 without data or where the population does not apply) */
  const members = (p: Population, sid: string) => (engine.has(sid) ? engine.count(before, sid, p.id) : 0);
  /** whether a sample without events in the gate still has none with the gate evaluated in `pair` */
  const staysEmpty = (p: Population, g: FreeShape, sid: string, pair: EvalPair) => {
    if (!engine.has(sid)) return false;
    if (!engine.applies(before, sid, p.id)) return true;
    const probe = { ...g, scales: { x: pair.x, y: pair.y }, strict: g.strict ?? false } as FreeShape;
    return engine.gateEvents(before, sid, probe, p.parentId).length === 0;
  };
  for (const p of before.populations) {
    // sample-specific gates: each for its own sample (one without events that keeps none stays as it is)
    for (const [sid, og] of Object.entries(p.overrides ?? {})) {
      if (!followsAxes(og) || !known.has(sid)) continue;
      const o = ev(before, og, sid);
      const n = ev(after, og, sid);
      if (samePair(o, n) || (members(p, sid) === 0 && staysEmpty(p, og, sid, n))) continue;
      todo.push({ pop: p.id, override: sid, plan: { shared: o, perSample: [] } });
    }
    const g = p.gate;
    if (!followsAxes(g)) continue;
    const sids = before.samples.filter((s) => !p.overrides?.[s.id] && inScopeChain(before, s.id, p.id)).map((s) => s.id);
    const plan = freezePlan(
      sids,
      (sid) => ev(before, g, sid),
      (sid) => ev(after, g, sid),
      { members: (sid) => members(p, sid), staysEmpty: (sid, pair) => staysEmpty(p, g, sid, pair) },
    );
    if (plan) todo.push({ pop: p.id, plan });
  }
  if (!todo.length) return null;
  const split = todo
    .filter((t) => t.override === undefined && t.plan.perSample.length)
    .map((t) => {
      const p = before.populations.find((q) => q.id === t.pop);
      const samples = t.plan.perSample.map(([s]) => s);
      // copies for samples the gate holds no events in: the shared gate would gain events there
      const empty = p ? samples.filter((sid) => members(p, sid) === 0) : [];
      return { pop: t.pop, name: p?.name ?? '', samples, ...(empty.length ? { empty } : {}) };
    });
  return {
    gates: new Set(todo.map((t) => t.pop)).size,
    split,
    apply: (w) => {
      for (const t of todo) {
        const p = w.populations.find((q) => q.id === t.pop);
        const g = t.override !== undefined ? p?.overrides?.[t.override] : p?.gate;
        if (p && g) applyFreezePlan(p, g, t.plan);
      }
    },
  };
}

/**
 * The note of a scale change on the gates it froze (scaleChangeFreeze), starting with a space; names the gates that
 * got sample-specific copies. Empty when no gate changed.
 */
export function freezeNote(ws: Workspace, f: ReturnType<typeof scaleChangeFreeze>): string {
  if (!f) return '';
  let s = ` ${f.gates} gate${f.gates > 1 ? 's keep their' : ' keeps its'} counts on the former scales.`;
  if (f.split.length) {
    const names = f.split.slice(0, 2).map((x) => `"${x.name}"`).join(', ') + (f.split.length > 2 ? ` and ${f.split.length - 2} more` : '');
    const sids = [...new Set(f.split.flatMap((x) => x.samples))];
    const who = sids.length === 1 ? `"${ws.samples.find((x) => x.id === sids[0])?.name ?? 'one sample'}"` : `${sids.length} samples`;
    // why: the gate's events there would change (lost, or gained where it holds none now)
    const allEmpty = f.split.every((x) => (x.empty ?? []).length === x.samples.length);
    const many = f.split.length > 1;
    s += ` ${names}: ${many ? 'shared gates' : 'a shared gate'} would change the counts on ${who}${allEmpty ? ` (${many ? 'they' : 'it'} would gain events there)` : ''}, so ${many ? 'they' : 'it'} got ${many ? 'sample-specific copies' : 'a sample-specific copy'} there (dashed outline).`;
  }
  return s;
}

/** The workspace with other scales (and instrument scales), for comparing gate evaluation before / after a change. */
export function withScales(ws: Workspace, scales: Record<string, ScaleDef>, inst?: Record<string, Record<string, ScaleDef>>): Workspace {
  const merged: Record<string, Record<string, ScaleDef>> | undefined = ws.instrumentScales && { ...ws.instrumentScales };
  if (merged && inst) for (const [k, m] of Object.entries(inst)) if (merged[k]) merged[k] = { ...merged[k], ...m };
  return { ...ws, scales: { ...ws.scales, ...scales }, ...(merged ? { instrumentScales: merged } : {}) };
}

/** A default-like scale of `ch` (keeping the kind of `cur`) from the events of `ids`, the same number from each sample. */
function fitScaleFromSamples(ws: Workspace, ch: string, ids: string[], cur: ScaleDef | undefined): ScaleDef | null {
  const parts: Float32Array[] = [];
  let range = 0;
  // the axis keeps its kind of transform (linear stays linear, log-like stays log-like); only its range follows the data
  const base = cur?.type === 'window' ? cur.base : cur;
  const hint: 'lin' | 'log' | '' = !base ? '' : base.type === 'linear' ? 'lin' : 'log';
  for (const id of ids) {
    const sd = engine.samples.get(id);
    if (!sd) continue;
    const i = sd.index.get(ch);
    const v = engine.raw(ws, id, ch);
    if (i === undefined || !v || !v.length) continue;
    range = Math.max(range, sd.ds.channels[i].range || 0);
    // the same number of events from each sample: every sample's data end up on the axis, whatever its size
    const n = 20000;
    const sub = new Float32Array(n);
    for (let j = 0; j < n; j++) sub[j] = v[Math.floor((j * v.length) / n)];
    parts.push(sub);
  }
  if (!parts.length) return null;
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  // a pure log axis stays one (defaultScaleFor makes log-like axes logicle)
  if (base?.type === 'log') {
    const lg = positiveLogScaleFor(range, all, true);
    if (lg) return base.clampLow ? { ...lg, clampLow: true } : lg;
  }
  return defaultScaleFor(ch, range, all, hint);
}

/**
 * Recompute the scales of `channels` from the data of the loaded samples (as for newly loaded channels): the workspace
 * scale from the samples that use it, each instrument's own scale (Workspace.instrumentScales) from that instrument's
 * samples. Polygon and ellipse gates whose evaluation would change keep the scales they were evaluated in (per sample
 * where instruments differ), so no count changes.
 */
export function fitScalesToData(channels: string[]) {
  const st = useStore.getState();
  const ws = st.ws;
  const next: Record<string, ScaleDef> = {};
  const nextInst: Record<string, Record<string, ScaleDef>> = {};
  for (const ch of channels) {
    // '' = samples on the workspace scale; else the instrument whose own scale of `ch` they use
    const groups = new Map<string, string[]>();
    for (const s of ws.samples) {
      if (!engine.has(s.id)) continue;
      const k = instrumentScaleKey(ws, ch, s.id, engine.keywordsOf) ?? '';
      groups.set(k, [...(groups.get(k) ?? []), s.id]);
    }
    for (const [k, ids] of groups) {
      const def = fitScaleFromSamples(ws, ch, ids, (k ? ws.instrumentScales?.[k]?.[ch] : ws.scales[ch]) as ScaleDef | undefined);
      if (!def) continue;
      if (k) (nextInst[k] ??= {})[ch] = def;
      else next[ch] = def;
    }
  }
  const n = Object.keys(next).length + Object.values(nextInst).reduce((a, m) => a + Object.keys(m).length, 0);
  if (!n) return;
  const freeze = scaleChangeFreeze(ws, withScales(ws, next, nextInst));
  st.update((w) => {
    freeze?.apply(w);
    for (const [ch, def] of Object.entries(next)) w.scales[ch] = def;
    for (const [k, m] of Object.entries(nextInst)) {
      const map = w.instrumentScales?.[k];
      if (map) for (const [ch, def] of Object.entries(m)) map[ch] = def;
    }
  });
  st.setUI((u) => ({ dataVersion: u.dataVersion + 1 }));
  const perInst = Object.keys(nextInst).length;
  st.toast(
    `Fitted ${n} ax${n > 1 ? 'es' : 'is'} to the data of the loaded samples${perInst ? ` (${perInst > 1 ? `the own axes of ${perInst} instruments to their samples` : `the own axes of "${instrumentDisplayName(Object.keys(nextInst)[0])}" to its samples`})` : ''}.${freezeNote(ws, freeze)}`,
    'success',
    { action: undoAction(useStore.getState().ws) },
  );
}

/**
 * Link a file to a workspace sample by hand (names may differ, e.g. a renamed file). A different event count asks
 * first, since the gates and statistics were made on the original file.
 */
export async function relinkSample(sampleId: string, f: File): Promise<void> {
  const st = useStore.getState();
  const s = st.ws.samples.find((x) => x.id === sampleId);
  if (!s) return;
  let buf: ArrayBuffer | Blob;
  let ds: FcsDataset;
  try {
    // a file with several data sets: the one this sample was made from (by position, else by event count); an event
    // table (CSV) read as one
    const table = /\.(csv|tsv|txt)$/i.test(f.name);
    const parts = table ? null : parseFcsSamples(await f.arrayBuffer());
    const part = parts ? pickSample(parts, { index: datasetIndexOf(s), eventCount: s.eventCount }) : eventTableDataset(await parseEventStream(f.stream() as ReadableStream<Uint8Array>), f.name);
    buf = parts?.length === 1 ? f : part.bytes;
    ds = part.ds;
  } catch (e) {
    st.toast(`${f.name}: ${readableError(e)}`, 'error');
    return;
  }
  const link = () => {
    const cur = useStore.getState();
    if (!cur.ws.samples.some((x) => x.id === sampleId)) return;
    addDataset(f.name, f.size, ds, buf, sampleId);
    // the sample keeps its name; later relinks look for the new file name
    cur.update((ws) => {
      const x = ws.samples.find((y) => y.id === sampleId);
      if (x) x.fileName = f.name;
    }, 'load:' + sampleId);
    const after = useStore.getState();
    after.setUI((u) => ({
      dataVersion: u.dataVersion + 1,
      activeSampleId: u.activeSampleId && engine.has(u.activeSampleId) ? u.activeSampleId : sampleId,
      missingFiles: after.ws.samples.filter((x) => !engine.has(x.id)).map((x) => x.fileName),
    }));
    after.toast(`Linked ${f.name} to '${s.name}'`, 'success');
  };
  if (s.eventCount && s.eventCount !== ds.eventCount) {
    st.setUI({
      dialog: {
        kind: 'confirm',
        payload: {
          title: 'Event count differs',
          text: `${f.name} has ${ds.eventCount.toLocaleString('en-US')} events, but '${s.name}' had ${s.eventCount.toLocaleString('en-US')} when it was analysed. It may be a different file: gates and statistics will be computed on the new data. Link it anyway?`,
          ok: 'Link anyway',
          onOk: link,
        },
      },
    });
    return;
  }
  link();
}

// --------------------------------------------------------------- plots

export interface DefaultChannelOpts {
  /** samples the channels must exist in (default: the selected samples, else the active sample, else all loaded) */
  sampleIds?: string[];
  /** population whose gates' channels come first among the fluorescence channels (default: the selected population) */
  popId?: string | null;
}

/** Samples default channels refer to: `ids`, else (for the store's workspace) the selected / active sample, else all loaded. */
export function relevantSamples(ws: Workspace, ids?: string[]): SampleRef[] {
  let want = ids;
  if (!want) {
    const st = useStore.getState();
    if (st.ws === ws) want = st.ui.selectedSampleIds.length > 1 ? st.ui.selectedSampleIds : st.ui.activeSampleId ? [st.ui.activeSampleId] : [];
  }
  const picked = want?.length ? ws.samples.filter((s) => want!.includes(s.id)) : [];
  if (picked.length) return picked;
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  return loaded.length ? loaded : ws.samples;
}

/** Fluorescence channels (no scatter, time, width / height duplicates), area channels first when a sample has them. */
function fluorescence(chans: string[]): string[] {
  const fl = chans.filter((c) => !isScatterOrTime(c) && !/width|-W$|^W$/i.test(c));
  const flA = fl.filter((c) => /-A$|INT|AREA/i.test(c));
  if (flA.length) return flA;
  const notH = fl.filter((c) => !/-H$|height/i.test(c));
  return notH.length ? notH : fl;
}

/** Channels of gates below and of a population: its child gates' channels first, then its own gate's. */
export function gateChannelsOf(ws: Workspace, popId: string | null | undefined): string[] {
  if (!popId || popId === 'root') return [];
  const out: string[] = [];
  const add = (g: GateGeom) => {
    if (g.type === 'bool') return;
    for (const c of [g.x, 'y' in g ? g.y : undefined]) if (c && !out.includes(c)) out.push(c);
  };
  // 1D child gates (ranges, splits) name the marker of interest most directly
  const kids = ws.populations.filter((p) => p.parentId === popId);
  for (const k of kids) if (k.gate.type === 'range' || k.gate.type === 'split') add(k.gate);
  for (const k of kids) add(k.gate);
  const own = ws.populations.find((p) => p.id === popId);
  if (own) add(own.gate);
  return out;
}

/**
 * Default channels for new plots and statistics: those of the relevant samples (opts.sampleIds, else the selected or
 * active sample), channels all of them have first; fluorescence area channels, with the channels gated on below / at the
 * selected population first.
 */
export function pickDefaultChannels(ws: Workspace, opts: DefaultChannelOpts = {}): { fsc: string; ssc: string; fl: string[] } {
  const rel = relevantSamples(ws, opts.sampleIds);
  const order: string[] = [];
  const n = new Map<string, number>();
  for (const s of rel)
    for (const c of s.channels) {
      if (!n.has(c.name)) order.push(c.name);
      n.set(c.name, (n.get(c.name) ?? 0) + 1);
    }
  // channels every relevant sample has, then the others (stable)
  const chans = [...order.filter((c) => n.get(c) === rel.length), ...order.filter((c) => n.get(c)! < rel.length)];
  const find = (re: RegExp) => chans.find((c) => re.test(c));
  let fsc = find(/^FSC[-_ ]?A$/i) ?? find(/^FSC/i) ?? find(/^FS/i) ?? chans[0] ?? 'FSC-A';
  let ssc = find(/^SSC[-_ ]?A$/i) ?? find(/^VSSC[-_ ]?A$/i) ?? find(/SSC.*-A$/i) ?? find(/^SSC/i) ?? find(/SSC/i) ?? find(/^SS/i) ?? chans[1] ?? 'SSC-A';
  // nanoscale instruments: forward scatter is noise for small particles; the two violet side scatters are the scatter plot
  const nano = nanoScatterChannels(ws, rel.map((s) => s.id));
  if (nano?.v2) [fsc, ssc] = [nano.v1, nano.v2];
  let fl = fluorescence(chans);
  const popId = opts.popId !== undefined ? opts.popId : useStore.getState().ws === ws ? useStore.getState().ui.selectedPopId : null;
  const gated = gateChannelsOf(ws, popId).filter((c) => n.has(c) && !isScatterOrTime(c));
  if (gated.length) fl = [...gated, ...fl.filter((c) => !gated.includes(c))];
  return { fsc, ssc, fl };
}

/**
 * Channel for an MFI column of population `popId` over `sampleIds`: the fluorescence channel of the population's own gate
 * (the marker it was gated on) or of its child gates, else the first fluorescence area channel most of the samples have.
 */
export function pickMfiChannel(ws: Workspace, sampleIds: string[], popId: string | null): string | undefined {
  const rel = relevantSamples(ws, sampleIds);
  const n = new Map<string, number>();
  for (const s of rel) for (const c of s.channels) n.set(c.name, (n.get(c.name) ?? 0) + 1);
  const own = popId && popId !== 'root' ? ws.populations.find((p) => p.id === popId) : undefined;
  const ownCh = own && own.gate.type !== 'bool' ? [own.gate.x, 'y' in own.gate ? own.gate.y : undefined] : [];
  const cand = [...ownCh, ...gateChannelsOf(ws, popId)].filter((c): c is string => !!c && n.has(c) && !isScatterOrTime(c));
  // the gated channel most of the samples have (stable: the population's own gate first)
  if (cand.length) return [...cand].sort((a, b) => n.get(b)! - n.get(a)!)[0];
  const { fl } = pickDefaultChannels(ws, { sampleIds: rel.map((s) => s.id), popId: null });
  // the channel most samples have (pickDefaultChannels lists channels all samples have first)
  return [...fl].sort((a, b) => (n.get(b) ?? 0) - (n.get(a) ?? 0))[0];
}

/**
 * Population new charts, stats boxes and overlays refer to: the selected population, else the population shown by the
 * selected plot, else All Events.
 */
export function currentPopulation(ws: Workspace = useStore.getState().ws, ui: UIState = useStore.getState().ui): string {
  if (ui.selectedPopId && ws.populations.some((p) => p.id === ui.selectedPopId)) return ui.selectedPopId;
  for (const sh of ws.worksheets)
    for (const it of sh.items)
      if (it.kind === 'plot' && ui.selectedItemIds.includes(it.id)) {
        const l = it.layers.find((x) => x.visible !== false);
        if (l && (l.population === 'root' || ws.populations.some((p) => p.id === l.population))) return l.population;
      }
  return 'root';
}

/**
 * Samples of a new overlay: the selected samples (two or more), else the active sample and the next loaded sample that
 * has channel `ch` (just the active one when there is no other). Fixed at creation: files loaded later are not added.
 */
export function overlaySampleIds(ws: Workspace = useStore.getState().ws, ui: UIState = useStore.getState().ui, ch?: string): string[] {
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  const sel = loaded.filter((s) => ui.selectedSampleIds.includes(s.id)).map((s) => s.id);
  if (sel.length > 1) return sel;
  const active = ui.activeSampleId && loaded.some((s) => s.id === ui.activeSampleId) ? ui.activeSampleId : loaded[0]?.id;
  if (!active) return [];
  const i = loaded.findIndex((s) => s.id === active);
  const others = [...loaded.slice(i + 1), ...loaded.slice(0, i)].filter((s) => !ch || s.channels.some((c) => c.name === ch));
  return others.length ? [active, others[0].id] : [active];
}

/** Layers of a new overlay plot of population `popId` on channel `ch` (see overlaySampleIds). */
export function overlayLayers(popId: string, ch?: string, ws: Workspace = useStore.getState().ws, ui: UIState = useStore.getState().ui): Layer[] {
  return overlaySampleIds(ws, ui, ch).map((sid) => ({ id: uid('ly'), sample: sid, population: popId }));
}

/**
 * A new histogram overlay at (x, y): the channel gated on below / at the current population (else the first fluorescence
 * channel of the samples), one layer per overlay sample (see overlaySampleIds).
 */
export function newOverlayPlot(x: number, y: number, w?: number, h?: number): PlotItem {
  const { ws, ui } = useStore.getState();
  const pop = currentPopulation(ws, ui);
  const ids = overlaySampleIds(ws, ui);
  const { fsc, fl } = pickDefaultChannels(ws, { sampleIds: ids, popId: pop });
  const ch = fl[0] ?? fsc;
  const it = newPlotItem('histogram', ch, ch, x, y, w, h, pop);
  it.layers = overlayLayers(pop, ch, ws, ui);
  if (!it.layers.length) it.layers = [{ id: uid('ly'), sample: 'active', population: pop }];
  it.options.histOffset = 0;
  return it;
}

/**
 * A new statistic chart: of the current population (selected population, else the selected plot's); its samples are
 * fixed now (the selected samples, else all loaded samples) or, with groups, the groups existing now. `stat` overrides
 * the statistic (e.g. a table column).
 */
export function newChartItem(x: number, y: number, w: number, h: number, stat?: StatColumn): ChartItem {
  const { ws, ui } = useStore.getState();
  const pop = stat?.population ?? currentPopulation(ws, ui);
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  const sel = loaded.filter((s) => ui.selectedSampleIds.includes(s.id));
  const grouped = ws.groups.length > 0 && sel.length < 2;
  const filterGroup = ui.sampleFilter !== 'all' ? ws.groups.find((g) => g.id === ui.sampleFilter) : undefined;
  const samples = (sel.length > 1 ? sel : filterGroup ? loaded.filter((s) => filterGroup.sampleIds.includes(s.id)) : loaded).map((s) => s.id);
  return {
    id: uid('chart'),
    kind: 'chart',
    x,
    y,
    w,
    h,
    stat: stat ? { ...stat, id: uid('col') } : { id: uid('col'), population: pop, stat: 'freqParent' },
    mode: grouped ? 'groups' : 'samples',
    sampleSet: filterGroup && !grouped ? filterGroup.id : 'all',
    samples,
    ...(grouped ? { groups: ws.groups.map((g) => g.id) } : {}),
    style: grouped ? 'dot' : 'bar',
    errorBars: 'sd',
    showPoints: true,
    color: '#5b8fd1',
    useGroupColors: true,
    // the figure text size (of the active sheet, else Workspace.style), as for new plots
    fontSize: bodyPt(ws, activeSheetOf(ws)),
    lineWidth: 1,
  };
}

/** Samples a chart shows: its fixed list (charts made since sample sets are fixed), else its live sample set. */
export function chartSampleIds(ws: Workspace, item: ChartItem): string[] {
  if (item.samples) return item.samples.filter((id) => ws.samples.some((s) => s.id === id) && engine.has(id));
  const grp = ws.groups.find((g) => g.id === item.sampleSet);
  return ws.samples.filter((s) => engine.has(s.id) && (!grp || grp.sampleIds.includes(s.id))).map((s) => s.id);
}

/** The worksheet shown (or the first one). */
export function activeSheetOf(ws: Workspace) {
  const id = useStore.getState().ui.activeSheetId;
  return ws.worksheets.find((s) => s.id === id) ?? ws.worksheets[0];
}

/** Default size of new plots in px: exactly the workspace figure style (positions snap to the grid, sizes do not). */
export function defaultPlotSize(): { w: number; h: number } {
  const { ws } = useStore.getState();
  const mm = 96 / 25.4;
  return { w: (ws.style.plotW ?? 60) * mm, h: (ws.style.plotH ?? 54) * mm };
}

export function newPlotItem(type: PlotType, xParam: string, yParam: string, x: number, y: number, w?: number, h?: number, population = 'root', sample = 'active'): PlotItem {
  const o = defaultPlotOptions();
  if (type === 'dot') o.colorMode = 'single';
  // the figure text size of the active sheet (its own, else the workspace figure style)
  const { ws: w0 } = useStore.getState();
  o.fontSize = bodyPt(w0, activeSheetOf(w0)) || o.fontSize;
  if (w === undefined || h === undefined) ({ w, h } = defaultPlotSize());
  return {
    id: uid('plot'),
    kind: 'plot',
    plotType: type,
    xParam,
    yParam,
    layers: [{ id: uid('ly'), sample, population }],
    options: o,
    x,
    y,
    w: w!,
    h: h!,
  };
}

/**
 * Violet side scatter channels (VSSC1, VSSC2; area preferred, by channel name or label) of the relevant samples when
 * they come from a nanoscale instrument (see isNanoscaleData), else null. CytoFLEX nano files name them "SSC-A" /
 * "SSC_1-A" with the labels "VSSC1-A" / "VSSC2-A".
 */
export function nanoScatterChannels(ws: Workspace, sampleIds?: string[]): { v1: string; v2?: string } | null {
  const rel = relevantSamples(ws, sampleIds);
  const nano = rel.some((s) => {
    const sd = engine.samples.get(s.id);
    return sd ? isNanoscaleData(sd.ds) : false;
  });
  if (!nano) return null;
  const find = (re: RegExp) => {
    for (const s of rel) for (const c of s.channels) if (re.test(c.name.trim()) || re.test((c.label ?? '').trim())) return c.name;
    return undefined;
  };
  const v1 = find(/^VSSC1?[-_ ]?A$/i) ?? find(/^VSSC1?[-_ ]?H$/i) ?? find(/^VSSC1?\b/i) ?? find(/violet[\s_-]*SSC/i);
  if (!v1) return null;
  const v2 = find(/^VSSC2[-_ ]?A$/i) ?? find(/^VSSC2[-_ ]?H$/i);
  return { v1, v2: v2 && v2 !== v1 ? v2 : undefined };
}

function ensureStarterPlots() {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((w) => w.id === st.ui.activeSheetId) ?? st.ws.worksheets[0];
  if (!sheet || sheet.items.length || st.ws.samples.length === 0) return;
  const { fsc, ssc, fl } = pickDefaultChannels(st.ws);
  const g = sheet.grid;
  const { w: W, h: H } = defaultPlotSize();
  const items: PlotItem[] = [];
  const at = (k: number) => g * 2 + k * (W + g);
  const nano = nanoScatterChannels(st.ws);
  if (nano) {
    // nanoscale instruments: the two violet side scatters (log axes), then side scatter against fluorescence
    if (nano.v2) items.push(newPlotItem('pseudo', nano.v1, nano.v2, at(0), g * 2, W, H));
    if (fl.length >= 1) items.push(newPlotItem('pseudo', nano.v1, fl[0], at(items.length), g * 2, W, H));
    if (fl.length >= 1) items.push(newPlotItem('histogram', fl[0], fl[0], at(items.length), g * 2, W, H));
    if (!items.length) items.push(newPlotItem('histogram', nano.v1, nano.v1, at(0), g * 2, W, H));
  } else {
    items.push(newPlotItem('pseudo', fsc, ssc, at(0), g * 2, W, H));
    if (fl.length >= 2) items.push(newPlotItem('pseudo', fl[0], fl[1], at(1), g * 2, W, H));
    if (fl.length >= 1) items.push(newPlotItem('histogram', fl[0], fl[0], at(2), g * 2, W, H));
  }
  st.update((ws) => {
    const sh = ws.worksheets.find((w) => w.id === sheet.id)!;
    sh.items.push(...items);
  }, loadKey ?? 'starter');
}

export function nextGateColor(ws: Workspace): string {
  return GATE_COLORS[ws.populations.length % GATE_COLORS.length];
}

export function uniquePopName(ws: Workspace, base: string, parentId: string | null): string {
  const sib = new Set(ws.populations.filter((p) => p.parentId === parentId).map((p) => p.name));
  if (!sib.has(base)) return base;
  let k = 2;
  while (sib.has(`${base} ${k}`)) k++;
  return `${base} ${k}`;
}

export function addPopulation(name: string, parentId: string | null, gate: GateGeom, color?: string): Population {
  const st = useStore.getState();
  const pop: Population = { id: uid('pop'), name: uniquePopName(st.ws, name, parentId), parentId, gate, color: color ?? nextGateColor(st.ws) };
  st.update((ws) => {
    ws.populations.push(pop);
  });
  return pop;
}

/** Undo action for a toast: reverts the change if nothing was edited since, else points to Ctrl+Z. */
function undoAction(after: Workspace): ToastAction {
  return {
    label: 'Undo',
    run: () => {
      const s = useStore.getState();
      if (s.ws === after) s.undo();
      else s.toast('Other changes were made since. Use Undo (Ctrl+Z) to step back.', 'info');
    },
  };
}

/**
 * Delete a population with its subpopulations (quadrant / split siblings and Boolean gates that use it go too).
 * Plots, charts and tables that showed it fall back to the nearest surviving ancestor. Shows a toast with Undo.
 */
export function deletePopulation(id: string, opts: { quiet?: boolean } = {}) {
  const st = useStore.getState();
  const ws = st.ws;
  const pop = ws.populations.find((p) => p.id === id);
  if (!pop) return;
  const kill = new Set<string>();
  const add = (pid: string) => {
    kill.add(pid);
    popDescendants(ws, pid).forEach((d) => kill.add(d));
  };
  add(id);
  // quadrant / split groups are deleted together
  if (pop.gate.type === 'quadrant' || pop.gate.type === 'split') {
    const gid = pop.gate.groupId;
    for (const p of ws.populations) if ((p.gate.type === 'quadrant' || p.gate.type === 'split') && p.gate.groupId === gid) add(p.id);
  }
  // Boolean gates built from deleted populations are dependents
  const bools = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of ws.populations)
      if (!kill.has(p.id) && p.gate.type === 'bool' && p.gate.operands.some((o) => kill.has(o.replace(/^!/, '')))) {
        bools.add(p.id);
        add(p.id);
        grew = true;
      }
  }
  const survivor = (pid: string): string => {
    let cur: string | null = pid;
    const seen = new Set<string>();
    while (cur && cur !== 'root' && kill.has(cur) && !seen.has(cur)) {
      const c: string = cur;
      seen.add(c);
      cur = ws.populations.find((p) => p.id === c)?.parentId ?? null;
    }
    return cur && !kill.has(cur) ? cur : 'root';
  };
  const names = new Set(ws.populations.filter((p) => kill.has(p.id)).map((p) => p.name));
  st.update((w) => {
    w.populations = w.populations.filter((p) => !kill.has(p.id));
    for (const sh of w.worksheets)
      for (const it of sh.items) {
        if (it.kind === 'plot') {
          if (it.options.labelPos) for (const k of Object.keys(it.options.labelPos)) if (kill.has(k)) delete it.options.labelPos[k];
          if (!it.layers.some((l) => kill.has(l.population)) && it.layers.length) continue;
          const out: Layer[] = [];
          for (const l of it.layers) {
            const nl = kill.has(l.population) ? { ...l, population: survivor(l.population) } : l;
            // an overlay layer that now duplicates another one is dropped
            if (nl === l || !out.some((o) => o.sample === nl.sample && o.population === nl.population)) out.push(nl);
          }
          // a custom title described the population that is gone: back to the automatic title
          if (kill.has(it.layers[0]?.population ?? '') || (it.options.title && names.has(it.options.title))) it.options.title = undefined;
          it.layers = out.length ? out : [{ id: uid('ly'), sample: 'active', population: 'root' }];
        }
        if (it.kind === 'stats') {
          it.rows = it.rows.filter((r) => !kill.has(r.population));
          for (const r of it.rows) if (r.ofPopulation && kill.has(r.ofPopulation)) r.ofPopulation = survivor(r.ofPopulation);
        }
        if (it.kind === 'chart') {
          if (kill.has(it.stat.population)) {
            it.stat.population = survivor(it.stat.population);
            it.title = undefined;
          }
          if (it.stat.ofPopulation && kill.has(it.stat.ofPopulation)) it.stat.ofPopulation = survivor(it.stat.ofPopulation);
        }
      }
    for (const t of w.tables) {
      t.columns = t.columns.filter((c) => !kill.has(c.population));
      for (const c of t.columns) if (c.ofPopulation && kill.has(c.ofPopulation)) c.ofPopulation = survivor(c.ofPopulation);
    }
    // the plate heatmap shows the nearest surviving ancestor
    const pv = w.plateView;
    if (pv) {
      if (kill.has(pv.stat.population)) pv.stat.population = survivor(pv.stat.population);
      if (pv.stat.ofPopulation && kill.has(pv.stat.ofPopulation)) pv.stat.ofPopulation = survivor(pv.stat.ofPopulation);
    }
  });
  if (st.ui.selectedPopId && kill.has(st.ui.selectedPopId)) st.setUI({ selectedPopId: null });
  if (opts.quiet) return;
  const subs = kill.size - 1 - bools.size;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const text = `Deleted '${pop.name}'${subs > 0 ? ` and ${plural(subs, 'subpopulation')}` : ''}${bools.size ? ` (incl. ${plural(bools.size, 'Boolean gate')} that used it)` : ''}`;
  st.toast(text, 'info', { action: undoAction(useStore.getState().ws) });
}

/** Remove samples from the workspace (event data stay in memory so the removal can be undone). */
export function removeSamples(ids: string[], opts: { quiet?: boolean } = {}) {
  const st = useStore.getState();
  const kill = new Set(ids.filter((id) => st.ws.samples.some((s) => s.id === id)));
  if (!kill.size) return;
  const order = st.ws.samples.map((s) => s.id);
  const removedNames = st.ws.samples.filter((s) => kill.has(s.id)).map((s) => s.name);
  st.update((ws) => {
    ws.samples = ws.samples.filter((s) => !kill.has(s.id));
    for (const sh of ws.worksheets)
      for (const it of sh.items) {
        if (it.kind === 'plot' && it.layers.some((l) => kill.has(l.sample))) {
          // overlay layers of removed samples go; a plot pinned to a removed sample follows the active sample
          const keep = it.layers.filter((l) => !kill.has(l.sample));
          it.layers = keep.length ? keep : [{ ...it.layers[0], sample: 'active' }];
        }
        if (it.kind === 'stats' && kill.has(it.sample)) it.sample = 'active';
      }
    for (const p of ws.populations) {
      if (p.overrides) for (const id of kill) delete p.overrides[id];
      if (p.scope?.samples?.some((id) => kill.has(id))) p.scope.samples = p.scope.samples.filter((id) => !kill.has(id));
    }
    for (const g of ws.groups) g.sampleIds = g.sampleIds.filter((x) => !kill.has(x));
  });
  const after = useStore.getState().ws;
  const left = after.samples;
  const patch: Partial<UIState> = { selectedSampleIds: st.ui.selectedSampleIds.filter((x) => !kill.has(x)) };
  if (st.ui.activeSampleId && kill.has(st.ui.activeSampleId)) {
    // the next remaining sample after the removed one, else the one before
    const i = order.indexOf(st.ui.activeSampleId);
    const loaded = (id: string) => !kill.has(id) && engine.has(id);
    patch.activeSampleId = order.slice(i + 1).find(loaded) ?? order.slice(0, i).reverse().find(loaded) ?? null;
  }
  st.setUI((u) => ({ ...patch, missingFiles: left.filter((x) => !engine.has(x.id)).map((x) => x.fileName), dataVersion: u.dataVersion + 1 }));
  if (!opts.quiet) st.toast(kill.size === 1 ? `Removed '${removedNames[0]}'` : `Removed ${kill.size} samples`, 'info', { action: undoAction(after) });
}

// --------------------------------------------------------------- plates and wells

/** What placeSamples did (for the load message). */
export interface PlaceSummary {
  /** samples placed in a well */
  wells: number;
  /** plates of those samples */
  plates: string[];
  fromKeywords: boolean;
  notes: string[];
}

/** Set by the UI: switches the sample list to its plate view (the "Show plate" button of the load message). */
let showPlateHook: (() => void) | null = null;
export function setShowPlateHook(f: (() => void) | null) {
  showPlateHook = f;
}

/**
 * Find the plate and well of samples (core/plate.ts assignPlates) and store them (SampleRef.well / plate /
 * wellSource, Workspace.plates) for samples never placed (new samples, and those of workspaces saved before plates
 * existed); `ids`: the samples the summary counts. `all`: re-detect every sample not set by hand. `folders`: folder of a
 * sample's file (opened as a folder), kept in its info ("Folder"). One undo step (`key`). Returns what was found.
 */
export function placeSamples(ids: string[], opts: { key?: string; folders?: Map<string, string>; all?: boolean } = {}): PlaceSummary | null {
  const st = useStore.getState();
  const ws = st.ws;
  const want = new Set(ids);
  // new samples have no wellSource yet (relinked ones keep theirs)
  const target = (s: SampleRef) => s.wellSource !== 'manual' && (opts.all || s.wellSource === undefined);
  const targets = ws.samples.filter(target);
  if (!targets.length) return null;
  const fixed = ws.samples.filter((s) => !target(s));
  const folder = (s: SampleRef) => opts.folders?.get(s.id) ?? s.info?.['Folder'];
  const inputs = targets.map((s) => ({ ...plateInputOf(s, engine.keywordsOf), folder: folder(s) }));
  // re-detection: the plates keep their names, formats and layouts (matched by key); plates of none are dropped later
  const r = assignPlates(inputs, {
    plates: ws.plates ?? [],
    placed: fixed.filter((s) => s.well && s.plate).map((s) => ({ plate: s.plate!, well: s.well! })),
    contextNames: fixed.filter((s) => s.wellSource === 'name').map((s) => s.name),
  });
  const placedHere = [...r.placements.entries()].filter(([id, p]) => p.well && (want.has(id) || opts.all));
  st.update((w) => {
    for (const s of w.samples) {
      const p: Placement | undefined = r.placements.get(s.id);
      if (!p) continue;
      const dir = opts.folders?.get(s.id);
      if (dir) s.info = { ...(s.info ?? {}), Folder: dir };
      if (p.well && p.plate) {
        s.well = p.well;
        s.plate = p.plate;
      } else {
        delete s.well;
        delete s.plate;
      }
      s.wellSource = p.source;
    }
    // plates of samples or with a layout (annotations); none at all: no field
    const used = new Set(w.samples.map((s) => s.plate).filter(Boolean));
    const plates = r.plates.filter((p) => used.has(p.name) || Object.keys(p.annotations ?? {}).length > 0);
    if (plates.length || w.plates) w.plates = plates;
  }, opts.key ?? 'place:' + uid('p'));
  const names = [...new Set(placedHere.map(([, p]) => p.plate!))];
  return { wells: placedHere.length, plates: names, fromKeywords: placedHere.some(([, p]) => p.source === 'keyword'), notes: r.notes };
}

/**
 * Message of an error for a toast: our own errors are written for the user; a raw TypeError / RangeError from damaged
 * input ("Cannot read properties of undefined", "Maximum call stack size exceeded") is wrapped in a sentence that says
 * what it means.
 */
export function readableError(e: unknown): string {
  const err = e as Error | undefined;
  const msg = (err && typeof err.message === 'string' ? err.message : String(e ?? '')).trim() || 'unknown error';
  const raw = (err && typeof err.name === 'string' && err.name !== 'Error') || /Cannot (read|set) prop|is not a function|is not iterable|is not defined|\[object |Maximum call stack|Invalid (typed )?array length/.test(msg);
  return raw ? `the file could not be read: it is damaged or in a form this program does not support (${msg.slice(0, 160)})` : msg;
}

/** FCS reader warnings worth showing (Beckman LMD files always hold two copies of the same data: not a problem). */
export function userWarnings(ds: { warnings: string[] }): string[] {
  return ds.warnings.filter((w) => {
    const m = /^File contains \d+ data sets \((.*)\); only data set/.exec(w);
    if (!m) return true;
    return new Set([...m[1].matchAll(/(\d+) events/g)].map((x) => x[1])).size > 1;
  });
}

export function activeSheet() {
  const { ws, ui } = useStore.getState();
  return ws.worksheets.find((w) => w.id === ui.activeSheetId) ?? ws.worksheets[0];
}

export function addSheet(name?: string) {
  const st = useStore.getState();
  const sh = newWorksheet(name ?? `Sheet ${st.ws.worksheets.length + 1}`);
  st.update((ws) => {
    ws.worksheets.push(sh);
  });
  st.setUI({ activeSheetId: sh.id, selectedItemIds: [], keyItemId: null, view: 'sheet' });
}

export { emptyWorkspace };
