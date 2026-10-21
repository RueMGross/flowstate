// Group- / sample-specific gating trees (population scopes), "not applicable" populations and statistics (n/a, not 0),
// default channels of the relevant samples, fixed sample sets of charts / overlays, automatic gate names from marker
// labels, saved UI state, instrument range hints, data-derived scales of computed channels and the MFI table.
import { engine, Engine } from '../src/core/engine';
import { writeFcs, type FcsDataset } from '../src/core/fcs';
import { exportGatingMLDoc } from '../src/core/gatingml';
import { emptyWorkspace, type ChartItem, type GateGeom, type PlotItem, type Population, type StatsBoxItem, type Workspace } from '../src/core/model';
import { formatStat } from '../src/core/stats';
import { chartData } from '../src/render/chart';
import { statsRows } from '../src/render/items';
import { resolveLayers, type RenderEnv } from '../src/render/plot';
import { autoNameRenames, markerName, quadrantName, shortChannelName } from '../src/core/naming';
import { applies, inScopeChain, popNotApplicableReason, resolvePopFor, scopeWithout, statNotApplicableReason } from '../src/core/scope';
import { parseWorkspace, serializeWorkspace, templateWorkspace } from '../src/io/files';
import { dataLogicleScale, dataLogScale, defaultOutputName } from '../src/state/derivedOps';
import { copyGatesToGroup, setPopScope } from '../src/state/scopeOps';
import {
  currentPopulation,
  fitScalesToData,
  loadFcsFiles,
  newChartItem,
  newOverlayPlot,
  overlaySampleIds,
  pickDefaultChannels,
  pickMfiChannel,
  removeSamples,
  savedUiOf,
  scaleMismatches,
  useStore,
} from '../src/state/store';
import { createMfiTable, mfiTablePlan, tableMatrix, tableSamples } from '../src/ui/TablesView';
import { populationPlotSpec } from '../src/ui/layoutOps';

function ds(names: string[], cols: number[][]): FcsDataset {
  return { channels: names.map((name) => ({ name, label: '', range: 262144 })), data: cols.map((c) => Float32Array.from(c)), eventCount: cols[0].length, keywords: {}, warnings: [] } as unknown as FcsDataset;
}

const pop = (id: string, name: string, parentId: string | null, gate: GateGeom, extra: Partial<Population> = {}): Population => ({ id, name, parentId, gate, color: '#000', ...extra });

/** Two BD-like samples (one without 7-AAD) and a CytoFLEX-like one, groups BD / CY. */
function mixed(): { ws: Workspace; eng: Engine } {
  const eng = new Engine();
  const n = 10;
  const ramp = (k: number) => Array.from({ length: n }, (_, i) => (i + 1) * k);
  eng.addSample('bd1', ds(['FSC-A', 'SSC-A', '7-AAD-A', 'PE-A'], [ramp(100), ramp(100), ramp(10), ramp(50)]));
  eng.addSample('bd2', ds(['FSC-A', 'SSC-A', 'PE-A'], [ramp(100), ramp(100), ramp(50)]));
  eng.addSample('cy', ds(['FSC-A', 'VSSC-A', 'U1-A'], [ramp(1e5), ramp(1e5), ramp(10)]));
  const ws = emptyWorkspace();
  const ch = (names: string[]) => names.map((name) => ({ name, label: '', range: 262144 }));
  ws.samples = [
    { id: 'bd1', name: 'bd1', fileName: 'bd1.fcs', fileSize: 0, eventCount: n, channels: ch(['FSC-A', 'SSC-A', '7-AAD-A', 'PE-A']), compId: null },
    { id: 'bd2', name: 'bd2', fileName: 'bd2.fcs', fileSize: 0, eventCount: n, channels: ch(['FSC-A', 'SSC-A', 'PE-A']), compId: null },
    { id: 'cy', name: 'cy', fileName: 'cy.fcs', fileSize: 0, eventCount: n, channels: ch(['FSC-A', 'VSSC-A', 'U1-A']), compId: null },
  ];
  ws.groups = [
    { id: 'gBD', name: 'BD', sampleIds: ['bd1', 'bd2'] },
    { id: 'gCY', name: 'CY', sampleIds: ['cy'] },
  ];
  ws.populations = [
    pop('cells', 'Cells', null, { type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: 250, xmax: Infinity, ymin: -Infinity, ymax: Infinity }, { scope: { groups: ['gBD'] } }),
    pop('live', 'Live', 'cells', { type: 'range', x: '7-AAD-A', min: -Infinity, max: 80 }),
    pop('pe', 'PE+', 'cells', { type: 'range', x: 'PE-A', min: 300, max: Infinity }),
    pop('cellsC', 'Cells', null, { type: 'rect', x: 'FSC-A', y: 'VSSC-A', xmin: 250000, xmax: Infinity, ymin: -Infinity, ymax: Infinity }, { scope: { groups: ['gCY'] } }),
    pop('and', 'Live and PE+', 'cells', { type: 'bool', op: 'and', operands: ['live', 'pe'] }),
    pop('or', 'Live or PE+', 'cells', { type: 'bool', op: 'or', operands: ['live', 'pe'] }),
  ];
  return { ws, eng };
}

