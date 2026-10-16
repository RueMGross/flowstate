// A plate of wells (8 x 12, 16 x 24 ...) with row letters and column numbers. Wells select their samples like rows of
// the sample list (one shared selection): click, Ctrl/Cmd-click, Shift-click (a block), drag a rectangle, a row letter /
// column number for the row / column, the corner for all; arrows move the active well, Shift+arrows extend the block.
import { useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { allWells, colWells, nextOccupied, parseWell, pickWells, ROW_LETTERS, rowWells, stepWell, wellId, wellsBetween, type PlateView } from '../core/plate';
import { engine } from '../core/engine';
import { removeSamples, useStore } from '../state/store';
import { DND_TYPE } from './SheetView';

/** Anchor of Shift-click / Shift+arrows and the keyboard cursor, per plate (shared by the panel and the plate view). */
const anchors = new Map<string, { anchor: string; cursor: string }>();

export interface PlateGridProps {
  plate: PlateView;
  /** well size in CSS px */
  cell: number;
  /** large view: rounded wells with text */
  big?: boolean;
  /** fill of a well (heatmap), null: the state colors */
  fill?: (well: string) => string | null;
  /** text color on that fill */
  ink?: (well: string) => string | null;
  /** value printed in the well */
  text?: (well: string) => string | null;
  /** second line (annotation) */
  sub?: (well: string) => string | null;
  /** wells with samples but no value: hatched */
  na?: (well: string) => boolean;
  /** wells whose samples are outside the sample list filter (a group): dimmed */
  dim?: (well: string) => boolean;
  tooltip: (well: string) => string;
  /** group color of a well's (first) sample: a small mark */
  mark?: (well: string) => string | null;
  onContextMenu?: (well: string | null, x: number, y: number) => void;
  /** a sample dragged from the sample list (or another well) dropped on a well */
  onDropSample?: (sampleId: string, well: string) => void;
  /** Enter / double-click: open the active sample */
  onOpen?: () => void;
}

function wellAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  return (el?.closest('[data-well]') as HTMLElement | null)?.dataset.well ?? null;
}

