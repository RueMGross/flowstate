import { colormapColor, colormapLUT, COLORMAP_NAMES } from '../src/render/colormaps';
import { binStat, hist2dEdge, logThresholds, rankBins, sampleGrid } from '../src/render/density';
import { applyPreset, copyAppearance, PRESETS, presetById } from '../src/render/presets';
import { defaultPlotOptions, newWorksheet, setGridStyle, sheetGridStyle, type PlotItem, type Worksheet } from '../src/core/model';
import { renderPageBackground } from '../src/render/items';
import { SvgPainter } from '../src/render/painter';

describe('colormaps', () => {
  it('match the matplotlib end points and support reverse / custom gradients', () => {
    expect(colormapColor('viridis', 0)).toBe('#440154');
    expect(colormapColor('viridis', 1)).toBe('#fde725');
    expect(colormapColor('magma', 1)).toBe('#fcfdbf');
    expect(colormapColor('cividis', 0)).toBe('#00224e');
    expect(colormapColor({ name: 'viridis', reverse: true }, 0)).toBe('#fde725');
    expect(colormapColor({ name: 'custom', stops: ['#000000', '#ffffff'] }, 1)).toBe('#ffffff');
    expect(colormapColor({ name: 'custom', stops: ['#000000', '#ff0000', '#ffffff'] }, 127.5 / 255)).toMatch(/^#ff0[01]0[01]$/);
    // v1 maps keep their look
    expect(colormapColor('flowjo', 0)).toBe('#0000c8');
    expect(colormapColor('gray', 0)).toBe('#bdbdbd');
    expect(COLORMAP_NAMES.length).toBeGreaterThanOrEqual(19);
    for (const n of COLORMAP_NAMES) expect(colormapLUT(n).length).toBe(768);
  });
  it('interpolate viridis close to the 256-entry reference', () => {
    // matplotlib viridis entries 100 and 200
    const lut = colormapLUT('viridis');
    const near = (i: number, ref: number[]) => ref.forEach((v, j) => expect(Math.abs(lut[i * 3 + j] - v * 255)).toBeLessThan(3));
    near(100, [0.166617, 0.463708, 0.558119]);
    near(200, [0.440137, 0.811138, 0.340967]);
  });
});

describe('density helpers', () => {
  const dx = Float32Array.from([0.1, 0.1, 0.9, -0.2, 1.5, NaN]);
  const dy = Float32Array.from([0.1, 0.1, 0.9, 0.5, 0.5, 0.5]);
  const idx = Uint32Array.from([0, 1, 2, 3, 4, 5]);
  it('counts off-scale events in the edge bins unless the axis is zoomed', () => {
    const h = hist2dEdge(dx, dy, idx, 4, 4, false, false);
    expect(h.reduce((a, b) => a + b, 0)).toBe(5);
    expect(h[0]).toBe(2);
    expect(h[2 * 4 + 0]).toBe(1); // x < 0 -> left column
    expect(h[2 * 4 + 3]).toBe(1); // x > 1 -> right column
    expect(hist2dEdge(dx, dy, idx, 4, 4, true, false).reduce((a, b) => a + b, 0)).toBe(3);
  });
  it('ranks bins by the share of events at lower density', () => {
    const r = rankBins(Float32Array.from([0, 1, 3, 3]), Float32Array.from([0, 2, 1, 1]));
    expect(r[0]).toBe(0);
    expect(r[1]).toBeCloseTo(0.25); // half of its own 2 of 4 events
    expect(r[2]).toBeCloseTo(0.75);
    expect(r[3]).toBeCloseTo(0.75);
  });
  it('computes per-bin medians and means of a third parameter', () => {
    const w = Float32Array.from([1, 3, 5, 7, 9, 11]);
    const med = binStat(dx, dy, w, idx, 2, 2, 'median', false, false);
    expect(med[0]).toBe(2); // events 0, 1
    expect(med[3]).toBe(7); // events 2 and 4 (beyond the right edge: edge bin)
    expect(med[2]).toBe(7); // event 3
    const mean = binStat(dx, dy, w, idx, 2, 2, 'mean', false, false);
    expect(mean[0]).toBe(2);
    expect(Number.isNaN(binStat(dx, dy, w, idx, 4, 4, 'median', false, false)[5])).toBe(true);
  });
  it('spaces log levels between a floor and the maximum', () => {
    const t = logThresholds(Float32Array.from([0, 0.01, 1, 100]), 4, 0.1);
    expect(t.length).toBe(4);
    expect(t[0]).toBeCloseTo(0.1);
    expect(t[2]).toBeCloseTo(Math.sqrt(10));
    expect(t[3]).toBeLessThan(100);
  });
  it('samples a grid bilinearly at cell centers', () => {
    const z = Float32Array.from([0, 1, 2, 3]);
    expect(sampleGrid(z, 2, 2, 0.25, 0.25)).toBeCloseTo(0);
    expect(sampleGrid(z, 2, 2, 0.5, 0.5)).toBeCloseTo(1.5);
  });
});

describe('defaults and presets', () => {
  it('never smooth new plots', () => {
    const o = defaultPlotOptions();
    expect(o.histSmooth).toBe(0);
    expect(o.densitySmooth).toBe(0);
  });
  const plot = (): PlotItem => ({
    id: 'p',
    kind: 'plot',
    plotType: 'pseudo',
    xParam: 'FSC-A',
    yParam: 'SSC-A',
    layers: [{ id: 'l', sample: 'active', population: 'pop1' }],
    options: { ...defaultPlotOptions(), xScale: { type: 'linear', min: 0, max: 10 }, histSmooth: 2, densitySmooth: 0.5, labelOff: { g: [0.1, 0.1] } },
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  });
  it('change only the appearance', () => {
    const it = plot();
    applyPreset(it, presetById('dark')!);
    expect(it.options.bg).toBe('dark');
    expect(it.options.colormap).toBe('turbo');
    expect(it.xParam).toBe('FSC-A');
    expect(it.layers[0].population).toBe('pop1');
    expect(it.options.xScale).toEqual({ type: 'linear', min: 0, max: 10 });
    expect(it.options.histSmooth).toBe(2);
    expect(it.options.densitySmooth).toBe(0.5);
    expect(it.options.labelOff).toEqual({ g: [0.1, 0.1] });
    expect(it.options.lineWidth).toBe(1);
    // acceptance round 3: a preset never changes the plot type (Dark on zebra / contour plots kept them)
    applyPreset(it, presetById('zebra')!);
    expect(it.plotType).toBe('pseudo');
    expect(it.options.bg).toBe('white');
    for (const t of ['zebra', 'contour', 'density', 'dot', 'pseudo'] as const) {
      const z = { ...plot(), plotType: t };
      for (const p of PRESETS) {
        applyPreset(z, p);
        expect(z.plotType).toBe(t);
      }
    }
  });
  it('keep histograms and third-parameter plots in their plot type', () => {
    const h = { ...plot(), plotType: 'histogram' as const };
    applyPreset(h, presetById('zebra')!);
    expect(h.plotType).toBe('histogram');
    const d = plot();
    d.plotType = 'dot';
    d.options.colorMode = 'param';
    applyPreset(d, presetById('contour')!);
    expect(d.plotType).toBe('dot');
    expect(d.options.colorMode).toBe('param');
    for (const p of PRESETS) expect(p.label).not.toMatch(/\u2014/);
  });
  it('copy appearance between plots', () => {
    const a = plot();
    const b = plot();
    applyPreset(a, presetById('print')!);
    copyAppearance(b.options, a.options);
    expect(b.options.colormap).toBe('gray');
    expect(b.options.densitySmooth).toBe(0.5);
  });
});

describe('worksheet background', () => {
  it('reads the legacy grid flag', () => {
    const s = newWorksheet('S');
    expect(sheetGridStyle(s)).toBe('lines');
    const old = { ...s, gridStyle: undefined, showGrid: false } as Worksheet;
    expect(sheetGridStyle(old)).toBe('none');
    setGridStyle(s, 'dots');
    expect(s.showGrid).toBe(true);
    setGridStyle(s, 'none');
    expect(s.showGrid).toBe(false);
  });
  it('exports the page color, and the grid only on request', () => {
    const s = newWorksheet('S');
    s.pageColor = '#fbf8f1';
    const b = { x: 0, y: 0, w: 100, h: 60 };
    const p1 = new SvgPainter();
    renderPageBackground(p1, s, b, false);
    expect(p1.toString()).toContain('fill="#fbf8f1"');
    expect(p1.toString()).not.toContain('<line');
    s.exportGrid = true;
    const p2 = new SvgPainter();
    renderPageBackground(p2, s, b, true);
    expect(p2.toString()).not.toContain('#fbf8f1');
    expect(p2.toString()).toContain('<line');
    s.exportPage = false;
    setGridStyle(s, 'dots');
    const p3 = new SvgPainter();
    renderPageBackground(p3, s, b, false);
    expect(p3.toString()).not.toContain('#fbf8f1');
    expect(p3.toString()).toContain('<ellipse');
  });
});
