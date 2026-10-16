// Methods & legend writer: a structured summary of the workspace built locally (shown and editable before anything is
// sent), from which the model writes a MIFlowCyt-style methods paragraph or a figure legend.
import type { DerivedDef } from '../core/derived';
import { engine } from '../core/engine';
import { APP_NAME, gateParams, popById, STAT_LABELS, type PlotItem, type SheetItem, type Workspace } from '../core/model';
import { buildSizeCurve } from '../core/scattercal';
import { applies } from '../core/scope';
import { describeScale } from '../core/transforms';
import { APP_VERSION } from '../legal/meta';
import type { MesfDef, SizeDef } from '../ui/calib/util';
import { anon, chan, instrumentOf, popName, redact, sampleHints, sampleLabel, treeText } from './context';
import { instrumentDisplayName } from '../state/store';

const uniq = <T,>(a: T[]) => [...new Set(a)];
const fmt = (v: number) => (!Number.isFinite(v) ? 'n/a' : Math.abs(v) >= 1000 || Number.isInteger(v) ? Math.round(v).toLocaleString('en-US') : v.toPrecision(3));
/** 3 significant digits, plain or (very large / small) exponent: diameters, cross sections, MESF */
const sig3 = (v: number) => (!Number.isFinite(v) ? 'n/a' : Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 0.01) ? v.toExponential(2).replace('e+', 'e') : String(Number(v.toPrecision(3))));

/** Reference values of a bead kit that are not the lot's own (calibration quality flag). */
const MESF_VALUES: Record<string, string> = {
  'kit-example': 'reference values: EXAMPLE values of another lot from the kit preset, not valid for this lot',
  mixed: 'reference values: partly preset kit values (example or nominal), not all from the lot certificate',
  'kit-nominal': 'reference values: nominal kit values, not lot-specific',
};
const SIZE_VALUES: Record<string, string> = {
  'kit-example': 'diameters: EXAMPLE values of other lots from the kit preset',
  mixed: 'diameters partly EXAMPLE values of other lots',
};

