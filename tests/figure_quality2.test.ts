// Figure quality, round 2: label placement off data and gate outlines, one typographic system, panel letters inside
// their items, events without a value, equal-gap grids, nudging, repeat headers, title modes, slide sizes, exports.
import { DEMO_SAMPLES, makeDemoDataset } from '../src/core/demo';
import { Engine } from '../src/core/engine';
import { defaultPlotOptions, emptyWorkspace, MM, type GateGeom, type PlotItem, type Population, type TextItem, type Workspace } from '../src/core/model';
import { defaultScaleFor, makeScale } from '../src/core/transforms';
import { layoutLabels, overlapArea, type Box } from '../src/render/labels';
import { drawableEvents, omittedEvents, plotTitleText, renderPlot, setPlotPopulation, type RenderEnv } from '../src/render/plot';
import { MIN_SCRIPT_PX, runs, runSize, SvgPainter, type RichText, type TextStyle } from '../src/render/painter';
import { bodyPt, brightOn, histModeOfLabel, middleEllipsis, panelLabelPt, SLIDE_SIZES } from '../src/render/figstyle';
import { isCalibPanel, newCalibItem, renderCalibPanel } from '../src/render/calibPanel';
import { sizeFitPanel } from '../src/ui/calib/sheetPanels';
import { newPlotItem, useStore } from '../src/state/store';
import { addPanelLabels, arrange, headerLines, nudgeItems, readingRows } from '../src/ui/layoutOps';

const noop = () => {};
interface Rec {
  texts: { x: number; y: number; t: string; st: TextStyle; rot: number }[];
  lines: number[][];
  images: { data: Uint8ClampedArray; w: number; h: number }[];
}
function recorder(): Rec {
  const r: Rec = { texts: [], lines: [], images: [] };
  return Object.assign(r, {
    kind: 'canvas',
    save: noop,
    restore: noop,
    translate: noop,
    clipRect: noop,
    line: (x1: number, y1: number, x2: number, y2: number) => r.lines.push([x1, y1, x2, y2]),
    ellipse: noop,
    image: noop,
    path: noop,
    rect: noop,
    text: (x: number, y: number, t: RichText, st: TextStyle, rot = 0) => r.texts.push({ x, y, t: runs(t).map((q) => q.text).join(''), st, rot }),
  });
}
/** Canvas stand-in whose last putImageData is kept (to look at the dot raster). */
function canvasMaker(images: Rec['images']) {
  return ((w: number, h: number) => ({
    width: w,
    height: h,
    getContext: () => ({
      createImageData: (ww: number, hh: number) => ({ width: ww, height: hh, data: new Uint8ClampedArray(ww * hh * 4) }),
      putImageData: (img: { data: Uint8ClampedArray; width: number; height: number }) => images.push({ data: img.data, w: img.width, h: img.height }),
    }),
  })) as unknown as RenderEnv['makeCanvas'];
}

function setup(withNaN = false) {
  const engine = new Engine();
  const ws: Workspace = emptyWorkspace();
  const ds = makeDemoDataset(DEMO_SAMPLES[2]);
  if (withNaN) {
    // an unsized third of the events: no value in FSC-A (as diameters outside a size calibration)
    const fsc = ds.channels.findIndex((c) => c.name === 'FSC-A');
    for (let i = 0; i < ds.eventCount; i += 3) ds.data[fsc][i] = NaN;
  }
  engine.addSample('s1', ds);
  ws.samples.push({ id: 's1', name: 'S1', fileName: 's1.fcs', fileSize: 0, eventCount: ds.eventCount, channels: ds.channels.map((c) => ({ name: c.name, label: c.label, range: c.range })), compId: null });
  ds.channels.forEach((c, i) => (ws.scales[c.name] = defaultScaleFor(c.name, c.range, ds.data[i].filter((v) => v === v), c.displayHint)));
  return { engine, ws };
}

function plot(type: PlotItem['plotType'], x: string, y: string, opts: Partial<PlotItem['options']> = {}, w = 113, h = 113): PlotItem {
  return { id: 'p', kind: 'plot', plotType: type, xParam: x, yParam: y, layers: [{ id: 'l', sample: 's1', population: 'root' }], options: { ...defaultPlotOptions(), fontSize: 6, ...opts }, x: 0, y: 0, w, h };
}

