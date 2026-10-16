// FlowJo 10 evaluates polygon gates on its gate grid (GateGrid in core/transforms.ts): events and vertices as integer
// display channels (gateResolution per axis; linear axes round, biex / logicle truncate), the outline included.
// Unit checks of the grid evaluation (always run) and real FlowJo workspaces whose stored counts the app must match
// exactly (skipped when the downloaded files are missing, see /home/claude/testdata/online/README.md).
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Engine, engine } from '../src/core/engine';
import { parseFcs, type FcsDataset } from '../src/core/fcs';
import { flowJoChannelRenames, importFlowJo, renameWorkspaceChannels } from '../src/core/flowjo';
import { applyGate, polygonGateGrids, type GateContext } from '../src/core/gating';
import { popPath, type GateGeom, type Pt, type Workspace } from '../src/core/model';
import { openFiles } from '../src/io/files';
import { useStore } from '../src/state/store';
import { flowJoBiexDef, gateGridBase, gateGridOf, gridChannel, makeScale, withGateGrid, type BaseScaleDef, type GateGrid, type ScaleDef } from '../src/core/transforms';

const ONLINE = '/home/claude/testdata/online';

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Gate context over two raw channels "x" and "y" (display arrays computed like the engine: float32). */
function context(xs: Float32Array, ys: Float32Array): GateContext {
  const raw: Record<string, Float32Array> = { x: xs, y: ys };
  return {
    raw: (ch) => raw[ch] ?? null,
    display: (ch, def) => (raw[ch] ? makeScale(def).fwdArray(raw[ch]) : null),
    scaleOf: () => ({ type: 'linear', min: 0, max: 1 }),
    population: () => new Uint32Array(0),
    eventCount: xs.length,
  };
}

const all = (n: number) => Uint32Array.from({ length: n }, (_, i) => i);

