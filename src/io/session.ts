// Local autosave of the current workspace and its FCS files in IndexedDB (stays in this browser only).
import { engine, fileByteSize, fileBytes } from '../core/engine';
import { DEMO_NAME } from '../state/demo';
import { bumpData, holdFileLoads, replacementCount, savedUiOf, useStore, type SavedUi } from '../state/store';
import { installDerivedRunner } from '../workers/derivedJobs';
import { attachSavedUi, openWorkspace, parseWorkspace, saveFile, serializeWorkspace } from './files';
import { strToU8, zipSync } from 'fflate';
import type { Workspace } from '../core/model';

// Results that arrive later (background worker jobs, the full-quality redraw after a burst of changes such as a gate
// drag) redraw the plots and tables: the engine notifies, the data version goes up. Wired here because this module is
// loaded once at startup in the browser.
if (typeof window !== 'undefined') {
  installDerivedRunner(engine);
  engine.subscribe(() => bumpData());
}

const DB = 'flowcanvas-session';
// 2: the 'recent' store (earlier analyses, see below)
const VER = 2;
let dbp: Promise<IDBDatabase | null> | null = null;
/** The open database once known (a page being closed needs it without waiting). */
let dbHandle: IDBDatabase | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        if (!d.objectStoreNames.contains('recent')) d.createObjectStore('recent');
      };
      req.onsuccess = () => {
        dbHandle = req.result;
        resolve(req.result);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

// ------------------------------------------------------------------ crash-loop guard
//
// A workspace that makes the app fail (or hang) right after it is restored would be restored again on every reload.
// The flag below is set before a restore and cleared once the restored workspace has been shown (or the page is closed
// normally); a start that finds it still set does not restore automatically but asks (Dialogs.tsx, 'restoreProblem').

const RESTORING_KEY = 'fs.session.restoring';
let restoredThisLoad = false;
let appAlive: () => boolean = () => true;

/** Whether the last start stopped (crashed or hung) while or right after restoring the session. */
export function restoreInterrupted(): boolean {
  try {
    return !!localStorage.getItem(RESTORING_KEY);
  } catch {
    return false;
  }
}

function markRestoring() {
  try {
    localStorage.setItem(RESTORING_KEY, String(Date.now()));
  } catch {
    /* storage unavailable: no guard */
  }
}

/** The restored session works (it was shown; or the page is closed normally): the next start restores it again. */
export function restoreSettled() {
  try {
    localStorage.removeItem(RESTORING_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** How the app tells it is still alive (mounted, not replaced by an error); set by App. */
export function setAppAliveCheck(f: () => boolean) {
  appAlive = f;
}

/**
 * Clear the guard once the restored workspace has been on screen for a few seconds (only while the app is alive): a
 * hang while drawing it, or right after (a background result arriving), keeps the timer from firing.
 */
function settleRestoreSoon() {
  const run = () => {
    if (appAlive()) restoreSettled();
  };
  if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => setTimeout(run, SETTLE_MS));
  else setTimeout(run, SETTLE_MS);
}
const SETTLE_MS = 5000;

if (typeof window !== 'undefined')
  // a normal close (reload, other page) of a working app: the restore did not break it
  window.addEventListener('pagehide', () => {
    if (restoredThisLoad && appAlive()) restoreSettled();
  });

function tx<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise((resolve) => {
        if (!d) return resolve(undefined);
        try {
          const t = d.transaction(store, mode);
          const r = f(t.objectStore(store));
          t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
          t.onerror = () => resolve(undefined);
          t.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

/** Write transaction; resolves true only once it has been committed. */
function write(store: string, f: (s: IDBObjectStore) => void): Promise<boolean> {
  return db().then(
    (d) =>
      new Promise<boolean>((resolve) => {
        if (!d) return resolve(false);
        try {
          const t = d.transaction(store, 'readwrite');
          t.oncomplete = () => resolve(true);
          t.onerror = () => resolve(false);
          t.onabort = () => resolve(false);
          f(t.objectStore(store));
          t.commit?.(); // commit right away (matters when the page is being closed)
        } catch {
          resolve(false);
        }
      }),
  );
}

const stored = new Set<string>(); // sample ids whose file is committed to the database
const unstorable = new Set<string>(); // sample ids whose file could not be stored (left out of snapshots)
/** Byte size of each stored file (kv 'sizes'), for the sizes the start screen shows without reading the files. */
let sizes: Map<string, number> | null = null;
function persistSizes(): Promise<boolean> {
  const m = sizes;
  return m ? write('kv', (st) => st.put(Object.fromEntries(m), 'sizes')) : Promise.resolve(false);
}
async function fileSizes(): Promise<Map<string, number>> {
  if (sizes) return sizes;
  const raw = await tx<Record<string, number>>('kv', 'readonly', (st) => st.get('sizes'));
  sizes = new Map(raw && typeof raw === 'object' ? Object.entries(raw).filter(([, v]) => typeof v === 'number') : []);
  return sizes;
}

let lastIssued: Workspace | null = null; // the workspace of the last snapshot transaction issued

/**
 * Save the workspace together with the FCS files not stored yet, in one transaction: a committed workspace always has
 * its files (a reload right after loading files used to restore the workspace without them). The requests are issued
 * synchronously, so this also works while the page is being closed.
 */
function writeSnapshot(d: IDBDatabase, ws: Workspace): Promise<boolean> {
  lastIssued = ws;
  return new Promise<boolean>((resolve) => {
    try {
      const t = d.transaction(['kv', 'files'], 'readwrite');
      const files = t.objectStore('files');
      const added: string[] = [];
      for (const s of ws.samples) {
        if (stored.has(s.id) || unstorable.has(s.id)) continue;
        const sd = engine.samples.get(s.id);
        if (!sd?.bytes) continue;
        files.put({ name: s.fileName, bytes: sd.bytes }, s.id);
        added.push(s.id);
        sizes?.set(s.id, fileByteSize(sd.bytes));
      }
      t.objectStore('kv').put(serializeWorkspace(ws), 'workspace');
      if (added.length && sizes) t.objectStore('kv').put(Object.fromEntries(sizes), 'sizes');
      t.oncomplete = () => {
        for (const id of added) stored.add(id);
        resolve(true);
      };
      t.onerror = () => resolve(false);
      t.onabort = () => resolve(false);
      t.commit?.(); // commit right away (matters when the page is being closed)
    } catch {
      resolve(false);
    }
  });
}

/** Drop stored files of samples no longer in the workspace; keep those still reachable by undo / redo. */
async function dropUnusedFiles(): Promise<void> {
  const keys = ((await tx<IDBValidKey[]>('files', 'readonly', (st) => st.getAllKeys())) ?? []) as string[];
  const { ws, past, future } = useStore.getState(); // fresh state: the workspace may have changed while writing
  const keep = new Set([ws, ...past, ...future].flatMap((w) => w.samples.map((s) => s.id)));
  // ... and the files of the earlier analyses on the start screen
  for (const r of await allRecent()) for (const id of r.fileIds) keep.add(id);
  for (const k of keys)
    if (!keep.has(k) && (await write('files', (st) => st.delete(k)))) {
      stored.delete(k);
      sizes?.delete(k);
    }
}

const isExample = (ws: Workspace) => ws.name === DEMO_NAME && ws.samples.every((s) => !engine.samples.get(s.id)?.bytes);

let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let chain: Promise<void> = Promise.resolve(); // saves run one after another
let warned = false;
let persistAsked = false;

function enqueue(job: () => Promise<void>): Promise<void> {
  chain = chain.then(job).catch((e) => console.warn('Autosave failed', e));
  return chain;
}

/** Save now if there are unsaved changes. */
function flush(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!dirty) return chain;
  dirty = false;
  return enqueue(save);
}

/**
 * The page is being closed: issue the save synchronously (an awaited chain would not get to run). Workspace and new
 * files go in one transaction, so the restored session never lacks the files of a workspace it shows.
 */
function flushNow() {
  if (timer) clearTimeout(timer);
  timer = null;
  const ws = useStore.getState().ws;
  // also when a queued save has not issued its transaction yet (it would not run once the page is gone)
  if (!dirty && ws === lastIssued) return;
  if (!dbHandle || isExample(ws)) {
    void flush();
    return;
  }
  dirty = false;
  void writeSnapshot(dbHandle, ws);
}

let started = false;
let exampleHinted = false;
let lastReplacements = 0;

export function startAutosave() {
  if (started) return;
  started = true;
  void fileSizes();
  lastIssued = useStore.getState().ws; // as restored (or new): nothing to write until it changes
  lastReplacements = replacementCount();
  useStore.subscribe((s, prev) => {
    if (s.ws === prev.ws) return;
    // the example is not autosaved (it is made anew on every start): say so once when it is edited (not when another
    // workspace is opened over it)
    const rc = replacementCount();
    const replaced = rc !== lastReplacements;
    lastReplacements = rc;
    if (!exampleHinted && !replaced && isExample(s.ws) && isExample(prev.ws)) {
      exampleHinted = true;
      useStore.getState().toast('Example edits are not kept. Save or open your own files to keep work.', 'info', { duration: 9000 });
    }
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 800);
  });
  // where the user is (active sample, sheet, view): kept apart from the workspace, restored on reload
  let uiKey = JSON.stringify(savedUiOf());
  let uiTimer: ReturnType<typeof setTimeout> | null = null;
  const saveUi = () => {
    if (uiTimer) clearTimeout(uiTimer);
    uiTimer = null;
    const k = JSON.stringify(savedUiOf());
    void write('kv', (st) => st.put(k, 'ui'));
  };
  useStore.subscribe((s, prev) => {
    if (s.ui === prev.ui) return;
    const k = JSON.stringify(savedUiOf(s.ui));
    if (k === uiKey) return;
    uiKey = k;
    if (uiTimer) clearTimeout(uiTimer);
    uiTimer = setTimeout(saveUi, 600);
  });
  // the page may be closed before the timer fires
  window.addEventListener('pagehide', () => {
    if (uiTimer) saveUi();
    flushNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (uiTimer) saveUi();
    flushNow();
  });
}

async function save() {
  const ws = useStore.getState().ws;
  if (isExample(ws)) {
    // the example is regenerated on start; nothing to keep
    await write('kv', (st) => st.delete('workspace'));
    return;
  }
  if (!persistAsked && ws.samples.length) {
    // ask the browser not to evict the stored files under storage pressure (the answer does not matter)
    persistAsked = true;
    try {
      if (typeof navigator !== 'undefined') void navigator.storage?.persist?.().catch(() => undefined);
    } catch {
      /* not supported */
    }
  }
  const d = await db();
  let ok = !!d && (await writeSnapshot(d, ws));
  if (!ok && d) {
    // one file that cannot be stored (moved or changed on disk since it was opened, or no room) fails the whole
    // snapshot: store the files one by one, leave out those that fail, and save the workspace with the rest
    const lost: string[] = [];
    for (const s of ws.samples) {
      const sd = engine.samples.get(s.id);
      if (stored.has(s.id) || unstorable.has(s.id) || !sd?.bytes) continue;
      const bytes = sd.bytes;
      if (await write('files', (st) => st.put({ name: s.fileName, bytes }, s.id))) {
        stored.add(s.id);
        sizes?.set(s.id, fileByteSize(bytes));
      } else {
        unstorable.add(s.id);
        lost.push(s.fileName);
      }
    }
    if (lost.length) {
      ok = await writeSnapshot(d, ws);
      if (ok)
        useStore
          .getState()
          .toast(
            `${lost.length} file${lost.length === 1 ? '' : 's'} could not be kept in this browser (storage full, or moved or changed on disk since opened): ${lost.slice(0, 3).join(', ')}${lost.length > 3 ? ` and ${lost.length - 3} more` : ''}. After a reload ${lost.length === 1 ? 'it has' : 'they have'} to be opened again; "Save with data" keeps everything.`,
            'info',
            { duration: 20000 },
          );
    }
  }
  if (ok) await dropUnusedFiles();
  // the files do not fit (storage quota): keep at least the workspace (its files can be relinked when it is restored)
  else if (d) await write('kv', (st) => st.put(serializeWorkspace(ws), 'workspace'));
  if (!ok && !warned) {
    warned = true;
    useStore.getState().toast('Autosave failed: browser storage is full or blocked. Use "Save with data" to keep your work.', 'error');
  }
}

export type RestoreResult = { status: 'none' } | { status: 'restored' } | { status: 'failed'; message: string };

/**
 * Restore the last session (workspace, FCS files, where the user was). 'none': nothing saved; 'failed': the saved
 * session could not be read (it stays stored; see downloadSavedSession). Files opened meanwhile wait for it and are
 * added to the restored workspace (holdFileLoads).
 */
export function restoreSession(): Promise<RestoreResult> {
  return holdFileLoads(restoreSessionNow());
}

async function restoreSessionNow(): Promise<RestoreResult> {
  const json = await tx<string>('kv', 'readonly', (st) => st.get('workspace'));
  if (!json) {
    restoreSettled();
    return { status: 'none' };
  }
  markRestoring();
  let ws: Workspace;
  try {
    ws = parseWorkspace(json);
  } catch (e) {
    restoreSettled();
    console.warn('Session restore failed', e);
    return { status: 'failed', message: (e as Error)?.message ?? String(e) };
  }
  try {
    const ui = await tx<string>('kv', 'readonly', (st) => st.get('ui'));
    if (ui) {
      try {
        attachSavedUi(ws, JSON.parse(ui) as SavedUi);
      } catch {
        /* unreadable: open at the first sample */
      }
    }
    const files: { name: string; bytes: Uint8Array; id?: string; blob?: Blob }[] = [];
    const sz = await fileSizes();
    for (const s of ws.samples) {
      const f = await tx<{ name: string; bytes: ArrayBuffer | Blob }>('files', 'readonly', (st) => st.get(s.id));
      const bytes = f?.bytes ? await fileBytes(f.bytes).catch(() => null) : null; // unreadable: missing (can be relinked)
      if (f?.bytes && bytes) {
        files.push({ name: s.fileName, bytes, id: s.id, blob: f.bytes instanceof Blob ? f.bytes : undefined });
        stored.add(s.id);
        sz.set(s.id, fileByteSize(f.bytes));
      }
    }
    void persistSizes();
    await openWorkspace(ws, files, { restored: true });
    restoredThisLoad = true;
    settleRestoreSoon();
    return { status: 'restored' };
  } catch (e) {
    restoreSettled();
    console.warn('Session restore failed', e);
    return { status: 'failed', message: (e as Error)?.message ?? String(e) };
  }
}

/**
 * The saved session as a bundle (.flowstate.zip: the workspace text as stored, and its FCS files), read without
 * opening it, so a session that cannot be opened can still be kept. Returns false if there is nothing to save.
 */
export async function downloadSavedSession(): Promise<boolean> {
  const json = await tx<string>('kv', 'readonly', (st) => st.get('workspace'));
  const keys = ((await tx<IDBValidKey[]>('files', 'readonly', (st) => st.getAllKeys())) ?? []) as string[];
  if (!json && !keys.length) {
    useStore.getState().toast('There is no saved session in this browser.', 'info');
    return false;
  }
  const out: Record<string, Uint8Array> = {};
  if (json) out['workspace.flowstate.json'] = strToU8(json);
  // the files of this session only (the store also holds those of earlier analyses)
  let own: Set<string> | null = null;
  try {
    if (json) own = new Set((JSON.parse(json) as { samples?: { id?: unknown }[] }).samples?.map((x) => String(x?.id)) ?? []);
  } catch {
    own = null; // unreadable workspace text: every file, so nothing is lost
  }
  for (const k of keys) {
    if (own && !own.has(String(k))) continue;
    const f = await tx<{ name: string; bytes: ArrayBuffer | Blob }>('files', 'readonly', (st) => st.get(k));
    const bytes = f?.bytes ? await fileBytes(f.bytes).catch(() => null) : null;
    if (f && bytes) out[`fcs/${String(k).replace(/[\\/]/g, '_')}/${String(f.name || k + '.fcs').replace(/[\\/]/g, '_')}`] = bytes;
  }
  return saveFile('saved-session.flowstate.zip', zipSync(out, { level: 1 }));
}

/**
 * Forget the current session (a new, empty workspace follows). Files of earlier analyses (start screen) stay; the
 * current one is kept there too when `archive` (default) and it has samples.
 */
export function clearSession(opts: { archive?: boolean } = {}): Promise<void> {
  const archive = opts.archive !== false;
  // the workspace as it is now (it is replaced right after this call): its last changes and new files are written at
  // once, while its data are still loaded; later transactions on the database wait for this one
  if (archive) snapshotNow();
  return enqueue(async () => {
    if (archive) await archiveStored();
    stored.clear();
    unstorable.clear();
    await write('kv', (st) => {
      st.delete('workspace');
      st.delete('ui');
    });
    const keepIds = new Set((await allRecent()).flatMap((r) => r.fileIds));
    const keys = ((await tx<IDBValidKey[]>('files', 'readonly', (st) => st.getAllKeys())) ?? []) as string[];
    const drop = keys.filter((k) => !keepIds.has(k));
    if (drop.length) await write('files', (st) => drop.forEach((k) => st.delete(k)));
  });
}

// ------------------------------------------------------------------ earlier analyses (start screen)
//
// When the user starts something else (a new analysis, the example, another earlier analysis), the current session is
// not discarded: its workspace and the keys of its stored files move to the 'recent' store, and the files stay in
// 'files' (they are shared by key; sample ids are unique). The start screen lists them; opening one makes it the
// current session again. At most RECENT_MAX are kept (the oldest goes, with its files).

export interface RecentMeta {
  id: string;
  name: string;
  /** when it was last saved (ms) */
  savedAt: number;
  /** when it was last open (moved to the list; ms): the list order */
  usedAt: number;
  samples: number;
  plates: number;
  populations: number;
  /** stored file bytes */
  bytes: number;
  /** samples whose file is stored (the others must be relinked) */
  files: number;
  instruments: string[];
  firstSamples: string[];
}
interface RecentEntry extends RecentMeta {
  workspace: string;
  ui?: string;
  fileIds: string[];
}

export const RECENT_MAX = 12;

async function allRecent(): Promise<RecentEntry[]> {
  const all = ((await tx<RecentEntry[]>('recent', 'readonly', (st) => st.getAll())) ?? []) as RecentEntry[];
  return all.filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.workspace === 'string' && Array.isArray(r.fileIds));
}

/** What the start screen shows of a saved workspace (from its JSON, without opening it). */
export function recentMetaOf(json: string, savedAt: number, storedIds: Set<string>, sizeOf?: (id: string) => number | undefined): Omit<RecentMeta, 'id' | 'usedAt'> | null {
  try {
    const w = JSON.parse(json) as { name?: unknown; samples?: unknown; plates?: unknown; populations?: unknown; savedAt?: unknown };
    if (!w || typeof w !== 'object' || !Array.isArray(w.samples)) return null;
    const samples = w.samples.filter((x): x is { id: string; name?: string; fileSize?: number; instrument?: string; info?: Record<string, string> } => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string');
    const withFile = samples.filter((x) => storedIds.has(x.id));
    const inst = [...new Set(samples.map((x) => (typeof x.info?.['Cytometer'] === 'string' ? x.info['Cytometer'] : typeof x.instrument === 'string' ? x.instrument.split('|')[0] : '')).filter(Boolean))];
    const plateNames = new Set(samples.map((x) => (x as { plate?: unknown }).plate).filter((p) => typeof p === 'string'));
    const iso = typeof w.savedAt === 'string' ? Date.parse(w.savedAt) : NaN;
    return {
      name: typeof w.name === 'string' && w.name.trim() ? w.name : 'Untitled workspace',
      savedAt: Number.isFinite(iso) ? iso : savedAt,
      samples: samples.length,
      plates: plateNames.size,
      populations: Array.isArray(w.populations) ? w.populations.length : 0,
      bytes: withFile.reduce((a, x) => a + (sizeOf?.(x.id) ?? (typeof x.fileSize === 'number' && x.fileSize > 0 ? x.fileSize : 0)), 0),
      files: withFile.length,
      instruments: inst.slice(0, 3),
      firstSamples: samples.slice(0, 3).map((x) => (typeof x.name === 'string' ? x.name : '')).filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** The stored current session (what "Continue" opens), without opening it; null when there is none. */
export async function currentSessionInfo(): Promise<RecentMeta | null> {
  const json = await tx<string>('kv', 'readonly', (st) => st.get('workspace'));
  if (!json) return null;
  const keys = new Set(((await tx<IDBValidKey[]>('files', 'readonly', (st) => st.getAllKeys())) ?? []) as string[]);
  const sz = await fileSizes();
  const m = recentMetaOf(json, Date.now(), keys, (id) => sz.get(id));
  return m && m.samples > 0 ? { id: 'current', ...m, usedAt: m.savedAt } : null;
}

/** Earlier analyses, newest first (without their workspace text). */
export async function listRecent(): Promise<RecentMeta[]> {
  return (await allRecent())
    .map(({ workspace: _w, ui: _u, fileIds: _f, ...m }) => ({ ...m, usedAt: m.usedAt ?? m.savedAt }))
    .sort((a, b) => b.usedAt - a.usedAt);
}

/** Bytes of the FCS files the earlier analyses keep (a file shared by several counts once). */
export async function recentBytes(): Promise<number> {
  const sz = await fileSizes();
  const ids = new Set((await allRecent()).flatMap((r) => r.fileIds));
  let n = 0;
  for (const id of ids) n += sz.get(id) ?? 0;
  return n;
}

/** Move the stored current session (if it has samples) to the earlier analyses. */
async function archiveStored(protect?: string): Promise<boolean> {
  const json = await tx<string>('kv', 'readonly', (st) => st.get('workspace'));
  if (!json) return false;
  const keys = new Set(((await tx<IDBValidKey[]>('files', 'readonly', (st) => st.getAllKeys())) ?? []) as string[]);
  const sz = await fileSizes();
  const meta = recentMetaOf(json, Date.now(), keys, (id) => sz.get(id));
  if (!meta || !meta.samples) return false;
  const ui = await tx<string>('kv', 'readonly', (st) => st.get('ui'));
  let fileIds: string[] = [];
  try {
    fileIds = (JSON.parse(json) as { samples: { id: string }[] }).samples.map((x) => x.id).filter((id) => keys.has(id));
  } catch {
    /* (meta was read, so this does not happen) */
  }
  const entry: RecentEntry = { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...meta, usedAt: Date.now(), workspace: json, ...(ui ? { ui } : {}), fileIds };
  const ok = await write('recent', (st) => st.put(entry, entry.id));
  if (!ok) return false;
  await write('kv', (st) => {
    st.delete('workspace');
    st.delete('ui');
  });
  // the oldest beyond the limit go (their files with them, unless shared); not the one being opened (`protect`)
  const all = (await allRecent()).filter((r) => r.id !== protect).sort((a, b) => (b.usedAt ?? b.savedAt) - (a.usedAt ?? a.savedAt));
  for (const old of all.slice(RECENT_MAX)) await removeRecentEntry(old.id);
  return true;
}

/**
 * Keep the open workspace as an earlier analysis (start screen) before something else replaces it: pending changes are
 * saved first. The example and empty workspaces are not kept.
 */
export async function archiveCurrent(protect?: string): Promise<boolean> {
  const ws = useStore.getState().ws;
  // (nothing open, e.g. at the start screen: the stored session is the current one and is kept)
  if (isExample(ws)) return false;
  await db();
  snapshotNow();
  let result = false;
  await enqueue(async () => {
    result = await archiveStored(protect);
  });
  return result;
}

/** Write the open workspace (and its new files) now, synchronously issued, unless it is stored already. */
function snapshotNow() {
  if (timer) clearTimeout(timer);
  timer = null;
  const ws = useStore.getState().ws;
  if (!dbHandle || isExample(ws) || !ws.samples.length || ws === lastIssued) return;
  dirty = false;
  void writeSnapshot(dbHandle, ws);
}

async function removeRecentEntry(id: string) {
  await write('recent', (st) => st.delete(id));
  await dropUnusedFiles();
}

/** Delete an earlier analysis and the files only it used. */
export function deleteRecent(id: string): Promise<void> {
  return enqueue(() => removeRecentEntry(id));
}

/**
 * Open an earlier analysis: the current one is kept as an earlier analysis first; the opened one becomes the current
 * session (it leaves the list). Returns false if it could not be read. Files opened meanwhile wait for it
 * (holdFileLoads).
 */
export function openRecent(id: string): Promise<boolean> {
  return holdFileLoads(openRecentNow(id));
}

async function openRecentNow(id: string): Promise<boolean> {
  const entry = (await allRecent()).find((r) => r.id === id);
  if (!entry) return false;
  let ws: Workspace;
  try {
    ws = parseWorkspace(entry.workspace);
  } catch (e) {
    useStore.getState().toast(`This analysis could not be opened: ${(e as Error)?.message ?? e}`, 'error');
    return false;
  }
  // (the entry being opened stays out of the trim to the limit: its files must not go)
  await archiveCurrent(id);
  if (entry.ui) {
    try {
      attachSavedUi(ws, JSON.parse(entry.ui) as SavedUi);
    } catch {
      /* unreadable: open at the first sample */
    }
  }
  const files: { name: string; bytes: Uint8Array; id?: string; blob?: Blob }[] = [];
  const sz = await fileSizes();
  for (const sid of entry.fileIds) {
    const f = await tx<{ name: string; bytes: ArrayBuffer | Blob }>('files', 'readonly', (st) => st.get(sid));
    const bytes = f?.bytes ? await fileBytes(f.bytes).catch(() => null) : null;
    if (f?.bytes && bytes) {
      files.push({ name: ws.samples.find((x) => x.id === sid)?.fileName ?? f.name, bytes, id: sid, blob: f.bytes instanceof Blob ? f.bytes : undefined });
      stored.add(sid);
      sz.set(sid, fileByteSize(f.bytes));
    }
  }
  void persistSizes();
  // it is the current session now: stored as such, and out of the list (its files stay: the workspace uses them)
  await write('kv', (st) => {
    st.put(entry.workspace, 'workspace');
    if (entry.ui) st.put(entry.ui, 'ui');
  });
  await write('recent', (st) => st.delete(id));
  markRestoring();
  await openWorkspace(ws, files, { restored: true, label: `"${entry.name}"` });
  restoredThisLoad = true;
  settleRestoreSoon();
  lastIssued = useStore.getState().ws;
  return true;
}
