// QC fixes: statistics on derived channels (NaN), number formatting, MESF linear fits, "% of" references, channel
// display names, missing-channel reasons, derived dependents / name collisions, Gating-ML export of derived channels
// and FlowJo biex axes, compensation merge, unmixing controls without a stained population, reports.
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { DerivedDef, MesfDerived } from '../src/core/derived';
import { Engine, engine } from '../src/core/engine';
import { parseFcs, type FcsDataset } from '../src/core/fcs';
import { allIndices } from '../src/core/gating';
import { exportGatingMLDoc, importGatingML } from '../src/core/gatingml';
import { toMesf } from '../src/core/mesf';
import { channelDisplayName, emptyWorkspace, isAncestorPop, missingChannelReason, sampleHasChannel, type Population, type Workspace } from '../src/core/model';
import { channelStats, excludedNote, formatStat, statFromChannel } from '../src/core/stats';
import { flowJoBiexDef, makeScale } from '../src/core/transforms';
import { derivedDependents, derivedNameCollisions, freeChannelName, removeDerived } from '../src/state/derivedOps';
import { useStore } from '../src/state/store';
import { mergeSpillover } from '../src/ui/CompView';
import { kitPatternHints, mesfOutputLabel } from '../src/ui/calib/MesfPage';
import { sizeReportText, sizeReportCsv } from '../src/ui/calib/report';
import type { SizeDef } from '../src/ui/calib/util';
import { annotateAfSimilarity, computeRow, cosine, stainedFraction, unstainedSet, type RowResult } from '../src/ui/unmix/compute';
import { newDraft } from '../src/ui/unmix/draft';
import { spreadToCsv } from '../src/ui/unmix/helpers';
import { EV_MODEL } from '../src/core/scattercal';

function ds(names: string[], cols: number[][]): FcsDataset {
  return { channels: names.map((name) => ({ name, label: '', range: 262144 })), data: cols.map((c) => Float32Array.from(c)), eventCount: cols[0].length, keywords: {} } as unknown as FcsDataset;
}

