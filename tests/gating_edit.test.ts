// Gate drawing vs evaluation, editing in evaluation space, strict flag, boolean operands, labels.
import { DEMO_SAMPLES, makeDemoDataset } from '../src/core/demo';
import { Engine } from '../src/core/engine';
import { allIndices, applyGate, isStrictGate, pointInPolygon, type GateContext } from '../src/core/gating';
import { exportGatingMLDoc, importGatingML } from '../src/core/gatingml';
import { defaultPlotOptions, emptyWorkspace, type GateGeom, type PlotItem, type Population, type Workspace } from '../src/core/model';
import { defaultScaleFor, makeScale, type ScaleDef } from '../src/core/transforms';
import { renderPlot, type PlotGeometry } from '../src/render/plot';
import { editHandle, parentOf, toRaw, translateGate } from '../src/ui/gateOps';
import { hitTest } from '../src/ui/PlotView';

const noop = () => {};
const texts: string[] = [];
const painter = { kind: 'canvas', save: noop, restore: noop, translate: noop, clipRect: noop, line: noop, path: noop, rect: noop, ellipse: noop, image: noop, text: (_x: number, _y: number, t: unknown) => texts.push(typeof t === 'string' ? t : JSON.stringify(t)) } as never;
const makeCanvas = (() => ({ getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: noop }) })) as never;

function setup() {
  const engine = new Engine();
  const ds = makeDemoDataset(DEMO_SAMPLES[2]);
  engine.addSample('s1', ds);
  const ws: Workspace = emptyWorkspace();
  ws.samples.push({ id: 's1', name: 's1', fileName: 's1.fcs', fileSize: 0, eventCount: ds.eventCount, channels: ds.channels.map((c) => ({ name: c.name, label: c.label, range: c.range })), compId: null });
  ds.channels.forEach((c, i) => (ws.scales[c.name] = defaultScaleFor(c.name, c.range, ds.data[i], c.displayHint)));
  return { engine, ws };
}

function plot(x: string, y: string, opts: Partial<PlotItem['options']> = {}): PlotItem {
  return { id: 'p', kind: 'plot', plotType: 'dot', xParam: x, yParam: y, layers: [{ id: 'l', sample: 's1', population: 'root' }], options: { ...defaultPlotOptions(), ...opts }, x: 0, y: 0, w: 300, h: 280 };
}

const render = (engine: Engine, ws: Workspace, item: PlotItem, selectedPopId: string | null = null): PlotGeometry =>
  renderPlot(painter, item, item.w, item.h, { ws, engine, activeSampleId: 's1', rasterScale: 1, makeCanvas, selectedPopId });

function setPop(ws: Workspace, gate: GateGeom): Population {
  const p: Population = { id: 'g', name: 'G', parentId: null, gate, color: '#ff0000' };
  ws.populations = [p];
  return p;
}

/** fraction of frame grid points where the drawn outline disagrees with the gate's membership */
function mismatch(ws: Workspace, geom: PlotGeometry, item: PlotItem, pop: Population, N = 80) {
  const ol = geom.gates.find((s) => s.popId === pop.id)!.outline!;
  const oxs = new Float64Array(ol.length / 2);
  const oys = new Float64Array(ol.length / 2);
  for (let k = 0; k < oxs.length; k++) {
    oxs[k] = ol[2 * k];
    oys[k] = ol[2 * k + 1];
  }
  const sx = makeScale(geom.xScale);
  const sy = makeScale(geom.yScale!);
  const g = pop.gate as Extract<GateGeom, { x: string; y: string }>;
  const swapped = g.x !== item.xParam;
  const rx = new Float32Array(N * N);
  const ry = new Float32Array(N * N);
  const drawn: boolean[] = [];
  const fr = geom.frame;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const px = fr.x + ((i + 0.5) / N) * fr.w;
      const py = fr.y + ((j + 0.5) / N) * fr.h;
      const [u, v] = geom.toDisplay(px, py);
      const a = sx.inv(u);
      const b = sy.inv(v);
      rx[i * N + j] = swapped ? b : a;
      ry[i * N + j] = swapped ? a : b;
      drawn.push(pointInPolygon(px, py, oxs, oys));
    }
  const ctx: GateContext = { raw: (ch) => (ch === g.x ? rx : ry), display: (ch, d) => makeScale(d).fwdArray(ch === g.x ? rx : ry), scaleOf: (ch) => ws.scales[ch], population: () => new Uint32Array(0), eventCount: N * N };
  const inside = new Uint8Array(N * N);
  applyGate(pop.gate, allIndices(N * N), ctx).forEach((e) => (inside[e] = 1));
  let bad = 0;
  for (let k = 0; k < N * N; k++) if (!!inside[k] !== drawn[k]) bad++;
  return bad / (N * N);
}

