// "Add to sheet" of the calibration pages: the bead fit and the size curve (size calibration) and the MESF regression
// become figure items on the active worksheet (chart items carrying the plotted data, see render/calibPanel.ts).
import { useStore, defaultPlotSize } from '../../state/store';
import { addItems, findFreeSlot } from '../layoutOps';
import { newCalibItem, type CalibPanel } from '../../render/calibPanel';
import { bodyPt } from '../../render/figstyle';
import { fmtFix, fmtNum } from './util';

/** Place a calibration panel on the active worksheet (at a free place, figure font size), and say where. */
export function addCalibPanelToSheet(panel: CalibPanel) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((s) => s.id === st.ui.activeSheetId) ?? st.ws.worksheets[0];
  if (!sheet) return;
  const { w, h } = defaultPlotSize();
  const pos = findFreeSlot(sheet, w, h, undefined, [], null);
  const item = newCalibItem(panel, pos.x, pos.y, w, h, bodyPt(st.ws, sheet));
  addItems(sheet.id, [item], { select: false });
  st.toast(`Added "${panel.title}" to worksheet "${sheet.name}".`, 'success', {
    action: { label: 'Show', run: () => useStore.getState().setUI({ view: 'sheet', activeSheetId: sheet.id, selectedItemIds: [item.id], selectedPopId: null, keyItemId: item.id }) },
  });
}

const finite = (v: number) => typeof v === 'number' && Number.isFinite(v);

/** Log axis limits around the values (a factor `pad` beyond them). */
function logLimits(values: number[], pad = 1.6): [number, number] {
  const v = values.filter((x) => finite(x) && x > 0);
  if (!v.length) return [1, 10];
  const lo = Math.min(...v) / pad;
  const hi = Math.max(...v) * pad;
  return [lo, hi > lo ? hi : lo * 10];
}

/** Bead fit of a size calibration: measured bead medians against the model prediction (log-log, identity line). */
export function sizeFitPanel(o: {
  channel: string;
  beads: { diameterNm: number; measured: number; predicted: number; used: boolean }[];
  halfAngleDeg: number;
  cvPct: number;
  r2Log: number;
  fixed: boolean;
}): CalibPanel {
  const used = o.beads.filter((b) => b.used && finite(b.measured) && finite(b.predicted));
  const [m0, m1] = logLimits([...used.map((b) => b.measured), ...used.map((b) => b.predicted)], 2);
  return {
    kind: 'sizeFit',
    title: 'Bead fit',
    x: { title: 'Predicted F·σ (a.u.)', log: true, min: m0, max: m1 },
    y: { title: `Measured median ${o.channel} (a.u.)`, log: true, min: m0, max: m1 },
    series: [
      { name: 'measured = predicted', kind: 'line', x: [m0, m1], y: [m0, m1], color: 'reference', dash: [4, 3] },
      { name: 'beads (nm)', kind: 'points', x: used.map((b) => b.predicted), y: used.map((b) => b.measured), color: 'beads', labels: used.map((b) => fmtNum(b.diameterNm, 3)) },
    ],
    notes: [`Half-angle ${o.halfAngleDeg.toFixed(1)}°${o.fixed ? ' (fixed)' : ''}`, `CV ${fmtFix(o.cvPct, 1)} %, R² ${fmtFix(o.r2Log, 4)}`],
    source: `Size calibration, ${o.channel}`,
  };
}

/** Size curve of a size calibration: collected scattering cross section against diameter, with the valid range. */
export function sizeCurvePanel(o: {
  channel: string;
  modelName: string;
  diameters: number[];
  sigma: number[];
  validRange: [number, number];
  ps?: { d: number[]; s: number[] } | null;
  /** beads in nm² σ (each converted with the factor of its own detector, `channel`) */
  beads: { diameterNm: number; sigma: number; channel?: string }[];
  noiseSigma?: number | null;
}): CalibPanel {
  const [v0, v1] = o.validRange;
  // one bead series per detector (filled, then rings), named after it when there are several
  const chans = [...new Set(o.beads.map((b) => b.channel ?? o.channel))];
  const beadSeries = chans.map((ch, k) => {
    const bs = o.beads.filter((b) => (b.channel ?? o.channel) === ch);
    return { name: chans.length > 1 ? `beads (${ch})` : 'beads', kind: 'points' as const, x: bs.map((b) => b.diameterNm), y: bs.map((b) => b.sigma), color: 'beads', ...(k % 2 ? { hollow: bs.map(() => true) } : {}) };
  });
  const valid = o.diameters.map((x, i) => (x >= v0 && x <= v1 ? o.sigma[i] : NaN));
  const [y0, y1] = logLimits([...o.sigma, ...(o.ps?.s ?? []), ...o.beads.map((b) => b.sigma)], 1.5);
  return {
    kind: 'sizeCurve',
    title: 'Size calibration',
    x: { title: 'Diameter (nm)', log: true, min: o.diameters[0], max: o.diameters[o.diameters.length - 1] },
    y: { title: 'σ (nm²)', log: true, min: Math.max(y0, y1 / 1e12), max: y1 },
    series: [
      ...(o.ps ? [{ name: 'polystyrene', kind: 'line' as const, x: o.ps.d, y: o.ps.s, color: 'reference', dash: [3, 3] }] : []),
      { name: '', kind: 'line', x: o.diameters, y: o.sigma, color: 'model', dash: [2, 2], width: 0.75 },
      { name: o.modelName, kind: 'line', x: o.diameters, y: valid, color: 'model', width: 1.5 },
      ...beadSeries,
    ],
    bands: [{ x0: v0, x1: v1, label: 'valid range' }],
    hlines: o.noiseSigma && o.noiseSigma > 0 ? [{ y: o.noiseSigma, label: 'noise', color: 'noise' }] : [],
    notes: [`Valid ${fmtNum(v0, 3)} to ${fmtNum(v1, 3)} nm`],
    source: `Size calibration, ${chans.length > 1 ? chans.join(' / ') : o.channel}`,
  };
}

/** MESF (or ERF, ...) regression of a fluorescence calibration: reference values against bead medians. */
export function mesfFitPanel(o: {
  channel: string;
  unit: string;
  points: { median: number; reference: number; used: boolean }[];
  line: { x: number[]; y: number[] };
  r2: number;
  slope: number;
  thresholdMfi?: number | null;
}): CalibPanel {
  const [x0, x1] = logLimits(o.points.map((p) => p.median), 2);
  const [y0, y1] = logLimits([...o.points.map((p) => p.reference), ...o.line.y], 2);
  return {
    kind: 'mesfFit',
    title: `${o.unit} calibration`,
    x: { title: `${o.channel} median (MFI)`, log: true, min: x0, max: x1 },
    y: { title: `Reference (${o.unit})`, log: true, min: y0, max: y1 },
    series: [
      { name: 'regression', kind: 'line', x: o.line.x, y: o.line.y, color: 'model', width: 1.2 },
      { name: 'beads', kind: 'points', x: o.points.map((p) => p.median), y: o.points.map((p) => p.reference), color: 'beads', hollow: o.points.map((p) => !p.used) },
    ],
    vlines: o.thresholdMfi && o.thresholdMfi > 0 ? [{ x: o.thresholdMfi, label: 'detection threshold', color: 'noise', dash: [2, 3] }] : [],
    notes: [`R² ${fmtFix(o.r2, 5)}, slope ${fmtFix(o.slope, 3)}`],
    source: `${o.unit} calibration, ${o.channel}`,
  };
}
