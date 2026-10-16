// Opt-in (ONLINE_DATA=1): the 166 public FCS / LMD files in /home/claude/testdata/online (see its README.md):
//   - every file is read (two are corrupt on purpose), with checks for the reader fixes on the files they came from;
//   - the comparison with FlowIO / FlowKit (testdata/online/_scripts/compare.py, needs python3 with flowio, flowkit and
//     numpy): every file must match FlowIO except the listed ones, where FlowIO is wrong or reads differently by design;
//   - the FlowJo 9 (Mac) workspaces of Bioconductor's flowWorkspaceData against FlowJo's stored counts.
// Run: ONLINE_DATA=1 npx vitest run tests/fcs_online.test.ts
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSpillover, parseFcs, parseFcsAll, parseFcsSamples, type FcsDataset } from '../src/core/fcs';
import { importFlowJo } from '../src/core/flowjo';
import { Engine } from '../src/core/engine';
import { popPath } from '../src/core/model';

const ONLINE = '/home/claude/testdata/online';
const RUN = process.env.ONLINE_DATA === '1' && existsSync(ONLINE);
const SCRIPTS = join(ONLINE, '_scripts');
const HAVE_PY =
  RUN && existsSync(join(SCRIPTS, 'compare.py')) && spawnSync('python3', ['-I', '-c', 'import flowio, flowkit, numpy'], { encoding: 'utf8' }).status === 0;

