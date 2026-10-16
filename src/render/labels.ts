// Label layout: places gate / quadrant / range labels and legends so that they overlap neither each other nor the data
// and gate outlines they describe (as far as there is room).

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelCandidate {
  x: number; // top-left
  y: number;
  cost: number; // preference (0 = preferred anchor)
}

/** Another form of a label (smaller, on one line, shortened), tried at extra cost when the label has no clear place. */
export interface LabelForm {
  w: number;
  h: number;
  /** extra cost of the form (candidate cost units) */
  cost: number;
  /** candidate positions for this form (top-left) */
  cands: LabelCandidate[];
  nudge?: { dx: number; dy: number; n?: number };
}

export interface LabelRequest {
  id: string;
  w: number;
  h: number;
  /** user-placed (dragged) label: kept exactly where it is */
  fixed?: { x: number; y: number };
  cands: LabelCandidate[];
  /** region the label must stay in */
  bounds: Box;
  /** try small shifts around each candidate (step sizes in px); default: half the label height / width */
  nudge?: { dx: number; dy: number; n?: number };
  /**
   * Also scan `bounds` (or this region) for an empty place when the candidates near the gate are crowded; such places
   * cost `scanCost` plus their distance from the first candidate. The label then usually gets a leader line.
   */
  scan?: Box | boolean;
  scanCost?: number;
  /** other forms of the label (see LabelForm), in order of preference */
  forms?: LabelForm[];
  /** the gate the label belongs to: other gates' outlines and interiors are kept clear (hard), its own are not */
  owner?: string;
  /** extra cost of the label in its own form (w x h), e.g. when its text had to be shortened */
  cost?: number;
}

/** A gate outline (px): labels avoid sitting on it. */
export interface LabelLine {
  pts: ArrayLike<number>;
  closed: boolean;
  /** gate the outline belongs to: labels of other gates must not cross it (see LabelRequest.owner) */
  owner?: string;
}

/** Interior of a closed gate (px): labels of other gates must not sit in it. */
export interface LabelRegion {
  owner: string;
  pts: ArrayLike<number>;
}

/** Room outside the frame (a reserved margin) where labels may go at extra cost. */
export interface LabelZone {
  box: Box;
  /** base cost of a place there (plus its distance from the label's preferred anchor) */
  cost: number;
}

export interface LayoutOptions {
  /** data under a box, 0 (empty) .. 1 (dense) */
  density?: (b: Box) => number;
  /** outlines to keep labels off */
  lines?: LabelLine[];
  /** gate interiors to keep other gates' labels out of */
  regions?: LabelRegion[];
  /** weight of a box fully over dense data (in candidate cost units) */
  densityWeight?: number;
  /** cost of a label crossed by an outline (plus a share for the length crossed) */
  lineWeight?: number;
  /** places outside the frame */
  zones?: LabelZone[];
  /** the region where outlines and gate interiors are drawn (the frame): parts beyond it are not seen */
  clip?: Box;
}

/** Cost of a label on another gate's outline or in its interior: avoided whenever any other place exists. */
export const HARD_COST = 300;
/** Cost of a label overlapping another label or an obstacle. */
const OVERLAP_COST = 1000;

/** How a label was placed. */
export interface PlacedLabel {
  /** index into LabelRequest.forms, -1: the request's own size */
  form: number;
  score: number;
  /** on another label, an obstacle, or another gate's outline or interior (no clear place was found) */
  hard: boolean;
  /** data under the label (0..1, see LayoutOptions.density) */
  overData: number;
  /** an outline crosses the label or it sits in a gate's interior */
  overLines: boolean;
  /** placed in a zone outside the frame */
  outside: boolean;
}

export interface LayoutResult {
  boxes: Map<string, Box>;
  info: Map<string, PlacedLabel>;
  /** labels without a clear place */
  hard: number;
  /** sum of the scores of the labels placed (not fixed) */
  total: number;
}

export const overlapArea = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

function clampInto(x: number, y: number, w: number, h: number, b: Box): [number, number] {
  const cx = Math.min(Math.max(x, b.x), Math.max(b.x, b.x + b.w - w));
  const cy = Math.min(Math.max(y, b.y), Math.max(b.y, b.y + b.h - h));
  return [cx, cy];
}

