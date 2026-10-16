// "AI auto-analysis": the AI reads what the files tell (instrument, channels, tube names, plates, event counts and
// per-sample medians) and describes the experiment: groups of samples (controls, conditions, beads, buffer), the
// experiment setup and the next analysis steps. Built locally from summaries: never raw events, no operator names.
import { engine } from '../core/engine';
import type { ExperimentSetup, Workspace } from '../core/model';
import { isTimeChannel } from '../core/transforms';
import { tubeName } from '../core/plate';
import { isNanoscaleData } from '../state/store';
import { anon } from './context';

export type GroupRole = 'sample' | 'unstained' | 'single-stain' | 'fmo' | 'isotype' | 'beads' | 'buffer' | 'cleaning' | 'other';
export type StepAction = 'setup' | 'groups' | 'strategy' | 'size' | 'mesf' | 'compensation' | 'plates' | 'none';

export interface ExperimentGroup {
  name: string;
  role: GroupRole;
  sampleIds: string[];
}
export interface ExperimentStep {
  title: string;
  detail: string;
  action: StepAction;
  /** gating goal for the strategy assistant (action 'strategy') */
  goal?: string;
}
export interface ExperimentReading {
  summary: string;
  setup: ExperimentSetup | null;
  /** why these calibrations */
  calibWhy: string;
  groups: ExperimentGroup[];
  steps: ExperimentStep[];
  questions: string[];
}

const ROLES: GroupRole[] = ['sample', 'unstained', 'single-stain', 'fmo', 'isotype', 'beads', 'buffer', 'cleaning', 'other'];
const ACTIONS: StepAction[] = ['setup', 'groups', 'strategy', 'size', 'mesf', 'compensation', 'plates', 'none'];

const isScatter = (n: string) => /^(FSC|SSC|VSSC|VFSC|SSC_\d|FSC_\d)/i.test(n) || /scatter/i.test(n);

/** Numbers in two significant digits ("1.2e3", "45", "0.31"). */
function sig(v: number): string {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a >= 1e4 || (a > 0 && a < 0.01)) return v.toExponential(1).replace('e+', 'e');
  return String(Number(v.toPrecision(2)));
}

/** Median and 95th percentile of a channel (subsampled to 20,000 events). */
function quantiles(a: Float32Array): [number, number] {
  const step = Math.max(1, Math.floor(a.length / 20000));
  const s: number[] = [];
  for (let i = 0; i < a.length; i += step) if (Number.isFinite(a[i])) s.push(a[i]);
  if (!s.length) return [NaN, NaN];
  s.sort((x, y) => x - y);
  return [s[Math.floor(0.5 * (s.length - 1))], s[Math.floor(0.95 * (s.length - 1))]];
}

/** Fluorescence channels worth summarizing: area channels (else height), the most varying across samples first. */
function summaryChannels(ws: Workspace, ids: string[], max: number): string[] {
  const all = new Set<string>();
  for (const id of ids) for (const c of engine.samples.get(id)?.ds.channels ?? []) if (!isTimeChannel(c.name) && !isScatter(c.name) && !isScatter(c.label ?? '')) all.add(c.name);
  const names = [...all];
  const hasA = new Set(names.filter((n) => /-A$/.test(n)).map((n) => n.slice(0, -2)));
  const pick = names.filter((n) => !/-[HW]$/.test(n) || !hasA.has(n.slice(0, -2)));
  // spread of the log medians across (up to 40) samples
  const probe = ids.slice(0, 40);
  const spread = new Map<string, number>();
  for (const ch of pick) {
    const meds: number[] = [];
    for (const id of probe) {
      const sd = engine.samples.get(id);
      const i = sd?.index.get(ch);
      if (sd && i !== undefined) meds.push(quantiles(sd.ds.data[i])[1]);
    }
    const lg = meds.filter((m) => m > 0).map(Math.log10);
    spread.set(ch, lg.length ? Math.max(...lg) - Math.min(...lg) : 0);
  }
  const labelled = (ch: string) => !!ws.channelLabels[ch] || ws.samples.some((s) => s.channels.some((c) => c.name === ch && c.label && c.label !== ch));
  return pick.sort((a, b) => Number(labelled(b)) - Number(labelled(a)) || (spread.get(b) ?? 0) - (spread.get(a) ?? 0)).slice(0, max);
}

