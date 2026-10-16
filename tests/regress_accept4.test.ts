// Regressions of acceptance round 4: text boxes grow with their text (repeat headers after a font change), overlay
// gate label stacks stay in the frame, axis titles are shortened (marker label / middle ellipsis) instead of cut at the
// item edge, calibration point labels sit next to their own point, shortened gate names stay distinguishable (and the
// gating view shows them in full), an accurate fit-axes note, per-detector bead factors on the size curve, and text
// made by the app follows the page color.
import { writeFileSync } from 'fs';
import { Engine, engine } from '../src/core/engine';
import type { FcsDataset } from '../src/core/fcs';
import { defaultPlotOptions, emptyWorkspace, MM, type PlotItem, type Population, type TextItem, type Workspace } from '../src/core/model';
import { newCalibItem, renderCalibPanel, type CalibChartItem } from '../src/render/calibPanel';
import { nameAbbreviations, shortenName } from '../src/render/figstyle';
import { textLines, textNeedH, textOverflows } from '../src/render/items';
import { overlapArea, type Box } from '../src/render/labels';
import { measureRich, runs, SvgPainter, type Painter, type RichText, type TextStyle } from '../src/render/painter';
import { fitAxisTitle, plotFitNotes, PT, renderPlot, type PlotGeometry, type RenderEnv } from '../src/render/plot';
import { loadDemo } from '../src/state/demo';
import { freezeNote, useStore } from '../src/state/store';
import { beadSigmaPoints } from '../src/ui/calib/SizePage';
import { sizeCurvePanel, sizeFitPanel } from '../src/ui/calib/sheetPanels';
import { repeatForSamples } from '../src/ui/layoutOps';
import type { CollectionFit } from '../src/core/scattercal';

const noop = () => {};
interface Rec {
  texts: { x: number; y: number; t: string; st: TextStyle; rot: number }[];
  ellipses: { x: number; y: number }[];
}
function recorder(): Rec & Painter {
  const r: Rec = { texts: [], ellipses: [] };
  return Object.assign(r, {
    kind: 'canvas' as const,
    save: noop,
    restore: noop,
    translate: noop,
    clipRect: noop,
    line: noop,
    ellipse: (x: number, y: number) => void r.ellipses.push({ x, y }),
    image: noop,
    path: noop,
    rect: noop,
    text: (x: number, y: number, t: RichText, st: TextStyle, rot = 0) => void r.texts.push({ x, y, t: runs(t).map((q) => q.text).join(''), st, rot }),
  }) as Rec & Painter;
}
const canvasMaker = (() => ({ width: 1, height: 1, getContext: () => ({ createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: noop, drawImage: noop, clearRect: noop }) })) as unknown as RenderEnv['makeCanvas'];
const dump = (name: string, w: number, h: number, draw: (p: Painter) => void) => {
  if (!process.env.ACCEPT4_SVG) return;
  const p = new SvgPainter('a');
  draw(p);
  writeFileSync(`${process.env.ACCEPT4_SVG}/${name}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 4}" height="${h * 4}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#fff"/>${p.toString()}</svg>`);
};
const inside = (b: Box, f: Box, tol = 0.5) => b.x >= f.x - tol && b.y >= f.y - tol && b.x + b.w <= f.x + f.w + tol && b.y + b.h <= f.y + f.h + tol;

