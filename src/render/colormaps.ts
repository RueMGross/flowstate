// Colormaps as 256-entry RGB lookup tables, interpolated linearly between stops (the perceptual maps from 65 evenly
// spaced entries of their published LUTs: error < 3/255).
// Provenance (licenses and attributions: THIRD_PARTY_NOTICES.md):
// - viridis, magma, inferno, plasma: matplotlib LUTs by N. J. Smith, S. van der Walt, E. Firing (CC0 1.0)
// - cividis: Nunez, Anderton & Renslow, PLoS ONE 2018 (LUT as distributed with matplotlib)
// - turbo: Google LLC 2019, A. Mikhailov (Apache License 2.0)
// - haline, ice: cmocean, K. M. Thyng (MIT License)
// - Blues, Reds, Greens, Purples, Oranges, Greys, Spectral: ColorBrewer, C. Brewer, Penn State (Apache License 2.0)
// - jet, heat (= "hot"), rainbow: simple piecewise-linear / analytic definitions (as in matplotlib)
// - pseudocolor (internal key 'flowjo', kept for saved workspaces): hand-picked stops of a generic blue-green-yellow-red
//   ramp. Labels never use product names (no "<product>-like" maps).

type Stop = [number, string];

/** evenly spaced stops from a packed 'rrggbbrrggbb...' string */
const even = (hex: string): Stop[] => {
  const n = hex.length / 6;
  return Array.from({ length: n }, (_, i) => [i / (n - 1), '#' + hex.slice(i * 6, i * 6 + 6)] as Stop);
};
/** ColorBrewer 9-class sequential map from class 3 on (the palest classes vanish on white) */
const brewer = (classes: string[]): Stop[] => even(classes.slice(2).join(''));

export type CmapGroup = 'Classic' | 'Perceptual' | 'Single hue' | 'Other';

