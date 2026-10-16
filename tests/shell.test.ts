// Worksheet / store logic of the app shell: placement, undo steps, population and sample removal, batch layouts.
import { engine } from '../src/core/engine';
import { writeFcs } from '../src/core/fcs';
import { emptyWorkspace, type PlotItem, type SheetItem, type TextItem, type Worksheet, type Workspace } from '../src/core/model';
import { deletePopulation, loadFcsFiles, newPlotItem, removeSamples, useStore, userWarnings } from '../src/state/store';
import { addPanelLabels, arrange, clipText, findFreeSlot, growPageToFit, parseClip, reorder, repeatForSamples } from '../src/ui/layoutOps';

const rect = (id: string, x: number, y: number, w = 100, h = 80): SheetItem => ({ id, kind: 'text', x, y, w, h, text: id, fontSize: 10, bold: false, italic: false, align: 'left', color: '#000' });
const sheetOf = (items: SheetItem[], page = { w: 1000, h: 700 }): Worksheet => ({ id: 's', name: 'S', page: { ...page, name: 'custom' }, grid: 10, snap: true, showGrid: true, items });
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function setup(mut?: (w: Workspace) => void) {
  const w = emptyWorkspace();
  w.samples = ['A', 'B', 'C'].map((n) => ({ id: 's' + n, name: n, fileName: n + '.fcs', fileSize: 0, eventCount: 100, channels: [], compId: null }));
  w.populations = [
    { id: 'p1', name: 'Cells', parentId: null, color: '#000', gate: { type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: 0, xmax: 1, ymin: 0, ymax: 1 } },
    { id: 'p2', name: 'T cells', parentId: 'p1', color: '#000', gate: { type: 'rect', x: 'CD3', y: 'SSC-A', xmin: 0, xmax: 1, ymin: 0, ymax: Infinity } },
    { id: 'p3', name: 'CD4', parentId: 'p2', color: '#000', gate: { type: 'range', x: 'CD4', min: 1, max: 2 } },
    { id: 'p4', name: 'Other', parentId: 'p1', color: '#000', gate: { type: 'range', x: 'CD3', min: 2, max: 3 } },
    { id: 'pb', name: 'CD4 or Other', parentId: 'p1', color: '#000', gate: { type: 'bool', op: 'or', operands: ['p3', 'p4'] } },
  ];
  mut?.(w);
  useStore.getState().replaceWorkspace(w);
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [] } });
  return w;
}
const sheet = () => useStore.getState().ws.worksheets[0];
const plots = () => sheet().items.filter((i): i is PlotItem => i.kind === 'plot');

describe('findFreeSlot', () => {
  it('returns the reading-order slot that does not overlap and is snapped', () => {
    const sh = sheetOf([rect('a', 20, 20), rect('b', 130, 20)]);
    const p = findFreeSlot(sh, 100, 80);
    expect(p).toEqual({ x: 240, y: 20 });
    expect(p.x % 10).toBe(0);
  });
  it('prefers the same row right of `near`, then below', () => {
    const sh = sheetOf([rect('a', 20, 20), rect('b', 130, 20, 800)], { w: 1000, h: 700 });
    // no room right of b on this row: goes below, close to near.x
    const p = findFreeSlot(sh, 100, 80, { x: 130, y: 20 });
    expect(p.y).toBeGreaterThan(20);
    for (const o of sh.items) expect(overlaps({ ...p, w: 100, h: 80 }, o)).toBe(false);
    const q = findFreeSlot(sheetOf([rect('a', 20, 20)]), 100, 80, { x: 130, y: 20 });
    expect(q).toEqual({ x: 130, y: 20 });
  });
  it('falls back below everything when the page is full, and growPageToFit grows the page', () => {
    const sh = sheetOf([rect('a', 0, 0, 1000, 700)]);
    const p = findFreeSlot(sh, 100, 80);
    expect(p.y).toBeGreaterThanOrEqual(710);
    const page = { page: { ...sh.page }, grid: sh.grid };
    expect(growPageToFit(page, [{ ...p, w: 100, h: 80 }])).toBe(true);
    expect(page.page.h).toBeGreaterThanOrEqual(p.y + 80);
    expect(page.page.name).toBe('custom');
  });
});

