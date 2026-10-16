// Plates in the interface: the sample panel's plate view (wells select samples like the list), the Plates document
// view (heatmap of a statistic over all plates, plate layouts, export) and the "Set well" dialog.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../core/engine';
import { allChannels, channelDisplayName, popPath, STAT_LABELS, STAT_NEEDS_CHANNEL, type StatColumn, type StatKind, type Workspace } from '../core/model';
import {
  allWells,
  annotationGroups,
  annotationKeys,
  cellRange,
  csvText,
  fmtValue,
  fmtWellValue,
  normWell,
  PLATE_FORMATS,
  plateCells,
  plateExportTables,
  rangeT,
  parseWell,
  shortWell,
  statDecimals,
  wellOfSample,
  tubeName,
  type PlateLayout,
  type PlateView,
} from '../core/plate';
import { colormapColor, luminance } from '../render/colormaps';
import { cmapSpecOf, layoutOf, plateStatValue, statShortLabel } from '../render/plateChart';
import {
  addPlateHeatmaps,
  annotateWellValues,
  fillOrder,
  groupsFromAnnotation,
  plateViewSettings,
  redetectWells,
  removeAnnotationKey,
  renamePlate,
  setPlateFormat,
  setWells,
  updatePlateView,
} from '../state/plateOps';
import { newPlotItem, pickDefaultChannels, pickMfiChannel, removeSamples, useStore } from '../state/store';
import { safeName, saveFile } from '../io/files';
import { writeXlsxBook } from '../io/xlsx';
import { ChannelPicker } from './ChannelPicker';
import { Icon } from './icons';
import { addItems, addPlotAt } from './layoutOps';
import { PlateGrid } from './PlateGrid';
import { CmapPicker } from './stylePresets';
import { ancestorOptions, validOfPopulation } from './TablesView';
import { Check, ContextMenu, Field, Modal, Num, Sel, Seg } from './widgets';
import { isPanelShown, useLayout, useShellMode } from './shell';

// ---------------------------------------------------------------- data

/** Plates and wells as shown (re-computed when samples, plates or loaded files change). */
export function usePlateLayout(): PlateLayout {
  const ws = useStore((s) => s.ws);
  useStore((s) => s.ui.dataVersion);
  return layoutOf(ws, engine);
}

// statistic values of the plate view, computed a slice at a time and kept while nothing they depend on changes
const ids = new WeakMap<object, number>();
let nextId = 1;
const objId = (o: unknown) => {
  if (!o || typeof o !== 'object') return 0;
  let v = ids.get(o);
  if (!v) ids.set(o, (v = nextId++));
  return v;
};
const compSig = new WeakMap<object, string>();
function samplesSig(ws: Workspace): string {
  let s = compSig.get(ws.samples);
  if (s === undefined) compSig.set(ws.samples, (s = ws.samples.map((x) => `${x.id}:${x.compId ?? ''}`).join(',')));
  return s;
}
function statSig(ws: Workspace, stat: StatColumn): string {
  return [objId(ws.populations), objId(ws.scales), objId(ws.instrumentScales), objId(ws.compensations), objId(ws.derived), samplesSig(ws), engine.version, stat.population, stat.stat, stat.channel ?? '', stat.percentile ?? '', stat.ofPopulation ?? ''].join('|');
}
const valueCache: { sig: string; values: Map<string, number | null> } = { sig: '', values: new Map() };

/** A value of the plate view's statistic if it is computed already (tooltips of the sample panel's plate). */
export function cachedPlateValue(ws: Workspace, id: string): number | null | undefined {
  if (!ws.plateView || valueCache.sig !== statSig(ws, ws.plateView.stat)) return undefined;
  return valueCache.values.get(id);
}

/**
 * Values of a statistic for samples, computed in slices of ~12 ms (the page stays responsive with hundreds of samples)
 * and cached; `undefined` while not computed yet.
 */
