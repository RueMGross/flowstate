// From the AI's answer to an auto gate seed. The AI only points (a position, a box or a histogram range in plot-frame
// units); the deterministic auto gate (core/autogate.ts) draws the boundary from the event density, so the gate is
// data-driven and reproducible. Pure functions on the density maps, unit tested.
import { autoGate2D, DensityMap1D, DensityMap2D, SENSITIVITY } from '../core/autogate';
import type { AutoSeed } from '../ui/gateOps';

/** A density peak (basin of the auto gate segmentation) in frame units. */
export interface Peak {
  id: string;
  x: number;
  /** 2D only */
  y?: number;
  /** share of the plotted events in the basin */
  share: number;
  /** extent where the density is >= 5 % of the peak: [x0, y0, x1, y1] (2D) or [x0, x1] (1D) */
  box: number[];
}

const r2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;

export function peaks2D(map: DensityMap2D, max = 8): Peak[] {
  const { G, M, GE, S, comp, peak, peakCell, H } = map;
  const acc = new Map<number, { n: number; i0: number; j0: number; i1: number; j1: number }>();
  for (let c = 0; c < comp.length; c++) {
    const r = comp[c];
    if (r < 0) continue;
    let a = acc.get(r);
    if (!a) acc.set(r, (a = { n: 0, i0: GE, j0: GE, i1: -1, j1: -1 }));
    a.n += H[c];
    if (S[c] >= 0.05 * peak[r]) {
      const i = c % GE;
      const j = (c - i) / GE;
      if (i < a.i0) a.i0 = i;
      if (i > a.i1) a.i1 = i;
      if (j < a.j0) a.j0 = j;
      if (j > a.j1) a.j1 = j;
    }
  }
  const f = (i: number) => r2((i - M + 0.5) / G);
  return [...acc.entries()]
    .filter(([r, a]) => map.significant(peak[r]) && a.n >= 0.005 * map.total)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, max)
    .map(([r, a], k) => ({ id: `P${k + 1}`, x: f(peakCell[r] % GE), y: f(Math.floor(peakCell[r] / GE)), share: a.n / map.total, box: [f(a.i0), f(a.j0), f(a.i1), f(a.j1)] }));
}

export function peaks1D(map: DensityMap1D, max = 6): Peak[] {
  const { S, comp, peak, peakCell, H, B } = map;
  const acc = new Map<number, { n: number; i0: number; i1: number }>();
  for (let i = 0; i < B; i++) {
    const r = comp[i];
    if (r < 0) continue;
    let a = acc.get(r);
    if (!a) acc.set(r, (a = { n: 0, i0: B, i1: -1 }));
    a.n += H[i];
    if (S[i] >= 0.05 * peak[r]) {
      a.i0 = Math.min(a.i0, i);
      a.i1 = Math.max(a.i1, i);
    }
  }
  return [...acc.entries()]
    .filter(([r, a]) => map.significant(peak[r]) && a.n >= 0.005 * map.total)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, max)
    .map(([r, a], k) => ({ id: `P${k + 1}`, x: r2((peakCell[r] + 0.5) / B), share: a.n / map.total, box: [r2(a.i0 / B), r2((a.i1 + 1) / B)] }));
}

export function peaksText(peaks: Peak[]): string {
  const p = (v: number) => v.toFixed(2);
  return peaks
    .map((k) =>
      k.y === undefined
        ? `${k.id}: peak at x=${p(k.x)}, ${(100 * k.share).toFixed(1)}% of events, spans x ${p(k.box[0])} to ${p(k.box[1])}`
        : `${k.id}: peak at (${p(k.x)}, ${p(k.y)}), ${(100 * k.share).toFixed(1)}% of events, spans x ${p(k.box[0])} to ${p(k.box[2])}, y ${p(k.box[1])} to ${p(k.box[3])}`,
    )
    .join('\n');
}

/** What the model answers (fields checked, nothing trusted). */
export interface AiGateAnswer {
  found?: boolean;
  name?: string;
  x?: number;
  y?: number;
  bbox?: number[];
  range?: number[];
  peak?: string | null;
  confidence?: number;
  rationale?: string;
}

export type SeedChoice = { seed: AutoSeed; snapped: boolean; note: string; frame: number[] } | { seed: null; note: string };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : null);

function box(v: unknown, n: 2 | 4): number[] | null {
  if (!Array.isArray(v) || v.length !== n) return null;
  const b = v.map(num);
  if (b.some((x) => x === null)) return null;
  const s = b as number[];
  return n === 2 ? [Math.min(s[0], s[1]), Math.max(s[0], s[1])] : [Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3])];
}

/** search radius (frame units) for snapping a point off the data onto the nearest density peak */
export const SNAP_RADIUS = 0.1;

/**
 * Seed for a 2D plot. The point must lie on data (in a significant basin, above 2 % of its peak density); else it snaps
 * to the nearest significant peak within SNAP_RADIUS. A box picks the peak inside it nearest the point. When the basin
 * found is much larger than the box (the population merges with a neighbour), the box itself becomes the seed.
 */
