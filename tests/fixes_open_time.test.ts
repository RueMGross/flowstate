// Opening workspaces (undo, confirmation triggers), Time in seconds ($TIMESTEP), Gating-ML matrices, relinking,
// Boolean names, gate copy / paste, history limits, 1D auto gate bounds.
import { strToU8, zipSync } from 'fflate';
import { DensityMap1D, autoGate1D, SENSITIVITY } from '../src/core/autogate';
import { engine } from '../src/core/engine';
import { parseFcs, writeFcs } from '../src/core/fcs';
import { emptyWorkspace, type GateGeom, type Population, type Workspace } from '../src/core/model';
import { importGatingMLText, openFiles, openWorkspace, parseWorkspace, replacingFile, serializeWorkspace } from '../src/io/files';
import { HISTORY_LIMIT, hasTicksTime, loadFcsFiles, relinkSample, useStore } from '../src/state/store';
import { copyGates, pasteGates, rangeName } from '../src/ui/gateOps';

const N = 500;
/** FCS bytes with FSC-A, FL1-A and Time (ticks 0..N-1); `timestep` is written as $TIMESTEP. */
function fcsBytes(opts: { timestep?: string; n?: number; seed?: number } = {}): Uint8Array {
  const n = opts.n ?? N;
  let s = opts.seed ?? 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const data = [Float32Array.from({ length: n }, () => rnd() * 1000), Float32Array.from({ length: n }, () => rnd() * 1000), Float32Array.from({ length: n }, (_, i) => i)];
  const kw: Record<string, string> = { $FIL: 'x.fcs' };
  // writeFcs never writes $TIMESTEP (its values are already in seconds): patch a same-length placeholder
  if (opts.timestep) kw.XTIMESTEP = opts.timestep;
  const b = writeFcs({ channels: [{ name: 'FSC-A', range: 1024 }, { name: 'FL1-A', range: 1024 }, { name: 'Time', range: 1024 }], data, keywords: kw });
  const txt = new TextDecoder('latin1').decode(b);
  const at = txt.indexOf('XTIMESTEP');
  if (at >= 0) b[at] = '$'.charCodeAt(0);
  return b;
}
const toBuf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const file = (b: Uint8Array, name: string) => new File([b as BlobPart], name);

function reset(ws?: Workspace) {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(ws ?? emptyWorkspace());
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [], dialog: null, flowjoCounts: null } });
}

