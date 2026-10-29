// Example plugin, computation: reporter intensity per bead population and sample, minus the blank (buffer-only)
// samples, optionally divided by the mean of reference bead populations. A template for bead-based multiplex assays;
// not the evaluation procedure of any particular kit. Uses only the PluginContext (fs), so it is tested without a UI.
import type { PluginContext } from '../api';

export interface BeadMfiSettings {
  /** reporter (detection) channel, e.g. "APC-A" */
  reporter: string;
  /** statistic of the reporter per bead population */
  stat: 'median' | 'mean' | 'geomean';
  /** bead populations (one per capture bead / analyte), in table order */
  beads: string[];
  /** blank samples (no analyte): their mean is subtracted per bead population; none: no subtraction */
  blanks: string[];
  /** bead populations (of `beads`) whose mean after subtraction each sample is divided by; none: no normalization */
  normalizeTo: string[];
}

export const DEFAULT_SETTINGS: BeadMfiSettings = { reporter: '', stat: 'median', beads: [], blanks: [], normalizeTo: [] };

/** Settings saved with a workspace, checked (see FlowStatePlugin.parseState). */
export function parseSettings(raw: unknown): BeadMfiSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    reporter: typeof o.reporter === 'string' ? o.reporter : '',
    stat: o.stat === 'mean' || o.stat === 'geomean' ? o.stat : 'median',
    beads: ids(o.beads),
    blanks: ids(o.blanks),
    normalizeTo: ids(o.normalizeTo),
  };
}

export interface BeadMfiResult {
  beads: { id: string; name: string }[];
  /** mean blank value per bead (null: no blank value); empty when no blanks are chosen */
  blank: (number | null)[];
  /** one row per loaded sample that is not a blank; null = no value (no events, not applicable, no blank value) */
  rows: { sampleId: string; sample: string; values: (number | null)[] }[];
  normalized: boolean;
  notes: string[];
}

function mean(v: (number | null)[]): number | null {
  const ok = v.filter((x): x is number => x !== null);
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
}

export function beadMfi(fs: PluginContext<BeadMfiSettings>, s: BeadMfiSettings): BeadMfiResult {
  const pops = fs.populations();
  const beads = s.beads.filter((id) => pops.some((p) => p.id === id)).map((id) => ({ id, name: pops.find((p) => p.id === id)!.name }));
  const notes: string[] = [];
  if (!s.reporter || !beads.length) return { beads, blank: [], rows: [], normalized: false, notes: ['Choose the reporter channel and the bead populations.'] };
  const value = (sid: string, pop: string): number | null => {
    const v = fs.stat(sid, pop, s.stat, s.reporter);
    return Number.isFinite(v) ? v : null;
  };
  const samples = fs.samples().filter((x) => x.loaded);
  const blanks = s.blanks.filter((id) => samples.some((x) => x.id === id));
  const blank = blanks.length ? beads.map((b) => mean(blanks.map((sid) => value(sid, b.id)))) : [];
  if (!blanks.length) notes.push('No blank sample chosen: values are not background-subtracted.');
  else if (blank.some((v) => v === null)) notes.push('Some bead populations have no blank value: their results are left empty.');
  const refIdx = s.normalizeTo.map((id) => beads.findIndex((b) => b.id === id)).filter((k) => k >= 0);
  let unnormalizable = 0;
  const rows = samples
    .filter((x) => !blanks.includes(x.id))
    .map((x) => {
      const sub = beads.map((b, k) => {
        const v = value(x.id, b.id);
        if (v === null) return null;
        if (!blanks.length) return v;
        return blank[k] === null ? null : v - blank[k]!;
      });
      if (!refIdx.length) return { sampleId: x.id, sample: x.name, values: sub };
      const ref = mean(refIdx.map((k) => sub[k]));
      if (ref === null || !(ref > 0)) {
        unnormalizable++;
        return { sampleId: x.id, sample: x.name, values: sub.map(() => null) };
      }
      return { sampleId: x.id, sample: x.name, values: sub.map((v) => (v === null ? null : v / ref)) };
    });
  if (unnormalizable) notes.push(`${unnormalizable} sample(s) have no positive reference signal to normalize to: left empty.`);
  return { beads, blank, rows, normalized: refIdx.length > 0, notes };
}

/** The result as table rows (header first), for CSV / Excel export. */
export function resultRows(r: BeadMfiResult, s: BeadMfiSettings): (string | number | null)[][] {
  const head = ['Sample', ...r.beads.map((b) => b.name)];
  const out: (string | number | null)[][] = [head];
  if (r.blank.length) out.push([`Blank (mean ${s.stat})`, ...r.blank]);
  for (const row of r.rows) out.push([row.sample, ...row.values]);
  return out;
}
