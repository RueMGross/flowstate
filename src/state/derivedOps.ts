// Workspace operations for derived (computed) channels.
import { derivedInputs, type DerivedDef } from '../core/derived';
import { engine } from '../core/engine';
import { allChannels, missingChannelReason, type Workspace } from '../core/model';
import { shortChannelName } from '../core/naming';
import { defaultScaleFor, type ScaleDef } from '../core/transforms';
import { useStore } from './store';

export { missingChannelReason };

/** Insert or replace a derived definition (by id). `scales` sets display scales for new output channels. */
export function upsertDerived(def: DerivedDef, scales: Record<string, ScaleDef> = {}) {
  const st = useStore.getState();
  // creation paths pick free names (freeChannelName); a measured channel of that name would hide the output
  const measured = new Set(st.ws.samples.flatMap((s) => s.channels.map((c) => c.name)));
  const clash = def.outputs.map((o) => o.name).filter((n) => measured.has(n));
  if (clash.length)
    st.toast(`${clash.map((c) => `"${c}"`).join(', ')} ${clash.length > 1 ? 'are' : 'is'} also a measured channel: samples that measure it show the measured values, not "${def.name}". Rename the output to tell them apart.`, 'info', { duration: 10000 });
  st.update((ws) => {
    const list = (ws.derived ??= []);
    const i = list.findIndex((d) => d.id === def.id);
    if (i >= 0) list[i] = def;
    else list.push(def);
    for (const [ch, sc] of Object.entries(scales)) if (!ws.scales[ch]) ws.scales[ch] = sc;
  });
  st.setUI((u) => ({ dataVersion: u.dataVersion + 1 }));
}

