// Live computation for the unmixing view: signatures of the controls, autofluorescence, the definition the draft
// would apply, quality metrics and spreading. Runs asynchronously (yielding between controls) and caches per control,
// so editing names or switching the method does not recompute signatures.
import { useEffect, useRef, useState } from 'react';
import { engine } from '../../core/engine';
import type { Workspace } from '../../core/model';
import {
  afSignatures,
  autoSelectPopulations,
  buildSignature,
  controlSpread,
  createUnmixDef,
  estimateNoiseSD,
  resolveDetectors,
  unmixQuality,
  type Endmember,
  type EventSet,
  type QualityReport,
  type UnmixDef,
} from '../../core/unmix';
import type { Draft, DerivedWithSetup, SetupControl } from './draft';
import { capIndices } from './helpers';

export interface RowResult {
  /** ok: computed from the control; stored: control not loaded, signature of the applied definition; library: imported */
  kind: 'ok' | 'stored' | 'library' | 'error';
  error?: string;
  /** the error can be overridden by the user ('weak': no distinct stained population) */
  overridable?: 'weak';
  warnings: string[];
  signature?: number[];
  raw?: number[];
  peak?: number;
  nPos?: number;
  nNeg?: number;
  negSource?: 'control' | 'unstained' | 'population';
  pos?: EventSet;
  neg?: EventSet;
  source?: string;
}

export interface AfOut {
  kind: 'computed' | 'stored' | 'library';
  endmembers: Endmember[];
  warnings: string[];
  nEvents?: number;
}

export interface SpreadOut {
  names: string[];
  /** endmember index of each control row used */
  rows: number[];
  ssm: number[][];
  leakage: number[][];
}

export interface Live {
  draftId: string | null;
  rows: Record<string, RowResult>;
  af: AfOut | null;
  afError?: string;
  noiseSD?: number[];
  /** definition from the valid controls */
  def: UnmixDef | null;
  /** every control has a signature (the definition can be applied) */
  complete: boolean;
  /** control row index of each endmember of `def` */
  used: number[];
  problems: string[];
  quality: QualityReport | null;
  spread: SpreadOut | null;
  spreadError?: string;
  pending: boolean;
  /** controls being (re)computed */
  computing: Set<string>;
}

const EMPTY: Live = { draftId: null, rows: {}, af: null, def: null, complete: false, used: [], problems: [], quality: null, spread: null, pending: false, computing: new Set() };

// ------------------------------------------------------------------ event sets

function sampleDs(id: string | null | undefined) {
  return id ? engine.samples.get(id)?.ds ?? null : null;
}

function popIdx(ws: Workspace, sampleId: string, pop: string): Uint32Array | null {
  if (!pop || pop === 'root') return null;
  return engine.population(ws, sampleId, pop);
}

function eventSet(sampleId: string, detectors: string[], idx: Uint32Array | null): { set: EventSet | null; missing: string[] } {
  const ds = sampleDs(sampleId);
  if (!ds) return { set: null, missing: [] };
  const names = ds.channels.map((c) => c.name);
  const di = resolveDetectors({ detectors }, names);
  const missing = detectors.filter((_, i) => di[i] < 0);
  if (missing.length) return { set: null, missing };
  return { set: { columns: ds.data, detectorIndex: di, idx, ranges: di.map((i) => ds.channels[i].range) }, missing };
}

/** FSC-A and SSC-A columns of a sample (with their ranges) for the automatic selection, if it has them. */
function scatterOf(sampleId: string): { values: Float32Array; range: number }[] | undefined {
  const ds = sampleDs(sampleId);
  if (!ds) return undefined;
  const find = (re: RegExp) => ds.channels.findIndex((c) => re.test(c.name.trim()));
  const out = [find(/^FSC[-_ ]?A$/i), find(/^SSC[-_ ]?A$/i)].filter((i) => i >= 0).map((i) => ({ values: ds.data[i], range: ds.channels[i].range }));
  return out.length ? out : undefined;
}