describe('undo steps', () => {
  it('coalesces a gesture regardless of pauses and splits at breakGroup', () => {
    setup();
    const st = useStore.getState();
    const n0 = st.past.length;
    st.update((w) => void (w.name = 'a'), 'move:x');
    st.update((w) => void (w.name = 'b'), 'move:x');
    useStore.setState({ lastTime: 0 }); // a long pause does not matter
    st.update((w) => void (w.name = 'c'), 'move:x');
    expect(useStore.getState().past.length).toBe(n0 + 1);
    st.breakGroup();
    st.update((w) => void (w.name = 'd'), 'move:x');
    expect(useStore.getState().past.length).toBe(n0 + 2);
  });
  it('cancelGroup reverts the running gesture', () => {
    setup();
    const st = useStore.getState();
    st.update((w) => void (w.name = 'before'));
    st.breakGroup();
    st.update((w) => void (w.name = 'x1'), 'resize:i');
    st.update((w) => void (w.name = 'x2'), 'resize:i');
    st.cancelGroup('resize:i');
    expect(useStore.getState().ws.name).toBe('before');
    expect(useStore.getState().future.length).toBe(0);
  });
  it('undo/redo repair UI references', () => {
    setup();
    const st = useStore.getState();
    st.setUI({ activeSampleId: 'sB', selectedSampleIds: ['sB', 'sC'] });
    removeSamples(['sB'], { quiet: true });
    st.update((w) => void w.groups.push({ id: 'g1', name: 'G', sampleIds: [] }));
    st.setUI({ sampleFilter: 'g1' });
    st.undo();
    expect(useStore.getState().ui.sampleFilter).toBe('all');
    st.undo(); // sample B is back
    st.redo(); // and gone again
    const ui = useStore.getState().ui;
    expect(useStore.getState().ws.samples.some((s) => s.id === ui.activeSampleId)).toBe(true);
    expect(ui.selectedSampleIds).not.toContain('sB');
  });
});

describe('deletePopulation', () => {
  it('re-points plots to the nearest surviving ancestor and removes dependent Boolean gates', () => {
    setup((w) => {
      const a = newPlotItem('pseudo', 'CD3', 'SSC-A', 0, 0, 100, 100, 'p2');
      a.options.title = 'T cells';
      a.options.labelPos = { p3: [0.5, 0.5], p1: [0.1, 0.1] };
      const b = newPlotItem('histogram', 'CD4', 'CD4', 0, 0, 100, 100, 'p3');
      b.layers.push({ id: 'l2', sample: 'active', population: 'p2' });
      w.worksheets[0].items.push(a, b, { id: 'c', kind: 'chart', x: 0, y: 0, w: 10, h: 10, stat: { id: 'k', population: 'p3', stat: 'freqOf', ofPopulation: 'p2' }, mode: 'samples', sampleSet: 'all', style: 'bar', errorBars: 'sd', showPoints: true, color: '#000', useGroupColors: false, fontSize: 8, lineWidth: 1 });
    });
    deletePopulation('p2');
    const ws = useStore.getState().ws;
    expect(ws.populations.map((p) => p.id).sort()).toEqual(['p1', 'p4']);
    const [a, b] = plots();
    expect(a.layers.map((l) => l.population)).toEqual(['p1']);
    expect(a.options.title).toBeUndefined();
    expect(Object.keys(a.options.labelPos!)).toEqual(['p1']);
    // both layers now show p1 for the active sample: the duplicate is dropped, at least one layer stays
    expect(b.layers.map((l) => l.population)).toEqual(['p1']);
    const c = sheet().items.find((i) => i.kind === 'chart')!;
    expect(c.kind === 'chart' && [c.stat.population, c.stat.ofPopulation]).toEqual(['p1', 'p1']);
    const t = useStore.getState().ui.toasts.at(-1)!;
    expect(t.text).toBe("Deleted 'T cells' and 1 subpopulation (incl. 1 Boolean gate that used it)");
    t.action!.run(); // Undo
    expect(useStore.getState().ws.populations).toHaveLength(5);
  });
});

describe('removeSamples', () => {
  it('keeps the population of pinned plots and prunes the selection', () => {
    setup((w) => {
      w.worksheets[0].items.push(newPlotItem('pseudo', 'CD3', 'SSC-A', 0, 0, 100, 100, 'p2', 'sB'));
    });
    useStore.getState().setUI({ activeSampleId: 'sB', selectedSampleIds: ['sA', 'sB'] });
    removeSamples(['sB']);
    expect(plots()[0].layers).toMatchObject([{ sample: 'active', population: 'p2' }]);
    const ui = useStore.getState().ui;
    expect(ui.selectedSampleIds).toEqual(['sA']);
    expect(ui.activeSampleId).not.toBe('sB');
    expect(ui.toasts.at(-1)!.action?.label).toBe('Undo');
  });
});

