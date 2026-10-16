// Editable unmixing setups (drafts). A draft is the UI state of one unmixing definition: controls, detectors, AF and
// method. Drafts live in a small store of their own so edits survive switching views; "Apply" writes the definition
// (with the setup, so it can be edited again after reloading the workspace) to Workspace.derived.
import { create } from 'zustand';
import { engine } from '../../core/engine';
import { uid, type Workspace } from '../../core/model';
import type { UnmixDerived } from '../../core/derived';
import { defaultDetectors, endmemberNameFromSample, type UnmixMethod } from '../../core/unmix';
import { looksLikeControl, looksLikeUnstained, uniqueName } from './helpers';
import { onWorkspaceReplaced, useStore } from '../../state/store';

export interface SetupControl {
  /** stable row id */
  key: string;
  /** control sample (absent for library spectra) */
  sampleId?: string;
  /** sample name when the row was made (shown if the sample is gone) */
  sampleName?: string;
  /** endmember (output channel) name */
  name: string;
  /** marker shown as the output channel's label, e.g. "CD4" */
  marker?: string;
  /** positive events: 'auto' or a population id */
  pos: string;
  /** negative events: 'auto' | 'unstained' | a population id */
  neg: string;
  /** colour slot (stable per row) */
  color: number;
  /** library spectrum (imported CSV) instead of a control sample */
  fixed?: { detectors: string[]; signature: number[]; source?: string };
  /** use the control although no distinct stained population was found (explicit override) */
  allowWeak?: boolean;
}

export interface UnmixSetup {
  v: 1;
  controls: SetupControl[];
  /** events used for automatic selection ('root' = all events) */
  scope: string;
  unstainedId: string | null;
  afK: number;
  /** AF spectra from a library (used when no unstained sample is chosen) */
  afFixed?: { name: string; detectors: string[]; signature: number[] }[];
  showHW?: boolean;
  /** automatic positives: the brightest 3 % (default) or every event above the negative population */
  posMode?: 'top' | 'all';
}

export interface Draft {
  id: string;
  name: string;
  detectors: string[];
  method: UnmixMethod;
  nonNegative: boolean;
  includeAF: boolean;
  afMode: 'best' | 'all';
  residual: 'none' | 'ssr' | 'rms';
  setup: UnmixSetup;
  created?: string;
  /** note shown once, e.g. which samples were added automatically */
  note?: string;
  /** sample ids of the workspace the draft was made in (tells drafts of another workspace apart) */
  origin?: string[];
}

export type DerivedWithSetup = UnmixDerived & { setup?: UnmixSetup };

interface DraftStore {
  drafts: Record<string, Draft>;
  selectedId: string | null;
  /** sample ids of the workspace a first draft was created for automatically (once per workspace) */
  autoInitIds: string[] | null;
  /** the user opened the Unmixing view: a first draft may be made from the single-stain controls (once) */
  autoRequested: boolean;
  setDraft: (d: Draft) => void;
  dropDraft: (id: string) => void;
  select: (id: string | null) => void;
}

export const useDrafts = create<DraftStore>((set) => ({
  drafts: {},
  selectedId: null,
  autoInitIds: null,
  autoRequested: false,
  setDraft: (d) => set((s) => ({ drafts: { ...s.drafts, [d.id]: d } })),
  dropDraft: (id) =>
    set((s) => {
      const drafts = { ...s.drafts };
      delete drafts[id];
      return { drafts, selectedId: s.selectedId === id ? null : s.selectedId };
    }),
  select: (id) => set({ selectedId: id }),
}));

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// drafts belong to the workspace they were made in: a new or opened workspace starts without any
onWorkspaceReplaced(() => useDrafts.setState({ drafts: {}, selectedId: null, autoInitIds: null, autoRequested: false }));

/**
 * Open the Unmixing view on the user's request (ribbon button, view tab). Only then is a first draft made by itself,
 * and only when the workspace has samples that look like single-stain controls.
 */
export function openUnmixView() {
  useDrafts.setState({ autoRequested: true });
  useStore.getState().setUI({ view: 'unmix' });
}

