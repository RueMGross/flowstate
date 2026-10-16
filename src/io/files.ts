// File input/output: downloads (artifact-safe), workspace JSON, ZIP bundles, Gating-ML, population export.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { produce } from 'immer';
import { engine, fileBytes } from '../core/engine';
import { getSpillover, parseFcsSamples, parseTextSegment, pickSample, spilloverKeyword, SPILL_KEYS, writeFcs, type FcsDataset, type FcsSample } from '../core/fcs';
import { decodeEntities } from '../core/xml';
import { eventTableDataset, looksLikeEventTable, parseEventStream } from '../core/eventtable';
import { matrixToText, readMatrixFile, sniffMatrix, type ChannelRef } from '../core/matrixio';
import { exportGatingMLDoc, importGatingML, instrumentDependentGates, type GmlExport } from '../core/gatingml';
import { flowJoChannelRenames, importFlowJo, isFlowJoWorkspaceXml, renameWorkspaceChannels } from '../core/flowjo';
import { APP_NAME, LEGACY_APP_NAMES, WORKSPACE_VERSION, type CompDef, type ExperimentSetup, type GateGeom, type SampleChannel, type Workspace, emptyWorkspace, uid, GATE_COLORS } from '../core/model';
import { DEMO_NAME } from '../state/demo';
import { repairWorkspace } from '../core/repair';
import { sampleInstrument } from '../core/instruments';
import {
  addDataset,
  confirmLargeLoad,
  convertTicksTime,
  datasetIndexOf,
  fileLoadsReady,
  gateChannelsMissing,
  hasTicksTime,
  instrumentDisplayName,
  linkCandidateOf,
  loadFcsFiles,
  matchByContent,
  openDataBytes,
  readableError,
  restoreSavedUi,
  savedUiOf,
  useStore,
  warnMissingGateChannels,
  type SavedUi,
  type TimeUnitMark,
} from '../state/store';
import { clearSession } from './session';
import { relativePathOf, setRelativePath } from './folders';

type DownloadsNS = { save(req: { filename: string; data: string | Blob | ArrayBuffer | ArrayBufferView }): Promise<{ status: string }> };

let downloadsNs: Promise<DownloadsNS | null> | null = null;
function getDownloads(): Promise<DownloadsNS | null> {
  if (downloadsNs) return downloadsNs;
  const w = window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } };
  if (w.claude?.use) {
    downloadsNs = (w.claude.use('downloads') as Promise<DownloadsNS | null>).catch(() => null);
  } else downloadsNs = Promise.resolve(null);
  return downloadsNs;
}

const ALLOWED = /\.(gif|png|jpe?g|webp|mp4|webm|txt|json|md|docx|pptx|epub|csv|ttf|html|svg|pdf|xlsx|zip)$/i;

export function isHostedArtifact(): boolean {
  const w = window as unknown as { claude?: { use?: unknown } };
  return !!w.claude?.use;
}

/** Save a file. Inside the claude.ai viewer the platform download capability is used; formats it does not accept are zipped. */
export async function saveFile(filename: string, data: string | Blob | Uint8Array): Promise<boolean> {
  const st = useStore.getState();
  const dl = await getDownloads();
  if (dl) {
    let name = filename;
    let payload: string | Blob | Uint8Array = data;
    if (!ALLOWED.test(name)) {
      const bytes = typeof data === 'string' ? strToU8(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
      payload = zipSync({ [filename]: bytes });
      name = filename + '.zip';
    }
    try {
      await dl.save({ filename: name, data: payload instanceof Uint8Array ? payload.slice() : payload });
      st.toast(`Saved ${name}`, 'success');
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'declined') return false;
      if (code === 'rate_limited') {
        st.toast('Another save prompt is open. Try again in a moment.', 'error');
        return false;
      }
      st.toast(`Could not save ${name} (${code ?? 'error'})`, 'error');
      return false;
    }
  }
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'workspace';
}

// ------------------------------------------------------------ workspace

// JSON has no Infinity / NaN: such numbers are written as {"$n":"Infinity"} (workspace version 2 and later).
const numReplacer = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? { $n: String(v) } : v);
const numReviver = (_k: string, v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$n' && typeof (v as { $n: unknown }).$n === 'string') return Number((v as { $n: string }).$n);
  }
  return v;
};

/** Version 1 files stored infinite gate bounds as the strings "Infinity" / "-Infinity". */
const GATE_STRING_KEYS = new Set(['type', 'x', 'y', 'quadrant', 'groupId', 'side', 'op', 'operands', 'comp']);
function legacyInfinities(v: unknown, key = ''): unknown {
  if (v === 'Infinity' || v === '-Infinity') return GATE_STRING_KEYS.has(key) ? v : Number(v);
  if (Array.isArray(v)) return key === 'operands' ? v : v.map((x) => legacyInfinities(x));
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (v as Record<string, unknown>)[k] = legacyInfinities(x, k);
  return v;
}

/**
 * `timeUnit`: 's' since Time is read in seconds (FCS $TIMESTEP applied); files without it (or 'ticks', a workspace not
 * converted yet) hold Time gates and scales in raw ticks and are converted when a sample is loaded (state/store.ts).
 */
export function serializeWorkspace(ws: Workspace, ui?: SavedUi): string {
  const timeUnit = hasTicksTime(ws) ? 'ticks' : 's';
  return JSON.stringify({ ...ws, app: APP_NAME, version: WORKSPACE_VERSION, timeUnit, savedAt: new Date().toISOString(), ...(ui ? { uiState: ui } : {}) }, numReplacer);
}

/** UI state saved with a parsed workspace (active sample, sheet, view), applied when it is opened (openWorkspace). */
const pendingUi = new WeakMap<Workspace, SavedUi>();

/** Attach a UI state to restore when `ws` is opened with openWorkspace (e.g. the autosaved one). */
export function attachSavedUi(ws: Workspace, ui: SavedUi | null | undefined) {
  if (ui && typeof ui === 'object') pendingUi.set(ws, ui);
}

/** Notes of the repair of a parsed workspace (damaged entries fixed or removed), shown when it is opened. */
const repairNotes = new WeakMap<Workspace, string[]>();

/** What was repaired when `ws` was parsed (empty for an intact workspace). */
export function workspaceRepairNotes(ws: Workspace): string[] {
  return repairNotes.get(ws) ?? [];
}

/**
 * Parse a workspace file (JSON). Damaged contents are validated and repaired (core/repair.ts; the notes are shown when it
 * is opened); a file that cannot be used at all throws an Error with a message for the user.
 */
export function parseWorkspace(text: string): Workspace {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text, numReviver);
  } catch (e) {
    throw new Error(`The workspace file is damaged: it is not valid JSON (${String((e as Error)?.message ?? e).slice(0, 120)}). It may have been cut off while saving or downloading.`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || (obj.app !== APP_NAME && !LEGACY_APP_NAMES.includes(obj.app as string)) || !Array.isArray(obj.samples))
    throw new Error(`Not a ${APP_NAME} workspace file`);
  if (!((obj.version as number) >= 2) && Array.isArray(obj.populations))
    for (const p of obj.populations as { gate?: unknown; overrides?: Record<string, unknown> }[]) {
      if (p?.gate) p.gate = legacyInfinities(p.gate);
      if (p?.overrides && typeof p.overrides === 'object') for (const k of Object.keys(p.overrides)) p.overrides[k] = legacyInfinities(p.overrides[k]);
    }
  const uiState = obj.uiState as SavedUi | undefined;
  delete obj.uiState;
  // when it was saved is not part of the workspace (it would be carried along and saved again)
  delete obj.savedAt;
  const timeUnit = obj.timeUnit;
  const base = emptyWorkspace();
  const merged = { ...base, ...obj, style: { ...base.style, ...(obj.style && typeof obj.style === 'object' && !Array.isArray(obj.style) ? obj.style : {}) } };
  const { ws: out, notes } = repairWorkspace(merged);
  const res = out as Workspace & TimeUnitMark;
  attachSavedUi(res, uiState);
  if (notes.length) repairNotes.set(res, notes);
  // files saved before Time was read in seconds have no 'timeUnit'
  if (timeUnit === 's') delete res.timeUnit;
  else res.timeUnit = 'ticks';
  return res;
}

export async function saveWorkspaceJson(): Promise<boolean> {
  const ws = useStore.getState().ws;
  return saveFile(`${safeName(ws.name)}.flowstate.json`, serializeWorkspace(ws, savedUiOf()));
}