const MAPS: Record<string, { label: string; group: CmapGroup; stops: Stop[] }> = {
  // internal key kept for compatibility with saved workspaces (never shown in the UI)
  flowjo: {
    label: 'Pseudocolor (classic)',
    group: 'Classic',
    stops: [
      [0, '#0000c8'],
      [0.18, '#0080ff'],
      [0.36, '#00d8d8'],
      [0.52, '#20d020'],
      [0.7, '#f0f000'],
      [0.85, '#ff8000'],
      [1, '#e00000'],
    ],
  },
  jet: {
    label: 'Jet',
    group: 'Classic',
    stops: [
      [0, '#000080'],
      [0.11, '#0000ff'],
      [0.125, '#0000ff'],
      [0.34, '#00dcfe'],
      [0.35, '#00e4f8'],
      [0.375, '#16ffe1'],
      [0.64, '#eeff09'],
      [0.65, '#f8f500'],
      [0.66, '#feed00'],
      [0.89, '#ff1300'],
      [0.91, '#e80000'],
      [1, '#800000'],
    ],
  },
  rainbow: { label: 'Rainbow', group: 'Classic', stops: even('8000ff6032fe4062fa208ef400b5eb20d5e140ecd460fac580ffb49efaa2beec8eded579feb562ff8e4aff6232ff3219ff0000') },
  spectral: { label: 'Spectral', group: 'Classic', stops: even('5e4fa23288bd66c2a5abdda4e6f598ffffbffee08bfdae61f46d43d53e4f9e0142') },
  viridis: {
    label: 'Viridis',
    group: 'Perceptual',
    stops: even(
      '44015446075a470d6047136548186a481d6f482374482878472d7b46327e453781443b844240864045883e49893d4e8a3b528b39568c375b8d355f8d33638d31678e2f6b8e2e6f8e2c728e2a768e297a8e277e8e26828e25858e23898e228d8d21918c20938c1f978b1e9b8a1f9f881fa28721a68524aa8327ad812cb17e31b57b37b8783dbc7444bf704cc26c54c5685cc86365cb5e6ece5877d15381d34d8bd64695d840a0da39aadc32b5de2bc0df25cae11fd5e21adfe318eae51af4e61efde725',
    ),
  },
  magma: {
    label: 'Magma',
    group: 'Perceptual',
    stops: even(
      '00000402010903031206051a0a08220e0b2b130d34180f3d1d114722115029115a2f116336106b3d0f71440f764a107951127c57157e5d177f641a806a1c81701f817621817c2382832681892881902a81962c809c2e7fa3307eaa337db0357bb73779bc3978c23b75c83e73cf4070d5446ddb476ae04c67e55064ea5661ee5b5ef2625df4695cf7705cf9785dfa7f5efb8761fc8e64fd9668fe9d6cfea571feac76feb47bfebb81fec287feca8dfed194fed89afde0a1fde7a9fceeb0fcf6b8fcfdbf',
    ),
  },
  inferno: {
    label: 'Inferno',
    group: 'Perceptual',
    stops: even(
      '00000402010a04031207051b0b072410092d150b371b0c41210c4a280b532f0a5b3609613d0965440a684a0c6b510e6c57106e5d126e64156e6a176e71196e771c6d7d1e6d84206b8a226a9025689727669d2964a32c61a92e5eb0315bb63458bc3754c03a51c63d4dcb4149d04545d54a41da4e3cdf5337e35933e75e2eeb6429ee6a24f1711ff37819f67e14f8850ff98c0afa9407fb9b06fca309fcaa0ffcb216fbba1ffac228f9c932f7d13df5d949f4e156f2e865f1ef75f3f586f6fa96fcffa4',
    ),
  },
  plasma: {
    label: 'Plasma',
    group: 'Perceptual',
    stops: even(
      '0d088719068c2206902a059331059738049a3f049c46039f4c02a15302a35901a56001a66600a76c00a87201a87801a87e03a88405a78a09a58f0da49511a19a169fa01a9ca51f99aa2395ae2892b32c8eb7318abc3587c03a83c43e7fc8437bcc4778ce4b75d24f71d5546ed9586adc5d67df6263e26660e56b5de87059eb7556ed7a52f07f4ff2844bf48948f68f44f89441f99a3efb9f3afca537fdab33fdb130feb72dfebd2afdc328fdca26fcd025fbd724f9dd25f7e425f5eb27f2f227f0f921',
    ),
  },
  cividis: {
    label: 'Cividis (colorblind-safe)',
    group: 'Perceptual',
    stops: even(
      '00224e00255400285b002b62002e6a0030700533711235701a386f213b6e273e6e2d416d32436d36466c3b496c3f4c6c434e6c47516c4b546c4f576c535a6d565c6d5a5f6e5e626e61656f656870686a716c6d726f70737273747676767979777d7c787f7e788381798784788b87788f8a78928d789690779a93769e9676a29975a69c74aaa073aea371b3a670b7a96ebbad6dbfb06bc3b369c7b767ccba64d0be62d4c15fd9c55cddc858e1cc55e6d051ead34cefd748f3db42f8df3cfde334fee838',
    ),
  },
  turbo: {
    label: 'Turbo',
    group: 'Perceptual',
    stops: even(
      '30123b351e58392a733d358b4040a2424bb54456c74661d6466be34776ee4680f6458afc4294ff3d9efe37a8fa2fb2f428bceb22c5e21ccdd819d5cd18ddc219e3b91fe9af27eea432f2983ff68a4ef97d5dfc6f6dfe627dff568bff4b99fe42a4fc3cacfb38b7f735c1f334cbed34d4e735dde037e5d938ecd13af2c93af7c13afbb838fdae35fea431fe992cfd8d27fb8122f9751df56918f15d13ec530fe7490ce14109da3907d23105ca2a04c12302b71d02ac1701a11201950d018808027a0403',
    ),
  },
  haline: {
    label: 'Haline (blue-green-yellow)',
    group: 'Perceptual',
    stops: even(
      '2a186c2b19752d1a7f2e1c892e1d932d209c2a25a1252ca32033a21b3aa016409d12459b0f4a980d4f960c53940d57920f5b90125f8f15628e18668d1c698c1f6d8b22708a25748a2877892b7a892e7e89308189338588358888378c883a8f883c93873e9687409a86429e8544a18447a58349a8824cac804fb07e53b37c57b77a5bba7760be7465c1716bc56e72c86b79cb6781ce6489d06192d35e9cd55ca6d75cafd95db9db60c2dd64cadf69d2e16fdae375e2e57ce9e783f0ea8bf7ec92fdef9a',
    ),
  },
  heat: {
    label: 'Heat (black-red-yellow-white)',
    group: 'Other',
    stops: [
      [0, '#0b0000'],
      [0.365, '#ff0000'],
      [0.746, '#ffff00'],
      [1, '#ffffff'],
    ],
  },
  ice: { label: 'Ice (navy-blue-white)', group: 'Other', stops: even('0406132928513f4b96427bb761a8c79cd4daeafdfd') },
  gray: {
    label: 'Greys',
    group: 'Single hue',
    stops: [
      [0, '#bdbdbd'],
      [1, '#000000'],
    ],
  },
  blues: { label: 'Blues', group: 'Single hue', stops: brewer(['f7fbff', 'deebf7', 'c6dbef', '9ecae1', '6baed6', '4292c6', '2171b5', '08519c', '08306b']) },
  reds: { label: 'Reds', group: 'Single hue', stops: brewer(['fff5f0', 'fee0d2', 'fcbba1', 'fc9272', 'fb6a4a', 'ef3b2c', 'cb181d', 'a50f15', '67000d']) },
  greens: { label: 'Greens', group: 'Single hue', stops: brewer(['f7fcf5', 'e5f5e0', 'c7e9c0', 'a1d99b', '74c476', '41ab5d', '238b45', '006d2c', '00441b']) },
  purples: { label: 'Purples', group: 'Single hue', stops: brewer(['fcfbfd', 'efedf5', 'dadaeb', 'bcbddc', '9e9ac8', '807dba', '6a51a3', '54278f', '3f007d']) },
  oranges: { label: 'Oranges', group: 'Single hue', stops: brewer(['fff5eb', 'fee6ce', 'fdd0a2', 'fdae6b', 'fd8d3c', 'f16913', 'd94801', 'a63603', '7f2704']) },
};