/** Length of segment (x0,y0)-(x1,y1) inside box b (Liang-Barsky clipping). */
export function clippedLength(x0: number, y0: number, x1: number, y1: number, b: Box): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - b.x, b.x + b.w - x0, y0 - b.y, b.y + b.h - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return 0;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return 0;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return 0;
      if (r < t1) t1 = r;
    }
  }
  return t1 > t0 ? (t1 - t0) * Math.hypot(dx, dy) : 0;
}

interface PreparedLine {
  pts: ArrayLike<number>;
  n: number;
  closed: boolean;
  bb: Box;
  owner?: string;
}

function bboxOf(pts: ArrayLike<number>, n: number): Box {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[2 * i];
    const y = pts[2 * i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function prepare(lines: LabelLine[]): PreparedLine[] {
  const out: PreparedLine[] = [];
  for (const l of lines) {
    const n = l.pts.length >> 1;
    if (n < 2) continue;
    out.push({ pts: l.pts, n, closed: l.closed, bb: bboxOf(l.pts, n), owner: l.owner });
  }
  return out;
}

/** The overlap of two boxes, null when they do not overlap. */
function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

const disjoint = (a: Box, b: Box) => a.x > b.x + b.w || a.x + a.w < b.x || a.y > b.y + b.h || a.y + a.h < b.y;

/**
 * Length of the outlines inside box b and how many outlines cross it: of the label's own gate (or no gate) and of
 * others. `graze`: the own crossings weighted by their length (a crossing of 6 px or more counts fully).
 */
function lineHits(lines: PreparedLine[], b: Box, owner: string | undefined): { len: number; count: number; graze: number; otherLen: number; other: number } {
  let len = 0;
  let count = 0;
  let graze = 0;
  let otherLen = 0;
  let other = 0;
  for (const l of lines) {
    if (disjoint(l.bb, b)) continue;
    let ll = 0;
    const segs = l.closed ? l.n : l.n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % l.n;
      ll += clippedLength(l.pts[2 * i], l.pts[2 * i + 1], l.pts[2 * j], l.pts[2 * j + 1], b);
    }
    if (ll <= 0) continue;
    if (owner !== undefined && l.owner !== undefined && l.owner !== owner) {
      otherLen += ll;
      other++;
    } else {
      len += ll;
      count++;
      graze += Math.min(1, 0.25 + ll / 8);
    }
  }
  return { len, count, graze, otherLen, other };
}

interface PreparedRegion {
  owner: string;
  pts: ArrayLike<number>;
  bb: Box;
}

/** Share of box b (sampled on a 5 x 3 grid) inside the interiors of gates other than `owner`. */
function regionShare(regions: PreparedRegion[], b: Box, owner: string | undefined): number {
  if (owner === undefined || !regions.length) return 0;
  let k = 0;
  let n = 0;
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 3; j++) {
      const x = b.x + (b.w * (i + 0.5)) / 5;
      const y = b.y + (b.h * (j + 0.5)) / 3;
      n++;
      for (const r of regions) {
        if (r.owner === owner || x < r.bb.x || x > r.bb.x + r.bb.w || y < r.bb.y || y > r.bb.y + r.bb.h) continue;
        if (pointInPolygon(x, y, r.pts)) {
          k++;
          break;
        }
      }
    }
  return k / n;
}

/**
 * Greedy placement in request order (fixed labels first): each label takes the position and form of least cost among
 * its candidates (with small nudges), its other forms (smaller, one line, shortened: their own extra cost), places in
 * the zones outside the frame and, when asked, a scan of its region. Cost: the candidate's preference, data under the
 * label (`opts.density`), gate outlines through it (`opts.lines`), and, as near-hard constraints, overlap with labels
 * placed before it and with obstacles, and (for labels with an `owner`) other gates' outlines and interiors. When some
 * label finds no clear place, the layout is repeated with that label placed first (a crowded gate gets the room before
 * labels that have alternatives); the result with the fewest such labels wins. `penalty` adds a soft cost for a box.
 */
