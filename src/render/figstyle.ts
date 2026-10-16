// One typographic and color system for figures: sizes derived from the figure style (ws.style.fontSize), page-aware
// colors (light text on dark pages), extra optional item fields kept by workspace files, and text helpers.
import type { PlotItem, PlotOptions, SheetItem, TextItem, Workspace, Worksheet } from '../core/model';
import { luminance, mixHex } from './colormaps';

export const PT = 96 / 72;

/** Smallest gate label (pt). */
export const MIN_LABEL_PT = 6;
/** Smallest superscript / subscript (pt). */
export const MIN_SCRIPT_PT = 5;
/** Largest default panel letter (pt). */
export const MAX_PANEL_PT = 9;

/**
 * Body text size of the figure (pt): the sheet's own size when it has one (Worksheet.fontSize, e.g. a 14 pt slide next
 * to a 6 pt journal figure), else the workspace figure style.
 */
export function bodyPt(ws: Pick<Workspace, 'style'>, sheet?: Pick<Worksheet, 'fontSize'> | null): number {
  const s = sheet?.fontSize;
  if (typeof s === 'number' && Number.isFinite(s) && s > 0) return s;
  const v = ws.style?.fontSize;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 8;
}

/** Panel letters: body + 2 pt, bold, at most 9 pt (never smaller than the body). */
export function panelLabelPt(ws: Pick<Workspace, 'style'>, sheet?: Pick<Worksheet, 'fontSize'> | null): number {
  const b = bodyPt(ws, sheet);
  return Math.max(b, Math.min(MAX_PANEL_PT, b + 2));
}

/** Gate label size (px) for a plot font size (px): the body size, at least 6 pt. */
export function gateLabelPx(fsPx: number): number {
  return Math.max(fsPx, MIN_LABEL_PT * PT);
}

// ------------------------------------------------------------------ optional fields kept in workspace files

/**
 * Plot options this module adds (optional; older readers ignore them, the workspace repair keeps unknown fields):
 * - labelBox: gate labels on a background box (else a halo only)
 * - titleMode: 'auto' (missing: custom when `title` is set, else sample: population), 'population', 'sample' (sample:
 *   population) or 'custom' (the typed `title`)
 */
export type TitleMode = 'population' | 'sample' | 'custom';
export interface PlotOptionsX extends PlotOptions {
  labelBox?: boolean;
  titleMode?: TitleMode;
}
export const optsX = (o: PlotOptions): PlotOptionsX => o as PlotOptionsX;

/** The effective title mode of a plot. */
export function titleModeOf(o: PlotOptions): TitleMode {
  const m = optsX(o).titleMode;
  const typed = typeof o.title === 'string' && o.title !== '';
  // custom without a text (e.g. a plot made from another one, title cleared): automatic
  if (m === 'custom') return typed ? 'custom' : 'sample';
  if (m === 'population' || m === 'sample') return m;
  return typed ? 'custom' : 'sample';
}

/**
 * The histogram mode a y axis title names ("% of max", "Normalized to mode" -> normalized; "Count", "Events" -> count),
 * else null. Such a title follows the mode: one naming the other mode is not shown (see axis titles in render/plot.ts).
 */
export function histModeOfLabel(t: string): 'normalized' | 'count' | null {
  if (/^\s*(%\s*of\s*(max(imum)?|mode|peak)|normali[sz]ed(\s+to\s+(mode|max(imum)?|peak))?|%\s*max)\s*$/i.test(t)) return 'normalized';
  if (/^\s*(count|counts|events|number of events|event count)\s*$/i.test(t)) return 'count';
  return null;
}

/** Text item tagged as a panel letter of an item (optional extra fields, kept in saved workspaces). */
export type PanelLabelItem = TextItem & { tag?: 'panelLabel'; forItem?: string };
export const isPanelLabel = (i: SheetItem): i is PanelLabelItem => i.kind === 'text' && (i as PanelLabelItem).tag === 'panelLabel';

// ------------------------------------------------------------------ page colors