/**
 * Names of colormaps that were removed, mapped to their replacement, so saved workspaces still open with a sensible map.
 * ('parula' approximated the proprietary MATLAB colormap of that name; it was replaced by cmocean's haline.)
 */
const LEGACY_CMAPS: Record<string, string> = { parula: 'haline' };

/** Current name of a colormap (resolves names of removed maps). */
export function resolveCmapName(name: string): string {
  return MAPS[name] ? name : LEGACY_CMAPS[name] ?? name;
}

/** Pseudo-name of the user-defined 2- or 3-stop gradient (PlotOptions.cmapStops). */
export const CUSTOM_CMAP = 'custom';
export const DEFAULT_CUSTOM_STOPS = ['#e8eef6', '#1463b8'];

export const COLORMAP_NAMES = Object.keys(MAPS);
export const COLORMAP_LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(LEGACY_CMAPS).map(([k, v]) => [k, MAPS[v].label])),
  ...Object.fromEntries(Object.entries(MAPS).map(([k, v]) => [k, v.label])),
  [CUSTOM_CMAP]: 'Custom gradient',
};
export const COLORMAP_GROUPS: Record<string, CmapGroup> = Object.fromEntries(Object.entries(MAPS).map(([k, v]) => [k, v.group]));

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(v)) return [0, 0, 0];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** Relative luminance (0 black .. 1 white), sRGB. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Linear mix of two colors (t = 0: a, 1: b). */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}

export interface CmapSpec {
  name: string;
  reverse?: boolean;
  stops?: string[]; // custom gradient colors (used when name === 'custom')
}

function stopsOf(spec: CmapSpec): Stop[] {
  if (spec.name === CUSTOM_CMAP) {
    const c = spec.stops && spec.stops.length >= 2 ? spec.stops.slice(0, 3) : DEFAULT_CUSTOM_STOPS;
    return c.map((h, i) => [i / (c.length - 1), h] as Stop);
  }
  return (MAPS[resolveCmapName(spec.name)] ?? MAPS.flowjo).stops;
}

const lutCache = new Map<string, Uint8Array>();

/** 256 x RGB lookup table of a colormap (name or spec incl. reverse / custom stops). */
export function colormapLUT(spec: string | CmapSpec): Uint8Array {
  const s: CmapSpec = typeof spec === 'string' ? { name: spec } : spec;
  const key = `${s.name}|${s.reverse ? 1 : 0}|${s.name === CUSTOM_CMAP ? (s.stops ?? []).join(',') : ''}`;
  const c = lutCache.get(key);
  if (c) return c;
  const lut = new Uint8Array(256 * 3);
  const stops = stopsOf(s).map(([t, h]) => [t, hexToRgb(h)] as const);
  for (let i = 0; i < 256; i++) {
    const t = (s.reverse ? 255 - i : i) / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * f);
  }
  lutCache.set(key, lut);
  return lut;
}

/** Color at t in [0,1] as hex. */
export function colormapColor(spec: string | CmapSpec, t: number): string {
  const lut = colormapLUT(spec);
  const i = Math.max(0, Math.min(255, Math.round(t * 255)));
  return rgbToHex(lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]);
}

/** CSS gradient of a colormap (sampled from the LUT, so reverse and custom stops are honoured). */
export function colormapCss(spec: string | CmapSpec, dir = '90deg'): string {
  const n = 16;
  const parts: string[] = [];
  for (let i = 0; i <= n; i++) parts.push(`${colormapColor(spec, i / n)} ${((100 * i) / n).toFixed(1)}%`);
  return `linear-gradient(${dir}, ${parts.join(', ')})`;
}
