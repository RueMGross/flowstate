// Regression (review 3): FlowJo grid polygons are exported to Gating-ML as plain polygons; other software (FlowKit, the
// app's own Gating-ML import) counts them differently. The export now says so.
import { Engine } from '../src/core/engine';
import { writeFcs, type FcsDataset } from '../src/core/fcs';
import { importFlowJo } from '../src/core/flowjo';
import { exportGatingMLDoc, importGatingML } from '../src/core/gatingml';
import { polygonGateGrids } from '../src/core/gating';
import { emptyWorkspace, type Workspace } from '../src/core/model';

const NS =
  'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';
const dim = (n: string) => `<gating:dimension><data-type:fcs-dimension data-type:name="${n}"/></gating:dimension>`;
const vtx = (x: number, y: number) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
export const WSP = `<?xml version="1.0"?><Workspace version="20.0" flowJoVersion="10.8.1" ${NS}><SampleList><Sample>
  <DataSet uri="file:/a.fcs" sampleID="1"/>
  <Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="1024" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:linear transforms:minRange="0" transforms:maxRange="1024" gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
  </Transformations>
  <Keywords><Keyword name="$PAR" value="2"/><Keyword name="$P1N" value="FSC-A"/><Keyword name="$P2N" value="SSC-A"/><Keyword name="$P1R" value="1024"/><Keyword name="$P2R" value="1024"/></Keywords>
  <SampleNode name="a.fcs" count="20000" sampleID="1"><Subpopulations>
    <Population name="Cells" count="-1"><Gate><gating:PolygonGate eventsInside="1" gateResolution="256">${dim('FSC-A')}${dim('SSC-A')}${vtx(100.3, 100.3)}${vtx(600.7, 120.2)}${vtx(500.1, 700.9)}</gating:PolygonGate></Gate></Population>
  </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;

export function data(n = 20000): FcsDataset {
  let s = 12345;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = r() * 1024;
    y[i] = r() * 1024;
  }
  return { channels: [{ name: 'FSC-A', label: '', range: 1024 }, { name: 'SSC-A', label: '', range: 1024 }], data: [x, y], eventCount: n, keywords: {}, warnings: [] } as unknown as FcsDataset;
}

it('grid polygon: the Gating-ML export warns that other programs count it differently', () => {
  const ws: Workspace = importFlowJo(WSP).workspace;
  const pop = ws.populations.find((p) => p.name === 'Cells')!;
  expect(polygonGateGrids(pop.gate)).not.toBeNull();
  const eng = new Engine();
  const d = data();
  eng.addSample(ws.samples[0].id, d);
  const app = eng.count(ws, ws.samples[0].id, pop.id);

  const doc = exportGatingMLDoc(ws);
  // evaluated by a Gating-ML reader (the app's own importer, strict polygons like FlowKit)
  const res = importGatingML(doc.xml);
  const w2 = emptyWorkspace();
  w2.samples = [{ id: 's', name: 's', fileName: 's.fcs', fileSize: 0, eventCount: d.eventCount, channels: [], compId: null }];
  w2.populations = res.populations;
  const e2 = new Engine();
  e2.addSample('s', d);
  const other = e2.count(w2, 's', res.populations[0].id);

  // the counts differ ...
  expect(other).not.toBe(app);
  // ... and the export tells the user
  expect(doc.warnings.some((w) => /FlowJo channel-grid gates are evaluated exactly by other programs; counts can differ, especially for dim populations/.test(w))).toBe(true);
});
