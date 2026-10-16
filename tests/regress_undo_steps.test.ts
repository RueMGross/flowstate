// Regression (review 3): (1) loading files of a new instrument took two undo steps although the load toast promises
// one; (2) an AI run squashed every change made while it ran (also the user's own edits) into its single undo step.
import { writeFcs } from '../src/core/fcs';
import { engine } from '../src/core/engine';
import { emptyWorkspace } from '../src/core/model';
import { loadFcsFiles, markStep, runAs, useStore } from '../src/state/store';
import { squashSince, stepsSince } from '../src/ai/history';

const file = (name: string, k: number, range: number, cyt: string, n = 2000) =>
  new File([writeFcs({ channels: [{ name: 'FSC-A', range }, { name: 'PE-A', range }], data: [Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 100) + 1) * k)), Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 50) + 1) * (k / 100)))], keywords: { $CYT: cyt } }) as BlobPart], name);

function reset() {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(emptyWorkspace());
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [] } });
}

it('a file load is one undo step, as its toast says', async () => {
  reset();
  await loadFcsFiles([file('bd.fcs', 2500, 262144, 'LSRII')]);
  await loadFcsFiles([file('cy.fcs', 800000, 16777216, 'CytoFLEX LX')]);
  expect(useStore.getState().ws.instrumentScales?.['CytoFLEX LX']).toBeDefined();
  const toast = useStore.getState().ui.toasts.find((t) => /Loaded 1 file/.test(t.text))!.text;
  expect(toast).toMatch(/removes it again in one step/);
  useStore.getState().undo();
  expect(useStore.getState().ws.samples.map((s) => s.name)).toEqual(['bd']);
  expect(useStore.getState().ws.instrumentScales?.['CytoFLEX LX']).toBeUndefined();
  // and Redo brings both back in one step
  useStore.getState().redo();
  expect(useStore.getState().ws.samples.map((s) => s.name)).toEqual(['bd', 'cy']);
  expect(useStore.getState().ws.instrumentScales?.['CytoFLEX LX']).toBeDefined();
});

it('undoing an AI run does not undo edits the user made while it ran', () => {
  reset();
  const st = useStore.getState();
  const before = useStore.getState().ws;
  runAs('ai', () => st.update((w) => void w.worksheets.push({ ...w.worksheets[0], id: 'ai', name: 'AI gating', items: [] }))); // AI: new sheet
  useStore.getState().breakGroup();
  useStore.getState().update((w) => void (w.name = 'renamed by the user')); // user edit while the AI waits for the model
  runAs('ai', () => useStore.getState().update((w) => void (w.channelLabels['FSC-A'] = 'x'))); // AI: a plot
  useStore.getState().update((w) => void (w.channelLabels['PE-A'] = 'y')); // AI: a gate made by its preview ...
  markStep('ai'); // ... reported back to the run
  squashSince(before, 'ai'); // end of runStrategy
  expect(stepsSince(before)).toBe(3);
  useStore.getState().undo(); // the run's last part (plot and gate) in one step
  expect(useStore.getState().ws.channelLabels).toEqual({});
  expect(useStore.getState().ws.name).toBe('renamed by the user');
  useStore.getState().undo(); // the user's rename
  expect(useStore.getState().ws.name).not.toBe('renamed by the user');
  expect(useStore.getState().ws.worksheets.some((w) => w.id === 'ai')).toBe(true);
  useStore.getState().undo(); // the run's first part
  expect(useStore.getState().ws).toBe(before);
});

it('an AI run without edits in between is one undo step', () => {
  reset();
  const before = useStore.getState().ws;
  runAs('ai', () => useStore.getState().update((w) => void (w.name = 'a')));
  runAs('ai', () => useStore.getState().update((w) => void (w.name = 'b')));
  useStore.getState().update((w) => void (w.name = 'c'));
  markStep('ai');
  squashSince(before, 'ai');
  expect(stepsSince(before)).toBe(1);
  useStore.getState().undo();
  expect(useStore.getState().ws).toBe(before);
});
