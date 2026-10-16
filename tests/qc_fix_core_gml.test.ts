// QC fixes in Gating-ML import / export and the engine: non-square and already inverted spectrum matrices; a bad
// matrix never breaks evaluation; compensation-ref="FCS" only for a sample's own acquisition matrix.
import { compensate, invertMatrix } from '../src/core/compensation';
import { Engine, engine as appEngine } from '../src/core/engine';
import { parseFcs, writeFcs, type FcsDataset } from '../src/core/fcs';
import { exportGatingMLDoc, importGatingML, type GmlExportOptions } from '../src/core/gatingml';
import { emptyWorkspace, type CompDef, type Population, type Workspace } from '../src/core/model';

const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;
const dim = (n: string) => `<data-type:fcs-dimension data-type:name="${n}"/>`;
const spectrum = (r: number[]) => `<transforms:spectrum>${r.map((v) => `<transforms:coefficient transforms:value="${v}"/>`).join('')}</transforms:spectrum>`;
const matrixXml = (id: string, fl: string[], det: string[], rows: number[][], inverted = false) =>
  `<transforms:spectrumMatrix transforms:id="${id}"${inverted ? ' transforms:matrix-inverted-already="true"' : ''}><transforms:fluorochromes>${fl.map(dim).join('')}</transforms:fluorochromes><transforms:detectors>${det.map(dim).join('')}</transforms:detectors>${rows.map(spectrum).join('')}</transforms:spectrumMatrix>`;
const rangeGate = (id: string, ch: string, ref: string, min: number, parent?: string) =>
  `<gating:RectangleGate gating:id="${id}"${parent ? ` gating:parent_id="${parent}"` : ''}><gating:dimension gating:compensation-ref="${ref}" gating:min="${min}">${dim(ch)}</gating:dimension></gating:RectangleGate>`;
const doc = (...parts: string[]) => `<gating:Gating-ML ${NS}>${parts.join('')}</gating:Gating-ML>`;

let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

/** FL1-A / FL2-A / FL3-A events (FL2 gets 15 % of FL1), optionally with a $SPILLOVER over FL1-A / FL2-A. */
function dataset(spill: number[][] | null, n = 20000, s = 11): FcsDataset {
  seed = s;
  const f1 = new Float32Array(n), f2 = new Float32Array(n), f3 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    f1[i] = (rnd() < 0.5 ? 3000 * Math.exp(gauss()) : 0) + gauss() * 150;
    f2[i] = (rnd() < 0.4 ? 8000 * Math.exp(gauss()) : 0) + gauss() * 200 + 0.15 * f1[i];
    f3[i] = 100 + i;
  }
  const keywords: Record<string, string> = spill ? { $SPILLOVER: `2,FL1-A,FL2-A,${spill.flat().join(',')}` } : {};
  const chans = ['FL1-A', 'FL2-A', 'FL3-A'].map((name) => ({ name, range: 262144 }));
  return parseFcs(writeFcs({ channels: chans, data: [f1, f2, f3], keywords }).buffer as ArrayBuffer);
}

const sample = (id: string, compId: string | null) => ({ id, name: id, fileName: `${id}.fcs`, fileSize: 0, eventCount: 20000, channels: ['FL1-A', 'FL2-A', 'FL3-A'].map((name) => ({ name, label: '', range: 262144 })), compId });