export function chooseSeed2D(map: DensityMap2D, a: AiGateAnswer, peaks: Peak[] = peaks2D(map, 50)): SeedChoice {
  if (a.found === false) return { seed: null, note: 'The AI did not find this population on the plot.' };
  const bb = box(a.bbox, 4);
  const pk = typeof a.peak === 'string' ? peaks.find((p) => p.id.toLowerCase() === a.peak!.toLowerCase()) : undefined;
  // a named peak is exact (reading a position off the image is not); else the point; else the box center
  let x = pk ? pk.x : num(a.x);
  let y = pk ? pk.y! : num(a.y);
  if ((x === null || y === null) && bb) [x, y] = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
  if (x === null || y === null) return { seed: null, note: 'The answer had no usable position.' };
  const { G, M, GE, S, comp, peak } = map;
  const cell = (u: number, v: number) => (Math.min(G - 1, Math.max(0, Math.floor(v * G))) + M) * GE + Math.min(G - 1, Math.max(0, Math.floor(u * G))) + M;
  const c0 = cell(x, y);
  const onData = comp[c0] >= 0 && map.significant(peak[comp[c0]]) && S[c0] >= 0.02 * peak[comp[c0]];
  const dist = (p: Peak) => Math.hypot(p.x - x!, p.y! - y!);
  let snapped = false;
  let note = '';
  const inBox = bb ? peaks.filter((p) => p.x >= bb[0] - 0.03 && p.x <= bb[2] + 0.03 && p.y! >= bb[1] - 0.03 && p.y! <= bb[3] + 0.03).sort((p, q) => dist(p) - dist(q)) : [];
  const rootAt = (p: Peak) => comp[cell(p.x, p.y!)];
  if (!pk && inBox.length && (!onData || !inBox.some((p) => rootAt(p) === comp[c0]))) {
    [x, y] = [inBox[0].x, inBox[0].y!];
    snapped = true;
    note = 'Moved onto the density peak inside the box the AI gave.';
  } else if (!onData) {
    // the nearest population within SNAP_RADIUS (its edge, not only its peak), then that population's peak
    const R = Math.round(SNAP_RADIUS * G);
    const ci = (c0 % GE) - M;
    const cj = Math.floor(c0 / GE) - M;
    let best = -1;
    let bd = Infinity;
    for (let j = Math.max(0, cj - R); j <= Math.min(G - 1, cj + R); j++)
      for (let i = Math.max(0, ci - R); i <= Math.min(G - 1, ci + R); i++) {
        const c = (j + M) * GE + i + M;
        const r = comp[c];
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (r >= 0 && d < bd && d <= R * R && map.significant(peak[r]) && S[c] >= 0.05 * peak[r]) (bd = d), (best = r);
      }
    if (best < 0) return { seed: null, note: `There are no events near the point the AI chose (${x.toFixed(2)}, ${y.toFixed(2)}); nothing was gated.` };
    const pc = map.peakCell[best];
    [x, y] = [Math.min(1, Math.max(0, ((pc % GE) - M + 0.5) / G)), Math.min(1, Math.max(0, (Math.floor(pc / GE) - M + 0.5) / G))];
    snapped = true;
    note = 'The point was off the data; moved to the peak of the nearest population.';
  }
  const seed: AutoSeed = { u: x, v: y };
  if (bb) {
    const r = autoGate2D(map, seed, SENSITIVITY.normal);
    const bw = Math.max(bb[2] - bb[0], 0.02);
    const bh = Math.max(bb[3] - bb[1], 0.02);
    if (r) {
      const rw = (r.region.x1 - r.region.x0 + 1) / G;
      const rh = (r.region.y1 - r.region.y0 + 1) / G;
      if (rw * rh > 3 * bw * bh && (rw > 1.6 * bw || rh > 1.6 * bh)) {
        const pad = (lo: number, hi: number) => [Math.max(0, lo - 0.15 * (hi - lo)), Math.min(1, hi + 0.15 * (hi - lo))];
        const [x0, x1] = pad(bb[0], bb[2]);
        const [y0, y1] = pad(bb[1], bb[3]);
        return { seed: { rect: [x0, y0, x1, y1] }, snapped, frame: [x0, y0, x1, y1], note: `${note} The population merges with a neighbour here, so the gate is limited to the box the AI gave.`.trim() };
      }
    }
  }
  return { seed, snapped, frame: [x, y], note };
}

/** Seed for a histogram: a range (the auto gate takes the highest peak in it and runs to the valleys). */
export function chooseSeed1D(map: DensityMap1D, a: AiGateAnswer, peaks: Peak[] = peaks1D(map, 50)): SeedChoice {
  if (a.found === false) return { seed: null, note: 'The AI did not find this population on the plot.' };
  let rg = box(a.range, 2) ?? box(a.bbox, 2);
  const pk = typeof a.peak === 'string' ? peaks.find((p) => p.id.toLowerCase() === a.peak!.toLowerCase()) : undefined;
  if (!rg && pk) rg = pk.box;
  const x = num(a.x);
  if (!rg && x !== null) rg = [Math.max(0, x - 0.03), Math.min(1, x + 0.03)];
  if (!rg) return { seed: null, note: 'The answer had no usable range.' };
  if (map.locate({ range: [rg[0], rg[1]] })) return { seed: { range: [rg[0], rg[1]] }, snapped: false, frame: rg, note: '' };
  const mid = (rg[0] + rg[1]) / 2;
  const near = peaks.filter((p) => Math.abs(p.x - mid) <= SNAP_RADIUS + (rg![1] - rg![0]) / 2).sort((p, q) => Math.abs(p.x - mid) - Math.abs(q.x - mid))[0];
  if (!near) return { seed: null, note: `There is no population in the range ${rg[0].toFixed(2)} to ${rg[1].toFixed(2)} the AI chose; nothing was gated.` };
  return { seed: { u: near.x }, snapped: true, frame: [near.x], note: 'The range held no population; moved to the nearest peak.' };
}