describe('channel statistics leave out events without a value', () => {
  const v = Float32Array.from([1, 2, NaN, 3, 4, NaN, Infinity, 5, -Infinity, 6]);
  const idx = allIndices(v.length);
  const cs = channelStats(v, idx, { type: 'linear', min: 0, max: 10 });
  const ref = [1, 2, 3, 4, 5, 6];
  it('counts valid and excluded events', () => {
    expect(cs.nEvents).toBe(10);
    expect(cs.n).toBe(6);
    expect(cs.excluded).toBe(4);
    expect(Array.from(cs.sorted)).toEqual(ref);
  });
  it('mean, median, SD, CV, geomean, min, max, percentiles and mode are those of the finite values', () => {
    expect(cs.mean).toBeCloseTo(3.5, 12);
    expect(cs.median).toBeCloseTo(3.5, 12);
    expect(cs.sd).toBeCloseTo(Math.sqrt(17.5 / 5), 6);
    expect(cs.cv).toBeCloseTo((100 * Math.sqrt(3.5)) / 3.5, 6);
    expect(cs.geomean).toBeCloseTo(Math.pow(720, 1 / 6), 6);
    expect(cs.min).toBe(1);
    expect(cs.max).toBe(6);
    expect(statFromChannel(cs, 'percentile', 0)).toBe(1);
    expect(statFromChannel(cs, 'percentile', 100)).toBe(6);
    expect(Number.isFinite(cs.mode)).toBe(true);
    expect(cs.mode).toBeGreaterThanOrEqual(1);
    expect(cs.mode).toBeLessThanOrEqual(6);
    for (const k of ['rsd', 'rcv'] as const) expect(Number.isFinite(cs[k])).toBe(true);
  });
  it('all-NaN population: NaN statistics and a note', () => {
    const z = channelStats(Float32Array.from([NaN, NaN]), allIndices(2));
    expect(z.n).toBe(0);
    expect(z.excluded).toBe(2);
    expect(Number.isNaN(z.mean) && Number.isNaN(z.median) && Number.isNaN(z.max)).toBe(true);
    expect(excludedNote(z)).toMatch(/Based on 0 of 2 events/);
    expect(excludedNote(channelStats(Float32Array.from([1, 2]), allIndices(2)))).toBeNull();
  });
  it('engine statistics on an MESF channel (log fit): MFI <= 0 counts as 0, not as a missing value', () => {
    // Updated with the QC fix of MESF order statistics: the events at or below 0 MFI used to be NaN and were left out
    // (excluded 2, mean over the 4 positive events), which biased medians / percentiles of dim populations upwards.
    // They are now 0 (the limit of the power law) and keep their rank.
    const e = new Engine();
    e.addSample('s', ds(['FL1-A'], [[-50, 0, 100, 200, 400, 800]]));
    const ws = emptyWorkspace();
    ws.samples = [{ id: 's', name: 's', fileName: 's', fileSize: 0, eventCount: 6, channels: [{ name: 'FL1-A', label: '', range: 262144 }], compId: null }];
    const def: MesfDerived = { id: 'm', kind: 'mesf', name: 'm', channel: 'FL1-A', unit: 'MESF', fit: { method: 'log', slope: 1, intercept: 1, r2: 1 }, outputs: [{ name: 'FL1-A MESF', range: 1e7 }] };
    ws.derived = [def];
    const col = { population: 'root', channel: 'FL1-A MESF' };
    expect(e.stat(ws, 's', { ...col, stat: 'mean' })).toBeCloseTo(((100 + 200 + 400 + 800) * 10) / 6, 6);
    expect(e.stat(ws, 's', { ...col, stat: 'median' })).toBeCloseTo(1500, 6);
    expect(e.stat(ws, 's', { ...col, stat: 'max' })).toBeCloseTo(8000, 6);
    expect(e.stat(ws, 's', { ...col, stat: 'geomean' })).toBeCloseTo(Math.pow(1000 * 2000 * 4000 * 8000, 1 / 4), 3);
    expect(e.channelStats(ws, 's', 'root', 'FL1-A MESF')!.excluded).toBe(0);
  });
});

describe('number formatting of statistics', () => {
  it('grouped integers, fixed decimals, scientific only from 1e9', () => {
    expect(formatStat(713912.4, 'median')).toBe('713,912');
    expect(formatStat(-713912.4, 'mean')).toBe('-713,912');
    expect(formatStat(123.456, 'median')).toBe('123');
    expect(formatStat(12.3456, 'median')).toBe('12.35');
    expect(formatStat(0.012345, 'median')).toBe('0.0123');
    expect(formatStat(0, 'median')).toBe('0');
    expect(formatStat(7.139e9, 'median')).toBe('7.14×10⁹');
    expect(formatStat(2.5e-5, 'sd')).toBe('2.50×10⁻⁵');
    expect(formatStat(1234567, 'count')).toBe('1,234,567');
    expect(formatStat(45.678, 'freqParent')).toBe('45.7');
    expect(formatStat(NaN, 'median')).toBe('–');
    expect(formatStat(5e5, 'concentration')).toBe('500,000');
  });
});

describe('MESF conversion of non-positive MFI', () => {
  it('linear fits convert every finite MFI; log fits give NaN (or 0) for MFI <= 0', () => {
    const lin = toMesf({ method: 'linear', slope: 2, intercept: 10 }, Float32Array.from([-5, 0, 5, NaN, Infinity]));
    expect(Array.from(lin.slice(0, 3))).toEqual([0, 10, 20]);
    expect(Number.isNaN(lin[3]) && Number.isNaN(lin[4])).toBe(true);
    const lg = toMesf({ method: 'log', slope: 1, intercept: 1 }, Float32Array.from([-5, 0, 5, NaN]));
    expect(Number.isNaN(lg[0]) && Number.isNaN(lg[1]) && Number.isNaN(lg[3])).toBe(true);
    expect(lg[2]).toBeCloseTo(50, 4);
    const zero = toMesf({ method: 'weightedLog', slope: 1, intercept: 1 }, Float32Array.from([-5, NaN]), { nonPositive: 'zero' });
    expect(zero[0]).toBe(0);
    expect(Number.isNaN(zero[1])).toBe(true);
  });
});

