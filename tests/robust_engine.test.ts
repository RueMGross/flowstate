// Background computations and the interface: counts and statistics on unmixed channels do not compute the unmixing on
// the main thread (they show "computing" until the background job is in), superseded jobs are cancelled, and
// dependency cycles cannot make the gating engine re-evaluate without end.
import type { DerivedDef } from '../src/core/derived';
import { Engine, type DerivedRunner } from '../src/core/engine';
import type { FcsDataset } from '../src/core/fcs';
import { emptyWorkspace, newWorksheet, type ChartItem, type StatsBoxItem, type Workspace } from '../src/core/model';
import { createUnmixDef, unmix, resolveDetectors } from '../src/core/unmix';
import { chartDataOf } from '../src/render/chart';
import { statsRows } from '../src/render/items';
import { derivedRunner } from '../src/workers/derivedJobs';

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

describe('counts and statistics for the interface do not wait for background unmixing', () => {
  it('countForDisplay / statForDisplay are null while the job runs, then exact', async () => {
    const e = new Engine();
    const run = fakeRunner();
    e.setDerivedRunner(run);
    const ds = dataset();
    e.addSample('s1', ds);
    const def = unmixDef();
    const ws = workspace(def);
    expect(e.countForDisplay(ws, 's1', 'p1')).toBeNull();
    expect(e.statForDisplay(ws, 's1', { population: 'p1', stat: 'median', channel: 'E2' })).toBeNull();
    // nothing was computed on this thread: one background job, no cached outputs
    expect(run.calls.length).toBe(1);
    expect(e.memory().byKind.derived.n).toBe(0);
    expect(e.pendingCount()).toBe(1);
    run.calls[0].resolve(outputsOf(def, ds));
    await tick();
    expect(e.pendingCount()).toBe(0);
    const n = e.countForDisplay(ws, 's1', 'p1');
    expect(n).toBeGreaterThan(0);
    // the same as the exact (synchronous) value of an engine without background jobs
    const ref = new Engine();
    ref.addSample('s1', ds);
    expect(n).toBe(ref.count(ws, 's1', 'p1'));
    expect(e.statForDisplay(ws, 's1', { population: 'p1', stat: 'median', channel: 'E2' })).toBe(ref.stat(ws, 's1', { population: 'p1', stat: 'median', channel: 'E2' }));
  });

  it('stats boxes and charts on screen show "computing"; exports compute', async () => {
    const e = new Engine();
    const run = fakeRunner();
    e.setDerivedRunner(run);
    const ds = dataset();
    e.addSample('s1', ds);
    const ws = workspace(unmixDef());
    const box: StatsBoxItem = { id: 'b', kind: 'stats', x: 0, y: 0, w: 100, h: 60, sample: 'active', fontSize: 8, rows: [{ id: 'r1', population: 'p1', stat: 'count' }, { id: 'r2', population: 'root', stat: 'count' }] };
    const rows = statsRows(ws, e, box, 's1', { deferred: true });
    expect(rows.map((r) => r.value)).toEqual(['computing…', N.toLocaleString('en-US')]);
    const chart = { id: 'c', kind: 'chart', x: 0, y: 0, w: 100, h: 80, stat: { id: 'k', population: 'p1', stat: 'count' }, mode: 'samples', sampleSet: 'all', style: 'bar', errorBars: 'sd', showPoints: true, color: '#000', useGroupColors: false, fontSize: 8, lineWidth: 1 } as ChartItem;
    const env = { ws, engine: e, activeSampleId: 's1', rasterScale: 1, makeCanvas: () => null as never };
    expect(chartDataOf(chart, { ...env, deferStats: true }).pending).toBe(true);
    // exports (no deferral): exact values right away, and the background job is no longer needed
    const exact = statsRows(ws, e, box, 's1');
    expect(Number(exact[0].value.replace(/,/g, ''))).toBeGreaterThan(0);
    expect(run.calls[0].signal!.aborted).toBe(true);
    expect(chartDataOf(chart, { ...env, deferStats: true }).pending).toBe(false);
  });

  it('a superseded job (the definition was edited) is cancelled', async () => {
    const e = new Engine();
    const run = fakeRunner();
    e.setDerivedRunner(run);
    const ds = dataset();
    e.addSample('s1', ds);
    const defs = [1, 2, 3, 4].map(unmixDef);
    for (const d of defs) expect(e.countForDisplay(workspace(d), 's1', 'p1')).toBeNull();
    expect(run.calls.length).toBe(4);
    expect(run.calls.map((c) => c.signal!.aborted)).toEqual([true, true, true, false]);
    expect(e.pendingCount()).toBe(1);
    // a late result of a cancelled job is ignored
    run.calls[0].resolve(outputsOf(defs[0], ds));
    await tick();
    expect(e.countForDisplay(workspace(defs[3]), 's1', 'p1')).toBeNull();
    run.calls[3].resolve(outputsOf(defs[3], ds));
    await tick();
    expect(e.countForDisplay(workspace(defs[3]), 's1', 'p1')).toBeGreaterThan(0);
    // removing the sample cancels its job
    e.countForDisplay(workspace(unmixDef(9)), 's1', 'p1');
    const last = run.calls.at(-1)!;
    e.removeSample('s1');
    expect(last.signal!.aborted).toBe(true);
  });

  it('the background runner stops a cancelled job (main-thread slices, as without workers)', async () => {
    const ds = dataset();
    const def = unmixDef();
    const ok = await derivedRunner.run(def, ds.data, D);
    const ref = outputsOf(def, ds)!;
    expect(Array.from(ok![0])).toEqual(Array.from(ref[0]));
    const ac = new AbortController();
    const p = derivedRunner.run(def, ds.data, D, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('dependency cycles in the gating tree', () => {
  it('a Boolean gate with an operand inside it counts quickly (no exponential re-evaluation)', () => {
    const e = new Engine();
    e.addSample('s1', dataset());
    const ws = workspace(unmixDef());
    ws.derived = [];
    ws.populations = [
      { id: 'b', name: 'B', parentId: null, color: '#000', gate: { type: 'bool', op: 'and', operands: ['x', '!y'] } },
      { id: 'x', name: 'X', parentId: 'b', color: '#000', gate: { type: 'range', x: 'V1-A', min: 10, max: Infinity } },
      { id: 'y', name: 'Y', parentId: 'x', color: '#000', gate: { type: 'range', x: 'V2-A', min: 500, max: Infinity } },
      { id: 'c1', name: 'C1', parentId: 'c2', color: '#000', gate: { type: 'range', x: 'V1-A', min: 0, max: Infinity } },
      { id: 'c2', name: 'C2', parentId: 'c1', color: '#000', gate: { type: 'range', x: 'V1-A', min: 0, max: Infinity } },
    ];
    ws.worksheets = [newWorksheet('S')];
    const t0 = Date.now();
    for (const p of ws.populations) expect(e.count(ws, 's1', p.id)).toBeGreaterThanOrEqual(0);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
