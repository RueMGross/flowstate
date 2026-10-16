// Computation engine: holds event data and memoizes compensation, transforms, gating and statistics.
// Workspace objects are immutable, so object identity is used for cache invalidation.
//
// Memory: everything derived from the event data (compensated channels, display arrays, population indices, channel
// statistics, derived channels) lives in one byte-budgeted LRU cache (see ByteCache). Entries are keyed by sample and
// definition id and checked against the definition object, so older versions of a definition (kept alive by the undo
// history) no longer keep their arrays alive; least recently used entries are dropped when the budget is exceeded,
// cheap ones (statistics, display arrays) first, and recomputed when needed again. Results are always the same.
//
// Background work: derived channels that are expensive (spectral unmixing of large samples) are computed in Web
// Workers (src/workers/pool.ts) when requested while rendering a plot (see `deferred`); the plot shows "computing" and
// the engine notifies its subscribers when the result is in. Everything else (tables, exports, statistics) gets exact
// values synchronously, also when a background job for them is still running.
import { compensate } from './compensation';
import { computeDerived, type DerivedDef } from './derived';
import { getSpillover, type FcsDataset } from './fcs';
import { allIndices, applyGate, type GateContext } from './gating';
import { isAncestorPop, popById, type GateGeom, type Population, type StatColumn, type Workspace, type CompDef } from './model';
import { applies, popNotApplicableReason, resolveStatCol, statNotApplicableReason } from './scope';
import { channelStats, statFromChannel, type ChannelStats } from './stats';
import { scaleFor as scaleForSample } from './instruments';
import { makeScale, type ScaleDef } from './transforms';

export interface SampleData {
  id: string;
  ds: FcsDataset;
  index: Map<string, number>;
  /**
   * the original file (for bundles and the browser session): in memory, or a Blob read only when needed (a file the
   * user opened, or one stored in the browser), which keeps large files from taking memory twice
   */
  bytes?: ArrayBuffer | Blob;
}

interface PopEntry {
  deps: unknown[];
  idx: Uint32Array;
}