function popWs(): Workspace {
  const ws = emptyWorkspace();
  const p = (id: string, parentId: string | null, min: number): Population => ({ id, name: id, parentId, color: '#000', gate: { type: 'range', x: 'FL1-A', min, max: Infinity } });
  ws.populations = [p('A', null, 0), p('B', 'A', 100), p('C', 'B', 300), p('D', null, 500)];
  ws.samples = [{ id: 's', name: 's', fileName: 's', fileSize: 0, eventCount: 6, channels: [{ name: 'FL1-A', label: '', range: 262144 }], compId: null }];
  return ws;
}

describe('"% of" statistics need an ancestor', () => {
  it('isAncestorPop and NaN for a reference that is not an ancestor', () => {
    const ws = popWs();
    expect(isAncestorPop(ws, 'root', 'C')).toBe(true);
    expect(isAncestorPop(ws, 'A', 'C')).toBe(true);
    expect(isAncestorPop(ws, 'B', 'C')).toBe(true);
    expect(isAncestorPop(ws, 'C', 'C')).toBe(false);
    expect(isAncestorPop(ws, 'D', 'C')).toBe(false);
    const e = new Engine();
    e.addSample('s', ds(['FL1-A'], [[-50, 50, 150, 350, 600, 900]]));
    expect(e.stat(ws, 's', { population: 'C', stat: 'freqOf', ofPopulation: 'A' })).toBeCloseTo(60, 10);
    // D (3 events) is not an ancestor of C (3 events of which 2 in D): no "119 %"-like values
    expect(Number.isNaN(e.stat(ws, 's', { population: 'C', stat: 'freqOf', ofPopulation: 'D' }))).toBe(true);
  });
});

describe('channel display names', () => {
  it('do not repeat label and name when one contains the other', () => {
    const ws = emptyWorkspace();
    ws.samples = [{ id: 's', name: 's', fileName: 's', fileSize: 0, eventCount: 1, channels: [{ name: 'PE-A', label: 'CD4', range: 1 }, { name: 'FL1-A', label: 'FL1', range: 1 }], compId: null }];
    ws.derived = [
      { id: 'm', kind: 'mesf', name: 'm', channel: 'FITC-A', unit: 'MESF', fit: { method: 'log', slope: 1, intercept: 0, r2: 1 }, outputs: [{ name: 'FITC-A MESF', label: 'FITC-A (MESF)', range: 1 }] },
      { id: 'z', kind: 'size', name: 'z', channel: 'VSSC1-A', nm2PerAu: 1, setup: { wavelengthNm: 405, nMedium: 1.34, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 50 } }, model: EV_MODEL, outputs: [{ name: 'VSSC1-A diameter (nm)', label: 'Diameter (nm), EV (core 1.38 / shell 1.48, 5 nm)', range: 1 }] },
    ] as DerivedDef[];
    expect(channelDisplayName(ws, 'PE-A')).toBe('CD4 (PE-A)');
    expect(channelDisplayName(ws, 'FL1-A')).toBe('FL1-A');
    expect(channelDisplayName(ws, 'FITC-A MESF')).toBe('FITC-A MESF');
    expect(channelDisplayName(ws, 'VSSC1-A diameter (nm)')).toBe('VSSC1-A diameter (nm)');
    expect(channelDisplayName(ws, 'VSSC1-A diameter (nm)', 'label')).toBe('Diameter (nm)');
    expect(mesfOutputLabel('FITC-A MESF', 'FITC-A', 'MESF')).toBeUndefined();
    expect(mesfOutputLabel('CD4 calibrated', 'FITC-A', 'MESF')).toBe('FITC-A MESF');
  });
});