function usePlateValues(ws: Workspace, stat: StatColumn, sampleIds: string[]) {
  const [, force] = useState(0);
  const sig = statSig(ws, stat);
  // another statistic, gating, compensation or data: the values kept go
  if (valueCache.sig !== sig) {
    valueCache.sig = sig;
    valueCache.values = new Map();
  }
  const key = sampleIds.join(',');
  useEffect(() => {
    let stop = false;
    let timer = 0;
    const todo = sampleIds.filter((id) => !valueCache.values.has(id));
    if (!todo.length) return;
    let i = 0;
    const slice = () => {
      if (stop || valueCache.sig !== sig) return;
      const t0 = performance.now();
      while (i < todo.length && performance.now() - t0 < 12) {
        const id = todo[i++];
        const v = plateStatValue(ws, engine, id, stat, true);
        // values waiting for a background computation are asked for again when it is in (engine version changes)
        if (v !== undefined) valueCache.values.set(id, v);
      }
      force((x) => x + 1);
      if (i < todo.length) timer = window.setTimeout(slice, 0);
    };
    timer = window.setTimeout(slice, 0);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [sig, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = sampleIds.filter((id) => valueCache.values.has(id)).length;
  return { valueOf: (id: string) => (valueCache.values.has(id) ? valueCache.values.get(id)! : undefined), done, total: sampleIds.length };
}

const fmtCount = (n: number) => n.toLocaleString('en-US');

/**
 * Cell luminance above which the value is written in black, below in white: black and white have the same contrast
 * there ((L + 0.05) / 0.05 = 1.05 / (L + 0.05) at L ~ 0.18), so either gives the better of the two.
 */
const INK_LUMINANCE = 0.18;

/** A plain number written with thousands separators, as counts elsewhere ("3000.5" -> "3,000.5"); other text as it is. */
function groupThousands(t: string): string {
  const m = /^(-?)(\d{4,})(\.\d+)?$/.exec(t);
  return m ? `${m[1]}${Number(m[2]).toLocaleString('en-US')}${m[3] ?? ''}` : t;
}

/** Tooltip of a well: well, samples (events, file state), the statistic, the layout. */
function wellTip(ws: Workspace, p: PlateView, well: string, extra?: (id: string) => string | null): string {
  const ids = p.wells.get(well) ?? [];
  const lines = [`${shortWell(well)} (${p.name})`];
  if (!ids.length) lines.push('Empty');
  for (const id of ids.slice(0, 4)) {
    const s = ws.samples.find((x) => x.id === id);
    if (!s) continue;
    lines.push(`${s.name}: ${fmtCount(s.eventCount)} events${engine.has(id) ? '' : ' (file not loaded)'}`);
    const x = extra?.(id);
    if (x) lines.push('  ' + x);
  }
  if (ids.length > 4) lines.push(`and ${ids.length - 4} more`);
  const ann = p.def?.annotations?.[well];
  if (ann) for (const [k, v] of Object.entries(ann)) lines.push(`${k}: ${v}`);
  return lines.join('\n');
}

/** Group color of the first sample of a well in a group (its mark). */
function groupColorOf(ws: Workspace, ids: string[]): string | null {
  for (const g of ws.groups) if (g.color && ids.some((id) => g.sampleIds.includes(id))) return g.color;
  return null;
}

/** Show the active sample on the worksheet (Enter / double-click on a well). */
function openActive() {
  const st = useStore.getState();
  if (st.ui.view !== 'sheet') st.setUI({ view: 'sheet' });
  requestAnimationFrame(() => (document.querySelector('.sheet-scroll') as HTMLElement | null)?.focus({ preventScroll: true }));
}

/**
 * Size of an element, followed while it changes; returns a callback ref (the element may be replaced, e.g. when the
 * empty state gives way to the plates).
 */
function useSize(): [(el: HTMLElement | null) => void, { w: number; h: number }] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const on = () => setSize((o) => (o.w === el.clientWidth && o.h === el.clientHeight ? o : { w: el.clientWidth, h: el.clientHeight }));
    on();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size];
}

// ---------------------------------------------------------------- menus shared by both views

function WellMenu({ x, y, plate, well, onClose }: { x: number; y: number; plate: PlateView; well: string | null; onClose: () => void }) {
  const st = useStore.getState();
  const ui = st.ui;
  const ids = well ? plate.wells.get(well) ?? [] : [];
  const sel = ui.selectedSampleIds.length ? ui.selectedSampleIds : ui.activeSampleId ? [ui.activeSampleId] : [];
  const one = sel.length === 1 ? st.ws.samples.find((s) => s.id === sel[0]) : undefined;
  const act = (f: () => void) => () => {
    onClose();
    f();
  };
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      {ids.length > 0 && engine.has(ids[0]) && (
        <button
          onClick={act(() => {
            const s = useStore.getState();
            const sheet = s.ws.worksheets.find((w) => w.id === s.ui.activeSheetId) ?? s.ws.worksheets[0];
            const { fsc, ssc } = pickDefaultChannels(s.ws, { sampleIds: [ids[0]], popId: null });
            if (s.ui.view !== 'sheet') s.setUI({ view: 'sheet' });
            addPlotAt(sheet.id, (px, py, w, h) => newPlotItem('pseudo', fsc, ssc, px, py, w, h, 'root', ids[0]));
          })}
        >
          Add plot to sheet
        </button>
      )}
      {ids.length > 0 && <button onClick={act(() => st.setUI({ dialog: { kind: 'setWell', payload: { sampleIds: sel.length > 1 ? sel : ids } } }))}>Set well…</button>}
      {ids.length > 0 && (
        <button onClick={act(() => setWells((sel.length > 1 ? sel : ids).map((id) => ({ id, plate: plate.name, well: null }))))}>Take off the plate</button>
      )}
      {!ids.length && well && one && (
        <button onClick={act(() => setWells([{ id: one.id, plate: plate.name, well }]))}>
          Put “{one.name.length > 28 ? one.name.slice(0, 27) + '…' : one.name}” here
        </button>
      )}
      {ids.length > 0 && <button onClick={act(() => st.setUI({ dialog: { kind: 'group', payload: { sampleIds: sel.length > 1 ? sel : ids } } }))}>Create group from selection…</button>}
      <hr />
      {ui.view !== 'plate' && <button onClick={act(() => st.setUI({ view: 'plate' }))}>Open the plate view</button>}
      <button onClick={act(() => redetectWells())}>Re-detect wells</button>
      {ids.length > 0 && (
        <>
          <hr />
          <button style={{ color: 'var(--danger)' }} onClick={act(() => removeSamples(sel.length > 1 ? sel : ids))}>
            Remove from workspace
          </button>
        </>
      )}
    </ContextMenu>
  );
}