const round = (g: unknown) => JSON.stringify(g, (_k, v) => (typeof v === 'number' ? Number(v.toPrecision(6)) : v));

describe('drawn outline matches evaluation', () => {
  const { engine, ws } = setup();
  const X = makeScale(ws.scales['PC7-A']);
  const Y = makeScale(ws.scales['PE-A']);
  const poly: GateGeom = { type: 'polygon', x: 'PC7-A', y: 'PE-A', points: [[X.inv(0.2), Y.inv(0.2)], [X.inv(0.9), Y.inv(0.25)], [X.inv(0.5), Y.inv(0.9)]] };
  const ell: GateGeom = { type: 'ellipse', x: 'PC7-A', y: 'PE-A', center: [X.inv(0.5), Y.inv(0.5)], a: [X.inv(0.7), Y.inv(0.55)], b: [X.inv(0.45), Y.inv(0.7)] };
  const lin: ScaleDef = { type: 'linear', min: 0, max: 1 };
  const imported: GateGeom = { type: 'polygon', x: 'PC7-A', y: 'PE-A', points: [[100, 100], [60000, 300], [30000, 50000]], scales: { x: lin, y: lin }, strict: true };
  const cfgs: [string, Partial<PlotItem['options']>, boolean][] = [
    ['plain', {}, false],
    ['swapped', {}, true],
    ['zoom', { xWin: [0.45, 0.6], yWin: [0.4, 0.55] }, false],
    ['zoom swapped', { xWin: [0.3, 0.6], yWin: [0.35, 0.65] }, true],
    ['override', { xScale: { type: 'linear', min: -2000, max: 100000 }, yScale: { type: 'logicle', T: 262144, W: 0.2, M: 4.5, A: 0 } }, false],
  ];
  for (const [name, opts, sw] of cfgs)
    for (const [gname, gate] of [['polygon', poly], ['ellipse', ell], ['imported', imported]] as const)
      it(`${gname} on ${name} plot`, () => {
        const pop = setPop(ws, gate);
        const item = sw ? plot('PE-A', 'PC7-A', opts) : plot('PC7-A', 'PE-A', opts);
        expect(mismatch(ws, render(engine, ws, item), item, pop)).toBeLessThan(0.008);
      });
});