describe('derived channels: availability, dependents, names', () => {
  const unmixDef = (): DerivedDef =>
    ({
      id: 'u',
      kind: 'unmix',
      name: 'Unmix',
      outputs: [{ name: 'FITC', range: 1e5 }],
      unmix: { detectors: ['B1-A', 'B2-A'], endmembers: [{ name: 'FITC', signature: [1, 0.2] }], method: 'ols', includeAF: false } as never,
    }) as DerivedDef;
  const mesfOn = (id: string, ch: string, out: string): DerivedDef => ({ id, kind: 'mesf', name: out, channel: ch, unit: 'MESF', fit: { method: 'log', slope: 1, intercept: 0, r2: 1 }, outputs: [{ name: out, range: 1e7 }] });
  const ws0 = (): Workspace => {
    const ws = emptyWorkspace();
    ws.samples = [
      { id: 'a', name: 'beads', fileName: 'a', fileSize: 0, eventCount: 1, channels: [{ name: 'B1-A', label: '', range: 1 }, { name: 'B2-A', label: '', range: 1 }], compId: null },
      { id: 'b', name: 'other', fileName: 'b', fileSize: 0, eventCount: 1, channels: [{ name: 'B1-A', label: '', range: 1 }], compId: null },
    ];
    ws.derived = [unmixDef(), mesfOn('m', 'FITC', 'FITC MESF'), mesfOn('m2', 'FITC MESF', 'FITC MESF x')];
    return ws;
  };
  it('sampleHasChannel follows chained definitions', () => {
    const ws = ws0();
    expect(sampleHasChannel(ws, 'a', 'FITC')).toBe(true);
    expect(sampleHasChannel(ws, 'a', 'FITC MESF')).toBe(true);
    expect(sampleHasChannel(ws, 'b', 'FITC MESF')).toBe(false);
  });
  it('missingChannelReason explains why a channel has no values', () => {
    const ws = ws0();
    expect(missingChannelReason(ws, 'FITC MESF', 'b')).toMatch(/needs FITC, missing here/);
    expect(missingChannelReason(ws, 'B2-A', 'b')).toBe('B2-A not measured in this sample');
    expect(missingChannelReason(ws, 'Gone MESF', 'b')).toBe('Gone MESF is not available (calibration/unmixing removed)');
  });
  it('derivedDependents and removal with or without dependents', () => {
    const ws = ws0();
    expect(derivedDependents(ws, 'u').map((d) => d.id)).toEqual(['m', 'm2']);
    expect(derivedDependents(ws, 'm').map((d) => d.id)).toEqual(['m2']);
    useStore.getState().replaceWorkspace(ws);
    removeDerived('u');
    expect(useStore.getState().ws.derived!.map((d) => d.id)).toEqual(['m', 'm2']);
    useStore.getState().replaceWorkspace(ws0());
    removeDerived('u', { withDependents: true });
    expect(useStore.getState().ws.derived).toEqual([]);
  });
  it('new output names avoid measured channels of every sample; collisions are listed', () => {
    const ws = ws0();
    ws.samples[1].channels.push({ name: 'FITC MESF', label: '', range: 1 });
    useStore.getState().replaceWorkspace(ws);
    expect(freeChannelName('FITC MESF', 'm')).toBe('FITC MESF 2');
    expect(freeChannelName('B1-A')).toBe('B1-A 2');
    expect(derivedNameCollisions(useStore.getState().ws)).toEqual([{ sample: 'other', channel: 'FITC MESF', def: 'FITC MESF' }]);
  });
  it('warns once when a newly added sample measures a channel named like a computed output', () => {
    useStore.getState().replaceWorkspace(ws0());
    const n0 = useStore.getState().ui.toasts.length;
    const add = (id: string) =>
      useStore.getState().update((w) => {
        w.samples.push({ id, name: id, fileName: id, fileSize: 0, eventCount: 1, channels: [{ name: 'FITC MESF', label: '', range: 1 }], compId: null });
      });
    add('re-exported');
    const t = useStore.getState().ui.toasts.slice(n0);
    expect(t.length).toBe(1);
    expect(t[0].text).toMatch(/"re-exported" measures "FITC MESF", the name of a computed channel/);
    useStore.getState().update((w) => void (w.name = 'x'));
    expect(useStore.getState().ui.toasts.length).toBe(n0 + 1);
  });
});

