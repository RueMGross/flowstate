import { APP_STAGE } from '../legal/meta';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { engine } from '../core/engine';
import { newBlankWorkspace, openFilesInteractive } from '../io/files';
import { restoreInterrupted, restoreSession, setAppAliveCheck, startAutosave } from '../io/session';
import { DEMO_NAME, loadDemo } from '../state/demo';
import { consumeNewPending, freshView, showWelcome, startNewFromWelcome, useWelcome, Welcome, welcomeAtStart } from './Welcome';
import { addSheet, setLargeLoadPrompt, setShowPlateHook, useStore, type LargeLoadChoice, type Tool } from '../state/store';
import { CompView } from './CompView';
import { UnmixView } from './UnmixView';
import { openUnmixView } from './unmix/draft';
import { CalibrationView } from './CalibrationView';
import { Dialogs, type RestoreProblemPayload } from './Dialogs';
import { AiLayer, AiPrivacyNote, AiTitleButton } from './ai/AiPanel';
import { AboutDialog, AboutIcon } from './About';
import { Icon } from './icons';
import { onCursorInfo } from './cursorBus';
import { Inspector } from './Inspector';
import { ErrorBoundary } from './ErrorBoundary';
import { confirmDeleteSheet, copyItems, deleteSelection, duplicateItems, duplicateSheet, moveSheet, pasteItems, readClip, reorder } from './layoutOps';
import { PopulationPanel, SamplePanel } from './Panels';
import { Ribbon, ribbonTabForView } from './Ribbon';
import { autoName, needsName, requestSave } from './saveOps';
import { fitLargeScreen, fitZoom, setZoom, SheetView, zoomBack, zoomStep, zoomToSelection } from './SheetView';
import { closeGatingView, GatingView, openGatingView } from './GatingView';
import { TablesView } from './TablesView';
import { PlateDocView } from './PlateView';
import { PluginsView } from './PluginsView';
import { usePlugins } from '../plugins/registry';
import { layoutOf } from '../render/plateChart';
import { droppedFolderEntries, folderInputFiles, readDroppedEntries } from '../io/folders';
import { ContextMenu, Modal } from './widgets';
import { installLongPress, isPanelShown, PaneSplit, panelWidths, ShellIcon, shellMode, showPanel, SplitHandle, togglePanel, toggleRibbon, useLayout, useShellMode, useViewportWidth, watchPixelRatio, type ShellMode, type Side } from './shell';

const TOOL_KEYS: Record<string, Tool> = { v: 'select', p: 'polygon', r: 'rect', e: 'ellipse', q: 'quadrant', h: 'range', s: 'split', t: 'text', z: 'zoom', w: 'autogate' };
const SHEET_DND = 'application/x-flowstate-sheet';

/** The theme in use: the saved choice (applied in main.tsx before the first render), else the system setting. */
function currentTheme(): 'light' | 'dark' {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Inputs that take no typed text (check boxes, radio buttons, color wells): letters on them are shortcuts. */
const NON_TEXT_INPUT = /^(checkbox|radio|color|button|submit|reset|file|image)$/i;

/** Keys typed into fields, dialogs and menus are not worksheet shortcuts. */
function isTyping(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLInputElement && NON_TEXT_INPUT.test(t.type)) return !!t.closest('.modal, .ctx-menu');
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest('.modal, .ctx-menu');
}

/**
 * After a choice made with the mouse in a drop-down list or a check box (Inspector, ribbon, panels), the focus returns to
 * the worksheet, so tool shortcuts (V, P, W ...) work right away; with the keyboard the field keeps the focus. Dialogs
 * and menus keep theirs.
 */
function installBlurAfterChoice(): () => void {
  let pointer = 0;
  let key = 0;
  const down = () => (pointer = performance.now());
  const kd = (e: KeyboardEvent) => {
    if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') key = performance.now();
  };
  const change = (e: Event) => {
    const t = e.target;
    const choice = t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && /^(checkbox|radio)$/i.test(t.type));
    if (!choice || (t as HTMLElement).closest('.modal, .ctx-menu, .gv-head')) return;
    if (key > pointer) return; // keyboard use: stay on the field
    requestAnimationFrame(() => {
      if (document.activeElement === t) (t as HTMLElement).blur();
    });
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('keydown', kd, true);
  document.addEventListener('change', change, true);
  return () => {
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('keydown', kd, true);
    document.removeEventListener('change', change, true);
  };
}

/** The app is mounted (not torn down by an error): the restored session is shown (see io/session.ts). */
let appMounted = false;

const activeSheetId = () => {
  const { ws, ui } = useStore.getState();
  return (ws.worksheets.find((w) => w.id === ui.activeSheetId) ?? ws.worksheets[0]).id;
};