/** FCS / LMD files: by extension, or by the "FCS" magic (files such as "060909.001"). */
function walk(d: string): string[] {
  return readdirSync(d)
    .sort()
    .flatMap((f) => {
      const p = join(d, f);
      if (statSync(p).isDirectory()) return f === '_scripts' ? [] : walk(p);
      if (/\.(fcs|lmd)$/i.test(f)) return [p];
      const head = readFileSync(p).subarray(0, 3).toString('latin1');
      return head === 'FCS' ? [p] : [];
    });
}
const files = RUN ? walk(ONLINE) : [];
const rel = (f: string) => f.slice(ONLINE.length + 1);
const load = (r: string) => {
  const b = readFileSync(join(ONLINE, r));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const col = (ds: FcsDataset, name: string) => ds.data[ds.channels.findIndex((c) => c.name === name)];

// test files of other parsers that are invalid on purpose (fcsparser: a truncated file, a header without data)
const EXPECTED_ERRORS: Record<string, RegExp> = {
  'fcsparser/corrupted.fcs': /Not an FCS file/,
  'fcsparser/sample_header.fcs': /DATA segment truncated/,
};

describe.skipIf(!RUN)('online test data: every file', () => {
  it('finds the 166 files', () => expect(files).toHaveLength(166));
  for (const f of files) {
    it(rel(f), () => {
      const ab = load(rel(f));
      const bad = EXPECTED_ERRORS[rel(f)];
      if (bad) {
        expect(() => parseFcs(ab)).toThrow(bad);
        return;
      }
      const parts = parseFcsSamples(ab);
      expect(parts.length).toBeGreaterThan(0);
      for (const p of parts) {
        expect(p.ds.eventCount).toBeGreaterThan(0);
        expect(new Set(p.ds.channels.map((c) => c.name)).size).toBe(p.ds.channels.length);
        expect(p.ds.channels.every((c) => c.range > 0)).toBe(true);
        // $ENDDATA one byte off is not reported
        const offByOne = p.ds.warnings.filter((w) => {
          const m = /DATA segment length \((\d+)\) differs from expected \((\d+)\)/.exec(w);
          return !!m && Math.abs(Number(m[1]) - Number(m[2])) <= 1;
        });
        expect(offByOne).toEqual([]);
      }
    });
  }
});

describe.skipIf(!RUN)('online test data: reader fixes', () => {
  it('CyAn: the HEADER DATA offset (right after TEXT) wins over $BEGINDATA', () => {
    const ds = parseFcs(load('cytoflow/Beckman_Coulter_Cyan.fcs'));
    expect(Array.from(col(ds, 'Event Count').subarray(0, 4))).toEqual([2, 3, 4, 5]);
    expect(ds.warnings.join(' ')).toMatch(/using HEADER 2284, ignoring TEXT \$BEGINDATA 2330/);
  });
  it('Accuri C6: the stale $BEGINDATA inside TEXT is ignored with a note', () => {
    expect(parseFcs(load('cytoflow/Accuri_C6.fcs')).warnings.join(' ')).toMatch(/using HEADER 2960, ignoring TEXT \$BEGINDATA 2526 \(starts inside the TEXT segment\)/);
  });
  it('Gallios LMD: $SPILLOVER by parameter numbers, $COMP agrees, keywords of the FCS 2.0 part', () => {
    const parts = parseFcsSamples(load('zenodo_17197319_lmd/sample_1mem 001.LMD'));
    expect(parts).toHaveLength(1);
    const ds = parts[0].ds;
    expect(ds.keywords['$CYT']).toBe('Gallios');
    expect(ds.channels.find((c) => c.name === 'FL1-A')!.label).toBe('CD62L FITC');
    const sp = getSpillover(ds)!;
    expect(sp.keyword).toBe('$SPILLOVER');
    expect(sp.channels).toEqual(['FL1-A', 'FL2-A', 'FL3-A', 'FL4-A', 'FL5-A', 'FL6-A', 'FL7-A', 'FL8-A', 'FL9-A', 'FL10-A']);
    expect(sp.matrix[0][1]).toBeCloseTo(0.119, 6);
    // the Kaluza $COMP alone gives the same matrix (transposed, percent)
    const comp = getSpillover({ keywords: { $COMP: ds.keywords['$COMP'] }, channels: ds.channels })!;
    expect(comp.channels).toEqual(sp.channels);
    comp.matrix.forEach((row, i) => row.forEach((v, j) => expect(Math.abs(v - sp.matrix[i][j])).toBeLessThan(6e-4)));
  });
  it('spillover with parameter numbers (Accuri, Apogee) and decimal commas (German Accuri C6)', () => {
    expect(getSpillover(parseFcs(load('cytoflow/Accuri_C6.fcs')))?.channels).toEqual(['FL1-A', 'FL2-A', 'FL3-A', 'FL4-A', 'FL1-H', 'FL2-H', 'FL3-H', 'FL4-H']);
    expect(getSpillover(parseFcs(load('figshare_31833808_ev_assay_controls/20230215_dPBS_0.fcs')))?.channels).toHaveLength(7);
    const de = getSpillover(parseFcs(load('figshare_26106262_attune_nxt/A05_A14_K_100_9.fcs')))!;
    expect(de.keyword).toBe('$SPILLOVER (identity)');
    expect(de.channels).toHaveLength(8);
  });
  it('FCS 3.2 $PnDATATYPE: the integer parameters of a FACSDiscover file', () => {
    const ds = parseFcs(load('zenodo_19221995_facsdiscover/Zam39 GFP.fcs'));
    const ints = ds.channels.filter((c) => (ds.keywords[`$P${c.index + 1}DATATYPE`] ?? '').trim() === 'I');
    expect(ints).toHaveLength(22);
    const ev = col(ds, 'EventNumber0');
    expect(ev[0]).toBeGreaterThan(1000);
    expect(Number.isInteger(ev[0])).toBe(true);
  });
  it('Guava: one sample per well, HLog channels linearized to the HLin values', () => {
    const parts = parseFcsSamples(load('cytoflow/Millipore_Guava.fcs'));
    expect(parts.map((p) => p.ds.dataset!.label)).toEqual(
      ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'B01', 'B02', 'B03'].map((w, i) => `#${i + 1} ${w}`),
    );
    for (const p of parts) {
      const lin = col(p.ds, 'GRN-HLin');
      const log = col(p.ds, 'GRN-HLog');
      for (let i = 0; i < lin.length; i++) if (lin[i] >= 1.5) expect(Math.abs(log[i] / lin[i] - 1)).toBeLessThan(1e-5);
      expect(parseFcsAll(p.bytes)).toHaveLength(1);
    }
    expect(parseFcsSamples(load('cytoflow/Guava_Muse.fcs')).map((p) => p.ds.eventCount)).toEqual([108, 50081, 111496, 50037]);
  });
  it('duplicate $PnN (Rosetta-calibrated Apogee export) become unique', () => {
    const ds = parseFcs(load('zenodo_4561815_ev_calibration/Figure_3_calibration/01A 40x CD61-APC CD62p-PE_A1_0_PSD_settings_1_PSD_settings_2_Flow-SR_medium_PBS_MESF_PSD_1.fcs'));
    expect(ds.channels.map((c) => c.name).filter((n) => n.startsWith('Diameter (nm) based on SSC'))).toEqual(['Diameter (nm) based on SSC', 'Diameter (nm) based on SSC (2)']);
    expect(ds.warnings[0]).toMatch(/^Parameter names occur more than once/);
  });
  it('LMD files: $CYT of the FCS 2.0 part', () => {
    expect(parseFcs(load('cytoflow/Beckman_Coulter_Gallios.LMD')).keywords['$CYT']).toBe('Gallios');
    expect(parseFcs(load('cytoflow/Beckman_Coulter_Cytomics_FC500.LMD')).keywords['$CYT']).toBe('Cytomics FC 500');
  });
});

