// Fixes from the validation against public data: FlowJo parameter names with "/" (written as "_"), relinking FCS files
// whose names differ from the workspace's, the "axes of another instrument" note, automatic positive selection of
// spectral bead controls, detector saturation and per-detector factors in size calibration.
// Real-data checks run when the downloaded files are present (/home/claude/testdata/online).
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { engine } from '../src/core/engine';
import { parseFcs, writeFcs, type FcsDataset } from '../src/core/fcs';
import { flowJoChannelRenames, flowJoSafeName, renameWorkspaceChannels } from '../src/core/flowjo';
import { emptyWorkspace, popPath, type SampleRef, type Workspace } from '../src/core/model';
import { apertureCrossSections, detectPileUp, fitCollectionAngle, sweepConstraint } from '../src/core/scattercal';
import { autoSelectPopulations, defaultDetectors, fluorPeakHint, resolveDetectors, scatterGate, type EventSet } from '../src/core/unmix';
import { getBeadKit } from '../src/core/beads';
import { findBeadPeaks } from '../src/core/mesf';
import { openFiles } from '../src/io/files';
import { gateChannelsMissing, loadFcsFiles, matchByContent, otherInstrument, scaleMismatches, useStore } from '../src/state/store';
import { assignPeaks, rowsFromKit } from '../src/ui/calib/logic';
import { defaultSetChannel, suggestedHalfAngle } from '../src/ui/calib/SizePage';
import { positiveLogScale, positiveOnly, defaultMediumRI } from '../src/ui/calib/util';
import { annotateSharedPeaks, type RowResult } from '../src/ui/unmix/compute';

const ONLINE = '/home/claude/testdata/online';
const toBuf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const fileOf = (b: Uint8Array | string, name: string) => new File([(typeof b === 'string' ? b : b) as BlobPart], name);

function reset(ws?: Workspace) {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(ws ?? emptyWorkspace());
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [], dialog: null, flowjoCounts: null } });
}
const toasts = () => useStore.getState().ui.toasts.map((t) => t.text);

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// ------------------------------------------------------------------ FlowJo names with "/"

const N = 2000;
/** FCS with FSC-A, FL1-A and "LIVE/DEAD Aqua-A" (raw: LIVE/DEAD observed = true + 0.1 x FL1). */
function liveDeadFcs(opts: { fil: string; n?: number; seed?: number; cyt?: string; scale?: number; extraKw?: Record<string, string> }): Uint8Array {
  const n = opts.n ?? N;
  const r = rng(opts.seed ?? 11);
  const k = opts.scale ?? 1;
  const fsc = Float32Array.from({ length: n }, () => r() * 1000 * k);
  const fl1 = Float32Array.from({ length: n }, () => r() * 1000 * k);
  const ld = Float32Array.from({ length: n }, (_, i) => (r() < 0.3 ? 600 + r() * 400 : r() * 400) * k + 0.1 * fl1[i]);
  return writeFcs({
    channels: [
      { name: 'FSC-A', range: 1024 * k },
      { name: 'FL1-A', range: 1024 * k },
      { name: 'LIVE/DEAD Aqua-A', range: 1024 * k },
    ],
    data: [fsc, fl1, ld],
    keywords: { $FIL: opts.fil, ...(opts.cyt ? { $CYT: opts.cyt } : {}), ...(opts.extraKw ?? {}) },
  });
}

const NS =
  'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';
const dim = (n: string, min?: number, max?: number) =>
  `<gating:dimension${min !== undefined ? ` gating:min="${min}"` : ''}${max !== undefined ? ` gating:max="${max}"` : ''}><data-type:fcs-dimension data-type:name="${n}"/></gating:dimension>`;

