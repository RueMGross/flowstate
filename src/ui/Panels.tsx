import { MiddleText } from './MiddleText';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { engine } from '../core/engine';
import { popChildren, uid, type PlotItem, type Population, type Workspace } from '../core/model';
import { popNotApplicableReason, scopeLabel, scopeOwner, scopeTag } from '../core/scope';
import { setPlotPopulation } from '../render/plot';
import { copyGatesToGroup, setPopScope } from '../state/scopeOps';
import { deletePopulation, newPlotItem, pickDefaultChannels, relinkSample, removeSamples, useStore } from '../state/store';
import { copyGates, gateClipLabel, onGateClip, pasteGates } from './gateOps';
import { Icon } from './icons';
import { addPlotAt, populationPlotSpec } from './layoutOps';
import { openPopulationPlot } from './popPlot';
import { DND_TYPE } from './SheetView';
import { ContextMenu } from './widgets';
import { sampleSplit, ShellIcon, useLayout } from './shell';
import { PlatePanel } from './PlateView';
import { setWells } from '../state/plateOps';
import { shortWell } from '../core/plate';

export { ContextMenu };

/** A pseudocolor plot of a sample's scatter channels on the active sheet (the touch alternative to dragging it there). */
function addSamplePlot(sampleId: string) {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((w) => w.id === st.ui.activeSheetId) ?? st.ws.worksheets[0];
  if (!sheet) return;
  const { fsc, ssc } = pickDefaultChannels(st.ws, { sampleIds: [sampleId], popId: null });
  if (st.ui.view !== 'sheet') st.setUI({ view: 'sheet' });
  addPlotAt(sheet.id, (x, y, w, h) => newPlotItem('pseudo', fsc, ssc, x, y, w, h, 'root', sampleId));
}

/** The one selected plot of the active sheet, if any. */
function selectedPlot(): { sheetId: string; plot: PlotItem } | null {
  const st = useStore.getState();
  const sheet = st.ws.worksheets.find((w) => w.id === st.ui.activeSheetId) ?? st.ws.worksheets[0];
  const plots = sheet?.items.filter((i): i is PlotItem => i.kind === 'plot' && st.ui.selectedItemIds.includes(i.id)) ?? [];
  return plots.length === 1 ? { sheetId: sheet.id, plot: plots[0] } : null;
}

function setDrag(e: DragEvent, type: 'sample' | 'population', id: string) {
  e.dataTransfer.setData(DND_TYPE, JSON.stringify({ type, id }));
  e.dataTransfer.setData('text/plain', id);
  e.dataTransfer.effectAllowed = 'copy';
}

/**
 * Group filter chips: one row that scrolls sideways (wheel or drag), so many groups never squeeze the sample list; when
 * they do not fit, a menu at the end lists all groups.
 */