/** Reference: closed polygon (inside or on the outline) on integer points, checked point by point. */
function closedLattice(cx: number, cy: number, V: number[][]): boolean {
  for (let i = 0, j = V.length - 1; i < V.length; j = i++) {
    const [x1, y1] = V[j];
    const [x2, y2] = V[i];
    if ((x2 - x1) * (cy - y1) === (y2 - y1) * (cx - x1) && cx >= Math.min(x1, x2) && cx <= Math.max(x1, x2) && cy >= Math.min(y1, y2) && cy <= Math.max(y1, y2)) return true;
  }
  let inside = false;
  for (let i = 0, j = V.length - 1; i < V.length; j = i++) {
    const [xi, yi] = V[i];
    const [xj, yj] = V[j];
    if (yi > cy !== yj > cy && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe('FlowJo gate grid: evaluation', () => {
  const lin = (min: number, max: number, grid?: GateGrid): ScaleDef => (grid ? withGateGrid({ type: 'linear', min, max }, grid) : { type: 'linear', min, max });

  it('tests channel points against the closed polygon (random polygons, outline and off-scale events)', () => {
    const r = rng(7);
    const grid = { n: 64, nearest: true };
    const sc = lin(0, 64, grid); // display u = x / 64: channel = round(x)
    for (let t = 0; t < 60; t++) {
      // random polygons with integer and fractional vertices, also beyond the axis, axis-parallel edges included
      const nv = 3 + Math.floor(r() * 7);
      const pts: Pt[] = [];
      for (let i = 0; i < nv; i++) {
        const snap = r() < 0.5;
        const x = -8 + r() * 80;
        const y = -8 + r() * 80;
        pts.push(snap ? [Math.round(x), Math.round(y)] : [x, y]);
        if (r() < 0.2) pts.push([pts[pts.length - 1][0] + Math.round(r() * 10 - 5), pts[pts.length - 1][1]]);
      }
      const n = 3000;
      const xs = new Float32Array(n);
      const ys = new Float32Array(n);
      for (let e = 0; e < n; e++) {
        // half of the events exactly on channel points (outline cases), the rest anywhere (also off-scale)
        xs[e] = r() < 0.5 ? Math.round(r() * 70 - 3) : r() * 80 - 8;
        ys[e] = r() < 0.5 ? Math.round(r() * 70 - 3) : r() * 80 - 8;
      }
      const g: GateGeom = { type: 'polygon', x: 'x', y: 'y', points: pts, scales: { x: sc, y: sc }, strict: false };
      const got = new Set(applyGate(g, all(n), context(xs, ys)));
      const V = pts.map((p) => [Math.floor(p[0] + 0.5), Math.floor(p[1] + 0.5)]);
      const wrong: string[] = [];
      for (let e = 0; e < n; e++) {
        const cx = Math.min(63, Math.max(0, Math.floor(xs[e] + 0.5)));
        const cy = Math.min(63, Math.max(0, Math.floor(ys[e] + 0.5)));
        if (got.has(e) !== closedLattice(cx, cy, V)) wrong.push(`(${xs[e]}, ${ys[e]})`);
      }
      expect(wrong, `polygon ${t}`).toEqual([]);
    }
  });

  /** A gate one channel wide (channel c of the x axis), all channels of the y axis. */
  const band = (sx: ScaleDef, sy: ScaleDef, c: number, n: number): GateGeom => {
    const x0 = makeScale(sx).inv((c + 0.25) / n);
    const x1 = makeScale(sx).inv((c + 0.45) / n);
    return { type: 'polygon', x: 'x', y: 'y', points: [[x0, -1], [x0, 2], [x1, 2], [x1, -1]], scales: { x: sx, y: sy }, strict: false };
  };

  it('rounds linear axes half up (Java Math.round), also for values exactly half way', () => {
    // (2k + 1) * 3 / 512 is exact in float32: half-way values, which round up (banker's rounding would not)
    const max = 3;
    const n = 256;
    const xs = Float32Array.from({ length: 2 * n - 1 }, (_, i) => ((i + 1) * 0.5 * max) / n);
    const ys = new Float32Array(xs.length).fill(0.5);
    const sx = lin(0, max, { n, nearest: true });
    const sy = lin(0, 1, { n, nearest: true });
    for (const c of [2, 3, 100, 201]) {
      // channel c holds c - 0.5 (rounded up) and c: events 2c - 2 and 2c - 1
      expect(Array.from(applyGate(band(sx, sy, c, n), all(xs.length), context(xs, ys)))).toEqual([2 * c - 2, 2 * c - 1]);
    }
  });

  it('places events next to a channel step by their raw value, not the float32 display value', () => {
    const n = 256;
    const sy = lin(0, 1, { n, nearest: true });
    const defs: BaseScaleDef[] = [
      { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 },
      flowJoBiexDef({ neg: 0, width: -100, pos: 4.418539922, max: 262144 }),
      { type: 'arcsinh', T: 262144, M: 4.5, A: 0 },
    ];
    for (const def of defs) {
      const sx = withGateGrid(def, { n, nearest: false });
      const sc = makeScale(sx);
      // the float32 values around every channel step
      const xs: number[] = [];
      const f = new Float32Array(1);
      const bits = new Int32Array(f.buffer);
      for (let k = 1; k < n; k++) {
        f[0] = sc.inv(k / n);
        const b0 = bits[0];
        for (let i = -6; i <= 6; i++) {
          bits[0] = b0 + i;
          xs.push(f[0]);
        }
      }
      const xr = Float32Array.from(xs);
      const exact = xs.map((x) => Math.floor(sc.fwd(x) * n));
      // the float32 display values alone would put many of them into the neighbouring channel
      const disp = sc.fwdArray(xr);
      expect(exact.filter((c, i) => Math.floor(disp[i] * n) !== c).length, def.type).toBeGreaterThan(50);
      const ys = new Float32Array(xr.length).fill(0.5);
      for (const c of [10, 60, 128, 200]) {
        const got = Array.from(applyGate(band(sx, sy, c, n), all(xr.length), context(xr, ys)));
        expect(got, `${def.type} channel ${c}`).toEqual(exact.flatMap((ch, i) => (ch === c ? [i] : [])));
      }
    }
  });

  it('keeps continuous evaluation without a (valid) grid, and checks grids', () => {
    expect(gateGridOf({ type: 'linear', min: 0, max: 1 })).toBeNull();
    expect(gateGridOf({ type: 'linear', min: 0, max: 1, grid: { n: 1.5, nearest: true } })).toBeNull();
    expect(gateGridOf({ type: 'linear', min: 0, max: 1, grid: 'x' } as unknown as ScaleDef)).toBeNull();
    expect(gateGridOf({ type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0, grid: { n: 1024, nearest: false } })).toEqual({ n: 1024, nearest: false });
    expect(gridChannel(0.5 / 256, { n: 256, nearest: true })).toBe(1);
    expect(gridChannel(0.5 / 256, { n: 256, nearest: false })).toBe(0);
    // memoized: one object per definition and grid (stable for the engine's caches)
    const base: BaseScaleDef = { type: 'linear', min: 0, max: 10 };
    expect(withGateGrid(base, { n: 256, nearest: true })).toBe(withGateGrid(base, { n: 256, nearest: true }));
    expect(withGateGrid(base, { n: 256, nearest: true })).not.toBe(withGateGrid(base, { n: 1024, nearest: true }));
    // only one axis with a grid: the exact polygon
    const xs = Float32Array.from([0.49, 0.51]);
    const ys = Float32Array.from([0.5, 0.5]);
    const sq: Pt[] = [[0.5, 0], [1, 0], [1, 1], [0.5, 1]];
    const g: GateGeom = { type: 'polygon', x: 'x', y: 'y', points: sq, scales: { x: lin(0, 1, { n: 4, nearest: true }), y: lin(0, 1) }, strict: false };
    expect(polygonGateGrids(g)).toBeNull();
    expect(Array.from(applyGate(g, all(2), context(xs, ys)))).toEqual([1]);
    // with both: channel 2 of 4 (0.49 -> round(1.96) = 2) lies on the outline at x = 2
    const g2: GateGeom = { ...g, scales: { x: lin(0, 1, { n: 4, nearest: true }), y: lin(0, 1, { n: 4, nearest: true }) } };
    expect(Array.from(applyGate(g2, all(2), context(xs, ys)))).toEqual([0, 1]);
  });

  it('imports FlowJo polygons with their gate resolution; biex and logicle axes truncate', () => {
    const NS =
      'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';
    const dim = (n: string) => `<gating:dimension><data-type:fcs-dimension data-type:name="${n}"/></gating:dimension>`;
    const vtx = (x: number, y: number) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
    const poly = (x: string, y: string, res: string) => `<gating:PolygonGate eventsInside="1"${res}>${dim(x)}${dim(y)}${vtx(10, 10)}${vtx(500, 10)}${vtx(500, 500)}</gating:PolygonGate>`;
    const pop = (name: string, gate: string) => `<Population name="${name}" count="-1"><Gate>${gate}</Gate></Population>`;
    const wsp = `<?xml version="1.0"?><Workspace version="20.0" flowJoVersion="10.8.1" ${NS}><SampleList><Sample>
      <DataSet uri="file:/a.fcs" sampleID="1"/>
      <Transformations>
        <transforms:linear transforms:minRange="0" transforms:maxRange="1024" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
        <transforms:biex transforms:length="256" transforms:maxRange="1024" transforms:neg="0" transforms:width="-10" transforms:pos="3"><data-type:parameter data-type:name="FL1-A"/></transforms:biex>
        <transforms:logicle transforms:length="256" transforms:T="1024" transforms:W="0.5" transforms:M="3" transforms:A="0"><data-type:parameter data-type:name="FL2-A"/></transforms:logicle>
      </Transformations>
      <Keywords><Keyword name="$PAR" value="3"/><Keyword name="$P1N" value="FSC-A"/><Keyword name="$P2N" value="FL1-A"/><Keyword name="$P3N" value="FL2-A"/></Keywords>
      <SampleNode name="a.fcs" count="10" sampleID="1"><Subpopulations>
        ${pop('hi', poly('FSC-A', 'FL1-A', ' gateResolution="1024"'))}${pop('lo', poly('FL2-A', 'FSC-A', ''))}
      </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
    const ws = importFlowJo(wsp).workspace;
    const gate = (name: string) => ws.populations.find((p) => p.name === name)!.gate;
    expect(polygonGateGrids(gate('hi'))).toEqual({ x: { n: 1024, nearest: true }, y: { n: 1024, nearest: false } });
    // no gateResolution: FlowJo's 256
    expect(polygonGateGrids(gate('lo'))).toEqual({ x: { n: 256, nearest: false }, y: { n: 256, nearest: true } });
    // the display scales stay without a grid; the gate's scales are the same transforms
    expect(Object.values(ws.scales).every((s) => gateGridOf(s) === null)).toBe(true);
    const { grid: _g, ...plain } = (gate('hi') as Extract<GateGeom, { type: 'polygon' }>).scales!.y as Extract<ScaleDef, { type: 'logicle' }>;
    expect(plain).toEqual(ws.scales['FL1-A']);
    // ... and evaluate on the display arrays of the workspace scale
    expect(gateGridBase((gate('hi') as Extract<GateGeom, { type: 'polygon' }>).scales!.y!)).toBe(ws.scales['FL1-A']);
  });
});

// ------------------------------------------------------------------ real FlowJo workspaces

function loadFcs(path: string): FcsDataset {
  const b = readFileSync(path);
  return parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

/**
 * Import a workspace, link FCS files (by the sample's file name, or `files` sample file name -> path) the way the app does
 * (FlowJo's "_" for "/" follows the file), and return the app's and FlowJo's counts per sample and population path.
 */
function compareCounts(wspPath: string, dir: string, files: Record<string, string> = {}) {
  const res = importFlowJo(readFileSync(wspPath, 'utf8'));
  const ws: Workspace = res.workspace;
  const eng = new Engine();
  const names = readdirSync(dir);
  const rows: { sample: string; path: string; app: number; fj: number }[] = [];
  for (const s of ws.samples) {
    const f = files[s.fileName] ?? names.find((n) => n === s.fileName || n.endsWith(' ' + s.fileName));
    if (!f) continue;
    const ds = loadFcs(files[s.fileName] ?? join(dir, f));
    renameWorkspaceChannels(ws, flowJoChannelRenames(s.channels.map((c) => c.name), ds.channels.map((c) => c.name)));
    eng.addSample(s.id, ds);
    for (const p of ws.populations) {
      const fj = res.counts[s.id]?.[p.id];
      const app = eng.countOrNA(ws, s.id, p.id);
      if (fj === undefined || fj < 0 || app === null) continue;
      rows.push({ sample: s.name, path: popPath(ws, p.id), app, fj });
    }
  }
  return { ws, rows };
}

const ICS = join(ONLINE, 'zenodo_16754553_ics_wsp');
const ICS_WSP = join(ICS, '2-Week ICS #2.wsp');

describe.skipIf(!existsSync(ICS_WSP) || readdirSync(ICS).filter((f) => f.endsWith('.fcs')).length < 18)('FlowJo gate grid: ICS workspace (FlowJo 10.10, biex)', () => {
  it('matches every count FlowJo stored (16 populations x 18 samples; cytokine gates differed by up to 30 % before)', () => {
    const { rows } = compareCounts(ICS_WSP, ICS);
    expect(rows.length).toBe(16 * 18);
    const wrong = rows.filter((r) => r.app !== r.fj).map((r) => `${r.sample} ${r.path}: ${r.app} vs FlowJo ${r.fj}`);
    expect(wrong).toEqual([]);
    // the cases that were furthest off with exact polygons (FlowKit's evaluation): 166, 399, 7703
    const at = (sample: string, gate: string) => rows.find((r) => r.sample.includes(sample) && r.path.endsWith('CD4 Single Positive / ' + gate))!.app;
    expect(at('C02', 'IL-4 BV421 +')).toBe(225);
    expect(at('C07', 'IFNy FITC +')).toBe(342);
    expect(at('C08', 'IL-10 APC +')).toBe(8197);
  });

  it('opened in the app (workspace dropped with its files): the comparison table shows no difference', async () => {
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    const fcs = readdirSync(ICS).filter((f) => f.endsWith('.fcs'));
    const file = (name: string) => new File([new Uint8Array(readFileSync(join(ICS, name)))], name);
    await openFiles([file('2-Week ICS #2.wsp'), ...fcs.map(file)]);
    const st = useStore.getState();
    const ws = st.ws;
    expect(ws.samples.filter((s) => engine.has(s.id))).toHaveLength(18);
    const fj = st.ui.flowjoCounts!.counts;
    const wrong: string[] = [];
    let n = 0;
    for (const s of ws.samples)
      for (const p of ws.populations) {
        const want = fj[s.id]?.[p.id];
        if (want === undefined || want < 0) continue;
        n++;
        const c = engine.count(ws, s.id, p.id);
        if (c !== want) wrong.push(`${s.name} ${popPath(ws, p.id)}: ${c} vs FlowJo ${want}`);
      }
    expect(n).toBe(16 * 18);
    expect(wrong).toEqual([]);
  });
});

const FLOWSOM = join(ONLINE, 'flowsom');
describe.skipIf(!existsSync(join(FLOWSOM, 'gating.wsp')) || !existsSync(join(FLOWSOM, '68983.fcs')))('FlowJo gate grid: FlowSOM workspace (FlowJo 10.5, gateResolution 1024)', () => {
  it('matches every count FlowJo stored', () => {
    // the workspace's sample "lymphocytes.fcs" is the downloaded 68983.fcs
    const { ws, rows } = compareCounts(join(FLOWSOM, 'gating.wsp'), FLOWSOM, { 'lymphocytes.fcs': join(FLOWSOM, '68983.fcs') });
    expect(rows.length).toBe(15);
    expect(rows.filter((r) => r.app !== r.fj).map((r) => `${r.path}: ${r.app} vs FlowJo ${r.fj}`)).toEqual([]);
    const lym = ws.populations.find((p) => p.name === 'Lymphocytes')!;
    expect(polygonGateGrids(lym.gate)?.x.n).toBe(1024);
  });
});

const ATTUNE = join(ONLINE, 'zenodo_7352402_attune_wsp');
const ATTUNE_WSP = join(ATTUNE, 'TMEM IAB Flox flow 10-Jan-2022.wsp');
describe.skipIf(!existsSync(ATTUNE_WSP))('FlowJo gate grid: Attune workspace (FlowJo 10.8, biex)', () => {
  it('matches every count FlowJo stored for the samples present', () => {
    const { rows } = compareCounts(ATTUNE_WSP, ATTUNE);
    expect(rows.length).toBeGreaterThanOrEqual(17);
    expect(rows.filter((r) => r.app !== r.fj).map((r) => `${r.sample} ${r.path}: ${r.app} vs FlowJo ${r.fj}`)).toEqual([]);
  });
});
