// Calibration reports (CSV + MIFlowCyt-EV-style text) built from stored derived definitions. Pure functions.
import { getBeadKit } from '../../core/beads';
import { APP_NAME } from '../../core/model';
import { csvLine, csvNum, describeModel, fmtNum, kitName, nmBandsText, riNumber, type MesfDef, type SizeDef } from './util';

const METHOD_TEXT: Record<string, string> = {
  log: 'ordinary least squares, log10(reference) = a + b * log10(MFI)',
  weightedLog: 'weighted least squares (weights = events / rCV²), log10(reference) = a + b * log10(MFI)',
  linear: 'ordinary least squares, reference = a + b * MFI',
};

const SIZE_METHOD_TEXT: Record<string, string> = {
  cv: 'half-angle with the lowest CV of measured/predicted ratios (FCMPASS, Welsh et al. 2020); factor = mean ratio',
  lsq: 'half-angle with the lowest RMS log residual (least squares in log space); factor = geometric mean ratio',
  fixed: 'fixed (known) half-angle; factor = mean measured/predicted ratio',
};

export function valuesSourceText(src: string | undefined): string {
  switch (src) {
    case 'user':
      return 'entered by the user (lot certificate)';
    case 'kit-example':
      return 'EXAMPLE values of another lot stored in the kit preset: NOT valid for your lot';
    case 'kit-nominal':
      return 'nominal kit values (not lot-specific)';
    case 'mixed':
      return 'partly entered by the user, partly kit preset values (check against your certificate)';
    default:
      return 'not recorded';
  }
}

function kitText(kitId: string | undefined, fallback?: string): string {
  const kit = kitId ? getBeadKit(kitId) : undefined;
  if (!kit) return fallback || (kitId === 'custom' ? 'custom beads' : 'not recorded');
  return `${kitName(kit)} (${kit.vendor}${kit.catalog ? `, cat. ${kit.catalog}` : ''})`;
}

function dateText(iso?: string): string {
  return (iso ?? new Date().toISOString()).slice(0, 10);
}

// ---------------------------------------------------------------- MESF

/** The stored calibrated range of an MESF calibration when it is complete (older workspaces have none). */
function calibratedRangeOf(d: MesfDef): { mfi: [number, number]; mesf: [number, number] } | null {
  const r = d.calibratedRange;
  return r && Array.isArray(r.mfi) && Array.isArray(r.mesf) && [...r.mfi, ...r.mesf].every((v) => Number.isFinite(v)) ? r : null;
}

export function mesfReportCsv(d: MesfDef): string {
  const b = d.beads;
  const unit = d.unit;
  const out = d.outputs[0]?.name ?? '';
  const lines: string[] = [];
  lines.push(csvLine([`${APP_NAME} fluorescence calibration report`]));
  lines.push(csvLine(['Calibration', d.name]));
  lines.push(csvLine(['Channel', d.channel]));
  lines.push(csvLine(['Output channel', out]));
  lines.push(csvLine(['Unit', unit]));
  lines.push(csvLine(['Bead sample', b?.sampleName ?? '']));
  lines.push(csvLine(['Population', b?.populationName ?? '']));
  lines.push(csvLine(['Bead kit', kitText(b?.kitId, b?.kit)]));
  lines.push(csvLine(['Kit values for', b?.fluor ?? '']));
  lines.push(csvLine(['Lot', b?.lot ?? '']));
  lines.push(csvLine(['Reference values', valuesSourceText(b?.valuesSource)]));
  lines.push(csvLine(['Regression', METHOD_TEXT[d.fit.method] ?? d.fit.method]));
  lines.push(csvLine(['Slope b', csvNum(d.fit.slope)]));
  lines.push(csvLine(['Intercept a', csvNum(d.fit.intercept)]));
  lines.push(csvLine(['R squared', csvNum(d.fit.r2, 8)]));
  if (b?.blankMedian !== undefined) lines.push(csvLine(['Blank median (MFI)', csvNum(b.blankMedian)]));
  if (b?.blankRsd !== undefined) lines.push(csvLine(['Blank robust SD (MFI)', csvNum(b.blankRsd)]));
  if (b?.threshold !== undefined) lines.push(csvLine([`Detection threshold, blank median + 2 rSD (${unit})`, csvNum(b.threshold)]));
  const cr = calibratedRangeOf(d);
  if (cr) {
    lines.push(csvLine(['Calibrated range, beads in the fit (MFI)', `${csvNum(cr.mfi[0])} to ${csvNum(cr.mfi[1])}`]));
    lines.push(csvLine([`Calibrated range, beads in the fit (${unit})`, `${csvNum(cr.mesf[0])} to ${csvNum(cr.mesf[1])}`]));
    lines.push(csvLine(['Values outside the calibrated range', 'extrapolated from the regression']));
  }
  lines.push(csvLine(['Applied to', d.samples ? `${d.samples.length} selected samples` : 'all samples with the channel']));
  lines.push(csvLine(['Created', dateText(d.created)]));
  lines.push('');
  lines.push(csvLine(['Bead', `Reference (${unit})`, 'Median (MFI)', 'rCV (%)', 'Events', 'Used in fit']));
  if (b) {
    const excl = new Set(b.excluded ?? []);
    const sat = new Set(b.saturated ?? []);
    b.medians.forEach((m, i) => {
      const ref = b.refs[i];
      const used = ref !== null && ref > 0 && !excl.has(i);
      const use = ref === 0 ? 'blank' : used ? (sat.has(i) ? 'yes (saturated, kept by the user)' : 'yes') : sat.has(i) ? 'no (detector saturated)' : 'no';
      lines.push(csvLine([b.labels?.[i] ?? `Bead ${i + 1}`, ref === null ? '' : ref, m, b.rcvPct?.[i] ?? '', b.counts?.[i] ?? '', use]));
    });
  }
  return lines.join('\r\n') + '\r\n';
}