/** FlowJo 10 workspace as FlowJo writes it for a file with "LIVE/DEAD Aqua-A": "_" in keywords, matrix, transform and gates. */
function wsp(samples: { id: number; uri: string; fil: string; tot: number }[], gateCh = 'Comp-LIVE_DEAD Aqua-A'): string {
  const kw = (s: { fil: string; tot: number }) =>
    [
      ['$PAR', '3'],
      ['$TOT', String(s.tot)],
      ['$FIL', s.fil],
      ['$P1N', 'FSC-A'],
      ['$P1R', '1024'],
      ['$P2N', 'FL1-A'],
      ['$P2R', '1024'],
      ['$P3N', 'LIVE_DEAD Aqua-A'],
      ['$P3R', '1024'],
    ]
      .map(([k, v]) => `<Keyword name="${k}" value="${v}"/>`)
      .join('');
  const sample = (s: { id: number; uri: string; fil: string; tot: number }) => `<Sample>
  <DataSet uri="file:/D:/data/${encodeURIComponent(s.uri)}" sampleID="${s.id}"/>
  <transforms:spilloverMatrix spectral="0" prefix="Comp-" name="Comp" suffix="">
    <data-type:parameters><data-type:parameter data-type:name="FL1-A"/><data-type:parameter data-type:name="LIVE_DEAD Aqua-A"/></data-type:parameters>
    <transforms:spillover data-type:parameter="FL1-A"><transforms:coefficient data-type:parameter="FL1-A" transforms:value="1"/><transforms:coefficient data-type:parameter="LIVE_DEAD Aqua-A" transforms:value="0.1"/></transforms:spillover>
    <transforms:spillover data-type:parameter="LIVE_DEAD Aqua-A"><transforms:coefficient data-type:parameter="FL1-A" transforms:value="0"/><transforms:coefficient data-type:parameter="LIVE_DEAD Aqua-A" transforms:value="1"/></transforms:spillover>
  </transforms:spilloverMatrix>
  <Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="1024" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:biex transforms:length="256" transforms:maxRange="1024" transforms:neg="0" transforms:width="-10" transforms:pos="3"><data-type:parameter data-type:name="Comp-LIVE_DEAD Aqua-A"/></transforms:biex>
  </Transformations>
  <Keywords>${kw(s)}</Keywords>
  <SampleNode name="${s.uri}" count="${s.tot}" sampleID="${s.id}">
    <Subpopulations>
      <Population name="Live" owningGroup="" count="-1"><Gate><gating:RectangleGate eventsInside="1">${dim(gateCh, undefined, 500)}</gating:RectangleGate></Gate></Population>
    </Subpopulations>
  </SampleNode>
</Sample>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" flowJoVersion="10.8.1" ${NS}>
  <SampleList>${samples.map(sample).join('')}</SampleList>
</Workspace>`;
}

/** Events of the file with compensated LIVE/DEAD (observed - 0.1 x FL1) below 500. */
function expectedLive(bytes: Uint8Array): number {
  const ds = parseFcs(toBuf(bytes));
  const fl1 = ds.data[1];
  const ld = ds.data[2];
  let n = 0;
  for (let i = 0; i < ds.eventCount; i++) if (ld[i] - 0.1 * fl1[i] < 500) n++;
  return n;
}

describe('FlowJo parameter names with "/"', () => {
  it('maps FlowJo\'s "_" form back to the file\'s names', () => {
    expect(flowJoSafeName('LIVE/DEAD Aqua-A')).toBe('LIVE_DEAD Aqua-A');
    const m = flowJoChannelRenames(['FSC-A', 'LIVE_DEAD Aqua-A', 'CD4_CD8-A'], ['FSC-A', 'LIVE/DEAD Aqua-A', 'CD4_CD8-A']);
    expect([...m]).toEqual([['LIVE_DEAD Aqua-A', 'LIVE/DEAD Aqua-A']]);
    // a real "LIVE_DEAD Aqua-A" of another loaded file stays
    expect(flowJoChannelRenames(['LIVE_DEAD Aqua-A'], ['LIVE/DEAD Aqua-A'], new Set(['LIVE_DEAD Aqua-A'])).size).toBe(0);
    // ambiguous ("A/B" and "A\\B" both map to "A_B"): left alone
    expect(flowJoChannelRenames(['A_B'], ['A/B', 'A\\B']).size).toBe(0);
    const ws = emptyWorkspace();
    ws.samples = [{ id: 's', name: 's', fileName: 's.fcs', fileSize: 0, eventCount: 1, channels: [{ name: 'LIVE_DEAD Aqua-A', label: '', range: 1 }], compId: null }];
    ws.populations = [{ id: 'p', name: 'Live', parentId: null, color: '#000', gate: { type: 'rect', x: 'FSC-A', y: 'LIVE_DEAD Aqua-A', xmin: 0, xmax: 1, ymin: 0, ymax: 1 }, overrides: { s: { type: 'range', x: 'LIVE_DEAD Aqua-A', min: 0, max: 1 } } }];
    ws.scales['LIVE_DEAD Aqua-A'] = { type: 'linear', min: 0, max: 1 };
    ws.compensations = [{ id: 'c', name: 'c', channels: ['FL1-A', 'LIVE_DEAD Aqua-A'], matrix: [[1, 0], [0, 1]], source: 'manual' }];
    renameWorkspaceChannels(ws, m);
    expect(ws.populations[0].gate).toMatchObject({ y: 'LIVE/DEAD Aqua-A' });
    expect(ws.populations[0].overrides!.s).toMatchObject({ x: 'LIVE/DEAD Aqua-A' });
    expect(Object.keys(ws.scales)).toEqual(['LIVE/DEAD Aqua-A']);
    expect(ws.compensations[0].channels).toEqual(['FL1-A', 'LIVE/DEAD Aqua-A']);
    expect(ws.samples[0].channels[0].name).toBe('LIVE/DEAD Aqua-A');
  });

  it('gates, transforms and matrices on "LIVE_DEAD Aqua-A" use the file\'s "LIVE/DEAD Aqua-A" (dropped together or relinked later)', async () => {
    const fcs = liveDeadFcs({ fil: 'Specimen_001_A1_A01.fcs' });
    const want = expectedLive(fcs);
    expect(want).toBeGreaterThan(500);
    const xml = wsp([{ id: 1, uri: 'Specimen_001_A1_A01 Negative.fcs', fil: 'Specimen_001_A1_A01.fcs', tot: N }]);
    for (const later of [false, true]) {
      reset();
      // the file has a prefix ("HC ") FlowJo's sample does not have: linked by $FIL and event count
      const f = fileOf(fcs, 'HC Specimen_001_A1_A01 Negative.fcs');
      if (later) {
        await openFiles([fileOf(xml, 'ics.wsp')]);
        expect(useStore.getState().ui.missingFiles).toHaveLength(1);
        await loadFcsFiles([f]);
      } else await openFiles([fileOf(xml, 'ics.wsp'), f]);
      const ws = useStore.getState().ws;
      expect(ws.samples).toHaveLength(1);
      const s = ws.samples[0];
      expect(engine.has(s.id)).toBe(true);
      expect(s.fileName).toBe('HC Specimen_001_A1_A01 Negative.fcs');
      const p = ws.populations.find((x) => x.name === 'Live')!;
      expect(p.gate).toMatchObject({ x: 'LIVE/DEAD Aqua-A' });
      expect(ws.compensations[0].channels).toContain('LIVE/DEAD Aqua-A');
      expect(ws.scales['LIVE/DEAD Aqua-A']).toBeDefined();
      expect(ws.scales['LIVE_DEAD Aqua-A']).toBeUndefined();
      expect(engine.count(ws, s.id, p.id)).toBe(want);
      expect(gateChannelsMissing(ws).size).toBe(0);
      expect(toasts().join('\n')).not.toMatch(/none of the loaded files has/);
    }
  });

  it('warns when a gate uses a parameter that none of the loaded files has', async () => {
    reset();
    const fcs = liveDeadFcs({ fil: 'x.fcs' });
    await openFiles([fileOf(wsp([{ id: 1, uri: 'x.fcs', fil: 'x.fcs', tot: N }], 'Comp-Viability-A'), 'w.wsp'), fileOf(fcs, 'x.fcs')]);
    const ws = useStore.getState().ws;
    expect([...gateChannelsMissing(ws).keys()]).toEqual(['Comp-Viability-A']);
    expect(toasts().join('\n')).toMatch(/Gates use parameters that none of the loaded files has: "Comp-Viability-A" \(gate "Live"\)/);
  });
});