describe('text boxes fit their text', () => {
  const sheet = () => useStore.getState().ws.worksheets.find((s) => s.id === useStore.getState().ui.activeSheetId)!;
  const texts = () => sheet().items.filter((i): i is TextItem => i.kind === 'text');

  it('repeat-for-samples row labels grow (around their middle) when the sheet font gets larger', () => {
    loadDemo();
    const ws = useStore.getState().ws;
    const first = sheet().items.find((i) => i.kind === 'plot')!;
    const sids = ws.samples.filter((s) => s.name !== 'Unstained').map((s) => s.id);
    repeatForSamples(sheet().id, [first.id], sids, { newSheet: false, rowLabels: true, orientation: 'rows' });
    const heads = texts().filter((t) => t.sampleHeader);
    expect(heads.length).toBe(4);
    const before = new Map(heads.map((t) => [t.id, { mid: t.y + t.h / 2, h: t.h }]));
    // sheet font 11 pt, "Font to all items"
    useStore.getState().update((w) => {
      const sh = w.worksheets.find((s) => s.id === sheet().id)!;
      sh.fontSize = 11;
      for (const it of sh.items) if (it.kind === 'text') it.fontSize = 11;
    });
    const fam = useStore.getState().ws.style.fontFamily;
    for (const t of texts()) expect(textOverflows(t, fam)).toBe(false);
    const stim = texts().find((t) => t.text === 'Donor A stim')!;
    expect(textLines(stim, fam).length).toBe(2);
    const b = before.get(stim.id)!;
    expect(stim.h).toBeGreaterThan(b.h * 1.5);
    expect(stim.y + stim.h / 2).toBeCloseTo(b.mid, 3);
  });

  it('any text box grows downwards with its text; one sized by hand keeps its height and reports the overflow', () => {
    loadDemo();
    const fam = useStore.getState().ws.style.fontFamily;
    const title = texts()[0];
    const y0 = title.y;
    useStore.getState().update((w) => {
      const t = w.worksheets[0].items.find((i) => i.id === title.id) as TextItem;
      t.text = 'A much longer title of the example figure that has to wrap over more than one line of this box, and then some more words';
    });
    const grown = texts().find((t) => t.id === title.id)!;
    expect(grown.y).toBe(y0);
    expect(grown.h).toBeGreaterThanOrEqual(textNeedH(grown, fam));
    expect(textOverflows(grown, fam)).toBe(false);
    // the user fixes the height; a larger font then overflows (marked on screen, said in the export dialog)
    useStore.getState().update((w) => {
      const t = w.worksheets[0].items.find((i) => i.id === title.id) as TextItem;
      t.h = 20;
      t.hFixed = true;
    });
    useStore.getState().update((w) => {
      const t = w.worksheets[0].items.find((i) => i.id === title.id) as TextItem;
      t.fontSize = 16;
    });
    const fixed = texts().find((t) => t.id === title.id)!;
    expect(fixed.h).toBe(20);
    expect(textOverflows(fixed, fam)).toBe(true);
  });

  it('the demo title and app-made texts follow the page color', () => {
    loadDemo();
    expect(texts()[0].color).toBe('');
  });
});

/** the demo's overlay histogram (CD69 of CD4+ T cells) with four layers at 40 x 40 mm */
function overlay40() {
  loadDemo();
  const st = useStore.getState();
  const ws = st.ws;
  const sh = ws.worksheets[0];
  const ov = sh.items.find((i): i is PlotItem => i.kind === 'plot' && i.layers.length === 2)!;
  const un = ws.samples.find((s) => s.name === 'Unstained')!.id;
  const bUn = ws.samples.find((s) => s.name === 'Donor B unstim')!.id;
  const item: PlotItem = JSON.parse(JSON.stringify(ov));
  item.layers.push({ id: 'l3', sample: un, population: ov.layers[0].population, color: '#1f77b4' }, { id: 'l4', sample: bUn, population: ov.layers[0].population, color: '#2ca02c' });
  item.options.legendStat = 'median';
  item.w = item.h = 40 * MM;
  const w2: Workspace = { ...ws, worksheets: [{ ...sh, items: [item] }] };
  return { ws: w2, item };
}

describe('overlay gate label stacks', () => {
  it('stay inside the frame (one value per layer, compact when the stack does not fit)', () => {
    const { ws, item } = overlay40();
    const rec = recorder();
    const env: RenderEnv = { ws, engine, activeSampleId: null, rasterScale: 1, makeCanvas: canvasMaker, forExport: true };
    const geom = renderPlot(rec, item, item.w, item.h, env);
    dump('overlay40', item.w, item.h, (p) => renderPlot(p, item, item.w, item.h, env));
    const labelled = geom.gates.filter((g) => g.label);
    expect(labelled.length).toBeGreaterThan(0);
    for (const g of labelled) expect(inside(g.label!, geom.frame, 1)).toBe(true);
    // every layer's value is still shown
    const all = rec.texts.map((t) => t.t).join(' ');
    for (const v of ['4.0', '46']) expect(all).toContain(v);
  });
});

