// FCS reader fixes, on small synthetic files (tests/fcsBuilder.ts): DATA offset choice, FCS 3.2 $PnDATATYPE,
// spillover keywords (parameter numbers, decimal comma, Kaluza $COMP), files with several data sets (one sample each;
// LMD copies as one), duplicate $PnN, Guava log-decade float channels, $PnR 0, and loading them into the workspace.
import { engine } from '../src/core/engine';
import { getSpillover, parseFcs, parseFcsAll, parseFcsSamples, parseTextSegment, pickSample, type FcsDataset } from '../src/core/fcs';
import { emptyWorkspace } from '../src/core/model';
import { openWorkspace } from '../src/io/files';
import { DATASET_INFO, loadFcsFiles, relinkSample, useStore } from '../src/state/store';
import { buildFcs, buildMulti, toBuf, type BuildOpts } from './fcsBuilder';

const seq = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
const col = (ds: FcsDataset, name: string) => Array.from(ds.data[ds.channels.findIndex((c) => c.name === name)]);
const parse = (o: BuildOpts) => parseFcs(toBuf(buildFcs(o)));

/** Three float parameters, 6 events: "Event" counts 1..6 so a shifted read is obvious. */
const base = (o: Partial<BuildOpts> = {}): BuildOpts => ({
  version: 'FCS3.0',
  datatype: 'F',
  pars: [{ name: 'Event' }, { name: 'FSC-A' }, { name: 'FL1-A' }],
  data: [seq(6, (i) => i + 1), seq(6, (i) => 100 + i), seq(6, (i) => 1000 * (i + 1))],
  ...o,
});

