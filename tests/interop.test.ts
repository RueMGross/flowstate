// Interoperability with FlowJo, FlowLogic and CytExpert: compensation matrix files (import / export), event tables
// (CSV) as samples, $SPILLOVER in exported FCS files.
import { existsSync, readFileSync } from 'node:fs';
import { getSpillover, parseFcs, writeFcs } from '../src/core/fcs';
import { eventTableDataset, EventTableParser, looksLikeEventTable, parseEventStream, parseEventTable, TABLE_ORIGIN, TABLE_ORIGIN_KEY } from '../src/core/eventtable';
import { mapChannelName, mapMatrixNames, matrixToText, parseDelimitedMatrix, parseFlowJoMatrixXml, readMatrixFile, sniffMatrix, transpose } from '../src/core/matrixio';
import { parseCytExpertComp, parseNrbf } from '../src/core/nrbf';
import { invertMatrix } from '../src/core/compensation';
import { emptyWorkspace, type CompDef } from '../src/core/model';
import { engine } from '../src/core/engine';
import { exportKeywords, fmtNum, openFiles, populationCsv, serializeWorkspace } from '../src/io/files';
import { relinkSample, useStore } from '../src/state/store';
import { strToU8, zipSync } from 'fflate';

const NANO = '/home/claude/testdata/online/figshare_31855687_cytoflex_nano';
const COMP = `${NANO}/compensation_liposome_atto.comp`;
const LIPO = `${NANO}/Liposomes_mixRBG_150_100k.fcs`;
const ATTO = `${NANO}/150_ATTO488_Det_100.000_1.fcs`;
const SONY = '/home/claude/testdata/online/figshare_30376627_33color/NoManualAdjustment_Spillover_LSM_A.csv';
const WSP = '/home/claude/testdata/online/flowkit/8_color_ICS.wsp';
const buf = (p: string) => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const close = (a: number[][], b: number[][], tol = 1e-9) => {
  expect(a.length).toBe(b.length);
  a.forEach((r, i) => r.forEach((v, j) => expect(Math.abs(v - b[i][j]), `[${i}][${j}] ${v} vs ${b[i][j]}`).toBeLessThan(tol)));
};

// ------------------------------------------------------------------ CytExpert .comp

