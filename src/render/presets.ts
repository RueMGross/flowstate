// Style presets: appearance-only bundles of plot options (never channels, gates, scales or data smoothing).
import type { PlotItem, PlotOptions } from '../core/model';

/** Option keys that are pure appearance; presets and "copy style" touch only these. */
export const APPEARANCE_KEYS = [
  'colormap',
  'cmapReverse',
  'cmapStops',
  'densityScale',
  'colorRange',
  'colorBar',
  'dotSize',
  'dotShape',
  'dotOpacity',
  'drawOrder',
  'bg',
  'bgColor',
  'contourLines',
  'contourLineColor',
  'contourFill',
  'contourOutliers',
  'histFill',
  'histFillStyle',
  'histFillColor',
  'histLineWidth',
  'frame',
  'tickDir',
  'boldLabels',
  'lineWidth',
  'gateColor',
] as const satisfies readonly (keyof PlotOptions)[];

const REQUIRED = new Set<string>(['colormap', 'dotSize', 'contourOutliers', 'histFill', 'histLineWidth', 'frame', 'lineWidth']);

export type Appearance = Partial<Pick<PlotOptions, (typeof APPEARANCE_KEYS)[number]>>;

export interface StylePreset {
  id: string;
  label: string;
  /** appearance only: a preset never changes a plot's type (a zebra plot stays a zebra plot) */
  options: Appearance;
}

/** Every preset sets every key, so applying one fully replaces the previous look. */
const BASE: Required<Pick<Appearance, 'colormap' | 'cmapReverse' | 'densityScale' | 'colorRange' | 'colorBar' | 'dotShape' | 'dotOpacity' | 'drawOrder' | 'bg' | 'contourFill' | 'histFill' | 'frame' | 'tickDir' | 'boldLabels'>> & Appearance = {
  colormap: 'flowjo',
  cmapReverse: false,
  densityScale: 'log',
  colorRange: [0, 100],
  colorBar: 'none',
  dotShape: 'square',
  dotOpacity: 1,
  drawOrder: 'density',
  bg: 'white',
  contourFill: false,
  contourOutliers: true,
  histFill: true, // fill style unset: solid for one layer, tinted for overlays
  frame: true,
  tickDir: 'out',
  boldLabels: false,
};

export const PRESETS: StylePreset[] = [
  { id: 'classic', label: 'Classic pseudocolor', options: { ...BASE } },
  { id: 'viridis', label: 'Viridis on white', options: { ...BASE, colormap: 'viridis', histFillStyle: 'semi' } },
  { id: 'dark', label: 'Dark', options: { ...BASE, colormap: 'turbo', bg: 'dark', histFillStyle: 'semi' } },
  { id: 'print', label: 'Print (grayscale)', options: { ...BASE, colormap: 'gray', contourLineColor: '#000000', histFillColor: '#bdbdbd', gateColor: '#000000' } },
  // (ids kept for saved workspaces; these once also switched the plot type)
  { id: 'contour', label: 'Dark lines, open histograms', options: { ...BASE, contourLineColor: '#1f1f1f', histFillStyle: 'outline', histFill: false } },
  { id: 'zebra', label: 'Gradient histograms', options: { ...BASE, histFillStyle: 'gradient' } },
  { id: 'minimal', label: 'Minimal (open axes)', options: { ...BASE, frame: false, histFillStyle: 'semi' } },
];

export function presetById(id: string | undefined): StylePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Apply a preset to a (draft) plot item: its appearance options only (plot type, color mode and data stay). */
export function applyPreset(it: PlotItem, p: StylePreset) {
  const o = it.options as unknown as Record<string, unknown>;
  for (const k of APPEARANCE_KEYS) {
    const v = (p.options as Record<string, unknown>)[k];
    if (v !== undefined) o[k] = Array.isArray(v) ? [...v] : v;
    else if (!REQUIRED.has(k)) delete o[k];
  }
}

/** Copy the appearance of one plot to another (plot type and data settings stay). */
export function copyAppearance(dst: PlotOptions, src: PlotOptions) {
  const d = dst as unknown as Record<string, unknown>;
  const s = src as unknown as Record<string, unknown>;
  for (const k of APPEARANCE_KEYS) {
    const v = s[k];
    if (v === undefined) delete d[k];
    else d[k] = Array.isArray(v) ? [...v] : v;
  }
  dst.fontSize = src.fontSize;
  dst.gateLabel = src.gateLabel;
  dst.showTitle = src.showTitle;
  // gate labels on a background box (optional field, see render/figstyle.ts)
  const lb = (src as { labelBox?: boolean }).labelBox;
  if (lb) (dst as { labelBox?: boolean }).labelBox = true;
  else delete (dst as { labelBox?: boolean }).labelBox;
}