describe('Gating-ML import: spectrum matrices the engine cannot use', () => {
  it('a non-square matrix is skipped, and so are the gates using it (and their children)', () => {
    const xml = doc(
      matrixXml('M', ['F1', 'F2'], ['FL1-A', 'FL2-A', 'FL3-A'], [[1, 0.5, 0.1], [0.05, 1, 0.3]]),
      rangeGate('G', 'F2', 'M', 100),
      rangeGate('Child', 'FL1-A', 'uncompensated', 0, 'G'),
      rangeGate('Other', 'FL3-A', 'uncompensated', 5000),
    );
    const res = importGatingML(xml, { perGateComp: true });
    expect(res.compensations).toEqual([]);
    expect(res.populations.map((p) => p.name)).toEqual(['Other']);
    const w = res.warnings.join('\n');
    expect(w).toMatch(/Spectrum matrix "M" was skipped: it is not square \(2 fluorochromes, 3 detectors\)/);
    expect(w).toMatch(/Gate G skipped: it uses spectrum matrix "M"/);
    expect(w).toMatch(/Gate Child skipped: its parent "G" was not imported/);
  });

  it('matrix-inverted-already="true": the compensation matrix is inverted back to the spillover', () => {
    const S = [[1, 0.2], [0.05, 1]];
    const C = invertMatrix(S);
    const res = importGatingML(doc(matrixXml('C', ['FL1-A', 'FL2-A'], ['FL1-A', 'FL2-A'], C, true), rangeGate('G', 'FL2-A', 'C', 1500)), { perGateComp: true });
    expect(res.warnings).toEqual([]);
    const m = res.compensations[0].matrix;
    m.forEach((r, i) => r.forEach((v, j) => expect(v).toBeCloseTo(S[i][j], 12)));
    // counts as the plain spillover matrix does
    const plain = importGatingML(doc(matrixXml('S', ['FL1-A', 'FL2-A'], ['FL1-A', 'FL2-A'], S), rangeGate('G', 'FL2-A', 'S', 1500)), { perGateComp: true });
    const e = new Engine();
    e.addSample('s', dataset(null));
    const ws = (r: typeof res): Workspace => ({ ...emptyWorkspace(), compensations: r.compensations, populations: r.populations, samples: [sample('s', null)] });
    const n = e.count(ws(res), 's', res.populations[0].id);
    expect(n).toBe(e.count(ws(plain), 's', plain.populations[0].id));
    expect(n).toBeGreaterThan(1000);
  });

  it('a singular "already inverted" matrix is skipped with its gates', () => {
    const res = importGatingML(doc(matrixXml('C', ['FL1-A', 'FL2-A'], ['FL1-A', 'FL2-A'], [[1, 1], [1, 1]], true), rangeGate('G', 'FL2-A', 'C', 1500)), { perGateComp: true });
    expect(res.compensations).toEqual([]);
    expect(res.populations).toEqual([]);
    expect(res.warnings.join('\n')).toMatch(/Spectrum matrix "C" was skipped: it is marked as already inverted, but it cannot be inverted back/);
  });
});

describe('engine: a bad compensation matrix leaves the data uncompensated instead of throwing', () => {
  const bad: [string, CompDef][] = [
    ['not square', { id: 'b1', name: 'bad', channels: ['FL1-A', 'FL2-A', 'FL3-A'], matrix: [[1, 0.5, 0.1], [0.05, 1, 0.3]], source: 'gatingml' }],
    ['ragged', { id: 'b2', name: 'bad', channels: ['FL1-A', 'FL2-A'], matrix: [[1, 0.5], [0.05]], source: 'manual' }],
    ['NaN', { id: 'b3', name: 'bad', channels: ['FL1-A', 'FL2-A'], matrix: [[1, NaN], [0.05, 1]], source: 'manual' }],
    ['null value', { id: 'b4', name: 'bad', channels: ['FL1-A', 'FL2-A'], matrix: [[1, null as unknown as number], [0.05, 1]], source: 'manual' }],
  ];
  for (const [what, comp] of bad)
    it(what, () => {
      const e = new Engine();
      const ds = dataset(null, 2000);
      e.addSample('s', ds);
      const pop: Population = { id: 'p', name: 'p', parentId: null, color: '#000000', gate: { type: 'range', x: 'FL2-A', min: 1500, max: Infinity, comp: comp.id } };
      const ws: Workspace = { ...emptyWorkspace(), compensations: [comp], populations: [pop], samples: [sample('s', comp.id)] };
      const warn = console.warn;
      console.warn = () => {};
      try {
        expect(() => e.count(ws, 's', 'p')).not.toThrow();
        expect(e.data(ws, 's')).toBe(ds.data);
      } finally {
        console.warn = warn;
      }
    });
});

