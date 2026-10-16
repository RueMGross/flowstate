// Regression (acceptance round 3, MED): "Fit axes to data" with per-instrument scales (BD Activation_1 + CytoFLEX
// Unstained_Cells, polygons on FSC-A vs FSC-H) turned every gate into "adjusted for Activation_1 only" (sample-specific
// copies, drawn dashed) and the Gating-ML export collapsed to one file without the BD positions. Now a gate keeps the
// former scales of the instrument it has events on; copies only where a gate has events on samples evaluated on
// different scales, and the Gating-ML export gives each instrument a document that counts its samples as the app does.
import { existsSync, readFileSync } from 'fs';
import { Engine, engine } from '../src/core/engine';
import { importGatingML } from '../src/core/gatingml';
import { emptyWorkspace, uid, type Population, type Workspace } from '../src/core/model';
import { gatingMLExportFiles } from '../src/io/files';
import { fitScalesToData, freezePlan, loadFcsFiles, newPlotItem, useStore, type EvalPair } from '../src/state/store';
import { fitAllAxes } from '../src/ui/axisFit';

const BD = '/home/claude/testdata/bd/Activation_1.fcs';
const CY = '/home/claude/testdata/cytoflex/Unstained_Cells.fcs';
const have = existsSync(BD) && existsSync(CY);

function reset() {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(emptyWorkspace());
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [] } });
}
const fileOf = (p: string) => new File([readFileSync(p) as BlobPart], p.split('/').pop()!);
const counts = (ws: Workspace, popId: string) => ws.samples.map((s) => engine.count(ws, s.id, popId));

/** count of a population of a Gating-ML document on a loaded sample's data (as another program would) */
function countWith(xml: string, sampleId: string, name: string): number {
  const res = importGatingML(xml);
  const w2 = emptyWorkspace();
  const ds = engine.samples.get(sampleId)!.ds;
  w2.samples = [{ id: 'x', name: 'x', fileName: 'x', fileSize: 0, eventCount: ds.eventCount, channels: [], compId: null }];
  w2.populations = res.populations;
  const e2 = new Engine();
  e2.addSample('x', ds);
  const p = res.populations.find((q) => q.name === name)!;
  return e2.count(w2, 'x', p.id);
}

async function setup() {
  reset();
  await loadFcsFiles([fileOf(BD)]);
  await loadFcsFiles([fileOf(CY)]);
  const ws = useStore.getState().ws;
  const bd = ws.samples.find((s) => s.name === 'Activation_1')!.id;
  const cy = ws.samples.find((s) => s.name === 'Unstained_Cells')!.id;
  // P2 drawn on the BD plot (FSC-A 0..262144), P3 drawn on the CytoFLEX plot (its own scales, millions)
  const p2: Population = { id: uid('pop'), name: 'P2', parentId: null, color: '#1f77b4', gate: { type: 'polygon', x: 'FSC-A', y: 'FSC-H', points: [[50000, 100000], [150000, 130000], [200000, 100000], [160000, 20000], [80000, 15000], [40000, 30000]] } };
  const p3: Population = { id: uid('pop'), name: 'P3', parentId: null, color: '#2ca02c', gate: { type: 'polygon', x: 'FSC-A', y: 'FSC-H', points: [[300000, 300000], [800000, 1300000], [1600000, 2000000], [2400000, 1800000], [1200000, 400000], [600000, 150000]] } };
  const st = useStore.getState();
  st.update((w) => {
    w.populations.push(p2, p3);
    w.worksheets[0].items.push(newPlotItem('pseudo', 'FSC-A', 'FSC-H', 0, 0, 200, 200));
  });
  return { bd, cy, p2: p2.id, p3: p3.id };
}