// ------------------------------------------------------------------ FlowIO comparison

/** Files where the app differs from FlowIO 1.4 on purpose (FlowIO is wrong or reads differently). */
const KNOWN_DIFF: Record<string, RegExp> = {
  // FlowIO reads the stale $BEGINDATA (inside TEXT); the app the HEADER offset (independent reader: identical)
  'cytoflow/Accuri_C6.fcs': /value mismatch/,
  // FlowIO uses $BEGINDATA, 46 bytes too far; the HEADER offset follows TEXT (independent reader: identical)
  'cytoflow/Beckman_Coulter_Cyan.fcs': /value mismatch/,
  // HLog channels (log10 decades in float data) are linearized by the app
  'cytoflow/Millipore_Guava.fcs': /^value mismatch in 6 channels \['FSC-HLog', 'GRN-ALog', 'GRN-HLog', 'RED-HLog', 'SSC-HLog', 'YEL-HLog'\]/,
  'cytoflow/Guava_Muse.fcs': /^value mismatch in 3 channels \['FSC-HLog', 'RED-HLog', 'YEL-HLog'\]/,
  // FlowIO drops a parameter of this FCS 2.0 file
  'flowcore/0877408774.B08': /channel names differ/,
  // FlowIO 1.4 ignores FCS 3.2 $PnDATATYPE (reads the integer parameters as float bit patterns)
  'zenodo_19221995_facsdiscover/Zam39 GFP.fcs': /value mismatch/,
};

/** The app's reading of each file in compare.py's input format (as testdata/online/_scripts/check.ts writes it). */
function dump(outDir: string, f: string) {
  const id = createHash('md5').update(f).digest('hex').slice(0, 12);
  const meta: Record<string, unknown> = { file: f, id };
  try {
    const ab = load(rel(f));
    const ds = parseFcs(ab);
    const all = parseFcsAll(ab);
    meta.datasets = all.map((d) => ({ version: d.version, eventCount: d.eventCount, nPar: d.channels.length, names: d.channels.map((c) => c.name) }));
    meta.version = ds.version;
    meta.eventCount = ds.eventCount;
    meta.channels = ds.channels.map((c) => ({ name: c.name, label: c.label, range: c.range }));
    meta.warnings = ds.warnings;
    meta.cyt = ds.keywords['$CYT'] ?? null;
    const sp = getSpillover(ds);
    meta.spill = sp ? { keyword: sp.keyword, channels: sp.channels, n: sp.channels.length } : null;
    const n = ds.eventCount;
    const h = Math.min(1000, n);
    const t = Math.min(1000, Math.max(0, n - h));
    meta.head = h;
    meta.tail = t;
    const buf = new Float32Array(ds.channels.length * (h + t));
    let o = 0;
    for (const a of ds.data) {
      buf.set(a.subarray(0, h), o);
      o += h;
      buf.set(a.subarray(n - t, n), o);
      o += t;
    }
    writeFileSync(join(outDir, id + '.bin'), Buffer.from(buf.buffer));
    meta.colStats = ds.data.map((a) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += a[i];
      return [s, 0, 0];
    });
    meta.ok = true;
  } catch (e) {
    meta.ok = false;
    meta.error = String((e as Error)?.message ?? e);
  }
  writeFileSync(join(outDir, id + '.json'), JSON.stringify(meta));
}