export function App() {
  const ws = useStore((s) => s.ws);
  const ui = useStore((s) => s.ui);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const st = useStore.getState();
  const fcsInput = useRef<HTMLInputElement>(null);
  const anyInput = useRef<HTMLInputElement>(null);
  const gmlInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const clip = useRef<{ copy?: number; paste?: number }>({});
  const [dragging, setDragging] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);
  const [about, setAbout] = useState(false);
  const mode = useShellMode();
  const vw = useViewportWidth();
  const lay = useLayout();

  useEffect(() => {
    let alive = true;
    appMounted = true;
    setAppAliveCheck(() => appMounted);
    // the start screen (continue, earlier analyses, new, example); it opens the stored session only when asked, and
    // warns there when the last start broke down while opening it
    if (welcomeAtStart()) {
      showWelcome(true);
      return () => {
        alive = false;
        appMounted = false;
      };
    }
    // the last start broke down while restoring the session: do not restore it again automatically, ask
    if (restoreInterrupted()) {
      useStore.getState().setUI({ dialog: { kind: 'restoreProblem', payload: { reason: 'crashed' } satisfies RestoreProblemPayload } });
      return () => {
        alive = false;
        appMounted = false;
      };
    }
    void restoreSession().then((r) => {
      if (!alive) return;
      if (r.status === 'failed') {
        // the saved session stays stored until the user decides (download it, try again, start empty)
        useStore.getState().setUI({ dialog: { kind: 'restoreProblem', payload: { reason: 'failed', message: r.message } satisfies RestoreProblemPayload } });
        return;
      }
      if (r.status === 'none' && !useStore.getState().ws.samples.length) loadDemo();
      startAutosave();
      // big screens: the page fills the worksheet area instead of sitting small in its middle
      requestAnimationFrame(() => alive && shellMode() !== 'phone' && fitLargeScreen());
    });
    return () => {
      alive = false;
      appMounted = false;
    };
  }, []);

  // follow the system theme while the user has not picked one
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => !document.documentElement.dataset.theme && setTheme(currentTheme());
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  // the ribbon tab follows the view (Statistics, Compensation, Calibration are one thing in both tab rows)
  useEffect(() => {
    const s = useStore.getState();
    const tab = ribbonTabForView(ui.view, s.ui.ribbonTab);
    if (tab !== s.ui.ribbonTab) s.setUI({ ribbonTab: tab });
  }, [ui.view]);

  // first run: a small note next to the help button points to the shortcut overview (once; gone after 20 s, on the
  // first press elsewhere or Escape). It waits until the work area shows: not over the start screen or a dialog.
  const [helpHint, setHelpHint] = useState(false);
  useEffect(() => {
    const key = 'fs.hint.shortcuts';
    let decided = false;
    let timer = 0;
    // a press anywhere but on the note's "Getting started" link closes it (the note itself lets presses through)
    const down = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('.help-hint-link')) return;
      off();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && off();
    const off = () => {
      setHelpHint(false);
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', esc, true);
    };
    const unsubs: (() => void)[] = [];
    const tryShow = () => {
      // (read from the stores: the start screen opens in an effect of this same first commit)
      if (decided || useWelcome.getState().open || useStore.getState().ui.dialog || document.querySelector('.modal-back')) return;
      decided = true;
      for (const u of unsubs.splice(0)) u();
      // keyboard shortcuts are no news on touch screens and phones
      if (!window.matchMedia?.('(pointer: fine)').matches || shellMode() === 'phone') return;
      try {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, '1');
      } catch {
        return; // no storage: the note could not be shown only once
      }
      setHelpHint(true);
      timer = window.setTimeout(off, 20000);
      window.addEventListener('pointerdown', down, true);
      window.addEventListener('keydown', esc, true);
    };
    unsubs.push(useWelcome.subscribe(tryShow), useStore.subscribe((s, prev) => s.ui.dialog !== prev.ui.dialog && tryShow()));
    const raf = requestAnimationFrame(tryShow);
    return () => {
      cancelAnimationFrame(raf);
      for (const u of unsubs.splice(0)) u();
      off();
    };
  }, []);

  // floating panels (AI assistant) start below the ribbon, whatever its height
  useLayoutEffect(() => {
    const wa = document.querySelector('.workarea');
    const rb = document.querySelector('.ribbon');
    if (!wa || typeof ResizeObserver === 'undefined') return;
    const set = () => document.documentElement.style.setProperty('--shell-top', `${Math.round(wa.getBoundingClientRect().top)}px`);
    set();
    const ro = new ResizeObserver(set);
    if (rb) ro.observe(rb);
    ro.observe(wa);
    return () => ro.disconnect();
  }, [mode]);

  // the layout mode is also on <html> (dialogs and menus are portals outside the app element)
  useEffect(() => {
    document.documentElement.dataset.shell = mode;
  }, [mode]);

  // "Show plate" of the load message: the sample panel shows the plate
  useEffect(() => {
    setShowPlateHook(() => {
      useLayout.getState().set({ sampleView: 'plate' });
      showPanel('left');
    });
    // more event data than the tab can keep: ask before loading (see largeLoadPlan)
    setLargeLoadPrompt(
      (plan) =>
        new Promise<LargeLoadChoice>((resolve) => {
          const st = useStore.getState();
          // a question still open (a second drop meanwhile) is answered "cancel"; the dialog answers "cancel" too
          // when anything else closes it (see LargeLoadDialog)
          const prev = st.ui.dialog?.kind === 'largeLoad' ? (st.ui.dialog.payload as { resolve?: (c: LargeLoadChoice) => void }).resolve : undefined;
          prev?.('cancel');
          st.setUI({ dialog: { kind: 'largeLoad', payload: { plan, resolve } } });
        }),
    );
    return () => {
      setShowPlateHook(null);
      setLargeLoadPrompt(null);
    };
  }, []);

  // the folder picker (webkitdirectory is not a React attribute)
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
    folderInput.current?.setAttribute('directory', '');
  }, []);

  // touch screens: a long press opens the context menus; plots are redrawn sharp when the pixel ratio changes
  useEffect(() => installLongPress(), []);
  useEffect(() => installBlurAfterChoice(), []);
  useEffect(() => watchPixelRatio(), []);

  // a drawer (compact window) closes on a press outside it, and when the window gets wide enough to dock the panels
  useEffect(() => {
    if (mode !== 'compact') {
      if (useLayout.getState().drawer) useLayout.getState().set({ drawer: null });
      return;
    }
    const down = (e: PointerEvent) => {
      const d = useLayout.getState().drawer;
      if (!d || !(e.target instanceof Element)) return;
      if (e.target.closest(`#side-${d}, .panel-toggle, .ctx-menu, .modal-back, .toasts`)) return;
      useLayout.getState().set({ drawer: null });
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [mode]);

  // a plot added from the samples / populations drawer (menu, button, double-click) shows up: the drawer closes
  const sheetItems = ws.worksheets.find((w) => w.id === ui.activeSheetId)?.items.length ?? 0;
  const lastItems = useRef(sheetItems);
  useEffect(() => {
    if (sheetItems > lastItems.current && useLayout.getState().drawer === 'left') useLayout.getState().set({ drawer: null });
    lastItems.current = sheetItems;
  }, [sheetItems]);

  // every press or focus change starts a new undo step (a paused drag stays one step)
  useEffect(() => {
    const brk = () => useStore.getState().breakGroup();
    window.addEventListener('pointerdown', brk, true);
    window.addEventListener('focusin', brk, true);
    return () => {
      window.removeEventListener('pointerdown', brk, true);
      window.removeEventListener('focusin', brk, true);
    };
  }, []);

  // global file drag & drop
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      // dropped on the start screen: a new analysis with these files (what was open is kept as an earlier analysis)
      const fromStart = useWelcome.getState().open;
      if (fromStart) startNewFromWelcome();
      // folders (e.g. a CytExpert experiment folder, a subfolder per plate): their FCS files, with the folder paths
      const entries = droppedFolderEntries(e.dataTransfer);
      if (entries) {
        void readDroppedEntries(entries)
          .then(({ files, skipped }) => openFolderFiles(files, skipped))
          .then(() => fromStart && freshView());
        return;
      }
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void openFilesMaybeReplacingDemo(files).then(() => fromStart && freshView());
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // the start screen covers the work: its keys are its own (Tab, Enter, Esc)
      if (useWelcome.getState().open && !useStore.getState().ui.dialog) return;
      const s = useStore.getState();
      if (s.ui.dialog) {
        if (e.key === 'Escape') s.setUI({ dialog: null });
        return;
      }
      // an open menu owns the keyboard (it handles Escape and arrows itself)
      if (isTyping(e.target) || document.querySelector('.ctx-menu')) return;
      const lay = useLayout.getState();
      if (e.key === 'Escape' && lay.drawer) {
        e.preventDefault();
        const side = lay.drawer;
        lay.set({ drawer: null });
        (document.querySelector(`.panel-toggle.${side}`) as HTMLElement | null)?.focus();
        return;
      }
      if (shellMode() === 'phone') return; // the viewer has no editing shortcuts
      // panels: Ctrl+B samples & populations, Ctrl+Alt+B inspector; Ctrl+F1 minimizes the ribbon
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key.toLowerCase() === 'b' || e.code === 'KeyB')) {
        e.preventDefault();
        togglePanel(e.altKey ? 'right' : 'left');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'F1') {
        e.preventDefault();
        toggleRibbon();
        return;
      }
      if (e.key === 'F1' || (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        s.setUI({ dialog: { kind: 'shortcuts' } });
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const onSheet = s.ui.view === 'sheet';
      const sheetId = activeSheetId();
      const sel = s.ui.selectedItemIds;
      const done = () => e.preventDefault();
      if (mod && k === 'z') {
        done();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && k === 'y') {
        done();
        s.redo();
        return;
      }
      if (mod && k === 's') {
        done();
        requestSave('json');
        return;
      }
      if (mod && k === 'o') {
        done();
        anyInput.current?.click();
        return;
      }
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        done();
        stepSample(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Escape') {
        // the gating view closes first (the tool and the selection stay)
        if (s.ui.gatingItemId && onSheet) {
          done();
          closeGatingView();
          return;
        }
        s.setUI({ tool: 'select', selectedPopId: null, selectedItemIds: [], keyItemId: null });
        return;
      }
      if (!onSheet) return;
      // ---- worksheet shortcuts
      const gating = !!s.ui.gatingItemId;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // in the gating view only gates are deleted (not the plot)
        if (gating ? s.ui.selectedPopId : sel.length || s.ui.selectedPopId) {
          done();
          deleteSelection(gating ? 'population' : 'auto');
        }
        return;
      }
      if (gating) {
        // the gating view takes tool keys (and Alt+arrows, above); item editing waits for the worksheet
        if (!mod && !e.altKey && TOOL_KEYS[k]) s.setUI({ tool: TOOL_KEYS[k] });
        return;
      }
      // zoom to the selection (F, Shift+2), back (Shift+1); Enter opens the selected plot in the gating view
      if (!mod && !e.altKey && (k === 'f' || (e.shiftKey && e.code === 'Digit2'))) {
        done();
        zoomToSelection();
        return;
      }
      if (!mod && !e.altKey && e.shiftKey && e.code === 'Digit1') {
        done();
        zoomBack();
        return;
      }
      if (!mod && !e.altKey && e.key === 'Enter') {
        const t = e.target as HTMLElement | null;
        const sheetItems = s.ws.worksheets.find((w) => w.id === sheetId)?.items ?? [];
        const plots = sheetItems.filter((i) => sel.includes(i.id) && i.kind === 'plot');
        if (plots.length === 1 && (!t || t === document.body || !!t.closest?.('.sheet-scroll'))) {
          done();
          openGatingView(plots[0].id);
        }
        return;
      }
      if (mod && k === 'd') {
        done();
        if (sel.length) duplicateItems(sheetId, sel);
        return;
      }
      if (mod && k === 'a') {
        done();
        s.setUI({ selectedItemIds: s.ws.worksheets.find((w) => w.id === sheetId)!.items.map((i) => i.id), selectedPopId: null });
        return;
      }
      // copy / cut / paste run through the clipboard events below; these timers are the fallback if none arrives
      if (mod && (k === 'c' || k === 'x') && sel.length) {
        clip.current.copy = window.setTimeout(() => {
          copyItems(sheetId, sel);
          if (k === 'x') deleteSelection();
        }, 80);
        return;
      }
      if (mod && k === 'v') {
        clip.current.paste = window.setTimeout(() => {
          const rt = navigator.clipboard?.readText?.();
          if (!rt) pasteItems(sheetId);
          else
            rt.then(readClip, () => ({ ours: false, items: null })).then((r) => {
              // our clipboard format with nothing usable: reported, the in-app clipboard is not pasted instead
              if (!r.ours || r.items) pasteItems(sheetId, r.items);
            });
        }, 80);
        return;
      }
      if (mod && (e.code === 'BracketRight' || e.code === 'BracketLeft' || e.key === ']' || e.key === '[' || e.key === '}' || e.key === '{')) {
        if (!sel.length) return;
        done();
        const fwd = e.code === 'BracketRight' || e.key === ']' || e.key === '}';
        reorder(sheetId, sel, e.shiftKey ? (fwd ? 'front' : 'back') : fwd ? 'forward' : 'backward');
        return;
      }
      // arrow-key nudging of items is handled in SheetView (capture listener)
      if (!mod && !e.altKey && TOOL_KEYS[k]) {
        s.setUI({ tool: TOOL_KEYS[k] });
        return;
      }
      // keyboard zoom keeps the selection (else the middle of the view) in place
      if (!mod && (e.key === '+' || e.key === '=')) zoomStep(1.2);
      if (!mod && e.key === '-') zoomStep(1 / 1.2);
    };
    // system clipboard: works across browser tabs; falls back to the in-app clipboard
    const onCopy = (e: ClipboardEvent) => {
      if (useWelcome.getState().open) return;
      const s = useStore.getState();
      if (s.ui.dialog || s.ui.view !== 'sheet' || !s.ui.selectedItemIds.length || isTyping(document.activeElement) || window.getSelection()?.toString()) return;
      window.clearTimeout(clip.current.copy);
      e.preventDefault();
      copyItems(activeSheetId(), s.ui.selectedItemIds, e.clipboardData);
      if (e.type === 'cut') deleteSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (useWelcome.getState().open) return;
      const s = useStore.getState();
      if (s.ui.dialog || s.ui.view !== 'sheet' || isTyping(document.activeElement)) return;
      window.clearTimeout(clip.current.paste);
      const text = e.clipboardData?.getData('text/plain');
      const r = readClip(text);
      if (r.ours || !text) {
        e.preventDefault();
        // our format but nothing usable: already reported (the in-app clipboard is not pasted instead)
        if (!r.ours || r.items) pasteItems(activeSheetId(), r.items);
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  const isDemo = ws.name === DEMO_NAME;
  /** FCS files read from a folder (picker or drop): opened like dropped files; the other files of the folder are noted. */
  const openFolderFiles = async (files: File[], skipped: number) => {
    const s = useStore.getState();
    if (!files.length) {
      s.toast(`No FCS or LMD files in the folder${skipped ? ` (${skipped} other file${skipped > 1 ? 's' : ''})` : ''}.`, 'info');
      return;
    }
    if (skipped) s.toast(`Opening ${files.length} FCS / LMD file${files.length > 1 ? 's' : ''} of the folder; ${skipped} other file${skipped > 1 ? 's were' : ' was'} skipped.`, 'info');
    await openFilesMaybeReplacingDemo(files);
  };
  const openFilesMaybeReplacingDemo = async (files: File[]) => {
    const s = useStore.getState();
    const onlyFcs = files.every((f) => /\.(fcs|lmd)$/i.test(f.name));
    if (s.ws.name === DEMO_NAME && onlyFcs) {
      // replace the example with the user's data, keep nothing from the demo
      newBlankWorkspace();
    }
    // a workspace / bundle / FlowJo file replacing unsaved work asks first
    await openFilesInteractive(files);
    // a new analysis is named after its data (experiment, folder or sample names, and the date)
    const after = useStore.getState();
    // (with the undo key of the load, so one Undo takes back both)
    if (onlyFcs && needsName(after.ws) && after.ws.samples.length)
      after.update((w) => {
        w.name = autoName(after.ws, (id) => engine.keywordsOf(id));
      }, after.lastKey?.startsWith('load:') ? after.lastKey : 'wsname');
  };

  const active = ws.samples.find((s) => s.id === ui.activeSampleId);
  const activeComp = active?.compId ? ws.compensations.find((c) => c.id === active.compId) : null;
  const widths = panelWidths(vw, lay, mode);
  const leftShown = isPanelShown('left', mode, lay);
  const rightShown = isPanelShown('right', mode, lay);
  const themeButton = (
    <button
      className="tb-btn"
      title={theme === 'dark' ? 'Switch to the light interface' : 'Switch to the dark interface'}
      aria-label={theme === 'dark' ? 'Light interface' : 'Dark interface'}
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        setTheme(next);
        try {
          localStorage.setItem('fc-theme', next);
        } catch {
          /* ignore */
        }
      }}
    >
      {theme === 'dark' ? <Icon.sun /> : <Icon.moon />}
    </button>
  );
  const aboutButton = (
    <button className="tb-btn" title="About FlowState: version, intended use, privacy, licenses" aria-label="About FlowState" onClick={() => setAbout(true)}>
      <AboutIcon />
    </button>
  );
  const overlays = (
    <>
      <Welcome
        actions={{
          openFcs: () => fcsInput.current?.click(),
          openFolder: () => folderInput.current?.click(),
          openWorkspace: () => anyInput.current?.click(),
          help: () => st.setUI({ dialog: { kind: 'guide' } }),
          about: () => setAbout(true),
        }}
      />
      <input
        ref={fcsInput}
        type="file"
        multiple
        accept=".fcs,.lmd,.FCS,.LMD,.csv,.tsv,.txt"
        aria-label="Open FCS files"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          // chosen from the start screen: a new analysis begins now (what was open is kept as an earlier one), in a
          // fresh view once the files are in
          const fromStart = files.length > 0 && consumeNewPending();
          if (fromStart) startNewFromWelcome();
          if (files.length) void openFilesMaybeReplacingDemo(files).then(() => fromStart && freshView());
        }}
      />
      <input
        ref={anyInput}
        type="file"
        multiple
        accept=".json,.zip,.xml,.wsp,.flowjo,.fcs,.lmd,.csv,.tsv,.txt,.mtx,.comp"
        aria-label="Open files"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          // chosen from the start screen: a new analysis begins now (what was open is kept as an earlier one)
          const fromStart = files.length > 0 && consumeNewPending();
          if (fromStart) startNewFromWelcome();
          if (files.length) void openFilesMaybeReplacingDemo(files).then(() => fromStart && freshView());
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        aria-label="Open a folder of FCS files"
        style={{ display: 'none' }}
        onChange={(e) => {
          const { files, skipped } = folderInputFiles(e.target.files ?? []);
          e.target.value = '';
          const fromStart = files.length > 0 && consumeNewPending();
          if (fromStart) startNewFromWelcome();
          void openFolderFiles(files, skipped).then(() => fromStart && freshView());
        }}
      />
      <input
        ref={gmlInput}
        type="file"
        accept=".xml"
        aria-label="Import Gating-ML"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void openFilesInteractive(files);
        }}
      />
      <ErrorBoundary
        label="dialog"
        resetKey={ui.dialog}
        fallback={(err) => (
          <Modal title="The dialog could not be displayed" onClose={() => st.setUI({ dialog: null })}>
            <p style={{ marginTop: 0 }}>{String(err?.message ?? err).slice(0, 300)}</p>
            <p>Your workspace is still intact. Close this message and try again, or undo the last step (Ctrl+Z).</p>
          </Modal>
        )}
      >
        <Dialogs />
      </ErrorBoundary>
      <div className="toasts" aria-live="polite">
        {/* the newest three (older ones wait for their time, they do not pile up over the work) */}
        {ui.toasts.slice(-3).map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-text">{t.text}</span>
            {t.action && (
              <button
                className="toast-act"
                onClick={() => {
                  st.dismissToast(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast-x" aria-label="Dismiss" title="Dismiss" onClick={() => st.dismissToast(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
      {about && <AboutDialog onClose={() => setAbout(false)} />}
      {dragging && <div className="dropzone-full">Drop FCS files or folders, a workspace, a FlowJo workspace or Gating-ML to open</div>}
    </>
  );

  if (mode === 'phone')
    return (
      <div className="app phone">
        <PhoneShell themeButton={themeButton} aboutButton={aboutButton} openAny={() => anyInput.current?.click()} />
        {overlays}
      </div>
    );

  return (
    <div className={`app ${mode}`}>
      <header className="titlebar">
        <button className="brand" title="Start screen: earlier analyses, new analysis, example" aria-label="FlowState start screen" onClick={() => showWelcome(false)}>
          <span className="brand-mark">
            <Icon.logo />
          </span>
          <span className="brand-name">
            <b>Flow</b>State
          </span>
          <span className="beta-tag" title="Beta software, work in progress: check important results">
            {APP_STAGE}
          </span>
        </button>
        <input
          className="ws-name"
          value={ws.name}
          aria-label="Workspace name"
          title="Workspace name (click to rename)"
          onChange={(e) => st.update((w) => {
            w.name = e.target.value;
          }, 'wsname')}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }}
        />
        <SetupChip />
        <span className="spacer" />
        <AiTitleButton />
        <button className="tb-btn" onClick={st.undo} disabled={!past} title="Undo (Ctrl+Z)" aria-label="Undo">
          <Icon.undo />
        </button>
        <button className="tb-btn" onClick={st.redo} disabled={!future} title="Redo (Ctrl+Y)" aria-label="Redo">
          <Icon.redo />
        </button>
        <span className="help-wrap">
          <button className="tb-btn" title="Help: getting started and keyboard shortcuts (? or F1: shortcuts)" aria-label="Help: getting started" onClick={() => st.setUI({ dialog: { kind: 'guide' } })}>
            <Icon.help />
          </button>
          {helpHint && !ui.dialog && !about && (
            <span className="help-hint" role="status">
              New here?{' '}
              <button
                className="help-hint-link"
                onClick={() => {
                  setHelpHint(false);
                  st.setUI({ dialog: { kind: 'guide' } });
                }}
              >
                Getting started
              </button>{' '}
              · press <kbd>?</kbd> for all shortcuts
            </span>
          )}
        </span>
        {aboutButton}
        {themeButton}
      </header>
      <ErrorBoundary label="ribbon" compact resetKey={ws}>
        <Ribbon openFcs={() => fcsInput.current?.click()} openFolder={() => folderInput.current?.click()} openWorkspace={() => anyInput.current?.click()} importGatingML={() => gmlInput.current?.click()} />
      </ErrorBoundary>
      <div className="workarea">
        {isDemo && (
          <div className="banner" role="status">
            <span className="banner-text">
              <b>Example data.</b> These samples are synthetic and only show what the program does. Your own FCS files stay on this computer.
            </span>
            <span className="banner-acts">
              <button className="btn sm primary" onClick={() => fcsInput.current?.click()}>
                <Icon.fcs /> Open my FCS files
              </button>
              <button className="btn sm" onClick={() => newBlankWorkspace()}>
                Clear example
              </button>
            </span>
          </div>
        )}
        {ui.missingFiles.length > 0 && (
          <div className="banner" role="status">
            <span className="banner-text">
              <b>{ui.missingFiles.length === 1 ? '1 FCS file' : `${ui.missingFiles.length} FCS files`} not loaded:</b> {ui.missingFiles.slice(0, 4).join(', ')}
              {ui.missingFiles.length > 4 ? ` and ${ui.missingFiles.length - 4} more` : ''}. Drop {ui.missingFiles.length === 1 ? 'it' : 'them'} anywhere to relink.
            </span>
            <span className="banner-acts">
              <button className="btn sm" onClick={() => fcsInput.current?.click()}>
                Locate files
              </button>
            </span>
          </div>
        )}
        <main
          className={`main ${mode}`}
          style={
            {
              '--left-w': `${mode === 'wide' && lay.leftOpen ? widths.left : 0}px`,
              '--right-w': `${mode === 'wide' && lay.rightOpen ? widths.right : 0}px`,
            } as CSSProperties
          }
        >
          <aside
            id="side-left"
            className={`side left${leftShown ? ' shown' : ''}`}
            aria-label="Samples and populations"
            style={mode === 'compact' ? { width: widths.left } : undefined}
            onDragStart={() => mode === 'compact' && window.setTimeout(() => lay.set({ drawer: null }), 0)}
          >
            <ErrorBoundary label="sample list" compact resetKey={ws}>
              <SamplePanel onOpen={() => fcsInput.current?.click()} />
            </ErrorBoundary>
            <PaneSplit />
            <ErrorBoundary label="population tree" compact resetKey={ws}>
              <PopulationPanel />
            </ErrorBoundary>
            <SplitHandle side="left" width={widths.left} label="Samples and populations panel width" />
          </aside>
          <section className="center">
            <div className="center-bar">
              <PanelToggle side="left" shown={leftShown} mode={mode} />
              <ErrorBoundary label="worksheet tabs" compact resetKey={ws}>
                <DocTabs />
              </ErrorBoundary>
              <PanelToggle side="right" shown={rightShown} mode={mode} />
            </div>
            <ErrorBoundary label={`${ui.view} view`} resetKey={ws}>
              {ui.view === 'sheet' && <SheetView />}
              {ui.view === 'tables' && <TablesView />}
              {ui.view === 'comp' && <CompView />}
              {ui.view === 'unmix' && <UnmixView />}
              {ui.view === 'calib' && <CalibrationView />}
              {ui.view === 'plate' && <PlateDocView />}
              {ui.view === 'plugins' && <PluginsView />}
            </ErrorBoundary>
          </section>
          <aside id="side-right" className={`side right${rightShown ? ' shown' : ''}`} aria-label="Inspector" style={mode === 'compact' ? { width: widths.right } : undefined}>
            <SplitHandle side="right" width={widths.right} label="Inspector width" />
            <ErrorBoundary label="inspector" resetKey={ws}>
              <Inspector />
            </ErrorBoundary>
          </aside>
        </main>
      </div>
      <footer className="status">
        <span className="row step-btns" style={{ gap: 2, flexWrap: 'nowrap' }}>
          <button className="icon-btn" aria-label="Previous sample" title="Previous sample (Alt+↑)" onClick={() => stepSample(-1)}>
            <StepIcon dir={-1} />
          </button>
          <button className="icon-btn" aria-label="Next sample" title="Next sample (Alt+↓)" onClick={() => stepSample(1)}>
            <StepIcon dir={1} />
          </button>
        </span>
        <span className="status-sample">
          {active ? (
            <>
              <b>{active.name}</b> · {active.eventCount.toLocaleString('en-US')} events · {activeComp ? `compensated (${activeComp.name})` : 'uncompensated'}
            </>
          ) : (
            'No sample selected'
          )}
        </span>
        <span className="status-tool">Tool: {TOOL_NAMES[ui.tool] ?? ui.tool}</span>
        <CursorInfo />
        <span className="grow" />
        <AiPrivacyNote />
        <ZoomControls />
      </footer>
      <AiLayer />
      <ErrorBoundary label="gating view" compact resetKey={ws}>
        <GatingView />
      </ErrorBoundary>
      {overlays}
    </div>
  );
}

const TOOL_NAMES: Record<string, string> = {
  select: 'Select',
  polygon: 'Polygon',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  quadrant: 'Quadrant',
  range: 'Range',
  split: 'Split',
  text: 'Text',
  zoom: 'Zoom',
  autogate: 'Auto gate',
};

function StepIcon({ dir }: { dir: 1 | -1 }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={dir < 0 ? 'M15 6v12L6 12z' : 'M9 6v12l9-6z'} />
    </svg>
  );
}

/** Zoom buttons of the worksheet (status bar; the phone layout's footer). */
function ZoomControls({ compact }: { compact?: boolean }) {
  const zoom = useStore((s) => s.ui.zoom);
  const view = useStore((s) => s.ui.view);
  const hasSel = useStore((s) => s.ui.selectedItemIds.length > 0);
  const hasPlot = useStore((s) => {
    const sh = s.ws.worksheets.find((w) => w.id === s.ui.activeSheetId);
    return !!sh?.items.some((i) => i.kind === 'plot' && s.ui.selectedItemIds.includes(i.id));
  });
  const off = view !== 'sheet';
  return (
    <div className="zoom-ctl" role="group" aria-label="Worksheet zoom">
      {!compact && (
        <>
          <button className="btn xs" title="Open the selected plot large, with all gating tools (Enter; Esc closes)" disabled={off || !hasPlot} onClick={() => openGatingView()}>
            Gating view
          </button>
          <button className="btn xs" title="Zoom so the selected items fill the window (F or Shift+2; Shift+1 goes back)" disabled={off || !hasSel} onClick={() => zoomToSelection()}>
            Zoom to selection
          </button>
          <button className="btn xs" title="Zoom to fit the page (Shift+1: back to the zoom before Zoom to selection)" disabled={off} onClick={() => fitZoom('page')}>
            Fit page
          </button>
          <button className="btn xs" title="Zoom to fit the page width" disabled={off} onClick={() => fitZoom('width')}>
            Fit width
          </button>
        </>
      )}
      <button className="icon-btn" aria-label="Zoom out" title="Zoom out (-)" disabled={off} onClick={() => zoomStep(1 / 1.2)}>
        <Icon.zoomOut />
      </button>
      {!compact && <input type="range" min={0.25} max={4} step={0.05} value={zoom} disabled={off} aria-label="Zoom" title="Zoom (Ctrl + mouse wheel, pinch on touch screens)" onChange={(e) => setZoom(Number(e.target.value))} />}
      <button className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" disabled={off} onClick={() => zoomStep(1.2)}>
        <Icon.zoomIn />
      </button>
      <button className="btn xs num zoom-pct" title={compact ? 'Fit the page width' : 'Zoom to 100%'} disabled={off} onClick={() => (compact ? fitZoom('width') : setZoom(1))}>
        {Math.round(zoom * 100)}%
      </button>
    </div>
  );
}

/** Show / hide a side panel (docked) or open its drawer (compact window). */
function PanelToggle({ side, shown, mode }: { side: Side; shown: boolean; mode: ShellMode }) {
  const what = side === 'left' ? 'samples and populations' : 'inspector';
  const keys = side === 'left' ? 'Ctrl+B' : 'Ctrl+Alt+B';
  const docked = mode === 'wide';
  const label = docked ? `${shown ? 'Hide' : 'Show'} the ${what} panel` : `${shown ? 'Close' : 'Open'} ${what}`;
  return (
    <button
      className={`panel-toggle ${side}${shown ? ' on' : ''}`}
      aria-expanded={shown}
      aria-controls={side === 'left' ? 'side-left' : 'side-right'}
      aria-label={label}
      title={`${label} (${keys})`}
      onClick={() => togglePanel(side)}
    >
      {side === 'left' ? <ShellIcon.panelLeft /> : null}
      {!docked && <span>{side === 'left' ? 'Samples' : 'Inspector'}</span>}
      {side === 'right' ? <ShellIcon.panelRight /> : null}
    </button>
  );
}

/** Worksheet tabs and the tabs of the other views (Statistics, Compensation, …). */
function DocTabs({ sheetsOnly }: { sheetsOnly?: boolean }) {
  const ws = useStore((s) => s.ws);
  const ui = useStore((s) => s.ui);
  const pluginCount = usePlugins((s) => s.entries.length);
  const st = useStore.getState();
  const [editingSheet, setEditingSheet] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [tabDrop, setTabDrop] = useState<{ id: string; after: boolean } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const openSheet = (id: string) => st.setUI({ view: 'sheet', activeSheetId: id, selectedItemIds: [], keyItemId: null });
  // the active tab stays in view (many sheets in a narrow window)
  useEffect(() => {
    barRef.current?.querySelector('.doc-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [ui.activeSheetId, ui.view]);
  return (
    <div className="doc-tabs" role="tablist" aria-label="Worksheets and views" ref={barRef}>
      {ws.worksheets.map((s, i) => (
        <div
          key={s.id}
          role="tab"
          tabIndex={0}
          aria-selected={ui.view === 'sheet' && ui.activeSheetId === s.id}
          className={`doc-tab${ui.view === 'sheet' && ui.activeSheetId === s.id ? ' on' : ''}${tabDrop?.id === s.id ? (tabDrop.after ? ' drop-after' : ' drop-before') : ''}`}
          title={sheetsOnly ? s.name : `${s.name}: double-click to rename, right-click for more, drag to reorder`}
          draggable={!sheetsOnly && editingSheet !== s.id}
          onDragStart={(e) => {
            e.dataTransfer.setData(SHEET_DND, s.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            if (!Array.from(e.dataTransfer.types).includes(SHEET_DND)) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const after = e.clientX > r.left + r.width / 2;
            if (tabDrop?.id !== s.id || tabDrop.after !== after) setTabDrop({ id: s.id, after });
          }}
          onDragLeave={() => tabDrop?.id === s.id && setTabDrop(null)}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(SHEET_DND);
            setTabDrop(null);
            if (!id) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            if (id !== s.id) moveSheet(id, i + (e.clientX > r.left + r.width / 2 ? 1 : 0));
          }}
          onDragEnd={() => setTabDrop(null)}
          onClick={() => openSheet(s.id)}
          onDoubleClick={() => !sheetsOnly && setEditingSheet(s.id)}
          onContextMenu={(e) => {
            if (sheetsOnly) return;
            e.preventDefault();
            openSheet(s.id);
            setTabMenu({ x: e.clientX, y: e.clientY, id: s.id });
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openSheet(s.id);
            } else if (e.key === 'F2' && !sheetsOnly) setEditingSheet(s.id);
            else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && !sheetsOnly) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setTabMenu({ x: r.left, y: r.bottom, id: s.id });
            }
          }}
        >
          <Icon.sheet />
          {editingSheet === s.id ? (
            <input
              autoFocus
              defaultValue={s.name}
              aria-label="Sheet name"
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== s.name)
                  st.update((w) => {
                    w.worksheets.find((x) => x.id === s.id)!.name = v;
                  });
                setEditingSheet(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditingSheet(null);
              }}
            />
          ) : (
            <span className="doc-tab-name">{s.name}</span>
          )}
        </div>
      ))}
      {!sheetsOnly && (
        <>
          <button className="icon-btn doc-add" title="New worksheet" aria-label="New worksheet" onClick={() => addSheet()}>
            <Icon.plus />
          </button>
          <span className="doc-gap" aria-hidden="true" />
          {(
            [
              ['tables', <Icon.table key="t" />, 'Statistics', true],
              ['plate', <Icon.plate key="p" />, 'Plates', ui.view === 'plate' || layoutOf(ws, engine).plates.length > 0],
              ['comp', <Icon.matrix key="c" />, 'Compensation', true],
              ['unmix', <Icon.spectrum key="u" />, 'Unmixing', ui.view === 'unmix' || !!ws.derived?.some((d) => d.kind === 'unmix')],
              ['calib', <Icon.beads key="k" />, 'Calibration', ui.view === 'calib' || !!ws.derived?.some((d) => d.kind !== 'unmix')],
              ['plugins', <Icon.plug key="g" />, 'Plugins', ui.view === 'plugins' || pluginCount > 0 || Object.keys(ws.plugins ?? {}).length > 0],
            ] as const
          )
            .filter(([, , , show]) => show)
            .map(([v, ic, label]) => (
              <div
                key={v}
                className={`doc-tab view-tab${ui.view === v ? ' on' : ''}`}
                role="tab"
                tabIndex={0}
                title={label}
                aria-selected={ui.view === v}
                onClick={() => (v === 'unmix' ? openUnmixView() : st.setUI({ view: v }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (v === 'unmix') openUnmixView();
                    else st.setUI({ view: v });
                  }
                }}
              >
                {ic} <span className="doc-tab-name">{label}</span>
              </div>
            ))}
        </>
      )}
      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)}>
          <button onClick={() => setEditingSheet(tabMenu.id)}>Rename</button>
          <button onClick={() => duplicateSheet(tabMenu.id)}>Duplicate</button>
          <button onClick={() => addSheet()}>New worksheet</button>
          <hr />
          <button disabled={ws.worksheets.length < 2} style={{ color: 'var(--danger)' }} onClick={() => confirmDeleteSheet(tabMenu.id)}>
            Delete…
          </button>
        </ContextMenu>
      )}
    </div>
  );
}

