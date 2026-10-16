// Workspace actions of the unmixing view: apply a draft (derived channels + display scales), worksheet of unmixed
// controls, spectra CSV export.
import type { DerivedOutput } from '../../core/derived';
import { engine } from '../../core/engine';
import { allChannels, MM, uid, type SheetItem, type TextItem, type Workspace } from '../../core/model';
import { defaultScaleFor, type ScaleDef } from '../../core/transforms';
import { resolveDetectors, similarityMatrix, unmixOutputNames, type UnmixDef } from '../../core/unmix';
import { saveFile, safeName } from '../../io/files';
import { dataLogicleScale, derivedOutputValues, upsertDerived } from '../../state/derivedOps';
import { addSheet, newPlotItem, useStore } from '../../state/store';
import { addItems } from '../layoutOps';
import type { Draft, DerivedWithSetup } from './draft';
import { plotPartners, spectraToCsv, spreadToCsv, unmixOutputRanges } from './helpers';

/** Measured and other derived channel names an unmixing's outputs must not collide with. */
export function takenChannelNames(ws: Workspace, defId: string): string[] {
  return allChannels({ ...ws, derived: (ws.derived ?? []).filter((d) => d.id !== defId) }).map((c) => c.name);
}

export function detectorRange(ws: Workspace, det: string): number {
  const l = det.toLowerCase();
  for (const s of ws.samples) {
    const c = s.channels.find((x) => x.name === det) ?? s.channels.find((x) => x.name.toLowerCase() === l);
    if (c && c.range > 0) return c.range;
  }
  return 0;
}

/** Output channels (names, ranges, labels) the definition would create. `markers[k]` labels endmember k. */
export function plannedOutputs(ws: Workspace, def: UnmixDef, markers: (string | undefined)[]): DerivedOutput[] {
  const names = unmixOutputNames(def, takenChannelNames(ws, def.id));
  const ranges = unmixOutputRanges(def, (d) => detectorRange(ws, d));
  return names.map((name, k) => {
    const o: DerivedOutput = { name, range: ranges[k] };
    const m = markers[k]?.trim();
    if (m) o.label = m;
    return o;
  });
}

/** Sample used to estimate the display scales: an experimental sample, else the unstained, else a control. */
function scaleSample(ws: Workspace, def: UnmixDef, draft: Draft): string | null {
  const ok = (id: string) => {
    const ds = engine.samples.get(id)?.ds;
    return !!ds && resolveDetectors(def, ds.channels.map((c) => c.name)).every((i) => i >= 0);
  };
  const controls = new Set(draft.setup.controls.map((c) => c.sampleId));
  const loaded = ws.samples.filter((s) => engine.has(s.id) && ok(s.id));
  const exp = loaded.find((s) => !controls.has(s.id) && s.id !== draft.setup.unstainedId);
  if (exp) return exp.id;
  if (draft.setup.unstainedId && loaded.some((s) => s.id === draft.setup.unstainedId)) return draft.setup.unstainedId;
  return loaded[0]?.id ?? null;
}

/** Write the definition to the workspace (undoable) with logicle display scales for new output channels. */
export function applyDraft(draft: Draft, def: UnmixDef, markers: (string | undefined)[]): DerivedWithSetup {
  const ws = useStore.getState().ws;
  const outputs = plannedOutputs(ws, def, markers);
  const existing = ws.derived?.find((d) => d.id === def.id);
  const derived: DerivedWithSetup = {
    id: def.id,
    kind: 'unmix',
    name: def.name,
    outputs,
    unmix: def,
    created: existing?.created ?? new Date().toISOString(),
    setup: JSON.parse(JSON.stringify(draft.setup)),
  };
  if (existing?.samples) derived.samples = existing.samples;
  const scales: Record<string, ScaleDef> = {};
  const sid = scaleSample(ws, def, draft);
  let outs: Float32Array[] | null = null;
  if (sid) {
    const tmp: Workspace = { ...ws, derived: [...(ws.derived ?? []).filter((d) => d.id !== def.id), derived] };
    outs = engine.derivedOutputs(tmp, sid, derived);
  }
  const afBest = def.includeAF && (def.af?.length ?? 0) > 1 && (def.afMode ?? 'best') === 'best';
  outputs.forEach((o, k) => {
    if (ws.scales[o.name]) return;
    if (afBest && k === def.endmembers.length + 1) scales[o.name] = { type: 'linear', min: 0, max: o.range + 1 };
    else {
      // top of the axis from the data of the experimental samples (robust maximum), not the theoretical output range
      const exp = (sid ? [sid] : []).concat(ws.samples.filter((s) => s.id !== sid && s.id !== draft.setup.unstainedId && !draft.setup.controls.some((c) => c.sampleId === s.id)).map((s) => s.id));
      const vals = derivedOutputValues(ws, derived, k, { sampleIds: exp, maxSamples: 6 });
      scales[o.name] = (vals.length ? dataLogicleScale(o.name, vals) : null) ?? defaultScaleFor(o.name, o.range, outs?.[k] ?? undefined, 'log');
    }
  });
  upsertDerived(derived, scales);
  return derived;
}

