// Plate operations of the interface: plates and wells set by hand, plate names and formats, layouts (annotations) and
// groups made from them, re-detection, the plate view settings and the plate heatmap figure item.
import { engine } from '../core/engine';
import { uid, type ChartItem, type PlateDef, type PlateViewSettings, type StatColumn, type Workspace } from '../core/model';
import { annotationGroups, normWell, parseWell, wellId, type PlateFormat, type PlateView } from '../core/plate';
import { layoutOf } from '../render/plateChart';
import { activeSheetOf, placeSamples, useStore } from './store';
import { bodyPt } from '../render/figstyle';
import type { Draft } from 'immer';

/** Plates of the workspace as shown (stored and detected placements). */
export function currentLayout(ws: Workspace = useStore.getState().ws) {
  return layoutOf(ws, engine);
}

/**
 * Store the placements detected for samples never placed (older workspaces), so that changes by hand start from what
 * the plate view shows. Part of the undo step `key`.
 */
export function materializePlates(key?: string) {
  const ws = useStore.getState().ws;
  if (ws.samples.some((s) => s.wellSource === undefined)) placeSamples([], { key });
}

const findDef = (w: Draft<Workspace>, name: string): Draft<PlateDef> => {
  w.plates ??= [];
  let d = w.plates.find((p) => p.name === name);
  if (!d) {
    // a plate known only from its samples (or new): its definition, with the format holding its wells
    const wells = w.samples.filter((s) => s.plate === name && s.well).map((s) => parseWell(s.well)!);
    const big = wells.some((p) => p && (p.row >= 8 || p.col >= 12));
    d = { name, rows: big ? 16 : 8, cols: big ? 24 : 12 };
    w.plates.push(d);
  }
  return d;
};

/** Rename a plate (samples, layouts and plate heatmaps follow). False when the name is taken or empty. */
export function renamePlate(from: string, to: string): boolean {
  const name = to.trim();
  const st = useStore.getState();
  if (!name || name === from) return false;
  const layout = currentLayout();
  if (layout.plates.some((p) => p.name === name) || st.ws.plates?.some((p) => p.name === name)) {
    st.toast(`A plate named "${name}" exists already.`, 'error');
    return false;
  }
  const key = 'plate-rename:' + uid('r');
  materializePlates(key);
  st.update((w) => {
    findDef(w, from).name = name;
    for (const s of w.samples) if (s.plate === from) s.plate = name;
    for (const sh of w.worksheets) for (const it of sh.items) if (it.kind === 'chart' && it.plate?.plate === from) it.plate.plate = name;
  }, key);
  if (st.ui.activePlate === from) st.setUI({ activePlate: name });
  return true;
}

/** Change the format of a plate (rows x columns); wells outside it keep their samples (shown when it grows again). */
export function setPlateFormat(name: string, f: PlateFormat) {
  const key = 'plate-format:' + uid('f');
  materializePlates(key);
  useStore.getState().update((w) => {
    const d = findDef(w, name);
    d.rows = f.rows;
    d.cols = f.cols;
  }, key);
}

/**
 * Put samples into wells by hand (wellSource 'manual'); a well of null takes a sample off its plate. With `swap`, the
 * samples already in a target well move to where the sample came from (drag and drop onto a taken well).
 */
export function setWells(list: { id: string; plate: string; well: string | null }[], opts: { swap?: boolean; quiet?: boolean } = {}) {
  const st = useStore.getState();
  if (!list.length) return;
  const key = 'set-well:' + uid('w');
  materializePlates(key);
  const before = currentLayout();
  st.update((w) => {
    for (const a of list) {
      const s = w.samples.find((x) => x.id === a.id);
      if (!s) continue;
      const well = a.well ? normWell(a.well) : null;
      if (opts.swap && well) {
        const from = before.plates.find((p) => p.name === s.plate);
        const fromWell = s.plate === a.plate ? s.well : undefined;
        const others = before.plates.find((p) => p.name === a.plate)?.wells.get(well)?.filter((id) => id !== s.id) ?? [];
        for (const oid of others) {
          const o = w.samples.find((x) => x.id === oid);
          if (!o || !from || !fromWell) continue;
          o.well = fromWell;
          o.plate = s.plate;
          o.wellSource = 'manual';
        }
      }
      if (well) {
        s.well = well;
        s.plate = a.plate;
        findDef(w, a.plate);
      } else {
        delete s.well;
        delete s.plate;
      }
      s.wellSource = 'manual';
    }
    // the format grows to hold the wells
    for (const d of w.plates ?? []) {
      const ps = w.samples.filter((s) => s.plate === d.name && s.well).map((s) => parseWell(s.well)!);
      if (ps.some((p) => p.row >= d.rows || p.col >= d.cols)) {
        d.rows = Math.max(d.rows, ...ps.map((p) => (p.row >= 8 ? 16 : 8)));
        d.cols = Math.max(d.cols, ...ps.map((p) => (p.col >= 12 ? 24 : 12)));
      }
    }
  }, key);
  if (!opts.quiet) {
    const n = list.length;
    const a = list[0];
    const nm = st.ws.samples.find((s) => s.id === a.id)?.name ?? '';
    st.toast(a.well ? (n === 1 ? `'${nm}' set to ${a.plate}, well ${a.well}` : `${n} samples placed on ${a.plate}`) : n === 1 ? `'${nm}' taken off its plate` : `${n} samples taken off their plates`, 'info', {
      action: { label: 'Undo', run: () => useStore.getState().undo() },
    });
  }
}