/** Next free colour slot (slots of existing rows are kept so colours follow the endmember). */
export function nextColor(controls: SetupControl[]): number {
  const used = new Set(controls.map((c) => c.color));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

export function controlRow(ws: Workspace, sampleId: string, existing: SetupControl[]): SetupControl {
  const s = ws.samples.find((x) => x.id === sampleId);
  const name = uniqueName(endmemberNameFromSample(s?.name ?? 'Endmember'), existing.map((c) => c.name));
  return { key: uid('uc'), sampleId, sampleName: s?.name, name, pos: 'auto', neg: 'auto', color: nextColor(existing) };
}

export function loadedSamples(ws: Workspace) {
  return ws.samples.filter((s) => engine.has(s.id));
}

/** Samples that look like single-stain controls, and the most likely unstained sample. */
export function guessControls(ws: Workspace): { controls: string[]; unstained: string | null } {
  const loaded = loadedSamples(ws);
  const unstained = loaded.find((s) => looksLikeUnstained(s.name))?.id ?? null;
  return { controls: loaded.filter((s) => s.id !== unstained && looksLikeControl(s.name)).map((s) => s.id), unstained };
}

/** Default detectors from the first loaded control (else the first loaded sample). */
export function defaultDetectorsFor(ws: Workspace, sampleIds: (string | undefined | null)[]): string[] {
  const id = sampleIds.find((x) => x && engine.has(x)) ?? loadedSamples(ws)[0]?.id;
  const ds = id ? engine.samples.get(id)?.ds : undefined;
  return ds ? defaultDetectors(ds) : [];
}

export function newDraft(ws: Workspace, opts: { guess?: boolean; name?: string } = {}): Draft {
  const taken = new Set((ws.derived ?? []).map((d) => d.name));
  for (const d of Object.values(useDrafts.getState().drafts)) taken.add(d.name);
  const g = opts.guess ? guessControls(ws) : { controls: [], unstained: null };
  const controls: SetupControl[] = [];
  for (const id of g.controls) controls.push(controlRow(ws, id, controls));
  const d: Draft = {
    id: `unmix_${uid('u').slice(2)}`,
    name: opts.name ?? uniqueName('Spectral unmixing', taken),
    detectors: defaultDetectorsFor(ws, [...g.controls, g.unstained]),
    method: 'ols',
    nonNegative: false,
    includeAF: false,
    afMode: 'best',
    residual: 'none',
    setup: { v: 1, controls, scope: 'root', unstainedId: g.unstained, afK: 1 },
    origin: ws.samples.slice(0, 200).map((x) => x.id),
  };
  if (opts.guess && (controls.length || g.unstained)) {
    const parts: string[] = [];
    if (controls.length) parts.push(`${controls.length} sample${controls.length > 1 ? 's' : ''} that look like single-stain controls`);
    if (g.unstained) parts.push(`"${ws.samples.find((s) => s.id === g.unstained)?.name}" as the unstained sample`);
    d.note = `Added ${parts.join(' and ')}. Remove or add controls as needed.`;
  }
  return d;
}

/** Draft for an existing definition: its stored setup, or library rows made from its signatures. */
export function draftFromDef(def: DerivedWithSetup): Draft {
  const u = def.unmix;
  const setup: UnmixSetup =
    def.setup && def.setup.v === 1
      ? clone(def.setup)
      : {
          v: 1,
          controls: u.endmembers.map((e, i) => ({
            key: uid('uc'),
            name: e.name,
            pos: 'auto',
            neg: 'auto',
            color: i,
            fixed: { detectors: [...u.detectors], signature: [...e.signature], source: e.source },
          })),
          scope: 'root',
          unstainedId: null,
          afK: Math.max(1, u.af?.length ?? 1),
          afFixed: u.af?.map((a) => ({ name: a.name, detectors: [...u.detectors], signature: [...a.signature] })),
        };
  // markers from the output labels
  def.outputs.forEach((o, i) => {
    const c = setup.controls[i];
    if (c && o.label && !c.marker) c.marker = o.label;
  });
  return {
    id: def.id,
    name: def.name,
    detectors: [...u.detectors],
    method: u.method,
    nonNegative: !!u.nonNegative,
    includeAF: u.includeAF && !!u.af?.length,
    afMode: u.afMode ?? 'best',
    residual: u.residual ?? 'none',
    setup,
    created: u.created,
  };
}

/** Copy of a draft under a new id and name (not applied). */
export function duplicateDraft(d: Draft, taken: Iterable<string>): Draft {
  const c = clone(d);
  c.id = `unmix_${uid('u').slice(2)}`;
  c.name = uniqueName(`${d.name} copy`, taken);
  c.created = undefined;
  c.note = undefined;
  c.setup.controls = c.setup.controls.map((r) => ({ ...r, key: uid('uc') }));
  return c;
}