describe('population scopes and not-applicable populations', () => {
  it('a scope (group, inherited by the subtree) or a gate on a missing channel makes a population n/a', () => {
    const { ws } = mixed();
    expect(applies(ws, 'bd1', 'cells')).toBe(true);
    expect(applies(ws, 'cy', 'cells')).toBe(false);
    expect(applies(ws, 'cy', 'pe')).toBe(false); // inherited
    expect(applies(ws, 'cy', 'cellsC')).toBe(true);
    expect(applies(ws, 'bd2', 'live')).toBe(false); // no 7-AAD-A
    expect(popNotApplicableReason(ws, 'bd2', 'live')).toMatch(/7-AAD-A not measured/);
    expect(popNotApplicableReason(ws, 'cy', 'pe')).toMatch(/applies only to group BD/);
    // AND with an n/a operand is n/a; OR needs one operand that applies
    expect(applies(ws, 'bd2', 'and')).toBe(false);
    expect(applies(ws, 'bd2', 'or')).toBe(true);
    expect(applies(ws, 'bd1', 'root')).toBe(true);
    // group membership is live
    expect(inScopeChain(ws, 'bd2', 'cellsC')).toBe(false);
    ws.groups[1].sampleIds.push('bd2');
    expect(inScopeChain(ws, 'bd2', 'cellsC')).toBe(true);
  });

  it('n/a populations have no events; statistics are NaN and flagged, counts stay numbers', () => {
    const { ws, eng } = mixed();
    expect(eng.count(ws, 'cy', 'cells')).toBe(0);
    expect(eng.countOrNA(ws, 'cy', 'cells')).toBeNull();
    expect(eng.countOrNA(ws, 'bd1', 'cells')).toBe(8);
    expect(eng.count(ws, 'bd1', 'live')).toBe(5); // 7-AAD 10..50 of the 8 cells (30..100)
    expect(eng.stat(ws, 'bd1', { population: 'live', stat: 'freqParent' })).toBeCloseTo(62.5, 9);
    expect(Number.isNaN(eng.stat(ws, 'bd2', { population: 'live', stat: 'freqParent' }))).toBe(true);
    expect(eng.statNotApplicable(ws, 'bd2', { population: 'live', stat: 'count' })).toBe(true);
    // a statistic on a channel the sample lacks is n/a too, on a population that applies
    expect(statNotApplicableReason(ws, 'bd2', { population: 'cells', stat: 'median', channel: '7-AAD-A' })).toMatch(/not measured/);
    expect(eng.statNotApplicable(ws, 'bd1', { population: 'cells', stat: 'median', channel: '7-AAD-A' })).toBe(false);
    // an OR gate keeps the events of the operand that applies
    expect(eng.count(ws, 'bd2', 'or')).toBe(eng.count(ws, 'bd2', 'pe'));
  });

  it('statistics use the population with the same path that applies (group-specific copies of a tree)', () => {
    const { ws, eng } = mixed();
    expect(resolvePopFor(ws, 'cy', 'cells')).toBe('cellsC');
    expect(resolvePopFor(ws, 'bd1', 'cells')).toBe('cells');
    expect(eng.stat(ws, 'cy', { population: 'cells', stat: 'count' })).toBe(eng.count(ws, 'cy', 'cellsC'));
    expect(eng.statNotApplicable(ws, 'cy', { population: 'cells', stat: 'count' })).toBe(false);
    // no counterpart: n/a
    expect(eng.statNotApplicable(ws, 'cy', { population: 'pe', stat: 'count' })).toBe(true);
  });

  it('a legacy empty override (older FlowJo imports) reads as "no gate for this sample"', () => {
    const { ws } = mixed();
    ws.populations[2].overrides = { bd2: { type: 'bool', op: 'or', operands: [] } };
    expect(popNotApplicableReason(ws, 'bd2', 'pe')).toMatch(/no gate for this sample/);
  });

  it('scopeWithout removes a group: from listed groups, else as the other groups or the remaining samples', () => {
    const { ws } = mixed();
    expect(scopeWithout(ws, undefined, 'gCY')).toEqual({ groups: ['gBD'] });
    expect(scopeWithout(ws, { groups: ['gBD', 'gCY'] }, 'gCY')).toEqual({ groups: ['gBD'] });
    ws.groups = ws.groups.slice(1);
    expect(scopeWithout(ws, undefined, 'gCY')).toEqual({ samples: ['bd1', 'bd2'] });
  });
});