describe('CytExpert .comp (MS-NRBF)', () => {
  it.skipIf(!existsSync(COMP) || !existsSync(LIPO))('reads the real file: Height and Area matrices, transposed to the $SPILLOVER layout of the same experiment', () => {
    const bytes = new Uint8Array(readFileSync(COMP));
    const { matrices, notes } = parseCytExpertComp(bytes);
    expect(matrices.map((m) => m.kind)).toEqual(['H', 'A']);
    for (const m of matrices) expect(m.detectors).toEqual(['V447', 'B531', 'Y595', 'R670', 'R710', 'R792']);
    expect(matrices[0].background).toEqual([0, 375, 375, 375, 0, 0]);
    expect(matrices[1].background).toEqual([0, 7500, 7500, 7500, 0, 0]);
    expect(matrices[1].gain).toEqual([3000, 3000, 3000, 3000, 3000, 3000]);
    expect(notes).toEqual([]);
    expect(parseNrbf(bytes).trailing).toBe(216); // "CytExpert nano Integrity Check" (UTF-32) and a checksum
    // B531 spills 19.0 % into Y595 (Height), 22.3 % (Area)
    expect(matrices[0].spill[1][2]).toBeCloseTo(0.1902279, 7);
    expect(matrices[1].spill[1][2]).toBeCloseTo(0.2233701, 7);

    // the FCS file of the same experiment: $PnN FL1-A.., $PnS "V447-A"..; $SPILLOVER 12 x 12 (FL1-H..FL6-H, FL1-A..FL6-A)
    const ds = parseFcs(buf(LIPO));
    const sp = getSpillover(ds)!;
    const [imp] = readMatrixFile('compensation_liposome_atto.comp', bytes, ds.channels);
    const fl = (s: string) => [1, 2, 3, 4, 5, 6].map((k) => `FL${k}-${s}`);
    expect(imp.channels).toEqual([...fl('H'), ...fl('A')]);
    expect(imp.unmapped).toEqual([]);
    expect(imp.renamed).toContain('B531-A -> FL2-A');
    expect(sp.channels).toEqual(imp.channels);
    // equal to $SPILLOVER except the V447 fluorochrome rows, which the FCS files compensate and this .comp does not
    imp.matrix.forEach((row, i) =>
      row.forEach((v, j) => {
        if (i === 0 || i === 6) expect(v).toBe(i === j ? 1 : 0);
        else expect(Math.abs(v - sp.matrix[i][j])).toBeLessThan(1e-7);
      }),
    );
    // CytExpert's own text keywords: COMPA is the same matrix with rows = detectors
    const compa = ds.keywords['COMPA'].split('\t').map(Number);
    for (let d = 1; d < 6; d++) for (let s = 1; s < 6; s++) expect(Math.abs(imp.matrix[6 + s][6 + d] - compa[d * 6 + s])).toBeLessThan(1e-7);
  });

  it.skipIf(!existsSync(COMP) || !existsSync(ATTO))('a Height-only sample gets the Height matrix; detectors are found in labels like "Atto488 B531-H"', () => {
    const ds = parseFcs(buf(ATTO));
    const [imp] = readMatrixFile('x.comp', new Uint8Array(readFileSync(COMP)), ds.channels);
    expect(imp.channels).toEqual(['FL1-H', 'FL2-H', 'FL3-H', 'FL4-H', 'FL5-H', 'FL6-H']);
    expect(imp.notes.join(' ')).toMatch(/Area matrix was left out/);
    expect(imp.matrix[1][2]).toBeCloseTo(0.1902279, 7);
  });

  it.skipIf(!existsSync(COMP))('without samples the names are kept as CytExpert detectors with -H / -A', () => {
    const [imp] = readMatrixFile('x.comp', new Uint8Array(readFileSync(COMP)), []);
    expect(imp.channels.slice(0, 2)).toEqual(['V447-H', 'B531-H']);
    expect(imp.channels.slice(6, 8)).toEqual(['V447-A', 'B531-A']);
    expect(imp.unmapped).toEqual([]);
  });

  // ---- a synthetic stream, written as BinaryFormatter writes it
  const enc = new TextEncoder();
  const i32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    return [...b];
  };
  const f32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    return [...b];
  };
  const lps = (s: string) => {
    const u = enc.encode(s);
    return [u.length, ...u];
  };
  function compStream(names: string[], stored: number[][], opts: { nullGains?: boolean } = {}): number[] {
    const n = names.length;
    const out: number[] = [0, ...i32(1), ...i32(-1), ...i32(1), ...i32(0)];
    out.push(12, ...i32(2), ...lps('CTG_Tube_RDC, Version=1.0.0.0'));
    out.push(5, ...i32(1), ...lps('CTG_Tube_RDC.CompensationInfo'), ...i32(3), ...lps('m_ArrayChannelName'), ...lps('m_CompensationMatrix'), ...lps('m_ArrayGain'));
    out.push(6, 3, 7, ...lps('System.Single[,]'), 8, ...i32(2));
    out.push(9, ...i32(3), 9, ...i32(4), 9, ...i32(5));
    out.push(17, ...i32(3), ...i32(n));
    names.forEach((nm, k) => out.push(6, ...i32(10 + k), ...lps(nm)));
    out.push(7, ...i32(4), 2, ...i32(2), ...i32(n), ...i32(n), 0, 11, ...stored.flat().flatMap(f32));
    // gains as a jagged array of objects with a run of nulls, to cover ObjectNullMultiple256
    if (opts.nullGains) out.push(16, ...i32(5), ...i32(n), 13, n);
    else out.push(15, ...i32(5), ...i32(n), 8, ...names.flatMap(() => i32(3000)));
    out.push(11);
    return out;
  }
  const intStream = (v: number) => [0, ...i32(1), ...i32(-1), ...i32(1), ...i32(0), 4, ...i32(1), ...lps('System.Int32'), ...i32(1), ...lps('m_value'), 0, 8, ...i32(v), 11];

  it('reads a synthetic stream (single matrix = Area; stored rows = detectors)', () => {
    const stored = [
      [1, 0, 0],
      [0.25, 1, 0.01],
      [0.05, 0.125, 1],
    ];
    const bytes = new Uint8Array([...intStream(4), ...compStream(['V450', 'B525', 'Y585'], stored)]);
    const { roots } = parseNrbf(bytes);
    expect(roots.length).toBe(2);
    const { matrices } = parseCytExpertComp(bytes);
    expect(matrices.length).toBe(1);
    expect(matrices[0].kind).toBe('A');
    expect(matrices[0].detectors).toEqual(['V450', 'B525', 'Y585']);
    expect(matrices[0].gain).toEqual([3000, 3000, 3000]);
    const nulls = parseCytExpertComp(new Uint8Array(compStream(['V450', 'B525', 'Y585'], stored, { nullGains: true })));
    expect(nulls.matrices[0].gain).toBeUndefined();
    close(nulls.matrices[0].spill, transpose(stored), 1e-7);
    close(matrices[0].spill, transpose(stored), 1e-7);
    const [imp] = readMatrixFile('s.comp', bytes, [
      { name: 'FL1-A', label: 'V450-A' },
      { name: 'FL2-A', label: 'B525-A' },
      { name: 'FL3-A', label: 'Y585-A' },
    ]);
    expect(imp.channels).toEqual(['FL1-A', 'FL2-A', 'FL3-A']);
    expect(imp.matrix[0][1]).toBe(0.25);
    expect(sniffMatrix('s.comp', bytes)).toBe(true);
  });

  it('fails clearly on unknown records, a cut-off stream and other .NET objects', () => {
    const good = compStream(['V450', 'B525'], [
      [1, 0],
      [0.1, 1],
    ]);
    // a record type the reader does not know (21: a remoting method call) in place of the first member
    const bad = [...good];
    const at = good.indexOf(9);
    bad[at] = 21;
    expect(() => parseCytExpertComp(new Uint8Array(bad))).toThrow(/unsupported record type 21/);
    expect(() => parseCytExpertComp(new Uint8Array(good.slice(0, good.length - 30)))).toThrow(/file ends inside|no end record/);
    expect(() => parseCytExpertComp(new Uint8Array(intStream(7)))).toThrow(/No CytExpert compensation .* System\.Int32/);
    expect(() => parseCytExpertComp(new TextEncoder().encode('V447\tB531\n1\t0\n0\t1'))).toThrow(/does not start with a stream header/);
  });
});

