// Fixes after the "new lab user" acceptance test: per-instrument scales, one undo step per file load (and a stable
// active sample), view / draft reset on a new workspace, readable MESF warnings, opaque bitmap exports, chart groups and
// axis titles, nanoscale defaults, derived units and the residual check of spectral unmixing.
import { existsSync, readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { engine, Engine } from '../src/core/engine';
import { parseFcs, writeFcs, type FcsDataset } from '../src/core/fcs';
import { instrumentKeyOf, scaleFor, sampleInstrument } from '../src/core/instruments';
import { fitMesf } from '../src/core/mesf';
import { channelDisplayName, emptyWorkspace, type ChartItem, type Population, type Workspace } from '../src/core/model';
import { createUnmixDef, defaultDetectors, resolveDetectors, signatureFromControl, type EventSet } from '../src/core/unmix';
import { rasterSize } from '../src/io/exportFigure';
import { chartData, statAxisLabel } from '../src/render/chart';
import type { RenderEnv } from '../src/render/plot';
import { isNanoscaleData, loadFcsFiles, useStore } from '../src/state/store';
import { residualCheck } from '../src/ui/unmix/residualCheck';
import { openUnmixView, useDrafts } from '../src/ui/unmix/draft';

function ds(names: string[], cols: number[][], keywords: Record<string, string> = {}): FcsDataset {
  return { channels: names.map((name) => ({ name, label: '', range: 262144 })), data: cols.map((c) => Float32Array.from(c)), eventCount: cols[0].length, keywords, warnings: [] } as unknown as FcsDataset;
}

const file = (name: string, k: number, range: number, cyt: string, n = 2000) =>
  new File(
    [
      writeFcs({
        channels: [
          { name: 'FSC-A', range },
          { name: 'PE-A', range },
        ],
        data: [Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 100) + 1) * k)), Float32Array.from(Array.from({ length: n }, (_, i) => ((i % 50) + 1) * (k / 100)))],
        keywords: { $CYT: cyt },
      }) as BlobPart,
    ],
    name,
  );

function reset() {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(emptyWorkspace());
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [] } });
}

