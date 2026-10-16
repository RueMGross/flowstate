// Regression (review 3, MED): "Fit all axes to data" (ui/axisFit.ts fitAllAxes) refitted workspace AND per-instrument
// scales without freezing app-drawn polygon / ellipse gates: counts changed silently (4704 -> 2149).
import { engine } from '../src/core/engine';
import type { FcsDataset } from '../src/core/fcs';
import { emptyWorkspace, uid, type Population } from '../src/core/model';
import { addDataset, newPlotItem, useStore } from '../src/state/store';
import { fitAllAxes } from '../src/ui/axisFit';

function ds(seed: number, k: number, cyt: string): FcsDataset {
  let s = seed;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const n = 20000;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (Math.exp(r() * 10) - 50) * k;
    y[i] = (Math.exp(r() * 10) - 50) * k;
  }
  return { channels: [{ name: 'FL1-A', label: '', range: 262144 * k }, { name: 'FL2-A', label: '', range: 262144 * k }], data: [x, y], eventCount: n, keywords: { $CYT: cyt }, warnings: [] } as unknown as FcsDataset;
}

it('fit all axes keeps gate counts', () => {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(emptyWorkspace());
  const a = addDataset('a.fcs', 0, ds(5, 1, 'LSRII'));
  const st = useStore.getState();
  const sheet = st.ws.worksheets[0];
  const plot = newPlotItem('dot', 'FL1-A', 'FL2-A', 0, 0, 200, 200);
  const pop: Population = { id: uid('pop'), name: 'Tri', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FL1-A', y: 'FL2-A', points: [[-30, -30], [3000, -20], [100, 6000]] } };
  st.update((w) => {
    w.worksheets[0].items.push(plot);
    w.populations.push(pop);
    // an axis set by hand before (e.g. a wider logicle)
    w.scales['FL1-A'] = { type: 'logicle', T: 1e6, W: 1.5, M: 5, A: 0 };
    w.scales['FL2-A'] = { type: 'logicle', T: 1e6, W: 1.5, M: 5, A: 0 };
  });
  useStore.getState().setUI({ activeSampleId: a, activeSheetId: sheet.id });
  const before = engine.count(useStore.getState().ws, a, pop.id);
  fitAllAxes(sheet.id);
  const after = engine.count(useStore.getState().ws, a, pop.id);

  expect(after).toBe(before);
});

it('fit all axes keeps gate counts with per-instrument scales', async () => {
  const { writeFcs } = await import('../src/core/fcs');
  const { loadFcsFiles } = await import('../src/state/store');
  const file = (name: string, k: number, range: number, cyt: string, n = 2000) =>
    new File([writeFcs({ channels: [{ name: 'FSC-A', range }, { name: 'PE-A', range }], data: [Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 100) + 1) * k)), Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 50) + 1) * (k / 100)))], keywords: { $CYT: cyt } }) as BlobPart], name);
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(emptyWorkspace());
  await loadFcsFiles([file('bd.fcs', 2500, 262144, 'LSRII')]);
  await loadFcsFiles([file('cy.fcs', 800000, 16777216, 'CytoFLEX LX')]);
  const pop: Population = { id: uid('pop'), name: 'P', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FSC-A', y: 'PE-A', points: [[150000, -1e7], [270000, -1e7], [270000, 1e9], [150000, 1e9]] } };
  const st = useStore.getState();
  st.update((w) => {
    w.populations.push(pop);
    // axes set by hand: both get refitted
    w.scales['FSC-A'] = { type: 'linear', min: 0, max: 1e6 };
    w.instrumentScales!['CytoFLEX LX']['FSC-A'] = { type: 'linear', min: 0, max: 1e9 };
  });
  const ws0 = useStore.getState().ws;
  const ids = ws0.samples.map((s) => s.id);
  const before = ids.map((id) => engine.count(ws0, id, pop.id));
  useStore.getState().setUI({ selectedSampleIds: ids, activeSampleId: ids[0] });
  fitAllAxes(ws0.worksheets[0].id);
  const ws = useStore.getState().ws;
  expect(ws.scales['FSC-A']).not.toEqual(ws0.scales['FSC-A']);
  expect(ws.instrumentScales!['CytoFLEX LX']['FSC-A']).not.toEqual(ws0.instrumentScales!['CytoFLEX LX']['FSC-A']);
  expect(ids.map((id) => engine.count(ws, id, pop.id))).toEqual(before);
});
