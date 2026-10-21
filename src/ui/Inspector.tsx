import { useState, type ReactNode } from 'react';
import { engine } from '../core/engine';
import {
  allChannels,
  channelDisplayName,
  ITEM_MAX_POS,
  ITEM_MAX_SIZE,
  ITEM_MIN_SIZE,
  MM,
  PAGE_SIZES,
  popById,
  popPath,
  uid,
  type GateGeom,
  type PlotItem,
  type PlotBackground,
  type PlotOptions,
  type PlotType,
  DEFAULT_GRID_COLOR,
  sheetGridOpacity,
  sheetGridStyle,
  type Population,
  type SheetItem,
  type StatsBoxItem,
  type ChartItem,
  type TextItem,
  type Workspace,
  type Worksheet,
  setGridStyle,
  STAT_LABELS,
  STAT_NEEDS_CHANNEL,
  type StatKind,
} from '../core/model';
import { describeScale, formatLinear } from '../core/transforms';
import { CUSTOM_CMAP, DEFAULT_CUSTOM_STOPS, luminance, mixHex } from '../render/colormaps';
import { omittedEvents, plotFitNotes, plotSampleId, setPlotPopulation, usesColormap } from '../render/plot';
import { autoTextColor, bodyPt, histModeOfLabel, optsX, pageIsDark, SLIDE_SIZES, titleModeOf, type PlotOptionsX, type TitleMode } from '../render/figstyle';
import { isCalibPanel, type CalibChartItem } from '../render/calibPanel';
import { cellRange, plateCells } from '../core/plate';
import { isPlateChart, layoutOf, plateStatValue, type PlateChartItem } from '../render/plateChart';
import { PlateLayoutInspector } from './PlateView';
import { instrumentScaleKey, scaleFor } from '../core/instruments';
import { applyPresetTo, CmapPicker, copyStyleToSheet, PRESET_OPTIONS, ZebraIcon } from './stylePresets';
import { deletePopulation, newPlotItem, useStore } from '../state/store';
import { textNeedH, textOverflows } from '../render/items';
import { Icon } from './icons';
import { Check, ColorIn, Field, Num, Sel, Seg, Txt } from './widgets';
import { addPlotAt, arrange, arrangeGapMm, contentBox, fitPageToContent, populationPlotSpec, setArrangeGapMm, type ArrangeMode } from './layoutOps';
import { ChannelPicker } from './ChannelPicker';
import { itemsOutsidePage } from '../io/exportFigure';
import { ancestorOptions, validOfPopulation } from './TablesView';
import { scopeLabel, scopeOwner } from '../core/scope';

export function updItem(sheetId: string, itemId: string, f: (it: SheetItem) => void, key?: string) {
  useStore.getState().update((w) => {
    const it = w.worksheets.find((s) => s.id === sheetId)?.items.find((i) => i.id === itemId);
    if (it) f(it as SheetItem);
  }, key);
}

