// Publication-figure layout: label collisions, legends, margins, ticks, text fitting and export text.
import { DEMO_SAMPLES, makeDemoDataset } from '../src/core/demo';
import { Engine } from '../src/core/engine';
import { defaultPlotOptions, emptyWorkspace, newWorksheet, type ChartItem, type GateGeom, type PlotItem, type Population, type StatsBoxItem, type TextItem, type Workspace } from '../src/core/model';
import { computeTicks, defaultScaleFor, makeScale } from '../src/core/transforms';
import { layoutLabels, overlapArea, type Box } from '../src/render/labels';
import { fitText, renderPlot, type PlotGeometry } from '../src/render/plot';
import { measureRich, runs, SvgPainter, type RichText, type TextStyle } from '../src/render/painter';
import { renderStatsBox, renderText } from '../src/render/items';
import { renderChart } from '../src/render/chart';
import { applyPreset, presetById } from '../src/render/presets';

const noop = () => {};
interface Rec {
  texts: { x: number; y: number; t: string; st: TextStyle; rot: number }[];
  rects: { x: number; y: number; w: number; h: number }[];
  paths: number[][];
}
function recorder(): Rec {
  const r: Rec = { texts: [], rects: [], paths: [] };
  return Object.assign(r, {
    kind: 'canvas',
    save: noop,
    restore: noop,
    translate: noop,
    clipRect: noop,
    line: noop,
    ellipse: noop,
    image: noop,
    path: (pts: ArrayLike<number>) => r.paths.push(Array.from(pts)),
    rect: (x: number, y: number, w: number, h: number) => r.rects.push({ x, y, w, h }),
    text: (x: number, y: number, t: RichText, st: TextStyle, rot = 0) => r.texts.push({ x, y, t: runs(t).map((q) => q.text).join(''), st, rot }),
  });
}
const makeCanvas = (() => ({ getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: noop }) })) as never;

function setup(n = 1) {
  const engine = new Engine();
  const ws: Workspace = emptyWorkspace();
  for (let k = 0; k < n; k++) {
    const ds = makeDemoDataset(DEMO_SAMPLES[(k + 1) % DEMO_SAMPLES.length]);
    const id = 's' + (k + 1);
    engine.addSample(id, ds);
    ws.samples.push({ id, name: 'Sample ' + (k + 1), fileName: id + '.fcs', fileSize: 0, eventCount: ds.eventCount, channels: ds.channels.map((c) => ({ name: c.name, label: c.label, range: c.range })), compId: null });
    if (k === 0) ds.channels.forEach((c, i) => (ws.scales[c.name] = defaultScaleFor(c.name, c.range, ds.data[i], c.displayHint)));
  }
  return { engine, ws };
}

function plot(type: PlotItem['plotType'], x: string, y: string, opts: Partial<PlotItem['options']> = {}, w = 300, h = 280): PlotItem {
  return { id: 'p' + Math.random(), kind: 'plot', plotType: type, xParam: x, yParam: y, layers: [{ id: 'l', sample: 's1', population: 'root' }], options: { ...defaultPlotOptions(), fontSize: 8, ...opts }, x: 0, y: 0, w, h };
}

const render = (engine: Engine, ws: Workspace, item: PlotItem, p = recorder()): { geom: PlotGeometry; rec: Rec } => ({
  geom: renderPlot(p as never, item, item.w, item.h, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas }),
  rec: p,
});

const width = (t: { t: string; st: TextStyle }) => measureRich(t.t, t.st);