/** Wells from `start` on, by rows (A01, A02 ...) or columns (A01, B01 ...), for `n` samples (null: past the plate). */
export function fillOrder(f: PlateFormat, start: string, n: number, by: 'rows' | 'cols'): (string | null)[] {
  const s = parseWell(start) ?? { row: 0, col: 0 };
  const total = f.rows * f.cols;
  let i = by === 'rows' ? s.row * f.cols + s.col : s.col * f.rows + s.row;
  const out: (string | null)[] = [];
  for (let k = 0; k < n; k++, i++) {
    if (i >= total) out.push(null);
    else out.push(by === 'rows' ? wellId(Math.floor(i / f.cols), i % f.cols) : wellId(i % f.rows, Math.floor(i / f.rows)));
  }
  return out;
}

/** Set (or remove: empty value) an annotation of wells of a plate, e.g. Compound = Drug A. */
export function annotateWells(plate: string, wells: string[], key: string, value: string) {
  annotateWellValues(wells.map((well) => ({ plate, well, value })), key);
}

/** Set an annotation key of wells to values of their own (empty: remove), in one undo step. */
export function annotateWellValues(entries: { plate: string; well: string; value: string }[], key: string) {
  const k = key.trim();
  if (!k || !entries.length) return;
  const ukey = 'annotate:' + uid('a');
  materializePlates(ukey);
  useStore.getState().update((w) => {
    for (const e of entries) {
      const id = normWell(e.well);
      if (!id) continue;
      const v = e.value.trim();
      const d = findDef(w, e.plate);
      const ann = (d.annotations ??= {});
      if (v) (ann[id] ??= {})[k] = v;
      else if (ann[id]) {
        delete ann[id][k];
        if (!Object.keys(ann[id]).length) delete ann[id];
      }
      if (!Object.keys(ann).length) delete d.annotations;
    }
  }, ukey);
}

/** Remove an annotation key from all wells of all plates. */
export function removeAnnotationKey(key: string) {
  useStore.getState().update((w) => {
    for (const d of w.plates ?? []) {
      if (!d.annotations) continue;
      for (const [well, a] of Object.entries(d.annotations)) {
        delete a[key];
        if (!Object.keys(a).length) delete d.annotations[well];
      }
      if (!Object.keys(d.annotations).length) delete d.annotations;
    }
    if (w.plateView?.overlay === key) delete w.plateView.overlay;
  });
}

const GROUP_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#8c564b', '#e377c2', '#bcbd22', '#7f7f7f'];

/**
 * One sample group per value of an annotation ("Compound: Drug A"): groups of the same name are updated (their
 * members replaced), so making them again after changing the layout keeps scopes and charts that use them.
 */
export function groupsFromAnnotation(key: string): number {
  const st = useStore.getState();
  const vals = annotationGroups(currentLayout().plates, key).filter((g) => g.sampleIds.length);
  if (!vals.length) {
    st.toast(`No samples are in wells with "${key}" set.`, 'info');
    return 0;
  }
  let made = 0;
  st.update((w) => {
    for (const g of vals) {
      const name = `${key}: ${g.value}`;
      const ex = w.groups.find((x) => x.name === name);
      if (ex) ex.sampleIds = [...g.sampleIds];
      else {
        w.groups.push({ id: uid('grp'), name, color: GROUP_COLORS[w.groups.length % GROUP_COLORS.length], sampleIds: [...g.sampleIds] });
        made++;
      }
    }
  });
  st.toast(`${vals.length} group${vals.length > 1 ? 's' : ''} from "${key}" (${made} new, ${vals.length - made} updated). Use them in charts (Compare: Groups), tables and gate scopes.`, 'success', {
    action: { label: 'Undo', run: () => useStore.getState().undo() },
  });
  return vals.length;
}

