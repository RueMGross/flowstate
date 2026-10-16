// Calibration panels on the worksheet: the bead fit (measured vs predicted, or the MESF regression) and the size curve
// (scattering cross section vs diameter) of a calibration, as figure items. They are chart items carrying their own data
// (`calib`, frozen when added: a workspace file keeps them as drawn), rendered with the painter like every other item,
// so the screen, PDF, SVG and bitmaps agree.
import { uid, type ChartItem, type SheetItem } from '../core/model';
import { computeTicks, type ScaleDef } from '../core/transforms';
import { brightOn, pageColorOf, sheetOf } from './figstyle';
import { measureRich, type Painter, type RichText, type TextStyle } from './painter';
import { fitText, fitTitle, panelLetterBox, placeTitle, PT, type RenderEnv, type TitleFit } from './plot';
import { clippedLength, overlapArea } from './labels';
import { itemTheme } from './chart';

export interface CalibAxis {
  title: string;
  log: boolean;
  min: number;
  max: number;
}

export interface CalibSeries {
  /** legend entry ('' = none) */
  name: string;
  kind: 'line' | 'points';
  x: number[];
  /** NaN breaks a line */
  y: number[];
  /** a palette role (resolved per theme) or a hex color */
  color: CalibColor | string;
  /** dash pattern in line widths, e.g. [4, 3] */
  dash?: number[];
  /** line width in pt (default 1) */
  width?: number;
  /** points drawn as rings (e.g. beads left out of the fit) */
  hollow?: boolean[];
  /** small labels next to the points (e.g. bead diameters) */
  labels?: string[];
}

export type CalibColor = 'model' | 'beads' | 'reference' | 'noise';

export interface CalibPanel {
  kind: 'sizeFit' | 'sizeCurve' | 'mesfFit';
  title: string;
  x: CalibAxis;
  y: CalibAxis;
  series: CalibSeries[];
  /** shaded x ranges (e.g. the valid range of a size curve) */
  bands?: { x0: number; x1: number; label?: string }[];
  hlines?: { y: number; label?: string; color: CalibColor | string; dash?: number[] }[];
  vlines?: { x: number; label?: string; color: CalibColor | string; dash?: number[] }[];
  /** result lines shown in the panel (e.g. "Half-angle 32.1°", "R² 0.9991") */
  notes?: string[];
  /** what it was made from (inspector) */
  source?: string;
}

export type CalibChartItem = ChartItem & { calib: CalibPanel };

export function isCalibPanel(it: SheetItem): it is CalibChartItem {
  if (it.kind !== 'chart') return false;
  const c = (it as { calib?: unknown }).calib as CalibPanel | undefined;
  return !!c && typeof c === 'object' && Array.isArray(c.series) && !!c.x && !!c.y;
}

const ROLE: Record<CalibColor, string> = { model: '#1f77b4', beads: '#d62728', reference: '#7f7f7f', noise: '#d62728' };

/** A chart item for a calibration panel (w x h px at x, y). */
export function newCalibItem(panel: CalibPanel, x: number, y: number, w: number, h: number, fontSize: number): CalibChartItem {
  return {
    id: uid('chart'),
    kind: 'chart',
    x,
    y,
    w,
    h,
    stat: { id: uid('col'), population: 'root', stat: 'count' },
    mode: 'samples',
    sampleSet: 'all',
    samples: [],
    style: 'dot',
    errorBars: 'none',
    showPoints: false,
    color: ROLE.model,
    useGroupColors: false,
    fontSize,
    lineWidth: 1,
    calib: panel,
  };
}

const fin = (v: number) => typeof v === 'number' && Number.isFinite(v);

function tickRuns(label: { base: string; exp?: string }): RichText {
  return label.exp !== undefined ? [{ text: label.base }, { text: label.exp, sup: true }] : label.base;
}

/** Axis scale of a panel axis (log axes need positive limits). */
function axisDef(a: CalibAxis): ScaleDef {
  const lo = fin(a.min) ? a.min : a.log ? 1 : 0;
  let hi = fin(a.max) ? a.max : lo + 1;
  if (a.log) {
    const l = lo > 0 ? lo : 1e-3;
    if (!(hi > l)) hi = l * 10;
    return { type: 'log', min: l, max: hi };
  }
  if (!(hi > lo)) hi = lo + 1;
  return { type: 'linear', min: lo, max: hi };
}