describe('Time in seconds ($TIMESTEP)', () => {
  it('scales Time by $TIMESTEP on reading, with its range and unit', () => {
    const ds = parseFcs(toBuf(fcsBytes({ timestep: '0.01' })));
    const t = ds.channels.findIndex((c) => c.name === 'Time');
    expect(ds.timeStep).toBe(0.01);
    expect(ds.channels[t].unit).toBe('s');
    expect(ds.data[t][250]).toBeCloseTo(2.5, 5);
    expect(ds.channels[t].range).toBeCloseTo(1024 * 0.01, 9);
    // other channels untouched
    expect(ds.channels[0].unit).toBeUndefined();
    const plain = parseFcs(toBuf(fcsBytes()));
    expect(plain.timeStep).toBeUndefined();
    expect(plain.data[2][250]).toBe(250);
  });
  it('writes seconds without $TIMESTEP, so a round trip does not scale twice', () => {
    const ds = parseFcs(toBuf(fcsBytes({ timestep: '0.01' })));
    const back = parseFcs(toBuf(writeFcs({ channels: ds.channels, data: ds.data, keywords: ds.keywords })));
    expect(back.keywords['$TIMESTEP']).toBeUndefined();
    expect(back.data[2][250]).toBeCloseTo(2.5, 5);
  });
  it('converts Time gates of workspaces saved in ticks when the files are opened (bundle) or linked later', async () => {
    const w = emptyWorkspace();
    w.samples = [{ id: 'sA', name: 'A', fileName: 'A.fcs', fileSize: 0, eventCount: N, channels: [{ name: 'Time', label: '', range: 1024 }], compId: null }];
    w.populations = [
      { id: 'pT', name: 'Early', parentId: null, color: '#000', gate: { type: 'range', x: 'Time', min: -Infinity, max: 100 } },
      { id: 'pR', name: 'R', parentId: null, color: '#000', gate: { type: 'rect', x: 'FSC-A', y: 'Time', xmin: 0, xmax: Infinity, ymin: 50, ymax: 150 } },
    ];
    w.scales.Time = { type: 'linear', min: 0, max: 600 };
    // an older file: no timeUnit
    const old = JSON.parse(serializeWorkspace(w));
    delete old.timeUnit;
    const parsed = parseWorkspace(JSON.stringify(old));
    expect(hasTicksTime(parsed)).toBe(true);
    // a bundle: converted right away
    reset();
    await openWorkspace(parsed, [{ name: 'A.fcs', bytes: fcsBytes({ timestep: '0.01' }), id: 'sA' }]);
    let ws = useStore.getState().ws;
    expect(hasTicksTime(ws)).toBe(false);
    expect(ws.populations[0].gate).toEqual({ type: 'range', x: 'Time', min: -Infinity, max: 1 });
    expect(ws.populations[1].gate).toMatchObject({ xmin: 0, xmax: Infinity, ymin: 0.5, ymax: 1.5 });
    expect(ws.scales.Time).toEqual({ type: 'linear', min: 0, max: 6 });
    expect(engine.count(ws, 'sA', 'pT')).toBe(100); // ticks 0..99 = 0..0.99 s
    expect(JSON.parse(serializeWorkspace(ws)).timeUnit).toBe('s');
    // a .json without files: converted when the file is linked (dropped by name, any case)
    reset();
    await openWorkspace(parseWorkspace(JSON.stringify(old)), []);
    expect(hasTicksTime(useStore.getState().ws)).toBe(true);
    expect(JSON.parse(serializeWorkspace(useStore.getState().ws)).timeUnit).toBe('ticks');
    await loadFcsFiles([file(fcsBytes({ timestep: '0.01' }), 'a.FCS')]);
    ws = useStore.getState().ws;
    expect(ws.samples).toHaveLength(1);
    expect(engine.has('sA')).toBe(true);
    expect(ws.populations[0].gate).toEqual({ type: 'range', x: 'Time', min: -Infinity, max: 1 });
    expect(engine.count(ws, 'sA', 'pT')).toBe(100);
    expect((ws.samples[0].channels.find((c) => c.name === 'Time') as { unit?: string }).unit).toBe('s');
  });
});

describe('opening a workspace', () => {
  it('keeps the previous workspace and its data reachable by Undo', async () => {
    reset();
    await loadFcsFiles([file(fcsBytes({ seed: 3 }), 'one.fcs')]);
    const st = useStore.getState();
    st.update((w) => void (w.name = 'Mine'));
    const mine = useStore.getState().ws;
    const sid = mine.samples[0].id;
    const other = emptyWorkspace();
    other.name = 'Other';
    other.samples = [{ id: 'sX', name: 'X', fileName: 'x.fcs', fileSize: 0, eventCount: N, channels: [], compId: null }];
    await openFiles([new File([serializeWorkspace(other)], 'other.flowstate.json')]);
    expect(useStore.getState().ws.name).toBe('Other');
    expect(useStore.getState().ui.missingFiles).toEqual(['x.fcs']);
    useStore.getState().undo();
    expect(useStore.getState().ws.name).toBe('Mine');
    expect(engine.has(sid)).toBe(true);
    expect(useStore.getState().ui.missingFiles).toEqual([]);
    useStore.getState().redo();
    expect(useStore.getState().ws.name).toBe('Other');
  });
  it('knows which files replace the workspace (asks first) and which only add to it', async () => {
    const wsJson = new File(['{}'], 'a.flowstate.json');
    const fcs = file(fcsBytes(), 'a.fcs');
    const gml = new File(['<?xml version="1.0"?><gating:Gating-ML xmlns:gating="x"/>'], 'gates.xml');
    const fjXml = new File(['<?xml version="1.0"?><Workspace version="20.0"></Workspace>'], 'fj.xml');
    const bundle = new File([zipSync({ 'workspace.flowstate.json': strToU8('{}'), 'fcs/s/a.fcs': fcsBytes() }) as BlobPart], 'b.zip');
    const fcsZip = new File([zipSync({ 'a.fcs': fcsBytes(), 'g.xml': strToU8('<Gating-ML/>') }) as BlobPart], 'c.zip');
    const wspZip = new File([zipSync({ 'study/x.wsp': strToU8('<Workspace/>') }) as BlobPart], 'd.zip');
    expect(await replacingFile([fcs, gml])).toBeNull();
    expect(await replacingFile([fcsZip])).toBeNull();
    expect(await replacingFile([fcs, wsJson])).toBe(wsJson);
    expect(await replacingFile([fjXml])).toBe(fjXml);
    expect((await replacingFile([new File(['<Workspace/>'], 'x.wsp')]))?.name).toBe('x.wsp');
    expect(await replacingFile([bundle])).toBe(bundle);
    expect(await replacingFile([wspZip])).toBe(wspZip);
  });
});