function popOptions(ws: Workspace) {
  const out: { value: string; label: string }[] = [{ value: 'root', label: 'All Events' }];
  const walk = (parent: string | null, depth: number) => {
    for (const p of ws.populations.filter((x) => x.parentId === parent)) {
      out.push({ value: p.id, label: `${' '.repeat(depth)}${p.name}` });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

const VIEW_NAMES: Partial<Record<string, string>> = { tables: 'Statistics', comp: 'Compensation', unmix: 'Unmixing', calib: 'Calibration' };

export function Inspector() {
  const ws = useStore((s) => s.ws);
  const ui = useStore((s) => s.ui);
  const sheet = ws.worksheets.find((w) => w.id === ui.activeSheetId) ?? ws.worksheets[0];
  const sel = sheet.items.filter((i) => ui.selectedItemIds.includes(i.id));
  const pop = ui.selectedPopId ? popById(ws, ui.selectedPopId) : undefined;
  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <span className="grow">Inspector</span>
      </div>
      <div
        className="pane-body insp"
        onKeyDownCapture={(e) => {
          // Enter in a one-line field commits it (the field's own handler) and gives the keys back to the worksheet
          // (Ctrl+D, arrows, Delete act on the selection again)
          const t = e.target as HTMLElement;
          if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || t.tagName !== 'INPUT') return;
          const type = (t as HTMLInputElement).type;
          if (type === 'checkbox' || type === 'radio' || type === 'color' || type === 'range') return;
          setTimeout(() => {
            if (document.activeElement === t) t.blur();
          }, 0);
        }}
      >
        {/* the plate view: the layout of the selected wells (the worksheet's settings do not apply there) */}
        {ui.view === 'plate' ? (
          <PlateLayoutInspector />
        ) : ui.view !== 'sheet' ? (
          // Statistics, Compensation, Unmixing, Calibration: edited in the view itself; a population chosen in the tree
          // can still be edited here (the worksheet's page and grid settings belong to the worksheet tabs)
          pop ? (
            <PopulationInspector key={pop.id} pop={pop} ws={ws} sampleId={ui.activeSampleId} sheet={sheet} />
          ) : (
            <div className="empty-note">
              {VIEW_NAMES[ui.view] ?? 'This view'} is set up in the view itself. Select a population in the tree to edit its gate here; worksheet and plot settings show on a worksheet tab.
            </div>
          )
        ) : (
          <>
          {/* sections are keyed by what they edit: pending field edits commit to that object when the selection changes */}
          {pop && <PopulationInspector key={pop.id} pop={pop} ws={ws} sampleId={ui.activeSampleId} sheet={sheet} />}
          {sel.length === 1 && sel[0].kind === 'plot' && <PlotInspector key={sel[0].id} item={sel[0]} sheet={sheet} ws={ws} />}
          {sel.length === 1 && sel[0].kind === 'text' && <TextInspector key={sel[0].id} item={sel[0]} sheet={sheet} />}
          {sel.length === 1 && sel[0].kind === 'stats' && <StatsInspector key={sel[0].id} item={sel[0]} sheet={sheet} ws={ws} />}
          {sel.length === 1 &&
            sel[0].kind === 'chart' &&
            (isCalibPanel(sel[0]) ? (
              <CalibInspector key={sel[0].id} item={sel[0]} sheet={sheet} />
            ) : isPlateChart(sel[0]) ? (
              <PlateChartInspector key={sel[0].id} item={sel[0]} sheet={sheet} ws={ws} />
            ) : (
              <ChartInspector key={sel[0].id} item={sel[0]} sheet={sheet} ws={ws} />
            ))}
          {sel.length > 1 && <MultiInspector key={sheet.id + ':' + sel.map((i) => i.id).join(',')} items={sel} sheet={sheet} />}
          {sel.length === 1 && <GeometrySection key={'geo' + sel[0].id} item={sel[0]} sheet={sheet} />}
          {sel.length === 0 && !pop && <SheetInspector key={sheet.id} sheet={sheet} ws={ws} />}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ plot

const PLOT_TYPES: { value: PlotType; label: React.ReactNode; title: string }[] = [
  { value: 'dot', label: <Icon.dot />, title: 'Dot plot' },
  { value: 'pseudo', label: <Icon.pseudo />, title: 'Pseudocolor' },
  { value: 'density', label: <Icon.density />, title: 'Density' },
  { value: 'contour', label: <Icon.contour />, title: 'Contour' },
  { value: 'zebra', label: <ZebraIcon />, title: 'Zebra' },
  { value: 'histogram', label: <Icon.histogram />, title: 'Histogram' },
];

const closedKey = 'fs.insp.closed';
function readClosed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(closedKey) ?? '[]');
  } catch {
    return [];
  }
}

/** Collapsible inspector section; open / closed is remembered per section. */
function Sec({ id, title, children, alt }: { id: string; title: string; children: ReactNode; alt?: boolean }) {
  const [open, setOpen] = useState(() => !readClosed().includes(id));
  const toggle = () => {
    setOpen(!open);
    try {
      const s = new Set(readClosed());
      if (open) s.add(id);
      else s.delete(id);
      localStorage.setItem(closedKey, JSON.stringify([...s]));
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className={`isec${open ? '' : ' closed'}`} style={alt ? { background: 'var(--panel-alt)' } : undefined}>
      <button className="isec-head" aria-expanded={open} onClick={toggle}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d={open ? 'M2 3.5l3 3 3-3' : 'M3.5 2l3 3-3 3'} stroke="currentColor" strokeWidth="1.4" fill="none" />
        </svg>
        {title}
      </button>
      {open && <div className="isec-body">{children}</div>}
    </div>
  );
}

/** Sub-heading inside a section. */
const Sub = ({ children }: { children: ReactNode }) => <div className="isub">{children}</div>;

const pct = (v: number) => `${Math.round(v * 100) / 100}`;
/** A share as percent text ("0.4 %", "<0.1 %"). */
const fmtShare = (f: number) => (f < 0.001 ? '<0.1 %' : `${(f * 100).toFixed(f < 0.1 ? 1 : 0)} %`);
/** A y axis title that names a histogram mode: it follows the mode when the mode changes. */
const isModeLabel = (t: string) => histModeOfLabel(t) !== null;
const DENS_BINS = ['64', '128', '256', '512'];
const DENS_SMOOTH = [0.25, 0.5, 1, 2];
const HIST_SMOOTH = [0.5, 1, 1.5, 2, 3, 5];

function PlotInspector({ item, sheet, ws }: { item: PlotItem; sheet: Worksheet; ws: Workspace }) {
  const st = useStore.getState();
  const chans = allChannels(ws).map((c) => ({ value: c.name, label: channelDisplayName(ws, c.name) }));
  const up = (f: (p: PlotItem) => void, key?: string) => updItem(sheet.id, item.id, (it) => f(it as PlotItem), key);
  const upo = (f: (o: PlotOptions) => void, key?: string) => up((p) => f(p.options), key);
  const o = item.options;
  const t = item.plotType;
  const isHist = t === 'histogram';
  const contourish = t === 'contour' || t === 'zebra';
  const densColored = t === 'pseudo' || (t === 'dot' && o.colorMode === 'density') || (t === 'density' && o.colorMode !== 'param');
  const byParam = o.colorMode === 'param' && (t === 'dot' || t === 'density');
  const hasCmap = usesColormap(item);
  const legacyDens = densColored && o.densitySmooth === undefined;
  const pointDots = t === 'dot' || t === 'pseudo';
  // backgating (dots colored by population) has a legend of the population colors
  const backgate = t === 'dot' && o.colorMode === 'population';
  const [preset, setPreset] = useState(ws.style.preset ?? 'classic');
  const sampleOpts = [{ value: 'active', label: 'Active sample' }, ...ws.samples.map((s) => ({ value: s.id, label: s.name }))];
  const pops = popOptions(ws);
  // channel lists start with the channels of the samples this plot shows
  const plotSamples = [...new Set(item.layers.map((l) => (l.sample === 'active' ? useStore.getState().ui.activeSampleId : l.sample)).filter((x): x is string => !!x))];
  const scaleBtn = (axis: 'x' | 'y') => {
    const ch = axis === 'x' ? item.xParam : item.yParam;
    const ov = axis === 'x' ? o.xScale : o.yScale;
    const psid = plotSampleId(item, useStore.getState().ui.activeSampleId);
    const inst = !ov && ws.instrumentScales ? instrumentScaleKey(ws, ch, psid, engine.keywordsOf) : null;
    const def = ov ?? scaleFor(ws, ch, psid, engine.keywordsOf);
    return (
      <button className="btn sm" style={{ justifyContent: 'flex-start', overflow: 'hidden' }} onClick={() => st.setUI({ dialog: { kind: 'axis', payload: { channel: ch, itemId: item.id, axis } } })} title="Edit axis scale">
        <Icon.axis />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={inst ? `Scale of the instrument "${inst}"` : undefined}>
          {def ? describeScale(def).split(' (')[0] + (ov ? ' (plot)' : inst ? ' (instrument)' : '') : 'Linear'}
        </span>
      </button>
    );
  };
  // density estimate of pseudocolor / density plots (v1 plots: smoothed, until changed here)
  const legacyG = t === 'density' ? 128 : 200;
  const G = o.densityBins ?? legacyG;
  const smooth = o.densitySmooth ?? (t === 'density' ? 0.5 : 0.6);
  const unlegacy = (x: PlotOptions) => {
    if (x.densitySmooth === undefined) {
      x.densitySmooth = smooth;
      x.densityBins = G;
      x.densityScale ??= 'sqrt';
    }
  };
  const bw = o.contourBandwidth ?? 1.25;
  const cG = o.densityBins ?? 128;
  const firstFl = chans.find((c) => c.value !== item.xParam && c.value !== item.yParam && !/FSC|SSC|Time/i.test(c.value))?.value ?? chans[0]?.value;
  const paramScaleKind = !o.colorParamScale ? 'ws' : o.colorParamScale.type === 'log' ? 'log' : 'linear';
  const cmapSpec = { name: o.colormap, reverse: o.cmapReverse, stops: o.cmapStops };
  const [lo, hi] = o.colorRange ?? [0, 100];
  const activeId = useStore.getState().ui.activeSampleId;
  const omitted = omittedEvents(item, ws, engine, activeId);
  const fitNotes = plotFitNotes(item, ws, activeId, engine);
  const tMode = titleModeOf(o);
  return (
    <>
      <Sec id="data" title="Data">
        <Field label="Type">
          <div className="seg-tight">
            <Seg
              value={t}
              options={PLOT_TYPES}
              onChange={(v) =>
                up((p) => {
                  p.plotType = v;
                  if (v === 'histogram') {
                    p.yParam = p.xParam;
                    p.options.yWin = undefined;
                  } else if (p.yParam === p.xParam) {
                    const other = chans.find((c) => c.value !== p.xParam);
                    if (other) p.yParam = other.value;
                  }
                  if (v === 'pseudo') p.options.colorMode = 'density';
                  else if (v === 'dot' && t !== 'dot' && p.options.colorMode === 'density') p.options.colorMode = 'single';
                })
              }
            />
          </div>
        </Field>
        <Field label="X parameter">
          <ChannelPicker value={item.xParam} samples={plotSamples} ariaLabel="X parameter" onChange={(v) => up((p) => {
            if (v === p.xParam) return;
            p.xParam = v;
            if (p.plotType === 'histogram') p.yParam = v;
            p.options.xScale = undefined;
            p.options.xWin = undefined; // a new parameter starts unzoomed
            p.options.labelPos = {};
            p.options.labelOff = {};
          })} />
        </Field>
        <Field label="X scale">{scaleBtn('x')}</Field>
        {(o.xWin || o.yWin) && (
          <div className="row" style={{ marginBottom: 6, justifyContent: 'space-between' }}>
            <span className="hint">Axes zoomed with the zoom tool.</span>
            <button className="btn sm" onClick={() => upo((x) => {
              x.xWin = undefined;
              x.yWin = undefined;
            })}>Reset zoom</button>
          </div>
        )}
        {!isHist && (
          <>
            <Field label="Y parameter">
              <ChannelPicker value={item.yParam} samples={plotSamples} ariaLabel="Y parameter" onChange={(v) => up((p) => {
                if (v === p.yParam) return;
                p.yParam = v;
                p.options.yScale = undefined;
                p.options.yWin = undefined;
                p.options.labelPos = {};
                p.options.labelOff = {};
              })} />
            </Field>
            <Field label="Y scale">{scaleBtn('y')}</Field>
            <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 6 }}>
              <button className="btn sm" onClick={() => up((p) => {
                const x = p.xParam;
                p.xParam = p.yParam;
                p.yParam = x;
                const xs = p.options.xScale;
                p.options.xScale = p.options.yScale;
                p.options.yScale = xs;
                const xw = p.options.xWin;
                p.options.xWin = p.options.yWin;
                p.options.yWin = xw;
                p.options.labelPos = {};
                p.options.labelOff = {};
              })}>Swap axes</button>
            </div>
          </>
        )}
        <Sub>{item.layers.length > 1 ? 'Overlay layers' : 'Sample & population'}</Sub>
        {item.layers.map((l, i) => (
          <div key={l.id} className="layer">
            <ColorIn value={l.color ?? (i === 0 && item.layers.length === 1 ? o.dotColor : ['#1f1f1f', '#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd'][i % 6])} ariaLabel="Layer color" onChange={(v) => up((p) => {
              if (p.layers.length === 1 && i === 0) p.options.dotColor = v;
              p.layers[i].color = v;
            }, 'lc' + l.id)} />
            <Sel value={l.sample} options={sampleOpts} ariaLabel="Sample" onChange={(v) => up((p) => {
              p.layers[i].sample = v;
            })} />
            <button className="icon-btn danger" title="Remove layer" aria-label="Remove layer" disabled={item.layers.length === 1} onClick={() => up((p) => {
              p.layers.splice(i, 1);
            })}>
              <Icon.close />
            </button>
            <button className="icon-btn" title={l.visible === false ? 'Show' : 'Hide'} aria-label="Toggle layer" onClick={() => up((p) => {
              p.layers[i].visible = p.layers[i].visible === false;
            })}>
              {l.visible === false ? <Icon.eyeOff /> : <Icon.eye />}
            </button>
            <div className="full">
              <Sel value={l.population} options={pops} ariaLabel="Population" onChange={(v) => up((p) => {
                // the first layer's gates stay on the plot (also when going up the tree)
                if (i === 0) setPlotPopulation(useStore.getState().ws, p, v, useStore.getState().ui.activeSampleId);
                else p.layers[i].population = v;
                if (i === 0) {
                  p.options.labelPos = {};
                  p.options.labelOff = {};
                }
              })} />
            </div>
            {item.layers.length > 1 && (
              <div className="full">
                <Txt value={l.label ?? ''} placeholder="Legend label (auto)" ariaLabel="Legend label" onChange={(v) => up((p) => {
                  p.layers[i].label = v || undefined;
                })} />
              </div>
            )}
          </div>
        ))}
        <div className="row" style={{ marginBottom: 6 }}>
          <button className="btn sm" onClick={() => up((p) => {
            const last = p.layers[p.layers.length - 1];
            const used = new Set(p.layers.map((x) => x.sample));
            const next = ws.samples.find((s) => !used.has(s.id));
            p.layers.push({ id: uid('ly'), sample: next?.id ?? last?.sample ?? 'active', population: last?.population ?? 'root' });
          })}>
            <Icon.plus /> Add overlay
          </button>
        </div>
        {omitted && (
          <div className="note-box" role="status">
            {omitted.omitted.toLocaleString('en-US')} of {omitted.total.toLocaleString('en-US')} events ({fmtShare(omitted.omitted / Math.max(1, omitted.total))}) have no value in {omitted.channels.map((c) => channelDisplayName(ws, c, 'short')).join(' or ') || 'a plotted channel'} (e.g. outside the calibrated size range) and are not drawn. The figure does not mention them.
          </div>
        )}
        {!isHist && (
          <Field label="Events shown" title="Draw at most this many events (a random subset) to keep large files fast. Statistics and gate percentages always use all events.">
            <Sel
              value={String(o.maxEvents || 0)}
              ariaLabel="Events shown"
              options={[...new Set([0, 10000, 50000, 100000, 500000, o.maxEvents || 0])]
                .sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b))
                .map((v) => ({ value: String(v), label: v === 0 ? 'All events' : `At most ${v >= 1000 ? `${v / 1000}k` : v}` }))}
              onChange={(v) => upo((x) => {
                x.maxEvents = Number(v);
              })}
            />
          </Field>
        )}
        {isHist && (
          <>
            <Field label="Y axis">
              <Seg value={o.histMode} options={[{ value: 'normalized', label: '% of max' }, { value: 'count', label: 'Count' }]} onChange={(v) => upo((x) => {
                x.histMode = v;
                // a y title naming the other mode ("% of max", "Count", ...) follows the mode; any other typed title stays
                if (x.yLabel !== undefined && isModeLabel(x.yLabel)) x.yLabel = undefined;
              })} />
            </Field>
            <Field label="Bins" title="Bin width = axis range / bins. Fewer bins coarsen the histogram without smoothing it.">
              <Sel value={String(o.bins)} ariaLabel="Bins" options={['32', '64', '128', '256', '512', '1024'].map((b) => ({ value: b, label: `${b} (${pct(100 / Number(b))}% wide)` }))} onChange={(v) => upo((x) => {
                x.bins = Number(v);
              })} />
            </Field>
            <div title={`Display only: the drawn curve is convolved with a Gaussian kernel (σ in bins of the histogram). Statistics always use the raw events. Off by default.`}>
              <Check checked={o.histSmooth > 0} label="Smoothing (display only)" onChange={(v) => upo((x) => {
                x.histSmooth = v ? 1 : 0;
              })} />
            </div>
            {o.histSmooth > 0 && (
              <Field label="Gaussian σ" title={`σ = ${o.histSmooth} bins = ${pct((100 * o.histSmooth) / (o.bins || 256))}% of the axis range`}>
                <Sel
                  value={String(o.histSmooth)}
                  ariaLabel="Histogram smoothing kernel width"
                  options={[...new Set([...HIST_SMOOTH, o.histSmooth])].sort((a, b) => a - b).map((v) => ({ value: String(v), label: `${v} bin${v === 1 ? '' : 's'} (${pct((100 * v) / (o.bins || 256))}% of axis)` }))}
                  onChange={(v) => upo((x) => {
                    x.histSmooth = Number(v);
                  })}
                />
              </Field>
            )}
          </>
        )}
        {densColored && (
          <>
            <Sub>Density estimate</Sub>
            <Field label="Bins" title={`Events are counted in ${G} x ${G} bins (bin width ${pct(100 / G)}% of each axis). Each event is colored by the count of its bin.`}>
              <Sel value={String(G)} ariaLabel="Density bins" options={[...new Set([...DENS_BINS, String(G)])].map((b) => ({ value: b, label: `${b} x ${b}` }))} onChange={(v) => upo((x) => {
                unlegacy(x);
                x.densityBins = Number(v);
              })} />
            </Field>
            <div title="Display only, off by default: colors events by a Gaussian-smoothed density instead of the raw events per bin. Statistics are never affected.">
              <Check checked={smooth > 0} label="Density smoothing (display only)" onChange={(v) => upo((x) => {
                unlegacy(x);
                x.densitySmooth = v ? 0.5 : 0;
              })} />
            </div>
            {smooth > 0 && (
              <Field label="Gaussian σ" title={`σ = ${smooth}% of the axis range (${pct((smooth / 100) * G)} bins)`}>
                <Sel value={String(smooth)} ariaLabel="Density smoothing kernel width" options={[...new Set([...DENS_SMOOTH, smooth])].sort((a, b) => a - b).map((v) => ({ value: String(v), label: `${v}% of axis` }))} onChange={(v) => upo((x) => {
                  unlegacy(x);
                  x.densitySmooth = Number(v);
                })} />
              </Field>
            )}
            {legacyDens && (
              <div className="note-box">
                Saved with the earlier smoothed coloring (Gaussian σ ≈ {smooth}% of the axis, power scale).
                <button className="btn sm" onClick={() => upo((x) => {
                  x.densitySmooth = 0;
                  x.densityBins = 128;
                  x.densityScale = 'log';
                })}>Use unsmoothed density</button>
              </div>
            )}
          </>
        )}
        {contourish && (
          <>
            <Sub>Density estimate</Sub>
            <Field label="Bandwidth %" title={`Contours${t === 'zebra' ? ' and zebra bands' : ''} are drawn from a smoothed density estimate: Gaussian kernel with σ = ${bw}% of the axis range (${pct((bw / 100) * cG)} of ${cG} bins). Statistics are never affected.`}>
              <Num value={bw} min={0.25} max={10} step={0.25} ariaLabel="Contour bandwidth" onChange={(v) => upo((x) => {
                x.contourBandwidth = v;
              })} />
            </Field>
            <Field label="Levels" title="Equal probability: each band holds the same share of events. Log density: levels evenly spaced in log density, from one event's kernel peak to the maximum.">
              <Seg value={o.contourMode ?? 'probability'} options={[{ value: 'probability', label: 'Equal prob.' }, { value: 'log', label: 'Log density' }]} onChange={(v) => upo((x) => {
                x.contourMode = v;
              })} />
            </Field>
            <Field label="Level step %" title="Equal probability: % of events per band. Log density: the same number of levels.">
              <Num value={o.contourLevels} min={2} max={50} step={1} ariaLabel="Contour level" onChange={(v) => upo((x) => {
                x.contourLevels = v;
              })} />
            </Field>
            <p className="hint note">Drawn from a smoothed density estimate (σ = {bw}% of axis).</p>
          </>
        )}
      </Sec>

      <Sec id="colors" title="Colors">
        <Field label="Style preset" title="Changes only the look (colors, background, axes), never channels, gates, scales or smoothing">
          <Sel value={preset} ariaLabel="Style preset" options={PRESET_OPTIONS} onChange={setPreset} />
        </Field>
        <div className="row" style={{ marginBottom: 8, justifyContent: 'flex-end' }}>
          <button className="btn sm" onClick={() => applyPresetTo(sheet.id, st.ui.selectedItemIds.length ? st.ui.selectedItemIds : [item.id], preset)}>Apply to selected</button>
          <button className="btn sm" onClick={() => applyPresetTo(sheet.id, 'all', preset)}>Apply to sheet</button>
        </div>
        {(t === 'dot' || t === 'pseudo' || t === 'density') && (
          <Field label="Color by">
            <Sel
              value={t === 'pseudo' ? 'density' : t === 'density' ? (o.colorMode === 'param' ? 'param' : 'density') : o.colorMode}
              ariaLabel="Color mode"
              options={
                t === 'density'
                  ? [
                      { value: 'density', label: 'Density' },
                      { value: 'param', label: 'Third parameter (per bin)' },
                    ]
                  : [
                      { value: 'single', label: 'Single color' },
                      { value: 'density', label: 'Density (pseudocolor)' },
                      { value: 'population', label: 'Gate colors (backgating)' },
                      { value: 'param', label: 'Third parameter' },
                    ]
              }
              onChange={(v) => up((p) => {
                p.options.colorMode = v as PlotOptions['colorMode'];
                if (v === 'param' && !p.options.colorParam) p.options.colorParam = firstFl;
                if (p.plotType !== 'density') p.plotType = v === 'density' ? 'pseudo' : 'dot';
              })}
            />
          </Field>
        )}
        {byParam && (
          <>
            <Field label="Parameter">
              <ChannelPicker value={o.colorParam ?? ''} samples={plotSamples} ariaLabel="Color parameter" onChange={(v) => upo((x) => {
                x.colorParam = v;
                x.colorParamScale = undefined;
              })} />
            </Field>
            <Field label="Param. scale" title="Scale used to map the parameter onto the colormap">
              <Sel
                value={paramScaleKind}
                ariaLabel="Color parameter scale"
                options={[
                  { value: 'ws', label: 'As its axes (workspace)' },
                  { value: 'linear', label: 'Linear' },
                  { value: 'log', label: 'Log' },
                ]}
                onChange={(v) => upo((x) => {
                  const base = x.colorParam ? ws.scales[x.colorParam] : undefined;
                  const top = !base ? 262144 : base.type === 'logicle' || base.type === 'arcsinh' ? base.T : base.type === 'window' ? 262144 : base.max;
                  x.colorParamScale = v === 'linear' ? { type: 'linear', min: 0, max: top } : v === 'log' ? { type: 'log', min: Math.max(1, top / 1e4), max: top, clampLow: true } : undefined;
                })}
              />
            </Field>
            {t === 'density' && (
              <Field label="Per bin">
                <Seg value={o.colorStat ?? 'median'} options={[{ value: 'median', label: 'Median' }, { value: 'mean', label: 'Mean' }]} onChange={(v) => upo((x) => {
                  x.colorStat = v;
                })} />
              </Field>
            )}
          </>
        )}
        {hasCmap && (
          <>
            <Field label="Colormap">
              <CmapPicker spec={cmapSpec} onChange={(v) => upo((x) => {
                x.colormap = v;
                if (v === CUSTOM_CMAP && !x.cmapStops) x.cmapStops = [...DEFAULT_CUSTOM_STOPS];
              })} />
            </Field>
            {o.colormap === CUSTOM_CMAP && (
              <Field label="Gradient">
                <div className="row" style={{ gap: 4 }}>
                  {(o.cmapStops ?? DEFAULT_CUSTOM_STOPS).map((c, i) => (
                    <ColorIn key={i} value={c} ariaLabel={`Gradient color ${i + 1}`} onChange={(v) => upo((x) => {
                      const s = [...(x.cmapStops ?? DEFAULT_CUSTOM_STOPS)];
                      s[i] = v;
                      x.cmapStops = s;
                    }, 'cs' + item.id + i)} />
                  ))}
                  <button className="btn sm" title={(o.cmapStops ?? DEFAULT_CUSTOM_STOPS).length < 3 ? 'Add a middle color' : 'Remove the middle color'} onClick={() => upo((x) => {
                    const s = [...(x.cmapStops ?? DEFAULT_CUSTOM_STOPS)];
                    x.cmapStops = s.length < 3 ? [s[0], mixHex(s[0], s[1], 0.5), s[1]] : [s[0], s[2]];
                  })}>{(o.cmapStops ?? DEFAULT_CUSTOM_STOPS).length < 3 ? '3 colors' : '2 colors'}</button>
                </div>
              </Field>
            )}
            <Check checked={!!o.cmapReverse} label="Reverse colormap" onChange={(v) => upo((x) => {
              x.cmapReverse = v || undefined;
            })} />
          </>
        )}
        {densColored && (
          <Field label="Color scale" title="How events per bin map onto the colormap. Rank: equalized, by the percentile of events at lower density.">
            <Seg
              value={o.densityScale ?? 'sqrt'}
              options={[
                { value: 'linear', label: 'Lin' },
                { value: 'sqrt', label: 'Sqrt' },
                { value: 'log', label: 'Log' },
                { value: 'rank', label: 'Rank' },
              ]}
              onChange={(v) => upo((x) => {
                unlegacy(x);
                x.densityScale = v;
              })}
            />
          </Field>
        )}
        {hasCmap && !contourish && (
          <Field label="Range %" title={byParam ? 'Part of the parameter axis (in % of its display range) spread over the colormap; values beyond are clipped' : 'Part of the color scale (in %) spread over the colormap; values beyond are clipped'}>
            <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
              <Num value={lo} min={0} max={99} step={1} ariaLabel="Color range minimum" onChange={(v) => upo((x) => {
                x.colorRange = [v, Math.max(v + 1, (x.colorRange ?? [0, 100])[1])];
              })} />
              <span className="hint">to</span>
              <Num value={hi} min={1} max={100} step={1} ariaLabel="Color range maximum" onChange={(v) => upo((x) => {
                x.colorRange = [Math.min((x.colorRange ?? [0, 100])[0], v - 1), v];
              })} />
            </div>
          </Field>
        )}
        {hasCmap && (
          <Field label="Color bar">
            <Seg value={o.colorBar ?? 'none'} options={[{ value: 'none', label: 'None' }, { value: 'right', label: 'Right' }, { value: 'top', label: 'Top' }]} onChange={(v) => upo((x) => {
              x.colorBar = v;
            })} />
          </Field>
        )}
        {(pointDots || (contourish && o.contourOutliers)) && (
          <>
            <Sub>{pointDots ? 'Dots' : 'Outlier dots'}</Sub>
            <div className="pair">
              <Field label="Size">
                <Num value={o.dotSize} min={0.5} max={6} step={0.5} ariaLabel="Dot size" onChange={(v) => upo((x) => {
                  x.dotSize = v;
                })} />
              </Field>
              <Field label="Opacity">
                <Num value={o.dotOpacity ?? 1} min={0.05} max={1} step={0.05} ariaLabel="Dot opacity" onChange={(v) => upo((x) => {
                  x.dotOpacity = v;
                })} />
              </Field>
            </div>
            <Field label="Shape">
              <Seg value={o.dotShape ?? 'square'} options={[{ value: 'square', label: 'Square' }, { value: 'circle', label: 'Circle' }]} onChange={(v) => upo((x) => {
                x.dotShape = v;
              })} />
            </Field>
            {pointDots && (densColored || byParam) && (
              <Field label="Draw order">
                <Sel
                  value={o.drawOrder ?? 'density'}
                  ariaLabel="Draw order"
                  options={[
                    { value: 'density', label: byParam ? 'Highest values last' : 'Densest last' },
                    { value: 'file', label: 'File order' },
                    { value: 'random', label: 'Random' },
                  ]}
                  onChange={(v) => upo((x) => {
                    x.drawOrder = v;
                  })}
                />
              </Field>
            )}
          </>
        )}
        {contourish && (
          <>
            <Sub>Contours</Sub>
            <Field label="Lines">
              <Seg value={o.contourLines ?? (t === 'zebra' ? 'none' : 'single')} options={[{ value: 'single', label: 'Color' }, { value: 'level', label: 'By level' }, { value: 'none', label: 'None' }]} onChange={(v) => upo((x) => {
                x.contourLines = v;
              })} />
            </Field>
            {(o.contourLines ?? (t === 'zebra' ? 'none' : 'single')) === 'single' && item.layers.length === 1 && (
              <Field label="Line color">
                <ColorIn value={o.contourLineColor ?? '#1f1f1f'} onChange={(v) => upo((x) => {
                  x.contourLineColor = v;
                }, 'clc' + item.id)} />
              </Field>
            )}
            {t === 'contour' && <Check checked={!!o.contourFill} label="Fill bands with the colormap" onChange={(v) => upo((x) => {
              x.contourFill = v;
            })} />}
            <Check checked={o.contourOutliers} label="Show outliers as dots" onChange={(v) => upo((x) => {
              x.contourOutliers = v;
            })} />
          </>
        )}
        {isHist && (
          <>
            <Field label="Fill">
              {/* (four choices on one row in a narrow inspector) */}
              <div className="seg-tight">
                <Seg
                  value={o.histFillStyle ?? (o.histFill ? (item.layers.length > 1 ? 'semi' : 'solid') : 'outline')}
                  options={[
                    { value: 'solid', label: 'Solid' },
                    { value: 'semi', label: 'Tint' },
                    { value: 'gradient', label: 'Fade' },
                    { value: 'outline', label: 'Line' },
                  ]}
                  onChange={(v) => upo((x) => {
                    x.histFillStyle = v;
                    x.histFill = v !== 'outline';
                  })}
                />
              </div>
            </Field>
            {(o.histFillStyle ?? (o.histFill ? 'solid' : 'outline')) === 'solid' && item.layers.length === 1 && (
              <Field label="Fill color">
                <ColorIn value={o.histFillColor ?? '#9aa6b2'} onChange={(v) => upo((x) => {
                  x.histFillColor = v;
                }, 'hfc' + item.id)} />
              </Field>
            )}
            <Field label="Line width">
              <Num value={o.histLineWidth} min={0.25} max={4} step={0.25} ariaLabel="Line width" onChange={(v) => upo((x) => {
                x.histLineWidth = v;
              })} />
            </Field>
            {item.layers.length > 1 && (
              <>
                <Field label="Offset" title="Vertical stagger between overlay layers">
                  <input type="range" min={0} max={0.4} step={0.01} value={o.histOffset} aria-label="Overlay offset" onChange={(e) => upo((x) => {
                    x.histOffset = Number(e.target.value);
                  }, 'off' + item.id)} />
                </Field>
                <Check checked={!!o.histHideY} label="Hide y axis" onChange={(v) => upo((x) => {
                  x.histHideY = v || undefined;
                })} />
              </>
            )}
          </>
        )}
        <BackgroundField what="Plot" value={o} set={upo} colorKey={'bgc' + item.id} />
      </Sec>

      <Sec id="axes" title="Axes">
        <Check checked={o.showTitle} label="Title" onChange={(v) => upo((x) => {
          x.showTitle = v;
        })} />
        {o.showTitle && (
          <Field label="Title shows" title="Population and sample: follow renames and the sample shown. Custom: the text typed below.">
            <Sel<TitleMode>
              value={tMode}
              ariaLabel="Title mode"
              options={[
                { value: 'population', label: 'Population' },
                { value: 'sample', label: 'Automatic (sample: population)' },
                { value: 'custom', label: 'Custom text' },
              ]}
              onChange={(v) => upo((x) => {
                const xx = x as PlotOptionsX;
                xx.titleMode = v;
                if (v !== 'custom') delete x.title;
                else if (!x.title) x.title = item.layers[0]?.population && item.layers[0].population !== 'root' ? popById(ws, item.layers[0].population)?.name ?? '' : 'All Events';
              })}
            />
          </Field>
        )}
        {o.showTitle && tMode === 'custom' && (
          <Field label="Title text">
            <Txt value={o.title ?? ''} placeholder="Title" ariaLabel="Title" onChange={(v) => upo((x) => {
              x.title = v || undefined;
              (x as PlotOptionsX).titleMode = v ? 'custom' : undefined;
            })} />
          </Field>
        )}
        <Field label="X axis label">
          <Txt value={o.xLabel ?? ''} placeholder={channelDisplayName(ws, item.xParam)} ariaLabel="X axis label" onChange={(v) => upo((x) => {
            x.xLabel = v || undefined;
          })} />
        </Field>
        <Field label="Y axis label">
          <Txt value={o.yLabel ?? ''} placeholder={isHist ? (o.histMode === 'normalized' ? 'Normalized to mode' : 'Count') : channelDisplayName(ws, item.yParam)} ariaLabel="Y axis label" onChange={(v) => upo((x) => {
            x.yLabel = v || undefined;
          })} />
        </Field>
        <div className="pair">
          <Field label="Font pt">
            <Num value={o.fontSize} min={5} max={24} step={0.5} ariaLabel="Font size" onChange={(v) => upo((x) => {
              x.fontSize = v;
            })} />
          </Field>
          <Field label="Line pt">
            <Num value={o.lineWidth} min={0.25} max={4} step={0.25} ariaLabel="Axis line width" onChange={(v) => upo((x) => {
              x.lineWidth = v;
            })} />
          </Field>
        </div>
        <Field label="Frame">
          <Seg value={o.frame ? 'box' : 'axes'} options={[{ value: 'box', label: 'Box' }, { value: 'axes', label: 'Open axes' }]} onChange={(v) => upo((x) => {
            x.frame = v === 'box';
          })} />
        </Field>
        <Field label="Ticks">
          <Seg value={o.tickDir ?? 'out'} options={[{ value: 'out', label: 'Outside' }, { value: 'in', label: 'Inside' }]} onChange={(v) => upo((x) => {
            x.tickDir = v === 'out' ? undefined : v;
          })} />
        </Field>
        <Check checked={!!o.boldLabels} label="Bold axis titles" onChange={(v) => upo((x) => {
          x.boldLabels = v || undefined;
        })} />
        {(item.layers.length > 1 || backgate) && <Check checked={o.legend} label="Legend" onChange={(v) => upo((x) => {
          x.legend = v;
        })} />}
        <Field label="In legend" title="Statistic of the X parameter per layer, e.g. MFI">
          <Sel value={o.legendStat ?? 'none'} ariaLabel="Legend statistic" options={[
            { value: 'none', label: 'Nothing' },
            { value: 'median', label: 'Median (MFI)' },
            { value: 'geomean', label: 'Geo. mean' },
            { value: 'mean', label: 'Mean' },
            { value: 'freqParent', label: '% of parent' },
            { value: 'count', label: 'Event count' },
          ]} onChange={(v) => upo((x) => {
            x.legendStat = v as PlotOptions['legendStat'];
          })} />
        </Field>
        {(item.layers.length > 1 || (o.legendStat ?? 'none') !== 'none' || backgate) && (
          <Field label="Legend position" title="Automatic: inside the plot where it covers the fewest events and labels, else right of or below the plot">
            <Sel value={o.legendPos ?? 'auto'} ariaLabel="Legend position" options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'inside', label: 'Inside the plot' },
              { value: 'outside-right', label: 'Right of the plot' },
              { value: 'below', label: 'Below the plot' },
            ]} onChange={(v) => upo((x) => {
              x.legendPos = v === 'auto' ? undefined : (v as PlotOptions['legendPos']);
            })} />
          </Field>
        )}
        {fitNotes.length > 0 && (
          <div className="note-box warn" role="status">
            {fitNotes.join('; ')} to fit the plot. Make the plot larger, the text smaller, or type a shorter label.
          </div>
        )}
      </Sec>

      <Sec id="gates" title="Gates & labels">
        <Check checked={o.showGates} label="Show gates" onChange={(v) => upo((x) => {
          x.showGates = v;
        })} />
        <Field label="Gate labels">
          <Sel value={o.gateLabel} ariaLabel="Gate labels" options={[
            { value: 'name+percent', label: 'Name + %' },
            { value: 'percent', label: '% only' },
            { value: 'name', label: 'Name only' },
            { value: 'name+count', label: 'Name + count' },
            { value: 'none', label: 'None' },
          ]} onChange={(v) => upo((x) => {
            x.gateLabel = v as PlotOptions['gateLabel'];
          })} />
        </Field>
        <Check checked={!!optsX(o).labelBox} label="Labels on a background box" onChange={(v) => upo((x) => {
          (x as PlotOptionsX).labelBox = v || undefined;
        })} />
        <Check checked={!!o.gateColor} label="One color for all gates" onChange={(v) => upo((x) => {
          x.gateColor = v ? '#000000' : undefined;
        })} />
        {!!o.gateColor && (
          <Field label="Gate color">
            <ColorIn value={o.gateColor} ariaLabel="Gate color" onChange={(v) => upo((x) => {
              x.gateColor = v;
            }, 'gc' + item.id)} />
          </Field>
        )}
        {(Object.keys(o.labelPos ?? {}).length > 0 || Object.keys(o.labelOff ?? {}).length > 0) && (
          <button className="btn sm" onClick={() => upo((x) => {
            x.labelPos = {};
            x.labelOff = {};
          })}>Reset label positions</button>
        )}
      </Sec>
    </>
  );
}

