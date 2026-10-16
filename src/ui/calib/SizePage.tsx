// Light-scatter size calibration page (Mie model as in FCMPASS, Welsh et al. 2020).
import { useEffect, useMemo, useState } from 'react';
import { getBeadKit, kitValueWarnings } from '../../core/beads';
import type { DerivedDef } from '../../core/derived';
import { engine } from '../../core/engine';
import { findBeadPeaks, type BeadPeak } from '../../core/mesf';
import type { RISpec } from '../../core/mie';
import { channelDisplayName, popPath, sampleHasChannel, uid, type Workspace } from '../../core/model';
import {
  apertureCrossSections,
  buildSizeCurve,
  DEFAULT_MIN_LOG_SLOPE,
  FCMPASS_EV_CORES,
  detectPileUp,
  fitCollectionAngle,
  scatterToDiameter,
  sizeResolution,
  sweepConstraint,
  type CollectionFit,
  type ScatterBead,
  type ScatterSetup,
  type SizeCurve,
} from '../../core/scattercal';
import { makeScale, type ScaleDef } from '../../core/transforms';
import { dataLogScale, defaultOutputName, derivedOutputValues, freeChannelName, upsertDerived } from '../../state/derivedOps';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { Check, Num, Sel, Seg, Txt } from '../widgets';
import { HistChart, logRange, XYChart, type HistWindow } from './charts';
import { addCalibPanelToSheet, sizeCurvePanel, sizeFitPanel } from './sheetPanels';
import { ApplyTargets, CalibList, clean, memoOn, Notes, PopulationPicker, popValues, ReportBox, SamplePicker, Stat, StepCard, useDeferredCompute } from './common';
import { emptySize, newSetId, useCalib, type BeadSetDraft, type SizeDraft } from './draft';
import { assignPeaks, guessSizeKit, kitShort, matchBeadPattern, rowsFromKit, sizeKits, sizeValuesSource } from './logic';
import {
  defaultMediumRI,
  describeModel,
  isVioletSsc,
  fmtFix,
  fmtNum,
  fmtPct,
  fromParticleModel,
  kitName,
  nmBandsText,
  GEOMETRY_PRESETS,
  MODEL_PRESETS,
  modelPresetDraft,
  pickScatterChannel,
  positiveLogScale,
  positiveOnly,
  riNumber,
  scatterChannelsOf,
  toParticleModel,
  wavelengthForChannel,
  type GeomPreset,
  type SizeDef,
  type SizeFitExt,
  type SizeSetProvenance,
} from './util';

const PS_MODEL = { kind: 'sphere' as const, ri: { material: 'polystyrene' as const } };

/**
 * Default scatter channel of a bead set: nanoViS High on the less sensitive violet SSC detector (CytoFLEX nano VSSC2,
 * "SSC_1-A") when the calibration channel is violet SSC, as in the published CytoFLEX nano protocol (the large beads
 * saturate VSSC1); undefined = the calibration channel.
 */
export function defaultSetChannel(ws: Workspace, sampleId: string | null, kitId: string, mainChannel: string | undefined): string | undefined {
  if (kitId !== 'beckman-nanovis-high' || !mainChannel || !sampleId) return undefined;
  const smp = ws.samples.find((q) => q.id === sampleId);
  if (!smp) return undefined;
  const lab = (n: string) => smp.channels.find((c) => c.name === n)?.label ?? '';
  if (!isVioletSsc(mainChannel, lab(mainChannel)) || /VSSC2|SSC_1-/i.test(`${mainChannel} ${lab(mainChannel)}`)) return undefined;
  const v2 = smp.channels.find((c) => c.name !== mainChannel && /-A$/i.test(c.name) && (/VSSC2/i.test(c.label ?? '') || /^SSC_1-A$/i.test(c.name)));
  return v2?.name;
}

export function guessSets(ws: Workspace, mainChannel?: string): BeadSetDraft[] {
  const sets: BeadSetDraft[] = [];
  for (const s of ws.samples) {
    if (!engine.has(s.id)) continue;
    const k = guessSizeKit(`${s.name} ${s.fileName}`);
    if (!k) continue;
    const kit = getBeadKit(k);
    const set: BeadSetDraft = { id: newSetId(), sampleId: s.id, population: 'root', kitId: k, beads: rowsFromKit(kit), noise: true, windows: null };
    const ch = defaultSetChannel(ws, s.id, k, mainChannel);
    if (ch) set.channel = ch;
    sets.push(set);
  }
  if (!sets.length) {
    const kit = getBeadKit('beckman-nanovis-low');
    sets.push({ id: newSetId(), sampleId: null, population: 'root', kitId: 'beckman-nanovis-low', beads: rowsFromKit(kit), noise: true, windows: null });
  }
  return sets;
}

function setupOf(d: SizeDraft): ScatterSetup {
  return { wavelengthNm: d.wavelength, nMedium: d.nMedium, geometry: { ...d.geometry } };
}

// ---------------------------------------------------------------- per-set detection

interface SetResult {
  values: Float32Array | null;
  error?: string;
  scale: ScaleDef | null;
  hist: { u0: number; u1: number; counts: Float32Array } | null;
  peaks: BeadPeak[];
  k: number;
  /** peak index per bead (-1 = none) */
  assign: number[];
  noisePeak: number;
  warnings: string[];
  /** significant peaks of the automatic detection (to compare with the kit) */
  nCandidates: number;
  /** scatter channel of the set */
  channel: string;
  /** per bead: its peak lies in the saturated range of the detector (excluded from the fit) */
  saturated: boolean[];
  /** a less sensitive detector of the same laser without pile-up for these events (suggested for saturated sets) */
  twin?: string;
  /** the peaks were chosen by the kit's brightness pattern (see matchBeadPattern) */
  matched?: boolean;
}

/** Lowest noise median (a.u.) of the bead sets measured on `channel`. */
function noiseOfChannel(results: SetResult[], channel: string): number {
  const meds = results.filter((r) => r.channel === channel).map((r) => (r.noisePeak >= 0 ? r.peaks[r.noisePeak]?.median : NaN)).filter((v) => v > 0);
  return meds.length ? Math.min(...meds) : NaN;
}

/** Scatter channel of a bead set (its own, else the calibration channel of step 1). */
export const setChannelOf = (d: Pick<SizeDraft, 'channel'>, s: Pick<BeadSetDraft, 'channel'>): string => s.channel || d.channel;

/** Height channel paired with an area channel ("SSC-A" -> "SSC-H", "SSC_1-A" -> "SSC_1-H"), if the sample has it. */
function heightOf(ws: Workspace, sampleId: string, ch: string): string | null {
  if (!/-A$/.test(ch)) return null;
  const h = ch.replace(/-A$/, '-H');
  return ws.samples.find((q) => q.id === sampleId)?.channels.some((c) => c.name === h) ? h : null;
}

const rangeOf = (ws: Workspace, sampleId: string, ch: string) => ws.samples.find((q) => q.id === sampleId)?.channels.find((c) => c.name === ch)?.range ?? 0;

/**
 * Saturation of the bead peaks: events piled up at the top of the detector (its -H channel, or the channel itself)
 * compress the bright peaks (CytoFLEX nano VSSC1 with nanoViS High: 304 to 1020 nm). A bead whose window holds >= 2 %
 * saturated events is flagged.
 */
function saturationCheck(ws: Workspace, s: BeadSetDraft, ch: string, a: Float32Array, peaks: BeadPeak[], assign: number[]): { saturated: boolean[]; note?: string; twin?: string } {
  const out = { saturated: s.beads.map(() => false) } as { saturated: boolean[]; note?: string; twin?: string };
  if (!s.sampleId) return out;
  const hName = heightOf(ws, s.sampleId, ch);
  const h = hName ? popValues(ws, s.sampleId, s.population, hName).values : null;
  const pa = memoOn(a, `pile${rangeOf(ws, s.sampleId, ch)}`, () => detectPileUp(a, rangeOf(ws, s.sampleId!, ch)));
  const ph = h && h.length === a.length ? memoOn(h, `pile${rangeOf(ws, s.sampleId, hName!)}`, () => detectPileUp(h, rangeOf(ws, s.sampleId!, hName!))) : null;
  if (!pa && !ph) return out;
  const flagged: string[] = [];
  s.beads.forEach((b, i) => {
    const p = assign[i] >= 0 ? peaks[assign[i]] : undefined;
    if (!p || !b.use) return;
    let n = 0;
    let k = 0;
    for (let j = 0; j < a.length; j++) {
      const v = a[j];
      if (!(v >= p.lo && v < p.hi)) continue;
      n++;
      if ((pa && v >= pa.level) || (ph && h![j] >= ph.level)) k++;
    }
    if (n > 0 && k / n >= 0.02) {
      out.saturated[i] = true;
      flagged.push(`${b.label} (${((100 * k) / n).toFixed(0)} %)`);
    }
  });
  if (!flagged.length) return out;
  // a less sensitive detector of the same laser in this sample whose height channel has no pile-up
  const smp = ws.samples.find((q) => q.id === s.sampleId)!;
  const lab = (n: string) => smp.channels.find((c) => c.name === n)?.label ?? '';
  const wl = wavelengthForChannel(ch, lab(ch));
  for (const c of scatterChannelsOf(smp.channels.map((x) => x.name))) {
    if (c === ch || !/-A$/.test(c) || wavelengthForChannel(c, lab(c)) !== wl || !/SSC/i.test(c)) continue;
    const hc = heightOf(ws, s.sampleId, c);
    const vals = popValues(ws, s.sampleId, s.population, hc ?? c).values;
    if (vals && !detectPileUp(vals, rangeOf(ws, s.sampleId, hc ?? c))) {
      out.twin = c;
      break;
    }
  }
  const pile = ph ?? pa!;
  const lc = (n: string) => (lab(n) && lab(n) !== n ? `${n} (${lab(n)})` : n);
  out.note = `Detector saturation: ${pile.count.toLocaleString('en-US')} events pile up at the maximum of ${lc(ph ? hName! : ch)}; ${flagged.join(', ')} lie in the saturated range and are left out of the fit (their medians are compressed).${out.twin ? ` Measure this bead set on the less sensitive detector ${lc(out.twin)} (bead sample setting "Scatter channel").` : ' Use a lower gain or a less sensitive detector for these beads.'}`;
  return out;
}

