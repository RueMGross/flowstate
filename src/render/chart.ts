// Statistic chart (bar / dot plot) of one statistic across samples or groups.
import { STAT_LABELS, popById, channelDisplayName, type ChartItem, type PlotBackground, type PlotOptions } from '../core/model';
import { computeTicks } from '../core/transforms';
import { formatStat } from '../core/stats';
import { measureRich, parseSup, type Painter, type TextStyle } from './painter';
import { fitText as fitRich, panelLetterBox, placeTitle, plotTheme, PT, type RenderEnv, type Theme } from './plot';
import { pageColorOf, sheetOf } from './figstyle';
import { isCalibPanel, renderCalibPanel } from './calibPanel';
import { isPlateChart, renderPlateChart } from './plateChart';

export interface ChartBar {
  label: string;
  color: string;
  values: number[];
}

/** The bars of a chart; on screen (env.deferStats), whether a value waits for a background computation. */
export function chartDataOf(item: ChartItem, env: RenderEnv): { bars: ChartBar[]; pending: boolean } {
  if (!env.deferStats) return { bars: chartData(item, env), pending: false };
  const r = env.engine.deferredValue(() => chartData(item, env));
  return { bars: r.value, pending: r.pending };
}

export function chartData(item: ChartItem, env: RenderEnv): ChartBar[] {
  const { ws, engine } = env;
  const val = (sid: string) => (engine.has(sid) ? engine.stat(ws, sid, item.stat) : NaN);
  if (item.mode === 'groups') {
    const groups = (item.groups?.length ? item.groups.map((id) => ws.groups.find((g) => g.id === id)).filter(Boolean) : ws.groups) as typeof ws.groups;
    const bars = groups.map((g) => ({
      label: g.name,
      color: item.useGroupColors && g.color ? g.color : item.color,
      values: g.sampleIds.map(val).filter((v) => Number.isFinite(v)),
    }));
    // groups without a value (the population does not apply to them, no loaded sample) are left out, unless none has one
    const withData = bars.filter((b) => b.values.length > 0);
    return withData.length ? withData : bars;
  }
  // the samples fixed when the chart was made (in that order, loaded ones), else the live sample set
  // (same rule as chartSampleIds in the store, which the render layer does not import)
  const grp = ws.groups.find((g) => g.id === item.sampleSet);
  const samples = item.samples
    ? item.samples.map((id) => ws.samples.find((s) => s.id === id)).filter((s): s is (typeof ws.samples)[number] => !!s && engine.has(s.id))
    : ws.samples.filter((s) => engine.has(s.id) && (!grp || grp.sampleIds.includes(s.id)));
  return samples.map((s) => ({ label: s.name, color: item.useGroupColors && s.color ? s.color : item.color, values: [val(s.id)].filter((v) => Number.isFinite(v)) }));
}

const STAT_AXIS: Partial<Record<ChartItem['stat']['stat'], string>> = {
  freqParent: '% of parent',
  freqTotal: '% of total',
  freqGrandparent: '% of grandparent',
  count: 'Count',
  concentration: 'Events / µL',
};

/** Y axis title from the statistic: "% of parent", "% of Lymphocytes", "Median CD69 (APC-A)", "Count". */
export function statAxisLabel(item: ChartItem, env: RenderEnv): string {
  const { ws } = env;
  const c = item.stat;
  if (c.stat === 'freqOf') {
    const ofName = c.ofPopulation && c.ofPopulation !== 'root' ? popById(ws, c.ofPopulation)?.name ?? '?' : 'All Events';
    return `% of ${ofName}`;
  }
  const fixed = STAT_AXIS[c.stat];
  if (fixed) return fixed;
  const st = c.stat === 'percentile' ? `P${c.percentile ?? 50}` : STAT_LABELS[c.stat];
  return c.channel ? `${st} ${channelDisplayName(ws, c.channel, 'both')}` : st;
}

export function statTitle(item: ChartItem, env: RenderEnv): string {
  const { ws } = env;
  const c = item.stat;
  const pop = c.population === 'root' ? 'All Events' : popById(ws, c.population)?.name ?? '?';
  const ofName = c.ofPopulation && c.ofPopulation !== 'root' ? popById(ws, c.ofPopulation)?.name ?? '?' : 'All Events';
  const st = c.stat === 'percentile' ? `P${c.percentile ?? 50}` : c.stat === 'freqOf' ? `% of ${ofName}` : STAT_LABELS[c.stat];
  const ch = c.channel && ['mean', 'median', 'geomean', 'sd', 'cv', 'rsd', 'rcv', 'min', 'max', 'percentile', 'mode'].includes(c.stat) ? ` ${channelDisplayName(ws, c.channel, 'label')}` : '';
  return `${pop}: ${st}${ch}`;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1));
};