/**
 * Background of a plot, chart or statistics box: automatic (unset: white on light pages, transparent on dark pages),
 * white, transparent, dark, black or a custom color. Dark backgrounds get light axes and text.
 */
function BackgroundField({ what, value, set, colorKey }: { what: string; value: { bg?: PlotBackground; bgColor?: string }; set: (f: (t: { bg?: PlotBackground; bgColor?: string }) => void, key?: string) => void; colorKey: string }) {
  return (
    <Field label="Background" title={`${what} background. Dark backgrounds get light axes and text. Transparent: exports show the page (or nothing, with a transparent export) behind the ${what.toLowerCase()}.`}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <Sel
          value={value.bg ?? 'auto'}
          ariaLabel={`${what} background`}
          options={[
            { value: 'auto', label: 'Automatic (page)' },
            { value: 'white', label: 'White' },
            { value: 'transparent', label: 'Transparent' },
            { value: 'dark', label: 'Dark gray' },
            { value: 'black', label: 'Black' },
            { value: 'custom', label: 'Custom color' },
          ]}
          onChange={(v) => set((x) => {
            // automatic (unset): white on light pages, transparent on dark ones
            x.bg = v === 'auto' ? undefined : (v as PlotBackground);
            if (v === 'custom' && !x.bgColor) x.bgColor = '#f4f1ea';
          })}
        />
        {value.bg === 'custom' && (
          <ColorIn value={value.bgColor ?? '#ffffff'} ariaLabel="Background color" onChange={(v) => set((x) => {
            x.bgColor = v;
          }, colorKey)} />
        )}
      </div>
    </Field>
  );
}