/** Methods line of a fluorescence (MESF / ERF) or scatter size calibration, with its quality flags. */
export function calibrationLine(d: Exclude<DerivedDef, { kind: 'unmix' }>): string {
  if (d.kind === 'mesf') {
    const b = (d as MesfDef).beads;
    const excl = new Set(b?.excluded ?? []);
    const used = b ? b.refs.filter((r, i) => r !== null && r > 0 && !excl.has(i)).length : 0;
    const flags = [b?.valuesSource ? MESF_VALUES[b.valuesSource] : undefined];
    const keptSat = (b?.saturated ?? []).filter((i) => !excl.has(i)).length;
    if (keptSat) flags.push(`${keptSat} bead population${keptSat > 1 ? 's' : ''} compressed by detector saturation kept in the fit`);
    // the range the beads in the fit cover (older calibrations have none): values outside it are extrapolated
    const cr = d.calibratedRange;
    const range = cr && Array.isArray(cr.mfi) && Array.isArray(cr.mesf) && [...cr.mfi, ...cr.mesf].every((v) => Number.isFinite(v)) ? `; calibrated range ${sig3(cr.mfi[0])} to ${sig3(cr.mfi[1])} MFI = ${sig3(cr.mesf[0])} to ${sig3(cr.mesf[1])} ${d.unit} (values outside it are extrapolated)` : '';
    const warn = flags.filter((x): x is string => !!x);
    return `Fluorescence calibration: ${d.channel} in ${d.unit} units, ${d.fit.method} fit (R² = ${d.fit.r2.toFixed(4)})${b ? `, beads ${b.kit ?? '[kit to fill]'}${b.lot ? ` lot ${b.lot}` : ''}, ${used} bead populations used in the fit` : ''}${range}${warn.length ? `; WARNING: ${warn.join('; ')}` : ''}.`;
  }
  const f = (d as SizeDef).fit;
  const m = d.model as { kind: string; name?: string };
  // beads that entered the fit (not unused, saturated or check-only ones)
  const sets = f?.setups ?? [];
  const beads = sets.length
    ? sets.flatMap((s) => s.beads.filter((x) => x.use && Number.isFinite(x.measured) && x.measured > 0 && x.fit !== false && !x.saturated).map((x) => `${x.diameterNm} nm`))
    : (f?.beads ?? []).filter((x) => Number.isFinite(x.measured) && x.measured > 0).map((x) => `${x.name && !x.name.includes(String(x.diameterNm)) ? `${x.name} ` : ''}${x.diameterNm} nm`);
  const kits = uniq(sets.map((s) => [s.kitName ?? s.kitId ?? '', s.lot ? `lot ${s.lot}` : ''].filter(Boolean).join(' ')).filter(Boolean));
  const vs = uniq(sets.map((s) => (s.valuesSource ? SIZE_VALUES[s.valuesSource] : undefined)).filter((x): x is string => !!x));
  // the range the inversion is valid in (stored with the calibration; older ones: from the same curve the engine uses)
  let valid = f?.validRangeNm;
  let validSig = f?.validSigmaNm2;
  let lowRes: [number, number][] = [];
  try {
    // the same curve the engine uses for this definition (older definitions end their range at the first flat stretch)
    const c = buildSizeCurve(d.model, d.setup, {
      ...(d.rangeNm ? { rangeNm: d.rangeNm } : {}),
      ...(d.minLogSlope !== undefined ? { minLogSlope: d.minLogSlope } : {}),
      ...((d as SizeDef).lowSlopeBands ? {} : { endAtLowSlope: true }),
    });
    if (!valid) {
      valid = c.validRangeNm;
      validSig = c.validSigmaNm2;
    }
    lowRes = c.lowResolutionNm ?? [];
  } catch {
    /* model or setup incomplete: no range */
  }
  const parts = [
    `Scatter size calibration: ${d.channel} to diameter (nm) by Mie theory, ${d.setup.wavelengthNm} nm laser, medium refractive index ${d.setup.nMedium}, particle model ${m.name ?? m.kind}`,
    valid ? `, valid sizing range ${sig3(valid[0])} to ${sig3(valid[1])} nm${validSig ? ` (σ ${sig3(validSig[0])} to ${sig3(validSig[1])} nm²)` : ''}` : '',
    lowRes.length ? `, low size resolution at ${lowRes.map(([a, b]) => `${sig3(a)} to ${sig3(b)} nm`).join(', ')}` : '',
    f ? `; collection half-angle ${f.halfAngleDeg.toFixed(1)}°, bead fit R² (log) ${f.r2Log.toFixed(3)}, CV of measured/predicted ${f.cvPct.toFixed(1)}%` : '',
    f ? `, beads used in the fit${kits.length ? ` (${kits.join('; ')})` : ''}: ${beads.join(', ') || 'none recorded'}` : '',
    f?.poorFit ? `; WARNING: poor bead fit (CV of ratios ${f.poorFit.cvPct.toFixed(1)}%, largest residual ${f.poorFit.maxResidualPct.toFixed(0)}%), applied after explicit confirmation` : '',
    vs.length ? `; WARNING: ${vs.join('; ')}` : '',
  ];
  return `${parts.join('')}.`;
}

const COMP_SOURCE: Record<string, string> = {
  file: 'spillover matrix stored in the FCS file (acquisition software)',
  computed: 'computed in FlowState from single-stained controls',
  manual: 'entered or edited by hand',
  gatingml: 'imported from Gating-ML',
};

/** Channels a workspace uses in gates and plots (in first-use order). */
function usedChannels(ws: Workspace): string[] {
  const out: string[] = [];
  for (const p of ws.populations) out.push(...gateParams(p.gate));
  for (const sh of ws.worksheets) for (const it of sh.items) if (it.kind === 'plot') out.push(it.xParam, ...(it.plotType === 'histogram' ? [] : [it.yParam]));
  return uniq(out);
}

/** Items of a sheet in reading order (rows, then left to right), as figure panels. */
export function panels(items: SheetItem[]): SheetItem[] {
  const vis = items.filter((i) => i.kind !== 'text');
  return vis.slice().sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x));
}

