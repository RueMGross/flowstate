// Plates in the workspace: placement when files are loaded (keywords, names, folders), undo, re-detection, changes by
// hand, layouts and groups, heatmap values against the statistics engine and tables, the heatmap figure item (SVG),
// repair of damaged plate fields, folders read from a drop, the Excel workbook.
import { unzipSync, strFromU8 } from 'fflate';
import { writeFcs } from '../src/core/fcs';
import { engine } from '../src/core/engine';
import { emptyWorkspace, uid, type ChartItem, type Workspace } from '../src/core/model';
import { plateCells, plateLayout } from '../src/core/plate';
import { repairWorkspace } from '../src/core/repair';
import { loadFcsFiles, placeSamples, useStore } from '../src/state/store';
import { addPlateHeatmaps, annotateWellValues, fillOrder, groupsFromAnnotation, redetectWells, renamePlate, setWells, updatePlateView } from '../src/state/plateOps';
import { layoutOf, plateStatValue } from '../src/render/plateChart';
import { renderChart } from '../src/render/chart';
import { SvgPainter } from '../src/render/painter';
import { PdfPainter } from '../src/render/pdf';
import { readDroppedEntries, relativePathOf, setRelativePath } from '../src/io/folders';
import { writeXlsxBook } from '../src/io/xlsx';
import { tableMatrix } from '../src/ui/TablesView';

const ROWS = 'ABCDEFGH';
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** A small well file: GFP+ fraction by column (col 1: 10 %, col 12: 65 %). */
function wellFile(name: string, col: number, kw: Record<string, string> = {}, n = 400) {
  const frac = 0.1 + 0.05 * col;
  const fsc = new Float32Array(n);
  const gfp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    fsc[i] = 1000 + rnd() * 1000;
    gfp[i] = i < n * frac ? 20000 + rnd() * 1000 : 100 + rnd() * 100;
  }
  return new File([writeFcs({ channels: [{ name: 'FSC-A', range: 262144 }, { name: 'FITC-A', range: 262144 }], data: [fsc, gfp], keywords: { $CYT: 'CytoFLEX', ...kw } }) as BlobPart], name);
}

function reset(ws: Workspace = emptyWorkspace()) {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(ws);
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [] } });
}

const st = () => useStore.getState();
const sampleBy = (name: string) => st().ws.samples.find((s) => s.name === name)!;

