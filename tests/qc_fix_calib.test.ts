// Regression tests for the QC findings on bead calibration (synthetic data only):
// 1. MESF order statistics of dim populations (MFI <= 0 kept as 0 instead of dropped)
// 2. detector saturation check on the MESF page (saturated beads left out of the fit by default)
// 3. calibrated range of an MESF calibration (stored, reported, marked in statistics tables)
// 4. size calibration range not ended at low-slope stretches while σ(d) still rises
// 5. reference value provenance of kit templates without preset values
import { getBeadKit } from '../src/core/beads';
import { calibratedRangeNote, computeDerived, type DerivedDef, type MesfDerived, type SizeDerived } from '../src/core/derived';
import { engine } from '../src/core/engine';
import type { FcsDataset } from '../src/core/fcs';
import { allIndices } from '../src/core/gating';
import { beadSaturation, calibratedRangePosition, findBeadPeaks, fitMesf, mesfValue, saturationLevel, toMesf } from '../src/core/mesf';
import { emptyWorkspace, type TableDef, type Workspace } from '../src/core/model';
import { apertureCrossSection, apertureCrossSections, buildSizeCurve, evModelFcmpass, scatterToDiameter, type ScatterSetup } from '../src/core/scattercal';
import { channelStats } from '../src/core/stats';
import { makeScale } from '../src/core/transforms';
import { dataLogScale } from '../src/state/derivedOps';
import { tableRangeNotes } from '../src/ui/TablesView';
import { emptyMesf, type MesfDraft } from '../src/ui/calib/draft';
import { chanFromKit, valuesSource } from '../src/ui/calib/logic';
import { analyseMesf, isSaturatedBead } from '../src/ui/calib/MesfPage';
import { mesfReportCsv, mesfReportText, sizeReportCsv, sizeReportText } from '../src/ui/calib/report';
import { sizePreviewCounts } from '../src/ui/calib/SizePage';
import type { MesfDef, SizeDef } from '../src/ui/calib/util';

function rng(seed: number) {
  let s = seed;
  const u = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const g = () => {
    let a = 0;
    while (a === 0) a = u();
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u());
  };
  return { u, g };
}

const RCP = [0, 792, 2079, 6588, 16471, 47497, 137049, 271647];
const TOP = 262143;

/** RCP-30-5A-like bead channel (3000 events per population, 4 % CV, blank at 60·gain), clipped at the detector maximum. */
function rainbow(gain: number, seed = 12345, clip = TOP): { area: Float32Array; raw: Float32Array } {
  const { g } = rng(seed);
  const raw: number[] = [];
  RCP.forEach((r, i) => {
    const mfi = i === 0 ? 60 * gain : r * gain;
    for (let k = 0; k < 3000; k++) raw.push(mfi * Math.exp(0.04 * g()) + 15 * g());
  });
  return { raw: Float32Array.from(raw), area: Float32Array.from(raw, (v) => Math.min(clip, v)) };
}

function dataset(cols: Record<string, Float32Array>, range = 262144): FcsDataset {
  const names = Object.keys(cols);
  return { channels: names.map((name) => ({ name, label: '', range })), data: names.map((n) => cols[n]), eventCount: cols[names[0]].length, keywords: {} } as unknown as FcsDataset;
}

function beadWorkspace(id: string, cols: Record<string, Float32Array>, range = 262144): Workspace {
  const ds = dataset(cols, range);
  engine.addSample(id, ds);
  const ws = emptyWorkspace();
  ws.samples = [{ id, name: `${id} Rainbow`, fileName: `${id}.fcs`, fileSize: 0, eventCount: ds.eventCount, channels: ds.channels.map((c) => ({ name: c.name, label: '', range: c.range })), compId: null }];
  return ws;
}

function rainbowDraft(sampleId: string): MesfDraft {
  const kit = getBeadKit('spherotech-rcp-30-5a')!;
  const d = emptyMesf();
  d.sampleId = sampleId;
  d.kitId = kit.id;
  d.chans = [chanFromKit(kit, d, 'FITC-A', '')];
  // values typed from the certificate (not the stored example values)
  d.chans[0].edited = d.chans[0].refs.map((_, i) => i > 0);
  return d;
}

// ---------------------------------------------------------------- 1