function newChartItemFor(): ChartItem {
  return { id: 'ch', kind: 'chart', x: 0, y: 0, w: 10, h: 10, stat: { id: 's', population: 'root', stat: 'count' }, mode: 'samples', sampleSet: 'all', style: 'bar', errorBars: 'sd', showPoints: true, color: '#000', useGroupColors: true, fontSize: 8, lineWidth: 1 };
}

function reset(ws: Workspace, eng: Engine) {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  for (const [id, sd] of eng.samples) engine.addSample(id, sd.ds);
  useStore.getState().replaceWorkspace(ws);
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [], dialog: null, selectedPopId: null, selectedItemIds: [], selectedSampleIds: [], activeSampleId: 'bd1', sampleFilter: 'all' } });
}

describe('tables, scope operations and Gating-ML', () => {
  it('table cells of n/a statistics are null (shown "n/a", exported empty)', () => {
    const { ws, eng } = mixed();
    reset(ws, eng);
    useStore.getState().update((w) => {
      w.tables.push({ id: 't', name: 'T', sampleSet: 'all', columns: [{ id: 'a', population: 'live', stat: 'freqParent' }, { id: 'b', population: 'cells', stat: 'count' }] });
    });
    const { rows } = tableMatrix(useStore.getState().ws, useStore.getState().ws.tables[0]);
    expect(rows.map((r) => r[0])).toEqual(['bd1', 'bd2', 'cy']);
    expect(rows[0][1]).toBeCloseTo(62.5, 9);
    expect(rows[1][1]).toBeNull();
    expect(rows[2][1]).toBeNull();
    expect(rows[2][2]).toBe(engine.count(ws, 'cy', 'cellsC'));
  });

  it('samples hidden from a table leave its rows only; saved with the workspace, dropped when the sample is removed', () => {
    const { ws, eng } = mixed();
    reset(ws, eng);
    useStore.getState().update((w) => {
      w.tables.push({ id: 't', name: 'T', sampleSet: 'all', hiddenSamples: ['bd2'], columns: [{ id: 'b', population: 'cells', stat: 'count' }] });
    });
    let w = useStore.getState().ws;
    expect(tableMatrix(w, w.tables[0]).rows.map((r) => r[0])).toEqual(['bd1', 'cy']);
    expect(w.samples.map((s) => s.id)).toContain('bd2');
    expect(parseWorkspace(serializeWorkspace(w)).tables[0].hiddenSamples).toEqual(['bd2']);
    // a damaged list is dropped on load (all rows shown)
    const bad = JSON.parse(serializeWorkspace(w));
    bad.tables[0].hiddenSamples = [3];
    expect(parseWorkspace(JSON.stringify(bad)).tables[0].hiddenSamples).toBeUndefined();
    removeSamples(['bd2'], { quiet: true });
    w = useStore.getState().ws;
    expect(w.tables[0].hiddenSamples).toEqual([]);
    expect(tableSamples(w, w.tables[0]).map((s) => s.id)).toEqual(['bd1', 'cy']);
  });

  it('Apply to sets the scope of all regions of a quadrant gate; Copy gates to group narrows the original', () => {
    const { ws, eng } = mixed();
    ws.populations.push(
      pop('q1', 'A', null, { type: 'quadrant', x: 'FSC-A', y: 'PE-A', cx: 1, cy: 1, quadrant: 'UR', groupId: 'G' }),
      pop('q2', 'B', null, { type: 'quadrant', x: 'FSC-A', y: 'PE-A', cx: 1, cy: 1, quadrant: 'UL', groupId: 'G' }),
    );
    reset(ws, eng);
    setPopScope('q1', { samples: ['bd1'] });
    let w = useStore.getState().ws;
    expect(w.populations.find((p) => p.id === 'q2')!.scope).toEqual({ samples: ['bd1'] });
    setPopScope('q1', undefined, { quiet: true });
    w = useStore.getState().ws;
    expect(w.populations.find((p) => p.id === 'q2')!.scope).toBeUndefined();
    // copy the (unscoped) PE+ ... first make Cells unscoped so it reaches both groups
    setPopScope('cells', undefined, { quiet: true });
    const made = copyGatesToGroup('cells', 'gCY');
    w = useStore.getState().ws;
    expect(made).toHaveLength(1);
    expect(made[0].name).toBe('Cells'); // names kept: tables match by path
    expect(made[0].scope).toEqual({ groups: ['gCY'] });
    expect(w.populations.find((p) => p.id === 'cells')!.scope).toEqual({ groups: ['gBD'] });
    const kids = w.populations.filter((p) => p.parentId === made[0].id);
    expect(kids.map((k) => k.name).sort()).toEqual(['Live', 'Live and PE+', 'Live or PE+', 'PE+']);
    expect(kids.every((k) => !k.scope)).toBe(true);
    // the copied Boolean gates use the copied operands
    const and = kids.find((k) => k.name === 'Live and PE+')!;
    expect((and.gate as { operands: string[] }).operands.every((o) => kids.some((k) => k.id === o))).toBe(true);
  });

  it('Gating-ML export warns about group-specific gates', () => {
    const { ws } = mixed();
    const { warnings } = exportGatingMLDoc(ws);
    expect(warnings.some((m) => /apply only to some samples/.test(m) && /group BD/.test(m))).toBe(true);
  });
});