/** Plate name that turns into a text field on double-click (or the pencil button). */
function PlateName({ plate, editing, setEditing }: { plate: string; editing: boolean; setEditing: (v: boolean) => void }) {
  const [val, setVal] = useState(plate);
  useEffect(() => setVal(plate), [plate, editing]);
  if (!editing)
    return (
      <span className="plate-name" title={`${plate} (double-click to rename)`} onDoubleClick={() => setEditing(true)}>
        {plate}
      </span>
    );
  return (
    <input
      className="inp sm plate-name-in"
      autoFocus
      value={val}
      aria-label="Plate name"
      onFocus={(e) => e.target.select()}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        if (val.trim() && val.trim() !== plate) renamePlate(plate, val);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

const FORMAT_OPTIONS = PLATE_FORMATS.map((f) => ({ value: `${f.rows}x${f.cols}`, label: `${f.wells} wells` }));

function FormatSel({ plate }: { plate: PlateView }) {
  const v = `${plate.rows}x${plate.cols}`;
  // formats too small for the wells used are offered disabled (with the reason)
  let maxR = -1;
  let maxC = -1;
  for (const [w, ids] of plate.wells) {
    const pos = ids.length ? parseWell(w) : null;
    if (pos) {
      maxR = Math.max(maxR, pos.row);
      maxC = Math.max(maxC, pos.col);
    }
  }
  const base = FORMAT_OPTIONS.map((o) => {
    const [r, c] = o.value.split('x').map(Number);
    const fits = maxR < r && maxC < c;
    return fits ? o : { ...o, disabled: true, title: 'Samples are in wells outside this format' };
  });
  const opts = base.some((o) => o.value === v) ? base : [...base, { value: v, label: `${plate.rows} x ${plate.cols}` }];
  return (
    <Sel
      value={v}
      ariaLabel="Plate format"
      options={opts}
      onChange={(x) => {
        const [r, c] = x.split('x').map(Number);
        setPlateFormat(plate.name, { rows: r, cols: c });
      }}
    />
  );
}

// ---------------------------------------------------------------- the sample panel's plate

/** The sample panel in plate mode: a plate selector, the plate, a status line. */
export function PlatePanel() {
  const layout = usePlateLayout();
  const ws = useStore((s) => s.ws);
  const activePlate = useStore((s) => s.ui.activePlate);
  const active = useStore((s) => s.ui.activeSampleId);
  const selIds = useStore((s) => s.ui.selectedSampleIds);
  const filter = useStore((s) => s.ui.sampleFilter);
  const st = useStore.getState();
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; well: string | null } | null>(null);
  const [body, { w: width, h: height }] = useSize();
  // the plate of the active sample is shown when the active sample changes (elsewhere: list, stepping)
  // (undefined at first: the panel opened in plate mode shows the active sample's plate)
  const lastActive = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (active === lastActive.current) return;
    lastActive.current = active;
    const p = layout.plates.find((x) => active && wellOfSample(x, active));
    if (p && p.name !== useStore.getState().ui.activePlate) st.setUI({ activePlate: p.name });
  }, [active, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const plate =
    layout.plates.find((p) => p.name === activePlate) ?? layout.plates.find((p) => !!active && !!wellOfSample(p, active)) ?? layout.plates[0];
  if (!plate)
    return (
      <div className="pane-body plate-pane" ref={body}>
        <div className="empty-note">
          {ws.samples.length ? (
            <>
              No wells found in the sample names or FCS keywords. Names such as <b>A1</b>, <b>B07</b> or <b>Well_C3</b> place samples on a plate; or set
              wells by hand (right-click a sample in the list, <b>Set well…</b>).
              <div style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={() => redetectWells()}>
                  Re-detect wells
                </button>
              </div>
            </>
          ) : (
            <>Open FCS files or a folder of a plate export: samples with a well ID in their name or keywords are placed on the plate.</>
          )}
        </div>
      </div>
    );
  const grp = filter !== 'all' ? ws.groups.find((g) => g.id === filter) : undefined;
  // wells as large as the panel allows (width and height; at least 8 px, then the plate scrolls)
  const byW = Math.floor((width - 16 - 2 * plate.cols) / (plate.cols + 0.75));
  const byH = Math.floor((height - 12 - 22 - 2 * plate.rows) / (plate.rows + 0.75));
  const cell = Math.max(8, Math.min(34, byW, byH));
  const occupied = [...plate.wells.values()].filter((l) => l.length).length;
  const activeWell = active ? wellOfSample(plate, active) : null;
  const activeName = active ? ws.samples.find((s) => s.id === active)?.name : undefined;
  const nSel = plate ? [...plate.wells.values()].flat().filter((id) => (selIds.length ? selIds.includes(id) : id === active)).length : 0;
  const pvStat = ws.plateView?.stat;
  return (
    <>
      <div className="plate-bar">
        {layout.plates.length > 1 ? (
          editing ? (
            <PlateName plate={plate.name} editing setEditing={setEditing} />
          ) : (
            <select
              className="sel plate-sel"
              aria-label="Plate"
              value={plate.name}
              onChange={(e) => st.setUI({ activePlate: e.target.value })}
              onDoubleClick={() => setEditing(true)}
              title="Plate shown (double-click or the pencil to rename)"
            >
              {layout.plates.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          )
        ) : (
          <PlateName plate={plate.name} editing={editing} setEditing={setEditing} />
        )}
        <button className="icon-btn" title="Rename the plate" aria-label="Rename the plate" onClick={() => setEditing(true)}>
          <PencilIcon />
        </button>
        <span className="grow" />
        <button className="icon-btn" title="Open the plate view: heatmap of a statistic, plate layout, export" aria-label="Open the plate view" onClick={() => st.setUI({ view: 'plate' })}>
          <Icon.plate />
        </button>
        <button className="icon-btn" title="More" aria-label="Plate menu" onClick={(e) => setMenu({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 2, well: null })}>
          <MoreIcon />
        </button>
      </div>
      <div className="pane-body plate-pane" ref={body} aria-label="Plate">
        {width > 0 && (
          <PlateGrid
            plate={plate}
            cell={cell}
            tooltip={(w) =>
              wellTip(ws, plate, w, (id) => {
                if (!pvStat) return null;
                const v = cachedPlateValue(ws, id);
                return v === undefined ? null : `${statShortLabel(pvStat)}: ${v === null ? 'n/a' : fmtValue(v, statDecimals(pvStat, ws.plateView?.decimals)) || 'no value'}`;
              })
            }
            mark={(w) => groupColorOf(ws, plate.wells.get(w) ?? [])}
            dim={grp ? (w) => !(plate.wells.get(w) ?? []).some((id) => grp.sampleIds.includes(id)) : undefined}
            onContextMenu={(well, x, y) => {
              // a right-click on an unselected well selects it (as in the list)
              const wids = well ? plate.wells.get(well) ?? [] : [];
              const ui = useStore.getState().ui;
              if (wids.length && !wids.some((id) => ui.selectedSampleIds.includes(id) || (!ui.selectedSampleIds.length && id === ui.activeSampleId)))
                st.setUI({ activeSampleId: wids[0], selectedSampleIds: wids });
              setMenu({ x, y, well });
            }}
            onDropSample={(id, well) => setWells([{ id, plate: plate.name, well }], { swap: true })}
            onOpen={openActive}
          />
        )}
        <div className="plate-foot">
          {activeWell && activeName ? (
            <span title={activeName}>
              <b>{shortWell(activeWell)}</b> {activeName}
            </span>
          ) : (
            <span>
              {occupied} of {plate.rows * plate.cols} wells
            </span>
          )}
          {nSel > 1 && <span> · {nSel} selected</span>}
          {layout.unplaced.length > 0 && <span title="Samples without a well: set one with right-click > Set well… in the list"> · {layout.unplaced.length} not on a plate</span>}
        </div>
      </div>
      {menu && <WellMenu x={menu.x} y={menu.y} plate={plate} well={menu.well} onClose={() => setMenu(null)} />}
    </>
  );
}

const PencilIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
);
const MoreIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="6" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18" cy="12" r="1.6" />
  </svg>
);

