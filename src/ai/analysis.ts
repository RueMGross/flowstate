// "Analyze new files": the AI reads the files not analyzed yet (summaries, no events) and proposes a whole analysis:
// groups, the gating steps still missing, and the figures and tables to make. The user ticks items off, adds notes
// ("do this differently") and can have the plan revised; Run then creates the groups, gates through the AI gating
// strategy runner (each gate seeded by the AI, drawn by the deterministic auto gate, accepted automatically), builds the
// figures and tables, and asks the AI for a short results text from the computed numbers. Everything is one undo step,
// and every page it makes carries the disclaimer.
import { engine } from '../core/engine';
import { MM, newWorksheet, popById, STAT_LABELS, STAT_NEEDS_CHANNEL, uid, type ChartItem, type Group, type SheetItem, type StatColumn, type StatKind, type TableDef, type TextItem, type Workspace } from '../core/model';
import { applies } from '../core/scope';
import { defaultPlotSize, newChartItem, newPlotItem, runAs, useStore } from '../state/store';
import { buildGatingStrategySheet, growPageToFit } from '../ui/layoutOps';
import { chan, redact, sampleLabel, treeText } from './context';
import type { Protocol } from '../io/protocol';
import { experimentFacts, type GroupRole } from './experiment';
import { squashSince } from './history';
import { aiErrorMessage, completeJson, type AiError, type AiProvider } from './provider';
import { parseStrategy, resolveChannel, runStrategy, type RunControl, type StrategyStep } from './strategy';

export const DISCLAIMER =
  'AI-generated analysis (FlowState Assist). Gates were placed automatically (the AI chose where, the auto gate drew the boundary from the event density) and the text was drafted by an AI from the computed numbers. Check every gate, number and statement against the data before you use them. For research use only, not for diagnostic or clinical decisions.';

const ROLES: GroupRole[] = ['sample', 'unstained', 'single-stain', 'fmo', 'isotype', 'beads', 'buffer', 'cleaning', 'other'];
/** statistics the plan may use (those needing extra settings, such as percentiles, are left to the user) */
export const PLAN_STATS: StatKind[] = ['count', 'freqParent', 'freqTotal', 'freqGrandparent', 'median', 'mean', 'geomean', 'sd', 'cv', 'rsd', 'rcv'];
export type OutputKind = 'strategy' | 'grid' | 'overlay' | 'chart' | 'table';
const KINDS: OutputKind[] = ['strategy', 'grid', 'overlay', 'chart', 'table'];
/** groups left out of charts and overlays that compare conditions */
const CONTROL_ROLES = new Set<GroupRole>(['unstained', 'single-stain', 'fmo', 'isotype', 'beads', 'buffer', 'cleaning']);

export interface PlanGroup {
  id: string;
  on: boolean;
  name: string;
  role: GroupRole;
  sampleIds: string[];
}

export interface PlanColumn {
  population: string;
  stat: StatKind;
  channel?: string;
}

export interface PlanOutput {
  id: string;
  on: boolean;
  kind: OutputKind;
  title: string;
  why: string;
  /** population name: a gating step of the plan, an existing population, or "All events" */
  population: string;
  /** grid: plot channels (y empty: histogram); overlay: x is the channel */
  x: string;
  y: string;
  /** chart */
  stat?: StatKind;
  channel?: string;
  /** table */
  columns?: PlanColumn[];
  /** grid / overlay: these samples (else the samples analyzed) */
  sampleIds?: string[];
  note?: string;
}

export interface AnalysisPlan {
  summary: string;
  gatingSample: string | null;
  groups: PlanGroup[];
  gating: StrategyStep[];
  outputs: PlanOutput[];
  assumptions: string[];
  questions: string[];
}

// ------------------------------------------------------------------ which files

/**
 * Samples already analyzed: shown on a worksheet as themselves (a plot layer, statistics box or label pinned to them),
 * in a chart's fixed sample list, or in a group that a chart or table uses. Plots that follow the active sample and
 * tables of all samples do not count: they show any sample.
 */