describe('editing in evaluation space', () => {
  const { engine, ws } = setup();
  const X = makeScale(ws.scales['PC7-A']);
  const Y = makeScale(ws.scales['PE-A']);
  const lin: ScaleDef = { type: 'linear', min: 0, max: 1 };
  const gates: GateGeom[] = [
    { type: 'polygon', x: 'PC7-A', y: 'PE-A', points: [[X.inv(0.3), Y.inv(0.3)], [X.inv(0.6), Y.inv(0.35)], [X.inv(0.5), Y.inv(0.6)]] },
    { type: 'rect', x: 'PC7-A', y: 'PE-A', xmin: X.inv(0.3), xmax: X.inv(0.55), ymin: Y.inv(0.35), ymax: Y.inv(0.65) },
    { type: 'ellipse', x: 'PC7-A', y: 'PE-A', center: [X.inv(0.45), Y.inv(0.5)], a: [X.inv(0.52), Y.inv(0.52)], b: [X.inv(0.44), Y.inv(0.58)] },
    { type: 'ellipse', x: 'PC7-A', y: 'PE-A', center: [20000, 20000], a: [30000, 21000], b: [19000, 26000], scales: { x: lin, y: lin }, strict: true },
    { type: 'quadrant', x: 'PC7-A', y: 'PE-A', cx: X.inv(0.4), cy: Y.inv(0.55), quadrant: 'UR', groupId: 'q' },
  ];
  const cfgs: [string, Partial<PlotItem['options']>, boolean][] = [
    ['plain', {}, false],
    ['swapped', {}, true],
    ['zoom', { xWin: [0.25, 0.7], yWin: [0.25, 0.7] }, false],
    ['zoom swapped', { xWin: [0.25, 0.7], yWin: [0.3, 0.75] }, true],
    ['override', { xScale: { type: 'logicle', T: 262144, W: 1, M: 4.5, A: 0 } }, false],
  ];
  for (const [name, opts, sw] of cfgs)
    it(`no-op handle drags and translations keep the gate (${name})`, () => {
      for (const g of gates) {
        setPop(ws, g);
        const item = sw ? plot('PE-A', 'PC7-A', opts) : plot('PC7-A', 'PE-A', opts);
        const geom = render(engine, ws, item);
        const sh = geom.gates[0];
        const ev = g.type === 'polygon' || g.type === 'ellipse' ? { x: g.scales?.x ?? ws.scales[g.x], y: g.scales?.y ?? ws.scales[g.y] } : null;
        for (const h of sh.handles) {
          const [u, v] = geom.toDisplay(h.x, h.y);
          // handles exactly on the window edge snap to the edge by design
          if (u < 1e-9 || u > 1 - 1e-9 || v < 1e-9 || v > 1 - 1e-9) continue;
          const ng = editHandle(g, h.id, u, v, { xScale: geom.xScale, yScale: geom.yScale }, sh.swapped, { u: 0, v: 0 }, ev);
          expect(round(ng), `${g.type} ${h.id}`).toBe(round(g));
        }
        const t = translateGate(g, { xScale: geom.xScale, yScale: geom.yScale }, [0.4, 0.4], [0.4, 0.4], sh.swapped, ev);
        expect(round(t)).toBe(round(g));
      }
    });

  it('moving an imported polygon keeps its scales, strictness and membership', () => {
    const g: GateGeom = { type: 'polygon', x: 'PC7-A', y: 'PE-A', points: [[-500, -500], [60000, -500], [-500, 30000]], scales: { x: lin, y: lin }, strict: true };
    setPop(ws, g);
    const n0 = engine.count(ws, 's1', 'g');
    const ax = { xScale: ws.scales['PC7-A'], yScale: ws.scales['PE-A'] };
    const g2 = translateGate(g, ax, [0.5, 0.5], [0.5 + 1e-6, 0.5], false, { x: lin, y: lin });
    expect(g2).toMatchObject({ scales: { x: lin, y: lin }, strict: true });
    setPop(ws, g2);
    expect(Math.abs(engine.count(ws, 's1', 'g') - n0)).toBeLessThanOrEqual(2);
  });

  it('ellipse a2 / b2 handles on a swapped plot mirror through the center', () => {
    const g = gates[2] as Extract<GateGeom, { type: 'ellipse' }>;
    setPop(ws, g);
    const geom = render(engine, ws, plot('PE-A', 'PC7-A'));
    const sh = geom.gates[0];
    expect(sh.swapped).toBe(true);
    const a2 = sh.handles.find((h) => h.id === 'a2')!;
    const [u, v] = geom.toDisplay(a2.x - 10, a2.y + 4);
    const ng = editHandle(g, 'a2', u, v, { xScale: geom.xScale, yScale: geom.yScale }, true, { u: 0, v: 0 }, { x: ws.scales['PC7-A'], y: ws.scales['PE-A'] }) as typeof g;
    expect(ng.center).toEqual(g.center);
    // plot x = PE-A (gate y), plot y = PC7-A (gate x); the pointer is the mirror image of the new a through the center
    const pointer = [X.fwd(makeScale(geom.yScale!).inv(v)), Y.fwd(makeScale(geom.xScale).inv(u))];
    const c = [X.fwd(g.center[0]), Y.fwd(g.center[1])];
    expect(X.fwd(ng.a[0])).toBeCloseTo(2 * c[0] - pointer[0], 6);
    expect(Y.fwd(ng.a[1])).toBeCloseTo(2 * c[1] - pointer[1], 6);
  });
});

describe('edge snapping', () => {
  it('a polygon drawn to the top edge of a plot with a narrower axis includes the events shown there', () => {
    const { engine, ws } = setup();
    const wsY = ws.scales['SSC-A'] as { max: number };
    const yOv: ScaleDef = { type: 'linear', min: 0, max: wsY.max / 4 };
    const ax = { xScale: ws.scales['FSC-A'], yScale: yOv };
    const ev = { x: ws.scales['FSC-A'], y: ws.scales['SSC-A'] };
    const pts = [[0.0, 0.5], [1, 0.5], [1, 1], [0.0, 1]].map(([u, v]) => toRaw(ax, u, v, { u: 0.01, v: 0.01 }, ev));
    setPop(ws, { type: 'polygon', x: 'FSC-A', y: 'SSC-A', points: pts as [number, number][] });
    const ys = engine.raw(ws, 's1', 'SSC-A')!;
    const sc = makeScale(yOv);
    let shown = 0;
    for (let i = 0; i < ys.length; i++) if (Math.min(0.99999, Math.max(0, sc.fwd(ys[i]))) >= 0.5) shown++;
    expect(engine.count(ws, 's1', 'g')).toBe(shown);
  });
});