export function PlateGrid(props: PlateGridProps) {
  const { plate, cell, big } = props;
  const selIds = useStore((s) => s.ui.selectedSampleIds);
  const active = useStore((s) => s.ui.activeSampleId);
  const [dropWell, setDropWell] = useState<string | null>(null);
  const drag = useRef<{ start: string; base: string[]; add: boolean; moved: boolean; shift: boolean; ctrl: boolean; id: number } | null>(null);
  const [rubber, setRubber] = useState<string[] | null>(null);
  const st = useStore.getState();
  const selSet = new Set(selIds.length ? selIds : active ? [active] : []);
  const state = () => {
    const ui = useStore.getState().ui;
    return { selected: ui.selectedSampleIds, active: ui.activeSampleId };
  };
  const apply = (wells: string[], mode: 'set' | 'add' | 'toggle', focus?: string, base?: { selected: string[]; active: string | null }) => {
    const r = pickWells(base ?? state(), plate, wells, mode, focus);
    st.setUI({ selectedSampleIds: r.selected, activeSampleId: r.active });
  };
  const anc = () => anchors.get(plate.name);
  const setAnchor = (anchor: string, cursor = anchor) => anchors.set(plate.name, { anchor, cursor });

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const well = (e.target as HTMLElement).closest('[data-well]') as HTMLElement | null;
    if (!well?.dataset.well) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    const ctrl = e.ctrlKey || e.metaKey;
    drag.current = { start: well.dataset.well, base: state().selected, add: ctrl, moved: false, shift: e.shiftKey, ctrl, id: e.pointerId };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const w = wellAt(e.clientX, e.clientY);
    if (!w || (w === d.start && !d.moved)) return;
    d.moved = true;
    const rect = wellsBetween(d.start, w);
    setRubber(rect);
    const base = { selected: d.add ? d.base : [], active: useStore.getState().ui.activeSampleId };
    apply(rect, d.add ? 'add' : 'set', undefined, base);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    setRubber(null);
    if (d.moved) {
      const w = wellAt(e.clientX, e.clientY) ?? d.start;
      setAnchor(d.start, w);
      return;
    }
    const w = d.start;
    const a = anc()?.anchor;
    if (d.shift && a) {
      apply(wellsBetween(a, w), d.ctrl ? 'add' : 'set', w);
      anchors.set(plate.name, { anchor: a, cursor: w });
      return;
    }
    apply([w], d.ctrl ? 'toggle' : 'set', w);
    setAnchor(w);
  };
  const header = (wells: string[], e: React.MouseEvent) => {
    e.preventDefault();
    apply(wells, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'set');
    if (wells[0]) setAnchor(wells[0], wells[wells.length - 1]);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const dirs: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const mod = e.ctrlKey || e.metaKey;
    const activeWell = (() => {
      const id = useStore.getState().ui.activeSampleId;
      for (const [w, ids] of plate.wells) if (id && ids.includes(id)) return w;
      return null;
    })();
    if (dirs[e.key]) {
      e.preventDefault();
      e.stopPropagation();
      const [dr, dc] = dirs[e.key];
      const cur = anc();
      if (e.shiftKey) {
        // extend the block from the anchor by one well
        const anchor = cur?.anchor ?? activeWell ?? 'A01';
        const cursor = stepWell(plate, cur?.cursor ?? anchor, dr, dc);
        anchors.set(plate.name, { anchor, cursor });
        apply(wellsBetween(anchor, cursor), 'set', plate.wells.get(cursor)?.length ? cursor : undefined);
        return;
      }
      const from = activeWell ?? cur?.cursor ?? null;
      const next = from ? nextOccupied(plate, from, dr, dc) : allWells(plate).find((w) => plate.wells.get(w)?.length) ?? null;
      if (!next) return;
      apply([next], 'set', next);
      setAnchor(next);
      e.currentTarget.querySelector(`[data-well="${next}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      props.onOpen?.();
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      apply(allWells(plate), 'set');
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      const ui = useStore.getState().ui;
      const sel = ui.selectedSampleIds.length ? ui.selectedSampleIds : ui.activeSampleId ? [ui.activeSampleId] : [];
      if (sel.length) removeSamples(sel);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      const ws = allWells(plate).filter((w) => plate.wells.get(w)?.length);
      const w = e.key === 'Home' ? ws[0] : ws[ws.length - 1];
      if (w) {
        apply([w], 'set', w);
        setAnchor(w);
      }
    }
  };
  const isOurDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DND_TYPE);
  const drop = (e: DragEvent, well: string) => {
    setDropWell(null);
    if (!isOurDrag(e) || !props.onDropSample) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const d = JSON.parse(e.dataTransfer.getData(DND_TYPE)) as { type: string; id: string };
      if (d.type === 'sample') props.onDropSample(d.id, well);
    } catch {
      /* not ours */
    }
  };
  const hdr = big ? Math.max(18, Math.round(cell * 0.45)) : Math.max(13, Math.round(cell * 0.75));
  const rubberSet = new Set(rubber ?? []);
  // the longest value of the plate sets the text size of all wells (one size on a plate, and every value fits)
  let maxLen = 3;
  if (big && props.text) for (const [w, wids] of plate.wells) if (wids.length) maxLen = Math.max(maxLen, props.text(w)?.length ?? 0);
  const style = { '--cell': `${cell}px`, '--hdr': `${hdr}px`, '--len': maxLen, gridTemplateColumns: `var(--hdr) repeat(${plate.cols}, var(--cell))` } as CSSProperties;
  const corner = allWells(plate);
  return (
    <div
      className={`plate-grid${big ? ' big' : ''}`}
      style={style}
      role="grid"
      aria-label={`Plate ${plate.name}: ${plate.rows} x ${plate.cols} wells`}
      aria-multiselectable="true"
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = null;
        setRubber(null);
      }}
      onKeyDown={key}
      onContextMenu={(e) => {
        if (!props.onContextMenu) return;
        e.preventDefault();
        const w = (e.target as HTMLElement).closest('[data-well]') as HTMLElement | null;
        props.onContextMenu(w?.dataset.well ?? null, e.clientX, e.clientY);
      }}
      onDoubleClick={(e) => {
        // (the pointer is captured by the grid while pressed: the target is the grid, the well is the one under the pointer)
        if (wellAt(e.clientX, e.clientY)) props.onOpen?.();
      }}
    >
      <div role="row" className="pg-row" style={{ display: 'contents' }}>
        <button className="pg-corner" title="Select all wells of the plate" aria-label="Select all wells" onClick={(e) => header(corner, e)} />
        {Array.from({ length: plate.cols }, (_, c) => (
          <button key={c} className="pg-col" role="columnheader" aria-label={`Column ${c + 1}`} title={`Column ${c + 1}: select (Ctrl: add or remove)`} onClick={(e) => header(colWells(plate, c), e)}>
            {/* small wells: every other number (two digits do not fit) */}
            {cell >= 15 || c % 2 === 0 ? c + 1 : ''}
          </button>
        ))}
      </div>
      {Array.from({ length: plate.rows }, (_, r) => (
        <div key={r} role="row" style={{ display: 'contents' }}>
          <button className="pg-rowh" role="rowheader" aria-label={`Row ${ROW_LETTERS[r]}`} title={`Row ${ROW_LETTERS[r]}: select (Ctrl: add or remove)`} onClick={(e) => header(rowWells(plate, r), e)}>
            {ROW_LETTERS[r]}
          </button>
          {Array.from({ length: plate.cols }, (_, c) => {
            const w = wellId(r, c);
            const ids = plate.wells.get(w) ?? [];
            const has = ids.length > 0;
            const on = !!active && ids.includes(active);
            const sel = has && ids.some((id) => selSet.has(id));
            const missing = has && ids.every((id) => !engine.has(id));
            const fill = has ? props.fill?.(w) ?? null : null;
            const na = has && !fill && !!props.na?.(w);
            const txt = has ? props.text?.(w) : null;
            const sub = props.sub?.(w);
            const mark = has ? props.mark?.(w) : null;
            const cls = `pw${has ? ' has' : ''}${sel ? ' sel' : ''}${on ? ' on' : ''}${missing ? ' miss' : ''}${na ? ' na' : ''}${fill ? ' filled' : ''}${rubberSet.has(w) ? ' rb' : ''}${dropWell === w ? ' drop' : ''}${has && props.dim?.(w) ? ' dim' : ''}`;
            return (
              <div
                key={w}
                role="gridcell"
                aria-selected={sel}
                aria-label={`${w}${has ? '' : ', empty'}`}
                data-well={w}
                className={cls}
                title={props.tooltip(w)}
                style={fill ? ({ '--fill': fill, color: props.ink?.(w) ?? undefined } as CSSProperties) : undefined}
                onDragOver={(e) => {
                  if (!props.onDropSample || !isOurDrag(e)) return;
                  e.preventDefault();
                  // (the sample list offers its rows as 'copy')
                  e.dataTransfer.dropEffect = 'copy';
                  if (dropWell !== w) setDropWell(w);
                }}
                onDragLeave={() => dropWell === w && setDropWell(null)}
                onDrop={(e) => drop(e, w)}
              >
                {big && (txt || sub) ? (
                  <span className="pw-txt">
                    {txt && (
                      <span className="pw-v">{txt}</span>
                    )}
                    {sub && <span className="pw-s">{sub}</span>}
                  </span>
                ) : null}
                {ids.length > 1 && <span className="pw-n" aria-hidden="true">{ids.length}</span>}
                {mark && <span className="pw-g" style={{ background: mark }} aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Wells of a plate holding a sample (helper for tests of the UI and menus). */
export const occupiedWells = (p: PlateView) => allWells(p).filter((w) => p.wells.get(w)?.length);
export { parseWell };
