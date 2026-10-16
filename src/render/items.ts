// Rendering of non-plot sheet items (text boxes, statistics boxes) and whole worksheets.
import type { Engine } from '../core/engine';
import { DEFAULT_GRID_COLOR, STAT_LABELS, STAT_NEEDS_CHANNEL, popById, channelDisplayName, sheetGridOpacity, sheetGridStyle, type SheetItem, type StatsBoxItem, type TextItem, type Workspace, type Worksheet } from '../core/model';
import { resolveStatCol } from '../core/scope';
import { excludedNote, formatStat } from '../core/stats';
import { measureRich, parseSup, type Painter, type RichText, type TextStyle } from './painter';
import { fitText, panelLetterBox, PT, renderPlot, type RenderEnv } from './plot';
import { itemTheme, renderChart } from './chart';
import { pageColorOf, sheetOf, textColorOf } from './figstyle';
import { vmetrics } from './fonts';

/**
 * Text box, laid out like the HTML text on the worksheet: lines of 1.2 em (baseline where the CSS line box puts it),
 * greedy word wrap measured on the rendered text (superscript markup counts at its drawn size, not as "^{...}").
 */
export function renderText(p: Painter, it: TextItem, ws: Workspace) {
  const st: TextStyle = {
    family: ws.style.fontFamily,
    size: it.fontSize * PT,
    weight: it.bold ? 'bold' : 'normal',
    italic: it.italic,
    // no color of its own (panel letters): the page's text color, light on dark pages
    color: textColorOf(it, sheetOf(ws, it.id)),
    baseline: 'alphabetic',
    align: it.align,
  };
  const lh = st.size * 1.2;
  const vm = vmetrics(st.family);
  const baseline = ((1.2 - (vm.asc + vm.desc)) / 2 + vm.asc) * st.size;
  const x = it.align === 'center' ? it.w / 2 : it.align === 'right' ? it.w : 0;
  const lines = textLines(it, st.family);
  lines.forEach((l, i) => {
    if (i * lh >= it.h) return; // clipped like the overflow of the HTML box
    p.text(x, i * lh + baseline, l.includes('^') ? parseSup(l) : l, st);
  });
}

type TextShape = Pick<TextItem, 'text' | 'fontSize' | 'bold' | 'italic' | 'w'>;

/** Lines of a text box as drawn (paragraphs wrapped greedily at the box width, see renderText). */
export function textLines(it: TextShape, family: string): string[] {
  const st: TextStyle = { family, size: it.fontSize * PT, weight: it.bold ? 'bold' : 'normal', italic: it.italic, color: '#000000' };
  const width = (t: string) => measureRich(t.includes('^') ? parseSup(t) : t, st);
  const lines: string[] = [];
  for (const para of it.text.split('\n')) {
    // greedy word wrap at spaces and after hyphens (like the browser); spaces at a line end hang (white-space: pre-wrap)
    const words = para.split(/(\s+)|(?<=[^\s\-^]-)(?=[^\d\s\-])/);
    let cur = '';
    for (const w of words) {
      if (!w) continue;
      const test = cur + w;
      if (!/^\s+$/.test(w) && cur.trim() && width(test.trimEnd()) > it.w + 0.01) {
        lines.push(cur.trimEnd());
        cur = w;
      } else cur = test;
    }
    lines.push(cur.trimEnd());
  }
  return lines;
}

/** Height (px) a text box needs to show all its lines (1.2 em each, see renderText). */
export function textNeedH(it: TextShape, family: string): number {
  return textLines(it, family).length * it.fontSize * PT * 1.2;
}

/** The text of a text box does not fit its height (lines are cut at the bottom on screen and in exports). */
export function textOverflows(it: TextItem, family: string): boolean {
  return textNeedH(it, family) > it.h + 0.5;
}

/**
 * Rows of a statistics box: label and value text ("n/a" when the statistic does not apply to the sample). `note`: the
 * value rests on fewer events than the population has (events without a value in the channel, see excludedNote).
 */
export function statsRows(ws: Workspace, engine: Engine, it: StatsBoxItem, sampleId: string | null, opts: { deferred?: boolean } = {}): { label: string; value: string; note: string | null }[] {
  // on screen, a value on a channel computed in the background is shown as "computing" (no wait on the main thread)
  if (opts.deferred)
    return it.rows.map((r) => {
      const one = { ...it, rows: [r] };
      const v = engine.deferredValue(() => statsRows(ws, engine, one, sampleId)[0]);
      return v.pending ? { ...v.value, value: 'computing…', note: null } : v.value;
    });
  return it.rows.map((r) => {
    const pop = r.population === 'root' ? 'All Events' : popById(ws, r.population)?.name ?? '?';
    const ch = r.channel && STAT_NEEDS_CHANNEL[r.stat] ? ` ${channelDisplayName(ws, r.channel, 'label')}` : '';
    const ofName = r.ofPopulation && r.ofPopulation !== 'root' ? popById(ws, r.ofPopulation)?.name ?? '?' : 'All Events';
    const stat = r.stat === 'percentile' ? `P${r.percentile ?? 50}` : r.stat === 'freqOf' ? `% of ${ofName}` : STAT_LABELS[r.stat];
    const label = r.header || `${pop}: ${stat}${ch}`;
    const na = !!sampleId && engine.statNotApplicable(ws, sampleId, r);
    const v = sampleId && !na ? engine.stat(ws, sampleId, r) : NaN;
    // channel statistics on fewer events than the population has (populations resolved like the value)
    const note = sampleId && !na && r.channel && STAT_NEEDS_CHANNEL[r.stat] ? excludedNote(engine.channelStats(ws, sampleId, resolveStatCol(ws, sampleId, r).population || 'root', r.channel)) : null;
    return { label, value: na ? 'n/a' : formatStat(v, r.stat), note };
  });
}