describe('strict flag', () => {
  it('legacy gates with scales stay strict, app gates clamp', () => {
    const lin: ScaleDef = { type: 'linear', min: 0, max: 1 };
    expect(isStrictGate({ type: 'polygon', x: 'a', y: 'b', points: [], scales: { x: lin } })).toBe(true);
    expect(isStrictGate({ type: 'polygon', x: 'a', y: 'b', points: [], scales: { x: lin }, strict: false })).toBe(false);
    expect(isStrictGate({ type: 'ellipse', x: 'a', y: 'b', center: [0, 0], a: [1, 0], b: [0, 1] })).toBe(false);
  });
  it('Gating-ML import marks gates strict and export keeps them unclamped', () => {
    const { ws } = setup();
    const X = makeScale(ws.scales['PC7-A']);
    const Y = makeScale(ws.scales['PE-A']);
    ws.populations = [{ id: 'g', name: 'G', parentId: null, color: '#f00', gate: { type: 'polygon', x: 'PC7-A', y: 'PE-A', points: [[X.inv(-0.004), Y.inv(-0.004)], [X.inv(0.5), Y.inv(-0.004)], [X.inv(0.3), Y.inv(0.5)]] } }];
    const appXml = exportGatingMLDoc(ws).xml;
    const imp = importGatingML(appXml);
    const g = imp.populations[0].gate as Extract<GateGeom, { type: 'polygon' }>;
    expect(g.strict).toBe(true);
    expect(g.points.length).toBeGreaterThan(3); // the app gate was exported with its clamped region
    ws.populations = [{ id: 'g', name: 'G', parentId: null, color: '#f00', gate: g }];
    const again = importGatingML(exportGatingMLDoc(ws).xml).populations[0].gate as typeof g;
    expect(again.points.length).toBe(g.points.length);
  });
});

describe('boolean gates with missing operands', () => {
  const ctx = (exists: (id: string) => boolean): GateContext => ({
    raw: () => null,
    display: () => null,
    scaleOf: () => ({ type: 'linear', min: 0, max: 1 }),
    population: (id) => (id === 'A' ? new Uint32Array([1, 2, 3]) : id === 'B' ? new Uint32Array([2, 3, 4]) : new Uint32Array(0)),
    exists,
    eventCount: 6,
  });
  const parent = allIndices(6);
  const has = (id: string) => id === 'A' || id === 'B';
  it('NOT / AND become empty, OR ignores the missing operand', () => {
    expect([...applyGate({ type: 'bool', op: 'not', operands: [] }, parent, ctx(has))]).toEqual([]);
    expect([...applyGate({ type: 'bool', op: 'not', operands: ['X'] }, parent, ctx(has))]).toEqual([]);
    expect([...applyGate({ type: 'bool', op: 'not', operands: ['A'] }, parent, ctx(has))]).toEqual([0, 4, 5]);
    expect([...applyGate({ type: 'bool', op: 'and', operands: ['A', 'X'] }, parent, ctx(has))]).toEqual([]);
    expect([...applyGate({ type: 'bool', op: 'and', operands: ['A', '!X'] }, parent, ctx(has))]).toEqual([]);
    expect([...applyGate({ type: 'bool', op: 'and', operands: ['A', 'B'] }, parent, ctx(has))]).toEqual([2, 3]);
    expect([...applyGate({ type: 'bool', op: 'or', operands: ['A', '!X'] }, parent, ctx(has))]).toEqual([1, 2, 3]);
  });
});