describe('Gating-ML export', () => {
  const N = 20000;
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const fl1: number[] = [];
  const fl2: number[] = [];
  for (let i = 0; i < N; i++) {
    const k = i % 3;
    const m = [[0, 0], [3000, 200], [30000, 20000]][k];
    fl1.push(m[0] + (k ? m[0] * 0.4 : 150) * gauss() * (k === 0 && i % 7 === 0 ? 8 : 1));
    fl2.push(m[1] + (k === 2 ? m[1] * 0.4 : 120) * gauss());
  }
  const biex = flowJoBiexDef({ neg: 0, width: -100, pos: 4.418539922, max: 262144 });
  function setup(): { ws: Workspace; e: Engine } {
    const e = new Engine();
    e.addSample('s', ds(['FL1-A', 'FL2-A'], [fl1, fl2]));
    const ws = emptyWorkspace();
    ws.samples = [{ id: 's', name: 's', fileName: 's', fileSize: 0, eventCount: N, channels: ['FL1-A', 'FL2-A'].map((name) => ({ name, label: '', range: 262144 })), compId: null }];
    ws.scales = { 'FL1-A': biex, 'FL2-A': flowJoBiexDef({ neg: 0, width: -100, pos: 4.418539922, max: 262144 }) };
    const S = (ch: string) => makeScale(ws.scales[ch]);
    const P = (pts: [number, number][]) => pts.map(([u, v]) => [S('FL1-A').inv(u), S('FL2-A').inv(v)] as [number, number]);
    const c = [S('FL1-A').inv(0.55), S('FL2-A').inv(0.55)] as [number, number];
    ws.populations = [
      { id: 'p1', name: 'Tri', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FL1-A', y: 'FL2-A', points: P([[0.05, 0.08], [0.5, 0.05], [0.3, 0.5]]) } },
      { id: 'p2', name: 'Left', parentId: null, color: '#000', gate: { type: 'polygon', x: 'FL1-A', y: 'FL2-A', points: P([[-0.004, 0.2], [0.35, 0.3], [0.3, 0.8], [-0.004, 0.9]]) } },
      { id: 'p3', name: 'Ell', parentId: null, color: '#000', gate: { type: 'ellipse', x: 'FL1-A', y: 'FL2-A', center: c, a: [S('FL1-A').inv(0.75), S('FL2-A').inv(0.62)], b: [S('FL1-A').inv(0.5), S('FL2-A').inv(0.7)] } },
    ];
    return { ws, e };
  }
  it('gates on FlowJo biex axes: the exported logicle polygons select the same events', () => {
    const { ws, e } = setup();
    const doc = exportGatingMLDoc(ws);
    expect(doc.warnings.join(' ')).toMatch(/FlowJo biex/);
    expect(doc.xml).not.toContain('EllipsoidGate');
    const imp = importGatingML(doc.xml);
    const ws2: Workspace = { ...ws, populations: imp.populations, scales: { ...ws.scales } };
    for (const p of ws.populations) {
      const q = imp.populations.find((x) => x.name === p.name)!;
      const a = e.count(ws, 's', p.id);
      const b = e.count(ws2, 's', q.id);
      expect(a).toBeGreaterThan(100);
      expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(1, Math.round(a * 1e-4)));
    }
  });
  it('warns per gate on computed channels', () => {
    const { ws } = setup();
    ws.derived = [{ id: 'm', kind: 'mesf', name: 'm', channel: 'FL1-A', unit: 'MESF', fit: { method: 'log', slope: 1, intercept: 0, r2: 1 }, outputs: [{ name: 'FL1-A MESF', range: 1e7 }] }];
    ws.populations.push({ id: 'p4', name: 'Bright', parentId: null, color: '#000', gate: { type: 'range', x: 'FL1-A MESF', min: 1e4, max: Infinity } });
    const doc = exportGatingMLDoc(ws);
    expect(doc.warnings).toContain('Gate "Bright" uses computed channel "FL1-A MESF", which other programs cannot evaluate; export the population as FCS instead.');
  });
});