describe('label layout', () => {
  it('places labels without overlaps and keeps fixed ones', () => {
    const bounds = { x: 0, y: 0, w: 200, h: 200 };
    const reqs = [0, 1, 2, 3].map((i) => ({ id: 'l' + i, w: 60, h: 20, cands: [{ x: 50, y: 50, cost: 0 }], bounds }));
    const out = layoutLabels([...reqs, { id: 'fixed', w: 40, h: 20, fixed: { x: 52, y: 52 }, cands: [], bounds }], [{ x: 0, y: 0, w: 40, h: 40 }]);
    const boxes = [...out.values()];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlapArea(boxes[i], boxes[j])).toBe(0);
    expect(out.get('fixed')).toEqual({ x: 52, y: 52, w: 40, h: 20 });
    for (const b of boxes) expect(overlapArea(b, { x: 0, y: 0, w: 40, h: 40 })).toBe(0);
  });

  it('gate labels of crowded gates do not overlap each other or the legend', () => {
    const { engine, ws } = setup();
    const X = makeScale(ws.scales['FSC-A']);
    const Y = makeScale(ws.scales['SSC-A']);
    const rect = (a: number, b: number, c: number, d: number): GateGeom => ({ type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: X.inv(a), xmax: X.inv(b), ymin: Y.inv(c), ymax: Y.inv(d) });
    ws.populations = [
      rect(0.3, 0.5, 0.3, 0.5),
      rect(0.32, 0.52, 0.32, 0.52),
      rect(0.34, 0.54, 0.34, 0.54),
      rect(0.36, 0.56, 0.28, 0.48),
      rect(0.7, 0.98, 0.75, 0.98),
    ].map((gate, i): Population => ({ id: 'g' + i, name: 'Population ' + i, parentId: null, gate, color: '#d62728' }));
    const item = plot('pseudo', 'FSC-A', 'SSC-A', { legendStat: 'count', legendPos: 'inside' });
    const { geom, rec } = render(engine, ws, item);
    const labels = geom.gates.map((g) => g.label!).filter(Boolean);
    expect(labels.length).toBe(5);
    for (let i = 0; i < labels.length; i++) {
      const a = labels[i];
      expect(a.x).toBeGreaterThanOrEqual(geom.frame.x - 0.01);
      expect(a.x + a.w).toBeLessThanOrEqual(geom.frame.x + geom.frame.w + 0.01);
      for (let j = i + 1; j < labels.length; j++) expect(overlapArea(a, labels[j])).toBeLessThan(1);
    }
    // the legend entry (inside the frame) does not run into a gate label
    const lt = rec.texts.find((t) => t.t.includes('n ='))!;
    const lb: Box = { x: lt.x, y: lt.y - lt.st.size * 0.5, w: width(lt), h: lt.st.size };
    for (const l of labels) expect(overlapArea(lb, l)).toBeLessThan(1);
  });

  it('an overlay histogram legend that would cover the peaks moves outside the frame', () => {
    const { engine, ws } = setup(3);
    // a small panel: the legend covers the curves in every corner
    const item = plot('histogram', 'APC-A', 'APC-A', { fontSize: 10 }, 200, 150);
    item.layers = ['s1', 's2', 's3'].map((s, i) => ({ id: 'l' + i, sample: s, population: 'root' }));
    const { geom, rec } = render(engine, ws, item);
    const entries = rec.texts.filter((t) => /^Sample \d$/.test(t.t));
    expect(entries.length).toBe(3);
    const fr = geom.frame;
    for (const e of entries) expect(e.x >= fr.x + fr.w || e.y >= fr.y + fr.h).toBe(true);
    // forced inside: within the frame
    item.options.legendPos = 'inside';
    const r2 = render(engine, ws, item);
    for (const e of r2.rec.texts.filter((t) => /^Sample \d$/.test(t.t))) expect(e.x).toBeLessThan(r2.geom.frame.x + r2.geom.frame.w);
  });

  it('overlay gate labels carry one value per layer in the layer colors', () => {
    const { engine, ws } = setup(2);
    const X = makeScale(ws.scales['APC-A']);
    ws.populations = [{ id: 'g', name: 'Pos', parentId: null, gate: { type: 'range', x: 'APC-A', min: X.inv(0.6), max: X.inv(1) }, color: '#2ca02c' }];
    const item = plot('histogram', 'APC-A', 'APC-A');
    item.layers = [
      { id: 'a', sample: 's1', population: 'root', color: '#111111' },
      { id: 'b', sample: 's2', population: 'root', color: '#d62728' },
    ];
    const { rec } = render(engine, ws, item);
    const pct = (s: string) => (100 * engine.count(ws, s, 'g')) / engine.count(ws, s, 'root');
    const fmt = (v: number) => (v < 10 ? v.toFixed(2) : v.toFixed(1));
    const v1 = rec.texts.find((t) => t.t === fmt(pct('s1')));
    const v2 = rec.texts.find((t) => t.t === fmt(pct('s2')));
    expect(v1?.st.color).toBe('#111111');
    expect(v2?.st.color).toBe('#d62728');
  });

  it('backgating plots get a legend of the population colors', () => {
    const { engine, ws } = setup();
    const X = makeScale(ws.scales['FSC-A']);
    const Y = makeScale(ws.scales['SSC-A']);
    ws.populations = [{ id: 'g', name: 'Lymphs', parentId: null, gate: { type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: X.inv(0.2), xmax: X.inv(0.5), ymin: Y.inv(0), ymax: Y.inv(0.3) }, color: '#9467bd' }];
    const item = plot('dot', 'FSC-A', 'SSC-A', { colorMode: 'population', showGates: false });
    expect(render(engine, ws, item).rec.texts.some((t) => t.t === 'Lymphs')).toBe(true);
    item.options.legend = false;
    expect(render(engine, ws, item).rec.texts.some((t) => t.t === 'Lymphs')).toBe(false);
  });
});