describe('default channels, charts and overlays', () => {
  it('default channels come from the active / given samples; gated channels first', () => {
    const { ws, eng } = mixed();
    reset(ws, eng);
    const w = useStore.getState().ws;
    expect(pickDefaultChannels(w, { sampleIds: ['cy'] })).toMatchObject({ fsc: 'FSC-A', ssc: 'VSSC-A', fl: ['U1-A'] });
    expect(pickDefaultChannels(w).fl[0]).toBe('7-AAD-A'); // active bd1
    expect(pickDefaultChannels(w, { popId: 'cells' }).fl.slice(0, 2)).toEqual(['7-AAD-A', 'PE-A']); // child range gates first
    expect(pickDefaultChannels(w, { sampleIds: ['bd2'], popId: 'pe' }).fl[0]).toBe('PE-A'); // own gate
    expect(pickMfiChannel(w, ['bd1', 'bd2'], 'pe')).toBe('PE-A');
    expect(pickMfiChannel(w, ['bd2'], 'cells')).toBe('PE-A');
  });

  it('charts use the selected population (else the selected plot\'s) and fix their samples', () => {
    const { ws, eng } = mixed();
    reset(ws, eng);
    const st = useStore.getState();
    st.setUI({ selectedPopId: 'pe' });
    let c: ChartItem = newChartItem(0, 0, 100, 100);
    expect(c.stat.population).toBe('pe');
    expect(c.mode).toBe('groups');
    expect(c.groups).toEqual(['gBD', 'gCY']);
    st.update((w) => {
      w.groups = [];
      w.worksheets[0].items.push({ ...newOverlayPlot(0, 0, 100, 100), id: 'pl', layers: [{ id: 'l', sample: 'active', population: 'live' }] } as PlotItem);
    });
    st.setUI({ selectedPopId: null, selectedItemIds: ['pl'] });
    expect(currentPopulation()).toBe('live');
    c = newChartItem(0, 0, 100, 100);
    expect(c.stat.population).toBe('live');
    expect(c.samples).toEqual(['bd1', 'bd2', 'cy']);
    st.setUI({ selectedSampleIds: ['bd2', 'cy'] });
    expect(newChartItem(0, 0, 100, 100).samples).toEqual(['bd2', 'cy']);
  });

  it('overlays: the selected samples, else the active one and the next with the channel', () => {
    const { ws, eng } = mixed();
    reset(ws, eng);
    const st = useStore.getState();
    expect(overlaySampleIds(st.ws, { ...st.ui, activeSampleId: 'bd1', selectedSampleIds: [] }, 'PE-A')).toEqual(['bd1', 'bd2']);
    expect(overlaySampleIds(st.ws, { ...st.ui, activeSampleId: 'bd2', selectedSampleIds: [] }, '7-AAD-A')).toEqual(['bd2', 'bd1']);
    expect(overlaySampleIds(st.ws, { ...st.ui, activeSampleId: 'bd1', selectedSampleIds: ['bd1', 'bd2', 'cy'] })).toEqual(['bd1', 'bd2', 'cy']);
    st.setUI({ selectedPopId: 'pe', activeSampleId: 'bd1' });
    const ov = newOverlayPlot(0, 0, 100, 100);
    expect(ov.xParam).toBe('PE-A'); // the channel the population is gated on
    expect(ov.layers.map((l) => [l.sample, l.population])).toEqual([
      ['bd1', 'pe'],
      ['bd2', 'pe'],
    ]);
    // a channel only the active sample has: just that sample
    st.setUI({ selectedPopId: 'live' });
    expect(newOverlayPlot(0, 0, 100, 100).layers.map((l) => l.sample)).toEqual(['bd1']);
  });

  it('population plots open on the axes of the child gates, else the own gate', () => {
    const { ws } = mixed();
    expect(populationPlotSpec(ws, 'cells')).toEqual({ type: 'histogram', x: '7-AAD-A', y: '7-AAD-A' });
    expect(populationPlotSpec(ws, 'pe')).toEqual({ type: 'histogram', x: 'PE-A', y: 'PE-A' });
    expect(populationPlotSpec(ws, 'root')).toEqual({ type: 'pseudo', x: 'FSC-A', y: 'SSC-A' });
  });
});

