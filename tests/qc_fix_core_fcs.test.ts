// QC fixes in the FCS reader / writer: $PnR follows $PnE log linearization and $PnG gain division; ASCII data get the
// same conversion as integer data; the writer's HEADER gives 0 / 0 for a segment that does not fit 8 digits.
import { fcsHeader, parseFcs, writeFcs, type FcsDataset } from '../src/core/fcs';
import { buildFcs, toBuf } from './fcsBuilder';

const col = (ds: FcsDataset, name: string) => Array.from(ds.data[ds.channels.findIndex((c) => c.name === name)]);
const ch = (ds: FcsDataset, name: string) => ds.channels.find((c) => c.name === name)!;

describe('$PnR after $PnE / $PnG conversion', () => {
  it('log-amplified integer channels: range f2 x 10^f1 (f2 0 counts as 1); the bit mask still uses $PnR as written', () => {
    const ds = parseFcs(
      toBuf(
        buildFcs({
          datatype: 'I',
          pars: [
            { name: 'FL1-H', bits: 16, range: 1024, e: '4,0' },
            { name: 'FL2-H', bits: 16, range: 1024, e: '4,1' },
            { name: 'FL3-H', bits: 16, range: 1024, e: '3,10' },
            { name: 'FSC-H', bits: 16, range: 1024 },
          ],
          data: [
            [0, 512, 1023, 1029], // 1029 & 1023 = 5
            [0, 512, 1023, 0],
            [0, 512, 1023, 0],
            [0, 512, 1023, 0],
          ],
        }),
      ),
    );
    expect(ch(ds, 'FL1-H').range).toBe(10000);
    expect(ch(ds, 'FL2-H').range).toBe(10000);
    expect(ch(ds, 'FL3-H').range).toBe(10000);
    expect(ch(ds, 'FSC-H').range).toBe(1024);
    const fl1 = col(ds, 'FL1-H');
    expect(fl1[1]).toBeCloseTo(100, 3);
    expect(fl1[2]).toBeCloseTo(Math.pow(10, (4 * 1023) / 1024), 2);
    expect(fl1[3]).toBeCloseTo(Math.pow(10, (4 * 5) / 1024), 5);
    expect(col(ds, 'FL3-H')[1]).toBeCloseTo(10 * Math.pow(10, 1.5), 3);
    // every value lies within the range
    for (const c of ds.channels) expect(Math.max(...col(ds, c.name))).toBeLessThanOrEqual(c.range);
  });

  it('linear integer channels with a gain: values and range divided by $PnG (not Time)', () => {
    const ds = parseFcs(
      toBuf(
        buildFcs({
          datatype: 'I',
          pars: [
            { name: 'FL1', bits: 16, range: 1024, g: '4' },
            { name: 'Time', bits: 16, range: 1024, g: '4' },
          ],
          data: [
            [0, 256, 1023],
            [0, 256, 1023],
          ],
        }),
      ),
    );
    expect(col(ds, 'FL1')).toEqual([0, 64, 255.75]);
    expect(ch(ds, 'FL1').range).toBe(256);
    expect(col(ds, 'Time')).toEqual([0, 256, 1023]);
    expect(ch(ds, 'Time').range).toBe(1024);
  });

  it('a linearized log channel written and read again keeps its values and range', () => {
    const ds = parseFcs(toBuf(buildFcs({ datatype: 'I', pars: [{ name: 'FL1-H', bits: 16, range: 1024, e: '4,1' }], data: [[0, 300, 1023]] })));
    const back = parseFcs(toBuf(writeFcs({ channels: ds.channels, data: ds.data })));
    expect(back.channels[0].range).toBe(ds.channels[0].range);
    expect(Array.from(back.data[0])).toEqual(Array.from(ds.data[0]));
  });
});