// ------------------------------------------------------------------ relinking files with other names

const ref = (id: string, fileName: string, eventCount: number, info: Record<string, string> = {}): SampleRef => ({ id, name: fileName.replace(/\.fcs$/, ''), fileName, fileSize: 0, eventCount, channels: [], compId: null, info });

describe('relinking files whose names differ from the workspace', () => {
  it('matches by $FIL and event count, then by a contained file name, each sample once', () => {
    const waiting = [ref('a', 'Specimen_001_C1_C01 Negative.fcs', 100, { File: 'Specimen_001_C1_C01.fcs' }), ref('b', 'Specimen_001_C10_C10 Negative.fcs', 100, { File: 'Specimen_001_C10_C10.fcs' })];
    const m = matchByContent(
      [
        { name: 'HC Specimen_001_C1_C01 Negative.fcs', events: 100, fil: 'Specimen_001_C1_C01.fcs' },
        { name: 'ALS Specimen_001_C10_C10 Negative.fcs', events: 100, fil: 'C:\\data\\Specimen_001_C10_C10.fcs' },
        { name: 'other.fcs', events: 100, fil: 'other.fcs' },
        { name: 'HC Specimen_001_C1_C01 Negative.fcs', events: 99, fil: 'Specimen_001_C1_C01.fcs' },
      ],
      waiting,
    );
    expect(m[0].sample?.id).toBe('a');
    expect(m[1].sample?.id).toBe('b');
    expect(m[2]).toEqual({});
    expect(m[3]).toEqual({}); // other event count
    // without $FIL: the file name contains the sample's
    expect(matchByContent([{ name: 'HC Specimen_001_C1_C01 Negative.fcs', events: 100 }], waiting)[0].sample?.id).toBe('a');
    // $DATE / $BTIM must agree where known
    const dated = [ref('a', 'Tube_1.fcs', 100, { File: 'Tube_1.fcs', Date: '01-JAN-2026' })];
    expect(matchByContent([{ name: 'x Tube_1.fcs', events: 100, fil: 'Tube_1.fcs', date: '02-JAN-2026' }], dated)[0]).toEqual({});
  });

  it('reports ambiguous files instead of guessing or adding duplicates', async () => {
    const twins = [ref('a', 'Tube_1 A.fcs', N, { File: 'Tube_1.fcs' }), ref('b', 'Tube_1 B.fcs', N, { File: 'Tube_1.fcs' })];
    const m = matchByContent([{ name: 'Tube_1.fcs', events: N, fil: 'Tube_1.fcs' }], twins);
    expect(m[0].sample).toBeUndefined();
    expect(m[0].ambiguous?.map((s) => s.id).sort()).toEqual(['a', 'b']);
    // two files claiming one sample: neither is linked
    const two = matchByContent(
      [
        { name: 'x Tube_9.fcs', events: N, fil: 'Tube_9.fcs' },
        { name: 'y Tube_9.fcs', events: N, fil: 'Tube_9.fcs' },
      ],
      [ref('c', 'Tube_9.fcs', N, { File: 'Tube_9.fcs' })],
    );
    expect(two.map((x) => x.sample)).toEqual([undefined, undefined]);
    // in the app: not loaded as a new sample, with a note
    reset();
    const xml = wsp([
      { id: 1, uri: 'Tube_1 A.fcs', fil: 'Tube_1.fcs', tot: N },
      { id: 2, uri: 'Tube_1 B.fcs', fil: 'Tube_1.fcs', tot: N },
    ]);
    await openFiles([fileOf(xml, 'w.wsp'), fileOf(liveDeadFcs({ fil: 'Tube_1.fcs' }), 'Tube_1.fcs')]);
    const ws = useStore.getState().ws;
    expect(ws.samples).toHaveLength(2);
    expect(ws.samples.filter((s) => engine.has(s.id))).toHaveLength(0);
    expect(toasts().join('\n')).toMatch(/match several samples and were not loaded/);
    // dropped later: the same
    await loadFcsFiles([fileOf(liveDeadFcs({ fil: 'Tube_1.fcs' }), 'Tube_1.fcs')]);
    expect(useStore.getState().ws.samples).toHaveLength(2);
    expect(toasts().join('\n')).toMatch(/could belong to several workspace samples/);
  });
});

