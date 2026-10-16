// Auto gate: density segmentation on synthetic Gaussian mixtures (display space), exact counting, 1D ranges.
import {
  alphaFromTightness,
  warmUpAutoGate,
  autoGate1D,
  autoGate2D,
  countPolygonDirect,
  DensityMap1D,
  DensityMap2D,
  EventGrid,
  SENSITIVITY,
  tightnessFromAlpha,
} from '../src/core/autogate';
import { engine } from '../src/core/engine';
import { pointInPolygon } from '../src/core/gating';
import type { PlotItem } from '../src/core/model';
import { loadDemo } from '../src/state/demo';
import { useStore } from '../src/state/store';
import { autoGateAt, autoSession, createPolygon, createRange, type PlotAxes } from '../src/ui/gateOps';

function rng(seed: number) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let u = 0;
    while (u === 0) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  return { r, gauss };
}

interface Cluster {
  n: number;
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  rho?: number;
}

/** events of a Gaussian mixture in display units (not clamped: off-scale values stay < 0 / > 1 like real data) */
function mixture(clusters: Cluster[], seed = 1, background = 0) {
  const { r, gauss } = rng(seed);
  const N = clusters.reduce((a, c) => a + c.n, 0) + background;
  const dx = new Float32Array(N);
  const dy = new Float32Array(N);
  const label = new Int32Array(N);
  let e = 0;
  clusters.forEach((c, k) => {
    const rho = c.rho ?? 0;
    for (let i = 0; i < c.n; i++, e++) {
      const a = gauss();
      const b = rho * a + Math.sqrt(1 - rho * rho) * gauss();
      dx[e] = c.cx + c.sx * a;
      dy[e] = c.cy + c.sy * b;
      label[e] = k;
    }
  });
  for (let i = 0; i < background; i++, e++) {
    dx[e] = r();
    dy[e] = r();
    label[e] = -1;
  }
  const idx = new Uint32Array(N);
  for (let i = 0; i < N; i++) idx[i] = i;
  return { dx, dy, label, idx, N };
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** per-cluster events inside the polygon (events clamped onto the frame, as app-drawn gates evaluate them) */
function evaluate(poly: [number, number][], m: ReturnType<typeof mixture>, nClusters: number) {
  const px = new Float64Array(poly.map((p) => p[0]));
  const py = new Float64Array(poly.map((p) => p[1]));
  const inside = new Array(nClusters + 1).fill(0);
  const total = new Array(nClusters + 1).fill(0);
  for (let e = 0; e < m.N; e++) {
    const k = m.label[e] < 0 ? nClusters : m.label[e];
    total[k]++;
    if (pointInPolygon(clamp01(m.dx[e]), clamp01(m.dy[e]), px, py)) inside[k]++;
  }
  const gateN = inside.reduce((a, b) => a + b, 0);
  return { inside, total, recall: (k: number) => inside[k] / total[k], contamination: (k: number) => (gateN - inside[k]) / Math.max(1, gateN) };
}

const NORMAL = SENSITIVITY.normal;

describe('auto gate 2D', () => {
  const clusters: Cluster[] = [
    { n: 20000, cx: 0.3, cy: 0.3, sx: 0.05, sy: 0.04, rho: 0.4 },
    { n: 5000, cx: 0.72, cy: 0.35, sx: 0.035, sy: 0.05 },
    { n: 1200, cx: 0.55, cy: 0.78, sx: 0.03, sy: 0.03 },
  ];
  const m = mixture(clusters, 7, 600);
  const map = DensityMap2D.fromEvents(m.dx, m.dy, m.idx);

  it('click on each cluster selects it with > 95 % recall and low contamination', () => {
    clusters.forEach((c, k) => {
      const res = autoGate2D(map, { u: c.cx + 0.3 * c.sx, v: c.cy - 0.2 * c.sy }, NORMAL)!;
      expect(res).toBeTruthy();
      expect(res.polygon.length).toBeLessThanOrEqual(40);
      const ev = evaluate(res.polygon, m, clusters.length);
      expect(ev.recall(k)).toBeGreaterThan(0.95);
      expect(ev.contamination(k)).toBeLessThan(0.03);
      for (let o = 0; o < clusters.length; o++) if (o !== k) expect(ev.recall(o)).toBeLessThan(0.01);
    });
  });

  it('a click in the sparse tail still finds the population; empty space does not', () => {
    const res = autoGate2D(map, { u: 0.3 + 2.6 * 0.05, v: 0.3 }, NORMAL)!;
    expect(res).toBeTruthy();
    expect(evaluate(res.polygon, m, 3).recall(0)).toBeGreaterThan(0.95);
    const none = mixture([{ n: 3000, cx: 0.2, cy: 0.2, sx: 0.03, sy: 0.03 }], 3);
    const map2 = DensityMap2D.fromEvents(none.dx, none.dy, none.idx);
    expect(autoGate2D(map2, { u: 0.8, v: 0.8 }, NORMAL)).toBeNull();
  });

  it('drag: highest peak inside the rectangle, restricted to it', () => {
    const res = autoGate2D(map, { rect: [0.6, 0.2, 0.85, 0.5] }, NORMAL)!;
    const ev = evaluate(res.polygon, m, 3);
    expect(ev.recall(1)).toBeGreaterThan(0.95);
    expect(ev.contamination(1)).toBeLessThan(0.03);
    for (const [u, v] of res.polygon) {
      expect(u).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(u).toBeLessThanOrEqual(0.85 + 1e-9);
    }
    // a rectangle spanning two clusters takes the denser one only
    const both = autoGate2D(map, { rect: [0.15, 0.1, 0.9, 0.55] }, NORMAL)!;
    const e2 = evaluate(both.polygon, m, 3);
    expect(e2.recall(0)).toBeGreaterThan(0.95);
    expect(e2.recall(1)).toBeLessThan(0.01);
  });

  it('tightness: tighter thresholds give nested, smaller gates', () => {
    const counts = [SENSITIVITY.tight, SENSITIVITY.normal, SENSITIVITY.loose].map((a) => evaluate(autoGate2D(map, { u: 0.3, v: 0.3 }, a)!.polygon, m, 3).inside[0]);
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThanOrEqual(counts[2]);
    expect(counts[0] / 20000).toBeGreaterThan(0.75);
    expect(alphaFromTightness(tightnessFromAlpha(0.05))).toBeCloseTo(0.05, 6);
  });

  it('a cluster touching the axis edge includes the off-scale events piled on the edge', () => {
    const cl: Cluster[] = [
      { n: 6000, cx: 0.02, cy: 0.5, sx: 0.04, sy: 0.05 },
      { n: 6000, cx: 0.6, cy: 0.5, sx: 0.05, sy: 0.05 },
      { n: 3000, cx: 0.5, cy: 0.985, sx: 0.04, sy: 0.02 },
    ];
    const mm = mixture(cl, 11);
    const mp = DensityMap2D.fromEvents(mm.dx, mm.dy, mm.idx);
    const res = autoGate2D(mp, { u: 0.03, v: 0.5 }, NORMAL)!;
    const ev = evaluate(res.polygon, mm, 3);
    expect(ev.recall(0)).toBeGreaterThan(0.95);
    expect(ev.contamination(0)).toBeLessThan(0.03);
    expect(Math.min(...res.polygon.map((p) => p[0]))).toBeLessThan(0);
    expect(res.region.beyond[0]).toBe(true);
    const top = autoGate2D(mp, { u: 0.5, v: 0.97 }, NORMAL)!;
    const et = evaluate(top.polygon, mm, 3);
    expect(et.recall(2)).toBeGreaterThan(0.95);
    expect(et.contamination(2)).toBeLessThan(0.03);
    expect(Math.max(...top.polygon.map((p) => p[1]))).toBeGreaterThan(1);
  });

  it('a population with a shoulder is one gate; well separated clusters never share one', () => {
    const cl: Cluster[] = [
      { n: 9000, cx: 0.4, cy: 0.4, sx: 0.05, sy: 0.05 },
      { n: 2500, cx: 0.49, cy: 0.45, sx: 0.035, sy: 0.035 },
      { n: 4000, cx: 0.78, cy: 0.75, sx: 0.04, sy: 0.04 },
      { n: 800, cx: 0.15, cy: 0.8, sx: 0.025, sy: 0.025 },
    ];
    const mm = mixture(cl, 5);
    const mp = DensityMap2D.fromEvents(mm.dx, mm.dy, mm.idx);
    for (const at of [
      { u: 0.4, v: 0.4 },
      { u: 0.5, v: 0.46 },
    ]) {
      const ev = evaluate(autoGate2D(mp, at, NORMAL)!.polygon, mm, 4);
      expect((ev.inside[0] + ev.inside[1]) / (ev.total[0] + ev.total[1])).toBeGreaterThan(0.95);
      expect(ev.recall(2)).toBeLessThan(0.01);
      expect(ev.recall(3)).toBeLessThan(0.01);
    }
    for (const k of [2, 3]) {
      const ev = evaluate(autoGate2D(mp, { u: cl[k].cx, v: cl[k].cy }, NORMAL)!.polygon, mm, 4);
      expect(ev.recall(k)).toBeGreaterThan(0.95);
      expect(ev.contamination(k)).toBeLessThan(0.02);
    }
  });

  it('bimodal: two separated populations are split at the valley', () => {
    const cl: Cluster[] = [
      { n: 8000, cx: 0.35, cy: 0.5, sx: 0.05, sy: 0.06 },
      { n: 3000, cx: 0.65, cy: 0.5, sx: 0.05, sy: 0.06 },
    ];
    const mm = mixture(cl, 9);
    const mp = DensityMap2D.fromEvents(mm.dx, mm.dy, mm.idx);
    const a = evaluate(autoGate2D(mp, { u: 0.35, v: 0.5 }, NORMAL)!.polygon, mm, 2);
    const b = evaluate(autoGate2D(mp, { u: 0.66, v: 0.5 }, NORMAL)!.polygon, mm, 2);
    expect(a.recall(0)).toBeGreaterThan(0.95);
    expect(b.recall(1)).toBeGreaterThan(0.95);
    expect(a.recall(1)).toBeLessThan(0.03);
    expect(b.recall(0)).toBeLessThan(0.03);
  });

  it('few events and zoom windows', () => {
    const few = mixture([{ n: 60, cx: 0.5, cy: 0.5, sx: 0.03, sy: 0.03 }], 4);
    const res = autoGate2D(DensityMap2D.fromEvents(few.dx, few.dy, few.idx), { u: 0.5, v: 0.5 }, NORMAL)!;
    expect(evaluate(res.polygon, few, 1).recall(0)).toBeGreaterThan(0.9);
    // zoom window axes: events outside are dropped, not piled on the edge
    const mm = mixture([{ n: 5000, cx: 0.5, cy: 0.5, sx: 0.05, sy: 0.05 }, { n: 5000, cx: -0.4, cy: 0.5, sx: 0.05, sy: 0.05 }], 6);
    const mp = DensityMap2D.fromEvents(mm.dx, mm.dy, mm.idx, { dropX: true });
    expect(mp.total).toBeLessThan(5100);
    expect(autoGate2D(mp, { u: 0.02, v: 0.5 }, NORMAL)).toBeNull();
  });
});

describe('auto gate exact counts', () => {
  it('EventGrid.count equals the direct polygon test, incl. edges beyond the frame', () => {
    const mm = mixture(
      [
        { n: 30000, cx: 0.3, cy: 0.3, sx: 0.1, sy: 0.1 },
        { n: 5000, cx: 0.02, cy: 0.9, sx: 0.05, sy: 0.05 },
      ],
      13,
      2000,
    );
    const grid = new EventGrid(mm.dx, mm.dy, mm.idx, 256);
    const { r } = rng(99);
    for (let t = 0; t < 40; t++) {
      const n = 3 + Math.floor(r() * 30);
      const cx = r(),
        cy = r(),
        R = 0.05 + r() * 0.5;
      const px = new Float64Array(n);
      const py = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * Math.PI;
        const rr = R * (0.4 + r());
        px[k] = cx + rr * Math.cos(a);
        py[k] = cy + rr * Math.sin(a);
      }
      // exact cell borders and vertices beyond the edges
      if (t % 5 === 0) for (let k = 0; k < n; k++) px[k] = Math.round(px[k] * 256) / 256;
      if (t % 7 === 0) px[0] = -0.004;
      expect(grid.count(px, py)).toBe(countPolygonDirect(mm.dx, mm.dy, mm.idx, px, py));
    }
  });
});