describe('events without a value', () => {
  it('are not drawn at the axis end of 2D plots, and are counted for the inspector', () => {
    const { engine, ws } = setup(true);
    ws.scales['FSC-A'] = { type: 'log', min: 10, max: 1e7 };
    const item = plot('dot', 'FSC-A', 'SSC-A', { colorMode: 'single' });
    const images: Rec['images'] = [];
    renderPlot(recorder() as never, item, item.w, item.h, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas: canvasMaker(images) });
    const img = images[images.length - 1];
    let edge = 0;
    for (let y = 0; y < img.h; y++) if (img.data[(y * img.w) * 4 + 3] > 0) edge++;
    // a stripe would fill most of the first raster column
    expect(edge).toBeLessThan(img.h * 0.2);
    const om = omittedEvents(item, ws, engine, 's1');
    expect(om?.omitted).toBe(Math.ceil(engine.eventCount('s1') / 3));
    expect(om?.channels).toEqual(['FSC-A']);
    const d = drawableEvents(ws, engine, 's1', 'root', 'FSC-A', 'SSC-A');
    expect(d.idx.length + d.omitted).toBe(engine.eventCount('s1'));
  });
});

describe('label placement', () => {
  it('avoids dense data and gate outlines, choosing an empty place when the anchor is crowded', () => {
    const bounds: Box = { x: 0, y: 0, w: 200, h: 200 };
    // dense data in the left half; the preferred anchor sits on it
    const density = (b: Box) => Math.max(0, Math.min(1, (100 - b.x) / b.w));
    const out = layoutLabels([{ id: 'a', w: 40, h: 16, cands: [{ x: 20, y: 20, cost: 0 }], bounds, scan: true }], [], undefined, {
      density,
      lines: [{ pts: [150, 0, 150, 200], closed: false }],
    });
    const b = out.get('a')!;
    expect(b.x).toBeGreaterThan(99.9);
    // not on the vertical outline at x = 150
    expect(b.x > 151.5 || b.x + b.w < 148.5).toBe(true);
  });

  it('gate labels of a crowded scatter plot are not on the gate outline', () => {
    const { engine, ws } = setup();
    const X = makeScale(ws.scales['FSC-A']);
    const Y = makeScale(ws.scales['SSC-A']);
    const g: GateGeom = { type: 'polygon', x: 'FSC-A', y: 'SSC-A', points: [[X.inv(0.1), Y.inv(0.02)], [X.inv(0.95), Y.inv(0.02)], [X.inv(1.02), Y.inv(1.05)], [X.inv(0.2), Y.inv(1.05)]] };
    ws.populations = [{ id: 'c', name: 'Cells', parentId: null, color: '#d62728', gate: g }];
    const item = plot('pseudo', 'FSC-A', 'SSC-A');
    const images: Rec['images'] = [];
    const geom = renderPlot(recorder() as never, item, item.w, item.h, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas: canvasMaker(images) });
    const lb = geom.gates[0].label!;
    const ol = geom.gates[0].outline!;
    // no polygon edge passes through the label box
    for (let i = 0; i < ol.length; i += 2) {
      const [x0, y0, x1, y1] = [ol[i], ol[i + 1], ol[(i + 2) % ol.length], ol[(i + 3) % ol.length]];
      for (let t = 0; t <= 1; t += 0.02) {
        const x = x0 + (x1 - x0) * t;
        const y = y0 + (y1 - y0) * t;
        expect(x > lb.x && x < lb.x + lb.w && y > lb.y && y < lb.y + lb.h).toBe(false);
      }
    }
  });

  it('open-ended rectangle gates are drawn as a single line with an arrow (no box edges)', () => {
    const { engine, ws } = setup();
    ws.populations = [{ id: 't', name: 'T cells', parentId: null, color: '#ff7f0e', gate: { type: 'rect', x: 'FITC-A', y: 'SSC-A', xmin: 5500, xmax: Infinity, ymin: -Infinity, ymax: Infinity } }];
    const item = plot('pseudo', 'FITC-A', 'SSC-A');
    const rec = recorder();
    const geom = renderPlot(rec as never, item, item.w, item.h, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas: canvasMaker([]) });
    const fr = geom.frame;
    const x = geom.gates[0].outline![0];
    // the vertical line at the bound, and a short arrow pointing right from it
    expect(rec.lines.some((l) => Math.abs(l[0] - x) < 0.01 && Math.abs(l[2] - x) < 0.01)).toBe(true);
    expect(rec.lines.some((l) => Math.abs(l[0] - x) < 0.01 && l[2] > x + 2 && Math.abs(l[1] - l[3]) < 0.01)).toBe(true);
    // no horizontal box edge beyond the frame
    expect(rec.lines.some((l) => Math.abs(l[1] - l[3]) < 0.01 && (l[1] < fr.y - 1 || l[1] > fr.y + fr.h + 1))).toBe(false);
  });
});

