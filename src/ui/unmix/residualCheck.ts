// Signal the reference controls do not explain: per event, the part of the detector signal left after unmixing
// (residual RMS over the detectors) relative to the signal itself. Samples whose stained events keep much more of their
// signal unexplained than the controls' positive events point to a fluorochrome (or autofluorescence) that has no
// control, a wrong control, or another detector setting.
import { engine } from '../../core/engine';
import type { Workspace } from '../../core/model';
import { resolveDetectors, unmix, type UnmixDef } from '../../core/unmix';

export interface ResidualFlag {
  sampleId: string;
  name: string;
  /** median relative residual of the sample's brighter events */
  median: number;
  /** median relative to the controls' */
  ratio: number;
  /** fraction of the sample's brighter events above the controls' 99th percentile */
  frac: number;
}

export interface ResidualCheck {
  /** reference: the largest median relative residual of the controls' positive events (each control's own median) */
  refMedian: number;
  /** a sample's event counts as "high residual" above this (3x the reference, between 0.2 and 0.9) */
  refHigh: number;
  /** samples checked (unmixed samples other than the controls) */
  checked: number;
  flags: ResidualFlag[];
}

/** A sample is flagged when its median is this many times the controls' ... */
export const RESIDUAL_RATIO = 2;
/** ... or when this fraction of its brighter events has a high residual (above refHigh). */
export const RESIDUAL_FRAC = 0.25;

function quantile(a: Float64Array | number[], q: number): number {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/**
 * Relative residual (residual RMS / signal RMS over the detectors) of up to `maxEvents` events of a sample, with the
 * signal RMS of each event; null when the sample lacks detectors or the unmixing fails.
 */
export function relativeResiduals(def: UnmixDef, sampleId: string, maxEvents = 3000): { rel: Float64Array; signal: Float64Array } | null {
  const sd = engine.samples.get(sampleId);
  if (!sd) return null;
  const idx = resolveDetectors(def, sd.ds.channels.map((c) => c.name));
  if (idx.some((i) => i < 0)) return null;
  const N = sd.ds.eventCount;
  const n = Math.min(N, maxEvents);
  if (n < 20) return null;
  const D = idx.length;
  const cols = idx.map(() => new Float32Array(n));
  for (let k = 0; k < n; k++) {
    const e = Math.floor((k * N) / n);
    for (let d = 0; d < D; d++) cols[d][k] = sd.ds.data[idx[d]][e];
  }
  let out: Float32Array[];
  try {
    out = unmix({ ...def, residual: 'rms' }, cols, cols.map((_, d) => d));
  } catch {
    return null;
  }
  const res = out[out.length - 1];
  const rel = new Float64Array(n);
  const signal = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s2 = 0;
    for (let d = 0; d < D; d++) s2 += cols[d][k] * cols[d][k];
    const s = Math.sqrt(s2 / D);
    signal[k] = s;
    rel[k] = s > 0 && Number.isFinite(res[k]) ? res[k] / s : NaN;
  }
  return { rel, signal };
}

/** Values of `rel` for events whose signal is at least the `q` quantile of the signal (the brighter events). */
function brighter(r: { rel: Float64Array; signal: Float64Array }, q: number): number[] {
  const thr = quantile(r.signal, q);
  const out: number[] = [];
  for (let k = 0; k < r.rel.length; k++) if (r.signal[k] >= thr && Number.isFinite(r.rel[k])) out.push(r.rel[k]);
  return out;
}

/**
 * Compare the unexplained signal of the workspace's unmixed samples with that of the controls (`controlIds`, positive
 * events = their brightest 5 %). The unstained sample and the controls themselves are not checked. Null when the
 * controls give no reference.
 */
export function residualCheck(ws: Workspace, def: UnmixDef, controlIds: string[], unstainedId: string | null, opts: { samples?: string[]; maxEvents?: number } = {}): ResidualCheck | null {
  // each control's positive events (its brightest 5 %): their median; the largest one is the reference (single bright
  // outliers, debris or saturated events of a control do not move it)
  const meds: number[] = [];
  for (const id of controlIds) {
    const r = relativeResiduals(def, id, opts.maxEvents);
    const v = r ? brighter(r, 0.95) : [];
    if (v.length >= 10) meds.push(quantile(v, 0.5));
  }
  if (!meds.length) return null;
  const refMedian = Math.max(...meds);
  const refHigh = Math.min(0.9, Math.max(0.2, 3 * refMedian));
  const skip = new Set([...controlIds, ...(unstainedId ? [unstainedId] : [])]);
  const ids = (opts.samples ?? ws.samples.map((s) => s.id)).filter((id) => !skip.has(id) && engine.has(id));
  const flags: ResidualFlag[] = [];
  let checked = 0;
  for (const id of ids.slice(0, 60)) {
    const r = relativeResiduals(def, id, opts.maxEvents);
    if (!r) continue;
    // the brighter half: stained events (the dim ones are mostly noise, which no spectrum explains)
    const v = brighter(r, 0.5);
    if (v.length < 20) continue;
    checked++;
    const median = quantile(v, 0.5);
    const frac = v.filter((x) => x > refHigh).length / v.length;
    const ratio = refMedian > 0 ? median / refMedian : Infinity;
    if ((ratio >= RESIDUAL_RATIO && median > 0.1) || frac >= RESIDUAL_FRAC) flags.push({ sampleId: id, name: ws.samples.find((s) => s.id === id)?.name ?? id, median, ratio, frac });
  }
  flags.sort((a, b) => b.frac - a.frac || b.ratio - a.ratio);
  return { refMedian, refHigh, checked, flags };
}