/** The worksheet holding an item. */
export function sheetOf(ws: Pick<Workspace, 'worksheets'>, itemId: string): Worksheet | undefined {
  return ws.worksheets.find((s) => s.items.some((i) => i.id === itemId));
}

export const pageColorOf = (sheet: Pick<Worksheet, 'pageColor'> | undefined | null): string => sheet?.pageColor ?? '#ffffff';
export const isDarkColor = (c: string): boolean => luminance(c) < 0.18;
export const pageIsDark = (sheet: Pick<Worksheet, 'pageColor'> | undefined | null): boolean => isDarkColor(pageColorOf(sheet));

/** Default text color on a page: near-black, light gray on dark pages. */
export function autoTextColor(sheet: Pick<Worksheet, 'pageColor'> | undefined | null): string {
  return pageIsDark(sheet) ? '#eef0f3' : '#000000';
}

/** Color of a text item: its own, or (none set, e.g. panel letters) the page's text color. */
export function textColorOf(it: Pick<TextItem, 'color'>, sheet: Pick<Worksheet, 'pageColor'> | undefined | null): string {
  return it.color || autoTextColor(sheet);
}

// ------------------------------------------------------------------ data colors on dark backgrounds

/** Brighter versions of the default palettes (gate and overlay colors) for dark backgrounds. */
const BRIGHT: Record<string, string> = {
  '#1f1f1f': '#eef0f3',
  '#d62728': '#ff6b6b',
  '#1f77b4': '#4dabf7',
  '#2ca02c': '#69db7c',
  '#ff7f0e': '#ffa94d',
  '#9467bd': '#c0a6ff',
  '#17becf': '#3bc9db',
  '#8c564b': '#d9a07b',
  '#e377c2': '#f783ac',
  '#7f7f7f': '#c3c9d0',
  '#bcbd22': '#d8e05a',
};

const contrast = (a: string, b: string) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/**
 * A data color that stands out on a dark background: the default palette colors map to brighter variants, other
 * colors are lightened until they reach a contrast of about 4.5:1.
 */
export function brightOn(c: string, bg: string): string {
  const k = c.toLowerCase();
  if (BRIGHT[k]) return BRIGHT[k];
  if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c)) return c;
  let out = c;
  for (let t = 0.15; t <= 0.9 && contrast(out, bg) < 4.5; t += 0.15) out = mixHex(c, '#ffffff', t);
  return out;
}

// ------------------------------------------------------------------ text helpers

/**
 * Shorten a name in the middle: "Specimen_001_H7_H07_018.fcs" -> "Specimen_00…07_018.fcs". `fits` tells whether a
 * candidate fits (e.g. measured width), else a character count is used.
 */
export function middleEllipsis(text: string, max: number | ((t: string) => boolean)): string {
  const fits = typeof max === 'number' ? (t: string) => [...t].length <= max : max;
  if (fits(text)) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length - 1;
  const build = (n: number) => {
    const head = Math.ceil(n / 2);
    const tail = n - head;
    return chars.slice(0, head).join('').trimEnd() + '…' + (tail > 0 ? chars.slice(chars.length - tail).join('').trimStart() : '');
  };
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(build(mid))) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

/**
 * Abbreviations of common words in population names, tried in order (each step on top of the earlier ones) before a
 * name is cut: "CD4 Single Positive" becomes "CD4 SP", "IFNg Positive" "IFNg+".
 */
const NAME_ABBREVIATIONS: [RegExp, string][] = [
  [/\bSingle[ -]Positive\b/gi, 'SP'],
  [/\bDouble[ -]Positive\b/gi, 'DP'],
  [/\bDouble[ -]Negative\b/gi, 'DN'],
  [/\s*\bPositive\b/gi, '+'],
  [/\s*\bNegative\b/gi, '-'],
  [/\bSingle\b/gi, 'S.'],
  [/\bDouble\b/gi, 'D.'],
  [/\s*\bpopulation\b/gi, ''],
];