/**
 * Controls whose signatures peak in the same detector: one of them is probably wrong (e.g. debris picked instead of the
 * stain) or the two fluorochromes are too similar to unmix. Adds a warning to each (copies; cached rows stay intact).
 */
export function annotateSharedPeaks(rows: Record<string, RowResult>, controls: { key: string; name?: string }[], detectors: string[]): Record<string, RowResult> {
  const byPeak = new Map<number, string[]>();
  for (const c of controls) {
    const r = rows[c.key];
    if (!r || r.kind === 'error' || r.peak === undefined || !r.signature) continue;
    byPeak.set(r.peak, [...(byPeak.get(r.peak) ?? []), c.key]);
  }
  const out = { ...rows };
  const nameOf = new Map(controls.map((c) => [c.key, c.name || rows[c.key]?.source || 'another control']));
  for (const [peak, keys] of byPeak) {
    if (keys.length < 2) continue;
    for (const k of keys) {
      const others = keys.filter((x) => x !== k).map((x) => `'${nameOf.get(x)}'`);
      out[k] = { ...out[k], warnings: [...out[k].warnings, `Same peak detector (${detectors[peak] ?? peak + 1}) as ${others.join(', ')}: check the positive selection of these controls`] };
    }
  }
  return out;
}

/** Values of a signature given over `from` detectors on the `to` detectors (null + missing names if incomplete). */
export function mapSignature(from: string[], sig: number[], to: string[]): { sig: number[] | null; missing: string[] } {
  const lower = from.map((d) => d.toLowerCase());
  const out: number[] = [];
  const missing: string[] = [];
  for (const d of to) {
    let i = from.indexOf(d);
    if (i < 0) i = lower.indexOf(d.toLowerCase());
    if (i < 0) missing.push(d);
    else out.push(sig[i]);
  }
  return missing.length ? { sig: null, missing } : { sig: out, missing };
}

const argmax = (a: number[]) => a.reduce((b, v, i) => (v > a[b] ? i : b), 0);

const fmtList = (a: string[], n = 4) => (a.length > n ? `${a.slice(0, n).join(', ')} and ${a.length - n} more` : a.join(', '));

/** Fraction of control events below which a "control" has no stained population (an unstained sample gives 0.5 %). */
export const MIN_STAINED_FRACTION = 0.015;

function quantileOf(v: Float32Array, idx: ArrayLike<number> | null | undefined, q: number, cap = 200000): number {
  const n = idx ? idx.length : v.length;
  if (!n) return NaN;
  const step = Math.max(1, Math.floor(n / cap));
  const a: number[] = [];
  for (let i = 0; i < n; i += step) {
    const x = v[idx ? idx[i] : i];
    if (x === x) a.push(x);
  }
  a.sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))] : NaN;
}

/**
 * Fraction of the control's events (in the selection gate) brighter than 99.5 % of the unstained sample in detector
 * `d`. About 0.005 for an unstained sample; real single-stain controls are well above (cells with a dim, rare marker
 * a few %).
 */
export function stainedFraction(ctl: EventSet, un: EventSet, d: number): number {
  const thr = quantileOf(un.columns[un.detectorIndex[d]], un.idx, 0.995);
  const col = ctl.columns[ctl.detectorIndex[d]];
  const idx = ctl.idx;
  const n = idx ? idx.length : col.length;
  if (!n || !Number.isFinite(thr)) return NaN;
  let k = 0;
  for (let i = 0; i < n; i++) if (col[idx ? idx[i] : i] > thr) k++;
  return k / n;
}

/** Cosine similarity of two spectra. */
export function cosine(a: number[], b: number[]): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : NaN;
}

/** Spectra closer to autofluorescence than this get a warning (is the control stained at all?). */
export const AF_SIMILARITY_WARN = 0.95;