describe('auto gate 1D', () => {
  function mix1(parts: { n: number; c: number; s: number }[], seed = 3) {
    const { gauss } = rng(seed);
    const N = parts.reduce((a, p) => a + p.n, 0);
    const d = new Float32Array(N);
    const label = new Int32Array(N);
    let e = 0;
    parts.forEach((p, k) => {
      for (let i = 0; i < p.n; i++, e++) {
        d[e] = p.c + p.s * gauss();
        label[e] = k;
      }
    });
    const idx = new Uint32Array(N);
    for (let i = 0; i < N; i++) idx[i] = i;
    return { d, label, idx };
  }
  const recall = (m: ReturnType<typeof mix1>, k: number, lo: number, hi: number, open: [boolean, boolean]) => {
    let a = 0,
      t = 0,
      other = 0;
    for (let e = 0; e < m.d.length; e++) {
      const inR = (open[0] || m.d[e] >= lo) && (open[1] || m.d[e] < hi);
      if (m.label[e] === k) {
        t++;
        if (inR) a++;
      } else if (inR) other++;
    }
    return { recall: a / t, other };
  };

  it('peaks are split at the valley; an edge peak gets an open bound', () => {
    const m = mix1([
      { n: 6000, c: 0.3, s: 0.04 },
      { n: 3000, c: 0.62, s: 0.05 },
      { n: 2000, c: 0.98, s: 0.03 },
    ]);
    const map = DensityMap1D.fromEvents(m.d, m.idx);
    const a = autoGate1D(map, { u: 0.31 }, NORMAL)!;
    const ra = recall(m, 0, a.lo, a.hi, [a.lo < 0, a.hi > 1]);
    expect(ra.recall).toBeGreaterThan(0.95);
    expect(ra.other).toBeLessThan(60);
    const b = autoGate1D(map, { range: [0.5, 0.75] }, NORMAL)!;
    const rb = recall(m, 1, b.lo, b.hi, [b.lo < 0, b.hi > 1]);
    expect(rb.recall).toBeGreaterThan(0.95);
    const c = autoGate1D(map, { u: 0.97 }, NORMAL)!;
    expect(c.hi).toBeGreaterThan(1);
    expect(recall(m, 2, c.lo, c.hi, [false, true]).recall).toBeGreaterThan(0.95);
    expect(autoGate1D(map, { u: 0.05 }, NORMAL)).toBeNull();
  });
});

