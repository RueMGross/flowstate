// FlowJo workspace (.wsp) import: synthetic workspace (always runs) and FlowKit's test workspaces (skipped when the
// FlowKit data folder is missing). Expected counts: FlowJo's own counts stored in the .wsp, and a FlowKit 1.3.2
// reference in which the Time channel is scaled the way FlowJo does (FlowKit itself ignores FlowJo's time gain).
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseFcs, type FcsDataset } from '../src/core/fcs';
import { importFlowJo, isFlowJoWorkspaceXml } from '../src/core/flowjo';
import { Engine, engine } from '../src/core/engine';
import { openFiles } from '../src/io/files';
import { loadFcsFiles, useStore } from '../src/state/store';
import { zipSync } from 'fflate';
import { popPath, type GateGeom, type Workspace } from '../src/core/model';
import { applies } from '../src/core/scope';
import { polygonGateGrids } from '../src/core/gating';
import { flowJoBiexScale, flowJoBiexTable, makeScale, describeScale, type ScaleDef } from '../src/core/transforms';

const DATA = '/tmp/claude-0/dl/FlowKit/data';
const HAVE_DATA = ['8_color_data_set/fcs_files', 'simple_line_example', 'simple_diamond_example'].every((d) => existsSync(join(DATA, d)));

// ------------------------------------------------------------------ synthetic workspace

const NS =
  'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';
const dim = (n: string, min?: number, max?: number) =>
  `<gating:dimension${min !== undefined ? ` gating:min="${min}"` : ''}${max !== undefined ? ` gating:max="${max}"` : ''}><data-type:fcs-dimension data-type:name="${n}"/></gating:dimension>`;
const poly = (x: string, y: string, pts: number[][], inside = 1) =>
  `<gating:PolygonGate eventsInside="${inside}" gateResolution="256">${dim(x)}${dim(y)}${pts
    .map((p) => `<gating:vertex><gating:coordinate data-type:value="${p[0]}"/><gating:coordinate data-type:value="${p[1]}"/></gating:vertex>`)
    .join('')}</gating:PolygonGate>`;
const rect = (dims: string) => `<gating:RectangleGate eventsInside="1">${dims}</gating:RectangleGate>`;
const pop = (name: string, gate: string, sub = '', count = -1) =>
  `<Population name="${name}" owningGroup="" count="${count}"><Gate>${gate}</Gate>${sub ? `<Subpopulations>${sub}</Subpopulations>` : ''}</Population>`;
const bool = (kind: string, name: string, deps: string[]) =>
  `<${kind} name="${name}" owningGroup="" count="-1"><Dependents>${deps.map((d) => `<Dependent name="${d}"/>`).join('')}</Dependents></${kind}>`;

const CX = 300; // quadrant cut on Comp-FL1-A (raw)
const CY = 200; // quadrant cut on Comp-FL2_PE-A (raw)
const quads = (x: string, y: string) =>
  [
    pop('Q1: FL1-, PE+', rect(dim(x, undefined, CX) + dim(y, CY))),
    pop('Q2: FL1+, PE+', rect(dim(x, CX) + dim(y, CY))),
    pop('Q3: FL1+, PE-', rect(dim(x, CX) + dim(y, undefined, CY))),
    pop('Q4: FL1-, PE-', rect(dim(x, undefined, CX) + dim(y, undefined, CY))),
  ].join('');
const CELLS1 = [
  [100, 100],
  [900, 100],
  [900, 900],
  [100, 900],
];
const CELLS2 = [
  [150, 100],
  [900, 100],
  [900, 850],
  [150, 850],
];
const BIG = [
  [500, 500],
  [900, 500],
  [900, 900],
];