function mapper(a: CalibAxis, p0: number, p1: number): (v: number) => number {
  const d = axisDef(a);
  if (d.type === 'log') {
    const l0 = Math.log10(d.min);
    const l1 = Math.log10(d.max);
    return (v) => (v > 0 ? p0 + ((Math.log10(v) - l0) / (l1 - l0)) * (p1 - p0) : NaN);
  }
  const lin = d as { min: number; max: number };
  return (v) => p0 + ((v - lin.min) / (lin.max - lin.min)) * (p1 - p0);
}

/** Words of `text` wrapped into lines of at most `maxW` px (a word longer than that is shortened). */
function wrapText(text: string, maxW: number, st: TextStyle): RichText[] {
  const w = (t: string) => measureRich(t, st);
  if (w(text) <= maxW) return [text];
  const out: RichText[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const next = cur ? cur + ' ' + word : word;
    if (w(next) <= maxW || !cur) cur = next;
    else {
      out.push(w(cur) <= maxW ? cur : fitText(cur, maxW, st));
      cur = word;
    }
  }
  if (cur) out.push(w(cur) <= maxW ? cur : fitText(cur, maxW, st));
  return out;
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * Lay out and draw a calibration panel. The legend (named series, labelled reference lines, result notes) goes where it
 * covers no data, curve or reference line: an empty part of the frame, else right of the frame or below it (the frame
 * gets smaller); long entries wrap instead of being cut. Axis titles that do not fit take two lines or a smaller size.
 */
export function renderCalibPanel(p: Painter, it: CalibChartItem, env: RenderEnv) {
  const c = it.calib;
  const fs = it.fontSize * PT;
  const lw = Math.max(0.25, it.lineWidth) * PT * 0.75;
  const th = itemTheme(it.bg, it.bgColor, pageColorOf(sheetOf(env.ws, it.id)));
  const color = (k: string) => {
    const hex = (ROLE as Record<string, string>)[k] ?? k;
    return th.dark ? brightOn(hex, th.bg ?? '#1d2026') : hex;
  };
  const st: TextStyle = { family: env.ws.style.fontFamily, size: fs, color: th.fg };
  if (th.bg) p.rect(0, 0, it.w, it.h, null, { color: th.bg });
  const xd = axisDef(c.x);
  const yd = axisDef(c.y);
  const tl = fs * 0.42;
  const gap = fs * 0.42 + fs * 0.25;
  const r = Math.max(1.6, fs * 0.28);
  const pls: TextStyle = { ...st, size: Math.max(fs * 0.85, 5.5 * PT) };

  // legend entries: series with a name, then labelled reference lines (noise level, detection threshold); then notes
  const entries: CalibSeries[] = [
    ...c.series.filter((s) => s.name),
    ...[...(c.hlines ?? []), ...(c.vlines ?? [])].filter((l) => l.label).map((l) => ({ name: l.label!, kind: 'line' as const, x: [], y: [], color: l.color, dash: l.dash ?? [4, 3] })),
  ];
  const notes = c.notes ?? [];
  const lh = fs * 1.3;
  const sw = fs * 1.6;
  const tx = sw + fs * 0.2;
  /** the legend's lines (each entry and note wrapped to `maxW`) and size */
  const legendLines = (maxW: number) => {
    const ent = entries.map((e) => wrapText(e.name, Math.max(fs * 2, maxW - tx), st));
    const nts = notes.map((n) => wrapText(n, Math.max(fs * 2, maxW), st));
    const all = [...ent.flat().map((t) => tx + measureRich(t, st)), ...nts.flat().map((t) => measureRich(t, st))];
    const w = all.length ? Math.min(maxW, Math.max(...all)) + 2 : 0;
    const h = (ent.reduce((a, l) => a + l.length, 0) + nts.reduce((a, l) => a + l.length, 0)) * lh;
    return { ent, nts, w, h };
  };
  const hasLegend = entries.length + notes.length > 0;

  /** room of the x axis title: the frame and part of the margin left of it, never beyond the item (or into a legend) */
  const xSpan = (fr: Box) => {
    const m = Math.min(fr.x, 40) * 0.8;
    return { lo: fr.x - m, hi: Math.max(fr.x + fr.w, Math.min(fr.x + fr.w + m, it.w - 1)) };
  };
  /** frame and axis titles with the legend inside, right of the frame or below it */
  const layout = (side: 'inside' | 'right' | 'below') => {
    const T = c.title ? fs * 1.6 : fs * 0.62;
    const R0 = fs * 0.8;
    const legOut = side === 'right' ? legendLines(it.w * 0.4) : side === 'below' ? legendLines(it.w - fs * 1.2) : null;
    let xfit: TitleFit = { size: fs, lines: c.x.title ? [c.x.title] : [], cut: false };
    let yfit: TitleFit = { size: fs, lines: c.y.title ? [c.y.title] : [], cut: false };
    let fr = { x: 0, y: T, w: 10, h: 10 };
    let wy = 0;
    let yt: ReturnType<typeof computeTicks> = [];
    for (let pass = 0; pass < 2; pass++) {
      const B = gap + fs * 1.02 + (c.x.title ? fs * 1.28 + (xfit.lines.length - 1) * xfit.size * 1.15 : 0) + fs * 0.14 + (legOut && side === 'below' ? legOut.h + fs * 0.4 : 0);
      const fh = Math.max(10, it.h - T - B);
      if (c.y.title) yfit = fitTitle(c.y.title, fh + Math.min(T, 20), st);
      yt = computeTicks(yd, { target: Math.max(3, Math.round(fh / (fs * 3))) }).filter((t) => t.u >= -1e-9 && t.u <= 1 + 1e-9);
      wy = 0;
      for (const t of yt) if (t.major && t.label) wy = Math.max(wy, measureRich(tickRuns(t.label), st));
      const L = gap + wy + (c.y.title ? fs * 0.3 + yfit.size * 0.95 + (yfit.lines.length - 1) * yfit.size * 1.15 : 0) + fs * 0.18;
      const R = R0 + (legOut && side === 'right' ? legOut.w + fs * 0.5 : 0);
      fr = { x: L, y: T, w: Math.max(10, it.w - L - R), h: fh };
      if (c.x.title) xfit = fitTitle(c.x.title, xSpan(fr).hi - xSpan(fr).lo, st);
    }
    return { fr, xfit, yfit, wy, yt, legOut, X: mapper(c.x, fr.x, fr.x + fr.w), Y: mapper(c.y, fr.y + fr.h, fr.y) };
  };

  /** what a legend must not cover in a frame: curve and reference line segments, points and their labels */
  const contentOf = (lay: ReturnType<typeof layout>) => {
    const { fr, X, Y } = lay;
    const segs: number[][] = [];
    const boxes: Box[] = [];
    for (const s of c.series) {
      let prev: [number, number] | null = null;
      s.x.forEach((xv, i) => {
        const x = X(xv);
        const y = Y(s.y[i]);
        if (!fin(x) || !fin(y)) {
          prev = null;
          return;
        }
        if (s.kind === 'line') {
          if (prev) segs.push([prev[0], prev[1], x, y]);
          prev = [x, y];
        } else boxes.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r });
      });
    }
    for (const q of placeLabels(lay, null)) boxes.push(q);
    for (const h of c.hlines ?? []) {
      const y = Y(h.y);
      if (fin(y)) segs.push([fr.x, y, fr.x + fr.w, y]);
    }
    for (const v of c.vlines ?? []) {
      const x = X(v.x);
      if (fin(x)) segs.push([x, fr.y, x, fr.y + fr.h]);
    }
    return { segs, boxes };
  };
  const covered = (b: Box, ct: ReturnType<typeof contentOf>) => {
    const g = { x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 };
    let n = 0;
    for (const sg of ct.segs) n += clippedLength(sg[0], sg[1], sg[2], sg[3], g);
    for (const q of ct.boxes) n += overlapArea(g, q) > 0 ? 20 : 0;
    return n;
  };
  /** the least covered place for the legend inside the frame (corners first) */
  const insidePlace = (lay: ReturnType<typeof layout>) => {
    const { fr } = lay;
    const lg = legendLines(fr.w - 6);
    if (lg.w > fr.w - 4 || lg.h > fr.h - 4) return null;
    const ct = contentOf(lay);
    const cands: { x: number; y: number; pref: number }[] = [
      { x: fr.x + 3, y: fr.y + 2, pref: 0 },
      { x: fr.x + fr.w - lg.w - 3, y: fr.y + fr.h - lg.h - 2, pref: 0.1 },
      { x: fr.x + fr.w - lg.w - 3, y: fr.y + 2, pref: 0.2 },
      { x: fr.x + 3, y: fr.y + fr.h - lg.h - 2, pref: 0.3 },
    ];
    const sx = Math.max(4, (fr.w - lg.w) / 12);
    const sy = Math.max(4, (fr.h - lg.h) / 12);
    for (let y = fr.y + 2; y <= fr.y + fr.h - lg.h - 2 + 0.01; y += sy) for (let x = fr.x + 3; x <= fr.x + fr.w - lg.w - 3 + 0.01; x += sx) cands.push({ x, y, pref: 0.5 });
    let best: { x: number; y: number; cost: number } | null = null;
    for (const k of cands) {
      const cost = covered({ x: k.x, y: k.y, w: lg.w, h: lg.h }, ct) * 10 + k.pref;
      if (!best || cost < best.cost) best = { x: k.x, y: k.y, cost };
    }
    return best ? { ...best, lg } : null;
  };

  /**
   * Point labels (e.g. bead diameters) next to their own point: inside the frame, off the other points, labels, curves
   * and `avoid` (the legend), and nearer to their own point than to any other (never between two points).
   */
  const placeLabels = (lay: ReturnType<typeof layout>, avoid: Box | null): (Box & { t: string })[] => {
    const { fr, X, Y } = lay;
    const pts: { x: number; y: number; t?: string }[] = [];
    const segs: number[][] = [];
    for (const s of c.series) {
      let prev: [number, number] | null = null;
      s.x.forEach((xv, i) => {
        const x = X(xv);
        const y = Y(s.y[i]);
        if (!fin(x) || !fin(y)) {
          prev = null;
          return;
        }
        if (s.kind === 'line') {
          if (prev) segs.push([prev[0], prev[1], x, y]);
          prev = [x, y];
        } else if (x >= fr.x - r && x <= fr.x + fr.w + r && y >= fr.y - r && y <= fr.y + fr.h + r) pts.push({ x, y, t: s.labels?.[i] || undefined });
      });
    }
    const out: (Box & { t: string })[] = [];
    const lh = pls.size * 1.05;
    const gap = 1.5;
    const distTo = (b: Box, x: number, y: number) => Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h));
    pts.forEach((q, qi) => {
      if (!q.t) return;
      const w = measureRich(q.t, pls);
      const cands: [number, number][] = [
        [q.x + r + gap, q.y - r * 0.4 - lh],
        [q.x + r + gap, q.y + r * 0.4],
        [q.x - r - gap - w, q.y - r * 0.4 - lh],
        [q.x - r - gap - w, q.y + r * 0.4],
        [q.x + r + gap, q.y - lh / 2],
        [q.x - r - gap - w, q.y - lh / 2],
        [q.x - w / 2, q.y - r - gap - lh],
        [q.x - w / 2, q.y + r + gap],
      ];
      let best: { b: Box; cost: number } | null = null;
      cands.forEach(([x, y], k) => {
        const b = { x, y, w, h: lh };
        let cost = k * 0.5;
        // inside the frame (hard)
        const outW = Math.max(0, fr.x + 1 - b.x) + Math.max(0, b.x + b.w - (fr.x + fr.w - 1));
        const outH = Math.max(0, fr.y + 1 - b.y) + Math.max(0, b.y + b.h - (fr.y + fr.h - 1));
        cost += (outW + outH) * 50;
        if (avoid) cost += overlapArea(b, { x: avoid.x - 2, y: avoid.y - 2, w: avoid.w + 4, h: avoid.h + 4 }) * 50;
        for (const o of out) cost += overlapArea(b, { x: o.x - 1, y: o.y - 1, w: o.w + 2, h: o.h + 2 }) * 50;
        const own = distTo(b, q.x, q.y);
        pts.forEach((o, oi) => {
          if (oi === qi) return;
          const dOther = distTo(b, o.x, o.y);
          // on another point, or nearer to it than to its own point (which one is meant?)
          if (dOther < r + 0.5) cost += 400;
          else if (dOther < own + r) cost += 120;
        });
        for (const sg of segs) cost += clippedLength(sg[0], sg[1], sg[2], sg[3], b) * 0.6;
        if (!best || cost < best.cost) best = { b, cost };
      });
      const b = (best as { b: Box } | null)?.b;
      if (b) out.push({ ...b, t: q.t });
    });
    return out;
  };

  let lay = layout('inside');
  let legend: { x: number; y: number; lg: ReturnType<typeof legendLines>; halo?: boolean } | null = null;
  if (hasLegend) {
    const ins = insidePlace(lay);
    if (ins && ins.cost < 1) legend = ins;
    else {
      // no empty place inside: right of the frame when the frame keeps at least half the width, else below it
      const right = layout('right');
      const outside = right.legOut && right.fr.w >= (it.w - lay.fr.x) * 0.5 && right.legOut.h <= right.fr.h + fs ? right : layout('below');
      if (outside.legOut) {
        lay = outside;
        const lg = outside.legOut;
        legend = outside === right ? { x: lay.fr.x + lay.fr.w + fs * 0.5, y: lay.fr.y + 2, lg } : { x: fs * 0.6, y: it.h - lg.h - fs * 0.2, lg };
      } else if (ins) legend = { ...ins, halo: true };
    }
  }
  const { fr, X, Y, xfit, yfit, wy, yt } = lay;
  const axis = { color: th.fg, width: lw };
  const tick = { color: th.fg, width: lw * 0.9 };

  // shaded bands first, then the data, then the frame on top
  p.save();
  p.clipRect(fr.x, fr.y, fr.w, fr.h);
  for (const b of c.bands ?? []) {
    const a = X(Math.max(b.x0, xd.type === 'log' ? xd.min : -Infinity));
    const e = X(b.x1);
    if (fin(a) && fin(e)) p.rect(Math.min(a, e), fr.y, Math.abs(e - a), fr.h, null, { color: color('model'), opacity: th.dark ? 0.16 : 0.08 });
  }
  for (const h of c.hlines ?? []) {
    const y = Y(h.y);
    if (fin(y)) p.line(fr.x, y, fr.x + fr.w, y, { color: color(h.color), width: lw, dash: (h.dash ?? [4, 3]).map((d) => d * lw) });
  }
  for (const v of c.vlines ?? []) {
    const x = X(v.x);
    if (fin(x)) p.line(x, fr.y, x, fr.y + fr.h, { color: color(v.color), width: lw, dash: (v.dash ?? [4, 3]).map((d) => d * lw) });
  }
  for (const s of c.series) {
    const col = color(s.color);
    const width = (s.width ?? 1) * PT * 0.75;
    if (s.kind === 'line') {
      let seg: number[] = [];
      const flush = () => {
        if (seg.length >= 4) p.path(seg, false, { color: col, width, dash: s.dash?.map((d) => d * width) });
        seg = [];
      };
      for (let i = 0; i < s.x.length; i++) {
        const x = X(s.x[i]);
        const y = Y(s.y[i]);
        if (fin(x) && fin(y)) seg.push(x, y);
        else flush();
      }
      flush();
    } else
      s.x.forEach((xv, i) => {
        const x = X(xv);
        const y = Y(s.y[i]);
        if (!fin(x) || !fin(y)) return;
        const hollow = !!s.hollow?.[i];
        p.ellipse(x, y, r, r, 0, { color: hollow ? col : th.bg ?? (th.dark ? '#000000' : '#ffffff'), width: lw * 0.7 }, hollow ? null : { color: col });
      });
  }
  p.restore();
  // point labels next to their own point, inside the frame and off the legend
  const legBox = legend ? { x: legend.x, y: legend.y, w: legend.lg.w, h: legend.lg.h } : null;
  for (const q of placeLabels(lay, legBox)) p.text(q.x, q.y + q.h, q.t, { ...pls, align: 'left', baseline: 'bottom', halo: { color: th.bg ?? (th.dark ? '#000000' : '#ffffff'), width: 1, opacity: 0.9 } });

  // axes
  p.rect(fr.x, fr.y, fr.w, fr.h, axis, null);
  const xt = computeTicks(xd, { target: Math.max(3, Math.round(fr.w / (fs * 5))) }).filter((t) => t.u >= -1e-9 && t.u <= 1 + 1e-9);
  const xUsed: [number, number][] = [];
  for (const t of xt) {
    const x = fr.x + t.u * fr.w;
    p.line(x, fr.y + fr.h, x, fr.y + fr.h + (t.major ? tl : tl * 0.55), tick);
    if (!t.major || !t.label) continue;
    const runs = tickRuns(t.label);
    const w = measureRich(runs, st);
    const a = x - w / 2 - fs * 0.3;
    const b = x + w / 2 + fs * 0.3;
    if (xUsed.some(([u0, u1]) => a < u1 && b > u0)) continue;
    xUsed.push([a, b]);
    p.text(x, fr.y + fr.h + gap, runs, { ...st, align: 'center', baseline: 'top' });
  }
  const yUsed: [number, number][] = [];
  for (const t of yt) {
    const y = fr.y + (1 - t.u) * fr.h;
    p.line(fr.x - (t.major ? tl : tl * 0.55), y, fr.x, y, tick);
    if (!t.major || !t.label) continue;
    if (yUsed.some(([u0, u1]) => y - fs * 0.68 < u1 && y + fs * 0.68 > u0)) continue;
    yUsed.push([y - fs * 0.68, y + fs * 0.68]);
    p.text(fr.x - gap, y, tickRuns(t.label), { ...st, align: 'right', baseline: 'middle' });
  }
  // axis titles: one line, or two lines / a smaller size when they do not fit (shortened only beyond that)
  if (c.x.title) {
    const xs: TextStyle = { ...st, size: xfit.size, align: 'center', baseline: 'top' };
    const span = xSpan(fr);
    const room = span.hi - span.lo;
    // centered on the frame, moved inwards where the item ends
    const tw = Math.min(room, Math.max(...xfit.lines.map((l) => measureRich(l, xs))));
    const cx = Math.min(Math.max(fr.x + fr.w / 2, span.lo + tw / 2), span.hi - tw / 2);
    xfit.lines.forEach((l, i) => p.text(cx, fr.y + fr.h + gap + fs * 1.22 + i * xfit.size * 1.15, xfit.cut ? fitText(l, room, xs) : l, xs));
  }
  if (c.y.title) {
    const ys: TextStyle = { ...st, size: yfit.size, align: 'center', baseline: 'middle' };
    const room = fr.h + Math.min(fr.y, 20);
    const n = yfit.lines.length;
    const x0 = fr.x - gap - wy - fs * 0.3 - yfit.size * 0.56;
    yfit.lines.forEach((l, i) => p.text(x0 - (n - 1 - i) * yfit.size * 1.15, fr.y + fr.h / 2, yfit.cut ? fitText(l, room, ys) : l, ys, -Math.PI / 2));
  }
  if (c.title) {
    const bst: TextStyle = { ...st, weight: 'bold' };
    const t = placeTitle(c.title, fr.x + fr.w / 2, fr.w + 2 * Math.min(fr.x, it.w - fr.x - fr.w) * 0.85, it.w, fr.y - fs * 0.6, bst, panelLetterBox(env.ws, it.id));
    p.text(t.x, fr.y - fs * 0.6, t.text, { ...bst, size: t.size, align: 'center', baseline: 'alphabetic' });
  }

  // the legend: in an empty place or outside the frame (a halo only where it has to cover something)
  if (legend) {
    const { lg } = legend;
    const halo = legend.halo ? { color: th.bg ?? (th.dark ? '#000000' : '#ffffff'), width: Math.max(1, fs * 0.14), opacity: 0.92 } : undefined;
    let y = legend.y + lh / 2;
    entries.forEach((e, i) => {
      const col = color(e.color);
      const width = (e.width ?? 1) * PT * 0.75;
      if (e.kind === 'line') p.line(legend!.x, y, legend!.x + sw - fs * 0.3, y, { color: col, width: Math.max(width, lw), dash: e.dash?.map((d) => d * width) });
      else if (e.hollow?.length && e.hollow.every(Boolean)) p.ellipse(legend!.x + (sw - fs * 0.3) / 2, y, r, r, 0, { color: col, width: lw * 0.7 }, null);
      else p.ellipse(legend!.x + (sw - fs * 0.3) / 2, y, r, r, 0, { color: th.bg ?? (th.dark ? '#000000' : '#ffffff'), width: lw * 0.7 }, { color: col });
      for (const t of lg.ent[i]) {
        p.text(legend!.x + tx, y, t, { ...st, baseline: 'middle', halo });
        y += lh;
      }
    });
    for (const n of lg.nts)
      for (const t of n) {
        p.text(legend.x, y, t, { ...st, baseline: 'middle', halo });
        y += lh;
      }
  }
}