/** Definitions that read the outputs of `id`, directly or through other definitions (e.g. MESF of an unmixed channel). */
export function derivedDependents(ws: Workspace, id: string): DerivedDef[] {
  const list = ws.derived ?? [];
  const out: DerivedDef[] = [];
  const gone = new Set<string>(list.find((d) => d.id === id)?.outputs.map((o) => o.name) ?? []);
  const done = new Set<string>([id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of list) {
      if (done.has(d.id)) continue;
      const ins = derivedInputs(d);
      // unmixing reads measured detectors only; the other kinds read one (possibly derived) channel
      if (d.kind !== 'unmix' && ins.some((c) => gone.has(c))) {
        out.push(d);
        done.add(d.id);
        for (const o of d.outputs) gone.add(o.name);
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Remove a derived definition; plots and gates on its outputs remain but show the channel as missing.
 * `withDependents`: also remove the definitions built on its outputs (see derivedDependents); otherwise they stay and
 * have no values until an input with the same name exists again.
 */
export function removeDerived(id: string, opts: { withDependents?: boolean } = {}) {
  const st = useStore.getState();
  const def = st.ws.derived?.find((d) => d.id === id);
  if (!def) return;
  const deps = derivedDependents(st.ws, id);
  const kill = new Set([id, ...(opts.withDependents ? deps.map((d) => d.id) : [])]);
  const outs = new Set((st.ws.derived ?? []).filter((d) => kill.has(d.id)).flatMap((d) => d.outputs.map((o) => o.name)));
  const usedByGates = st.ws.populations.filter((p) => 'x' in p.gate && (outs.has(p.gate.x) || ('y' in p.gate && outs.has(p.gate.y as string))));
  st.update((ws) => {
    ws.derived = (ws.derived ?? []).filter((d) => !kill.has(d.id));
  });
  st.setUI((u) => ({ dataVersion: u.dataVersion + 1 }));
  const kept = opts.withDependents ? [] : deps;
  const parts = [`Removed "${def.name}"${opts.withDependents && deps.length ? ` and ${deps.length} dependent calibration${deps.length > 1 ? 's' : ''}` : ''}`];
  if (kept.length) parts.push(`${kept.map((d) => `"${d.name}"`).join(', ')} now ${kept.length > 1 ? 'have' : 'has'} no input`);
  if (usedByGates.length) parts.push(`${usedByGates.length} gate(s) use the removed channels and now match nothing`);
  st.toast(parts.join('; '), 'info', {
    action: { label: 'Undo', run: () => useStore.getState().undo() },
  });
}

/** A channel name that does not collide with measured channels (of any sample) or with other derived channels. */
export function freeChannelName(base: string, exceptDefId?: string): string {
  const ws = useStore.getState().ws;
  const taken = new Set(allChannels({ ...ws, derived: (ws.derived ?? []).filter((d) => d.id !== exceptDefId) }).map((c) => c.name));
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base} ${i}`;
  return n;
}

/**
 * Derived output names that a sample measures itself. The measured channel wins in that sample (engine.raw), so the
 * computed values are hidden there.
 */
export function derivedNameCollisions(ws: Workspace, sampleIds?: string[]): { sample: string; channel: string; def: string }[] {
  const out: { sample: string; channel: string; def: string }[] = [];
  for (const s of ws.samples) {
    if (sampleIds && !sampleIds.includes(s.id)) continue;
    const have = new Set(s.channels.map((c) => c.name));
    for (const d of ws.derived ?? []) for (const o of d.outputs) if (have.has(o.name)) out.push({ sample: s.name, channel: o.name, def: d.name });
  }
  return out;
}

// Warn once when newly added samples measure a channel named like a derived output (e.g. a re-exported FCS file that
// already contains "FITC-A MESF"): in those samples the file's channel is used, not the calibration.
const warnedCollisions = new Set<string>();
let knownSamples = new Set<string>();
function checkNewSamples(ws: Workspace) {
  const ids = ws.samples.map((s) => s.id);
  const fresh = ids.filter((id) => !knownSamples.has(id));
  knownSamples = new Set(ids);
  if (!fresh.length || !ws.derived?.length) return;
  const hits = derivedNameCollisions(ws, fresh).filter((h) => !warnedCollisions.has(`${h.sample}|${h.channel}`));
  if (!hits.length) return;
  for (const h of hits) warnedCollisions.add(`${h.sample}|${h.channel}`);
  const chans = [...new Set(hits.map((h) => h.channel))];
  const samples = [...new Set(hits.map((h) => h.sample))];
  useStore
    .getState()
    .toast(
      `${samples.length === 1 ? `"${samples[0]}" measures` : `${samples.length} new samples measure`} ${chans.map((c) => `"${c}"`).join(', ')}, the name of a computed channel. In ${samples.length === 1 ? 'that sample' : 'those samples'} the measured values are used; rename the calibration output to compare both.`,
      'info',
      { duration: 12000 },
    );
}

let watching = false;
/** Start the collision watch (idempotent; called on module load). */
export function watchDerivedNameCollisions() {
  if (watching) return;
  watching = true;
  knownSamples = new Set(useStore.getState().ws.samples.map((s) => s.id));
  let prev = useStore.getState().ws.samples;
  useStore.subscribe((s) => {
    if (s.ws.samples === prev) return;
    prev = s.ws.samples;
    checkNewSamples(s.ws);
  });
}
try {
  watchDerivedNameCollisions();
} catch {
  /* store not available (tests) */
}

// ------------------------------------------------------------------ display scales of new outputs from their data

/**
 * Values of output `k` of a derived definition (not necessarily in the workspace yet) in the loaded samples it applies
 * to: up to `maxSamples` samples, each subsampled to about `perSample` events.
 */
export function derivedOutputValues(ws: Workspace, def: DerivedDef, k: number, opts: { maxSamples?: number; perSample?: number; sampleIds?: string[] } = {}): Float32Array {
  const tmp: Workspace = { ...ws, derived: [...(ws.derived ?? []).filter((d) => d.id !== def.id), def] };
  const per = opts.perSample ?? 20000;
  const ids = (opts.sampleIds ?? ws.samples.map((s) => s.id)).filter((id) => engine.has(id) && (!def.samples || def.samples.includes(id))).slice(0, opts.maxSamples ?? 8);
  const parts: Float32Array[] = [];
  for (const id of ids) {
    const v = engine.derivedOutputs(tmp, id, def)?.[k];
    if (!v) continue;
    const step = Math.max(1, Math.floor(v.length / per));
    const sub = new Float32Array(Math.ceil(v.length / step));
    for (let i = 0, j = 0; i < v.length; i += step, j++) sub[j] = v[i];
    parts.push(sub);
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function sortedFinite(values: Float32Array, positive: boolean): number[] {
  const a: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v) && (!positive || v > 0)) a.push(v);
  }
  return a.sort((x, y) => x - y);
}

const at = (a: number[], q: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];

/**
 * Log display scale over the whole decades around the robust range of the positive values (0.5 % .. 99.9 %), at least two
 * decades; null when there are too few values. Keeps derived axes (MESF, size) close to the data instead of spanning
 * the theoretical range of the calibration.
 */
export function dataLogScale(values: Float32Array, bounds?: [number, number]): ScaleDef | null {
  const a = sortedFinite(values, true);
  if (a.length < 20) return null;
  let lo = at(a, 0.005);
  let hi = at(a, 0.999);
  if (bounds) {
    lo = Math.max(lo, bounds[0]);
    hi = Math.min(hi, bounds[1]);
  }
  if (!(lo > 0) || !(hi >= lo)) return null;
  const l = Math.floor(Math.log10(lo) + 1e-9);
  let h = Math.ceil(Math.log10(hi) - 1e-9);
  if (h - l < 2) h = l + 2;
  return { type: 'log', min: Math.pow(10, l), max: Math.pow(10, h) };
}

function niceCeil125(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (m * p >= v * (1 - 1e-9)) return m * p;
  return 10 * p;
}

/** Logicle display scale whose top is the robust maximum of the values (nice 1-2-5 step); null without values. */
export function dataLogicleScale(name: string, values: Float32Array): ScaleDef | null {
  const a = sortedFinite(values, false);
  if (a.length < 20) return null;
  const hi = Math.max(at(a, 0.999), -at(a, 0.001));
  if (!(hi > 0)) return null;
  const T = niceCeil125(hi * 1.5);
  return defaultScaleFor(name, T, values, 'log');
}

/**
 * Default name of a computed channel: the short channel name and what it is ("FITC MESF", "VSSC1 diameter"), unique
 * among measured and computed channels (freeChannelName).
 */
export function defaultOutputName(channel: string, what: string, exceptDefId?: string): string {
  return freeChannelName(`${shortChannelName(channel)} ${what}`, exceptDefId);
}
