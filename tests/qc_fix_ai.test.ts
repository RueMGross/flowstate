// Regression tests for the QC findings on the AI features: requests follow the privacy settings while a panel is open
// (1), no sample names on AI plot images (2), plate / group names hidden in Methods (3), FMO hints without the rest of
// the name (4), a stream cut mid-way is not a complete answer (5), no duplicate samples in AI groups (6), calibration
// lines in Methods (valid range, beads used, quality flags) (8). No network: fetch is faked, the mock hook answers.
import { vi } from 'vitest';
import { engine } from '../src/core/engine';
import type { PlotItem } from '../src/core/model';
import { renderPlot, resolveLayers } from '../src/render/plot';
import { prepareCheck } from '../src/ai/check';
import { nameHints, sampleHints } from '../src/ai/context';
import { experimentRequest, parseExperiment } from '../src/ai/experiment';
import { findPlot, prepareAiGate } from '../src/ai/gate';
import { markerRequest, markerRows } from '../src/ai/markers';
import { calibrationLine, workspaceSummary } from '../src/ai/methods';
import * as P from '../src/ai/provider';
import { aiRenderInput } from '../src/ai/render';
import { useAiSettings } from '../src/ai/settings';
import { parseStrategy, runStrategy, strategyRequest } from '../src/ai/strategy';
import { loadDemo } from '../src/state/demo';
import { newPlotItem, useStore } from '../src/state/store';
import { autoGateAt, autoSession, createPolygon, createRange, onAutoPreview, type PlotAxes } from '../src/ui/gateOps';
import { prepCurrent, sameInputs } from '../src/ui/ai/shared';
import type { MesfDef, SizeDef } from '../src/ui/calib/util';

const g = globalThis as Record<string, unknown>;
const st = () => useStore.getState();
const sid = () => st().ui.activeSampleId!;
const setAi = (p: Parameters<ReturnType<typeof useAiSettings.getState>['set']>[0]) => useAiSettings.getState().set(p);
const plot = (x: string, y?: string) => st().ws.worksheets[0].items.find((i) => i.kind === 'plot' && i.xParam === x && (!y || i.yParam === y)) as PlotItem;
const axesOf = (it: PlotItem): PlotAxes => ({ xScale: engine.scaleOf(st().ws, it.xParam), yScale: it.plotType === 'histogram' ? null : engine.scaleOf(st().ws, it.yParam) });

beforeEach(() => {
  g.__flowstateAiMock = () => '{}';
  setAi({ provider: 'auto', anonymize: true, allowImages: true });
});

// ------------------------------------------------------------------ 1