export function analyzedSampleIds(ws: Workspace): Set<string> {
  const out = new Set<string>();
  const groups = new Set<string>();
  for (const sh of ws.worksheets)
    for (const it of sh.items) {
      if (it.kind === 'plot') for (const l of it.layers) out.add(l.sample);
      else if (it.kind === 'stats') out.add(it.sample);
      else if (it.kind === 'text' && it.sampleHeader) out.add(it.sampleHeader.sample);
      else if (it.kind === 'chart' && !it.plate && !it.calib) {
        for (const id of it.samples ?? []) out.add(id);
        if (it.mode === 'groups') for (const g of it.groups?.length ? it.groups : ws.groups.map((x) => x.id)) groups.add(g);
        else if (it.sampleSet !== 'all') groups.add(it.sampleSet);
      }
    }
  for (const t of ws.tables) if (t.sampleSet !== 'all') groups.add(t.sampleSet);
  for (const g of ws.groups) if (groups.has(g.id)) for (const id of g.sampleIds) out.add(id);
  out.delete('active');
  return out;
}

/** Loaded samples not analyzed yet (see analyzedSampleIds). */
export function newSampleIds(ws: Workspace): string[] {
  const done = analyzedSampleIds(ws);
  return ws.samples.filter((s) => engine.has(s.id) && !done.has(s.id)).map((s) => s.id);
}

// ------------------------------------------------------------------ the plan

export interface PlanRequest {
  prompt: string;
  refs: string[];
  ids: string[];
}

export interface PlanFeedback {
  /** the plan the user commented on */
  plan: AnalysisPlan;
  /** general remarks */
  notes: string;
}

/** The plan as the model sees it again (refs instead of sample ids), with the user's ticks and notes. */
function feedbackText(ws: Workspace, f: PlanFeedback, refOf: (id: string) => string): string {
  const lines: string[] = ['Your previous plan, with the scientist\'s review ("[removed]" = unticked by the scientist, "NOTE:" = what they want differently):'];
  lines.push(`Gating sample: ${f.plan.gatingSample ? refOf(f.plan.gatingSample) : 'none'}`);
  lines.push('Groups:');
  for (const g of f.plan.groups) lines.push(`- ${g.on ? '' : '[removed] '}${g.name} (${g.role}): ${g.sampleIds.map(refOf).join(', ')}`);
  lines.push('Gating steps:');
  for (const s of f.plan.gating) lines.push(`- ${s.on ? '' : '[removed] '}${s.name} in ${s.parent}: ${s.plot === 'histogram' ? chan(ws, s.x) : `${chan(ws, s.x)} vs ${chan(ws, s.y)}`}, ${s.target}${s.remark ? `. NOTE: ${s.remark}` : ''}`);
  lines.push('Outputs:');
  for (const o of f.plan.outputs) lines.push(`- ${o.on ? '' : '[removed] '}${o.kind} "${o.title}": ${outputDesc(ws, o)}${o.note ? `. NOTE: ${o.note}` : ''}`);
  if (f.notes.trim()) lines.push('', `General notes from the scientist: """${f.notes.trim().slice(0, 3000)}"""`);
  lines.push('', 'Make a revised plan that follows the notes: drop or change what was removed or commented on, keep what was accepted as it is.');
  return lines.join('\n');
}

/** One line describing an output (for the review list and the revision request). */
export function outputDesc(ws: Workspace, o: PlanOutput): string {
  const c = (ch: string | undefined) => (ch ? chan(ws, ch) : '');
  switch (o.kind) {
    case 'strategy':
      return 'one plot per gating step';
    case 'grid':
      return `${o.population}: ${o.y ? `${c(o.x)} vs ${c(o.y)}` : `histogram of ${c(o.x)}`}, one plot per sample`;
    case 'overlay':
      return `${o.population}: histogram overlay of ${c(o.x)}`;
    case 'chart':
      return `${o.population}: ${STAT_LABELS[o.stat ?? 'freqParent']}${o.channel ? ` of ${c(o.channel)}` : ''} per group or sample`;
    case 'table':
      return (o.columns ?? []).map((k) => `${k.population} ${STAT_LABELS[k.stat]}${k.channel ? ` ${c(k.channel)}` : ''}`).join('; ');
  }
}