export function mesfReportText(d: MesfDef): string {
  const b = d.beads;
  const unit = d.unit;
  const n = b ? b.refs.filter((r, i) => r !== null && r > 0 && !(b.excluded ?? []).includes(i)).length : NaN;
  const hasBlank = !!b?.refs.some((r) => r === 0);
  const eq = d.fit.method === 'linear' ? `${unit} = ${fmtNum(d.fit.intercept, 5)} + ${fmtNum(d.fit.slope, 5)} x MFI` : `log10(${unit}) = ${d.fit.intercept.toFixed(4)} + ${d.fit.slope.toFixed(4)} x log10(MFI)`;
  const L: string[] = [];
  L.push(`Fluorescence calibration (MIFlowCyt-EV, ${dateText(d.created)})`);
  L.push(`- Channel ${d.channel} was calibrated in ${unit} with ${kitText(b?.kitId, b?.kit)}${b?.lot ? `, lot ${b.lot}` : ', lot not recorded'}.`);
  L.push(`- Reference values: ${valuesSourceText(b?.valuesSource)}.`);
  if (b) L.push(`- Bead sample: ${b.sampleName ?? 'not recorded'}${b.populationName ? ` (population ${b.populationName})` : ''}; ${b.medians.length} bead populations${hasBlank ? ' incl. blank' : ''}, ${n} used in the regression; medians of the detected bead populations.`);
  L.push(`- Regression: ${eq} (${d.fit.method === 'weightedLog' ? 'weighted least squares' : 'ordinary least squares'}), R² = ${d.fit.r2.toFixed(5)}.`);
  if (b?.saturated?.length) {
    const name = (i: number) => b.labels?.[i] ?? `bead ${i + 1}`;
    const excl = new Set(b.excluded ?? []);
    const out = b.saturated.filter((i) => excl.has(i));
    const kept = b.saturated.filter((i) => !excl.has(i));
    if (out.length) L.push(`- Detector saturation: ${out.map(name).join(', ')} left out of the regression (compressed median${out.length > 1 ? 's' : ''}).`);
    if (kept.length) L.push(`- WARNING: ${kept.map(name).join(', ')} flagged as saturated but kept in the regression by the user; the slope and values near the top are biased.`);
  }
  if (b?.threshold !== undefined && Number.isFinite(b.threshold))
    L.push(`- Detection threshold (blank median + 2 robust SD): ${b.blankMedian !== undefined && b.blankRsd !== undefined ? `${fmtNum(b.blankMedian + 2 * b.blankRsd)} MFI = ` : ''}${fmtNum(b.threshold)} ${unit}.`);
  const cr = calibratedRangeOf(d);
  if (cr)
    L.push(`- Calibrated range (beads in the regression): ${fmtNum(cr.mfi[0])} to ${fmtNum(cr.mfi[1])} MFI = ${fmtNum(cr.mesf[0])} to ${fmtNum(cr.mesf[1])} ${unit}; values outside it are extrapolated from the regression.`);
  L.push(
    `- Calibrated output: "${d.outputs[0]?.name ?? ''}" (${unit}), applied to ${d.samples ? `${d.samples.length} selected samples` : 'all samples with this channel'}${
      d.fit.method === 'linear' ? '' : '; MFI <= 0 is set to 0 (the limit of the log fit, so medians and percentiles keep their rank; the geometric mean uses positive values only)'
    }.`,
  );
  L.push(`- Analysis software: ${APP_NAME} (browser-based).`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- size

export function sizeReportCsv(d: SizeDef): string {
  const f = d.fit;
  const g = d.setup.geometry;
  const lam = d.setup.wavelengthNm;
  const lines: string[] = [];
  lines.push(csvLine([`${APP_NAME} light-scatter calibration report`]));
  lines.push(csvLine(['Calibration', d.name]));
  lines.push(csvLine(['Scatter channel', d.channel]));
  lines.push(csvLine(['Output channels', d.outputs.map((o) => o.name).join('; ')]));
  lines.push(csvLine(['Wavelength (nm)', lam]));
  lines.push(csvLine(['Medium / sheath RI', csvNum(d.setup.nMedium, 7)]));
  lines.push(csvLine(['Detector polar angle theta (deg)', g.thetaDeg]));
  lines.push(csvLine(['Detector azimuth phi from polarization (deg)', g.phiDeg]));
  lines.push(csvLine(['Collection half-angle (deg)', csvNum(g.halfAngleDeg)]));
  lines.push(csvLine(['Obscuration half-angle (deg)', g.obscurationHalfAngleDeg ?? 0]));
  lines.push(csvLine(['Polarization', g.polarization ?? 'linear']));
  lines.push(csvLine(['Half-angle method', f ? SIZE_METHOD_TEXT[f.method] ?? f.method : 'not recorded']));
  lines.push(csvLine(['Calibration factor (nm2 per a.u.)', csvNum(d.nm2PerAu)]));
  lines.push(csvLine(['a.u. per nm2', csvNum(1 / d.nm2PerAu)]));
  for (const c of f?.channelFactors ?? [])
    lines.push(csvLine([`Factor of ${c.channel} (shared half-angle; nm2 per a.u.)`, `${csvNum(c.nm2PerAu)} from ${c.beads} beads${c.beads > 1 && Number.isFinite(c.cvPct) ? `, CV ${csvNum(c.cvPct, 3)} %` : ''}`]));
  if (f) {
    if (f.poorFit) lines.push(csvLine(['WARNING', `poor bead fit (CV of ratios ${csvNum(f.poorFit.cvPct, 3)} %, largest residual ${csvNum(f.poorFit.maxResidualPct, 3)} %), applied after explicit confirmation`]));
    lines.push(csvLine(['CV of measured/predicted ratios (%)', csvNum(f.cvPct, 4)]));
    lines.push(csvLine(['R squared (log)', csvNum(f.r2Log, 8)]));
    if (f.rmsLog !== undefined) lines.push(csvLine(['RMS log10 residual', csvNum(f.rmsLog, 4)]));
  }
  lines.push(csvLine(['Particle model', describeModel(d.model, lam)]));
  const vr = f?.validRangeNm;
  if (vr) lines.push(csvLine(['Valid diameter range (nm)', `${csvNum(vr[0])} to ${csvNum(vr[1])}`]));
  if (vr) lines.push(csvLine(['Valid range ends', f?.endsAtMaximum ? 'at the first Mie resonance maximum' : f?.endsAtFlat ? `where the log-log slope of sigma(d) falls below ${csvNum(f.minLogSlope ?? 0.5, 3)}` : 'at the range limit']));
  if (f?.minLogSlope !== undefined) lines.push(csvLine([d.lowSlopeBands ? 'Low size resolution below a log-log slope of sigma(d) of' : 'Minimum log-log slope of sigma(d)', csvNum(f.minLogSlope, 3)]));
  for (const [a, b] of f?.lowResolutionNm ?? []) lines.push(csvLine(['Low size resolution (nm; sized, imprecise)', `${csvNum(a)} to ${csvNum(b)}`]));
  if (f?.ambiguousNm) lines.push(csvLine(['Ambiguous diameters (nm; signals also fit particles above the Mie maximum)', `${csvNum(f.ambiguousNm[0])} to ${csvNum(f.ambiguousNm[1])}`]));
  for (const r of f?.resolution ?? []) lines.push(csvLine([`Size error per 1 % scatter error at ${csvNum(r.diameterNm, 4)} nm (%)`, csvNum(r.pctPerPct, 4)]));
  if (f?.validSigmaNm2) lines.push(csvLine(['Valid cross-section range (nm2)', `${csvNum(f.validSigmaNm2[0])} to ${csvNum(f.validSigmaNm2[1])}`]));
  if (d.rangeNm) lines.push(csvLine([f?.rangeFromNoise ? 'Inversion range from the noise level (nm)' : 'Inversion range limited to (nm)', `${d.rangeNm[0]} to ${d.rangeNm[1]}`]));
  if (f?.noiseFloor) lines.push(csvLine(['Noise population median', `${csvNum(f.noiseFloor.au)} a.u. = ${csvNum(f.noiseFloor.sigmaNm2)} nm2 = ${Number.isFinite(f.noiseFloor.diameterNm) ? csvNum(f.noiseFloor.diameterNm, 4) + ' nm (model)' : 'below the model range'}`]));
  lines.push(csvLine(['Applied to', d.samples ? `${d.samples.length} selected samples` : 'all samples with the channel']));
  lines.push(csvLine(['Created', dateText(d.created)]));
  lines.push('');
  for (const s of f?.setups ?? [])
    lines.push(csvLine([`Beads in ${s.sampleName ?? 'sample'}`, `${s.kitName ?? s.kitId ?? 'custom'}; lot ${s.lot ?? 'not recorded'}; diameters ${diamSourceText(s.valuesSource)}; channel ${s.channel ?? d.channel}`]));
  lines.push('');
  lines.push(csvLine(['Bead sample', 'Kit', 'Bead', 'Diameter (nm)', `RI at ${lam} nm`, 'Used', 'Median (a.u.)', 'Events', 'rCV (%)', 'Modelled sigma (nm2)', 'Predicted (a.u.)', 'Residual (%)', 'Sized back (nm)', 'Size error (%)']));
  const sized = f?.sizedBeads ?? [];
  let k = 0;
  for (const s of f?.setups ?? []) {
    for (const bd of s.beads) {
      const fitRow = f?.beads?.[k];
      const sz = sized[k];
      k++;
      lines.push(
        csvLine([
          s.sampleName ?? '',
          s.kitName ?? s.kitId ?? '',
          bd.label,
          bd.diameterNm,
          csvNum(riNum(bd.ri, lam), 5),
          bd.use && Number.isFinite(bd.measured) ? (bd.fit === false ? 'check only' : 'yes') : bd.saturated ? 'no (saturated)' : 'no',
          bd.measured,
          bd.count ?? '',
          bd.rcvPct ?? '',
          sz?.sigmaNm2 ?? '',
          sz?.predicted ?? '',
          fitRow?.residualPct ?? '',
          sz?.sizedNm ?? '',
          sz?.sizeErrorPct ?? '',
        ]),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}

const riNum = riNumber;

function diamSourceText(src: string | undefined): string {
  switch (src) {
    case 'user':
      return 'entered by the user (certificate)';
    case 'kit-nominal':
      return 'nominal kit values, not lot certificate';
    case 'kit-example':
      return 'EXAMPLE values of other lots, not valid for this lot';
    case 'mixed':
      return 'partly EXAMPLE values of other lots';
    default:
      return 'not recorded';
  }
}

export function sizeReportText(d: SizeDef): string {
  const f = d.fit;
  const g = d.setup.geometry;
  const lam = d.setup.wavelengthNm;
  const L: string[] = [];
  L.push(`Light-scatter calibration (MIFlowCyt-EV, FCMPASS-style Mie model, ${dateText(d.created)})`);
  L.push(`- Detector ${d.channel}, ${lam} nm laser; medium/sheath RI ${d.setup.nMedium.toFixed(5)}.`);
  L.push(
    `- Collection geometry: detector axis θ ${g.thetaDeg}°, φ ${g.phiDeg}° from the polarization, ${g.polarization ?? 'linear'} polarization${g.obscurationHalfAngleDeg ? `, obscuration half-angle ${g.obscurationHalfAngleDeg}°` : ''}; collection half-angle ${g.halfAngleDeg.toFixed(1)}° (${f ? SIZE_METHOD_TEXT[f.method] ?? f.method : 'method not recorded'}).`,
  );
  L.push(`- Calibration factor ${fmtNum(d.nm2PerAu, 4)} nm² per a.u. (σ = a.u. x factor)${f ? `; CV of measured/predicted ratios ${f.cvPct.toFixed(2)} %, R² (log) ${f.r2Log.toFixed(5)}` : ''}.`);
  if (f?.channelFactors?.length)
    L.push(
      `- Bead sets on ${f.channelFactors.length} detectors with one shared half-angle and a factor per detector: ${f.channelFactors.map((c) => `${c.channel} ${fmtNum(c.nm2PerAu, 4)} nm²/a.u. (${c.beads} beads)`).join(', ')}.`,
    );
  if (f?.poorFit)
    L.push(`- WARNING: poor bead fit (CV of ratios ${f.poorFit.cvPct.toFixed(1)} %, largest residual ${f.poorFit.maxResidualPct.toFixed(0)} %; limits 10 % and 15 %). The calibration was applied after explicit confirmation; treat the sizes with caution.`);
  for (const s of f?.setups ?? []) {
    const used = s.beads.filter((b) => b.use && Number.isFinite(b.measured) && b.fit !== false);
    L.push(
      `- Reference beads: ${s.kitName ?? s.kitId ?? 'custom'}${s.lot ? `, lot ${s.lot}` : ', lot not recorded'} (diameters ${diamSourceText(s.valuesSource)}) in sample ${s.sampleName ?? 'not recorded'}${s.populationName ? ` (population ${s.populationName})` : ''}${s.channel && s.channel !== d.channel ? ` on ${s.channel}` : ''}: ${used.map((b) => `${b.diameterNm} nm (RI ${riNum(b.ri, lam).toFixed(4)})`).join(', ') || 'none used'}${
        s.beads.length > used.length ? `; not used: ${s.beads.filter((b) => !(b.use && Number.isFinite(b.measured) && b.fit !== false)).map((b) => `${b.diameterNm} nm${b.saturated ? ' (detector saturated)' : b.fit === false && b.use ? ' (sized back as a check)' : ''}`).join(', ')}` : ''
      }.`,
    );
  }
  if (f?.sizedBeads?.length) {
    const errs = f.sizedBeads.map((b) => Math.abs(b.sizeErrorPct)).filter(Number.isFinite);
    if (errs.length) L.push(`- Beads sized back with their own model: largest deviation from the stated diameter ${Math.max(...errs).toFixed(1)} %.`);
  }
  L.push(`- Particle model for sizing: ${d.model.name ? `${d.model.name}, ` : ''}${describeModel(d.model, lam)}.`);
  if (f?.validRangeNm)
    L.push(
      `- Valid range: ${fmtNum(f.validRangeNm[0])} to ${fmtNum(f.validRangeNm[1])} nm${f.validSigmaNm2 ? ` (σ ${fmtNum(f.validSigmaNm2[0])} to ${fmtNum(f.validSigmaNm2[1])} nm²)` : ''}${
        f.endsAtMaximum ? ', ending at the first Mie resonance maximum' : f.endsAtFlat ? `, ending where the curve turns flat (log-log slope of σ(d) below ${(f.minLogSlope ?? 0.5).toFixed(2)})` : ''
      }${f.rangeFromNoise ? '; the lower limit is the noise-equivalent diameter' : ''}; events outside it have no diameter.`,
    );
  if (f?.lowResolutionNm?.length)
    L.push(`- Low size resolution: ${nmBandsText(f.lowResolutionNm)} (log-log slope of σ(d) below ${(f.minLogSlope ?? 0.5).toFixed(2)}; σ(d) still rises, so these events are sized, with a size error over ${(1 / (f.minLogSlope ?? 0.5)).toFixed(1)} times the scatter error).`);
  if (f?.ambiguousNm) L.push(`- Ambiguous: signals of ${nmBandsText([f.ambiguousNm])} also fit particles above the first Mie maximum; larger particles would be sized into this band.`);
  if (f?.resolution?.length)
    L.push(`- Size resolution (size error per 1 % scatter error): ${f.resolution.map((r) => `${fmtNum(r.diameterNm, 3)} nm ${r.pctPerPct.toFixed(2)} %`).join(', ')}.`);
  if (f?.noiseFloor)
    L.push(`- Noise population median: ${fmtNum(f.noiseFloor.au)} a.u. = ${fmtNum(f.noiseFloor.sigmaNm2)} nm²${Number.isFinite(f.noiseFloor.diameterNm) ? `, corresponding to ${fmtNum(f.noiseFloor.diameterNm, 3)} nm in this model` : ''}.`);
  L.push(`- Outputs: ${d.outputs.map((o) => `"${o.name}"`).join(', ')}, applied to ${d.samples ? `${d.samples.length} selected samples` : 'all samples with this channel'}.`);
  L.push(`- Analysis software: ${APP_NAME} (browser-based), Mie theory with aperture integration as in FCMPASS.`);
  return L.join('\n') + '\n';
}