describe('1: requests follow "Hide sample and file names" / "Allow sending plot images"', () => {
  it('a prepared gate / check request records its settings and is stale once they change', async () => {
    loadDemo();
    const provider = (await P.getProvider())!;
    expect(provider.kind).toBe('mock');
    const fs = plot('FSC-A', 'SSC-A');
    const prep = await prepareAiGate(fs.id, 'lymphocytes', false);
    expect(prep.anonymized).toBe(true);
    expect(prep.withImages).toBe(false);
    expect(prep.prompt).not.toContain('Donor');
    // images allowed with this provider: a request built without them is not the current one
    expect(prepCurrent(prep, provider)).toBe(false);
    setAi({ allowImages: false });
    expect(prepCurrent(prep, provider)).toBe(true);
    setAi({ anonymize: false });
    expect(prepCurrent(prep, provider)).toBe(false);
    const again = await prepareAiGate(fs.id, 'lymphocytes', false);
    expect(again.anonymized).toBe(false);
    expect(again.prompt).toContain('Donor');
    expect(prepCurrent(again, provider)).toBe(true);

    const ws = st().ws;
    const chk = await prepareCheck(ws, ws.worksheets[0].id, sid(), false);
    expect([chk.anonymized, chk.withImages]).toEqual([false, false]);
    expect(prepCurrent(chk, provider)).toBe(true);
    setAi({ anonymize: true });
    expect(prepCurrent(chk, provider)).toBe(false);
    expect((await prepareCheck(ws, ws.worksheets[0].id, sid(), false)).prompt).not.toContain('Donor');
  });

  it('the inputs check rebuilds only when an input changed', () => {
    const ws = st().ws;
    expect(sameInputs(null, [ws])).toBe(false);
    expect(sameInputs([ws, true, false], [ws, true, false])).toBe(true);
    expect(sameInputs([ws, true, false], [ws, false, false])).toBe(false);
    expect(sameInputs([ws, true], [{ ...ws }, true])).toBe(false);
  });

  it('text requests read the setting when they are built', () => {
    loadDemo();
    const ws = st().ws;
    setAi({ anonymize: false });
    expect(strategyRequest(ws, sid(), '')).toContain('Donor A');
    expect(markerRequest(ws, markerRows(ws), '')).toContain('Donor A');
    expect(experimentRequest(ws).prompt).toContain('Donor A');
    setAi({ anonymize: true });
    expect(strategyRequest(ws, sid(), '')).not.toContain('Donor A');
    expect(markerRequest(ws, markerRows(ws), '')).not.toContain('Donor A');
    expect(experimentRequest(ws).prompt).not.toContain('Donor A');
  });

  it('a strategy run asks whether images may be sent at every step', async () => {
    loadDemo();
    g.__flowstateAiMock = () => '{"found": true, "peak": "P1", "confidence": 0.7, "rationale": "largest population"}';
    const parsed = parseStrategy(st().ws, {
      steps: [
        { name: 'Cells', parent: 'All events', plot: '2d', x: 'FSC-A', y: 'SSC-A', target: 'cells' },
        { name: 'Singlets', parent: 'Cells', plot: '2d', x: 'FSC-A', y: 'FSC-H', target: 'singlets' },
      ],
    });
    const off = onAutoPreview((r) => {
      const it = findPlot(r.itemId)!;
      const w = st().ws;
      const prim = resolveLayers(it, w, sid(), engine)[0];
      const s = autoSession(w, it, axesOf(it), prim.sampleId, prim.popId)!;
      const res = autoGateAt(s, axesOf(it), r.seed, r.alpha);
      if (!res) return 'none';
      const p = res.kind === '2d' ? createPolygon(it, res.raw, r.meta.extra) : createRange(it, res.min, res.max, undefined, r.meta.extra);
      setTimeout(() => r.onDone?.(p?.id ?? null), 0);
      return { ok() {}, cancel() {} };
    });
    let asked = 0;
    const seen: boolean[] = [];
    await runStrategy(parsed.steps, {
      provider: (await P.getProvider())!,
      images: () => (asked++, false),
      signal: new AbortController().signal,
      update: () => {},
      setHandle: () => {},
      setPrep: (p) => p && seen.push(p.anonymized),
      acceptAll: () => false,
    });
    off();
    expect(asked).toBe(2);
    expect(seen).toEqual([true, true]);
  });
});

// ------------------------------------------------------------------ 2

describe('2: AI plot images show no sample names while names are hidden', () => {
  const texts: string[] = [];
  const rec = new Proxy({ kind: 'svg' } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : k === 'text' ? (_x: number, _y: number, s: unknown) => texts.push(typeof s === 'string' ? s : JSON.stringify(s)) : () => undefined),
  });
  const stubCanvas = () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => ({ data: new Uint8ClampedArray(4) }) }) });
  const draw = (item: PlotItem) => {
    texts.length = 0;
    const { ws, item: it } = aiRenderInput(st().ws, item, { grid: false });
    renderPlot(rec as never, it, it.w, it.h, { ws, engine, activeSampleId: sid(), selectedPopId: null, rasterScale: 1, makeCanvas: stubCanvas, forExport: true } as never);
    return texts.join(' | ');
  };

  it('overlay with a legend statistic, typed layer labels and axis titles, automatic title', () => {
    loadDemo();
    const ws = st().ws;
    const [a, b, c] = ws.samples;
    const item = newPlotItem('histogram', 'FSC-A', 'FSC-A', 0, 0, 300, 300, 'root', b.id);
    item.layers.push({ ...item.layers[0], id: 'l2', sample: c.id });
    item.layers.push({ ...item.layers[0], id: 'l3', sample: a.id, label: `${a.name} baseline` });
    item.options.legendStat = 'median';
    item.options.legend = true;
    item.options.xLabel = `FSC of ${b.name}`;
    item.options.showTitle = true;
    item.options.titleMode = 'sample';
    const names = ws.samples.map((s) => s.name);
    const hidden = draw(item);
    expect(hidden).toMatch(/MFI/); // the legend is drawn
    expect(hidden).toContain('Sample 2');
    for (const n of names) expect(hidden).not.toContain(n);
    expect(hidden).not.toContain('Donor');
    expect(hidden).not.toContain('baseline');
    // 2D overlay of one population in several samples (legend names the samples)
    const dot = newPlotItem('dot', 'FSC-A', 'SSC-A', 0, 0, 300, 300, 'root', b.id);
    dot.layers.push({ ...dot.layers[0], id: 'l2', sample: c.id });
    dot.options.legendStat = 'count';
    const d2 = draw(dot);
    expect(d2).toMatch(/Sample [23]/);
    expect(d2).not.toContain('Donor');
    // shown names: the plot as on the sheet (the test sees names when they are there)
    setAi({ anonymize: false });
    expect(draw(item)).toContain(b.name);
  });
});

