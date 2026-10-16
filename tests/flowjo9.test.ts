// FlowJo 9 (Mac, <Workspace version="2.0">) workspaces on a synthetic workspace, FlowJo v11 ".flowjo" files, and the
// warning when nothing could be imported. The real FlowJo 9 workspaces (Bioconductor flowWorkspaceData) are checked in
// the opt-in online test (tests/fcs_online.test.ts, ONLINE_DATA=1).
import { strToU8, zipSync } from 'fflate';
import { Engine } from '../src/core/engine';
import type { FcsDataset } from '../src/core/fcs';
import { fitFlowJoTable, importFlowJo, isFlowJo9Mac } from '../src/core/flowjo';
import { popPath, type GateGeom } from '../src/core/model';
import { flowJoBiexTable, makeScale } from '../src/core/transforms';
import { parseXml } from '../src/core/xml';
import { flowJo11Workspace, openFiles } from '../src/io/files';
import { useStore } from '../src/state/store';

const table = (name: string, p: { width: number; pos: number; max: number }, stated = true) => {
  const xs = flowJoBiexTable({ neg: 0, ...p }, 4096);
  const attrs = stated ? `biexponentialDecades="${p.pos}" biexponentialNegDecades="0" biexponentialWidth="${p.width}"` : 'biexponentialDecades="0" biexponentialNegDecades="0" biexponentialWidth="0"';
  return `<Table name="${name}" ${attrs}>${Array.from(xs, (v, i) => `${i},${v.toPrecision(8)}`).join(',')}</Table>`;
};
const INPUT = { width: -10, pos: 4.5, max: 262144 };
const COMP1 = { width: -30, pos: 4.5, max: 262144 };

const strs = (a: string, b = '') => `<ParameterNames><StringArray><String>${a}</String>${b ? `<String>${b}</String>` : '<String />'}</StringArray></ParameterNames>`;
const verts = (pts: number[][]) => `<Polygon>${pts.map((p) => `<Vertex x="${p[0]}" y="${p[1]}" />`).join('')}</Polygon>`;
const gate = (shape: string, a: string, b: string, pts: number[][], negated = false) =>
  `<PolygonGate>${strs(a, b)}<Graph type="Pseudocolor"><Axis name="${a}" /></Graph><${shape} name="g"${negated ? ' negated="1"' : ''}>${verts(pts)}</${shape}></PolygonGate>`;
const pop = (name: string, g: string, sub = '', count = -1) => `<Population name="${name}" count="${count}">${g}${sub}</Population>`;

const CELLS = [
  [30000, 10000],
  [250000, 10000],
  [250000, 250000],
  [30000, 250000],
];
// ellipse in the display space of the compensated FL1 / FL2 axes: center (0.6, 0.5), semi-axes 0.15 (x) and 0.1 (y)
const fl1Scale = (() => {
  const xs = flowJoBiexTable({ neg: 0, ...COMP1 }, 4096);
  return (u: number) => {
    const c = u * 4096;
    const i = Math.min(4095, Math.floor(c));
    return xs[i] + (c - i) * (xs[i + 1] - xs[i]);
  };
})();
// FlowJo 9 writes the four ends of the axes as pairs: right, left, top, bottom
const ELLIPSE = [
  [fl1Scale(0.75), fl1Scale(0.5)],
  [fl1Scale(0.45), fl1Scale(0.5)],
  [fl1Scale(0.6), fl1Scale(0.6)],
  [fl1Scale(0.6), fl1Scale(0.4)],
];

