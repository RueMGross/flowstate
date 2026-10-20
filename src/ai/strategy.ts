// AI gating strategy: the model proposes a hierarchy from the panel (no images); the user edits it as a checklist; Run
// builds it step by step on a new worksheet "AI gating", each gate through "Gate with AI" and the auto gate preview,
// which the user accepts, adjusts or skips. The whole run is one undo step.
import { allChannels, newWorksheet, popById, type Workspace } from '../core/model';
import { defaultPlotSize, markStep, newPlotItem, runAs, useStore } from '../state/store';
import { addItems } from '../ui/layoutOps';
import type { AutoPreviewHandle } from '../ui/gateOps';
import { chan, instrumentOf, redact, sampleHints, treeText } from './context';
import { askAiGate, prepareAiGate, previewAiGate, type GatePrep } from './gate';
import { squashSince, stepsSince, undoRunAction } from './history';
import { strategyPrompt } from './prompts';
import { AiError, type AiProvider } from './provider';

export type StepStatus = 'waiting' | 'asking' | 'preview' | 'done' | 'skipped' | 'failed';

export interface StrategyStep {
  id: string;
  on: boolean;
  name: string;
  parent: string;
  plot: '2d' | 'histogram';
  x: string;
  y: string;
  target: string;
  status?: StepStatus;
  note?: string;
  popId?: string;
  /** the user's note on this step when reviewing a plan ("do this differently") */
  remark?: string;
}

export function strategyRequest(ws: Workspace, sampleId: string | null, goal: string): string {
  const panel = allChannels(ws)
    .map((c) => `${c.name}: ${ws.channelLabels[c.name] ?? c.label ?? ''}`)
    .join('\n');
  return redact(strategyPrompt({ panel, samples: sampleHints(ws), instrument: instrumentOf(sampleId), tree: treeText(ws, null, 30), goal: goal.trim() }), ws);
}

/** A channel named by the model: exact or case-insensitive channel name, else a marker label. */
export function resolveChannel(ws: Workspace, s: unknown): string | null {
  if (typeof s !== 'string' || !s.trim()) return null;
  const t = s.trim();
  const chans = allChannels(ws);
  const lc = t.toLowerCase();
  return (
    chans.find((c) => c.name === t)?.name ??
    chans.find((c) => c.name.toLowerCase() === lc)?.name ??
    chans.find((c) => (ws.channelLabels[c.name] ?? c.label ?? '').trim().toLowerCase() === lc)?.name ??
    chans.find((c) => chan(ws, c.name).toLowerCase() === lc)?.name ??
    unique(chans.filter((c) => (ws.channelLabels[c.name] ?? c.label ?? '').toLowerCase().split(/[^a-z0-9+]+/).includes(lc)).map((c) => c.name))
  );
}

/** the only element, else null */
function unique(a: string[]): string | null {
  return a.length === 1 ? a[0] : null;
}

let seq = 0;

/** The model's steps, checked: unknown channels switch a step off with a note. */
export function parseStrategy(ws: Workspace, v: unknown): { steps: StrategyStep[]; notes: string } {
  const o = (v && typeof v === 'object' ? v : {}) as { steps?: unknown; notes?: unknown };
  const raw = Array.isArray(o.steps) ? o.steps.slice(0, 12) : [];
  const names = new Set<string>();
  const steps = raw.map((r): StrategyStep => {
    const s = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const name = (typeof s.name === 'string' && s.name.trim().slice(0, 40)) || `Step ${names.size + 1}`;
    const x = resolveChannel(ws, s.x);
    const hist = s.plot === 'histogram' || !s.y || s.y === s.x;
    const y = hist ? x : resolveChannel(ws, s.y);
    const parent = typeof s.parent === 'string' && s.parent.trim() ? s.parent.trim() : 'All events';
    const bad = [!x && `unknown channel "${String(s.x ?? '')}"`, !hist && !y && `unknown channel "${String(s.y ?? '')}"`].filter(Boolean);
    names.add(name.toLowerCase());
    return { id: `st${++seq}`, on: !bad.length, name, parent, plot: hist ? 'histogram' : '2d', x: x ?? '', y: y ?? '', target: typeof s.target === 'string' ? s.target.trim().slice(0, 300) : name, note: bad.length ? `Off: ${bad.join(', ')}` : undefined };
  });
  return { steps, notes: typeof o.notes === 'string' ? o.notes.slice(0, 600) : '' };
}

export interface RunControl {
  provider: AiProvider;
  /** whether plot images are sent; a function is asked again for each step (settings changed during the run) */
  images: boolean | (() => boolean);
  signal: AbortSignal;
  update(id: string, patch: Partial<StrategyStep>): void;
  /** the preview the user is deciding on (null: none) */
  setHandle(h: AutoPreviewHandle | null): void;
  /** the request of the current step (shown as "what was sent") */
  setPrep(p: GatePrep | null): void;
  acceptAll(): boolean;
  /** no toast at the end (a larger AI action reports the run itself) */
  quiet?: boolean;
}