// ------------------------------------------------------------------ axis note for another instrument

describe('"Axis ranges were set for another instrument"', () => {
  const note = () => toasts().filter((t) => /another instrument/.test(t));
  it('does not fire for the first files or files of the same instrument', async () => {
    reset();
    // CytoFLEX-like files ($PnR 2^22) with dim data (e.g. beads), then a bright one, on linear scatter axes (a
    // nanoscale instrument's scatter axes are logicle by default and would hold both: see acceptance_fixes.test.ts)
    const nano = (vals: (i: number) => number, name: string) =>
      fileOf(writeFcs({ channels: [{ name: 'FSC-A', range: 4194304 }, { name: 'SSC-A', range: 4194304 }], data: [Float32Array.from({ length: 800 }, (_, i) => vals(i)), Float32Array.from({ length: 800 }, (_, i) => vals(i))], keywords: { $CYT: 'CytoFLEX S' } }), name);
    await loadFcsFiles([nano((i) => 100 + i, 'low1.fcs'), nano((i) => 120 + i, 'low2.fcs')]);
    expect(note()).toEqual([]);
    const had = new Set(Object.keys(useStore.getState().ws.scales));
    await loadFcsFiles([nano((i) => 2e6 + i, 'high.fcs')]);
    const ws = useStore.getState().ws;
    // the data lie far outside the axes set by the first files (the note would have fired before) ...
    expect(scaleMismatches(ws, ws.samples[2].id, had).length).toBeGreaterThan(0);
    // ... but it is the same instrument
    expect(note()).toEqual([]);
  });
  it('files of another (known) instrument get their own scales instead of the note', async () => {
    reset();
    await loadFcsFiles([fileOf(liveDeadFcs({ fil: 'a.fcs', cyt: 'LSRFortessa' }), 'a.fcs')]);
    const fsc0 = useStore.getState().ws.scales['FSC-A'];
    const big = writeFcs({ channels: [{ name: 'FSC-A', range: 4194304 }], data: [Float32Array.from({ length: 500 }, (_, i) => 2e6 + i)], keywords: { $CYT: 'CytoFLEX' } });
    await loadFcsFiles([fileOf(big, 'big.fcs')]);
    expect(note()).toHaveLength(0);
    const ws = useStore.getState().ws;
    expect(ws.instrumentScales?.['CytoFLEX']?.['FSC-A']).toBeDefined();
    expect(ws.scales['FSC-A']).toBe(fsc0);
    expect(toasts().some((t) => /"CytoFLEX" got its own axis scales for FSC-A/.test(t))).toBe(true);
  });
  it('fires for files of another instrument without an instrument name', async () => {
    reset();
    await loadFcsFiles([fileOf(liveDeadFcs({ fil: 'a.fcs', cyt: 'LSRFortessa' }), 'a.fcs')]);
    const big = writeFcs({ channels: [{ name: 'FSC-A', range: 4194304 }], data: [Float32Array.from({ length: 500 }, (_, i) => 2e6 + i)], keywords: {} });
    await loadFcsFiles([fileOf(big, 'big.fcs')]);
    expect(note()).toHaveLength(1);
    expect(useStore.getState().ws.instrumentScales).toBeUndefined();
  });
  it('compares $CYT and the ranges of the same channel', () => {
    const ds = (cyt: string, range: number): FcsDataset => parseFcs(toBuf(writeFcs({ channels: [{ name: 'FSC-A', range }], data: [Float32Array.of(1, 2, 3)], keywords: cyt ? { $CYT: cyt } : {} })));
    expect(otherInstrument(ds('A', 1024), [])).toBe(false);
    expect(otherInstrument(ds('A', 1024), [{ cyt: 'A', channels: [{ name: 'FSC-A', range: 1024 }] }])).toBe(false);
    expect(otherInstrument(ds('A', 1024), [{ cyt: 'B', channels: [] }])).toBe(true);
    expect(otherInstrument(ds('', 1024), [{ cyt: '', channels: [{ name: 'FSC-A', range: 262144 }] }])).toBe(true);
  });
});