/** The workspace as a template: gates, layouts, tables and scales without samples. */
export function templateWorkspace(ws: Workspace): Workspace {
  const ids = new Set(ws.samples.map((s) => s.id));
  const t: Workspace = JSON.parse(serializeWorkspace(ws), numReviver);
  t.samples = [];
  t.groups = t.groups.map((g) => ({ ...g, sampleIds: [] }));
  for (const p of t.populations) {
    delete p.overrides;
    // sample-specific gating trees refer to samples the template does not have; group-specific ones stay (groups are kept)
    if (p.scope) {
      delete p.scope.samples;
      if (!p.scope.groups?.length) delete p.scope;
    }
  }
  for (const sh of t.worksheets)
    for (const it of sh.items) {
      if (it.kind === 'plot') it.layers = it.layers.map((l) => (ids.has(l.sample) ? { ...l, sample: 'active' } : l));
      if (it.kind === 'stats' && ids.has(it.sample)) it.sample = 'active';
      if (it.kind === 'chart' && it.samples) delete it.samples;
    }
  // keep only matrices that do not come from individual files
  t.compensations = t.compensations.filter((c) => c.source !== 'file');
  t.name = ws.name + ' (template)';
  delete (t as Workspace & { uiState?: unknown }).uiState;
  return t;
}

/** Gates, layouts, tables and scales without samples: open it, then add new FCS files. */
export async function saveTemplate() {
  const ws = useStore.getState().ws;
  await saveFile(`${safeName(ws.name)}.template.flowstate.json`, serializeWorkspace(templateWorkspace(ws)));
}

/**
 * Save the workspace with the FCS files of its samples (.flowstate.zip). Samples whose data are not loaded (files not
 * found or left out) cannot go into the bundle: unless `allowMissing`, ask first (relink them, or save without them).
 * Returns false when nothing was saved.
 */
export async function saveWorkspaceBundle(opts: { allowMissing?: boolean } = {}): Promise<boolean> {
  const st = useStore.getState();
  const ws = st.ws;
  const missing = ws.samples.filter((s) => !engine.samples.get(s.id));
  if (missing.length && !opts.allowMissing) {
    const names = missing.map((s) => s.fileName || s.name);
    st.setUI({
      dialog: {
        kind: 'confirm',
        payload: {
          title: 'Save without the missing data?',
          text:
            `${plural(missing.length, 'sample')} of ${ws.samples.length} ${missing.length === 1 ? 'has' : 'have'} no data loaded (file not found or left out): ` +
            `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}. ` +
            `The bundle would hold ${missing.length === 1 ? 'its' : 'their'} gates and settings but not ${missing.length === 1 ? 'its' : 'their'} events. ` +
            'To include them, relink the files first: drop them on the page or use "Locate files" in the banner above the worksheet.',
          ok: 'Save without them',
          onOk: () => void saveWorkspaceBundle({ allowMissing: true }),
        } satisfies ConfirmExtraPayload,
      },
    });
    return false;
  }
  const files: Record<string, Uint8Array> = { 'workspace.flowstate.json': strToU8(serializeWorkspace(ws, savedUiOf())) };
  const rewritten: string[] = [];
  for (const s of ws.samples) {
    const sd = engine.samples.get(s.id);
    if (!sd) continue;
    // the original file (a file on disk that was moved or changed since cannot be read: the data as FCS instead)
    let bytes = sd.bytes ? await fileBytes(sd.bytes).catch(() => null) : null;
    if (!bytes) {
      if (sd.bytes) rewritten.push(s.fileName);
      bytes = writeFcs({ channels: sd.ds.channels, data: sd.ds.data, keywords: sd.ds.keywords });
    }
    // one folder per sample: samples may share a file name
    files[`fcs/${s.id}/${(s.fileName || s.name + '.fcs').replace(/[\\/]/g, '_')}`] = bytes;
  }
  const zipped = zipSync(files, { level: 6 });
  const ok = await saveFile(`${safeName(ws.name)}.flowstate.zip`, zipped);
  if (!ok) return false;
  if (missing.length)
    useStore
      .getState()
      .toast(
        `The bundle has no events for ${plural(missing.length, 'sample')} (not loaded): ${missing.slice(0, 3).map((s) => s.fileName || s.name).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}. Opening it asks for ${missing.length === 1 ? 'this file' : 'these files'} again.`,
        'info',
        { duration: 15000 },
      );
  if (rewritten.length)
    useStore
      .getState()
      .toast(
        `${rewritten.length} original file${rewritten.length === 1 ? ' could' : 's could'} not be read again (moved or changed on disk): ${rewritten.slice(0, 3).join(', ')}${rewritten.length > 3 ? ` and ${rewritten.length - 3} more` : ''}. The bundle holds their events as new FCS files with the same keywords.`,
        'info',
        { duration: 15000 },
      );
  return true;
}

/** Text files read whole to tell a compensation matrix from an event table (matrices are small). */
const MATRIX_SNIFF_BYTES = 2 << 20;

/**
 * What a .csv / .tsv / .txt / .mtx / .comp file holds: a compensation matrix (CytExpert binary, FlowJo XML, a square
 * table with matching row and column names) or an event table (rows of numbers), by content; null: neither.
 */
export async function sniffTableFile(f: File): Promise<'matrix' | 'events' | null> {
  const small = f.size <= MATRIX_SNIFF_BYTES;
  const head = new Uint8Array(await f.slice(0, small ? f.size : 1 << 18).arrayBuffer());
  if (small && sniffMatrix(f.name, head)) return 'matrix';
  if (/\.(mtx|comp)$/i.test(f.name)) return null;
  return looksLikeEventTable(new TextDecoder('utf-8').decode(head), !small) ? 'events' : null;
}

/** Open any supported file(s): FCS/LMD, workspace JSON, bundle ZIP, Gating-ML XML, FlowJo workspace (.wsp), compensation matrices (.mtx, .comp, matrix .txt / .csv), event tables (.csv / .tsv / .txt). */
export async function openFiles(files: File[]) {
  // files opened while the last session is restored: added to it once it is there (not dropped with the workspace)
  await fileLoadsReady();
  const st = useStore.getState();
  let fcs: File[] = [];
  // the large-load question was answered for the FCS files given with a FlowJo workspace (not asked twice)
  let asked = false;
  const flowjo: { name: string; text: string }[] = [];
  const matrices: File[] = [];
  const tables: File[] = [];
  for (const f of files) {
    const n = f.name.toLowerCase();
    try {
      if (/\.(csv|tsv|txt|mtx|comp)$/.test(n)) {
        const kind = await sniffTableFile(f);
        if (kind === 'matrix') matrices.push(f);
        else if (kind === 'events') tables.push(f);
        else
          throw new Error(
            /\.(mtx|comp)$/.test(n)
              ? 'not a readable compensation matrix (FlowJo .mtx XML, CytExpert .comp or a table of channel names and values).'
              : 'neither a compensation matrix (a square table with channel names) nor an event table (a header row of channel names and rows of numbers).',
          );
      } else if (n.endsWith('.json')) {
        const ws = parseWorkspace(await f.text());
        await openWorkspace(ws, []);
      } else if (n.endsWith('.zip')) {
        await openBundle(new Uint8Array(await f.arrayBuffer()));
      } else if (n.endsWith('.wsp')) {
        flowjo.push({ name: f.name, text: await f.text() });
      } else if (n.endsWith('.flowjo')) {
        // FlowJo v11 workspace: a zip; only a FlowJo XML workspace inside it can be imported
        flowjo.push({ name: f.name, text: flowJo11Workspace(new Uint8Array(await f.arrayBuffer()), f.name) });
      } else if (n.endsWith('.xml')) {
        const text = await f.text();
        // FlowJo can also save workspaces as .xml; a FlowJo matrix may be saved as .xml too
        if (isFlowJoWorkspaceXml(text)) flowjo.push({ name: f.name, text });
        else if (sniffMatrix(f.name, strToU8(text))) matrices.push(f);
        else importGatingMLText(text, f.name);
      } else fcs.push(f);
    } catch (e) {
      st.toast(`${f.name}: ${readableError(e)}`, 'error');
    }
  }
  if (flowjo.length) {
    if (flowjo.length > 1) st.toast(`Several FlowJo workspaces were dropped; opened ${flowjo[0].name}.`, 'info');
    try {
      // FCS files dropped together with the workspace are linked right away (by path / file name, then content)
      const r = await importFlowJoText(flowjo[0].text, flowjo[0].name, fcs);
      fcs = fcs.filter((f) => !r.linked.has(f));
      asked = r.asked;
    } catch (e) {
      st.toast(`${flowjo[0].name}: ${readableError(e)}`, 'error');
    }
  }
  if (fcs.length) await loadFcsFiles(fcs, undefined, { noPrompt: asked });
  if (tables.length) await loadEventTables(tables);
  // after the data: matrix names are matched to the channels of the loaded samples
  if (matrices.length) await importMatrixFiles(matrices);
}

// ------------------------------------------------------------ event tables (CSV) and compensation matrix files

/** Event tables (CSV / TSV / TXT) as samples; read in pieces so large tables do not freeze the page. */
export async function loadEventTables(files: File[]): Promise<string[]> {
  const st = useStore.getState();
  const pre = new Map<File, FcsSample[]>();
  for (const f of files) {
    try {
      if (f.size > 20e6) st.toast(`Reading ${f.name} (${Math.round(f.size / 1e6)} MB)...`, 'info');
      const t = await parseEventStream(f.stream() as ReadableStream<Uint8Array>);
      const { ds, bytes } = eventTableDataset(t, f.name);
      pre.set(f, [{ ds, bytes }]);
      st.toast(
        `${f.name}: ${t.rows.toLocaleString('en-US')} events, ${t.names.length} channels read from the table. The values are used as exported (no compensation keywords): values exported compensated are already compensated.${t.notes.length ? ' ' + t.notes.join('; ') + '.' : ''}`,
        'info',
        { duration: 12000 },
      );
    } catch (e) {
      st.toast(`${f.name}: ${readableError(e)}`, 'error');
    }
  }
  return pre.size ? loadFcsFiles([...pre.keys()], pre) : [];
}