describe('batch and layout', () => {
  it('repeat for samples re-pins a template pinned to a sample', () => {
    setup((w) => {
      const t = newPlotItem('pseudo', 'CD3', 'SSC-A', 20, 20, 100, 100, 'p1', 'sA');
      t.id = 'tpl';
      w.worksheets[0].items.push(t);
    });
    repeatForSamples(sheet().id, ['tpl'], ['sA', 'sB', 'sC'], { newSheet: false, rowLabels: false });
    const copies = plots().filter((p) => p.id !== 'tpl');
    expect(copies.map((p) => p.layers[0].sample)).toEqual(['sA', 'sB', 'sC']);
    // placed in free space
    const tpl = plots().find((p) => p.id === 'tpl')!;
    for (const c of copies) expect(overlaps(c, tpl)).toBe(false);
  });
  it('panel labels replace earlier ones', () => {
    setup((w) => {
      w.worksheets[0].items.push(newPlotItem('pseudo', 'a', 'b', 20, 20, 100, 100), newPlotItem('pseudo', 'a', 'b', 140, 20, 100, 100));
    });
    addPanelLabels(sheet().id, []);
    addPanelLabels(sheet().id, []);
    const labels = sheet().items.filter((i): i is TextItem => i.kind === 'text');
    expect(labels.map((l) => l.text)).toEqual(['A', 'B']);
  });
  it('centers on the selection box, sizes to the last clicked item, aligns one item to the page', () => {
    setup((w) => {
      w.worksheets[0].items.push(rect('a', 0, 0, 100, 50), rect('b', 300, 100, 200, 80));
    });
    arrange(sheet().id, ['a', 'b'], 'hcenter');
    const [a, b] = sheet().items;
    expect(a.x + a.w / 2).toBe(250);
    expect(b.x + b.w / 2).toBe(250);
    useStore.getState().setUI({ keyItemId: 'b' });
    arrange(sheet().id, ['a', 'b'], 'sameSize');
    expect([sheet().items[0].w, sheet().items[0].h]).toEqual([200, 80]);
    arrange(sheet().id, ['a'], 'right');
    expect(sheet().items[0].x + sheet().items[0].w).toBe(sheet().page.w);
  });
  it('moves items one step forward / backward', () => {
    setup((w) => {
      w.worksheets[0].items.push(rect('a', 0, 0), rect('b', 0, 0), rect('c', 0, 0));
    });
    reorder(sheet().id, ['a'], 'forward');
    expect(sheet().items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
    reorder(sheet().id, ['c'], 'backward');
    expect(sheet().items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
  it('clipboard text round-trips and ignores other text', () => {
    const items = [rect('a', 1, 2)];
    expect(parseClip(clipText(items))).toEqual(items);
    expect(parseClip('hello')).toBeNull();
    expect(parseClip('{"application/x-flowstate-items":1,"items":[{"kind":"text"}]}')).toBeNull();
  });
});

describe('FCS loading', () => {
  it('hides the multi-dataset warning when all data sets have the same events', () => {
    const same = 'File contains 2 data sets (FCS2.0, 1000 events; FCS3.0, 1000 events); only data set 2 is loaded';
    const diff = 'File contains 2 data sets (FCS3.0, 1000 events; FCS3.0, 50 events); only data set 1 is loaded';
    expect(userWarnings({ warnings: [same, 'x'] })).toEqual(['x']);
    expect(userWarnings({ warnings: [diff] })).toEqual([diff]);
  });
  it('relinks a missing sample by file name and event count', async () => {
    const n = 50;
    const bytes = writeFcs({ channels: [{ name: 'FSC-A', range: 1000 }], data: [Float32Array.from({ length: n }, (_, i) => i)] });
    setup((w) => {
      w.samples = [
        { id: 'm1', name: 'first', fileName: 'x.fcs', fileSize: 0, eventCount: 999, channels: [], compId: null },
        { id: 'm2', name: 'second', fileName: 'x.fcs', fileSize: 0, eventCount: n, channels: [], compId: null },
      ];
    });
    const ids = await loadFcsFiles([new File([bytes], 'x.fcs')]);
    expect(ids).toEqual(['m2']);
    expect(engine.has('m2') && !engine.has('m1')).toBe(true);
    engine.removeSample('m2');
  });
});
