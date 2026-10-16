import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { engine } from '../core/engine';
import { channelDisplayName, MM, popById, popPath, uid, type ExperimentSetup, type PlotItem, type Population, type SheetItem, type TextItem, type Worksheet } from '../core/model';
import { replaceGroupInScopes } from '../core/scope';
import { computeTicks, describeScale, estimateLogicleW, makeScale, type ScaleDef } from '../core/transforms';
import { hasInstrumentScales, instrumentScaleKey, sampleInstrument, scaleFor } from '../core/instruments';
import { plotFitNotes, plotSampleId } from '../render/plot';
import { textOverflows } from '../render/items';
import { csvCell, exportPopulation, newBlankWorkspace, safeName, saveFile, type ConfirmExtraPayload } from '../io/files';
import { downloadSavedSession, restoreSession, restoreSettled, startAutosave } from '../io/session';
import { loadDemo } from '../state/demo';
import { exportFigure, figureBounds, itemsOutsidePage, rasterSize, rasterTooLarge, type FigureFormat } from '../io/exportFigure';
import { hist1d, blur1d } from '../render/density';
import { addPopulation, instrumentDisplayName, isNanoscaleData, userWarnings, useStore, type LargeLoad, type LargeLoadChoice } from '../state/store';
import { channelValues, FIT_TAIL, fitChannel, fitSampleIds, fitSampleLabel } from './axisFit';
import { createMfiTable, mfiPreselect, mfiTablePlan } from './TablesView';
import { Icon } from './icons';
import { applyPageSize, fitLayout, isControlSampleName, repeatForSamples, type ConfirmPayload, type PageFitMode } from './layoutOps';
import { runSave, suggestName, type SaveKind } from './saveOps';
import { Check, Field, InfoTip, Modal, Num, Sel, Seg } from './widgets';
import { useShellMode } from './shell';
import { MESF_INFO, SIZE_INFO } from './calib/info';
import { SparkIcon } from './ai/shared';
import { SetWellDialog } from './PlateView';
import { APP_CONTACT_EMAIL, contactMailto } from '../legal/meta';