/** All channels of the workspace's samples (loaded or waiting for their file), for matching matrix names. */
export function workspaceChannels(ws: Workspace): ChannelRef[] {
  const seen = new Map<string, ChannelRef>();
  for (const s of ws.samples) for (const c of s.channels) if (!seen.has(c.name)) seen.set(c.name, { name: c.name, label: c.label });
  return [...seen.values()];
}

/**
 * Add the compensation matrices of matrix files (FlowJo .mtx, CytExpert .comp, FlowLogic / CSV text) to the
 * workspace, their names matched to the samples' channels. An identical matrix already there is reused. Returns the
 * ids of the matrices (new or reused).
 */
export async function importMatrixFiles(files: File[]): Promise<string[]> {
  const st = useStore.getState();
  const ids: string[] = [];
  for (const f of files) {
    try {
      const got = readMatrixFile(f.name, new Uint8Array(await f.arrayBuffer()), workspaceChannels(useStore.getState().ws));
      for (const m of got) {
        const def: CompDef = { id: uid('comp'), name: m.name, channels: m.channels, matrix: m.matrix, source: 'imported' };
        let reused: string | null = null;
        let name = m.name;
        useStore.getState().update((ws) => {
          const same = ws.compensations.find((x) => sameMatrix(x as CompDef, def));
          if (same) {
            reused = same.name;
            ids.push(same.id);
            return;
          }
          const names = new Set(ws.compensations.map((c) => c.name));
          for (let k = 2; names.has(name); k++) name = `${m.name} ${k}`;
          ws.compensations.push({ ...def, name });
          ids.push(def.id);
        });
        const id = ids[ids.length - 1];
        const n = m.channels.length;
        const parts = [
          reused ? `${f.name}: the same matrix is already in the workspace ("${reused}").` : `Imported the ${n}x${n} compensation matrix "${name}" from ${f.name}.`,
          m.notes.length ? `Note: ${m.notes.join('; ')}.` : '',
          m.renamed.length ? `Matched by name: ${m.renamed.slice(0, 4).join(', ')}${m.renamed.length > 4 ? ` and ${m.renamed.length - 4} more` : ''}.` : '',
          m.unmapped.length
            ? `Not found among the samples' channels (ignored when compensating): ${m.unmapped.slice(0, 6).join(', ')}${m.unmapped.length > 6 ? ` and ${m.unmapped.length - 6} more` : ''}.`
            : '',
          !useStore.getState().ws.samples.length ? 'Open the FCS files, then import the matrix again to match its names to their channels.' : '',
        ].filter(Boolean);
        const hasSamples = useStore.getState().ws.samples.length > 0;
        st.toast(parts.join(' '), m.unmapped.length || m.notes.length ? 'info' : 'success', {
          duration: 15000,
          ...(hasSamples
            ? {
                action: {
                  label: 'Use for all samples',
                  run: () =>
                    useStore.getState().update((ws) => {
                      for (const s of ws.samples) s.compId = id;
                    }),
                },
              }
            : {}),
        });
      }
    } catch (e) {
      st.toast(`${f.name}: ${readableError(e)}`, 'error', { duration: 12000 });
    }
  }
  return ids;
}

/**
 * Save a matrix as text: tab-separated .txt (FlowLogic / FlowJo text import) or .csv, header row and first column of
 * channel names ($PnN), spillover as fractions (rows = fluorochromes).
 */
export async function exportMatrixFile(comp: Pick<CompDef, 'name' | 'channels' | 'matrix'>, format: 'txt' | 'csv'): Promise<boolean> {
  return saveFile(`${safeName(comp.name)}.${format}`, matrixToText(comp, format === 'txt' ? '\t' : ','));
}

/** The first file among `files` that replaces the current workspace when opened (workspace, bundle, FlowJo), or null. */
export async function replacingFile(files: File[]): Promise<File | null> {
  for (const f of files) {
    const n = f.name.toLowerCase();
    try {
      if (n.endsWith('.json') || n.endsWith('.wsp')) return f;
      if (n.endsWith('.flowjo')) {
        try {
          flowJo11Workspace(new Uint8Array(await f.arrayBuffer()), f.name);
          return f;
        } catch {
          continue; // not importable: reported when it is opened, the current workspace stays
        }
      }
      if (n.endsWith('.xml') && isFlowJoWorkspaceXml(await f.slice(0, 4096).text())) return f;
      if (n.endsWith('.zip')) {
        // a bundle, or a zip with a FlowJo workspace in it (a zip of FCS / Gating-ML files only adds to the workspace)
        const xml: string[] = [];
        const names: string[] = [];
        const got = unzipSync(new Uint8Array(await f.arrayBuffer()), {
          filter: (e) => {
            if (/(^|\/)(__MACOSX\/|\._)/.test(e.name)) return false;
            names.push(e.name);
            return /\.xml$/i.test(e.name);
          },
        });
        for (const k of Object.keys(got)) xml.push(strFromU8(got[k].subarray(0, 4096)));
        if (names.some((k) => /\.(flowstate|flowcanvas)\.json$/.test(k) || k.endsWith('workspace.json') || /\.wsp$/i.test(k))) return f;
        if (xml.some((t) => isFlowJoWorkspaceXml(t))) return f;
      }
    } catch {
      // unreadable files are reported when they are opened
    }
  }
  return null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The current workspace holds work worth keeping (not empty, not the example). */
function hasWork(ws: Workspace): boolean {
  if (ws.name === DEMO_NAME && ws.samples.every((s) => !engine.samples.get(s.id)?.bytes)) return false;
  return ws.samples.length > 0 || ws.populations.length > 0;
}

/**
 * Open files chosen or dropped by the user. A workspace, bundle or FlowJo workspace replaces the current work: when
 * there is work to lose, ask first (Save first / Replace / Cancel). FCS files only add samples; Gating-ML adds gates.
 */
export async function openFilesInteractive(files: File[]) {
  // while the last session is restored: wait for it (then it is the work that may be replaced)
  const waited = await fileLoadsReady();
  // there was no session to restore and the start showed the example meanwhile: FCS files replace it (as they do when
  // opened over the example, see App)
  const now = useStore.getState().ws;
  if (waited && now.name === DEMO_NAME && !hasWork(now) && files.every((f) => /\.(fcs|lmd)$/i.test(f.name))) newBlankWorkspace();
  const st = useStore.getState();
  const rep = hasWork(st.ws) ? await replacingFile(files) : null;
  if (!rep) return openFiles(files);
  const undo = undoBytesOk();
  const what = /\.wsp$|\.xml$|\.flowjo$/i.test(rep.name) ? 'FlowJo workspace' : /\.zip$/i.test(rep.name) ? 'workspace bundle' : 'workspace';
  st.setUI({
    dialog: {
      kind: 'confirm',
      payload: {
        title: 'Replace the current workspace?',
        text:
          `Opening the ${what} "${rep.name}" closes the current workspace "${st.ws.name}" (${plural(st.ws.samples.length, 'sample')}, ${plural(st.ws.populations.length, 'gate')}). ` +
          (undo ? 'You can go back to it with Undo (Ctrl+Z) until you close this page. ' : 'This cannot be undone: there is too much event data to keep both in memory. ') +
          '"Save first" saves the current workspace as .json, then opens the file.',
        ok: 'Replace',
        danger: true,
        onOk: () => void openFiles(files),
        extra: {
          label: 'Save first',
          run: () =>
            void saveWorkspaceJson().then((ok) => {
              if (ok) void openFiles(files);
              else useStore.getState().toast(`${rep.name} was not opened because the workspace was not saved.`, 'info');
            }),
        },
      } satisfies ConfirmExtraPayload,
    },
  });
}

/** Confirm dialog payload with an optional third button (see ui/Dialogs.tsx, kind 'confirm'). */
export interface ConfirmExtraPayload {
  title: string;
  text: string;
  ok: string;
  danger?: boolean;
  onOk: () => void;
  extra?: { label: string; run: () => void };
}

/** Event data kept in memory for Undo of an opened workspace at most (beyond this, opening clears the history). */
const UNDO_DATA_BUDGET = 1e9;

function sampleBytes(id: string): number {
  const sd = engine.samples.get(id);
  if (!sd) return 0;
  return sd.ds.data.reduce((a, d) => a + d.byteLength, 0) + (sd.bytes instanceof ArrayBuffer ? sd.bytes.byteLength : 0);
}

/** Samples still reachable by undo / redo (their event data must stay loaded). */
function reachableSampleIds(): Set<string> {
  const { ws, past, future } = useStore.getState();
  return new Set([ws, ...past, ...future].flatMap((w) => w.samples.map((s) => s.id)));
}

/** Whether the data of the current workspace (and its history) can stay in memory so opening another one can be undone. */
function undoBytesOk(): boolean {
  let total = 0;
  for (const id of reachableSampleIds()) total += sampleBytes(id);
  return total <= UNDO_DATA_BUDGET;
}

/**
 * The FlowJo XML workspace inside a FlowJo v11 ".flowjo" file (a zip). FlowJo 11 stores its analyses as JSON
 * (workbench.json, analyses/*.json), which cannot be imported: the error says how to get a .wsp instead.
 */
export function flowJo11Workspace(bytes: Uint8Array, fileName = 'workspace.flowjo'): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (e) => !/(^|\/)(__MACOSX\/|\._)/.test(e.name) && /\.(wsp|xml|json)$/i.test(e.name) });
  } catch {
    throw new Error(`${fileName} is not a FlowJo v11 workspace (not a zip file).`);
  }
  for (const [k, v] of Object.entries(entries)) {
    if (!/\.(wsp|xml)$/i.test(k)) continue;
    const text = strFromU8(v);
    if (isFlowJoWorkspaceXml(text)) return text;
  }
  const json = Object.keys(entries).some((k) => /(^|\/)workbench\.json$/i.test(k) || /(^|\/)analyses\/.*\.json$/i.test(k));
  throw new Error(
    json
      ? 'FlowJo v11 .flowjo workspaces store their analysis in a format (JSON) that cannot be imported yet. In FlowJo 11, export the workspace as a FlowJo 10 workspace (.wsp) and open that file here, together with its FCS files.'
      : `${fileName} does not contain a FlowJo workspace.`,
  );
}

