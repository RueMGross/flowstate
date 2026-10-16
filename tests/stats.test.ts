import { existsSync, readFileSync, writeFileSync } from 'fs';
import { parseFcs } from '../src/core/fcs';
import { Engine } from '../src/core/engine';
import { emptyWorkspace } from '../src/core/model';
import { compensate } from '../src/core/compensation';
import { getSpillover } from '../src/core/fcs';
import { channelStats } from '../src/core/stats';
import { allIndices } from '../src/core/gating';

// reference file (not part of the repository): skipped when missing
const LSRII = '/home/claude/testdata/bd/lsrii_8color.fcs';
it.skipIf(!existsSync(LSRII))('stats + compensation dump', () => {
  const b = readFileSync(LSRII);
  const ds = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  const eng = new Engine();
  eng.addSample('s', ds);
  const ws = emptyWorkspace();
  const sp = getSpillover(ds)!;
  ws.compensations = [{ id: 'c', name: 'c', channels: sp.channels, matrix: sp.matrix, source: 'file' }];
  ws.samples = [{ id: 's', name: 's', fileName: 'x', fileSize: 0, eventCount: ds.eventCount, channels: [], compId: 'c' }];
  ws.populations = [{ id: 'g', name: 'g', parentId: null, color: '#000', gate: { type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: 50000, xmax: 150000, ymin: 0, ymax: 100000 } }];
  const out: Record<string, number[]> = {};
  for (const ch of ['FSC-A', 'SSC-A', sp.channels[0], sp.channels[3]]) {
    out[ch] = (['count', 'mean', 'median', 'geomean', 'sd', 'cv', 'rsd', 'rcv', 'min', 'max'] as const).map((k) => eng.stat(ws, 's', { population: 'g', stat: k, channel: ch }));
  }
  out['first_comp'] = Array.from(eng.raw(ws, 's', sp.channels[0])!.slice(0, 5));
  for (const v of Object.values(out)) expect(v.every(Number.isFinite)).toBe(true);
  expect(out['FSC-A'][0]).toBeGreaterThan(0); // events in the gate
  // values for the comparison with FlowKit: STATS_DUMP=/path/stats_js.json npx vitest run tests/stats.test.ts
  if (process.env.STATS_DUMP) writeFileSync(process.env.STATS_DUMP, JSON.stringify({ chans: [sp.channels[0], sp.channels[3]], out }));
});

describe('mode', () => {
  // log-normal sample around 1000: the peak of a log-scale histogram is ~1000, of a linear one ~1000/e
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const v = new Float32Array(50000);
  for (let i = 0; i < v.length; i++) v[i] = Math.exp(Math.log(1000) + Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()));
  const idx = allIndices(v.length);
  it('is binned on the display scale', () => {
    expect(channelStats(v, idx, { type: 'log', min: 10, max: 1e5 }).mode).toBeGreaterThan(850);
    expect(channelStats(v, idx, { type: 'log', min: 10, max: 1e5 }).mode).toBeLessThan(1150);
    expect(channelStats(v, idx, { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 }).mode).toBeGreaterThan(800);
    expect(channelStats(v, idx).mode).toBeLessThan(600);
  });
});
