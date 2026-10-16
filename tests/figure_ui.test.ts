// Figure export and layout helpers of the UI: TIFF writer, axis fit, page fitting, repeat-for-samples labels,
// panel letters, channel search, save names.
import { unzlibSync } from 'fflate';
import { emptyWorkspace, MM, type ChartItem, type PlotItem, type SheetItem, type TextItem, type Workspace } from '../src/core/model';
import { figureBounds, itemsOutsidePage, rasterSize, rasterTooLarge } from '../src/io/exportFigure';
import { PngWriter } from '../src/io/pngEncode';
import { lzwDecode, lzwEncode, TiffWriter } from '../src/io/tiff';
import { newPlotItem, useStore } from '../src/state/store';
import { fitScale, niceCeil, poolValues } from '../src/ui/axisFit';
import { filterChannels, type ChannelOption } from '../src/ui/ChannelPicker';
import { addPanelLabels, fitLayout, isControlSampleName, populationPlotSpec, repeatForSamples } from '../src/ui/layoutOps';
import { isoDate, suggestName } from '../src/ui/saveOps';

const text = (id: string, x: number, y: number, w = 100, h = 20, t = id): TextItem => ({ id, kind: 'text', x, y, w, h, text: t, fontSize: 10, bold: false, italic: false, align: 'left', color: '#000' });