/** Lower-case path segments of a relative path ("Plate 2/A1.fcs") or of a FlowJo DataSet uri (`uri`: %-escapes decoded). */
function pathSegments(p: string, uri = false): string[] {
  const segs = (uri ? p.trim().replace(/^file:/i, '') : p).split(/[\\/]+/).filter(Boolean);
  return segs.map((x) => {
    let v = x;
    if (uri)
      try {
        v = decodeURIComponent(x);
      } catch {
        /* not escaped */
      }
    return v.trim().toLowerCase();
  });
}

/** Number of trailing path segments two paths have in common (1: the file name only). */
function commonSuffix(a: string[], b: string[]): number {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}

/**
 * Where each sample of a FlowJo workspace was (its DataSet uri as path segments), in the order of its SampleList, which
 * is the order importFlowJo makes the samples in. A sample whose uri does not end in its file name (or a workspace whose
 * samples cannot be lined up) gets its file name only.
 */
function flowJoSamplePaths(xml: string, samples: { fileName: string }[]): string[][] {
  const byName = samples.map((s) => [s.fileName.trim().toLowerCase()]);
  const a = xml.indexOf('<SampleList');
  if (a < 0) return byName;
  const b = xml.indexOf('</SampleList>', a);
  const list = xml.slice(a, b > a ? b : undefined);
  const uris: string[] = [];
  // the DataSet of each Sample (SampleNode, SampleList and SampleRef do not match "<Sample" followed by a space or ">")
  for (const m of list.matchAll(/<Sample[\s>][\s\S]*?(?:<DataSet\b([^>]*)>|<\/Sample>)/g)) {
    const u = m[1] ? /\buri\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(m[1]) : null;
    let v = u ? u[1] ?? u[2] ?? '' : '';
    try {
      v = decodeEntities(v);
    } catch {
      /* kept as written */
    }
    uris.push(v);
  }
  if (uris.length !== samples.length) return byName;
  return samples.map((s, i) => {
    const segs = uris[i] ? pathSegments(uris[i], true) : [];
    return segs.length && segs[segs.length - 1] === byName[i][0] ? segs : byName[i];
  });
}

/**
 * $TOT, $FIL, $DATE, $BTIM ... of an FCS file from its HEADER and TEXT segment only (the events are not read); null when
 * it is not readable as FCS.
 */
async function fcsHeaderKeywords(f: Blob): Promise<Record<string, string> | null> {
  try {
    const head = new Uint8Array(await f.slice(0, 58).arrayBuffer());
    const ascii = (x: number, y: number) => String.fromCharCode(...head.subarray(x, y));
    if (head.length < 26 || ascii(0, 3) !== 'FCS') return null;
    const ts = parseInt(ascii(10, 18).trim(), 10);
    const te = parseInt(ascii(18, 26).trim(), 10);
    if (!(ts > 0 && te > ts && te - ts < 16 << 20)) return null;
    return parseTextSegment(new Uint8Array(await f.slice(ts, te + 1).arrayBuffer()));
  } catch {
    return null;
  }
}

/** Data of a file waiting to be read for openWorkspace: in memory (`bytes`) or read when its sample is loaded (`blob`). */
export interface WorkspaceFile {
  name: string;
  bytes?: Uint8Array;
  id?: string;
  parts?: FcsSample[];
  blob?: Blob;
}

/** Bytes of event data in memory now that stay when the workspace is replaced (kept for Undo, see openWorkspace). */
function dataKeptOnReplace(): number {
  return hasWork(useStore.getState().ws) && undoBytesOk() ? openDataBytes() : 0;
}

/** What importFlowJoText did with the FCS files given: those it used (linked, or left out on purpose), and whether the large-load question was asked. */
export interface FlowJoFilesResult {
  linked: Set<File>;
  asked: boolean;
}

/**
 * Open a FlowJo v10 workspace (.wsp) as a new workspace. FCS files among `fcsFiles` are linked to its samples right away:
 * by file name, where several samples or files share a name by the folders of their paths (the workspace's DataSet uri
 * against the path in the folder or zip opened), then by event count ($TOT) and $FIL / $DATE / $BTIM. Each file goes to
 * one sample; samples the files cannot be told apart for stay unlinked (reported). Files with other names are matched by
 * content (matchByContent). The other samples wait for their files ("drop them here to relink"). More event data than
 * the tab can keep asks first (confirmLargeLoad). Returns the files used (linked, or not to be loaded as new samples).
 * FlowJo's own counts are kept for the comparison table (dialog 'flowjoCounts').
 */