function sample(id: number, compId: number, extraKw = '') {
  const kw = [
    ['$FIL', `tube${id}.fcs`],
    ['$PAR', '4'],
    ['$TOT', '4000'],
    ['$P1N', 'FSC-A'],
    ['$P1R', '262144'],
    ['$P2N', 'SSC-A'],
    ['$P2R', '262144'],
    ['$P3N', 'FL1-A'],
    ['$P3S', 'CD3'],
    ['$P3R', '262144'],
    ['$P4N', 'FL2-A'],
    ['$P4R', '262144'],
  ];
  const tree = pop(
    'not debris',
    gate('PolyRect', 'FSC-A', 'SSC-A', [
      [-1000, -1000],
      [20000, -1000],
      [20000, 3e5],
      [-1000, 3e5],
    ], true),
    pop(
      'cells',
      gate('Polygon', 'FSC-A', 'SSC-A', CELLS),
      [
        pop('FL1+', gate('Range', '&lt;FL1-A&gt;', '', [[1000, 0.02], [1e8, 0.02]])),
        pop('Q', gate('PolyRect', '&lt;FL1-A&gt;', '&lt;FL2-A&gt;', [[-1e6, 500], [1000, 500], [1000, 1e9], [-1e6, 1e9]])),
        pop('E', gate('Ellipse', '&lt;FL1-A&gt;', '&lt;FL2-A&gt;', ELLIPSE)),
        pop('FL2 raw', gate('Range', 'FL2-A', '', [[500, 0.02], [1e8, 0.02]])),
      ].join(''),
      1234,
    ),
    3000,
  );
  return `<Sample eventCount="4000" sampleNumber="" sampleID="${id}" compensationID="${compId}">
    <Keywords>${kw.map(([k, v]) => `<Keyword name="${k}" value="${v}" />`).join('')}${extraKw}</Keywords>
    <DataSet locationType="MacAlias" aliasSize="4">AAAA</DataSet>
    <Parameter name="FSC-A" label="" bits="32" range="4096" log="0" lowValue="0" highValue="4096" decades="0" gain="0.015625" />
    <Parameter name="SSC-A" label="" bits="32" range="4096" log="0" lowValue="0" highValue="2.621439933776855e5" decades="0" gain="0.015625" />
    <Parameter name="FL1-A" label="CD3" bits="32" range="4096" log="1" lowValue="-110.59" highValue="261589.9" decades="6.4" gain="1" calibrationIndex="1" />
    <Parameter name="FL2-A" label="" bits="32" range="4096" log="1" lowValue="-110.59" highValue="261589.9" decades="6.4" gain="1" calibrationIndex="1" />
    <SampleNode sampleID="${id}" name="tube${id}.fcs" count="4000"><Graph type="Pseudocolor" />${tree}</SampleNode>
  </Sample>`;
}

const MAC9 = `<?xml version="1.0" encoding="ISO-8859-1"?><!DOCTYPE Workspace><Workspace version="2.0" flowJoVersion="9.5.2">
  <Keywords><Keyword name="TUBE NAME" /></Keywords>
  <Groups nextGroupID="2">
    <GroupNode name="All Samples"><Group groupID="0"><SampleRefs><SampleRef sampleID="1" /><SampleRef sampleID="2" /></SampleRefs></Group></GroupNode>
    <GroupNode name="Panel A"><Group groupID="1"><SampleRefs><SampleRef sampleID="1" /></SampleRefs></Group></GroupNode>
  </Groups>
  <SampleList nextSampleID="3">
    ${sample(1, 1)}
    ${sample(2, -1, '<Keyword name="SPILL" value="2,FL1-A,FL2-A,1,0.2,0,1" />')}
  </SampleList>
  <CalibrationTables>
    ${table('InputParameterTransform_Gain1_Offset1262144', INPUT)}
    ${table('M1 &lt;FL1-A&gt;', COMP1, false)}
    ${table('M1 &lt;FL2-A&gt;', COMP1, false)}
  </CalibrationTables>
  <CompensationMatrices>
    <CompensationMatrix name="M1" prefix="&lt;" suffix="&gt;" usageFlag="1">
      <Channel name="FL1-A"><ChannelValue name="FL1-A" value="1" /><ChannelValue name="FL2-A" value="0.1" /></Channel>
      <Channel name="FL2-A"><ChannelValue name="FL1-A" value="0" /><ChannelValue name="FL2-A" value="1" /></Channel>
    </CompensationMatrix>
  </CompensationMatrices>
</Workspace>`;

/** FSC/SSC uniform 0..262144, FL1 / FL2 (observed = true + spill x FL1) from -300 to 100000 on a log-like spread. */
function synth(seed: number, spill: number): FcsDataset {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const n = 4000;
  const names = ['FSC-A', 'SSC-A', 'FL1-A', 'FL2-A'];
  const data = names.map(() => new Float32Array(n));
  const fl = () => (rnd() < 0.2 ? rnd() * 600 - 300 : Math.pow(10, 1 + rnd() * 4));
  for (let e = 0; e < n; e++) {
    data[0][e] = rnd() * 262144;
    data[1][e] = rnd() * 262144;
    data[2][e] = fl();
    data[3][e] = fl() + spill * data[2][e];
  }
  return {
    version: 'FCS3.0',
    keywords: {},
    channels: names.map((name, index) => ({ index, name, label: '', range: 262144, bits: 32, logDecades: 0, logOffset: 0, gain: 1, displayHint: '' })),
    eventCount: n,
    data,
    warnings: [],
  };
}