describe('axis titles', () => {
  const LABEL = 'APC-eFluor 780 fixable viability stain, lot 2';
  it('are shortened (marker label, else a middle ellipsis) and never run past the item edge', () => {
    loadDemo();
    const ws: Workspace = JSON.parse(JSON.stringify(useStore.getState().ws));
    ws.channelLabels['APC-A'] = LABEL;
    const item: PlotItem = { id: 'p', kind: 'plot', plotType: 'pseudo', xParam: 'APC-A', yParam: 'SSC-A', layers: [{ id: 'l', sample: ws.samples[1].id, population: 'root' }], options: { ...defaultPlotOptions(), fontSize: 8 }, x: 0, y: 0, w: 28 * MM, h: 28 * MM };
    ws.worksheets[0].items = [item];
    const rec = recorder();
    const env: RenderEnv = { ws, engine, activeSampleId: null, rasterScale: 1, makeCanvas: canvasMaker, forExport: true };
    const geom = renderPlot(rec, item, item.w, item.h, env);
    dump('axis28', item.w, item.h, (p) => renderPlot(p, item, item.w, item.h, env));
    const xt = rec.texts.filter((t) => !t.rot && t.st.align === 'center' && t.st.baseline === 'top' && t.y > geom.frame.y + geom.frame.h + 8);
    expect(xt.length).toBeGreaterThan(0);
    for (const t of xt) {
      const w = measureRich(t.t, t.st);
      expect(t.x - w / 2).toBeGreaterThanOrEqual(-0.01);
      expect(t.x + w / 2).toBeLessThanOrEqual(item.w + 0.01);
    }
    const shown = xt.map((t) => t.t).join(' ');
    // too long for 28 mm even on two lines: the marker label alone, or an ellipsis; listed by the export dialog
    expect(shown === LABEL || shown.includes('…')).toBe(true);
    expect(plotFitNotes(item, ws, null, engine).join(' ')).toContain(`X axis title "${LABEL} (APC-A)" is shortened to "${shown}"`);
  });

  it('prefer the marker label, then a middle ellipsis', () => {
    const st: TextStyle = { family: 'Arial', size: 8 * PT, color: '#000' };
    const full = 'LIVE/DEAD Aqua (Comp-BV510-A-Height-Long)';
    const room = measureRich('LIVE/DEAD Aqua', { ...st, size: st.size * 0.8 }) + 2;
    const f = fitAxisTitle(full, 'LIVE/DEAD Aqua', room, st);
    expect(f.cut).toBe(true);
    expect(f.lines.join(' ')).toBe('LIVE/DEAD Aqua');
    const g = fitAxisTitle(full, null, room * 0.7, st);
    expect(g.lines[0]).toMatch(/^LIVE.*….*g\)$/);
    expect(measureRich(g.lines[0], { ...st, size: g.size })).toBeLessThanOrEqual(room * 0.7);
  });
});