describe('Gating-ML export: compensation-ref="FCS" only for a sample\'s own acquisition matrix', () => {
  const A = [[1, 0.2], [0.05, 1]];
  const B = [[1, 0.4], [0.1, 1]];
  const dsA = dataset(A);
  const dsB = dataset(B, 20000, 12);
  const dsNo = dataset(null, 20000, 13);
  const acq = (id: string, m: number[][]): CompDef => ({ id, name: `Acquisition matrix ${id}`, channels: ['FL1-A', 'FL2-A'], matrix: m, source: 'file' });
  const pops: Population[] = [{ id: 'pos', name: 'FL2 pos', parentId: null, color: '#123456', gate: { type: 'range', x: 'FL2-A', min: 1500, max: Infinity } }];

  /** Export, import and count every sample in the app and as other software would (perGateComp import). */
  function roundTrip(w: Workspace, dss: Record<string, FcsDataset>, opts: GmlExportOptions = {}) {
    const d = exportGatingMLDoc(w, opts);
    const res = importGatingML(d.xml, { perGateComp: true });
    const w2: Workspace = { ...emptyWorkspace(), compensations: [...w.compensations, ...res.compensations], samples: w.samples.map((s) => ({ ...s })), populations: res.populations, scales: w.scales };
    const e1 = new Engine();
    const e2 = new Engine();
    for (const [id, ds] of Object.entries(dss)) {
      e1.addSample(id, ds);
      e2.addSample(id, ds);
    }
    const counts = w.samples.map((s) => [e1.count(w, s.id, 'pos'), e2.count(w2, s.id, res.populations[0].id)]);
    return { xml: d.xml, warnings: d.warnings, counts };
  }
  const refs = (xml: string) => [...new Set([...xml.matchAll(/compensation-ref="([^"]*)"/g)].map((m) => m[1]))];

  it('a file without a matrix using another file\'s acquisition matrix: written out (QC repro 7281 vs 7572)', () => {
    const w: Workspace = { ...emptyWorkspace(), compensations: [acq('acq1', A)], samples: [sample('qa1', 'acq1'), sample('qa2', 'acq1')], populations: pops };
    const dss = { qa1: dsA, qa2: dsNo };
    // default: the app's engine knows the files
    appEngine.addSample('qa1', dsA);
    appEngine.addSample('qa2', dsNo);
    try {
      const r = roundTrip(w, dss);
      expect(refs(r.xml)).not.toContain('FCS');
      expect(r.xml).toMatch(/<transforms:spectrumMatrix transforms:id="acq1">/);
      for (const [app, other] of r.counts) expect(other).toBe(app);
      console.log('own matrix + other file using it: counts (app, re-imported)', JSON.stringify(r.counts));
    } finally {
      appEngine.removeSample('qa1');
      appEngine.removeSample('qa2');
    }
  });

  it('"Use Acquisition matrix 2 for all samples": written out; the explicit lookup option works too', () => {
    const w: Workspace = { ...emptyWorkspace(), compensations: [acq('acq1', A), acq('acq2', B)], samples: [sample('s1', 'acq2'), sample('s2', 'acq2')], populations: pops };
    const dss: Record<string, FcsDataset> = { s1: dsA, s2: dsB };
    const own = new Engine();
    for (const [id, ds] of Object.entries(dss)) own.addSample(id, ds);
    const r = roundTrip(w, dss, { fileCompOf: (sid) => (own.has(sid) ? own.fileCompOf(sid) : undefined) });
    expect(refs(r.xml)).toEqual(['acq2']);
    for (const [app, other] of r.counts) expect(other).toBe(app);
  });

  it('every sample on its own acquisition matrix: "FCS" (one document for different matrices)', () => {
    const w: Workspace = { ...emptyWorkspace(), compensations: [acq('acq1', A), acq('acq2', B)], samples: [sample('s1', 'acq1'), sample('s2', 'acq2')], populations: pops };
    const dss: Record<string, FcsDataset> = { s1: dsA, s2: dsB };
    const own = new Engine();
    for (const [id, ds] of Object.entries(dss)) own.addSample(id, ds);
    const r = roundTrip(w, dss, { fileCompOf: (sid) => own.fileCompOf(sid) });
    expect(refs(r.xml)).toEqual(['FCS']);
    expect(r.warnings.join(' ')).not.toMatch(/different compensation/);
    for (const [app, other] of r.counts) expect(other).toBe(app);
    // the files themselves cannot be checked (not loaded): "FCS" as before
    expect(refs(exportGatingMLDoc(w).xml)).toEqual(['FCS']);
  });

  it('the matrix written out compensates as the app does', () => {
    const w: Workspace = { ...emptyWorkspace(), compensations: [acq('acq1', A)], samples: [sample('s2', 'acq1')], populations: pops };
    const d = exportGatingMLDoc(w, { fileCompOf: () => null });
    const res = importGatingML(d.xml, { perGateComp: true });
    expect(res.compensations[0].matrix).toEqual(A);
    const c = compensate(dsNo.data, [0, 1], A);
    expect(c[1][0]).toBeCloseTo(compensate(dsNo.data, [0, 1], res.compensations[0].matrix)[1][0], 6);
  });
});
