// Pure helpers for the calibration view (formatting, channel guessing, presets). No React, no store.
import type { BeadKit } from '../../core/beads';
import type { MesfDerived, SizeDerived } from '../../core/derived';
import { riWater, resolveRI, type RISpec } from '../../core/mie';
import type { CollectionGeometry, ParticleModel } from '../../core/scattercal';
import type { ScaleDef } from '../../core/transforms';

// ---------------------------------------------------------------- formatting

/** Readable number: grouped integers from 1000, significant digits below, exponent for very large / small values. */
export function fmtNum(v: number | null | undefined, sig = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e9 || a < 1e-3) return v.toExponential(Math.max(0, sig - 1)).replace('e+', 'e');
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  return Number(v.toPrecision(sig)).toLocaleString('en-US', { maximumSignificantDigits: sig });
}

/** Diameter bands as text: "351 to 417 nm, 900 to 950 nm". */
export function nmBandsText(bands: ReadonlyArray<readonly [number, number]>): string {
  return bands.map(([a, b]) => (a === b ? `${fmtNum(a)} nm` : `${fmtNum(a)} to ${fmtNum(b)} nm`)).join(', ');
}

/** Fixed decimals or 'n/a'. */
export function fmtFix(v: number | null | undefined, d = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(d);
}

/** Signed percentage with fixed decimals. */
export function fmtPct(v: number | null | undefined, d = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return `${v > 0 ? '+' : ''}${v.toFixed(d)} %`;
}

/** Number for CSV / reports: up to 6 significant digits, no grouping. */
export function csvNum(v: number | null | undefined, sig = 6): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return String(Number(v.toPrecision(sig)));
}

