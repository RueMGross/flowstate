// QC fixes: percent vs fractions of compensation matrices is decided by the diagonal (spill above 1 is real: BD
// PE-Cy5 into PerCP-Cy5.5, up to 1.29 in FlowKit's 100715 / 113548 files), in matrix files (matrixio) and in the
// Beckman $COMP keyword (fcs.ts compKeyword).
import { existsSync, readFileSync } from 'fs';
import { compensate, invertMatrix } from '../src/core/compensation';
import { getSpillover, parseFcs } from '../src/core/fcs';
import { matrixToText, parseDelimitedMatrix, readMatrixFile } from '../src/core/matrixio';

const DL = '/tmp/claude-0/dl/FlowKit/data';
const FILES = ['100715.fcs', '113548.fcs'].map((f) => `${DL}/${f}`);

const maxDiff = (a: number[][], b: number[][]) => Math.max(...a.flatMap((r, i) => r.map((v, j) => Math.abs(v - b[i][j]))));
const enc = (s: string) => new TextEncoder().encode(s);

// the G block of 100715.fcs: three spill values above 1 (G780 -> G560 1.238, G710 -> G780 1.150, G610 -> G660 1.218)
const G_CH = ['G780-A', 'G710-A', 'G660-A', 'G610-A', 'G560-A'];
const G_SPILL = [
  [1, 0.06689784643460173, 0.16145640353506588, 0.2868231743828476, 1.2380368696528024],
  [1.1500323358669722, 1, 0.016076827046672983, 0.014674146885307975, 0.055351746085494],
  [0.49748791920091034, 0.7439226300384197, 1, 0.010329232815907474, 0.03763461149817695],
  [0.3702770755789083, 0.6134900271606913, 1.2180240147472128, 1, 0.06521131251063482],
  [0.023802192010810994, 0.049474451704249904, 0.13251071256825273, 0.23921555785727822, 1],
];

