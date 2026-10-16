// Regression (review 3): polygon / ellipse gates drawn in the app (no own scales) were copied without the scales they
// were drawn in; pasted into a workspace whose scale of the sample differs (another workspace, or per-instrument
// scales), they selected other events.
import { Engine } from '../src/core/engine';
import type { FcsDataset } from '../src/core/fcs';
import { emptyWorkspace, type Population, type Workspace } from '../src/core/model';
import { cloneGates, collectGates } from '../src/ui/gateOps';

function data(n = 20000): FcsDataset {
  let s = 99;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = Math.exp(r() * 12) - 200; // spread over decades, some negative
    y[i] = Math.exp(r() * 12) - 200;
  }
  return { channels: [{ name: 'FL1-A', label: '', range: 262144 }, { name: 'FL2-A', label: '', range: 262144 }], data: [x, y], eventCount: n, keywords: { $CYT: 'LSRII' }, warnings: [] } as unknown as FcsDataset;
}

const ws = (scaleW: number): Workspace => {
  const w = emptyWorkspace();
  w.samples = [{ id: 's', name: 's', fileName: 's.fcs', fileSize: 0, eventCount: 20000, channels: [], compId: null, instrument: 'LSRII' }];
  w.scales = { 'FL1-A': { type: 'logicle', T: 262144, W: scaleW, M: 4.5, A: 0 }, 'FL2-A': { type: 'logicle', T: 262144, W: scaleW, M: 4.5, A: 0 } };
  return w;
};

it('a pasted polygon selects the same events as the copied one', () => {
  const d = data();
  const a = ws(0.5);
  const tri: Population = { id: 'p', name: 'Tri', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FL1-A', y: 'FL2-A', points: [[-100, -100], [5000, -50], [200, 8000]] } };
  a.populations = [tri];
  const ea = new Engine();
  ea.addSample('s', d);
  const n0 = ea.count(a, 's', 'p');
  // another workspace with the same sample, its FL axes with another logicle width
  const b = ws(1.5);
  const pasted = cloneGates(b, collectGates(a, 'p', false)!, null);
  b.populations = pasted;
  const eb = new Engine();
  eb.addSample('s', d);
  const n1 = eb.count(b, 's', pasted[0].id);
  // same workspace scales, but the sample's instrument has its own FL scales in the target
  const c = ws(0.5);
  c.instrumentScales = { LSRII: { 'FL1-A': { type: 'logicle', T: 262144, W: 1.5, M: 4.5, A: 0 }, 'FL2-A': { type: 'logicle', T: 262144, W: 1.5, M: 4.5, A: 0 } } };
  const pc = cloneGates(c, collectGates(a, 'p', false)!, null);
  c.populations = pc;
  const n2 = eb.count(c, 's', pc[0].id);

  expect(n1).toBe(n0);
  expect(n2).toBe(n0);
});

it('a gate pasted in its own workspace keeps following the axes', () => {
  const a = ws(0.5);
  a.instrumentScales = { LSRII: { 'FL1-A': { type: 'logicle', T: 262144, W: 1.5, M: 4.5, A: 0 } } };
  const tri: Population = { id: 'p', name: 'Tri', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FL1-A', y: 'FL2-A', points: [[-100, -100], [5000, -50], [200, 8000]] } };
  a.populations = [tri];
  const notes: string[] = [];
  const pasted = cloneGates(a, collectGates(a, 'p', false)!, null, { notes });
  expect(pasted[0].gate).toEqual(tri.gate);
  expect(pasted[0].overrides).toBeUndefined();
  expect(notes).toEqual([]);
  // pasted elsewhere, the paste notes say why the gate got scales
  const b = ws(1.5);
  const n2: string[] = [];
  const p2 = cloneGates(b, collectGates(a, 'p', false)!, null, { notes: n2 });
  expect(p2[0].gate.type === 'polygon' && p2[0].gate.scales).toBeTruthy();
  expect(n2.join(' ')).toMatch(/keeps the axis scales it was drawn in/);
});