describe('compensation from controls merges into the current matrix', () => {
  it('keeps detectors without a control', () => {
    const base = { channels: ['A', 'B', 'C', 'D'], matrix: [[1, 0.1, 0.2, 0.3], [0.01, 1, 0.02, 0.03], [0, 0.4, 1, 0.5], [0.06, 0.07, 0.08, 1]] };
    const comp = { channels: ['B', 'C', 'E'], matrix: [[1, 0.9, 0.8], [0.7, 1, 0.6], [0.5, 0.4, 1]] };
    const m = mergeSpillover(base, comp);
    expect(m.channels).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(m.kept).toEqual(['A', 'D']);
    const at = (r: string, c: string) => m.matrix[m.channels.indexOf(r)][m.channels.indexOf(c)];
    expect(at('B', 'C')).toBe(0.9); // from the controls
    expect(at('C', 'B')).toBe(0.7);
    expect(at('B', 'E')).toBe(0.8);
    expect(at('A', 'B')).toBe(0.1); // kept
    expect(at('B', 'D')).toBe(0.03); // control fluor into a detector without a control: kept
    expect(at('A', 'E')).toBe(0); // unknown
    expect(at('E', 'E')).toBe(1);
    expect(mergeSpillover(null, comp).channels).toEqual(['B', 'C', 'E']);
  });
});

