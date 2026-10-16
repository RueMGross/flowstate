// Damaged workspaces (files, bundles, templates, the autosaved session, the clipboard) are validated and repaired:
// opening one never blanks the app or hangs it. Ported from the QC fuzz (wsfuzz corpus, ws_repro.py, qc_cross_paste,
// parent cycles, keyItemId, chart height) and kept fast.
import { engine } from '../src/core/engine';
import { parseFcs, writeFcs } from '../src/core/fcs';
import {
  clampItemGeometry,
  gateProblem,
  isAncestorPop,
  ITEM_MAX_SIZE,
  MM,
  popDescendants,
  popPath,
  type ChartItem,
  type PlotItem,
  type Population,
  type StatsBoxItem,
  type TextItem,
  type Workspace,
} from '../src/core/model';
import { RepairNotes, refContextOf, repairItem } from '../src/core/repair';
import { computeTicks, MAX_TICK_TARGET, scaleDefProblem } from '../src/core/transforms';
import { parseWorkspace, serializeWorkspace, templateWorkspace, workspaceRepairNotes, newBlankWorkspace, openWorkspace } from '../src/io/files';
import { renderChart } from '../src/render/chart';
import { renderStatsBox, renderText, statsRows } from '../src/render/items';
import { SvgPainter } from '../src/render/painter';
import { renderPlot, type RenderEnv } from '../src/render/plot';
import { loadDemo } from '../src/state/demo';
import { upsertDerived } from '../src/state/derivedOps';
import { addDataset, addPopulation, addSheet, deletePopulation, newChartItem, newPlotItem, useStore } from '../src/state/store';
import { setPopScope } from '../src/state/scopeOps';
import { copyGates, pasteGates } from '../src/ui/gateOps';
import { addItems, addStatsBelow, copyItems, parseClip, pasteItems } from '../src/ui/layoutOps';
import { ancestorOptions } from '../src/ui/TablesView';

const st = () => useStore.getState();

/** Store consistency: the invariants the QC fuzz checks (HARD ones; soft references to removed samples are allowed). */
export function consistency(ws: Workspace): string[] {
  const v: string[] = [];
  const pid = new Set(ws.populations.map((p) => p.id));
  const sid = new Set(ws.samples.map((s) => s.id));
  const cid = new Set(ws.compensations.map((c) => c.id));
  const popOk = (id: string) => id === 'root' || pid.has(id);
  if (!ws.worksheets.length) v.push('no worksheets');
  if (pid.size !== ws.populations.length) v.push('duplicate population id');
  const items = ws.worksheets.flatMap((w) => w.items);
  if (new Set(items.map((i) => i.id)).size !== items.length) v.push('duplicate item id');
  const byId = new Map(ws.populations.map((p) => [p.id, p]));
  for (const p of ws.populations) {
    if (p.parentId && !pid.has(p.parentId)) v.push(`parent missing (${p.name})`);
    let cur = p.parentId;
    let n = 0;
    while (cur && n < 1000) {
      cur = byId.get(cur)?.parentId ?? null;
      n++;
    }
    if (n >= 1000) v.push(`parent cycle (${p.name})`);
    const gp = gateProblem(p.gate);
    if (gp) v.push(`gate ${p.name}: ${gp}`);
    if (p.gate?.type === 'bool') for (const o of p.gate.operands) if (!pid.has(o.replace(/^!/, ''))) v.push(`bool operand missing (${p.name})`);
    if (typeof p.name !== 'string') v.push('population without name');
  }
  for (const s of ws.samples) {
    if (s.compId && !cid.has(s.compId)) v.push('sample comp missing');
    if (!Array.isArray(s.channels) || s.channels.some((c) => !c || typeof c.name !== 'string')) v.push('sample channels');
  }
  for (const [ch, sc] of Object.entries(ws.scales)) if (scaleDefProblem(sc)) v.push(`scale ${ch}: ${scaleDefProblem(sc)}`);
  for (const t of ws.tables) for (const c of t.columns) if (!popOk(c.population)) v.push('table column population missing');
  for (const sh of ws.worksheets) if (![sh.page.w, sh.page.h, sh.grid].every((x) => Number.isFinite(x) && x > 0)) v.push('sheet page');
  for (const it of items) {
    if (![it.x, it.y, it.w, it.h].every(Number.isFinite) || !(it.w > 0 && it.h > 0) || it.h > ITEM_MAX_SIZE) v.push(`item geometry ${it.kind}`);
    if (!['plot', 'text', 'stats', 'chart'].includes(it.kind)) v.push(`item kind ${it.kind}`);
    if (it.kind === 'plot') {
      if (!Array.isArray(it.layers) || !it.layers.length) v.push('plot without layers');
      else for (const l of it.layers) if (!popOk(l.population) || (l.sample !== 'active' && !sid.has(l.sample))) v.push('layer reference missing');
      if (!it.options || typeof it.options !== 'object') v.push('plot without options');
    }
    if (it.kind === 'stats') for (const r of it.rows) if (!popOk(r.population)) v.push('stats row population missing');
    if (it.kind === 'chart' && !popOk(it.stat.population)) v.push('chart population missing');
  }
  const nan: string[] = [];
  JSON.stringify(ws, (k, x) => (typeof x === 'number' && Number.isNaN(x) ? (nan.push(k), null) : x));
  if (nan.length) v.push('NaN at ' + nan.slice(0, 3).join(','));
  return [...new Set(v)];
}