/** Rows whose signature is very similar to an autofluorescence spectrum get a warning (copies; cached rows stay intact). */
export function annotateAfSimilarity(rows: Record<string, RowResult>, af: AfOut | null): Record<string, RowResult> {
  if (!af?.endmembers.length) return rows;
  const out: Record<string, RowResult> = {};
  for (const [k, r] of Object.entries(rows)) {
    if (!r.signature || r.kind === 'error') {
      out[k] = r;
      continue;
    }
    let best = -1;
    let name = '';
    for (const a of af.endmembers) {
      const c = cosine(r.signature, a.signature);
      if (c > best) {
        best = c;
        name = a.name;
      }
    }
    out[k] =
      best > AF_SIMILARITY_WARN
        ? { ...r, warnings: [...r.warnings, `Spectrum is very similar to autofluorescence${af.endmembers.length > 1 ? ` (${name})` : ''}: cosine ${best.toFixed(3)}. Is this control stained?`] }
        : r;
  }
  return out;
}

// ------------------------------------------------------------------ one control

function storedRow(applied: DerivedWithSetup | undefined, index: number, detectors: string[], why: string): RowResult | null {
  const em = applied?.unmix.endmembers[index];
  if (!applied || !em) return null;
  const m = mapSignature(applied.unmix.detectors, em.signature, detectors);
  if (!m.sig) return { kind: 'error', error: `${why}; the stored signature lacks ${fmtList(m.missing)}`, warnings: [] };
  return { kind: 'stored', warnings: [`${why}: using the signature stored with the definition`], signature: m.sig, peak: argmax(m.sig), nPos: em.nPos, nNeg: em.nNeg, source: em.source };
}