describe('gate names from marker labels', () => {
  it('short channel names and marker labels', () => {
    expect(shortChannelName('Alexa Fluor 700-A')).toBe('AF700');
    expect(shortChannelName('PE-A')).toBe('PE');
    expect(shortChannelName('PE-Cy7-A')).toBe('PE-Cy7');
    expect(shortChannelName('CD4 PE-Cy7 FLR-A')).toBe('CD4 PE-Cy7');
    expect(shortChannelName('FSC-H')).toBe('FSC-H');
    expect(shortChannelName('FL1')).toBe('FL1');
    const ws = emptyWorkspace();
    ws.channelLabels['PE-A'] = 'CD8';
    expect(markerName(ws, 'PE-A')).toBe('CD8');
    expect(quadrantName('CD4', 'CD8', 'LR')).toBe('CD4+ CD8-');
  });

  it('offers renames only for gates still named automatically', () => {
    const prev = emptyWorkspace();
    prev.populations = [
      pop('a', 'AF700+ PE-', null, { type: 'quadrant', x: 'Alexa Fluor 700-A', y: 'PE-A', cx: 1, cy: 1, quadrant: 'LR', groupId: 'g' }),
      pop('b', 'Alexa Fluor 700-A- PE-A+', null, { type: 'quadrant', x: 'Alexa Fluor 700-A', y: 'PE-A', cx: 1, cy: 1, quadrant: 'UL', groupId: 'g' }),
      pop('c', 'Tregs', null, { type: 'quadrant', x: 'Alexa Fluor 700-A', y: 'PE-A', cx: 1, cy: 1, quadrant: 'UR', groupId: 'g' }),
      pop('d', 'AF700+ 2', null, { type: 'range', x: 'Alexa Fluor 700-A', min: 5, max: Infinity }),
    ];
    const next: Workspace = { ...prev, channelLabels: { 'Alexa Fluor 700-A': 'CD4' } };
    expect(autoNameRenames(prev, next).map((r) => [r.id, r.to])).toEqual([
      ['a', 'CD4+ PE-'],
      ['b', 'CD4- PE+'],
      ['d', 'CD4+ 2'],
    ]);
  });
});