/** A canvas stand-in for rendering plots in node (draws nothing). */
function fakeCanvas(w: number, h: number): HTMLCanvasElement {
  const props: Record<string, unknown> = {};
  const ctx = new Proxy(props, {
    get: (t, k: string) =>
      k in t
        ? t[k]
        : k === 'createImageData' || k === 'getImageData'
          ? (a: number, b: number, c?: number, d?: number) => {
              const W = Math.max(1, Math.round(c ?? a));
              const H = Math.max(1, Math.round(d ?? b));
              return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
            }
          : k === 'measureText'
            ? (s: string) => ({ width: s.length * 5 })
            : () => undefined,
    set: (t, k: string, v) => ((t[k] = v), true),
  });
  return { width: w, height: h, getContext: () => ctx, toDataURL: () => 'data:,' } as unknown as HTMLCanvasElement;
}

/** Everything the interface computes for a workspace: counts, statistics, tree paths, and every item drawn. */
function exercise(ws: Workspace) {
  const env: RenderEnv = { ws, engine, activeSampleId: ws.samples.find((s) => engine.has(s.id))?.id ?? null, rasterScale: 1, makeCanvas: fakeCanvas, forExport: true };
  for (const s of ws.samples)
    if (engine.has(s.id)) {
      for (const p of ws.populations) {
        const n = engine.count(ws, s.id, p.id);
        expect(Number.isInteger(n) && n >= 0).toBe(true);
      }
      for (const t of ws.tables) for (const c of t.columns) engine.stat(ws, s.id, c);
    }
  for (const p of ws.populations) {
    popPath(ws, p.id);
    popDescendants(ws, p.id);
    ancestorOptions(ws, p.id);
  }
  for (const sh of ws.worksheets)
    for (const it of sh.items) {
      const pt = new SvgPainter();
      if (it.kind === 'plot') renderPlot(pt, it as PlotItem, it.w, it.h, env);
      else if (it.kind === 'chart') renderChart(pt, it as ChartItem, env);
      else if (it.kind === 'stats') renderStatsBox(pt, it as StatsBoxItem, ws, engine, env.activeSampleId);
      else renderText(pt, it as TextItem, ws);
    }
}