function setup(mut?: (w: Workspace) => void) {
  const w = emptyWorkspace();
  w.samples = ['Unstained', 'Donor A', 'Donor B'].map((n, i) => ({ id: 's' + i, name: n, fileName: n + '.fcs', fileSize: 0, eventCount: 100, channels: [], compId: null }));
  w.populations = [
    { id: 'p1', name: 'Cells', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FSC-A', y: 'SSC-A', points: [[0, 0], [1, 0], [1, 1]] } },
    { id: 'p2', name: 'Live', parentId: 'p1', color: '#000', gate: { type: 'range', x: '7-AAD', min: 0, max: 1 } },
    { id: 'p3', name: 'T cells', parentId: 'p2', color: '#000', gate: { type: 'rect', x: 'CD3', y: 'CD4', xmin: 0, xmax: 1, ymin: 0, ymax: 1 } },
  ];
  mut?.(w);
  useStore.getState().replaceWorkspace(w);
  return w;
}
const sheet = () => useStore.getState().ws.worksheets[0];

describe('TIFF writer', () => {
  it('LZW round-trips data of every kind (runs, noise, table resets)', () => {
    const cases: Uint8Array[] = [new Uint8Array(0), new Uint8Array([7]), new Uint8Array(5000).fill(255)];
    const noise = new Uint8Array(70000);
    let s = 1;
    for (let i = 0; i < noise.length; i++) noise[i] = (s = (s * 1103515245 + 12345) >>> 0) >>> 24;
    cases.push(noise);
    const mixed = new Uint8Array(200000);
    for (let i = 0; i < mixed.length; i++) mixed[i] = i % 3000 < 1500 ? 255 : (i * 7) & 0xff;
    cases.push(mixed);
    for (const c of cases) expect(lzwDecode(lzwEncode(c), c.length)).toEqual(c);
    // white figures compress well
    expect(lzwEncode(cases[2]).length).toBeLessThan(200);
  });
  it('writes a baseline RGB TIFF with strips and resolution tags', async () => {
    const w = 37;
    const h = 29;
    const tw = new TiffWriter({ width: w, height: h, channels: 3, dpi: 600 });
    const rows = new Uint8Array(w * h * 3);
    for (let i = 0; i < rows.length; i++) rows[i] = (i * 13) & 0xff;
    tw.addRows(rows, h);
    const buf = new Uint8Array(await tw.finish().arrayBuffer());
    const dv = new DataView(buf.buffer);
    expect([buf[0], buf[1], dv.getUint16(2, true)]).toEqual([0x49, 0x49, 42]);
    const ifd = dv.getUint32(4, true);
    const n = dv.getUint16(ifd, true);
    const tags = new Map<number, { type: number; count: number; at: number }>();
    for (let i = 0; i < n; i++) {
      const p = ifd + 2 + i * 12;
      tags.set(dv.getUint16(p, true), { type: dv.getUint16(p + 2, true), count: dv.getUint32(p + 4, true), at: p + 8 });
    }
    const val = (tag: number) => {
      const t = tags.get(tag)!;
      return t.type === 3 ? dv.getUint16(t.at, true) : dv.getUint32(t.at, true);
    };
    expect([...tags.keys()]).toEqual([...tags.keys()].sort((a, b) => a - b));
    expect(val(256)).toBe(w);
    expect(val(257)).toBe(h);
    expect(val(259)).toBe(5); // LZW
    expect(val(262)).toBe(2); // RGB
    expect(val(277)).toBe(3);
    const xr = dv.getUint32(tags.get(282)!.at, true);
    expect(dv.getUint32(xr, true) / dv.getUint32(xr + 4, true)).toBe(600);
    expect(val(296)).toBe(2); // inch
    // decode all strips back
    const ns = tags.get(273)!.count;
    const offs = ns === 1 ? [val(273)] : Array.from({ length: ns }, (_, i) => dv.getUint32(dv.getUint32(tags.get(273)!.at, true) + i * 4, true));
    const cnts = ns === 1 ? [val(279)] : Array.from({ length: ns }, (_, i) => dv.getUint32(dv.getUint32(tags.get(279)!.at, true) + i * 4, true));
    const rps = val(278);
    const out: number[] = [];
    offs.forEach((o, i) => {
      const nrows = Math.min(rps, h - i * rps);
      out.push(...lzwDecode(buf.subarray(o, o + cnts[i]), nrows * w * 3));
    });
    expect(Uint8Array.from(out)).toEqual(rows);
  });
  it('streams a PNG whose image data inflate to the filtered rows', async () => {
    const pw = new PngWriter(4, 3, 3, 300);
    const rows = Uint8Array.from({ length: 36 }, (_, i) => i * 7);
    pw.addRows(rows.subarray(0, 24), 2);
    pw.addRows(rows.subarray(24), 1);
    const png = new Uint8Array(await pw.finish().arrayBuffer());
    expect(Array.from(png.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    const chunks: Uint8Array[] = [];
    let p = 8;
    const types: string[] = [];
    while (p < png.length) {
      const len = new DataView(png.buffer).getUint32(p);
      const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
      types.push(type);
      if (type === 'IDAT') chunks.push(png.subarray(p + 8, p + 8 + len));
      p += 12 + len;
    }
    expect(types[0]).toBe('IHDR');
    expect(types).toContain('pHYs');
    expect(types.at(-1)).toBe('IEND');
    const all = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    const raw = unzlibSync(all);
    // undo the Sub filter
    const back: number[] = [];
    for (let r = 0; r < 3; r++) {
      expect(raw[r * 13]).toBe(1);
      for (let i = 0; i < 12; i++) back.push((raw[r * 13 + 1 + i] + (i >= 3 ? back[r * 12 + i - 3] : 0)) & 0xff);
    }
    expect(Uint8Array.from(back)).toEqual(rows);
  });
});

describe('export bounds', () => {
  const sh = { id: 's', name: 'S', page: { w: 300, h: 200, name: 'custom' }, grid: 10, snap: true, items: [text('a', 10, 10), text('b', 250, 150, 100, 80)] as SheetItem[] };
  it('reports items outside the page and includes them on request', () => {
    expect(itemsOutsidePage(sh).map((i) => i.id)).toEqual(['b']);
    expect(figureBounds(sh, sh.items, { scope: 'page', margin: 0 })).toEqual({ x: 0, y: 0, w: 300, h: 200 });
    expect(figureBounds(sh, sh.items, { scope: 'page', margin: 0, includeOutside: true })).toEqual({ x: 0, y: 0, w: 350, h: 230 });
  });
  it('exports a selection at its exact size unless a margin is asked for', () => {
    const one = [sh.items[0]];
    expect(figureBounds(sh, one, { scope: 'selection', margin: 0 })).toEqual({ x: 10, y: 10, w: 100, h: 20 });
    expect(figureBounds(sh, one, { scope: 'selection', margin: 2 * MM }).w).toBeCloseTo(100 + 4 * MM);
  });
  it('knows the bitmap size and refuses absurd ones', () => {
    expect(rasterSize({ w: 96, h: 48 }, 300)).toMatchObject({ w: 300, h: 150 });
    expect(rasterTooLarge({ w: 1123, h: 794 }, 1200)).toBeNull();
    expect(rasterTooLarge({ w: 1123, h: 4000 }, 1200)).toMatch(/megapixels/);
  });
});

describe('fit axes to data', () => {
  const data = (lo: number, hi: number, n = 20000, neg = 0) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = i < neg ? -Math.random() * 300 : lo + ((hi - lo) * i) / n;
    return a;
  };
  it('rounds the range to nice numbers, keeps the transform kind', () => {
    expect(niceCeil(1.13e6)).toBe(1.2e6);
    expect(niceCeil(262144)).toBe(300000);
    const lin = fitScale({ type: 'linear', min: 0, max: 262144 }, data(1000, 3e6), 'FSC-A');
    expect(lin).toEqual({ type: 'linear', min: 0, max: 4e6 });
    const lg = fitScale({ type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 }, data(10, 2e6, 20000, 2000), 'PE-A');
    expect(lg?.type).toBe('logicle');
    if (lg?.type === 'logicle') {
      expect(lg.T).toBe(2.5e6);
      expect(lg.M).toBeGreaterThan(4.5);
      expect(2 * lg.W).toBeLessThanOrEqual(lg.M);
    }
    const lo = fitScale({ type: 'log', min: 1, max: 1e5 }, data(50, 8e4), 'PE-A');
    expect(lo).toMatchObject({ type: 'log', min: 100, max: 1e5 });
    expect(fitScale({ type: 'linear', min: 0, max: 1 }, new Float32Array(3), 'x')).toBeNull();
  });
  it('pools several samples', () => {
    const p = poolValues([new Float32Array(10).fill(1), new Float32Array(30).fill(2)], 20);
    expect(p.length).toBeGreaterThan(15);
    expect(p.filter((v) => v === 2).length).toBeGreaterThan(p.filter((v) => v === 1).length);
  });
});

describe('page fit', () => {
  const items: SheetItem[] = [
    text('title', 40, 10, 760, 38, 'A long figure title that will need several lines on a page of one journal column'),
    ...[0, 1, 2, 3].map((i) => ({ ...newPlotItem('pseudo', 'a', 'b', 40 + i * 250, 60, 227, 208), id: 'p' + i })),
    ...[0, 1, 2, 3].map((i) => ({ ...newPlotItem('pseudo', 'a', 'b', 40 + i * 250, 300, 227, 208), id: 'q' + i })),
    { ...text('lbl', 36, 56, 20, 16, 'A'), tag: 'panelLabel', forItem: 'p0' } as TextItem,
  ];
  const page = { w: 321, h: 416 };
  it('scales positions and sizes, keeps fonts and panel letters in place', () => {
    const r = fitLayout(items, page, 18.9, 'scale');
    const plots = r.items.filter((i) => i.kind === 'plot') as PlotItem[];
    expect(r.scale).toBeLessThan(0.35);
    for (const p of plots) expect(p.x + p.w).toBeLessThanOrEqual(page.w + 0.5);
    expect(plots[0].options.fontSize).toBe((items[1] as PlotItem).options.fontSize);
    const lbl = r.items.find((i) => i.id === 'lbl')!;
    expect(lbl.x - plots[0].x).toBeCloseTo(-4);
    const title = r.items.find((i) => i.id === 'title') as TextItem;
    expect(title.w).toBeLessThanOrEqual(page.w);
    expect(title.h).toBeGreaterThan(38); // wraps: needs more height at the same font size
  });
  it('re-flows into rows of the page width, keeping sizes and row breaks', () => {
    const r = fitLayout(items, page, 18.9, 'reflow');
    const plots = r.items.filter((i) => i.kind === 'plot');
    for (const p of r.items) expect(p.x + p.w).toBeLessThanOrEqual(page.w + 0.5);
    expect(plots.every((p) => p.w === 227)).toBe(true);
    // one plot per row at 85 mm: eight rows
    expect(new Set(plots.map((p) => p.y)).size).toBe(8);
    const lbl = r.items.find((i) => i.id === 'lbl')!;
    const p0 = r.items.find((i) => i.id === 'p0')!;
    expect([lbl.x - p0.x, lbl.y - p0.y]).toEqual([-4, -4]);
    expect(r.pageH).toBeGreaterThan(page.h);
  });
});

describe('repeat for samples and panel letters', () => {
  it('labels rows with sample names and columns with populations; can replace the template', () => {
    setup((w) => {
      const t = newPlotItem('pseudo', 'FSC-A', 'SSC-A', 40, 40, 200, 180, 'p1');
      t.id = 'tpl';
      w.worksheets[0].items.push(t);
    });
    repeatForSamples(sheet().id, ['tpl'], ['s1', 's2'], { newSheet: false, rowLabels: true, orientation: 'rows', removeTemplate: true });
    const its = sheet().items;
    expect(its.some((i) => i.id === 'tpl')).toBe(false);
    const labels = its.filter((i): i is TextItem => i.kind === 'text').map((t) => t.text);
    expect(labels).toEqual(['Donor A', 'Donor B']);
    const plots = its.filter((i): i is PlotItem => i.kind === 'plot');
    // column titles name the population automatically (they follow renames), shown on the first row
    expect(plots.map((p) => [p.options.showTitle, (p.options as { titleMode?: string }).titleMode, p.options.title])).toEqual([
      [true, 'population', undefined],
      [false, 'population', undefined],
    ]);
    // the grid takes the template's place
    expect(Math.min(...its.map((i) => i.y))).toBeLessThan(80);
  });
  it('columns: sample names on top, population names as row labels', () => {
    setup((w) => {
      const a = newPlotItem('pseudo', 'FSC-A', 'SSC-A', 40, 40, 200, 180, 'p1');
      a.id = 'a';
      const b = newPlotItem('pseudo', 'CD3', 'CD4', 40, 260, 200, 180, 'p3');
      b.id = 'b';
      w.worksheets[0].items.push(a, b);
    });
    repeatForSamples(sheet().id, ['a', 'b'], ['s1', 's2'], { newSheet: false, rowLabels: true, orientation: 'columns' });
    const labels = sheet().items.filter((i): i is TextItem => i.kind === 'text').map((t) => t.text);
    expect(labels).toEqual(['Cells', 'T cells', 'Donor A', 'Donor B']);
    expect(sheet().items.filter((i): i is PlotItem => i.kind === 'plot' && !['a', 'b'].includes(i.id)).every((p) => !p.options.showTitle)).toBe(true);
  });
  it('panel letters go to plots and charts in reading order', () => {
    setup((w) => {
      const chart = { id: 'c', kind: 'chart', x: 20, y: 300, w: 100, h: 100, stat: { id: 'k', population: 'p1', stat: 'count' }, mode: 'samples', sampleSet: 'all', style: 'bar', errorBars: 'none', showPoints: false, color: '#000', useGroupColors: false, fontSize: 8, lineWidth: 1 } as ChartItem;
      w.worksheets[0].items.push(newPlotItem('pseudo', 'a', 'b', 140, 20, 100, 100), chart, newPlotItem('pseudo', 'a', 'b', 20, 24, 100, 100));
    });
    addPanelLabels(sheet().id, []);
    const its = sheet().items;
    const letter = (id: string) => (its.find((i) => i.kind === 'text' && (i as TextItem & { forItem?: string }).forItem === id) as TextItem).text;
    const [p1, , p2] = its.filter((i) => i.kind !== 'text');
    expect([letter(p2.id), letter(p1.id), letter('c')]).toEqual(['A', 'B', 'C']);
  });
  it('plots of a population use the axes of the next gate', () => {
    const w = setup();
    expect(populationPlotSpec(w, 'p1')).toEqual({ type: 'histogram', x: '7-AAD', y: '7-AAD' });
    expect(populationPlotSpec(w, 'p2')).toEqual({ type: 'pseudo', x: 'CD3', y: 'CD4' });
    expect(populationPlotSpec(w, 'p3')).toEqual({ type: 'pseudo', x: 'CD3', y: 'CD4' });
  });
  it('recognizes control samples', () => {
    expect(['Unstained', 'unstained_cells', 'Beads20_BV711', 'Comp PE', 'Isotype control', 'CTRL-1'].every(isControlSampleName)).toBe(true);
    expect(['Donor A stim', 'Activation_1', 'Sample_Beta'].some(isControlSampleName)).toBe(false);
  });
});

describe('channel search and names', () => {
  const opts: ChannelOption[] = [
    { name: 'FSC-A', label: '', display: 'FSC-A', preferred: true, derived: false },
    { name: 'PC5.5-A', label: 'CD45', display: 'CD45 (PC5.5-A)', preferred: true, derived: false },
    { name: 'PC7-A', label: 'CD4', display: 'CD4 (PC7-A)', preferred: true, derived: false },
    { name: 'BV421-A', label: 'CD4', display: 'CD4 (BV421-A)', preferred: false, derived: false },
  ];
  it('filters by name or marker, exact and preferred matches first', () => {
    expect(filterChannels(opts, 'cd4').map((o) => o.name)).toEqual(['PC7-A', 'PC5.5-A', 'BV421-A']);
    expect(filterChannels(opts, 'pc 7').map((o) => o.name)).toEqual(['PC7-A']);
    expect(filterChannels(opts, '').length).toBe(4);
    expect(filterChannels(opts, 'pc5.5a').map((o) => o.name)).toEqual(['PC5.5-A']);
  });
  it('suggests a workspace name from the experimental samples and their date', () => {
    const w = emptyWorkspace();
    w.samples = ['Unstained', 'Activation_1', 'Activation_2'].map((n, i) => ({ id: 's' + i, name: n, fileName: n, fileSize: 0, eventCount: 1, channels: [], compId: null, info: { Date: '11-OCT-2026' } }));
    expect(suggestName(w)).toBe('Activation 2026-10-11');
    expect(isoDate('2026-1-5')).toBe('2026-01-05');
    expect(isoDate('nonsense')).toBeNull();
  });
});
