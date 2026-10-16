// Regressions of acceptance round 3 (figures): gate labels on small plots (other gates' outlines and interiors are a
// hard constraint, room outside the frame, smaller / one-line / shortened forms, the gating view placing them as the
// sheet), long names shortened in the middle with the full name on hover, gate label halos that are not a second text
// (SVG paint-order, PDF outline paths) and only drawn where needed, legends that keep their values, contour / zebra
// fills on dark pages.
import { Engine } from '../src/core/engine';
import type { FcsDataset } from '../src/core/fcs';
import { defaultPlotOptions, emptyWorkspace, type PlotItem, type Population, type Workspace } from '../src/core/model';
import { overlapArea, layoutLabelsDetailed, type Box } from '../src/render/labels';
import { fillStart, renderPlot, type PlotGeometry, type RenderEnv } from '../src/render/plot';
import { colormapLUT, luminance } from '../src/render/colormaps';
import { runs, SvgPainter, type RichText, type TextStyle } from '../src/render/painter';
import { PdfPainter } from '../src/render/pdf';

const noop = () => {};
interface Rec {
  texts: { x: number; y: number; t: string; st: TextStyle; rot: number }[];
}
function recorder(): Rec {
  const r: Rec = { texts: [] };
  return Object.assign(r, {
    kind: 'canvas',
    save: noop,
    restore: noop,
    translate: noop,
    clipRect: noop,
    line: noop,
    ellipse: noop,
    image: noop,
    path: noop,
    rect: noop,
    text: (x: number, y: number, t: RichText, st: TextStyle, rot = 0) => r.texts.push({ x, y, t: runs(t).map((q) => q.text).join(''), st, rot }),
  });
}
const canvasMaker = (() => ({ width: 1, height: 1, getContext: () => ({ createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: noop }) })) as unknown as RenderEnv['makeCanvas'];

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** CD4 / CD8 plot of CD3 cells: CD8+ top-left (near the frame top), CD4+ bottom-right, double negatives bottom-left. */
function setup(cd4Name = 'CD4+') {
  const r = rng(7);
  const n = 6000;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i % 10;
    const [cx, cy, sx, sy] = k < 6 ? [520, 90, 120, 18] : k < 8 ? [110, 90, 25, 18] : [110, 820, 22, 70];
    x[i] = cx + (r() + r() + r() - 1.5) * sx;
    y[i] = cy + (r() + r() + r() - 1.5) * sy;
  }
  const ds = { channels: [{ name: 'APC-A', label: '', range: 1024 }, { name: 'BV650-A', label: '', range: 1024 }], data: [x, y], eventCount: n, keywords: {}, warnings: [] } as unknown as FcsDataset;
  const engine = new Engine();
  engine.addSample('s1', ds);
  const ws: Workspace = emptyWorkspace();
  ws.samples.push({ id: 's1', name: 'S1', fileName: 's1.fcs', fileSize: 0, eventCount: n, channels: ds.channels.map((c) => ({ name: c.name, label: '', range: 1024 })), compId: null });
  ws.scales['APC-A'] = { type: 'linear', min: 0, max: 1000 };
  ws.scales['BV650-A'] = { type: 'linear', min: 0, max: 1000 };
  const cd8: Population = { id: 'cd8', name: 'CD8+', parentId: null, color: '#1f77b4', gate: { type: 'rect', x: 'APC-A', y: 'BV650-A', xmin: 50, xmax: 180, ymin: 640, ymax: 985 } };
  const cd4: Population = { id: 'cd4', name: cd4Name, parentId: null, color: '#8c564b', gate: { type: 'rect', x: 'APC-A', y: 'BV650-A', xmin: 200, xmax: 950, ymin: 40, ymax: 145 } };
  ws.populations.push(cd4, cd8);
  return { engine, ws };
}

const plot = (w = 106, h = 106, opts: Partial<PlotItem['options']> = {}): PlotItem => ({
  id: 'p',
  kind: 'plot',
  plotType: 'pseudo',
  xParam: 'APC-A',
  yParam: 'BV650-A',
  layers: [{ id: 'l', sample: 's1', population: 'root' }],
  options: { ...defaultPlotOptions(), fontSize: 6, colorMode: 'density', ...opts },
  x: 0,
  y: 0,
  w,
  h,
});

function render(ws: Workspace, engine: Engine, item: PlotItem, extra: Partial<RenderEnv> = {}) {
  ws.worksheets[0].items = [{ ...item, w: extra.labelRef?.w ?? item.w, h: extra.labelRef?.h ?? item.h }];
  const rec = recorder();
  const geom = renderPlot(rec as never, item, item.w, item.h, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas: canvasMaker, forExport: true, ...extra });
  return { rec, geom };
}