// ------------------------------------------------------------------ 3

describe('3: plate and group names in the Methods summary', () => {
  it('P1 / Group n while names are hidden, the names when shown', () => {
    loadDemo();
    st().update((w) => {
      w.samples.forEach((s, i) => {
        s.plate = 'Patient_Mueller 2026-10-01';
        s.well = `A${i + 1}`;
      });
      w.groups.push({ id: 'g1', name: 'Donor Schmidt', color: '#000', sampleIds: [w.samples[0].id] });
      const sh = w.worksheets[0];
      const stat = { id: 'c1', population: w.populations[0].id, stat: 'freqParent' };
      sh.items.push({ id: 'chartX', kind: 'chart', x: 0, y: 2000, w: 100, h: 100, stat, mode: 'samples', sampleSet: 'all', samples: [], style: 'bar', errorBars: 'none', showPoints: false, color: '#000', useGroupColors: false, fontSize: 8, lineWidth: 1, plate: { plate: 'Patient_Mueller 2026-10-01', colormap: 'viridis', values: true, decimals: 1, legend: true } } as never);
    });
    const ws = st().ws;
    const sum = workspaceSummary(ws, sid(), ws.worksheets[0].id);
    expect(sum).not.toMatch(/Mueller|Schmidt/);
    expect(sum).toContain('plate P1');
    expect(sum).toMatch(/Sample groups: Group 1 \(2 samples\); Group 2 \(2 samples\); Group 3 \(1 samples\)\./);
    setAi({ anonymize: false });
    const shown = workspaceSummary(st().ws, sid(), ws.worksheets[0].id);
    expect(shown).toContain('plate "Patient_Mueller 2026-10-01"');
    expect(shown).toContain('Donor Schmidt (1 samples)');
  });
});

// ------------------------------------------------------------------ 4

describe('4: FMO hints carry no other part of the name', () => {
  it('"fmo", and "fmo <marker>" only for a channel or marker of the panel', () => {
    const panel = new Set(['cd8', 'pe-a', 'pe']);
    expect(nameHints('FMO_CD8_P0123 rep2', panel)).toEqual(['fmo cd8']);
    expect(nameHints('FMO-CD8-P0123', panel)).toEqual(['fmo cd8']);
    expect(nameHints('FMO_P0123 rep2', panel)).toEqual(['fmo']);
    expect(nameHints('FMOX 12', panel)).toEqual([]);
    expect(nameHints('unstained_ctrl_PT4471', panel)).toEqual(['unstained', 'ctrl']);
    expect(nameHints('single_stain beads', panel)).toEqual(['single stain', 'beads']);
  });

  it('every request built from sample hints', () => {
    loadDemo();
    st().update((w) => {
      w.samples[0].name = 'FMO_CD8_P0123 rep2';
      w.samples[0].fileName = 'FMO_CD8_P0123 rep2.fcs';
      w.channelLabels['PE-A'] = 'CD8';
    });
    const ws = st().ws;
    const hints = sampleHints(ws);
    expect(hints).toContain('Sample 1 (fmo cd8)');
    const all = [hints, strategyRequest(ws, sid(), ''), markerRequest(ws, markerRows(ws), ''), workspaceSummary(ws, sid(), ws.worksheets[0].id), experimentRequest(ws).prompt].join('\n').toLowerCase();
    expect(all).not.toContain('p0123');
    expect(all).not.toContain('rep2');
    expect(experimentRequest(ws, { names: false }).prompt).toMatch(/\nS1 \| fmo \|/);
  });
});

// ------------------------------------------------------------------ 5

