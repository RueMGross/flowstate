// Background computation of derived channels for the engine (Engine.setDerivedRunner): spectral unmixing of large
// samples runs in the worker pool, split into event ranges; without workers it runs on the main thread in time slices
// (one range per task, so the page stays responsive). Results are identical to the synchronous computation:
//  - every event is unmixed by the same kernel (the workers are used only when their WebAssembly support matches this
//    thread's, and every range has at least 64 events, so the WebAssembly kernel takes all of them as it does in one go);
//  - definitions that choose the autofluorescence signature per event (several AF signatures, 'best') group events
//    across the whole sample, so they run as one range.
import type { DerivedDef } from '../core/derived';
import type { DerivedRunner, Engine } from '../core/engine';
import { prepareUnmix, resolveDetectors, unmixRange, unmixWasmAvailable, type PreparedUnmix } from '../core/unmix';
import { abortError, poolInfo, poolUsable, poolWasm, runInWorker, startPool } from './pool';

/** Estimated main-thread time (ms) of unmixing n events (calibrated on WLS / OLS at 1M x 48 x 24). */
export function unmixCostMs(def: Extract<DerivedDef, { kind: 'unmix' }>, n: number): number {
  const u = def.unmix;
  const D = u.detectors.length;
  const K = u.endmembers.length + (u.includeAF ? u.af?.length ?? 0 : 0);
  const heavy = u.method === 'wls' || u.method === 'nnls' || !!u.nonNegative;
  return n * D * K * (heavy ? Math.max(1, K / 2) : 1) * 2.5e-7;
}

/** Background work pays off from this estimated time on (ms). */
const MIN_COST_MS = 40;
/** Events per range (a range is one worker message / one main-thread slice); at least 64 (see above). */
const RANGE_EVENTS = 65536;
const MIN_RANGE = 64;

function ranges(n: number, size: number): [number, number][] {
  const out: [number, number][] = [];
  for (let s = 0; s < n; s += size) out.push([s, Math.min(n, s + size)]);
  // a short last range joins the previous one (every range >= MIN_RANGE events)
  if (out.length > 1 && out[out.length - 1][1] - out[out.length - 1][0] < MIN_RANGE) {
    const last = out.pop()!;
    out[out.length - 1][1] = last[1];
  }
  return out;
}

const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

/** Stop when the engine no longer needs the result (a newer definition, the sample removed). */
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

async function unmixInWorkers(pu: PreparedUnmix, cols: Float32Array[], n: number, signal?: AbortSignal): Promise<Float32Array[]> {
  const out = pu.outNames.map(() => new Float32Array(n));
  const workers = Math.max(1, poolInfo().workers);
  const parts = pu.afBest ? [[0, n] as [number, number]] : ranges(n, Math.max(MIN_RANGE, Math.min(RANGE_EVENTS, Math.ceil(n / (workers * 2)))));
  // a few ranges in flight per worker: the copies are made one range at a time (short tasks, bounded memory); a
  // cancelled job sends no further ranges and its queued ones are dropped (runInWorker)
  let next = 0;
  const lane = async () => {
    while (next < parts.length) {
      checkAbort(signal);
      const [s, e] = parts[next++];
      const chunk = cols.map((c) => c.slice(s, e)); // copies, moved to the worker
      const r = await runInWorker({ type: 'unmix', def: pu.def, cols: chunk, n: e - s }, chunk.map((c) => c.buffer), signal);
      checkAbort(signal);
      r.out!.forEach((o, k) => out[k].set(o, s));
    }
  };
  await Promise.all(Array.from({ length: Math.min(parts.length, workers * 2) }, lane));
  return out;
}

async function unmixSliced(pu: PreparedUnmix, cols: Float32Array[], n: number, signal?: AbortSignal): Promise<Float32Array[]> {
  const out = pu.outNames.map(() => new Float32Array(n));
  const parts = pu.afBest ? [[0, n] as [number, number]] : ranges(n, RANGE_EVENTS / 2);
  for (const [s, e] of parts) {
    await yieldTask();
    checkAbort(signal);
    unmixRange(pu, cols, out, s, e);
  }
  return out;
}

export const derivedRunner: DerivedRunner = {
  wants(def, n) {
    if (def.kind !== 'unmix' || unmixCostMs(def, n) < MIN_COST_MS) return false;
    if (poolUsable()) void startPool();
    return true;
  },
  async run(def, columns, names, signal) {
    if (def.kind !== 'unmix') throw new Error('not a background job');
    checkAbort(signal);
    const idx = resolveDetectors(def.unmix, names);
    if (idx.some((i) => i < 0)) return null;
    const pu = prepareUnmix(def.unmix); // throws on a singular matrix, as the synchronous path does
    const cols = idx.map((i) => columns[i]);
    const n = cols.length ? cols[0].length : 0;
    const ok = await startPool();
    checkAbort(signal);
    if (ok && poolWasm() === unmixWasmAvailable()) {
      try {
        return await unmixInWorkers(pu, cols, n, signal);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        console.warn('Worker unmixing failed; computing on the main thread', e);
      }
    }
    return unmixSliced(pu, cols, n, signal);
  },
};

/** Use the background runner for this engine (done once at startup, in the browser). */
export function installDerivedRunner(engine: Engine) {
  engine.setDerivedRunner(derivedRunner);
}