function sampleXml(id: number, file: string, cells: number[][], withEarly: boolean) {
  const kw: [string, string][] = [
    ['$PAR', '6'],
    ['$TOT', '4000'],
    ['$TIMESTEP', '0.01'],
    ['$P1N', 'FSC-A'],
    ['$P1R', '1024'],
    ['$P2N', 'SSC-A'],
    ['$P2R', '1024'],
    ['$P3N', 'FL1-A'],
    ['$P3S', 'CD3'],
    ['$P3R', '1024'],
    ['$P4N', 'FL2/PE-A'],
    ['$P4S', 'CD4'],
    ['$P4R', '1024'],
    ['$P5N', 'Time'],
    ['$P5R', '1024'],
    ['$P6N', 'FL3-A'],
    ['$P6R', '1024'],
    ['$DATE', '11-OCT-2026'],
  ];
  const sub = [
    quads('Comp-FL1-A', 'Comp-FL2_PE-A'),
    withEarly ? pop('Early', rect(dim('Time', 0, 10))) : '',
    pop('.', rect(dim('FL1-A', 100))),
    pop('Small', poly('FSC-A', 'SSC-A', BIG, 0)),
    pop('Bisect L', rect(dim('FL3-A', undefined, 400))),
    pop('Bisect R', rect(dim('FL3-A', 400))),
    bool('AndNode', 'Q2 & Early', ['Cells/Q2: FL1+, PE+', 'Cells/Early']),
    bool('OrNode', 'Q1 or Q3', ['Cells/Q1: FL1-, PE+', 'Cells/Q3: FL1+, PE-']),
    bool('NotNode', 'not Q2', ['Cells/Q2: FL1+, PE+']),
  ].join('');
  return `<Sample>
  <DataSet uri="file:/C:/data/${encodeURIComponent(file)}" sampleID="${id}"/>
  <transforms:spilloverMatrix spectral="0" prefix="Comp-" name="Acquisition-defined" suffix="">
    <data-type:parameters><data-type:parameter data-type:name="FL1-A"/><data-type:parameter data-type:name="FL2_PE-A"/></data-type:parameters>
    <transforms:spillover data-type:parameter="FL1-A"><transforms:coefficient data-type:parameter="FL1-A" transforms:value="1"/><transforms:coefficient data-type:parameter="FL2_PE-A" transforms:value="0.1"/></transforms:spillover>
    <transforms:spillover data-type:parameter="FL2_PE-A"><transforms:coefficient data-type:parameter="FL1-A" transforms:value="0"/><transforms:coefficient data-type:parameter="FL2_PE-A" transforms:value="1"/></transforms:spillover>
  </transforms:spilloverMatrix>
  <Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="1024" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:linear transforms:minRange="0" transforms:maxRange="1024" gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
    <transforms:linear transforms:minRange="0" transforms:maxRange="100" gain="0.5"><data-type:parameter data-type:name="Time"/></transforms:linear>
    <transforms:biex transforms:length="256" transforms:maxRange="1024" transforms:neg="0" transforms:width="-10" transforms:pos="3"><data-type:parameter data-type:name="Comp-FL1-A"/></transforms:biex>
    <transforms:logicle transforms:length="256" transforms:T="1024" transforms:W="0.5" transforms:M="3" transforms:A="0"><data-type:parameter data-type:name="Comp-FL2_PE-A"/></transforms:logicle>
    <transforms:log transforms:offset="1" transforms:decades="3"><data-type:parameter data-type:name="FL3-A"/></transforms:log>
  </Transformations>
  <Keywords>${kw.map(([k, v]) => `<Keyword name="${k}" value="${v}"/>`).join('')}</Keywords>
  <SampleNode name="${file}" count="4000" sampleID="${id}">
    <Subpopulations>
      <Statistic name="Count" value="4000"/>
      ${pop('Cells', poly('FSC-A', 'SSC-A', cells), sub, 1234)}
    </Subpopulations>
  </SampleNode>
</Sample>`;
}

const SYN = `<?xml version="1.0" encoding="UTF-8"?>
<!-- synthetic FlowJo 10 workspace -->
<Workspace version="20.0" flowJoVersion="10.8.1" ${NS}>
  <Groups>
    <GroupNode name="All Samples"><Group name="All Samples"><SampleRefs><SampleRef sampleID="1"/><SampleRef sampleID="2"/><SampleRef sampleID="3"/></SampleRefs></Group></GroupNode>
    <GroupNode name="Stim"><Group name="Stim"><SampleRefs><SampleRef sampleID="2"/><SampleRef sampleID="3"/><SampleRef sampleID="3"/></SampleRefs></Group></GroupNode>
    <GroupNode name="Beads"><Group name="Beads"/></GroupNode>
  </Groups>
  <SampleList>
    ${sampleXml(1, 'tube 1.fcs', CELLS1, true)}
    ${sampleXml(2, 'tube 2.fcs', CELLS1, true)}
    ${sampleXml(3, 'tube 3.fcs', CELLS2, false)}
  </SampleList>
</Workspace>`;