describe('5: a stream cut mid-way is not taken as a complete answer', () => {
  const lines = (events: object[], tail = '\n\n') => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}`).join('\n\n') + tail;
  const respond = (body: string) =>
    new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          // in two chunks, split inside an event
          const k = Math.floor(body.length / 2);
          c.enqueue(enc.encode(body.slice(0, k)));
          c.enqueue(enc.encode(body.slice(k)));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const start = { type: 'message_start', message: { model: 'claude-test' } };
  const delta = (t: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } });
  let next = '';

  beforeEach(() => {
    delete g.__flowstateAiMock;
    // a lab proxy on an unreachable host: every request is answered by the fake fetch below
    setAi({ provider: 'proxy', proxyUrl: 'https://proxy.invalid', proxyPass: 'x', model: '' });
    g.fetch = vi.fn(async (url: string) => {
      expect(url.startsWith('https://proxy.invalid/')).toBe(true);
      return respond(next);
    });
  });
  afterAll(() => setAi({ provider: 'off', proxyUrl: '', proxyPass: '' }));

  it('without message_stop or stop reason: incomplete (text kept), JSON callers get an error', async () => {
    const p = (await P.getProvider())!;
    expect(p.kind).toBe('proxy');
    next = lines([start, delta('{"steps": [{"name": "Cel'), delta('ls", "x": "FSC')]);
    const r = await p.complete({ prompt: 'x' });
    expect(r).toMatchObject({ incomplete: true, truncated: true, text: '{"steps": [{"name": "Cells", "x": "FSC' });
    await expect(P.completeJson(p, { prompt: 'x' })).rejects.toMatchObject({ code: 'incomplete' });
    expect(P.aiErrorMessage(new P.AiError('incomplete'))).toMatch(/cut off/);
    // cut before any text
    next = lines([start]);
    await expect(p.complete({ prompt: 'x' })).rejects.toMatchObject({ code: 'incomplete' });
  });

  it('complete streams: message_stop, a stop reason, a last line without its newline', async () => {
    const p = (await P.getProvider())!;
    next = lines([start, delta('{"a": '), delta('1}'), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]);
    expect(await P.completeJson(p, { prompt: 'x' })).toMatchObject({ value: { a: 1 }, result: { truncated: false } });
    next = lines([start, delta('OK'), { type: 'message_stop' }], '');
    const r = await p.complete({ prompt: 'x' });
    expect(r.incomplete).toBeFalsy();
    expect(r.text).toBe('OK');
    next = lines([start, delta('OK'), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }]);
    expect((await p.complete({ prompt: 'x' })).incomplete).toBeFalsy();
    next = lines([start, delta('{"a": 1'), { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }]);
    await expect(P.completeJson(p, { prompt: 'x' })).rejects.toMatchObject({ code: 'invalid_json' });
  });
});

// ------------------------------------------------------------------ 6

describe('6: AI auto-analysis groups list each sample once', () => {
  it('repeats within a group (any case / spacing) and across groups are dropped', () => {
    loadDemo();
    const ws = st().ws;
    const [a, b, c] = ws.samples.map((s) => s.id);
    const req = { refs: ['S1', 'S2', 'S3'], ids: [a, b, c] };
    const r = parseExperiment(ws, req, {
      groups: [
        { name: 'ctrl', role: 'unstained', samples: ['S1', 's1 ', 'S1', 'S2', 'S2'] },
        { name: 'again', role: 'sample', samples: ['S1', 'S2'] },
        { name: 'rest', role: 'sample', samples: ['S3', 'S3'] },
      ],
    });
    expect(r.groups.map((x) => [x.name, x.sampleIds])).toEqual([
      ['ctrl', [a, b]],
      ['rest', [c]],
    ]);
  });
});

// ------------------------------------------------------------------ 8

describe('8: calibration lines in the Methods summary', () => {
  const setup = { wavelengthNm: 405, nMedium: 1.343, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 40 } };
  const ri = { material: 'polystyrene' } as never;
  const bead = (diameterNm: number, x: Partial<{ use: boolean; measured: number; saturated: boolean; fit: boolean }> = {}) => ({ label: `PS ${diameterNm}`, diameterNm, ri, use: true, assign: null, measured: 1000, ...x });
  const size = (fit: Partial<NonNullable<SizeDef['fit']>> = {}): SizeDef => ({
    id: 'sz',
    kind: 'size',
    name: 'SSC size',
    channel: 'SSC-A',
    outputs: [{ name: 'Diameter', range: 1000, unit: 'nm' }],
    nm2PerAu: 0.01,
    setup,
    model: { kind: 'sphere', ri: 1.4, name: 'EV (RI 1.40)' },
    rangeNm: [50, 1000],
    fit: {
      method: 'cv',
      halfAngleDeg: 40,
      r2Log: 0.99,
      cvPct: 4,
      beads: [100, 200, 400, 600, 800].map((d) => ({ name: `PS ${d}`, diameterNm: d, measured: d === 200 || d === 400 ? NaN : 1000, residualPct: 1 })),
      setups: [{ kitName: 'nanoViS', lot: 'L7', valuesSource: 'user', beads: [bead(100), bead(200, { use: false, measured: NaN }), bead(400, { measured: NaN, saturated: true }), bead(600, { fit: false }), bead(800)] }],
      validRangeNm: [62.5, 455],
      validSigmaNm2: [0.52, 310],
      ...fit,
    },
  });

  it('size: the valid range of the curve (not the requested limits), only beads used in the fit, flags', () => {
    const line = calibrationLine(size());
    expect(line).toContain('valid sizing range 62.5 to 455 nm (σ 0.52 to 310 nm²)');
    expect(line).not.toContain('1000 nm');
    expect(line).toContain('beads used in the fit (nanoViS lot L7): 100 nm, 800 nm');
    for (const d of [200, 400, 600]) expect(line).not.toContain(`${d} nm`);
    expect(line).not.toContain('WARNING');
    const poor = calibrationLine(size({ poorFit: { cvPct: 18.24, maxResidualPct: 31, confirmed: true }, setups: [{ ...size().fit!.setups![0], valuesSource: 'kit-example' }] }));
    expect(poor).toContain('WARNING: poor bead fit (CV of ratios 18.2%, largest residual 31%)');
    expect(poor).toContain('EXAMPLE values');
    // an older calibration without stored setups: the beads with a measured median (check-only ones are not marked there)
    const old = calibrationLine(size({ setups: undefined }));
    expect(old).toContain('beads used in the fit: 100 nm, 600 nm, 800 nm');
    expect(old).not.toMatch(/\b[24]00 nm/);
  });

  it('size without a stored valid range: computed from the same curve as the engine, within the requested limits', () => {
    const line = calibrationLine(size({ validRangeNm: undefined, validSigmaNm2: undefined }));
    const m = /valid sizing range ([\d.]+) to ([\d.]+) nm/.exec(line);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(50);
    expect(Number(m![2])).toBeLessThanOrEqual(1000);
  });

  it('MESF: beads used in the fit and the reference value source', () => {
    const mesf = (valuesSource?: string): MesfDef =>
      ({
        id: 'm1',
        kind: 'mesf',
        name: 'FITC MESF',
        channel: 'FITC-A',
        unit: 'MESF',
        outputs: [{ name: 'FITC MESF', range: 1e6 }],
        fit: { method: 'log', slope: 1, intercept: 0.5, r2: 0.9991 },
        beads: { kit: 'Quantum FITC-5', lot: 'Q1', medians: [10, 100, 1000, 5000, 20000], refs: [0, 100, 1000, null, 10000], excluded: [2], valuesSource },
      }) as MesfDef;
    expect(calibrationLine(mesf('user'))).toBe('Fluorescence calibration: FITC-A in MESF units, log fit (R² = 0.9991), beads Quantum FITC-5 lot Q1, 2 bead populations used in the fit.');
    expect(calibrationLine(mesf('kit-example'))).toContain('WARNING: reference values: EXAMPLE values of another lot');
    expect(calibrationLine(mesf('mixed'))).toContain('WARNING: reference values: partly preset kit values');
    // the calibrated range, when the calibration records it; a saturated bead kept in the fit is flagged
    const withRange = { ...mesf('user'), calibratedRange: { mfi: [100, 20000], mesf: [100, 10000] } } as MesfDef;
    withRange.beads = { ...withRange.beads!, saturated: [4, 2] };
    expect(calibrationLine(withRange)).toBe(
      'Fluorescence calibration: FITC-A in MESF units, log fit (R² = 0.9991), beads Quantum FITC-5 lot Q1, 2 bead populations used in the fit; calibrated range 100 to 20000 MFI = 100 to 10000 MESF (values outside it are extrapolated); WARNING: 1 bead population compressed by detector saturation kept in the fit.',
    );
    loadDemo();
    st().update((w) => {
      w.derived = [...(w.derived ?? []), mesf('kit-example') as never];
    });
    expect(workspaceSummary(st().ws, sid(), st().ws.worksheets[0].id)).toContain('2 bead populations used in the fit; WARNING');
  });
});
