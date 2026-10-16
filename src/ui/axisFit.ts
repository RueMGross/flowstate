// "Fit to data": robust axis ranges from the events of the selected samples (e.g. after adding files from another
// instrument whose range differs from the one that set the workspace scales).
import { engine } from '../core/engine';
import { channelDisplayName, type Workspace } from '../core/model';
import { estimateLogicleW, isTimeChannel, type BaseScaleDef, type ScaleDef } from '../core/transforms';
import { freezeNote, scaleChangeFreeze, useStore, withScales } from '../state/store';
import { instrumentScaleKey } from '../core/instruments';

/** Fraction of events allowed beyond each end of a fitted axis. */
export const FIT_TAIL = 0.001;

/** Up to `max` finite values spread evenly over the arrays (each array contributes in proportion to its size). */
export function poolValues(arrays: Float32Array[], max = 200000): Float32Array {
  const total = arrays.reduce((a, x) => a + x.length, 0);
  if (!total) return new Float32Array(0);
  const step = Math.max(1, total / max);
  const out = new Float32Array(Math.min(total, max + arrays.length));
  let n = 0;
  for (const a of arrays) {
    for (let i = 0; i < a.length && n < out.length; i += step) {
      const v = a[Math.floor(i)];
      if (Number.isFinite(v)) out[n++] = v;
    }
  }
  return out.slice(0, n);
}

/** Smallest "nice" number (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 x 10^n) at or above v (v > 0). */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v * (1 - 1e-12)) return m * p;
  return 10 * p;
}

const q = (sorted: Float32Array, f: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * f)))];

/**
 * A scale of the same kind as `like` (linear, log, biex / logicle, arcsinh) whose range holds the data between the 0.1th
 * and 99.9th percentile, with nice round ends; logicle width W is estimated from the negative events. Null without data.
 */
export function fitScale(like: ScaleDef | undefined, values: Float32Array, channel: string): BaseScaleDef | null {
  const base: BaseScaleDef = !like ? { type: 'linear', min: 0, max: 262144 } : like.type === 'window' ? like.base : like;
  const sorted = values.filter((v) => Number.isFinite(v)).sort();
  if (sorted.length < 10) return null;
  const lo = q(sorted, FIT_TAIL);
  const hi = q(sorted, 1 - FIT_TAIL);
  const top = hi > 0 ? niceCeil(hi * 1.1) : 1;
  switch (base.type) {
    case 'linear': {
      if (isTimeChannel(channel)) return { type: 'linear', min: 0, max: niceCeil(sorted[sorted.length - 1] * 1.01) };
      const min = lo >= 0 ? 0 : -niceCeil(-lo * 1.1);
      const max = hi > 0 ? top : niceCeil(Math.abs(min) * 0.1);
      return { type: 'linear', min, max };
    }
    case 'log': {
      let firstPos = 0;
      while (firstPos < sorted.length && !(sorted[firstPos] > 0)) firstPos++;
      const pos = sorted.subarray(firstPos);
      if (pos.length < 10) return null;
      const max = niceCeil(q(pos, 1 - FIT_TAIL) * 1.1);
      const lowPos = q(pos, FIT_TAIL);
      const min = Math.max(Math.pow(10, Math.floor(Math.log10(lowPos))), max / 1e7);
      return { type: 'log', min, max, ...(base.clampLow ? { clampLow: true } : {}) };
    }
    case 'logicle': {
      const T = top;
      const M = Math.max(4.5, Math.round((4.5 + Math.max(0, Math.log10(T) - Math.log10(262144))) * 4) / 4);
      const W = Math.round(estimateLogicleW(values, T, M) * 100) / 100;
      const A = Math.min(base.A, M - 2 * W);
      return { type: 'logicle', T, W, M, A: Math.max(-W, A) };
    }
    case 'arcsinh':
      return { type: 'arcsinh', T: top, M: base.M, A: base.A };
  }
}

/** Samples whose events define a fit: the selected samples, else the active one, else all loaded samples. */
export function fitSampleIds(): string[] {
  const { ws, ui } = useStore.getState();
  const loaded = (id: string) => engine.has(id) && ws.samples.some((s) => s.id === id);
  const sel = ui.selectedSampleIds.filter(loaded);
  if (sel.length > 1) return sel;
  if (ui.activeSampleId && loaded(ui.activeSampleId)) return [ui.activeSampleId];
  if (sel.length) return sel;
  return ws.samples.map((s) => s.id).filter(loaded);
}

/** Short description of the samples a fit uses, e.g. "Donor A stim" or "3 selected samples". */
export function fitSampleLabel(ids: string[] = fitSampleIds()): string {
  const ws = useStore.getState().ws;
  if (!ids.length) return 'no loaded sample';
  if (ids.length === 1) return ws.samples.find((s) => s.id === ids[0])?.name ?? '1 sample';
  return `${ids.length} selected samples`;
}