/** The example, with a Boolean gate, a scoped gate, a MESF channel, a chart, a stats box and a second sheet. */
function richWorkspace(): Workspace {
  loadDemo();
  const ws = st().ws;
  const pops = ws.populations;
  addPopulation('Bool', pops[0].id, { type: 'bool', op: 'and', operands: [pops[1].id, '!' + pops[2].id] });
  setPopScope(pops[3].id, { groups: [ws.groups[0].id] }, { quiet: true });
  upsertDerived({ id: 'mesf_qc', kind: 'mesf', name: 'MESF FITC', channel: 'FITC-A', unit: 'MESF', fit: { method: 'log', slope: 1.02, intercept: 0.5, r2: 0.999 }, outputs: [{ name: 'FITC MESF', range: 1e6 }] });
  const sh = st().ws.worksheets[0];
  addItems(sh.id, [newChartItem(600, 500, 200, 150), newPlotItem('histogram', 'FITC MESF', 'FITC MESF', 820, 500, 200, 160, pops[4].id)]);
  addStatsBelow(sh.id, sh.items.find((i) => i.kind === 'plot')!.id);
  addSheet('Second');
  return st().ws;
}

describe('damaged workspace files are repaired, not crashed on', () => {
  let base: Record<string, unknown>;
  beforeAll(() => {
    base = JSON.parse(serializeWorkspace(richWorkspace()));
  });
  const edit = (f: (w: Record<string, any>) => void): Workspace => {
    const w = JSON.parse(JSON.stringify(base));
    f(w);
    return parseWorkspace(JSON.stringify(w));
  };
  const cases: [string, (w: Record<string, any>) => void, RegExp][] = [
    ['a population replaced by an array (ws_pop_array)', (w) => (w.populations[9] = []), /damaged gate/],
    ['a scale without type (ws_scale_no_type)', (w) => delete w.scales['FSC-H'].type, /axis settings of 1 channel/],
    ['a scale with impossible parameters (logicle A = -5)', (w) => (w.scales['FITC-A'] = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: -5 }), /axis settings/],
    ['a plot without layers (ws_plot_no_layers)', (w) => (w.worksheets[0].items.find((i: any) => i.kind === 'plot').layers = []), /worksheet item/],
    ['a plot without options (ws_plot_no_options)', (w) => delete w.worksheets[0].items.find((i: any) => i.kind === 'plot').options, /worksheet item/],
    ['plot layers not a list', (w) => (w.worksheets[0].items.find((i: any) => i.kind === 'plot').layers = { $n: 'NaN' }), /worksheet item/],
    ['an empty compensation row (ws_comp_row_empty)', (w) => (w.compensations[0] = { id: 'c1', name: 'x', channels: ['A', 'B'], matrix: [[1, 0], []], source: 'manual' }), /compensation matrix/],
    ['a channel set to null (ws_channel_null)', (w) => (w.samples[2].channels[5] = null), /channel lists/],
    ['a channel name that is not text', (w) => (w.samples[0].channels[3].name = [1, 2]), /channel lists/],
    ['two populations each other\'s parent', (w) => ((w.populations[4].parentId = w.populations[6].id), (w.populations[6].parentId = w.populations[4].id)), /parent cycle/],
    ['a population its own parent (ws_self_parent)', (w) => (w.populations[3].parentId = w.populations[3].id), /parent cycle/],
    ['a parent that does not exist', (w) => (w.populations[3].parentId = 'nope'), /parent or Boolean operands were missing/],
    [
      'a Boolean gate whose operand lies inside it (hung the counts: exponential re-evaluation)',
      (w) => {
        const b = w.populations.find((p: any) => p.gate.type === 'bool');
        w.populations[0].parentId = b.id;
        b.parentId = null;
      },
      /Boolean gate that depended on itself/,
    ],
    ['a duplicate population', (w) => w.populations.push(JSON.parse(JSON.stringify(w.populations[1]))), /damaged gate/],
    ['a gate bound that is NaN', (w) => (w.populations[2].gate.max = { $n: 'NaN' }), /damaged gate/],
    ['a gate type that does not exist', (w) => (w.populations[1].gate.type = 'root'), /damaged gate/],
    ['an item with an unknown kind', (w) => (w.worksheets[0].items[4].kind = 'banana'), /damaged worksheet item/],
    ['an item height of -1e300 / NaN position', (w) => ((w.worksheets[0].items[2].h = -1e300), (w.worksheets[0].items[3].x = { $n: 'NaN' })), /worksheet items? had missing or invalid/],
    ['density smoothing of 1e15 (RangeError: Invalid typed array length)', (w) => (w.worksheets[0].items[1].options.densitySmooth = 1e15), /worksheet item/],
    ['an unknown table population', (w) => (w.tables[0].columns[0].population = 'gone'), /statistic/],
    ['compensations not a list', (w) => (w.compensations = 'x'), /compensations of the workspace were damaged/],
    ['a damaged derived channel', (w) => (w.derived[0].outputs = '\u0000'), /computed channel/],
    ['a page width of -1e300', (w) => (w.worksheets[1].page.w = -1e300), /other damaged value/],
  ];
  for (const [name, f, note] of cases)
    it(name, () => {
      const ws = edit(f);
      expect(consistency(ws)).toEqual([]);
      expect(workspaceRepairNotes(ws).join('\n')).toMatch(note);
      exercise(ws);
    });

  it('unusable files are rejected with a clear message', () => {
    expect(() => parseWorkspace('{"app":"FlowState","samples":[')).toThrow(/not valid JSON .* cut off/);
    expect(() => parseWorkspace('{"app":"FlowState","samples":{}}')).toThrow(/Not a FlowState workspace file/);
    expect(() => parseWorkspace('[1,2]')).toThrow(/Not a FlowState workspace file/);
    expect(() => parseWorkspace('null')).toThrow(/Not a FlowState workspace file/);
  });

  it('an intact workspace passes unchanged, without notes or the saved time', () => {
    const text = JSON.stringify(base);
    const ws = parseWorkspace(text);
    expect(workspaceRepairNotes(ws)).toEqual([]);
    expect('savedAt' in ws).toBe(false);
    const again = JSON.parse(serializeWorkspace(ws));
    for (const o of [again, JSON.parse(text)]) delete o.savedAt;
    expect(JSON.stringify(again)).toBe(JSON.stringify({ ...JSON.parse(text), savedAt: undefined }));
    const t = templateWorkspace(ws);
    expect(consistency(parseWorkspace(serializeWorkspace(t)))).toEqual([]);
  });

  // ---- structure-aware random damage (the wsfuzz mutations), seeded
  function mulberry32(a: number) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const WEIRD = ['x', '', 0, -1, 1e308, -1e308, 1e-320, { $n: 'NaN' }, { $n: 'Infinity' }, { $n: '-Infinity' }, null, true, [], {}, [1, 2], 'root', 'active', 2 ** 53, 'Infinity', { type: 'polygon' }, 1.5, '\u0000'];
  function paths(o: unknown, p: (string | number)[] = [], out: (string | number)[][] = []) {
    out.push(p);
    if (Array.isArray(o)) o.forEach((v, i) => paths(v, [...p, i], out));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) paths(v, [...p, k], out);
    return out;
  }
  const get = (o: any, p: (string | number)[]) => p.reduce((a, k) => a[k], o);
  function mutate(w: any, r: () => number): string {
    const all = paths(w).filter((p) => p.length);
    const p = all[Math.floor(r() * all.length)];
    const parent = get(w, p.slice(0, -1));
    const key = p[p.length - 1];
    const op = r();
    const ids = paths(w)
      .filter((q) => q[q.length - 1] === 'id')
      .map((q) => get(w, q));
    if (op < 0.2) {
      if (Array.isArray(parent)) parent.splice(key as number, 1);
      else delete parent[key];
      return 'delete ' + p.join('/');
    }
    if (op < 0.55) {
      parent[key] = JSON.parse(JSON.stringify(WEIRD[Math.floor(r() * WEIRD.length)]));
      return 'set ' + p.join('/');
    }
    if (op < 0.7) {
      parent[key] = r() < 0.8 ? ids[Math.floor(r() * ids.length)] : 'nope';
      return 'ref ' + p.join('/');
    }
    if (op < 0.85) {
      const pops = w.populations;
      if (Array.isArray(pops) && pops.length >= 2) {
        const a = Math.floor(r() * pops.length);
        const b = Math.floor(r() * pops.length);
        if (pops[a] && pops[b] && typeof pops[a] === 'object' && typeof pops[b] === 'object') {
          pops[a].parentId = pops[b].id;
          pops[b].parentId = r() < 0.7 ? pops[a].id : pops[b].id;
        }
      }
      return 'cycle';
    }
    const nums = all.filter((q) => typeof get(w, q) === 'number');
    const q = nums[Math.floor(r() * nums.length)];
    if (q) get(w, q.slice(0, -1))[q[q.length - 1]] = [-1e300, 1e300, -0, -5, 0, { $n: 'NaN' }, 1e15][Math.floor(r() * 7)];
    return 'num';
  }
  const N = Number(process.env.QC_WS_CASES ?? 30);
  it(`${N} randomly damaged workspaces open consistently (or are rejected with a message)`, () => {
    let opened = 0;
    for (let c = 1; c <= N; c++) {
      const r = mulberry32(c * 7717);
      const w = JSON.parse(JSON.stringify(base));
      const notes = Array.from({ length: 1 + Math.floor(r() * 3) }, () => mutate(w, r));
      let ws: Workspace;
      try {
        ws = parseWorkspace(JSON.stringify(w));
      } catch (e) {
        expect((e as Error).name, notes.join('; ')).toBe('Error');
        continue;
      }
      opened++;
      expect(consistency(ws), `case ${c}: ${notes.join('; ')}`).toEqual([]);
      exercise(ws);
      // and again: a repaired workspace is stable
      expect(workspaceRepairNotes(parseWorkspace(serializeWorkspace(ws))), `case ${c}`).toEqual([]);
    }
    expect(opened).toBeGreaterThan(N / 2);
  });

  // (last: opening without files releases the example's event data)
  it('opening a repaired workspace says what was repaired', async () => {
    const ws = edit((w) => (w.populations[9] = []));
    const t0 = st().ui.toasts.length;
    await openWorkspace(ws, []);
    const t = st().ui.toasts.slice(t0).map((x) => x.text).join('\n');
    expect(t).toMatch(/had damaged entries, which were repaired or removed: 1 damaged gate was removed/);
  });
});