// ------------------------------------------------------------------ delimited text matrices

describe('matrix text files', () => {
  const S = [
    [1, 0.2150175, 0.02021618],
    [0, 1, 0.1902279],
    [0.001751388, 0.0053, 1],
  ];
  const names = ['FITC-A', 'PE-A', 'PE-Cy7-A'];
  it('tab-separated with a corner cell, fractions (FlowState / FlowLogic layout); round trip of the export', () => {
    const txt = matrixToText({ channels: names, matrix: S }, '\t');
    expect(txt.split('\r\n')[0]).toBe('\tFITC-A\tPE-A\tPE-Cy7-A');
    const m = parseDelimitedMatrix(txt);
    expect(m.names).toEqual(names);
    close(m.matrix, S);
    expect(m.notes).toEqual([]);
    const csv = parseDelimitedMatrix(matrixToText({ channels: names, matrix: S }, ','));
    close(csv.matrix, S);
  });
  it('header without a corner cell, rows named; comma; percent', () => {
    const t = ['FITC-A,PE-A,PE-Cy7-A', ...S.map((r, i) => [names[i], ...r.map((v) => (v * 100).toString())].join(','))].join('\n');
    const m = parseDelimitedMatrix(t);
    expect(m.names).toEqual(names);
    close(m.matrix, S);
    expect(m.notes.join(' ')).toMatch(/percent/);
  });
  it('semicolon with decimal commas, diagonal 100, header only (no row names)', () => {
    const t = ['FITC-A;PE-A;PE-Cy7-A', ...S.map((r) => r.map((v) => String(v * 100).replace('.', ',')).join(';'))].join('\r\n');
    const m = parseDelimitedMatrix(t);
    close(m.matrix, S);
  });
  it('a compensation (inverse) matrix is inverted back to the spillover', () => {
    const inv = invertMatrix(S);
    const t = ['\t' + names.join('\t'), ...inv.map((r, i) => [names[i], ...r].join('\t'))].join('\n');
    const m = parseDelimitedMatrix(t);
    close(m.matrix, S, 1e-9);
    expect(m.notes.join(' ')).toMatch(/inverted/);
  });
  it('rows = detectors: by the corner cell, or by the detector wavelengths', () => {
    const tr = transpose(S);
    const byCorner = parseDelimitedMatrix(['Detector \\ Fluorochrome\t' + names.join('\t'), ...tr.map((r, i) => [names[i], ...r].join('\t'))].join('\n'));
    close(byCorner.matrix, S);
    expect(byCorner.notes.join(' ')).toMatch(/rows are detectors/);
    // CytExpert-style names, stored like COMPA (rows = detectors): the spill would go to shorter wavelengths
    const det = ['V447', 'B531', 'Y595', 'R670'];
    const spill = [
      [1, 0.21, 0.02, 0.009],
      [0, 1, 0.19, 0.0065],
      [0, 0.0017, 1, 0.144],
      [0, 0, 0, 1],
    ];
    const asStored = transpose(spill);
    const m = parseDelimitedMatrix(['\t' + det.join('\t'), ...asStored.map((r, i) => [det[i], ...r].join('\t'))].join('\n'));
    close(m.matrix, spill);
    expect(m.notes.join(' ')).toMatch(/transposed/);
    // the same in the right orientation is left alone
    const ok = parseDelimitedMatrix(['\t' + det.join('\t'), ...spill.map((r, i) => [det[i], ...r].join('\t'))].join('\n'));
    close(ok.matrix, spill);
    expect(ok.notes).toEqual([]);
  });
  it('rows in another order than the columns are reordered', () => {
    const order = [2, 0, 1];
    const t = ['\t' + names.join('\t'), ...order.map((i) => [names[i], ...S[i]].join('\t'))].join('\n');
    close(parseDelimitedMatrix(t).matrix, S);
  });
  it('tables that are no matrix are rejected (not square, no names, no unit diagonal)', () => {
    expect(() => parseDelimitedMatrix('A,B,C\n1,2,3\n4,5,6\n7,8,9')).toThrow(/diagonal is not 1/);
    expect(() => parseDelimitedMatrix('1\t0\n0\t1')).toThrow(/no channel names/);
    expect(() => parseDelimitedMatrix('FSC-A,SSC-A\n1,2\n3,4\n5,6')).toThrow(/not a square/);
    expect(sniffMatrix('events.csv', new TextEncoder().encode('FSC-A,SSC-A\n1,2\n3,4\n5,6'))).toBe(false);
  });
  it.skipIf(!existsSync(SONY))('a Sony spectral reference table is neither a matrix nor an event table', () => {
    const b = new Uint8Array(readFileSync(SONY));
    expect(sniffMatrix('x.csv', b)).toBe(false);
    expect(looksLikeEventTable(new TextDecoder().decode(b))).toBe(false);
  });
});