function plotLine(ws: Workspace, it: PlotItem, sid: string | null): string {
  const kind = it.plotType === 'histogram' ? 'histogram' : `${it.plotType === 'pseudo' ? 'pseudocolor' : it.plotType} plot`;
  const axes = it.plotType === 'histogram' ? chan(ws, it.xParam) : `${chan(ws, it.xParam)} (x) vs ${chan(ws, it.yParam)} (y)`;
  const layers = it.layers.filter((l) => l.visible !== false);
  const who = layers.map((l) => `${popName(ws, l.population)} of ${l.sample === 'active' ? sampleLabel(ws, sid) : sampleLabel(ws, l.sample)}`).join('; ');
  const parent = layers[0]?.population ?? 'root';
  const lsid = layers[0] && layers[0].sample !== 'active' ? layers[0].sample : sid;
  const axesSet = it.plotType === 'histogram' ? [it.xParam] : [it.xParam, it.yParam];
  const gates = it.options.showGates
    ? ws.populations
        .filter((p) => (p.parentId ?? 'root') === parent && gateParams(p.gate).length && gateParams(p.gate).every((c) => axesSet.includes(c)))
        .map((p) => {
          if (!lsid || !engine.has(lsid) || !applies(ws, lsid, p.id)) return p.name;
          const n = engine.count(ws, lsid, p.id);
          const d = engine.count(ws, lsid, parent === 'root' ? null : parent);
          return `${p.name} (${d ? ((100 * n) / d).toFixed(1) : '-'}% of parent)`;
        })
    : [];
  return `${kind} of ${axes}; ${who}${it.options.title && !anon() ? `; title "${it.options.title}"` : ''}${gates.length ? `; gates shown: ${gates.join(', ')}` : ''}`;
}