// ------------------------------------------------------------------ geometry

function GeometrySection({ item, sheet }: { item: SheetItem; sheet: Worksheet }) {
  const up = (k: 'x' | 'y' | 'w' | 'h', mm: number) => {
    if (!Number.isFinite(mm)) return;
    const lim = k === 'w' || k === 'h' ? [Math.max(10, ITEM_MIN_SIZE), ITEM_MAX_SIZE] : [-ITEM_MAX_POS, ITEM_MAX_POS];
    const v = Math.min(lim[1], Math.max(lim[0], mm * MM));
    if (v !== mm * MM) useStore.getState().toast(`${k === 'x' ? 'X' : k === 'y' ? 'Y' : k === 'w' ? 'Width' : 'Height'} is limited to ${Math.round(lim[0] / MM)} .. ${Math.round(lim[1] / MM)} mm`, 'info');
    updItem(sheet.id, item.id, (it) => {
      it[k] = v;
      // a text box's height typed by hand stays (see fitTextHeights)
      if (k === 'h' && it.kind === 'text') it.hFixed = true;
    });
  };
  const f = (v: number) => Math.round((v / MM) * 10) / 10;
  return (
    <Sec id="layout" title="Layout">
      <AlignButtons sheetId={sheet.id} ids={[item.id]} single />
      <div className="pair">
        <Field label="X mm">
          <Num value={f(item.x)} step={1} ariaLabel="X position" onChange={(v) => up('x', v)} />
        </Field>
        <Field label="Y mm">
          <Num value={f(item.y)} step={1} ariaLabel="Y position" onChange={(v) => up('y', v)} />
        </Field>
        <Field label="Width">
          <Num value={f(item.w)} step={1} ariaLabel="Width" onChange={(v) => up('w', v)} />
        </Field>
        <Field label="Height">
          <Num value={f(item.h)} step={1} ariaLabel="Height" onChange={(v) => up('h', v)} />
        </Field>
      </div>
      {item.kind === 'plot' && (
        <button className="btn sm" onClick={() => copyStyleToSheet(sheet.id, item)} title="Copy colors, background, axes, font size and label style of this plot to every plot on this sheet">
          Copy style to all plots
        </button>
      )}
    </Sec>
  );
}