describe('shortened names stay distinguishable', () => {
  it('abbreviates common words first, then keeps the distinguishing part', () => {
    expect(nameAbbreviations('CD4 Single Positive')[0]).toBe('CD4 SP');
    expect(nameAbbreviations('IFNg Positive')[0]).toBe('IFNg+');
    const others = ['CD4 Single Positive', 'CD8 Single Positive'];
    const byLen = (n: number) => (t: string) => [...t].length <= n;
    expect(shortenName('CD4 Single Positive', byLen(8), others)).toBe('CD4 SP');
    const a = shortenName('CD4 Single Positive', byLen(5), others);
    const b = shortenName('CD8 Single Positive', byLen(5), others);
    expect(a).not.toBe(b);
    expect(a.startsWith('CD4')).toBe(true);
    // names differing at their end keep their end
    const c = shortenName('Single Cells 1', byLen(6), ['Single Cells 1', 'Single Cells 2']);
    const d = shortenName('Single Cells 2', byLen(6), ['Single Cells 1', 'Single Cells 2']);
    expect(c).not.toBe(d);
    // a name without rivals: the usual middle ellipsis
    expect(shortenName('Lymphocytes and monocytes', byLen(9))).toMatch(/^Lymp.*….*tes$/);
  });

  function cdSetup() {
    let s = 7;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
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
    const eng = new Engine();
    eng.addSample('s1', ds);
    const ws: Workspace = emptyWorkspace();
    ws.samples.push({ id: 's1', name: 'S1', fileName: 's1.fcs', fileSize: 0, eventCount: n, channels: ds.channels.map((c) => ({ name: c.name, label: '', range: 1024 })), compId: null });
    ws.scales['APC-A'] = { type: 'linear', min: 0, max: 1000 };
    ws.scales['BV650-A'] = { type: 'linear', min: 0, max: 1000 };
    const cd8: Population = { id: 'cd8', name: 'CD8 Single Positive', parentId: null, color: '#1f77b4', gate: { type: 'rect', x: 'APC-A', y: 'BV650-A', xmin: 50, xmax: 180, ymin: 640, ymax: 985 } };
    const cd4: Population = { id: 'cd4', name: 'CD4 Single Positive', parentId: null, color: '#8c564b', gate: { type: 'rect', x: 'APC-A', y: 'BV650-A', xmin: 200, xmax: 950, ymin: 40, ymax: 145 } };
    ws.populations.push(cd4, cd8);
    return { eng, ws };
  }
  const plot = (w: number, h: number): PlotItem => ({ id: 'p', kind: 'plot', plotType: 'pseudo', xParam: 'APC-A', yParam: 'BV650-A', layers: [{ id: 'l', sample: 's1', population: 'root' }], options: { ...defaultPlotOptions(), fontSize: 6, colorMode: 'density' }, x: 0, y: 0, w, h });
  const draw = (ws: Workspace, eng: Engine, item: PlotItem, extra: Partial<RenderEnv> = {}) => {
    ws.worksheets[0].items = [{ ...item, w: extra.labelRef?.w ?? item.w, h: extra.labelRef?.h ?? item.h }];
    const rec = recorder();
    const geom: PlotGeometry = renderPlot(rec, item, item.w, item.h, { ws, engine: eng, activeSampleId: 's1', rasterScale: 1, makeCanvas: canvasMaker, forExport: true, ...extra });
    return { rec, geom };
  };

  it('on a small plot, and in full in the (large) gating view', () => {
    const { eng, ws } = cdSetup();
    const small = draw(ws, eng, plot(28 * MM, 28 * MM));
    const names = small.rec.texts.map((t) => t.t).filter((t) => /^CD[48]/.test(t));
    // distinguishable: no two gate labels read the same
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((t) => t.startsWith('CD4'))).toBe(true);
    expect(names.some((t) => t.startsWith('CD8'))).toBe(true);
    // the gating view: the plot drawn at 500 px, labels laid out at the sheet size, the names in full
    const big = draw(ws, eng, plot(500, 480), { labelRef: { w: 28 * MM, h: 28 * MM } });
    const bigText = big.rec.texts.map((t) => t.t).join('|');
    expect(bigText).toContain('CD4 Single Positive');
    expect(bigText).toContain('CD8 Single Positive');
    for (const g of big.geom.gates) expect(g.label?.full).toBeUndefined();
    const [a, b] = big.geom.gates.map((g) => g.label!);
    expect(overlapArea(a, b)).toBe(0);
  });
});