describe.skipIf(!HAVE_PY)('online test data: comparison with FlowIO / FlowKit', () => {
  it(
    'matches FlowIO except where FlowIO is wrong',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'fcs-online-'));
      for (const f of files) dump(dir, f);
      const list = join(dir, 'files.txt');
      writeFileSync(list, files.join('\n') + '\n');
      const out = join(dir, 'results.json');
      const r = spawnSync('python3', ['-I', join(SCRIPTS, 'compare.py'), dir, out, '@' + list], { encoding: 'utf8', timeout: 15 * 60_000 });
      expect(r.status, r.stderr).toBe(0);
      const res: { file: string; status: string; issues?: string[] }[] = JSON.parse(readFileSync(out, 'utf8'));
      expect(res).toHaveLength(files.length);
      const tally: Record<string, number> = {};
      for (const x of res) {
        const k = rel(x.file);
        tally[x.status] = (tally[x.status] ?? 0) + 1;
        if (x.status === 'MISMATCH') {
          expect(KNOWN_DIFF[k], `${k}: ${x.issues?.join('; ')}`).toBeDefined();
          expect(x.issues!.join('; ')).toMatch(KNOWN_DIFF[k]);
        } else if (x.status === 'BOTH_ERROR') expect(EXPECTED_ERRORS[k], k).toBeDefined();
        else expect(['OK', 'APP_ONLY', 'FLOWIO_ARRAY_ERROR'], `${k}: ${x.status}`).toContain(x.status);
      }
      console.log('FlowIO comparison:', JSON.stringify(tally));
      expect(tally.OK).toBeGreaterThanOrEqual(150);
    },
    20 * 60_000,
  );
});

// ------------------------------------------------------------------ FlowJo 9 workspaces

describe.skipIf(!RUN || !existsSync(join(ONLINE, 'bioc_flowWorkspaceData')))('online test data: FlowJo 9 (Mac) workspaces', () => {
  const D = join(ONLINE, 'bioc_flowWorkspaceData');
  for (const [wsf, minCounts] of [
    ['manual.xml', 40],
    ['A2004Analysis.xml', 30],
  ] as const) {
    it(`${wsf}: counts close to FlowJo's`, () => {
      const res = importFlowJo(readFileSync(join(D, wsf), 'utf8'), { name: wsf });
      const ws = res.workspace;
      expect(ws.populations.length).toBeGreaterThan(10);
      const eng = new Engine();
      let n = 0;
      let sumD = 0;
      let sumFj = 0;
      const worst: string[] = [];
      for (const s of ws.samples) {
        const f = join(D, s.fileName);
        if (!existsSync(f)) continue;
        const b = readFileSync(f);
        const ds = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
        if (ds.eventCount !== s.eventCount) continue; // same file name, another acquisition
        eng.addSample(s.id, ds);
        for (const p of ws.populations) {
          const fj = res.counts[s.id]?.[p.id];
          if (fj === undefined || fj < 0) continue;
          const c = eng.count(ws, s.id, p.id);
          const d = Math.abs(c - fj);
          n++;
          sumD += d;
          sumFj += fj;
          if (d > Math.max(10, 0.05 * fj)) worst.push(`${s.name} ${popPath(ws, p.id)}: ${c} vs FlowJo ${fj}`);
          if (fj >= 10000) expect(d / fj, `${s.name} ${popPath(ws, p.id)}: ${c} vs FlowJo ${fj}`).toBeLessThan(0.01);
        }
      }
      console.log(`${wsf}: ${n} counts, total |app - FlowJo| = ${((100 * sumD) / sumFj).toFixed(2)} % of FlowJo's`);
      expect(worst).toEqual([]);
      expect(n).toBeGreaterThanOrEqual(minCounts);
      expect(sumD / sumFj).toBeLessThan(0.005);
    });
  }
});