describe('auto gate performance', () => {
  it('1M events: density, segmentation, outline and exact count', () => {
    const mm = mixture(
      [
        { n: 600000, cx: 0.35, cy: 0.4, sx: 0.06, sy: 0.05, rho: 0.3 },
        { n: 300000, cx: 0.7, cy: 0.65, sx: 0.05, sy: 0.07 },
        { n: 100000, cx: 0.2, cy: 0.85, sx: 0.04, sy: 0.04 },
      ],
      21,
    );
    warmUpAutoGate();
    const best = { session: Infinity, gate: Infinity, step: Infinity };
    let n = 0;
    for (let rep = 0; rep < 4; rep++) {
      const t0 = performance.now();
      const H = new Float32Array(320 * 320);
      const grid = new EventGrid(mm.dx, mm.dy, mm.idx, 256, { M: 32, H });
      const map = new DensityMap2D(H, 256, 32);
      const t1 = performance.now();
      const res = autoGate2D(map, { u: 0.7, v: 0.65 }, NORMAL)!;
      n = grid.count(new Float64Array(res.polygon.map((p) => p[0])), new Float64Array(res.polygon.map((p) => p[1])));
      const t2 = performance.now();
      // slider: threshold, outline and count again
      const reg = map.region(res.located, SENSITIVITY.loose)!;
      const poly = map.outline(reg, res.located);
      grid.count(new Float64Array(poly.map((p) => p[0])), new Float64Array(poly.map((p) => p[1])));
      const t3 = performance.now();
      best.session = Math.min(best.session, t1 - t0);
      best.gate = Math.min(best.gate, t2 - t1);
      best.step = Math.min(best.step, t3 - t2);
    }
    console.log(`autogate 1M (best of 4): binning + density + segmentation ${best.session.toFixed(1)} ms, gate + exact count ${best.gate.toFixed(1)} ms, slider step ${best.step.toFixed(1)} ms`);
    expect(n / 300000).toBeGreaterThan(0.95);
    // generous bound: shared CI machines are noisy
    expect(best.session + best.gate).toBeLessThan(250);
  });
});