// ---------------------------------------------------------------- the plate view (document tab)

const STAT_OPTIONS = (Object.keys(STAT_LABELS) as StatKind[]).map((k) => ({ value: k, label: STAT_LABELS[k] }));
/** Statistics that are 100 % for All Events in every well */
const ROOT_NA = new Set<StatKind>(['freqParent', 'freqTotal', 'freqGrandparent', 'freqOf']);

function popOptions(ws: Workspace) {
  return [{ value: 'root', label: 'All Events' }, ...ws.populations.map((p) => ({ value: p.id, label: popPath(ws, p.id) }))];
}

/** Heatmap of a statistic over the wells of all plates, the plate layout and the exports. */
export function PlateDocView() {
  const layout = usePlateLayout();
  const ws = useStore((s) => s.ws);
  const filter = useStore((s) => s.ui.sampleFilter);
  const st = useStore.getState();
  const pv = plateViewSettings(ws);
  const stat = pv.stat;
  const plates = layout.plates;
  const sampleIds = useMemo(() => plates.flatMap((p) => [...p.wells.values()].flat()), [plates]);
  const { valueOf, done, total } = usePlateValues(ws, stat, sampleIds);
  const cellSets = plates.map((p) => plateCells(p, valueOf).cells);
  const range = cellRange(cellSets, pv.range ?? null);
  // values outside a fixed range (drawn in the end colors)
  const flat = cellSets.flat(2).map((c) => c.value).filter((v): v is number => v !== null && Number.isFinite(v));
  const below = !!pv.range && !!range && flat.some((v) => v < range[0]);
  const above = !!pv.range && !!range && flat.some((v) => v > range[1]);
  const spec = cmapSpecOf(pv);
  const keys = annotationKeys(layout.defs);
  const overlay = pv.overlay && keys.includes(pv.overlay) ? pv.overlay : undefined;
  const byOverlay = pv.colorBy === 'overlay' && !!overlay;
  const overlayValues = overlay ? annotationGroups(plates, overlay).map((g) => g.value) : [];
  const catColor = (v: string) => CAT_COLORS[overlayValues.indexOf(v) % CAT_COLORS.length];
  const [menu, setMenu] = useState<{ x: number; y: number; plate: PlateView; well: string | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [cards, { w: width }] = useSize();
  // the plate layout is in the Inspector when that is shown, else beside the plates
  const shell = useShellMode();
  const inspShown = useLayout((s) => isPanelShown('right', shell, s));
  const grp = filter !== 'all' ? ws.groups.find((g) => g.id === filter) : undefined;
  const chans = allChannels(ws);
  const statLabel = `${stat.population === 'root' ? 'All Events' : ws.populations.find((p) => p.id === stat.population)?.name ?? '?'}: ${statShortLabel(stat)}`;
  const up = (f: (s: StatColumn) => void) =>
    updatePlateView((w) => {
      f(w.stat as StatColumn);
    });

  if (!plates.length)
    return (
      <div className="doc-view">
        <div className="card" style={{ maxWidth: 680 }}>
          <div className="card-head">
            <h3>Plates</h3>
          </div>
          <div className="card-body">
            <p style={{ marginTop: 0 }}>
              Samples whose FCS keywords or names carry a well ID (<b>A1</b> to <b>H12</b>, also 384-well <b>P24</b>) are shown here on their plates, with a
              heatmap of any statistic (for example % of a GFP+ gate per well).
            </p>
            <p>
              {ws.samples.length
                ? 'No wells were found in the samples of this workspace. Set them by hand (right-click a sample, Set well…), or re-detect after renaming.'
                : 'Open the FCS files of a plate (Home > Open FCS), or a whole export folder (Home > Open folder): plates in subfolders are told apart.'}
            </p>
            {ws.samples.length > 0 && (
              <button className="btn" onClick={() => redetectWells()}>
                Re-detect wells
              </button>
            )}
          </div>
        </div>
      </div>
    );

  // well size: plates side by side when they fit (at least 30 px per well), else one per row
  const maxCols = Math.max(...plates.map((p) => p.cols));
  // (a plate card: wells and their 2 px gaps, the row letters (~0.45 well), padding and border ~30 px)
  const cardFor = (c: number) => maxCols * (c + 2) + Math.max(18, c * 0.45) + 30;
  const per = pv.arrange === 'column' ? 1 : Math.max(1, Math.min(plates.length, Math.floor((width + 14) / (cardFor(30) + 14))));
  const avail = (width - (per - 1) * 14) / per;
  const cell = Math.max(14, Math.min(64, Math.floor((avail - 30 - 2 * maxCols) / (maxCols + 0.45))));
  const cellsOf = (i: number) => cellSets[i];
  const exportTables = () => {
    // exports compute every value now (also those still being computed for the screen)
    const exact = (id: string) => plateStatValue(ws, engine, id, stat, false);
    const name = (id: string) => ws.samples.find((s) => s.id === id)?.name ?? id;
    return plateExportTables(plates, exact, statLabel, name, keys);
  };
  const base = safeName(`${ws.name} plates ${statLabel}`.replace(/[:%]/g, '').replace(/\s+/g, ' ').trim());
  const valueText = (v: number | null) => groupThousands(fmtValue(v, statDecimals(stat, pv.decimals)));
  // (in the wells: the same short form for all, so that 100000 fits a well as 100k; 3,000 as in the sample list)
  const wellText = (v: number | null) => groupThousands(fmtWellValue(v, statDecimals(stat, pv.decimals), range));

  return (
    <div className="doc-view plate-view">
      <div className="card plate-tools">
        <div className="card-head">
          <div className="pt-group">
            <label className="pt-lbl">Population</label>
            <div style={{ minWidth: 150, maxWidth: 240 }}>
              <Sel value={stat.population} options={popOptions(ws)} ariaLabel="Population" onChange={(v) => up((s) => {
                s.population = v;
                // of All Events, % of the parent (or of the total) is 100 in every well: the count instead
                if (v === 'root' && (s.stat === 'freqParent' || s.stat === 'freqTotal' || s.stat === 'freqGrandparent' || s.stat === 'freqOf')) s.stat = 'count';
                if (s.ofPopulation) s.ofPopulation = validOfPopulation(ws, v, s.ofPopulation);
              })} />
            </div>
          </div>
          <div className="pt-group">
            <label className="pt-lbl">Statistic</label>
            <Sel value={stat.stat} options={stat.population === 'root' ? STAT_OPTIONS.map((o) => (ROOT_NA.has(o.value) ? { ...o, disabled: true, title: 'Choose a gated population: of All Events this is 100 in every well' } : o)) : STAT_OPTIONS} ariaLabel="Statistic" onChange={(v) => up((s) => {
              s.stat = v;
              if (STAT_NEEDS_CHANNEL[v] && !s.channel) s.channel = pickMfiChannel(ws, sampleIds, s.population) ?? chans[0]?.name;
              if (v === 'percentile' && s.percentile === undefined) s.percentile = 50;
            })} />
            {stat.stat === 'percentile' && (
              <div style={{ width: 52 }}>
                <Num value={stat.percentile ?? 50} min={0} max={100} ariaLabel="Percentile" onChange={(v) => up((s) => {
                  s.percentile = v;
                })} />
              </div>
            )}
          </div>
          {STAT_NEEDS_CHANNEL[stat.stat] && (
            <div className="pt-group">
              <label className="pt-lbl">Channel</label>
              <div style={{ minWidth: 150 }}>
                <ChannelPicker value={stat.channel ?? chans[0]?.name ?? ''} samples={sampleIds.slice(0, 50)} ariaLabel="Channel" onChange={(v) => up((s) => {
                  s.channel = v;
                })} />
              </div>
            </div>
          )}
          {stat.stat === 'freqOf' && (
            <div className="pt-group">
              <label className="pt-lbl">% of</label>
              <Sel value={validOfPopulation(ws, stat.population, stat.ofPopulation)} options={ancestorOptions(ws, stat.population)} ariaLabel="Reference population" onChange={(v) => up((s) => {
                s.ofPopulation = v;
              })} />
            </div>
          )}
          <span className="pt-sep" />
          <div className="pt-group">
            <CmapPicker spec={spec} onChange={(n) => updatePlateView((w) => {
              w.colormap = n;
            })} />
            <Check checked={!!pv.reverse} label="Reverse" onChange={(v) => updatePlateView((w) => {
              if (v) w.reverse = true;
              else delete w.reverse;
            })} />
          </div>
          <div className="pt-group" title="Color range: from the values of all plates (Auto) or fixed">
            <Seg
              value={pv.range ? 'fixed' : 'auto'}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'fixed', label: 'Fixed' },
              ]}
              onChange={(v) => updatePlateView((w) => {
                if (v === 'auto') delete w.range;
                else w.range = range ? [Number(range[0].toPrecision(3)), Number(range[1].toPrecision(3))] : [0, 100];
              })}
            />
            {pv.range && (
              <>
                <div style={{ width: 64 }}>
                  <Num value={pv.range[0]} ariaLabel="Range minimum" onChange={(v) => updatePlateView((w) => {
                    if (w.range && v !== w.range[1]) w.range = [Math.min(v, w.range[1]), Math.max(v, w.range[1])];
                  })} />
                </div>
                <span className="hint">to</span>
                <div style={{ width: 64 }}>
                  <Num value={pv.range[1]} ariaLabel="Range maximum" onChange={(v) => updatePlateView((w) => {
                    if (w.range && v !== w.range[0]) w.range = [Math.min(v, w.range[0]), Math.max(v, w.range[0])];
                  })} />
                </div>
              </>
            )}
          </div>
          <div className="pt-group">
            <Check checked={pv.values !== false} label="Values" onChange={(v) => updatePlateView((w) => {
              w.values = v;
            })} />
            <div style={{ width: 44 }} title="Decimals">
              <Num value={pv.decimals ?? 1} min={0} max={6} step={1} ariaLabel="Decimals" onChange={(v) => updatePlateView((w) => {
                w.decimals = Math.round(v);
              })} />
            </div>
          </div>
          {plates.length > 1 && (
            <Seg
              value={pv.arrange ?? 'row'}
              options={[
                { value: 'row', label: 'Side by side' },
                { value: 'column', label: 'Stacked' },
              ]}
              onChange={(v) => updatePlateView((w) => {
                w.arrange = v;
              })}
            />
          )}
          <span className="pt-sep" />
          <button className="btn sm" title="CSV: one 8 x 12 block per plate, then one row per sample (plate, well, sample, value, layout)" onClick={() => {
            const t = exportTables();
            void saveFile(`${base}.csv`, csvText([...t.layout, [], ...t.long]));
          }}>
            CSV
          </button>
          <button className="btn sm" title="Excel: sheet Plates (one block per plate) and sheet Samples (one row per sample)" onClick={() => {
            const t = exportTables();
            void saveFile(`${base}.xlsx`, writeXlsxBook([{ name: 'Plates', rows: t.layout }, { name: 'Samples', rows: t.long, header: true }]));
          }}>
            <Icon.export /> Excel
          </button>
          <button className="btn sm primary" title="Add the heatmap of each plate to the worksheet (a figure item: same on screen, PNG, PDF and SVG)" onClick={() => {
            const items = addPlateHeatmaps(plates.map((p) => p.name));
            const sheet = useStore.getState().ws.worksheets.find((w) => w.id === useStore.getState().ui.activeSheetId) ?? useStore.getState().ws.worksheets[0];
            addItems(sheet.id, items);
          }}>
            <Icon.plus /> Add to sheet
          </button>
        </div>
      </div>
      <div className="plate-doc">
        <div className={`plate-cards${per === 1 ? ' one' : ''}`} ref={cards}>
          {width > 0 &&
            plates.map((p, i) => {
              const cells = cellsOf(i);
              const cellOf = (w: string) => {
                const pos = allWells(p).indexOf(w);
                return cells[Math.floor(pos / p.cols)]?.[pos % p.cols];
              };
              const n = [...p.wells.values()].reduce((a, l) => a + l.length, 0);
              const pending = [...p.wells.values()].flat().filter((id) => valueOf(id) === undefined).length;
              return (
                <section key={p.name} className="card plate-card" aria-label={`Plate ${p.name}`}>
                  <div className="card-head">
                    <PlateName plate={p.name} editing={editing === p.name} setEditing={(v) => setEditing(v ? p.name : null)} />
                    <button className="icon-btn" title="Rename the plate" aria-label={`Rename plate ${p.name}`} onClick={() => setEditing(p.name)}>
                      <PencilIcon />
                    </button>
                    <span className="hint">
                      {n} sample{n === 1 ? '' : 's'}
                      {pending ? ` · computing ${n - pending} of ${n}` : ''}
                    </span>
                    <span style={{ flex: 1 }} />
                    <FormatSel plate={p} />
                  </div>
                  <div className="card-body">
                    <PlateGrid
                      plate={p}
                      cell={cell}
                      big
                      fill={(w) => {
                        if (byOverlay) {
                          const a = p.def?.annotations?.[w]?.[overlay!];
                          return a ? catColor(a) : null;
                        }
                        const c = cellOf(w);
                        return c && range && c.value !== null && Number.isFinite(c.value) ? colormapColor(spec, rangeT(c.value, range)) : null;
                      }}
                      ink={(w) => {
                        const c = cellOf(w);
                        if (byOverlay) return '#000000';
                        return c && range && c.value !== null && Number.isFinite(c.value) ? (luminance(colormapColor(spec, rangeT(c.value, range))) > INK_LUMINANCE ? '#000000' : '#ffffff') : null;
                      }}
                      text={(w) => (pv.values !== false && !byOverlay && cell >= 26 ? wellText(cellOf(w)?.value ?? null) || null : null)}
                      sub={overlay ? (w) => p.def?.annotations?.[w]?.[overlay] ?? null : undefined}
                      na={(w) => {
                        const c = cellOf(w);
                        if (!c) return false;
                        return c.samples.every((id) => valueOf(id) !== undefined) && (c.value === null || !Number.isFinite(c.value));
                      }}
                      dim={grp ? (w) => !(p.wells.get(w) ?? []).some((id) => grp.sampleIds.includes(id)) : undefined}
                      mark={(w) => groupColorOf(ws, p.wells.get(w) ?? [])}
                      tooltip={(w) =>
                        wellTip(ws, p, w, (id) => {
                          const v = valueOf(id);
                          return `${statLabel}: ${v === undefined ? 'computing…' : v === null ? 'n/a' : valueText(v) || 'no value'}`;
                        })
                      }
                      onContextMenu={(well, x, y) => {
                        const wids = well ? p.wells.get(well) ?? [] : [];
                        const ui = useStore.getState().ui;
                        if (wids.length && !wids.some((id) => ui.selectedSampleIds.includes(id) || (!ui.selectedSampleIds.length && id === ui.activeSampleId)))
                          st.setUI({ activeSampleId: wids[0], selectedSampleIds: wids });
                        setMenu({ x, y, plate: p, well });
                      }}
                      onDropSample={(id, well) => setWells([{ id, plate: p.name, well }], { swap: true })}
                      onOpen={openActive}
                    />
                    {byOverlay ? (
                      <div className="plate-legend cat">
                        {overlayValues.map((v) => (
                          <span key={v} className="pl-cat">
                            <span className="pl-sw" style={{ background: catColor(v) }} />
                            {v}
                          </span>
                        ))}
                      </div>
                    ) : (
                      range && (
                        <div className="plate-legend" aria-label={`Color scale from ${valueText(range[0])} to ${valueText(range[1])}`}>
                          <span className="num" title={below ? 'Lower values have the color of the minimum' : undefined}>
                            {below ? '≤ ' : ''}
                            {wellText(range[0])}
                          </span>
                          <span className="pl-bar" style={{ background: `linear-gradient(90deg, ${Array.from({ length: 11 }, (_, k) => colormapColor(spec, k / 10)).join(', ')})` }} />
                          <span className="num" title={above ? 'Higher values have the color of the maximum' : undefined}>
                            {above ? '≥ ' : ''}
                            {wellText(range[1])}
                          </span>
                          <span className="pl-what" title={statLabel}>
                            {statLabel}
                            {pv.range ? ' (fixed range)' : ''}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </section>
              );
            })}
          {done < total && (
            <div className="hint plate-progress" role="status">
              Computing {statLabel}: {done} of {total} samples…
            </div>
          )}
        </div>
        {!inspShown && <PlateLayoutPanel layout={layout} keys={keys} overlay={overlay} byOverlay={byOverlay} />}
      </div>
      {menu && <WellMenu x={menu.x} y={menu.y} plate={menu.plate} well={menu.well} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Categorical colors of annotation values (colorblind-safe Okabe-Ito order, then more). */
const CAT_COLORS = ['#56b4e9', '#e69f00', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7', '#999999', '#a6d854', '#ffd92f', '#8da0cb', '#fc8d62'];

/** Plate layout: annotate the selected wells (key = value), show a key in the wells, make groups of its values. */
function PlateLayoutPanel({ layout, keys, overlay, byOverlay, inInspector }: { layout: PlateLayout; keys: string[]; overlay?: string; byOverlay: boolean; inInspector?: boolean }) {
  const ws = useStore((s) => s.ws);
  const selIds = useStore((s) => s.ui.selectedSampleIds);
  const active = useStore((s) => s.ui.activeSampleId);
  const [key, setKey] = useState(keys[0] ?? 'Condition');
  const [value, setValue] = useState('');
  const [part, setPart] = useState<'tube' | 'first' | 'last'>('tube');
  const sel = selIds.length ? selIds : active ? [active] : [];
  // the selected wells per plate
  const wellsByPlate = new Map<string, string[]>();
  for (const p of layout.plates)
    for (const [w, ids] of p.wells)
      if (ids.some((id) => sel.includes(id))) {
        const l = wellsByPlate.get(p.name) ?? [];
        l.push(w);
        wellsByPlate.set(p.name, l);
      }
  const nWells = [...wellsByPlate.values()].reduce((a, l) => a + l.length, 0);
  const apply = (v: string) => annotateWellValues([...wellsByPlate].flatMap(([plate, wells]) => wells.map((well) => ({ plate, well, value: v }))), key);
  // the first / last word of each well's (first) sample name, e.g. "ALS" / "HC" or "Negative" / "Peptide"
  const fillFromNames = () => {
    const entries: { plate: string; well: string; value: string }[] = [];
    for (const [plate, wells] of wellsByPlate) {
      const p = layout.plates.find((x) => x.name === plate);
      for (const w of wells) {
        const name = ws.samples.find((s) => s.id === p?.wells.get(w)?.[0])?.name ?? '';
        // (CytExpert "02-Well-A1", "Donor.3": hyphens and dots separate words too)
        const words = name.split(/[\s_\-.]+/).filter(Boolean);
        const v = (part === 'tube' ? tubeName(name, w) : part === 'first' ? words[0] : words[words.length - 1]) ?? '';
        if (v) entries.push({ plate, well: w, value: v });
      }
    }
    annotateWellValues(entries, key);
  };
  const current = (() => {
    const vals = new Set<string>();
    for (const [plate, wells] of wellsByPlate) for (const w of wells) vals.add(layout.plates.find((p) => p.name === plate)?.def?.annotations?.[w]?.[key] ?? '');
    return vals.size === 1 ? [...vals][0] : vals.size > 1 ? '(several)' : '';
  })();
  const body = (
    <>
        <p className="hint" style={{ marginTop: 0 }}>
          Select wells (drag a block, click row letters or column numbers), then describe them, e.g. <i>Compound</i> = <i>Drug A</i>, <i>Concentration (uM)</i> = <i>10</i>.
        </p>
        <Field label="Key">
          <input className="inp" list="plate-keys" value={key} aria-label="Annotation key" onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <datalist id="plate-keys">
            {[...new Set([...keys, 'Condition', 'Stain', 'Treatment', 'Virus', 'Compound', 'Concentration (uM)', 'Replicate', 'Control'])].map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </Field>
        <Field label="Value">
          <input
            className="inp"
            value={value}
            placeholder={current || 'value'}
            aria-label="Annotation value"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && nWells && key.trim() && value.trim()) apply(value);
            }}
          />
        </Field>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm primary" disabled={!nWells || !key.trim() || !value.trim()} onClick={() => apply(value)}>
            Set for {nWells} well{nWells === 1 ? '' : 's'}
          </button>
          <button className="btn sm" disabled={!nWells || !key.trim()} onClick={() => apply('')} title="Remove this key from the selected wells">
            Clear
          </button>
        </div>
        <div className="row" style={{ gap: 6, marginTop: 6 }} title="Set the key of the selected wells from their sample names (the tube names typed at the cytometer, or a word such as a donor or condition)">
          <span className="hint">or from the names:</span>
          <Sel
            value={part}
            ariaLabel="Word of the sample name"
            options={[
              { value: 'tube', label: 'name without plate and well', title: 'e.g. "02-Liposomes stained-C1" gives "Liposomes stained"' },
              { value: 'first', label: 'first word' },
              { value: 'last', label: 'last word' },
            ]}
            onChange={setPart}
          />
          <button className="btn sm" disabled={!nWells || !key.trim()} onClick={fillFromNames}>
            Fill
          </button>
        </div>
        {keys.length > 0 && (
          <>
            <h4 className="plate-side-h">Keys</h4>
            <table className="plate-keys">
              <tbody>
                {keys.map((k) => {
                  const vals = annotationGroups(layout.plates, k);
                  return (
                    <tr key={k}>
                      <td>
                        <button className={`link-btn${overlay === k ? ' on' : ''}`} title="Show this key in the wells" onClick={() => updatePlateView((w) => {
                          if (w.overlay === k) delete w.overlay;
                          else w.overlay = k;
                        })}>
                          {k}
                        </button>
                        <span className="hint"> {vals.length} value{vals.length === 1 ? '' : 's'}</span>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn xs" title={`One sample group per value of "${k}" (for charts by group, tables, gate scopes)`} onClick={() => groupsFromAnnotation(k)}>
                          Groups
                        </button>
                        <button className="icon-btn danger" title={`Remove "${k}" from all wells`} aria-label={`Remove ${k}`} onClick={() => removeAnnotationKey(k)}>
                          <Icon.close />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Field label="In the wells">
              <Sel
                value={overlay ?? ''}
                ariaLabel="Key shown in the wells"
                options={[{ value: '', label: 'Values only' }, ...keys.map((k) => ({ value: k, label: k }))]}
                onChange={(v) => updatePlateView((w) => {
                  if (v) w.overlay = v;
                  else delete w.overlay;
                })}
              />
            </Field>
            {overlay && (
              <Check checked={byOverlay} label={`Color wells by ${overlay}`} onChange={(v) => updatePlateView((w) => {
                w.colorBy = v ? 'overlay' : 'stat';
              })} />
            )}
          </>
        )}
        {layout.unplaced.length > 0 && (
          <>
            <h4 className="plate-side-h">Not on a plate ({layout.unplaced.length})</h4>
            <p className="hint" style={{ marginTop: 0 }}>
              Drag a sample from the list onto a well, or right-click it: <b>Set well…</b>
            </p>
            <ul className="plate-unplaced">
              {layout.unplaced.slice(0, 12).map((id) => (
                <li key={id}>{ws.samples.find((s) => s.id === id)?.name}</li>
              ))}
              {layout.unplaced.length > 12 && <li className="hint">and {layout.unplaced.length - 12} more</li>}
            </ul>
          </>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" title="Detect plates and wells again from the FCS keywords, names and folders (wells set by hand are kept)" onClick={() => redetectWells()}>
            Re-detect wells
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          The layout goes into the Excel export (Samples sheet: value and layout per well); Groups makes one sample group per value, for gates, tables and overlays by condition.
        </p>
    </>
  );
  // in the Inspector (the plate view's settings for the selected wells), else a card beside the plates
  if (inInspector)
    return (
      <div className="isec plate-insp" aria-label="Plate layout">
        <h4>Plate layout</h4>
        {body}
      </div>
    );
  return (
    <aside className="card plate-side" aria-label="Plate layout">
      <div className="card-head">
        <h3>Plate layout</h3>
      </div>
      <div className="card-body">{body}</div>
    </aside>
  );
}

/** The Inspector of the plate view: the plate layout of the selected wells. */
export function PlateLayoutInspector() {
  const layout = usePlateLayout();
  const ws = useStore((s) => s.ws);
  const pv = plateViewSettings(ws);
  const keys = annotationKeys(layout.defs);
  const overlay = pv.overlay && keys.includes(pv.overlay) ? pv.overlay : undefined;
  if (!layout.plates.length)
    return (
      <div className="isec">
        <h4>Plate layout</h4>
        <p className="hint">No samples on a plate yet.</p>
      </div>
    );
  return <PlateLayoutPanel layout={layout} keys={keys} overlay={overlay} byOverlay={pv.colorBy === 'overlay' && !!overlay} inInspector />;
}

// ---------------------------------------------------------------- "Set well" dialog

export function SetWellDialog({ payload, onClose }: { payload: { sampleIds: string[] }; onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const layout = usePlateLayout();
  // in the order of the sample list (not the order they were clicked in)
  const pos = new Map(ws.samples.map((s, i) => [s.id, i]));
  const ids = payload.sampleIds.filter((id) => pos.has(id)).sort((a, b) => pos.get(a)! - pos.get(b)!);
  const first = ws.samples.find((s) => s.id === ids[0]);
  const at = layout.plates.map((p) => ({ p, w: first ? wellOfSample(p, first.id) : null })).find((x) => x.w);
  const plateNames = layout.plates.map((p) => p.name);
  const [plate, setPlate] = useState(at?.p.name ?? plateNames[0] ?? 'Plate 1');
  const [newName, setNewName] = useState('');
  const [well, setWell] = useState(at?.w ? shortWell(at.w) : 'A1');
  const [by, setBy] = useState<'rows' | 'cols'>('rows');
  const target = plate === '__new' ? newName.trim() : plate;
  const fmt = layout.plates.find((p) => p.name === target) ?? { rows: 8, cols: 12 };
  const w = normWell(well);
  const many = ids.length > 1;
  const order = w ? fillOrder(fmt, w, ids.length, by) : [];
  const over = order.filter((x) => !x).length;
  const ok = !!target && !!w && (plate !== '__new' || !plateNames.includes(target));
  const save = () => {
    if (!ok) return;
    setWells(ids.map((id, i) => ({ id, plate: target, well: order[i] ?? null })).filter((a) => a.well));
    onClose();
  };
  return (
    <Modal
      title={many ? `Place ${ids.length} samples on a plate` : `Set well of “${first?.name ?? ''}”`}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            style={{ marginRight: 'auto' }}
            onClick={() => {
              setWells(ids.map((id) => ({ id, plate: target, well: null })));
              onClose();
            }}
          >
            Take off the plate
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok} onClick={save}>
            Set
          </button>
        </>
      }
    >
      <Field label="Plate">
        <select className="sel" value={plate} aria-label="Plate" onChange={(e) => setPlate(e.target.value)}>
          {plateNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value="__new">New plate…</option>
        </select>
      </Field>
      {plate === '__new' && (
        <Field label="Name">
          <input className="inp" autoFocus value={newName} aria-label="New plate name" placeholder={`Plate ${plateNames.length + 1}`} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </Field>
      )}
      <Field label={many ? 'First well' : 'Well'}>
        <input
          className="inp"
          value={well}
          aria-label="Well"
          style={{ width: 90 }}
          onChange={(e) => setWell(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') save();
          }}
        />
      </Field>
      {many && (
        <Field label="Fill">
          <Seg
            value={by}
            options={[
              { value: 'rows', label: 'By rows (A1, A2 …)' },
              { value: 'cols', label: 'By columns (A1, B1 …)' },
            ]}
            onChange={setBy}
          />
        </Field>
      )}
      {!w && <p className="hint" style={{ color: 'var(--danger)' }}>A well is a row letter A to P and a column 1 to 24, e.g. B7.</p>}
      {many && w && (
        <p className="hint">
          {ids.length} samples in list order: {order.filter(Boolean).slice(0, 3).map((x) => shortWell(x!)).join(', ')}
          {ids.length > 3 ? ` … ${shortWell(order.filter(Boolean).slice(-1)[0] ?? '')}` : ''}
          {over ? `; ${over} do not fit on the plate and stay where they are.` : '.'}
        </p>
      )}
      <p className="hint" style={{ marginBottom: 0 }}>
        Wells set by hand are kept when wells are detected again. Samples already in the well stay there too (one well can hold several samples, e.g. raw and
        unmixed files).
      </p>
    </Modal>
  );
}