/** codes after which the run cannot go on */
const FATAL = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'auth', 'proxy_auth', 'forbidden', 'rate_limited', 'session_expired', 'network', 'not_configured', 'images_unavailable']);

export async function runStrategy(steps: StrategyStep[], c: RunControl): Promise<number> {
  const st = useStore.getState();
  const before = st.ws;
  const taken = new Set(before.worksheets.map((w) => w.name));
  let nm = 'AI gating';
  for (let k = 2; taken.has(nm); k++) nm = `AI gating ${k}`;
  const sheet = newWorksheet(nm);
  // the run's own changes are marked (runAs / markStep): edits the user makes meanwhile stay separate undo steps
  runAs('ai', () =>
    st.update((w) => {
      w.worksheets.push(sheet);
    }),
  );
  st.setUI({ activeSheetId: sheet.id, view: 'sheet', selectedItemIds: [], tool: 'select' });
  const made = new Map<string, string>();
  const { w: W, h: H } = defaultPlotSize();
  const g = sheet.grid;
  // at most 3 columns, so the plots (and their previews) stay left of the AI panel
  const cols = Math.max(1, Math.min(3, Math.floor((sheet.page.w - 3 * g) / (W + g))));
  let slot = 0;
  let created = 0;
  try {
    for (const s of steps) {
      if (!s.on) continue;
      if (c.signal.aborted) break;
      const ws = useStore.getState().ws;
      const pl = s.parent.toLowerCase();
      const parent = ['all events', 'root', 'all', 'ungated'].includes(pl) ? 'root' : made.get(pl) ?? ws.populations.find((p) => p.name.toLowerCase() === pl)?.id ?? null;
      if (!parent || (parent !== 'root' && !popById(ws, parent))) {
        c.update(s.id, { status: 'skipped', note: `Parent "${s.parent}" was not gated.` });
        continue;
      }
      const it = newPlotItem(s.plot === 'histogram' ? 'histogram' : 'pseudo', s.x, s.plot === 'histogram' ? s.x : s.y, 2 * g + (slot % cols) * (W + g), 2 * g + Math.floor(slot / cols) * (H + g), W, H, parent);
      slot++;
      runAs('ai', () => addItems(sheet.id, [it]));
      c.update(s.id, { status: 'asking', note: undefined });
      let popId: string | null = null;
      let why = 'Skipped.';
      try {
        const prep = await prepareAiGate(it.id, s.target || s.name, typeof c.images === 'function' ? c.images() : c.images);
        c.setPrep(prep);
        const out = await askAiGate(prep, c.provider, c.signal);
        if (!out.choice.seed) {
          c.update(s.id, { status: 'failed', note: out.choice.note + (out.answer.rationale ? ` ${String(out.answer.rationale).slice(0, 200)}` : '') });
          continue;
        }
        c.update(s.id, { status: 'preview', note: typeof out.answer.rationale === 'string' ? out.answer.rationale.slice(0, 300) : undefined });
        // the preview needs the plot on screen
        useStore.getState().setUI({ view: 'sheet', activeSheetId: sheet.id });
        popId = await new Promise<string | null>((resolve) => {
          // the gate is made by the preview (accepted by the user or automatically): it belongs to the run
          const done = (id: string | null) => {
            if (id) markStep('ai');
            resolve(id);
          };
          void previewAiGate(prep, out, done, s.name).then((h) => {
            if (!h || h === 'none') {
              why = h ? 'The auto gate found no population at this position.' : 'The plot was not shown, so no preview could be made.';
              return done(null);
            }
            c.setHandle(h);
            if (c.acceptAll()) setTimeout(() => h.ok(), 450);
            c.signal.addEventListener('abort', () => h.cancel(), { once: true });
          });
        });
      } catch (e) {
        const err = e instanceof AiError ? e : new AiError('upstream_error', String(e));
        if (err.code === 'cancelled') break;
        c.update(s.id, { status: 'failed', note: err.message });
        if (FATAL.has(err.code)) throw err;
        continue;
      } finally {
        c.setHandle(null);
      }
      if (popId) {
        made.set(s.name.toLowerCase(), popId);
        created++;
        c.update(s.id, { status: 'done', popId });
      } else c.update(s.id, { status: 'skipped', note: why });
    }
  } finally {
    c.setPrep(null);
    squashSince(before, 'ai');
    const after = useStore.getState().ws;
    const steps = stepsSince(before);
    if (after !== before && !c.quiet)
      useStore
        .getState()
        .toast(
          `AI gating: ${created} gate${created === 1 ? '' : 's'} on sheet "${nm}". ${steps === 1 ? 'Undo removes the whole run.' : `Edits you made while it ran are undo steps of their own: Undo (Ctrl+Z) steps back through the run in ${steps} steps.`}`,
          'success',
          steps === 1 ? { action: undoRunAction(after) } : { duration: 9000 },
        );
  }
  return created;
}