describe('placement when files are loaded', () => {
  it('CytExpert keywords: two plates, one undo step with the samples', async () => {
    reset();
    const files = [1, 2].flatMap((p) => ['A1', 'A2', 'B1'].map((w, i) => wellFile(`0${p}-Well-${w}.fcs`, i, { PLTNO: `0${p}`, $SMNO: w })));
    await loadFcsFiles(files);
    const ws = st().ws;
    expect(ws.plates?.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2']);
    expect(sampleBy('02-Well-B1')).toMatchObject({ well: 'B01', plate: 'Plate 2', wellSource: 'keyword' });
    expect(st().ui.toasts.some((t) => /Wells found for 6 of 6 samples \(FCS keywords\) on 2 plates/.test(t.text))).toBe(true);
    st().undo();
    expect(st().ws.samples).toEqual([]);
    expect(st().ws.plates).toBeUndefined();
  });

  it('files load in natural order whatever order they come in (A2 before A10)', async () => {
    reset();
    await loadFcsFiles(['01-Well-A10', '01-Well-A2', '01-Well-A1', '01-Well-B1'].map((n, i) => wellFile(`${n}.fcs`, i)));
    expect(st().ws.samples.map((s) => s.name)).toEqual(['01-Well-A1', '01-Well-A2', '01-Well-A10', '01-Well-B1']);
  });

  it('a folder per plate, wells from the names only', async () => {
    reset();
    const files = [1, 2].flatMap((p) =>
      ['A01', 'A02', 'B01', 'B02'].map((w, i) => {
        const f = wellFile(`HEK_${w}.fcs`, i);
        setRelativePath(f, `Exp 7/Plate ${p}/HEK_${w}.fcs`);
        return f;
      }),
    );
    expect(relativePathOf(files[5])).toBe('Exp 7/Plate 2/HEK_A02.fcs');
    await loadFcsFiles(files);
    const ws = st().ws;
    expect(ws.plates?.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2']);
    const second = ws.samples.filter((s) => s.plate === 'Plate 2');
    expect(second.map((s) => s.well)).toEqual(['A01', 'A02', 'B01', 'B02']);
    expect(second[0].info?.Folder).toBe('Exp 7/Plate 2');
    expect(second[0].wellSource).toBe('name');
  });

  it('samples without wells are marked as looked for (none), older workspaces derive lazily', async () => {
    reset();
    await loadFcsFiles([wellFile('tube 1.fcs', 0), wellFile('tube 2.fcs', 1)]);
    expect(st().ws.samples.map((s) => s.wellSource)).toEqual(['none', 'none']);
    expect(st().ws.plates).toBeUndefined();
    // a workspace saved before plates existed: no wellSource; the layout is derived, not stored
    const ws = emptyWorkspace();
    ws.samples = ['x_A1', 'x_A2', 'x_B1', 'x_B2'].map((n) => ({ id: uid('smp'), name: n, fileName: n + '.fcs', fileSize: 0, eventCount: 0, channels: [], compId: null }));
    reset(ws);
    const L = layoutOf(st().ws, engine);
    expect(L.plates.map((p) => p.name)).toEqual(['Plate 1']);
    expect(st().ws.samples.every((s) => s.wellSource === undefined)).toBe(true);
    // a change by hand stores the detected placements first
    renamePlate('Plate 1', 'Screen');
    expect(st().ws.samples.map((s) => [s.plate, s.well, s.wellSource])).toEqual([
      ['Screen', 'A01', 'name'],
      ['Screen', 'A02', 'name'],
      ['Screen', 'B01', 'name'],
      ['Screen', 'B02', 'name'],
    ]);
  });
});

describe('changes by hand, layouts, re-detection', () => {
  beforeEach(async () => {
    reset();
    const files = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'].map((w, i) => wellFile(`01-Well-${w}.fcs`, i % 3, { PLTNO: '01', $SMNO: w }));
    await loadFcsFiles(files);
  });

  it('rename keeps samples, heatmap items and the plate key (re-detection keeps the name)', () => {
    const items = addPlateHeatmaps(['Plate 1']);
    st().update((w) => void w.worksheets[0].items.push(...items));
    expect(renamePlate('Plate 1', 'Screen 1')).toBe(true);
    expect(st().ws.samples.every((s) => s.plate === 'Screen 1')).toBe(true);
    expect((st().ws.worksheets[0].items.find((i) => i.kind === 'chart') as ChartItem).plate?.plate).toBe('Screen 1');
    redetectWells();
    expect(st().ws.samples.every((s) => s.plate === 'Screen 1')).toBe(true);
    expect(renamePlate('Screen 1', '')).toBe(false);
  });

  it('set well by hand (swap on drop), kept by re-detection; fill order', () => {
    const a1 = sampleBy('01-Well-A1');
    const b3 = sampleBy('01-Well-B3');
    setWells([{ id: a1.id, plate: 'Plate 1', well: 'B03' }], { swap: true, quiet: true });
    expect(sampleBy('01-Well-A1')).toMatchObject({ well: 'B03', wellSource: 'manual' });
    expect(st().ws.samples.find((s) => s.id === b3.id)).toMatchObject({ well: 'A01', wellSource: 'manual' });
    redetectWells();
    expect(sampleBy('01-Well-A1').well).toBe('B03');
    // off the plate
    setWells([{ id: a1.id, plate: 'Plate 1', well: null }], { quiet: true });
    expect(sampleBy('01-Well-A1').well).toBeUndefined();
    expect(layoutOf(st().ws, engine).unplaced).toEqual([a1.id]);
    expect(fillOrder({ rows: 8, cols: 12 }, 'A11', 4, 'rows')).toEqual(['A11', 'A12', 'B01', 'B02']);
    expect(fillOrder({ rows: 8, cols: 12 }, 'G12', 3, 'cols')).toEqual(['G12', 'H12', null]);
  });

  it('annotations make groups (one per value, updated when made again)', () => {
    annotateWellValues(
      ['A01', 'A02', 'A03'].map((well) => ({ plate: 'Plate 1', well, value: 'Drug A' })).concat(['B01', 'B02', 'B03'].map((well) => ({ plate: 'Plate 1', well, value: 'DMSO' }))),
      'Compound',
    );
    expect(st().ws.plates![0].annotations).toMatchObject({ A01: { Compound: 'Drug A' }, B03: { Compound: 'DMSO' } });
    expect(groupsFromAnnotation('Compound')).toBe(2);
    const g = st().ws.groups;
    expect(g.map((x) => x.name)).toEqual(['Compound: DMSO', 'Compound: Drug A']);
    expect(g[1].sampleIds.map((id) => st().ws.samples.find((s) => s.id === id)!.name)).toEqual(['01-Well-A1', '01-Well-A2', '01-Well-A3']);
    // B03 changes compound: the groups are updated, not duplicated
    annotateWellValues([{ plate: 'Plate 1', well: 'B03', value: 'Drug A' }], 'Compound');
    groupsFromAnnotation('Compound');
    expect(st().ws.groups.length).toBe(2);
    expect(st().ws.groups[1].sampleIds.length).toBe(4);
    // removing a value
    annotateWellValues([{ plate: 'Plate 1', well: 'B03', value: '' }], 'Compound');
    expect(st().ws.plates![0].annotations?.B03).toBeUndefined();
  });

  it('heatmap values are the statistics of the engine and of tables', () => {
    st().update((w) => void w.populations.push({ id: 'gfp', name: 'GFP+', parentId: null, color: '#2ca02c', gate: { type: 'range', x: 'FITC-A', min: 5000, max: Infinity } }));
    updatePlateView((pv) => {
      pv.stat = { id: 'c', population: 'gfp', stat: 'freqParent' };
    });
    const ws = st().ws;
    const p = plateLayout(ws, engine.keywordsOf).plates[0];
    const stat = ws.plateView!.stat;
    const { cells } = plateCells(p, (id) => plateStatValue(ws, engine, id, stat));
    const table = tableMatrix(ws, { id: 't', name: 't', sampleSet: 'all', columns: [stat] });
    for (const row of cells)
      for (const c of row) {
        if (!c.samples.length) continue;
        const s = ws.samples.find((x) => x.id === c.samples[0])!;
        expect(c.value).toBeCloseTo(engine.stat(ws, s.id, stat), 10);
        expect(table.rows.find((r) => r[0] === s.name)![1]).toBeCloseTo(c.value!, 10);
      }
    // the GFP+ fraction follows the column (10 %, 15 %, 20 %)
    expect(cells[0].slice(0, 3).map((c) => Math.round(c.value!))).toEqual([10, 15, 20]);
    // a statistic that does not apply (channel the files lack): n/a
    const na = plateCells(p, (id) => plateStatValue(ws, engine, id, { population: 'root', stat: 'median', channel: 'PE-A' })).cells[0][0];
    expect(na.value).toBeNull();
  });

  it('the heatmap figure item renders its values (SVG painter, as in exports)', () => {
    st().update((w) => void w.populations.push({ id: 'gfp', name: 'GFP+', parentId: null, color: '#2ca02c', gate: { type: 'range', x: 'FITC-A', min: 5000, max: Infinity } }));
    updatePlateView((pv) => {
      pv.stat = { id: 'c', population: 'gfp', stat: 'freqParent' };
      pv.decimals = 1;
    });
    const [item] = addPlateHeatmaps(['Plate 1']);
    st().update((w) => void w.worksheets[0].items.push(item));
    const p = new SvgPainter();
    renderChart(p, item, { ws: st().ws, engine, activeSampleId: null, rasterScale: 1, makeCanvas: () => null as never, forExport: true });
    const svg = p.parts.join('');
    expect(svg).toContain('Plate 1: GFP+');
    // (column 2: 61 of 400 events above the gate)
    for (const v of ['10.0', '15.3', '20.0']) expect(svg).toContain(`>${v}<`);
    // 96 wells as circles (ellipses), row letters and column numbers
    expect((svg.match(/<ellipse/g) ?? []).length).toBeGreaterThanOrEqual(96);
    expect(svg).toContain('>H<');
    expect(svg).toContain('>12<');
    // the PDF painter draws the same item (exports): a valid PDF with the wells as filled paths
    const pdf = new PdfPainter(item.w, item.h);
    renderChart(pdf, item, { ws: st().ws, engine, activeSampleId: null, rasterScale: 1, makeCanvas: () => null as never, forExport: true });
    const bytes = pdf.toBytes({ title: 'plate' });
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 8))).toBe('%PDF-1.4'.slice(0, 8));
    expect(bytes.length).toBeGreaterThan(2000);
    // a plate that is gone
    const gone = { ...item, plate: { ...item.plate!, plate: 'nope' } };
    const p2 = new SvgPainter();
    renderChart(p2, gone, { ws: st().ws, engine, activeSampleId: null, rasterScale: 1, makeCanvas: () => null as never });
    expect(p2.parts.join('')).toContain('not found');
  });

  it('several heatmaps wrap on the page and share the range of the plate view', () => {
    const items = addPlateHeatmaps(['Plate 1', 'Plate 1', 'Plate 1', 'Plate 1']);
    // automatic over all plates (follows gate changes), no fixed range stored
    expect(items.every((i) => i.plate!.shared === true && i.plate!.range === undefined)).toBe(true);
    const page = st().ws.worksheets[0].page;
    expect(Math.max(...items.map((i) => i.x + i.w))).toBeLessThanOrEqual(page.w);
    expect(new Set(items.map((i) => i.y)).size).toBeGreaterThan(1);
    // one plate: its own automatic range
    expect(addPlateHeatmaps(['Plate 1'])[0].plate).toMatchObject({ plate: 'Plate 1' });
    expect(addPlateHeatmaps(['Plate 1'])[0].plate!.shared).toBeUndefined();
  });

  it('placeSamples(all) re-detects everything not set by hand', () => {
    st().update((w) => {
      for (const s of w.samples) {
        s.plate = 'Wrong';
        s.wellSource = 'name';
      }
    });
    const r = placeSamples([], { all: true });
    expect(r?.wells).toBe(6);
    expect(st().ws.samples.every((s) => s.plate === 'Plate 1')).toBe(true);
  });
});