export function renderStatsBox(p: Painter, it: StatsBoxItem, ws: Workspace, engine: Engine, activeSampleId: string | null, opts: { deferred?: boolean } = {}) {
  const sid = it.sample === 'active' ? activeSampleId : it.sample;
  const th = itemTheme(it.bg, it.bgColor, pageColorOf(sheetOf(ws, it.id)));
  const st: TextStyle = { family: ws.style.fontFamily, size: it.fontSize * PT, color: th.fg, baseline: 'middle' };
  const rows = statsRows(ws, engine, it, sid && engine.has(sid) ? sid : null, opts);
  const lh = st.size * 1.45;
  const pad = 6;
  const sName = sid ? ws.samples.find((s) => s.id === sid)?.name ?? '' : 'No sample';
  p.rect(0, 0, it.w, it.h, { color: th.fg, width: 0.6 }, th.bg ? { color: th.bg } : null);
  const bst: TextStyle = { ...st, weight: 'bold' };
  // the sample name starts right of a panel letter sitting on the box
  const letter = panelLetterBox(ws, it.id);
  const hx = letter && letter.y < lh + 1 ? Math.max(pad, letter.x + letter.w + st.size * 0.4) : pad;
  p.text(hx, lh / 2 + 1, fitText(sName, it.w - hx - pad, bst), bst);
  p.line(0, lh + 1, it.w, lh + 1, { color: th.fg, width: 0.5 });
  const anyNote = rows.some((r) => r.note);
  // values on fewer events get a raised asterisk (same width in every row, so the values stay aligned)
  const star: RichText = [{ text: '*', sup: true }];
  const starW = anyNote ? measureRich(star, st) : 0;
  rows.forEach((r, i) => {
    const y = lh * (i + 1) + lh / 2 + 2;
    if (y > it.h) return;
    const vw = measureRich(r.value, st) + starW;
    // long labels end in an ellipsis before the value
    p.text(pad, y, fitText(r.label, Math.max(st.size, it.w - 2 * pad - vw - st.size * 0.8), st), st);
    p.text(it.w - pad - starW, y, r.value, { ...st, align: 'right' });
    if (r.note) p.text(it.w - pad - starW, y, star, st);
  });
  if (!rows.length) p.text(pad, lh * 1.5 + 2, fitText('Add statistics in the inspector', it.w - 2 * pad, st), { ...st, color: '#8a95a3' });
  if (anyNote) {
    // footnote below the rows (when there is room)
    const fst: TextStyle = { ...st, size: Math.max(st.size * 0.8, Math.min(st.size, 5.5 * PT)), color: th.dark ? '#b8c0ca' : '#5f6b7a' };
    const y = lh * (rows.length + 1) + fst.size * 0.9 + 3;
    if (y + fst.size * 0.5 <= it.h) p.text(pad, y, fitText('* Based on fewer events: some have no value in this channel', it.w - 2 * pad, fst), fst);
  }
}

export function renderItem(p: Painter, it: SheetItem, env: RenderEnv) {
  if (it.kind === 'plot') renderPlot(p, it, it.w, it.h, env);
  else if (it.kind === 'text') renderText(p, it, env.ws);
  else if (it.kind === 'chart') renderChart(p, it, env);
  else renderStatsBox(p, it, env.ws, env.engine, env.activeSampleId);
}

/** Render a set of items (or a whole worksheet) with the painter positioned at page coordinates. */
export function renderSheet(p: Painter, sheet: Worksheet, items: SheetItem[], env: RenderEnv, origin: { x: number; y: number }) {
  for (const it of items) {
    p.save();
    p.translate(it.x - origin.x, it.y - origin.y);
    p.clipRect(0, 0, it.w, it.h);
    renderItem(p, it, env);
    p.restore();
  }
  void sheet;
}

/**
 * Page background of an exported region `b` (page coordinates): the page color unless transparent, and the grid only
 * when the sheet asks for it in exports (on screen the grid is an editing aid).
 */
export function renderPageBackground(p: Painter, sheet: Worksheet, b: { x: number; y: number; w: number; h: number }, transparent: boolean) {
  if (!transparent && sheet.exportPage !== false) p.rect(0, 0, b.w, b.h, null, { color: sheet.pageColor ?? '#ffffff' });
  const style = sheetGridStyle(sheet);
  const g = sheet.grid;
  if (!sheet.exportGrid || style === 'none' || !(g > 0)) return;
  const color = sheet.gridColor ?? DEFAULT_GRID_COLOR;
  const op = sheetGridOpacity(sheet);
  const major = sheet.gridMajor ?? 0;
  const isMajor = (i: number) => major > 1 && i % major === 0;
  const i0 = Math.ceil(b.x / g);
  const i1 = Math.floor((b.x + b.w) / g);
  const j0 = Math.ceil(b.y / g);
  const j1 = Math.floor((b.y + b.h) / g);
  if (style === 'lines') {
    for (let i = i0; i <= i1; i++) p.line(i * g - b.x, 0, i * g - b.x, b.h, { color, width: 0.5, opacity: Math.min(1, op * (isMajor(i) ? 2.5 : 1)) });
    for (let j = j0; j <= j1; j++) p.line(0, j * g - b.y, b.w, j * g - b.y, { color, width: 0.5, opacity: Math.min(1, op * (isMajor(j) ? 2.5 : 1)) });
    return;
  }
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const r = isMajor(i) && isMajor(j) ? 1.1 : 0.6;
      p.ellipse(i * g - b.x, j * g - b.y, r, r, 0, null, { color, opacity: op });
    }
}