// ------------------------------------------------------------------ spectral bead controls

describe('automatic selection of spectral bead controls', () => {
  /** 24-detector bead control: stained beads peak in detector `peak`; debris with huge scatter is very bright in detector 20. */
  function control(peak: number, junk: number) {
    const D = 24;
    const n = 6000;
    const r = rng(5 + peak);
    const cols: Float32Array[] = Array.from({ length: D + 2 }, () => new Float32Array(n));
    const sig = Array.from({ length: D }, (_, d) => Math.exp(-((d - peak) ** 2) / 4));
    for (let e = 0; e < n; e++) {
      const isJunk = e < junk;
      const pos = !isJunk && e % 2 === 0;
      for (let d = 0; d < D; d++) cols[d][e] = 200 + r() * 100 + (pos ? 20000 * sig[d] * (0.8 + 0.4 * r()) : 0) + (isJunk && d === 20 ? 5e5 * r() : 0);
      cols[D][e] = isJunk ? 3e6 + r() * 1e6 : 2.5e5 * (1 + 0.03 * (r() - 0.5)); // FSC-A
      cols[D + 1][e] = isJunk ? 1e3 + r() * 1e3 : 3.3e5 * (1 + 0.03 * (r() - 0.5)); // SSC-A
    }
    const set: EventSet = { columns: cols, detectorIndex: Array.from({ length: D }, (_, d) => d) };
    const names = Array.from({ length: D }, (_, d) => (d < 16 ? `V${d + 1}-A` : `B${d - 15}-A`));
    return { set, names, scatter: [{ values: cols[D], range: 4194304 }, { values: cols[D + 1], range: 4194304 }] };
  }
  it('drops debris outside the bead scatter population and finds the stained detector', () => {
    const c = control(6, 400); // V7-A
    expect(autoSelectPopulations(c.set, { detectorNames: c.names }).peak).toBe(20); // debris wins without scatter
    const sel = autoSelectPopulations(c.set, { detectorNames: c.names, scatter: c.scatter });
    expect(c.names[sel.peak]).toBe('V7-A');
    expect(sel.warnings.join(' ')).toMatch(/outside the bead scatter population/);
    const g = scatterGate(Uint32Array.from({ length: 6000 }, (_, i) => i), c.scatter);
    expect(g.beads).toBe(true);
    expect(g.idx.length).toBe(5600);
  });
  it('uses the fluorochrome named in the sample as a hint', () => {
    expect(fluorPeakHint('Reference Group-A7 iNOS APC-eFluor 780 (Beads)', ['R1-A', 'R7-A'])).toEqual({ fluor: 'APC-eFluor 780', detector: 1 });
    expect(fluorPeakHint('CD4 Real Blue RB 545 (Beads)', ['B2-A', 'B3-A'])?.detector).toBe(1);
    expect(fluorPeakHint('CD11b BV510', ['V1-A', 'V7-A'])?.fluor).toBe('BV510');
    expect(fluorPeakHint('Specimen_001 Peptide', ['YG1-A'])).toBeNull(); // "pe" inside a word is not PE
    expect(fluorPeakHint('CD3 PE-Cy7', ['YG1-A', 'YG9-A'])?.fluor).toBe('PE-Cy7');
    const c = control(6, 400);
    const sel = autoSelectPopulations(c.set, { detectorNames: c.names, fluorochrome: 'CD11b BV510 (Beads)' });
    expect(c.names[sel.peak]).toBe('V7-A');
    expect(sel.warnings.join(' ')).toMatch(/chosen for BV510/);
  });
  it('flags controls with the same peak detector', () => {
    const row = (peak: number): RowResult => ({ kind: 'ok', warnings: [], signature: [1], peak });
    const out = annotateSharedPeaks({ a: row(3), b: row(3), c: row(4) }, [{ key: 'a', name: 'BV510' }, { key: 'b', name: 'BV605' }, { key: 'c', name: 'PE' }], ['d1', 'd2', 'd3', 'UV9-A', 'YG1-A']);
    expect(out.a.warnings[0]).toMatch(/Same peak detector \(UV9-A\) as 'BV605'/);
    expect(out.b.warnings[0]).toMatch(/'BV510'/);
    expect(out.c.warnings).toEqual([]);
  });

  const AUR = '/tmp/claude-0/qc-real/data/aurora';
  it.skipIf(!existsSync(AUR))('Aurora reference controls (Zenodo 17457137): all 17 pick their peak detector', () => {
    const load = (f: string) => parseFcs(toBuf(new Uint8Array(readFileSync(join(AUR, f)))));
    const un = load('Reference Group-A1 Unstained (Cells).fcs');
    const det = defaultDetectors(un);
    const setOf = (ds: FcsDataset): EventSet => {
      const di = resolveDetectors({ detectors: det }, ds.channels.map((c) => c.name));
      return { columns: ds.data, detectorIndex: di, ranges: di.map((i) => ds.channels[i].range) };
    };
    const expected: Record<string, string> = {
      'RB 744': 'B12-A', 'PE-Cy5': 'YG5-A', BV421: 'V1-A', BV510: 'V7-A', APC: 'R1-A', 'PE-eFluor 610': 'YG3-A', 'PE (': 'YG1-A', 'PerCP-eFluor 710': 'YG7-A',
      'APC-eFluor 780': 'R7-A', 'RB 545': 'B3-A', BV605: 'V10-A', 'Live-or-dye': 'UV5-A|UV6-A', 'Spark UV 387': 'UV1-A', 'StarBright Violet 475': 'V5-A', FITC: 'B2-A', BV650: 'V11-A', AF660: 'R3-A',
    };
    // the viability dye is about as bright in UV5 and UV6 (either gives the same signature)
    const is = (got: string, want: string) => want.split('|').includes(got);
    const files = readdirSync(AUR).filter((f) => f.endsWith('.fcs') && !/Unstained/.test(f));
    expect(files).toHaveLength(17);
    for (const f of files) {
      const ds = load(f);
      const sc = ['FSC-A', 'SSC-A'].map((n) => {
        const i = ds.channels.findIndex((c) => c.name === n);
        return { values: ds.data[i], range: ds.channels[i].range };
      });
      const key = Object.keys(expected).sort((a, b) => b.length - a.length).find((k) => f.includes(k))!;
      // scatter alone and the name alone are each enough
      const a = det[autoSelectPopulations(setOf(ds), { unstained: setOf(un), detectorNames: det, scatter: sc }).peak];
      const b = det[autoSelectPopulations(setOf(ds), { unstained: setOf(un), detectorNames: det, fluorochrome: f }).peak];
      expect(is(a, expected[key]), `${f}: ${a}`).toBe(true);
      expect(is(b, expected[key]), `${f}: ${b}`).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ size calibration

describe('size calibration: saturation, detectors with their own factor, weak fits', () => {
  const PS = { material: 'polystyrene' } as const;
  const opts = { wavelengthNm: 405, nMedium: 1.34309, halfAngleRangeDeg: [30, 80] as [number, number], stepDeg: 0.5 };
  it('finds pile-up at the top of a channel', () => {
    const r = rng(3);
    const v = Float32Array.from({ length: 10000 }, (_, i) => (i < 500 ? 5652796 : r() * 4e6));
    expect(detectPileUp(v)).toMatchObject({ count: 500 });
    expect(detectPileUp(Float32Array.from({ length: 10000 }, () => r() * 4e6))).toBeNull(); // flat top
    expect(detectPileUp(Float32Array.from({ length: 10000 }, () => Math.exp(8 * r())))).toBeNull(); // decaying tail
    expect(detectPileUp(Float32Array.from({ length: 1000 }, (_, i) => (i < 30 ? 1024 : r() * 900)), 1024)).toMatchObject({ count: 30 });
  });
  it('fits one half-angle with a factor per detector; check beads are sized back but not fitted', () => {
    const setup = { wavelengthNm: 405, nMedium: 1.34309, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 55, polarization: 'linear' as const } };
    const hi = [142, 304, 600, 1020];
    const lo = [44, 80, 108, 142];
    const sig = (ds: number[]) => Array.from(apertureCrossSections({ kind: 'sphere', ri: PS }, ds, setup));
    const beads = [...hi, ...lo].map((d) => ({ diameterNm: d, ri: PS }));
    // detector 0 (VSSC2) 100 a.u./nm2, detector 1 (VSSC1) 4000 a.u./nm2; the first low bead is labelled 40 nm but is 44
    const meas = [...sig(hi).map((s) => 100 * s), ...sig(lo).map((s) => 4000 * s)];
    beads[4] = { diameterNm: 40, ri: PS };
    const fit = fitCollectionAngle(beads, meas, { ...opts, groups: [0, 0, 0, 0, 1, 1, 1, 1], checkOnly: [false, false, false, false, true, false, false, false] });
    expect(fit.halfAngleDeg).toBeCloseTo(55, 0);
    expect(fit.groupFactors.map((g) => g.n)).toEqual([4, 3]);
    expect(fit.groupFactors[0].auPerNm2).toBeCloseTo(100, 0);
    expect(fit.groupFactors[1].auPerNm2 / 4000).toBeCloseTo(1, 2);
    expect(fit.nm2PerAu).toBeCloseTo(0.01, 4);
    const check = fit.beads[4];
    expect(check.used).toBe(false);
    expect(check.check).toBe(true);
    expect(check.sizedNm).toBeCloseTo(44, 0);
    for (const b of fit.beads.filter((x) => x.used)) expect(Math.abs(b.sizeErrorPct)).toBeLessThan(0.5);
    // one factor for both detectors cannot fit
    expect(fitCollectionAngle(beads, meas, opts).cvPct).toBeGreaterThan(50);
  });
  it('tells when the beads do not determine the half-angle', () => {
    const x = Float64Array.from({ length: 851 }, (_, i) => 5 + i * 0.1);
    const fitOf = (y: (a: number) => number, best: number) => ({ method: 'cv' as const, halfAngleDeg: best, sweep: { halfAngleDeg: x, cvPct: x.map(y), rmsLog: x.map(y), auPerNm2: x.map(() => 1) } });
    expect(sweepConstraint(fitOf((a) => 2 + Math.abs(a - 55), 55))).toEqual({ atEdge: false, flat: false });
    expect(sweepConstraint(fitOf((a) => 30 + 0.01 * (90 - a), 90))).toEqual({ atEdge: true, flat: true });
    expect(sweepConstraint(fitOf((a) => 30 + 0.02 * Math.abs(a - 50), 50))).toEqual({ atEdge: false, flat: true });
    const ws = emptyWorkspace();
    expect(suggestedHalfAngle(ws, { wavelength: 405, channel: 'SSC-A', preset: 'cytoflex' })).toEqual({ deg: 53.2, from: 'the CytoFLEX VSSC example of FCMPASS' });
  });
  it('defaults nanoViS High to VSSC2 when calibrating violet SSC on a CytoFLEX nano', () => {
    const ws = emptyWorkspace();
    ws.samples = [
      {
        id: 'h',
        name: 'NanoVIS_High',
        fileName: 'h.fcs',
        fileSize: 0,
        eventCount: 1,
        compId: null,
        channels: [
          { name: 'SSC-A', label: 'VSSC1-A', range: 1 },
          { name: 'SSC_1-A', label: 'VSSC2-A', range: 1 },
        ],
      },
    ];
    expect(defaultSetChannel(ws, 'h', 'beckman-nanovis-high', 'SSC-A')).toBe('SSC_1-A');
    expect(defaultSetChannel(ws, 'h', 'beckman-nanovis-low', 'SSC-A')).toBeUndefined();
    expect(defaultSetChannel(ws, 'h', 'beckman-nanovis-high', 'SSC_1-A')).toBeUndefined();
    expect(rowsFromKit(getBeadKit('beckman-nanovis-low')).map((b) => b.fit)).toEqual([false, undefined, undefined, undefined]);
  });

  const NANO = join(ONLINE, 'figshare_31855687_cytoflex_nano');
  it.skipIf(!existsSync(join(NANO, 'Figure_1A_NanoVIS_High.fcs')))('CytoFLEX nano nanoViS files (figshare 31855687): saturation on VSSC1, High on VSSC2 + Low on VSSC1', () => {
    const load = (f: string) => parseFcs(toBuf(new Uint8Array(readFileSync(join(NANO, f)))));
    const nMed = defaultMediumRI(405);
    const setup0 = { wavelengthNm: 405, nMedium: nMed, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 53.2, polarization: 'linear' as const } };
    const peaks = (file: string, ch: string, kitId: string) => {
      const ds = load(file);
      const ci = ds.channels.findIndex((c) => c.name === ch);
      const hi = ds.channels.findIndex((c) => c.name === ch.replace(/-A$/, '-H'));
      const raw = ds.data[ci];
      const values = positiveOnly(raw);
      const rows = rowsFromKit(getBeadKit(kitId));
      const res = findBeadPeaks(values, rows.length + 1, { scale: positiveLogScale(values) });
      const a = assignPeaks(rows, rows.map((b) => apertureCrossSections({ kind: 'sphere', ri: b.ri }, [b.diameterNm], setup0)[0]), res.peaks.length, true);
      const pa = detectPileUp(raw, ds.channels[ci].range);
      const ph = detectPileUp(ds.data[hi], ds.channels[hi].range);
      const sat = rows.map((_, i) => {
        const p = res.peaks[a.assign[i]];
        if (!p) return false;
        let n = 0;
        let k = 0;
        for (let j = 0; j < raw.length; j++)
          if (raw[j] >= p.lo && raw[j] < p.hi) {
            n++;
            if ((pa && raw[j] >= pa.level) || (ph && ds.data[hi][j] >= ph.level)) k++;
          }
        return k / n >= 0.02;
      });
      return { rows, sat, ph, meas: rows.map((_, i) => (a.assign[i] >= 0 && !sat[i] ? res.peaks[a.assign[i]].median : NaN)) };
    };
    const hiV1 = peaks('Figure_1A_NanoVIS_High.fcs', 'SSC-A', 'beckman-nanovis-high');
    expect(hiV1.ph?.count).toBeGreaterThan(10000);
    expect(hiV1.rows.filter((_, i) => hiV1.sat[i]).map((b) => b.diameterNm)).toEqual([304, 600, 1020]);
    const hiV2 = peaks('Figure_1A_NanoVIS_High.fcs', 'SSC_1-A', 'beckman-nanovis-high');
    expect(hiV2.sat.some(Boolean)).toBe(false);
    const loV1 = peaks('Figure_1A_NanoVIS_Low.fcs', 'SSC-A', 'beckman-nanovis-low');
    const rows = [...hiV2.rows, ...loV1.rows];
    const fit = fitCollectionAngle(
      rows.map((b) => ({ diameterNm: b.diameterNm, ri: b.ri, label: b.label })),
      [...hiV2.meas, ...loV1.meas],
      { wavelengthNm: 405, nMedium: nMed, halfAngleRangeDeg: [5, 90], stepDeg: 0.1, groups: [0, 0, 0, 0, 1, 1, 1, 1], checkOnly: rows.map((b) => b.fit === false) },
    );
    expect(fit.halfAngleDeg).toBeGreaterThanOrEqual(54.2);
    expect(fit.halfAngleDeg).toBeLessThanOrEqual(55.7);
    for (const b of fit.beads.filter((x) => x.used)) expect(Math.abs(b.sizeErrorPct), b.label).toBeLessThan(3);
    const b40 = fit.beads[4];
    expect(b40.check).toBe(true);
    expect(b40.sizedNm).toBeGreaterThan(43);
    expect(b40.sizedNm).toBeLessThan(45);
    // a calibration made from nanoViS Low alone does not determine the half-angle
    const low = fitCollectionAngle(loV1.rows.map((b) => ({ diameterNm: b.diameterNm, ri: b.ri })), loV1.meas, { wavelengthNm: 405, nMedium: nMed, halfAngleRangeDeg: [5, 90], stepDeg: 0.5 });
    const c = sweepConstraint(low);
    expect(c.atEdge || c.flat).toBe(true);
  });
});

// ------------------------------------------------------------------ real FlowJo workspace

const ICS = join(ONLINE, 'zenodo_16754553_ics_wsp');
describe.skipIf(!existsSync(join(ICS, '2-Week ICS #2.wsp')))('Zenodo 16754553 ICS workspace with its 18 FCS files ("HC " / "ALS " prefixes, LIVE/DEAD Aqua-A)', () => {
  it('links all 18 files without duplicates and gates on LIVE/DEAD as FlowJo', async () => {
    reset();
    const fcs = readdirSync(ICS).filter((f) => f.endsWith('.fcs'));
    await openFiles([fileOf(new Uint8Array(readFileSync(join(ICS, '2-Week ICS #2.wsp'))), '2-Week ICS #2.wsp'), ...fcs.map((f) => fileOf(new Uint8Array(readFileSync(join(ICS, f))), f))]);
    const st = useStore.getState();
    const ws = st.ws;
    expect(ws.samples).toHaveLength(18);
    expect(ws.samples.every((s) => engine.has(s.id))).toBe(true);
    expect(gateChannelsMissing(ws).size).toBe(0);
    const fj = st.ui.flowjoCounts!.counts;
    const ld = ws.populations.find((p) => /LIVE_DEAD Aqua-A, SSC-A subset$/.test(popPath(ws, p.id)))!;
    expect(ld.gate).toMatchObject({ x: 'LIVE/DEAD Aqua-A' });
    for (const s of ws.samples) {
      const c = engine.count(ws, s.id, ld.id);
      expect(Math.abs(c - fj[s.id][ld.id]) / fj[s.id][ld.id], s.name).toBeLessThan(0.015);
    }
  });
});