// ------------------------------------------------------------------ FlowJo matrix XML

describe('FlowJo matrix XML (.mtx)', () => {
  const mtx = `<?xml version="1.0" encoding="UTF-8"?>
<gating:gatingML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <transforms:spilloverMatrix spectral="0" prefix="Comp-" name="Panel A" editable="1" suffix="">
    <data-type:parameters>
      <data-type:parameter data-type:name="FITC-A" userProvidedCompInfix="Comp-FITC-A"/>
      <data-type:parameter data-type:name="PE-A" userProvidedCompInfix="Comp-PE-A"/>
    </data-type:parameters>
    <transforms:spillover data-type:parameter="FITC-A">
      <transforms:coefficient data-type:parameter="FITC-A" transforms:value="1"/>
      <transforms:coefficient data-type:parameter="PE-A" transforms:value="0.215"/>
    </transforms:spillover>
    <transforms:spillover data-type:parameter="PE-A">
      <transforms:coefficient data-type:parameter="FITC-A" transforms:value="0.0017"/>
      <transforms:coefficient data-type:parameter="PE-A" transforms:value="1"/>
    </transforms:spillover>
  </transforms:spilloverMatrix>
</gating:gatingML>`;
  it('reads the matrix (rows = fluorochromes) and names it after the file and the matrix', () => {
    const [m] = parseFlowJoMatrixXml(mtx);
    expect(m.names).toEqual(['FITC-A', 'PE-A']);
    close(m.matrix, [
      [1, 0.215],
      [0.0017, 1],
    ]);
    const [imp] = readMatrixFile('panel.mtx', new TextEncoder().encode(mtx), [{ name: 'FITC-A' }, { name: 'PE-A' }]);
    expect(imp.name).toBe('panel (Panel A)');
    expect(sniffMatrix('panel.mtx', new TextEncoder().encode(mtx))).toBe(true);
    expect(() => parseFlowJoMatrixXml(mtx.replace('spectral="0"', 'spectral="1"'))).toThrow(/spectral/);
  });
  it.skipIf(!existsSync(WSP))('finds the matrices in a FlowJo workspace too', () => {
    const ms = parseFlowJoMatrixXml(readFileSync(WSP, 'utf8'));
    expect(ms[0].names.length).toBe(8);
    expect(ms[0].matrix[0][1]).toBeCloseTo(0.0141385011, 9);
  });
});