/** Detect plates and wells again for all samples not set by hand (plates keep their names, formats and layouts). */
export function redetectWells() {
  const st = useStore.getState();
  const ids = st.ws.samples.map((s) => s.id);
  const r = placeSamples(ids, { all: true, key: 'redetect:' + uid('r') });
  const manual = st.ws.samples.filter((s) => s.wellSource === 'manual').length;
  if (!r || !r.wells) st.toast(`No wells found in the keywords or names of the samples${manual ? ` (${manual} set by hand kept)` : ''}. Set wells by hand: right-click a sample, "Set well...".`, 'info', { duration: 9000 });
  else
    st.toast(`Wells detected for ${r.wells} sample${r.wells > 1 ? 's' : ''} on ${r.plates.length} plate${r.plates.length > 1 ? 's' : ''}${manual ? ` (${manual} set by hand kept)` : ''}${r.notes.length ? `; ${r.notes.join('; ')}` : ''}.`, 'success', {
      action: { label: 'Undo', run: () => useStore.getState().undo() },
    });
}

// ---------------------------------------------------------------- plate view settings

/** Plate view settings of the workspace, or the defaults: % parent of the selected (else the last) population. */
export function plateViewSettings(ws: Workspace = useStore.getState().ws): PlateViewSettings {
  if (ws.plateView) return ws.plateView;
  const ui = useStore.getState().ui;
  const pop = (ui.selectedPopId && ws.populations.some((p) => p.id === ui.selectedPopId) ? ui.selectedPopId : ws.populations[ws.populations.length - 1]?.id) ?? 'root';
  return { stat: { id: 'plate-stat', population: pop, stat: pop === 'root' ? 'count' : 'freqParent' }, colormap: 'viridis', values: true, decimals: 1, arrange: 'row' };
}

export function updatePlateView(f: (pv: Draft<PlateViewSettings>) => void, key?: string) {
  const st = useStore.getState();
  const cur = plateViewSettings(st.ws);
  st.update((w) => {
    if (!w.plateView) w.plateView = structuredClone(cur);
    f(w.plateView);
  }, key);
}

/**
 * Plate heatmaps of the plate view's statistic and look for the active worksheet (one per plate, in rows below the
 * content of the sheet). Several plates share the color range (`shared`: automatic over all plates, or the fixed one
 * of the plate view), so they compare like on screen.
 */
export function addPlateHeatmaps(plates: string[]): ChartItem[] {
  const st = useStore.getState();
  const ws = st.ws;
  const pv = plateViewSettings(ws);
  const sheet = activeSheetOf(ws);
  const g = sheet.grid > 0 ? sheet.grid : 10;
  const items: ChartItem[] = [];
  const W = g * 20;
  const H = g * 13;
  const perRow = Math.max(1, Math.floor((sheet.page.w - 2 * g) / (W + g)));
  const bottom = Math.ceil(Math.max(g * 2, ...sheet.items.map((i) => i.y + i.h + g)) / g) * g;
  // a fixed range of the plate view is kept; an automatic one of several plates stays automatic over all plates (it
  // follows gate changes like the plate view does)
  const range = pv.range;
  const share = plates.length > 1 && !range;
  plates.forEach((name, i) => {
    const stat: StatColumn = { ...pv.stat, id: uid('col') };
    items.push({
      id: uid('chart'),
      kind: 'chart',
      x: g * 2 + (i % perRow) * (W + g),
      y: bottom + Math.floor(i / perRow) * (H + g),
      w: W,
      h: H,
      stat,
      mode: 'samples',
      sampleSet: 'all',
      samples: [],
      style: 'bar',
      errorBars: 'none',
      showPoints: false,
      color: '#5b8fd1',
      useGroupColors: false,
      fontSize: bodyPt(ws, sheet),
      lineWidth: 1,
      plate: { plate: name, colormap: pv.colormap, ...(pv.reverse ? { reverse: true } : {}), ...(range ? { range: [...range] as [number, number] } : {}), ...(share ? { shared: true } : {}), values: pv.values !== false, decimals: pv.decimals ?? 1, legend: true },
    });
  });
  return items;
}

/** The samples of a plate in a set of wells (helper for menus). */
export function plateSamples(p: PlateView, wells: string[]): string[] {
  const out: string[] = [];
  for (const w of wells) out.push(...(p.wells.get(w) ?? []));
  return out;
}

/** The plate a sample is on (as shown), if any. */
export function plateOfSample(id: string): { plate: PlateView; well: string } | null {
  for (const p of currentLayout().plates) for (const [w, ids] of p.wells) if (ids.includes(id)) return { plate: p, well: w };
  return null;
}