describe('per-instrument scales', () => {
  it('instrument keys: $CYT plus serial number', () => {
    expect(instrumentKeyOf({ $CYT: 'LSRII' })).toBe('LSRII');
    expect(instrumentKeyOf({ $CYT: 'CytoFLEX nano', $CYTSN: 'BH20023' })).toBe('CytoFLEX nano (BH20023)');
    expect(instrumentKeyOf({})).toBe('');
  });

  it('without instrumentScales every sample uses the workspace scale (counts as before)', () => {
    const eng = new Engine();
    const ramp = (k: number) => Array.from({ length: 200 }, (_, i) => (i + 1) * k);
    eng.addSample('a', ds(['FSC-A', 'SSC-A'], [ramp(1000), ramp(1000)], { $CYT: 'LSRII' }));
    eng.addSample('b', ds(['FSC-A', 'SSC-A'], [ramp(80000), ramp(80000)], { $CYT: 'CytoFLEX' }));
    const ws = emptyWorkspace();
    ws.samples = ['a', 'b'].map((id) => ({ id, name: id, fileName: id + '.fcs', fileSize: 0, eventCount: 200, channels: [], compId: null }));
    ws.scales = { 'FSC-A': { type: 'linear', min: 0, max: 262144 }, 'SSC-A': { type: 'linear', min: 0, max: 262144 } };
    const poly: Population = { id: 'p', name: 'P', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FSC-A', y: 'SSC-A', points: [[0, 0], [100000, 0], [100000, 100000], [0, 100000]] } };
    ws.populations = [poly];
    const before = [eng.count(ws, 'a', 'p'), eng.count(ws, 'b', 'p')];
    expect(eng.scaleFor(ws, 'FSC-A', 'b')).toBe(ws.scales['FSC-A']);
    // an own scale for the CytoFLEX: its samples use it, the BD sample keeps its scale and count
    const ws2: Workspace = { ...ws, instrumentScales: { CytoFLEX: { 'FSC-A': { type: 'linear', min: 0, max: 2e7 } } } };
    expect(scaleFor(ws2, 'FSC-A', 'a', eng.keywordsOf)).toBe(ws.scales['FSC-A']);
    expect(scaleFor(ws2, 'FSC-A', 'b', eng.keywordsOf)).toEqual({ type: 'linear', min: 0, max: 2e7 });
    expect(sampleInstrument(ws2, 'b', eng.keywordsOf)).toBe('CytoFLEX');
    expect(eng.count(ws2, 'a', 'p')).toBe(before[0]);
    expect(eng.count(ws, 'b', 'p')).toBe(before[1]);
  });

  it('files of another instrument with a 10x different range get their own scales (in the load\'s undo step)', async () => {
    reset();
    await loadFcsFiles([file('bd.fcs', 2500, 262144, 'LSRII')]);
    const bdScale = useStore.getState().ws.scales['FSC-A'];
    await loadFcsFiles([file('cy.fcs', 800000, 16777216, 'CytoFLEX LX')]);
    const st = useStore.getState();
    expect(st.ws.instrumentScales?.['CytoFLEX LX']?.['FSC-A']).toBeDefined();
    expect(st.ws.scales['FSC-A']).toBe(bdScale);
    const cy = st.ws.samples.find((s) => s.name === 'cy')!;
    expect(cy.instrument).toBe('CytoFLEX LX');
    expect((engine.scaleFor(st.ws, 'FSC-A', cy.id) as { max: number }).max).toBeGreaterThan(5e7);
    const t = st.ui.toasts.find((x) => /own axis scales/.test(x.text));
    expect(t).toBeDefined();
    // the scales belong to the load's undo step (as its toast says: "removes it again in one step"): one Undo removes
    // the loaded file and its instrument scales (and says so)
    expect(t?.action).toBeUndefined();
    useStore.getState().undo();
    expect(useStore.getState().ws.instrumentScales).toBeUndefined();
    expect(useStore.getState().ws.samples.map((s) => s.name)).toEqual(['bd']);
    expect(useStore.getState().ui.toasts.some((x) => /Undo removed the sample 'cy'/.test(x.text))).toBe(true);
  });
});

describe('loading files: one undo step, stable active sample', () => {
  it('several files are one step; redo brings back the sample that was active', async () => {
    reset();
    await loadFcsFiles([file('a.fcs', 2500, 262144, 'LSRII'), file('b.fcs', 2600, 262144, 'LSRII'), file('c.fcs', 2700, 262144, 'LSRII')]);
    const st = useStore.getState();
    expect(st.ws.samples.length).toBe(3);
    const c = st.ws.samples[2].id;
    st.setUI({ activeSampleId: c, selectedSampleIds: [c] });
    // an edit after the load, then undo twice: the edit, then the whole load
    st.update((w) => {
      w.name = 'edited';
    });
    useStore.getState().undo();
    expect(useStore.getState().ws.samples.length).toBe(3);
    useStore.getState().undo();
    expect(useStore.getState().ws.samples.length).toBe(0);
    useStore.getState().redo();
    expect(useStore.getState().ws.samples.length).toBe(3);
    expect(useStore.getState().ui.activeSampleId).toBe(c);
  });
});

describe('new workspace', () => {
  it('goes back to the worksheet and drops unmixing drafts; a draft is made only when asked for', () => {
    reset();
    openUnmixView();
    expect(useStore.getState().ui.view).toBe('unmix');
    useDrafts.getState().setDraft({ id: 'unmix_x', name: 'Spectral unmixing', detectors: [], method: 'ols', nonNegative: false, includeAF: false, afMode: 'best', residual: 'none', setup: { v: 1, controls: [], scope: 'root', unstainedId: null, afK: 1 } });
    useStore.getState().replaceWorkspace(emptyWorkspace());
    expect(useStore.getState().ui.view).toBe('sheet');
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([]);
    expect(useDrafts.getState().autoRequested).toBe(false);
  });
});

describe('readable messages and labels', () => {
  it('MESF: bead labels and rounded medians in warnings', () => {
    const f = fitMesf([-151.72500610351562, 93.93, 1098, 3002], [150, 600, 2400, 9600], { labels: ['P1', 'P2', 'P3', 'P4'] });
    expect(f.warnings.join(' ')).toMatch(/^P1: median -151\.7 is not above 0/);
    expect(f.warnings.join(' ')).not.toMatch(/151\.725/);
  });

  it('charts: groups without values are left out; the y title names the statistic', () => {
    const eng = new Engine();
    eng.addSample('a', ds(['FSC-A', 'APC-A'], [[1, 2, 3, 4], [10, 20, 30, 40]]));
    eng.addSample('b', ds(['FSC-A'], [[1, 2, 3, 4]]));
    const ws = emptyWorkspace();
    ws.samples = [
      { id: 'a', name: 'a', fileName: 'a.fcs', fileSize: 0, eventCount: 4, channels: [{ name: 'FSC-A', label: '', range: 1 }, { name: 'APC-A', label: 'CD69', range: 1 }], compId: null },
      { id: 'b', name: 'b', fileName: 'b.fcs', fileSize: 0, eventCount: 4, channels: [{ name: 'FSC-A', label: '', range: 1 }], compId: null },
    ];
    ws.groups = [
      { id: 'g1', name: 'BD', sampleIds: ['a'] },
      { id: 'g2', name: 'CytoFLEX', sampleIds: ['b'] },
    ];
    const item: ChartItem = { id: 'c', kind: 'chart', x: 0, y: 0, w: 100, h: 80, stat: { id: 's', population: 'root', stat: 'median', channel: 'APC-A' }, mode: 'groups', sampleSet: 'all', style: 'dot', errorBars: 'sd', showPoints: true, color: '#000', useGroupColors: true, fontSize: 8, lineWidth: 1 };
    const env = { ws, engine: eng, activeSampleId: 'a', rasterScale: 1, makeCanvas: () => null } as unknown as RenderEnv;
    expect(chartData(item, env).map((b) => b.label)).toEqual(['BD']);
    expect(statAxisLabel(item, env)).toBe('Median CD69 (APC-A)');
    expect(statAxisLabel({ ...item, stat: { id: 's', population: 'root', stat: 'freqParent' } }, env)).toBe('% of parent');
  });

  it('bitmap exports cover whole pixels (rounded up)', () => {
    expect(rasterSize({ w: 1122.52, h: 793.7 }, 96)).toMatchObject({ w: 1123, h: 794 });
    expect(rasterSize({ w: 96, h: 48 }, 300)).toMatchObject({ w: 300, h: 150 });
  });

  it('size outputs carry their unit in the channel name', () => {
    const ws = emptyWorkspace();
    ws.derived = [
      {
        id: 'sz',
        kind: 'size',
        name: 'SSC size',
        channel: 'SSC-A',
        nm2PerAu: 0.003,
        setup: {} as never,
        model: {} as never,
        outputs: [
          { name: 'SSC diameter', range: 1000 },
          { name: 'SSC σ', range: 1000 },
        ],
      },
    ];
    expect(channelDisplayName(ws, 'SSC diameter')).toBe('SSC diameter (nm)');
    expect(channelDisplayName(ws, 'SSC σ')).toBe('SSC σ (nm²)');
  });

  it('nanoscale instruments: $CYT or the numbered violet side scatters', () => {
    expect(isNanoscaleData({ keywords: { $CYT: 'CytoFLEX nano' }, channels: [] })).toBe(true);
    expect(isNanoscaleData({ keywords: {}, channels: [{ name: 'SSC-A', label: 'VSSC1-A', range: 1 }] as FcsDataset['channels'] })).toBe(true);
    expect(isNanoscaleData({ keywords: { $CYT: 'CytoFLEX LX' }, channels: [{ name: 'VSSC-A', label: 'VSSC-A', range: 1 }] as FcsDataset['channels'] })).toBe(false);
  });
});

describe('unmixing: signal the controls do not explain', () => {
  const dir = '/home/claude/testdata/online/zenodo_17457137_aurora_refctrl/';
  const files = ['Reference Group-A5 CD206 PE (Beads).fcs', 'Reference Group-B4 CD8 FITC (Beads).fcs', 'SFV-IFNg_PDT_007.fcs'];
  it.skipIf(!files.every((f) => existsSync(dir + f)))('flags a fully stained sample against three single-stain controls, not a matching one', () => {
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    const read = (f: string) => {
      const b = readFileSync(dir + f);
      return parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    };
    const [pe, fitc, full] = files.map(read);
    engine.addSample('pe', pe);
    engine.addSample('fitc', fitc);
    engine.addSample('full', full);
    engine.addSample('pe2', pe); // a sample stained like a control: explained
    const det = defaultDetectors(pe);
    const set = (d: FcsDataset): EventSet => ({ columns: d.data, detectorIndex: resolveDetectors({ detectors: det }, d.channels.map((c) => c.name)) });
    const def = createUnmixDef({ detectors: det, endmembers: [signatureFromControl(set(pe), { name: 'PE' }).endmember, signatureFromControl(set(fitc), { name: 'FITC' }).endmember] });
    const ws = emptyWorkspace();
    ws.samples = ['pe', 'fitc', 'full', 'pe2'].map((id) => ({ id, name: id, fileName: id + '.fcs', fileSize: 0, eventCount: engine.eventCount(id), channels: [], compId: null }));
    const r = residualCheck(ws, def, ['pe', 'fitc'], null)!;
    expect(r.checked).toBe(2);
    expect(r.flags.map((f) => f.sampleId)).toEqual(['full']);
    expect(r.flags[0].ratio).toBeGreaterThan(5);
  });
});