// ------------------------------------------------------------------ channel names

describe('matching matrix names to channels', () => {
  const chans = [
    { name: 'FSC-A' },
    { name: 'FITC-A', label: 'CD3' },
    { name: 'FITC-H', label: 'CD3' },
    { name: 'PE-A', label: 'CD4' },
    { name: 'FL3-A', label: 'Atto565 Y595-A' },
    { name: 'APC' },
  ];
  it.each([
    ['FITC-A', 'FITC-A'],
    ['fitc-a', 'FITC-A'],
    ['Comp-FITC-A', 'FITC-A'],
    ['FJComp-PE-A', 'PE-A'],
    ['FITC', 'FITC-A'],
    ['APC-A', 'APC'],
    ['CD3', 'FITC-A'],
    ['CD4', 'PE-A'],
    ['FITC-A :: CD3', 'FITC-A'],
    ['Y595-A', 'FL3-A'],
  ])('%s -> %s', (n, ch) => {
    expect(mapChannelName(n, chans)?.channel).toBe(ch);
  });
  it('reports names without a channel, keeps exact names first', () => {
    const r = mapMatrixNames(['CD3', 'FITC-A', 'BV421-A'], chans);
    // "CD3" cannot take FITC-A (named exactly by another entry): it gets the Height channel with that label
    expect(r.channels).toEqual(['FITC-H', 'FITC-A', 'BV421-A']);
    expect(r.unmapped).toEqual(['BV421-A']);
  });
});

// ------------------------------------------------------------------ event tables

