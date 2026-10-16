// Regression (review 3): a late background result for an older definition replaced a newer synchronous one (the plot
// then showed "computing" again and started a second job).
import type { DerivedDef } from '../src/core/derived';
import { Engine, type DerivedRunner } from '../src/core/engine';
import type { FcsDataset } from '../src/core/fcs';
import { emptyWorkspace, type Workspace } from '../src/core/model';
import { createUnmixDef, unmix, resolveDetectors } from '../src/core/unmix';

const D = ['V1-A', 'V2-A', 'V3-A'];
const N = 2000;

function dataset(): FcsDataset {
  const cols = D.map((_, d) => Float32Array.from({ length: N }, (_, i) => ((i * (d + 3)) % 997) + (i % 2 ? 4000 : 0)));
  return { version: 'FCS3.1', keywords: {}, channels: D.map((name) => ({ index: 0, name, label: '', range: 262144, bits: 32, logDecades: 0, logOffset: 0, gain: 1, displayHint: '' })), eventCount: N, data: cols, warnings: [] } as unknown as FcsDataset;
}

function unmixDef(floor = 1): DerivedDef {
  const u = createUnmixDef({ id: 'ux', detectors: D, endmembers: [{ name: 'E1', signature: [1, 0.2, 0.1] }, { name: 'E2', signature: [0.1, 1, 0.3] }], method: 'ols' });
  return { id: 'ux', kind: 'unmix', name: 'U' + floor, unmix: { ...u, wls: { floor } }, outputs: [{ name: 'E1', range: 262144 }, { name: 'E2', range: 262144 }] };
}

function workspace(def: DerivedDef): Workspace {
  const ws = emptyWorkspace();
  ws.samples.push({ id: 's1', name: 's1', fileName: 's1.fcs', fileSize: 0, eventCount: N, channels: D.map((name) => ({ name, label: '', range: 262144 })), compId: null });
  ws.derived = [def];
  ws.populations.push({ id: 'p1', name: 'E1+', parentId: null, color: '#000', gate: { type: 'range', x: 'E1', min: 100, max: Infinity } });
  return ws;
}

interface Call {
  def: DerivedDef;
  signal?: AbortSignal;
  resolve: (o: Float32Array[] | null) => void;
}

/** A background runner whose jobs finish when the test says so. */
function fakeRunner(): DerivedRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    wants: () => true,
    run: (def, _cols, _names, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ def, signal, resolve });
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
      }),
  };
}

const outputsOf = (def: DerivedDef, ds: FcsDataset) => {
  if (def.kind !== 'unmix') throw new Error();
  return unmix(def.unmix, ds.data, resolveDetectors(def.unmix, ds.channels.map((c) => c.name)));
};
const tick = () => new Promise((r) => setTimeout(r, 5));


it('a late result for an older definition does not replace the current one (no second job, no "computing")', async () => {
  const e = new Engine();
  const run = fakeRunner();
  e.setDerivedRunner(run);
  const ds = dataset();
  e.addSample('s1', ds);
  const v1 = unmixDef(1);
  const v2 = unmixDef(2);
  // the plot asks for v1 in the background
  expect(e.countForDisplay(workspace(v1), 's1', 'p1')).toBeNull();
  // the definition is edited (v2) and an export / table computes v2 right away
  const exact = e.count(workspace(v2), 's1', 'p1');
  // the v1 job is not needed any more: cancelled
  expect(run.calls[0].signal!.aborted).toBe(true);
  // (a runner that finishes it anyway)
  run.calls[0].resolve(outputsOf(v1, ds));
  await tick();
  // the plot now shows v2: it is in the cache already
  const shown = e.countForDisplay(workspace(v2), 's1', 'p1');
  expect(shown).toBe(exact);
  expect(run.calls.length).toBe(1);
});

it('a late result for an older definition does not replace a newer one computed while it ran', async () => {
  // a runner that ignores cancelling (the job's promise still resolves)
  const calls: { def: DerivedDef; resolve: (o: Float32Array[] | null) => void }[] = [];
  const run: DerivedRunner = { wants: () => true, run: (def) => new Promise((resolve) => calls.push({ def, resolve })) };
  const e = new Engine();
  e.setDerivedRunner(run);
  const ds = dataset();
  e.addSample('s1', ds);
  const v1 = unmixDef(1);
  const v2 = unmixDef(2);
  expect(e.countForDisplay(workspace(v1), 's1', 'p1')).toBeNull();
  // the engine forgot the job (cancelled), the runner finishes it anyway: ignored
  const exact = e.count(workspace(v2), 's1', 'p1');
  calls[0].resolve(outputsOf(v1, ds));
  await tick();
  expect(e.countForDisplay(workspace(v2), 's1', 'p1')).toBe(exact);
  expect(calls.length).toBe(1);
});

it('a job started while the slot held another version stores its result (no endless re-requests)', async () => {
  const e = new Engine();
  const run = fakeRunner();
  e.setDerivedRunner(run);
  const ds = dataset();
  e.addSample('s1', ds);
  const v1 = unmixDef(1);
  const v2 = unmixDef(2);
  // v2 computed right away (e.g. an export), then the plot shows v1 again (undo): a background job for v1
  e.count(workspace(v2), 's1', 'p1');
  expect(e.countForDisplay(workspace(v1), 's1', 'p1')).toBeNull();
  run.calls[0].resolve(outputsOf(v1, ds));
  await tick();
  const ref = new Engine();
  ref.addSample('s1', ds);
  expect(e.countForDisplay(workspace(v1), 's1', 'p1')).toBe(ref.count(workspace(v1), 's1', 'p1'));
  expect(run.calls.length).toBe(1);
});