describe('matrix files: percent or fractions by the diagonal', () => {
  it('a matrix with spill above 1 survives export -> import unchanged (.txt and .csv)', () => {
    for (const delim of ['\t', ','] as const) {
      const txt = matrixToText({ channels: G_CH, matrix: G_SPILL }, delim);
      const [m] = readMatrixFile(delim === '\t' ? 'm.txt' : 'm.csv', enc(txt), G_CH.map((name) => ({ name })));
      expect(m.channels).toEqual(G_CH);
      expect(maxDiff(m.matrix, G_SPILL)).toBeLessThan(1e-9);
      expect(m.matrix.map((r, i) => r[i])).toEqual([1, 1, 1, 1, 1]);
      expect(m.notes.join(' ')).not.toMatch(/percent/);
    }
  });

  it.skipIf(!FILES.every(existsSync))('round trip of the 100715 / 113548 acquisition matrices; compensated data are the same', () => {
    for (const f of FILES) {
      const b = readFileSync(f);
      const ds = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      const sp = getSpillover(ds)!;
      let maxOff = 0;
      sp.matrix.forEach((r, i) => r.forEach((v, j) => i !== j && (maxOff = Math.max(maxOff, v))));
      expect(maxOff).toBeGreaterThan(1.2);
      const idx = sp.channels.map((c) => ds.channels.findIndex((x) => x.name === c));
      const ref = compensate(ds.data, idx, sp.matrix);
      for (const delim of ['\t', ','] as const) {
        const txt = matrixToText({ channels: sp.channels, matrix: sp.matrix }, delim);
        const [m] = readMatrixFile(delim === '\t' ? 'm.txt' : 'm.csv', enc(txt), ds.channels.map((c) => ({ name: c.name, label: c.label })));
        expect(m.channels).toEqual(sp.channels);
        const d = maxDiff(m.matrix, sp.matrix);
        expect(d).toBeLessThan(1e-9);
        expect(m.matrix.every((r, i) => r[i] === 1)).toBe(true);
        expect(m.notes).toEqual([]);
        // the compensated events are those of the file's own matrix
        const got = compensate(ds.data, idx, m.matrix);
        let worst = 0;
        for (const k of idx) for (let e = 0; e < got[k].length; e++) worst = Math.max(worst, Math.abs(got[k][e] - ref[k][e]) / Math.max(1, Math.abs(ref[k][e])));
        expect(worst).toBeLessThan(1e-5);
        const med = (a: Float32Array) => Float32Array.from(a).sort()[a.length >> 1];
        console.log(`${f.split('/').pop()} ${delim === '\t' ? 'TXT' : 'CSV'}: n=${sp.channels.length}, max spill ${maxOff.toFixed(3)}, max |diff| ${d.toExponential(1)}, median ${sp.channels[0]} file ${med(ref[idx[0]])} reimported ${med(got[idx[0]])}`);
      }
    }
  });

  it('a diagonal of 100 means percent, also when no value off it exceeds 1 (or one exceeds 100)', () => {
    const small = parseDelimitedMatrix('\tFITC-A\tPE-A\nFITC-A\t100\t0.5\nPE-A\t0.8\t100\n');
    expect(maxDiff(small.matrix, [[1, 0.005], [0.008, 1]])).toBeLessThan(1e-12);
    expect(small.notes.join(' ')).toMatch(/percent/);
    const big = parseDelimitedMatrix('\tPE-Cy5-A\tPerCP-Cy5.5-A\nPE-Cy5-A\t100\t123.8\nPerCP-Cy5.5-A\t12\t100\n');
    expect(maxDiff(big.matrix, [[1, 1.238], [0.12, 1]])).toBeLessThan(1e-12);
  });

  it('a diagonal of 1 keeps fractions; only spill above 300 % is percent (the diagonal of 1 is never scaled)', () => {
    const fr = parseDelimitedMatrix(',FITC-A,PE-A,PE-Cy5-A,PerCP-Cy5.5-A\nFITC-A,1,0.22,0.03,0.01\nPE-A,0.01,1,0.35,0.08\nPE-Cy5-A,0,0.02,1,1.25\nPerCP-Cy5.5-A,0,0,0.12,1\n');
    expect(fr.matrix[2][3]).toBe(1.25);
    expect(fr.notes).toEqual([]);
    const pc = parseDelimitedMatrix(',FL1-A,FL2-A\nFL1-A,1,71.9\nFL2-A,1.1,1\n');
    expect(maxDiff(pc.matrix, [[1, 0.719], [0.011, 1]])).toBeLessThan(1e-12);
    expect(pc.notes.join(' ')).toMatch(/can only be percent \(the diagonal of 1 was kept\)/);
  });

  it('a compensation matrix with values below -1 is inverted, not read as percent', () => {
    const S = [[1, 1.2, 0], [0, 1, 0], [0, 0.02, 1]];
    const C = invertMatrix(S); // [[1, -1.2, 0], [0, 1, 0], [0, -0.02, 1]]
    const m = parseDelimitedMatrix(matrixToText({ channels: ['FITC-A', 'PE-A', 'APC-A'], matrix: C }, ','));
    expect(maxDiff(m.matrix, S)).toBeLessThan(1e-12);
    expect(m.notes.join(' ')).toMatch(/inverted/);
    expect(m.notes.join(' ')).not.toMatch(/percent/);
  });

  it('a table without names and a diagonal that is neither 1 nor 100 is still no matrix', () => {
    expect(() => parseDelimitedMatrix('A,B,C\n1,2,3\n4,5,6\n7,8,9')).toThrow(/diagonal is not 1/);
  });
});

describe('Beckman $COMP: percent or fractions', () => {
  const chans = ['FS-A', 'SS-A', 'FL1-A', 'FL2-A', 'TIME'].map((name) => ({ name, label: '' }));
  const sp = (comp: string) => getSpillover({ keywords: { $COMP: comp }, channels: chans });
  it('a diagonal of 100 means percent even when no value off it exceeds 1', () => {
    // $COMP[detector][source]: FL1 -> FL2 0.8 %, FL2 -> FL1 0.5 % (was rejected before: diagonal 100 without percent)
    const s = sp('2,100,0.5,0.8,100');
    expect(s?.channels).toEqual(['FL1-A', 'FL2-A']);
    expect(maxDiff(s!.matrix, [[1, 0.008], [0.005, 1]])).toBeLessThan(1e-12);
  });
  it('a diagonal of 1 keeps the Kaluza layout: values above 1 are percent', () => {
    expect(maxDiff(sp('2,1,1.1,71.9,1')!.matrix, [[1, 0.719], [0.011, 1]])).toBeLessThan(1e-12);
    expect(sp('2,1,0.02,0.1,1')!.matrix).toEqual([[1, 0.1], [0.02, 1]]);
  });
});