function rand(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('event tables (CSV) as samples', () => {
  const r = rand(7);
  const n = 3000;
  const chans = [
    { name: 'FSC-A', label: '', range: 262144 },
    { name: 'FITC-A', label: 'CD3', range: 262144 },
    { name: 'Time', label: '', range: 1000 },
  ];
  const cols = [
    Float32Array.from({ length: n }, () => r() * 262144),
    Float32Array.from({ length: n }, () => (r() - 0.2) * Math.pow(10, r() * 6)),
    Float32Array.from({ length: n }, (_, i) => i * 0.0123),
  ];
  cols[1][0] = 1.0000001; // needs 8 digits to read back
  cols[1][1] = -3.4028235e38;
  cols[1][2] = 1.401298e-45;

  it('fmtNum gives values that read back to the same float32', () => {
    for (const a of cols) for (const v of a) expect(Math.fround(Number(fmtNum(v)))).toBe(v);
  });

  it('round trip: FlowState CSV export, imported again: same names, labels and values', () => {
    const csv = populationCsv(chans, cols);
    expect(csv.split('\n')[0]).toBe('FSC-A,FITC-A :: CD3,Time');
    const t = parseEventTable(csv);
    expect(t.names).toEqual(['FSC-A', 'FITC-A', 'Time']);
    expect(t.labels).toEqual(['', 'CD3', '']);
    expect(t.rows).toBe(n);
    t.data.forEach((a, k) => expect(a).toEqual(cols[k]));
    expect(t.notes).toEqual([]);
    // read in pieces cut anywhere (also inside lines and numbers)
    const p = new EventTableParser();
    for (let i = 0; i < csv.length; i += 997) p.push(csv.slice(i, i + 997));
    p.finish().data.forEach((a, k) => expect(a).toEqual(cols[k]));
  });

  it('as a sample: FCS dataset without compensation keywords, marked as imported from CSV', () => {
    const t = parseEventTable(populationCsv(chans, cols));
    const { ds, bytes } = eventTableDataset(t, 'pop.csv');
    expect(ds.keywords[TABLE_ORIGIN_KEY]).toBe(TABLE_ORIGIN);
    expect(getSpillover(ds)).toBeNull();
    expect(ds.channels[1].label).toBe('CD3');
    expect(ds.channels[0].range).toBeGreaterThanOrEqual(Math.max(...cols[0]));
    const back = parseFcs(bytes);
    expect(back.keywords).toEqual(ds.keywords);
    back.data.forEach((a, k) => expect(a).toEqual(cols[k]));
    expect(back.channels.map((c) => c.range)).toEqual(ds.channels.map((c) => c.range));
  });

  it('FlowJo / FlowLogic style tables: tab or semicolon, decimal commas, quotes, CRLF, no header, text columns', () => {
    const a = parseEventTable('"FSC-A"\t"SSC-A"\t"Comp-PE-A :: CD4"\r\n1.5\t2\t-3.25\r\n4\t5\t6\r\n');
    expect(a.names).toEqual(['FSC-A', 'SSC-A', 'Comp-PE-A']);
    expect(a.labels[2]).toBe('CD4');
    expect(Array.from(a.data[2])).toEqual([-3.25, 6]);
    const b = parseEventTable('FSC-A;SSC-A\n1,5;2,25\n3;4\n');
    expect(Array.from(b.data[0])).toEqual([1.5, 3]);
    expect(Array.from(b.data[1])).toEqual([2.25, 4]);
    const c = parseEventTable('1,2,3\n4,5,6\n');
    expect(c.names).toEqual(['P1', 'P2', 'P3']);
    expect(c.rows).toBe(2);
    const d = parseEventTable('Sample,FSC-A,SSC-A\ntube1,1,2\ntube1,3,x\ntube1,5,\n');
    expect(d.names).toEqual(['FSC-A', 'SSC-A']);
    expect(Array.from(d.data[1])).toEqual([2, 0, 0]);
    expect(d.notes.join(' ')).toMatch(/Text columns left out: Sample/);
    expect(d.notes.join(' ')).toMatch(/1 cell that are not numbers/);
    expect(() => parseEventTable('FSC-A,SSC-A\n')).toThrow(/no rows of values/);
    expect(() => parseEventTable('')).toThrow(/empty/);
  });

  it('reads a stream in pieces (yielding between them)', async () => {
    const csv = populationCsv(chans, cols);
    const f = new File([csv], 'big.csv');
    let calls = 0;
    const t = await parseEventStream(f.stream() as ReadableStream<Uint8Array>, { yieldBytes: 10000, onProgress: () => calls++ });
    expect(calls).toBeGreaterThan(0);
    t.data.forEach((a, k) => expect(a).toEqual(cols[k]));
  });

  it('a million events parse in reasonable time', () => {
    const m = 1_000_000;
    const lines = ['FSC-A,SSC-A,FITC-A,PE-A,APC-A,Time'];
    for (let i = 0; i < m; i++) lines.push(`${(i * 7) % 262144},${(i * 13) % 100000}.5,${i % 977}.25,-${i % 31},${i % 1000}.125,${i}`);
    const csv = lines.join('\n');
    const t0 = Date.now();
    const t = parseEventTable(csv);
    const ms = Date.now() - t0;
    expect(t.rows).toBe(m);
    expect(t.data[5][m - 1]).toBe(m - 1);
    expect(ms).toBeLessThan(15000);
  });

  it('sniffing: event tables vs matrices', () => {
    expect(looksLikeEventTable(populationCsv(chans, cols).slice(0, 5000), true)).toBe(true);
    expect(looksLikeEventTable('\tFITC-A\tPE-A\nFITC-A\t1\t0.1\nPE-A\t0\t1')).toBe(false);
    expect(sniffMatrix('m.txt', new TextEncoder().encode('\tFITC-A\tPE-A\nFITC-A\t1\t0.1\nPE-A\t0\t1'))).toBe(true);
  });
});

// ------------------------------------------------------------------ opening files, FCS export keywords

describe('opening matrix and event table files; exported FCS keywords', () => {
  const S = [
    [1, 0.2, 0.03],
    [0.01, 1, 0.15],
    [0, 0.002, 1],
  ];
  function sampleFcs(): Uint8Array {
    const r = rand(3);
    const nEv = 500;
    const data = [0, 1, 2, 3].map(() => Float32Array.from({ length: nEv }, () => r() * 10000));
    return writeFcs({
      channels: [
        { name: 'FSC-A', range: 262144 },
        { name: 'FITC-A', label: 'CD3', range: 262144 },
        { name: 'PE-A', label: 'CD4', range: 262144 },
        { name: 'APC-A', label: 'CD8', range: 262144 },
      ],
      data,
      keywords: { $SPILLOVER: '3,FITC-A,PE-A,APC-A,1,0.1,0,0,1,0.1,0,0,1' },
    });
  }

  it('a matrix .txt dropped with an FCS file is matched to its channels; a CSV becomes a sample', async () => {
    useStore.getState().replaceWorkspace(emptyWorkspace());
    const txt = matrixToText({ channels: ['Comp-FITC-A', 'Comp-PE-A', 'APC'], matrix: S }, '\t');
    const csv = 'FSC-A,FITC-A :: CD3\n1.5,2.25\n3,4\n5,6\n';
    await openFiles([new File([txt], 'panel.txt'), new File([sampleFcs() as BlobPart], 's1.fcs'), new File([csv], 'events.csv')]);
    const ws = useStore.getState().ws;
    const imp = ws.compensations.find((c) => c.source === 'imported') as CompDef;
    expect(imp.name).toBe('panel');
    expect(imp.channels).toEqual(['FITC-A', 'PE-A', 'APC-A']);
    close(imp.matrix, S);
    const ev = ws.samples.find((s) => s.fileName === 'events.csv')!;
    expect(ev.name).toBe('events');
    expect(ev.info?.['Origin']).toBe(TABLE_ORIGIN);
    expect(ev.compId).toBeNull();
    expect(Array.from(engine.raw(ws, ev.id, 'FITC-A')!)).toEqual([2.25, 4, 6]);
    expect(ev.channels[1].label).toBe('CD3');
    const toasts = useStore.getState().ui.toasts.map((t) => t.text).join(' | ');
    expect(toasts).toMatch(/Imported the 3x3 compensation matrix "panel"/);
    expect(toasts).toMatch(/events\.csv: 3 events, 2 channels/);
  });

  it('a sample read from CSV survives a bundle (FCS bytes under its .csv name) and relinks from the CSV file', async () => {
    useStore.getState().replaceWorkspace(emptyWorkspace());
    const csv = 'FSC-A;SSC-A :: side\n1,5;2\n3;4,25\n';
    await openFiles([new File([csv], 'tbl.csv')]);
    const ws = useStore.getState().ws;
    const s = ws.samples[0];
    const bytes = new Uint8Array(engine.samples.get(s.id)!.bytes as ArrayBuffer);
    const zip = zipSync({ 'workspace.flowstate.json': strToU8(serializeWorkspace(ws)), [`fcs/${s.id}/tbl.csv`]: bytes });
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    await openFiles([new File([zip as BlobPart], 'b.flowstate.zip')]);
    const ws2 = useStore.getState().ws;
    expect(Array.from(engine.raw(ws2, s.id, 'FSC-A')!)).toEqual([1.5, 3]);
    // the workspace alone: the sample waits for its file; "Locate file" with the CSV links it
    const saved = serializeWorkspace(ws2);
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    useStore.getState().replaceWorkspace(emptyWorkspace());
    await openFiles([new File([saved], 'w.flowstate.json')]);
    expect(engine.has(s.id)).toBe(false);
    await relinkSample(s.id, new File([csv], 'tbl.csv'));
    expect(Array.from(engine.raw(useStore.getState().ws, s.id, 'SSC-A')!)).toEqual([2, 4.25]);
  });

  it('files that are neither matrix nor event table are reported', async () => {
    useStore.getState().replaceWorkspace(emptyWorkspace());
    const t0 = useStore.getState().ui.toasts.length;
    await openFiles([new File(['Name,Value\nfoo,bar\nbaz,qux\n'], 'notes.csv'), new File([new Uint8Array([1, 2, 3])], 'x.comp')]);
    const t = useStore.getState().ui.toasts.slice(t0).filter((x) => x.kind === 'error').map((x) => x.text);
    expect(t.find((x) => x.startsWith('notes.csv:'))).toMatch(/neither a compensation matrix .* nor an event table/);
    expect(t.find((x) => x.startsWith('x.comp:'))).toMatch(/not a readable compensation matrix/);
  });

  it('uncompensated FCS export carries the matrix the sample uses as $SPILLOVER; compensated export none', () => {
    const ds = parseFcs(sampleFcs().buffer as ArrayBuffer);
    const acq = getSpillover(ds)!;
    // the sample uses its acquisition matrix: keywords unchanged
    const same: CompDef = { id: 'c1', name: 'Acq', channels: acq.channels, matrix: acq.matrix, source: 'file' };
    expect(exportKeywords(ds, same, false).$SPILLOVER).toBe(ds.keywords.$SPILLOVER);
    expect(exportKeywords(ds, null, false).$SPILLOVER).toBe(ds.keywords.$SPILLOVER);
    // an edited / imported matrix replaces it (channels the sample lacks are left out)
    const mine: CompDef = { id: 'c2', name: 'Mine', channels: ['FITC-A', 'PE-A', 'BV421-A'], matrix: [[1, 0.2, 0.5], [0.01, 1, 0.5], [0.5, 0.5, 1]], source: 'imported' };
    const kw = exportKeywords({ ...ds, keywords: { ...ds.keywords, SPILL: 'old', COMPA: '1\t0\t0\t1', COMPCHA: 'B531\tY595', USCOMP: 'True' } }, mine, false);
    expect(kw.$SPILLOVER).toBe('2,FITC-A,PE-A,1,0.2,0.01,1');
    // no other (outdated) matrix keyword is left for a program to pick
    for (const k of ['SPILL', 'COMPA', 'COMPCHA', 'USCOMP']) expect(kw[k]).toBeUndefined();
    const back = parseFcs(writeFcs({ channels: ds.channels, data: ds.data, keywords: kw }).buffer as ArrayBuffer);
    expect(getSpillover(back)?.matrix).toEqual([
      [1, 0.2],
      [0.01, 1],
    ]);
    const comp = exportKeywords({ ...ds, keywords: { ...ds.keywords, COMPH: '1\t0\t0\t1', USCOMP: 'True' } }, mine, true);
    expect(comp.$SPILLOVER).toBeUndefined();
    expect(comp.COMPH).toBeUndefined();
  });
});