/** Deterministic synthetic events (FL2/PE-A observed = true + 0.1 * FL1-A). */
function synthData(seed: number): FcsDataset {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const n = 4000;
  const names = ['FSC-A', 'SSC-A', 'FL1-A', 'FL2/PE-A', 'Time', 'FL3-A'];
  const data = names.map(() => new Float32Array(n));
  for (let e = 0; e < n; e++) {
    data[0][e] = rnd() * 1000;
    data[1][e] = rnd() * 1000;
    data[2][e] = rnd() * 1200 - 200;
    const fl2 = rnd() * 1200 - 200;
    data[3][e] = fl2 + 0.1 * data[2][e];
    data[4][e] = rnd(); // seconds (0..100 ticks of $TIMESTEP 0.01, as the FCS reader returns them)
    data[5][e] = rnd() < 0.1 ? -rnd() * 50 : rnd() * 1000;
  }
  return {
    version: 'FCS3.1',
    keywords: {},
    channels: names.map((name, index) => ({ index, name, label: '', range: 1024, bits: 32, logDecades: 0, logOffset: 0, gain: 1, displayHint: '' })),
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

/**
 * FlowJo's polygon test on its gate grid, for the synthetic workspace's linear 0..1024 axes at gateResolution 256:
 * events and vertices rounded to channels (halves up), clamped events, outline included.
 */
function inGridPoly(x: number, y: number, P: number[][]): boolean {
  const ch = (v: number) => Math.floor((v / 1024) * 256 + 0.5);
  const cx = Math.min(255, Math.max(0, ch(x)));
  const cy = Math.min(255, Math.max(0, ch(y)));
  const V = P.map(([a, b]) => [ch(a), ch(b)]);
  for (let i = 0, j = V.length - 1; i < V.length; j = i++) {
    const [x1, y1] = V[j];
    const [x2, y2] = V[i];
    const onLine = (x2 - x1) * (cy - y1) === (y2 - y1) * (cx - x1);
    if (onLine && cx >= Math.min(x1, x2) && cx <= Math.max(x1, x2) && cy >= Math.min(y1, y2) && cy <= Math.max(y1, y2)) return true;
  }
  return inPoly(cx, cy, V);
}

describe('FlowJo import: synthetic workspace', () => {
  const res = importFlowJo(SYN, { name: 'synthetic' });
  const ws = res.workspace;
  const byPath = (p: string) => ws.populations.find((q) => popPath(ws, q.id) === p)!;

  it('recognizes FlowJo XML', () => {
    expect(isFlowJoWorkspaceXml(SYN)).toBe(true);
    expect(isFlowJoWorkspaceXml('<?xml version="1.0"?><gating:Gating-ML/>')).toBe(false);
  });

  it('reads samples, groups, compensation and scales', () => {
    expect(ws.name).toBe('synthetic');
    expect(ws.samples.map((s) => s.fileName)).toEqual(['tube 1.fcs', 'tube 2.fcs', 'tube 3.fcs']);
    expect(ws.samples[0].name).toBe('tube 1');
    expect(ws.samples[0].eventCount).toBe(4000);
    expect(ws.samples[0].channels.map((c) => c.name)).toContain('FL2/PE-A');
    expect(ws.samples[0].channels.find((c) => c.name === 'FL2/PE-A')!.label).toBe('CD4');
    expect(ws.samples[0].info?.Date).toBe('11-OCT-2026');
    // "All Samples" and empty groups are skipped; repeated references collapse
    expect(ws.groups.map((g) => g.name)).toEqual(['Stim']);
    expect(ws.groups[0].sampleIds).toEqual([ws.samples[1].id, ws.samples[2].id]);
    // one shared matrix; FlowJo's "FL2_PE-A" is the FCS channel "FL2/PE-A"
    expect(ws.compensations.length).toBe(1);
    expect(ws.compensations[0].channels).toEqual(['FL1-A', 'FL2/PE-A']);
    expect(ws.compensations[0].matrix).toEqual([
      [1, 0.1],
      [0, 1],
    ]);
    expect(ws.samples.every((s) => s.compId === ws.compensations[0].id)).toBe(true);
    // display scales: Comp- transforms belong to the compensated channel; time in seconds (FlowJo 0..100 at gain 0.5 =
    // 0..200 ticks of $TIMESTEP 0.01 s)
    expect(ws.scales['Time']).toEqual({ type: 'linear', min: 0, max: 2 });
    expect(ws.scales['FL3-A']).toEqual({ type: 'log', min: 1, max: 1000, clampLow: true });
    expect(ws.scales['FL2/PE-A']).toEqual({ type: 'logicle', T: 1024, W: 0.5, M: 3, A: 0 });
    const b = ws.scales['FL1-A'] as Extract<ScaleDef, { type: 'logicle' }>;
    expect(b.flowjo).toEqual({ neg: 0, width: -10, pos: 3, max: 1024 });
    expect(describeScale(b)).toMatch(/FlowJo biex/);
    expect(res.counts[ws.samples[0].id][byPath('Cells').id]).toBe(1234);
  });

  it('maps gates: quadrants, bisectors, time gain, uncompensated dimensions, complements, booleans', () => {
    const q2 = byPath('Cells / Q2: FL1+, PE+').gate;
    expect(q2).toMatchObject({ type: 'quadrant', x: 'FL1-A', y: 'FL2/PE-A', cx: CX, cy: CY, quadrant: 'UR' });
    const groups = new Set(['Q1: FL1-, PE+', 'Q2: FL1+, PE+', 'Q3: FL1+, PE-', 'Q4: FL1-, PE-'].map((n) => (byPath('Cells / ' + n).gate as { groupId: string }).groupId));
    expect(groups.size).toBe(1);
    expect(byPath('Cells / Bisect L').gate).toMatchObject({ type: 'split', x: 'FL3-A', cut: 400, side: 'lo' });
    // FlowJo time 0..10 at gain 0.5 = 0..20 ticks = 0..0.2 s; 0 is the axis minimum, so the gate is open below
    expect(byPath('Cells / Early').gate).toEqual({ type: 'range', x: 'Time', min: -Infinity, max: 0.2 });
    expect(byPath('Cells / .').gate).toEqual({ type: 'range', x: 'FL1-A', min: 100, max: Infinity, comp: 'none' });
    const small = byPath('Cells / Small').gate as Extract<GateGeom, { type: 'bool' }>;
    expect(small.op).toBe('not');
    expect(ws.populations.find((p) => p.id === small.operands[0])!.name).toBe('Small (FlowJo gate, inverted)');
    expect(res.warnings.some((w) => /excludes the events inside/.test(w))).toBe(true);
    const cells = byPath('Cells');
    expect(cells.gate).toMatchObject({ type: 'polygon', points: CELLS1 });
    // FlowJo's gate grid (gateResolution 256; linear axes round to the nearest channel); the display scales have none
    const cs = (cells.gate as Extract<GateGeom, { type: 'polygon' }>).scales!;
    expect(cs.x).toEqual({ type: 'linear', min: 0, max: 1024, grid: { n: 256, nearest: true } });
    expect(cs.y).toEqual({ type: 'linear', min: 0, max: 1024, grid: { n: 256, nearest: true } });
    expect(ws.scales['FSC-A']).toEqual({ type: 'linear', min: 0, max: 1024 });
    expect(Object.keys(cells.overrides ?? {})).toEqual([ws.samples[2].id]);
    // sample 3 has no "Early": the population is scoped to the samples that have it (n/a in sample 3, not 0)
    expect(byPath('Cells / Early').overrides).toBeUndefined();
    expect(byPath('Cells / Early').scope).toEqual({ samples: [ws.samples[0].id, ws.samples[1].id] });
    expect(byPath('Cells').scope).toBeUndefined();
    expect(applies(ws, ws.samples[2].id, byPath('Cells / Early').id)).toBe(false);
    expect(applies(ws, ws.samples[0].id, byPath('Cells / Early').id)).toBe(true);
    // the AND gate with "Early" does not apply either; the OR gate of two present quadrants does
    expect(applies(ws, ws.samples[2].id, byPath('Cells / Q2 & Early').id)).toBe(false);
    expect(applies(ws, ws.samples[2].id, byPath('Cells / Q1 or Q3').id)).toBe(true);
    expect(res.warnings.some((w) => /tube 3.*Cells \/ Early/.test(w))).toBe(true);
    // a gating worksheet: one plot per parent and axis pair
    expect(ws.worksheets[0].name).toBe('Gating');
    expect(ws.worksheets[0].items.length).toBe(6);
  });

  it('counts events like FlowJo', () => {
    const eng = new Engine();
    const dss = ws.samples.map((s, i) => {
      const ds = synthData(17 + i);
      eng.addSample(s.id, ds);
      return ds;
    });
    ws.samples.forEach((s, si) => {
      const d = dss[si].data;
      const n = d[0].length;
      const cellsPoly = si === 2 ? CELLS2 : CELLS1;
      const exp: Record<string, number> = {};
      const inc = (k: string) => (exp[k] = (exp[k] ?? 0) + 1);
      for (let e = 0; e < n; e++) {
        // polygons on FlowJo's gate grid (see GateGrid); the exact polygon differs at the outline
        if (!inGridPoly(d[0][e], d[1][e], cellsPoly)) continue;
        inc('Cells');
        const f1 = d[2][e];
        const f2 = Math.fround(d[3][e] - 0.1 * d[2][e]); // compensated (stored as float32, like the app)
        const up = f2 >= CY;
        const right = f1 >= CX;
        const q = right ? (up ? 'Q2: FL1+, PE+' : 'Q3: FL1+, PE-') : up ? 'Q1: FL1-, PE+' : 'Q4: FL1-, PE-';
        inc('Cells / ' + q);
        const early = si !== 2 && d[4][e] >= 0 && d[4][e] < 0.2; // FlowJo time 0..10 at gain 0.5 (0..0.2 s)
        if (early) inc('Cells / Early');
        if (d[2][e] >= 100) inc('Cells / .'); // uncompensated FL1-A
        if (!inGridPoly(d[0][e], d[1][e], BIG)) inc('Cells / Small');
        inc(d[5][e] < 400 ? 'Cells / Bisect L' : 'Cells / Bisect R');
        if (q === 'Q2: FL1+, PE+' && early) inc('Cells / Q2 & Early');
        if (q === 'Q1: FL1-, PE+' || q === 'Q3: FL1+, PE-') inc('Cells / Q1 or Q3');
        if (q !== 'Q2: FL1+, PE+') inc('Cells / not Q2');
      }
      for (const p of ws.populations) {
        const path = popPath(ws, p.id);
        if (path.includes('(FlowJo gate')) continue;
        expect([s.name, path, eng.count(ws, s.id, p.id)]).toEqual([s.name, path, exp[path] ?? 0]);
      }
    });
  });

  it('rejects documents that are not FlowJo workspaces', () => {
    expect(() => importFlowJo('<Gating-ML/>')).toThrow(/FlowJo/);
  });
});

// ------------------------------------------------------------------ FlowJo biex

describe('FlowJo biex transform', () => {
  it('display and inverse are consistent and clamp at the table ends', () => {
    const p = { neg: 0, width: -10, pos: 4.418539922, max: 262144 };
    const sc = flowJoBiexScale(p);
    for (const v of [-50, 0, 10, 1000, 50000, 250000]) expect(sc.inv(sc.fwd(v))).toBeCloseTo(v, 6);
    const t = flowJoBiexTable(p);
    expect(sc.fwd(t[0] - 1000)).toBe(0);
    expect(sc.fwd(1e9)).toBe(1);
    expect(sc.fwd(0)).toBeCloseTo(t.indexOf(0) / 4096, 12);
    // editing the logicle parameters of the scale turns it into a plain logicle
    const def = { type: 'logicle' as const, T: 262144, W: 0.5, M: 4.418539922, A: 0, flowjo: p };
    expect(makeScale(def).fwd(1000)).toBeCloseTo(sc.fwd(1000), 12);
    expect(makeScale({ ...def, W: 0.6 }).fwd(1000)).not.toBeCloseTo(sc.fwd(1000), 4);
  });

  const csv = join(DATA, 'flowjo_xforms', 'tr_biex_l256_w-7.943282_n1.000000_m4.418540_r262144.000029.csv');
  it.skipIf(!existsSync(csv))('matches a lookup table exported by FlowJo', () => {
    const rows = readFileSync(csv, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => Number(l.split(',')[1]));
    const t = flowJoBiexTable({ neg: 1, width: -7.943282, pos: 4.41854, max: 262144.000029 });
    let worst = 0;
    rows.forEach((v, i) => (worst = Math.max(worst, Math.abs(t[i] - v) / Math.max(1, Math.abs(v)))));
    expect(rows.length).toBe(4096);
    expect(worst).toBeLessThan(1e-5);
  });
});

// ------------------------------------------------------------------ FlowKit test workspaces

/**
 * Reference counts per workspace: FlowKit 1.3.2 (Workspace.analyze_samples) with the Time channel as FlowJo has it:
 * scaled by the gain of the sample's Time transform (FlowKit applies $TIMESTEP instead), and for sample E01 the time gate
 * starting at the axis minimum (FlowJo's edge rule, see flowjo.ts). Sample order as listed.
 */
const REF: Record<string, { samples: string[]; counts: Record<string, (number | null)[]> }> = {
  '8_color_data_set/8_color_ICS_simple.wsp': {
    samples: ["101_DEN084Y5_15_E01_008_clean.fcs", "101_DEN084Y5_15_E03_009_clean.fcs", "101_DEN084Y5_15_E05_010_clean.fcs"],
    counts: {
      "Time": [290172, 283968, 284933],
      "Time/Singlets": [239007, 236780, 235405],
      "Time/Singlets/aAmine-": [164661, 161823, 161005],
      "Time/Singlets/aAmine-/CD3+": [133675, 132200, 131348],
    },
  },
  '8_color_data_set/8_color_ICS.wsp': {
    samples: ["101_DEN084Y5_15_E01_008_clean.fcs", "101_DEN084Y5_15_E03_009_clean.fcs", "101_DEN084Y5_15_E05_010_clean.fcs"],
    counts: {
      "Time": [290172, 283968, 284933],
      "Time/Singlets": [239007, 236780, 235405],
      "Time/Singlets/aAmine-": [164661, 161823, 161005],
      "Time/Singlets/aAmine-/CD3+": [133675, 132200, 131348],
      "Time/Singlets/aAmine-/CD3+/CD4+": [82485, 81855, 81158],
      "Time/Singlets/aAmine-/CD3+/CD8+": [47169, 46965, 46562],
      "Time/Singlets/aAmine-/CD3+/CD4+/CD107a+": [68, 59, 70],
      "Time/Singlets/aAmine-/CD3+/CD8+/CD107a+": [73, 814, 306],
      "Time/Singlets/aAmine-/CD3+/CD4+/IFNg+": [4, 598, 9],
      "Time/Singlets/aAmine-/CD3+/CD8+/IFNg+": [2, 1224, 348],
      "Time/Singlets/aAmine-/CD3+/CD4+/IL2+": [6, 64, 8],
      "Time/Singlets/aAmine-/CD3+/CD8+/IL2+": [10, 127, 65],
      "Time/Singlets/aAmine-/CD3+/CD4+/TNFa+": [21, 288, 28],
      "Time/Singlets/aAmine-/CD3+/CD8+/TNFa+": [8, 821, 336],
    },
  },
  '8_color_data_set/8_color_ICS_boolean_gate_testing.wsp': {
    samples: ["101_DEN084Y5_15_E01_008_clean.fcs", "101_DEN084Y5_15_E03_009_clean.fcs", "101_DEN084Y5_15_E05_010_clean.fcs"],
    counts: {
      "Time": [290172, 283968, 284933],
      "Time/Singlets": [239007, 236780, 235405],
      "Time/Singlets/aAmine-": [164661, 161823, 161005],
      "Time/Singlets/aAmine-/CD3+": [133675, 132200, 131348],
      "Time/Singlets/aAmine-/CD3+/CD4+": [82485, 81855, 81158],
      "Time/Singlets/aAmine-/CD3+/CD8+": [47169, 46965, 46562],
      "Time/Singlets/aAmine-/CD3+/CD4+/CD107a+": [68, 59, 70],
      "Time/Singlets/aAmine-/CD3+/CD8+/CD107a+": [73, 814, 306],
      "Time/Singlets/aAmine-/CD3+/CD4+/CD107a+ & IFNg+": [0, 6, 0],
      "Time/Singlets/aAmine-/CD3+/CD4+/CD107a+ or IFNg+": [72, 651, 79],
      "Time/Singlets/aAmine-/CD3+/CD4+/IFNg+": [4, 598, 9],
      "Time/Singlets/aAmine-/CD3+/CD8+/IFNg+": [2, 1224, 348],
      "Time/Singlets/aAmine-/CD3+/CD4+/IL2+": [6, 64, 8],
      "Time/Singlets/aAmine-/CD3+/CD8+/IL2+": [10, 127, 65],
      "Time/Singlets/aAmine-/CD3+/CD4+/IL2+-": [82479, 81791, 81150],
      "Time/Singlets/aAmine-/CD3+/CD4+/TNFa+": [21, 288, 28],
      "Time/Singlets/aAmine-/CD3+/CD8+/TNFa+": [8, 821, 336],
      "Time/Singlets/aAmine-/CD3+/CD4+/TNFa+-": [82464, 81567, 81130],
      "Time/Singlets/aAmine-/CD3+/CD8+/TNFa+-": [47161, 46144, 46226],
      "Time/Singlets/aAmine-/CD3+/CD8+/TNFa+-/CD107a+": [70, 198, 69],
    },
  },
  '8_color_data_set/8_color_ICS_with_ellipse.wsp': {
    samples: ["101_DEN084Y5_15_E01_008_clean.fcs", "101_DEN084Y5_15_E03_009_clean.fcs", "101_DEN084Y5_15_E05_010_clean.fcs"],
    counts: {
      "Time": [290172, 283968, 284933],
      "Time/Singlets": [239007, 236780, 235405],
      "Time/Singlets/aAmine-": [164661, 161823, 161005],
      "Time/Singlets/aAmine-/CD3+": [133675, 132200, 131348],
      "Time/Singlets/aAmine-/CD3+/CD4+": [82485, 81855, 81158],
      "Time/Singlets/aAmine-/CD3+/CD8+": [47169, 46965, 46562],
      "Time/Singlets/aAmine-/CD3+/ellipse1": [7023, 5871, 6009],
      "Time/Singlets/aAmine-/CD3+/CD4+/CD107a+": [68, 59, 70],
      "Time/Singlets/aAmine-/CD3+/CD8+/CD107a+": [73, 814, 306],
      "Time/Singlets/aAmine-/CD3+/CD4+/IFNg+": [4, 598, 9],
      "Time/Singlets/aAmine-/CD3+/CD8+/IFNg+": [2, 1224, 348],
      "Time/Singlets/aAmine-/CD3+/CD4+/IL2+": [6, 64, 8],
      "Time/Singlets/aAmine-/CD3+/CD8+/IL2+": [10, 127, 65],
      "Time/Singlets/aAmine-/CD3+/CD4+/TNFa+": [21, 288, 28],
      "Time/Singlets/aAmine-/CD3+/CD8+/TNFa+": [8, 821, 336],
    },
  },
  '8_color_data_set/8_color_ICS_sample_without_gates.wsp': {
    samples: ["101_DEN084Y5_15_E01_008_clean.fcs", "101_DEN084Y5_15_E03_009_clean.fcs"],
    counts: {
      "Time": [290172, 256251],
      "Time/Singlets": [239007, 216780],
      "Time/Singlets/aAmine-": [164661, 148257],
      "Time/Singlets/aAmine-/CD3+": [133675, 121174],
    },
  },
  '8_color_data_set/reused_quad_gate_with_child.wsp': {
    samples: ["101_DEN084Y5_15_E01_008_clean.fcs"],
    counts: {
      "good cells": [180693],
      "good cells/cd4+": [116865],
      "good cells/cd8+": [48231],
      "good cells/cd4+/Q1: CD107a-, IL2+": [3317],
      "good cells/cd8+/Q1: CD107a-, IL2+": [440],
      "good cells/cd4+/Q2: CD107a+, IL2+": [3704],
      "good cells/cd8+/Q2: CD107a+, IL2+": [1385],
      "good cells/cd4+/Q3: CD107a+, IL2-": [2605],
      "good cells/cd8+/Q3: CD107a+, IL2-": [883],
      "good cells/cd4+/Q4: CD107a-, IL2-": [107239],
      "good cells/cd8+/Q4: CD107a-, IL2-": [45523],
      "good cells/cd4+/Q2: CD107a+, IL2+/some_child_gate": [558],
      "good cells/cd8+/Q2: CD107a+, IL2+/some_child_gate": [299],
    },
  },
  'simple_line_example/simple_poly_and_rect.wsp': {
    samples: ["data_set_simple_line_100.fcs"],
    counts: {
      "poly1": [0],
      "rect1": [0],
    },
  },
  'simple_line_example/simple_poly_and_rect_v2_poly50.wsp': {
    samples: ["data_set_simple_line_100.fcs"],
    counts: {
      "poly1": [50],
      "rect1": [0],
    },
  },
  'simple_line_example/single_ellipse_51_events.wsp': {
    samples: ["data_set_simple_line_100.fcs"],
    counts: {
      "ellipse1": [51],
    },
  },
  'simple_diamond_example/simple_diamond_example_quad_gate.wsp': {
    samples: ["test_data_diamond_01.fcs"],
    counts: {
      "Q1: channel_A- , channel_B+": [49671],
      "Q2: channel_A+ , channel_B+": [50596],
      "Q3: channel_A+ , channel_B-": [50330],
      "Q4: channel_A- , channel_B-": [49403],
    },
  },
  'simple_diamond_example/test_data_diamond_asinh_rect.wsp': {
    samples: ["test_data_diamond_01.fcs"],
    counts: {
      "upper_right": [50559],
    },
  },
  'simple_diamond_example/test_data_diamond_asinh_rect2.wsp': {
    samples: ["test_data_diamond_01.fcs"],
    counts: {
      "upper_right": [50699],
    },
  },
  'simple_diamond_example/test_data_diamond_biex_rect.wsp': {
    samples: ["test_data_diamond_01.fcs"],
    counts: {
      "upper_right": [50605],
    },
  },
};
// FlowKit cannot load the workspace with a gate named "."; its gates are those of 8_color_ICS.wsp
REF['8_color_data_set/8_color_ICS_dot_gate_name.wsp'] = {
  samples: REF['8_color_data_set/8_color_ICS.wsp'].samples,
  counts: Object.fromEntries(Object.entries(REF['8_color_data_set/8_color_ICS.wsp'].counts).map(([k, v]) => [k.replace('CD4+/TNFa+', 'CD4+/.'), v])),
};

/**
 * FlowJo's own counts stored in the workspaces: every population matches exactly (polygons on FlowJo's gate grid, see
 * GateGrid in transforms.ts; FlowKit evaluates them exactly and differs from FlowJo by 0.2-0.3 % in the scatter polygon
 * "Singlets", and by all 50 events of poly1 in simple_poly_and_rect_v2_poly50.wsp, where FlowJo's 0 is right), except:
 *   - the ellipse: up to 3.5 % (FlowJo's ellipse geometry is not documented; the app follows FlowKit's reading);
 *   - FlowJo 10.10 (dot_gate_name.wsp) counted 88 fewer events in the time gate of one sample than FlowJo 10.6 / 10.8
 *     with the same gate and time gain (carried into the populations below it);
 *   - FlowJo 10.6.2 (8_color_ICS.wsp) counted 2 fewer events in CD4+ of one sample than FlowJo 10.8.1 with the same
 *     gate, transforms and data (8_color_ICS_with_ellipse.wsp, boolean_gate_testing.wsp): FlowJo-internal.
 */
function flowJoTolerance(rel: string, path: string, fj: number): number {
  if (/ellipse/.test(path)) return Math.max(12, 0.035 * fj);
  if (/dot_gate_name/.test(rel)) return 90;
  if (rel === '8_color_data_set/8_color_ICS.wsp') return 2;
  return 0;
}
/** FlowJo did not compute these counts (-1). */
const FLOWJO_NO_COUNTS = new Set(['simple_line_example/simple_poly_and_rect.wsp']);

/** Whether a population (through its gate, its ancestors or Boolean operands) depends on a polygon on FlowJo's grid. */
function onGateGrid(ws: Workspace, popId: string, seen = new Set<string>()): boolean {
  if (seen.has(popId)) return false;
  seen.add(popId);
  const p = ws.populations.find((q) => q.id === popId);
  if (!p) return false;
  const gates = [p.gate, ...Object.values(p.overrides ?? {})];
  if (gates.some((g) => polygonGateGrids(g))) return true;
  if (gates.some((g) => g.type === 'bool' && g.operands.some((o) => onGateGrid(ws, o.replace(/^!/, ''), seen)))) return true;
  return p.parentId ? onGateGrid(ws, p.parentId, seen) : false;
}

const FCS_DIRS = ['8_color_data_set/fcs_files', 'simple_line_example', 'simple_diamond_example'];
const fcsCache = new Map<string, FcsDataset>();
function loadFcs(fileName: string): FcsDataset | null {
  const path = FCS_DIRS.map((d) => join(DATA, d, fileName)).find((p) => existsSync(p));
  if (!path) return null;
  let ds = fcsCache.get(path);
  if (!ds) {
    const b = readFileSync(path);
    ds = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    fcsCache.set(path, ds);
  }
  return ds;
}

describe.skipIf(!HAVE_DATA)('FlowJo import: FlowKit test workspaces', () => {
  const report: string[] = [];
  for (const rel of Object.keys(REF)) {
    it(rel, () => {
      const res = importFlowJo(readFileSync(join(DATA, rel), 'utf8'));
      const ws: Workspace = res.workspace;
      const eng = new Engine();
      for (const s of ws.samples) {
        const ds = loadFcs(s.fileName);
        expect(ds, s.fileName).not.toBeNull();
        eng.addSample(s.id, ds!);
      }
      const ref = REF[rel];
      let maxFk = 0;
      let maxFj = 0;
      let worstFj = '';
      let n = 0;
      for (const s of ws.samples) {
        const si = ref.samples.indexOf(s.fileName);
        for (const p of ws.populations) {
          const path = popPath(ws, p.id).split(' / ').join('/');
          const count = eng.count(ws, s.id, p.id);
          n++;
          // FlowKit reference (samples FlowKit could not analyze have no gates: all populations empty), for the
          // populations that do not depend on a FlowJo polygon (FlowKit tests polygons exactly, FlowJo on its grid)
          const fk = si >= 0 ? ref.counts[path]?.[si] : 0;
          expect(fk, `${rel} ${s.name} ${path}: no reference`).not.toBeUndefined();
          if (!onGateGrid(ws, p.id)) {
            const tolFk = /ellipse/.test(path) ? 1 : 0; // exact ellipse here, 128-vertex polygon in FlowKit
            expect(Math.abs(count - fk!), `${s.name} ${path}: ${count} vs FlowKit ${fk}`).toBeLessThanOrEqual(tolFk);
          }
          maxFk = Math.max(maxFk, Math.abs(count - fk!));
          // FlowJo's own counts stored in the workspace
          const fj = res.counts[s.id][p.id];
          if (FLOWJO_NO_COUNTS.has(rel) || fj === undefined || fj < 0) continue;
          const d = Math.abs(count - fj);
          if (d > maxFj) {
            maxFj = d;
            worstFj = `${path} (${count} vs ${fj})`;
          }
          expect(d, `${s.name} ${path}: ${count} vs FlowJo ${fj}`).toBeLessThanOrEqual(flowJoTolerance(rel, path, fj));
        }
      }
      report.push(`${rel}: ${ws.samples.length} samples x ${ws.populations.length} populations; max |app - FlowKit| = ${maxFk}; max |app - FlowJo| = ${maxFj}${worstFj ? ' at ' + worstFj : ''}`);
      expect(n).toBeGreaterThan(0);
    });
  }

  it('maps Comp- channels, per-sample transforms and custom gates', () => {
    const res = importFlowJo(readFileSync(join(DATA, '8_color_data_set/8_color_ICS_sample_without_gates.wsp'), 'utf8'));
    const ws = res.workspace;
    expect(ws.groups.map((g) => g.name)).toEqual(['DEN']);
    expect(ws.compensations).toHaveLength(1);
    expect(ws.compensations[0].channels).toContain('CD3 APC-H7 FLR-A');
    const aamine = ws.populations.find((p) => p.name === 'aAmine-')!;
    expect(aamine.gate).toMatchObject({ type: 'polygon', x: 'Aqua Amine FLR-A', y: 'SSC-A' });
    expect((aamine.gate as { scales: { x: ScaleDef } }).scales.x).toMatchObject({ type: 'logicle', T: 262144, W: 1, A: 0 });
    // the time gate: each sample's own time gain (FlowJo time -> seconds: x $TIMESTEP 0.01 / gain)
    const time = ws.populations.find((p) => p.name === 'Time')!;
    const e03 = ws.samples.find((s) => s.fileName.includes('E03'))!;
    const e05 = ws.samples.find((s) => s.fileName.includes('E05'))!;
    const e01 = ws.samples.find((s) => s.fileName.includes('E01'))!;
    const g03 = time.overrides?.[e03.id] ?? time.gate; // E03 has a custom (sample-specific) time gate
    const g01 = time.overrides?.[e01.id] ?? time.gate;
    expect(g03).toMatchObject({ type: 'rect', x: 'Time', y: 'FSC-A' });
    expect(g03).not.toEqual(g01);
    expect((g03 as { xmin: number }).xmin).toBeCloseTo((6.238138952758297 * 0.01) / 0.0100853049, 9);
    // E01: the gate starts within half a display channel of the time axis minimum (1.2747 s), so FlowJo counts every event
    expect((g01 as { xmin: number }).xmin).toBe(-Infinity);
    expect((g01 as { xmax: number }).xmax).toBe(Infinity);
    // E05 has no gates in this workspace: the tree is scoped to the gated samples (n/a for E05)
    expect(time.overrides?.[e05.id]).toBeUndefined();
    expect(applies(ws, e05.id, time.id)).toBe(false);
    expect(applies(ws, e01.id, time.id)).toBe(true);
    expect(ws.populations.filter((p) => p.scope).map((p) => p.name)).toEqual(['Time']);
    expect(res.warnings.some((w) => /E05.*no gate/.test(w))).toBe(true);
  });

  afterAll(() => {
    if (report.length) console.log('FlowJo import vs FlowKit / FlowJo counts\n' + report.join('\n'));
  });
});

// ------------------------------------------------------------------ opening files

describe.skipIf(!HAVE_DATA)('FlowJo import: opening .wsp files', () => {
  const dir = join(DATA, '8_color_data_set');
  const file = (path: string) => new File([readFileSync(path)], path.split('/').pop()!);
  const fcsNames = ['101_DEN084Y5_15_E01_008_clean.fcs', '101_DEN084Y5_15_E03_009_clean.fcs', '101_DEN084Y5_15_E05_010_clean.fcs'];
  const cd4Count = (sampleFile: string) => {
    const ws = useStore.getState().ws;
    const s = ws.samples.find((x) => x.fileName === sampleFile)!;
    const p = ws.populations.find((x) => popPath(ws, x.id) === 'Time / Singlets / aAmine- / CD3+ / CD4+')!;
    return engine.count(ws, s.id, p.id);
  };

  it('links FCS files dropped together with the workspace; the others wait to be relinked', async () => {
    await openFiles([file(join(dir, '8_color_ICS.wsp')), file(join(dir, 'fcs_files', fcsNames[0])), file(join(dir, 'fcs_files', fcsNames[1]))]);
    const st = useStore.getState();
    expect(st.ws.name).toBe('8_color_ICS');
    expect(st.ws.samples).toHaveLength(3); // no extra samples for the linked files
    expect(st.ws.samples.filter((s) => engine.has(s.id)).map((s) => s.fileName).sort()).toEqual(fcsNames.slice(0, 2));
    expect(st.ui.missingFiles).toEqual([fcsNames[2]]);
    expect(cd4Count(fcsNames[0])).toBe(82636); // FlowJo's count (FlowKit: 82485, polygons tested exactly)
    // dropping the missing file later relinks it
    await loadFcsFiles([file(join(dir, 'fcs_files', fcsNames[2]))]);
    expect(useStore.getState().ws.samples).toHaveLength(3);
    expect(useStore.getState().ui.missingFiles).toEqual([]);
    expect(cd4Count(fcsNames[2])).toBe(81268); // FlowJo's count (FlowKit: 81158)
  });

  it('opens a .wsp inside a zip together with its FCS files', async () => {
    const zip = zipSync({
      'study/8_color_ICS_boolean_gate_testing.wsp': readFileSync(join(dir, '8_color_ICS_boolean_gate_testing.wsp')),
      ...Object.fromEntries(fcsNames.map((n) => [`study/fcs/${n}`, new Uint8Array(readFileSync(join(dir, 'fcs_files', n)))])),
    }, { level: 0 });
    await openFiles([new File([zip], 'study.zip')]);
    const st = useStore.getState();
    expect(st.ws.name).toBe('8_color_ICS_boolean_gate_testing');
    expect(st.ws.samples.every((s) => engine.has(s.id))).toBe(true);
    expect(st.ui.missingFiles).toEqual([]);
    const ws = st.ws;
    const s = ws.samples.find((x) => x.fileName === fcsNames[1])!;
    const p = ws.populations.find((x) => popPath(ws, x.id) === 'Time / Singlets / aAmine- / CD3+ / CD4+ / CD107a+ or IFNg+')!;
    expect(engine.count(ws, s.id, p.id)).toBe(663); // FlowJo's count (FlowKit: 651)
  });
});