describe('QC 1: MESF statistics of dim populations keep the events at or below 0 MFI', () => {
  const fit = { method: 'log' as const, slope: 1, intercept: Math.log10(1.2), r2: 1 };
  const def: MesfDerived = { id: 'm', kind: 'mesf', name: 'm', channel: 'FL1-A', unit: 'MESF', fit, outputs: [{ name: 'FL1-A MESF', range: 1e6 }] };
  const n = 100000;
  const { g } = rng(7);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = 20 + 100 * g(); // N(20, 100): 42 % of the events at or below 0 MFI
  const idx = allIndices(n);
  const raw = channelStats(v, idx);
  const m = computeDerived(def, { rawColumns: [], rawNames: [], channel: () => v })![0];
  const cs = channelStats(m, idx);

  it('median and percentiles equal the calibrated MFI statistics (before the fix: median 91.4 instead of 26.3)', () => {
    expect(cs.excluded).toBe(0);
    expect(mesfValue(fit, raw.median)).toBeCloseTo(26.3, 1);
    expect(cs.median / mesfValue(fit, raw.median)).toBeCloseTo(1, 4);
    // the old conversion (non-positive events dropped) shows the bias the fix removes
    const old = channelStats(toMesf(fit, v, { nonPositive: 'nan' }), idx);
    expect(old.excluded).toBeGreaterThan(0.4 * n);
    expect(old.median).toBeGreaterThan(3 * cs.median);
    const q = (s: Float32Array, p: number) => s[Math.round(p * (s.length - 1))];
    for (const p of [0.6, 0.75, 0.9, 0.99]) expect(q(cs.sorted, p) / mesfValue(fit, q(raw.sorted, p))).toBeCloseTo(1, 4);
    // events at or below 0 MFI are 0, the continuous limit of the power law (rank kept)
    expect(q(cs.sorted, 0.25)).toBe(0);
    expect(cs.min).toBe(0);
  });

  it('geometric mean over the positive events only; linear fits and slope <= 0 unaffected', () => {
    let lg = 0;
    let k = 0;
    for (const x of m) if (x > 0) (lg += Math.log(x)), k++;
    expect(cs.geomean).toBeCloseTo(Math.exp(lg / k), 2);
    const lin = computeDerived({ ...def, fit: { method: 'linear', slope: 2, intercept: 10, r2: 1 } }, { rawColumns: [], rawNames: [], channel: () => Float32Array.of(-5, 0, 5) })![0];
    expect(Array.from(lin)).toEqual([0, 10, 20]);
    // a non-increasing power law has no 0 limit: no value
    expect(Number.isNaN(toMesf({ method: 'log', slope: -1, intercept: 0 }, Float32Array.of(-1), { nonPositive: 'zero' })[0])).toBe(true);
  });

  it('log display: zeros sit off-scale below the axis, the scale and the mode come from the positive values', () => {
    const sc = dataLogScale(m)!;
    expect(sc.type).toBe('log');
    const min = sc.type === 'log' ? sc.min : NaN;
    expect(min).toBeGreaterThan(0);
    const fwd = makeScale(sc).fwd(0);
    expect(Number.isFinite(fwd) && fwd < 0).toBe(true);
    const withScale = channelStats(m, idx, sc);
    expect(withScale.mode).toBeGreaterThan(min);
  });
});

// ---------------------------------------------------------------- 2