/** CSV cell (quotes when needed). */
export function csvCell(v: string | number | null | undefined): string {
  if (typeof v === 'number') return csvNum(v);
  const s = v ?? '';
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

/** Kit name for display (no dashes as separators). */
export function kitName(kit: { name: string }): string {
  return kit.name.replace(/\s[–—]\s/g, ': ').replace(/[–—]/g, '-');
}

// ---------------------------------------------------------------- channels

/** Scatter channels (not time, not width), Area first. */
export function scatterChannelsOf(names: string[]): string[] {
  const sc = names.filter((n) => /FSC|SSC|^FS(\s|$|[-_])|^SS(\s|$|[-_])|scatter/i.test(n) && !/width|-W$|^time/i.test(n));
  return sc;
}

/** Violet side scatter (405 nm) detector name, e.g. VSSC-A, VSSC1-A, "Violet SSC-A", SSC_1-A. */
export function isVioletSsc(name: string, label = ''): boolean {
  const s = `${name} ${label}`;
  return /VSSC|violet[\s_-]*ssc|ssc[\s_-]*violet|SSC[_ ]1(?!\d)|405[\s_-]*SSC|SSC[\s_-]*405/i.test(s);
}

/** Default scatter channel for size calibration: violet SSC (Area) first, then SSC, then FSC. */
export function pickScatterChannel(chs: { name: string; label?: string }[]): string | null {
  const names = chs.map((c) => c.name);
  const sc = scatterChannelsOf(names);
  if (!sc.length) return null;
  const lab = (n: string) => chs.find((c) => c.name === n)?.label ?? '';
  const area = (n: string) => /-A$|area|INT/i.test(n);
  const pref = [
    (n: string) => isVioletSsc(n, lab(n)) && area(n),
    (n: string) => isVioletSsc(n, lab(n)),
    (n: string) => /SSC/i.test(n) && area(n),
    (n: string) => /SSC|^SS/i.test(n),
    (n: string) => area(n),
  ];
  for (const p of pref) {
    const f = sc.find(p);
    if (f) return f;
  }
  return sc[0];
}

/** Laser wavelength (nm) suggested by a scatter detector name (CytoFLEX naming: U/V/B/Y/R/IR SSC). */
export function wavelengthForChannel(name: string, label = ''): number {
  const s = `${name} ${label}`;
  if (isVioletSsc(name, label)) return 405;
  if (/USSC|UV[\s_-]*SSC/i.test(s)) return 375;
  if (/YSSC|yellow[\s_-]*SSC|561/i.test(s)) return 561;
  if (/IRSSC|808/i.test(s)) return 808;
  if (/RSSC|red[\s_-]*SSC|638|640/i.test(s)) return 638;
  return 488;
}

/** Fluorescence channels (not scatter / time / width). */
export function fluorChannelsOf(names: string[]): string[] {
  return names.filter((n) => !/FSC|SSC|^FS(\s|$|[-_])|^SS(\s|$|[-_])|^time|^event|width|-W$/i.test(n));
}

/** Prefer Area channels for calibration. */
export function preferArea(names: string[]): string[] {
  const a = names.filter((n) => /-A$|area|INT/i.test(n));
  return a.length ? [...a, ...names.filter((n) => !a.includes(n))] : names;
}

/** Kit fluorochrome whose values fit a channel (longest name contained in channel name or label), or ''. */
export function guessFluor(kit: BeadKit | undefined, channel: string, label = ''): string {
  if (!kit?.channels?.length) return '';
  const norm = (x: string) => x.toUpperCase().trim().replace(/[_\s]+/g, '-').replace(/-(A|H|W)$/, '');
  const parts = [channel, label].filter(Boolean).map(norm);
  const matches = (F: string) =>
    parts.some((p) => {
      for (let i = p.indexOf(F); i >= 0; i = p.indexOf(F, i + 1)) {
        const before = i === 0 ? '' : p[i - 1];
        const rest = p.slice(i + F.length);
        // whole token: 'PE' matches 'PE' but not 'PE-CY5' or 'APE'
        if (!/[A-Z0-9]/.test(before) && !/^[A-Z0-9]|^-[A-Z0-9]/.test(rest)) return true;
      }
      return false;
    });
  const hits = kit.channels
    .map((c) => c.fluorochrome)
    .filter((f) => matches(norm(f)))
    .sort((a, b) => b.length - a.length);
  if (hits.length) return hits[0];
  return kit.channels.length === 1 ? kit.channels[0].fluorochrome : '';
}

// ---------------------------------------------------------------- scales

/** Log display scale covering positive values (0.1 % .. 99.95 % quantiles, padded). */
export function positiveLogScale(values: Float32Array, pad = 1.6): ScaleDef {
  const step = Math.max(1, Math.floor(values.length / 100000));
  const s: number[] = [];
  for (let i = 0; i < values.length; i += step) if (values[i] > 0 && Number.isFinite(values[i])) s.push(values[i]);
  if (s.length < 2) return { type: 'log', min: 1, max: 1e6 };
  s.sort((a, b) => a - b);
  const lo = s[Math.floor(0.001 * (s.length - 1))];
  const hi = s[Math.ceil(0.9995 * (s.length - 1))];
  const min = Math.max(lo / pad, 1e-6);
  return { type: 'log', min, max: Math.max(hi * pad, min * 100) };
}

/** Decade-aligned log display scale for a derived output, from the smallest and largest relevant values. */
export function decadeLogScale(lo: number, hi: number): ScaleDef {
  const l = Math.floor(Math.log10(Math.max(lo, 1e-9)));
  let h = Math.ceil(Math.log10(Math.max(hi, lo * 10, 1e-8)));
  if (h <= l) h = l + 1;
  return { type: 'log', min: Math.pow(10, l), max: Math.pow(10, h) };
}

/** Positive values only (log peak finding puts values <= 0 into a spurious bin below the axis). */
export function positiveOnly(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > 0) n++;
  if (n === v.length) return v;
  const out = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > 0) out[k++] = v[i];
  return out;
}

// ---------------------------------------------------------------- scatter presets

export type GeomPreset = 'cytoflex' | 'bd' | 'fsc' | 'custom';

export const GEOMETRY_PRESETS: { id: GeomPreset; label: string; geometry: CollectionGeometry; note: string }[] = [
  {
    id: 'cytoflex',
    label: 'CytoFLEX VSSC (FCMPASS example: θ 90°, φ 90°, half-angle 53.2°)',
    geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 53.2, polarization: 'linear' },
    note: 'Example geometry from the FCMPASS documentation for a CytoFLEX violet SSC detector. The half-angle is a fit result for one instrument, not a specification: fit it from your beads.',
  },
  {
    id: 'bd',
    label: 'BD side scatter (θ 90°, φ 90°, half-angle about 52°)',
    geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 52, polarization: 'linear' },
    note: 'Typical side-scatter collection of a high-NA objective (NA about 1.0 to 1.2 in water). Fit the half-angle from your beads.',
  },
  {
    id: 'fsc',
    label: 'Forward scatter (θ 0°, half-angle 15°, obscuration 2.5°)',
    geometry: { thetaDeg: 0, phiDeg: 0, halfAngleDeg: 15, obscurationHalfAngleDeg: 2.5, polarization: 'linear' },
    note: 'Rough forward-scatter geometry: circular aperture with a circular stand-in for the obscuration bar. FSC of sub-micron particles is often below the noise; check with your beads.',
  },
  { id: 'custom', label: 'Custom geometry', geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 50, polarization: 'linear' }, note: 'Enter the detector axis (θ from the beam, φ from the polarization), the collection half-angle in the sheath and an optional obscuration.' },
];