/** text boxes of a gate's label (name and value lines), from the geometry's label box */
const labelBox = (g: PlotGeometry, id: string): Box => g.gates.find((s) => s.popId === id)!.label!;
const rectOf = (g: PlotGeometry, id: string): Box => {
  const o = g.gates.find((s) => s.popId === id)!.outline!;
  const xs = [o[0], o[2], o[4], o[6]];
  const ys = [o[1], o[3], o[5], o[7]];
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
/** the label box shrunk by its padding (the text itself) */
const inner = (b: Box): Box => ({ x: b.x + 2, y: b.y + 1, w: b.w - 4, h: b.h - 2 });

describe('gate labels on a small CD4 / CD8 plot', () => {
  for (const name of ['CD4+', 'CD4+ T cells']) {
    it(`never on the other gate's outline or interior (${name})`, () => {
      const { engine, ws } = setup(name);
      const { rec, geom } = render(ws, engine, plot());
      const all = rec.texts.map((t) => t.t).join('|');
      // both percentages are shown, the long name in full (above the frame when it fits nowhere inside)
      expect(all).toContain(name);
      expect(all).not.toMatch(/…/);
      for (const [a, b] of [
        ['cd4', 'cd8'],
        ['cd8', 'cd4'],
      ]) {
        const lb = inner(labelBox(geom, a));
        expect(overlapArea(lb, rectOf(geom, b))).toBe(0);
      }
      // nor on each other
      expect(overlapArea(labelBox(geom, 'cd4'), labelBox(geom, 'cd8'))).toBe(0);
    });
  }

  it('the gating view (an enlarged copy) places the labels as on the sheet', () => {
    const { engine, ws } = setup('CD4+ T cells');
    const sheet = render(ws, engine, plot());
    const big = render(ws, engine, plot(265, 265), { labelRef: { w: 106, h: 106 } });
    for (const id of ['cd4', 'cd8']) {
      const a = labelBox(sheet.geom, id);
      const b = labelBox(big.geom, id);
      const fa = sheet.geom.frame;
      const fb = big.geom.frame;
      // same side of the frame (above it / inside it), same text size
      expect(a.y + a.h <= fa.y + 0.5).toBe(b.y + b.h <= fb.y + 0.5);
      expect(b.h).toBeCloseTo(a.h, 3);
      // on the same side of its gate (above / below / left / right of it)
      const side = (l: Box, g: Box) => [l.y + l.h <= g.y + 1, l.y >= g.y + g.h - 1, l.x + l.w <= g.x + 1, l.x >= g.x + g.w - 1].join();
      expect(side(b, rectOf(big.geom, id))).toBe(side(a, rectOf(sheet.geom, id)));
    }
    // the sheet reserved room above the frame for the long label: the enlarged view too
    const zoneA = sheet.geom.frame.y - labelBox(sheet.geom, 'cd4').y;
    if (zoneA > 0) expect(big.geom.frame.y - labelBox(big.geom, 'cd4').y).toBeCloseTo(zoneA, 0);
  });

  it('a name wider than the plot is shortened in the middle, with the full text for the hover', () => {
    const { engine, ws } = setup('Comp-LIVE_DEAD Aqua-A, SSC-A subset');
    const { rec, geom } = render(ws, engine, plot());
    const shown = rec.texts.find((t) => t.t.startsWith('Comp-'))!.t;
    expect(shown).toMatch(/^Comp-.*….*t( |$)/);
    const lb = labelBox(geom, 'cd4');
    // inside the plot item
    expect(lb.x + lb.w).toBeLessThanOrEqual(106 + 0.5);
    expect(geom.gates.find((s) => s.popId === 'cd4')!.label!.full).toMatch(/^Comp-LIVE_DEAD Aqua-A, SSC-A subset /);
  });
});

describe('label layout engine', () => {
  it("keeps labels out of other gates' interiors when there is another place", () => {
    const bounds = { x: 0, y: 0, w: 200, h: 200 };
    const other = [60, 60, 140, 60, 140, 140, 60, 140];
    const res = layoutLabelsDetailed([{ id: 'a', w: 30, h: 12, cands: [{ x: 85, y: 90, cost: 0 }], bounds, owner: 'a', scan: true }], [], undefined, {
      regions: [{ owner: 'b', pts: other }],
      lines: [{ pts: other, closed: true, owner: 'b' }],
    });
    const b = res.boxes.get('a')!;
    expect(res.info.get('a')!.hard).toBe(false);
    expect(overlapArea(b, { x: 60, y: 60, w: 80, h: 80 })).toBe(0);
  });
  it('uses a smaller / one-line form, then room outside the frame, before a hard place', () => {
    const bounds = { x: 0, y: 20, w: 60, h: 60 };
    const res = layoutLabelsDetailed(
      [{ id: 'a', w: 40, h: 24, cands: [{ x: 5, y: 25, cost: 0 }], bounds, owner: 'a', forms: [{ w: 50, h: 12, cost: 0.6, cands: [{ x: 5, y: 25, cost: 0 }] }] }],
      [{ x: 0, y: 20, w: 60, h: 46 }],
      undefined,
      { zones: [{ box: { x: 0, y: 2, w: 60, h: 16 }, cost: 2.5 }] },
    );
    const inf = res.info.get('a')!;
    expect(inf.hard).toBe(false);
    expect(inf.form).toBe(0);
  });
});

describe('gate label halo', () => {
  const st: TextStyle = { family: 'Arial', size: 10, color: '#111111', halo: { color: '#ffffff', width: 1.4, opacity: 0.92 } };
  it('SVG: one text element (stroke under the fill where paint-order works), never a second copy', () => {
    const p = new SvgPainter('t');
    p.text(10, 10, 'CD4+', st);
    p.text(10, 30, 'CD8+', st);
    const s = p.toString();
    expect((s.match(/<text/g) ?? []).length).toBe(2);
    expect((s.match(/>CD4\+</g) ?? []).length).toBe(1);
    expect(s).toMatch(/@supports \(paint-order: stroke\)/);
    expect((s.match(/<style>/g) ?? []).length).toBe(1);
  });
  it('PDF: the halo is an artifact path, the label one text object', () => {
    const p = new PdfPainter(100, 100);
    p.text(10, 10, 'CD4+', st);
    const ops = p._parts().ops.join('\n');
    expect((ops.match(/Tj/g) ?? []).length).toBe(1);
    expect(ops).toContain('/Artifact BMC');
    // (no stroked copy of the text: text render mode 1)
    expect(ops).not.toMatch(/1 Tr/);
    // glyph outlines: curves
    expect(ops).toMatch(/ c /);
  });
  it('only where the label sits on data or outlines', () => {
    const { engine, ws } = setup();
    const { rec } = render(ws, engine, plot(300, 300, { fontSize: 8 }));
    const labels = rec.texts.filter((t) => /^(CD4\+|CD8\+)$/.test(t.t));
    expect(labels.length).toBe(2);
    // in the empty upper right part of a large plot: no halo needed for at least one of them
    expect(labels.some((t) => !t.st.halo)).toBe(true);
  });
});

describe('overlay legend values', () => {
  it('never drops the statistic: long names are shortened or wrapped instead', () => {
    const { engine, ws } = setup();
    for (const [id, name] of [
      ['s2', 'ALS unstim. long sample name'],
      ['s3', 'ALS peptide'],
    ]) {
      engine.addSample(id, engine.samples.get('s1')!.ds);
      ws.samples.push({ ...ws.samples[0], id, name });
    }
    const item: PlotItem = {
      ...plot(219, 106),
      plotType: 'histogram',
      layers: ['s1', 's2', 's3'].map((s, i) => ({ id: 'l' + i, sample: s, population: 'root' })),
      options: { ...defaultPlotOptions(), fontSize: 6, legend: true, legendPos: 'outside-right', legendStat: 'median' },
    };
    const { rec } = render(ws, engine, item);
    const mfi = rec.texts.filter((t) => /MFI \d/.test(t.t));
    expect(mfi.length).toBe(3);
  });
});

describe('contour / zebra fills on dark pages', () => {
  it('start where the colormap stands out from the background', () => {
    expect(fillStart({ name: 'turbo' }, '#ffffff')).toBe(0);
    for (const bg of ['#14161a', '#1d2026', '#000000']) {
      const t = fillStart({ name: 'turbo' }, bg);
      expect(t).toBeGreaterThan(0);
      const lut = colormapLUT({ name: 'turbo' });
      const i = Math.round(t * 255);
      const hex = '#' + [lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      expect((luminance(hex) + 0.05) / (luminance(bg) + 0.05)).toBeGreaterThanOrEqual(2.9);
    }
    // viridis starts dark purple, too
    expect(fillStart({ name: 'viridis' }, '#14161a')).toBeGreaterThan(0);
  });
});