export async function importFlowJoText(xml: string, fileName: string, fcsFiles: File[] = []): Promise<FlowJoFilesResult> {
  const st = useStore.getState();
  const res = importFlowJo(xml, { name: fileName.replace(/\.(wsp|xml|flowjo)$/i, '') });
  let ws = res.workspace;
  const linked = new Set<File>();
  const notes: string[] = [];
  // ---- by file name (ignoring case, as on Windows / macOS file systems), then path, event count and keywords
  const samplePaths = flowJoSamplePaths(xml, ws.samples);
  const groups = new Map<string, { files: File[]; samples: number[] }>();
  ws.samples.forEach((s, i) => {
    const k = samplePaths[i][samplePaths[i].length - 1];
    const g = groups.get(k) ?? { files: [], samples: [] };
    g.samples.push(i);
    groups.set(k, g);
  });
  const rest: File[] = []; // no sample of this file name: matched by content below
  for (const f of fcsFiles) {
    const g = groups.get(f.name.trim().toLowerCase());
    if (g) g.files.push(f);
    else rest.push(f);
  }
  const fileOf = new Map<string, File>(); // sample id -> its file
  const nameClaimed = new Set<number>(); // samples whose file name came with the files (not matched by content)
  const unclear: string[] = [];
  for (const g of groups.values()) {
    if (!g.files.length) continue;
    for (const i of g.samples) nameClaimed.add(i);
    if (g.files.length === 1 && g.samples.length === 1) {
      fileOf.set(ws.samples[g.samples[0]].id, g.files[0]);
      continue;
    }
    // several samples or files of this name: the folders of their paths, then event count, then $FIL / $DATE / $BTIM
    const kws = new Map<File, Record<string, string> | null>();
    for (const f of g.files) kws.set(f, await fcsHeaderKeywords(f));
    const filePath = new Map(g.files.map((f) => [f, pathSegments(relativePathOf(f) || f.name)]));
    const score = (f: File, i: number): number[] => {
      const s = ws.samples[i];
      const kw = kws.get(f);
      const tot = Number(kw?.['$TOT']);
      const agree = (a?: string, b?: string, norm = (x: string) => x.trim().toLowerCase()) => (!a || !b ? 0 : norm(a) === norm(b) ? 1 : -1);
      const base = (x: string) => (x.split(/[\\/]/).pop() ?? x).trim().toLowerCase();
      return [
        commonSuffix(filePath.get(f)!, samplePaths[i]),
        Number.isFinite(tot) && s.eventCount > 0 ? (tot === s.eventCount ? 1 : -1) : 0,
        agree(kw?.['$FIL'], s.info?.['File'], base) + agree(kw?.['$DATE'], s.info?.['Date']) + agree(kw?.['$BTIM'], s.info?.['Start']),
      ];
    };
    const cmp = (a: number[], b: number[]) => {
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k];
      return 0;
    };
    // pairs that are each other's only best match, until none is left
    let files = [...g.files];
    let samples = [...g.samples];
    for (;;) {
      const bestOf = <T,>(cands: T[], sc: (c: T) => number[]): T | null => {
        let best: T | null = null;
        let bs: number[] | null = null;
        let tie = false;
        for (const c of cands) {
          const v = sc(c);
          const d = bs ? cmp(v, bs) : 1;
          if (d > 0) [best, bs, tie] = [c, v, false];
          else if (d === 0) tie = true;
        }
        return tie ? null : best;
      };
      const pairs: [File, number][] = [];
      for (const f of files) {
        const i = bestOf(samples, (j) => score(f, j));
        if (i !== null && bestOf(files, (x) => score(x, i)) === f) pairs.push([f, i]);
      }
      if (!pairs.length) break;
      for (const [f, i] of pairs) fileOf.set(ws.samples[i].id, f);
      files = files.filter((f) => !pairs.some((p) => p[0] === f));
      samples = samples.filter((i) => !pairs.some((p) => p[1] === i));
    }
    if (files.length && samples.length) {
      // not told apart: these samples stay unlinked, and the files are not loaded as new samples either
      for (const f of files) linked.add(f);
      unclear.push(`${ws.samples[samples[0]].fileName} (${plural(samples.length, 'sample')}, ${plural(files.length, 'file')})`);
    }
    // files left over once every sample of the name has one: other data, loaded as new samples (not used here)
  }
  const unclearNote = unclear.length
    ? [
        `Samples that share a file name could not be told apart from the files given (same folder name, event count, $FIL, $DATE and $BTIM), so they were left unlinked: ${unclear.slice(0, 3).join('; ')}${unclear.length > 3 ? ' ...' : ''}. Link them by hand (right-click the sample, "Locate file")`,
      ]
    : [];
  // ---- more event data than the tab can keep: ask before reading (the files linked by name and those to match by content)
  const byName = [...new Set(fileOf.values())];
  const ok = await confirmLargeLoad([...byName, ...rest], {
    openBytes: dataKeptOnReplace(),
    leftOutHint: (n) => `Their samples stay unlinked: drop ${n === 1 ? 'the file' : 'the files'} here later to relink.`,
  });
  if (!ok) {
    st.toast(`${fileName} was not opened.`, 'info');
    return { linked: new Set(fcsFiles), asked: true };
  }
  const skipped = new Set(ok.skipped);
  for (const f of skipped) linked.add(f);
  for (const [id, f] of [...fileOf]) {
    linked.add(f);
    if (skipped.has(f)) fileOf.delete(id);
  }
  const entries: WorkspaceFile[] = [...fileOf].map(([id, f]) => ({ name: f.name, id, blob: f }));
  // ---- other names (e.g. "HC Specimen_001_C2_C02 Peptide.fcs" for FlowJo's "Specimen_001_C2_C02 Peptide.fcs"): by content
  const parsedRest: { f: File; parts: FcsSample[] }[] = [];
  for (const f of rest) {
    if (skipped.has(f)) continue;
    try {
      parsedRest.push({ f, parts: parseFcsSamples(await f.arrayBuffer()) });
    } catch {
      // not readable: reported when it is loaded as a sample
    }
  }
  if (parsedRest.length) {
    const waiting = ws.samples.filter((_, i) => !nameClaimed.has(i));
    const cands = parsedRest.flatMap((r) => r.parts.map((p) => ({ r, p, c: linkCandidateOf(r.f.name, p.ds) })));
    const m = matchByContent(
      cands.map((x) => x.c),
      waiting,
    );
    const newName = new Map<string, string>();
    const ambiguous: string[] = [];
    cands.forEach((x, i) => {
      const hit = m[i];
      if (hit.sample) {
        linked.add(x.r.f);
        entries.push({ name: x.r.f.name, id: hit.sample.id, parts: x.r.parts, blob: x.r.f });
        fileOf.set(hit.sample.id, x.r.f);
        newName.set(hit.sample.id, x.r.f.name);
      } else if (hit.ambiguous?.length) {
        // not loaded as a new sample either: it belongs to one of these
        linked.add(x.r.f);
        ambiguous.push(`${x.r.f.name} (${hit.ambiguous.slice(0, 3).map((s) => `'${s.name}'`).join(', ')})`);
      }
    });
    if (newName.size) {
      // the samples now refer to the files they were linked to (later relinks look for these names)
      ws = produce(ws, (w) => {
        for (const s of w.samples) if (newName.has(s.id)) s.fileName = newName.get(s.id)!;
      });
      notes.push(`${newName.size} FCS file(s) with other names were linked by their $FIL keyword or file name and event count`);
    }
    if (ambiguous.length)
      notes.push(`${ambiguous.length} file(s) match several samples and were not loaded; link them by hand (right-click the sample, "Locate file"): ${ambiguous.slice(0, 3).join('; ')}${ambiguous.length > 3 ? ' ...' : ''}`);
  }
  // FlowJo's counts are kept with the workspace (saved with it) for the comparison table
  ws = { ...ws, flowjoCounts: { fileName, counts: res.counts } };
  const r = await openWorkspace(ws, entries, { quiet: true });
  // a linked file whose event count differs from the workspace's: perhaps not the file the analysis was made with
  const differ: string[] = [];
  for (const s of ws.samples) {
    const n = engine.samples.get(s.id)?.ds.eventCount;
    const f = fileOf.get(s.id);
    if (f && n !== undefined && s.eventCount > 0 && n !== s.eventCount) differ.push(`${relativePathOf(f) || f.name} (${n.toLocaleString('en-US')} events, the workspace has ${s.eventCount.toLocaleString('en-US')} for '${s.name}')`);
  }
  const differNote = differ.length
    ? [
        `${plural(differ.length, 'linked file')} ${differ.length === 1 ? 'has' : 'have'} another event count than the workspace, so ${differ.length === 1 ? 'it' : 'they'} may not be the file${differ.length === 1 ? '' : 's'} it was made with: ${differ.slice(0, 2).join('; ')}${differ.length > 2 ? ' ...' : ''}`,
      ]
    : [];
  st.setUI({ flowjoCounts: { fileName, counts: res.counts } });
  // what needs checking first (unlinked samples, files that may be the wrong ones), then the other notes
  const w = [...unclearNote, ...differNote, ...notes, ...res.warnings];
  const head = `FlowJo workspace opened (${r.loaded} of ${ws.samples.length} samples loaded${r.missing ? `; drop the ${r.missing} missing FCS file(s) here to relink` : ''})`;
  st.toast(
    `${head}.${w.length ? ` ${w.slice(0, 2).join(' · ')}${w.length > 2 ? ` (${w.length - 2} more notes in the browser console)` : ''}` : ''}`,
    r.missing || w.length ? 'info' : 'success',
    { action: { label: 'Compare counts', run: () => useStore.getState().setUI({ dialog: { kind: 'flowjoCounts' } }) }, duration: 12000 },
  );
  if (w.length) console.warn(w);
  return { linked, asked: ok.asked };
}

/**
 * Make `ws` the current workspace with the FCS files given (matched to samples by id, else by file name ignoring case).
 * Unless `restored`, the previous workspace stays reachable with Undo while its event data fit in memory
 * (UNDO_DATA_BUDGET); otherwise the history is cleared and its data are released.
 */