export function defaultMediumRI(wavelengthNm: number): number {
  return Number(riWater(wavelengthNm).toFixed(5));
}

// ---------------------------------------------------------------- particle models

export type ModelDraft =
  | {
      kind: 'ev';
      core: number;
      shell: number;
      shellNm: number;
      /**
       * wavelength (nm) at which core and shell RIs are given; they are shifted with the dispersion of water to the
       * laser wavelength, as FCMPASS does (488). Unset: the RIs are taken as they are at the laser wavelength.
       */
      refNm?: number;
    }
  | { kind: 'sphere'; preset: 'polystyrene' | 'silica' | 'virus' | 'custom'; n: number };

export const MODEL_PRESETS: { value: string; label: string }[] = [
  { value: 'ev', label: 'Extracellular vesicle (core-shell)' },
  { value: 'virus', label: 'Virus / dense particle (sphere, n about 1.45 to 1.50)' },
  { value: 'polystyrene', label: 'Polystyrene sphere (dispersion)' },
  { value: 'silica', label: 'Silica sphere (fused silica dispersion)' },
  { value: 'custom', label: 'Homogeneous sphere, custom RI' },
];

export function modelPresetDraft(v: string): ModelDraft {
  switch (v) {
    case 'ev':
      return { kind: 'ev', core: 1.38, shell: 1.48, shellNm: 5, refNm: 488 };
    case 'virus':
      return { kind: 'sphere', preset: 'virus', n: 1.48 };
    case 'polystyrene':
      return { kind: 'sphere', preset: 'polystyrene', n: 1.59 };
    case 'silica':
      return { kind: 'sphere', preset: 'silica', n: 1.46 };
    default:
      return { kind: 'sphere', preset: 'custom', n: 1.45 };
  }
}

export function toParticleModel(m: ModelDraft): ParticleModel {
  if (m.kind === 'ev') {
    const ri = (n: number): RISpec => (m.refNm ? { material: 'water', n, atNm: m.refNm } : n);
    return { kind: 'coreShell', core: ri(m.core), shell: ri(m.shell), shellNm: m.shellNm, name: `EV (core ${m.core} / shell ${m.shell}${m.refNm ? ` at ${m.refNm} nm` : ''}, ${m.shellNm} nm)` };
  }
  if (m.preset === 'polystyrene') return { kind: 'sphere', ri: { material: 'polystyrene' }, name: 'Polystyrene sphere' };
  if (m.preset === 'silica') return { kind: 'sphere', ri: { material: 'silica' }, name: 'Silica sphere' };
  return { kind: 'sphere', ri: m.n, name: `${m.preset === 'virus' ? 'Virus-like sphere' : 'Sphere'} (n ${m.n})` };
}

export function fromParticleModel(p: ParticleModel): ModelDraft {
  if (p.kind === 'coreShell') {
    // RIs given at a reference wavelength with water dispersion (FCMPASS convention)
    const at = (x: RISpec) => (typeof x === 'object' && 'material' in x && x.material === 'water' && x.n !== undefined && x.atNm !== undefined ? x : null);
    const c = at(p.core);
    const sh = at(p.shell);
    if (c && sh && c.atNm === sh.atNm) return { kind: 'ev', core: c.n!, shell: sh.n!, shellNm: p.shellNm, refNm: c.atNm };
    return { kind: 'ev', core: riNumber(p.core, 405), shell: riNumber(p.shell, 405), shellNm: p.shellNm };
  }
  if (typeof p.ri === 'object' && 'material' in p.ri && p.ri.n === undefined) {
    if (p.ri.material === 'polystyrene') return { kind: 'sphere', preset: 'polystyrene', n: 1.59 };
    if (p.ri.material === 'silica') return { kind: 'sphere', preset: 'silica', n: 1.46 };
  }
  const n = riNumber(p.ri, 405);
  return { kind: 'sphere', preset: /virus/i.test(p.name ?? '') ? 'virus' : 'custom', n };
}

/** Real part of an RI spec at a wavelength. */
export function riNumber(spec: RISpec, lambdaNm: number): number {
  return resolveRI(spec, lambdaNm).re;
}