function depsEqual(a: unknown[], b: unknown[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const FALLBACK_SCALE: ScaleDef = { type: 'linear', min: 0, max: 262144 };
const NO_EVENTS = new Uint32Array(0);

// ------------------------------------------------------------------ byte-budgeted LRU

/** Cache entry kinds, cheapest to recompute first (eviction order). */
export type CacheKind = 'stats' | 'disp' | 'pop' | 'comp' | 'derived';
const EVICT_ORDER: CacheKind[][] = [['stats'], ['stats', 'disp'], ['stats', 'disp', 'pop'], ['stats', 'disp', 'pop', 'comp', 'derived']];

interface CacheEntry {
  kind: CacheKind;
  bytes: number;
  v: unknown;
}

/**
 * LRU cache with a byte budget. `get` marks an entry as recently used; `set` evicts least recently used entries until the
 * cache is below 90 % of the budget, trying the cheap kinds first. Entries still referenced by a caller stay valid for
 * that caller (they are only dropped from the cache).
 */
export class ByteCache {
  private m = new Map<string, CacheEntry>();
  bytes = 0;
  evictions = 0;
  constructor(public budget: number) {}

  get(key: string): CacheEntry | undefined {
    const e = this.m.get(key);
    if (e) {
      this.m.delete(key);
      this.m.set(key, e);
    }
    return e;
  }

  peek(key: string): CacheEntry | undefined {
    return this.m.get(key);
  }

  set(key: string, kind: CacheKind, v: unknown, bytes: number) {
    const old = this.m.get(key);
    if (old) {
      this.bytes -= old.bytes;
      this.m.delete(key);
    }
    this.m.set(key, { kind, v, bytes });
    this.bytes += bytes;
    if (this.bytes > this.budget) this.evict(key);
  }

  delete(key: string) {
    const e = this.m.get(key);
    if (!e) return;
    this.bytes -= e.bytes;
    this.m.delete(key);
  }

  /** Drop all entries whose key starts with `prefix`. */
  deletePrefix(prefix: string) {
    for (const [k, e] of this.m)
      if (k.startsWith(prefix)) {
        this.bytes -= e.bytes;
        this.m.delete(k);
      }
  }

  evict(keep?: string) {
    const target = this.budget * 0.9;
    for (const kinds of EVICT_ORDER) {
      if (this.bytes <= target) return;
      for (const [k, e] of this.m) {
        if (this.bytes <= target) return;
        if (k === keep || !kinds.includes(e.kind)) continue;
        this.m.delete(k);
        this.bytes -= e.bytes;
        this.evictions++;
      }
    }
  }

  clear() {
    this.m.clear();
    this.bytes = 0;
  }

  stats(): Record<CacheKind, { n: number; bytes: number }> {
    const out = { stats: { n: 0, bytes: 0 }, disp: { n: 0, bytes: 0 }, pop: { n: 0, bytes: 0 }, comp: { n: 0, bytes: 0 }, derived: { n: 0, bytes: 0 } };
    for (const e of this.m.values()) {
      out[e.kind].n++;
      out[e.kind].bytes += e.bytes;
    }
    return out;
  }
}

/**
 * Default cache budget: a quarter of the device memory (navigator.deviceMemory, which browsers cap at 8 GB), at least
 * 512 MB and at most 2 GB; 1 GB when the browser does not tell. The event data themselves are not part of it.
 */
export function defaultCacheBudget(): number {
  const dm = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  const gb = typeof dm === 'number' && dm > 0 ? dm : 4;
  return Math.round(Math.min(2048, Math.max(512, gb * 256)) * 1024 * 1024);
}

// stable small ids for definition objects used in cache keys (scales are compared by identity)
const objIds = new WeakMap<object, number>();
let nextObjId = 1;
function objId(o: object): number {
  let id = objIds.get(o);
  if (id === undefined) objIds.set(o, (id = nextObjId++));
  return id;
}

const overrideKey = (override: CompDef | null | undefined) => (override === undefined ? '' : override ? 'c:' + override.id : 'none');

const bytesOf = (arrays: (ArrayBufferView | null | undefined)[]) => arrays.reduce((s, a) => s + (a ? a.byteLength : 0), 0);

/** Background (worker) computation of derived channels, installed by src/workers/derivedJobs.ts. */
export interface DerivedRunner {
  /** Whether a definition is worth a background job for a sample of n events (else it is computed right away). */
  wants(def: DerivedDef, nEvents: number): boolean;
  /**
   * Start the job; resolves with the outputs (or null if the sample lacks inputs), rejects on failure. `signal`: the
   * engine no longer needs the result (a newer definition superseded it, the sample was removed, it was computed here):
   * work not started yet is dropped.
   */
  run(def: DerivedDef, columns: Float32Array[], names: string[], signal?: AbortSignal): Promise<Float32Array[] | null>;
}

export interface EngineMemory {
  budgetMB: number;
  cachedMB: number;
  byKind: Record<CacheKind, { n: number; mb: number }>;
  evictions: number;
  /** parsed event data of all samples (not evictable) */
  sampleDataMB: number;
  /** original file bytes kept for bundles / autosave */
  fileBytesMB: number;
  rootsMB: number;
}

/** Size of an original file kept with a sample (in memory or as a Blob). */
export const fileByteSize = (b: ArrayBuffer | Blob | undefined | null): number => (!b ? 0 : b instanceof ArrayBuffer ? b.byteLength : b.size);

/** The bytes of an original file kept with a sample (a Blob is read). */
export async function fileBytes(b: ArrayBuffer | Blob): Promise<Uint8Array> {
  return new Uint8Array(b instanceof ArrayBuffer ? b : await b.arrayBuffer());
}

export class Engine {
  samples = new Map<string, SampleData>();
  private cache = new ByteCache(defaultCacheBudget());
  private roots = new Map<string, Uint32Array>();
  /** Changes whenever results can change without a workspace change (samples added / removed, background results). */
  version = 0;

  addSample(id: string, ds: FcsDataset, bytes?: ArrayBuffer | Blob) {
    const index = new Map<string, number>();
    ds.channels.forEach((c, i) => index.set(c.name, i));
    this.purge(id);
    this.samples.set(id, { id, ds, index, bytes });
    this.version++;
  }

  removeSample(id: string) {
    this.samples.delete(id);
    this.purge(id);
    this.version++;
  }

  private purge(id: string) {
    this.fileComp.delete(id);
    this.roots.delete(id);
    for (const k of ['c', 'd', 'p', 's', 'x']) this.cache.deletePrefix(`${k}|${id}|`);
    for (const k of [...this.pending.keys()]) if (k.startsWith(id + '|')) this.dropJob(k);
  }

  /** Forget a background job and cancel what it has not started yet. */
  private dropJob(pkey: string) {
    const j = this.pending.get(pkey);
    if (!j) return;
    this.pending.delete(pkey);
    j.abort?.abort();
  }

  has(id: string) {
    return this.samples.has(id);
  }

  eventCount(id: string): number {
    return this.samples.get(id)?.ds.eventCount ?? 0;
  }

  // ---------------------------------------------------------------- memory

  /** Cache budget in bytes (see defaultCacheBudget); lowering it evicts right away. */
  get cacheBudget(): number {
    return this.cache.budget;
  }

  set cacheBudget(bytes: number) {
    this.cache.budget = Math.max(16 * 1024 * 1024, bytes);
    this.cache.evict();
  }

  /** Drop all cached results (they are recomputed when needed). */
  clearCache() {
    this.cache.clear();
  }

  memory(): EngineMemory {
    const MB = 1024 * 1024;
    let data = 0;
    let files = 0;
    for (const s of this.samples.values()) {
      data += bytesOf(s.ds.data);
      files += s.bytes instanceof ArrayBuffer ? s.bytes.byteLength : 0; // a Blob is not held in memory
    }
    let roots = 0;
    for (const r of this.roots.values()) roots += r.byteLength;
    const k = this.cache.stats();
    const byKind = {} as EngineMemory['byKind'];
    for (const [kind, v] of Object.entries(k)) byKind[kind as CacheKind] = { n: v.n, mb: Math.round((v.bytes / MB) * 10) / 10 };
    return {
      budgetMB: Math.round(this.cache.budget / MB),
      cachedMB: Math.round((this.cache.bytes / MB) * 10) / 10,
      byKind,
      evictions: this.cache.evictions,
      sampleDataMB: Math.round(data / MB),
      fileBytesMB: Math.round(files / MB),
      rootsMB: Math.round((roots / MB) * 10) / 10,
    };
  }

  // ---------------------------------------------------------------- change notification

  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called (coalesced) when results changed without a workspace change, e.g. a background job finished. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Ask subscribers to re-render soon (coalesced). */
  notify() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const f of [...this.listeners]) {
        try {
          f();
        } catch (e) {
          console.warn(e);
        }
      }
    }, 0);
  }

  // ---------------------------------------------------------------- deferred (background) results

  private deferDepth = 0;
  private runner: DerivedRunner | null = null;
  /** sampleId|okey -> running background job */
  private pending = new Map<string, { def: DerivedDef; inputs: unknown[]; failed?: boolean; abort?: AbortController }>();
  /** Results left to a background job so far (see deferredValue). */
  private deferMisses = 0;

  /** Install the background runner for derived channels (null: compute everything right away). */
  setDerivedRunner(r: DerivedRunner | null) {
    this.runner = r;
  }

  /**
   * Run `fn` with expensive results allowed to be computed in the background: while not ready, they read as missing
   * (null) and `isPending` tells so. Used by plot rendering only; all other callers always get the exact values.
   */
  deferred<T>(fn: () => T): T {
    this.deferDepth++;
    try {
      return fn();
    } finally {
      this.deferDepth--;
    }
  }

  /**
   * Run `fn` like `deferred` and tell whether a result it needed is still being computed in the background (then the
   * value is incomplete: show "computing" and wait for the engine's notification).
   */
  deferredValue<T>(fn: () => T): { value: T; pending: boolean } {
    const m = this.deferMisses;
    const value = this.deferred(fn);
    return { value, pending: this.deferMisses !== m };
  }

  /**
   * Population count for the interface (population tree, inspector): does not wait for background computations (a gate
   * on an unmixed channel of a large sample); null while one it needs is running.
   */
  countForDisplay(ws: Workspace, sampleId: string, popId: string | null): number | null {
    const r = this.deferredValue(() => this.count(ws, sampleId, popId));
    return r.pending ? null : r.value;
  }

  /** A statistic for the interface (stats boxes, charts, tables on screen); null while a background computation runs. */
  statForDisplay(ws: Workspace, sampleId: string, column: Pick<StatColumn, 'population' | 'stat' | 'channel' | 'percentile' | 'ofPopulation'>): number | null {
    const r = this.deferredValue(() => this.stat(ws, sampleId, column));
    return r.pending ? null : r.value;
  }

  /** Whether a channel of a sample is being computed in the background (its values read as missing meanwhile). */
  isPending(ws: Workspace, sampleId: string, ch: string): boolean {
    if (!this.pending.size) return false;
    for (const def of ws.derived ?? []) {
      if (!def.outputs.some((o) => o.name === ch)) continue;
      for (const k of this.pending.keys()) if (k.startsWith(sampleId + '|' + def.id + '|')) return true;
      if (def.kind !== 'unmix' && this.isPending(ws, sampleId, def.channel)) return true;
    }
    return false;
  }

  /** Number of background jobs running. */
  pendingCount(): number {
    return this.pending.size;
  }

  compFor(ws: Workspace, sampleId: string): CompDef | null {
    const s = ws.samples.find((x) => x.id === sampleId);
    if (!s || !s.compId) return null;
    return ws.compensations.find((c) => c.id === s.compId) ?? null;
  }

  private fileComp = new Map<string, CompDef | null>();

  /** The acquisition (file keyword) spillover of a sample, as a CompDef. */
  fileCompOf(sampleId: string): CompDef | null {
    if (this.fileComp.has(sampleId)) return this.fileComp.get(sampleId)!;
    const sd = this.samples.get(sampleId);
    const sp = sd ? getSpillover(sd.ds) : null;
    const c: CompDef | null = sp ? { id: 'file', name: 'Acquisition', channels: sp.channels, matrix: sp.matrix, source: 'file' } : null;
    this.fileComp.set(sampleId, c);
    return c;
  }

  /** Resolve a gate-level compensation override. */
  resolveComp(ws: Workspace, sampleId: string, ref: string | undefined): CompDef | null | undefined {
    if (ref === undefined) return undefined;
    if (ref === 'none' || ref === 'uncompensated') return null;
    if (ref === 'file' || ref === 'FCS') return this.fileCompOf(sampleId);
    return ws.compensations.find((c) => c.id === ref) ?? null;
  }

  private computeComp(sd: SampleData, comp: CompDef): Float32Array[] {
    let arrays = sd.ds.data;
    try {
      // a matrix that is not square over its channels or holds a value that is not a number (a damaged workspace or
      // import) leaves the data uncompensated instead of breaking evaluation
      const n = comp.channels?.length ?? 0;
      const m = comp.matrix;
      if (!Array.isArray(m) || m.length !== n || !m.every((r) => Array.isArray(r) && r.length === n && r.every((v) => typeof v === 'number' && Number.isFinite(v))))
        throw new Error(`matrix "${comp.name}" is not a square ${n} x ${n} matrix of numbers`);
      const present = comp.channels.map((c, k) => [k, sd.index.get(c) ?? -1] as const).filter(([, i]) => i >= 0);
      if (present.length > 1) {
        const sub = present.map(([k]) => present.map(([j]) => m[k][j]));
        arrays = compensate(sd.ds.data, present.map(([, i]) => i), sub);
      }
    } catch (e) {
      console.warn('Compensation failed', e);
      arrays = sd.ds.data;
    }
    return arrays;
  }

  /** Compensated channel arrays for a sample (array indexed like ds.channels). `override` replaces the sample's compensation. */
  data(ws: Workspace, sampleId: string, override?: CompDef | null): Float32Array[] | null {
    const sd = this.samples.get(sampleId);
    if (!sd) return null;
    const comp = override !== undefined ? override : this.compFor(ws, sampleId);
    if (!comp) return sd.ds.data;
    const key = `c|${sampleId}|${comp.id}`;
    const e = this.cache.get(key);
    const hit = e?.v as { comp: CompDef; arrays: Float32Array[] } | undefined;
    if (hit && hit.comp === comp) return hit.arrays;
    const arrays = this.computeComp(sd, comp);
    // only the compensated copies count (the other channels are the sample's own arrays)
    this.cache.set(key, 'comp', { comp, arrays }, bytesOf(arrays.filter((a, i) => a !== sd.ds.data[i])));
    return arrays;
  }

  raw(ws: Workspace, sampleId: string, ch: string, override?: CompDef | null): Float32Array | null {
    const sd = this.samples.get(sampleId);
    if (!sd) return null;
    const i = sd.index.get(ch);
    if (i === undefined) return this.derivedRaw(ws, sampleId, ch, override);
    const d = this.data(ws, sampleId, override);
    return d ? d[i] : null;
  }

  // ---------------------------------------------------------------- derived channels

  private derivedBusy = new Set<string>();

  private derivedRaw(ws: Workspace, sampleId: string, ch: string, override?: CompDef | null): Float32Array | null {
    for (const def of ws.derived ?? []) {
      const k = def.outputs.findIndex((o) => o.name === ch);
      if (k < 0) continue;
      if (def.samples && !def.samples.includes(sampleId)) return null;
      return this.derivedOutputs(ws, sampleId, def, override)?.[k] ?? null;
    }
    return null;
  }

  /** Outputs of a derived definition for one sample (cached by definition and input identity). */
  derivedOutputs(ws: Workspace, sampleId: string, def: DerivedDef, override?: CompDef | null): Float32Array[] | null {
    const sd = this.samples.get(sampleId);
    if (!sd) return null;
    const busyKey = sampleId + '|' + def.id;
    if (this.derivedBusy.has(busyKey)) return null; // circular definition
    const okey = def.id + '|' + overrideKey(override);
    const key = `x|${sampleId}|${okey}`;
    this.derivedBusy.add(busyKey);
    try {
      const inputs: unknown[] = def.kind === 'unmix' ? [sd.ds.data] : [this.raw(ws, sampleId, def.channel, override)];
      const c = this.cache.get(key)?.v as { def: DerivedDef; inputs: unknown[]; outs: Float32Array[] | null } | undefined;
      if (c && c.def === def && depsEqual(c.inputs, inputs)) return c.outs;
      const pkey = sampleId + '|' + okey;
      const run = this.runner;
      if (this.deferDepth > 0 && run && def.kind === 'unmix') {
        const p = this.pending.get(pkey);
        // still running; a failed job is computed right here (below)
        if (p && p.def === def && depsEqual(p.inputs, inputs) && !p.failed) {
          this.deferMisses++;
          return null;
        }
      }
      const prev = this.pending.get(pkey);
      if (this.deferDepth > 0 && run && def.kind === 'unmix' && !(prev && prev.def === def && depsEqual(prev.inputs, inputs)) && run.wants(def, sd.ds.eventCount)) {
        // a job for an older version of the definition (a slider being dragged) is not needed any more
        if (prev) this.dropJob(pkey);
        const abort = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
        const job: { def: DerivedDef; inputs: unknown[]; failed?: boolean; abort?: AbortController } = { def, inputs, abort };
        this.pending.set(pkey, job);
        this.deferMisses++;
        // what the slot held when the job started: a result stored after that is newer than the job's
        const startEntry = this.cache.peek(key);
        run
          .run(def, sd.ds.data, sd.ds.channels.map((x) => x.name), abort?.signal)
          .then(
            (outs) => {
              if (this.pending.get(pkey) !== job) return; // superseded or sample removed
              this.pending.delete(pkey);
              // a synchronous caller may have computed this definition meanwhile (keep that one), or a newer one (a
              // late result of an older version must not replace it); a slot that is empty or unchanged takes the result
              const nowEntry = this.cache.peek(key);
              const now = nowEntry?.v as { def: DerivedDef; inputs: unknown[] } | undefined;
              const same = !!now && now.def === def && depsEqual(now.inputs, inputs);
              const newer = !!nowEntry && nowEntry !== startEntry;
              if (!same && !newer) this.cache.set(key, 'derived', { def, inputs, outs }, bytesOf(outs ?? []));
              this.version++;
              this.notify();
            },
            (e) => {
              if (this.pending.get(pkey) !== job) return;
              job.failed = true; // the next request computes it synchronously (and reports the error, if any)
              console.warn(`Background computation of "${def.name}" failed; computing it here`, e);
              this.version++;
              this.notify();
            },
          );
        return null;
      }
      let outs: Float32Array[] | null = null;
      try {
        outs = computeDerived(def, {
          rawColumns: sd.ds.data,
          rawNames: sd.ds.channels.map((x) => x.name),
          channel: () => inputs[0] as Float32Array | null,
        });
      } catch (e) {
        console.warn(`Derived channels "${def.name}" failed for ${sampleId}`, e);
      }
      this.cache.set(key, 'derived', { def, inputs, outs }, bytesOf(outs ?? []));
      // the result is in: a background job for the same inputs is no longer needed, nor one for an older version of the
      // definition (its late result would only replace this one)
      if (this.pending.has(pkey)) this.dropJob(pkey);
      return outs;
    } finally {
      this.derivedBusy.delete(busyKey);
    }
  }

  /** All channels of a sample incl. derived ones (for export), with values as used for gating. */
  columns(ws: Workspace, sampleId: string, override?: CompDef | null): { names: string[]; labels: string[]; ranges: number[]; data: Float32Array[] } | null {
    const sd = this.samples.get(sampleId);
    const base = this.data(ws, sampleId, override);
    if (!sd || !base) return null;
    const names = sd.ds.channels.map((c) => c.name);
    const labels = sd.ds.channels.map((c) => c.label);
    const ranges = sd.ds.channels.map((c) => c.range);
    const data = [...base];
    for (const def of ws.derived ?? []) {
      if (def.samples && !def.samples.includes(sampleId)) continue;
      const outs = this.derivedOutputs(ws, sampleId, def, override);
      if (!outs) continue;
      def.outputs.forEach((o, k) => {
        if (!outs[k] || names.includes(o.name)) return;
        names.push(o.name);
        labels.push(o.label ?? '');
        ranges.push(o.range);
        data.push(outs[k]);
      });
    }
    return { names, labels, ranges, data };
  }

  /** The workspace scale of a channel (shared by all instruments; see scaleFor for a sample's own). */
  scaleOf(ws: Workspace, ch: string): ScaleDef {
    return ws.scales[ch] ?? FALLBACK_SCALE;
  }

  /**
   * The scale of a channel for a sample: its instrument's own scale when the workspace has one (Workspace.instrumentScales),
   * else the workspace scale. Without instrument scales this is exactly scaleOf.
   */
  scaleFor(ws: Workspace, ch: string, sampleId?: string | null): ScaleDef {
    if (!ws.instrumentScales || !sampleId) return ws.scales[ch] ?? FALLBACK_SCALE;
    return scaleForSample(ws, ch, sampleId, this.keywordsOf) ?? FALLBACK_SCALE;
  }

  /** FCS keywords of a loaded sample. */
  keywordsOf = (sampleId: string): Record<string, string> | undefined => this.samples.get(sampleId)?.ds.keywords;

  display(ws: Workspace, sampleId: string, ch: string, def: ScaleDef, override?: CompDef | null): Float32Array | null {
    const src = this.raw(ws, sampleId, ch, override);
    if (!src) return null;
    const key = `d|${sampleId}|${overrideKey(override)}|${objId(def)}|${ch}`;
    const hit = this.cache.get(key)?.v as { src: Float32Array; def: ScaleDef; arr: Float32Array } | undefined;
    if (hit && hit.src === src && hit.def === def) return hit.arr;
    let arr: Float32Array;
    if (def.type === 'window') {
      // a zoomed axis: the base display values mapped linearly (what the window scale computes, from the cached base)
      const base = this.display(ws, sampleId, ch, def.base, override);
      const span = def.u1 - def.u0 || 1;
      const u0 = def.u0;
      arr = new Float32Array(src.length);
      if (base) for (let i = 0; i < arr.length; i++) arr[i] = (base[i] - u0) / span;
      else arr = makeScale(def).fwdArray(src);
    } else arr = makeScale(def).fwdArray(src);
    this.cache.set(key, 'disp', { src, def, arr }, arr.byteLength);
    return arr;
  }

  root(sampleId: string): Uint32Array {
    let r = this.roots.get(sampleId);
    if (!r) {
      r = allIndices(this.eventCount(sampleId));
      this.roots.set(sampleId, r);
    }
    return r;
  }

  effectiveGate(p: Population, sampleId: string): GateGeom {
    return p.overrides?.[sampleId] ?? p.gate;
  }

  /**
   * Whether a population applies to a sample (core/scope.ts): not when a scope (group- / sample-specific gates) leaves the
   * sample out or a gate uses a channel the sample lacks. Such populations have no events, and statistics are n/a.
   */
  applies(ws: Workspace, sampleId: string, popId: string | null): boolean {
    return applies(ws, sampleId, popId);
  }

  /** Why a population does not apply to a sample (null: it applies). */
  notApplicableReason(ws: Workspace, sampleId: string, popId: string | null): string | null {
    return popNotApplicableReason(ws, sampleId, popId);
  }

  /** Count of a population, or null when it does not apply to the sample (n/a, not 0). */
  countOrNA(ws: Workspace, sampleId: string, popId: string | null): number | null {
    if (!this.samples.has(sampleId) || !applies(ws, sampleId, popId)) return null;
    return this.count(ws, sampleId, popId);
  }

  /** Whether a statistic does not apply to a sample (population out of scope, channel not measured): shown as n/a. */
  statNotApplicable(ws: Workspace, sampleId: string, col: Pick<StatColumn, 'population' | 'stat' | 'channel' | 'ofPopulation'>): boolean {
    return statNotApplicableReason(ws, sampleId, col) !== null;
  }

  /** sampleId|popId of the populations being evaluated (a population that depends on itself is empty, not endless) */
  private evaluating = new Set<string>();

  population(ws: Workspace, sampleId: string, popId: string | null, depth = 0): Uint32Array {
    if (!this.samples.has(sampleId)) return new Uint32Array(0);
    if (!popId || popId === 'root') return this.root(sampleId);
    if (depth > 64) return new Uint32Array(0);
    const pop = popById(ws, popId);
    if (!pop) return new Uint32Array(0);
    // a dependency cycle (a Boolean gate whose operand lies below it, a parent cycle): no events. Without this, every
    // pass around the cycle evaluates both operands again (exponential until the depth limit)
    const ek = sampleId + '|' + popId;
    if (this.evaluating.has(ek)) return NO_EVENTS;
    this.evaluating.add(ek);
    try {
      return this.populationOf(ws, sampleId, pop, depth);
    } finally {
      this.evaluating.delete(ek);
    }
  }

  private populationOf(ws: Workspace, sampleId: string, pop: Population, depth: number): Uint32Array {
    const popId = pop.id;
    // out of scope / on a channel the sample lacks: no events (statistics report n/a)
    if (!applies(ws, sampleId, popId)) return NO_EVENTS;
    const parent = this.population(ws, sampleId, pop.parentId, depth + 1);
    const g = this.effectiveGate(pop, sampleId);
    const override = this.resolveComp(ws, sampleId, g.comp);
    const compArrays = this.data(ws, sampleId, override);
    const deps: unknown[] = [g, parent, compArrays];
    if (ws.derived?.length && g.type !== 'bool') {
      const sd = this.samples.get(sampleId)!;
      for (const ch of [g.x, 'y' in g ? g.y : undefined]) if (ch && !sd.index.has(ch)) deps.push(this.raw(ws, sampleId, ch, override));
    }
    if (g.type === 'polygon' || g.type === 'ellipse') {
      deps.push(g.scales?.x ?? this.scaleFor(ws, g.x, sampleId), g.scales?.y ?? this.scaleFor(ws, g.y, sampleId));
    }
    if (g.type === 'bool') {
      for (const op of g.operands) deps.push(this.population(ws, sampleId, op.replace(/^!/, ''), depth + 1));
    }
    const key = `p|${sampleId}|${popId}`;
    const c = this.cache.get(key)?.v as PopEntry | undefined;
    if (c && depsEqual(c.deps, deps)) return c.idx;
    const ctx: GateContext = {
      raw: (ch) => this.raw(ws, sampleId, ch, override),
      display: (ch, def) => this.display(ws, sampleId, ch, def, override),
      scaleOf: (ch) => this.scaleFor(ws, ch, sampleId),
      population: (id) => this.population(ws, sampleId, id, depth + 1),
      eventCount: this.eventCount(sampleId),
      exists: (id) => id === 'root' || !!popById(ws, id),
    };
    const idx = applyGate(g, parent, ctx);
    this.cache.set(key, 'pop', { deps, idx } satisfies PopEntry, idx.byteLength);
    return idx;
  }

  count(ws: Workspace, sampleId: string, popId: string | null): number {
    return this.population(ws, sampleId, popId).length;
  }

  /**
   * Events of population `parentId` that gate geometry `g` selects in a sample, not cached: e.g. to test a gate on other
   * evaluation scales before changing it. Empty for a sample without data.
   */
  gateEvents(ws: Workspace, sampleId: string, g: GateGeom, parentId: string | null): Uint32Array {
    if (!this.samples.has(sampleId)) return NO_EVENTS;
    const parent = this.population(ws, sampleId, parentId);
    if (!parent.length) return NO_EVENTS;
    const override = this.resolveComp(ws, sampleId, g.comp);
    const ctx: GateContext = {
      raw: (ch) => this.raw(ws, sampleId, ch, override),
      display: (ch, def) => this.display(ws, sampleId, ch, def, override),
      scaleOf: (ch) => this.scaleFor(ws, ch, sampleId),
      population: (id) => this.population(ws, sampleId, id),
      eventCount: this.eventCount(sampleId),
      exists: (id) => id === 'root' || !!popById(ws, id),
    };
    return applyGate(g, parent, ctx);
  }

  channelStats(ws: Workspace, sampleId: string, popId: string, ch: string): ChannelStats | null {
    const src = this.raw(ws, sampleId, ch);
    if (!src) return null;
    const idx = this.population(ws, sampleId, popId);
    const key = `s|${sampleId}|${popId}|${ch}`;
    const scale = this.scaleFor(ws, ch, sampleId); // the mode is binned on the display scale
    const c = this.cache.get(key)?.v as { idx: Uint32Array; src: Float32Array; scale: ScaleDef; cs: ChannelStats } | undefined;
    if (c && c.idx === idx && c.src === src && c.scale === scale) return c.cs;
    const cs = channelStats(src, idx, scale);
    // the statistics keep the population's finite values (sorted on first use of an order statistic)
    this.cache.set(key, 'stats', { idx, src, scale, cs }, cs.n * 4 + 64);
    return cs;
  }

  /**
   * A statistic of a sample. NaN when it does not apply there (population out of scope or gated on a channel the sample
   * lacks, channel not measured: see core/scope.ts) or has no value. A population that does not apply is replaced by the
   * one with the same path that does (group-specific copies of a gating tree), as tables compare samples by gate path.
   */
  stat(ws: Workspace, sampleId: string, column: Pick<StatColumn, 'population' | 'stat' | 'channel' | 'percentile' | 'ofPopulation'>): number {
    if (!this.samples.has(sampleId)) return NaN;
    const col = resolveStatCol(ws, sampleId, column);
    const popId = col.population || 'root';
    // not applicable (population out of scope, gate or statistic on a channel the sample lacks): no value, not 0
    if (statNotApplicableReason(ws, sampleId, col)) return NaN;
    const n = this.count(ws, sampleId, popId);
    switch (col.stat) {
      case 'count':
        return n;
      case 'freqTotal': {
        const t = this.eventCount(sampleId);
        return t ? (100 * n) / t : NaN;
      }
      case 'freqParent': {
        const p = popId === 'root' ? null : popById(ws, popId)?.parentId ?? null;
        const pn = popId === 'root' ? n : this.count(ws, sampleId, p);
        return pn ? (100 * n) / pn : NaN;
      }
      case 'freqOf': {
        // the reference must be an ancestor (or All Events); anything else is not a frequency of it
        const ref = col.ofPopulation || 'root';
        if (!isAncestorPop(ws, ref, popId)) return NaN;
        const rn = this.count(ws, sampleId, ref);
        return rn ? (100 * n) / rn : NaN;
      }
      case 'concentration': {
        // FCS $VOL is the analysed volume in nanolitres
        const vol = parseFloat(this.samples.get(sampleId)?.ds.keywords['$VOL'] ?? '');
        return vol > 0 ? n / (vol / 1000) : NaN;
      }
      case 'freqGrandparent': {
        const p = popId === 'root' ? undefined : popById(ws, popId);
        const gp = p?.parentId ? popById(ws, p.parentId)?.parentId ?? null : null;
        const gn = this.count(ws, sampleId, gp);
        return gn ? (100 * n) / gn : NaN;
      }
      default: {
        if (!col.channel) return NaN;
        const cs = this.channelStats(ws, sampleId, popId, col.channel);
        if (!cs) return NaN;
        return statFromChannel(cs, col.stat, col.percentile ?? 50);
      }
    }
  }
}

export const engine = new Engine();