/** Progressively abbreviated forms of a name (without the name itself; empty when no rule applies). */
export function nameAbbreviations(name: string): string[] {
  const out: string[] = [];
  let cur = name;
  for (const [re, rep] of NAME_ABBREVIATIONS) {
    const next = cur.replace(re, rep).replace(/\s{2,}/g, ' ').trim();
    if (next && next !== cur) {
      out.push(next);
      cur = next;
    }
  }
  return out;
}

/**
 * A name shortened until `fits`, kept apart from the `others` shown with it (e.g. the other gates of a plot): common
 * words are abbreviated first ("CD4 Single Positive" -> "CD4 SP"), then an ellipsis goes in the middle unless that
 * makes it look like another name ("CD…ve" for both "CD4 Single Positive" and "CD8 Single Positive"); then the
 * ellipsis moves so the distinguishing part stays ("CD4 S…").
 */
export function shortenName(name: string, fits: (t: string) => boolean, others: string[] = []): string {
  if (fits(name)) return name;
  const abbr = nameAbbreviations(name);
  for (const a of abbr) if (fits(a)) return a;
  const text = abbr.length ? abbr[abbr.length - 1] : name;
  const rivals = others.filter((o) => o !== name).flatMap((o) => [o, ...nameAbbreviations(o)]);
  const chars = [...text];
  const L = chars.length;
  const build = (h: number, t: number) => chars.slice(0, h).join('').trimEnd() + '…' + (t > 0 ? chars.slice(L - t).join('').trimStart() : '');
  const ambiguous = (h: number, t: number) => {
    const head = chars.slice(0, h).join('').trimEnd();
    const tail = t > 0 ? chars.slice(L - t).join('').trimStart() : '';
    return rivals.some((o) => o.startsWith(head) && o.endsWith(tail) && [...o].length > [...head].length + [...tail].length);
  };
  const mid = middleEllipsis(text, fits);
  const m = [...mid];
  const k = m.indexOf('…');
  if (!rivals.length || k < 0 || !ambiguous(k, m.length - k - 1)) return mid;
  // as many characters as fit, the ellipsis where the result names only this one (prefix first: "CD4 S…")
  for (let n = Math.min(L - 1, m.length + 1); n >= 1; n--)
    for (let h = n; h >= 0; h--) {
      const t = build(h, n - h);
      if (fits(t) && !ambiguous(h, n - h)) return t;
    }
  return mid;
}

/** Plots of a sheet whose panel letter sits on them (letter id -> item). */
export function panelLetterOf(sheet: Worksheet | undefined, item: Pick<PlotItem, 'id'>): PanelLabelItem | undefined {
  return sheet?.items.find((i): i is PanelLabelItem => isPanelLabel(i) && i.forItem === item.id);
}

// ------------------------------------------------------------------ page sizes

/**
 * Slide page sizes (PowerPoint / Keynote / Google Slides): 13.333 x 7.5 in (16:9 widescreen) and 10 x 7.5 in (4:3).
 * Offered with the journal and paper sizes of the model (PAGE_SIZES).
 */
export const SLIDE_SIZES: Record<string, { w: number; h: number }> = {
  'Slide 16:9 (338.7 x 190.5 mm)': { w: 1280, h: 720 },
  'Slide 4:3 (254 x 190.5 mm)': { w: 960, h: 720 },
};

/**
 * A sample or population name as one or two lines of at most `maxW`: whole if it fits, else split at a space, "_",
 * "-" or "." into two balanced lines, else shortened in the middle ("Specimen_00…H07_018").
 */
export function headerLines(name: string, maxW: number, measure: (t: string) => number): string[] {
  if (measure(name) <= maxW) return [name];
  let best: [string, string] | null = null;
  let bestW = Infinity;
  for (let i = 1; i < name.length; i++) {
    const c = name[i - 1];
    if (!/[\s_\-.]/.test(c)) continue;
    const a = name.slice(0, i).trimEnd();
    const b = name.slice(i).trimStart();
    const w = Math.max(measure(a), measure(b));
    if (w < bestW) {
      bestW = w;
      best = [a, b];
    }
  }
  if (best && bestW <= maxW) return best;
  return [middleEllipsis(name, (t) => measure(t) <= maxW)];
}
