import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseFcs, parseFcsAll, getSpillover, parseTextSegment, writeFcs } from '../src/core/fcs';

// Local test files (skipped when the folder is missing). The public collection in testdata/online (166 files, some
// corrupt on purpose) is read by the opt-in test tests/fcs_online.test.ts (ONLINE_DATA=1).
const ROOT = '/home/claude/testdata';
const SKIP_DIRS = new Set(['gml', 'truth', 'online', '_scripts']);
function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? (SKIP_DIRS.has(f) ? [] : walk(p)) : /\.(fcs|lmd)$/i.test(f) ? [p] : [];
  });
}
const files = existsSync(ROOT) ? walk(ROOT) : [];

// test files of other parsers that are invalid on purpose (fcsparser: a truncated file, a header without data):
// a clear error, not a crash or an empty dataset
const EXPECTED_ERRORS: Record<string, RegExp> = {
  'fcsparser/corrupted.fcs': /Not an FCS file/,
  'fcsparser/sample_header.fcs': /DATA segment truncated/,
};

describe.skipIf(!files.length)('FCS parsing', () => {
  const summary: Record<string, unknown> = {};
  for (const f of files) {
    it(f.replace(ROOT + '/', ''), () => {
      const b = readFileSync(f);
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      const bad = Object.entries(EXPECTED_ERRORS).find(([k]) => f.endsWith('/' + k));
      if (bad) {
        expect(() => parseFcs(ab)).toThrow(bad[1]);
        return;
      }
      const all = parseFcsAll(ab);
      const ds = parseFcs(ab);
      const spill = getSpillover(ds);
      summary[f] = {
        n: ds.eventCount,
        datasets: all.map((d) => d.version + ':' + d.eventCount),
        version: ds.version,
        channels: ds.channels.map((c) => c.name),
        first: ds.data.map((a) => a[0]),
        last: ds.data.map((a) => a[ds.eventCount - 1]),
        sums: ds.data.map((a) => a.reduce((s, v) => s + v, 0)),
        spill: spill ? spill.keyword + ' ' + spill.channels.length : null,
        warnings: ds.warnings,
      };
      expect(ds.eventCount).toBeGreaterThan(0);
    });
  }
  afterAll(() => {
    try {
      mkdirSync('/tmp/claude-0', { recursive: true });
      writeFileSync('/tmp/claude-0/fcs_summary.json', JSON.stringify(summary));
    } catch {
      // the summary is only a debugging aid
    }
  });
});

describe('FCS writer roundtrip', () => {
  it('roundtrips', () => {
    const data = [Float32Array.from([1, 2, 3.5]), Float32Array.from([-4, 5e5, 6])];
    const bytes = writeFcs({ channels: [{ name: 'FSC-A', range: 262144 }, { name: 'FITC-A', label: 'CD4|x', range: 262144 }], data, keywords: { $FIL: 'test.fcs', $SPILLOVER: '1,FITC-A,1' } });
    const ds = parseFcs(bytes.buffer as ArrayBuffer);
    expect(ds.eventCount).toBe(3);
    expect(ds.channels[1].label).toBe('CD4|x');
    expect(Array.from(ds.data[1])).toEqual([-4, 5e5, 6]);
    expect(ds.keywords['$FIL']).toBe('test.fcs');
  });
});

describe('FCS TEXT segment', () => {
  const kw = (s: string) => parseTextSegment(new TextEncoder().encode(s));
  it('reads an empty value without swallowing the next keyword', () => {
    expect(kw('/$P1S//$BYTEORD/4,3,2,1/$DATATYPE/I/$PAR/1/')).toEqual({ $P1S: '', $BYTEORD: '4,3,2,1', $DATATYPE: 'I', $PAR: '1' });
  });
  it('keeps escaped delimiters inside values', () => {
    expect(kw('/$FIL/a//b/K2/x///K3/y/')).toEqual({ $FIL: 'a/b', K2: 'x/', K3: 'y' });
    expect(kw('/K1///start/K2/v/')).toEqual({ K1: '/start', K2: 'v' });
  });
});

describe('FCS writer', () => {
  const kwOf = (b: Uint8Array) => parseFcs(b.buffer as ArrayBuffer).keywords;
  it('picks a delimiter that occurs in no keyword or value', () => {
    const b = writeFcs({ channels: [{ name: 'FL1-A', label: 'CD4 |/x', range: 1024 }], data: [Float32Array.from([1, 2])], keywords: { WEIRD: '|start', END: 'end|' } });
    const text = new TextDecoder().decode(b.subarray(256, 260));
    expect(text[0]).not.toBe('|');
    expect(text[0]).not.toBe('/');
    const k = kwOf(b);
    expect(k['WEIRD']).toBe('|start');
    expect(k['END']).toBe('end|');
    expect(k['$P1S']).toBe('CD4 |/x');
  });
  it('writes consistent offsets for an empty data segment', () => {
    const b = writeFcs({ channels: [{ name: 'FL1-A', range: 1024 }], data: [new Float32Array(0)] });
    const hdr = new TextDecoder().decode(b.subarray(0, 58));
    const k = kwOf(b);
    expect(Number(hdr.slice(26, 34))).toBe(Number(k['$BEGINDATA']));
    expect(Number(hdr.slice(34, 42))).toBe(Number(k['$ENDDATA']));
    expect(Number(k['$ENDDATA'])).toBe(Number(k['$BEGINDATA']) - 1);
    const ds = parseFcs(b.buffer as ArrayBuffer);
    expect(ds.eventCount).toBe(0);
    expect(ds.warnings).toEqual([]);
  });
  it('writes $PnR covering linearized values', () => {
    const b = writeFcs({
      channels: [
        { name: 'FL1-H', range: 1024, logDecades: 4, logOffset: 1 },
        { name: 'FL2-H', range: 1024 },
      ],
      data: [Float32Array.from([1, 9910.5]), Float32Array.from([-2000.5, 3])],
    });
    const k = kwOf(b);
    expect(k['$P1R']).toBe('10000');
    expect(k['$P1E']).toBe('0,0');
    expect(k['$P1G']).toBe('1');
    expect(k['$P2R']).toBe('2002');
  });
});