/** Pooled events of a channel in the given samples (compensated values, as gates and axes see them). */
export function channelValues(ws: Workspace, channel: string, sampleIds: string[]): Float32Array {
  const arrays: Float32Array[] = [];
  for (const id of sampleIds) {
    const a = engine.raw(ws, id, channel);
    if (a && a.length) arrays.push(a);
  }
  return poolValues(arrays);
}

/** Fit a channel's scale (keeping its kind) to the data of the fit samples; null without data. */
export function fitChannel(ws: Workspace, channel: string, like: ScaleDef | undefined, sampleIds = fitSampleIds()): BaseScaleDef | null {
  return fitScale(like, channelValues(ws, channel, sampleIds), channel);
}

/** "Fit all axes to data": the workspace scales of every channel plotted on the sheet, and per-plot axis overrides there. */
export function fitAllAxes(sheetId: string) {
  const st = useStore.getState();
  const ws = st.ws;
  const sheet = ws.worksheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  const ids = fitSampleIds();
  if (!ids.length) {
    st.toast('Load a sample first: axes are fitted to its events.', 'info');
    return;
  }
  const chans = new Set<string>();
  for (const it of sheet.items)
    if (it.kind === 'plot') {
      chans.add(it.xParam);
      if (it.plotType !== 'histogram') chans.add(it.yParam);
    }
  const fitted = new Map<string, BaseScaleDef>();
  // per-instrument scales: the samples of an instrument with its own scale of a channel fit that scale
  const instFitted: { inst: string; ch: string; def: BaseScaleDef }[] = [];
  for (const ch of chans) {
    if (!ws.instrumentScales) {
      const f = fitChannel(ws, ch, ws.scales[ch], ids);
      if (f) fitted.set(ch, f);
      continue;
    }
    const byInst = new Map<string, string[]>();
    for (const id of ids) {
      const k = instrumentScaleKey(ws, ch, id, engine.keywordsOf) ?? '';
      byInst.set(k, [...(byInst.get(k) ?? []), id]);
    }
    for (const [k, gids] of byInst) {
      const f = fitChannel(ws, ch, k ? ws.instrumentScales[k]?.[ch] : ws.scales[ch], gids);
      if (!f) continue;
      if (k) instFitted.push({ inst: k, ch, def: f });
      else fitted.set(ch, f);
    }
  }
  const overrides: { id: string; axis: 'x' | 'y'; def: BaseScaleDef }[] = [];
  for (const it of sheet.items) {
    if (it.kind !== 'plot') continue;
    for (const axis of ['x', 'y'] as const) {
      const ov = axis === 'x' ? it.options.xScale : it.options.yScale;
      if (!ov) continue;
      const f = fitChannel(ws, axis === 'x' ? it.xParam : it.yParam, ov, ids);
      if (f) overrides.push({ id: it.id, axis, def: f });
    }
  }
  if (!fitted.size && !overrides.length && !instFitted.length) {
    st.toast('No plotted channel has data in ' + fitSampleLabel(ids) + '.', 'info');
    return;
  }
  // polygon / ellipse gates drawn in the app follow the axes: those whose evaluation changes keep their former scales
  // (per instrument where samples are evaluated on different scales), so no count changes
  const inst: Record<string, Record<string, ScaleDef>> = {};
  for (const f of instFitted) (inst[f.inst] ??= {})[f.ch] = f.def;
  const freeze = scaleChangeFreeze(ws, withScales(ws, Object.fromEntries(fitted), inst));
  st.update((w) => {
    freeze?.apply(w);
    for (const [ch, def] of fitted) w.scales[ch] = def;
    for (const f of instFitted) {
      const m = w.instrumentScales?.[f.inst];
      if (m) m[f.ch] = f.def;
    }
    const sh = w.worksheets.find((s) => s.id === sheetId);
    for (const o of overrides) {
      const it = sh?.items.find((i) => i.id === o.id);
      if (it?.kind !== 'plot') continue;
      if (o.axis === 'x') it.options.xScale = o.def;
      else it.options.yScale = o.def;
    }
  });
  const after = useStore.getState().ws;
  const names = [...fitted.keys()].map((c) => channelDisplayName(ws, c, 'short'));
  const kept = freezeNote(ws, freeze);
  st.toast(`Fitted ${fitted.size + overrides.length + instFitted.length} axes to ${fitSampleLabel(ids)}${names.length ? ` (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''})` : ''}.${kept}`, 'success', {
    action: {
      label: 'Undo',
      run: () => {
        const s = useStore.getState();
        if (s.ws === after) s.undo();
        else s.toast('Other changes were made since. Use Undo (Ctrl+Z) to step back.', 'info');
      },
    },
  });
}