/** The summary the writer works from (plain text; the user can edit it before sending). */
export function workspaceSummary(ws: Workspace, sampleId: string | null, sheetId: string): string {
  const L: string[] = [];
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  L.push(`Software: ${APP_NAME} ${APP_VERSION} (browser-based flow cytometry analysis software).`);
  const versions = uniq(loaded.map((s) => engine.samples.get(s.id)!.ds.version.replace(/^FCS\s*/i, '')));
  const ev = loaded.map((s) => s.eventCount);
  L.push(`Data: ${ws.samples.length} FCS files${versions.length ? ` (FCS ${versions.join(', ')})` : ''}${ev.length ? `, ${fmt(Math.min(...ev))} to ${fmt(Math.max(...ev))} events per file` : ''}.`);
  const cyt = uniq(ws.samples.map((s) => instrumentOf(s.id) || s.info?.Cytometer || '').filter(Boolean));
  L.push(`Instrument ($CYT keyword): ${cyt.join(', ') || '[not in files]'}.`);
  L.push(`Samples: ${sampleHints(ws)}.`);
  // group and plate names are often donor, folder or experiment names ($PROJ, $DATE): "Group n" / "P1" when names are hidden
  if (ws.groups.length) L.push(`Sample groups: ${ws.groups.map((g, i) => `${anon() ? `Group ${i + 1}` : g.name} (${g.sampleIds.length} samples)`).join('; ')}.`);
  const plates = uniq(ws.samples.map((s) => s.plate).filter((p): p is string => !!p));
  const plateRef = (p: string) => {
    if (!anon()) return `"${p}"`;
    if (!plates.includes(p)) plates.push(p);
    return `P${plates.indexOf(p) + 1}`;
  };
  L.push('', 'Channels used (name, marker, scale used for display and gating):');
  // per-instrument axis scales (Workspace.instrumentScales): the samples of those instruments use their own scale
  const instKeys = Object.keys(ws.instrumentScales ?? {});
  for (const ch of usedChannels(ws)) {
    const own = instKeys.filter((k) => ws.instrumentScales?.[k]?.[ch]);
    const per = own.map((k) => `; samples of ${instrumentDisplayName(k, instKeys)}: ${describeScale(ws.instrumentScales![k][ch])}`).join('');
    L.push(`- ${chan(ws, ch)}: ${describeScale(engine.scaleOf(ws, ch))}${own.length ? ` (other samples)${per}` : ''}`);
  }
  if (instKeys.some((k) => Object.keys(ws.instrumentScales?.[k] ?? {}).length))
    L.push(`Axis scales are set per instrument where the instruments' ranges differ; gates drawn in ${APP_NAME} are evaluated on each sample's own instrument scale.`);
  L.push('', 'Compensation:');
  const comps = new Map<string, string[]>();
  for (const s of ws.samples) {
    const c = s.compId ? ws.compensations.find((x) => x.id === s.compId) : null;
    const k = c ? `${c.name}: ${c.channels.length} x ${c.channels.length} matrix, ${COMP_SOURCE[c.source] ?? c.source}` : 'none (uncompensated)';
    comps.set(k, [...(comps.get(k) ?? []), sampleLabel(ws, s.id)]);
  }
  for (const [k, v] of comps) L.push(`- ${k} (${v.length === ws.samples.length ? 'all samples' : v.join(', ')})`);
  for (const d of ws.derived ?? []) {
    if (d.kind === 'unmix') {
      const u = d.unmix;
      L.push(`Spectral unmixing "${d.name}": ${u.method.toUpperCase()}${u.nonNegative ? ' with non-negativity' : ''}, ${u.detectors.length} detectors, ${u.endmembers.length} fluorochromes (${u.endmembers.map((e) => e.name).join(', ')})${u.includeAF ? `, autofluorescence extracted (${u.af?.length ?? 1} signature${(u.af?.length ?? 1) > 1 ? 's' : ''})` : ''}; outputs ${d.outputs.map((o) => o.name).join(', ')}.`);
    } else L.push(calibrationLine(d));
  }
  L.push('', `Gating hierarchy (gate type and channels; counts for ${sampleLabel(ws, sampleId)}):`, treeText(ws, sampleId, 80));
  for (const t of ws.tables.slice(0, 3)) {
    if (!t.columns.length) continue;
    const grp = ws.groups.find((g) => g.id === t.sampleSet);
    const sids = (grp ? ws.samples.filter((s) => grp.sampleIds.includes(s.id)) : ws.samples).filter((s) => engine.has(s.id)).slice(0, 16);
    const head = t.columns.map((c) => c.header || `${popName(ws, c.population)} ${STAT_LABELS[c.stat]}${c.channel ? ` ${chan(ws, c.channel)}` : ''}`);
    L.push('', anon() ? `Statistics table ${ws.tables.indexOf(t) + 1}:` : `Statistics table "${t.name}":`, `Sample | ${head.join(' | ')}`);
    for (const s of sids) L.push(`${sampleLabel(ws, s.id)} | ${t.columns.map((c) => fmt(engine.stat(ws, s.id, c))).join(' | ')}`);
  }
  const sheet = ws.worksheets.find((s) => s.id === sheetId);
  if (sheet) {
    L.push('', anon() ? 'Worksheet (figure panels in reading order):' : `Worksheet "${sheet.name}" (figure panels in reading order):`);
    const texts = sheet.items.filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text.trim()).filter(Boolean);
    // free text may name donors or patients: left out while names are hidden (the summary can be edited)
    if (texts.length || (anon() && sheet.items.some((i) => i.kind === 'plot' && i.options.title)))
      L.push(anon() ? 'Plot titles and text boxes are left out while sample names are hidden.' : `Text on the sheet: ${texts.map((t) => `"${t}"`).join('; ')}`);
    panels(sheet.items).forEach((it, i) => {
      const tag = String.fromCharCode(65 + (i % 26));
      if (it.kind === 'plot') L.push(`${tag}: ${plotLine(ws, it, sampleId)}`);
      else if (it.kind === 'chart' && it.plate) L.push(`${tag}: plate heatmap of ${STAT_LABELS[it.stat.stat]} of ${popName(ws, it.stat.population)}${it.stat.channel ? ` (${chan(ws, it.stat.channel)})` : ''} per well, plate ${plateRef(it.plate.plate)}`);
      else if (it.kind === 'chart') L.push(`${tag}: ${it.style} chart of ${STAT_LABELS[it.stat.stat]} of ${popName(ws, it.stat.population)}${it.stat.channel ? ` (${chan(ws, it.stat.channel)})` : ''} by ${it.mode === 'groups' ? 'group' : 'sample'}${it.errorBars !== 'none' ? `, error bars ${it.errorBars.toUpperCase()}` : ''}`);
      else if (it.kind === 'stats') L.push(`${tag}: statistics box (${it.rows.map((r) => `${STAT_LABELS[r.stat]} of ${popById(ws, r.population)?.name ?? 'All events'}`).join(', ')})`);
    });
  }
  return redact(L.join('\n'), ws);
}