/**
 * New worksheet with the unmixed controls: one row per control (pinned to its sample), x = its own endmember,
 * y = the most similar other endmembers (where unmixing errors and spreading show) and AF.
 */
export function showUnmixPlots(defId: string): boolean {
  const st = useStore.getState();
  const ws = st.ws;
  const d = ws.derived?.find((x) => x.id === defId && x.kind === 'unmix') as DerivedWithSetup | undefined;
  if (!d) return false;
  const K = d.unmix.endmembers.length;
  const out = d.outputs.map((o) => o.name);
  const afOut = d.unmix.includeAF && d.unmix.af?.length ? K : -1;
  const partners = plotPartners(similarityMatrix(d.unmix.endmembers.map((e) => e.signature)), afOut >= 0 ? 4 : 5);
  const rows = (d.setup?.controls ?? [])
    .map((c, k) => ({ k, sid: c.sampleId, name: c.name }))
    .filter((r) => r.k < K && r.sid && engine.has(r.sid) && ws.samples.some((s) => s.id === r.sid)) as { k: number; sid: string; name: string }[];
  addSheet(`Unmixed: ${d.name}`.slice(0, 40));
  const after = useStore.getState();
  const sheet = after.ws.worksheets.find((s) => s.id === after.ui.activeSheetId);
  if (!sheet) return false;
  const g = sheet.grid || 10;
  const size = Math.max(g * 6, Math.round((40 * MM) / g) * g);
  const labelW = g * 7;
  const x0 = g * 2;
  let y = g * 2;
  const items: SheetItem[] = [];
  const text = (t: string, x: number, yy: number, w: number, h: number, opts: Partial<TextItem> = {}): TextItem => ({
    id: uid('txt'),
    kind: 'text',
    x,
    y: yy,
    w,
    h,
    text: t,
    fontSize: 10,
    bold: false,
    italic: false,
    align: 'left',
    // no color of its own: the page's text color (light on dark pages)
    color: '',
    ...opts,
  });
  items.push(text(`${d.name}: unmixed single-stain controls. x = the control's own endmember, y = the most similar endmembers${afOut >= 0 ? ' and AF' : ''}.`, x0, y, labelW + 5 * (size + g), g * 2, { fontSize: 9, italic: true }));
  y += g * 3;
  if (rows.length) {
    for (const r of rows) {
      items.push(text(r.name, x0, y + size / 2 - g, labelW - g, g * 2, { bold: true, align: 'right' }));
      const ys = [...partners[r.k], ...(afOut >= 0 ? [afOut] : [])];
      ys.forEach((j, c) => {
        const p = newPlotItem('pseudo', out[r.k], out[j], x0 + labelW + c * (size + g), y, size, size, 'root', r.sid);
        p.options.showTitle = false;
        items.push(p);
      });
      y += size + g;
    }
  } else {
    // no control samples (library spectra): pairwise overview of the first endmembers on the active sample
    const n = Math.min(K, 5);
    for (let i = 1; i < n; i++)
      for (let j = 0; j < i; j++) {
        const p = newPlotItem('pseudo', out[j], out[i], x0 + labelW + j * (size + g), y + (i - 1) * (size + g), size, size, 'root', 'active');
        p.options.showTitle = false;
        items.push(p);
      }
  }
  addItems(sheet.id, items, { select: false });
  return true;
}

export async function exportSpectraCsv(def: UnmixDef): Promise<void> {
  const ems = [...def.endmembers, ...(def.af ?? [])];
  await saveFile(`${safeName(def.name)}_spectra.csv`, spectraToCsv(def.detectors, ems));
}

export async function exportSpreadCsv(name: string, sp: { names: string[]; rows: number[]; ssm: number[][]; leakage: number[][] }): Promise<void> {
  await saveFile(`${safeName(name)}_spreading.csv`, spreadToCsv(sp.names, sp.rows, sp.ssm, sp.leakage));
}