function GroupBar({ filter, onNew }: { filter: string; onNew: () => void }) {
  const groups = useStore((s) => s.ws.groups);
  const st = useStore.getState();
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 2);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [groups]);
  // the chosen group stays in view
  useEffect(() => {
    ref.current?.querySelector('.chip.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [filter]);
  // a vertical wheel scrolls the row sideways
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const cur = groups.find((g) => g.id === filter);
  return (
    <div className="group-bar-wrap">
      <div className="group-bar" ref={ref} role="toolbar" aria-label="Sample groups">
        {groups.length > 0 && (
          <button className={`chip${filter === 'all' ? ' on' : ''}`} onClick={() => st.setUI({ sampleFilter: 'all' })}>
            All
          </button>
        )}
        {groups.map((g) => (
          <button
            key={g.id}
            className={`chip${filter === g.id ? ' on' : ''}`}
            onClick={() => st.setUI({ sampleFilter: g.id })}
            onDoubleClick={() => st.setUI({ dialog: { kind: 'group', payload: { groupId: g.id } } })}
            title={`${g.name}: ${g.sampleIds.length} samples · double-click to edit`}
          >
            <span className="dot" style={{ background: g.color ?? 'var(--accent)' }} />
            {g.name}
          </button>
        ))}
        <button className="chip add" onClick={onNew} title="Create a group from the selected samples">
          + Group
        </button>
      </div>
      {overflow && (
        <select
          className="group-more"
          aria-label="Show group"
          title="All groups"
          value={cur ? cur.id : 'all'}
          onChange={(e) => {
            st.setUI({ sampleFilter: e.target.value });
            e.target.blur();
          }}
        >
          <option value="all">All samples</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.sampleIds.length})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function SamplePanel({ onOpen }: { onOpen: () => void }) {
  const ws = useStore((s) => s.ws);
  const active = useStore((s) => s.ui.activeSampleId);
  const selIds = useStore((s) => s.ui.selectedSampleIds);
  const filter = useStore((s) => s.ui.sampleFilter);
  useStore((s) => s.ui.dataVersion);
  const [editing, setEditing] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const st = useStore.getState();
  const group = ws.groups.find((g) => g.id === filter);
  const list = group ? ws.samples.filter((s) => group.sampleIds.includes(s.id)) : ws.samples;
  const lastClick = useRef<string | null>(null);

  const click = (e: React.MouseEvent, id: string) => {
    let sel = selIds.length ? selIds : active ? [active] : [];
    let act: string | null = id;
    if (e.metaKey || e.ctrlKey) {
      if (sel.includes(id)) {
        // deselecting does not activate: keep the active sample, or the last one still selected
        sel = sel.filter((x) => x !== id);
        act = active !== id ? active : sel[sel.length - 1] ?? active;
      } else sel = [...sel, id];
    } else if (e.shiftKey && lastClick.current && list.some((s) => s.id === lastClick.current)) {
      const ids = list.map((s) => s.id);
      const a = ids.indexOf(lastClick.current);
      const b = ids.indexOf(id);
      sel = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    } else sel = [id];
    if (!e.shiftKey) lastClick.current = id;
    st.setUI({ activeSampleId: act, selectedSampleIds: sel });
  };
  const selected = (id: string) => (selIds.length ? selIds.includes(id) : id === active);
  const targets = (id: string) => (selIds.includes(id) && selIds.length > 1 ? selIds : [id]);
  const selection = selIds.length ? selIds : active ? [active] : [];
  const split = useLayout(sampleSplit);
  const dupNames = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const x of ws.samples) (seen.has(x.name) ? dup : seen).add(x.name);
    return dup;
  }, [ws.samples]);
  const mode = useLayout((s) => s.sampleView);

  return (
    <div className="pane samples-pane" style={{ flex: `0 0 ${Math.round(split * 1000) / 10}%` }}>
      <div className="pane-head">
        <span className="grow">Samples ({list.length}{group ? ` of ${ws.samples.length}` : ''})</span>
        <span className="seg view-seg" role="radiogroup" aria-label="Show samples as">
          <button role="radio" aria-checked={mode === 'list'} aria-label="List" className={mode === 'list' ? 'on' : ''} title="Samples as a list" onClick={() => useLayout.getState().set({ sampleView: 'list' })}>
            <ListIcon />
          </button>
          <button role="radio" aria-checked={mode === 'plate'} aria-label="Plate" className={mode === 'plate' ? 'on' : ''} title="Samples on their plate (wells from names or FCS keywords)" onClick={() => useLayout.getState().set({ sampleView: 'plate' })}>
            <Icon.plate />
          </button>
        </span>
        <button
          className="icon-btn"
          title="Add a plot of the active sample to the worksheet (or drag the sample onto the page)"
          aria-label="Add plot of the active sample to the sheet"
          disabled={!active || !engine.has(active)}
          onClick={() => active && addSamplePlot(active)}
        >
          <ShellIcon.addToSheet />
        </button>
        <button className="icon-btn danger" title="Remove the selected samples from the workspace (Del)" aria-label="Remove sample" disabled={!selection.length} onClick={() => removeSamples(selection)}>
          <Icon.trash />
        </button>
        <button className="icon-btn" title="Add FCS files" aria-label="Add FCS files" onClick={onOpen}>
          <Icon.plus />
        </button>
      </div>
      {/* always there: "+ Group" makes the first group too */}
      <GroupBar filter={filter} onNew={() => st.setUI({ dialog: { kind: 'group', payload: { sampleIds: selIds.length ? selIds : active ? [active] : [] } } })} />
      {mode === 'plate' && <PlatePanel />}
      <div
        className="pane-body"
        hidden={mode === 'plate'}
        tabIndex={0}
        aria-label="Sample list"
        onKeyDown={(e) => {
          // keys handled here never reach the worksheet shortcuts (no nudging plots while browsing samples)
          const ids = list.map((s) => s.id);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            e.stopPropagation();
            const i = ids.indexOf(active ?? '');
            const n = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
            if (ids[n]) {
              st.setUI({ activeSampleId: ids[n], selectedSampleIds: [ids[n]] });
              e.currentTarget.querySelector(`[data-sample-id="${CSS.escape(ids[n])}"]`)?.scrollIntoView({ block: 'nearest' });
            }
          } else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            if (selection.length) removeSamples(selection);
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            e.stopPropagation();
            st.setUI({ selectedSampleIds: ids, activeSampleId: active && ids.includes(active) ? active : ids[0] ?? null });
          } else if (e.key === 'Enter' && active) {
            e.preventDefault();
            e.stopPropagation();
            setEditing(active);
            setVal(ws.samples.find((x) => x.id === active)?.name ?? '');
          }
        }}
      >
        {ws.samples.length === 0 && (
          <div className="empty-note">
            Drop FCS / LMD files anywhere in the window, or use <b>Open FCS</b>. Files stay in your browser; nothing is uploaded.
          </div>
        )}
        {list.map((s) => {
          const loaded = engine.has(s.id);
          const comp = s.compId ? ws.compensations.find((c) => c.id === s.compId) : null;
          return (
            <div
              key={s.id}
              data-sample-id={s.id}
              aria-selected={selected(s.id)}
              className={`srow${active === s.id ? ' on' : selected(s.id) ? ' sel' : ''}${loaded ? '' : ' missing'}`}
              draggable={loaded}
              onDragStart={(e) => setDrag(e, 'sample', s.id)}
              onClick={(e) => click(e, s.id)}
              onDoubleClick={() => {
                setEditing(s.id);
                setVal(s.name);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!selected(s.id)) st.setUI({ activeSampleId: s.id, selectedSampleIds: [s.id] });
                setMenu({ x: e.clientX, y: e.clientY, id: s.id });
              }}
              title={`${s.fileName}\n${s.eventCount.toLocaleString('en-US')} events${s.info?.Cytometer ? '\n' + s.info.Cytometer : ''}${s.info?.Date ? '\n' + s.info.Date : ''}`}
            >
              <span className="dot" style={{ background: s.color ?? (loaded ? 'var(--accent)' : 'var(--text-3)') }} />
              {editing === s.id ? (
                <input
                  className="inp sm"
                  autoFocus
                  value={val}
                  aria-label="Sample name"
                  onChange={(e) => setVal(e.target.value)}
                  onBlur={() => {
                    st.update((w) => {
                      const x = w.samples.find((y) => y.id === s.id);
                      if (x && val.trim()) x.name = val.trim();
                    });
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <MiddleText className="nm" text={s.name} />
              )}
              <span className="meta num">
                {s.well && (
                  <span className="badge well" title={`${s.plate ?? ''}, well ${s.well}`}>
                    {/* samples of the same name on different plates (two runs saved as "01-Well-A1"): with the plate */}
                    {dupNames.has(s.name) && s.plate ? `${s.plate} · ${shortWell(s.well)}` : shortWell(s.well)}
                  </span>
                )}
                {comp && (
                  <span className="badge comp" title={`Compensation: ${comp.name}`}>
                    C
                  </span>
                )}
                {!loaded && (
                  <span className="badge warn" title="FCS file not loaded. Drop the file to relink.">
                    missing
                  </span>
                )}
                {fmtK(s.eventCount)}
              </span>
            </div>
          );
        })}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {!engine.has(menu.id) && (
            <>
              <button
                title="Pick the FCS file of this sample (its name may differ, e.g. a renamed file)"
                onClick={() => {
                  const id = menu.id;
                  pickFile('.fcs,.lmd,.FCS,.LMD,.csv,.tsv,.txt', (f) => void relinkSample(id, f));
                }}
              >
                Locate file…
              </button>
              <hr />
            </>
          )}
          {engine.has(menu.id) && (
            <>
              <button onClick={() => addSamplePlot(menu.id)}>Add plot to sheet</button>
              {selectedPlot() && (
                <>
                  <button
                    onClick={() => {
                      const sp = selectedPlot();
                      if (!sp) return;
                      st.update((w) => {
                        const p = w.worksheets.find((x) => x.id === sp.sheetId)!.items.find((i) => i.id === sp.plot.id) as PlotItem;
                        if (p.layers[0]) p.layers[0].sample = menu.id;
                        else p.layers.push({ id: uid('ly'), sample: menu.id, population: 'root' });
                      });
                    }}
                  >
                    Show in selected plot
                  </button>
                  <button
                    onClick={() => {
                      const sp = selectedPlot();
                      if (!sp) return;
                      st.update((w) => {
                        const p = w.worksheets.find((x) => x.id === sp.sheetId)!.items.find((i) => i.id === sp.plot.id) as PlotItem;
                        const pop = p.layers[0]?.population ?? 'root';
                        if (p.layers.length === 1 && p.layers[0].sample === 'active' && st.ui.activeSampleId) p.layers[0].sample = st.ui.activeSampleId;
                        p.layers.push({ id: uid('ly'), sample: menu.id, population: pop });
                      });
                    }}
                  >
                    Overlay on selected plot
                  </button>
                </>
              )}
              <hr />
            </>
          )}
          <button onClick={() => st.setUI({ dialog: { kind: 'keywords', payload: { sampleId: menu.id } } })}>Keywords…</button>
          <button title="Put the sample(s) in a well of a plate (several: filled by rows or columns)" onClick={() => st.setUI({ dialog: { kind: 'setWell', payload: { sampleIds: targets(menu.id) } } })}>
            Set well…
          </button>
          {ws.samples.some((x) => targets(menu.id).includes(x.id) && x.well) && (
            <button onClick={() => setWells(ws.samples.filter((x) => targets(menu.id).includes(x.id)).map((x) => ({ id: x.id, plate: x.plate ?? '', well: null })))}>Take off the plate</button>
          )}
          <button
            onClick={() => {
              const s = ws.samples.find((x) => x.id === menu.id);
              setEditing(menu.id);
              setVal(s?.name ?? '');
            }}
          >
            Rename
          </button>
          <label className="menu-row">
            Color
            <input
              type="color"
              className="color-in"
              aria-label="Sample color"
              value={ws.samples.find((x) => x.id === menu.id)?.color ?? '#1f77b4'}
              onChange={(e) => {
                const c = e.target.value;
                const ids = targets(menu.id);
                st.update((w) => {
                  for (const x of w.samples) if (ids.includes(x.id)) x.color = c;
                }, 'scolor');
              }}
            />
          </label>
          <hr />
          <button onClick={() => st.setUI({ dialog: { kind: 'group', payload: { sampleIds: targets(menu.id) } } })}>Create group from selection…</button>
          {ws.groups.map((g) => (
            <button
              key={g.id}
              onClick={() =>
                st.update((w) => {
                  const gg = w.groups.find((x) => x.id === g.id)!;
                  for (const id of targets(menu.id)) if (!gg.sampleIds.includes(id)) gg.sampleIds.push(id);
                })
              }
            >
              Add to “{g.name}”
            </button>
          ))}
          <hr />
          <button style={{ color: 'var(--danger)' }} onClick={() => removeSamples(targets(menu.id))}>
            Remove from workspace
          </button>
        </ContextMenu>
      )}
    </div>
  );
}

const ListIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden="true">
    <path d="M8 6h12M8 12h12M8 18h12" />
    <circle cx="4" cy="6" r="1" fill="currentColor" />
    <circle cx="4" cy="12" r="1" fill="currentColor" />
    <circle cx="4" cy="18" r="1" fill="currentColor" />
  </svg>
);

/** Open the system file picker (a detached input: no extra file input in the page). */
function pickFile(accept: string, onPick: (f: File) => void) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = accept;
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (f) onPick(f);
  };
  inp.click();
}

function fmtK(n: number) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  return n.toLocaleString('en-US');
}

/** Rows of the population tree in display order (collapsed branches and hidden populations skipped); 'root' is All Events. */
function visibleRows(ws: Workspace, collapsed: Record<string, boolean>, shown: (p: Population) => boolean): string[] {
  const out = ['root'];
  const walk = (parent: string | null, key: string) => {
    if (collapsed[key]) return;
    for (const p of popChildren(ws, parent)) {
      if (!shown(p)) continue;
      out.push(p.id);
      walk(p.id, p.id);
    }
  };
  walk(null, 'root');
  return out;
}

/** Indentation of a tree level: full steps near the top, smaller ones deeper down (deep trees keep their names). */
const indentPx = (depth: number) => Math.min(124, depth <= 5 ? depth * 14 : 70 + (depth - 5) * 6);