export function computeRow(ws: Workspace, draft: Draft, row: SetupControl, index: number, applied: DerivedWithSetup | undefined, un: EventSet | null): RowResult {
  const det = draft.detectors;
  if (row.fixed) {
    const m = mapSignature(row.fixed.detectors, row.fixed.signature, det);
    if (!m.sig) return { kind: 'error', error: `Library spectrum has no values for ${fmtList(m.missing)}`, warnings: [] };
    if (!(Math.max(...m.sig) > 0)) return { kind: 'error', error: 'Library spectrum has no positive values on the selected detectors', warnings: [] };
    return { kind: 'library', warnings: [], signature: m.sig, peak: argmax(m.sig), source: row.fixed.source ?? 'library' };
  }
  if (!row.sampleId || !ws.samples.some((s) => s.id === row.sampleId)) return storedRow(applied, index, det, 'Control sample removed') ?? { kind: 'error', error: 'The control sample is no longer in the workspace', warnings: [] };
  if (!engine.has(row.sampleId)) return storedRow(applied, index, det, 'Control file not loaded') ?? { kind: 'error', error: 'Control file not loaded: add the FCS file again', warnings: [] };
  if (row.sampleId === draft.setup.unstainedId) return { kind: 'error', error: 'This is the unstained sample; choose another unstained sample or remove this row', warnings: [] };
  const scope = draft.setup.scope;
  const scopeIdx = popIdx(ws, row.sampleId, scope);
  const { set: ctl, missing } = eventSet(row.sampleId, det, scopeIdx);
  if (!ctl) return { kind: 'error', error: missing.length ? `Detectors missing in this sample: ${fmtList(missing)}` : 'Control not loaded', warnings: [] };
  if (scopeIdx && scopeIdx.length < 20) return { kind: 'error', error: `Only ${scopeIdx.length} events in the selected gate`, warnings: [] };
  if (row.neg === 'unstained' && !un) return { kind: 'error', error: 'Negative "Unstained": choose an unstained sample under Autofluorescence', warnings: [] };
  try {
    // the fluorochrome named in the sample (known peak detectors) and its scatter (bead population, aggregates)
    const sref = ws.samples.find((s) => s.id === row.sampleId);
    const opts = {
      unstained: un ?? undefined,
      detectorNames: det,
      negativeFrom: (row.neg === 'unstained' ? 'unstained' : 'auto') as 'unstained' | 'auto',
      fluorochrome: [row.name, sref?.name, sref?.info?.['Tube']].filter(Boolean).join(' / '),
      scatter: scatterOf(row.sampleId),
    };
    const needAuto = row.pos === 'auto' || row.neg === 'auto' || row.neg === 'unstained';
    const sel = needAuto ? autoSelectPopulations(ctl, opts) : null;
    let pos: EventSet;
    let neg: EventSet;
    let negSource: RowResult['negSource'];
    // whole positive population: every event above the negatives in the same peak detector (not only the top 3 %)
    if (row.pos === 'auto' && draft.setup.posMode === 'all') pos = autoSelectPopulations(ctl, { ...opts, topFraction: 1, peakDetector: sel!.peak }).positive;
    else if (row.pos === 'auto') pos = sel!.positive;
    else {
      const idx = popIdx(ws, row.sampleId, row.pos);
      if (!idx || !idx.length) return { kind: 'error', error: 'The positive population has no events in this sample', warnings: [] };
      pos = { ...ctl, idx };
    }
    if (row.neg === 'auto' || row.neg === 'unstained') {
      neg = sel!.negative;
      negSource = sel!.negSource;
    } else {
      const idx = popIdx(ws, row.sampleId, row.neg);
      if (!idx || !idx.length) return { kind: 'error', error: 'The negative population has no events in this sample', warnings: [] };
      neg = { ...ctl, idx };
      negSource = 'population';
    }
    const posN = pos.idx ? pos.idx.length : 0;
    if (posN < 3) return { kind: 'error', error: sel?.warnings[0] ?? 'No positive events', warnings: sel?.warnings ?? [] };
    const res = buildSignature(pos, neg, { detectorNames: det });
    const warnings = [...(sel && row.pos === 'auto' ? sel.warnings : []), ...res.warnings];
    if (res.signature.every((v) => v === 0)) return { kind: 'error', error: 'No positive signal above the negative population', warnings };
    // a "control" without a stained population (e.g. a second unstained file) would add autofluorescence as a fluorochrome
    if (un) {
      const f = stainedFraction(ctl, un, res.peak);
      if (f < MIN_STAINED_FRACTION) {
        const why = `No stained population: only ${(100 * f).toFixed(2)} % of the events are brighter than 99.5 % of the unstained sample in ${det[res.peak]} (an unstained sample gives 0.5 %)`;
        if (!row.allowWeak) return { kind: 'error', overridable: 'weak', error: `${why}. Is this a stained control?`, warnings, signature: undefined, peak: res.peak };
        warnings.unshift(`${why}; used anyway (override)`);
      }
    }
    return { kind: 'ok', warnings: [...new Set(warnings)], signature: res.signature, raw: res.raw, peak: res.peak, nPos: res.nPos, nNeg: res.nNeg, negSource, pos, neg, source: ws.samples.find((s) => s.id === row.sampleId)?.name };
  } catch (e) {
    return { kind: 'error', error: (e as Error).message, warnings: [] };
  }
}

/** Event set of the unstained sample (restricted to the selection gate), with an error if unusable. */
export function unstainedSet(ws: Workspace, draft: Draft): { un: EventSet | null; unIdx: Uint32Array | null; unError?: string } {
  const unId = draft.setup.unstainedId;
  if (!unId) return { un: null, unIdx: null };
  // the engine may still hold the data of a sample removed from the workspace (undo): do not use it
  if (!ws.samples.some((s) => s.id === unId)) return { un: null, unIdx: null, unError: 'The unstained sample was removed from the workspace' };
  if (!engine.has(unId)) return { un: null, unIdx: null };
  const idx = popIdx(ws, unId, draft.setup.scope);
  const r = eventSet(unId, draft.detectors, idx);
  if (!r.set) return { un: null, unIdx: idx, unError: r.missing.length ? `Unstained sample lacks ${fmtList(r.missing)}` : 'Unstained sample not loaded' };
  if (idx && idx.length < 50) return { un: null, unIdx: idx, unError: `Only ${idx.length} unstained events in the selected gate` };
  return { un: r.set, unIdx: idx };
}

// ------------------------------------------------------------------ caches