describe('typography', () => {
  it('gate labels and legends at the body size (at least 6 pt), scripts at least 5 pt', () => {
    const { engine, ws } = setup();
    ws.populations = [{ id: 'r', name: 'Live', parentId: null, color: '#2ca02c', gate: { type: 'range', x: 'KO525-A', min: -Infinity, max: 6000 } }];
    const item = plot('histogram', 'KO525-A', 'KO525-A', { fontSize: 5 });
    const rec = recorder();
    renderPlot(rec as never, item, item.w, item.h, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas: canvasMaker([]) });
    const label = rec.texts.find((t) => t.t.startsWith('Live'))!;
    expect(label.st.size).toBeGreaterThanOrEqual(6 * (96 / 72) - 1e-6);
    expect(runSize({ text: '3', sup: true }, 6 * (96 / 72))).toBeCloseTo(MIN_SCRIPT_PX);
    expect(runSize({ text: '3', sup: true }, 12 * (96 / 72))).toBeCloseTo(12 * (96 / 72) * 0.7);
    expect(panelLabelPt({ style: { fontSize: 6 } } as Workspace)).toBe(8);
    expect(panelLabelPt({ style: { fontSize: 8 } } as Workspace)).toBe(9);
    expect(panelLabelPt({ style: { fontSize: 14 } } as Workspace)).toBe(14);
  });

  it('SVG superscripts are placed absolutely (no relative dy)', () => {
    const p = new SvgPainter();
    p.text(50, 10, [{ text: '10' }, { text: '3', sup: true }], { family: 'Arial', size: 8, color: '#000', align: 'center' });
    const s = p.toString();
    expect(s).not.toContain('dy=');
    expect((s.match(/<tspan x=/g) ?? []).length).toBe(2);
    expect(s).toContain('text-anchor="start"');
  });

  it('a typed y title naming the other histogram mode follows the mode', () => {
    const { ws } = setup();
    expect(histModeOfLabel('% of max')).toBe('normalized');
    expect(histModeOfLabel('Count')).toBe('count');
    expect(histModeOfLabel('Cells per µL')).toBe(null);
    void ws;
  });

  it('brighter data colors on dark backgrounds', () => {
    expect(brightOn('#d62728', '#1d2026')).toBe('#ff6b6b');
    expect(brightOn('#123456', '#1d2026')).not.toBe('#123456');
  });
});