const PHONE_NOTE_KEY = 'fs.phone.note';

/**
 * Small screens (phones): a viewer. Worksheets can be looked at, the sample switched and figures exported;
 * gating and layout editing need a larger screen.
 */
function PhoneShell({ themeButton, aboutButton, openAny }: { themeButton: ReactNode; aboutButton: ReactNode; openAny: () => void }) {
  const ws = useStore((s) => s.ws);
  const ui = useStore((s) => s.ui);
  const st = useStore.getState();
  const [note, setNote] = useState(() => {
    try {
      return !sessionStorage.getItem(PHONE_NOTE_KEY);
    } catch {
      return true;
    }
  });
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  // a phone shows worksheets only; the page fits the screen width when a sheet opens or the phone is turned
  useEffect(() => {
    if (ui.view !== 'sheet' || ui.tool !== 'select' || ui.selectedItemIds.length || ui.selectedPopId) st.setUI({ view: 'sheet', tool: 'select', selectedItemIds: [], selectedPopId: null });
  }, [ui.view, ui.tool, ui.selectedItemIds.length, ui.selectedPopId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const fit = () => requestAnimationFrame(() => fitZoom('width'));
    fit();
    window.addEventListener('orientationchange', fit);
    return () => window.removeEventListener('orientationchange', fit);
  }, [ui.activeSheetId]);
  return (
    <>
      <header className="titlebar">
        <button className="brand" title="Start screen" aria-label="FlowState start screen" onClick={() => showWelcome(false)}>
          <span className="brand-mark">
            <Icon.logo />
          </span>
          <span className="beta-tag" title="Beta software, work in progress: check important results">
            {APP_STAGE}
          </span>
        </button>
        <span className="ws-title" title={ws.name}>
          {ws.name}
        </span>
        <span className="spacer" />
        <button className="tb-btn" title="Open a workspace or FCS files" aria-label="Open files" onClick={openAny}>
          <Icon.open />
        </button>
        {aboutButton}
        {themeButton}
      </header>
      {note && (
        <div className="banner phone-note" role="note">
          <span className="banner-text">
            <b>Viewing mode.</b> Look at worksheets (pinch to zoom), switch samples and export figures. Gating and layout editing need a larger screen (tablet or computer).
          </span>
          <button
            className="icon-btn"
            aria-label="Dismiss note"
            title="Dismiss"
            onClick={() => {
              setNote(false);
              try {
                sessionStorage.setItem(PHONE_NOTE_KEY, '1');
              } catch {
                /* ignore */
              }
            }}
          >
            ×
          </button>
        </div>
      )}
      <div className="phone-bar">
        <button className="icon-btn" aria-label="Previous sample" title="Previous sample" onClick={() => stepSample(-1)}>
          <StepIcon dir={-1} />
        </button>
        <select
          className="sel"
          aria-label="Active sample"
          value={ui.activeSampleId ?? ''}
          disabled={!loaded.length}
          onChange={(e) => st.setUI({ activeSampleId: e.target.value, selectedSampleIds: [e.target.value] })}
        >
          {!loaded.length && <option value="">No samples loaded</option>}
          {loaded.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.eventCount.toLocaleString('en-US')} events)
            </option>
          ))}
        </select>
        <button className="icon-btn" aria-label="Next sample" title="Next sample" onClick={() => stepSample(1)}>
          <StepIcon dir={1} />
        </button>
      </div>
      {ws.worksheets.length > 1 && (
        <div className="center-bar">
          <DocTabs sheetsOnly />
        </div>
      )}
      <section className="center">
        <ErrorBoundary label="worksheet" resetKey={ws}>
          <SheetView readOnly />
        </ErrorBoundary>
      </section>
      <footer className="phone-foot">
        <button className="btn sm primary" onClick={() => st.setUI({ dialog: { kind: 'export', payload: { format: 'png' } } })}>
          <Icon.export /> Export figure
        </button>
        <span className="grow" />
        <ZoomControls compact />
      </footer>
    </>
  );
}