describe('QC 2: detector saturation of MESF beads', () => {
  it('flags the brightest bead at the detector maximum and leaves it out of the fit (before: accepted silently)', () => {
    const { area, raw } = rainbow(1.0);
    const det = findBeadPeaks(area, 8);
    expect(det.ok).toBe(true);
    expect(det.peaks[7].median).toBe(TOP);
    const sat = beadSaturation(area, det.peaks, { range: 262144 });
    expect(sat.saturated).toEqual([false, false, false, false, false, false, false, true]);
    expect(sat.reasons[7].join()).toMatch(/at the top of the range/);
    expect(sat.reasons[7].join()).toMatch(/median at the top of the range/);
    // sample at 0.8 x the brightest bead: +1.4 % with the saturated bead, about 0 without
    const truth = 0.8 * 271647;
    const all = fitMesf(det.peaks, RCP);
    const ok = fitMesf(det.peaks, RCP, { exclude: [7] });
    expect(mesfValue(all, truth) / truth - 1).toBeGreaterThan(0.01);
    expect(Math.abs(mesfValue(ok, truth) / truth - 1)).toBeLessThan(0.003);
    expect(Math.abs(ok.slope - 1)).toBeLessThan(0.003);
    // unclipped data: nothing flagged
    const clean = findBeadPeaks(raw.map((x) => x * 0.8), 8);
    expect(beadSaturation(raw.map((x) => x * 0.8), clean.peaks, { range: 1e6 }).saturated.every((s) => !s)).toBe(true);
  });

  it('P8 entirely at the detector maximum (median 262143, rCV 0): all three criteria', () => {
    const { area } = rainbow(1.4);
    const det = findBeadPeaks(area, 8);
    expect(det.peaks[7].rcvPct).toBe(0);
    const sat = beadSaturation(area, det.peaks, { range: 262144 });
    expect(sat.saturated[7]).toBe(true);
    expect(sat.reasons[7]).toHaveLength(3);
    expect(sat.reasons[7][2]).toMatch(/no spread/);
    expect(sat.saturated.slice(0, 7).every((s) => !s)).toBe(true);
  });

  it('saturation of the height channel alone flags the bead (as on the size page)', () => {
    const { raw } = rainbow(1.0, 99, Infinity);
    const h = Float32Array.from(raw, (v) => Math.min(TOP, v * 1.1));
    const det = findBeadPeaks(raw, 8);
    expect(beadSaturation(raw, det.peaks, { range: 1e6 }).saturated[7]).toBe(false);
    const sat = beadSaturation(raw, det.peaks, { range: 1e6, height: h, heightRange: 262144 });
    expect(sat.heightLevel).not.toBeNull();
    expect(sat.saturated[7]).toBe(true);
    expect(saturationLevel(raw, 1e6)).toBeNull();
  });

  it('MESF page: saturated bead out of the fit by default, kept on request, recorded in the report', () => {
    const { area } = rainbow(1.0);
    const ws = beadWorkspace('qc2beads', { 'FITC-A': area });
    const d = rainbowDraft('qc2beads');
    const r = analyseMesf(ws, d, d.chans[0]);
    expect(r.matched).toBe(true);
    expect(isSaturatedBead(r, d.chans[0], 7)).toBe(true);
    expect(r.exclude).toEqual([7]);
    expect(r.fit!.n).toBe(6);
    expect(r.fit!.points[7].used).toBe(false);
    expect(Math.abs(r.fit!.slope - 1)).toBeLessThan(0.003);
    // the user ticks "In fit": kept
    const kept = { ...d.chans[0], keepSaturated: d.chans[0].refs.map((_, i) => i === 7) };
    const r2 = analyseMesf(ws, d, kept);
    expect(r2.exclude).toEqual([]);
    expect(r2.fit!.n).toBe(7);
    // report: provenance of a saturated bead left out
    const def: MesfDef = {
      id: 'q',
      kind: 'mesf',
      name: 'FITC-A MEFL',
      channel: 'FITC-A',
      unit: 'MEFL',
      outputs: [{ name: 'FITC MEFL', range: 1e6 }],
      fit: { method: 'log', slope: r.fit!.slope, intercept: r.fit!.intercept, r2: r.fit!.r2 },
      calibratedRange: r.fit!.calibratedRange,
      beads: { medians: r.peaks.map((p) => p.median), refs: RCP, labels: ['Blank', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'], excluded: [7], saturated: [7], valuesSource: 'user' },
    };
    expect(mesfReportCsv(def)).toContain('P8,271647,262143,');
    expect(mesfReportCsv(def)).toMatch(/P8,.*no \(detector saturated\)/);
    expect(mesfReportText(def)).toContain('Detector saturation: P8 left out of the regression');
    expect(mesfReportText({ ...def, beads: { ...def.beads!, excluded: [] } })).toMatch(/WARNING: P8 flagged as saturated but kept/);
  });
});

// ---------------------------------------------------------------- 3

describe('QC 3: calibrated range of an MESF calibration', () => {
  const med = [41.2, 455.3, 1150.8, 3750.1, 9010.4, 26700.0, 74500.9, 152000.3];

  it('is the bead range of the fit, with the blank detection threshold', () => {
    const f = fitMesf(med, RCP, { unit: 'MEFL', exclude: [7] });
    expect(f.calibratedRange.mfi).toEqual([455.3, 74500.9]);
    expect(f.calibratedRange.mesf[0]).toBeCloseTo(mesfValue(f, 455.3), 6);
    expect(f.calibratedRange.mesf[1]).toBeCloseTo(mesfValue(f, 74500.9), 6);
    // MFI 10 and 262143 are extrapolated (before the fix: no warning anywhere)
    expect(calibratedRangePosition(f.calibratedRange, mesfValue(f, 10))).toBe('below');
    expect(calibratedRangePosition(f.calibratedRange, mesfValue(f, 262143))).toBe('above');
    expect(calibratedRangePosition(f.calibratedRange, mesfValue(f, 5000))).toBe('in');
    expect(calibratedRangePosition(f.calibratedRange, f.calibratedRange.mesf[1])).toBe('in');
    const { area } = rainbow(0.8);
    const det = findBeadPeaks(area, 8);
    const fb = fitMesf(det.peaks, RCP);
    expect(fb.calibratedRange.blankThresholdMfi).toBeCloseTo(fb.blank!.thresholdMfi, 6);
    expect(fb.calibratedRange.blankThresholdMesf).toBeCloseTo(fb.blank!.thresholdValue, 6);
  });

  const range = { mfi: [455.3, 152000.3] as [number, number], mesf: [800, 270000] as [number, number], blankThresholdMfi: 120, blankThresholdMesf: 210 };
  const def = (extra: Partial<MesfDerived> = {}): MesfDerived => ({ id: 'm', kind: 'mesf', name: 'FITC-A MEFL', channel: 'FITC-A', unit: 'MEFL', fit: { method: 'log', slope: 1, intercept: 0.24, r2: 1 }, outputs: [{ name: 'FITC MEFL', range: 1e6 }], ...extra });

  it('statistics outside the range get a note; spreads, other channels and older calibrations do not', () => {
    const ds: DerivedDef[] = [def({ calibratedRange: range })];
    expect(calibratedRangeNote(ds, 'FITC MEFL', 'median', 100)).toMatch(/^Outside the calibrated bead range \(800 to 270,000 MEFL\): below the dimmest bead.*detection threshold \(210 MEFL\)/);
    expect(calibratedRangeNote(ds, 'FITC MEFL', 'percentile', 5e5)).toMatch(/above the brightest bead/);
    expect(calibratedRangeNote(ds, 'FITC MEFL', 'mean', 400)).not.toMatch(/detection threshold/);
    expect(calibratedRangeNote(ds, 'FITC MEFL', 'median', 1000)).toBeNull();
    expect(calibratedRangeNote(ds, 'FITC MEFL', 'sd', 5e5)).toBeNull();
    expect(calibratedRangeNote(ds, 'FITC MEFL', 'cv', 5e5)).toBeNull();
    expect(calibratedRangeNote(ds, 'FITC-A', 'median', 5e5)).toBeNull();
    expect(calibratedRangeNote(ds, 'FITC MEFL', 'median', NaN)).toBeNull();
    // a workspace saved before the range was stored: no mark, no error
    expect(calibratedRangeNote([def()], 'FITC MEFL', 'median', 5e5)).toBeNull();
    expect(calibratedRangeNote(undefined, 'FITC MEFL', 'median', 5e5)).toBeNull();
  });

  it('statistics table cells: a note per out-of-range MESF cell (dagger in the table)', () => {
    const ws = emptyWorkspace();
    ws.derived = [def({ calibratedRange: range })];
    const t: TableDef = {
      id: 't',
      name: 'T',
      sampleSet: 'all',
      columns: [
        { id: 'c1', population: 'root', stat: 'median', channel: 'FITC MEFL' },
        { id: 'c2', population: 'root', stat: 'count' },
        { id: 'c3', population: 'root', stat: 'rsd', channel: 'FITC MEFL' },
      ],
    };
    const notes = tableRangeNotes(ws, t, [
      ['s1', 50, 1000, 1e6],
      ['s2', 5000, 20, null],
    ]);
    expect(notes[0][0]).toMatch(/below the dimmest/);
    expect(notes[0][1]).toBeNull();
    expect(notes[0][2]).toBeNull();
    expect(notes[1]).toEqual([null, null, null]);
  });

  it('the report states the range; older calibrations without it still give a report', () => {
    const d: MesfDef = { ...def({ calibratedRange: range }), beads: { medians: med, refs: RCP, valuesSource: 'user' } };
    const txt = mesfReportText(d);
    expect(txt).toContain('Calibrated range (beads in the regression): 455.3 to 152,000 MFI = 800 to 270,000 MEFL; values outside it are extrapolated');
    expect(txt).toContain('MFI <= 0 is set to 0');
    expect(txt).not.toMatch(/—/);
    expect(mesfReportCsv(d)).toContain('"Calibrated range, beads in the fit (MEFL)",800 to 270000');
    const old = mesfReportText({ ...d, calibratedRange: undefined });
    expect(old).not.toContain('Calibrated range');
    expect(mesfReportCsv({ ...d, calibratedRange: undefined })).not.toContain('Calibrated range');
  });

  it('the MESF page stores the range with the fit it shows', () => {
    const { area } = rainbow(0.8, 4);
    const ws = beadWorkspace('qc3beads', { 'FITC-A': area });
    const d = rainbowDraft('qc3beads');
    const r = analyseMesf(ws, d, d.chans[0]);
    const cr = r.fit!.calibratedRange;
    expect(cr.mfi[0]).toBeCloseTo(r.peaks[1].median, 6);
    expect(cr.mfi[1]).toBeCloseTo(r.peaks[7].median, 6);
    expect(cr.mesf[1] / 271647).toBeCloseTo(1, 1);
  });
});

// ---------------------------------------------------------------- 4

describe('QC 4: size calibration range while σ(d) rises', () => {
  const setup: ScatterSetup = { wavelengthNm: 405, nMedium: 1.343091653, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 53.2 } };
  const ev = evModelFcmpass('average');

  it('EV average model at 53.2°: valid 20 to 1500 nm (before: 20 to 350), 351 to 417 nm reported as low resolution', () => {
    const c = buildSizeCurve(ev, setup);
    for (let i = 1; i < c.sigmaNm2.length; i++) expect(c.sigmaNm2[i]).toBeGreaterThan(c.sigmaNm2[i - 1]);
    expect(c.validRangeNm).toEqual([20, 1500]);
    expect(c.endsAtFlat).toBe(false);
    expect(c.endsAtMaximum).toBe(false);
    expect(c.lowResolutionNm).toEqual([[351, 417]]);
    expect(c.ambiguousNm).toBeNull();
    // the legacy behaviour of stored calibrations is still available
    const legacy = buildSizeCurve(ev, setup, { endAtLowSlope: true });
    expect(legacy.validRangeNm).toEqual([20, 350]);
    expect(legacy.endsAtFlat).toBe(true);
    // threshold 0: no bands
    expect(buildSizeCurve(ev, setup, { minLogSlope: 0 }).lowResolutionNm).toEqual([]);
  });

  it('round trip d -> σ -> d over the whole range, monotone PCHIP inversion', () => {
    const c = buildSizeCurve(ev, setup);
    let worst = 0;
    for (let d = 20.3; d <= 1499; d += 3.37) {
      const s = apertureCrossSection({ ...ev, diameterNm: d } as never, setup.geometry, setup.wavelengthNm, setup.nMedium);
      const back = scatterToDiameter(c, Float64Array.of(s))[0];
      worst = Math.max(worst, Math.abs(back / d - 1));
    }
    expect(worst).toBeLessThan(1e-4);
    for (let i = 1; i < c.lnSigma.length; i++) expect(c.lnSigma[i]).toBeGreaterThan(c.lnSigma[i - 1]);
    const ls0 = c.lnSigma[0];
    const ls1 = c.lnSigma[c.lnSigma.length - 1];
    const xs = Float64Array.from({ length: 20001 }, (_, i) => Math.exp(ls0 + ((ls1 - ls0) * (i + 0.5)) / 20001));
    const ds = scatterToDiameter(c, xs);
    for (let i = 1; i < ds.length; i++) expect(ds[i]).toBeGreaterThanOrEqual(ds[i - 1]);
  });

  it('user limits and the noise limit still bound the range', () => {
    const c = buildSizeCurve(ev, setup, { rangeNm: [100, 600] });
    expect(c.validRangeNm).toEqual([100, 600]);
    expect(c.lowResolutionNm).toEqual([[351, 417]]);
    const s = apertureCrossSections(ev, [50, 380, 800], setup);
    const out = scatterToDiameter(c, Float64Array.from(s));
    expect(Number.isNaN(out[0]) && Number.isNaN(out[2])).toBe(true);
    expect(out[1]).toBeCloseTo(380, 1);
    expect(buildSizeCurve(ev, setup, { rangeNm: [57, 1500] }).validRangeNm).toEqual([57, 1500]);
  });

  it('stored calibrations: new ones size events above the flat stretch, older ones keep their results', () => {
    const def: SizeDerived = { id: 's', kind: 'size', name: 'size', channel: 'SSC-A', nm2PerAu: 1, setup, model: ev, outputs: [{ name: 'SSC diameter', range: 1500, unit: 'nm' }] };
    const s = Float32Array.from(apertureCrossSections(ev, [100, 380, 800, 1400], setup));
    const src = { rawColumns: [], rawNames: [], channel: () => s };
    const now = computeDerived({ ...def, lowSlopeBands: true }, src)![0];
    [100, 380, 800, 1400].forEach((d, i) => expect(now[i] / d).toBeCloseTo(1, 3));
    const old = computeDerived(def, src)![0];
    expect(old[0] / 100).toBeCloseTo(1, 3);
    expect(Array.from(old.slice(1)).every(Number.isNaN)).toBe(true);
  });

  it('preview counters: below / above range (not sized) and events at low resolution', () => {
    const c = buildSizeCurve(ev, setup);
    const sig = apertureCrossSections(ev, [100, 200, 380, 400, 1000], setup);
    const raw = Float32Array.from([...sig, c.validSigmaNm2[0] / 3, NaN, c.validSigmaNm2[1] * 3]);
    const p = sizePreviewCounts(c, raw, 1);
    expect(p.sized).toHaveLength(5);
    expect(p.below).toBe(2);
    expect(p.above).toBe(1);
    expect(p.lowRes).toBe(2);
  });

  it('the report lists the low-resolution bands', () => {
    const c = buildSizeCurve(ev, setup);
    const def: SizeDef = {
      id: 's',
      kind: 'size',
      name: 'VSSC1-A size',
      channel: 'VSSC1-A',
      nm2PerAu: 0.00365,
      setup,
      model: ev,
      minLogSlope: 0.5,
      lowSlopeBands: true,
      outputs: [{ name: 'VSSC1 diameter', range: 1500 }],
      fit: { method: 'cv', halfAngleDeg: 53.2, r2Log: 0.99, cvPct: 3, beads: [], validRangeNm: c.validRangeNm, validSigmaNm2: c.validSigmaNm2, endsAtMaximum: false, endsAtFlat: false, minLogSlope: 0.5, lowResolutionNm: c.lowResolutionNm, ambiguousNm: null },
    };
    const txt = sizeReportText(def);
    expect(txt).toContain('- Valid range: 20 to 1,500 nm');
    expect(txt).toContain('- Low size resolution: 351 to 417 nm (log-log slope of σ(d) below 0.50; σ(d) still rises, so these events are sized');
    expect(txt).not.toMatch(/turns flat/);
    expect(txt).not.toMatch(/[—]/);
    const csv = sizeReportCsv(def);
    expect(csv).toContain('"Low size resolution (nm; sized, imprecise)",351 to 417');
    expect(csv).toContain('Low size resolution below a log-log slope of sigma(d) of,0.5');
  });
});

// ---------------------------------------------------------------- 5

describe('QC 5: reference values of a kit template without preset values', () => {
  it('Quantum MESF template: typed values are the user\'s even with an empty entry', () => {
    const kit = getBeadKit('bangs-quantum-mesf-555')!;
    expect(kit.valuesStatus).toBe('empty');
    const c = chanFromKit(kit, { customLabels: [] }, 'FL1-A', '');
    // nothing typed yet: no preset values are claimed either
    expect(valuesSource(kit, c)).toBe('user');
    c.refs = [0, 5000, 15000, 50000, 150000, null];
    c.edited = [false, true, true, true, true, false];
    expect(valuesSource(kit, c)).toBe('user'); // before the fix: 'mixed' (asked to confirm example values)
    c.present[5] = false;
    expect(valuesSource(kit, c)).toBe('user');
  });
  it('kits with example values keep their provenance rules', () => {
    const rcp = getBeadKit('spherotech-rcp-30-5a')!;
    const c = chanFromKit(rcp, { customLabels: [] }, 'FITC-A', '');
    expect(valuesSource(rcp, c)).toBe('kit-example');
    expect(valuesSource(rcp, { ...c, edited: c.edited.map((_, i) => i === 2) })).toBe('mixed');
    expect(valuesSource(rcp, { ...c, edited: c.edited.map((_, i) => i > 0) })).toBe('user');
  });
});
