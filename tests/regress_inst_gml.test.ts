// Regression (review 3): Gating-ML export with per-instrument scales warned that gates "may count slightly differently";
// for the instrument's samples the difference can be total (app-drawn gates were exported on the workspace scale).
// Now such a workspace is exported as one Gating-ML document per instrument, each exact for its samples.
import { writeFcs } from '../src/core/fcs';
import { Engine, engine } from '../src/core/engine';
import { exportGatingMLDoc, importGatingML, instrumentDependentGates } from '../src/core/gatingml';
import { emptyWorkspace, uid, type Population, type Workspace } from '../src/core/model';
import { loadFcsFiles, useStore } from '../src/state/store';
import { gatingMLExportFiles } from '../src/io/files';

const file = (name: string, k: number, range: number, cyt: string, n = 2000) =>
  new File([writeFcs({ channels: [{ name: 'FSC-A', range }, { name: 'PE-A', range }], data: [Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 100) + 1) * k)), Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 50) + 1) * (k / 100)))], keywords: { $CYT: cyt } }) as BlobPart], name);

/** count of the first population of a Gating-ML document on a loaded sample's data (as another program would) */
function countWith(xml: string, sampleId: string): number {
  const res = importGatingML(xml);
  const w2 = emptyWorkspace();
  w2.samples = [{ id: 'x', name: 'x', fileName: 'x', fileSize: 0, eventCount: 2000, channels: [], compId: null }];
  w2.populations = res.populations;
  const e2 = new Engine();
  e2.addSample('x', engine.samples.get(sampleId)!.ds);
  return e2.count(w2, 'x', res.populations[0].id);
}

it('exported gates count the samples of every instrument as the app does', async () => {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(emptyWorkspace());
  await loadFcsFiles([file('bd.fcs', 2500, 262144, 'LSRII')]);
  await loadFcsFiles([file('cy.fcs', 800000, 16777216, 'CytoFLEX LX')]);
  const pop: Population = { id: uid('pop'), name: 'P', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FSC-A', y: 'PE-A', points: [[150000, -1e7], [270000, -1e7], [270000, 1e9], [150000, 1e9]] } };
  useStore.getState().update((w) => void w.populations.push(pop));
  const ws: Workspace = useStore.getState().ws;
  const bd = ws.samples.find((s) => s.name === 'bd')!.id;
  const cy = ws.samples.find((s) => s.name === 'cy')!.id;
  expect(instrumentDependentGates(ws).map((p) => p.id)).toEqual([pop.id]);
  // the instrument's own document counts its sample as the app does (the workspace-scale one does not)
  expect(countWith(exportGatingMLDoc(ws, { instrument: 'CytoFLEX LX' }).xml, cy)).toBe(engine.count(ws, cy, pop.id));
  expect(countWith(exportGatingMLDoc(ws).xml, cy)).not.toBe(engine.count(ws, cy, pop.id));
  // the export: one document per instrument
  const files = gatingMLExportFiles(ws);
  expect(files.map((f) => f.instruments)).toEqual([['LSRII'], ['CytoFLEX LX']]);
  expect(new Set(files.map((f) => f.fileName)).size).toBe(2);
  expect(countWith(files[0].doc.xml, bd)).toBe(engine.count(ws, bd, pop.id));
  expect(countWith(files[1].doc.xml, cy)).toBe(engine.count(ws, cy, pop.id));
  // gates with their own scales (or rectangles) do not depend on the instrument: a single document
  const ws2: Workspace = { ...ws, populations: [{ ...pop, gate: { type: 'rect', x: 'FSC-A', y: 'PE-A', xmin: 0, xmax: 1e5, ymin: 0, ymax: 1e5 } }] };
  expect(gatingMLExportFiles(ws2).length).toBe(1);
});
