// Instruments of samples and per-instrument axis scales (Workspace.instrumentScales).
//
// Files from different cytometers can share channel names with very different ranges (BD FSC-A up to 262,144,
// CytoFLEX FSC-A up to 16.7 million). A workspace may hold, per instrument, its own scale for such a channel; the
// workspace scale (Workspace.scales) is used for every other instrument and channel. A workspace without
// instrumentScales behaves exactly as before (one scale per channel).
import type { SampleRef, Workspace } from './model';
import type { ScaleDef } from './transforms';

/** Keywords of a loaded sample's file (for samples saved before SampleRef.instrument existed). */
export type KeywordsOf = (sampleId: string) => Record<string, string> | undefined;

/** Instrument key of an FCS data set: $CYT, plus the serial number ($CYTSN) when the file has one; '' when unknown. */
export function instrumentKeyOf(keywords: Record<string, string> | undefined): string {
  const cyt = (keywords?.['$CYT'] ?? '').replace(/\s+/g, ' ').trim();
  const sn = (keywords?.['$CYTSN'] ?? '').replace(/\s+/g, ' ').trim();
  if (!cyt) return sn ? `S/N ${sn}` : '';
  return sn && !cyt.includes(sn) ? `${cyt} (${sn})` : cyt;
}

const byId = new WeakMap<SampleRef[], Map<string, SampleRef>>();
function sampleOf(ws: Workspace, id: string): SampleRef | undefined {
  let m = byId.get(ws.samples);
  if (!m) byId.set(ws.samples, (m = new Map(ws.samples.map((s) => [s.id, s]))));
  return m.get(id);
}

/**
 * Instrument key of a workspace sample: stored on the sample when it was loaded; for older workspaces derived from its
 * file's keywords (when loaded) or from the cytometer noted in its info. '' when unknown.
 */
export function sampleInstrument(ws: Workspace, sampleId: string, keywordsOf?: KeywordsOf): string {
  const s = sampleOf(ws, sampleId);
  if (!s) return '';
  if (typeof s.instrument === 'string') return s.instrument;
  const kw = keywordsOf?.(sampleId);
  if (kw) return instrumentKeyOf(kw);
  return (s.info?.['Cytometer'] ?? '').replace(/\s+/g, ' ').trim();
}

/** The instrument whose own scale of `ch` applies to a sample, or null when it uses the workspace scale. */
export function instrumentScaleKey(ws: Workspace, ch: string, sampleId: string | null | undefined, keywordsOf?: KeywordsOf): string | null {
  const inst = ws.instrumentScales;
  if (!inst || !sampleId) return null;
  const key = sampleInstrument(ws, sampleId, keywordsOf);
  return key && inst[key]?.[ch] ? key : null;
}

/**
 * Scale of channel `ch` for a sample: its instrument's own scale when the workspace has one, else the workspace scale
 * (undefined when neither exists). Without a sample (or without instrument scales): the workspace scale.
 */
export function scaleFor(ws: Workspace, ch: string, sampleId?: string | null, keywordsOf?: KeywordsOf): ScaleDef | undefined {
  const inst = ws.instrumentScales;
  if (inst && sampleId) {
    const key = sampleInstrument(ws, sampleId, keywordsOf);
    const s = key ? inst[key]?.[ch] : undefined;
    if (s) return s;
  }
  return ws.scales[ch];
}

/** Whether the workspace has any per-instrument scale. */
export function hasInstrumentScales(ws: Workspace): boolean {
  return !!ws.instrumentScales && Object.values(ws.instrumentScales).some((m) => m && Object.keys(m).length > 0);
}