describe('auto gate on the demo workspace (store, engine, gate creation)', () => {
  loadDemo();
  const st = () => useStore.getState();
  const pop = (name: string) => st().ws.populations.find((p) => p.name === name)!;
  const plot = (x: string, y?: string) => st().ws.worksheets[0].items.find((i) => i.kind === 'plot' && i.xParam === x && (!y || i.yParam === y)) as PlotItem;
  const sid = () => st().ui.activeSampleId!;
  const axesOf = (it: PlotItem): PlotAxes => ({ xScale: engine.scaleOf(st().ws, it.xParam), yScale: it.plotType === 'histogram' ? null : engine.scaleOf(st().ws, it.yParam) });
  /** median display position of a population on a plot */
  const center = (it: PlotItem, popId: string): [number, number] => {
    const ws = st().ws;
    const idx = engine.population(ws, sid(), popId);
    const med = (ch: string) => {
      const d = engine.display(ws, sid(), ch, engine.scaleOf(ws, ch))!;
      const v = Array.from(idx, (e) => d[e]).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    return [med(it.xParam), it.plotType === 'histogram' ? 0 : med(it.yParam)];
  };
  const overlap = (a: string, b: string) => {
    const A = engine.population(st().ws, sid(), a);
    const B = new Set(engine.population(st().ws, sid(), b));
    let n = 0;
    for (const e of A) if (B.has(e)) n++;
    return n;
  };

  it('CD4+ T cells: one population, close to the hand-made quadrant; popover count = gate count', () => {
    const it = plot('PC7-A', 'PE-A');
    const parent = it.layers[0].population;
    const ref = pop('CD4+ CD8-');
    const s = autoSession(st().ws, it, axesOf(it), sid(), parent)!;
    const [u, v] = center(it, ref.id);
    const res = autoGateAt(s, axesOf(it), { u, v }, NORMAL)!;
    expect(res.kind).toBe('2d');
    const created = createPolygon(it, res.kind === '2d' ? res.raw : [])!;
    const n = engine.count(st().ws, sid(), created.id);
    expect(n).toBe(res.count);
    const q = engine.count(st().ws, sid(), ref.id);
    const both = overlap(created.id, ref.id);
    console.log(`demo CD4+: auto ${n}, quadrant ${q}, auto inside quadrant ${both}`);
    expect(both / q).toBeGreaterThan(0.95); // recall vs the hand-made gate
    expect(both / n).toBeGreaterThan(0.99); // nothing from other quadrants
    expect(created.parentId).toBe(parent);
  });

  it('CD8+ by dragging a rectangle; lymphocytes on FSC / SSC', () => {
    const it = plot('PC7-A', 'PE-A');
    const ref = pop('CD4- CD8+');
    const s = autoSession(st().ws, it, axesOf(it), sid(), it.layers[0].population)!;
    const [u, v] = center(it, ref.id);
    const res = autoGateAt(s, axesOf(it), { rect: [Math.max(0, u - 0.3), v - 0.12, Math.min(1, u + 0.3), v + 0.12] }, NORMAL)!;
    const created = createPolygon(it, res.kind === '2d' ? res.raw : [])!;
    const n = engine.count(st().ws, sid(), created.id);
    const q = engine.count(st().ws, sid(), ref.id);
    const both = overlap(created.id, ref.id);
    console.log(`demo CD8+: auto ${n}, quadrant ${q}, auto inside quadrant ${both}`);
    expect(n).toBe(res.count);
    expect(both / q).toBeGreaterThan(0.95);
    expect(both / n).toBeGreaterThan(0.99);
    // FSC / SSC of all events: the lymphocyte cluster
    const fs = plot('FSC-A', 'SSC-A');
    const s2 = autoSession(st().ws, fs, axesOf(fs), sid(), 'root')!;
    const lym = pop('Lymphocytes');
    const [lu, lv] = center(fs, lym.id);
    const r2 = autoGateAt(s2, axesOf(fs), { u: lu, v: lv }, NORMAL)!;
    const g2 = createPolygon(fs, r2.kind === '2d' ? r2.raw : [])!;
    const n2 = engine.count(st().ws, sid(), g2.id);
    const ref2 = engine.count(st().ws, sid(), lym.id);
    const both2 = overlap(lym.id, g2.id);
    console.log(`demo lymphocytes on FSC/SSC: auto ${n2}, hand-made (CD45/SSC, after live/singlets) ${ref2}, hand-made inside auto ${both2}`);
    expect(n2).toBe(r2.count);
    expect(both2 / ref2).toBeGreaterThan(0.9);
  });

  it('histograms: live (viability-negative) and CD69+ ranges', () => {
    const kv = plot('KO525-A');
    const live = pop('Live');
    const s = autoSession(st().ws, kv, axesOf(kv), sid(), kv.layers[0].population)!;
    const [u] = center(kv, live.id);
    const r = autoGateAt(s, axesOf(kv), { u }, NORMAL)!;
    expect(r.kind).toBe('1d');
    if (r.kind !== '1d') return;
    expect(r.min).toBe(-Infinity); // the valley is at the axis end: open bound
    const g = createRange(kv, r.min, r.max, '-');
    expect(engine.count(st().ws, sid(), g.id)).toBe(r.count);
    const ref = engine.count(st().ws, sid(), live.id);
    console.log(`demo live: auto ${r.count} (max ${r.max.toFixed(0)}), hand-made ${ref} (max 6000)`);
    expect(overlap(g.id, live.id) / ref).toBeGreaterThan(0.97);
    const ch = st().ws.worksheets[0].items.filter((i) => i.kind === 'plot' && i.xParam === 'APC-A')[1] as PlotItem;
    const cd69 = pop('CD69+');
    const s2 = autoSession(st().ws, ch, axesOf(ch), sid(), ch.layers[0].population)!;
    const r2 = autoGateAt(s2, axesOf(ch), { range: [0.62, 0.95] }, NORMAL)!;
    if (r2.kind !== '1d') throw new Error('1d expected');
    const g2 = createRange(ch, r2.min, r2.max);
    const ref2 = engine.count(st().ws, sid(), cd69.id);
    console.log(`demo CD69+: auto ${r2.count}, hand-made ${ref2}`);
    expect(engine.count(st().ws, sid(), g2.id)).toBe(r2.count);
    expect(overlap(g2.id, cd69.id) / ref2).toBeGreaterThan(0.97);
  });
});