/**
 * The request: instructions and a compact description of the loaded files. `names`: send the tube names typed at the
 * cytometer (without plate number and well); otherwise only control / condition words found in them.
 */
export function experimentRequest(ws: Workspace, opts: { names?: boolean; maxSamples?: number } = {}): { prompt: string; refs: string[]; ids: string[] } {
  const names = opts.names ?? !anon();
  const ids = ws.samples.filter((s) => engine.has(s.id)).map((s) => s.id).slice(0, opts.maxSamples ?? 96);
  const refs = ids.map((_, i) => `S${i + 1}`);
  const kwOf = (id: string) => engine.samples.get(id)!.ds.keywords;
  const cyt = [...new Set(ids.map((id) => (kwOf(id)['$CYT'] ?? '').trim()).filter(Boolean))];
  const nano = ids.some((id) => isNanoscaleData(engine.samples.get(id)!.ds));
  const first = engine.samples.get(ids[0])?.ds;
  const lines: string[] = [];
  lines.push(`Instrument: ${cyt.join(', ') || 'not stated'}${nano ? ' (nanoscale configuration: violet side scatter)' : ''}. ${ws.samples.length} samples${ids.length < ws.samples.length ? ` (first ${ids.length} described)` : ''}.`);
  if (first) {
    const ch = first.channels.map((c) => (c.label && c.label !== c.name ? `${c.name} = ${c.label}` : c.name));
    lines.push(`Channels: ${ch.join('; ')}.`);
    const spill = Object.keys(first.keywords).some((k) => /^(\$?SPILLOVER|SPILL|\$COMP)$/i.test(k));
    lines.push(`Acquisition compensation matrix in the files: ${spill ? 'yes' : 'no'}.`);
  }
  const chans = summaryChannels(ws, ids, 10);
  const plates = [...new Set(ws.samples.map((s) => s.plate).filter(Boolean))] as string[];
  // plate names are often folder or experiment names: "P1, P2" when names are hidden
  const plateName = (p: string | undefined) => (!p ? '-' : names ? p : `P${plates.indexOf(p) + 1}`);
  if (plates.length) lines.push(`Plates: ${plates.map(plateName).join(', ')}.`);
  lines.push('');
  const chLabel = (ch: string) => {
    const l = ws.channelLabels[ch] || first?.channels.find((c) => c.name === ch)?.label;
    return l && l !== ch ? `${ch} (${l})` : ch;
  };
  lines.push(`Samples: ref | ${plates.length ? 'plate well | ' : ''}name | events | acquisition (s) | median / 95th percentile (a.u.) of ${chans.map(chLabel).join(', ')}`);
  ids.forEach((id, i) => {
    const s = ws.samples.find((x) => x.id === id)!;
    const sd = engine.samples.get(id)!;
    const kw = sd.ds.keywords;
    let label = tubeName(s.name, s.well);
    // whole words only ("_" separates words too, so "FMO_CD8_P0123" gives "fmo")
    if (!names) label = (label.match(/(?<![A-Za-z0-9])(unstained|unstain|blank|fmo|isotype|iso|single[- _]?stain(ed)?|comp|beads?|control|ctrl|stim(ulated)?|unstim(ulated)?|untreated|treated|buffer|pbs|water|contrad|clean(ing)?|nano ?vis|apogee|rainbow|mesf)(?![A-Za-z0-9])/gi) ?? []).map((w) => w.toLowerCase()).join(' ') || '(name hidden)';
    const t0 = /^(\d+):(\d+):(\d+)/.exec(kw['$BTIM'] ?? '');
    const t1 = /^(\d+):(\d+):(\d+)/.exec(kw['$ETIM'] ?? '');
    const sec = t0 && t1 ? (+t1[1] - +t0[1]) * 3600 + (+t1[2] - +t0[2]) * 60 + (+t1[3] - +t0[3]) : NaN;
    const stats = chans.map((ch) => {
      const k = sd.index.get(ch);
      if (k === undefined) return '-';
      const [m, p] = quantiles(sd.ds.data[k]);
      return `${sig(m)}/${sig(p)}`;
    });
    lines.push(`${refs[i]} | ${plates.length ? `${plateName(s.plate)} ${s.well ?? '-'} | ` : ''}${label || '(no name)'} | ${sd.ds.eventCount} | ${Number.isFinite(sec) && sec >= 0 ? sec : '-'} | ${stats.join(' ')}`);
  });
  const existing: string[] = [];
  if (ws.populations.length) existing.push(`${ws.populations.length} gates`);
  if (ws.groups.length) existing.push(names ? `groups ${ws.groups.map((g) => g.name).join(', ')}` : `${ws.groups.length} sample groups`);
  if (ws.derived?.length) existing.push(`calibrations / derived channels: ${ws.derived.map((d) => d.kind).join(', ')}`);
  if (existing.length) lines.push('', `Already in the analysis: ${existing.join('; ')}.`);

  const prompt = `You help a scientist start the analysis of a flow cytometry experiment in FlowState (a FlowJo-like app).
From the file metadata and per-sample summaries below, work out what was measured: which samples are controls
(unstained, single stains, FMOs, isotypes), reference beads (size beads such as nanoViS / ApogeeMix / Rosetta, MESF or
rainbow beads), buffer-only or cleaning runs (PBS, water, Contrad: often very many noise events or very few events),
and which conditions the tube names and plate positions encode (treatments, dilutions, time points, replicates).
Say what you are unsure of. Do not invent facts.

Answer with JSON only:
{
  "summary": "2 to 4 sentences: what the experiment is",
  "kind": "conventional" | "nanoscale",
  "calibrations": { "mesf": true|false, "size": true|false, "why": "one sentence" },
  "groups": [ { "name": "short name", "role": "${ROLES.join('|')}", "samples": ["S1", "S2"] } ],
  "steps": [ { "title": "imperative, short", "detail": "one or two sentences for this experiment", "action": "${ACTIONS.join('|')}", "goal": "for action strategy: the populations to gate" } ],
  "questions": ["what you would ask the scientist, at most 3"]
}
Groups: every sample in at most one group; replicates of one condition in one group. At most 7 steps, in the order to
do them (setup, groups, compensation, calibration, gating strategy, statistics). Nanoscale data (EVs, viruses,
liposomes) need log scatter, buffer and detergent controls and usually scatter (size) and fluorescence (MESF)
calibration.

${lines.join('\n')}`;
  return { prompt, refs, ids };
}