function CursorInfo() {
  const [t, setT] = useState('');
  useEffect(() => onCursorInfo(setT), []);
  return (
    <span className="num status-cursor" style={{ color: 'var(--text)' }}>
      {t}
    </span>
  );
}

function stepSample(d: number) {
  const s = useStore.getState();
  const grp = s.ws.groups.find((g) => g.id === s.ui.sampleFilter);
  const ids = s.ws.samples.filter((x) => engine.has(x.id) && (!grp || grp.sampleIds.includes(x.id))).map((x) => x.id);
  if (!ids.length) return;
  const i = ids.indexOf(s.ui.activeSampleId ?? '');
  const n = Math.min(ids.length - 1, Math.max(0, i + d));
  s.setUI({ activeSampleId: ids[n], selectedSampleIds: [ids[n]] });
}

/** Kind of experiment and calibration tools of the analysis (Workspace.setup), next to its name; opens the setup. */
function SetupChip() {
  const setup = useStore((s) => s.ws.setup);
  const label = setup ? (setup.kind === 'nanoscale' ? 'Nanoscale' : 'Conventional') : 'All tools';
  const extra = setup ? [setup.mesf && 'MESF', setup.size && 'size'].filter(Boolean).join(' + ') : '';
  return (
    <button
      className="setup-chip"
      title={`Experiment: ${label}${extra ? ` with ${extra} calibration` : setup ? ', no calibration tools' : ' (every tool shown)'}. Click to change what this analysis shows.`}
      onClick={() => useStore.getState().setUI({ dialog: { kind: 'setup' } })}
    >
      {label}
      {extra && <span className="setup-chip-extra"> · {extra}</span>}
    </button>
  );
}