interface CacheEntry<T> {
  deps: unknown[];
  value: T;
}
const rowCache = new Map<string, CacheEntry<RowResult>>();
const afCache = new Map<string, CacheEntry<{ af: AfOut | null; noiseSD?: number[]; error?: string }>>();
const spreadCache = new Map<string, CacheEntry<{ spread: SpreadOut | null; error?: string }>>();

function same(a: unknown[], b: unknown[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function cached<T>(m: Map<string, CacheEntry<T>>, key: string, deps: unknown[]): T | undefined {
  const c = m.get(key);
  return c && same(c.deps, deps) ? c.value : undefined;
}

function rowDeps(ws: Workspace, draft: Draft, row: SetupControl, index: number, applied: DerivedWithSetup | undefined, unIdx: unknown): unknown[] {
  const sid = row.sampleId ?? '';
  const loaded = !!sid && engine.has(sid);
  const pops = loaded ? [draft.setup.scope, row.pos, row.neg].map((p) => (p === 'auto' || p === 'unstained' ? p : popIdx(ws, sid, p))) : [];
  return [
    sid,
    loaded ? sampleDs(sid) : null,
    // the fluorochrome hint of the automatic selection comes from these names
    row.name,
    ws.samples.find((s) => s.id === sid)?.name,
    ws.samples.some((s) => s.id === sid),
    draft.detectors.join('\n'),
    row.pos,
    row.neg,
    row.fixed?.signature,
    draft.setup.unstainedId,
    sampleDs(draft.setup.unstainedId),
    ws.samples.some((s) => s.id === draft.setup.unstainedId),
    unIdx,
    draft.setup.posMode ?? 'top',
    !!row.allowWeak,
    // the applied definition matters only as the fallback for a control that is not loaded
    !row.fixed && !loaded ? applied?.unmix : null,
    !row.fixed && !loaded ? index : -1,
    ...pops,
  ];
}

// ------------------------------------------------------------------ definition from results

export function buildDraftDef(draft: Draft, rows: Record<string, RowResult>, af: AfOut | null, noiseSD?: number[]): { def: UnmixDef | null; complete: boolean; used: number[]; problems: string[] } {
  const problems: string[] = [];
  const endmembers: Endmember[] = [];
  const used: number[] = [];
  draft.setup.controls.forEach((r, i) => {
    const res = rows[r.key];
    if (!res || !res.signature) {
      if (res?.error) problems.push(`${r.name}: ${res.error}`);
      return;
    }
    endmembers.push({ name: r.name.trim() || `Endmember ${i + 1}`, signature: res.signature, raw: res.raw, peak: res.peak, source: res.source, nPos: res.nPos, nNeg: res.nNeg });
    used.push(i);
  });
  const names = endmembers.map((e) => e.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) problems.push(`Duplicate endmember name${dup.length > 1 ? 's' : ''}: ${[...new Set(dup)].join(', ')}`);
  if (!draft.detectors.length) problems.push('Select detectors');
  if (!draft.setup.controls.length) problems.push('Add single-stained controls');
  const afs = af?.endmembers ?? [];
  if (draft.includeAF && !afs.length) problems.push('Autofluorescence is treated as a channel but no unstained sample is chosen');
  const nEnd = endmembers.length + (draft.includeAF ? (afs.length > 1 && draft.afMode === 'best' ? 1 : afs.length) : 0);
  if (nEnd > draft.detectors.length) problems.push(`More endmembers (${nEnd}) than detectors (${draft.detectors.length})`);
  const complete = !!draft.detectors.length && used.length === draft.setup.controls.length && used.length > 0 && !dup.length && !(draft.includeAF && !afs.length) && nEnd <= draft.detectors.length;
  if (!endmembers.length || !draft.detectors.length) return { def: null, complete: false, used, problems };
  const def = createUnmixDef({
    id: draft.id,
    name: draft.name.trim() || 'Spectral unmixing',
    detectors: [...draft.detectors],
    endmembers,
    af: afs.length ? afs : undefined,
    includeAF: draft.includeAF && afs.length > 0,
    afMode: afs.length > 1 ? draft.afMode : undefined,
    method: draft.method,
    nonNegative: draft.method === 'wls' && draft.nonNegative ? true : undefined,
    noiseSD,
    residual: draft.residual,
    created: draft.created,
  });
  return { def, complete, used, problems };
}

function defKey(def: UnmixDef): string {
  const af = def.includeAF ? def.af ?? [] : [];
  return JSON.stringify([def.detectors, def.endmembers.map((e) => e.signature), af.map((a) => a.signature), def.method, def.nonNegative, def.afMode, def.noiseSD?.length]);
}

// ------------------------------------------------------------------ hook

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Max events per control population used for the spreading matrix (per method cost). */
const SPREAD_CAP = { ols: 20000, wls: 4000, nnls: 4000 } as const;

export function useUnmixLive(draft: Draft | null, ws: Workspace, dataVersion: number): Live {
  const [live, setLive] = useState<Live>(EMPTY);
  const gen = useRef(0);
  useEffect(() => {
    if (!draft) {
      setLive(EMPTY);
      return;
    }
    const my = ++gen.current;
    const alive = () => gen.current === my;
    const applied = ws.derived?.find((d) => d.id === draft.id && d.kind === 'unmix') as DerivedWithSetup | undefined;
    (async () => {
      setLive((l) => ({ ...(l.draftId === draft.id ? l : EMPTY), draftId: draft.id, pending: true }));
      // unstained sample (negatives, AF, noise)
      const unId = draft.setup.unstainedId;
      const { un, unIdx, unError } = unstainedSet(ws, draft);
      // controls: cached results first, then compute the others one by one
      const rows: Record<string, RowResult> = {};
      const todo: { i: number; row: SetupControl; deps: unknown[] }[] = [];
      draft.setup.controls.forEach((row, i) => {
        const deps = rowDeps(ws, draft, row, i, applied, unIdx);
        const res = cached(rowCache, row.key, deps);
        if (res) rows[row.key] = res;
        else todo.push({ i, row, deps });
      });
      setLive((l) => ({ ...l, rows: { ...l.rows, ...rows }, computing: new Set(todo.map((t) => t.row.key)) }));
      for (const t of todo) {
        await tick();
        if (!alive()) return;
        const res = computeRow(ws, draft, t.row, t.i, applied, un);
        rowCache.set(t.row.key, { deps: t.deps, value: res });
        rows[t.row.key] = res;
        setLive((l) => {
          const computing = new Set(l.computing);
          computing.delete(t.row.key);
          return { ...l, rows: { ...l.rows, [t.row.key]: res }, computing };
        });
      }
      // autofluorescence + noise
      const unGone = !!unId && (!engine.has(unId) || !ws.samples.some((s) => s.id === unId));
      const afDeps = [unId, sampleDs(unId), unIdx, draft.setup.afK, draft.detectors.join('\n'), draft.setup.afFixed, unGone ? applied?.unmix : null, unError];
      const afKey = draft.id;
      let afv = cached(afCache, afKey, afDeps);
      if (!afv) {
        await tick();
        if (!alive()) return;
        afv = computeAf(draft, un, unError, applied);
        afCache.set(afKey, { deps: afDeps, value: afv });
      }
      // AF similarity warnings on copies: the cached row results (and the spreading cache keyed on them) stay intact
      const shown = annotateSharedPeaks(annotateAfSimilarity(rows, afv.af), draft.setup.controls, draft.detectors);
      const b = buildDraftDef(draft, shown, afv.af, afv.noiseSD);
      let quality: QualityReport | null = null;
      try {
        quality = b.def ? unmixQuality(b.def) : null;
      } catch {
        quality = null;
      }
      setLive((l) => ({ ...l, rows: { ...shown }, af: afv!.af, afError: afv!.error, noiseSD: afv!.noiseSD, def: b.def, complete: b.complete, used: b.used, problems: b.problems, quality }));
      // spreading after unmixing, from the controls' own positive / negative events
      let spread: SpreadOut | null = null;
      let spreadError: string | undefined;
      if (b.def) {
        const ctl = b.used.map((ri, k) => ({ k, r: rows[draft.setup.controls[ri].key] })).filter((x) => x.r.kind === 'ok' && x.r.pos && x.r.neg);
        const sDeps = [defKey(b.def), ...ctl.map((c) => c.r), ...ctl.map((c) => c.k)];
        const sv = cached(spreadCache, draft.id, sDeps);
        if (sv) ({ spread, error: spreadError } = sv);
        else if (ctl.length) {
          await tick();
          if (!alive()) return;
          const cap = SPREAD_CAP[b.def.method];
          try {
            const sub = (s: EventSet): EventSet => ({ ...s, idx: capIndices(s.idx ?? Uint32Array.from({ length: s.columns[s.detectorIndex[0]]?.length ?? 0 }, (_, i) => i), cap) });
            const res = controlSpread(
              b.def,
              ctl.map((c) => ({ endmember: c.k, pos: sub(c.r.pos!), neg: sub(c.r.neg!) })),
            );
            spread = { ...res, rows: ctl.map((c) => c.k) };
          } catch (e) {
            spreadError = (e as Error).message;
          }
          spreadCache.set(draft.id, { deps: sDeps, value: { spread, error: spreadError } });
        }
      }
      if (!alive()) return;
      setLive((l) => ({ ...l, spread, spreadError, pending: false }));
    })();
  }, [draft, ws, dataVersion]);
  return live.draftId === (draft?.id ?? null) ? live : { ...EMPTY, draftId: draft?.id ?? null, pending: !!draft };
}

export function computeAf(draft: Draft, un: EventSet | null, unError: string | undefined, applied: DerivedWithSetup | undefined): { af: AfOut | null; noiseSD?: number[]; error?: string } {
  const det = draft.detectors;
  if (un) {
    try {
      const r = afSignatures(un, { k: draft.setup.afK });
      const n = un.idx ? un.idx.length : un.columns[un.detectorIndex[0]]?.length ?? 0;
      return { af: { kind: 'computed', endmembers: r.endmembers, warnings: r.warnings, nEvents: n }, noiseSD: estimateNoiseSD(un) };
    } catch (e) {
      return { af: null, error: (e as Error).message };
    }
  }
  if (draft.setup.unstainedId && applied?.unmix.af?.length) {
    const ems: Endmember[] = [];
    for (const a of applied.unmix.af) {
      const m = mapSignature(applied.unmix.detectors, a.signature, det);
      if (!m.sig) return { af: null, error: unError ?? `Stored AF signature lacks ${fmtList(m.missing)}` };
      ems.push({ ...a, signature: m.sig });
    }
    const noise = applied.unmix.noiseSD && applied.unmix.detectors.join('\n') === det.join('\n') ? applied.unmix.noiseSD : undefined;
    const why = unError === 'The unstained sample was removed from the workspace' ? 'Unstained sample removed from the workspace' : 'Unstained file not loaded';
    return { af: { kind: 'stored', endmembers: ems, warnings: [`${why}: using the AF signature stored with the applied unmixing`] }, noiseSD: noise, error: unError };
  }
  if (!draft.setup.unstainedId && draft.setup.afFixed?.length) {
    const ems: Endmember[] = [];
    for (const a of draft.setup.afFixed) {
      const m = mapSignature(a.detectors, a.signature, det);
      if (!m.sig) return { af: null, error: `Library AF spectrum lacks ${fmtList(m.missing)}` };
      ems.push({ name: a.name, signature: m.sig, peak: argmax(m.sig), source: 'library' });
    }
    return { af: { kind: 'library', endmembers: ems, warnings: [] } };
  }
  return { af: null, error: unError ?? (draft.setup.unstainedId && !engine.has(draft.setup.unstainedId) ? 'Unstained file not loaded' : undefined) };
}