describe('repair of damaged plate fields', () => {
  it('samples, plates, plate view and heatmap items', () => {
    const raw = {
      app: 'FlowState',
      version: 2,
      name: 'x',
      samples: [
        { id: 'a', name: 'a', fileName: 'a.fcs', fileSize: 0, eventCount: 0, channels: [], compId: null, well: 'a1', plate: 'P', wellSource: 'name' },
        { id: 'b', name: 'b', fileName: 'b.fcs', fileSize: 0, eventCount: 0, channels: [], compId: null, well: 'Z99', plate: 'P', wellSource: 'name' },
        { id: 'c', name: 'c', fileName: 'c.fcs', fileSize: 0, eventCount: 0, channels: [], compId: null, well: 'B2', plate: 7, wellSource: 'magic' },
      ],
      plates: [
        { name: 'P', rows: 99, cols: 12, annotations: { a1: { Compound: 'X', Bad: 3 }, Q9: { k: 'v' }, B02: 'nope' } },
        { name: 'P', rows: 8, cols: 12 },
        { rows: 8 },
      ],
      plateView: { stat: { id: 's', population: 'gone', stat: 'freqParent' }, colormap: 5, range: [5, 1], decimals: 99, arrange: 'diagonal' },
      worksheets: [
        {
          id: 'w',
          name: 'S',
          page: { w: 500, h: 500, name: 'x' },
          grid: 10,
          snap: true,
          items: [
            { id: 'h', kind: 'chart', x: 0, y: 0, w: 100, h: 100, stat: { id: 'c', population: 'root', stat: 'count' }, mode: 'samples', sampleSet: 'all', style: 'bar', errorBars: 'none', showPoints: false, color: '#000', useGroupColors: false, fontSize: 8, lineWidth: 1, plate: { plate: 'P', colormap: 'viridis', values: 'yes', decimals: -3, legend: true, range: [0, 'x'] } },
            { id: 'h2', kind: 'chart', x: 0, y: 0, w: 100, h: 100, stat: { id: 'c2', population: 'root', stat: 'count' }, mode: 'samples', sampleSet: 'all', style: 'bar', errorBars: 'none', showPoints: false, color: '#000', useGroupColors: false, fontSize: 8, lineWidth: 1, plate: 'broken' },
          ],
        },
      ],
    };
    const { ws, notes } = repairWorkspace(JSON.parse(JSON.stringify(raw)));
    expect(ws.samples[0]).toMatchObject({ well: 'A01', plate: 'P', wellSource: 'name' });
    // an invalid well, a plate that is no text: the placement goes (detected again)
    expect(ws.samples[1].well).toBeUndefined();
    expect(ws.samples[1].plate).toBeUndefined();
    expect(ws.samples[2].plate).toBeUndefined();
    expect(ws.samples[2].wellSource).toBeUndefined();
    expect(ws.plates).toEqual([{ name: 'P', rows: 16, cols: 12, annotations: { A01: { Compound: 'X' } } }]);
    expect(ws.plateView).toMatchObject({ stat: { population: 'root' }, colormap: 'viridis', decimals: 6 });
    expect(ws.plateView!.range).toBeUndefined();
    expect(ws.plateView!.arrange).toBeUndefined();
    const items = ws.worksheets[0].items as ChartItem[];
    expect(items[0].plate).toEqual({ plate: 'P', colormap: 'viridis', values: true, decimals: 0, legend: true });
    expect(items[1].plate).toBeUndefined();
    expect(notes.join(' ')).toMatch(/plate/);
    // a valid workspace passes unchanged
    const ok = JSON.parse(JSON.stringify(ws));
    const again = repairWorkspace(ok);
    expect(again.notes).toEqual([]);
    expect(again.ws).toEqual(ws);
  });
});