describe('calibration panels', () => {
  it('bead labels sit next to their own point, inside the frame and off the legend', () => {
    const fit = sizeFitPanel({
      channel: 'SSC-A / SSC_1-A',
      beads: [142, 80, 304, 108, 600, 142, 1020].map((x, i) => ({ diameterNm: x, predicted: [3e4, 9e4, 2.8e5, 4.6e5, 1.1e6, 1.6e6, 4e6][i], measured: [3.1e4, 8.4e4, 2.9e5, 4.9e5, 1.15e6, 1.8e6, 4.1e6][i], used: true })),
      halfAngleDeg: 54.7,
      cvPct: 6.3,
      r2Log: 0.9988,
      fixed: false,
    });
    for (const [wmm, hmm] of [
      [60, 54],
      [45, 40],
      [55, 45],
      [40, 50],
    ]) {
      const ws = emptyWorkspace();
      const it = newCalibItem(fit, 0, 0, wmm * MM, hmm * MM, 7) as CalibChartItem;
      ws.worksheets[0].items.push(it);
      const env = { ws, engine: new Engine(), activeSampleId: null, rasterScale: 1, makeCanvas: (() => null) as never };
      const rec = recorder();
      renderCalibPanel(rec, it, env);
      dump(`beadfit_${wmm}x${hmm}`, it.w, it.h, (p) => renderCalibPanel(p, it, env));
      const pts = rec.ellipses.slice(-7);
      const labels = rec.texts.filter((t) => /^[\d,]+$/.test(t.t) && t.st.baseline === 'bottom');
      expect(labels.length).toBe(7);
      // the frame: the points' extent is inside it; labels stay within the item and right of the y axis
      for (const t of labels) {
        const w = measureRich(t.t, t.st);
        const box = { x: t.x, y: t.y - t.st.size * 1.05, w, h: t.st.size * 1.05 };
        const d = (p: { x: number; y: number }) => Math.hypot(Math.max(box.x - p.x, 0, p.x - box.x - box.w), Math.max(box.y - p.y, 0, p.y - box.y - box.h));
        const own = pts.reduce((best, p) => (d(p) < d(best) ? p : best));
        // the nearest point to the label is one labelled with this text (never between two points)
        const nearest = pts.filter((p) => Math.abs(d(p) - d(own)) < 0.01);
        expect(nearest.length).toBe(1);
        expect(box.x + box.w).toBeLessThanOrEqual(it.w);
        expect(box.y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('size curve: beads of each detector in nm² with their own factor, the axis in σ (nm²)', () => {
    const fit = {
      nm2PerAu: 0.01,
      groupFactors: [
        { nm2PerAu: 0.01, auPerNm2: 100, n: 4, cvPct: 3 },
        { nm2PerAu: 0.5, auPerNm2: 2, n: 3, cvPct: 4 },
      ],
      beads: [
        { label: '80', diameterNm: 80, measured: 2300, used: true },
        { label: '142', diameterNm: 142, measured: 48000, used: true },
        { label: '600', diameterNm: 600, measured: 600, used: true },
        { label: '1020', diameterNm: 1020, measured: 2200, used: true },
        { label: 'x', diameterNm: 200, measured: NaN, used: false },
      ],
    } as unknown as CollectionFit;
    const pts = beadSigmaPoints(fit, [0, 0, 1, 1, 1], ['SSC-A', 'SSC_1-A'], 'SSC-A');
    expect(pts.map((p) => p.sigma)).toEqual([23, 480, 300, 1100]);
    expect(pts.map((p) => p.channel)).toEqual(['SSC-A', 'SSC-A', 'SSC_1-A', 'SSC_1-A']);
    const d = Array.from({ length: 60 }, (_, i) => 20 * Math.pow(1500 / 20, i / 59));
    const panel = sizeCurvePanel({ channel: 'SSC-A', modelName: 'EV', diameters: d, sigma: d.map((x) => 1e-6 * x ** 3), validRange: [40, 350], beads: pts, noiseSigma: 0.05 });
    expect(panel.y.title).toBe('σ (nm²)');
    const beadSeries = panel.series.filter((s) => s.kind === 'points');
    expect(beadSeries.map((s) => s.name)).toEqual(['beads (SSC-A)', 'beads (SSC_1-A)']);
    expect(beadSeries[1].y).toEqual([300, 1100]);
    expect(beadSeries[1].hollow?.every(Boolean)).toBe(true);
    // drawn: the legend names both detectors
    const ws = emptyWorkspace();
    const it = newCalibItem(panel, 0, 0, 60 * MM, 54 * MM, 7) as CalibChartItem;
    ws.worksheets[0].items.push(it);
    const env = { ws, engine: new Engine(), activeSampleId: null, rasterScale: 1, makeCanvas: (() => null) as never };
    const rec = recorder();
    renderCalibPanel(rec, it, env);
    dump('sizecurve', it.w, it.h, (p) => renderCalibPanel(p, it, env));
    const all = rec.texts.map((t) => t.t).join('|');
    expect(all).toContain('beads (SSC_1-A)');
    expect(all).toContain('σ (nm');
  });
});

describe('fit axes note', () => {
  it('says that a shared gate would change the counts (gaining events where it holds none)', () => {
    const ws = emptyWorkspace();
    ws.samples.push({ id: 'bd', name: 'Activation_1', fileName: 'a.fcs', fileSize: 0, eventCount: 1, channels: [], compId: null });
    const note = freezeNote(ws, { gates: 1, split: [{ pop: 'p3', name: 'P3', samples: ['bd'], empty: ['bd'] }], apply: noop });
    expect(note).toContain('"P3": a shared gate would change the counts on "Activation_1" (it would gain events there), so it got a sample-specific copy there');
    expect(note).not.toMatch(/evaluated on different axis scales/);
    expect(note).not.toMatch(/—/);
  });
});