export async function openWorkspace(
  ws: Workspace,
  fcsFiles: WorkspaceFile[],
  opts: { restored?: boolean; quiet?: boolean; label?: string } = {},
): Promise<{ loaded: number; missing: number; undoable: boolean }> {
  const st = useStore.getState();
  const savedUi = pendingUi.get(ws);
  const repaired = repairNotes.get(ws);
  const lc = (n: string) => n.toLowerCase();
  const parsed: { id: string; ds: FcsDataset; buf: ArrayBuffer | Blob }[] = [];
  // data sets of the files matched by name (one file may serve several samples: one per data set); read once
  const partsOf = new Map<WorkspaceFile, FcsSample[]>();
  const read = async (f: WorkspaceFile): Promise<FcsSample[]> => {
    if (f.parts) return f.parts;
    const had = partsOf.get(f);
    if (had) return had;
    // the bytes as they are (no second copy), or the file read now (only one file's raw bytes in memory at a time)
    const b = f.bytes;
    const buf = b ? (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : await f.blob!.arrayBuffer();
    const parts = parseFcsSamples(buf as ArrayBuffer);
    if (!f.id) partsOf.set(f, parts);
    return parts;
  };
  // files given by name (no sample id): a file of several data sets serves every sample of its name (one data set
  // each), a file of one data set one sample (the one with its event count, else the first): never the data of two
  const withId = new Set(fcsFiles.map((x) => x.id).filter(Boolean));
  const byName = new Map<string, WorkspaceFile>(); // sample id -> file
  for (const f of fcsFiles) {
    if (f.id) continue;
    const n = lc(f.name);
    const cands = ws.samples.filter((s) => !withId.has(s.id) && !byName.has(s.id) && (n === lc(s.fileName) || n.endsWith('/' + lc(s.fileName))));
    if (!cands.length) continue;
    let parts: FcsSample[];
    try {
      parts = await read(f);
    } catch (e) {
      st.toast(`${f.name}: ${readableError(e)}`, 'error');
      continue;
    }
    if (parts.length > 1) for (const s of cands) byName.set(s.id, f);
    else byName.set((cands.find((s) => s.eventCount === parts[0].ds.eventCount) ?? cands[0]).id, f);
  }
  for (const s of ws.samples) {
    const f = fcsFiles.find((x) => x.id === s.id) ?? byName.get(s.id);
    if (!f) continue;
    try {
      // a file with several data sets (one per well): the one this sample was made from
      const parts = await read(f);
      const part = pickSample(parts, { index: datasetIndexOf(s), eventCount: s.eventCount || undefined });
      // a file of one data set that is on disk or stored in the browser (blob): kept as such, not a second copy in memory
      parsed.push({ id: s.id, ds: part.ds, buf: f.blob && parts.length === 1 ? f.blob : part.bytes });
    } catch (e) {
      st.toast(`${s.fileName}: ${readableError(e)}`, 'error');
    }
  }
  // channel names as the files have them: FlowJo writes "LIVE/DEAD Aqua-A" as "LIVE_DEAD Aqua-A" in its keywords, gates,
  // transforms and matrices; then channel units as the reader returns them (Time in seconds)
  const fileNames = parsed.map((p) => p.ds.channels.map((c) => c.name));
  const renames = parsed.map((p, i) => {
    const keep = new Set(fileNames.flatMap((n, j) => (j === i ? [] : n)));
    return flowJoChannelRenames(ws.samples.find((x) => x.id === p.id)?.channels.map((c) => c.name) ?? [], fileNames[i], keep);
  });
  if (renames.some((r) => r.size) || parsed.some((p) => p.ds.channels.some((c) => c.unit)))
    ws = produce(ws, (w) => {
      for (const r of renames) renameWorkspaceChannels(w as Workspace, r);
      for (const p of parsed) {
        const s = w.samples.find((x) => x.id === p.id);
        if (!s) continue;
        for (const c of s.channels as (SampleChannel & { unit?: string })[]) {
          const u = p.ds.channels.find((d) => d.name === c.name)?.unit;
          if (u && c.unit !== u) c.unit = u;
        }
      }
    });
  // a workspace saved with Time in raw ticks: convert with the files' $TIMESTEP (else when the first file is linked)
  if (hasTicksTime(ws) && parsed.length) {
    const steps = [...new Set(parsed.map((p) => p.ds.timeStep ?? 1))];
    if (steps.length > 1) st.toast(`The samples have different $TIMESTEP values (${steps.join(', ')}); Time gates were converted to seconds with ${steps[0]}.`, 'info');
    ws = produce(ws, (w) => convertTicksTime(w, steps[0]));
  }
  // the current workspace stays reachable by Undo while its data fit in memory
  const cur = st.ws;
  const undoable = !opts.restored && hasWork(cur) && undoBytesOk();
  const keep = undoable ? reachableSampleIds() : new Set<string>();
  for (const id of [...engine.samples.keys()]) if (!keep.has(id)) engine.removeSample(id);
  for (const p of parsed) engine.addSample(p.id, p.ds, p.buf);
  st.replaceWorkspace(ws, { keepHistory: undoable });
  const loaded = parsed.length;
  const missing = ws.samples.filter((s) => !engine.has(s.id)).map((s) => s.fileName);
  st.setUI((u) => ({
    dataVersion: u.dataVersion + 1,
    missingFiles: missing,
    activeSampleId: ws.samples.find((s) => engine.has(s.id))?.id ?? null,
  }));
  // back where the user was: active sample, sheet, view
  restoreSavedUi(savedUi);
  if (repaired?.length) {
    st.toast(
      `${opts.restored ? 'The saved session' : 'This workspace'} had damaged entries, which were repaired or removed: ${repaired.slice(0, 2).join('; ')}${repaired.length > 2 ? ` (${repaired.length - 2} more ${repaired.length === 3 ? 'note' : 'notes'} in the browser console)` : ''}. Check the result before saving over the file.`,
      'info',
      { duration: 20000 },
    );
    console.warn('Workspace repaired:', repaired);
  }
  const gm = gateChannelsMissing(useStore.getState().ws);
  if (gm.size) warnMissingGateChannels(gm);
  if (!opts.quiet) {
    const after = useStore.getState().ws;
    const action = undoable
      ? {
          label: 'Undo',
          run: () => {
            const s = useStore.getState();
            if (s.ws === after) s.undo();
            else s.toast('Other changes were made since. Use Undo (Ctrl+Z) to step back.', 'info');
          },
        }
      : undefined;
    const what = opts.label ? `Opened ${opts.label}` : opts.restored ? 'Last session restored' : 'Workspace opened';
    const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
    if (missing.length) st.toast(`${what}. ${n(missing.length, 'FCS file')} missing: drop them here to relink.`, 'info', { action });
    else st.toast(`${what} (${n(loaded, 'sample')})`, 'success', { action });
  }
  return { loaded, missing: missing.length, undoable };
}

/** A workspace bundle's workspace file among the entries of a zip. */
const isBundleWorkspace = (k: string) => /\.(flowstate|flowcanvas)\.json$/.test(k) || k.endsWith('workspace.json');
const isMacFork = (k: string) => /(^|\/)(__MACOSX\/|\._)/.test(k);

async function openBundle(bytes: Uint8Array) {
  // the list of entries (names, unpacked sizes) first: event data are unpacked only for the files that are loaded
  const sizes = new Map<string, number>();
  let files: Record<string, Uint8Array>;
  const unzip = (want: (name: string) => boolean) => {
    try {
      return unzipSync(bytes, {
        filter: (e) => {
          sizes.set(e.name, e.originalSize);
          return want(e.name);
        },
      });
    } catch (e) {
      throw new Error(`not a readable zip archive: it may be damaged or incomplete (${String((e as Error)?.message ?? e).slice(0, 80)})`);
    }
  };
  files = unzip(isBundleWorkspace);
  const wsName = Object.keys(files).find(isBundleWorkspace);
  if (wsName) {
    const ws = parseWorkspace(strFromU8(files[wsName]));
    const ids = new Set(ws.samples.map((s) => s.id));
    // fcs/<sampleId>/<fileName>: an FCS file whatever its name (samples read from CSV keep their .csv name)
    const keys = [...sizes.keys()].filter((k) => /\.(fcs|lmd)$/i.test(k) || /(?:^|\/)fcs\/[^/]+\/[^/]+$/.test(k));
    let wanted = keys.map((k) => {
      const m = /(?:^|\/)fcs\/([^/]+)\/[^/]+$/.exec(k); // fcs/<sampleId>/<fileName>
      return { key: k, name: k.split('/').pop()!, size: sizes.get(k) ?? 0, id: m && ids.has(m[1]) ? m[1] : undefined };
    });
    if (!wanted.some((f) => f.id)) {
      // older bundles: fcs/<fileName>, with "_" prepended to repeated names in sample order
      const byPath = new Map(keys.map((k) => [k.replace(/^.*?fcs\//, ''), k]));
      const used = new Set<string>();
      for (const s of ws.samples) {
        let name = s.fileName || s.name + '.fcs';
        while (used.has(name)) name = '_' + name;
        used.add(name);
        const key = byPath.get(name);
        if (key) wanted.push({ key, name: s.fileName, size: sizes.get(key) ?? 0, id: s.id });
      }
      // an entry that went to a sample is not offered by name as well (nor counted twice for the memory question)
      const withId = new Set(wanted.filter((f) => f.id).map((f) => f.key));
      wanted = wanted.filter((f) => f.id || !withId.has(f.key));
    }
    // more event data than the tab can keep: ask first (left out samples wait for their files, to be relinked)
    const ok = await confirmLargeLoad(wanted, {
      openBytes: dataKeptOnReplace(),
      leftOutHint: (n) => `${n === 1 ? 'Its sample waits' : 'Their samples wait'} for ${n === 1 ? 'the file' : 'the files'}: drop ${n === 1 ? 'it' : 'them'} here later to relink.`,
    });
    if (!ok) return;
    wanted = ok.load;
    const take = new Set(wanted.map((f) => f.key));
    files = take.size ? unzip((k) => take.has(k)) : {};
    const fcs: WorkspaceFile[] = wanted.filter((f) => files[f.key]).map((f) => ({ name: f.name, bytes: files[f.key], id: f.id }));
    files = {}; // (the entries are referenced by `fcs` only: each is released once its sample is read)
    await openWorkspace(ws, fcs);
    return;
  }
  // a plain zip of FCS / xml files (a FlowJo .wsp in it is opened with the FCS files it refers to); each file keeps its
  // path in the zip (folders tell plates apart, and samples of a FlowJo workspace that share a file name)
  files = unzip((k) => !isMacFork(k) && /\.(fcs|lmd|xml|wsp)$/i.test(k));
  const list: File[] = [];
  for (const [k, v] of Object.entries(files)) {
    const f = new File([v as BlobPart], k.split('/').pop()!);
    setRelativePath(f, k);
    list.push(f);
  }
  files = {};
  if (!list.length) throw new Error('the zip archive holds no FlowState workspace, FCS, FlowJo or Gating-ML files.');
  await openFiles(list);
}

function sameMatrix(a: CompDef, b: CompDef): boolean {
  if (a.channels.length !== b.channels.length || a.channels.some((c, i) => c !== b.channels[i])) return false;
  return a.matrix.every((row, i) => row.every((v, j) => Math.abs(v - (b.matrix[i]?.[j] ?? NaN)) < 1e-9));
}

/**
 * Add the gates of a Gating-ML document. Each gate keeps its own compensation reference ('uncompensated', 'FCS' or a
 * matrix), as other software evaluates it; the samples keep their compensation. Matrices of the document are added under
 * a readable name (an identical matrix already in the workspace is reused).
 */
export function importGatingMLText(xml: string, fileName = 'Gating-ML') {
  const st = useStore.getState();
  const res = importGatingML(xml, { perGateComp: true });
  const file = fileName.replace(/\.xml$/i, '').replace(/\.gating-ml$/i, '');
  const idMap = new Map<string, string>();
  const added: string[] = [];
  const reused: string[] = [];
  st.update((ws) => {
    const names = new Set(ws.compensations.map((c) => c.name));
    for (const c of res.compensations) {
      const same = ws.compensations.find((x) => sameMatrix(x as CompDef, c));
      if (same) {
        idMap.set(c.id, same.id);
        reused.push(same.name);
        continue;
      }
      const id = ws.compensations.some((x) => x.id === c.id) ? uid('comp') : c.id;
      const base = res.compensations.length > 1 ? `Gating-ML: ${file} (${c.name})` : `Gating-ML: ${file}`;
      let name = base;
      for (let k = 2; names.has(name); k++) name = `${base} ${k}`;
      names.add(name);
      ws.compensations.push({ ...c, id, name });
      idMap.set(c.id, id);
      added.push(name);
    }
    const remap = (g: GateGeom): GateGeom => (g.comp && idMap.has(g.comp) && idMap.get(g.comp) !== g.comp ? { ...g, comp: idMap.get(g.comp) } : g);
    let ci = ws.populations.length;
    for (const p of res.populations) {
      if (!p.color) p.color = GATE_COLORS[ci++ % GATE_COLORS.length];
      p.gate = remap(p.gate);
      if (p.overrides) for (const k of Object.keys(p.overrides)) p.overrides[k] = remap(p.overrides[k]);
      ws.populations.push(p);
    }
    for (const [ch, def] of Object.entries(res.scales)) if (!ws.scales[ch]) ws.scales[ch] = def;
  });
  const w = res.warnings;
  const q = (a: string[]) => a.map((n) => `"${n}"`).join(', ');
  const comp = added.length
    ? ` Its compensation matrix was added as ${q(added)}: the gates use it, the samples keep their own compensation.`
    : reused.length
      ? ` Its gates use the matrix ${q([...new Set(reused)])}; the samples keep their own compensation.`
      : '';
  st.toast(
    `Imported ${res.populations.length} gates from Gating-ML.${comp}${w.length ? ` ${w.slice(0, 2).join(' · ')}${w.length > 2 ? ` (${w.length - 2} more notes in the browser console)` : ''}` : ''}`,
    w.length ? 'info' : 'success',
    comp ? { duration: 9000 } : {},
  );
  if (w.length) console.warn(w);
  // gates on parameters none of the loaded files has (e.g. "FL1-A" for files with "FITC-A") count no events: say so
  const gm = gateChannelsMissing(useStore.getState().ws);
  if (gm.size) warnMissingGateChannels(gm);
}

/** One Gating-ML document of an export: its file name, the instruments whose samples it is for, the document. */
export interface GmlExportFile {
  fileName: string;
  /** instruments (display names) whose samples the document counts as the app does; empty: all samples */
  instruments: string[];
  doc: GmlExport;
  /** names of the gates whose position or scales differ between the files (empty for a single file) */
  differing?: string[];
}

/**
 * The workspace as the samples `sids` (of one instrument) see it: a population whose sample-specific gate is the same for
 * all of them gets that gate as its shared one (e.g. a gate kept per instrument when an axis was refitted); a population
 * with no sample-specific gate among them loses the others' copies. Mixed cases keep their copies for these samples
 * (the export notes that the shared position was used).
 */
function workspaceForSamples(ws: Workspace, sids: string[]): Workspace {
  if (!sids.length || !ws.populations.some((p) => p.overrides && Object.keys(p.overrides).length)) return ws;
  const populations = ws.populations.map((p) => {
    if (!p.overrides || !Object.keys(p.overrides).length) return p;
    const ovs = sids.map((s) => p.overrides?.[s]);
    const { overrides: _drop, ...rest } = p;
    if (ovs.every((g) => !g)) return rest;
    const first = JSON.stringify(ovs[0]);
    if (ovs[0] && ovs.every((g) => g && JSON.stringify(g) === first)) return { ...rest, gate: ovs[0] };
    return { ...rest, overrides: Object.fromEntries(sids.flatMap((s) => (p.overrides?.[s] ? [[s, p.overrides[s]]] : []))) };
  });
  return { ...ws, populations };
}

/**
 * The Gating-ML documents of the workspace's gates. A Gating-ML document holds one position and one scale per gate, but
 * the app can evaluate a gate differently on the samples of different instruments: polygon and ellipse gates drawn in the
 * app follow the axis scale of each sample's instrument (Workspace.instrumentScales), and a gate can have a position of
 * its own for all samples of an instrument (kept per instrument when an axis was refitted). Each instrument gets the
 * document that counts its samples as the app does; instruments whose documents are the same share one file. Usually
 * that is a single document, exact for all samples.
 */
export function gatingMLExportFiles(ws: Workspace): GmlExportFile[] {
  const base = safeName(ws.name);
  const own = Object.keys(ws.instrumentScales ?? {}).filter((k) => Object.keys(ws.instrumentScales?.[k] ?? {}).length);
  const of = ws.samples.map((s) => sampleInstrument(ws, s.id, engine.keywordsOf));
  const shared = [...new Set(of.filter((k) => !own.includes(k)))];
  const names = [...own, ...shared.filter(Boolean)];
  const label = (k: string) => instrumentDisplayName(k, names) || 'unknown instrument';
  // instruments on the workspace scales first (all of them together without samples), then those with own scales
  const groups: { keys: string[]; ownScales: boolean; sids: string[] }[] = [];
  if (!ws.samples.length) groups.push({ keys: [], ownScales: false, sids: [] });
  for (const k of shared) groups.push({ keys: [k], ownScales: false, sids: ws.samples.filter((_, i) => of[i] === k).map((s) => s.id) });
  for (const k of own) if (of.includes(k) || !ws.samples.length) groups.push({ keys: [k], ownScales: true, sids: ws.samples.filter((_, i) => of[i] === k).map((s) => s.id) });
  const docs = groups.map((g) => {
    const w = workspaceForSamples(ws, g.sids);
    return { g, w, doc: exportGatingMLDoc(w, g.ownScales ? { instrument: g.keys[0] } : {}) };
  });
  // instruments whose documents are the same share a file
  const merged: { keys: string[]; ownScales: boolean; doc: GmlExport; w: Workspace }[] = [];
  for (const d of docs) {
    const same = merged.find((m) => m.doc.xml === d.doc.xml);
    if (same) {
      same.keys.push(...d.g.keys);
      same.ownScales &&= d.g.ownScales;
    } else merged.push({ keys: [...d.g.keys], ownScales: d.g.ownScales, doc: d.doc, w: d.w });
  }
  if (merged.length === 1) return [{ fileName: `${base}.gating-ml.xml`, instruments: [], doc: merged[0].doc }];
  // the gates that differ between the files (their position or the scales they are evaluated in)
  const gateKey = (w: Workspace, popId: string, k: string | undefined) => {
    const g = w.populations.find((p) => p.id === popId)?.gate;
    if (!g) return '';
    if (g.type !== 'polygon' && g.type !== 'ellipse') return JSON.stringify(g);
    const sc = (ch: string, own?: unknown) => own ?? (k ? ws.instrumentScales?.[k]?.[ch] : undefined) ?? ws.scales[ch];
    return JSON.stringify([g, sc(g.x, g.scales?.x), sc(g.y, g.scales?.y)]);
  };
  const differing = ws.populations
    .filter((p) => new Set(merged.map((m) => gateKey(m.w, p.id, m.ownScales ? m.keys[0] : undefined))).size > 1)
    .map((p) => p.name);
  const used = new Set<string>();
  const fileOf = (part: string) => {
    let f = `${base} - ${safeName(part)}.gating-ml.xml`;
    for (let k = 2; used.has(f.toLowerCase()); k++) f = `${base} - ${safeName(part)} ${k}.gating-ml.xml`;
    used.add(f.toLowerCase());
    return f;
  };
  return merged.map((m) => {
    const insts = m.keys.map(label);
    return { fileName: fileOf(insts.length === 1 ? insts[0] : !m.keys.length || !m.ownScales ? 'workspace scales' : insts.join(' + ')), instruments: insts, doc: m.doc, differing };
  });
}

export async function exportGatingMLFile() {
  const ws = useStore.getState().ws;
  if (!ws.populations.length) {
    useStore.getState().toast('There are no gates to export yet.', 'info');
    return;
  }
  let files: GmlExportFile[];
  try {
    files = gatingMLExportFiles(ws);
  } catch (e) {
    console.error(e);
    useStore.getState().toast(`The gates could not be exported as Gating-ML (unexpected error: ${(e as Error)?.message ?? String(e)}). Check the gates for damaged entries.`, 'error');
    return;
  }
  const one = files.length === 1;
  const ok = one
    ? await saveFile(files[0].fileName, files[0].doc.xml)
    : await saveFile(`${safeName(ws.name)}.gating-ml.zip`, zipSync(Object.fromEntries(files.map((f) => [f.fileName, strToU8(f.doc.xml)]))));
  if (!ok) return;
  for (const msg of [...new Set(files.flatMap((f) => f.doc.warnings))]) useStore.getState().toast(msg, 'info');
  if (!one) {
    const dep = files[0].differing?.length ? files[0].differing : instrumentDependentGates(ws).map((p) => p.name);
    const ex = dep.slice(0, 2).map((n) => `"${n}"`).join(', ') + (dep.length > 2 ? ` and ${dep.length - 2} more` : '');
    useStore
      .getState()
      .toast(
        `${dep.length} gate${dep.length > 1 ? 's are' : ' is'} (${ex}) evaluated differently on the samples of each instrument (own axis scales or an own position), and a Gating-ML file holds one position and scale per gate: saved a zip with one Gating-ML file per instrument (${files.map((f) => f.instruments.join(' / ') || 'workspace scales').join(', ')}). Use each sample's instrument file: with another instrument's file, other programs can count these gates completely differently (e.g. none instead of all events).`,
        'info',
        { duration: 20000 },
      );
  }
}

// ------------------------------------------------------------ population export

/**
 * Exported FCS files: the value of a computed channel (MESF, size, ...) that has no value for an event (outside the
 * calibrated range), and the keyword that records it. CSV files leave such cells empty.
 */
export const NO_VALUE = -1;
export const NO_VALUE_KEYWORD = 'FLOWSTATE_NOVALUE';

export async function exportPopulation(sampleIds: string[], popId: string, format: 'fcs' | 'csv', compensated: boolean) {
  const st = useStore.getState();
  const ws = st.ws;
  const files: Record<string, Uint8Array> = {};
  const popName = popId === 'root' ? 'All' : ws.populations.find((p) => p.id === popId)?.name ?? 'pop';
  const usedNames = new Set<string>();
  for (const sid of sampleIds) {
    const sd = engine.samples.get(sid);
    const s = ws.samples.find((x) => x.id === sid);
    if (!sd || !s) continue;
    const idx = engine.population(ws, sid, popId);
    // the file's channels compensated or not, as chosen; computed channels (MESF, size, ...) always as the app shows
    // them, from the sample's own compensation (from uncompensated fluorescence they would be other values entirely)
    const own = engine.data(ws, sid, compensated ? undefined : null);
    const all = engine.columns(ws, sid);
    if (!all || !own) continue;
    const nBase = sd.ds.channels.length;
    let noValue = false;
    const cols = [...own, ...all.data.slice(nBase)].map((a, k) => {
      const out = new Float32Array(idx.length);
      for (let i = 0; i < idx.length; i++) out[i] = a[idx[i]];
      // computed channels use NaN for "no value" (e.g. outside the size calibration range): FCS readers expect numbers,
      // so FCS files get NO_VALUE (noted in the FLOWSTATE_NOVALUE keyword); CSV files an empty cell (populationCsv)
      if (k >= nBase && format === 'fcs')
        for (let i = 0; i < out.length; i++)
          if (!Number.isFinite(out[i])) {
            out[i] = NO_VALUE;
            noValue = true;
          }
      return out;
    });
    const chans = all.names.map((n, k) => (k < nBase ? sd.ds.channels[k] : { name: n, label: all.labels[k], range: all.ranges[k] }));
    // samples may share a name: number repeats (case-insensitive, for file systems that ignore case)
    const base0 = safeName(`${s.name}_${popName}`);
    let base = base0;
    for (let k = 2; usedNames.has(base.toLowerCase()); k++) base = `${base0}_${k}`;
    usedNames.add(base.toLowerCase());
    if (format === 'fcs') {
      const kw = exportKeywords(sd.ds, engine.compFor(ws, sid), compensated);
      kw.$FIL = base + '.fcs';
      kw.$COM = `Exported by ${APP_NAME}: population ${popName}${compensated ? ' (compensated values)' : ''}${chans.length > nBase ? '; computed channels from compensated values' : ''}`;
      // the value written for "no value" in computed channels (always noted when there are computed channels)
      if (chans.length > nBase || noValue) kw[NO_VALUE_KEYWORD] = String(NO_VALUE);
      files[base + '.fcs'] = writeFcs({ channels: chans, data: cols, keywords: kw });
    } else files[base + '.csv'] = strToU8(populationCsv(chans, cols));
  }
  const names = Object.keys(files);
  if (!names.length) return;
  if (names.length === 1 && format === 'csv') await saveFile(names[0], files[names[0]]);
  else await saveFile(safeName(`${ws.name}_${popName}_${format}`) + '.zip', zipSync(files));
}

const CYTEXPERT_COMP = /^(COMP[AH]|COMPCH[AH]|COMPBG[AH]|COMPAF[AH]|COMPGAIN[AH]|USCOMP|AHCOMPSYNC)$/;

/**
 * Keywords of an exported FCS file. Compensated values: no spillover keywords (they must not be compensated again).
 * Uncompensated values: $SPILLOVER is the matrix the sample uses in the app (when it differs from the file's own), so
 * FlowJo, FlowLogic, CytExpert or Kaluza compensate the events as the app does; the other spillover keywords are
 * dropped then, so no program picks an outdated matrix.
 */
export function exportKeywords(ds: FcsDataset, comp: CompDef | null, compensated: boolean): Record<string, string> {
  const kw: Record<string, string> = { ...ds.keywords };
  const dropMatrices = () => {
    for (const k of SPILL_KEYS) delete kw[k];
    // CytExpert's own matrix keywords (COMPA / COMPH and their channels, backgrounds, gains; USCOMP = compensation on)
    for (const k of Object.keys(kw)) if (CYTEXPERT_COMP.test(k)) delete kw[k];
  };
  if (compensated) {
    dropMatrices();
    return kw;
  }
  if (!comp) return kw;
  const present = new Set(ds.channels.map((c) => c.name));
  const keep = comp.channels.map((c, i) => [c, i] as const).filter(([c]) => present.has(c));
  if (keep.length < 2) return kw;
  const channels = keep.map(([c]) => c);
  const matrix = keep.map(([, i]) => keep.map(([, j]) => comp.matrix[i][j]));
  const own = getSpillover(ds);
  const same = own && own.channels.length === channels.length && own.channels.every((c, i) => c === channels[i]) && own.matrix.every((r, i) => r.every((v, j) => Math.abs(v - matrix[i][j]) < 1e-9));
  if (same) return kw;
  dropMatrices();
  kw.$SPILLOVER = spilloverKeyword(channels, matrix);
  return kw;
}

/**
 * A population as CSV: header "name :: label" (as FlowJo writes it), values that read back to the same float32; an
 * empty cell where there is no value (NaN, e.g. a computed channel outside its calibrated range).
 */
export function populationCsv(chans: { name: string; label?: string }[], cols: Float32Array[]): string {
  const header = chans.map((c) => (c.label ? `${c.name} :: ${c.label}` : c.name));
  const lines = [header.map(csvCell).join(',')];
  const n = cols.length ? cols[0].length : 0;
  for (let i = 0; i < n; i++) lines.push(cols.map((c) => (Number.isFinite(c[i]) ? fmtNum(c[i]) : '')).join(','));
  return lines.join('\n');
}

/** Shortest decimal form that reads back to the same float32 value (7 significant digits are not always enough). */
export function fmtNum(v: number) {
  if (Number.isInteger(v)) return String(v);
  for (let p = 7; p < 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(Number(s)) === v) return String(Number(s));
  }
  return String(Number(v.toPrecision(9)));
}

export function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function newBlankWorkspace(setup?: ExperimentSetup) {
  const st = useStore.getState();
  void clearSession();
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  st.replaceWorkspace(setup ? { ...emptyWorkspace(), setup: { ...setup } } : emptyWorkspace());
  st.setUI((u) => ({ dataVersion: u.dataVersion + 1, missingFiles: [], activeSampleId: null }));
}

export { addDataset, uid };
