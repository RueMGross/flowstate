// AI assistant (FlowState Assist) with a mock provider: JSON parsing, AI gate seed -> deterministic auto gate on the demo
// data (provenance, one undo step), seed validation / snapping, error codes, strategy runner, marker table, methods
// summary and anonymization. No network: the mock hook answers.
import { SENSITIVITY } from '../src/core/autogate';
import { engine } from '../src/core/engine';
import type { PlotItem } from '../src/core/model';
import { resolveLayers } from '../src/render/plot';
import { askAiGate, findPlot, prepareAiGate } from '../src/ai/gate';
import { squashSince } from '../src/ai/history';
import { applyMarkers, markerRequest, markerRows, mergeMarkers } from '../src/ai/markers';
import { workspaceSummary } from '../src/ai/methods';
import { legendPrompt, methodsPrompt } from '../src/ai/prompts';
import { AiError, aiErrorMessage, getProvider, parseJsonTolerant, type MockFn } from '../src/ai/provider';
import { chooseSeed1D, chooseSeed2D, peaks1D, peaks2D } from '../src/ai/seed';
import { useAiSettings } from '../src/ai/settings';
import { parseStrategy, resolveChannel, runStrategy, type StrategyStep } from '../src/ai/strategy';
import { loadDemo } from '../src/state/demo';
import { useStore } from '../src/state/store';
import { autoGateAt, autoSession, createPolygon, createRange, onAutoPreview, type PlotAxes } from '../src/ui/gateOps';

const g = globalThis as { __flowstateAiMock?: MockFn };
let answer: MockFn = () => '{}';
g.__flowstateAiMock = (r) => answer(r);