const ALIGN: [ArrangeMode, React.ReactNode, string][] = [
  ['left', <Icon.alignL key="l" />, 'Align left'],
  ['hcenter', <Icon.alignC key="c" />, 'Align centers'],
  ['right', <Icon.alignR key="r" />, 'Align right'],
  ['top', <Icon.alignT key="t" />, 'Align top'],
  ['vcenter', <Icon.alignM key="m" />, 'Align middles'],
  ['bottom', <Icon.alignB key="b" />, 'Align bottom'],
];

function AlignButtons({ sheetId, ids, single }: { sheetId: string; ids: string[]; single?: boolean }) {
  const list: [ArrangeMode, React.ReactNode, string][] = single
    ? ALIGN.map(([k, ic, t]) => [k, ic, t.replace(/s$/, '') + ' on the page'])
    : [...ALIGN, ['distH', <Icon.distH key="dh" />, 'Distribute horizontally'], ['distV', <Icon.distV key="dv" />, 'Distribute vertically'], ['sameSize', <Icon.sameSize key="ss" />, 'Same size as the last clicked item']];
  return (
    <div className="row" style={{ marginBottom: 8, gap: 2 }}>
      {list.map(([k, ic, t]) => (
        <button key={k} className="icon-btn" title={t} aria-label={t} onClick={() => arrange(sheetId, ids, k)}>
          {ic}
        </button>
      ))}
    </div>
  );
}