function analyseSet(ws: Workspace, d: SizeDraft, s: BeadSetDraft): SetResult {
  const ch = setChannelOf(d, s);
  const res: SetResult = { values: null, scale: null, hist: null, peaks: [], k: 0, assign: s.beads.map(() => -1), noisePeak: -1, warnings: [], nCandidates: 0, channel: ch, saturated: s.beads.map(() => false) };
  const pv = popValues(ws, s.sampleId, s.population, ch);
  if (!pv.values) {
    res.error = pv.error;
    const smp = ws.samples.find((q) => q.id === s.sampleId);
    if (smp && engine.has(smp.id) && ch && !sampleHasChannel(ws, smp.id, ch)) {
      const sc = scatterChannelsOf(smp.channels.map((c) => c.name));
      res.error += sc.length ? ` Its scatter channels: ${sc.join(', ')} (choose the detector of this bead sample or in step 1).` : ' It has no scatter channel.';
    }
    return res;
  }
  if (pv.error) res.warnings.push(pv.error);
  const values = memoOn(pv.values, 'pos', () => positiveOnly(pv.values!));
  res.values = values;
  if (values.length < 10) {
    res.error = `Only ${values.length} events with a positive ${ch} value.`;
    return res;
  }
  if (values.length < pv.values.length * 0.9) res.warnings.push(`${(100 - (100 * values.length) / pv.values.length).toFixed(0)} % of the events have ${ch} at or below 0 and are not shown.`);
  const used = s.beads.map((b, i) => (b.use ? i : -1)).filter((i) => i >= 0);
  const k = used.length + (s.noise ? 1 : 0);
  res.k = k;
  if (!k) return res;
  const scale = memoOn(values, 'scale', () => positiveLogScale(values));
  res.scale = scale;
  const auto = memoOn(values, `auto${k}`, () => findBeadPeaks(values, k, { scale }));
  res.hist = auto.histogram.counts.length ? { u0: auto.histogram.u0, u1: auto.histogram.u1, counts: auto.histogram.counts } : null;
  res.nCandidates = auto.candidates.length;
  const kitDef = getBeadKit(s.kitId);
  if (kitDef && !s.windows && res.nCandidates > k + 1)
    res.warnings.push(`The histogram shows ${res.nCandidates} peaks but "${kitName(kitDef)}" has ${used.length} beads${s.noise ? ' (plus noise)' : ''} in use: is this the right kit for this sample?`);
  const det = s.windows ? memoOn(values, `win${k}${JSON.stringify(s.windows.map((w) => w.map(String)))}`, () => findBeadPeaks(values, k, { scale, windows: s.windows! })) : auto;
  res.peaks = det.peaks;
  res.warnings.push(...det.warnings.filter((w) => !/^found \d+ of/.test(w)));
  // order beads by expected signal at the nominal geometry
  const setup = setupOf(d);
  const sig = s.beads.map((b) => (b.use ? apertureCrossSections({ kind: 'sphere', ri: b.ri }, [b.diameterNm], setup)[0] : 0));
  let P = det.peaks.length;
  let a = assignPeaks(s.beads, sig, P, s.noise);
  let matched = false;
  // automatic detection: when the largest peaks do not follow the kit's brightness pattern (aggregates, a bead in
  // the noise), choose the beads among all peaks by the pattern (see matchBeadPattern)
  // (a peak chosen by hand fixes the windows first, see BeadTable)
  if (!s.windows && !s.beads.some((b) => b.use && b.assign !== null)) {
    const all = memoOn(values, `all${k}`, () => findBeadPeaks(values, Math.max(k, 16), { scale, minEventsFraction: 0.01 }));
    const m = all.peaks.length > P || P < k ? matchBeadPattern(all.peaks, sig, used, s.noise) : null;
    if (m) {
      const near = (x: BeadPeak, y: BeadPeak) => Math.abs(x.u - y.u) < 0.01;
      const sameAsAuto = used.every((i) => (a.assign[i] < 0 ? m.assign[i] < 0 : m.assign[i] >= 0 && near(det.peaks[a.assign[i]], all.peaks[m.assign[i]])));
      // the automatic choice, scored the same way (its peaks are among all.peaks)
      if (!sameAsAuto) {
        const chosen = [...new Set([m.noisePeak, ...m.assign].filter((j) => j >= 0))].sort((x, y) => x - y);
        const at = new Map(chosen.map((j, i) => [j, i]));
        res.peaks = chosen.map((j) => all.peaks[j]);
        P = res.peaks.length;
        a = { assign: m.assign.map((j) => (j >= 0 ? at.get(j)! : -1)), noisePeak: m.noisePeak >= 0 ? at.get(m.noisePeak)! : -1, conflicts: [] };
        matched = true;
        res.matched = true;
        const left = all.peaks.length - chosen.length;
        res.warnings.push(
          `Beads chosen by the brightness pattern of the kit: ${left} other peak${left === 1 ? '' : 's'} (e.g. aggregates or debris) ${left === 1 ? 'is' : 'are'} left out${
            used.some((i) => a.assign[i] < 0) ? ', and the dimmest bead' + (used.filter((i) => a.assign[i] < 0).length > 1 ? 's are' : ' is') + ' taken to be in the noise' : ''
          }. Check the windows.`,
        );
      }
    }
  }
  res.assign = a.assign;
  res.noisePeak = a.noisePeak;
  for (const [p, i, j] of a.conflicts) res.warnings.push(`Peak #${p + 1} is assigned to both ${s.beads[i].label} and ${s.beads[j].label}.`);
  if (P < k && !matched) res.warnings.push(`Found ${P} of ${k} populations: the dimmest ${k - P === 1 ? 'bead is' : 'beads are'} probably merged with the noise. Untick beads below the noise floor or adjust the windows.`);
  const sat = saturationCheck(ws, s, ch, pv.values, res.peaks, a.assign);
  res.saturated = sat.saturated;
  res.twin = sat.twin;
  if (sat.note) res.warnings.unshift(sat.note);
  return res;
}

// ---------------------------------------------------------------- page