function rich(t: string) {
  return t.includes('^') ? parseSup(t) : t;
}

/** Background / text colors of a chart or statistics box (same choices as plots; `page`: the page color behind it). */
export function itemTheme(bg: PlotBackground | undefined, bgColor: string | undefined, page?: string | null): Theme {
  return plotTheme({ bg, bgColor } as PlotOptions, page);
}

export function renderChart(p: Painter, it: ChartItem, env: RenderEnv) {
  // a calibration panel (bead fit, resolution curve) is a chart item carrying its own data
  if (isCalibPanel(it)) {
    renderCalibPanel(p, it, env);
    return;
  }
  // a plate heatmap: the statistic over the wells of a plate
  if (isPlateChart(it)) {
    renderPlateChart(p, it, env);
    return;
  }
  const fs = it.fontSize * PT;
  const lw = it.lineWidth * PT * 0.75;
  const th = itemTheme(it.bg, it.bgColor, pageColorOf(sheetOf(env.ws, it.id)));
  const fg = th.fg;
  const st: TextStyle = { family: env.ws.style.fontFamily, size: fs, color: fg };
  const { bars, pending } = chartDataOf(it, env);
  if (th.bg) p.rect(0, 0, it.w, it.h, null, { color: th.bg });
  if (pending) {
    // values on channels computed in the background (unmixing of a large sample): drawn when they are in
    const mst: TextStyle = { ...st, color: '#8a95a3', align: 'center', baseline: 'middle' };
    const title0 = it.title ?? statTitle(it, env);
    if (title0) p.text(it.w / 2, fs * 1.2, fitRich(title0, it.w - fs * 0.6, { ...st, weight: 'bold' }), { ...st, weight: 'bold', align: 'center' });
    p.text(it.w / 2, it.h / 2, fitRich('Computing…', it.w * 0.9, mst), mst);
    return;
  }
  const title = it.title ?? statTitle(it, env);
  const T = title ? fs * 1.75 : fs * 0.8;
  // y range: zero to the largest value, extended below zero for negative values (the category axis runs through zero)
  let ymax = it.yMax ?? 0;
  let ymin = 0;
  let dataMax = 0;
  for (const b of bars) {
    if (!b.values.length) continue;
    const m = mean(b.values);
    const e = it.errorBars === 'sd' ? sd(b.values) : it.errorBars === 'sem' ? sd(b.values) / Math.sqrt(Math.max(1, b.values.length)) : 0;
    dataMax = Math.max(dataMax, m + e, ...b.values);
    if (!it.yMax) ymax = Math.max(ymax, m + e, ...b.values);
    ymin = Math.min(ymin, m - (it.style === 'bar' && m >= 0 ? 0 : e), ...b.values);
  }
  if (!it.yMax) {
    if (ymax <= 0 && ymin >= 0) ymax = 1;
    if (it.stat.stat.startsWith('freq') && ymax <= 100 && ymax > 60) ymax = 100;
    else if (ymax > 0) ymax *= 1.08;
  }
  if (ymin < 0) ymin *= 1.08;
  if (!(ymax > ymin)) ymax = ymin + 1;
  const tl = fs * 0.42;
  // left margin from the measured tick labels and the y title
  const hEst = Math.max(10, it.h - T - fs * 2.2);
  const ticks = computeTicks({ type: 'linear', min: ymin, max: ymax }, { target: Math.max(3, Math.round(hEst / (fs * 3))) });
  let wy = 0;
  for (const t of ticks) if (t.major && t.label) wy = Math.max(wy, measureRich(t.label.base, st));
  const yl = it.yLabel ?? statAxisLabel(it, env);
  let L = tl + fs * 0.25 + wy + (yl ? fs * 0.3 + fs * 0.95 : 0) + fs * 0.2;
  const L0 = L;
  const R = fs * 0.8;
  // x labels: rotate if they do not fit, shortened to the room below the axis
  const nb = Math.max(1, bars.length);
  let slot = (it.w - L - R) / nb;
  const maxLabel = Math.max(0, ...bars.map((b) => measureRich(rich(b.label), st)));
  const rotate = maxLabel > slot * 0.95;
  // Rotated labels run down and to the left from their bar (right-aligned at cx + 0.3 em, 45 degrees): the corner
  // farthest left / down lies SQ * (width + ROT_EM em) from the anchor. Widen the left margin so that no label is cut
  // at the item's left edge (as far as 45 % of the width; beyond that the labels are shortened instead).
  const SQ = Math.SQRT1_2;
  const ROT_EM = 0.6; // half the text height around the 'middle' baseline, in em
  // Labels at 45 degrees lie slot x sin 45 apart: with a slot below UPRIGHT_SLOT em they would touch, so they stand
  // upright (90 degrees, a slot apart, straight down from their bar); below THIN_SLOT em even those touch, and only every
  // k-th bar is labelled (the last one always).
  const UPRIGHT_SLOT = 1.45;
  const THIN_SLOT = 1.1;
  let upright = false;
  let B = fs * 2.2;
  let rotFit = 0;
  /** Room below the frame and the longest label for 45 degree or upright labels (in the bottom 45 % of the chart). */
  const rotLayout = (up: boolean) => {
    const k = up ? 1 : 0.72; // label length -> height below the axis
    B = Math.min(it.h * 0.45, maxLabel * k + fs * 1.2);
    rotFit = Math.min((it.h * 0.45) / k, (B - fs * 0.9) / k);
  };
  if (rotate && bars.length) {
    rotLayout(false);
    const need = bars.map((b, i) => {
      const ext = SQ * (measureRich(fitRich(b.label, rotFit, st), st) + fs * ROT_EM) + 1; // 1 px clearance
      const c = (i + 0.5) / nb; // bar centre = L + (it.w - L - R) * c
      return (ext - fs * 0.3 - (it.w - R) * c) / (1 - c);
    });
    L = Math.max(L, Math.min(it.w * 0.45, Math.max(...need)));
    slot = (it.w - L - R) / nb;
    if (slot < fs * UPRIGHT_SLOT) {
      // upright labels need no extra room on the left
      upright = true;
      L = L0;
      slot = (it.w - L - R) / nb;
      rotLayout(true);
    }
  }
  const labelEvery = upright && slot < fs * THIN_SLOT ? Math.ceil((fs * THIN_SLOT) / Math.max(slot, 0.01)) : 1;
  const fr = { x: L, y: T, w: Math.max(10, it.w - L - R), h: Math.max(10, it.h - T - B) };
  /** Longest rotated label that stays inside the item from an anchor at (ax, ay). */
  const rotRoom = (ax: number, ay: number) =>
    upright ? Math.max(fs, Math.min(rotFit, it.h - ay - 1)) : Math.max(fs, Math.min(rotFit, (ax - 1) / SQ - fs * ROT_EM, (it.h - ay - 1) / SQ - fs * ROT_EM));
  const yPx = (v: number) => fr.y + fr.h * (1 - (v - ymin) / (ymax - ymin));
  const yC = (v: number) => Math.max(fr.y, yPx(v)); // clipped to the frame top
  const y0 = yPx(0);
  const axis = { color: fg, width: lw };
  // axes: the category axis at zero
  p.line(fr.x, fr.y, fr.x, fr.y + fr.h, axis);
  p.line(fr.x, y0, fr.x + fr.w, y0, axis);
  for (const t of ticks) {
    const y = fr.y + (1 - t.u) * fr.h;
    p.line(fr.x - (t.major ? tl : tl * 0.55), y, fr.x, y, { color: fg, width: lw * 0.9 });
    if (t.major && t.label) p.text(fr.x - tl - fs * 0.25, y, t.label.base, { ...st, align: 'right', baseline: 'middle' });
  }
  if (yl) p.text(fr.x - tl - fs * 0.25 - wy - fs * 0.3 - fs * 0.56, fr.y + fr.h / 2, fitRich(yl, fr.h, st), { ...st, align: 'center', baseline: 'middle' }, -Math.PI / 2);
  if (title) {
    const bst: TextStyle = { ...st, weight: 'bold' };
    const t = placeTitle(title, it.w / 2, it.w - fs * 0.6, it.w, fr.y - fs * 0.6, bst, panelLetterBox(env.ws, it.id));
    p.text(t.x, fr.y - fs * 0.6, t.text, { ...bst, size: t.size, align: 'center' });
  }
  const n = bars.length;
  if (!n) {
    const mst: TextStyle = { ...st, color: '#8a95a3', align: 'center', baseline: 'middle' };
    p.text(fr.x + fr.w / 2, fr.y + fr.h / 2, fitRich(it.mode === 'groups' ? 'Create sample groups to compare them' : 'No samples', fr.w * 0.95, mst), mst);
    return;
  }
  const bw = (fr.w / n) * 0.62;
  const over = dataMax > ymax * 1.0001; // values beyond a fixed y maximum
  bars.forEach((b, i) => {
    const cx = fr.x + (fr.w / n) * (i + 0.5);
    const m = mean(b.values);
    if (b.values.length) {
      p.save();
      // bars, error bars and points stay inside the frame (above it sits the title)
      p.clipRect(fr.x - bw, fr.y, fr.w + 2 * bw, it.h - fr.y);
      // bars grow from zero, downwards for negative means
      if (it.style === 'bar') p.rect(cx - bw / 2, Math.min(yC(m), y0), bw, Math.abs(y0 - yC(m)), { color: fg, width: lw * 0.8 }, { color: b.color, opacity: 0.85 });
      else if (yPx(m) >= fr.y) p.line(cx - bw / 2.5, yPx(m), cx + bw / 2.5, yPx(m), { color: fg, width: lw * 1.6 });
      const e = it.errorBars === 'sd' ? sd(b.values) : it.errorBars === 'sem' ? sd(b.values) / Math.sqrt(b.values.length) : 0;
      if (e > 0 && b.values.length > 1) {
        const cap = bw / 5;
        // bars: the error bar points away from zero only
        const out = m < 0 ? -e : e;
        const from = it.style === 'bar' ? m : m - out;
        p.line(cx, yC(from), cx, yC(m + out), { color: fg, width: lw });
        if (yPx(m + out) >= fr.y) p.line(cx - cap, yPx(m + out), cx + cap, yPx(m + out), { color: fg, width: lw });
        if (it.style !== 'bar') p.line(cx - cap, yPx(m - out), cx + cap, yPx(m - out), { color: fg, width: lw });
      }
      if (it.showPoints || it.style === 'dot') {
        const r = fs * 0.28;
        b.values.forEach((v, k) => {
          if (yPx(v) < fr.y) return;
          const jitter = b.values.length > 1 ? (k / (b.values.length - 1) - 0.5) * bw * 0.6 : 0;
          p.ellipse(cx + jitter, yPx(v), r, r, 0, { color: fg, width: lw * 0.6 }, { color: it.style === 'bar' ? th.bg ?? '#ffffff' : b.color });
        });
      }
      p.restore();
      // overflow marker: something of this bar lies above the y maximum
      if (over && Math.max(m, ...b.values, m + e) > ymax * 1.0001) {
        const a = fs * 0.32;
        p.path([cx - a, fr.y + a * 1.5, cx + a, fr.y + a * 1.5, cx, fr.y + a * 0.2], true, { color: th.bg ?? '#ffffff', width: lw * 0.8 }, { color: fg });
      }
    }
    // category label
    if (upright) {
      // straight down from the bar (reading upwards); with crowded bars every k-th one, counted from the last
      if ((n - 1 - i) % labelEvery === 0) {
        const ay = fr.y + fr.h + tl + fs * 0.3;
        p.text(cx, ay, fitRich(b.label, rotRoom(cx, ay), st), { ...st, align: 'right', baseline: 'middle' }, -Math.PI / 2);
      }
    } else if (rotate) {
      const ax = cx + fs * 0.3;
      const ay = fr.y + fr.h + tl + fs * 0.3;
      p.text(ax, ay, fitRich(b.label, rotRoom(ax, ay), st), { ...st, align: 'right', baseline: 'middle' }, -Math.PI / 4);
    }
    else p.text(cx, fr.y + fr.h + tl + fs * 0.3, fitRich(b.label, slot * 0.98, st), { ...st, align: 'center', baseline: 'top' });
    p.line(cx, y0, cx, y0 + tl * 0.7, { color: fg, width: lw * 0.9 });
  });
  void formatStat;
}
