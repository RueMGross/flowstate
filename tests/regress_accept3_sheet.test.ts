// Regressions of acceptance round 3 (worksheet, minor): repeat headers follow sample renames (unless edited by hand),
// FlowJo's stored counts are saved with the workspace, a sheet may have its own figure font size, and alignment guides
// win over grid snapping at any zoom.
import { emptyWorkspace, MM, type PlotItem, type TextItem, type Workspace } from '../src/core/model';
import { repairWorkspace } from '../src/core/repair';
import { bodyPt, panelLabelPt } from '../src/render/figstyle';
import { parseWorkspace, serializeWorkspace } from '../src/io/files';
import { newPlotItem, useStore } from '../src/state/store';
import { addPanelLabels, repeatForSamples } from '../src/ui/layoutOps';
import { alignDrag, snapV } from '../src/ui/SheetView';

function setup(mut?: (w: Workspace) => void) {
  const w = emptyWorkspace();
  w.samples = ['Donor A', 'Donor B'].map((n, i) => ({ id: 's' + i, name: n, fileName: n + '.fcs', fileSize: 0, eventCount: 100, channels: [], compId: null }));
  w.populations = [{ id: 'p1', name: 'Cells', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FSC-A', y: 'SSC-A', points: [[0, 0], [1, 0], [1, 1]] } }];
  mut?.(w);
  useStore.getState().replaceWorkspace(w);
  return w;
}
const sheet = () => useStore.getState().ws.worksheets[0];
const texts = () => sheet().items.filter((i): i is TextItem => i.kind === 'text');
const rename = (id: string, name: string) =>
  useStore.getState().update((w) => {
    w.samples.find((s) => s.id === id)!.name = name;
  });

describe('repeat headers follow sample renames', () => {
  for (const orientation of ['rows', 'columns'] as const) {
    it(`${orientation}: the header of a renamed sample changes, an edited one stays`, () => {
      setup((w) => {
        const t = newPlotItem('pseudo', 'FSC-A', 'SSC-A', 40, 40, 200, 180, 'p1');
        t.id = 'tpl';
        w.worksheets[0].items.push(t);
      });
      repeatForSamples(sheet().id, ['tpl'], ['s0', 's1'], { newSheet: false, rowLabels: true, orientation, removeTemplate: true });
      const before = texts().filter((t) => t.sampleHeader);
      expect(before.map((t) => t.text)).toEqual(['Donor A', 'Donor B']);
      // edit the second header by hand
      useStore.getState().update((w) => {
        const t = w.worksheets[0].items.find((i) => i.id === before[1].id) as TextItem;
        t.text = 'Second donor';
      });
      const a = before[0];
      rename('s0', 'Healthy control 1');
      rename('s1', 'Patient 7');
      const after = texts();
      const ha = after.find((t) => t.id === a.id)!;
      expect(ha.text.replace(/\n/g, ' ')).toBe('Healthy control 1');
      expect(ha.sampleHeader!.auto).toBe(ha.text);
      // the box keeps its bottom (column headers) or middle (row labels)
      if (orientation === 'columns') expect(ha.y + ha.h).toBeCloseTo(a.y + a.h, 6);
      else expect(ha.y + ha.h / 2).toBeCloseTo(a.y + a.h / 2, 6);
      expect(after.find((t) => t.id === before[1].id)!.text).toBe('Second donor');
      // one undo step undoes the rename together with its header
      useStore.getState().undo();
      expect(texts().find((t) => t.id === before[1].id)!.text).toBe('Second donor');
      useStore.getState().undo();
      expect(texts().find((t) => t.id === a.id)!.text).toBe('Donor A');
    });
  }
  it('a long new name wraps like the header was made', () => {
    setup((w) => {
      const t = newPlotItem('pseudo', 'FSC-A', 'SSC-A', 40, 40, 120, 110, 'p1');
      t.id = 'tpl';
      w.worksheets[0].items.push(t);
    });
    repeatForSamples(sheet().id, ['tpl'], ['s0', 's1'], { newSheet: false, rowLabels: true, orientation: 'columns', removeTemplate: true });
    rename('s0', 'Specimen_001_C2_C02 Peptide stimulated');
    const h = texts().find((t) => t.sampleHeader?.sample === 's0')!;
    expect(h.text.split('\n').length).toBe(2);
  });
  it('repair keeps a valid header reference and drops a damaged one', () => {
    const w = setup((ws) => {
      ws.worksheets[0].items.push(
        { id: 't1', kind: 'text', x: 0, y: 0, w: 50, h: 10, text: 'Donor A', fontSize: 8, bold: true, italic: false, align: 'center', color: '', sampleHeader: { sample: 's0', auto: 'Donor A' } },
        { id: 't2', kind: 'text', x: 0, y: 20, w: 50, h: 10, text: 'X', fontSize: 8, bold: true, italic: false, align: 'center', color: '', sampleHeader: { sample: 'gone', auto: 'X' } } as TextItem,
      );
    });
    const r = repairWorkspace(JSON.parse(JSON.stringify(w)));
    const its = r.ws.worksheets[0].items as TextItem[];
    expect(its.find((i) => i.id === 't1')!.sampleHeader).toEqual({ sample: 's0', auto: 'Donor A' });
    expect(its.find((i) => i.id === 't2')!.sampleHeader).toBeUndefined();
  });
});

describe("FlowJo's stored counts are saved with the workspace", () => {
  it('survive save and reopen; stale and damaged entries are dropped', () => {
    const w = setup((ws) => {
      ws.flowjoCounts = { fileName: 'ICS.wsp', counts: { s0: { root: 1000, p1: 400, gone: 3 }, s1: { root: 900, p1: 'x' as unknown as number }, s9: { root: 1 } } };
    });
    expect(useStore.getState().ui.flowjoCounts?.fileName).toBe('ICS.wsp');
    const back = parseWorkspace(serializeWorkspace(w));
    expect(back.flowjoCounts).toEqual({ fileName: 'ICS.wsp', counts: { s0: { root: 1000, p1: 400 }, s1: { root: 900 } } });
    useStore.getState().replaceWorkspace(back);
    // the comparison works again after reopening
    expect(useStore.getState().ui.flowjoCounts?.counts.s0.p1).toBe(400);
    // a workspace without them: none
    useStore.getState().replaceWorkspace(emptyWorkspace());
    expect(useStore.getState().ui.flowjoCounts).toBeNull();
    // damaged: dropped
    const bad = repairWorkspace({ ...JSON.parse(serializeWorkspace(w)), flowjoCounts: 7 });
    expect(bad.ws.flowjoCounts).toBeUndefined();
  });
});

describe('a sheet with its own figure font size', () => {
  it('overrides the workspace size for its new items only', () => {
    setup((w) => {
      w.style.fontSize = 6;
      w.worksheets.push({ ...JSON.parse(JSON.stringify(w.worksheets[0])), id: 'slide', name: 'Slide', fontSize: 14, items: [] });
    });
    const ws = useStore.getState().ws;
    const journal = ws.worksheets[0];
    const slide = ws.worksheets.find((s) => s.id === 'slide')!;
    expect(bodyPt(ws, journal)).toBe(6);
    expect(bodyPt(ws, slide)).toBe(14);
    expect(panelLabelPt(ws, slide)).toBe(14);
    useStore.getState().setUI({ activeSheetId: 'slide' });
    expect(newPlotItem('pseudo', 'FSC-A', 'SSC-A', 0, 0).options.fontSize).toBe(14);
    useStore.getState().setUI({ activeSheetId: journal.id });
    expect(newPlotItem('pseudo', 'FSC-A', 'SSC-A', 0, 0).options.fontSize).toBe(6);
    // panel letters on the slide: its size
    useStore.getState().update((w) => void w.worksheets[1].items.push({ ...newPlotItem('pseudo', 'FSC-A', 'SSC-A', 40, 40, 200, 180), id: 'sp' } as PlotItem));
    useStore.getState().setUI({ activeSheetId: 'slide' });
    addPanelLabels('slide', []);
    const letter = useStore.getState().ws.worksheets[1].items.find((i) => i.kind === 'text') as TextItem;
    expect(letter.fontSize).toBe(14);
    // repaired: a damaged size is dropped (the workspace size applies)
    const r = repairWorkspace({ ...JSON.parse(serializeWorkspace(useStore.getState().ws)) });
    expect(r.ws.worksheets[1].fontSize).toBe(14);
    const r2 = repairWorkspace({ ...JSON.parse(serializeWorkspace(useStore.getState().ws)), worksheets: [{ ...JSON.parse(JSON.stringify(slide)), fontSize: 'big' }] });
    expect(r2.ws.worksheets[0].fontSize).toBeUndefined();
  });
});

describe('dragging: alignment guides before the grid', () => {
  it('at 62 % zoom a plot dropped near a row aligns with the row top, not with a grid line 3.4 mm away', () => {
    const grid = 5 * MM;
    const zoom = 0.62;
    const row = [{ x: 40, y: 103.4, w: 200, h: 180 }];
    // the pointer puts the dragged plot 6 px (page) below the row top: the nearest grid line is elsewhere
    const at = alignDrag({ x: 300, y: 109.4, w: 200, h: 180 }, row, { tol: 6 / zoom, spacingTol: 9 / zoom, grid, off: false });
    expect(at.y).toBeCloseTo(103.4, 6);
    expect(at.h).toEqual([103.4]);
    expect(Math.abs(snapV(109.4, grid, true) - 103.4)).toBeGreaterThan(3);
    // far from any edge: the grid
    const free = alignDrag({ x: 300, y: 160, w: 200, h: 180 }, row, { tol: 6 / zoom, spacingTol: 9 / zoom, grid, off: false });
    expect(free.y).toBeCloseTo(snapV(160, grid, true), 6);
    // Alt: free
    expect(alignDrag({ x: 300, y: 109.4, w: 200, h: 180 }, row, { tol: 6 / zoom, spacingTol: 9 / zoom, grid, off: true }).y).toBe(109.4);
  });
});