/**
 * Read the AI's answer: sample refs back to the samples of the request (`req.ids`, as they were when it was sent; those
 * no longer in the workspace are dropped), unknown roles / actions as "other" / "none".
 */
export function parseExperiment(ws: Workspace, req: { refs: string[]; ids: string[] }, v: unknown): ExperimentReading {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const str = (x: unknown, max = 600) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  const present = new Set(ws.samples.map((s) => s.id));
  const byRef = new Map(req.refs.map((r, i) => [r.toLowerCase(), present.has(req.ids[i]) ? req.ids[i] : undefined]));
  const cal = (o.calibrations && typeof o.calibrations === 'object' ? o.calibrations : {}) as Record<string, unknown>;
  const kind = o.kind === 'nanoscale' || o.kind === 'conventional' ? o.kind : null;
  const used = new Set<string>();
  const groups: ExperimentGroup[] = (Array.isArray(o.groups) ? o.groups : [])
    .map((g) => {
      const x = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
      // every sample in at most one group, and once in it ("S1", "s1 " twice in one list count once)
      const sampleIds = (Array.isArray(x.samples) ? x.samples : [])
        .map((r) => byRef.get(String(r).trim().toLowerCase()))
        .filter((id): id is string => {
          if (!id || used.has(id)) return false;
          used.add(id);
          return true;
        });
      const role = ROLES.includes(x.role as GroupRole) ? (x.role as GroupRole) : 'other';
      return { name: str(x.name, 60) || role, role, sampleIds };
    })
    .filter((g) => g.sampleIds.length);
  const steps: ExperimentStep[] = (Array.isArray(o.steps) ? o.steps : []).slice(0, 8).flatMap((s) => {
    const x = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const title = str(x.title, 120);
    if (!title) return [];
    const action = ACTIONS.includes(x.action as StepAction) ? (x.action as StepAction) : 'none';
    return [{ title, detail: str(x.detail), action, goal: str(x.goal, 300) || undefined }];
  });
  return {
    summary: str(o.summary, 1200),
    setup: kind ? { kind, mesf: cal.mesf === true, size: cal.size === true } : null,
    calibWhy: str(cal.why, 300),
    groups,
    steps,
    questions: (Array.isArray(o.questions) ? o.questions : []).map((q) => str(q, 300)).filter(Boolean).slice(0, 3),
  };
}