describe.skipIf(!have)('fit axes to data with BD + CytoFLEX samples', () => {
  it('needs instrument scales (CytoFLEX gets its own)', async () => {
    await setup();
    const ws = useStore.getState().ws;
    expect(Object.keys(ws.instrumentScales ?? {}).length).toBe(1);
  });

  for (const which of ['active BD sample', 'both samples selected', 'fitScalesToData'] as const) {
    it(`each gate keeps the scales of the instrument it has events on (${which})`, async () => {
      const { bd, cy, p2, p3 } = await setup();
      const ws0 = useStore.getState().ws;
      const before2 = counts(ws0, p2);
      const before3 = counts(ws0, p3);
      // P2 has events on BD only, P3 on the CytoFLEX only
      expect(before2[0]).toBeGreaterThan(1000);
      expect(before2[1]).toBe(0);
      expect(before3[0]).toBe(0);
      expect(before3[1]).toBeGreaterThan(1000);
      if (which === 'fitScalesToData') fitScalesToData(['FSC-A', 'FSC-H']);
      else {
        useStore.getState().setUI({ activeSampleId: bd, selectedSampleIds: which === 'active BD sample' ? [bd] : [bd, cy], activeSheetId: ws0.worksheets[0].id });
        fitAllAxes(ws0.worksheets[0].id);
      }
      const ws = useStore.getState().ws;
      if (which !== 'fitScalesToData') expect(ws.scales['FSC-A']).not.toEqual(ws0.scales['FSC-A']);
      // identical counts, no sample-specific copies (nothing drawn dashed, nothing "adjusted for ... only")
      expect(counts(ws, p2)).toEqual(before2);
      expect(counts(ws, p3)).toEqual(before3);
      for (const id of [p2, p3]) expect(ws.populations.find((p) => p.id === id)!.overrides ?? {}).toEqual({});
      // P2 keeps the BD (workspace) scales it was drawn in
      const g2 = ws.populations.find((p) => p.id === p2)!.gate as { scales?: { x: unknown } };
      expect(g2.scales?.x ?? ws.scales['FSC-A']).toEqual(ws0.scales['FSC-A']);
      // P3: the CytoFLEX scales (its own when they were refitted too; else it still follows the CytoFLEX axes)
      const g3 = ws.populations.find((p) => p.id === p3)!.gate as { scales?: { x: unknown } };
      const cyBefore = ws0.instrumentScales![Object.keys(ws0.instrumentScales!)[0]]['FSC-A'];
      if (g3.scales) expect(g3.scales.x).toEqual(cyBefore);
      else expect(ws.instrumentScales![Object.keys(ws.instrumentScales!)[0]]['FSC-A']).toEqual(cyBefore);
      const toast = useStore.getState().ui.toasts.at(-1)!.text;
      if (which !== 'fitScalesToData') expect(toast).toMatch(/keeps? (its|their) counts/);
      expect(toast).not.toMatch(/sample-specific/);
      // Gating-ML: the documents count each instrument's samples as the app does
      const files = gatingMLExportFiles(ws);
      for (const [sid, i] of [[bd, 0], [cy, 1]] as const) {
        const f = files.find((x) => !x.instruments.length || x.instruments.some((n) => (i === 0 ? !/CytoFLEX/i.test(n) : /CytoFLEX/i.test(n))))!;
        expect(countWith(f.doc.xml, sid, 'P2')).toBe(counts(ws, p2)[i]);
        expect(countWith(f.doc.xml, sid, 'P3')).toBe(counts(ws, p3)[i]);
      }
    });
  }

  it('a gate with events on both instruments gets copies only for the other instrument, and says so', async () => {
    const { bd, cy } = await setup();
    // a wide polygon with events on both samples (FSC-A 1e4 .. 2.4e6)
    const both: Population = { id: uid('pop'), name: 'Both', parentId: null, color: '#d62728', gate: { type: 'polygon', x: 'FSC-A', y: 'FSC-H', points: [[10000, 5000], [2400000, 5000], [2400000, 2400000], [10000, 2400000]] } };
    useStore.getState().update((w) => void w.populations.push(both));
    const ws0 = useStore.getState().ws;
    const before = counts(ws0, both.id);
    expect(before.every((n) => n > 100)).toBe(true);
    useStore.getState().setUI({ activeSampleId: bd, selectedSampleIds: [bd, cy], activeSheetId: ws0.worksheets[0].id });
    fitAllAxes(ws0.worksheets[0].id);
    const ws = useStore.getState().ws;
    expect(counts(ws, both.id)).toEqual(before);
    const p = ws.populations.find((q) => q.id === both.id)!;
    expect(Object.keys(p.overrides ?? {}).length).toBe(1);
    expect(useStore.getState().ui.toasts.at(-1)!.text).toMatch(/"Both": a shared gate would change the counts on "[^"]+", so it got a sample-specific copy there/);
    // Gating-ML: one document per instrument, each with the position the app uses for its samples
    const files = gatingMLExportFiles(ws);
    expect(files.length).toBe(2);
    expect(files[0].differing).toContain('Both');
    for (const [sid, i] of [[bd, 0], [cy, 1]] as const) {
      const f = files.find((x) => x.instruments.some((n) => (i === 0 ? !/CytoFLEX/i.test(n) : /CytoFLEX/i.test(n))))!;
      expect(f.doc.warnings.join(' ')).not.toMatch(/sample-specific positions/);
      expect(countWith(f.doc.xml, sid, 'Both')).toBe(before[i]);
    }
  });
});

describe('freezePlan with evidence of events', () => {
  const A: EvalPair = { x: { type: 'linear', min: 0, max: 1 }, y: { type: 'linear', min: 0, max: 1 } };
  const A2: EvalPair = { x: { type: 'linear', min: 0, max: 2 }, y: { type: 'linear', min: 0, max: 2 } };
  const B: EvalPair = { x: { type: 'linear', min: 0, max: 10 }, y: { type: 'linear', min: 0, max: 10 } };
  const before = (s: string | null) => (s === 'b' ? B : A);
  const after = (s: string | null) => (s === 'b' ? B : A2);
  it('without evidence: as before (copies for the samples that cannot share)', () => {
    expect(freezePlan(['a', 'b'], before, after)).toEqual({ shared: null, perSample: [['a', A]] });
  });
  it('a gate with events on one instrument keeps its scales; empty samples share them', () => {
    const plan = freezePlan(['a', 'b'], before, after, { members: (s) => (s === 'a' ? 50 : 0), staysEmpty: () => true });
    expect(plan).toEqual({ shared: A, perSample: [] });
  });
  it('an empty sample that would gain events keeps a copy (the gate keeps the scales of its events)', () => {
    const plan = freezePlan(['a', 'b'], before, after, { members: (s) => (s === 'a' ? 50 : 0), staysEmpty: () => false });
    expect(plan).toEqual({ shared: A, perSample: [['b', B]] });
  });
  it('a gate without events where the scales change is not touched', () => {
    expect(freezePlan(['a', 'b'], before, after, { members: (s) => (s === 'b' ? 50 : 0), staysEmpty: () => true })).toBeNull();
  });
  it('events on both: the copy goes to the sample with fewer events', () => {
    const after2 = () => A2;
    const plan = freezePlan(['a', 'b'], before, after2, { members: (s) => (s === 'a' ? 5 : 500), staysEmpty: () => false });
    expect(plan).toEqual({ shared: B, perSample: [['a', A]] });
  });
});