describe('margins', () => {
  it('small journal panels keep a usable data frame and the y title clears the tick labels', () => {
    const { engine, ws } = setup();
    const MM = 96 / 25.4;
    for (const [w, h, cb] of [
      [35, 32, 'none'],
      [35, 32, 'right'],
      [45, 40, 'right'],
    ] as const) {
      const item = plot('pseudo', 'FSC-A', 'SSC-A', { fontSize: 7, colorBar: cb }, w * MM, h * MM);
      const { geom, rec } = render(engine, ws, item);
      expect(geom.frame.w / item.w).toBeGreaterThan(cb === 'none' ? 0.62 : 0.4);
      expect(geom.frame.h / item.h).toBeGreaterThan(0.6);
      const ytitle = rec.texts.find((t) => t.rot !== 0 && t.t === 'SSC-A')!;
      const yticks = rec.texts.filter((t) => t.st.align === 'right' && t.rot === 0 && t.x < geom.frame.x);
      const leftmost = Math.min(...yticks.map((t) => t.x - width(t)));
      // rotated title: its descender side reaches ~0.56 em right of the anchor
      expect(ytitle.x + ytitle.st.size * 0.6).toBeLessThan(leftmost);
      expect(ytitle.x - ytitle.st.size * 0.45).toBeGreaterThan(0);
    }
  });

  it('same-size plots on a sheet share their data frame', () => {
    const { engine, ws } = setup();
    const a = plot('pseudo', 'FSC-A', 'SSC-A');
    const b = plot('pseudo', 'PC7-A', 'PE-A');
    const c = plot('histogram', 'APC-A', 'APC-A', { histMode: 'count' });
    const sheet = newWorksheet('S');
    sheet.items = [a, b, c];
    ws.worksheets = [sheet];
    const fa = render(engine, ws, a).geom.frame;
    expect(render(engine, ws, b).geom.frame).toEqual(fa);
    expect(render(engine, ws, c).geom.frame).toEqual(fa);
    // alone, the logicle plot would be laid out differently
    ws.worksheets = [];
    expect(render(engine, ws, b).geom.frame).not.toEqual(fa);
  });
});

describe('ticks', () => {
  it('use one unit per linear axis and a true minus sign', () => {
    const labels = computeTicks({ type: 'linear', min: 0, max: 1.05e6 }).filter((t) => t.label).map((t) => t.label!.base);
    expect(labels).toEqual(['0', '0.2M', '0.4M', '0.6M', '0.8M', '1.0M']);
    const neg = computeTicks({ type: 'linear', min: -2000, max: 6000 }).filter((t) => t.label).map((t) => t.label!.base);
    expect(neg[0]).toBe('−2K');
    const lg = computeTicks({ type: 'logicle', T: 262144, W: 1, M: 4.5, A: 0 }).filter((t) => t.label);
    expect(lg.some((t) => t.label!.base === '−10')).toBe(true);
  });
  it('drop logicle ticks that would merge with the zero tick', () => {
    const def = { type: 'logicle' as const, T: 1048576, W: 0.5, M: 5, A: 0 };
    const zero = computeTicks(def).find((t) => t.value === 0)!;
    const gap = 3 / 150; // 3 px on a 150 px axis
    for (const t of computeTicks(def, { zeroGap: gap })) if (t.value !== 0) expect(Math.abs(t.u - zero.u)).toBeGreaterThanOrEqual(gap);
    // decades in the linear region are no longer drawn as unlabelled major ticks
    for (const t of computeTicks(def)) if (t.value !== 0 && Math.abs(t.u - zero.u) < 0.06) expect(t.major && !t.label).toBe(false);
  });
});