export function layoutLabelsDetailed(reqs: LabelRequest[], obstacles: Box[] = [], penalty?: (b: Box, id: string) => number, opts: LayoutOptions = {}): LayoutResult {
  const lines = prepare(opts.lines ?? []);
  const regions: PreparedRegion[] = (opts.regions ?? []).filter((r) => r.pts.length >= 6).map((r) => ({ owner: r.owner, pts: r.pts, bb: bboxOf(r.pts, r.pts.length >> 1) }));
  const free = reqs.filter((r) => !r.fixed);
  let best = runLayout(reqs, free, obstacles, penalty, opts, lines, regions);
  if (best.hard && free.length > 1) {
    const tried = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const next = free.find((r) => best.info.get(r.id)?.hard && !tried.has(r.id));
      if (!next) break;
      tried.add(next.id);
      const order = [next, ...free.filter((r) => r !== next)];
      const res = runLayout(reqs, order, obstacles, penalty, opts, lines, regions);
      if (res.hard < best.hard || (res.hard === best.hard && res.total < best.total - 1e-6)) best = res;
      if (!best.hard) break;
    }
  }
  return best;
}

/** Label boxes of a layout (see layoutLabelsDetailed). */
export function layoutLabels(reqs: LabelRequest[], obstacles: Box[] = [], penalty?: (b: Box, id: string) => number, opts: LayoutOptions = {}): Map<string, Box> {
  return layoutLabelsDetailed(reqs, obstacles, penalty, opts).boxes;
}