const SHOW_ALL_KEY = 'fc-tree-show-all';
function readShowAll(): boolean {
  try {
    return localStorage.getItem(SHOW_ALL_KEY) === '1';
  } catch {
    return false;
  }
}

export function PopulationPanel() {
  const ws = useStore((s) => s.ws);
  const active = useStore((s) => s.ui.activeSampleId);
  const selected = useStore((s) => s.ui.selectedPopId);
  useStore((s) => s.ui.dataVersion);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [showAll, setShowAllState] = useState(readShowAll);
  const treeRef = useRef<HTMLDivElement>(null);
  const cancelRename = useRef(false);
  const renameTimer = useRef(0);
  const st = useStore.getState();
  const has = active && engine.has(active);
  const total = has ? engine.eventCount(active!) : 0;
  const setShowAll = (v: boolean) => {
    setShowAllState(v);
    try {
      localStorage.setItem(SHOW_ALL_KEY, v ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };
  // populations that do not apply to the active sample (other group's tree, gate on a channel it lacks) are hidden
  const naReason = (p: Population) => (active ? popNotApplicableReason(ws, active, p.id) : null);
  const naIds = new Set(active ? ws.populations.filter((p) => naReason(p)).map((p) => p.id) : []);
  const shown = (p: Population) => showAll || !naIds.has(p.id);
  // picking a population in the tree makes it the target of Delete and the inspector (no worksheet items selected)
  const pick = (id: string | null) => st.setUI({ selectedPopId: id, selectedItemIds: [], keyItemId: null });
  const rename = (id: string) => {
    window.clearTimeout(renameTimer.current);
    const p = ws.populations.find((x) => x.id === id);
    if (!p) return;
    setEditing(id);
    setVal(p.name);
  };
  useEffect(() => () => window.clearTimeout(renameTimer.current), []);

  const row = (p: Population | null, depth: number) => {
    const id = p?.id ?? 'root';
    const kids = popChildren(ws, p ? p.id : null).filter(shown);
    const na = p ? naIds.has(p.id) : false;
    // counts do not wait for background computations (gates on unmixed channels of large samples): "…" meanwhile
    const n0 = has && !na ? engine.countForDisplay(ws, active!, id) : NaN;
    const pn0 = has && !na ? (p ? engine.countForDisplay(ws, active!, p.parentId ?? 'root') : total) : NaN;
    const computing = n0 === null || pn0 === null;
    const n = n0 ?? NaN;
    const parentN = pn0 ?? NaN;
    const pct = parentN ? (100 * n) / parentN : NaN;
    const isCollapsed = collapsed[id];
    const on = p ? selected === p.id : !selected;
    const tag = p?.scope ? scopeTag(ws, p.scope) : '';
    const why = p && na ? naReason(p) : null;
    return (
      <div key={id} role="none">
        <div
          id={'prow-' + id}
          role="treeitem"
          aria-selected={on}
          aria-level={depth + 1}
          aria-expanded={kids.length ? !isCollapsed : undefined}
          className={`prow${selected === p?.id ? ' on' : ''}${on ? ' cur' : ''}${na ? ' na' : ''}`}
          draggable
          onDragStart={(e) => setDrag(e, 'population', id)}
          onClick={(e) => {
            const wasSelected = !!p && selected === p.id;
            pick(p?.id ?? null);
            // a second, slow click on the name of the selected population renames it (a double-click opens a plot)
            window.clearTimeout(renameTimer.current);
            if (p && wasSelected && e.detail === 1 && !e.shiftKey && !e.ctrlKey && !e.metaKey && (e.target as HTMLElement).classList.contains('nm'))
              renameTimer.current = window.setTimeout(() => rename(p.id), 450);
          }}
          onDoubleClick={() => {
            window.clearTimeout(renameTimer.current);
            if (editing) return;
            openPopulationPlot(id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            // keep the worksheet selection so "Show in selected plot" can act on it
            if (p) st.setUI({ selectedPopId: p.id });
            setMenu({ x: e.clientX, y: e.clientY, id });
          }}
          title={
            p
              ? `${p.name}: ${p.gate.type} gate${p.overrides && Object.keys(p.overrides).length ? ' (sample-specific variants)' : ''}${p.scope ? `\nApplies to ${scopeLabel(ws, p.scope)}` : ''}${why ? `\nNot applicable to the active sample: ${why}` : ''}\nDouble-click: show in a plot · F2: rename`
              : 'All events · double-click: show in a plot'
          }
        >
          <span className="indent" style={{ width: indentPx(depth) + 14 }}>
            {kids.length > 0 ? (
              <button
                className="icon-btn"
                tabIndex={-1}
                style={{ width: 14, height: 14 }}
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                title={isCollapsed ? 'Expand (→)' : 'Collapse (←)'}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsed({ ...collapsed, [id]: !isCollapsed });
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {isCollapsed ? <Icon.right /> : <Icon.down />}
              </button>
            ) : null}
          </span>
          <span className="sw" style={{ background: p?.color ?? '#9aa3ad' }} />
          {editing === p?.id ? (
            <input
              className="inp sm"
              autoFocus
              value={val}
              aria-label="Population name"
              onChange={(e) => setVal(e.target.value)}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={() => {
                if (!cancelRename.current && val.trim() && val.trim() !== p!.name)
                  st.update((w) => {
                    const x = w.populations.find((y) => y.id === p!.id);
                    if (x) x.name = val.trim();
                  });
                cancelRename.current = false;
                setEditing(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' || e.key === 'Escape') {
                  cancelRename.current = e.key === 'Escape';
                  treeRef.current?.focus(); // blurs the field, which commits unless cancelled
                }
              }}
            />
          ) : (
            <span className="nm">
              {p ? p.name : 'All Events'}
              {tag && (
                <span className="ptag" title={`Applies to ${scopeLabel(ws, p!.scope)}`}>
                  {tag}
                </span>
              )}
            </span>
          )}
          <span className="ct" title={computing ? 'Computing (a channel is being computed in the background)' : undefined}>
            {na ? '' : computing ? '…' : Number.isFinite(n) ? n.toLocaleString('en-US') : ''}
          </span>
          <span className="pc" title={why ?? undefined}>
            {na ? 'n/a' : computing ? '' : p && Number.isFinite(pct) ? pct.toFixed(pct < 10 ? 2 : 1) + '%' : ''}
          </span>
        </div>
        {!isCollapsed && kids.length > 0 && <div role="group">{kids.map((k) => row(k, depth + 1))}</div>}
      </div>
    );
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const rows = visibleRows(ws, collapsed, shown);
    const cur = selected ?? 'root';
    const i = rows.indexOf(cur);
    const go = (id: string | undefined) => {
      if (!id) return;
      pick(id === 'root' ? null : id);
      treeRef.current?.querySelector(`[id="prow-${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    const kids = popChildren(ws, cur === 'root' ? null : cur).filter(shown);
    let handled = true;
    if (e.key === 'ArrowDown') go(rows[Math.min(rows.length - 1, i + 1)]);
    else if (e.key === 'ArrowUp') go(rows[Math.max(0, i - 1)]);
    else if (e.key === 'Home') go(rows[0]);
    else if (e.key === 'End') go(rows[rows.length - 1]);
    else if (e.key === 'ArrowRight') {
      if (kids.length && collapsed[cur]) setCollapsed({ ...collapsed, [cur]: false });
      else go(kids[0]?.id);
    } else if (e.key === 'ArrowLeft') {
      if (kids.length && !collapsed[cur]) setCollapsed({ ...collapsed, [cur]: true });
      else if (cur !== 'root') go(ws.populations.find((p) => p.id === cur)?.parentId ?? 'root');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) deletePopulation(selected);
    else if (e.key === 'F2' && selected) rename(selected);
    else if (e.key === 'Enter') openPopulationPlot(selected ?? 'root');
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const hiddenN = showAll ? 0 : naIds.size;
  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <span className="grow">Populations</span>
        {naIds.size > 0 && (
          <button
            className={`chip${showAll ? ' on' : ''}`}
            style={{ height: 20, fontSize: 11 }}
            title={showAll ? 'Hide the populations that do not apply to the active sample' : `Show all populations, also the ${naIds.size} that do not apply to the active sample (other groups' gates, gates on channels it lacks)`}
            aria-pressed={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            Show all
          </button>
        )}
        <button
          className="icon-btn"
          title="Open a plot of the selected population (or double-click it, or drag it onto the page)"
          aria-label="Add plot of the selected population to the sheet"
          onClick={() => openPopulationPlot(selected ?? 'root')}
        >
          <ShellIcon.addToSheet />
        </button>
        <button
          className="icon-btn danger"
          title="Delete selected population (Del)"
          aria-label="Delete selected population"
          disabled={!selected}
          onClick={() => selected && deletePopulation(selected)}
        >
          <Icon.trash />
        </button>
      </div>
      <FlowJoNotice />
      <div ref={treeRef} className="pane-body ptree" tabIndex={0} role="tree" aria-label="Populations" aria-activedescendant={'prow-' + (selected ?? 'root')} onKeyDown={onKey}>
        {row(null, 0)}
        {ws.populations.length === 0 && <div className="empty-note">Draw a gate on a plot to create populations. Drag a population onto a plot to show or overlay it; double-click it to open a plot.</div>}
        {hiddenN > 0 && (
          <div className="ptree-note">
            {hiddenN} population{hiddenN > 1 ? 's do' : ' does'} not apply to this sample.{' '}
            <button className="linkish" onClick={() => setShowAll(true)}>
              Show all
            </button>
          </div>
        )}
      </div>
      {menu && <PopMenu menu={menu} onClose={() => setMenu(null)} onRename={rename} />}
    </div>
  );
}

/** After a FlowJo import: compare FlowJo's own counts with ours (stays until dismissed). */
function FlowJoNotice() {
  const fj = useStore((s) => s.ui.flowjoCounts);
  const dismissed = useStore((s) => s.ui.flowjoNoticeDismissed);
  if (!fj || dismissed) return null;
  const st = useStore.getState();
  return (
    <div className="flowjo-notice" role="status">
      <span className="grow" title={`Gates and counts were read from ${fj.fileName}`}>
        Imported from FlowJo:{' '}
        <button className="linkish" onClick={() => st.setUI({ dialog: { kind: 'flowjoCounts' } })}>
          compare counts
        </button>
      </span>
      <button className="icon-btn" aria-label="Dismiss the FlowJo note" title="Dismiss (Compare counts stays in the Gate tab)" onClick={() => st.setUI({ flowjoNoticeDismissed: true })}>
        ×
      </button>
    </div>
  );
}

function PopMenu({ menu, onClose, onRename }: { menu: { x: number; y: number; id: string }; onClose: () => void; onRename: (id: string) => void }) {
  const ws = useStore((s) => s.ws);
  const ui = useStore((s) => s.ui);
  const st = useStore.getState();
  const pop = ws.populations.find((p) => p.id === menu.id);
  const [clip, setClip] = useState(gateClipLabel());
  useEffect(() => onGateClip(() => setClip(gateClipLabel())), []);
  const hasKids = !!pop && ws.populations.some((p) => p.parentId === pop.id);
  const sheet = ws.worksheets.find((w) => w.id === ui.activeSheetId) ?? ws.worksheets[0];
  const selPlot = sheet.items.find((i) => i.kind === 'plot' && ui.selectedItemIds.includes(i.id)) as PlotItem | undefined;
  // the axes of the next gating step (child gates), else of the population's own gate (same as a double-click)
  const newPlot = (type: 'pseudo' | 'histogram') => {
    const spec = populationPlotSpec(ws, menu.id);
    let { x, y } = spec;
    if (type === 'pseudo' && spec.type === 'histogram') {
      // a one-parameter gate: plot its channel against side scatter (forward scatter for a side scatter gate)
      const def = pickDefaultChannels(ws, { popId: menu.id === 'root' ? null : menu.id });
      y = x === def.ssc ? def.fsc : def.ssc;
    }
    addPlotAt(sheet.id, (px, py, w, h) => newPlotItem(type, x, type === 'histogram' ? x : y, px, py, w, h, menu.id));
  };
  const updPlot = (f: (p: PlotItem) => void) =>
    selPlot &&
    st.update((w) => {
      const it = w.worksheets.find((s) => s.id === sheet.id)!.items.find((i) => i.id === selPlot.id) as PlotItem;
      f(it);
    });
  return (
    <ContextMenu x={menu.x} y={menu.y} onClose={onClose}>
      <button onClick={() => newPlot('pseudo')}>New pseudocolor plot</button>
      <button onClick={() => newPlot('histogram')}>New histogram</button>
      {selPlot && (
        <>
          <button onClick={() => updPlot((p) => {
            if (p.layers[0]) setPlotPopulation(st.ws, p, menu.id, st.ui.activeSampleId);
            else p.layers.push({ id: uid('ly'), sample: 'active', population: menu.id });
            p.options.labelPos = {};
            p.options.labelOff = {};
          })}>Show in selected plot</button>
          <button onClick={() => updPlot((p) => {
            p.layers.push({ id: uid('ly'), sample: p.layers[0]?.sample ?? 'active', population: menu.id, color: pop?.color });
          })}>Overlay on selected plot</button>
        </>
      )}
      <hr />
      <button
        onClick={() => {
          st.update((w) => {
            let t = w.tables.find((x) => x.id === ui.activeTableId) ?? w.tables[0];
            if (!t) {
              t = { id: uid('tbl'), name: 'Table 1', sampleSet: 'all', columns: [] };
              w.tables.push(t);
            }
            t.columns.push({ id: uid('col'), population: menu.id, stat: 'freqParent' });
          });
          st.toast('Added % parent to the statistics table', 'success');
        }}
      >
        Add % parent to table
      </button>
      {pop && <button onClick={() => onRename(menu.id)}>Rename</button>}
      {(pop || clip) && <hr />}
      {pop && (
        <button title="Copy this gate to paste it under another population" onClick={() => copyGates(menu.id, false)}>
          Copy gate
        </button>
      )}
      {pop && hasKids && (
        <button title="Copy this gate and all populations below it" onClick={() => copyGates(menu.id, true)}>
          Copy gate with subpopulations
        </button>
      )}
      {clip && (
        <button
          title={`Paste ${clip} as new populations under this one`}
          onClick={() => {
            const made = pasteGates(menu.id === 'root' ? null : menu.id);
            if (made[0]) st.setUI({ selectedPopId: made[0].id });
          }}
        >
          Paste gate here
        </button>
      )}
      {pop && (
        <label className="menu-row">
          Color
          <input type="color" className="color-in" aria-label="Population color" value={pop.color} onChange={(e) => {
            const c = e.target.value;
            st.update((w) => {
              const p = w.populations.find((x) => x.id === menu.id);
              if (p) p.color = c;
            }, 'pc' + menu.id);
          }} />
        </label>
      )}
      <button onClick={() => st.setUI({ dialog: { kind: 'exportPop', payload: { popId: menu.id } } })}>Export events…</button>
      {pop && <ScopeItems pop={pop} />}
      {pop && (
        <>
          <hr />
          <button style={{ color: 'var(--danger)' }} onClick={() => deletePopulation(menu.id)}>
            Delete population
          </button>
        </>
      )}
    </ContextMenu>
  );
}

const menuLabel: React.CSSProperties = { padding: '4px 12px 2px', fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4 };

/** "Apply to" and "Copy gates to group" entries of the population menu (group- / sample-specific gating trees). */
function ScopeItems({ pop }: { pop: Population }) {
  const ws = useStore((s) => s.ws);
  const ui = useStore((s) => s.ui);
  const active = ui.activeSampleId ? ws.samples.find((s) => s.id === ui.activeSampleId) : undefined;
  const sel = ws.samples.filter((s) => ui.selectedSampleIds.includes(s.id));
  const sc = pop.scope;
  const only = (ids: string[]) => !!sc && !sc.groups?.length && sc.samples?.length === ids.length && ids.every((id) => sc.samples!.includes(id));
  const isGroup = (gid: string) => !!sc && !sc.samples?.length && sc.groups?.length === 1 && sc.groups[0] === gid;
  const mark = (on: boolean) => <span style={{ width: 12, display: 'inline-block', textAlign: 'center' }}>{on ? '✓' : ''}</span>;
  const inherited = !sc ? scopeOwner(ws, pop.id) : undefined;
  return (
    <>
      <hr />
      <div style={menuLabel} title="Samples outside show this population and the ones below it as n/a (not applicable), not as 0">
        Apply to{inherited ? ` (now: ${scopeLabel(ws, inherited.scope)}, from '${inherited.name}')` : ''}
      </div>
      <button onClick={() => setPopScope(pop.id, undefined)}>
        {mark(!sc)}All samples
      </button>
      {ws.groups.map((g) => (
        <button key={g.id} onClick={() => setPopScope(pop.id, { groups: [g.id] })} title={`${g.sampleIds.length} samples; samples added to the group later are included`}>
          {mark(isGroup(g.id))}Group {g.name}
        </button>
      ))}
      {active && (
        <button onClick={() => setPopScope(pop.id, { samples: [active.id] })} title={active.name}>
          {mark(only([active.id]))}This sample only ({active.name.length > 24 ? active.name.slice(0, 23) + '…' : active.name})
        </button>
      )}
      {sel.length > 1 && (
        <button onClick={() => setPopScope(pop.id, { samples: sel.map((s) => s.id) })}>
          {mark(only(sel.map((s) => s.id)))}Selected samples ({sel.length})
        </button>
      )}
      {sc && !ws.groups.some((g) => isGroup(g.id)) && !(active && only([active.id])) && !(sel.length > 1 && only(sel.map((s) => s.id))) && (
        <div style={{ ...menuLabel, textTransform: 'none', letterSpacing: 0 }}>{mark(true)}Now: {scopeLabel(ws, sc)}</div>
      )}
      {ws.groups.length > 0 && (
        <>
          <hr />
          {ws.groups.map((g) => (
            <button key={g.id} title={`Copy this gate and the populations below it for the samples of ${g.name}; the original stops applying to them`} onClick={() => copyGatesToGroup(pop.id, g.id)}>
              Copy gates to group {g.name}
            </button>
          ))}
        </>
      )}
    </>
  );
}