describe('titles', () => {
  it('population titles follow renames; custom titles stay', () => {
    const { engine, ws } = setup();
    ws.populations = [{ id: 'c', name: 'Cells', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FSC-A', y: 'SSC-A', points: [[0, 0], [1, 0], [1, 1]] } }];
    const item = plot('pseudo', 'FSC-A', 'SSC-A');
    item.layers[0].population = 'c';
    (item.options as { titleMode?: string }).titleMode = 'population';
    expect(plotTitleText(item, [], ws)).toBe('Cells');
    ws.populations[0].name = 'Cells (renamed)';
    expect(plotTitleText(item, [], ws)).toBe('Cells (renamed)');
    item.options.title = 'My title';
    (item.options as { titleMode?: string }).titleMode = 'custom';
    expect(plotTitleText(item, [], ws)).toBe('My title');
    void engine;
  });
});

describe('layout', () => {
  function sheetWith(items: PlotItem[]) {
    const w = emptyWorkspace();
    w.style.fontSize = 6;
    w.worksheets[0].items = items;
    useStore.getState().replaceWorkspace(w);
    return useStore.getState().ws.worksheets[0];
  }
  const sheet = () => useStore.getState().ws.worksheets[0];

  it('arrange as grid: exactly equal gaps between same-size plots', () => {
    const its = [10, 45, 75, 108, 140, 172].map((x, i) => {
      const p = newPlotItem('pseudo', 'a', 'b', x * MM + i * 0.7, 20 * MM + (i % 2), 28 * MM, 28 * MM);
      p.id = 'p' + i;
      return p;
    });
    const sh = sheetWith(its);
    arrange(sh.id, its.map((i) => i.id), 'grid', { gap: 3 * MM });
    const rows = readingRows(sheet().items);
    expect(rows.length).toBe(1);
    const xs = rows[0].map((i) => i.x);
    for (let k = 1; k < xs.length; k++) expect(xs[k] - xs[k - 1] - 28 * MM).toBeCloseTo(3 * MM, 3);
    expect(new Set(rows[0].map((i) => i.y)).size).toBe(1);
  });

  it('nudge steps land on clean multiples (0.5 mm, Alt 0.1 mm, Shift one grid step) and carry panel letters', () => {
    const p = newPlotItem('pseudo', 'a', 'b', 2.11 * MM, 10 * MM, 30 * MM, 30 * MM);
    p.id = 'n';
    const sh = sheetWith([p]);
    addPanelLabels(sh.id, ['n']);
    nudgeItems(sh.id, ['n'], 1, 0);
    const it = () => sheet().items.find((i) => i.id === 'n')!;
    expect(it().x / MM).toBeCloseTo(2.5, 6);
    nudgeItems(sh.id, ['n'], 1, 0);
    expect(it().x / MM).toBeCloseTo(3, 6);
    nudgeItems(sh.id, ['n'], -1, 0, { alt: true });
    expect(it().x / MM).toBeCloseTo(2.9, 6);
    nudgeItems(sh.id, ['n'], 0, 1, { shift: true });
    expect(it().y / MM).toBeCloseTo(15, 3);
    const letter = sheet().items.find((i) => i.kind === 'text') as TextItem;
    expect(letter.x).toBeCloseTo(it().x, 6);
    expect(letter.y).toBeCloseTo(it().y, 6);
  });

  it('panel letters sit inside their item, at body + 2 pt, with the page text color', () => {
    const p = newPlotItem('pseudo', 'a', 'b', 0, 0, 30 * MM, 30 * MM);
    const sh = sheetWith([p]);
    addPanelLabels(sh.id, []);
    const l = sheet().items.find((i) => i.kind === 'text') as TextItem;
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.y).toBeGreaterThanOrEqual(0);
    expect(l.x + l.w).toBeLessThanOrEqual(p.x + p.w);
    expect(l.fontSize).toBe(panelLabelPt(useStore.getState().ws));
    expect(l.color).toBe('');
    expect(bodyPt(useStore.getState().ws)).toBe(6);
  });

  it('repeat headers: long names wrap at separators or are shortened in the middle', () => {
    const m = (t: string) => t.length * 5;
    expect(headerLines('Donor A', 100, m)).toEqual(['Donor A']);
    expect(headerLines('Specimen_001_H7_H07_018', 70, m)).toEqual(['Specimen_001_', 'H7_H07_018']);
    const one = headerLines('SpecimenXXXXXXXXXXXXXXXXXXXXXH07', 60, m);
    expect(one.length).toBe(1);
    expect(one[0]).toContain('…');
    expect(one[0].startsWith('Spec')).toBe(true);
    expect(one[0].endsWith('H07')).toBe(true);
    expect(middleEllipsis('abcdefghij', 5)).toBe('ab…ij');
  });

  it('slide sizes are true 16:9 and 4:3', () => {
    const s = SLIDE_SIZES['Slide 16:9 (338.7 x 190.5 mm)'];
    expect(s.w / s.h).toBeCloseTo(16 / 9, 6);
    expect(s.w / MM).toBeCloseTo(338.67, 1);
    const f = SLIDE_SIZES['Slide 4:3 (254 x 190.5 mm)'];
    expect(f.w / f.h).toBeCloseTo(4 / 3, 6);
  });
});

describe('calibration panels', () => {
  it('render the bead fit with its points, identity line and results', () => {
    const ws = emptyWorkspace();
    const panel = sizeFitPanel({
      channel: 'VSSC1-A',
      beads: [100, 200, 400].map((d, i) => ({ diameterNm: d, measured: 10 ** (2 + i), predicted: 10 ** (2 + i) * 1.05, used: true })),
      halfAngleDeg: 32.1,
      cvPct: 4.2,
      r2Log: 0.9991,
      fixed: false,
    });
    const it = newCalibItem(panel, 0, 0, 60 * MM, 54 * MM, 7);
    ws.worksheets[0].items.push(it);
    expect(isCalibPanel(it)).toBe(true);
    const p = new SvgPainter();
    renderCalibPanel(p, it, { ws, engine: new Engine(), activeSampleId: null, rasterScale: 1, makeCanvas: canvasMaker([]) });
    const s = p.toString();
    expect(s).toContain('Bead fit');
    expect(s).toContain('Half-angle 32.1°');
    expect((s.match(/<ellipse/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // survives a workspace round trip as a chart item
    const back = JSON.parse(JSON.stringify(it));
    expect(isCalibPanel(back)).toBe(true);
  });
});

void overlapArea;

describe('gates on the path of the shown population', () => {
  it('are drawn on a plot of a population below them (same axes), with % of their own parent; others are not', () => {
    const { engine, ws } = setup();
    const pop = (id: string, parentId: string | null, gate: GateGeom): Population => ({ id, name: id, parentId, gate, color: '#c00' });
    ws.populations.push(
      pop('cells', null, { type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: 2e5, xmax: 1e6, ymin: 0, ymax: 1e6 }),
      pop('live', 'cells', { type: 'range', x: 'KO525-A', min: -1e3, max: 1e3 }),
      pop('big', 'cells', { type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: 5e5, xmax: 1e6, ymin: 0, ymax: 1e6 }),
    );
    const item = plot('dot', 'FSC-A', 'SSC-A');
    const shown = (population: string) => {
      item.layers[0].population = population;
      const rec = recorder();
      const geom = renderPlot(rec as never, item, item.w, item.h, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas: canvasMaker([]) });
      return { gates: geom.gates.map((g) => g.popId), texts: rec.texts.map((t) => t.t) };
    };
    expect(shown('root').gates).toEqual(['cells']);
    // its own gate too (drawn first), then those of its subpopulations
    expect(shown('cells').gates).toEqual(['cells', 'big']);
    // live (gated on another channel): the cells gate it lies in, not its sibling "big"
    const live = shown('live');
    expect(live.gates).toEqual(['cells']);
    const pct = (100 * engine.count(ws, 's1', 'cells')) / engine.count(ws, 's1', null);
    expect(live.texts.some((t) => t.includes(pct.toFixed(1)))).toBe(true);
  });

  it('stay on the plot when its population is changed to one above them (All Events)', () => {
    const { engine, ws } = setup();
    const pop = (id: string, parentId: string | null, gate: GateGeom): Population => ({ id, name: id, parentId, gate, color: '#c00' });
    ws.populations.push(
      pop('cells', null, { type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: 2e5, xmax: 1e6, ymin: 0, ymax: 1e6 }),
      pop('singlets', 'cells', { type: 'rect', x: 'FSC-A', y: 'FSC-H', xmin: 2e5, xmax: 1e6, ymin: 0, ymax: 1e6 }),
    );
    const item = plot('dot', 'FSC-A', 'FSC-H');
    item.layers[0].population = 'cells';
    const gates = () => renderPlot(recorder() as never, item, item.w, item.h, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas: canvasMaker([]) }).gates.map((g) => g.popId);
    expect(gates()).toEqual(['singlets']);
    setPlotPopulation(ws, item, 'root', 's1');
    expect(item.keepGates).toEqual(['singlets']);
    expect(gates()).toEqual(['singlets']);
    // back down: shown as its child again, kept once
    setPlotPopulation(ws, item, 'cells', 's1');
    expect(gates()).toEqual(['singlets']);
  });
});