function runLayout(
  reqs: LabelRequest[],
  order: LabelRequest[],
  obstacles: Box[],
  penalty: ((b: Box, id: string) => number) | undefined,
  opts: LayoutOptions,
  lines: PreparedLine[],
  regions: PreparedRegion[],
): LayoutResult {
  const boxes = new Map<string, Box>();
  const info = new Map<string, PlacedLabel>();
  const placed: Box[] = [...obstacles];
  const pad = 1.5;
  const wD = opts.densityWeight ?? 8;
  const wL = opts.lineWeight ?? 4;
  const zones = opts.zones ?? [];
  let hardN = 0;
  let total = 0;
  /** costs of a box apart from the candidate's own cost: overlap, data, outlines, other gates */
  const assess = (r: LabelRequest, b: Box, limit: number, others: Box[]) => {
    const grown = { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
    let ov = 0;
    for (const p of others) ov += overlapArea(grown, p);
    let hard = ov > 0 ? OVERLAP_COST + (ov / Math.max(1, b.w * b.h)) * OVERLAP_COST : 0;
    let score = hard;
    if (score >= limit) return null;
    const d = opts.density ? opts.density(b) : 0;
    score += wD * d;
    if (score >= limit) return null;
    let overLines = false;
    // outlines and gate interiors count where they are drawn (inside the frame)
    const seen = opts.clip ? intersect(grown, opts.clip) : grown;
    if (lines.length && seen) {
      const hit = lineHits(lines, seen, r.owner);
      // an outline just grazing the label (its padding) costs less than one running through it
      if (hit.count) score += wL * hit.graze + (wL * hit.len) / Math.max(1, b.w + b.h);
      if (hit.other) {
        const h2 = HARD_COST * hit.other + (HARD_COST * hit.otherLen) / Math.max(1, b.w + b.h);
        hard += h2;
        score += h2;
      }
      overLines = hit.count + hit.other > 0;
    }
    if (score >= limit) return null;
    const sb = opts.clip ? intersect(b, opts.clip) : b;
    const share = sb ? (regionShare(regions, sb, r.owner) * sb.w * sb.h) / Math.max(1e-9, b.w * b.h) : 0;
    if (share > 0) {
      const h2 = HARD_COST * (0.5 + share);
      hard += h2;
      score += h2;
      overLines = true;
    }
    if (penalty) score += penalty(b, r.id);
    return { score, hard, overData: d, overLines };
  };
  for (const r of reqs) {
    if (!r.fixed) continue;
    const b = { x: r.fixed.x, y: r.fixed.y, w: r.w, h: r.h };
    boxes.set(r.id, b);
    const a = assess(r, b, Infinity, []);
    info.set(r.id, { form: -1, score: 0, hard: false, overData: a?.overData ?? 0, overLines: !!a?.overLines, outside: false });
    placed.push(b);
  }
  for (const r of order) {
    const forms: (LabelForm & { idx: number })[] = [{ w: r.w, h: r.h, cost: r.cost ?? 0, cands: r.cands, nudge: r.nudge, idx: -1 }, ...(r.forms ?? []).map((f, i) => ({ ...f, idx: i }))];
    let best: Box | null = null;
    let bestScore = Infinity;
    let bestInfo: PlacedLabel | null = null;
    for (const f of forms) {
      if (f.cost >= bestScore) continue;
      const res = placeForm(r, f, zones, (b, limit) => assess(r, b, limit, placed));
      if (res && res.score + f.cost < bestScore) {
        bestScore = res.score + f.cost;
        best = res.b;
        bestInfo = { form: f.idx, score: bestScore, hard: res.hard > 0, overData: res.overData, overLines: res.overLines, outside: res.outside };
      }
    }
    if (!best || !bestInfo) {
      const [x, y] = clampInto(r.cands[0]?.x ?? r.bounds.x, r.cands[0]?.y ?? r.bounds.y, r.w, r.h, r.bounds);
      best = { x, y, w: r.w, h: r.h };
      bestInfo = { form: -1, score: OVERLAP_COST, hard: true, overData: 0, overLines: false, outside: false };
    }
    boxes.set(r.id, best);
    info.set(r.id, bestInfo);
    if (bestInfo.hard) hardN++;
    total += bestInfo.score;
    placed.push(best);
  }
  return { boxes, info, hard: hardN, total };
}

/** Best place of one form of a label (score without the form's own cost). */
function placeForm(
  r: LabelRequest,
  f: LabelForm,
  zones: LabelZone[],
  assess: (b: Box, limit: number) => { score: number; hard: number; overData: number; overLines: boolean } | null,
): { b: Box; score: number; hard: number; overData: number; overLines: boolean; outside: boolean } | null {
  const { w, h } = f;
  const nd = f.nudge ?? { dx: w * 0.5, dy: h * 0.5 };
  const n = nd.n ?? 3;
  type Try = LabelCandidate & { reg?: Box };
  const tries: Try[] = [];
  for (const c of f.cands) {
    tries.push(c);
    for (let k = 1; k <= n; k++) {
      const step = 0.35 * k;
      if (nd.dy) {
        tries.push({ x: c.x, y: c.y + nd.dy * k, cost: c.cost + step });
        tries.push({ x: c.x, y: c.y - nd.dy * k, cost: c.cost + step });
      }
      if (nd.dx) {
        tries.push({ x: c.x + nd.dx * k, y: c.y, cost: c.cost + step * 1.2 });
        tries.push({ x: c.x - nd.dx * k, y: c.y, cost: c.cost + step * 1.2 });
      }
      if (nd.dx && nd.dy)
        for (let j = 1; j <= n; j++)
          for (const [sx, sy] of [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
          ])
            tries.push({ x: c.x + sx * nd.dx * k, y: c.y + sy * nd.dy * j, cost: c.cost + 0.35 * (k * 1.2 + j) });
    }
  }
  const a = f.cands[0] ?? r.cands[0];
  /** empty places anywhere in a region, dearer with their distance from the preferred anchor */
  const scanRegion = (reg: Box, base: number, inZone: boolean): Try[] => {
    const out: Try[] = [];
    if (!a || reg.w < w - 0.01 || reg.h < h - 0.01) return out;
    const diag = Math.max(1, Math.hypot(reg.w, reg.h), Math.hypot(r.bounds.w, r.bounds.h));
    const sx = Math.max(w / 4, reg.w / 18, 2);
    const sy = Math.max(h / 3, reg.h / 18, 2);
    const at = (x: number, y: number) => out.push({ x, y, cost: base + (3 * Math.hypot(x - a.x, y - a.y)) / diag, ...(inZone ? { reg } : {}) });
    for (let y = reg.y; y <= reg.y + reg.h - h + 0.01; y += sy) for (let x = reg.x; x <= reg.x + reg.w - w + 0.01; x += sx) at(x, y);
    // the far edges of the region, too
    for (let y = reg.y; y <= reg.y + reg.h - h + 0.01; y += sy) at(reg.x + reg.w - w, y);
    for (let x = reg.x; x <= reg.x + reg.w - w + 0.01; x += sx) at(x, reg.y + reg.h - h);
    // the place in the region nearest to the anchor
    const [nx, ny] = clampInto(a.x, a.y, w, h, reg);
    at(nx, ny);
    return out;
  };
  type Res = { b: Box; score: number; hard: number; overData: number; overLines: boolean; outside: boolean };
  let best: Res | null = null;
  /** the best few distinct places (refined below), with their candidate cost and region */
  const tops: { res: Res; cost: number; reg: Box }[] = [];
  const keep = (res: Res, cost: number, reg: Box) => {
    const i = tops.findIndex((t) => Math.abs(t.res.b.x - res.b.x) < 2 && Math.abs(t.res.b.y - res.b.y) < 2);
    if (i >= 0) {
      if (tops[i].res.score <= res.score) return;
      tops.splice(i, 1);
    }
    tops.push({ res, cost, reg });
    tops.sort((p, q) => p.res.score - q.res.score);
    if (tops.length > 5) tops.pop();
  };
  const scoreAt = (tx: number, ty: number, cost: number, limit: number, reg: Box) => {
    const [x, y] = clampInto(tx, ty, w, h, reg);
    const b = { x, y, w, h };
    // moving a label away from its candidate by clamping costs a little, too
    const moved = Math.hypot(x - tx, y - ty) / Math.max(4, h);
    // a form larger than the region sticks out of it (e.g. a wide one-line label meant for a zone above the frame, a
    // stack of overlay values taller than a small frame): avoided whenever a form fits, else the one sticking out least
    const excess = Math.max(0, w - reg.w) + Math.max(0, h - reg.h);
    const over = excess > 0.5 ? HARD_COST * (1 + excess / Math.max(4, Math.min(reg.w, reg.h))) : 0;
    const base = cost + moved * 0.5 + over;
    if (base >= limit) return null;
    const res = assess(b, limit - base);
    if (!res) return null;
    return { b, score: res.score + base, hard: res.hard + over, overData: res.overData, overLines: res.overLines, outside: reg !== r.bounds };
  };
  const consider = (list: Try[]) => {
    for (const t of list) {
      const reg = t.reg ?? r.bounds;
      const limit = tops.length < 5 ? Infinity : tops[tops.length - 1].res.score;
      const res = scoreAt(t.x, t.y, t.cost, limit, reg);
      if (!res) continue;
      keep(res, t.cost, reg);
      if (!best || res.score < best.score) best = res;
    }
  };
  consider(tries);
  // the whole region only when no place near the gate is clear (data or outlines under the best one)
  const scanCost = r.scanCost ?? 1.8;
  if (r.scan && (!best || (best as { score: number }).score > scanCost)) consider(scanRegion(r.scan === true ? r.bounds : r.scan, scanCost, false));
  // outside the frame: only when nothing inside is clear
  if (zones.length && (!best || (best as { hard: number }).hard > 0 || (best as { score: number }).score > scanCost + 1)) for (const z of zones) consider(scanRegion(z.box, z.cost, true));
  // local refinement: small moves around the best few places (a label just touching an outline or a cloud edge)
  for (const t of tops) {
    let cur = t.res;
    let curCost = t.cost;
    if (cur.score - curCost <= 0.05) continue;
    let sx = w / 4;
    let sy = h / 3;
    for (let round = 0; round < 3; round++) {
      let improved = true;
      let guard = 0;
      while (improved && guard++ < 6) {
        improved = false;
        for (const [ux, uy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ]) {
          const step = Math.hypot(ux * sx, uy * sy) / Math.max(4, h);
          const res = scoreAt(cur.b.x + ux * sx, cur.b.y + uy * sy, curCost + step * 0.15, cur.score - 1e-6, t.reg);
          if (res && res.score < cur.score) {
            cur = res;
            curCost += step * 0.15;
            improved = true;
          }
        }
      }
      sx /= 2;
      sy /= 2;
    }
    if (!best || cur.score < (best as Res).score) best = cur;
  }
  return best;
}

/** Whether point (x, y) lies inside the closed polygon `pts` (flat x,y list; even-odd rule). */
export function pointInPolygon(x: number, y: number, pts: ArrayLike<number>): boolean {
  const n = pts.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i];
    const yi = pts[2 * i + 1];
    const xj = pts[2 * j];
    const yj = pts[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