describe('plot geometry', () => {
  it('a zoomed plot does not offer handles of vertices outside the window', () => {
    const { engine, ws } = setup();
    const X = makeScale(ws.scales['PC7-A']);
    const Y = makeScale(ws.scales['PE-A']);
    setPop(ws, { type: 'polygon', x: 'PC7-A', y: 'PE-A', points: [[X.inv(0.1), Y.inv(0.1)], [X.inv(0.52), Y.inv(0.5)], [X.inv(0.9), Y.inv(0.2)]] });
    const item = plot('PC7-A', 'PE-A', { xWin: [0.45, 0.6], yWin: [0.4, 0.55] });
    const geom = render(engine, ws, item, 'g');
    const sh = geom.gates[0];
    const v0 = sh.handles.find((h) => h.id === 'v0')!;
    expect(v0.x).toBeLessThan(geom.frame.x - 100); // not squeezed onto the frame edge
    const edge = geom.toPx(0, 0);
    const hit = hitTest(geom, edge[0] + 1, edge[1] - 1, 'g');
    expect(hit?.part).not.toBe('handle');
    const v1 = sh.handles.find((h) => h.id === 'v1')!;
    expect(hitTest(geom, v1.x + 1, v1.y, 'g')).toMatchObject({ part: 'handle', handle: 'v1' });
  });

  it('quadrant regions are not drag targets; the center and divider lines are', () => {
    const { engine, ws } = setup();
    const X = makeScale(ws.scales['PC7-A']);
    const Y = makeScale(ws.scales['PE-A']);
    ws.populations = (['UL', 'UR', 'LR', 'LL'] as const).map((q) => ({ id: q, name: q, parentId: null, color: '#000', gate: { type: 'quadrant', x: 'PC7-A', y: 'PE-A', cx: X.inv(0.5), cy: Y.inv(0.5), quadrant: q, groupId: 'grp' } }));
    const geom = render(engine, ws, plot('PC7-A', 'PE-A'));
    const [cx, cy] = geom.toPx(0.5, 0.5);
    expect(hitTest(geom, cx + 1, cy, null)).toMatchObject({ part: 'handle', handle: 'center' });
    expect(hitTest(geom, cx + 2, cy - 40, null)).toMatchObject({ part: 'handle', handle: 'vline', shape: { popId: 'UR' } });
    expect(hitTest(geom, cx - 40, cy + 2, null)).toMatchObject({ part: 'handle', handle: 'hline', shape: { popId: 'LL' } });
    expect(hitTest(geom, cx + 40, cy + 40, null)).toMatchObject({ part: 'body', shape: { popId: 'LR' } });
  });

  it('quadrant labels follow the label mode', () => {
    const { engine, ws } = setup();
    ws.populations = (['UL', 'UR', 'LR', 'LL'] as const).map((q) => ({ id: q, name: 'Q-' + q, parentId: null, color: '#000', gate: { type: 'quadrant', x: 'PC7-A', y: 'PE-A', cx: 1000, cy: 1000, quadrant: q, groupId: 'grp' } }));
    texts.length = 0;
    render(engine, ws, plot('PC7-A', 'PE-A', { gateLabel: 'name' }));
    expect(texts).toContain('Q-UR');
    expect(texts.some((t) => /^\d+\.\d+$/.test(t))).toBe(false); // no percentages
    texts.length = 0;
    render(engine, ws, plot('PC7-A', 'PE-A', { gateLabel: 'name+count' }));
    expect(texts.some((t) => /^\d{1,3}(,\d{3})*$/.test(t))).toBe(true);
  });

  it('label offsets are relative to the gate and follow it', () => {
    const { engine, ws } = setup();
    const X = makeScale(ws.scales['PC7-A']);
    const Y = makeScale(ws.scales['PE-A']);
    const g: GateGeom = { type: 'rect', x: 'PC7-A', y: 'PE-A', xmin: X.inv(0.3), xmax: X.inv(0.5), ymin: Y.inv(0.3), ymax: Y.inv(0.5) };
    setPop(ws, g);
    const item = plot('PC7-A', 'PE-A', { labelOff: { g: [0.1, 0.2] } });
    const a = render(engine, ws, item).gates[0].label!;
    expect(a.x - a.bx).toBeCloseTo(0.1 * render(engine, ws, item).frame.w, 5);
    setPop(ws, { ...g, xmin: X.inv(0.35), xmax: X.inv(0.55) });
    const geom = render(engine, ws, item);
    const b = geom.gates[0].label!;
    expect(b.x - a.x).toBeCloseTo(0.05 * geom.frame.w, 3);
  });

  it('new gates attach to the first visible layer', () => {
    const item = plot('a', 'b');
    item.layers = [{ id: '1', sample: 's1', population: 'root', visible: false }, { id: '2', sample: 's1', population: 'P' }];
    expect(parentOf(item)).toBe('P');
  });
});