describe('DATA offsets: HEADER vs TEXT', () => {
  it('uses the HEADER offset that directly follows TEXT when $BEGINDATA is off (CyAn)', () => {
    // TEXT says 12 bytes later; both lengths match $TOT and both fit in the file
    const ds = parse(base({ textShift: 12, tail: 12 }));
    expect(col(ds, 'Event')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ds.warnings.join(' ')).toMatch(/using HEADER \d+, ignoring TEXT \$BEGINDATA \d+ \(does not follow the TEXT segment/);
  });
  it('uses TEXT when the HEADER offset points inside TEXT (FlowIO data_start_offset_discrepancy)', () => {
    const ds = parse(base({ headerBegin: 70 }));
    expect(col(ds, 'Event')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ds.warnings.join(' ')).toMatch(/using TEXT \$BEGINDATA \d+, ignoring HEADER 70 \(starts inside the TEXT segment\)/);
  });
  it('uses HEADER when a stale $BEGINDATA lies inside TEXT (Accuri C6)', () => {
    const ds = parse(base({ textBegin: 80 }));
    expect(col(ds, 'Event')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ds.warnings.join(' ')).toMatch(/using HEADER \d+, ignoring TEXT \$BEGINDATA 80 \(starts inside the TEXT segment\)/);
  });
  it('uses TEXT when the HEADER offset would run past the end of the file', () => {
    // padding between TEXT and DATA: neither follows TEXT; the HEADER offset is 8 bytes too far
    const ds = parse(base({ gap: 16, headerShift: 8 }));
    expect(col(ds, 'Event')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ds.warnings.join(' ')).toMatch(/using TEXT .* \(would run past the end of the file\)/);
  });
  it('prefers TEXT (FCS 3.x) when both are plausible, and HEADER for FCS 2.0', () => {
    // gap of 16 bytes, TEXT offset right, HEADER 4 bytes early (inside the gap): both fit, both lengths match
    const three = parse(base({ gap: 16, headerShift: -4, tail: 0 }));
    expect(col(three, 'Event')).toEqual([1, 2, 3, 4, 5, 6]);
    const two = parse(base({ version: 'FCS2.0', gap: 16, textShift: -4 }));
    expect(col(two, 'Event')).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('agreeing offsets and FCS 2.0 files without TEXT offsets give no warning', () => {
    expect(parse(base()).warnings).toEqual([]);
    const ds = parse(base({ version: 'FCS2.0', noTextOffsets: true }));
    expect(col(ds, 'FL1-A')).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    expect(ds.warnings).toEqual([]);
  });
  it('tolerates $ENDDATA one byte past the data silently, warns about other end mismatches', () => {
    const ds = parse(base({ endPastLast: true }));
    expect(col(ds, 'Event')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ds.warnings).toEqual([]);
    const bad = parse(base({ headerEnd: 5000, tail: 5000 }));
    expect(col(bad, 'Event')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(bad.warnings.join(' ')).toMatch(/DATA end offsets of HEADER \(5000\) and TEXT \$ENDDATA \(\d+\) disagree; using TEXT/);
  });
});

describe('FCS 3.2 $PnDATATYPE', () => {
  const pars = [
    { name: 'FSC-A' },
    { name: 'EventNumber', type: 'I' as const, bits: 32, range: '4294967296' },
    { name: 'Ratio', type: 'D' as const },
    { name: 'Flags', type: 'I' as const, bits: 16, range: 65536 },
  ];
  const data = [
    [1.5, -2.25, 3e5],
    [1363811, 4000000000, 7],
    [0.123456789, 1e-12, -5],
    [1, 65535, 300],
  ];
  for (const big of [false, true])
    it(`reads integer and double parameters in float data (${big ? 'big' : 'little'}-endian)`, () => {
      const ds = parse({ version: 'FCS3.2', datatype: 'F', big, pars, data });
      expect(col(ds, 'FSC-A')).toEqual([1.5, -2.25, 3e5]);
      expect(col(ds, 'EventNumber')).toEqual([1363811, 4000000000, 7].map(Math.fround));
      expect(col(ds, 'Ratio')).toEqual([0.123456789, 1e-12, -5].map(Math.fround));
      expect(col(ds, 'Flags')).toEqual([1, 65535, 300]);
      expect(ds.warnings).toEqual([]);
    });
  it('$DATATYPE stays the default for parameters without $PnDATATYPE (integer data with one float parameter)', () => {
    const ds = parse({ version: 'FCS3.2', datatype: 'I', pars: [{ name: 'A', bits: 16 }, { name: 'B', type: 'F' }], data: [[3, 4], [0.5, 1e9]] });
    expect(col(ds, 'A')).toEqual([3, 4]);
    expect(col(ds, 'B')).toEqual([0.5, 1e9]);
  });
});

describe('spillover keywords', () => {
  const chans = (names: string[]) => names.map((name) => ({ name, label: '' }));
  const sp = (kw: Record<string, string>, names = ['FSC-A', 'SSC-A', 'FL1-A', 'FL2-A', 'Time']) => getSpillover({ keywords: kw, channels: chans(names) });
  it('maps parameter numbers to $PnN (Gallios / Accuri / Apogee "10,5,6,...")', () => {
    const s = sp({ $SPILLOVER: '2,3,4,1.000,0.119,0.011,1.000' });
    expect(s).toEqual({ channels: ['FL1-A', 'FL2-A'], matrix: [[1, 0.119], [0.011, 1]], keyword: '$SPILLOVER' });
  });
  it('prefers names over numbers, and rejects numbers out of range', () => {
    expect(sp({ SPILL: '1,7,1' }, ['7', 'FL1-A'])?.channels).toEqual(['7']);
    expect(sp({ $SPILLOVER: '2,3,9,1,0,0,1' })).toBeNull();
  });
  it('reads decimal-comma values (German locale) by the token count', () => {
    const s = sp({ $SPILLOVER: '2,FL1-A,FL2-A,1,000,0,119,0,011,1,000' });
    expect(s?.matrix).toEqual([[1, 0.119], [0.011, 1]]);
    expect(sp({ $SPILLOVER: '2,3,4,1,000,0,000,0,000,1,000' })?.keyword).toBe('$SPILLOVER (identity)');
  });
  it('reads Kaluza $COMP without names: all $PAR parameters, transposed, percent', () => {
    // $COMP[detector][source] in percent with 1 on the diagonal: FL1 -> FL2 11.9 %, FL2 -> FL1 1.1 %
    const comp = [
      [1, 1, 0, 0, 0],
      [1, 1, 0, 0, 0],
      [0, 0, 1, 1.1, 0],
      [0, 0, 11.9, 1, 0],
      [0, 0, 0, 0, 0],
    ];
    const s = sp({ $COMP: '5,' + comp.flat().join(',') }, ['FS-A', 'SS-A', 'FL1-A', 'FL2-A', 'TIME']);
    expect(s?.channels).toEqual(['FL1-A', 'FL2-A']);
    expect(s?.matrix[0][1]).toBeCloseTo(0.119, 12);
    expect(s?.matrix[1][0]).toBeCloseTo(0.011, 12);
    expect(s?.keyword).toBe('$COMP');
    // n = number of fluorescence parameters, fractions
    const t = sp({ $COMP: '2,1,0.02,0.1,1' }, ['FS-A', 'SS-A', 'FL1-A', 'FL2-A', 'TIME']);
    expect(t?.matrix).toEqual([[1, 0.1], [0.02, 1]]);
    // $SPILLOVER wins over $COMP
    expect(sp({ $SPILLOVER: '2,3,4,1,0.5,0,1', $COMP: '2,1,0.02,0.1,1' })?.matrix).toEqual([[1, 0.5], [0, 1]]);
  });
  it('ignores matrices without values (MACSQuant "6,FL2-A,...")', () => {
    expect(sp({ $SPILLOVER: '2,FL1-A,FL2-A' })).toBeNull();
  });
});

describe('files with several data sets', () => {
  const well = (id: string, n: number, k: number): BuildOpts => ({
    version: 'FCS3.0',
    pars: [{ name: 'FSC-HLin' }, { name: 'GRN-HLin' }],
    data: [seq(n, (i) => k * 100 + i), seq(n, (i) => k + i / 10)],
    kw: { $WELLID: id, $SMNO: String(k), $CYT: 'Guava' },
  });
  const plate = buildMulti([well('A01', 5, 1), well('A02', 7, 2), well('A03', 4, 3)]);

  it('gives one sample per data set, each with standalone bytes', () => {
    const parts = parseFcsSamples(toBuf(plate));
    expect(parts.map((p) => p.ds.dataset)).toEqual([
      { index: 0, count: 3, label: '#1 A01' },
      { index: 1, count: 3, label: '#2 A02' },
      { index: 2, count: 3, label: '#3 A03' },
    ]);
    expect(parts.map((p) => p.ds.eventCount)).toEqual([5, 7, 4]);
    for (const p of parts) {
      const again = parseFcsAll(p.bytes);
      expect(again).toHaveLength(1);
      expect(Number(again[0].keywords['$NEXTDATA'])).toBe(0);
      expect(again[0].data.map((a) => Array.from(a))).toEqual(p.ds.data.map((a) => Array.from(a)));
    }
    expect(parts[0].ds.warnings).toEqual([]);
    expect(pickSample(parts, { index: 2 }).ds.keywords['$WELLID']).toBe('A03');
    expect(pickSample(parts, { eventCount: 7 }).ds.keywords['$WELLID']).toBe('A02');
    // parseFcs (one data set): the most events, with a note
    const one = parseFcs(toBuf(plate));
    expect(one.keywords['$WELLID']).toBe('A02');
    expect(one.warnings[0]).toMatch(/^File contains 3 data sets .* only data set 2 is loaded/);
  });

  it('keeps the FCS 2.0 and 3.0 copies of a Beckman LMD file as one sample with the 2.0 keywords', () => {
    const lmd = buildMulti([
      {
        version: 'FCS2.0',
        datatype: 'I',
        pars: [
          { name: 'FS INT LIN', bits: 16, s: 'FS INT LIN' },
          { name: 'FL1 INT LOG', bits: 16, s: 'CD3 FITC' },
          { name: 'FL2 INT LOG', bits: 16, s: 'FL2 INT LOG' },
        ],
        data: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
        kw: { $CYT: 'Gallios', $OP: 'me', $DATE: '24-Sep-21', $P1V: '260' },
      },
      { version: 'FCS3.0', pars: [{ name: 'FS-A' }, { name: 'FL1-A' }, { name: 'FL2-A' }, { name: 'TIME' }], data: [[10, 20, 30], [1, 2, 3], [4, 5, 6], [0, 1, 2]] },
    ]);
    const parts = parseFcsSamples(toBuf(lmd));
    expect(parts).toHaveLength(1);
    const ds = parts[0].ds;
    expect(ds.version).toBe('FCS3.0');
    expect(ds.dataset).toBeUndefined();
    expect(parts[0].bytes.byteLength).toBe(lmd.length);
    expect(ds.keywords['$CYT']).toBe('Gallios');
    expect(ds.keywords['$OP']).toBe('me');
    expect(ds.keywords['$P1V']).toBeUndefined(); // parameter keywords of the 2.0 part are not copied
    expect(ds.channels.map((c) => c.label)).toEqual(['', 'CD3 FITC', '', '']);
    expect(ds.warnings[0]).toMatch(/^File contains 2 data sets \(FCS2.0, 3 events; FCS3.0, 3 events\); only data set 2 is loaded/);
    expect(parseFcs(toBuf(lmd)).keywords['$CYT']).toBe('Gallios');
  });
});

describe('channel names, ranges and float log channels', () => {
  it('makes repeated $PnN unique', () => {
    const ds = parse({ pars: [{ name: 'Diameter' }, { name: 'X' }, { name: 'Diameter' }, { name: 'Diameter (2)' }, { name: 'Diameter' }], data: [[1], [2], [3], [4], [5]] });
    expect(ds.channels.map((c) => c.name)).toEqual(['Diameter', 'X', 'Diameter (3)', 'Diameter (2)', 'Diameter (4)']);
    expect(ds.warnings[0]).toMatch(/Parameter names occur more than once: "Diameter" \(\$P1, \$P3, \$P5\)/);
  });
  it('linearizes float channels holding log10 decades (Guava HLog: $PnE 4,1, values 0..4)', () => {
    const lin = [1, 232.38, 9999];
    const ds = parse({ pars: [{ name: 'GRN-HLin', range: 10000 }, { name: 'GRN-HLog', e: '4.0,1.0', range: 10000 }], data: [lin, lin.map(Math.log10)] });
    const got = col(ds, 'GRN-HLog');
    got.forEach((v, i) => expect(v / lin[i]).toBeCloseTo(1, 5));
    expect(ds.channels[1].range).toBe(10000);
    expect(ds.warnings[0]).toMatch(/^GRN-HLog: floating-point data with \$PnE=4,1: values 0..4 read as log10 decades/);
  });
  it('leaves float channels with $PnE but linear values (BD "5,3") as they are', () => {
    const ds = parse({ pars: [{ name: 'SSC-A', e: '5,3', range: 262144 }], data: [[3, 56022.5, -110.5]] });
    expect(col(ds, 'SSC-A')).toEqual([3, 56022.5, -110.5]);
    expect(ds.warnings).toEqual([]);
  });
  it('uses the data maximum when $PnR is 0', () => {
    const ds = parse({ pars: [{ name: 'Count', range: 0 }, { name: 'Zero', range: 0 }], data: [[3, 17.5, 2], [0, 0, 0]] });
    expect(ds.channels.map((c) => c.range)).toEqual([17.5, 1]);
  });
});

describe('TEXT keywords', () => {
  it('parses the TEXT of a built file', () => {
    const b = buildFcs(base());
    const kw = parseTextSegment(b.subarray(58, Number(new TextDecoder().decode(b.subarray(18, 26))) + 1));
    expect(kw['$PAR']).toBe('3');
  });
});

// ------------------------------------------------------------------ loading into the workspace

describe('loading files with several data sets', () => {
  const plate = buildMulti(
    ['A01', 'A02', 'A03'].map((id, k) => ({
      version: 'FCS3.0',
      pars: [{ name: 'FSC-A', range: 1000 }, { name: 'FL1-A', range: 1000 }],
      data: [seq(10 + k, (i) => i * (k + 1)), seq(10 + k, (i) => 500 - i)],
      kw: { $WELLID: id },
    })),
  );
  const file = () => new File([plate as BlobPart], 'plate.fcs');
  const reset = () => {
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    useStore.getState().replaceWorkspace(emptyWorkspace());
  };

  it('adds one sample per data set, named after the well', async () => {
    reset();
    const ids = await loadFcsFiles([file()]);
    const ws = useStore.getState().ws;
    expect(ids).toHaveLength(3);
    expect(ws.samples.map((s) => [s.name, s.fileName, s.eventCount, s.info?.[DATASET_INFO]])).toEqual([
      ['plate #1 A01', 'plate.fcs', 10, '1 of 3'],
      ['plate #2 A02', 'plate.fcs', 11, '2 of 3'],
      ['plate #3 A03', 'plate.fcs', 12, '3 of 3'],
    ]);
    // each sample keeps the bytes of its own data set (saved in bundles and sessions)
    for (const s of ws.samples) {
      const sd = engine.samples.get(s.id)!;
      expect(parseFcs(sd.bytes as ArrayBuffer).eventCount).toBe(s.eventCount);
    }
  });

  it('relinks each data set to its own sample', async () => {
    const ws = useStore.getState().ws;
    for (const s of ws.samples) engine.removeSample(s.id);
    const ids = await loadFcsFiles([file()]);
    expect(ids).toEqual(ws.samples.map((s) => s.id));
    expect(useStore.getState().ws.samples).toHaveLength(3);
    expect(ws.samples.map((s) => engine.samples.get(s.id)!.ds.keywords['$WELLID'])).toEqual(['A01', 'A02', 'A03']);
    // relinking one sample by hand picks its data set
    const second = ws.samples[1];
    engine.removeSample(second.id);
    await relinkSample(second.id, file());
    expect(engine.samples.get(second.id)!.ds.keywords['$WELLID']).toBe('A02');
  });

  it('opens a workspace with the whole file for each sample', async () => {
    const ws = useStore.getState().ws;
    reset();
    const r = await openWorkspace(ws, [{ name: 'plate.fcs', bytes: plate }], { quiet: true });
    expect(r.loaded).toBe(3);
    expect(ws.samples.map((s) => engine.samples.get(s.id)!.ds.eventCount)).toEqual([10, 11, 12]);
  });

  it('relinks a sample saved before such files were split (no data set position) by event count', async () => {
    reset();
    const w = emptyWorkspace();
    w.samples = [{ id: 'old', name: 'plate', fileName: 'plate.fcs', fileSize: 0, eventCount: 11, channels: [], compId: null }];
    useStore.getState().replaceWorkspace(w);
    const ids = await loadFcsFiles([file()]);
    expect(ids).toHaveLength(3);
    expect(ids[1]).toBe('old');
    expect(engine.samples.get('old')!.ds.keywords['$WELLID']).toBe('A02');
    expect(useStore.getState().ws.samples.map((s) => s.name)).toEqual(['plate', 'plate #1 A01', 'plate #3 A03']);
  });

  it('loads a Beckman LMD file (two copies) as one sample', async () => {
    reset();
    const lmd = buildMulti([
      { version: 'FCS2.0', datatype: 'I', pars: [{ name: 'FS INT LIN', bits: 16 }], data: [[1, 2]], kw: { $CYT: 'Navios' } },
      { version: 'FCS3.0', pars: [{ name: 'FS-A' }], data: [[10, 20]] },
    ]);
    const ids = await loadFcsFiles([new File([lmd as BlobPart], 'tube.LMD')]);
    expect(ids).toHaveLength(1);
    const s = useStore.getState().ws.samples[0];
    expect(s.name).toBe('tube');
    expect(s.info?.['Cytometer']).toBe('Navios');
    expect(s.info?.[DATASET_INFO]).toBeUndefined();
  });
});