export function planRequest(ws: Workspace, ids: string[], opts: { names: boolean; goal?: string; feedback?: PlanFeedback; protocol?: Protocol | null }): PlanRequest {
  const facts = experimentFacts(ws, { names: opts.names, ids, maxSamples: 96 });
  const refOf = (id: string) => facts.refs[facts.ids.indexOf(id)] ?? '?';
  const panel = [...new Set(ws.samples.filter((s) => facts.ids.includes(s.id)).flatMap((s) => s.channels.map((c) => c.name)))].map((n) => `${n}: ${ws.channelLabels[n] ?? ws.samples.flatMap((s) => s.channels).find((c) => c.name === n)?.label ?? ''}`);
  const prompt = `You are an expert flow cytometrist analysing an experiment in FlowState (a FlowJo-like app) for a scientist.
Plan the WHOLE analysis of the samples below: which samples belong together, the gates still missing, and the figures and
tables that answer what the experiment is about. The app will carry out the plan: it creates the groups, gates (you
name each population and where it is; the app's auto gate draws the boundary on the gating sample, and the gates apply to
all samples), makes the figures and tables, then you get the numbers to write the results.

${facts.text}

Panel (channel name: marker label, empty if unknown):
${panel.join('\n')}

Gates that exist already (reuse them by name, do not gate them again):
${treeText(ws, null, 40)}
${opts.goal?.trim() ? `\nWhat the scientist wants to know: """${opts.goal.trim().slice(0, 2000)}"""\n` : ''}${opts.protocol ? `\nThe scientist's protocol (file "${opts.protocol.name}"${opts.protocol.truncated ? ', shortened' : ''}): plate layout, samples and experimental details. Use it to tell which sample or well is which condition, control, replicate, dilution or time point (more reliable than guesses from names or numbers; match samples by tube name, plate and well), and let its context (question, treatments, expected results, staining, instrument settings) shape the gates, figures and tables:\n"""\n${opts.protocol.text}\n"""\n` : ''}${opts.feedback ? `\n${feedbackText(ws, opts.feedback, refOf)}\n` : ''}
Rules:
- Use only channel names from the panel and sample refs (S1 ...) from the list. Do not invent facts.
- groups: replicates of one condition in one group; controls (unstained, single stains, FMO, isotype), beads and buffer in groups of their own role. Every sample in at most one group.
- gatingSample: a fully stained, representative experimental sample (not a control, beads or buffer).
- gating: only the populations still missing, in order, at most 10 steps, each ONE population on a 2D plot or a histogram. Start from "All events" or an existing population: debris exclusion on scatter, doublets (FSC-A vs FSC-H) if height channels exist, dead cells if a viability dye is in the panel, then the populations the experiment is about. Nanoscale data (EVs, beads): gate particles above the noise on log violet SSC, no doublet gate.
- outputs, 4 to 9 of them, the most useful first:
  "strategy": the gating strategy figure (one plot per gating step). Include it when there are gates.
  "grid": the key plot (population, x, y; y empty for a histogram) repeated for every sample (or the listed samples, at most 24).
  "overlay": histogram overlay of one channel (x) of a population, comparing the conditions (listed samples, at most 8: one per condition).
  "chart": dot chart of a statistic of a population per group (bar chart per sample without groups). stat one of ${PLAN_STATS.join(', ')}; channel only for median, mean, geomean, sd, cv, rsd, rcv.
  "table": the statistics table: columns of population, stat, channel.
- assumptions: what you assumed; questions: at most 3 things you would ask the scientist.

Reply with only a JSON object:
{
  "summary": "2 to 4 sentences: what the experiment is and what the analysis shows",
  "groups": [{"name": "short", "role": "${ROLES.join('|')}", "samples": ["S1"]}],
  "gatingSample": "S2",
  "gating": [{"name": "Cells", "parent": "All events", "plot": "2d", "x": "FSC-A", "y": "SSC-A", "target": "intact cells, excluding debris near the origin"}],
  "outputs": [{"kind": "chart", "title": "short title", "why": "one sentence", "population": "CD4+ T cells", "x": "", "y": "", "stat": "freqParent", "channel": "", "samples": [], "columns": []}],
  "assumptions": ["..."],
  "questions": ["..."]
}`;
  // with tube names sent on purpose, names in free text stay as well (as in Describe experiment)
  return { prompt: opts.names ? prompt : redact(prompt, ws), refs: facts.refs, ids: facts.ids };
}

let seq = 0;
const str = (x: unknown, n = 400) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** Read the plan: refs back to samples, channels resolved, unknown kinds / stats dropped (with a note), nothing trusted. */
export function parsePlan(ws: Workspace, req: { refs: string[]; ids: string[] }, v: unknown): AnalysisPlan {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const present = new Set(ws.samples.map((s) => s.id));
  const byRef = new Map(req.refs.map((r, i) => [r.toLowerCase(), present.has(req.ids[i]) ? req.ids[i] : undefined]));
  const refs = (a: unknown) => [...new Set((Array.isArray(a) ? a : []).map((r) => byRef.get(String(r).trim().toLowerCase())).filter((id): id is string => !!id))];
  const used = new Set<string>();
  const groups: PlanGroup[] = (Array.isArray(o.groups) ? o.groups : []).flatMap((g) => {
    const x = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
    const ids = refs(x.samples).filter((id) => !used.has(id) && (used.add(id), true));
    const role = ROLES.includes(x.role as GroupRole) ? (x.role as GroupRole) : 'other';
    return ids.length ? [{ id: `pg${++seq}`, on: true, name: str(x.name, 60) || role, role, sampleIds: ids }] : [];
  });
  const gating = parseStrategy(ws, { steps: o.gating }).steps;
  const outputs: PlanOutput[] = (Array.isArray(o.outputs) ? o.outputs : []).slice(0, 12).flatMap((r) => {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const kind = x.kind as OutputKind;
    if (!KINDS.includes(kind)) return [];
    const out: PlanOutput = { id: `po${++seq}`, on: true, kind, title: str(x.title, 80) || kind, why: str(x.why), population: str(x.population, 60) || 'All events', x: '', y: '' };
    const bad: string[] = [];
    if (kind === 'grid' || kind === 'overlay') {
      out.x = resolveChannel(ws, x.x) ?? '';
      if (!out.x) bad.push(`unknown channel "${str(x.x, 30)}"`);
      if (kind === 'grid' && str(x.y)) {
        out.y = resolveChannel(ws, x.y) ?? '';
        if (!out.y) bad.push(`unknown channel "${str(x.y, 30)}"`);
      }
      const ids = refs(x.samples);
      if (ids.length) out.sampleIds = ids.slice(0, kind === 'grid' ? 24 : 8);
    }
    if (kind === 'chart') {
      out.stat = PLAN_STATS.includes(x.stat as StatKind) ? (x.stat as StatKind) : 'freqParent';
      if (STAT_NEEDS_CHANNEL[out.stat]) {
        out.channel = resolveChannel(ws, x.channel) ?? undefined;
        if (!out.channel) bad.push(`unknown channel "${str(x.channel, 30)}"`);
      }
    }
    if (kind === 'table') {
      out.columns = (Array.isArray(x.columns) ? x.columns : []).slice(0, 30).flatMap((c) => {
        const k = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
        const stat = PLAN_STATS.includes(k.stat as StatKind) ? (k.stat as StatKind) : null;
        if (!stat) return [];
        const channel = STAT_NEEDS_CHANNEL[stat] ? resolveChannel(ws, k.channel) : null;
        if (STAT_NEEDS_CHANNEL[stat] && !channel) return [];
        return [{ population: str(k.population, 60) || 'All events', stat, ...(channel ? { channel } : {}) }];
      });
      if (!out.columns.length) bad.push('no usable columns');
    }
    if (bad.length) (out.on = false), (out.note = `Off: ${bad.join(', ')}`);
    return [out];
  });
  const gs = byRef.get(str(o.gatingSample, 12).toLowerCase()) ?? null;
  return {
    summary: str(o.summary, 1500),
    gatingSample: gs,
    groups,
    gating,
    outputs,
    assumptions: (Array.isArray(o.assumptions) ? o.assumptions : []).map((a) => str(a, 300)).filter(Boolean).slice(0, 5),
    questions: (Array.isArray(o.questions) ? o.questions : []).map((a) => str(a, 300)).filter(Boolean).slice(0, 3),
  };
}

// ------------------------------------------------------------------ running it

export interface AnalysisControl extends Pick<RunControl, 'provider' | 'images' | 'signal' | 'setHandle' | 'setPrep'> {
  /** progress line */
  status(text: string): void;
  /** a gating step changed (status, population) */
  step(id: string, patch: Partial<StrategyStep>): void;
  /** send tube names with the results request (else Sample n) */
  names: boolean;
  /** the scientist's protocol: context for the results text as well */
  protocol?: Protocol | null;
}

export interface AnalysisResult {
  sheets: string[];
  tables: string[];
  gates: number;
  results: ResultsText | null;
  /** what could not be made, and why */
  skipped: string[];
}

export interface ResultsText {
  headline: string;
  findings: string[];
  caveats: string[];
  next: string[];
}

const GROUP_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#8c564b', '#e377c2', '#bcbd22', '#7f7f7f'];

/** Population id of a name: a step made in this run, an existing population, or All events ('root'); null if unknown. */
function popOf(ws: Workspace, made: Map<string, string>, name: string): string | null {
  const n = name.trim().toLowerCase();
  if (['all events', 'root', 'all', 'ungated', ''].includes(n)) return 'root';
  const id = made.get(n) ?? ws.populations.find((p) => p.name.toLowerCase() === n)?.id ?? null;
  return id && (id === 'root' || popById(ws, id)) ? id : null;
}

function textItem(x: number, y: number, w: number, text: string, pt: number, o: Partial<TextItem> = {}): TextItem {
  return { id: uid('txt'), kind: 'text', x, y, w, h: pt * 2, text, fontSize: pt, bold: false, italic: false, align: 'left', color: '', ...o };
}

/** Carry out the plan (the items ticked). One undo step; resolves when everything is made. */
export async function runAnalysis(plan: AnalysisPlan, ids: string[], c: AnalysisControl): Promise<AnalysisResult> {
  const st = useStore.getState();
  const before = st.ws;
  const res: AnalysisResult = { sheets: [], tables: [], gates: 0, results: null, skipped: [] };
  const made = new Map<string, string>();
  try {
    // 1. groups (an existing group of the same name gets these samples)
    const groupIds: { id: string; role: GroupRole }[] = [];
    const chosenGroups = plan.groups.filter((g) => g.on && g.sampleIds.length);
    if (chosenGroups.length) {
      c.status('Creating groups…');
      runAs('ai', () =>
        st.update((w) => {
          for (const g of chosenGroups) {
            let ex: Group | undefined = w.groups.find((x) => x.name === g.name);
            if (ex) ex.sampleIds = [...new Set([...ex.sampleIds, ...g.sampleIds])];
            else w.groups.push((ex = { id: uid('grp'), name: g.name, color: GROUP_COLORS[w.groups.length % GROUP_COLORS.length], sampleIds: [...g.sampleIds] }));
            groupIds.push({ id: ex.id, role: g.role });
          }
        }),
      );
    }
    // 2. gating on the gating sample
    const gsid = plan.gatingSample && engine.has(plan.gatingSample) ? plan.gatingSample : ids.find((id) => engine.has(id)) ?? null;
    if (gsid) useStore.getState().setUI({ activeSampleId: gsid });
    const steps = plan.gating.filter((s) => s.on && s.x && (s.plot === 'histogram' || s.y));
    if (steps.length && !c.signal.aborted) {
      c.status(`Gating on ${gsid ? sampleLabel(useStore.getState().ws, gsid) : 'the active sample'}…`);
      res.gates = await runStrategy(steps, {
        ...c,
        quiet: true,
        acceptAll: () => true,
        update: (id, p) => {
          c.step(id, p);
          const s = steps.find((x) => x.id === id);
          if (s && p.popId) made.set(s.name.toLowerCase(), p.popId);
        },
      });
      const sheet = useStore.getState().ws.worksheets.find((w) => !before.worksheets.some((b) => b.id === w.id) && w.name.startsWith('AI gating'));
      if (sheet) res.sheets.push(sheet.name);
    }
    if (c.signal.aborted) return res;
    // 3. figures and tables
    c.status('Making figures and tables…');
    const outs = plan.outputs.filter((o) => o.on);
    const ws = () => useStore.getState().ws;
    const analyzed = ids.filter((id) => engine.has(id));
    const { w: W, h: H } = defaultPlotSize();
    const g = 5 * MM;
    const report = newWorksheet(uniqueSheet(ws(), 'AI analysis'));
    const pageW = report.page.w;
    const items: SheetItem[] = [];
    items.push(textItem(2 * g, 2 * g, pageW - 4 * g, 'AI analysis', 14, { bold: true }));
    items.push(textItem(2 * g, 2 * g + 8 * MM, pageW - 4 * g, DISCLAIMER, 7, { italic: true, color: '#9a3412' }));
    if (plan.summary) items.push(textItem(2 * g, 2 * g + 22 * MM, pageW - 4 * g, plan.summary, 8));
    // below the summary: about 1.45 mm per character at 8 pt, 3.7 mm per line
    const summaryLines = plan.summary ? Math.ceil((plan.summary.length * 1.45 * MM) / (pageW - 4 * g)) : 0;
    let y = 2 * g + (plan.summary ? 22 + summaryLines * 3.7 + 6 : 24) * MM;
    const cols = Math.max(1, Math.floor((pageW - 3 * g) / (W + g)));
    let slot = 0;
    const place = () => {
      const p = { x: 2 * g + (slot % cols) * (W + g), y: y + Math.floor(slot / cols) * (H + g) };
      slot++;
      return p;
    };
    const condGroups = groupIds.filter((x) => !CONTROL_ROLES.has(x.role)).map((x) => x.id);
    for (const o of outs) {
      if (c.signal.aborted) break;
      const pop = o.kind === 'strategy' || o.kind === 'table' ? 'root' : popOf(ws(), made, o.population);
      if (pop === null) {
        res.skipped.push(`${o.title}: the population "${o.population}" was not gated`);
        continue;
      }
      if (o.kind === 'strategy') {
        if (!ws().populations.length) {
          res.skipped.push(`${o.title}: there are no gates`);
          continue;
        }
        runAs('ai', () => buildGatingStrategySheet(gsid ?? 'active'));
        const sh = ws().worksheets[ws().worksheets.length - 1];
        runAs('ai', () => st.update((w) => void w.worksheets.find((x) => x.id === sh.id)!.items.push(textItem(2 * g, 0.6 * g, sh.page.w - 4 * g, DISCLAIMER, 6.5, { italic: true, color: '#9a3412' }))));
        res.sheets.push(sh.name);
      } else if (o.kind === 'grid') {
        const sids = (o.sampleIds?.length ? o.sampleIds : analyzed).filter((id) => engine.has(id) && applies(ws(), id, pop)).slice(0, 24);
        if (!sids.length) {
          res.skipped.push(`${o.title}: no sample has this population`);
          continue;
        }
        const sh = newWorksheet(uniqueSheet(ws(), `AI: ${o.title}`.slice(0, 40)));
        const n = Math.max(1, Math.min(sids.length, Math.floor((sh.page.w - 3 * g) / (W + g))));
        const its: SheetItem[] = [textItem(2 * g, g, sh.page.w - 4 * g, `${o.title}. ${DISCLAIMER}`, 6.5, { italic: true, color: '#9a3412' })];
        sids.forEach((sid, i) => its.push(newPlotItem(o.y ? 'pseudo' : 'histogram', o.x, o.y || o.x, 2 * g + (i % n) * (W + g), 3 * g + Math.floor(i / n) * (H + g), W, H, pop, sid)));
        growPageToFit(sh, its);
        sh.items = its;
        runAs('ai', () => st.update((w) => void w.worksheets.push(sh)));
        res.sheets.push(sh.name);
      } else if (o.kind === 'overlay') {
        const pool = o.sampleIds?.length ? o.sampleIds : condGroups.length ? condGroups.map((gid) => ws().groups.find((x) => x.id === gid)?.sampleIds.find((id) => analyzed.includes(id))).filter((x): x is string => !!x) : analyzed;
        const sids = pool.filter((id) => engine.has(id) && applies(ws(), id, pop)).slice(0, 8);
        if (!sids.length) {
          res.skipped.push(`${o.title}: no sample has this population`);
          continue;
        }
        const p = place();
        const it = newPlotItem('histogram', o.x, o.x, p.x, p.y, W, H, pop);
        it.layers = sids.map((sid, i) => ({ id: uid('ly'), sample: sid, population: pop, color: GROUP_COLORS[i % GROUP_COLORS.length] }));
        it.options.histOffset = 0;
        it.options.legend = true;
        // one label per layer would crowd the plot: the gates are on the other figures
        it.options.showGates = false;
        it.options.title = o.title;
        it.options.showTitle = true;
        items.push(it);
      } else if (o.kind === 'chart') {
        const p = place();
        const stat: StatColumn = { id: uid('col'), population: pop, stat: o.stat ?? 'freqParent', ...(o.channel ? { channel: o.channel } : {}) };
        const ch: ChartItem = newChartItem(p.x, p.y, W, H, stat);
        if (condGroups.length) Object.assign(ch, { mode: 'groups', groups: condGroups, style: 'dot', errorBars: 'sd', showPoints: true, useGroupColors: true });
        else Object.assign(ch, { mode: 'samples', sampleSet: 'all', samples: analyzed, style: 'bar', errorBars: 'none' });
        ch.title = o.title;
        items.push(ch);
      } else if (o.kind === 'table') {
        const columns: StatColumn[] = [];
        for (const k of o.columns ?? []) {
          const pid = popOf(ws(), made, k.population);
          if (pid === null) {
            res.skipped.push(`${o.title}: column "${k.population}" (not gated)`);
            continue;
          }
          columns.push({ id: uid('col'), population: pid, stat: k.stat, ...(k.channel ? { channel: k.channel } : {}) });
        }
        if (!columns.length) continue;
        const t: TableDef = { id: uid('tbl'), name: uniqueTable(ws(), `AI: ${o.title}`.slice(0, 40)), sampleSet: 'all', columns };
        runAs('ai', () => st.update((w) => void w.tables.push(t)));
        res.tables.push(t.name);
      }
    }
    // the report page (charts and overlays, the results text below them)
    if (slot) y += Math.ceil(slot / cols) * (H + g);
    report.items = items;
    growPageToFit(report, items);
    runAs('ai', () => st.update((w) => void w.worksheets.push(report)));
    res.sheets.unshift(report.name);
    // 4. results text from the numbers
    if (!c.signal.aborted) {
      c.status('Writing the results…');
      // one more try after a dropped connection or a busy server: everything else is made already
      for (let k = 0; k < 2 && !res.results && !c.signal.aborted; k++)
        try {
          res.results = await askResults(c.provider, plan, analyzed, c.signal, c.names, { sheetId: report.id, tables: res.tables }, c.protocol ?? null);
        } catch (e) {
          if (c.signal.aborted) return res;
          const code = (e as AiError).code;
          if (k === 0 && ['network', 'overloaded', 'incomplete', 'upstream_error', 'rate_limited', 'invalid_json'].includes(code)) await new Promise((ok) => setTimeout(ok, 3000));
          else {
            res.skipped.push(`Results text: ${aiErrorMessage(e)}`);
            break;
          }
        }
      if (res.results) {
        const r = res.results;
        const text = [`Results (AI draft, check before use)`, r.headline, ...r.findings.map((f) => `• ${f}`), ...(r.caveats.length ? ['Caveats:', ...r.caveats.map((f) => `• ${f}`)] : []), ...(r.next.length ? ['Next:', ...r.next.map((f) => `• ${f}`)] : [])].filter(Boolean).join('\n');
        runAs('ai', () =>
          st.update((w) => {
            const sh = w.worksheets.find((x) => x.id === report.id);
            if (!sh) return;
            const t = textItem(2 * g, y + g, sh.page.w - 4 * g, text, 8);
            sh.items.push(t);
            growPageToFit(sh, [{ ...t, h: (text.split('\n').length + 4) * 8 * 1.6 }]);
          }),
        );
      }
    }
    useStore.getState().setUI({ view: 'sheet', activeSheetId: report.id, selectedItemIds: [] });
  } finally {
    squashSince(before, 'ai');
  }
  return res;
}

function uniqueSheet(ws: Workspace, base: string): string {
  const taken = new Set(ws.worksheets.map((w) => w.name));
  let n = base;
  for (let k = 2; taken.has(n); k++) n = `${base} ${k}`;
  return n;
}

function uniqueTable(ws: Workspace, base: string): string {
  const taken = new Set(ws.tables.map((w) => w.name));
  let n = base;
  for (let k = 2; taken.has(n); k++) n = `${base} ${k}`;
  return n;
}

// ------------------------------------------------------------------ results text

const fmt = (v: number) => (!Number.isFinite(v) ? '-' : Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toPrecision(3));

/** The computed numbers the results are written from: per output, per sample (and per group mean, SD, n). */
export function resultsNumbers(ws: Workspace, analyzed: string[], names: boolean, made: { sheetId: string; tables: string[] }): string {
  const label = (id: string) => (names ? ws.samples.find((s) => s.id === id)?.name ?? id : `Sample ${ws.samples.findIndex((s) => s.id === id) + 1}`);
  const lines: string[] = [];
  const cols: { title: string; col: StatColumn }[] = [];
  // the charts and tables this run made
  for (const it of ws.worksheets.find((w) => w.id === made.sheetId)?.items ?? []) if (it.kind === 'chart' && !it.plate && !it.calib) cols.push({ title: it.title ?? 'chart', col: it.stat });
  for (const t of ws.tables.filter((x) => made.tables.includes(x.name))) for (const col of t.columns) cols.push({ title: t.name, col });
  const seen = new Set<string>();
  const groups = ws.groups.filter((g) => g.sampleIds.some((id) => analyzed.includes(id)));
  for (const { title, col } of cols) {
    const key = `${col.population}|${col.stat}|${col.channel ?? ''}`;
    if (seen.has(key) || lines.length > 400) continue;
    seen.add(key);
    const popN = col.population === 'root' ? 'All events' : popById(ws, col.population)?.name ?? '?';
    lines.push(`${popN}, ${STAT_LABELS[col.stat]}${col.channel ? ` of ${chan(ws, col.channel)}` : ''} (${title}):`);
    const val = (sid: string) => (engine.statNotApplicable(ws, sid, col) ? NaN : engine.stat(ws, sid, col));
    lines.push(`  per sample: ${analyzed.slice(0, 48).map((sid) => `${label(sid)} ${fmt(val(sid))}`).join('; ')}`);
    for (const g of groups) {
      const v = g.sampleIds.filter((id) => analyzed.includes(id)).map(val).filter(Number.isFinite);
      if (!v.length) continue;
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : NaN;
      lines.push(`  group ${names ? g.name : `G${ws.groups.indexOf(g) + 1} (${g.name})`}: mean ${fmt(m)}, SD ${fmt(sd)}, n ${v.length}`);
    }
  }
  const counts = analyzed.slice(0, 48).map((sid) => `${label(sid)} ${engine.count(ws, sid, null)}`);
  lines.unshift(`Events per sample: ${counts.join('; ')}`, `Gating tree (gating sample):\n${treeText(ws, useStore.getState().ui.activeSampleId, 30)}`);
  return lines.join('\n');
}

async function askResults(p: AiProvider, plan: AnalysisPlan, analyzed: string[], signal: AbortSignal, names: boolean, made: { sheetId: string; tables: string[] }, protocol: Protocol | null): Promise<ResultsText> {
  const ws = useStore.getState().ws;
  const text =
    `You analysed a flow cytometry experiment for a scientist. The app has gated it and computed the numbers below. Write the results section of a short analysis report.

What the experiment is: ${plan.summary || '(not stated)'}
Assumptions made: ${plan.assumptions.join(' ') || 'none'}
${protocol ? `\nThe scientist's protocol (file "${protocol.name}"): use its experimental details (conditions, controls, expected results, the question asked) to interpret the numbers, and say where the data agree or disagree with what it expects:\n"""\n${protocol.text.slice(0, 20000)}\n"""\n` : ''}
${resultsNumbers(ws, analyzed, names, made).slice(0, protocol ? 28000 : 45000)}

Rules: only statements the numbers support; give the numbers; say "n = 1, no statistics" where a group has one sample; flag small populations (fewer than about 100 events), large variation between replicates, and anything that looks like a gating or acquisition problem. No statistical tests unless the numbers allow them (they mostly do not: say so). Plain text, no Markdown.

Reply with only a JSON object:
{"headline": "one sentence: the main result", "findings": ["2 to 6 sentences, one per finding, with numbers"], "caveats": ["what to check"], "next": ["at most 3 suggested next steps"]}
Inside the JSON strings use single quotes, never double quotes.`;
  const prompt = names ? text : redact(text, ws);
  const { value } = await completeJson<Record<string, unknown>>(p, { prompt, tier: 'default', signal, maxTokens: 8000, fresh: true });
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const list = (x: unknown, n: number) => (Array.isArray(x) ? x : []).map((a) => str(a, 500)).filter(Boolean).slice(0, n);
  return { headline: str(o.headline, 400), findings: list(o.findings, 8), caveats: list(o.caveats, 5), next: list(o.next, 3) };
}