describe('default scatter ranges', () => {
  // log-normal-ish population with a sparse tail, on a 2^24 instrument range
  const sample = (median: number, spread: number, n = 20000) => {
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    return Float32Array.from({ length: n }, () => {
      const g = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
      return median * Math.exp(spread * g);
    });
  };
  it('zooms CytoFLEX scatter to the populations but never below P99', () => {
    const d = sample(6e5, 0.45);
    const sc = defaultScaleFor('FSC-A', 16777216, d) as { type: string; max: number };
    const sorted = Float32Array.from(d).sort();
    expect(sc.type).toBe('linear');
    expect(sc.max).toBeGreaterThanOrEqual(sorted[Math.floor(d.length * 0.99)]);
    expect(sc.max).toBeLessThan(sorted[Math.floor(d.length * 0.99)] * 1.4);
  });
  it('uses a logicle axis for scatter spread over decades, and keeps native ranges the events fill', () => {
    expect(defaultScaleFor('SSC-A', 16777216, sample(2e4, 1.6)).type).toBe('logicle');
    expect(defaultScaleFor('SSC-A', 16777216, sample(2e4, 1.6), 'lin').type).toBe('linear');
    expect((defaultScaleFor('FSC-A', 262144, sample(9e4, 0.4)) as { max: number }).max).toBe(262144);
  });
});

describe('text', () => {
  const st: TextStyle = { family: 'Arial, Helvetica, sans-serif', size: 12, color: '#000' };
  it('shortens with an ellipsis and no space before it', () => {
    const r = fitText('Median fluorescence intensity of CD69 cells', 120, st);
    const s = runs(r).map((q) => q.text).join('');
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toMatch(/\s…$/);
    expect(measureRich(r, st)).toBeLessThanOrEqual(120);
    expect(runs(fitText('CD4^+ T cells of the very long population name', 60, st)).some((q) => q.sup)).toBe(true);
  });
  it('turns Unicode super- and subscripts into raised / lowered runs', () => {
    expect(runs('10⁴ H₂O CD4⁺')).toEqual([{ text: '10' }, { text: '4', sup: true }, { text: ' H' }, { text: '2', sub: true }, { text: 'O CD4' }, { text: '+', sup: true }]);
  });
  it('SVG text keeps spaces next to superscripts', () => {
    const p = new SvgPainter();
    p.text(0, 10, [{ text: '10' }, { text: '4', sup: true }, { text: ' cells' }], st);
    const s = p.toString();
    expect(s).toContain('xml:space="preserve"');
    expect(s).not.toContain('​');
    // every run at an absolute position (no relative dy: cairo draws a gap before the superscript otherwise)
    expect(s).toMatch(/<tspan x="[\d.]+" y="[\d.]+" font-size="8.4">4<\/tspan><tspan x="[\d.]+" y="10"> cells<\/tspan>/);
    expect(s).not.toContain(' dy=');
  });
  it('text boxes wrap on the rendered width of superscript markup', () => {
    const ws = emptyWorkspace();
    const it0: TextItem = { id: 't', kind: 'text', x: 0, y: 0, w: 1000, h: 200, text: 'CD4^{+}CD8^{-} T cells', fontSize: 10, bold: false, italic: false, align: 'left', color: '#000' };
    const plain = recorder();
    // exactly as wide as the rendered text: one line (the raw string with ^{ } would need two)
    it0.w = measureRich(runs([{ text: 'CD4' }, { text: '+', sup: true }, { text: 'CD8' }, { text: '-', sup: true }, { text: ' T cells' }]), { ...st, size: 10 * (96 / 72) }) + 0.5;
    renderText(plain as never, it0, ws);
    expect(plain.texts.length).toBe(1);
  });
});