describe('saved UI state, templates, instrument ranges', () => {
  it('saved workspaces carry the active sample, sheet and view', () => {
    const { ws, eng } = mixed();
    reset(ws, eng);
    useStore.getState().setUI({ activeSampleId: 'cy', view: 'tables' });
    const text = serializeWorkspace(useStore.getState().ws, savedUiOf());
    expect(JSON.parse(text).uiState).toMatchObject({ activeSampleId: 'cy', view: 'tables' });
    const back = parseWorkspace(text);
    expect((back as unknown as { uiState?: unknown }).uiState).toBeUndefined();
  });

  it('templates keep group scopes and drop sample scopes and fixed chart samples', () => {
    const { ws } = mixed();
    ws.populations[1].scope = { samples: ['bd1'] };
    ws.worksheets[0].items.push({ ...newChartItemFor(), samples: ['bd1'] });
    const t = templateWorkspace(ws);
    expect(t.populations.find((p) => p.id === 'cells')!.scope).toEqual({ groups: ['gBD'] });
    expect(t.populations.find((p) => p.id === 'live')!.scope).toBeUndefined();
    expect((t.worksheets[0].items[0] as ChartItem).samples).toBeUndefined();
  });

  it('flags channels whose axis was set for another instrument and fits them to all samples', async () => {
    const big = (k: number, n = 2000) => Array.from({ length: n }, (_, i) => ((i % 100) + 1) * k);
    const bytes = (k: number, range: number) =>
      new File([writeFcs({ channels: [{ name: 'FSC-A', range }, { name: 'PE-A', range }], data: [Float32Array.from(big(k)), Float32Array.from(big(k / 100))], keywords: {} }) as BlobPart], `f${k}.fcs`);
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    useStore.getState().replaceWorkspace(emptyWorkspace());
    useStore.setState({ ui: { ...useStore.getState().ui, toasts: [] } });
    await loadFcsFiles([bytes(2500, 262144)]); // BD-like: FSC-A up to 250,000
    const fsc0 = useStore.getState().ws.scales['FSC-A'];
    await loadFcsFiles([bytes(800000, 16777216)]); // CytoFLEX-like: up to 80 million
    const st = useStore.getState();
    const t = st.ui.toasts.find((x) => /Axis ranges were set for another instrument/.test(x.text));
    expect(t?.action?.label).toBe('Fit axes to data');
    expect(t!.text).toMatch(/FSC-A/);
    const cy = st.ws.samples[1].id;
    expect(scaleMismatches(st.ws, cy, new Set(['FSC-A']))).toEqual(['FSC-A']);
    // a polygon on FSC-A keeps its counts when the axis changes
    st.update((w) => {
      w.populations.push(pop('p', 'P', null, { type: 'polygon', x: 'FSC-A', y: 'PE-A', points: [[0, 0], [150000, 0], [150000, 3000], [0, 3000]] }));
    });
    const before = engine.count(useStore.getState().ws, st.ws.samples[0].id, 'p');
    fitScalesToData(['FSC-A']);
    const after = useStore.getState().ws;
    expect(after.scales['FSC-A']).not.toEqual(fsc0);
    expect((after.scales['FSC-A'] as { max: number }).max).toBeGreaterThan(5e7);
    expect(engine.count(after, st.ws.samples[0].id, 'p')).toBe(before);
    expect((after.populations[0].gate as { scales?: unknown }).scales).toBeDefined();
  });
});