export function Dialogs() {
  const dialog = useStore((s) => s.ui.dialog);
  const close = () => useStore.getState().setUI({ dialog: null });
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'axis':
      return <AxisDialog payload={dialog.payload as AxisPayload} onClose={close} />;
    case 'export':
      return <ExportDialog payload={(dialog.payload ?? {}) as { format?: FigureFormat; scope?: 'page' | 'selection' }} onClose={close} />;
    case 'batch':
      return <BatchDialog payload={dialog.payload as { itemIds: string[] }} onClose={close} />;
    case 'exportPop':
      return <ExportPopDialog payload={dialog.payload as { popId: string }} onClose={close} />;
    case 'bool':
      return <BoolDialog onClose={close} />;
    case 'keywords':
      return <KeywordsDialog payload={dialog.payload as { sampleId: string }} onClose={close} />;
    case 'group':
      return <GroupDialog payload={(dialog.payload ?? {}) as { groupId?: string; sampleIds?: string[] }} onClose={close} />;
    case 'flowjoCounts':
      return <FlowJoCountsDialog onClose={close} />;
    case 'pageFit':
      return <PageFitDialog payload={dialog.payload as PageFitPayload} onClose={close} />;
    case 'saveName':
      return <SaveNameDialog payload={dialog.payload as { kind: SaveKind }} onClose={close} />;
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />;
    case 'mfiTable':
      return <MfiTableDialog onClose={close} />;
    case 'guide':
      return <GuideDialog onClose={close} />;
    case 'setWell':
      return <SetWellDialog payload={dialog.payload as { sampleIds: string[] }} onClose={close} />;
    case 'restoreProblem':
      return <RestoreProblemDialog payload={dialog.payload as RestoreProblemPayload} onClose={close} />;
    case 'setup':
      return <SetupDialog onClose={close} />;
    case 'largeLoad':
      return <LargeLoadDialog payload={dialog.payload as LargeLoadPayload} onClose={close} />;
    case 'confirm': {
      // optional third button (e.g. "Save first")
      const c = dialog.payload as ConfirmPayload & Pick<ConfirmExtraPayload, 'extra'>;
      return (
        <Modal
          title={c.title}
          onClose={close}
          footer={
            <>
              <button className="btn" onClick={close} data-autofocus={c.danger ? '' : undefined}>
                Cancel
              </button>
              {c.extra && (
                <button
                  className="btn"
                  onClick={() => {
                    close();
                    c.extra!.run();
                  }}
                >
                  {c.extra.label}
                </button>
              )}
              <button
                className={`btn primary${c.danger ? ' danger' : ''}`}
                onClick={() => {
                  close();
                  c.onOk();
                }}
              >
                {c.ok}
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>{c.text}</p>
        </Modal>
      );
    }
    case 'confirmNew':
      return (
        <Modal
          title="Start a new analysis?"
          onClose={close}
          footer={
            <>
              <button className="btn" onClick={close}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  newBlankWorkspace();
                  close();
                }}
              >
                Start new
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            The current analysis is closed and kept with its files under <b>Earlier analyses</b> on the start screen (click the logo), in this browser. Use
            Save with data to keep a copy as a file.
          </p>
        </Modal>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ axis

interface AxisPayload {
  channel: string;
  itemId?: string;
  axis?: 'x' | 'y';
}

function AxisDialog({ payload, onClose }: { payload: AxisPayload; onClose: () => void }) {
  const st = useStore.getState();
  const ws = st.ws;
  const sheet = ws.worksheets.find((s) => s.id === st.ui.activeSheetId)!;
  const item = payload.itemId ? (sheet.items.find((i) => i.id === payload.itemId) as PlotItem | undefined) : undefined;
  const override = item ? (payload.axis === 'x' ? item.options.xScale : item.options.yScale) : undefined;
  // per-instrument scales: the instrument of the plot's (else the active) sample, and whether it has its own scale
  const sid = item ? plotSampleId(item, st.ui.activeSampleId) : st.ui.activeSampleId;
  const multiInst = hasInstrumentScales(ws);
  const instKey = multiInst ? instrumentScaleKey(ws, payload.channel, sid, engine.keywordsOf) : null;
  const instName = multiInst && sid ? sampleInstrument(ws, sid, engine.keywordsOf) : '';
  const ownElsewhere = multiInst ? Object.entries(ws.instrumentScales ?? {}).filter(([k, m]) => k !== instKey && m?.[payload.channel]).map(([k]) => k) : [];
  const [allInst, setAllInst] = useState(false);
  const [def, setDef] = useState<ScaleDef>(() => {
    const d = override ?? scaleFor(ws, payload.channel, sid, engine.keywordsOf) ?? { type: 'linear', min: 0, max: 262144 };
    return JSON.parse(JSON.stringify(d.type === 'window' ? d.base : d));
  });
  const [scope, setScope] = useState<'all' | 'plot'>(override ? 'plot' : 'all');
  const [label, setLabel] = useState(ws.channelLabels[payload.channel] ?? '');
  // samples behind "Fit to data" and the preview: several selected samples, else the plot's samples, else the active one
  const fitIds = useMemo(() => {
    const sel = st.ui.selectedSampleIds.filter((id) => engine.has(id));
    if (sel.length > 1) return sel;
    if (item) {
      const ids = [...new Set(item.layers.map((l) => (l.sample === 'active' ? st.ui.activeSampleId : l.sample)).filter((x): x is string => !!x && engine.has(x)))];
      if (ids.length) return ids;
    }
    return fitSampleIds();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const raw = useMemo(() => {
    const v = channelValues(ws, payload.channel, fitIds);
    return v.length ? v : null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [fitNote, setFitNote] = useState('');
  const fit = () => {
    const f = fitChannel(ws, payload.channel, def, fitIds);
    if (!f) {
      setFitNote('Not enough events with this channel to fit.');
      return;
    }
    setDef(f);
    setFitNote(`Fitted: ${describeScale(f)}`);
  };
  const range = ws.samples.flatMap((s) => s.channels).find((c) => c.name === payload.channel)?.range ?? 262144;
  const valid = isValid(def);

  const setType = (t: ScaleDef['type']) => {
    const T = def.type === 'linear' || def.type === 'log' ? def.max : def.type === 'window' ? range : def.T;
    if (t === 'linear') setDef({ type: 'linear', min: 0, max: T || range });
    else if (t === 'log') setDef({ type: 'log', min: 10, max: T || range });
    else if (t === 'logicle') setDef({ type: 'logicle', T: T || range, W: 0.5, M: 4.5, A: 0 });
    else setDef({ type: 'arcsinh', T: T || range, M: 4.5, A: 0 });
  };

  const apply = () => {
    if (!valid) return;
    st.update((w) => {
      if (scope === 'all') {
        if (allInst && w.instrumentScales) {
          // one scale for every instrument again
          w.scales[payload.channel] = def;
          for (const k of Object.keys(w.instrumentScales)) {
            delete w.instrumentScales[k][payload.channel];
            if (!Object.keys(w.instrumentScales[k]).length) delete w.instrumentScales[k];
          }
          if (!Object.keys(w.instrumentScales).length) delete w.instrumentScales;
        } else if (instKey && w.instrumentScales?.[instKey]) w.instrumentScales[instKey][payload.channel] = def;
        else w.scales[payload.channel] = def;
        if (item) {
          const it = w.worksheets.find((s) => s.id === sheet.id)!.items.find((i) => i.id === item.id) as PlotItem;
          if (payload.axis === 'x') it.options.xScale = undefined;
          else it.options.yScale = undefined;
        }
      } else if (item) {
        const it = w.worksheets.find((s) => s.id === sheet.id)!.items.find((i) => i.id === item.id) as PlotItem;
        if (payload.axis === 'x') it.options.xScale = def;
        else it.options.yScale = def;
      }
      if (label.trim()) w.channelLabels[payload.channel] = label.trim();
      else delete w.channelLabels[payload.channel];
    });
    onClose();
  };

  return (
    <Modal
      title={`Axis: ${channelDisplayName(ws, payload.channel)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <Field label="Marker label">
        <input className="inp" value={label} placeholder={ws.samples.flatMap((s) => s.channels).find((c) => c.name === payload.channel)?.label || 'e.g. CD4'} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Marker label" />
      </Field>
      <Field label="Transform">
        <Seg value={def.type} options={[{ value: 'linear', label: 'Linear' }, { value: 'log', label: 'Log' }, { value: 'logicle', label: 'Biex (Logicle)' }, { value: 'arcsinh', label: 'Arcsinh' }]} onChange={setType} />
      </Field>
      <div className="fit-row">
        <button
          className="btn sm"
          disabled={!raw}
          onClick={fit}
          title={`Set the range so it holds the events of ${fitSampleLabel(fitIds)} except the lowest and highest ${FIT_TAIL * 100} %, with round ends${def.type === 'logicle' ? '; the linear width W is estimated from the negative events' : ''}`}
        >
          <Icon.fit /> Fit to data
        </button>
        <span className="hint">{raw ? fitNote || `Range from the events of ${fitSampleLabel(fitIds)} (${FIT_TAIL * 100} to ${100 - FIT_TAIL * 100} percentile)` : 'Load a sample to fit the range to its events'}</span>
      </div>
      {def.type === 'linear' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Minimum">
            <Num value={def.min} step={1000} ariaLabel="Minimum" onChange={(v) => setDef({ ...def, min: v })} />
          </Field>
          <Field label="Maximum">
            <Num value={def.max} step={1000} ariaLabel="Maximum" onChange={(v) => setDef({ ...def, max: v })} />
          </Field>
        </div>
      )}
      {def.type === 'log' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Minimum">
            <Num value={def.min} ariaLabel="Minimum" onChange={(v) => setDef({ ...def, min: Math.max(1e-6, v) })} />
          </Field>
          <Field label="Maximum">
            <Num value={def.max} ariaLabel="Maximum" onChange={(v) => setDef({ ...def, max: v })} />
          </Field>
        </div>
      )}
      {def.type === 'logicle' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Top (T)" title="Top of scale (maximum data value)">
              <Num value={def.T} step={10000} min={1} ariaLabel="T" onChange={(v) => setDef({ ...def, T: v })} />
            </Field>
            <Field label="Decades (M)">
              <Num value={def.M} step={0.25} min={1} max={10} ariaLabel="M" onChange={(v) => setDef({ ...def, M: v })} />
            </Field>
            <Field label="Width (W)" title="Width of the linear region around zero, in decades">
              <Num value={def.W} step={0.05} min={0} max={3} ariaLabel="W" onChange={(v) => setDef({ ...def, W: v })} />
            </Field>
            <Field label="Extra neg. (A)">
              <Num value={def.A} step={0.25} min={-3} max={3} ariaLabel="A" onChange={(v) => setDef({ ...def, A: v })} />
            </Field>
          </div>
          <div className="row" style={{ marginBottom: 6 }}>
            <button className="btn sm" disabled={!raw} onClick={() => raw && setDef({ ...def, W: Math.round(estimateLogicleW(raw, def.T, def.M) * 100) / 100 })} title={`Estimate W from the negative events of ${fitSampleLabel(fitIds)}`}>
              Auto W from data
            </button>
          </div>
        </>
      )}
      {def.type === 'arcsinh' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Top (T)">
            <Num value={def.T} step={10000} min={1} ariaLabel="T" onChange={(v) => setDef({ ...def, T: v })} />
          </Field>
          <Field label="Decades (M)">
            <Num value={def.M} step={0.25} min={1} ariaLabel="M" onChange={(v) => setDef({ ...def, M: v })} />
          </Field>
          <Field label="Extra neg. (A)">
            <Num value={def.A} step={0.25} ariaLabel="A" onChange={(v) => setDef({ ...def, A: v })} />
          </Field>
          <div className="hint" style={{ alignSelf: 'center' }}>
            Cofactor ≈ {Number.isFinite(def.T / Math.sinh(def.M * Math.LN10)) ? (def.T / Math.sinh(def.M * Math.LN10)).toPrecision(3) : '–'}
          </div>
        </div>
      )}
      {!valid && <p className="hint" style={{ color: 'var(--danger)' }}>These parameters are not valid (for Logicle: 2·W ≤ M and −W ≤ A ≤ M − 2·W).</p>}
      <AxisPreview def={valid ? def : null} raw={raw} />
      {item && (
        <Field label="Apply to">
          <Seg value={scope} options={[{ value: 'all', label: 'All plots of this parameter' }, { value: 'plot', label: 'This plot only' }]} onChange={setScope} />
        </Field>
      )}
      {multiInst && scope === 'all' && (instKey || ownElsewhere.length > 0) && (
        <div className="inst-scale-note">
          <p className="hint" style={{ margin: '0 0 4px' }}>
            {instKey
              ? `Editing the scale of instrument "${instrumentDisplayName(instKey, Object.keys(ws.instrumentScales ?? {}))}" (its samples have their own ${payload.channel} axis).`
              : `Editing the shared scale of ${payload.channel}${instName ? ` (used by "${instrumentDisplayName(instName, Object.keys(ws.instrumentScales ?? {}))}")` : ''}; ${ownElsewhere.map((k) => `"${instrumentDisplayName(k, Object.keys(ws.instrumentScales ?? {}))}"`).join(', ')} ${ownElsewhere.length === 1 ? 'has its' : 'have their'} own.`}
          </p>
          <Check checked={allInst} label="Apply to all instruments (one scale for every sample)" onChange={setAllInst} />
        </div>
      )}
      <p className="hint" style={{ margin: '4px 0 0' }}>
        Polygon and ellipse gates are evaluated on the scale of their parameters{multiInst ? ' (of each sample\'s instrument)' : ''}. Changing a scale keeps gate vertices at the same data values.
      </p>
    </Modal>
  );
}

function isValid(d: ScaleDef): boolean {
  try {
    if (d.type === 'linear') return d.max > d.min;
    if (d.type === 'log') return d.min > 0 && d.max > d.min;
    if (d.type === 'arcsinh') return d.T > 0 && d.M > 0;
    makeScale({ ...d });
    return true;
  } catch {
    return false;
  }
}

function AxisPreview({ def, raw }: { def: ScaleDef | null; raw: Float32Array | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const W = 500,
      H = 110,
      k = window.devicePixelRatio || 1;
    cv.width = W * k;
    cv.height = H * k;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    if (!def || !raw) {
      ctx.fillStyle = '#8a95a3';
      ctx.font = '12px sans-serif';
      ctx.fillText(raw ? 'Invalid parameters' : 'Select a sample to preview the distribution', 12, 55);
      return;
    }
    const sc = makeScale(def);
    const step = Math.max(1, Math.floor(raw.length / 100000));
    const sub = new Float32Array(Math.ceil(raw.length / step));
    for (let i = 0, j = 0; i < raw.length; i += step, j++) sub[j] = sc.fwd(raw[i]);
    const idx = new Uint32Array(sub.length);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    const h = blur1d(hist1d(sub, idx, 200), 1);
    let mx = 0;
    for (const v of h) mx = Math.max(mx, v);
    const L = 10,
      B = 24,
      PW = W - 20,
      PH = H - B - 6;
    ctx.beginPath();
    ctx.moveTo(L, 6 + PH);
    h.forEach((v, i) => ctx.lineTo(L + ((i + 0.5) / 200) * PW, 6 + PH - (mx ? (v / mx) * PH : 0)));
    ctx.lineTo(L + PW, 6 + PH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(20,99,184,0.25)';
    ctx.strokeStyle = '#1463b8';
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.moveTo(L, 6 + PH + 0.5);
    ctx.lineTo(L + PW, 6 + PH + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = '10px Arial, sans-serif';
    ctx.textAlign = 'center';
    for (const t of computeTicks(def, { target: 6 })) {
      const x = L + t.u * PW;
      ctx.beginPath();
      ctx.moveTo(x, 6 + PH);
      ctx.lineTo(x, 6 + PH + (t.major ? 4 : 2));
      ctx.stroke();
      if (t.major && t.label) ctx.fillText(t.label.base + (t.label.exp !== undefined ? '^' + t.label.exp : ''), x, 6 + PH + 15);
    }
    // count off-scale
    let lo = 0,
      hi = 0;
    for (const v of sub) {
      if (v < 0) lo++;
      else if (v > 1) hi++;
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#5a6878';
    if (lo || hi) ctx.fillText(`off-scale: ${((100 * lo) / sub.length).toFixed(1)}% low, ${((100 * hi) / sub.length).toFixed(1)}% high`, L + 4, 16);
  }, [def, raw]);
  return <canvas ref={ref} style={{ width: '100%', height: 110, border: '1px solid var(--line)', borderRadius: 4, margin: '6px 0 10px', display: 'block' }} />;
}

// ------------------------------------------------------------------ export figure

const PREF_KEY = 'fs.export.prefs';
function readPrefs(): { format?: FigureFormat; dpi?: number } {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function writePrefs(p: { format: FigureFormat; dpi: number }) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/** mm with one decimal; whole millimetres (page presets are stored in whole px) without it. */
const fmtMm = (px: number) => {
  const v = px / MM;
  return Math.abs(v - Math.round(v)) < 0.15 ? String(Math.round(v)) : v.toFixed(1);
};
/** Page preset name without its size note: "Journal 1 column (85 mm)" -> "Journal 1 column". */
const pageLabel = (name: string) => (name === 'custom' ? 'Custom page' : name.replace(/\s*\([^)]*\)\s*$/, ''));

function ExportDialog({ payload, onClose }: { payload: { format?: FigureFormat; scope?: 'page' | 'selection' }; onClose: () => void }) {
  const st = useStore.getState();
  const ws = st.ws;
  const sheet = ws.worksheets.find((s) => s.id === st.ui.activeSheetId) ?? ws.worksheets[0];
  const sel = st.ui.selectedItemIds.filter((id) => sheet.items.some((i) => i.id === id));
  const prefs = readPrefs();
  const [format, setFormat] = useState<FigureFormat>(payload.format ?? prefs.format ?? 'pdf');
  // the whole page unless the export was started for the selection (Export selection…)
  const [scope, setScope] = useState<'page' | 'selection'>(payload.scope === 'selection' && sel.length ? 'selection' : 'page');
  const [dpi, setDpi] = useState(prefs.dpi ?? 600);
  const [marginMm, setMarginMm] = useState(sel.length > 1 ? 2 : 0);
  const [includeOutside, setIncludeOutside] = useState(true);
  const [transparent, setTransparent] = useState(false);
  const [pages, setPages] = useState<'current' | 'perSample' | 'allSheets'>('current');
  const [sampleSet, setSampleSet] = useState<string>(st.ui.sampleFilter);
  const [busy, setBusy] = useState(false);
  const nLoaded = ws.samples.filter((s) => engine.has(s.id)).length;
  const effScope = pages === 'allSheets' ? 'page' : scope;
  const items = effScope === 'selection' ? sheet.items.filter((i) => sel.includes(i.id)) : sheet.items;
  const opts = { scope: effScope, margin: marginMm * MM, includeOutside } as const;
  const b = figureBounds(sheet, items, opts);
  const bitmap = format === 'png' || format === 'tiff';
  const outsideSheets: { sheet: Worksheet; n: number }[] =
    effScope !== 'page' ? [] : (pages === 'allSheets' ? ws.worksheets : [sheet]).map((sh) => ({ sheet: sh, n: itemsOutsidePage(sh).length })).filter((x) => x.n > 0);
  const nOutside = outsideSheets.reduce((a, x) => a + x.n, 0);
  // text drawn shortened in the export (an axis title too long for its plot): said here, never silently
  const shortened = (pages === 'allSheets' ? ws.worksheets.flatMap((sh) => sh.items) : items).flatMap((it) => (it.kind === 'plot' ? plotFitNotes(it, ws, st.ui.activeSampleId, engine) : []));
  // text boxes too small for their text (cut at the bottom in the export)
  const cutTexts = (pages === 'allSheets' ? ws.worksheets.flatMap((sh) => sh.items) : items).filter((it): it is TextItem => it.kind === 'text' && textOverflows(it, ws.style.fontFamily));
  const tooBig = bitmap ? (pages === 'allSheets' ? ws.worksheets.map((sh) => rasterTooLarge(figureBounds(sh, sh.items, { ...opts, scope: 'page' }), dpi)).find(Boolean) : rasterTooLarge(b, dpi)) : null;
  const px = rasterSize(b, dpi);
  const run = async () => {
    setBusy(true);
    writePrefs({ format, dpi });
    try {
      const grp = ws.groups.find((g) => g.id === sampleSet);
      const sampleIds = ws.samples.filter((s) => engine.has(s.id) && (!grp || grp.sampleIds.includes(s.id))).map((s) => s.id);
      await exportFigure(sheet.id, sel, { format, scope: effScope, dpi, margin: marginMm * MM, transparent, pages, sampleIds, includeOutside });
      onClose();
    } catch (e) {
      st.toast('Export failed: ' + (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const pageName = pageLabel(sheet.page.name);
  const card = (v: 'page' | 'selection', title: string, sub: string, disabled = false) => (
    <button className={`scope-card${effScope === v ? ' on' : ''}`} aria-pressed={effScope === v} disabled={disabled} onClick={() => setScope(v)}>
      <span className="scope-title">{title}</span>
      <span className="scope-sub">{sub}</span>
    </button>
  );
  const selBox = sel.length ? figureBounds(sheet, sheet.items.filter((i) => sel.includes(i.id)), { scope: 'selection', margin: marginMm * MM }) : null;
  // the phone viewer selects nothing: no Selection choice there
  const phone = useShellMode() === 'phone';
  return (
    <Modal
      title="Export figure"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !!tooBig} onClick={run}>
            {busy ? 'Exporting…' : `Export ${format.toUpperCase()}`}
          </button>
        </>
      }
    >
      <div className="scope-cards" role="group" aria-label="What to export">
        {card('page', pages === 'allSheets' ? `All ${ws.worksheets.length} sheets` : 'Whole page', pages === 'allSheets' ? 'each sheet at its page size' : `${pageName}, ${fmtMm(sheet.page.w)} x ${fmtMm(sheet.page.h)} mm`)}
        {!phone &&
          card(
            'selection',
            `Selection (${sel.length} item${sel.length === 1 ? '' : 's'})`,
            selBox ? `${fmtMm(selBox.w)} x ${fmtMm(selBox.h)} mm` : 'select items on the sheet first',
            !sel.length || pages === 'allSheets',
          )}
      </div>
      <Field label="Format">
        <Seg
          value={format}
          options={[
            { value: 'pdf', label: 'PDF', title: 'Vector: editable text, any size (Illustrator, journals)' },
            { value: 'svg', label: 'SVG', title: 'Vector graphic with editable text (Illustrator, Inkscape, PowerPoint)' },
            { value: 'png', label: 'PNG', title: 'Bitmap with the chosen resolution stored in the file' },
            { value: 'tiff', label: 'TIFF', title: 'Bitmap for journal submission: RGB, LZW compressed, resolution stored in the file' },
          ]}
          onChange={setFormat}
        />
      </Field>
      <Field label={bitmap ? 'Resolution' : 'Dot raster'} title={bitmap ? 'Image resolution' : 'Resolution of the event dots embedded in the vector file; axes, text and gates stay vector'}>
        <Sel value={String(dpi)} ariaLabel="Resolution" options={['150', '300', '600', '1200'].map((d) => ({ value: d, label: d + ' dpi' }))} onChange={(v) => setDpi(Number(v))} />
      </Field>
      {effScope === 'selection' && (
        <Field label="Margin (mm)" title="White space around the selected items">
          <Num value={marginMm} min={0} max={50} step={0.5} ariaLabel="Margin around the selection in mm" onChange={setMarginMm} />
        </Field>
      )}
      <Field label="Pages" title="Per sample: plots bound to the active sample are drawn once for every loaded sample">
        <Seg
          value={pages}
          options={[
            { value: 'current', label: 'This sheet' },
            { value: 'perSample', label: `One per sample (${nLoaded})` },
            { value: 'allSheets', label: `All sheets (${ws.worksheets.length})` },
          ]}
          onChange={setPages}
        />
      </Field>
      {pages === 'perSample' && ws.groups.length > 0 && (
        <Field label="Samples">
          <Sel value={sampleSet} ariaLabel="Sample set" options={[{ value: 'all', label: 'All samples' }, ...ws.groups.map((g) => ({ value: g.id, label: g.name }))]} onChange={setSampleSet} />
        </Field>
      )}
      <Check checked={transparent} label={format === 'tiff' ? 'Transparent background (adds an alpha channel; journals usually want none)' : 'Transparent background'} onChange={setTransparent} />
      {nOutside > 0 && (
        <div className="note-box warn" role="status">
          {nOutside} item{nOutside === 1 ? ' lies' : 's lie'} partly or fully outside the page{outsideSheets.length > 1 || pages === 'allSheets' ? ` (${outsideSheets.map((x) => x.sheet.name).join(', ')})` : ''}.
          <Check checked={includeOutside} label="Include them (the exported area grows to hold them)" onChange={setIncludeOutside} />
          {!includeOutside && <span>They will be cut off at the page edge.</span>}
        </div>
      )}
      <div className="export-size" aria-live="polite">
        {pages === 'allSheets' ? (
          <span>Each sheet is exported at its page size.</span>
        ) : (
          <>
            Output size: <b>{fmtMm(b.w)} x {fmtMm(b.h)} mm</b>
            {bitmap && (
              <>
                {' '}
                · {px.w.toLocaleString('en-US')} x {px.h.toLocaleString('en-US')} px ({(px.pixels / 1e6).toFixed(1)} MP) at {dpi} dpi
              </>
            )}
            {pages === 'perSample' && <> · one page per sample</>}
          </>
        )}
      </div>
      {tooBig && (
        <p className="hint" style={{ color: 'var(--danger)' }}>
          {tooBig}
        </p>
      )}
      {shortened.length > 0 && (
        <div className="note-box warn" role="status">
          Text that does not fit is shortened in the export: {shortened.slice(0, 3).join('; ')}
          {shortened.length > 3 ? `; and ${shortened.length - 3} more` : ''}. Enlarge the plots, use a smaller font, or type shorter labels in the inspector.
        </div>
      )}
      {cutTexts.length > 0 && (
        <div className="note-box warn" role="status">
          {cutTexts.length === 1 ? 'A text box is' : `${cutTexts.length} text boxes are`} too small for {cutTexts.length === 1 ? 'its' : 'their'} text, which is cut in the export:{' '}
          {cutTexts.slice(0, 3).map((t) => `"${t.text.replace(/\s+/g, ' ').slice(0, 40)}"`).join(', ')}
          {cutTexts.length > 3 ? ` and ${cutTexts.length - 3} more` : ''}. Make {cutTexts.length === 1 ? 'it' : 'them'} taller (Fit height to text in the inspector).
        </div>
      )}
      <p className="hint">
        {bitmap
          ? `${format === 'tiff' ? 'TIFF (RGB, LZW)' : 'PNG'} stores the resolution, so the image opens at the size above in Word, PowerPoint, Illustrator and journal systems.`
          : 'PDF and SVG keep axes, text and gates as editable vectors; event dots are embedded as a high-resolution image.'}{' '}
        Several pages become one multi-page PDF, or a ZIP for SVG / PNG / TIFF.
      </p>
      {format === 'pdf' && (
        <p className="hint export-font-note">
          PDF embeds metric-compatible open fonts (FlowState Sans = Arial metrics, FlowState Serif = Times New Roman, FlowState Humanist = Calibri), so text looks and measures the same everywhere. Use SVG to keep the font name Arial for editing in Illustrator.
        </p>
      )}
      {format === 'svg' && <p className="hint export-font-note">SVG names the fonts of the figure style (e.g. Arial), so text stays editable in that font in Illustrator or Inkscape.</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ MFI table: channel choice

function MfiTableDialog({ onClose }: { onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const plan = useMemo(() => mfiTablePlan(ws, useStore.getState().ui), []); // eslint-disable-line react-hooks/exhaustive-deps
  const labelled = useMemo(() => mfiPreselect(ws, plan.channels), [plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<Set<string>>(() => new Set(labelled));
  const [q, setQ] = useState('');
  const shown = plan.channels.filter((ch) => !q.trim() || channelDisplayName(ws, ch).toLowerCase().includes(q.trim().toLowerCase()));
  const nCols = plan.pops.reduce((n, p) => n + (p === 'root' ? 1 : 2) + (plan.perPop.get(p) ?? []).filter((c) => picked.has(c)).length, 0);
  const set = (chs: string[], on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      for (const c of chs) {
        if (on) next.add(c);
        else next.delete(c);
      }
      return next;
    });
  const below = plan.pops.length - 1;
  const popLabel = plan.sel
    ? `"${ws.populations.find((p) => p.id === plan.sel)?.name}"${below > 0 ? ` and the ${below === 1 ? 'population' : `${below} populations`} below it` : ''}`
    : `${plan.pops.length} population${plan.pops.length === 1 ? '' : 's'}`;
  return (
    <Modal
      title="MFI table: choose the channels"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!picked.size}
            onClick={() => {
              onClose();
              createMfiTable([...picked]);
            }}
          >
            Create table ({nCols} columns)
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Count, % parent and the median of each chosen channel for {popLabel}, in {plan.samples.length} sample{plan.samples.length === 1 ? '' : 's'}
        {plan.filter !== 'all' ? ` of group "${ws.groups.find((g) => g.id === plan.filter)?.name}"` : ''}. Only channels the samples of a population have are listed for it.
      </p>
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <input className="inp" style={{ flex: 1, minWidth: 120 }} placeholder="Filter channels" aria-label="Filter channels" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn sm" onClick={() => set(shown, true)}>
          All
        </button>
        <button className="btn sm" onClick={() => set(shown, false)}>
          None
        </button>
        {labelled.length > 0 && labelled.length < plan.channels.length && (
          <button className="btn sm" title="Channels with a marker label or a gate" onClick={() => setPicked(new Set(labelled))}>
            Labelled / gated
          </button>
        )}
      </div>
      <div className="mfi-chan-list" role="group" aria-label="Channels">
        {shown.map((ch) => (
          <Check key={ch} checked={picked.has(ch)} label={channelDisplayName(ws, ch)} onChange={(v) => set([ch], v)} />
        ))}
        {!shown.length && <span className="hint">No channel matches the filter.</span>}
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>
        {picked.size} of {plan.channels.length} channels chosen.
      </p>
    </Modal>
  );
}

// ------------------------------------------------------------------ batch

function BatchDialog({ payload, onClose }: { payload: { itemIds: string[] }; onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const st = useStore.getState();
  const sheet = ws.worksheets.find((s) => s.id === st.ui.activeSheetId) ?? ws.worksheets[0];
  const templ = sheet.items.filter((i): i is PlotItem => payload.itemIds.includes(i.id) && i.kind === 'plot');
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  // the samples selected in the sample list (two or more); else all but the controls (unstained, beads, compensation)
  const [picked, setPicked] = useState<string[]>(() => {
    const chosen = loaded.filter((s) => st.ui.selectedSampleIds.includes(s.id)).map((s) => s.id);
    if (chosen.length > 1) return chosen;
    const exp = loaded.filter((s) => !isControlSampleName(s.name)).map((s) => s.id);
    return exp.length ? exp : loaded.map((s) => s.id);
  });
  const nSelected = loaded.filter((s) => st.ui.selectedSampleIds.includes(s.id)).length;
  const [newSheet, setNewSheet] = useState(false);
  const [rowLabels, setRowLabels] = useState(true);
  const [removeTemplate, setRemoveTemplate] = useState(false);
  const [orientation, setOrientation] = useState<'rows' | 'columns'>('rows');
  const order = ws.samples.filter((s) => picked.includes(s.id));
  const nControls = loaded.filter((s) => isControlSampleName(s.name)).length;
  return (
    <Modal
      title="Repeat plots for samples"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!picked.length || !templ.length}
            onClick={() => {
              repeatForSamples(st.ui.activeSheetId, payload.itemIds, order.map((s) => s.id), { newSheet, rowLabels, orientation, removeTemplate: removeTemplate && !newSheet });
              onClose();
            }}
          >
            Create {picked.length} {orientation === 'rows' ? 'row' : 'column'}
            {picked.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        {templ.length ? `The ${templ.length} selected plot${templ.length === 1 ? ' is' : 's are'} repeated for each chosen sample (each copy shows that sample) and aligned on the grid.` : 'Select one or more plots first.'}
      </p>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="hint">Select:</span>
        <button className="chip" onClick={() => setPicked(loaded.map((s) => s.id))}>
          All
        </button>
        {nSelected > 1 && (
          <button className="chip" title="The samples selected in the sample list" onClick={() => setPicked(loaded.filter((s) => st.ui.selectedSampleIds.includes(s.id)).map((s) => s.id))}>
            Selected ({nSelected})
          </button>
        )}
        {nControls > 0 && (
          <button className="chip" title="Unstained, bead and compensation samples left out" onClick={() => setPicked(loaded.filter((s) => !isControlSampleName(s.name)).map((s) => s.id))}>
            Without controls
          </button>
        )}
        <button className="chip" onClick={() => setPicked([])}>
          None
        </button>
        {ws.groups.map((g) => (
          <button key={g.id} className="chip" onClick={() => setPicked(loaded.filter((s) => g.sampleIds.includes(s.id)).map((s) => s.id))}>
            {g.name}
          </button>
        ))}
      </div>
      <div className="batch-list">
        {ws.samples.map((s) => (
          <label key={s.id} className="check" title={!engine.has(s.id) ? 'FCS file not loaded' : isControlSampleName(s.name) ? 'Looks like a control sample' : undefined} style={!engine.has(s.id) ? { opacity: 0.5 } : undefined}>
            <input type="checkbox" disabled={!engine.has(s.id)} checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? ws.samples.filter((x) => picked.includes(x.id) || x.id === s.id).map((x) => x.id) : picked.filter((x) => x !== s.id))} />
            {s.name}
            {isControlSampleName(s.name) && <span className="tag-mini">control</span>}
          </label>
        ))}
      </div>
      <Field label="Layout">
        <Seg
          value={orientation}
          options={[
            { value: 'rows', label: 'Samples in rows', title: 'One row per sample; the selected plots side by side' },
            { value: 'columns', label: 'Samples in columns', title: 'One column per sample; the selected plots stacked' },
          ]}
          onChange={setOrientation}
        />
      </Field>
      <div className="batch-layout">
        <div>
          <Check checked={rowLabels} label={orientation === 'rows' ? 'Sample names as row labels, populations as column titles' : 'Sample names as column titles, populations as row labels'} onChange={setRowLabels} />
          <Check checked={newSheet} label="Put the result on a new worksheet" onChange={setNewSheet} />
          <Check checked={removeTemplate && !newSheet} label="Replace the selected plots (remove the templates)" onChange={(v) => setRemoveTemplate(v)} />
        </div>
        <BatchPreview templ={templ} samples={order.map((s) => s.name)} columns={orientation === 'columns'} labels={rowLabels} />
      </div>
    </Modal>
  );
}

/** Small sketch of the grid that Repeat for samples makes. */
function BatchPreview({ templ, samples, columns, labels }: { templ: PlotItem[]; samples: string[]; columns: boolean; labels: boolean }) {
  const ws = useStore((s) => s.ws);
  const pops = [...templ]
    .sort((a, b) => (columns ? a.y - b.y : a.x - b.x))
    .map((t) => t.options.title || (t.layers[0]?.population && t.layers[0].population !== 'root' ? popById(ws, t.layers[0].population)?.name : 'All Events') || 'All Events');
  const maxS = 4;
  const shownS = samples.slice(0, maxS);
  const more = samples.length - shownS.length;
  const nx = columns ? shownS.length : pops.length;
  const ny = columns ? pops.length : shownS.length;
  if (!nx || !ny) return <div className="batch-preview empty">Choose samples to see the layout</div>;
  const cell = Math.max(18, Math.min(44, Math.floor(160 / Math.max(nx, ny))));
  const gap = 4;
  const lw = labels ? 68 : 0;
  const th = labels ? 13 : 0;
  const W = lw + nx * (cell + gap) + (columns && more ? 18 : 0);
  const H = th + ny * (cell + gap) + (!columns && more ? 14 : 0);
  const trunc = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const left = columns ? pops : shownS;
  const top = columns ? shownS : pops;
  return (
    <div className="batch-preview" aria-label="Layout preview">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img">
        {labels &&
          top.map((t, i) => (
            <text key={'t' + i} x={lw + i * (cell + gap) + cell / 2} y={9} textAnchor="middle" className="bp-text bp-strong">
              {trunc(t, Math.max(4, Math.floor((cell + gap) / 5.4)))}
            </text>
          ))}
        {labels &&
          left.map((t, j) => (
            <text key={'l' + j} x={lw - 5} y={th + j * (cell + gap) + cell / 2 + 3} textAnchor="end" className="bp-text">
              {trunc(t, 11)}
            </text>
          ))}
        {Array.from({ length: ny }).map((_, j) =>
          Array.from({ length: nx }).map((__, i) => <rect key={`${i}-${j}`} x={lw + i * (cell + gap)} y={th + j * (cell + gap)} width={cell} height={cell} rx={2} className="bp-cell" />),
        )}
        {more > 0 &&
          (columns ? (
            <text x={lw + nx * (cell + gap) + 2} y={th + cell / 2 + 3} className="bp-text">
              +{more}
            </text>
          ) : (
            <text x={lw} y={H - 2} className="bp-text">
              + {more} more row{more === 1 ? '' : 's'}
            </text>
          ))}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ export populations

function ExportPopDialog({ payload, onClose }: { payload: { popId: string }; onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const st = useStore.getState();
  const [popId, setPopId] = useState(payload.popId || 'root');
  const [format, setFormat] = useState<'fcs' | 'csv'>('fcs');
  const [comp, setComp] = useState(false);
  const [which, setWhich] = useState<'active' | 'all'>('active');
  const opts = [{ value: 'root', label: 'All Events' }, ...ws.populations.map((p) => ({ value: p.id, label: p.name }))];
  return (
    <Modal
      title="Export events"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const ids = which === 'all' ? ws.samples.filter((s) => engine.has(s.id)).map((s) => s.id) : st.ui.activeSampleId ? [st.ui.activeSampleId] : [];
              await exportPopulation(ids, popId, format, comp);
              onClose();
            }}
          >
            Export
          </button>
        </>
      }
    >
      <Field label="Population">
        <Sel value={popId} options={opts} ariaLabel="Population" onChange={setPopId} />
      </Field>
      <Field label="Samples">
        <Seg value={which} options={[{ value: 'active', label: 'Active sample' }, { value: 'all', label: 'All samples' }]} onChange={setWhich} />
      </Field>
      <Field label="Format">
        <Seg value={format} options={[{ value: 'fcs', label: 'FCS 3.1' }, { value: 'csv', label: 'CSV' }]} onChange={setFormat} />
      </Field>
      <Check checked={comp} label="Write compensated values" onChange={setComp} />
      <p className="hint">FCS files keep all keywords of the original file. Without compensation the spillover matrix stays in the file so other software can compensate.</p>
      <p className="hint">
        Calibrated channels: {format === 'fcs' ? '-1' : 'empty cell'} = no value (outside the calibrated range). They are computed from compensated values, as shown in the app.
      </p>
    </Modal>
  );
}

// ------------------------------------------------------------------ boolean gates

function BoolDialog({ onClose }: { onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const sel = useStore.getState().ui.selectedPopId;
  const [op, setOp] = useState<'and' | 'or' | 'not'>('and');
  const [ops, setOps] = useState<{ id: string; not: boolean }[]>(sel ? [{ id: sel, not: false }] : []);
  const [name, setName] = useState('');
  const pops = ws.populations.filter((p) => p.gate.type !== 'bool' || true);
  useEffect(() => {
    if (op === 'not' && ops.length > 1) setOps(ops.slice(0, 1));
  }, [op]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = ops[0] ? popById(ws, ops[0].id) : undefined;
  const auto = ops
    .map((o) => (o.not ? 'not ' : '') + (popById(ws, o.id)?.name ?? '?'))
    .join(op === 'and' ? ' AND ' : op === 'or' ? ' OR ' : '');
  const create = () => {
    if (!ops.length) return;
    // parent: common parent of the operands if identical, else all events
    const parents = new Set(ops.map((o) => popById(ws, o.id)?.parentId ?? null));
    const parent = parents.size === 1 ? [...parents][0] : null;
    const operands = op === 'not' ? [ops[0].id] : ops.map((o) => (o.not ? '!' : '') + o.id);
    addPopulation(name.trim() || (op === 'not' ? `NOT ${first?.name}` : auto), parent, { type: 'bool', op, operands });
    onClose();
  };
  return (
    <Modal
      title="Boolean gate"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ops.length || (op !== 'not' && ops.length < 2)} onClick={create}>
            Create population
          </button>
        </>
      }
    >
      <Field label="Operation">
        <Seg value={op} options={[{ value: 'and', label: 'AND' }, { value: 'or', label: 'OR' }, { value: 'not', label: 'NOT' }]} onChange={setOp} />
      </Field>
      {ops.map((o, i) => (
        <div key={i} className="row" style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
          {op !== 'not' && <Check checked={o.not} label="NOT" onChange={(v) => setOps(ops.map((x, k) => (k === i ? { ...x, not: v } : x)))} />}
          <Sel value={o.id} ariaLabel="Population" options={pops.map((p: Population) => ({ value: p.id, label: p.name }))} onChange={(v) => setOps(ops.map((x, k) => (k === i ? { ...x, id: v } : x)))} />
          <button className="icon-btn danger" aria-label="Remove" title="Remove this population" onClick={() => setOps(ops.filter((_, k) => k !== i))}>
            ×
          </button>
        </div>
      ))}
      {(op !== 'not' || ops.length === 0) && pops.length > 0 && (
        <button className="btn sm" onClick={() => setOps([...ops, { id: pops[0].id, not: false }])}>
          Add population
        </button>
      )}
      <div style={{ height: 8 }} />
      <Field label="Name">
        <input className="inp" value={name} placeholder={auto || 'Name'} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Name" />
      </Field>
      <p className="hint">The new population is placed under the common parent of the selected populations.</p>
    </Modal>
  );
}

export { uid };

// ------------------------------------------------------------------ keywords

function KeywordsDialog({ payload, onClose }: { payload: { sampleId: string }; onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const [q, setQ] = useState('');
  const s = ws.samples.find((x) => x.id === payload.sampleId);
  const sd = engine.samples.get(payload.sampleId);
  const kws = sd ? Object.entries(sd.ds.keywords) : [];
  const shown = kws.filter(([k, v]) => !q || k.toLowerCase().includes(q.toLowerCase()) || v.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal wide title={`Keywords: ${s?.name ?? ''}`} onClose={onClose}>
      {!sd ? (
        <p>The FCS file of this sample is not loaded.</p>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <input className="inp" style={{ maxWidth: 280 }} placeholder="Filter keywords" value={q} aria-label="Filter keywords" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <span className="hint">
              {sd.ds.version} · {sd.ds.eventCount.toLocaleString('en-US')} events · {sd.ds.channels.length} parameters · {kws.length} keywords
            </span>
          </div>
          {userWarnings(sd.ds).length > 0 && <p className="hint" style={{ color: 'var(--warn-text)' }}>{userWarnings(sd.ds).slice(0, 5).join(' · ')}</p>}
          <div className="tbl-wrap" style={{ maxHeight: 420 }}>
            <table className="data" style={{ width: '100%' }}>
              <tbody>
                {shown.slice(0, 2000).map(([k, v]) => (
                  <tr key={k}>
                    <td className="left" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{k}</td>
                    <td className="left" style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ groups

const GROUP_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#8c564b', '#e377c2'];

function GroupDialog({ payload, onClose }: { payload: { groupId?: string; sampleIds?: string[] }; onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const st = useStore.getState();
  const existing = payload.groupId ? ws.groups.find((g) => g.id === payload.groupId) : undefined;
  const [name, setName] = useState(existing?.name ?? `Group ${ws.groups.length + 1}`);
  const [color, setColor] = useState(existing?.color ?? GROUP_COLORS[ws.groups.length % GROUP_COLORS.length]);
  const [members, setMembers] = useState<string[]>(existing?.sampleIds ?? payload.sampleIds ?? []);
  const save = () => {
    st.update((w) => {
      if (existing) {
        const g = w.groups.find((x) => x.id === existing.id)!;
        g.name = name.trim() || g.name;
        g.color = color;
        g.sampleIds = members;
      } else w.groups.push({ id: uid('grp'), name: name.trim() || 'Group', color, sampleIds: members });
    });
    onClose();
  };
  return (
    <Modal
      title={existing ? 'Edit group' : 'New group'}
      onClose={onClose}
      footer={
        <>
          {existing && (
            <button
              className="btn"
              style={{ color: 'var(--danger)', marginRight: 'auto' }}
              onClick={() => {
                st.update((w) => {
                  w.groups = w.groups.filter((g) => g.id !== existing.id);
                  // gates scoped to the group keep applying to its samples (listed by sample instead)
                  replaceGroupInScopes(w.populations, existing);
                  for (const t of w.tables) if (t.sampleSet === existing.id) t.sampleSet = 'all';
                  for (const sh of w.worksheets)
                    for (const it of sh.items)
                      if (it.kind === 'chart') {
                        if (it.sampleSet === existing.id) it.sampleSet = 'all';
                        if (it.groups?.includes(existing.id)) it.groups = it.groups.filter((g) => g !== existing.id);
                      }
                });
                st.setUI({ sampleFilter: 'all' });
                onClose();
              }}
            >
              Delete group
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="inp" value={name} aria-label="Group name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); save(); } }} />
      </Field>
      <Field label="Color">
        <input type="color" className="color-in" aria-label="Group color" value={color} onChange={(e) => setColor(e.target.value)} />
      </Field>
      <div style={{ maxHeight: 280, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 4, padding: 6 }}>
        {ws.samples.map((s) => (
          <Check key={s.id} checked={members.includes(s.id)} label={s.name} onChange={(v) => setMembers(v ? [...members, s.id] : members.filter((x) => x !== s.id))} />
        ))}
      </div>
      <p className="hint">Groups filter the sample list and can be used as row sets for statistics tables, batch layouts and per-sample export.</p>
    </Modal>
  );
}

// ------------------------------------------------------------------ FlowJo counts

interface CountRow {
  sample: string;
  sampleName: string;
  pop: string;
  path: string;
  fj: number;
  app: number | null; // null: FCS file not loaded
  diff: number | null; // relative difference (app - FlowJo) / FlowJo, in %
}

const FJ_TOL = 1; // %

function relDiff(app: number, fj: number): number {
  if (fj > 0) return (100 * (app - fj)) / fj;
  return app === 0 ? 0 : Infinity;
}

/** FlowJo's stored counts of an opened .wsp next to the counts computed here, per sample and population. */
function FlowJoCountsDialog({ onClose }: { onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const fj = useStore((s) => s.ui.flowjoCounts);
  useStore((s) => s.ui.dataVersion);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const rows: CountRow[] = [];
  if (fj)
    for (const s of ws.samples) {
      const counts = fj.counts[s.id];
      if (!counts) continue;
      const loaded = engine.has(s.id);
      for (const pid of ['root', ...ws.populations.map((p) => p.id)]) {
        const c = counts[pid];
        if (c === undefined || c < 0) continue; // not in this sample, or not computed by FlowJo
        if (pid !== 'root' && !popById(ws, pid)) continue;
        const app = loaded ? (pid === 'root' ? engine.eventCount(s.id) : engine.count(ws, s.id, pid)) : null;
        rows.push({ sample: s.id, sampleName: s.name, pop: pid, path: pid === 'root' ? 'All Events' : popPath(ws, pid), fj: c, app, diff: app === null ? null : relDiff(app, c) });
      }
    }
  const big = rows.filter((r) => r.diff !== null && Math.abs(r.diff) > FJ_TOL);
  const compared = rows.filter((r) => r.diff !== null).length;
  const shown = onlyDiff ? big : rows;
  const fmtD = (d: number | null) => (d === null ? '-' : !Number.isFinite(d) ? 'n/a' : `${d > 0 ? '+' : ''}${d.toFixed(Math.abs(d) < 10 ? 2 : 1)} %`);
  const saveCsv = () => {
    const lines = [['Sample', 'Population', 'FlowJo', 'FlowState', 'Difference %'].join(',')];
    for (const r of rows) lines.push([csvCell(r.sampleName), csvCell(r.path), r.fj, r.app ?? '', r.diff === null || !Number.isFinite(r.diff) ? '' : r.diff.toFixed(3)].join(','));
    void saveFile(`${safeName(ws.name)}_flowjo_counts.csv`, lines.join('\n'));
  };
  return (
    <Modal
      wide
      title={`FlowJo counts${fj ? `: ${fj.fileName}` : ''}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" disabled={!rows.length} onClick={saveCsv} style={{ marginRight: 'auto' }}>
            Save CSV
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {!fj ? (
        <p style={{ margin: 0 }}>Open a FlowJo workspace (.wsp) to compare the counts FlowJo stored in it with the counts computed here.</p>
      ) : (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            FlowJo stores the event counts it computed when the workspace was saved. Small differences are expected: FlowJo assigns events on polygon edges
            slightly differently and works on its display grid, so counts can differ by a few events, usually well below 1 % (in small populations a few
            events can be more than 1 %). Larger differences point to a gate that was converted differently, a gate edited since, or a different FCS file.
          </p>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="hint" style={{ margin: 0 }}>
              {compared === 0
                ? 'No FCS files are loaded yet: drop them to compare.'
                : big.length
                  ? `${big.length} of ${compared} counts differ by more than ${FJ_TOL} %.`
                  : `All ${compared} counts agree within ${FJ_TOL} %.`}
              {compared < rows.length && compared > 0 ? ` ${rows.length - compared} counts belong to samples whose FCS file is not loaded.` : ''}
            </span>
            <span className="grow" />
            <Check checked={onlyDiff} label={`Only differences > ${FJ_TOL} %`} onChange={setOnlyDiff} />
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 420 }}>
            <table className="data" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th className="left">Sample</th>
                  <th className="left">Population</th>
                  <th>FlowJo</th>
                  <th>FlowState</th>
                  <th>Difference</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 3000).map((r) => {
                  const bad = r.diff !== null && Math.abs(r.diff) > FJ_TOL;
                  return (
                    <tr key={r.sample + '/' + r.pop} style={bad ? { background: 'var(--warn-bg, rgba(255, 170, 0, 0.16))' } : undefined}>
                      <td className="left">{r.sampleName}</td>
                      <td className="left" style={{ whiteSpace: 'normal' }}>{r.path}</td>
                      <td className="num">{r.fj.toLocaleString('en-US')}</td>
                      <td className="num">{r.app === null ? 'not loaded' : r.app.toLocaleString('en-US')}</td>
                      <td className="num" style={bad ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{fmtD(r.diff)}</td>
                    </tr>
                  );
                })}
                {!shown.length && (
                  <tr>
                    <td colSpan={5} className="left hint">
                      {onlyDiff ? 'No differences above the threshold.' : 'This workspace has no counts from FlowJo.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ page size change

export interface PageFitPayload {
  sheetId: string;
  page: { w: number; h: number; name: string };
}

/** Thumbnail of a layout on a page (page outline, plots and charts filled, text outlined). */
function LayoutThumb({ items, page, pageH, maxW = 150, maxH = 110 }: { items: SheetItem[]; page: { w: number; h: number }; pageH: number; maxW?: number; maxH?: number }) {
  const all = items.length ? items : [];
  const x1 = Math.max(page.w, ...all.map((i) => i.x + i.w));
  const y1 = Math.max(pageH, ...all.map((i) => i.y + i.h));
  const k = Math.min(maxW / x1, maxH / y1);
  return (
    <svg width={Math.ceil(x1 * k) + 2} height={Math.ceil(y1 * k) + 2} className="fit-thumb" aria-hidden="true">
      <rect x={1} y={1} width={page.w * k} height={pageH * k} className="ft-page" />
      {all.map((i) => (
        <rect key={i.id} x={1 + i.x * k} y={1 + i.y * k} width={Math.max(1, i.w * k)} height={Math.max(1, i.h * k)} className={i.kind === 'text' ? 'ft-text' : 'ft-item'} />
      ))}
    </svg>
  );
}

function PageFitDialog({ payload, onClose }: { payload: PageFitPayload; onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const sheet = ws.worksheets.find((s) => s.id === payload.sheetId);
  const scaled = useMemo(() => (sheet ? fitLayout(sheet.items, payload.page, sheet.grid, 'scale') : null), [sheet, payload.page]);
  const flowed = useMemo(() => (sheet ? fitLayout(sheet.items, payload.page, sheet.grid, 'reflow') : null), [sheet, payload.page]);
  if (!sheet || !scaled || !flowed) return null;
  const outside = itemsOutsidePage({ ...sheet, page: { ...payload.page } }).length;
  const same = Math.abs(payload.page.w - sheet.page.w) < 0.5 && Math.abs(payload.page.h - sheet.page.h) < 0.5;
  const name = payload.page.name === 'custom' ? 'custom size' : pageLabel(payload.page.name);
  const box = sheet.items.length ? figureBounds(sheet, sheet.items, { scope: 'selection', margin: 0 }) : null;
  const choose = (m: PageFitMode) => {
    applyPageSize(sheet.id, payload.page, m);
    onClose();
  };
  const opt = (m: PageFitMode, title: string, text: ReactNode, items: SheetItem[], pageH: number) => (
    <button className="fit-card" onClick={() => choose(m)} data-autofocus={m === 'scale' ? '' : undefined}>
      <LayoutThumb items={items} page={payload.page} pageH={pageH} />
      <span className="fit-title">{title}</span>
      <span className="fit-text">{text}</span>
    </button>
  );
  return (
    <Modal
      wide
      title={payload.page.name === 'custom' ? 'Fit the layout to the page?' : `Fit the layout to ${name}?`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <p style={{ marginTop: 0 }}>
        The layout{box ? ` (${fmtMm(box.w)} x ${fmtMm(box.h)} mm)` : ''} is larger than {same ? 'the page' : 'the new page'}, {name} ({fmtMm(payload.page.w)} x {fmtMm(payload.page.h)} mm): {outside} of {sheet.items.length} items {same ? 'lie' : 'would lie'} outside it.
      </p>
      <div className="fit-cards">
        {opt('scale', 'Scale layout to fit', <>Positions and sizes shrink to {Math.round(scaled.scale * 100)} %. Font sizes stay, so text keeps its size in print.</>, scaled.items, scaled.pageH)}
        {opt(
          'reflow',
          'Re-flow into columns',
          <>
            Plots keep their size and wrap into rows of the new width.
            {flowed.pageH > payload.page.h + 0.5 ? ` The page grows to ${Math.round(flowed.pageH / MM)} mm high.` : ''}
          </>,
          flowed.items,
          flowed.pageH,
        )}
        {opt('keep', 'Keep the layout', <>Only the page changes. Items outside it are not exported unless you include them when exporting.</>, sheet.items, payload.page.h)}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ save: name the workspace

function SaveNameDialog({ payload, onClose }: { payload: { kind: SaveKind }; onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const [name, setName] = useState(() => suggestName(ws));
  const ok = () => {
    const v = name.trim();
    if (!v) return;
    useStore.getState().update((w) => {
      w.name = v;
    }, 'wsname');
    onClose();
    runSave(payload.kind);
  };
  const what = payload.kind === 'bundle' ? 'workspace with its FCS files' : payload.kind === 'template' ? 'template' : 'workspace';
  return (
    <Modal
      title={`Name the ${what}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={ok}>
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          className="inp"
          value={name}
          aria-label="Workspace name"
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') ok();
          }}
        />
      </Field>
      <p className="hint" style={{ marginBottom: 0 }}>
        The name is shown in the title bar and used for the file name ({safeName(name.trim() || 'workspace')}
        {payload.kind === 'bundle' ? '.flowstate.zip' : payload.kind === 'template' ? '.template.flowstate.json' : '.flowstate.json'}).
      </p>
    </Modal>
  );
}

// ------------------------------------------------------------------ keyboard shortcuts

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

export const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  {
    group: 'Tools',
    keys: [
      ['V', 'Select'],
      ['W', 'Auto gate'],
      ['P', 'Polygon gate'],
      ['R', 'Rectangle gate'],
      ['E', 'Ellipse gate'],
      ['Q', 'Quadrant gate'],
      ['H', 'Range gate (histogram)'],
      ['S', 'Split gate (histogram)'],
      ['T', 'Text'],
      ['Z', 'Zoom (double-click resets)'],
      ['Esc', 'Cancel, back to Select, deselect'],
    ],
  },
  {
    group: 'Gates',
    keys: [
      ['Enter', 'Close the polygon (Shift+Enter keeps the tool)'],
      ['Backspace', 'Remove the last polygon point'],
      ['Arrows', 'Move the selected gate (Shift: more, ' + MOD + ': less)'],
      ['← / →', 'Auto gate: tighter / looser (Enter accepts, Esc cancels)'],
      ['Double-click gate', 'New plot of that population'],
      ['Enter', 'Open the selected plot large in the gating view (Esc closes)'],
      ['Double-click plot', 'Gating view (on the empty data area)'],
      ['Alt+↑ / Alt+↓', 'Previous / next sample (also with items selected)'],
    ],
  },
  {
    group: 'Edit',
    keys: [
      [`${MOD}+Z`, 'Undo'],
      [`${MOD}+Y / ${MOD}+Shift+Z`, 'Redo'],
      [`${MOD}+C / ${MOD}+X / ${MOD}+V`, 'Copy / cut / paste items (also between tabs)'],
      [`${MOD}+D`, 'Duplicate'],
      [`${MOD}+A`, 'Select all items'],
      ['Del', 'Delete items, or the selected gate'],
      ['Arrows', 'Nudge items 0.5 mm (Shift: one grid step, Ctrl: 0.1 mm)'],
      [`${MOD}+] / ${MOD}+[`, 'Bring forward / send backward (Shift: to front / back)'],
    ],
  },
  {
    group: 'View & files',
    keys: [
      [`${MOD}+wheel`, 'Zoom at the pointer'],
      ['+ / -', 'Zoom in / out (the selection stays in place)'],
      ['F / Shift+2', 'Zoom to the selection'],
      ['Shift+1', 'Back to the previous zoom (else fit the page)'],
      ['Space+drag', 'Pan the worksheet'],
      ['Alt+drag', 'Move without snapping'],
      [`${MOD}+S`, 'Save the workspace'],
      [`${MOD}+O`, 'Open files'],
      ['? or F1', 'This overview'],
    ],
  },
  {
    group: 'Plate (sample panel: Plate, and the Plates tab)',
    keys: [
      ['Click', 'Select the well (its sample becomes active)'],
      [`${MOD}+click`, 'Add or remove a well'],
      ['Shift+click', 'Select the block from the last well clicked'],
      ['Drag', 'Select a block of wells'],
      ['Row letter / column number', 'Select the row / column (corner: all)'],
      ['Arrows', 'Next well with a sample (Shift: extend the block)'],
      ['Enter / double-click', 'Show the active sample on the worksheet'],
      [`${MOD}+A`, 'Select all wells of the plate'],
      ['Del', 'Remove the selected samples'],
      ['Drag a sample onto a well', 'Set its well (from the list, Plates tab)'],
    ],
  },
  {
    group: 'Panels & touch',
    keys: [
      [`${MOD}+B`, 'Show / hide samples and populations'],
      [`${MOD}+Alt+B`, 'Show / hide the inspector'],
      [`${MOD}+F1`, 'Minimize the ribbon to its tabs, or show it again'],
      ['Esc', 'Close a side panel opened over the worksheet'],
      ['Pinch', 'Zoom the worksheet (touch screens)'],
      ['Drag the page', 'Pan the worksheet (touch screens)'],
      ['Press and hold', 'Context menu (touch screens)'],
    ],
  },
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      wide
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="shortcut-grid">
        {SHORTCUTS.map((g) => (
          <section key={g.group}>
            <h4>{g.group}</h4>
            <table>
              <tbody>
                {g.keys.map(([k, d]) => (
                  <tr key={k + d}>
                    <td>
                      {k.split(' / ').map((part, i) => (
                        <span key={i}>
                          {i > 0 && ' / '}
                          <kbd>{part}</kbd>
                        </span>
                      ))}
                    </td>
                    <td>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>
        Write CD4^+ or 10^{'{3}'} for superscripts in titles, labels and text. Right-click (or press and hold) items, samples and populations for more commands. Drag the edge of a side panel to resize it.
      </p>
    </Modal>
  );
}

// ------------------------------------------------------------------ getting started

const GUIDE: { icon: ReactNode; title: string; text: ReactNode; phoneText?: ReactNode }[] = [
  {
    icon: <Icon.fcs />,
    title: 'Load files',
    text: (
      <>
        Drop FCS / LMD files anywhere, or <b>Home &gt; Open FCS</b>. A saved workspace, a bundle (.zip) or a FlowJo workspace (.wsp) opens with its gates; drop its FCS files to link them.
      </>
    ),
  },
  {
    icon: <Icon.wand />,
    title: 'Gate',
    text: (
      <>
        <b>Auto gate</b> (<kbd>W</kbd>): click a population, adjust the tightness, Enter. Or draw: polygon <kbd>P</kbd>, rectangle <kbd>R</kbd>, range <kbd>H</kbd> on histograms. Double-click a gate for the next plot; <kbd>Enter</kbd> on a plot opens the large gating view, <kbd>F</kbd> zooms to it.
      </>
    ),
    // (a phone is a viewer: no gating tools, no keyboard)
    phoneText: <>Gates are drawn on a tablet or computer: auto gate, polygon, rectangle and range gates, and a large gating view. On a phone, the worksheets show the gates and their statistics.</>,
  },
  {
    icon: <Icon.table />,
    title: 'Statistics',
    text: (
      <>
        The <b>Statistics</b> tab makes tables over samples (counts, % parent, MFI); export to Excel or CSV, or turn a column into a chart. Groups compare conditions.
      </>
    ),
  },
  {
    icon: <Icon.plate />,
    title: 'Plates (96 / 384 wells)',
    text: (
      <>
        Wells are read from FCS keywords or names (A1, B07, Well_C3; CytExpert, FACSDiva, Attune, NovoCyte, Sony, Aurora, Guava ...). <b>Open folder</b> loads a whole
        export, a subfolder per plate. Switch the sample list to <b>Plate</b> and select wells like rows; the <b>Plates</b> tab shows a heatmap of any statistic,
        a plate layout (compound, concentration) that makes groups, and CSV / Excel / figure export.
      </>
    ),
  },
  {
    icon: <Icon.export />,
    title: 'Figures and export',
    text: (
      <>
        Arrange plots on the page (<b>Layout</b>), set fonts and sizes in mm, then <b>Export</b>: PDF / SVG (vector) or PNG / TIFF at journal resolution. <b>Repeat for samples</b> copies a layout to other samples.
      </>
    ),
  },
  {
    icon: <Icon.save />,
    title: 'Save and restore',
    text: (
      <>
        <kbd>{MOD}+S</kbd> saves the workspace (.json); <b>Save with data</b> adds the FCS files (.zip). The last session is kept in this browser and comes back when you reopen the page.
      </>
    ),
  },
  {
    icon: <Icon.matrix />,
    title: 'Compensation and unmixing',
    text: (
      <>
        Acquisition matrices from the files are applied. <b>Compensation</b> computes or edits a matrix from single-stain controls; <b>Unmixing</b> does spectral unmixing (also for conventional panels).
      </>
    ),
  },
  {
    icon: <Icon.beads />,
    title: 'Calibration',
    text: (
      <>
        <b>MESF / ERF</b> from fluorescence bead kits (enter your lot values); <b>Size (Mie)</b> turns scatter into nm with reference beads, e.g. for extracellular vesicles.
      </>
    ),
  },
  {
    icon: <SparkIcon />,
    title: 'AI assistant (optional)',
    text: <>Off by default. When you switch it on, it suggests gates and methods text; it sends plot images, names and counts only when you start an AI action, and shows what is sent first.</>,
  },
  {
    icon: <Icon.eyeOff />,
    title: 'Privacy',
    text: <>Everything runs in this browser: FCS files, workspaces and figures are not uploaded. Event data never leave this computer.</>,
  },
];

function GuideDialog({ onClose }: { onClose: () => void }) {
  const phone = useShellMode() === 'phone';
  return (
    <Modal
      wide
      title="Getting started"
      onClose={onClose}
      footer={
        <>
          {!phone && (
            <button className="btn" onClick={() => useStore.getState().setUI({ dialog: { kind: 'shortcuts' } })}>
              Keyboard shortcuts
            </button>
          )}
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <ol className="guide-flow" aria-label="Typical workflow">
        {['Load', 'Gate', 'Statistics', 'Plates', 'Figures', 'Save'].map((t, i) => (
          <li key={t}>
            <span className="guide-step">{i + 1}</span>
            {t}
          </li>
        ))}
      </ol>
      <div className="guide-grid">
        {GUIDE.map((g) => (
          <section key={g.title} className="guide-card">
            <span className="guide-ic" aria-hidden="true">
              {g.icon}
            </span>
            <div>
              <h4>{g.title}</h4>
              <p>{phone && g.phoneText ? g.phoneText : g.text}</p>
            </div>
          </section>
        ))}
      </div>
      <p className="hint" style={{ margin: '10px 0 0' }}>
        Questions, bug reports or ideas:{' '}
        <a href={contactMailto()} target="_blank" rel="noopener noreferrer" className="contact-mail">
          {APP_CONTACT_EMAIL}
        </a>
      </p>
    </Modal>
  );
}

// ------------------------------------------------------------------ the last session could not be restored

export interface RestoreProblemPayload {
  /** 'crashed': the last start broke down while restoring; 'failed': the saved session could not be read */
  reason: 'crashed' | 'failed';
  message?: string;
}

/**
 * Shown instead of restoring the last session when that broke the app on the previous start (or cannot be read): the
 * saved session can be downloaded, opened again, or discarded. It cannot be closed without a choice, and autosave starts
 * only after it (so the saved session is not overwritten meanwhile).
 */
function RestoreProblemDialog({ payload, onClose }: { payload: RestoreProblemPayload; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    onClose();
    const r = await restoreSession();
    if (r.status === 'failed') {
      useStore.getState().setUI({ dialog: { kind: 'restoreProblem', payload: { reason: 'failed', message: r.message } satisfies RestoreProblemPayload } });
      return;
    }
    if (r.status === 'none') loadDemo();
    startAutosave();
  };
  const startEmpty = () => {
    onClose();
    restoreSettled();
    newBlankWorkspace(); // the saved session moves to the earlier analyses of the start screen
    startAutosave();
    useStore.getState().toast('Started with an empty workspace. The last session is kept under Earlier analyses on the start screen (click the logo).', 'info', { duration: 9000 });
  };
  return (
    <Modal
      title="The last session was not restored"
      closable={false}
      onClose={() => undefined}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={() => void downloadSavedSession()}>
            Download the saved session
          </button>
          <button className="btn" disabled={busy} onClick={startEmpty}>
            Start empty
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void retry()}>
            Try again
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        {payload.reason === 'crashed'
          ? 'FlowState stopped working while it was opening your last session, so the session was not opened again automatically.'
          : `Your last session could not be opened: ${payload.message ?? 'unknown error'}`}
      </p>
      <p>
        The session is still saved in this browser. <b>Download the saved session</b> keeps a copy (a .flowstate.zip with the workspace and its FCS files).{' '}
        <b>Try again</b> opens it once more; <b>Start empty</b> keeps it under Earlier analyses on the start screen.
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------- very large loads

type LargeLoadPayload = { plan: LargeLoad; resolve: (c: LargeLoadChoice) => void };

const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

/** Asked before loading more event data than the browser tab can keep (see largeLoadPlan). */
function LargeLoadDialog({ payload, onClose }: { payload: LargeLoadPayload; onClose: () => void }) {
  const { plan, resolve } = payload;
  // answered once: a button, or "cancel" when the dialog goes away otherwise (replaced, the app reset)
  // (the same dialog may get the question of a later load: the answer goes to the question shown)
  const cur = useRef({ resolve, answered: false });
  if (cur.current.resolve !== resolve) cur.current = { resolve, answered: false };
  const answer = (c: LargeLoadChoice) => {
    const k = cur.current;
    if (k.answered) return;
    k.answered = true;
    k.resolve(c);
  };
  useEffect(
    () => () => {
      const k = cur.current;
      if (!k.answered) (k.answered = true), k.resolve('cancel');
    },
    [],
  );
  const done = (c: LargeLoadChoice) => {
    answer(c);
    onClose();
  };
  const n = plan.skip.length;
  const skipped = plan.skip.reduce((a, f) => a + f.size, 0);
  return (
    <Modal
      title="Very large files"
      onClose={() => done('cancel')}
      footer={
        <>
          <button className="btn" onClick={() => done('cancel')}>
            Cancel
          </button>
          <button className="btn" onClick={() => done('all')} title="May make the page run out of memory and close">
            Load all anyway
          </button>
          {n > 0 && (
            <button className="btn primary" data-autofocus="" onClick={() => done('skip')}>
              Leave out {n === 1 ? 'the largest file' : `the ${n} largest files`}
            </button>
          )}
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        These files hold {gb(plan.total)} of event data{plan.open > 50e6 ? ` (${gb(plan.open)} of it from the samples already open)` : ''}, more than this browser tab
        can safely keep in memory (about {gb(plan.budget)} here). Everything stays on this computer, so the page itself has to hold the events.
      </p>
      {n === 0 && <p>Loading may make the page run out of memory and close (unsaved changes since the last autosave would be lost).</p>}
      {n > 0 && (
        <>
          <p>Leaving out {n === 1 ? 'this file' : `these ${n} files`} ({gb(skipped)}) keeps the rest within the limit:</p>
          <ul className="large-load-list">
            {plan.skip.slice(0, 8).map((f) => (
              <li key={f.name + f.size}>
                <span>{f.name}</span>
                <span className="hint">{gb(f.size)}</span>
              </li>
            ))}
            {n > 8 && <li className="hint">and {n - 8} more</li>}
          </ul>
          <p className="hint">Cleaning and buffer tubes of nanoscale runs (Contrad, water, PBS) are often this large. A large file you need can be opened on its own later.</p>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- experiment setup

/** Kind of experiment and the calibration tools the analysis shows (Workspace.setup). */
function SetupDialog({ onClose }: { onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const [d, setD] = useState<ExperimentSetup>(() => ws.setup ?? { kind: ws.samples.some((s) => { const sd = engine.samples.get(s.id); return !!sd && isNanoscaleData(sd.ds); }) ? 'nanoscale' : 'conventional', mesf: true, size: true });
  const used = (k: string) => !!ws.derived?.some((x) => x.kind === k);
  const apply = () => {
    useStore.getState().update((w) => {
      w.setup = { ...d };
    });
    onClose();
  };
  return (
    <Modal
      title="Experiment setup"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-autofocus="" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>What this analysis needs. Tools it does not need are hidden; change this any time.</p>
      <Field label="Experiment">
        <div>
          <Seg
          value={d.kind}
          options={[
            { value: 'conventional', label: 'Conventional', title: 'Cells and beads: compensation, gating, statistics' },
            { value: 'nanoscale', label: 'Nanoscale', title: 'EVs, viruses, liposomes: size and MESF calibration; scatter channels new to the analysis get log axes (existing axes stay)' },
          ]}
          onChange={(k) => setD({ ...d, kind: k, mesf: k === 'nanoscale' || used('mesf'), size: k === 'nanoscale' || used('size') })}
          />
        </div>
      </Field>
      <Field label="Calibrators">
        <div style={{ display: 'grid', gap: 6 }}>
          <div className="check-info">
            <Check checked={d.mesf} label="MESF / ERF: fluorescence in molecules of equivalent soluble fluorochrome (intensity beads)" onChange={(v) => setD({ ...d, mesf: v })} />
            <InfoTip label="MESF / ERF">{MESF_INFO}</InfoTip>
          </div>
          <div className="check-info">
            <Check checked={d.size} label="Size (Mie): scatter in nm² and diameter (size beads such as nanoViS or ApogeeMix)" onChange={(v) => setD({ ...d, size: v })} />
            <InfoTip label="size calibration (Mie)">{SIZE_INFO}</InfoTip>
          </div>
        </div>
      </Field>
      {((!d.mesf && used('mesf')) || (!d.size && used('size'))) && <p className="hint">Calibrations already made in this analysis stay shown.</p>}
    </Modal>
  );
}
