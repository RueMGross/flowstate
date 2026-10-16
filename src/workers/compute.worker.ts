// Web Worker for pure computations (no DOM, no workspace): spectral unmixing of event ranges.
// Built into the page as an inline string (src/workers/pool.ts); messages carry their typed arrays as transferables.
import { prepareUnmix, unmixRange, unmixWasmAvailable, type UnmixDef } from '../core/unmix';

export type WorkerRequest = { id: number; type: 'ping' } | { id: number; type: 'unmix'; def: UnmixDef; cols: Float32Array[]; n: number };

export type WorkerReply = { id: number; ok: true; wasm?: boolean; out?: Float32Array[] } | { id: number; ok: false; error: string };

const post = (m: WorkerReply, transfer: Transferable[] = []) => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'ping') {
      post({ id: m.id, ok: true, wasm: unmixWasmAvailable() });
      return;
    }
    if (m.type === 'unmix') {
      const pu = prepareUnmix(m.def);
      const out = pu.outNames.map(() => new Float32Array(m.n));
      unmixRange(pu, m.cols, out, 0, m.n);
      post({ id: m.id, ok: true, out }, out.map((o) => o.buffer));
      return;
    }
    post({ id: (m as { id: number }).id, ok: false, error: 'unknown request' });
  } catch (err) {
    post({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