describe('computed channels and the MFI table', () => {
  it('data-derived log / logicle scales and short output names', () => {
    const v = Float32Array.from(Array.from({ length: 1000 }, (_, i) => 2000 + i * 300)); // 2,000 .. 301,700
    expect(dataLogScale(v)).toEqual({ type: 'log', min: 1000, max: 1e6 });
    expect(dataLogScale(Float32Array.from([1, 2]))).toBeNull();
    const l = dataLogicleScale('x', v)!;
    expect(l.type).toBe('logicle');
    expect((l as { T: number }).T).toBe(5e5);
    expect(defaultOutputName('FITC-A', 'MESF')).toBe('FITC MESF');
    expect(defaultOutputName('VSSC1-A', 'diameter')).toBe('VSSC1 diameter');
  });

  it('MFI of all channels: count, % parent and medians of the fluorescence channels', () => {
    const { ws, eng } = mixed();
    reset(ws, eng);
    useStore.getState().setUI({ selectedPopId: 'cells' });
    const id = createMfiTable()!;
    const t = useStore.getState().ws.tables.find((x) => x.id === id)!;
    const cellsCols = t.columns.filter((c) => c.population === 'cells');
    // 'cells' applies to the BD group only: no column for the CytoFLEX channel U1-A (it would be n/a in every row)
    expect(cellsCols.map((c) => c.stat + (c.channel ? ':' + c.channel : ''))).toEqual(['count', 'freqParent', 'median:7-AAD-A', 'median:PE-A']);
    // the CytoFLEX gate has its own channel
    expect(t.columns.some((c) => c.population === 'cellsC')).toBe(false); // not below the selected population
    expect(new Set(t.columns.map((c) => c.population))).toEqual(new Set(['cells', 'live', 'pe', 'and', 'or']));
    const { rows } = tableMatrix(useStore.getState().ws, t);
    // bd2 has no 7-AAD: n/a, not 0
    const i7 = t.columns.findIndex((c) => c.population === 'cells' && c.channel === '7-AAD-A');
    expect(rows[1][i7 + 1]).toBeNull();
    expect(typeof rows[0][i7 + 1]).toBe('number');
  });

  it('MFI table: each population gets the channels of the samples it applies to; a chosen subset only', () => {
    const { ws, eng } = mixed();
    reset(ws, eng);
    useStore.getState().setUI({ selectedPopId: null });
    const plan = mfiTablePlan();
    expect(plan.perPop.get('cellsC')).toEqual(['U1-A']);
    expect(plan.perPop.get('cells')).not.toContain('U1-A');
    const id = createMfiTable(['PE-A'])!;
    const t = useStore.getState().ws.tables.find((x) => x.id === id)!;
    expect(t.columns.filter((c) => c.stat === 'median').map((c) => c.channel)).toEqual(t.columns.filter((c) => c.stat === 'median').map(() => 'PE-A'));
    expect(t.columns.some((c) => c.population === 'cellsC' && c.stat === 'median')).toBe(false);
  });
});

describe('rendering of scoped populations (integration)', () => {
  const env = (ws: Workspace, eng: Engine) => ({ ws, engine: eng, activeSampleId: 'bd1', rasterScale: 1, makeCanvas: () => null as unknown as HTMLCanvasElement }) as RenderEnv;

  it('statistics boxes show n/a for statistics that do not apply, values otherwise', () => {
    const { ws, eng } = mixed();
    const box: StatsBoxItem = { id: 'sb', kind: 'stats', x: 0, y: 0, w: 100, h: 60, sample: 'active', fontSize: 8, rows: [
      { id: 'r1', population: 'pe', stat: 'count' },
      { id: 'r2', population: 'live', stat: 'freqParent' },
      { id: 'r3', population: 'cells', stat: 'median', channel: 'PE-A' },
    ] };
    expect(statsRows(ws, eng, box, 'bd2').map((r) => r.value)).toEqual([String(eng.stat(ws, 'bd2', box.rows[0])), 'n/a', formatStat(eng.stat(ws, 'bd2', box.rows[2]), 'median')]);
    expect(statsRows(ws, eng, box, 'cy').map((r) => r.value)).toEqual(['n/a', 'n/a', 'n/a']);
    expect(statsRows(ws, eng, box, 'bd1').every((r) => r.note === null)).toBe(true);
  });

  it('charts of fixed samples keep their order (loaded samples only), else follow the sample set', () => {
    const { ws, eng } = mixed();
    const chart = { id: 'c', kind: 'chart', x: 0, y: 0, w: 100, h: 100, stat: { id: 'k', population: 'root', stat: 'count' }, mode: 'samples', sampleSet: 'all', samples: ['cy', 'gone', 'bd1'], style: 'bar', errorBars: 'none', showPoints: false, color: '#000', useGroupColors: false, fontSize: 8, lineWidth: 1 } as ChartItem;
    expect(chartData(chart, env(ws, eng)).map((b) => b.label)).toEqual(['cy', 'bd1']);
    const live = { ...chart, samples: undefined, sampleSet: 'gBD' } as ChartItem;
    expect(chartData(live, env(ws, eng)).map((b) => b.label)).toEqual(['bd1', 'bd2']);
  });

  it('plot layers show each sample its own group-specific copy of a gating tree', () => {
    const { ws, eng } = mixed();
    const plot = { id: 'p', kind: 'plot', options: { dotColor: '#000' }, layers: [{ id: 'l', sample: 'active', population: 'cells' }] } as unknown as PlotItem;
    expect(resolveLayers(plot, ws, 'bd1', eng)[0].popId).toBe('cells');
    // 'Cells' of group CY has the same path of names
    expect(resolveLayers(plot, ws, 'cy', eng)[0].popId).toBe('cellsC');
  });
});