describe('charts and statistics boxes', () => {
  it('a y maximum below the data keeps bars inside the frame and marks the overflow', () => {
    const { engine, ws } = setup(2);
    ws.populations = [];
    const it: ChartItem = { id: 'c', kind: 'chart', x: 0, y: 0, w: 240, h: 200, stat: { id: 's', population: 'root', stat: 'count' }, mode: 'samples', sampleSet: 'all', style: 'bar', errorBars: 'none', showPoints: false, color: '#4c78a8', useGroupColors: false, fontSize: 8, lineWidth: 1, yMax: 10, title: 'T' };
    const rec = recorder();
    renderChart(rec as never, it, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas });
    const title = rec.texts.find((t) => t.t === 'T')!;
    for (const r of rec.rects.filter((q) => q.w < it.w)) expect(r.y).toBeGreaterThan(title.y);
    expect(rec.paths.length).toBe(2); // one overflow marker per bar
  });
  it('rotated category labels stay inside the chart (left edge and bottom)', () => {
    const { engine, ws } = setup(4);
    ['Donor B stim', 'Donor A unstim', 'Donor A stim', 'Donor B unstim'].forEach((n, k) => (ws.samples[k].name = n));
    for (const fontSize of [8, 10, 12]) for (const w of [100, 150, 189, 260]) for (const h of [150, 208, 300]) {
      const it: ChartItem = { id: 'c', kind: 'chart', x: 0, y: 0, w, h, stat: { id: 's', population: 'root', stat: 'count' }, mode: 'samples', sampleSet: 'all', style: 'bar', errorBars: 'none', showPoints: false, color: '#4c78a8', useGroupColors: false, fontSize, lineWidth: 1, title: 'T' };
      const rec = recorder();
      renderChart(rec as never, it, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas });
      const labels = rec.texts.filter((t) => t.rot !== 0 && t.st.align === 'right');
      if (!labels.length) continue; // wide enough for upright labels
      if (labels.some((t) => Math.abs(t.rot + Math.PI / 2) < 1e-9)) {
        // bars too narrow for 45 degree labels: all stand at 90 degrees, straight down from their bar, at least a text
        // height apart (crowded: every k-th bar, the last one always)
        expect(labels.every((t) => Math.abs(t.rot + Math.PI / 2) < 1e-9)).toBe(true);
        expect(ws.samples[3].name.startsWith(labels[labels.length - 1].t.replace(/…$/, ''))).toBe(true);
        for (let i = 1; i < labels.length; i++) expect(labels[i].x - labels[i - 1].x).toBeGreaterThanOrEqual(labels[i].st.size);
        for (const t of labels) {
          expect(t.x - t.st.size * 0.6).toBeGreaterThanOrEqual(0);
          expect(t.y + width(t)).toBeLessThanOrEqual(it.h);
        }
        continue;
      }
      expect(labels.length).toBe(4);
      for (const t of labels) {
        // right-aligned at the anchor, rotated by -45 degrees: the far corner is (width + ~0.56 em) / sqrt(2) away
        const ext = (width(t) + t.st.size * 0.56) * Math.SQRT1_2;
        expect(t.x - ext).toBeGreaterThanOrEqual(0);
        expect(t.y + ext).toBeLessThanOrEqual(it.h);
      }
      // the demo chart's size and font: complete labels
      if (fontSize === 8 && w === 189 && h === 208) expect(labels.map((t) => t.t)).toEqual(ws.samples.map((q) => q.name));
    }
  });
  it('long statistics labels end in an ellipsis before the value; dark boxes use light text', () => {
    const { engine, ws } = setup();
    const it: StatsBoxItem = { id: 'b', kind: 'stats', x: 0, y: 0, w: 160, h: 80, sample: 's1', fontSize: 8, bg: 'dark', rows: [{ id: 'r', population: 'root', stat: 'count', header: 'A very long header for the event count of all the events' }] };
    const rec = recorder();
    renderStatsBox(rec as never, it, ws, engine, 's1');
    const lab = rec.texts.find((t) => t.t.startsWith('A very'))!;
    const val = rec.texts.find((t) => /^\d/.test(t.t))!;
    expect(lab.t.endsWith('…')).toBe(true);
    expect(lab.x + width(lab)).toBeLessThan(val.x - width(val));
    expect(lab.st.color).toBe('#e8eaed');
  });
});

describe('presets', () => {
  it('print (grayscale) draws gates in black; other presets restore population colors', () => {
    const it = plot('pseudo', 'FSC-A', 'SSC-A');
    applyPreset(it, presetById('print')!);
    expect(it.options.gateColor).toBe('#000000');
    applyPreset(it, presetById('viridis')!);
    expect(it.options.gateColor).toBeUndefined();
  });
});