/** Short text for an RI spec, e.g. "polystyrene (1.627 at 405 nm)" or "1.43 at 589 nm (silica dispersion)". */
export function describeRI(spec: RISpec, lambdaNm: number): string {
  const n = riNumber(spec, lambdaNm).toFixed(4);
  if (typeof spec === 'number') return `${spec}`;
  if ('re' in spec) return `${spec.re}${spec.im ? ` + ${spec.im}i` : ''}`;
  if (spec.n !== undefined && spec.atNm !== undefined) return `${spec.n} at ${spec.atNm} nm (${spec.material} dispersion; ${n} at ${lambdaNm} nm)`;
  if (spec.n !== undefined) return `${spec.n}`;
  return `${spec.material} dispersion (${n} at ${lambdaNm} nm)`;
}

export function describeModel(p: ParticleModel, lambdaNm: number): string {
  if (p.kind === 'coreShell') return `core-shell sphere: core RI ${describeRI(p.core, lambdaNm)}, shell RI ${describeRI(p.shell, lambdaNm)}, shell ${p.shellNm} nm`;
  return `homogeneous sphere, RI ${describeRI(p.ri, lambdaNm)}`;
}

// ---------------------------------------------------------------- stored provenance (extra optional fields)

/** Provenance stored with an MESF calibration (beyond MesfDerived.beads; plain JSON in the workspace). */
export interface MesfProvenance {
  sampleId?: string;
  population?: string;
  populationName?: string;
  kitId?: string;
  fluor?: string;
  valuesSource?: 'kit-nominal' | 'kit-example' | 'user' | 'mixed';
  labels?: string[];
  counts?: number[];
  rcvPct?: number[];
  present?: boolean[];
  excluded?: number[];
  windows?: [number, number][] | null;
  blankRsd?: number;
  blankMedian?: number;
  rangeMfi?: number;
  /** indices (into medians) of beads flagged as compressed by detector saturation (left out unless kept by the user) */
  saturated?: number[];
}

export type MesfDef = MesfDerived & { beads?: NonNullable<MesfDerived['beads']> & MesfProvenance };

export interface SizeSetProvenance {
  sampleId?: string;
  sampleName?: string;
  population?: string;
  populationName?: string;
  kitId?: string;
  kitName?: string;
  lot?: string;
  valuesSource?: 'user' | 'kit-example' | 'kit-nominal' | 'mixed';
  noise?: boolean;
  noiseMedian?: number;
  windows?: [number, number][] | null;
  /** scatter channel of this bead set (unset: the calibration's channel) */
  channel?: string;
  beads: { label: string; diameterNm: number; ri: RISpec; use: boolean; assign: number | null; measured: number; count?: number; rcvPct?: number; edited?: boolean; saturated?: boolean; fit?: boolean }[];
}

export interface SizeFitExt {
  setups?: SizeSetProvenance[];
  nm2PerAu?: number;
  rmsLog?: number;
  geomPreset?: GeomPreset;
  sweepMin?: number;
  sweepMax?: number;
  validRangeNm?: [number, number];
  validSigmaNm2?: [number, number];
  endsAtMaximum?: boolean;
  /** the valid range ended where the curve turned flat (log-log slope below minLogSlope; calibrations saved before low-resolution bands) */
  endsAtFlat?: boolean;
  minLogSlope?: number;
  /** stretches (nm) inside the valid range with a log-log slope of σ(d) below minLogSlope: sized, low size resolution */
  lowResolutionNm?: [number, number][];
  /** range ending at a Mie maximum: diameters at its top whose signals larger particles also give */
  ambiguousNm?: [number, number] | null;
  /** the lower limit of the inversion range was set to the noise-equivalent diameter automatically */
  rangeFromNoise?: boolean;
  /** size resolution (% size error per 1 % scatter error) at representative diameters */
  resolution?: { diameterNm: number; pctPerPct: number }[];
  /** the bead fit failed the quality limits and was applied after explicit confirmation */
  poorFit?: { cvPct: number; maxResidualPct: number; confirmed: boolean };
  sizedBeads?: { label: string; diameterNm: number; sizedNm: number; sizeErrorPct: number; predicted: number; sigmaNm2: number }[];
  noiseFloor?: { au: number; sigmaNm2: number; diameterNm: number } | null;
  warnings?: string[];
  /** bead sets on several detectors: one shared half-angle, a factor per channel */
  channelFactors?: { channel: string; nm2PerAu: number; beads: number; cvPct: number }[];
}

export type SizeDef = SizeDerived & { fit?: NonNullable<SizeDerived['fit']> & SizeFitExt };