describe('parent cycles do not hang tree walks', () => {
  const cyc = (): Workspace => {
    loadDemo();
    const ws = structuredClone(st().ws) as Workspace;
    const [a, b, c] = ws.populations;
    a.parentId = c.id; // Cells <- ... <- Live, closing a loop
    void b;
    return ws;
  };
  it('popPath, popDescendants, isAncestorPop, ancestorOptions, counts and statistics terminate', () => {
    const ws = cyc();
    const t0 = Date.now();
    for (const p of ws.populations) {
      expect(typeof popPath(ws, p.id)).toBe('string');
      expect(popDescendants(ws, p.id).length).toBeLessThan(ws.populations.length);
      isAncestorPop(ws, ws.populations[2].id, p.id);
      expect(ancestorOptions(ws, p.id).length).toBeLessThanOrEqual(ws.populations.length + 1);
      for (const s of ws.samples) engine.count(ws, s.id, p.id);
    }
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('deleting a population inside a cycle terminates', () => {
    const ws = cyc();
    st().replaceWorkspace(ws);
    deletePopulation(ws.populations[1].id, { quiet: true });
    expect(st().ws.populations.length).toBeLessThan(ws.populations.length);
  });
});

describe('worksheet item geometry and axis ticks stay bounded', () => {
  it('computeTicks caps size-derived targets (a 1e9 mm chart asked for millions of ticks)', () => {
    const t0 = Date.now();
    const ticks = computeTicks({ type: 'linear', min: 0, max: 100 }, { target: 1e9 });
    expect(ticks.filter((t) => t.major).length).toBeLessThanOrEqual(MAX_TICK_TARGET + 2);
    expect(computeTicks({ type: 'linear', min: 0, max: Infinity }, { target: 5 })).toEqual([]);
    expect(computeTicks({ type: 'linear', min: NaN, max: 1 }, { target: 5 })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(200);
  });
  it('a chart of the largest allowed size renders quickly', () => {
    loadDemo();
    const ws = st().ws;
    const it0 = ws.worksheets[0].items.find((i) => i.kind === 'chart') as ChartItem;
    const big = { ...it0, h: 1e9 * MM };
    clampItemGeometry(big);
    expect(big.h).toBe(ITEM_MAX_SIZE);
    const t0 = Date.now();
    renderChart(new SvgPainter(), big, { ws, engine, activeSampleId: ws.samples[0].id, rasterScale: 1, makeCanvas: fakeCanvas });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('items added or pasted get finite, bounded geometry', () => {
    loadDemo();
    const sh = st().ws.worksheets[0];
    const t = { id: 'tx', kind: 'text', x: NaN, y: 1e12, w: -5, h: 1e9 * MM, text: 'x', fontSize: 10, bold: false, italic: false, align: 'left', color: '#000' } as TextItem;
    addItems(sh.id, [t]);
    const got = st().ws.worksheets[0].items.find((i) => i.id === 'tx')!;
    expect([got.x, got.y, got.w, got.h].every(Number.isFinite)).toBe(true);
    expect(got.h).toBe(ITEM_MAX_SIZE);
    expect(Number.isFinite(st().ws.worksheets[0].page.h)).toBe(true);
  });
});

describe('clipboard items are validated', () => {
  const clip = (items: unknown[]) => JSON.stringify({ 'application/x-flowstate-items': 1, items });
  it('malformed items are left out with a message (layers not a list, missing h, unknown kind)', () => {
    loadDemo();
    const t0 = st().ui.toasts.length;
    expect(parseClip(clip([{ kind: 'plot', id: 'p', x: 10, y: 10, w: 100, h: 100, layers: 5, options: {} }]))).toBeNull();
    expect(parseClip(clip([{ kind: 'text', id: 't', x: 10, y: 10, w: 100, text: 'hi', fontSize: 10 }]))).toBeNull();
    expect(parseClip(clip([{ kind: 'banana', id: 'b', x: 10, y: 10, w: 100, h: 100 }]))).toBeNull();
    expect(st().ui.toasts.slice(t0).filter((t) => /damaged FlowState items; nothing was pasted/.test(t.text)).length).toBe(3);
    const good = { kind: 'text', id: 'g', x: 10, y: 10, w: 100, h: 40, text: 'ok', fontSize: 10, bold: false, italic: false, align: 'left', color: '#000' };
    const mixed = parseClip(clip([good, { kind: 'plot', x: 1 }]))!;
    expect(mixed.length).toBe(1);
    expect(st().ui.toasts.at(-1)!.text).toMatch(/1 damaged clipboard item was left out/);
  });
  it('a plot with damaged options and references is repaired on paste', () => {
    loadDemo();
    const ws = st().ws;
    const p = structuredClone(ws.worksheets[0].items.find((i) => i.kind === 'plot')) as PlotItem;
    (p.options as unknown as Record<string, unknown>).bins = 'x';
    (p.options as unknown as Record<string, unknown>).densitySmooth = 1e15;
    p.layers[0].population = 'pop_missing';
    const items = parseClip(clip([p]))!;
    expect(items.length).toBe(1);
    const q = items[0] as PlotItem;
    expect(q.options.bins).toBe(256);
    expect(q.options.densitySmooth).toBeLessThanOrEqual(50);
    expect(q.layers[0].population).toBe('root');
    const n0 = ws.worksheets[0].items.length;
    pasteItems(ws.worksheets[0].id, items);
    expect(st().ws.worksheets[0].items.length).toBe(n0 + 1);
    expect(consistency(st().ws)).toEqual([]);
  });
  it('repairItem leaves a valid item unchanged', () => {
    loadDemo();
    const ws = st().ws;
    for (const it of ws.worksheets[0].items) {
      const c = structuredClone(it);
      const notes = new RepairNotes();
      repairItem(c, refContextOf(ws), notes);
      expect(c).toEqual(it);
      expect(notes.list()).toEqual([]);
    }
  });
});

describe('cross-workspace paste of gates and items (qc_cross_paste)', () => {
  it('references to gates, samples and matrices of the other workspace do not dangle', () => {
    loadDemo();
    let ws = st().ws;
    // a Boolean gate whose operands are not copied, a sample-specific variant, a scope and a matrix reference
    const bool = { id: 'pop_bool', name: 'B', parentId: ws.populations[0].id, color: '#000', gate: { type: 'bool' as const, op: 'and' as const, operands: [ws.populations[1].id, '!' + ws.populations[2].id] } };
    st().update((w) => {
      w.populations.push(bool as never);
      w.populations[3].overrides = { [w.samples[0].id]: w.populations[3].gate };
      w.populations[3].scope = { samples: [w.samples[0].id] };
      w.populations[3].gate = { ...w.populations[3].gate, comp: 'comp_elsewhere' } as never;
    });
    ws = st().ws;
    const sheet = ws.worksheets[0];
    copyItems(sheet.id, sheet.items.map((i) => i.id));
    copyGates('pop_bool', true);
    // another workspace with a file of its own
    (globalThis as unknown as { indexedDB?: unknown }).indexedDB = undefined;
    newBlankWorkspace();
    const bytes = writeFcs({ channels: [{ name: 'FSC-A', range: 262144 }, { name: 'SSC-A', range: 262144 }], data: [Float32Array.from({ length: 500 }, (_, i) => i * 100), Float32Array.from({ length: 500 }, (_, i) => i * 50)] });
    addDataset('other.fcs', bytes.byteLength, parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    // gates: the Boolean one (operands not here) is not pasted, with a message
    expect(pasteGates(null)).toEqual([]);
    expect(st().ui.toasts.at(-1)!.text).toMatch(/Nothing was pasted: 1 Boolean gate was not pasted/);
    // the scoped gate with a variant and a matrix of the other workspace (copied before the switch)
    pasteItems(st().ws.worksheets[0].id);
    expect(st().ui.toasts.some((t) => /Pasted with changes: .*references to missing gates or samples/.test(t.text))).toBe(true);
    expect(consistency(st().ws)).toEqual([]);
    exercise(st().ws);
  });
  it('gates with variants, scope and matrix of another workspace are adjusted', () => {
    loadDemo();
    const ws = st().ws;
    const src = ws.populations[3];
    st().update((w) => {
      const p = w.populations.find((x) => x.id === src.id)!;
      p.overrides = { [w.samples[0].id]: p.gate };
      p.scope = { samples: [w.samples[0].id] };
      p.gate = { ...p.gate, comp: 'comp_elsewhere' } as never;
    });
    copyGates(src.id, false);
    newBlankWorkspace();
    pasteGates(null);
    const made = st().ws.populations;
    expect(made.length).toBe(1);
    const p = made[0] as Population;
    expect(p.overrides).toBeUndefined();
    expect(p.scope).toBeUndefined();
    expect(p.gate.comp).toBeUndefined();
    expect(st().ui.toasts.at(-1)!.text).toMatch(/with changes: .*sample-specific gate position.*group \/ sample limits.*compensation/);
  });
});

describe('UI references', () => {
  it('keyItemId does not dangle after "New worksheet" or switching sheets', () => {
    loadDemo();
    const sh = st().ws.worksheets[0];
    st().setUI({ selectedItemIds: [sh.items[1].id], keyItemId: sh.items[1].id });
    addSheet();
    expect(st().ui.keyItemId).toBeNull();
    st().setUI({ activeSheetId: sh.id, keyItemId: sh.items[1].id });
    expect(st().ui.keyItemId).toBe(sh.items[1].id);
    st().setUI({ activeSheetId: st().ws.worksheets[1].id });
    expect(st().ui.keyItemId).toBeNull();
  });
});

describe('statistics rows of a stats box', () => {
  it('rows on damaged references are handled (n/a or removed, no exception)', () => {
    loadDemo();
    const ws = st().ws;
    const box = ws.worksheets[0].items.find((i) => i.kind === 'stats') as StatsBoxItem | undefined;
    const it: StatsBoxItem = box ?? { id: 's', kind: 'stats', x: 0, y: 0, w: 100, h: 100, sample: 'active', fontSize: 8, rows: [{ id: 'r', population: 'root', stat: 'count' }] };
    expect(statsRows(ws, engine, it, ws.samples[0].id).length).toBe(it.rows.length);
  });
});
