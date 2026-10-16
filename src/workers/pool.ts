// A small pool of Web Workers for pure, heavy computations (see compute.worker.ts).
//
// The worker code is bundled into the page as a string (Vite `?worker&inline`) and started from a Blob URL, else from a
// data: URL, so the single-file build needs no network. Where workers cannot start (a Content Security Policy without
// blob: / data: workers, file:// restrictions, very old browsers) or do not answer a first ping within a few seconds,
// the pool reports itself unavailable and callers compute on the main thread instead (src/workers/derivedJobs.ts).
import ComputeWorker from './compute.worker?worker&inline';
import type { WorkerReply, WorkerRequest } from './compute.worker';

type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

interface Slot {
  w: Worker;
  busy: boolean;
  alive: boolean;
}

interface Job {
  msg: Req;
  transfer: Transferable[];
  resolve: (r: WorkerReply & { ok: true }) => void;
  reject: (e: Error) => void;
}

export type PoolState = 'idle' | 'starting' | 'ready' | 'failed';

const PING_TIMEOUT_MS = 4000;

let state: PoolState = 'idle';
let starting: Promise<boolean> | null = null;
let slots: Slot[] = [];
let workerWasm: boolean | null = null;
let failure = '';
const queue: Job[] = [];
const inflight = new Map<number, { slot: Slot; job: Job }>();
let nextId = 1;

/** Number of workers to start: the cores minus one for the page, 1-4. */
function wantedSize(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(4, hc - 1));
}

function spawn(): Promise<Slot | null> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new ComputeWorker({ name: 'flowstate-compute' });
    } catch (e) {
      failure = (e as Error)?.message ?? String(e);
      resolve(null);
      return;
    }
    const slot: Slot = { w, busy: false, alive: true };
    let settled = false;
    const done = (ok: boolean, why = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) {
        failure = why;
        slot.alive = false;
        try {
          w.terminate();
        } catch {
          /* ignore */
        }
      }
      resolve(ok ? slot : null);
    };
    const timer = setTimeout(() => done(false, 'no answer from the worker'), PING_TIMEOUT_MS);
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      const r = e.data;
      if (!settled) {
        if (r && r.id === 0 && r.ok) {
          if (workerWasm === null) workerWasm = !!r.wasm;
          done(true);
        }
        return;
      }
      onReply(slot, r);
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      if (!settled) done(false, e.message || 'worker failed to start');
      else onCrash(slot, e.message || 'worker error');
    };
    try {
      w.postMessage({ id: 0, type: 'ping' } satisfies WorkerRequest);
    } catch (e) {
      done(false, (e as Error).message);
    }
  });
}

function onReply(slot: Slot, r: WorkerReply) {
  const f = inflight.get(r.id);
  if (!f) return;
  inflight.delete(r.id);
  slot.busy = false;
  if (r.ok) f.job.resolve(r);
  else f.job.reject(new Error(r.error));
  pump();
}

function onCrash(slot: Slot, why: string) {
  slot.alive = false;
  slot.busy = false;
  for (const [id, f] of inflight)
    if (f.slot === slot) {
      inflight.delete(id);
      f.job.reject(new Error(why));
    }
  if (!slots.some((s) => s.alive)) {
    state = 'failed';
    failure = why;
    for (const j of queue.splice(0)) j.reject(new Error(why));
  }
  pump();
}

function pump() {
  for (const slot of slots) {
    if (!queue.length) return;
    if (!slot.alive || slot.busy) continue;
    const job = queue.shift()!;
    const id = nextId++;
    slot.busy = true;
    inflight.set(id, { slot, job });
    try {
      slot.w.postMessage({ ...job.msg, id }, job.transfer);
    } catch (e) {
      inflight.delete(id);
      slot.busy = false;
      job.reject(e as Error);
    }
  }
}

/** Start the pool (once); resolves true when at least one worker answered. */
export function startPool(): Promise<boolean> {
  if (state === 'ready') return Promise.resolve(true);
  if (state === 'failed') return Promise.resolve(false);
  if (starting) return starting;
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    state = 'failed';
    failure = 'Web Workers are not available';
    return Promise.resolve(false);
  }
  state = 'starting';
  starting = (async () => {
    const first = await spawn();
    if (!first) {
      state = 'failed';
      console.info(`FlowState: background workers unavailable (${failure}); computing on the main thread.`);
      return false;
    }
    slots = [first];
    state = 'ready';
    // more workers in the background; a failing one only makes the pool smaller
    const n = wantedSize();
    for (let i = 1; i < n; i++)
      void spawn().then((s) => {
        if (s) {
          slots.push(s);
          pump();
        }
      });
    return true;
  })();
  return starting;
}

/** The error of a request cancelled through its AbortSignal. */
export function abortError(): Error {
  const e = new Error('cancelled');
  e.name = 'AbortError';
  return e;
}

/**
 * Run one request on the next free worker (the pool must be started). Typed arrays in `transfer` are moved. `signal`:
 * a request still waiting in the queue when it is aborted is dropped (rejects with an AbortError); one already sent
 * to a worker runs to its end (a range is short), its result is discarded by the caller.
 */
export function runInWorker(msg: Req, transfer: Transferable[] = [], signal?: AbortSignal): Promise<WorkerReply & { ok: true }> {
  return new Promise((resolve, reject) => {
    if (state !== 'ready') {
      reject(new Error('worker pool not available'));
      return;
    }
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const job: Job = { msg, transfer, resolve, reject };
    queue.push(job);
    signal?.addEventListener(
      'abort',
      () => {
        const i = queue.indexOf(job);
        if (i < 0) return; // already sent
        queue.splice(i, 1);
        reject(abortError());
      },
      { once: true },
    );
    pump();
  });
}

/** Requests waiting for a worker (for tests and diagnostics). */
export function queuedRequests(): number {
  return queue.length;
}

export function poolInfo(): { state: PoolState; workers: number; wasm: boolean | null; failure: string; queued: number; busy: number } {
  return { state, workers: slots.filter((s) => s.alive).length, wasm: workerWasm, failure, queued: queue.length, busy: inflight.size };
}

/** Whether the workers run the same unmixing kernel as this thread (results identical to the main thread's). */
export function poolWasm(): boolean | null {
  return workerWasm;
}

/** Workers available (or not known yet: not started / starting). */
export function poolUsable(): boolean {
  return state !== 'failed';
}

/** For tests: forget the pool state. */
export function resetPoolForTests() {
  for (const s of slots) s.w.terminate();
  slots = [];
  state = 'idle';
  starting = null;
  workerWasm = null;
}