function MultiInspector({ items, sheet }: { items: SheetItem[]; sheet: Worksheet }) {
  const ids = items.map((i) => i.id);
  const plots = items.filter((i): i is PlotItem => i.kind === 'plot');
  const [preset, setPreset] = useState(useStore.getState().ws.style.preset ?? 'classic');
  const [gapMm, setGapMm] = useState(arrangeGapMm);
  return (
    <div className="isec">
      <h4>{items.length} items selected</h4>
      <AlignButtons sheetId={sheet.id} ids={ids} />
      {plots.length > 0 && (
        <>
          <Field label="Font size (pt)">
            <Num value={plots[0].options.fontSize} min={5} max={24} step={0.5} ariaLabel="Font size for selected plots" onChange={(v) => useStore.getState().update((w) => {
              const sh = w.worksheets.find((s) => s.id === sheet.id)!;
              for (const it of sh.items) if (ids.includes(it.id) && it.kind === 'plot') it.options.fontSize = v;
            })} />
          </Field>
          <Field label="Style preset" title="Changes only the look, never channels, gates, scales or smoothing">
            <Sel value={preset} ariaLabel="Style preset" options={PRESET_OPTIONS} onChange={setPreset} />
          </Field>
          <div className="row" style={{ marginBottom: 8, justifyContent: 'flex-end' }}>
            <button className="btn sm" onClick={() => applyPresetTo(sheet.id, ids, preset)}>
              Apply to selected
            </button>
          </div>
        </>
      )}
      <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
        <button className="btn sm" title="Rows and columns in reading order with exactly equal gaps" onClick={() => arrange(sheet.id, ids, 'grid', { gap: gapMm * MM })}>
          <Icon.arrange /> Arrange as grid
        </button>
        <span className="hint">gap</span>
        <span style={{ width: 52, flex: 'none' }}>
          <Num value={gapMm} min={0} max={50} step={0.5} ariaLabel="Gap between grid items (mm)" onChange={(v) => {
            setGapMm(v);
            setArrangeGapMm(v);
          }} />
        </span>
        <span className="hint">mm</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ text / stats

function TextInspector({ item, sheet }: { item: TextItem; sheet: Worksheet }) {
  const up = (f: (t: TextItem) => void) => updItem(sheet.id, item.id, (it) => f(it as TextItem));
  const family = useStore((s) => s.ws.style.fontFamily);
  return (
    <div className="isec">
      <h4>Text</h4>
      <textarea className="inp" style={{ height: 70, resize: 'vertical' }} aria-label="Text" value={item.text} onChange={(e) => {
        const v = e.target.value;
        // one undo step per editing session (focus); see store.update
        updItem(sheet.id, item.id, (it) => {
          (it as TextItem).text = v;
        }, 'txt' + item.id);
      }} onKeyDown={(e) => e.stopPropagation()} />
      <div style={{ height: 6 }} />
      <Field label="Font size (pt)">
        <Num value={item.fontSize} min={5} max={72} step={1} ariaLabel="Font size" onChange={(v) => up((t) => {
          t.fontSize = v;
        })} />
      </Field>
      <Field label="Style">
        <div className="row">
          <Check checked={item.bold} label="Bold" onChange={(v) => up((t) => {
            t.bold = v;
          })} />
          <Check checked={item.italic} label="Italic" onChange={(v) => up((t) => {
            t.italic = v;
          })} />
        </div>
      </Field>
      <Field label="Align">
        <Seg value={item.align} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} onChange={(v) => up((t) => {
          t.align = v;
        })} />
      </Field>
      <Field label="Color">
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <ColorIn value={item.color || autoTextColor(sheet)} ariaLabel="Text color" onChange={(v) => up((t) => {
            t.color = v;
          })} />
          <Check checked={!item.color} label="From the page" onChange={(v) => up((t) => {
            t.color = v ? '' : autoTextColor(sheet);
          })} />
        </div>
      </Field>
      {pageIsDark(sheet) && item.color && luminance(item.color) < 0.18 && <p className="hint">Dark text on a dark page: choose a light color or "From the page".</p>}
      {textOverflows(item, family) && (
        <div className="row" style={{ marginTop: 6, flexWrap: 'nowrap', gap: 6 }}>
          <p className="hint" style={{ margin: 0, color: 'var(--warn-text)' }}>The text does not fit the box height set by hand (cut in exports).</p>
          <button className="btn sm" title="Make the box as tall as its text; it grows with the text again" onClick={() => up((t) => {
            const need = Math.ceil((textNeedH(t, family) + 1) * 10) / 10;
            if (need > t.h) t.h = need;
            delete t.hFixed;
          })}>Fit height to text</button>
        </div>
      )}
    </div>
  );
}

function StatsInspector({ item, sheet, ws }: { item: StatsBoxItem; sheet: Worksheet; ws: Workspace }) {
  const up = (f: (t: StatsBoxItem) => void, key?: string) => updItem(sheet.id, item.id, (it) => f(it as StatsBoxItem), key);
  const chans = allChannels(ws).map((c) => ({ value: c.name, label: channelDisplayName(ws, c.name) }));
  const pops = popOptions(ws);
  return (
    <div className="isec">
      <h4>Statistics box</h4>
      <Field label="Sample">
        <Sel value={item.sample} ariaLabel="Sample" options={[{ value: 'active', label: 'Active sample' }, ...ws.samples.map((s) => ({ value: s.id, label: s.name }))]} onChange={(v) => up((t) => {
          t.sample = v;
        })} />
      </Field>
      <Field label="Font size (pt)">
        <Num value={item.fontSize} min={5} max={24} step={0.5} ariaLabel="Font size" onChange={(v) => up((t) => {
          t.fontSize = v;
        })} />
      </Field>
      <BackgroundField what="Box" value={item} set={up} colorKey={'bgc' + item.id} />
      {item.rows.map((r, i) => (
        <div key={r.id} className="layer" style={{ gridTemplateColumns: '1fr 22px' }}>
          <Sel value={r.population} options={pops} ariaLabel="Population" onChange={(v) => up((t) => {
            t.rows[i].population = v;
            if (t.rows[i].ofPopulation) t.rows[i].ofPopulation = validOfPopulation(ws, v, t.rows[i].ofPopulation);
          })} />
          <button className="icon-btn danger" aria-label="Remove row" title="Remove this statistic" onClick={() => up((t) => {
            t.rows.splice(i, 1);
          })}>
            <Icon.close />
          </button>
          <Sel value={r.stat} ariaLabel="Statistic" options={(Object.keys(STAT_LABELS) as StatKind[]).map((k) => ({ value: k, label: STAT_LABELS[k] }))} onChange={(v) => up((t) => {
            t.rows[i].stat = v;
            if (STAT_NEEDS_CHANNEL[v] && !t.rows[i].channel) t.rows[i].channel = chans[0]?.value;
          })} />
          <span />
          {STAT_NEEDS_CHANNEL[r.stat] && (
            <ChannelPicker value={r.channel ?? chans[0]?.value ?? ''} samples={item.sample === 'active' ? undefined : [item.sample]} ariaLabel="Channel" onChange={(v) => up((t) => {
              t.rows[i].channel = v;
            })} />
          )}
          {r.stat === 'freqOf' && (
            <Sel value={validOfPopulation(ws, r.population, r.ofPopulation)} options={ancestorOptions(ws, r.population)} ariaLabel="Reference population" onChange={(v) => up((t) => {
              t.rows[i].ofPopulation = v;
            })} />
          )}
        </div>
      ))}
      <button className="btn sm" onClick={() => up((t) => {
        t.rows.push({ id: uid('row'), population: useStore.getState().ui.selectedPopId ?? 'root', stat: 'freqParent' });
      })}>
        <Icon.plus /> Add statistic
      </button>
    </div>
  );
}

function ChartInspector({ item, sheet, ws }: { item: ChartItem; sheet: Worksheet; ws: Workspace }) {
  const up = (f: (t: ChartItem) => void, key?: string) => updItem(sheet.id, item.id, (it) => f(it as ChartItem), key);
  const chans = allChannels(ws).map((c) => ({ value: c.name, label: channelDisplayName(ws, c.name) }));
  const pops = popOptions(ws);
  const c = item.stat;
  return (
    <>
      <div className="isec">
        <h4>Statistic chart</h4>
        <Field label="Population">
          <Sel value={c.population} options={pops} ariaLabel="Population" onChange={(v) => up((t) => {
            t.stat.population = v;
            if (t.stat.ofPopulation) t.stat.ofPopulation = validOfPopulation(ws, v, t.stat.ofPopulation);
          })} />
        </Field>
        <Field label="Statistic">
          <Sel value={c.stat} ariaLabel="Statistic" options={(Object.keys(STAT_LABELS) as StatKind[]).map((k) => ({ value: k, label: STAT_LABELS[k] }))} onChange={(v) => up((t) => {
            t.stat.stat = v;
            if (STAT_NEEDS_CHANNEL[v] && !t.stat.channel) t.stat.channel = chans.find((x) => !/FSC|SSC|Time/i.test(x.value))?.value ?? chans[0]?.value;
          })} />
        </Field>
        {STAT_NEEDS_CHANNEL[c.stat] && (
          <Field label="Parameter">
            <ChannelPicker value={c.channel ?? chans[0]?.value ?? ''} ariaLabel="Parameter" onChange={(v) => up((t) => {
              t.stat.channel = v;
            })} />
          </Field>
        )}
        {c.stat === 'freqOf' && (
          <Field label="% of">
            <Sel value={validOfPopulation(ws, c.population, c.ofPopulation)} options={ancestorOptions(ws, c.population)} ariaLabel="Reference population" onChange={(v) => up((t) => {
              t.stat.ofPopulation = v;
            })} />
          </Field>
        )}
        <Field label="Compare">
          <Seg value={item.mode} options={[{ value: 'samples', label: 'Samples' }, { value: 'groups', label: 'Groups' }]} onChange={(v) => up((t) => {
            t.mode = v;
          })} />
        </Field>
        {item.mode === 'samples' && (ws.groups.length > 0 || !!item.samples) && (
          <Field label="Samples" title={item.samples ? 'The samples fixed when the chart was made; choose a set to follow it instead (files loaded later are added)' : undefined}>
            <Sel
              value={item.samples ? 'fixed' : item.sampleSet}
              ariaLabel="Sample set"
              options={[
                ...(item.samples ? [{ value: 'fixed', label: `Samples at creation (${item.samples.length})` }] : []),
                { value: 'all', label: 'All samples' },
                ...ws.groups.map((g) => ({ value: g.id, label: g.name })),
              ]}
              onChange={(v) => v !== 'fixed' && up((t) => {
                t.sampleSet = v;
                delete t.samples;
              })}
            />
          </Field>
        )}
        {item.mode === 'groups' && !ws.groups.length && <p className="hint">Create groups in the sample list (right-click → Create group) to compare conditions.</p>}
        <Field label="Style">
          <Seg value={item.style} options={[{ value: 'bar', label: 'Bars' }, { value: 'dot', label: 'Dots + mean' }]} onChange={(v) => up((t) => {
            t.style = v;
          })} />
        </Field>
        {item.mode === 'groups' && (
          <>
            <Field label="Error bars">
              <Seg value={item.errorBars} options={[{ value: 'sd', label: 'SD' }, { value: 'sem', label: 'SEM' }, { value: 'none', label: 'None' }]} onChange={(v) => up((t) => {
                t.errorBars = v;
              })} />
            </Field>
            <Check checked={item.showPoints} label="Show individual samples" onChange={(v) => up((t) => {
              t.showPoints = v;
            })} />
          </>
        )}
        <Field label="Color">
          <ColorIn value={item.color} onChange={(v) => up((t) => {
            t.color = v;
          }, 'cc' + item.id)} />
        </Field>
        <Check checked={item.useGroupColors} label={item.mode === 'groups' ? 'Use group colors' : 'Use sample colors'} onChange={(v) => up((t) => {
          t.useGroupColors = v;
        })} />
      </div>
      <div className="isec">
        <h4>Text &amp; axis</h4>
        <Field label="Title">
          <Txt value={item.title ?? ''} placeholder="Automatic" ariaLabel="Title" onChange={(v) => up((t) => {
            t.title = v || undefined;
          })} />
        </Field>
        <Field label="Y axis label">
          <Txt value={item.yLabel ?? ''} placeholder="Automatic" ariaLabel="Y axis label" onChange={(v) => up((t) => {
            t.yLabel = v || undefined;
          })} />
        </Field>
        <Field label="Y maximum">
          <Num value={item.yMax ?? NaN} min={0} ariaLabel="Y maximum" onChange={(v) => up((t) => {
            t.yMax = v > 0 ? v : undefined;
          })} />
        </Field>
        <Field label="Font size (pt)">
          <Num value={item.fontSize} min={5} max={24} step={0.5} ariaLabel="Font size" onChange={(v) => up((t) => {
            t.fontSize = v;
          })} />
        </Field>
        <BackgroundField what="Chart" value={item} set={up} colorKey={'bgc' + item.id} />
      </div>
    </>
  );
}

/** A plate heatmap: plate, statistic, colors, range, values. */
function PlateChartInspector({ item, sheet, ws }: { item: PlateChartItem; sheet: Worksheet; ws: Workspace }) {
  const up = (f: (t: PlateChartItem) => void, key?: string) => updItem(sheet.id, item.id, (it) => f(it as PlateChartItem), key);
  const chans = allChannels(ws).map((c) => ({ value: c.name, label: channelDisplayName(ws, c.name) }));
  const pops = popOptions(ws);
  const c = item.stat;
  const d = item.plate;
  const plates = layoutOf(ws, engine).plates;
  const plate = plates.find((p) => p.name === d.plate);
  // the automatic range (shown as the starting values of a fixed one)
  const auto = plate ? cellRange([plateCells(plate, (sid) => plateStatValue(ws, engine, sid, c, true)).cells]) : null;
  return (
    <>
      <div className="isec">
        <h4>Plate heatmap</h4>
        <Field label="Plate">
          <Sel
            value={d.plate}
            ariaLabel="Plate"
            options={[...(plate ? [] : [{ value: d.plate, label: `${d.plate} (not found)` }]), ...plates.map((p) => ({ value: p.name, label: p.name }))]}
            onChange={(v) => up((t) => {
              t.plate.plate = v;
            })}
          />
        </Field>
        <Field label="Population">
          <Sel value={c.population} options={pops} ariaLabel="Population" onChange={(v) => up((t) => {
            t.stat.population = v;
            if (t.stat.ofPopulation) t.stat.ofPopulation = validOfPopulation(ws, v, t.stat.ofPopulation);
          })} />
        </Field>
        <Field label="Statistic">
          <Sel value={c.stat} ariaLabel="Statistic" options={(Object.keys(STAT_LABELS) as StatKind[]).map((k) => ({ value: k, label: STAT_LABELS[k] }))} onChange={(v) => up((t) => {
            t.stat.stat = v;
            if (STAT_NEEDS_CHANNEL[v] && !t.stat.channel) t.stat.channel = chans.find((x) => !/FSC|SSC|Time/i.test(x.value))?.value ?? chans[0]?.value;
          })} />
        </Field>
        {STAT_NEEDS_CHANNEL[c.stat] && (
          <Field label="Parameter">
            <ChannelPicker value={c.channel ?? chans[0]?.value ?? ''} ariaLabel="Parameter" onChange={(v) => up((t) => {
              t.stat.channel = v;
            })} />
          </Field>
        )}
        {c.stat === 'freqOf' && (
          <Field label="% of">
            <Sel value={validOfPopulation(ws, c.population, c.ofPopulation)} options={ancestorOptions(ws, c.population)} ariaLabel="Reference population" onChange={(v) => up((t) => {
              t.stat.ofPopulation = v;
            })} />
          </Field>
        )}
        <Field label="Colors">
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <CmapPicker spec={{ name: d.colormap, reverse: d.reverse }} onChange={(n) => up((t) => {
              t.plate.colormap = n;
            })} />
            <Check checked={!!d.reverse} label="Reverse" onChange={(v) => up((t) => {
              if (v) t.plate.reverse = true;
              else delete t.plate.reverse;
            })} />
          </div>
        </Field>
        <Field label="Range">
          <Seg
            value={d.range ? 'fixed' : d.shared ? 'shared' : 'auto'}
            options={[
              { value: 'auto', label: 'This plate', title: 'Automatic: from the values of this plate' },
              { value: 'shared', label: 'All plates', title: 'Automatic: from the values of all plates (heatmaps of several plates compare)' },
              { value: 'fixed', label: 'Fixed' },
            ]}
            onChange={(v) => up((t) => {
              if (v === 'fixed') t.plate.range = auto ? [Number(auto[0].toPrecision(3)), Number(auto[1].toPrecision(3))] : [0, 100];
              else delete t.plate.range;
              if (v === 'shared') t.plate.shared = true;
              else delete t.plate.shared;
            })}
          />
        </Field>
        {d.range && (
          <Field label="Min / max">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <Num value={d.range[0]} ariaLabel="Range minimum" onChange={(v) => up((t) => {
                const r = t.plate.range;
                if (r && v !== r[1]) t.plate.range = [Math.min(v, r[1]), Math.max(v, r[1])];
              })} />
              <Num value={d.range[1]} ariaLabel="Range maximum" onChange={(v) => up((t) => {
                const r = t.plate.range;
                if (r && v !== r[0]) t.plate.range = [Math.min(v, r[0]), Math.max(v, r[0])];
              })} />
            </div>
          </Field>
        )}
        <Check checked={d.values} label="Values in the wells" onChange={(v) => up((t) => {
          t.plate.values = v;
        })} />
        <Field label="Decimals">
          <Num value={d.decimals} min={0} max={6} step={1} ariaLabel="Decimals" onChange={(v) => up((t) => {
            t.plate.decimals = Math.round(v);
          })} />
        </Field>
        <Check checked={d.legend} label="Color scale" onChange={(v) => up((t) => {
          t.plate.legend = v;
        })} />
      </div>
      <div className="isec">
        <h4>Text</h4>
        <Field label="Title">
          <Txt value={item.title ?? ''} placeholder="Automatic" ariaLabel="Title" onChange={(v) => up((t) => {
            t.title = v || undefined;
          })} />
        </Field>
        <Field label="Font size (pt)">
          <Num value={item.fontSize} min={5} max={24} step={0.5} ariaLabel="Font size" onChange={(v) => up((t) => {
            t.fontSize = v;
          })} />
        </Field>
        <BackgroundField what="Chart" value={item} set={up} colorKey={'bgc' + item.id} />
      </div>
    </>
  );
}

/** A calibration panel (bead fit, size curve, MESF regression): its text and look; the data are fixed when added. */
function CalibInspector({ item, sheet }: { item: CalibChartItem; sheet: Worksheet }) {
  const up = (f: (t: CalibChartItem) => void, key?: string) => updItem(sheet.id, item.id, (it) => f(it as CalibChartItem), key);
  const c = item.calib;
  return (
    <div className="isec">
      <h4>Calibration panel</h4>
      <p className="hint" style={{ marginTop: 0 }}>
        {c.source ?? 'Calibration'}: the data are those of the calibration when the panel was added. After changing the calibration, add the panel again from the Calibration view.
      </p>
      <Field label="Title">
        <Txt value={c.title} placeholder="No title" ariaLabel="Title" onChange={(v) => up((t) => {
          t.calib.title = v;
        })} />
      </Field>
      <Field label="X axis label">
        <Txt value={c.x.title} ariaLabel="X axis label" onChange={(v) => up((t) => {
          t.calib.x.title = v;
        })} />
      </Field>
      <Field label="Y axis label">
        <Txt value={c.y.title} ariaLabel="Y axis label" onChange={(v) => up((t) => {
          t.calib.y.title = v;
        })} />
      </Field>
      <Check checked={(c.notes ?? []).length > 0} label="Show the fit results in the panel" onChange={(v) => up((t) => {
        const tt = t.calib as typeof t.calib & { hiddenNotes?: string[] };
        if (v) {
          tt.notes = tt.hiddenNotes ?? tt.notes ?? [];
          delete tt.hiddenNotes;
        } else {
          tt.hiddenNotes = tt.notes ?? [];
          tt.notes = [];
        }
      })} />
      <div className="pair">
        <Field label="Font pt">
          <Num value={item.fontSize} min={5} max={24} step={0.5} ariaLabel="Font size" onChange={(v) => up((t) => {
            t.fontSize = v;
          })} />
        </Field>
        <Field label="Line pt">
          <Num value={item.lineWidth} min={0.25} max={4} step={0.25} ariaLabel="Axis line width" onChange={(v) => up((t) => {
            t.lineWidth = v;
          })} />
        </Field>
      </div>
      <BackgroundField what="Panel" value={item} set={up} colorKey={'bgc' + item.id} />
    </div>
  );
}

// ------------------------------------------------------------------ population

function gateSummary(g: GateGeom): string {
  const f = (v: number) => (Number.isFinite(v) ? formatLinear(v, Math.abs(v) / 100 || 1) : v > 0 ? '+∞' : '-∞');
  switch (g.type) {
    case 'polygon':
      return `Polygon, ${g.points.length} vertices`;
    case 'rect':
      return `Rectangle ${f(g.xmin)}..${f(g.xmax)} × ${f(g.ymin)}..${f(g.ymax)}`;
    case 'ellipse':
      return 'Ellipse';
    case 'quadrant':
      return `Quadrant ${g.quadrant} at (${f(g.cx)}, ${f(g.cy)})`;
    case 'range':
      return `Range ${f(g.min)}..${f(g.max)}`;
    case 'split':
      return `Split at ${f(g.cut)} (${g.side === 'hi' ? 'upper' : 'lower'})`;
    case 'bool':
      return `Boolean ${g.op.toUpperCase()}`;
  }
}

function PopulationInspector({ pop, ws, sampleId, sheet }: { pop: Population; ws: Workspace; sampleId: string | null; sheet: Worksheet }) {
  const st = useStore.getState();
  const has = sampleId && engine.has(sampleId);
  // out of scope (another group's gate) or gated on a channel the sample lacks: n/a, not 0 events
  const naWhy = has ? engine.notApplicableReason(ws, sampleId!, pop.id) : null;
  // the scope may be set on an ancestor (a group-specific gating tree)
  const owner = scopeOwner(ws, pop.id);
  // not waiting for background computations (gates on unmixed channels): NaN shows as "computing" below
  const n0 = has ? engine.countForDisplay(ws, sampleId!, pop.id) : NaN;
  const pn0 = has ? engine.countForDisplay(ws, sampleId!, pop.parentId ?? 'root') : NaN;
  const computing = n0 === null || pn0 === null;
  const n = n0 ?? NaN;
  const pn = pn0 ?? NaN;
  const tot = has ? engine.eventCount(sampleId!) : NaN;
  const override = sampleId ? pop.overrides?.[sampleId] : undefined;
  const sName = ws.samples.find((s) => s.id === sampleId)?.name ?? '';
  const upPop = (f: (p: Population) => void, key?: string) =>
    st.update((w) => {
      const p = w.populations.find((x) => x.id === pop.id);
      if (p) f(p as Population);
    }, key);
  // quadrant / split regions share one geometry: per-sample variants are made and removed for the whole group
  const pg = pop.gate;
  const grouped = pg.type === 'quadrant' || pg.type === 'split';
  const groupIds = grouped
    ? ws.populations.filter((p) => p.parentId === pop.parentId && p.gate.type === pg.type && (p.gate as { groupId: string }).groupId === pg.groupId).map((p) => p.id)
    : [pop.id];
  const upGroup = (f: (p: Population) => void) =>
    st.update((w) => {
      for (const p of w.populations) if (groupIds.includes(p.id)) f(p as Population);
    });
  return (
    <div className="isec" style={{ background: 'var(--panel-alt)' }}>
      <h4>Population</h4>
      <Field label="Name">
        <Txt value={pop.name} ariaLabel="Population name" onChange={(v) => v.trim() && upPop((p) => {
          p.name = v.trim();
        })} />
      </Field>
      <Field label="Color">
        <ColorIn value={pop.color} onChange={(v) => upPop((p) => {
          p.color = v;
        }, 'pc' + pop.id)} />
      </Field>
      <div className="hint" style={{ marginBottom: 6 }}>
        {popPath(ws, pop.id)}
        <br />
        {gateSummary(override ?? pop.gate)}
        <br />
        Applies to: {scopeLabel(ws, owner?.scope)}
        {owner && owner.id !== pop.id && ` (set on '${owner.name}')`}
      </div>
      {has && naWhy && (
        <table className="data" style={{ width: '100%', marginBottom: 8 }}>
          <tbody>
            <tr>
              <td className="left">Events</td>
              <td title={`Not applicable: ${naWhy}`}>n/a</td>
            </tr>
            <tr>
              <td className="left hint" colSpan={2} style={{ whiteSpace: 'normal' }}>
                Not applicable to {sName}: {naWhy}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {has && !naWhy && (
        <table className="data" style={{ width: '100%', marginBottom: 8 }}>
          <tbody>
            <tr>
              <td className="left">Events</td>
              <td>{computing ? 'computing…' : n.toLocaleString('en-US')}</td>
            </tr>
            <tr>
              <td className="left">% of parent</td>
              <td>{computing ? '…' : pn ? ((100 * n) / pn).toFixed(2) : '–'}</td>
            </tr>
            <tr>
              <td className="left">% of total</td>
              <td>{computing ? '…' : tot ? ((100 * n) / tot).toFixed(2) : '–'}</td>
            </tr>
          </tbody>
        </table>
      )}
      {sampleId && pop.gate.type !== 'bool' && (
        <div style={{ marginBottom: 8 }}>
          {override ? (
            <>
              <div className="hint">
                {grouped ? `This ${pop.gate.type} gate (all ${groupIds.length} regions)` : 'This gate'} is adjusted for {sName} only.
              </div>
              <button className="btn sm" onClick={() => upGroup((p) => {
                if (p.overrides) delete p.overrides[sampleId];
                if (p.overrides && !Object.keys(p.overrides).length) delete p.overrides;
              })}>Use shared gate again</button>
            </>
          ) : naWhy ? null : (
            <button
              className="btn sm"
              title={grouped ? `Create a copy of this ${pop.gate.type} gate (all its regions together) that only applies to the active sample` : 'Create a copy of this gate that only applies to the active sample'}
              onClick={() => {
                // structuredClone keeps open (±Infinity) gate bounds; JSON would turn them into null (clone the committed
                // gates: immer drafts cannot be cloned)
                const gates = new Map(ws.populations.filter((p) => groupIds.includes(p.id)).map((p) => [p.id, structuredClone(p.gate)]));
                upGroup((p) => {
                  if (!p.overrides?.[sampleId]) p.overrides = { ...(p.overrides ?? {}), [sampleId]: gates.get(p.id)! };
                });
              }}
            >
              Adjust for {sName.length > 18 ? 'this sample' : sName} only
            </button>
          )}
        </div>
      )}
      <div className="row">
        <button className="btn sm" title="New plot of this population at a free place on the worksheet, on the axes of its next gate" onClick={() => {
          const spec = populationPlotSpec(ws, pop.id);
          addPlotAt(sheet.id, (px, py, w, h) => newPlotItem(spec.type, spec.x, spec.y, px, py, w, h, pop.id));
        }}>New plot</button>
        <button className="btn sm" onClick={() => st.setUI({ dialog: { kind: 'exportPop', payload: { popId: pop.id } } })}>Export events…</button>
        <button className="btn sm" style={{ color: 'var(--danger)' }} onClick={() => deletePopulation(pop.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ sheet

/** Figure fonts: only families whose metrics we bundle (src/render/fonts), so screen, SVG and PDF lay out alike. */
const FONT_CHOICES = [
  'Arial, Helvetica, sans-serif',
  'Helvetica, Arial, sans-serif',
  "'Times New Roman', Times, serif",
  'Calibri, Carlito, Arial, sans-serif',
];
const fontLabel = (f: string) => f.split(',')[0].replace(/['"]/g, '').trim();

/** Page sizes: the journal and paper sizes of the model plus true slide sizes (16:9, 4:3). */
const SIZES: Record<string, { w: number; h: number }> = { ...PAGE_SIZES, ...SLIDE_SIZES };
/** Offered only to sheets that already use them ("Screen (wide)" is 1.56:1, not a slide format). */
const HIDDEN_SIZES = new Set(['Screen (wide)']);
/** Font options; a family from an older workspace that is no longer offered stays selectable until changed. */
const fontOptions = (cur: string) => [
  ...FONT_CHOICES.map((f) => ({ value: f, label: fontLabel(f) })),
  ...(FONT_CHOICES.includes(cur) ? [] : [{ value: cur, label: `${fontLabel(cur)} (custom)` }]),
];

function SheetInspector({ sheet, ws }: { sheet: Worksheet; ws: Workspace }) {
  const st = useStore.getState();
  const outside = itemsOutsidePage(sheet);
  const content = contentBox(sheet.items);
  const wantW = ws.style.plotW ?? 60;
  const wantH = ws.style.plotH ?? 54;
  // on a dark page: items with an opaque background of their own (gray / white boxes)
  const boxed = pageIsDark(sheet) ? sheet.items.filter((it) => (it.kind === 'plot' ? it.options.bg : it.kind === 'chart' || it.kind === 'stats' ? it.bg : undefined) && (it.kind === 'plot' ? it.options.bg : (it as { bg?: string }).bg) !== 'transparent') : [];
  const upSheet = (f: (s: Worksheet) => void) => st.update((w) => {
    const s = w.worksheets.find((x) => x.id === sheet.id);
    if (s) f(s as Worksheet);
  });
  return (
    <>
      <div className="isec">
        <h4>Worksheet</h4>
        <Field label="Name">
          <Txt value={sheet.name} ariaLabel="Sheet name" onChange={(v) => upSheet((s) => {
            s.name = v || s.name;
          })} />
        </Field>
        <Field label="Page">
          <Sel value={SIZES[sheet.page.name] ? sheet.page.name : 'custom'} ariaLabel="Page size" options={[...Object.keys(SIZES).filter((k) => !HIDDEN_SIZES.has(k) || k === sheet.page.name).map((k) => ({ value: k, label: k })), { value: 'custom', label: 'Custom' }]} onChange={(v) => {
            if (!SIZES[v]) return upSheet((s) => {
              s.page = { ...s.page, name: 'custom' };
            });
            const page = { ...SIZES[v], name: v };
            // a smaller page than the layout: ask how the layout should follow
            if (itemsOutsidePage({ ...sheet, page }).length > itemsOutsidePage(sheet).length) st.setUI({ dialog: { kind: 'pageFit', payload: { sheetId: sheet.id, page } } });
            else upSheet((s) => {
              s.page = page;
            });
          }} />
        </Field>
        {!SIZES[sheet.page.name] && (
          <div className="pair">
            <Field label="W (mm)">
              <Num value={Math.round(sheet.page.w / MM)} min={20} max={2000} ariaLabel="Page width" onChange={(v) => upSheet((s) => {
                s.page.w = v * MM;
              })} />
            </Field>
            <Field label="H (mm)">
              <Num value={Math.round(sheet.page.h / MM)} min={20} max={2000} ariaLabel="Page height" onChange={(v) => upSheet((s) => {
                s.page.h = v * MM;
              })} />
            </Field>
          </div>
        )}
        {outside.length > 0 && (
          <div className="note-box warn">
            {outside.length} item{outside.length === 1 ? ' lies' : 's lie'} outside the page{content ? ` (layout ${Math.round(content.w / MM)} x ${Math.round(content.h / MM)} mm)` : ''}. Exports ask whether to include {outside.length === 1 ? 'it' : 'them'}.
            <button className="btn sm" onClick={() => st.setUI({ dialog: { kind: 'pageFit', payload: { sheetId: sheet.id, page: { ...sheet.page } } } })}>
              Fit layout to page…
            </button>
          </div>
        )}
        <div className="row" style={{ marginBottom: 6, justifyContent: 'flex-end' }}>
          <button className="btn sm" disabled={!sheet.items.length} title="Make the page exactly as large as the items on it, plus a 2 mm margin (the items move to that margin)" onClick={() => fitPageToContent(sheet.id, 2)}>
            Fit page to content
          </button>
        </div>
        <Field label="Page color">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <ColorIn value={sheet.pageColor ?? '#ffffff'} ariaLabel="Page color" onChange={(v) => upSheet((s) => {
              s.pageColor = v.toLowerCase() === '#ffffff' ? undefined : v;
            })} />
            <Check checked={sheet.exportPage !== false} label="In exports" onChange={(v) => upSheet((s) => {
              s.exportPage = v ? undefined : false;
            })} />
          </div>
        </Field>
        <Field label="Font size for this sheet" title="The figure font size of this sheet (new plots and text, Font to all items). Unset: the workspace figure style below">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <Num value={sheet.fontSize ?? ws.style.fontSize} min={5} max={40} step={0.5} ariaLabel="Font size for this sheet (pt)" onChange={(v) => upSheet((s) => {
              s.fontSize = v;
            })} />
            <Check checked={sheet.fontSize === undefined} label="Use workspace default" onChange={(v) => upSheet((s) => {
              if (v) delete s.fontSize;
              else s.fontSize = ws.style.fontSize;
            })} />
          </div>
        </Field>
        {boxed.length > 0 && (
          <div className="note-box" role="status">
            {boxed.length} item{boxed.length === 1 ? ' has its own background and shows' : 's have their own background and show'} as {boxed.length === 1 ? 'a box' : 'boxes'} on this dark page.
            <button className="btn sm" onClick={() => upSheet((s) => {
              for (const it of s.items) {
                if (it.kind === 'plot' && it.options.bg && it.options.bg !== 'transparent') delete it.options.bg;
                else if ((it.kind === 'chart' || it.kind === 'stats') && it.bg && it.bg !== 'transparent') delete it.bg;
              }
            })}>Use the page as background</button>
          </div>
        )}
        <Sub>Grid</Sub>
        <Field label="Show">
          <Seg value={sheetGridStyle(sheet)} options={[{ value: 'lines', label: 'Lines' }, { value: 'dots', label: 'Dots' }, { value: 'none', label: 'Blank' }]} onChange={(v) => upSheet((s) => setGridStyle(s, v))} />
        </Field>
        <Field label="Size">
          <Sel value={String(Math.round((sheet.grid / MM) * 10) / 10)} ariaLabel="Grid size" options={['1', '2', '2.5', '5', '10'].map((v) => ({ value: v, label: v + ' mm' }))} onChange={(v) => upSheet((s) => {
            s.grid = Number(v) * MM;
          })} />
        </Field>
        {sheetGridStyle(sheet) !== 'none' && (
          <>
            <Field label="Major every">
              <Sel value={String(sheet.gridMajor ?? 0)} ariaLabel="Major grid lines" options={['0', '2', '4', '5', '10'].map((v) => ({ value: v, label: v === '0' ? 'None' : `${v} cells` }))} onChange={(v) => upSheet((s) => {
                s.gridMajor = Number(v) || undefined;
              })} />
            </Field>
            <Field label="Color">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <ColorIn value={sheet.gridColor ?? DEFAULT_GRID_COLOR} ariaLabel="Grid color" onChange={(v) => upSheet((s) => {
                  s.gridColor = v;
                })} />
                <Num value={Math.round(sheetGridOpacity(sheet) * 100)} min={2} max={100} step={5} ariaLabel="Grid opacity (%)" onChange={(v) => upSheet((s) => {
                  s.gridOpacity = v / 100;
                })} />
                <span className="hint">%</span>
              </div>
            </Field>
          </>
        )}
        <Check checked={sheet.snap} label="Snap to grid" onChange={(v) => upSheet((s) => {
          s.snap = v;
        })} />
        <Check checked={!!sheet.exportGrid} label="Include grid in exports" onChange={(v) => upSheet((s) => {
          s.exportGrid = v || undefined;
        })} />
        <p className="hint">The grid is an editing aid: it is not exported unless included above. Snapping works with the grid hidden too.</p>
      </div>
      <div className="isec">
        <h4>Figure style</h4>
        <Field label="Font">
          <Sel value={ws.style.fontFamily} ariaLabel="Font of the figure style" options={fontOptions(ws.style.fontFamily)} onChange={(v) => st.update((w) => {
            w.style.fontFamily = v;
          })} />
        </Field>
        <Field label="Font size (pt)" title="Used for new plots on sheets without a font size of their own (Worksheet: Font size for this sheet)">
          <Num value={ws.style.fontSize} min={5} max={16} step={0.5} ariaLabel="Font size (pt) of the figure style" onChange={(v) => st.update((w) => {
            w.style.fontSize = v;
          })} />
        </Field>
        <div className="pair">
          <Field label="Plot W (mm)">
            <Num value={wantW} min={20} max={200} step={1} ariaLabel="Plot W (mm): width of new plots" onChange={(v) => st.update((w) => {
              w.style.plotW = v;
            })} />
          </Field>
          <Field label="Plot H (mm)">
            <Num value={wantH} min={20} max={200} step={1} ariaLabel="Plot H (mm): height of new plots" onChange={(v) => st.update((w) => {
              w.style.plotH = v;
            })} />
          </Field>
        </div>
        <Field label="New plots" title="Style preset for new plots (appearance only)">
          <Sel value={ws.style.preset ?? ''} ariaLabel="Default style for new plots" options={[{ value: '', label: 'Default look' }, ...PRESET_OPTIONS]} onChange={(v) => st.update((w) => {
            w.style.preset = v || undefined;
          })} />
        </Field>
        {ws.style.preset && (
          <div className="row" style={{ marginBottom: 6, justifyContent: 'flex-end' }}>
            <button className="btn sm" onClick={() => applyPresetTo(sheet.id, 'all', ws.style.preset!)}>Apply to all plots on sheet</button>
          </div>
        )}
        <div className="row" style={{ marginBottom: 6 }}>
          <button className="btn sm" title="Apply the font size of this sheet (its own, else the figure style) to every plot, chart, statistics box and text on it (panel letters: body + 2 pt)" onClick={() => st.update((w) => {
            const sh = w.worksheets.find((x) => x.id === sheet.id)!;
            const fs = bodyPt(w, sh);
            for (const it of sh.items) {
              if (it.kind === 'plot') it.options.fontSize = fs;
              else if (it.kind === 'chart' || it.kind === 'stats') it.fontSize = fs;
              else if (it.kind === 'text') it.fontSize = (it as { tag?: string }).tag === 'panelLabel' ? Math.max(fs, Math.min(9, fs + 2)) : fs;
            }
          })}>Font to all items</button>
          <button className="btn sm" title={`Resize every plot on this sheet to ${wantW} x ${wantH} mm`} onClick={() => {
            // the exact size set above (not snapped to the grid)
            const W = wantW * MM;
            const H = wantH * MM;
            st.update((w) => {
              for (const it of w.worksheets.find((x) => x.id === sheet.id)!.items) if (it.kind === 'plot') {
                it.w = W;
                it.h = H;
              }
            });
          }}>Size to all plots</button>
        </div>
        <p className="hint">Arial / Helvetica are accepted by most journals; 6–8 pt at final size is typical. Exported SVG and PDF keep text editable.</p>
      </div>
      <div className="isec row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => st.setUI({ dialog: { kind: 'guide' } })} title="A one-page overview: loading, gating, statistics, figures, saving">
          <Icon.help /> Getting started
        </button>
        <button className="btn sm" onClick={() => st.setUI({ dialog: { kind: 'shortcuts' } })} title="All keyboard shortcuts (? or F1)">
          Keyboard shortcuts
        </button>
      </div>
    </>
  );
}