describe('Gating-ML import', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <transforms:spectrumMatrix transforms:id="MySpill">
    <transforms:fluorochromes><data-type:fcs-dimension data-type:name="FSC-A"/><data-type:fcs-dimension data-type:name="FL1-A"/></transforms:fluorochromes>
    <transforms:detectors><data-type:fcs-dimension data-type:name="FSC-A"/><data-type:fcs-dimension data-type:name="FL1-A"/></transforms:detectors>
    <transforms:spectrum><transforms:coefficient transforms:value="1"/><transforms:coefficient transforms:value="0.2"/></transforms:spectrum>
    <transforms:spectrum><transforms:coefficient transforms:value="0"/><transforms:coefficient transforms:value="1"/></transforms:spectrum>
  </transforms:spectrumMatrix>
  <gating:RectangleGate gating:id="R1">
    <gating:dimension gating:compensation-ref="MySpill" gating:min="100" gating:max="900"><data-type:fcs-dimension data-type:name="FL1-A"/></gating:dimension>
  </gating:RectangleGate>
</gating:Gating-ML>`;
  it("adds the matrix under a readable name and leaves the samples' compensation alone", async () => {
    reset();
    await loadFcsFiles([file(fcsBytes(), 's.fcs')]);
    const before = useStore.getState().ws.samples.map((s) => s.compId);
    importGatingMLText(xml, 'panel.gating-ml.xml');
    const ws = useStore.getState().ws;
    expect(ws.samples.map((s) => s.compId)).toEqual(before);
    const m = ws.compensations.find((c) => c.name === 'Gating-ML: panel')!;
    expect(m).toBeTruthy();
    expect(ws.populations[0].gate.comp).toBe(m.id);
    expect(useStore.getState().ui.toasts.at(-1)!.text).toMatch(/added as "Gating-ML: panel"/);
    // importing again reuses the identical matrix
    importGatingMLText(xml, 'panel.xml');
    const ws2 = useStore.getState().ws;
    expect(ws2.compensations.filter((c) => c.name.startsWith('Gating-ML')).length).toBe(1);
    expect(ws2.populations[1].gate.comp).toBe(m.id);
  });
});

describe('relinking', () => {
  const missing = (): Workspace => {
    const w = emptyWorkspace();
    w.samples = [{ id: 'sM', name: 'M', fileName: 'Tube_01.fcs', fileSize: 0, eventCount: N, channels: [], compId: null }];
    return w;
  };
  it('matches dropped files by name ignoring case', async () => {
    reset(missing());
    await loadFcsFiles([file(fcsBytes(), 'TUBE_01.FCS')]);
    expect(useStore.getState().ws.samples).toHaveLength(1);
    expect(engine.has('sM')).toBe(true);
  });
  it('links a file picked by hand, asking first when the event count differs', async () => {
    reset(missing());
    await relinkSample('sM', file(fcsBytes(), 'renamed.fcs'));
    expect(engine.has('sM')).toBe(true);
    expect(useStore.getState().ws.samples[0].fileName).toBe('renamed.fcs');
    expect(useStore.getState().ws.samples[0].name).toBe('M');
    reset(missing());
    await relinkSample('sM', file(fcsBytes({ n: 300 }), 'other.fcs'));
    expect(engine.has('sM')).toBe(false);
    const d = useStore.getState().ui.dialog!;
    expect(d.kind).toBe('confirm');
    (d.payload as { onOk: () => void }).onOk();
    expect(engine.has('sM')).toBe(true);
    expect(useStore.getState().ws.samples[0].eventCount).toBe(300);
  });
});

describe('gates', () => {
  const pops = (): Population[] => [
    { id: 'a', name: 'A', parentId: null, color: '#000', gate: { type: 'range', x: 'FSC-A', min: 1, max: 2 } },
    { id: 'b', name: 'B', parentId: null, color: '#000', gate: { type: 'range', x: 'FL1-A', min: 1, max: 2 } },
    { id: 'ab', name: 'A AND B', parentId: null, color: '#000', gate: { type: 'bool', op: 'and', operands: ['a', 'b'] } },
    { id: 'nab', name: 'NOT A AND B', parentId: null, color: '#000', gate: { type: 'bool', op: 'not', operands: ['ab'] } },
    { id: 'mine', name: 'my combo', parentId: null, color: '#000', gate: { type: 'bool', op: 'or', operands: ['a', '!b'] } },
    { id: 'ab2', name: 'A AND B 2', parentId: null, color: '#000', gate: { type: 'bool', op: 'and', operands: ['a', 'b'] } },
  ];
  it('automatic Boolean names follow renamed operands; names given by the user stay', () => {
    const w = emptyWorkspace();
    w.populations = pops();
    reset(w);
    useStore.getState().update((ws) => void (ws.populations[0].name = 'CD4'));
    const name = (id: string) => useStore.getState().ws.populations.find((p) => p.id === id)!.name;
    expect(name('ab')).toBe('CD4 AND B');
    expect(name('nab')).toBe('NOT CD4 AND B');
    expect(name('ab2')).toBe('CD4 AND B 2');
    expect(name('mine')).toBe('my combo');
    // one undo step reverts the rename with its Boolean names
    useStore.getState().undo();
    expect(name('ab')).toBe('A AND B');
  });
  it('names range gates by position', () => {
    expect(rangeName('CD4', -Infinity, 5)).toBe('CD4-');
    expect(rangeName('CD4', 5, Infinity)).toBe('CD4+');
    expect(rangeName('CD4', 1, 5)).toBe('CD4 range');
  });
  it('copies a quadrant gate with its subtree to another population', () => {
    const w = emptyWorkspace();
    const q = (id: string, quadrant: 'UR' | 'UL' | 'LL' | 'LR'): Population => ({ id, name: 'Q ' + quadrant, parentId: 'a', color: '#000', gate: { type: 'quadrant', x: 'FSC-A', y: 'FL1-A', cx: 1, cy: 2, quadrant, groupId: 'g1' } });
    w.populations = [
      ...pops().slice(0, 2),
      q('q1', 'UR'),
      q('q2', 'UL'),
      q('q3', 'LL'),
      q('q4', 'LR'),
      { id: 'c', name: 'C', parentId: 'q1', color: '#000', gate: { type: 'range', x: 'FSC-A', min: 3, max: Infinity } },
      { id: 'cb', name: 'C or B', parentId: 'q1', color: '#000', gate: { type: 'bool', op: 'or', operands: ['c', '!b'] } },
    ];
    reset(w);
    copyGates('q2', true);
    const made = pasteGates('b');
    const ws = useStore.getState().ws;
    expect(made).toHaveLength(4);
    expect(ws.populations).toHaveLength(8 + 6);
    const newQ = ws.populations.filter((p) => p.parentId === 'b');
    const gids = new Set(newQ.map((p) => (p.gate as Extract<GateGeom, { type: 'quadrant' }>).groupId));
    expect(gids.size).toBe(1);
    expect(gids.has('g1')).toBe(false);
    const ur = newQ.find((p) => (p.gate as { quadrant: string }).quadrant === 'UR')!;
    const kids = ws.populations.filter((p) => p.parentId === ur.id);
    expect(kids.map((k) => k.name)).toEqual(['C', 'C or B']);
    const newC = kids[0];
    expect(kids[1].gate).toEqual({ type: 'bool', op: 'or', operands: [newC.id, '!b'] });
    expect((newC.gate as { max: number }).max).toBe(Infinity);
    // pasting again under the same parent: names are made unique
    pasteGates('b');
    expect(useStore.getState().ws.populations.filter((p) => p.parentId === 'b').map((p) => p.name)).toContain('Q UR 2');
  });
});

describe('history', () => {
  it(`keeps ${HISTORY_LIMIT} undo and redo steps`, () => {
    reset();
    const st = useStore.getState();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) st.update((w) => void (w.name = 'n' + i));
    expect(useStore.getState().past.length).toBe(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) useStore.getState().undo();
    expect(useStore.getState().future.length).toBe(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) useStore.getState().redo();
    expect(useStore.getState().past.length).toBe(HISTORY_LIMIT);
    expect(useStore.getState().ws.name).toBe('n' + (HISTORY_LIMIT + 19));
  });
});

describe('1D auto gate bounds', () => {
  function sample(parts: { n: number; c: number; s: number }[]) {
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const all: number[] = [];
    for (const p of parts) for (let i = 0; i < p.n; i++) all.push(p.c + p.s * g());
    const d = Float32Array.from(all);
    const idx = Uint32Array.from(all.map((_, i) => i));
    return DensityMap1D.fromEvents(d, idx);
  }
  it('negative and positive populations share one cut; the positive side stays open', () => {
    // two touching populations, the positive one with a long thin tail that ends well before the axis end
    const map = sample([
      { n: 20000, c: 0.3, s: 0.06 },
      { n: 8000, c: 0.58, s: 0.05 },
    ]);
    const neg = autoGate1D(map, { u: 0.3 }, SENSITIVITY.loose)!;
    const pos = autoGate1D(map, { u: 0.6 }, SENSITIVITY.loose)!;
    expect(neg.lo).toBeLessThan(0);
    expect(pos.hi).toBeGreaterThan(1);
    expect(pos.lo).toBeGreaterThanOrEqual(neg.hi);
    if (neg.located.root !== pos.located.root && pos.i0 === neg.i1 + 1) expect(pos.lo).toBe(neg.hi);
    // a lone population keeps both bounds
    const one = sample([{ n: 20000, c: 0.5, s: 0.05 }]);
    const r = autoGate1D(one, { u: 0.5 }, SENSITIVITY.normal)!;
    expect(r.lo).toBeGreaterThan(0);
    expect(r.hi).toBeLessThan(1);
  });
});

describe('stat chart with negative values', () => {
  it('draws bars from a zero axis, downwards for negative means', async () => {
    const { renderChart } = await import('../src/render/chart');
    const w = emptyWorkspace();
    w.samples = ['a', 'b'].map((id) => ({ id, name: id, fileName: id + '.fcs', fileSize: 0, eventCount: 1, channels: [], compId: null }));
    const vals: Record<string, number> = { a: -50, b: 100 };
    const fakeEngine = { has: () => true, stat: (_ws: Workspace, sid: string) => vals[sid] } as unknown as typeof engine;
    const rects: number[][] = [];
    const lines: number[][] = [];
    const p = {
      kind: 'svg',
      save() {},
      restore() {},
      translate() {},
      clipRect() {},
      line: (x1: number, y1: number, x2: number, y2: number) => void lines.push([x1, y1, x2, y2]),
      path() {},
      rect: (x: number, y: number, ww: number, h: number) => void rects.push([x, y, ww, h]),
      ellipse() {},
      text() {},
      image() {},
    };
    const item = { id: 'c', kind: 'chart', x: 0, y: 0, w: 300, h: 240, stat: { id: 's', population: 'root', stat: 'median', channel: 'X' }, mode: 'samples', sampleSet: 'all', style: 'bar', errorBars: 'none', showPoints: false, color: '#5b8fd1', useGroupColors: false, fontSize: 8, lineWidth: 1 };
    renderChart(p as never, item as never, { ws: w, engine: fakeEngine, activeSampleId: null, rasterScale: 1, makeCanvas: () => null as never } as never);
    const bars = rects.slice(1); // the first rect is the background
    expect(bars).toHaveLength(2);
    const [neg, pos] = bars;
    // the negative bar hangs from the zero line, the positive one stands on it, and twice as long
    expect(neg[1]).toBeCloseTo(pos[1] + pos[3], 6);
    expect(pos[3] / neg[3]).toBeCloseTo(2, 6);
    const y0 = neg[1];
    expect(lines.some(([x1, y1, x2, y2]) => y1 === y0 && y2 === y0 && x2 - x1 > 100)).toBe(true);
  });
});