export function SizePage() {
  const ws = useStore((s) => s.ws);
  const dataVersion = useStore((s) => s.ui.dataVersion);
  const d = useCalib((s) => s.size);
  const set = useCalib((s) => s.setSize);
  const measured = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of ws.samples) for (const c of s.channels) if (!seen.has(c.name)) seen.set(c.name, c.label);
    return [...seen.entries()].map(([name, label]) => ({ name, label }));
  }, [ws.samples]);
  const measuredScatter = scatterChannelsOf(measured.map((c) => c.name));
  // computed channels (e.g. unmixed) that the bead samples have; size outputs themselves are not scatter inputs
  const computed = (ws.derived ?? [])
    .filter((x) => x.kind !== 'size')
    .flatMap((x) => x.outputs.map((o) => o.name))
    .filter((n) => !measuredScatter.includes(n) && d.sets.some((q) => q.sampleId && sampleHasChannel(ws, q.sampleId, n)));
  const scatter = [...measuredScatter, ...computed];
  const labelOf = (n: string) => measured.find((c) => c.name === n)?.label ?? '';

  // defaults
  useEffect(() => {
    if (!ws.samples.length) return;
    set((x) => {
      if (!x.channel || !scatter.includes(x.channel)) {
        const ch = pickScatterChannel(measured);
        if (ch) {
          x.channel = ch;
          x.wavelength = wavelengthForChannel(ch, labelOf(ch));
          if (x.nAuto) x.nMedium = defaultMediumRI(x.wavelength);
          if (x.wavelength !== 405 && x.preset === 'cytoflex') {
            x.preset = 'bd';
            x.geometry = { ...GEOMETRY_PRESETS[1].geometry };
          }
        }
      }
      if (!x.sets.length || x.sets.every((s) => !s.sampleId)) {
        const g = guessSets(ws, x.channel);
        if (g.some((s) => s.sampleId) || !x.sets.length) {
          x.sets = g;
          x.activeSet = 0;
        }
      }
    });
  }, [ws.samples.length, measuredScatter.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const setResults = useMemo(
    () => d.sets.map((s) => analyseSet(ws, d, s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.samples, ws.populations, ws.compensations, ws.derived, d.sets, d.channel, d.wavelength, d.nMedium, d.geometry, dataVersion],
  );

  // fit input: beads of all sets; sets on other detectors get their own factor (one shared half-angle)
  const fitInput = useMemo(() => {
    const beads: ScatterBead[] = [];
    const meas: number[] = [];
    const groups: number[] = [];
    const checkOnly: boolean[] = [];
    const chans = [...new Set([d.channel, ...d.sets.map((s) => setChannelOf(d, s))])].filter((c) => !!c && d.sets.some((s) => setChannelOf(d, s) === c));
    const multi = d.sets.length > 1;
    const multiCh = chans.length > 1;
    const short = d.sets.map((s) => kitShort(getBeadKit(s.kitId)));
    const sampleName = (id: string | null) => ws.samples.find((q) => q.id === id)?.name ?? 'no sample';
    d.sets.forEach((s, si) => {
      const r = setResults[si];
      const ch = setChannelOf(d, s);
      // two sets of the same kit (e.g. two runs of nanoViS High) are told apart by their sample
      const tag0 = short.filter((k) => k === short[si]).length > 1 ? `${short[si]}, ${sampleName(s.sampleId)}` : short[si];
      const tag = multiCh ? `${tag0}, ${ch}` : tag0;
      s.beads.forEach((b, i) => {
        beads.push({ diameterNm: b.diameterNm, ri: b.ri, label: multi ? `${b.label} (${tag})` : b.label });
        const p = r.assign[i];
        // beads in the saturated range of the detector are left out
        meas.push(b.use && p >= 0 && r.peaks[p] && !r.saturated[i] ? r.peaks[p].median : NaN);
        groups.push(Math.max(0, chans.indexOf(ch)));
        checkOnly.push(b.fit === false);
      });
    });
    return { beads, meas, groups, chans, checkOnly };
  }, [d.sets, d.channel, setResults, ws.samples]);
  const fitKey = JSON.stringify([fitInput, d.wavelength, d.nMedium, d.geometry, d.method, d.sweep]);
  const { value: fitRes, pending: fitPending } = useDeferredCompute((): { fit: CollectionFit | null; error?: string } => {
    const n = fitInput.meas.filter((v, i) => v > 0 && !fitInput.checkOnly[i]).length;
    if (!n) return { fit: null, error: 'No bead to fit has a measured median yet.' };
    try {
      const g = d.geometry;
      const fit = fitCollectionAngle(fitInput.beads, fitInput.meas, {
        wavelengthNm: d.wavelength,
        nMedium: d.nMedium,
        thetaDeg: g.thetaDeg,
        phiDeg: g.phiDeg,
        polarization: g.polarization,
        obscurationHalfAngleDeg: g.obscurationHalfAngleDeg,
        method: d.method === 'fixed' ? 'cv' : d.method,
        fixedHalfAngleDeg: d.method === 'fixed' ? g.halfAngleDeg : undefined,
        halfAngleRangeDeg: d.sweep,
        stepDeg: 0.1,
        groups: fitInput.groups,
        checkOnly: fitInput.checkOnly,
      });
      return { fit };
    } catch (e) {
      return { fit: null, error: (e as Error).message.replace(/^fitCollectionAngle: /, '') };
    }
  }, [fitKey]);
  const fit = fitRes?.fit ?? null;

  const model = useMemo(() => toParticleModel(d.model), [d.model]);
  const noiseAu = useMemo(() => noiseOfChannel(setResults, d.channel), [setResults, d.channel]);
  const curveKey = JSON.stringify([fit?.setup, fit?.nm2PerAu, model, d.rangeOn ? d.rangeNm : null, d.rangeAuto, d.minSlope, noiseAu]);
  const { value: curveRes, pending: curvePending } = useDeferredCompute((): CurveRes => {
    if (!fit) return { curve: null, noise: null, range: null, rangeFromNoise: false };
    let noise: NoiseInfo | null = null;
    try {
      const opts = { minLogSlope: d.minSlope };
      // the noise level in nm comes from the curve without a range limit
      const base = buildSizeCurve(model, fit.setup, opts);
      if (noiseAu > 0) {
        const sigma = noiseAu * fit.nm2PerAu;
        noise = { au: noiseAu, sigmaNm2: sigma, diameterNm: scatterToDiameter(base, Float64Array.of(sigma))[0] };
      }
      const r = effectiveRange(d, noise);
      return { curve: r.range ? buildSizeCurve(model, fit.setup, { ...opts, rangeNm: r.range }) : base, noise, range: r.range, rangeFromNoise: r.fromNoise };
    } catch (e) {
      return { curve: null, noise, range: null, rangeFromNoise: false, error: (e as Error).message.replace(/^buildSizeCurve: /, '') };
    }
  }, [curveKey]);
  const curve = fit ? curveRes?.curve ?? null : null;
  const noise = fit ? curveRes?.noise ?? null : null;

  const startEdit = (def: DerivedDef) => {
    if (def.kind !== 'size') return;
    const s = def as SizeDef;
    const f = s.fit;
    const preset: GeomPreset = f?.geomPreset ?? 'custom';
    set((x) => {
      Object.assign(x, emptySize());
      x.channel = s.channel;
      x.wavelength = s.setup.wavelengthNm;
      x.nMedium = s.setup.nMedium;
      x.nAuto = Math.abs(s.setup.nMedium - defaultMediumRI(s.setup.wavelengthNm)) < 1e-4;
      x.preset = preset;
      x.geometry = { ...s.setup.geometry };
      x.method = (f?.method as SizeDraft['method']) ?? 'fixed';
      if (f?.sweepMin !== undefined && f.sweepMax !== undefined) x.sweep = [f.sweepMin, f.sweepMax];
      x.model = fromParticleModel(s.model);
      x.rangeOn = !!s.rangeNm && !f?.rangeFromNoise;
      if (s.rangeNm) x.rangeNm = [...s.rangeNm];
      x.rangeAuto = !s.rangeNm || !!f?.rangeFromNoise;
      x.minSlope = s.minLogSlope ?? DEFAULT_MIN_LOG_SLOPE;
      x.sigmaOut = s.outputs.length > 1;
      x.applyAll = !s.samples;
      x.applyIds = s.samples ?? [];
      x.editId = s.id;
      x.sets = (f?.setups ?? []).map((p) => ({
        id: newSetId(),
        sampleId: (p.sampleId && ws.samples.some((q) => q.id === p.sampleId) ? p.sampleId : ws.samples.find((q) => q.name === p.sampleName)?.id) ?? null,
        population: p.population ?? 'root',
        kitId: p.kitId ?? 'custom-ps-size',
        beads: p.beads.map((b) => ({ label: b.label, diameterNm: b.diameterNm, ri: b.ri, use: b.use, assign: b.assign, edited: b.edited, ...(b.fit === false ? { fit: false } : {}) })),
        noise: !!p.noise,
        lot: p.lot,
        windows: p.windows ?? null,
        ...(p.channel && p.channel !== s.channel ? { channel: p.channel } : {}),
      }));
      x.outChannels = [s.channel];
      if (!x.sets.length) x.sets = guessSets(ws, s.channel);
      x.activeSet = 0;
    });
  };

  if (!ws.samples.length)
    return (
      <div className="cal-empty card">
        <div className="card-body">
          <h3>Calibrate light scatter in nm² and particle diameter</h3>
          <p className="hint">
            Load the FCS files of your size reference beads (e.g. Beckman nanoViS Low and High, ApogeeMix) together with your samples. The bead medians fit the collection geometry of the scatter detector with Mie theory (as FCMPASS does); a particle model (e.g. extracellular vesicles) then converts each event&apos;s scatter into a diameter.
          </p>
        </div>
      </div>
    );

  return (
    <>
      <StepCard n="" title="Scatter calibrations in this workspace">
        <CalibList kind="size" onEdit={startEdit} editingId={d.editId} />
      </StepCard>
      <InstrumentStep
        d={d}
        scatter={scatter}
        computed={computed}
        labelOf={labelOf}
        editing={ws.derived?.find((x) => x.id === d.editId)?.outputs[0]?.name}
        fitted={fit && fit.method !== 'fixed' ? fit.halfAngleDeg : undefined}
      />
      <BeadsStep d={d} results={setResults} />
      <FitStep d={d} fit={fit} error={fitRes?.error} pending={fitPending} results={setResults} chans={fitInput.chans} />
      <ModelStep d={d} fit={fit} curve={curve} curveRes={curveRes} pending={curvePending || fitPending} groups={fitInput.groups} chans={fitInput.chans} />
      <ApplyStep d={d} fit={fit} curve={curve} curveRes={curveRes} results={setResults} noise={noise} chans={fitInput.chans} model={model} />
    </>
  );
}

// ---------------------------------------------------------------- step 1: instrument

function InstrumentStep({
  d,
  scatter,
  computed,
  labelOf,
  editing,
  fitted,
}: {
  d: SizeDraft;
  scatter: string[];
  computed: string[];
  labelOf: (n: string) => string;
  editing?: string;
  /** collection half-angle fitted to the beads (step 3), when not fixed */
  fitted?: number;
}) {
  const set = useCalib((s) => s.setSize);
  const preset = GEOMETRY_PRESETS.find((p) => p.id === d.preset) ?? GEOMETRY_PRESETS[3];
  const g = d.geometry;
  const geo = (f: (x: SizeDraft) => void) =>
    set((x) => {
      f(x as SizeDraft);
      x.preset = 'custom';
    });
  return (
    <StepCard n={1} title="Scatter detector and optical setup" right={editing && <span className="badge comp">editing {editing}</span>}>
      {!scatter.length && <Notes tone="error" items={['No scatter channel (FSC / SSC) in the loaded samples: size calibration needs a scatter detector.']} />}
      {computed.includes(d.channel) && <Notes tone="info" items={[`${d.channel} is a computed channel: the size calibration is chained to its definition and follows it when that changes.`]} />}
      <div className="cal-grid">
        <div className="frow">
          <label>Scatter channel</label>
          <Sel
            value={d.channel}
            ariaLabel="Scatter channel"
            options={[
              ...(scatter.includes(d.channel) ? [] : [{ value: d.channel, label: d.channel ? `${d.channel} (not in the samples)` : 'Choose' }]),
              ...scatter.map((n) => ({ value: n, label: computed.includes(n) ? `${n} (computed)` : labelOf(n) && labelOf(n) !== n ? `${n} (${labelOf(n)})` : n })),
            ]}
            onChange={(v) =>
              set((x) => {
                x.channel = v;
                x.wavelength = wavelengthForChannel(v, labelOf(v));
                if (x.nAuto) x.nMedium = defaultMediumRI(x.wavelength);
                for (const s of x.sets) s.windows = null;
              })
            }
          />
        </div>
        <div className="frow" title="Laser wavelength of this scatter detector (violet SSC 405 nm, blue SSC/FSC 488 nm)">
          <label>Wavelength (nm)</label>
          <Num
            value={d.wavelength}
            min={300}
            max={1100}
            ariaLabel="Wavelength in nm"
            onChange={(v) =>
              set((x) => {
                x.wavelength = v;
                if (x.nAuto) x.nMedium = defaultMediumRI(v);
              })
            }
          />
        </div>
        <div className="frow" title="Refractive index of the sheath / suspension medium at the laser wavelength">
          <label>Medium RI</label>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <Num
              value={d.nMedium}
              step={0.001}
              digits={5}
              min={1}
              max={2}
              ariaLabel="Medium refractive index"
              onChange={(v) =>
                set((x) => {
                  x.nMedium = v;
                  x.nAuto = false;
                })
              }
            />
            <Check
              checked={d.nAuto}
              label="water"
              onChange={(v) =>
                set((x) => {
                  x.nAuto = v;
                  if (v) x.nMedium = defaultMediumRI(x.wavelength);
                })
              }
            />
          </div>
        </div>
        <div className="frow">
          <label>Geometry</label>
          <Sel
            value={d.preset}
            ariaLabel="Collection geometry preset"
            options={GEOMETRY_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(v) =>
              set((x) => {
                x.preset = v;
                if (v !== 'custom') x.geometry = { ...GEOMETRY_PRESETS.find((p) => p.id === v)!.geometry };
              })
            }
          />
        </div>
      </div>
      <p className="hint" style={{ margin: '0 0 8px' }}>
        {preset.note} Medium RI {d.nAuto ? `= water at ${d.wavelength} nm (Daimon and Masumura 2007)` : 'entered manually'}.
      </p>
      <div className="cal-geo">
        <label>
          θ (°)
          <Num value={g.thetaDeg} min={0} max={180} ariaLabel="Detector polar angle theta" onChange={(v) => geo((x) => void (x.geometry.thetaDeg = v))} />
        </label>
        <label>
          φ (°)
          <Num value={g.phiDeg} min={0} max={360} ariaLabel="Detector azimuth phi" onChange={(v) => geo((x) => void (x.geometry.phiDeg = v))} />
        </label>
        <label title={fitted !== undefined ? 'Geometry preset / start value. The beads fitted another half-angle (shown next to it), which the calibration uses.' : 'Start value; used as is with the fixed half-angle method'}>
          {fitted !== undefined ? 'Half-angle, preset (°)' : 'Half-angle (°)'}
          <Num value={g.halfAngleDeg} min={0.1} max={90} step={0.1} digits={2} ariaLabel="Collection half-angle (preset or start value)" onChange={(v) => geo((x) => void (x.geometry.halfAngleDeg = v))} />
        </label>
        {fitted !== undefined && (
          <label className="cal-fitted" title="Fitted to the reference beads in step 3; the calibration uses this value">
            Half-angle, fitted (°)
            <output className="cal-fitted-val" aria-label="Fitted collection half-angle">
              {fitted.toFixed(2)}
            </output>
          </label>
        )}
        <label>
          Obscuration (°)
          <Num value={g.obscurationHalfAngleDeg ?? 0} min={0} max={90} step={0.5} ariaLabel="Obscuration half-angle" onChange={(v) => geo((x) => void (x.geometry.obscurationHalfAngleDeg = v || undefined))} />
        </label>
        <label>
          Polarization
          <Sel value={g.polarization ?? 'linear'} ariaLabel="Polarization" options={[{ value: 'linear', label: 'Linear' }, { value: 'unpolarized', label: 'Unpolarized' }]} onChange={(v) => geo((x) => void (x.geometry.polarization = v))} />
        </label>
      </div>
    </StepCard>
  );
}

// ---------------------------------------------------------------- step 2: beads

function BeadsStep({ d, results }: { d: SizeDraft; results: SetResult[] }) {
  const ws = useStore((s) => s.ws);
  const set = useCalib((s) => s.setSize);
  const ai = Math.min(d.activeSet, Math.max(0, d.sets.length - 1));
  const s = d.sets[ai];
  const r = results[ai];
  const kit = s ? getBeadKit(s.kitId) : undefined;
  const upSet = (f: (x: BeadSetDraft) => void) =>
    set((x) => {
      const ss = x.sets[ai];
      if (ss) f(ss as BeadSetDraft);
    });
  const sampleName = (id: string | null) => ws.samples.find((q) => q.id === id)?.name ?? 'no sample';
  const smp = s ? ws.samples.find((q) => q.id === s.sampleId) : undefined;
  const setScatter = smp ? scatterChannelsOf(smp.channels.map((c) => c.name)) : [];
  const chLabel = (n: string) => {
    const l = smp?.channels.find((c) => c.name === n)?.label;
    return l && l !== n ? `${n} (${l})` : n;
  };
  return (
    <StepCard
      n={2}
      title="Reference beads"
      right={
        <button
          className="btn sm"
          onClick={() =>
            set((x) => {
              const used = new Set(x.sets.map((q) => q.sampleId));
              const next = ws.samples.find((q) => engine.has(q.id) && !used.has(q.id));
              const kid = (next && guessSizeKit(`${next.name} ${next.fileName}`)) ?? 'beckman-nanovis-high';
              const ch = defaultSetChannel(ws, next?.id ?? null, kid, x.channel);
              x.sets.push({ id: newSetId(), sampleId: next?.id ?? null, population: 'root', kitId: kid, beads: rowsFromKit(getBeadKit(kid)), noise: true, windows: null, ...(ch ? { channel: ch } : {}) });
              x.activeSet = x.sets.length - 1;
            })
          }
        >
          <Icon.plus /> Bead sample
        </button>
      }
    >
      <div className="row" role="tablist" aria-label="Bead samples" style={{ marginBottom: 8 }}>
        {d.sets.map((q, i) => {
          const used = q.beads.filter((b, j) => b.use && results[i]?.assign[j] >= 0).length;
          return (
            <span key={q.id} className={`chip${i === ai ? ' on' : ''}`} role="tab" tabIndex={0} aria-selected={i === ai} onClick={() => set((x) => void (x.activeSet = i))} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && set((x) => void (x.activeSet = i))}>
              {sampleName(q.sampleId)} · {kitShort(getBeadKit(q.kitId))} · {used}/{q.beads.length}
              {d.sets.length > 1 && (
                <button
                  className="chip-x"
                  aria-label={`Remove bead sample ${sampleName(q.sampleId)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    set((x) => {
                      x.sets.splice(i, 1);
                      x.activeSet = Math.max(0, Math.min(x.activeSet, x.sets.length - 1));
                    });
                  }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>
      {s && r && (
        <>
          <div className="cal-grid">
            <div className="frow">
              <label>Bead sample</label>
              <SamplePicker
                value={s.sampleId}
                ariaLabel="Bead sample"
                onChange={(v) =>
                  upSet((x) => {
                    x.sampleId = v;
                    x.windows = null;
                    for (const b of x.beads) b.assign = null;
                    const smp = ws.samples.find((q) => q.id === v);
                    const g = smp ? guessSizeKit(`${smp.name} ${smp.fileName}`) : null;
                    if (g && g !== x.kitId) {
                      x.kitId = g;
                      x.beads = rowsFromKit(getBeadKit(g));
                      x.lot = '';
                      x.channel = defaultSetChannel(ws, v, g, d.channel);
                    }
                  })
                }
              />
            </div>
            <div className="frow" title="Detector this bead sample is measured on. Bead samples on another detector of the same laser (e.g. nanoViS High on the less sensitive VSSC2) share the fitted half-angle and get their own calibration factor.">
              <label>Scatter channel</label>
              <Sel
                value={s.channel ?? ''}
                ariaLabel="Scatter channel of this bead sample"
                options={[
                  { value: '', label: `Step 1 channel (${d.channel || 'none'})` },
                  ...(s.channel && !setScatter.includes(s.channel) ? [{ value: s.channel, label: `${s.channel} (not in the sample)` }] : []),
                  ...setScatter.filter((n) => n !== d.channel).map((n) => ({ value: n, label: chLabel(n) })),
                ]}
                onChange={(v) =>
                  upSet((x) => {
                    x.channel = v || undefined;
                    x.windows = null;
                    for (const b of x.beads) b.assign = null;
                  })
                }
              />
            </div>
            <div className="frow">
              <label>Events</label>
              <PopulationPicker value={s.population} sampleId={s.sampleId} ariaLabel="Bead population" onChange={(v) => upSet((x) => void ((x.population = v), (x.windows = null)))} />
            </div>
            <div className="frow">
              <label>Bead kit</label>
              <Sel
                value={s.kitId}
                ariaLabel="Size bead kit"
                options={sizeKits().map((k) => ({ value: k.id, label: `${kitName(k)} (${k.vendor.split(' (')[0]})` }))}
                onChange={(v) =>
                  upSet((x) => {
                    x.kitId = v;
                    x.beads = rowsFromKit(getBeadKit(v));
                    x.windows = null;
                  })
                }
              />
            </div>
            <div className="frow" title="Also detect the background / noise population below the beads (it is not fitted; its median is reported as the noise level)">
              <label>Noise</label>
              <Check checked={s.noise} label="detect noise population" onChange={(v) => upSet((x) => void ((x.noise = v), (x.windows = null)))} />
            </div>
            <div className="frow">
              <label>Lot number</label>
              <Txt value={s.lot ?? ''} ariaLabel="Bead lot number" placeholder="from the certificate" onChange={(v) => upSet((x) => void (x.lot = v))} />
            </div>
          </div>
          {kit && (
            <>
              {sizeValuesSource(kit, s.beads) === 'kit-example' || sizeValuesSource(kit, s.beads) === 'mixed' ? (
                <Notes tone="error" items={[`The diameters of "${kitName(kit)}" are EXAMPLE certificate values of other lots: type the certificate values of your lot into the table.`]} />
              ) : sizeValuesSource(kit, s.beads) === 'kit-nominal' ? (
                <Notes tone="warn" items={kitValueWarnings(kit).map((w) => `${kitName(kit)}: ${clean(w)}.`)} />
              ) : null}
              <p className="hint" style={{ margin: '2px 0 8px' }}>
                {clean(kit.note)}
              </p>
            </>
          )}
          {r.error && <Notes tone="error" items={[r.error]} />}
          {r.hist && r.scale && <SetHistogram s={s} r={r} channel={r.channel} upSet={upSet} />}
          <BeadTable d={d} s={s} r={r} upSet={upSet} />
          <Notes tone="warn" items={r.warnings} />
          {r.twin && r.saturated.some(Boolean) && (
            <div className="row" style={{ marginTop: 4 }}>
              <button
                className="btn sm"
                onClick={() =>
                  upSet((x) => {
                    x.channel = r.twin === d.channel ? undefined : r.twin;
                    x.windows = null;
                    for (const b of x.beads) b.assign = null;
                  })
                }
              >
                Measure this bead sample on {chLabel(r.twin)}
              </button>
            </div>
          )}
        </>
      )}
    </StepCard>
  );
}

function SetHistogram({ s, r, channel, upSet }: { s: BeadSetDraft; r: SetResult; channel: string; upSet: (f: (x: BeadSetDraft) => void) => void }) {
  const ws = useStore((st) => st.ws);
  const win: HistWindow[] = r.peaks.map((p, j) => {
    const bi = r.assign.indexOf(j);
    const isNoise = j === r.noisePeak;
    return {
      lo: p.lo,
      hi: p.hi,
      median: p.median,
      label: bi >= 0 ? `${s.beads[bi].diameterNm} nm` : isNoise ? 'noise' : `#${j + 1}`,
      tone: bi >= 0 ? 'bead' : isNoise ? 'noise' : 'unassigned',
      tip: `#${j + 1}: median ${fmtNum(p.median)} a.u., rCV ${fmtFix(p.rcvPct, 1)} %, ${p.count.toLocaleString('en-US')} events`,
    };
  });
  const addWindow = () => {
    if (!r.scale || !r.hist) return;
    const sc = makeScale(r.scale);
    const { u0, u1 } = r.hist;
    const cur = r.peaks.map((p): [number, number] => [p.lo, p.hi]);
    const us = cur.map(([lo, hi]) => [Number.isFinite(lo) ? sc.fwd(lo) : u0, Number.isFinite(hi) ? sc.fwd(hi) : u1]).sort((a, b) => a[0] - b[0]);
    let best = [u0, u1];
    let prev = u0;
    let gap = -1;
    for (const [a, b] of [...us, [u1, u1]]) {
      if (a - prev > gap) {
        gap = a - prev;
        best = [prev, a];
      }
      prev = Math.max(prev, b);
    }
    const mid = (best[0] + best[1]) / 2;
    const half = Math.min((best[1] - best[0]) * 0.3, 0.03 * (u1 - u0));
    const nw: [number, number] = [sc.inv(mid - half), sc.inv(mid + half)];
    upSet((x) => {
      x.windows = [...cur, nw].sort((a, b) => (Number.isFinite(a[0]) ? a[0] : -1e300) - (Number.isFinite(b[0]) ? b[0] : -1e300));
      for (const b of x.beads) b.assign = null;
    });
  };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 2 }}>
        <span className="hint">
          {s.windows ? `Manual windows: ${r.peaks.length} for ${r.k} populations` : `Automatic detection: ${r.peaks.length} of ${r.k} populations`}
          {s.noise ? ' (incl. noise)' : ''}. Drag the window edges to adjust.
        </span>
        <span className="row">
          <button className="btn sm" onClick={addWindow} title="Add a window (switches to manual windows)">
            <Icon.plus /> Window
          </button>
          <button
            className="btn sm"
            disabled={!s.windows && s.beads.every((b) => b.assign === null)}
            onClick={() =>
              upSet((x) => {
                x.windows = null;
                for (const b of x.beads) b.assign = null;
              })
            }
            title="Discard manual windows and assignments; detect automatically"
          >
            <Icon.wand /> Re-detect
          </button>
        </span>
      </div>
      <HistChart
        counts={r.hist!.counts}
        u0={r.hist!.u0}
        u1={r.hist!.u1}
        scale={r.scale!}
        windows={win}
        height={200}
        xTitle={`${channel} (a.u., log${s.population !== 'root' ? `; ${popPath(ws, s.population)}` : ''})`}
        ariaLabel={`Histogram of ${channel} with bead windows`}
        onWindowsChange={(w) =>
          upSet((x) => {
            x.windows = w;
          })
        }
      />
      {s.windows && (
        <div className="row" style={{ marginTop: 4 }}>
          {r.peaks.map((p, j) => (
            <span key={j} className="chip">
              #{j + 1}: {fmtNum(p.lo)} to {fmtNum(p.hi)}
              <button
                className="chip-x"
                aria-label={`Remove window ${j + 1}`}
                onClick={() =>
                  upSet((x) => {
                    x.windows = r.peaks.filter((_, i) => i !== j).map((q): [number, number] => [q.lo, q.hi]);
                    for (const b of x.beads) b.assign = null;
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function BeadTable({ d, s, r, upSet }: { d: SizeDraft; s: BeadSetDraft; r: SetResult; upSet: (f: (x: BeadSetDraft) => void) => void }) {
  const lam = d.wavelength;
  const custom = s.kitId.startsWith('custom');
  const matOf = (ri: RISpec): string => (typeof ri === 'object' && 'material' in ri ? ri.material : 'other');
  return (
    <div className="tbl-wrap" style={{ marginTop: 8 }}>
      <table className="data cal-table">
        <thead>
          <tr>
            <th title="Bead is in the file and used (untick e.g. a bead below the noise floor)">Use</th>
            <th title="Used in the fit (factor and half-angle); an unticked bead is still detected and sized back as a check">Fit</th>
            <th className="left">Bead</th>
            <th>
              Diameter<span className="sub">nm</span>
            </th>
            <th className="left">Material</th>
            <th>
              RI<span className="sub">at {lam} nm</span>
            </th>
            <th className="left">Peak</th>
            <th>
              Median<span className="sub">a.u.</span>
            </th>
            <th>Events</th>
            <th>
              rCV<span className="sub">%</span>
            </th>
            {custom && <th />}
          </tr>
        </thead>
        <tbody>
          {s.beads.map((b, i) => {
            const p = r.assign[i] >= 0 ? r.peaks[r.assign[i]] : undefined;
            const n = riNumber(b.ri, lam);
            return (
              <tr key={i} className={b.use ? '' : 'off'}>
                <td>
                  <input type="checkbox" aria-label={`Use ${b.label}`} checked={b.use} onChange={(e) => upSet((x) => void ((x.beads[i].use = e.target.checked), (x.windows = null), x.beads.forEach((q) => (q.assign = null))))} />
                </td>
                <td>
                  <input type="checkbox" aria-label={`Fit ${b.label}`} disabled={!b.use} checked={b.use && b.fit !== false} onChange={(e) => upSet((x) => void (x.beads[i].fit = e.target.checked ? undefined : false))} />
                </td>
                <td className="left">{b.label}</td>
                <td>
                  <Num
                    value={b.diameterNm}
                    min={1}
                    max={100000}
                    ariaLabel={`Diameter of ${b.label} in nm`}
                    onChange={(v) =>
                      upSet((x) => {
                        x.beads[i].diameterNm = v;
                        x.beads[i].edited = true;
                        if (/^(PS|Silica) \d/.test(x.beads[i].label)) x.beads[i].label = x.beads[i].label.replace(/\d+(\.\d+)? nm/, `${v} nm`);
                      })
                    }
                  />
                </td>
                <td className="left">
                  <Sel
                    value={matOf(b.ri)}
                    ariaLabel={`Material of ${b.label}`}
                    options={[
                      { value: 'polystyrene', label: 'Polystyrene' },
                      { value: 'silica', label: 'Silica' },
                      { value: 'other', label: 'Fixed RI' },
                    ]}
                    onChange={(v) =>
                      upSet((x) => {
                        x.beads[i].ri = v === 'other' ? Number(n.toFixed(4)) : { material: v as 'polystyrene' | 'silica' };
                      })
                    }
                  />
                </td>
                <td title={typeof b.ri === 'object' && 'material' in b.ri && b.ri.n !== undefined ? `${b.ri.material} dispersion shifted to ${b.ri.n} at ${b.ri.atNm} nm` : undefined}>
                  <Num
                    value={Number(n.toFixed(4))}
                    step={0.001}
                    min={1}
                    max={3}
                    ariaLabel={`Refractive index of ${b.label} at ${lam} nm`}
                    onChange={(v) =>
                      upSet((x) => {
                        const ri = x.beads[i].ri;
                        x.beads[i].ri = typeof ri === 'object' && 'material' in ri ? { material: ri.material, n: v, atNm: lam } : v;
                        x.beads[i].edited = true;
                      })
                    }
                  />
                </td>
                <td className="left">
                  <Sel
                    value={b.assign === null ? 'auto' : String(b.assign)}
                    ariaLabel={`Peak of ${b.label}`}
                    options={[
                      { value: 'auto', label: `Auto${r.assign[i] >= 0 && b.assign === null ? ` (#${r.assign[i] + 1})` : b.use ? ' (none)' : ''}` },
                      ...r.peaks.map((q, j) => ({ value: String(j), label: `#${j + 1}: ${fmtNum(q.median)}${j === r.noisePeak ? ' (noise)' : ''}` })),
                    ]}
                    onChange={(v) =>
                      upSet((x) => {
                        // peaks chosen by the pattern: their windows become fixed, so the peak numbers stay what this list shows
                        if (r.matched && !x.windows) x.windows = r.peaks.map((q) => [q.lo, q.hi] as [number, number]);
                        x.beads[i].assign = v === 'auto' ? null : Number(v);
                      })
                    }
                  />
                </td>
                <td title={r.saturated[i] ? 'In the saturated range of the detector: left out of the fit' : undefined}>
                  {p ? fmtNum(p.median) : b.use ? <span className="cal-warn-text">not found</span> : ''}
                  {p && r.saturated[i] ? <span className="cal-warn-text"> saturated</span> : null}
                </td>
                <td>{p ? p.count.toLocaleString('en-US') : ''}</td>
                <td>{p ? fmtFix(p.rcvPct, 1) : ''}</td>
                {custom && (
                  <td>
                    <button className="icon-btn danger" aria-label={`Remove ${b.label}`} onClick={() => upSet((x) => void x.beads.splice(i, 1))}>
                      <Icon.trash />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 6 }}>
        <button
          className="btn sm"
          onClick={() =>
            upSet((x) => {
              const last = x.beads[x.beads.length - 1];
              const dnm = last ? Math.round(last.diameterNm * 1.5) : 100;
              const mat = s.kitId === 'custom-silica-size' ? 'silica' : 'polystyrene';
              x.beads.push({ label: `${mat === 'silica' ? 'Silica' : 'PS'} ${dnm} nm`, diameterNm: dnm, ri: { material: mat }, use: true, assign: null, edited: true });
              x.windows = null;
            })
          }
        >
          <Icon.plus /> Bead
        </button>
        <span className="hint">Enter the certificate mean diameters of your lot where they differ from the nominal ones. The RI is entered at the laser wavelength; for polystyrene and silica the dispersion curve is shifted to it.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- step 3: fit

/**
 * Half-angle to use when the beads do not constrain it: that of the latest fitted calibration at this wavelength, else
 * the CytoFLEX VSSC example (53.2°) for violet SSC, else the geometry preset's.
 */
export function suggestedHalfAngle(ws: Workspace, d: Pick<SizeDraft, 'wavelength' | 'channel' | 'preset' | 'editId'>): { deg: number; from: string } {
  const fitted = (ws.derived ?? [])
    .filter((x) => x.kind === 'size' && x.id !== d.editId)
    .map((x) => x as SizeDef)
    .filter((x) => x.fit && x.fit.method !== 'fixed' && x.setup.wavelengthNm === d.wavelength)
    .sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
  if (fitted.length) return { deg: Number(fitted[0].setup.geometry.halfAngleDeg.toFixed(1)), from: `the last fitted calibration ("${fitted[0].outputs[0]?.name ?? fitted[0].name}")` };
  if (d.wavelength === 405 || isVioletSsc(d.channel)) return { deg: 53.2, from: 'the CytoFLEX VSSC example of FCMPASS' };
  const p = GEOMETRY_PRESETS.find((q) => q.id === d.preset && q.id !== 'custom');
  return p ? { deg: p.geometry.halfAngleDeg, from: `the ${p.label.split(' (')[0]} preset` } : { deg: 53.2, from: 'the CytoFLEX VSSC example of FCMPASS' };
}

function FitStep({ d, fit, error, pending, results, chans }: { d: SizeDraft; fit: CollectionFit | null; error?: string; pending: boolean; results: SetResult[]; chans: string[] }) {
  const set = useCalib((s) => s.setSize);
  const ws = useStore((s) => s.ws);
  const used = fit ? fit.beads.filter((b) => b.used) : [];
  const warns: string[] = [];
  // the beads do not constrain the half-angle (best value at the sweep edge, or a flat criterion: e.g. only nanoViS Low,
  // all beads in the Rayleigh range): a known half-angle is better
  const cons = fit ? sweepConstraint(fit) : null;
  const weak = !!cons && (cons.atEdge || cons.flat);
  const sugg = suggestedHalfAngle(ws, d);
  if (fit) {
    // poor fit: check each bead set on its own against the step-1 geometry; a set whose peaks do not follow its kit's
    // brightness pattern (measured / modelled ratios scattered) is probably the wrong kit for that sample
    if (poorFitOf(fit)) {
      const setup = setupOf(d);
      const bad: string[] = [];
      d.sets.forEach((st, si) => {
        const r = results[si];
        const kit = getBeadKit(st.kitId);
        const ratios = st.beads
          .map((b, i) => (b.use && r?.assign[i] >= 0 && r.peaks[r.assign[i]] ? r.peaks[r.assign[i]].median / apertureCrossSections({ kind: 'sphere', ri: b.ri }, [b.diameterNm], setup)[0] : NaN))
          .filter((x) => x > 0 && Number.isFinite(x));
        if (!kit || ratios.length < 3) return;
        const lr = ratios.map(Math.log);
        const m = lr.reduce((a, b) => a + b, 0) / lr.length;
        const sd = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1));
        if (sd > Math.log(1.3)) bad.push(`"${ws.samples.find((q) => q.id === st.sampleId)?.name ?? 'bead sample'}" (${kitName(kit)})`);
      });
      if (bad.length && bad.length < d.sets.length)
        warns.push(`The peaks of ${bad.join(' and ')} do not follow the brightness pattern of the kit: is this the right kit for that sample?`);
      else if (bad.length)
        warns.push('No bead set follows the brightness pattern of its kit at the step-1 geometry: check the kits, the scatter channel and the geometry.');
    }
    warns.push(...fit.warnings.filter((w) => !(weak && /edge of the swept range/.test(w))));
    for (const b of used) if (Math.abs(b.residualPct) > 15) warns.push(`${b.label} deviates ${fmtPct(b.residualPct, 0)} from the model: wrong peak, or a diameter / RI that differs from the stated one?`);
    for (const b of used) if (Number.isFinite(b.sizeErrorPct) && Math.abs(b.sizeErrorPct) > 5) warns.push(`${b.label} sizes back to ${fmtNum(b.sizedNm)} nm (${fmtPct(b.sizeErrorPct, 1)}).`);
    for (const b of used) if (!Number.isFinite(b.sizedNm)) warns.push(`${b.label} cannot be sized back near its diameter (signal outside the model curve).`);
    // the smallest nanoViS bead: Beckman's application note lists it as 44 nm (nominal 40 nm in the kit table)
    d.sets.forEach((st) => {
      if (st.kitId !== 'beckman-nanovis-low' || !st.beads.some((b) => b.use && Math.abs(b.diameterNm - 40) < 0.5)) return;
      const row = fit.beads.find((b) => (b.used || b.check) && Math.abs(b.diameterNm - 40) < 0.5);
      warns.push(
        `nanoViS 40 nm bead: Beckman's CytoFLEX nano application note gives 44 nm for it${row && Number.isFinite(row.sizedNm) ? ` (it sizes back to ${fmtNum(row.sizedNm, 3)} nm here${row.check ? ', as a check: it is not used in the fit' : ''})` : ''}; enter the certificate value of your lot if you have it.`,
      );
    });
    results.forEach((r) => {
      if (r.noisePeak < 0) return;
      const nm = r.peaks[r.noisePeak]?.median;
      for (const p of r.assign) if (p >= 0 && nm && r.peaks[p].median < 3 * nm) warns.push(`A bead median (${fmtNum(r.peaks[p].median)} a.u.) is less than 3 x the noise median (${fmtNum(nm)} a.u.): it may be biased by noise.`);
    });
  }
  const sw = fit?.sweep;
  const yKey = fit?.method === 'lsq' ? 'rmsLog' : 'cvPct';
  const sweepY = sw ? Array.from(sw[yKey]) : [];
  const finiteY = sweepY.filter((v) => v > 0 && Number.isFinite(v));
  const [sy0, sy1] = finiteY.length ? logRange(finiteY, 1.5, 10) : [1, 100];
  const preds = used.map((b) => b.predicted);
  const meas = used.map((b) => b.measured);
  const [m0, m1] = logRange([...preds, ...meas], 2);
  return (
    <StepCard
      n={3}
      title="Fit the collection half-angle"
      right={
        <div className="row">
          <Seg
            value={d.method}
            options={[
              { value: 'cv', label: 'CV (FCMPASS)', title: 'Sweep the half-angle; choose the lowest CV of measured/predicted ratios (Welsh et al. 2020)' },
              { value: 'lsq', label: 'Least squares', title: 'Sweep the half-angle; choose the lowest RMS residual of log10(measured) vs log10(F·σ)' },
              { value: 'fixed', label: 'Fixed half-angle', title: 'Use the half-angle of step 1 (known geometry); only the factor is fitted' },
            ]}
            onChange={(v) => set((x) => void (x.method = v))}
          />
        </div>
      }
    >
      {error && <Notes tone={/No bead/.test(error) ? 'warn' : 'error'} items={[error.endsWith('.') ? error : `${error}.`]} />}
      {pending && <p className="hint">Fitting…</p>}
      {fit && weak && (
        <div className="cal-confirm">
          <Notes
            tone="error"
            items={[
              `The beads do not determine the half-angle: ${cons!.atEdge ? `the best value (${fit.halfAngleDeg.toFixed(1)}°) is at the edge of the swept range` : 'the fit criterion is nearly flat over a wide range of angles'}${
                fit.beads.filter((b) => b.used).every((b) => b.diameterNm <= 160) ? ' (all beads are small: their relative brightness hardly depends on the angle)' : ''
              }. Use the fixed half-angle method with a known half-angle, e.g. ${sugg.deg}° from ${sugg.from}, or add larger beads (e.g. nanoViS High on a less sensitive detector).`,
            ]}
          />
          <button
            className="btn sm primary"
            onClick={() =>
              set((x) => {
                x.method = 'fixed';
                x.geometry.halfAngleDeg = sugg.deg;
              })
            }
          >
            Use fixed half-angle {sugg.deg}°
          </button>
        </div>
      )}
      {fit && (
        <div style={{ opacity: pending ? 0.6 : 1 }}>
          <div className="cal-statgrid wide">
            <Stat label="Half-angle" value={`${fit.halfAngleDeg.toFixed(1)}°`} sub={fit.method === 'fixed' ? 'fixed' : `fitted (${fit.method === 'cv' ? 'CV' : 'least squares'})${chans.length > 1 ? `, shared by ${chans.length} detectors` : ''}`} />
            {chans.length > 1 ? (
              chans.map((ch, g) => (
                <Stat
                  key={ch}
                  label={`Factor ${ch}`}
                  value={`${fmtNum(fit.groupFactors[g]?.nm2PerAu, 4)} nm²/a.u.`}
                  sub={`${fit.groupFactors[g]?.n ?? 0} beads${Number.isFinite(fit.groupFactors[g]?.cvPct) && (fit.groupFactors[g]?.n ?? 0) > 1 ? `, CV ${fmtFix(fit.groupFactors[g].cvPct, 1)} %` : ''}`}
                  title={`σ (nm²) = ${ch} a.u. x factor`}
                />
              ))
            ) : (
              <Stat label="Factor" value={`${fmtNum(fit.nm2PerAu, 4)} nm²/a.u.`} sub={`${fmtNum(fit.auPerNm2, 4)} a.u. per nm²`} title="σ (nm²) = a.u. x factor (FCMPASS calibration factor)" />
            )}
            <Stat label="CV of ratios" value={`${fmtFix(fit.cvPct, 2)} %`} sub={`${used.length} beads`} />
            <Stat label="R² (log)" value={fmtFix(fit.r2Log, 5)} sub={`RMS log10 ${fmtFix(fit.rmsLog, 4)}`} />
          </div>
          <div className="cal-two">
            {sw && sw.halfAngleDeg.length > 0 ? (
              <XYChart
                height={220}
                ariaLabel="Fit criterion versus collection half-angle"
                x={{ type: 'lin', min: Math.max(0, d.sweep[0] - 1), max: Math.min(90, d.sweep[1] + 1), title: 'Collection half-angle (°)' }}
                y={{ type: 'log', min: sy0, max: sy1, title: fit.method === 'lsq' ? 'RMS log10 residual' : 'CV of measured/predicted (%)' }}
                series={[{ kind: 'line', x: sw.halfAngleDeg, y: sweepY, color: 'var(--accent)', width: 1.6 }]}
                anno={{ vlines: [{ x: fit.halfAngleDeg, color: 'var(--sel)', label: `${fit.halfAngleDeg.toFixed(1)}°` }] }}
              />
            ) : (
              <div className="cal-placeholder hint">Fixed half-angle: no sweep. Use the CV or least-squares method to fit it from the beads (needs at least 2, better 4 or more beads spanning the Mie resonances).</div>
            )}
            <XYChart
              height={220}
              ariaLabel="Measured versus predicted bead scatter"
              x={{ type: 'log', min: m0, max: m1, title: 'Predicted F·σ (a.u.)' }}
              y={{ type: 'log', min: m0, max: m1, title: 'Measured median (a.u.)' }}
              series={[
                { kind: 'line', x: [m0, m1], y: [m0, m1], color: 'var(--text-3)', dash: '4 3', width: 1.2 },
                { kind: 'points', x: preds, y: meas, color: 'var(--sel)', labels: used.map((b) => `${b.diameterNm}`), tips: used.map((b) => `${b.label}: measured ${fmtNum(b.measured)} a.u., predicted ${fmtNum(b.predicted)} (${fmtPct(b.residualPct)})`) },
              ]}
              legend={[
                { name: 'beads (label: nm)', color: 'var(--sel)', marker: 'dot' },
                { name: 'measured = predicted', color: 'var(--text-3)', dash: '4 3', marker: 'line' },
              ]}
            />
          </div>
          <div className="row" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
            <button
              className="btn sm"
              title="Place the bead fit (measured versus predicted) on the active worksheet as a figure panel, with the half-angle, CV and R²"
              onClick={() => addCalibPanelToSheet(sizeFitPanel({ channel: chans.length > 1 ? chans.join(' / ') : d.channel, beads: fit.beads, halfAngleDeg: fit.halfAngleDeg, cvPct: fit.cvPct, r2Log: fit.r2Log, fixed: fit.method === 'fixed' }))}
            >
              <Icon.plus /> Add bead fit to sheet
            </button>
          </div>
          <div className="tbl-wrap" style={{ marginTop: 8 }}>
            <table className="data cal-table">
              <thead>
                <tr>
                  <th className="left">Bead</th>
                  <th>
                    Diameter<span className="sub">nm</span>
                  </th>
                  <th>
                    Measured<span className="sub">a.u.</span>
                  </th>
                  <th>
                    σ model<span className="sub">nm²</span>
                  </th>
                  <th>
                    Predicted<span className="sub">a.u.</span>
                  </th>
                  <th>
                    Residual<span className="sub">%</span>
                  </th>
                  <th>
                    Sized back<span className="sub">nm</span>
                  </th>
                  <th>
                    Size error<span className="sub">%</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {fit.beads.map((b, i) => (
                  <tr key={i} className={b.used || b.check ? '' : 'off'}>
                    <td className="left">
                      {b.label}
                      {b.check ? <span className="hint"> (check, not fitted)</span> : null}
                    </td>
                    <td>{fmtNum(b.diameterNm)}</td>
                    <td>{b.used || b.check ? fmtNum(b.measured) : <span className="hint">not used</span>}</td>
                    <td>{fmtNum(b.sigmaNm2)}</td>
                    <td>{fmtNum(b.predicted)}</td>
                    <td className={b.used && Math.abs(b.residualPct) > 15 ? 'cal-bad' : ''}>{b.used || b.check ? fmtPct(b.residualPct, 1) : ''}</td>
                    <td>{b.used || b.check ? fmtNum(b.sizedNm) : ''}</td>
                    <td className={b.used && Math.abs(b.sizeErrorPct) > 5 ? 'cal-bad' : ''}>{b.used || b.check ? fmtPct(b.sizeErrorPct, 1) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            Sized back: the diameter at which each bead&apos;s own material reproduces its measured median under this calibration (should match the stated diameter within a few %).
          </p>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="hint">Swept half-angles</span>
            <Num value={d.sweep[0]} min={0.1} max={89} step={1} ariaLabel="Sweep from (degrees)" onChange={(v) => set((x) => void (x.sweep = [v, Math.max(v + 1, x.sweep[1])]))} />
            <span className="hint">to</span>
            <Num value={d.sweep[1]} min={1} max={90} step={1} ariaLabel="Sweep to (degrees)" onChange={(v) => set((x) => void (x.sweep = [Math.min(x.sweep[0], v - 1), v]))} />
            <span className="hint">° in 0.1° steps</span>
          </div>
        </div>
      )}
      <Notes tone="warn" items={warns} />
    </StepCard>
  );
}

// ---------------------------------------------------------------- step 4: model and size curve

/** Noise population median (lowest of the bead sets) in a.u., nm² and nm (model curve without range limit). */
interface NoiseInfo {
  au: number;
  sigmaNm2: number;
  diameterNm: number;
}

interface CurveRes {
  curve: SizeCurve | null;
  noise: NoiseInfo | null;
  /** inversion range applied (manual, or from the noise level), null = none */
  range: [number, number] | null;
  rangeFromNoise: boolean;
  error?: string;
}

/** Inversion range: the manual one, else from the noise-equivalent diameter (when known and enabled), else none. */
function effectiveRange(d: SizeDraft, noise: NoiseInfo | null): { range: [number, number] | null; fromNoise: boolean } {
  if (d.rangeOn) return { range: [d.rangeNm[0], d.rangeNm[1]], fromNoise: false };
  if (d.rangeAuto && noise && Number.isFinite(noise.diameterNm) && noise.diameterNm > 20) return { range: [Math.ceil(noise.diameterNm), 1500], fromNoise: true };
  return { range: null, fromNoise: false };
}

/** Representative diameters for the size resolution: the range ends and round sizes in between. */
function resolutionPoints(curve: SizeCurve): { diameterNm: number; pctPerPct: number }[] {
  const [lo, hi] = curve.validRangeNm;
  const ds = [lo, ...[50, 100, 150, 200, 300, 500, 700, 1000].filter((x) => x > lo * 1.15 && x < hi / 1.1), hi];
  return ds.map((x) => ({ diameterNm: x, pctPerPct: sizeResolution(curve, x) }));
}

/** Good-fit limits (FCMPASS practice): above them the calibration needs explicit confirmation. */
const POOR_FIT = { cvPct: 10, residualPct: 15 };

function poorFitOf(fit: CollectionFit | null): { cvPct: number; maxResidualPct: number } | null {
  if (!fit) return null;
  const res = fit.beads.filter((b) => b.used && Number.isFinite(b.residualPct)).map((b) => Math.abs(b.residualPct));
  const maxResidualPct = res.length ? Math.max(...res) : 0;
  return fit.cvPct > POOR_FIT.cvPct || maxResidualPct > POOR_FIT.residualPct ? { cvPct: fit.cvPct, maxResidualPct } : null;
}

/**
 * Used beads of a fit as collected cross sections (nm²): each measured median times the factor of the detector its set
 * was measured on (`groups[i]`: index into `chans` and fit.groupFactors, one per fit bead in order).
 */
export function beadSigmaPoints(fit: CollectionFit, groups: number[], chans: string[], channel: string): { diameterNm: number; sigma: number; channel: string; factor: number; label: string }[] {
  const out: { diameterNm: number; sigma: number; channel: string; factor: number; label: string }[] = [];
  fit.beads.forEach((b, i) => {
    if (!b.used) return;
    const g = groups[i] ?? 0;
    const factor = fit.groupFactors[g]?.nm2PerAu ?? fit.nm2PerAu;
    out.push({ diameterNm: b.diameterNm, sigma: b.measured * factor, channel: chans[g] ?? channel, factor, label: b.label });
  });
  return out;
}

function ModelStep({ d, fit, curve, curveRes, pending, groups, chans }: { d: SizeDraft; fit: CollectionFit | null; curve: SizeCurve | null; curveRes?: CurveRes; pending: boolean; groups: number[]; chans: string[] }) {
  const set = useCalib((s) => s.setSize);
  const m = d.model;
  const preset = m.kind === 'ev' ? 'ev' : m.preset;
  const curveError = curveRes?.error;
  const psCurve = useMemo(() => {
    if (!fit) return null;
    const ds = Array.from({ length: 140 }, (_, i) => 20 * Math.pow(1500 / 20, i / 139));
    return { ds, s: Array.from(apertureCrossSections(PS_MODEL, ds, fit.setup)) };
  }, [fit]);
  const noise = fit ? curveRes?.noise ?? null : null;
  const fromNoise = !!curveRes?.rangeFromNoise;
  // beads in nm² σ: each bead's measured value with the factor of the detector it was measured on
  const beadPts = fit ? beadSigmaPoints(fit, groups, chans, d.channel) : [];
  const multiCh = new Set(beadPts.map((b) => b.channel)).size > 1;
  let chart = null;
  if (fit && curve) {
    const ds = Array.from(curve.diametersNm);
    const ss = Array.from(curve.sigmaNm2);
    const [v0, v1] = curve.validRangeNm;
    const valid = ds.map((x, i) => (x >= v0 && x <= v1 ? ss[i] : NaN));
    const yAll = [...ss.filter((v) => v > 0), ...(psCurve?.s ?? []), ...beadPts.map((b) => b.sigma)];
    const [y0, y1] = logRange(yAll, 1.5);
    chart = (
      <XYChart
        height={260}
        ariaLabel="Collected scattering cross section versus diameter"
        x={{ type: 'log', min: ds[0], max: ds[ds.length - 1], title: 'Diameter (nm)' }}
        y={{ type: 'log', min: Math.max(y0, y1 / 1e12), max: y1, title: 'σ (nm²)' }}
        series={[
          ...(psCurve ? [{ kind: 'line' as const, x: psCurve.ds, y: psCurve.s, color: 'var(--text-3)', dash: '3 3', width: 1.2 }] : []),
          { kind: 'line', x: ds, y: ss, color: 'var(--accent)', width: 1, dash: '2 2' },
          { kind: 'line', x: ds, y: valid, color: 'var(--accent)', width: 2.2 },
          { kind: 'points', x: beadPts.map((b) => b.diameterNm), y: beadPts.map((b) => b.sigma), color: 'var(--sel)', r: 4, tips: beadPts.map((b) => `${b.label}: ${fmtNum(b.sigma)} nm² measured on ${b.channel} (x ${fmtNum(b.factor, 4)} nm²/a.u.)`) },
        ]}
        anno={{
          bands: [
            { x0: v0, x1: v1, className: 'cc-band ok', label: 'valid range' },
            ...curve.lowResolutionNm.map(([a, b]) => ({ x0: a, x1: Math.max(b, a + 1), className: 'cc-band low', label: 'low resolution' })),
          ],
          hlines: noise ? [{ y: noise.sigmaNm2, color: 'var(--danger)', label: 'noise median' }] : [],
        }}
        legend={[
          { name: `${toParticleModel(m).name ?? 'model'} (valid part solid)`, color: 'var(--accent)', marker: 'line' },
          { name: 'polystyrene', color: 'var(--text-3)', dash: '3 3', marker: 'line' },
          { name: multiCh ? `beads (measured x factor of their detector: ${chans.join(', ')})` : 'beads (measured x factor)', color: 'var(--sel)', marker: 'dot' },
          ...(noise ? [{ name: 'noise median', color: 'var(--danger)', dash: '4 3', marker: 'line' as const }] : []),
        ]}
      />
    );
  }
  return (
    <StepCard n={4} title="Particle model for your samples">
      <div className="cal-grid">
        <div className="frow">
          <label>Model</label>
          <Sel value={preset} ariaLabel="Particle model" options={MODEL_PRESETS} onChange={(v) => set((x) => void (x.model = modelPresetDraft(v)))} />
        </div>
        {m.kind === 'ev' ? (
          <div className="cal-geo" style={{ gridColumn: '1 / -1' }}>
            <label>
              Core RI
              <Num value={m.core} step={0.005} min={1} max={2} digits={4} ariaLabel="Core refractive index" onChange={(v) => set((x) => void ((x.model as { core: number }).core = v))} />
            </label>
            <label>
              Shell RI
              <Num value={m.shell} step={0.005} min={1} max={2} digits={4} ariaLabel="Shell refractive index" onChange={(v) => set((x) => void ((x.model as { shell: number }).shell = v))} />
            </label>
            <label>
              Shell (nm)
              <Num value={m.shellNm} step={0.5} min={0} max={100} ariaLabel="Shell thickness in nm" onChange={(v) => set((x) => void ((x.model as { shellNm: number }).shellNm = v))} />
            </label>
            <label>
              RIs at
              <Sel
                value={m.refNm ? String(m.refNm) : 'laser'}
                ariaLabel="Wavelength at which the RIs are given"
                options={[
                  { value: '488', label: '488 nm', title: 'Given at 488 nm and shifted with the dispersion of water to the laser wavelength, as FCMPASS does' },
                  { value: 'laser', label: `${d.wavelength} nm`, title: 'Taken as they are at the laser wavelength' },
                ]}
                onChange={(v) =>
                  set((x) => {
                    const mm = x.model as { refNm?: number };
                    if (v === 'laser') delete mm.refNm;
                    else mm.refNm = Number(v);
                  })
                }
              />
            </label>
            <span className="row" style={{ gap: 4, alignSelf: 'end' }} title="The three EV models of FCMPASS (core RI low / average / high; shell 1.48, 5 nm; RIs at 488 nm)">
              {(['low', 'average', 'high'] as const).map((lv) => {
                const core = FCMPASS_EV_CORES[lv];
                const on = m.core === core && m.shell === 1.48 && m.shellNm === 5 && m.refNm === 488;
                return (
                  <button key={lv} className={`btn sm${on ? ' on' : ''}`} aria-pressed={on} onClick={() => set((x) => void (x.model = { kind: 'ev', core, shell: 1.48, shellNm: 5, refNm: 488 }))}>
                    {lv === 'average' ? 'Average' : lv === 'low' ? 'Low RI' : 'High RI'} ({core.toFixed(2)})
                  </button>
                );
              })}
            </span>
          </div>
        ) : m.preset === 'virus' || m.preset === 'custom' ? (
          <div className="frow">
            <label>RI</label>
            <Num value={m.n} step={0.005} min={1} max={3} digits={4} ariaLabel="Particle refractive index" onChange={(v) => set((x) => void ((x.model as { n: number }).n = v))} />
          </div>
        ) : null}
      </div>
      <p className="hint" style={{ margin: '0 0 8px' }}>
        {m.kind === 'ev'
          ? `Core-shell sphere: aqueous core plus a lipid membrane (FCMPASS models: core 1.36, 1.38 or 1.40, shell 1.48, 5 nm). The diameter includes the shell. ${
              m.refNm
                ? `RIs at ${m.refNm} nm, shifted with the dispersion of water to ${d.wavelength} nm (core ${riNumber({ material: 'water', n: m.core, atNm: m.refNm }, d.wavelength).toFixed(4)}, shell ${riNumber({ material: 'water', n: m.shell, atNm: m.refNm }, d.wavelength).toFixed(4)}), as FCMPASS does: diameters agree with its EV columns.`
                : `RIs taken as they are at ${d.wavelength} nm (FCMPASS shifts them from 488 nm: at 405 nm its diameters are about 10 % smaller).`
            }`
          : m.preset === 'virus'
            ? 'Enveloped and non-enveloped viruses are often modelled as homogeneous spheres with n about 1.45 to 1.50; the true value depends on the virus and on the medium.'
            : fit
              ? `Homogeneous sphere: ${describeModel(toParticleModel(m), d.wavelength)}.`
              : 'Homogeneous sphere.'}{' '}
        Refractive index at {d.wavelength} nm relative to the medium {d.nMedium.toFixed(4)}.
      </p>
      <div className="row" style={{ marginBottom: 6 }}>
        <Check checked={d.rangeOn} label="Limit the inversion range to" onChange={(v) => set((x) => void (x.rangeOn = v))} />
        <Num value={d.rangeNm[0]} min={20} max={1499} ariaLabel="Lower diameter limit in nm" onChange={(v) => set((x) => void ((x.rangeNm = [v, Math.max(v + 1, x.rangeNm[1])]), (x.rangeOn = true)))} />
        <span className="hint">to</span>
        <Num value={d.rangeNm[1]} min={21} max={1500} ariaLabel="Upper diameter limit in nm" onChange={(v) => set((x) => void ((x.rangeNm = [Math.min(x.rangeNm[0], v - 1), v]), (x.rangeOn = true)))} />
        <span className="hint">nm (model grid 20 to 1500 nm)</span>
        {d.rangeOn && noise && Number.isFinite(noise.diameterNm) && noise.diameterNm > 20 && (
          <button
            className="btn sm"
            title="Events below the noise level get no diameter (report sizes only above the detection limit)"
            onClick={() =>
              set((x) => {
                const lo = Math.ceil(noise.diameterNm);
                x.rangeOn = true;
                x.rangeNm = [lo, Math.max(lo + 1, x.rangeNm[1])];
              })
            }
          >
            Lower limit at noise level ({fmtNum(noise.diameterNm, 3)} nm)
          </button>
        )}
      </div>
      {!d.rangeOn && noise && Number.isFinite(noise.diameterNm) && noise.diameterNm > 20 && (
        <div className="row" style={{ marginBottom: 6 }}>
          <Check
            checked={d.rangeAuto}
            label={`Start at the noise level (${fmtNum(noise.diameterNm, 3)} nm): smaller signals are noise, not particles`}
            onChange={(v) => set((x) => void (x.rangeAuto = v))}
          />
        </div>
      )}
      <div className="row" style={{ marginBottom: 8 }} title="Where σ(d) is this flat, a 1 % scatter error becomes a size error of more than 1/slope %. Such stretches stay in the valid range while σ(d) still rises (events there are sized) and are reported as low size resolution.">
        <span className="hint">Mark low size resolution where the log-log slope is below</span>
        <Num value={d.minSlope} min={0} max={3} step={0.05} digits={2} ariaLabel="Log-log slope below which the size resolution counts as low" onChange={(v) => set((x) => void (x.minSlope = v))} />
        <span className="hint">(0.5 = size error over 2 × the scatter error; 0 = no marks). The range ends only where σ(d) stops rising.</span>
      </div>
      {!fit && <p className="hint">The size curve needs the fitted geometry (step 3).</p>}
      {curveError && <Notes tone="error" items={[`${curveError}.`]} />}
      {fit && !curve && pending && <p className="hint">Computing the size curve…</p>}
      {chart}
      {fit && curve && (
        <div className="row" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
          <button
            className="btn sm"
            title="Place the size curve (scattering cross section versus diameter, with the valid range and the beads) on the active worksheet as a figure panel"
            onClick={() =>
              addCalibPanelToSheet(
                sizeCurvePanel({
                  channel: d.channel,
                  modelName: toParticleModel(m).name ?? 'model',
                  diameters: Array.from(curve.diametersNm),
                  sigma: Array.from(curve.sigmaNm2),
                  validRange: [curve.validRangeNm[0], curve.validRangeNm[1]],
                  ps: psCurve ? { d: psCurve.ds, s: psCurve.s } : null,
                  beads: beadPts.map((b) => ({ diameterNm: b.diameterNm, sigma: b.sigma, channel: b.channel })),
                  noiseSigma: noise?.sigmaNm2 ?? null,
                }),
              )
            }
          >
            <Icon.plus /> Add size curve to sheet
          </button>
        </div>
      )}
      {curve && (
        <div className="cal-range">
          <b>
            Valid range: {fmtNum(curve.validRangeNm[0])} to {fmtNum(curve.validRangeNm[1])} nm
          </b>{' '}
          (σ {fmtNum(curve.validSigmaNm2[0])} to {fmtNum(curve.validSigmaNm2[1])} nm² = {fmtNum(curve.validSigmaNm2[0] / (fit?.nm2PerAu ?? 1))} to {fmtNum(curve.validSigmaNm2[1] / (fit?.nm2PerAu ?? 1))} a.u.)
          {fromNoise && <span className="badge" style={{ marginLeft: 6 }}>lower limit = noise level</span>}
          <div className="cal-res" role="table" aria-label="Size resolution" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', margin: '6px 0 2px', fontSize: 12.5 }}>
            <span className="hint" role="rowheader">
              Size error per 1 % scatter error:
            </span>
            {resolutionPoints(curve).map((r) => (
              <span key={r.diameterNm} role="cell" title={`At ${fmtNum(r.diameterNm, 3)} nm a 5 % scatter CV gives about ±${fmtFix(5 * r.pctPerPct, 1)} % in size`} className={r.pctPerPct > 1.5 ? 'cal-warn-text' : undefined}>
                {fmtNum(r.diameterNm, 3)} nm: ±{fmtFix(r.pctPerPct, 2)} %
              </span>
            ))}
          </div>
          {curve.lowResolutionNm.length > 0 && (
            <Notes
              tone="warn"
              items={[
                `Low size resolution: ${nmBandsText(curve.lowResolutionNm)} (log-log slope of σ(d) below ${fmtFix(curve.minLogSlope, 2)}: a 1 % scatter error becomes more than a ${fmtFix(1 / curve.minLogSlope, 1)} % size error). σ(d) still rises there, so these events are sized, but their diameters are imprecise.`,
              ]}
            />
          )}
          {curve.ambiguousNm && (
            <Notes
              tone="warn"
              items={[`Ambiguous: signals of ${nmBandsText([curve.ambiguousNm])} also fit particles above the Mie maximum at ${fmtNum(curve.validRangeNm[1])} nm; larger particles in the sample would be sized into this band.`]}
            />
          )}
          <p className="hint" style={{ margin: '4px 0 0' }}>
            Diameters can only be read from scatter where the curve rises.{' '}
            {curve.endsAtMaximum ? `Above ${fmtNum(curve.validRangeNm[1])} nm the curve reaches its first Mie resonance maximum, so one signal fits several diameters. ` : ''}
            Events outside the range get no diameter (they are not plotted on diameter axes and are excluded from diameter statistics, which report how many events they are based on).
            {noise &&
              ` The noise median (${fmtNum(noise.au)} a.u. = ${fmtNum(noise.sigmaNm2)} nm²) corresponds to ${Number.isFinite(noise.diameterNm) ? `${fmtNum(noise.diameterNm, 3)} nm in this model: smaller particles are not separated from noise` : 'a size below the model range'}.`}
          </p>
        </div>
      )}
    </StepCard>
  );
}

// ---------------------------------------------------------------- step 5: apply

function niceCeil(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 3, 5, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}

/** Output label only where the name does not say it already (keeps axis titles and table headers short). */
function outputLabel(name: string, label: string): string | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return norm(name).includes(norm(label)) ? undefined : label;
}

/**
 * Label of a size output: none when the name says what it is ("VSSC1 diameter", "VSSC1 diameter (nm)", "VSSC1 σ"),
 * so axes show the short name; else the quantity with its unit.
 */
export function sizeOutputLabel(name: string, label: string): string | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const word = norm(label.replace(/\s*\(.*\)\s*$/, ''));
  if (word && norm(name).includes(word)) return undefined;
  return outputLabel(name, label);
}

/**
 * Events of a preview sample: the diameters of the sized ones, how many lie below / above the valid range (not sized;
 * NaN and non-positive signals count as below) and how many sized ones fall in a low-resolution band of the curve.
 */
export function sizePreviewCounts(curve: SizeCurve, raw: Float32Array, nm2PerAu: number): { sized: number[]; below: number; above: number; lowRes: number } {
  const dia = scatterToDiameter(curve, raw, { nm2PerAu });
  const hi = curve.validSigmaNm2[1];
  const bands = curve.lowResolutionNm;
  let below = 0;
  let above = 0;
  let lowRes = 0;
  const sized: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = dia[i];
    if (Number.isFinite(v)) {
      sized.push(v);
      for (const [a, b] of bands)
        if (v >= a - 0.5 && v <= b + 0.5) {
          lowRes++;
          break;
        }
    } else if (raw[i] * nm2PerAu > hi) above++;
    else below++;
  }
  return { sized, below, above, lowRes };
}

/** Full-scale value of a channel (measured: its range; computed: the output range). */
function channelRangeOf(ws: Workspace, ch: string): number {
  const measured = Math.max(0, ...ws.samples.map((s) => s.channels.find((c) => c.name === ch)?.range ?? 0));
  if (measured > 0) return measured;
  return ws.derived?.flatMap((x) => x.outputs).find((o) => o.name === ch)?.range ?? 1;
}

function ApplyStep({
  d,
  fit,
  curve,
  curveRes,
  results,
  noise,
  chans,
  model: pageModel,
}: {
  d: SizeDraft;
  fit: CollectionFit | null;
  curve: SizeCurve | null;
  curveRes?: CurveRes;
  results: SetResult[];
  noise: NoiseInfo | null;
  chans: string[];
  model: ReturnType<typeof toParticleModel>;
}) {
  const ws = useStore((s) => s.ws);
  const set = useCalib((s) => s.setSize);
  const editDef = d.editId ? (ws.derived ?? []).find((x) => x.id === d.editId) : undefined;
  // channels that get size outputs: each calibrated channel (bead sets measured on it) can; editing keeps its own
  const outs = editDef ? [(editDef as SizeDef).channel] : (d.outChannels ?? [d.channel]).filter((c) => chans.includes(c));
  const outChans = outs.length ? outs : chans.slice(0, 1);
  const factorOf = (ch: string) => (fit ? fit.groupFactors[Math.max(0, chans.indexOf(ch))]?.nm2PerAu ?? fit.nm2PerAu : NaN);
  const [names, setNames] = useState<{ diam: string | null; sigma: string | null }>({ diam: null, sigma: null });
  useEffect(() => setNames({ diam: null, sigma: null }), [d.channel, d.editId, outChans[0]]);
  // short default names (axis titles and table headers stay readable); the unit is in the axis label
  const diamName = names.diam ?? editDef?.outputs[0]?.name ?? defaultOutputName(outChans[0] ?? d.channel, 'diameter', d.editId);
  const sigmaName = names.sigma ?? editDef?.outputs[1]?.name ?? defaultOutputName(outChans[0] ?? d.channel, 'σ', d.editId);
  const [last, setLast] = useState<string | null>(null);
  const lastDef = last ? (ws.derived ?? []).find((x) => x.id === last) : undefined;
  const [preview, setPreview] = useState<string | null>(null);
  const pch = outChans[0] ?? d.channel;
  const previewId = preview ?? ws.samples.find((s) => engine.has(s.id) && !d.sets.some((q) => q.sampleId === s.id) && sampleHasChannel(ws, s.id, pch))?.id ?? null;
  const model = useMemo(() => toParticleModel(d.model), [d.model]);

  const pv = useMemo(() => {
    if (!fit || !curve || !previewId) return null;
    const raw = engine.raw(ws, previewId, pch);
    if (!raw) return null;
    const { sized: fin, below, above, lowRes } = sizePreviewCounts(curve, raw, factorOf(pch));
    fin.sort((a, b) => a - b);
    const q = (p: number) => (fin.length ? fin[Math.min(fin.length - 1, Math.floor(p * fin.length))] : NaN);
    // log histogram 20..2000 nm
    const nb = 80;
    const l0 = Math.log10(Math.max(10, curve.validRangeNm[0] * 0.8));
    const l1 = Math.log10(curve.validRangeNm[1] * 1.25);
    const counts = new Float32Array(nb);
    for (const v of fin) {
      const b = Math.floor(((Math.log10(v) - l0) / (l1 - l0)) * nb);
      if (b >= 0 && b < nb) counts[b]++;
    }
    return { n: raw.length, sized: fin.length, below, above, lowRes, p10: q(0.1), p50: q(0.5), p90: q(0.9), counts, l0, l1 };
  }, [fit, curve, previewId, pch, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  const noiseNow = noise;
  const poor = poorFitOf(fit);
  const [okPoor, setOkPoor] = useState(false);
  useEffect(() => setOkPoor(false), [fit]);
  const needOk = d.sets.some((s) => {
    const src = sizeValuesSource(getBeadKit(s.kitId), s.beads);
    return src === 'kit-example' || src === 'mixed';
  });
  const [okExample, setOkExample] = useState(false);
  const can = !!fit && !!curve && diamName.trim() !== '' && (!d.sigmaOut || sigmaName.trim() !== '') && (d.applyAll || d.applyIds.length > 0) && (!needOk || okExample) && (!poor || okPoor);

  const apply = () => {
    if (!fit || !curve) return;
    const setups: SizeSetProvenance[] = d.sets.map((s, si) => {
      const r = results[si];
      const kit = getBeadKit(s.kitId);
      return {
        sampleId: s.sampleId ?? undefined,
        sampleName: ws.samples.find((q) => q.id === s.sampleId)?.name,
        population: s.population,
        populationName: popPath(ws, s.population),
        kitId: s.kitId,
        kitName: kit ? kitName(kit) : undefined,
        lot: s.lot || undefined,
        valuesSource: sizeValuesSource(kit, s.beads),
        noise: s.noise,
        noiseMedian: r.noisePeak >= 0 ? r.peaks[r.noisePeak]?.median : undefined,
        windows: s.windows,
        ...(s.channel && s.channel !== d.channel ? { channel: s.channel } : {}),
        beads: s.beads.map((b, i) => {
          const p = r.assign[i] >= 0 ? r.peaks[r.assign[i]] : undefined;
          return {
            label: b.label,
            diameterNm: b.diameterNm,
            ri: b.ri,
            use: b.use,
            assign: b.assign,
            measured: b.use && p && !r.saturated[i] ? p.median : NaN,
            count: p?.count,
            rcvPct: p ? Number(p.rcvPct.toFixed(3)) : undefined,
            edited: b.edited,
            ...(r.saturated[i] ? { saturated: true } : {}),
            ...(b.fit === false ? { fit: false } : {}),
          };
        }),
      };
    });
    const channelFactors = chans.length > 1 ? chans.map((ch, g) => ({ channel: ch, nm2PerAu: fit.groupFactors[g]?.nm2PerAu, beads: fit.groupFactors[g]?.n ?? 0, cvPct: fit.groupFactors[g]?.cvPct })) : undefined;
    const made: string[] = [];
    const cur0 = useStore.getState().ws;
    let lastId: string | null = null;
    for (const [k, ch] of outChans.entries()) {
      const main = ch === d.channel;
      const f = factorOf(ch);
      // the size curve of this channel: its own noise level may limit the inversion range
      let crv = curve;
      let cres = curveRes;
      let nz = noise;
      if (!main) {
        const nAu = noiseOfChannel(results, ch);
        const opts = { minLogSlope: d.minSlope };
        const base = buildSizeCurve(pageModel, fit.setup, opts);
        nz = nAu > 0 ? { au: nAu, sigmaNm2: nAu * f, diameterNm: scatterToDiameter(base, Float64Array.of(nAu * f))[0] } : null;
        const er = effectiveRange(d, nz);
        crv = er.range ? buildSizeCurve(pageModel, fit.setup, { ...opts, rangeNm: er.range }) : base;
        cres = { curve: crv, noise: nz, range: er.range, rangeFromNoise: er.fromNoise };
      }
      if (!crv) continue;
      const ext: SizeFitExt = {
        setups,
        nm2PerAu: f,
        rmsLog: fit.rmsLog,
        geomPreset: d.preset,
        sweepMin: d.sweep[0],
        sweepMax: d.sweep[1],
        validRangeNm: crv.validRangeNm,
        validSigmaNm2: crv.validSigmaNm2,
        endsAtMaximum: crv.endsAtMaximum,
        endsAtFlat: crv.endsAtFlat,
        minLogSlope: crv.minLogSlope,
        lowResolutionNm: crv.lowResolutionNm.map(([a, b]): [number, number] => [a, b]),
        ambiguousNm: crv.ambiguousNm ? [crv.ambiguousNm[0], crv.ambiguousNm[1]] : null,
        rangeFromNoise: !!cres?.rangeFromNoise,
        resolution: resolutionPoints(crv).map((r) => ({ diameterNm: r.diameterNm, pctPerPct: Number(r.pctPerPct.toFixed(4)) })),
        poorFit: poor ? { ...poor, confirmed: okPoor } : undefined,
        sizedBeads: fit.beads.map((b) => ({ label: b.label, diameterNm: b.diameterNm, sizedNm: b.sizedNm, sizeErrorPct: b.sizeErrorPct, predicted: b.predicted, sigmaNm2: b.sigmaNm2 })),
        noiseFloor: nz,
        warnings: fit.warnings,
        ...(channelFactors ? { channelFactors } : {}),
      };
      const id = (k === 0 && d.editId) || uid('size');
      // the name fields are for the first channel; the others get default names
      const dn = freeChannelName(k === 0 ? diamName.trim() : defaultOutputName(ch, 'diameter'), id);
      const sn = d.sigmaOut ? freeChannelName(k === 0 ? sigmaName.trim() : defaultOutputName(ch, 'σ'), id) : '';
      if (dn === sn) return useStore.getState().toast('The two output channels need different names', 'error');
      const chRangeK = Math.max(channelRangeOf(cur0, ch), 1);
      const def: SizeDef = {
        id,
        kind: 'size',
        name: `${ch} size`,
        channel: ch,
        nm2PerAu: f,
        setup: fit.setup,
        model: pageModel,
        rangeNm: cres?.range ? [cres.range[0], cres.range[1]] : undefined,
        minLogSlope: d.minSlope,
        lowSlopeBands: true,
        outputs: [
          { name: dn, label: sizeOutputLabel(dn, 'Diameter (nm)'), range: crv.validRangeNm[1], unit: 'nm' },
          ...(d.sigmaOut ? [{ name: sn, label: sizeOutputLabel(sn, 'σ (nm²)'), range: chRangeK * f, unit: 'nm²' }] : []),
        ],
        samples: d.applyAll ? undefined : d.applyIds,
        created: new Date().toISOString(),
        fit: { method: fit.method, halfAngleDeg: fit.halfAngleDeg, r2Log: fit.r2Log, cvPct: fit.cvPct, beads: fit.beads.map((b) => ({ name: b.label, diameterNm: b.diameterNm, measured: b.measured, residualPct: b.residualPct })), ...ext },
      };
      // display scales from the data of the samples (whole decades around the robust range), else from the calibration
      const cur = useStore.getState().ws;
      const scales: Record<string, ScaleDef> = {
        [dn]:
          dataLogScale(derivedOutputValues(cur, def, 0), [Math.max(1, crv.validRangeNm[0] * 0.5), crv.validRangeNm[1] * 2]) ??
          { type: 'log', min: Math.pow(10, Math.floor(Math.log10(Math.max(10, crv.validRangeNm[0])))), max: niceCeil(crv.validRangeNm[1]) },
      };
      if (sn)
        scales[sn] =
          dataLogScale(derivedOutputValues(cur, def, 1)) ??
          { type: 'log', min: Math.pow(10, Math.floor(Math.log10(Math.max(crv.validSigmaNm2[0], 1e-6)))), max: Math.pow(10, Math.ceil(Math.log10(Math.max(chRangeK * f, crv.validSigmaNm2[1] * 10)))) };
      upsertDerived(def, scales);
      made.push(`"${dn}"${sn ? ` and "${sn}"` : ''}`);
      if (k === 0) lastId = id;
    }
    if (!lastId) return;
    const firstId = lastId;
    set((x) => void (x.editId = firstId));
    setLast(firstId);
    useStore.getState().toast(`${editDef ? 'Updated' : 'Created'} ${made.join(', ')} for ${d.applyAll ? 'all samples' : `${d.applyIds.length} samples`}`, 'success');
  };

  return (
    <StepCard n={5} title="Apply to samples">
      {chans.length > 1 && !editDef && (
        <div className="row" style={{ marginBottom: 6 }} role="group" aria-label="Channels to create size outputs for">
          <span className="hint">Size outputs for</span>
          {chans.map((ch) => (
            <Check
              key={ch}
              checked={outChans.includes(ch)}
              label={`${ch} (${fmtNum(factorOf(ch), 4)} nm²/a.u.)`}
              onChange={(v) =>
                set((x) => {
                  const curSel = (x.outChannels ?? [x.channel]).filter((c) => chans.includes(c));
                  const next = v ? [...new Set([...curSel, ch])] : curSel.filter((c) => c !== ch);
                  x.outChannels = next.length ? chans.filter((c) => next.includes(c)) : curSel;
                })
              }
            />
          ))}
        </div>
      )}
      <div className="cal-grid">
        <div className="frow">
          <label>Diameter channel{outChans.length > 1 ? ` (${outChans[0]})` : ''}</label>
          <input className="inp" value={diamName} aria-label="Diameter output channel name" onChange={(e) => setNames({ ...names, diam: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <div className="frow">
          <label>
            <input type="checkbox" checked={d.sigmaOut} aria-label="Also create the cross-section channel" onChange={(e) => set((x) => void (x.sigmaOut = e.target.checked))} /> σ channel
          </label>
          <input className="inp" value={sigmaName} disabled={!d.sigmaOut} aria-label="Cross-section output channel name" onChange={(e) => setNames({ ...names, sigma: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      </div>
      <ApplyTargets all={d.applyAll} ids={d.applyIds} channel={pch} onChange={(all, ids) => set((x) => void ((x.applyAll = all), (x.applyIds = ids)))} />
      <p className="hint" style={{ margin: '6px 0' }}>
        Diameter (nm) per event from {outChans.join(' and ')} through the {model.name ?? 'model'} curve; σ (nm²) = a.u. x {fit ? outChans.map((c) => `${fmtNum(factorOf(c), 4)}${outChans.length > 1 ? ` (${c})` : ''}`).join(', ') : 'factor'}. Both get log display scales.
        {outChans.length > 1 ? ` The other channels get the default names ${outChans.slice(1).map((c) => `"${defaultOutputName(c, 'diameter')}"`).join(', ')}.` : ''}
      </p>
      {fit && curve && (
        <div className="cal-preview">
          <div className="row">
            <span className="hint">Preview on</span>
            <SamplePicker value={previewId} ariaLabel="Preview sample" onChange={setPreview} />
          </div>
          {pv && (
            <div className="cal-two" style={{ marginTop: 6 }}>
              <XYChart
                height={180}
                ariaLabel="Preview of the diameter distribution"
                x={{ type: 'log', min: Math.pow(10, pv.l0), max: Math.pow(10, pv.l1), title: `Diameter (nm), ${model.name ?? 'model'}` }}
                y={{ type: 'lin', min: 0, max: Math.max(1, ...Array.from(pv.counts)) * 1.08, title: 'Events' }}
                anno={noiseNow && Number.isFinite(noiseNow.diameterNm) ? { vlines: [{ x: noiseNow.diameterNm, color: 'var(--danger)', label: 'noise median' }] } : undefined}
                series={[
                  {
                    kind: 'line',
                    x: Array.from(pv.counts, (_, i) => Math.pow(10, pv.l0 + ((i + 0.5) / pv.counts.length) * (pv.l1 - pv.l0))),
                    y: Array.from(pv.counts),
                    color: 'var(--accent)',
                    width: 1.8,
                  },
                ]}
              />
              <div className="cal-statgrid">
                <Stat
                  label="Sized events"
                  value={`${((100 * pv.sized) / Math.max(1, pv.n)).toFixed(1)} %`}
                  sub={`${pv.sized.toLocaleString('en-US')} of ${pv.n.toLocaleString('en-US')}${pv.lowRes ? `; ${pv.lowRes.toLocaleString('en-US')} at low size resolution` : ''}`}
                />
                <Stat label="Median diameter" value={`${fmtNum(pv.p50, 3)} nm`} sub={`P10 ${fmtNum(pv.p10, 3)}, P90 ${fmtNum(pv.p90, 3)} nm`} />
                <Stat label="Below range" value={pv.below.toLocaleString('en-US')} sub="not sized (small / noise)" />
                <Stat label="Above range" value={pv.above.toLocaleString('en-US')} sub={curve.endsAtMaximum ? 'not sized (past the Mie maximum)' : 'not sized'} />
              </div>
            </div>
          )}
        </div>
      )}
      {needOk && (
        <div className="cal-confirm">
          <Check checked={okExample} onChange={setOkExample} label="Use the example bead diameters anyway (testing only: the report says so)" />
        </div>
      )}
      {poor && (
        <div className="cal-confirm">
          <Notes
            tone="error"
            items={[
              `The bead fit is poor: CV of measured/predicted ratios ${fmtFix(poor.cvPct, 1)} % (limit ${POOR_FIT.cvPct} %), largest residual ${fmtFix(poor.maxResidualPct, 0)} % (limit ${POOR_FIT.residualPct} %). Check the peak assignment, the bead diameters and RIs, and the detector before using these sizes.`,
            ]}
          />
          <Check checked={okPoor} onChange={setOkPoor} label="Apply anyway (the report marks the calibration as a poor fit)" />
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={!can} onClick={apply}>
          {editDef ? `Update "${editDef.outputs[0]?.name}"` : 'Create size channels'}
        </button>
        {d.editId && (
          <button className="btn" onClick={() => set((x) => void (x.editId = undefined))} title="Keep the existing calibration and create a new one from these settings">
            Save as new
          </button>
        )}
        {!fit && <span className="hint">Needs a fitted geometry (step 3).</span>}
      </div>
      {lastDef && (
        <div style={{ marginTop: 10 }}>
          <Notes tone="ok" items={[`Saved "${lastDef.outputs.map((o) => o.name).join('", "')}". Report:`]} />
          <ReportBox def={lastDef} />
        </div>
      )}
    </StepCard>
  );
}