const BD = '/home/claude/testdata/comp';
describe.skipIf(!existsSync(BD))('unmixing: a "control" without a stained population', () => {
  it('is a row error that can be overridden; real controls pass', () => {
    const ws = emptyWorkspace();
    const load = (f: string, id: string) => {
      const b = readFileSync(join(BD, f));
      const d = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      engine.addSample(id, d);
      ws.samples.push({ id, name: id, fileName: f, fileSize: 0, eventCount: d.eventCount, channels: d.channels.map((c) => ({ name: c.name, label: c.label, range: c.range })), compId: null });
    };
    for (const f of readdirSync(BD).filter((x) => x.endsWith('.fcs'))) load(f, f.replace('.fcs', ''));
    // a second copy of the unstained file posing as a control
    load('Compensation-Unstained.fcs', 'Fake-BV421');
    useStore.getState().replaceWorkspace(ws);
    const draft = newDraft(ws);
    draft.setup.unstainedId = 'Compensation-Unstained';
    draft.setup.controls = ['Compensation-FITC', 'Compensation-7AAD', 'Fake-BV421'].map((id, i) => ({ key: 'k' + i, sampleId: id, name: id, pos: 'auto', neg: 'auto', color: i }));
    const { un } = unstainedSet(ws, draft);
    expect(un).toBeTruthy();
    const rows = draft.setup.controls.map((c, i) => computeRow(ws, draft, c, i, undefined, un));
    expect(rows[0].kind).toBe('ok');
    expect(rows[1].kind).toBe('ok'); // 7-AAD: dim, ~2.5 % positive cells, still a stained population
    expect(rows[2].kind).toBe('error');
    expect(rows[2].overridable).toBe('weak');
    expect(rows[2].error).toMatch(/No stained population/);
    const forced = computeRow(ws, draft, { ...draft.setup.controls[2], allowWeak: true }, 2, undefined, un);
    expect(forced.kind).toBe('ok');
    expect(forced.warnings[0]).toMatch(/override/);
    const ctl = { columns: engine.samples.get('Compensation-FITC')!.ds.data, detectorIndex: un!.detectorIndex, idx: null };
    expect(stainedFraction(ctl, un!, rows[0].peak!)).toBeGreaterThan(0.1);
    // whole positive population instead of the brightest 3 %
    const all = computeRow(ws, { ...draft, setup: { ...draft.setup, posMode: 'all' } }, draft.setup.controls[0], 0, undefined, un);
    expect(all.nPos!).toBeGreaterThan(2 * rows[0].nPos!);
    expect(cosine(all.signature!, rows[0].signature!)).toBeGreaterThan(0.99);
    // a removed unstained sample is not used even though the engine still holds its data
    const gone = unstainedSet({ ...ws, samples: ws.samples.filter((s) => s.id !== 'Compensation-Unstained') }, draft);
    expect(gone.un).toBeNull();
    expect(gone.unError).toMatch(/removed/);
  });
  it('warns when a spectrum is almost the autofluorescence spectrum', () => {
    const rows: Record<string, RowResult> = { a: { kind: 'ok', warnings: [], signature: [1, 0.5, 0.2] }, b: { kind: 'ok', warnings: [], signature: [0, 0.1, 1] } };
    const out = annotateAfSimilarity(rows, { kind: 'computed', endmembers: [{ name: 'AF', signature: [1, 0.52, 0.21] }], warnings: [] });
    expect(out.a.warnings.join()).toMatch(/very similar to autofluorescence/);
    expect(out.b).toBe(rows.b);
    expect(rows.a.warnings).toEqual([]);
  });
  it('spreading matrix CSV', () => {
    const csv = spreadToCsv(['FITC', 'PE', 'AF'], [0, 1], [[0, 1.5, 0.2], [0.3, 0, NaN]], [[0, 0.01, 0], [0.02, 0, 0]]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('Spreading (row spreads into column),FITC,PE,AF');
    expect(lines[1]).toBe('FITC,,1.5,0.2');
    expect(lines[2]).toBe('PE,0.3,,');
    expect(lines[4]).toMatch(/^Leakage/);
  });
});

describe('calibration hints and reports', () => {
  it('kit pattern hints', () => {
    const fit = { points: [{ index: 0, used: true, residualPct: 2 }, { index: 1, used: true, residualPct: -60 }] } as never;
    const h = kitPatternHints('"Kit"', { k: 3, nCandidates: 7, matched: true, fit }, ['P1', 'P2', 'P3'], [1, 2]);
    expect(h[0]).toMatch(/7 bead-like peaks but "Kit" has 3/);
    expect(h[1]).toMatch(/P3 -60 %/);
  });
  it('size report: valid range end, resolution, noise limit and poor-fit confirmation', () => {
    const def: SizeDef = {
      id: 's',
      kind: 'size',
      name: 'VSSC1-A size',
      channel: 'VSSC1-A',
      nm2PerAu: 0.00365,
      setup: { wavelengthNm: 405, nMedium: 1.343, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 53.2 } },
      model: EV_MODEL,
      rangeNm: [46, 1500],
      minLogSlope: 0.5,
      outputs: [{ name: 'VSSC1-A diameter (nm)', range: 347 }],
      fit: {
        method: 'cv',
        halfAngleDeg: 53.2,
        r2Log: 0.99,
        cvPct: 14,
        beads: [],
        validRangeNm: [46, 347],
        endsAtFlat: true,
        minLogSlope: 0.5,
        rangeFromNoise: true,
        resolution: [{ diameterNm: 46, pctPerPct: 0.17 }, { diameterNm: 347, pctPerPct: 1.98 }],
        poorFit: { cvPct: 14, maxResidualPct: 22, confirmed: true },
      },
    };
    const txt = sizeReportText(def);
    expect(txt).toMatch(/WARNING: poor bead fit/);
    expect(txt).toMatch(/turns flat \(log-log slope of σ\(d\) below 0.50\)/);
    expect(txt).toMatch(/noise-equivalent diameter/);
    expect(txt).toMatch(/347 nm 1.98 %/);
    expect(txt).not.toMatch(/[—–]/);
    const csv = sizeReportCsv(def);
    expect(csv).toMatch(/Inversion range from the noise level/);
    expect(csv).toMatch(/Size error per 1 % scatter error at 347 nm/);
  });
});