function inPoly(x: number, y: number, P: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i];
    const [xj, yj] = P[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe('FlowJo 9 (Mac) workspaces', () => {
  const res = importFlowJo(MAC9, { name: 'mac9' });
  const ws = res.workspace;

  it('recognizes the format and fits the calibration tables', () => {
    expect(isFlowJo9Mac(parseXml(MAC9).children.find((c) => c.name === 'Workspace')!)).toBe(true);
    const xs = Array.from(flowJoBiexTable({ neg: 0, ...COMP1 }, 4096));
    const fit = fitFlowJoTable(xs, { pos: 0, neg: 0, width: 0 })!;
    expect(fit.err).toBeLessThan(6); // channels of 4096
    expect(fit.p.width).toBeCloseTo(-30, 0);
    expect(fitFlowJoTable(Array.from(flowJoBiexTable({ neg: 0, ...INPUT }, 4096)), { pos: 4.5, neg: 0, width: -10 })!.err).toBeLessThan(0.5);
    expect(res.warnings[0]).toMatch(/^FlowJo 9.5.2 \(Mac\) workspace: gates, compensation and display transforms were converted/);
  });

  it('reads samples, groups, matrices and gates', () => {
    expect(ws.samples.map((s) => [s.name, s.fileName, s.eventCount])).toEqual([
      ['tube1', 'tube1.fcs', 4000],
      ['tube2', 'tube2.fcs', 4000],
    ]);
    expect(ws.groups.map((g) => g.name)).toEqual(['Panel A']);
    const m1 = ws.compensations.find((c) => c.name === 'M1')!;
    expect(m1).toMatchObject({ channels: ['FL1-A', 'FL2-A'], matrix: [[1, 0.1], [0, 1]], source: 'manual' });
    const acq = ws.compensations.find((c) => c.source === 'file')!;
    expect(acq.matrix).toEqual([[1, 0.2], [0, 1]]);
    expect(ws.samples.map((s) => s.compId)).toEqual([m1.id, acq.id]);
    const paths = ws.populations.map((p) => popPath(ws, p.id));
    expect(paths).toEqual([
      'not debris (FlowJo gate, inverted)',
      'not debris',
      'not debris / cells',
      'not debris / cells / FL1+',
      'not debris / cells / Q',
      'not debris / cells / E',
      'not debris / cells / FL2 raw',
    ]);
    const g = (path: string) => ws.populations.find((p) => popPath(ws, p.id) === path)!.gate as GateGeom;
    expect(g('not debris (FlowJo gate, inverted)')).toEqual({ type: 'rect', x: 'FSC-A', y: 'SSC-A', xmin: -Infinity, xmax: 20000, ymin: -Infinity, ymax: Infinity });
    expect(g('not debris / cells / FL1+')).toEqual({ type: 'range', x: 'FL1-A', min: 1000, max: Infinity });
    expect(g('not debris / cells / Q')).toMatchObject({ type: 'rect', xmin: -Infinity, xmax: 1000, ymin: 500, ymax: Infinity });
    expect(g('not debris / cells / E').type).toBe('ellipse');
    expect(g('not debris / cells / FL2 raw')).toEqual({ type: 'range', x: 'FL2-A', min: 500, max: Infinity, comp: 'none' });
    // FlowJo's counts are kept for the comparison table
    expect(res.counts[ws.samples[0].id][ws.populations[2].id]).toBe(1234);
  });

  it('counts events like FlowJo 9 (display transforms from the tables, compensation by compensationID)', () => {
    const eng = new Engine();
    ws.samples.forEach((s, si) => {
      const spill = si === 0 ? 0.1 : 0.2;
      const ds = synth(11 + si, spill);
      eng.addSample(s.id, ds);
      const E = ws.populations.find((p) => p.name === 'E')!;
      const eg = (E.overrides?.[s.id] ?? E.gate) as Extract<GateGeom, { type: 'ellipse' }>;
      const ex = makeScale(eg.scales!.x as never);
      const ey = makeScale(eg.scales!.y as never);
      // the ellipse from its four axis ends (pairs 0-1 and 2-3) in this sample's display space
      const P = ELLIPSE.map((q) => [ex.fwd(q[0]), ey.fwd(q[1])]);
      const c = [(P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4, (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4];
      const a = [(P[0][0] - P[1][0]) / 2, (P[0][1] - P[1][1]) / 2];
      const b = [(P[2][0] - P[3][0]) / 2, (P[2][1] - P[3][1]) / 2];
      const det = a[0] * b[1] - a[1] * b[0];
      if (si === 0) {
        // the tables of matrix M1 are the ones the ellipse was drawn on
        expect(c[0]).toBeCloseTo(0.6, 3);
        expect(c[1]).toBeCloseTo(0.5, 3);
      }
      const d = ds.data;
      const exp: Record<string, number> = {};
      const inc = (k: string) => (exp[k] = (exp[k] ?? 0) + 1);
      for (let e = 0; e < ds.eventCount; e++) {
        if (!(d[0][e] >= 20000)) continue;
        inc('not debris');
        if (!inPoly(d[0][e], d[1][e], CELLS)) continue;
        inc('not debris / cells');
        const f1 = d[2][e];
        const f2 = Math.fround(d[3][e] - spill * d[2][e]);
        if (f1 >= 1000) inc('not debris / cells / FL1+');
        if (f1 < 1000 && f2 >= 500) inc('not debris / cells / Q');
        const px = ex.fwd(f1) - c[0];
        const py = ey.fwd(f2) - c[1];
        const u = (px * b[1] - py * b[0]) / det;
        const v = (a[0] * py - a[1] * px) / det;
        if (u * u + v * v <= 1 + 1e-9) inc('not debris / cells / E');
        if (d[3][e] >= 500) inc('not debris / cells / FL2 raw');
      }
      for (const p of ws.populations) {
        const path = popPath(ws, p.id);
        if (path.includes('(FlowJo gate')) continue;
        const c = eng.count(ws, s.id, p.id);
        const tol = p.name === 'E' ? 2 : 0; // the ellipse's display-space ends are rounded through raw values
        expect(Math.abs(c - (exp[path] ?? 0)), `${s.name} ${path}: ${c} vs ${exp[path] ?? 0}`).toBeLessThanOrEqual(tol);
      }
      expect(exp['not debris / cells / E']).toBeGreaterThan(50);
    });
  });
});

describe('FlowJo workspaces that cannot be imported', () => {
  it('says so when none of the populations could be read', () => {
    const xml = `<Workspace version="20.0" flowJoVersion="10.9"><SampleList><Sample><DataSet uri="file:a.fcs" sampleID="1"/><Keywords><Keyword name="$PAR" value="1"/><Keyword name="$P1N" value="FSC-A"/></Keywords>
      <SampleNode name="a.fcs" sampleID="1" count="10"><Subpopulations><Population name="P" count="5"><Gate><gating:FancyGate xmlns:gating="x"/></Gate></Population></Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
    const r = importFlowJo(xml);
    expect(r.workspace.populations).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/None of the 1 gated populations of this workspace \(FlowJo 10.9, workspace format 20.0\) could be imported/);
  });

  it('reads the XML workspace of a .flowjo zip, and explains FlowJo 11 JSON analyses', async () => {
    const wsp = `<?xml version="1.0"?><Workspace version="20.0"><SampleList/></Workspace>`;
    expect(flowJo11Workspace(zipSync({ 'study/workspace.wsp': strToU8(wsp) }))).toBe(wsp);
    const fj11 = zipSync({ 'workbench.json': strToU8('{"id":"x","analyses":["a"]}'), 'analyses/analysis-a/analysis-a.json': strToU8('{"schemaVersion":1}') });
    expect(() => flowJo11Workspace(fj11)).toThrow(/FlowJo v11 \.flowjo workspaces store their analysis in a format \(JSON\) that cannot be imported yet.*\.wsp/);
    expect(() => flowJo11Workspace(strToU8('not a zip'), 'x.flowjo')).toThrow(/not a FlowJo v11 workspace/);
    // opening one shows the message and keeps the workspace
    const before = useStore.getState().ws;
    await openFiles([new File([fj11 as BlobPart], 'test05.flowjo')]);
    expect(useStore.getState().ws).toBe(before);
    expect(useStore.getState().ui.toasts.some((t) => /test05\.flowjo: FlowJo v11 \.flowjo workspaces/.test(t.text))).toBe(true);
  });
});
