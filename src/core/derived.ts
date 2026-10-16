// Derived (computed) channels: spectral unmixing, MESF/ERF fluorescence calibration, scatter size calibration.
// Definitions live in the workspace (Workspace.derived) and carry their output channel names, so the channel lists work
// without computing anything. The engine computes outputs lazily per sample and caches them.
import { calibratedRangePosition, toMesf, type MesfCalibratedRange } from './mesf';
import { buildSizeCurve, scatterToCrossSection, scatterToDiameter, type ParticleModel, type ScatterSetup } from './scattercal';
import { resolveDetectors, unmix, type UnmixDef } from './unmix';

export interface DerivedOutput {
  name: string;
  label?: string;
  range: number;
  /** physical unit of the values, shown with the channel name in axis titles, e.g. 'nm' for a diameter */
  unit?: string;
}

interface DerivedBase {
  id: string;
  name: string;
  outputs: DerivedOutput[];
  /** Restrict to these samples; default: every sample that has the input channels. */
  samples?: string[];
  created?: string;
}

export interface UnmixDerived extends DerivedBase {
  kind: 'unmix';
  unmix: UnmixDef;
  /** editor state (controls, populations) so the definition can be edited after reload */
  setup?: unknown;
}

export interface MesfDerived extends DerivedBase {
  kind: 'mesf';
  channel: string;
  unit: string; // MESF, ERF, MEFL, ABC ...
  fit: { method: 'log' | 'weightedLog' | 'linear'; slope: number; intercept: number; r2: number };
  /**
   * Range covered by the beads used in the fit: lowest and highest bead median (MFI) and their calibrated values
   * (`mesf`, in `unit`), plus the blank detection threshold if there was a blank. Values outside are extrapolated;
   * statistics tables mark them. Absent in workspaces saved before it was recorded (no marks then).
   */
  calibratedRange?: MesfCalibratedRange;
  /** Provenance for reporting (MIFlowCyt-EV): bead sample, kit, lot, medians and reference values. */
  beads?: { sampleName?: string; kit?: string; lot?: string; medians: number[]; refs: (number | null)[]; threshold?: number };
}

export interface SizeDerived extends DerivedBase {
  kind: 'size';
  channel: string;
  nm2PerAu: number;
  setup: ScatterSetup;
  model: ParticleModel;
  rangeNm?: [number, number];
  /**
   * Stretches where the log-log slope of σ(d) falls below this are reported as low size resolution (default
   * DEFAULT_MIN_LOG_SLOPE, 0.5). Definitions without `lowSlopeBands` (saved before) end the valid range there instead.
   */
  minLogSlope?: number;
  /**
   * true: low-slope stretches of a still rising σ(d) stay in the valid range (sized, reported as low-resolution bands);
   * the range ends only at a local maximum or the range limit. Absent (workspaces saved before this was introduced):
   * the range ends at the first low-slope stretch, as it did when the calibration was made, so stored results do not
   * change until the calibration is updated.
   */
  lowSlopeBands?: boolean;
  /** Bead fit summary for reporting. */
  fit?: { method: string; halfAngleDeg: number; r2Log: number; cvPct: number; beads: { name: string; diameterNm: number; measured: number; residualPct: number }[] };
}

export type DerivedDef = UnmixDerived | MesfDerived | SizeDerived;

/** Input channels a definition reads (detectors for unmixing). */
export function derivedInputs(d: DerivedDef): string[] {
  return d.kind === 'unmix' ? d.unmix.detectors : [d.channel];
}

export interface DerivedSource {
  /** raw (uncompensated) columns of the sample, indexed like the FCS channels */
  rawColumns: Float32Array[];
  rawNames: string[];
  /** channel values as used for gating (compensated, may itself be derived) */
  channel(name: string): Float32Array | null;
}

/** Compute the outputs of one definition for one sample, or null if the sample lacks inputs. */
export function computeDerived(d: DerivedDef, src: DerivedSource): Float32Array[] | null {
  if (d.kind === 'unmix') {
    const idx = resolveDetectors(d.unmix, src.rawNames);
    if (idx.some((i) => i < 0)) return null;
    return unmix(d.unmix, src.rawColumns, idx);
  }
  const v = src.channel(d.channel);
  if (!v) return null;
  // MFI <= 0 under a log fit -> 0 (the limit of the power law): the events keep their rank, so medians and percentiles
  // of dim populations are those of the MFI; the geometric mean uses the positive values only
  if (d.kind === 'mesf') return [toMesf(d.fit, v, { nonPositive: 'zero' })];
  const curve = buildSizeCurve(d.model, d.setup, {
    ...(d.rangeNm ? { rangeNm: d.rangeNm } : {}),
    ...(d.minLogSlope !== undefined ? { minLogSlope: d.minLogSlope } : {}),
    ...(d.lowSlopeBands ? {} : { endAtLowSlope: true }),
  });
  const out = [scatterToDiameter(curve, v, { nm2PerAu: d.nm2PerAu })];
  if (d.outputs.length > 1) out.push(scatterToCrossSection(v, d.nm2PerAu));
  return out;
}

/** Statistics that are intensity levels in the channel's unit (spreads and percentages are not compared with a range). */
const LEVEL_STATS = new Set(['mean', 'median', 'geomean', 'mode', 'percentile', 'min', 'max']);

/**
 * Note for a statistic of a calibrated fluorescence (MESF ...) channel whose value lies outside the bead range of its
 * calibration (extrapolated), else null. `stat`: StatKind of the column; only level statistics (mean, median,
 * geometric mean, mode, percentiles, min, max) are checked. Calibrations without a stored range give null.
 */
export function calibratedRangeNote(derived: readonly DerivedDef[] | undefined, channel: string | undefined, stat: string, value: number): string | null {
  if (!channel || !LEVEL_STATS.has(stat) || !Number.isFinite(value)) return null;
  const d = derived?.find((x) => x.kind === 'mesf' && x.outputs.some((o) => o.name === channel)) as MesfDerived | undefined;
  const r = d?.calibratedRange;
  if (!d || !r || !Array.isArray(r.mesf)) return null;
  const pos = calibratedRangePosition(r, value);
  if (pos !== 'below' && pos !== 'above') return null;
  const f = (v: number) => Number(v.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 6 });
  const thr = pos === 'below' && Number.isFinite(r.blankThresholdMesf) && value < (r.blankThresholdMesf as number) ? `; also below the detection threshold (${f(r.blankThresholdMesf as number)} ${d.unit})` : '';
  return `Outside the calibrated bead range (${f(r.mesf[0])} to ${f(r.mesf[1])} ${d.unit}): ${pos === 'below' ? 'below the dimmest' : 'above the brightest'} bead in the fit, extrapolated${thr}.`;
}

export function derivedSummary(d: DerivedDef): string {
  if (d.kind === 'unmix') return `${d.unmix.endmembers.length} fluorochromes, ${d.unmix.detectors.length} detectors, ${d.unmix.method.toUpperCase()}`;
  if (d.kind === 'mesf') return `${d.channel} to ${d.unit}, slope ${d.fit.slope.toFixed(3)}, R² ${d.fit.r2.toFixed(4)}`;
  return `${d.channel} to diameter, ${d.setup.wavelengthNm} nm, half-angle ${d.setup.geometry.halfAngleDeg.toFixed(1)}°, ${d.nm2PerAu.toPrecision(3)} nm²/a.u.`;
}