const st = () => useStore.getState();
const sid = () => st().ui.activeSampleId!;
const plot = (x: string, y?: string) => st().ws.worksheets[0].items.find((i) => i.kind === 'plot' && i.xParam === x && (!y || i.yParam === y)) as PlotItem;
const pop = (name: string) => st().ws.populations.find((p) => p.name === name)!;
const axesOf = (it: PlotItem): PlotAxes => ({ xScale: engine.scaleOf(st().ws, it.xParam), yScale: it.plotType === 'histogram' ? null : engine.scaleOf(st().ws, it.yParam) });
const center = (it: PlotItem, popId: string): [number, number] => {
  const ws = st().ws;
  const idx = engine.population(ws, sid(), popId);
  const med = (ch: string) => {
    const d = engine.display(ws, sid(), ch, engine.scaleOf(ws, ch))!;
    const v = Array.from(idx, (e) => d[e]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  return [med(it.xParam), it.plotType === 'histogram' ? 0 : med(it.yParam)];
};
const overlap = (a: string, b: string) => {
  const B = new Set(engine.population(st().ws, sid(), b));
  let n = 0;
  for (const e of engine.population(st().ws, sid(), a)) if (B.has(e)) n++;
  return n;
};
const signal = () => new AbortController().signal;

describe('JSON answers', () => {
  it('whole text, fenced block, or the first { to the last }', () => {
    expect(parseJsonTolerant('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonTolerant('Sure:\n```json\n{"a": [1, 2]}\n```\nDone.')).toEqual({ a: [1, 2] });
    expect(parseJsonTolerant('Here it is: {"found": false, "rationale": "x"} hope it helps')).toEqual({ found: false, rationale: 'x' });
    expect(() => parseJsonTolerant('no json here')).toThrow(AiError);
    try {
      parseJsonTolerant('nope');
    } catch (e) {
      expect((e as AiError).code).toBe('invalid_json');
      expect((e as AiError).text).toBe('nope');
    }
  });
});

describe('AI assistant on the demo workspace (mock provider)', () => {
  loadDemo();
  useAiSettings.getState().set({ provider: 'auto', anonymize: true });

  it('is off by default and resolves the mock only when switched on', async () => {
    useAiSettings.getState().set({ provider: 'off' });
    expect(await getProvider()).toBeNull();
    useAiSettings.getState().set({ provider: 'auto' });
    expect((await getProvider())?.kind).toBe('mock');
  });

  it('AI gate: the seed goes to the auto gate; lymphocytes on FSC / SSC, with provenance, one undo step', async () => {
    const fs = plot('FSC-A', 'SSC-A');
    const [lu, lv] = center(fs, pop('Lymphocytes').id);
    let seen = '';
    answer = (r) => {
      seen = r.prompt;
      return `\`\`\`json\n{"found": true, "name": "Lymphocytes", "x": ${lu.toFixed(3)}, "y": ${lv.toFixed(3)}, "confidence": 0.85, "rationale": "Dense cluster at low SSC."}\n\`\`\``;
    };
    const prep = await prepareAiGate(fs.id, 'lymphocytes', false);
    expect(prep.image).toBeNull();
    expect(prep.hist).toBe(false);
    // without images: no grid note, the plot is described in text (axes, peaks)
    expect(prep.prompt).toContain('Using the description of the plot below');
    expect(prep.prompt).not.toContain('coordinate grid');
    expect(prep.prompt).toContain('X axis: FSC-A, Linear');
    expect(prep.prompt).toContain('"lymphocytes"');
    expect(prep.prompt).toMatch(/P1: peak at \(0\.\d\d, 0\.\d\d\)/);
    expect(prep.prompt).toContain(`Sample ${st().ws.samples.findIndex((x) => x.id === sid()) + 1}`); // names hidden
    expect(prep.prompt).not.toContain('Donor');
    const provider = (await getProvider())!;
    const out = await askAiGate(prep, provider, signal());
    expect(seen).toBe(prep.prompt);
    expect(out.name).toBe('Lymphocytes');
    expect(out.model).toBe('mock-model');
    if (!out.choice.seed) throw new Error(out.choice.note);
    expect(out.choice.snapped).toBe(false);
    // what the plot's preview computes and OK creates
    const res = autoGateAt(prep.session, axesOf(fs), out.choice.seed, SENSITIVITY.normal)!;
    expect(res.kind).toBe('2d');
    const before = st().past.length;
    const p = createPolygon(fs, res.kind === '2d' ? res.raw : [], { name: out.name, provenance: { method: 'ai-autogate', model: out.model, date: '2026-10-11T00:00:00Z', target: prep.target, seed: out.choice.frame } })!;
    expect(st().past.length).toBe(before + 1);
    expect(p.name).toBe('Lymphocytes'); // the hand-made one is under Live, not a sibling
    expect(p.provenance?.method).toBe('ai-autogate');
    expect(engine.count(st().ws, sid(), p.id)).toBe(res.count);
    const ref = engine.count(st().ws, sid(), pop('Lymphocytes').id);
    expect(overlap(pop('Lymphocytes').id, p.id) / ref).toBeGreaterThan(0.9);
    st().undo();
    expect(st().ws.populations.some((q) => q.id === p.id)).toBe(false);
  });

  it('seed validation: off-data points snap to the nearest peak or are not found; a box picks its peak', () => {
    const fs = plot('PC7-A', 'PE-A');
    const s = autoSession(st().ws, fs, axesOf(fs), sid(), fs.layers[0].population)!;
    if (s.kind !== '2d') throw new Error('2d');
    const peaks = peaks2D(s.map);
    expect(peaks.length).toBeGreaterThanOrEqual(3);
    expect(peaks[0].share).toBeGreaterThan(peaks[peaks.length - 1].share);
    expect(chooseSeed2D(s.map, { found: false }).seed).toBeNull();
    expect(chooseSeed2D(s.map, { found: true }).seed).toBeNull();
    // on a peak: as is
    const p1 = peaks[0];
    const on = chooseSeed2D(s.map, { found: true, x: p1.x, y: p1.y });
    expect(on.seed && !on.snapped).toBe(true);
    // a little off the data, near a peak: snapped onto it
    const far = chooseSeed2D(s.map, { found: true, x: 0.99, y: 0.99 });
    expect(far.seed).toBeNull();
    expect(far.note).toMatch(/no events near/);
    // just outside a population, in empty space: moved onto that population's peak
    const off = chooseSeed2D(s.map, { found: true, x: Math.min(1, peaks[0].box[2] + 0.05), y: peaks[0].y });
    expect(off.seed && off.snapped).toBe(true);
    if (off.seed && 'v' in off.seed) expect([Math.round(off.seed.u * 100) / 100, Math.round(off.seed.v * 100) / 100]).toEqual([peaks[0].x, peaks[0].y]);
    // a point on one population with a box around another: the peak in the box
    const target = peaks[1];
    const b = chooseSeed2D(s.map, { found: true, x: peaks[0].x, y: peaks[0].y, bbox: target.box });
    expect(b.seed && 'v' in b.seed ? [b.seed.u, b.seed.v] : b.seed).toEqual([target.x, target.y]);
    // a box much smaller than the population it finds: the box itself is the seed (gate limited to it)
    const small = chooseSeed2D(s.map, { found: true, x: target.x, y: target.y, bbox: [target.x - 0.02, target.y! - 0.02, target.x + 0.02, target.y! + 0.02] });
    expect(small.seed && 'rect' in small.seed).toBe(true);
    // peak id only
    const byId = chooseSeed2D(s.map, { found: true, peak: target.id });
    expect(byId.seed && 'u' in byId.seed ? byId.seed.u : -1).toBe(target.x);
    // a named peak wins over a (mis-read) position on another population
    const both = chooseSeed2D(s.map, { found: true, peak: target.id, x: peaks[0].x, y: peaks[0].y });
    expect(both.seed && 'v' in both.seed ? [both.seed.u, both.seed.v] : null).toEqual([target.x, target.y]);
    // an unknown peak id falls back to the position
    expect(chooseSeed2D(s.map, { found: true, peak: 'P99', x: peaks[0].x, y: peaks[0].y }).seed).toEqual({ u: peaks[0].x, v: peaks[0].y });
  });

  it('histogram: a range seed; CD69+ from the AI range', () => {
    const ch = st().ws.worksheets[0].items.filter((i) => i.kind === 'plot' && i.xParam === 'APC-A')[1] as PlotItem;
    const s = autoSession(st().ws, ch, axesOf(ch), sid(), ch.layers[0].population)!;
    if (s.kind !== '1d') throw new Error('1d');
    expect(peaks1D(s.map).length).toBeGreaterThanOrEqual(2);
    const c = chooseSeed1D(s.map, { found: true, range: [0.62, 0.95] });
    if (!c.seed) throw new Error(c.note);
    const r = autoGateAt(s, axesOf(ch), c.seed, SENSITIVITY.normal)!;
    if (r.kind !== '1d') throw new Error('1d');
    const g1 = createRange(ch, r.min, r.max, undefined, { name: 'CD69+ (AI)' });
    const ref = engine.count(st().ws, sid(), pop('CD69+').id);
    expect(overlap(pop('CD69+').id, g1.id) / ref).toBeGreaterThan(0.85);
    expect(g1.name).toBe('CD69+ (AI)');
    st().undo();
    expect(chooseSeed1D(s.map, { found: true, range: [0.98, 1] }).seed).toBeNull();
  });

  it('errors: rate limit, not granted, invalid JSON, cancel', async () => {
    const fs = plot('FSC-A', 'SSC-A');
    const prep = await prepareAiGate(fs.id, 'singlets', false);
    const provider = (await getProvider())!;
    const fail = async (code: string) => {
      answer = () => ({ error: code });
      try {
        await askAiGate(prep, provider, signal());
      } catch (e) {
        return e as AiError;
      }
      throw new Error('no error');
    };
    expect((await fail('rate_limited')).code).toBe('rate_limited');
    expect(aiErrorMessage(await fail('rate_limited'))).toMatch(/429/);
    expect(aiErrorMessage(await fail('not_granted'))).toMatch(/not allowed/);
    answer = () => 'I cannot see a plot.';
    await expect(askAiGate(prep, provider, signal())).rejects.toMatchObject({ code: 'invalid_json' });
    answer = () => '{"found": true, "x": 0.5, "y": 0.5}';
    const ctl = new AbortController();
    const p = askAiGate(prep, provider, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(aiErrorMessage(new AiError('no_plot', 'Select a plot first.'))).toBe('Select a plot first.');
  });

  it('strategy: parse (marker labels, unknown channels) and run on a new sheet as one undo step', async () => {
    const ws = st().ws;
    expect(resolveChannel(ws, 'CD3')).toBe('FITC-A');
    expect(resolveChannel(ws, 'fsc-a')).toBe('FSC-A');
    expect(resolveChannel(ws, 'BV421-A')).toBeNull();
    const parsed = parseStrategy(ws, {
      steps: [
        { name: 'Cells', parent: 'All events', plot: '2d', x: 'FSC-A', y: 'SSC-A', target: 'cells' },
        { name: 'Singlets', parent: 'Cells', plot: '2d', x: 'FSC-A', y: 'FSC-H', target: 'singlets on the diagonal' },
        { name: 'Live', parent: 'Singlets', plot: 'histogram', x: 'Viability', target: 'viability dye negative' },
        { name: 'B cells', parent: 'Live', plot: '2d', x: 'CD19', y: 'BV421-A', target: 'B cells' },
        { name: 'Orphan', parent: 'Nowhere', plot: '2d', x: 'FSC-A', y: 'SSC-A', target: 'x' },
      ],
      notes: 'demo',
    });
    expect(parsed.steps.map((s) => [s.name, s.on, s.plot, s.x, s.y])).toEqual([
      ['Cells', true, '2d', 'FSC-A', 'SSC-A'],
      ['Singlets', true, '2d', 'FSC-A', 'FSC-H'],
      ['Live', true, 'histogram', 'KO525-A', 'KO525-A'],
      ['B cells', false, '2d', 'PB450-A', ''],
      ['Orphan', true, '2d', 'FSC-A', 'SSC-A'],
    ]);
    expect(parsed.steps[3].note).toMatch(/BV421-A/);
    // the mock points at the largest peak; a stand-in for the plot view accepts every preview
    answer = () => '{"found": true, "peak": "P1", "confidence": 0.7, "rationale": "largest population"}';
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
    const before = st().ws;
    const pastLen = st().past.length;
    const log: Record<string, Partial<StrategyStep>> = {};
    const n = await runStrategy(parsed.steps, {
      provider: (await getProvider())!,
      images: false,
      signal: signal(),
      update: (id, p) => (log[id] = { ...log[id], ...p }),
      setHandle: () => {},
      setPrep: () => {},
      acceptAll: () => false,
    });
    off();
    expect(n).toBe(3);
    const after = st().ws;
    const sheet = after.worksheets.find((w) => w.name === 'AI gating')!;
    expect(sheet.items.length).toBe(3); // Cells, Singlets, Live; B cells is off, Orphan has no parent
    const made = after.populations.filter((p) => p.provenance);
    expect(made.map((p) => p.name)).toEqual(['Cells 2', 'Singlets', 'Live']); // unique among siblings
    const cells = made[0];
    expect(made[1].parentId).toBe(cells.id);
    expect(made[2].parentId).toBe(made[1].id);
    expect(made[2].gate.type).toBe('range');
    expect(made.every((p) => p.provenance!.target && p.provenance!.model === 'mock-model')).toBe(true);
    expect(log[parsed.steps[4].id].status).toBe('skipped');
    // one undo step for the whole run
    expect(st().past.length).toBe(pastLen + 1);
    st().undo();
    expect(st().ws).toBe(before);
  });

  it('marker assistant: table from $PnS, suggestions merged, accepted labels written in one undo step', async () => {
    const rows = markerRows(st().ws);
    expect(rows.map((r) => r.channel)).toContain('FITC-A');
    expect(rows.some((r) => /FSC|SSC|Time/.test(r.channel))).toBe(false);
    expect(rows.find((r) => r.channel === 'FITC-A')!.current).toBe('CD3');
    const prompt = markerRequest(st().ws, rows, 'CD3 FITC, CD8 PE, Live/Dead KO525');
    expect(prompt).toContain('FITC-A | CD3 | CD3');
    expect(prompt).toContain('Live/Dead KO525');
    const merged = mergeMarkers(rows, parseJsonTolerant('{"labels": [{"channel": "fitc-a", "marker": "CD3"}, {"channel": "KO525-A", "marker": "Live/Dead", "note": "from panel"}]}'));
    expect(merged.find((r) => r.channel === 'FITC-A')!.accept).toBe(false); // unchanged
    expect(merged.find((r) => r.channel === 'KO525-A')!.accept).toBe(true);
    expect(merged.find((r) => r.channel === 'APC-A')!.note).toBe('no suggestion');
    const n0 = st().past.length;
    const was = st().ws.channelLabels['KO525-A'];
    expect(applyMarkers(merged)).toBe(1);
    expect(st().ws.channelLabels['KO525-A']).toBe('Live/Dead');
    expect(st().past.length).toBe(n0 + 1);
    st().undo();
    expect(st().ws.channelLabels['KO525-A']).toBe(was);
  });

  it('methods summary: instrument, compensation, hierarchy with counts, panels; names hidden or shown', () => {
    const ws = st().ws;
    const sum = workspaceSummary(ws, sid(), ws.worksheets[0].id);
    expect(sum).toMatch(/^Software: FlowState \d/);
    expect(sum).toContain('Compensation:');
    expect(sum).toMatch(/- Cells \[polygon on FSC-A vs SSC-A\]: [\d,]+ events \(\d+\.\d% of parent\)/);
    expect(sum).toMatch(/\nWorksheet \(figure panels/); // sheet names are free text: hidden with the sample names
    expect(sum).toMatch(/\nA: pseudocolor plot of FSC-A \(x\) vs SSC-A \(y\)/);
    expect(sum).not.toContain('Donor A'); // also not from the plot title "Donor A: CD4+ T cells"
    expect(sum).toContain('Plot titles and text boxes are left out');
    expect(sum).toContain('Sample 1 (unstained)');
    useAiSettings.getState().set({ anonymize: false });
    const shown = workspaceSummary(ws, sid(), ws.worksheets[0].id);
    expect(shown).toContain('Donor A unstim');
    expect(shown).toMatch(/Worksheet ".+" \(figure panels/);
    useAiSettings.getState().set({ anonymize: true });
    expect(methodsPrompt(sum)).toContain('[to fill]');
    expect(legendPrompt(sum)).toContain(sum);
  });

  it('squashSince merges several steps into one', () => {
    const before = st().ws;
    st().update((w) => {
      w.name = 'a';
    });
    st().update((w) => {
      w.name = 'b';
    });
    expect(squashSince(before)).toBe(true);
    st().undo();
    expect(st().ws).toBe(before);
  });
});