/** FCS 2.0 file with ASCII data: FSC ($P1G 2) and FL1 ($P2E 4,1); events x parameters `vals`. */
function asciiFcs(delimited: boolean, vals: number[][]): ArrayBuffer {
  const data = delimited ? vals.map((r) => r.join(',')).join('\n') : vals.map((r) => r.map((v) => String(v).padStart(4, '0')).join('')).join('');
  const b = delimited ? '*' : '4';
  const kw = (s: number, e: number) =>
    `/$BYTEORD/1,2,3,4/$DATATYPE/A/$MODE/L/$NEXTDATA/0/$PAR/2/$TOT/${vals.length}/$P1N/FSC/$P1B/${b}/$P1R/1024/$P1E/0,0/$P1G/2/$P2N/FL1/$P2B/${b}/$P2R/1024/$P2E/4,1/$BEGINDATA/${String(s).padStart(8, '0')}/$ENDDATA/${String(e).padStart(8, '0')}/`;
  const textLen = kw(0, 0).length;
  const ds = 58 + textLen;
  const de = ds + data.length - 1;
  const hdr = 'FCS2.0    ' + [58, 58 + textLen - 1, ds, de, 0, 0].map((n) => String(n).padStart(8, ' ')).join('');
  return new TextEncoder().encode(hdr + kw(ds, de) + data).buffer as ArrayBuffer;
}

describe('ASCII data ($DATATYPE A) get the $PnE / $PnG conversion', () => {
  for (const delimited of [false, true])
    it(delimited ? 'delimited' : 'fixed width', () => {
      const ds = parseFcs(asciiFcs(delimited, [[0, 512], [256, 1023]]));
      expect(col(ds, 'FSC')).toEqual([0, 128]);
      expect(ch(ds, 'FSC').range).toBe(512);
      const fl1 = col(ds, 'FL1');
      expect(fl1[0]).toBeCloseTo(100, 3);
      expect(fl1[1]).toBeCloseTo(Math.pow(10, (4 * 1023) / 1024), 2);
      expect(ch(ds, 'FL1').range).toBe(10000);
    });
});

describe('FCS writer HEADER offsets', () => {
  it('a segment that ends beyond 99,999,999 gets 0 for begin and end', () => {
    const h = fcsHeader('FCS3.1', [[256, 871], [872, 104000871], [0, 0]]);
    expect(h).toHaveLength(58);
    expect(h).toBe('FCS3.1         256     871       0       0       0       0');
    // just fitting: kept
    expect(fcsHeader('FCS3.1', [[256, 871], [872, 99999999], [0, 0]]).slice(26, 42)).toBe('     87299999999');
    // TEXT too (never a begin without its end)
    expect(fcsHeader('FCS3.1', [[99999990, 100000100], [0, 0], [0, 0]]).slice(10, 26)).toBe('       0       0');
  });
  it('writeFcs: HEADER and TEXT agree for a normal file; an empty DATA segment is end = begin - 1', () => {
    const out = writeFcs({ channels: [{ name: 'A', range: 1024 }, { name: 'B', range: 1024 }], data: [Float32Array.of(1, 2, 3), Float32Array.of(4, 5, 6)] });
    const hdr = new TextDecoder().decode(out.subarray(0, 58));
    const off = [10, 18, 26, 34].map((k) => Number(hdr.slice(k, k + 8).trim()));
    expect(off[0]).toBe(256);
    expect(off[3] - off[2] + 1).toBe(24);
    expect(off[3]).toBe(out.length - 1);
    const ds = parseFcs(toBuf(out));
    expect(Number(ds.keywords['$BEGINDATA'])).toBe(off[2]);
    expect(Number(ds.keywords['$ENDDATA'])).toBe(off[3]);
    expect(ds.warnings).toEqual([]);
    const empty = new TextDecoder().decode(writeFcs({ channels: [{ name: 'A', range: 1024 }], data: [new Float32Array(0)] }).subarray(0, 58));
    expect(Number(empty.slice(34, 42)) - Number(empty.slice(26, 34))).toBe(-1);
  });
});