describe('folders and workbooks', () => {
  it('reads dropped folders recursively (data files only, with their paths)', async () => {
    type E = { name: string; fullPath: string; isDirectory: boolean; isFile: boolean; file?: (ok: (f: File) => void) => void; createReader?: () => { readEntries: (ok: (l: E[]) => void) => void } };
    const fileE = (path: string): E => ({ name: path.split('/').pop()!, fullPath: '/' + path, isDirectory: false, isFile: true, file: (ok) => ok(new File(['x'], path.split('/').pop()!)) });
    const dirE = (path: string, kids: E[]): E => {
      let given = false;
      // entries come in batches until an empty one
      return { name: path.split('/').pop()!, fullPath: '/' + path, isDirectory: true, isFile: false, createReader: () => ({ readEntries: (ok) => ok(given ? [] : ((given = true), kids)) }) };
    };
    const root = dirE('Exp', [dirE('Exp/Plate 2', [fileE('Exp/Plate 2/02-Well-A1.fcs')]), dirE('Exp/Plate 1', [fileE('Exp/Plate 1/01-Well-A10.fcs'), fileE('Exp/Plate 1/01-Well-A2.fcs'), fileE('Exp/Plate 1/Exp.xit')])]);
    const { files, skipped } = await readDroppedEntries([root as unknown as FileSystemEntry, fileE('loose.fcs') as unknown as FileSystemEntry]);
    expect(files.map((f) => relativePathOf(f) || f.name)).toEqual(['Exp/Plate 1/01-Well-A2.fcs', 'Exp/Plate 1/01-Well-A10.fcs', 'Exp/Plate 2/02-Well-A1.fcs', 'loose.fcs']);
    expect(skipped).toBe(1);
  });

  it('writes a workbook with several sheets', () => {
    const z = unzipSync(writeXlsxBook([{ name: 'Plates', rows: [['Plate: P', '% Parent'], ['', 1, 2], ['A', 1.5, null]] }, { name: 'Samples', rows: [['Plate', 'Well'], ['P', 'A01']], header: true }]));
    expect(strFromU8(z['xl/workbook.xml'])).toContain('<sheet name="Samples" sheetId="2" r:id="rId2"/>');
    expect(strFromU8(z['xl/worksheets/sheet1.xml'])).toContain('<c r="B3"><v>1.5</v></c>');
    expect(strFromU8(z['xl/worksheets/sheet2.xml'])).toContain('state="frozen"');
    expect(strFromU8(z['xl/worksheets/sheet1.xml'])).not.toContain('state="frozen"');
  });
});

void ROWS;
