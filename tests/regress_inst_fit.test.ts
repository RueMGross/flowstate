// Regression (review 3, HIGH): "Fit axes to data" (fitScalesToData) froze app-drawn polygons to the WORKSPACE scale,
// also for samples of an instrument with its own scale (Workspace.instrumentScales), and refitted the workspace scale
// from the data of all samples (BD FSC-A became linear 0..80,000,001): counts changed (0 -> 2000).
import { writeFcs } from '../src/core/fcs';
import { engine } from '../src/core/engine';
import { emptyWorkspace, uid, type Population, type Workspace } from '../src/core/model';
import { fitScalesToData, loadFcsFiles, useStore } from '../src/state/store';

const file = (name: string, k: number, range: number, cyt: string, n = 2000) =>
  new File(
    [
      writeFcs({
        channels: [
          { name: 'FSC-A', range },
          { name: 'PE-A', range },
        ],
        data: [Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 100) + 1) * k)), Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 50) + 1) * (k / 100)))],
        keywords: { $CYT: cyt },
      }) as BlobPart,
    ],
    name,
  );

function reset() {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(emptyWorkspace());
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [] } });
}

const counts = (ws: Workspace, popId: string) => Object.fromEntries(ws.samples.map((s) => [s.name, engine.count(ws, s.id, popId)]));

// a gate drawn in the app (no own scales): FSC-A 150,000 to just beyond the BD axis end
const gate = (): Population => ({ id: uid('pop'), name: 'P', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FSC-A', y: 'PE-A', points: [[150000, -1e7], [270000, -1e7], [270000, 1e9], [150000, 1e9]] } });

describe('fitScalesToData with per-instrument scales', () => {
  it('keeps the counts of samples that have instrument scales', async () => {
    reset();
    await loadFcsFiles([file('bd.fcs', 2500, 262144, 'LSRII')]);
    await loadFcsFiles([file('cy.fcs', 800000, 16777216, 'CytoFLEX LX')]);
    let ws = useStore.getState().ws;
    expect(ws.instrumentScales?.['CytoFLEX LX']?.['FSC-A']).toBeDefined();
    const pop = gate();
    useStore.getState().update((w) => void w.populations.push(pop));
    ws = useStore.getState().ws;
    const before = counts(ws, pop.id);
    fitScalesToData(['FSC-A']);
    ws = useStore.getState().ws;
    expect(counts(ws, pop.id)).toEqual(before);
    // the workspace scale is fitted to the BD sample only (not to the CytoFLEX range)
    const fsc = ws.scales['FSC-A'] as { type: string; max: number };
    expect(fsc.max).toBeLessThan(1e6);
  });

  it('freezes only the gates whose evaluation changes, per sample where instruments differ', async () => {
    reset();
    await loadFcsFiles([file('bd.fcs', 2500, 262144, 'LSRII')]);
    await loadFcsFiles([file('cy.fcs', 800000, 16777216, 'CytoFLEX LX')]);
    // more BD data, beyond the BD axis (same instrument: no "fit axes" note while loading)
    await loadFcsFiles([file('bd2.fcs', 25000, 262144 * 16, 'LSRII')]);
    expect(useStore.getState().ui.toasts.some((t) => /Fit axes/.test(t.action?.label ?? ''))).toBe(false);
    const pop = gate();
    const other: Population = { ...gate(), name: 'PE only', gate: { type: 'polygon', x: 'PE-A', y: 'PE-A', points: [[1, 1], [1000, 1], [1000, 1000]] } };
    useStore.getState().update((w) => void w.populations.push(pop, other));
    let ws = useStore.getState().ws;
    const before = counts(ws, pop.id);
    const cyScale = ws.instrumentScales!['CytoFLEX LX']['FSC-A'];
    fitScalesToData(['FSC-A']);
    ws = useStore.getState().ws;
    expect(ws.scales['FSC-A']).not.toEqual(useStore.getState().past.at(-1)!.scales['FSC-A']);
    expect(counts(ws, pop.id)).toEqual(before);
    const p = ws.populations.find((x) => x.id === pop.id)!;
    // the BD samples (workspace scale) keep the former workspace scale through the gate; the CytoFLEX sample, whose
    // own scale did not change, gets a sample-specific copy on its own scale
    expect(p.gate.type === 'polygon' && p.gate.scales?.x).toEqual(useStore.getState().past.at(-1)!.scales['FSC-A']);
    const cy = ws.samples.find((s) => s.name === 'cy')!.id;
    expect(Object.keys(p.overrides ?? {})).toEqual([cy]);
    expect((p.overrides![cy] as { scales?: { x: unknown } }).scales?.x).toEqual(cyScale);
    // a gate on channels whose scales did not change is not touched
    expect(ws.populations.find((x) => x.id === other.id)!.gate).toEqual(other.gate);
    // one undo step brings everything back
    useStore.getState().undo();
    expect(useStore.getState().ws.populations.find((x) => x.id === pop.id)!.overrides).toBeUndefined();
  });
});
