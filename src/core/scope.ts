// Per-group / per-sample gating trees and "not applicable" populations.
//
// A population applies to a sample unless
//   - it (or an ancestor) has a scope that leaves the sample out (group- or sample-specific gates),
//   - its gate (or an ancestor's) uses a channel the sample does not have (e.g. a 7-AAD gate on a file without 7-AAD),
//   - it is a Boolean gate whose operands do not apply (AND / NOT: any operand; OR: all operands),
//   - an older imported workspace left an empty gate for the sample (FlowJo sample without this population).
// Such populations have no events in that sample, but statistics, tables and exports report them as n/a, not as 0.
import { gateParams, missingChannelReason, popById, sampleHasChannel, type GateGeom, type PopScope, type Population, type StatColumn, type Workspace } from './model';

/** Whether `sampleId` is in a scope (no scope: every sample). */
export function inScope(ws: Workspace, scope: PopScope | undefined, sampleId: string): boolean {
  if (!scope) return true;
  if (scope.samples?.includes(sampleId)) return true;
  if (scope.groups?.some((gid) => ws.groups.find((g) => g.id === gid)?.sampleIds.includes(sampleId))) return true;
  return false;
}

/** Ids of the workspace samples in a scope, in workspace order. */
export function scopeSampleIds(ws: Workspace, scope: PopScope | undefined): string[] {
  return ws.samples.filter((s) => inScope(ws, scope, s.id)).map((s) => s.id);
}

/** Nearest population (itself or an ancestor) that carries a scope, or undefined. */
export function scopeOwner(ws: Workspace, popId: string): Population | undefined {
  const seen = new Set<string>();
  let p = popById(ws, popId);
  while (p && !seen.has(p.id)) {
    if (p.scope) return p;
    seen.add(p.id);
    p = p.parentId ? popById(ws, p.parentId) : undefined;
  }
  return undefined;
}

/** Short description of a scope: "group Stim", "groups A, B", "sample X", "3 samples", "group A + 1 sample". */
export function scopeLabel(ws: Workspace, scope: PopScope | undefined): string {
  if (!scope) return 'all samples';
  const groups = (scope.groups ?? []).map((id) => ws.groups.find((g) => g.id === id)?.name).filter((n): n is string => !!n);
  const samples = (scope.samples ?? []).map((id) => ws.samples.find((s) => s.id === id)?.name).filter((n): n is string => !!n);
  const parts: string[] = [];
  if (groups.length) parts.push(`${groups.length > 1 ? 'groups' : 'group'} ${groups.join(', ')}`);
  if (samples.length) parts.push(samples.length === 1 && !groups.length ? `sample ${samples[0]}` : `${samples.length} sample${samples.length > 1 ? 's' : ''}`);
  return parts.join(' + ') || 'no samples';
}

/** Compact tag for the population tree: the group name, "1 sample", "3 samples". */
export function scopeTag(ws: Workspace, scope: PopScope | undefined): string {
  if (!scope) return '';
  const groups = (scope.groups ?? []).map((id) => ws.groups.find((g) => g.id === id)?.name).filter((n): n is string => !!n);
  const ns = (scope.samples ?? []).filter((id) => ws.samples.some((s) => s.id === id)).length;
  const parts = [...groups];
  if (ns) parts.push(`${ns} sample${ns > 1 ? 's' : ''}`);
  return parts.join(' + ') || 'no samples';
}

/** A scope without entries means "no samples"; normalize: drop unknown ids and duplicates (keeps an explicit empty scope). */
export function cleanScope(ws: Workspace, scope: PopScope | undefined): PopScope | undefined {
  if (!scope) return undefined;
  const groups = [...new Set(scope.groups ?? [])].filter((id) => ws.groups.some((g) => g.id === id));
  const samples = [...new Set(scope.samples ?? [])].filter((id) => ws.samples.some((s) => s.id === id));
  const out: PopScope = {};
  if (groups.length) out.groups = groups;
  if (samples.length) out.samples = samples;
  return out;
}

/** The legacy "no gate for this sample" geometry of imported workspaces (an OR without operands). */
export function isEmptyGate(g: GateGeom | undefined): boolean {
  return !!g && g.type === 'bool' && g.op === 'or' && !g.operands.length;
}

/** A sample's geometry of a population (sample-specific override or the shared gate). */
function gateOf(p: Population, sampleId: string): GateGeom {
  return p.overrides?.[sampleId] ?? p.gate;
}

/** Measured channels per sample, cached per samples array (workspaces are immutable; large tables ask often). */
const channelCache = new WeakMap<object, { n: number; map: Map<string, Set<string>> }>();
function measured(ws: Workspace, sampleId: string): Set<string> | undefined {
  let c = channelCache.get(ws.samples);
  if (!c || c.n !== ws.samples.length) {
    c = { n: ws.samples.length, map: new Map(ws.samples.map((s) => [s.id, new Set(s.channels.map((x) => x.name))])) };
    channelCache.set(ws.samples, c);
  }
  return c.map.get(sampleId);
}

/**
 * Whether the channel test can be made: the sample is known to the workspace with its channel list (workspaces built
 * in code may leave the list empty; then every channel counts as present).
 */
function knowsChannels(ws: Workspace, sampleId: string): boolean {
  return !!measured(ws, sampleId)?.size;
}

/** Whether a sample has a channel (measured, else a derived output it can compute). */
function hasChannel(ws: Workspace, sampleId: string, ch: string): boolean {
  return !!measured(ws, sampleId)?.has(ch) || (!!ws.derived?.length && sampleHasChannel(ws, sampleId, ch));
}

/** Why `popId` does not apply to `sampleId` (null: it applies). The reason of the topmost failing population is given. */
export function popNotApplicableReason(ws: Workspace, sampleId: string | null | undefined, popId: string | null | undefined): string | null {
  if (!sampleId || !popId || popId === 'root') return null;
  return reasonOf(ws, sampleId, popId, new Map(), new Set());
}

function reasonOf(ws: Workspace, sampleId: string, popId: string, memo: Map<string, string | null>, stack: Set<string>): string | null {
  if (popId === 'root') return null;
  const hit = memo.get(popId);
  if (hit !== undefined) return hit;
  const p = popById(ws, popId);
  // unknown populations and cycles (a Boolean using itself through others) are left to the gating code
  if (!p || stack.has(popId)) return null;
  stack.add(popId);
  const r = ((): string | null => {
    if (p.parentId) {
      const up = reasonOf(ws, sampleId, p.parentId, memo, stack);
      if (up) return up;
    }
    if (p.scope && !inScope(ws, p.scope, sampleId)) return `'${p.name}' applies only to ${scopeLabel(ws, p.scope)}`;
    const g = gateOf(p, sampleId);
    if (isEmptyGate(g) && p.overrides?.[sampleId]) return `'${p.name}' has no gate for this sample`;
    if (g.type === 'bool') {
      const ops = g.operands.map((o) => o.replace(/^!/, '')).filter((o) => o !== 'root' && o !== p.id && !!popById(ws, o));
      const why = ops.map((o) => reasonOf(ws, sampleId, o, memo, stack));
      const bad = g.op === 'or' ? (why.length && why.every((w) => !!w) ? why[0] : null) : (why.find((w) => !!w) ?? null);
      return bad ? `'${p.name}' uses a population that does not apply here (${bad})` : null;
    }
    if (knowsChannels(ws, sampleId)) {
      const lacking = gateParams(g).filter((ch) => !hasChannel(ws, sampleId, ch));
      if (lacking.length) return `'${p.name}': ${missingChannelReason(ws, lacking[0], sampleId)}`;
    }
    return null;
  })();
  stack.delete(popId);
  memo.set(popId, r);
  return r;
}

/** Whether a population (and its ancestors) applies to a sample; 'root' (All Events) always does. */
export function applies(ws: Workspace, sampleId: string | null | undefined, popId: string | null | undefined): boolean {
  return popNotApplicableReason(ws, sampleId, popId) === null;
}

/** Whether the scopes of a population and its ancestors include a sample (channels are not considered). */
export function inScopeChain(ws: Workspace, sampleId: string, popId: string | null | undefined): boolean {
  const seen = new Set<string>();
  let p = popId && popId !== 'root' ? popById(ws, popId) : undefined;
  while (p && !seen.has(p.id)) {
    if (p.scope && !inScope(ws, p.scope, sampleId)) return false;
    seen.add(p.id);
    p = p.parentId ? popById(ws, p.parentId) : undefined;
  }
  return true;
}

/** Names from the top of the tree down to a population (its path), or null if it does not exist. */
function namePath(ws: Workspace, popId: string): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  let p = popById(ws, popId);
  if (!p) return null;
  while (p && !seen.has(p.id)) {
    out.unshift(p.name);
    seen.add(p.id);
    p = p.parentId ? popById(ws, p.parentId) : undefined;
  }
  return out;
}

/** Other populations with the same path of names as `popId` (e.g. the copy of a gating tree made for another group). */
export function samePathPops(ws: Workspace, popId: string): string[] {
  const path = namePath(ws, popId);
  if (!path) return [];
  const key = JSON.stringify(path);
  const name = path[path.length - 1];
  return ws.populations.filter((q) => q.id !== popId && q.name === name && JSON.stringify(namePath(ws, q.id)) === key).map((q) => q.id);
}

/**
 * The population that stands for `popId` in a sample: itself when it applies, else a population with the same path of
 * names that applies there (group-specific copies of a gating tree), else `popId` (not applicable).
 * Statistics use this, so a table column "Lymphocytes / CD4+" shows each sample's own group-specific gate.
 */
export function resolvePopFor(ws: Workspace, sampleId: string, popId: string): string {
  if (!popId || popId === 'root' || applies(ws, sampleId, popId)) return popId;
  for (const q of samePathPops(ws, popId)) if (applies(ws, sampleId, q)) return q;
  return popId;
}

/** A statistic with its population and "% of" reference resolved for a sample (see resolvePopFor). */
export function resolveStatCol<C extends Pick<StatColumn, 'population' | 'ofPopulation'>>(ws: Workspace, sampleId: string, col: C): C {
  const pop = resolvePopFor(ws, sampleId, col.population || 'root');
  const of = col.ofPopulation ? resolvePopFor(ws, sampleId, col.ofPopulation) : col.ofPopulation;
  return pop === (col.population || 'root') && of === col.ofPopulation ? col : { ...col, population: pop, ofPopulation: of };
}

/**
 * Why a statistic has no value for a sample: its population (or the "% of" reference) does not apply, or the channel
 * is not measured / computed there. null: the statistic applies (it may still be undefined, e.g. no events).
 * Populations are resolved for the sample first (see resolvePopFor).
 */
export function statNotApplicableReason(ws: Workspace, sampleId: string, column: Pick<StatColumn, 'population' | 'stat' | 'channel' | 'ofPopulation'>): string | null {
  const col = resolveStatCol(ws, sampleId, column);
  const pop = popNotApplicableReason(ws, sampleId, col.population || 'root');
  if (pop) return pop;
  if (col.stat === 'freqOf' && col.ofPopulation) {
    const ref = popNotApplicableReason(ws, sampleId, col.ofPopulation);
    if (ref) return ref;
  }
  if (col.channel && STAT_CHANNEL.has(col.stat) && knowsChannels(ws, sampleId) && !hasChannel(ws, sampleId, col.channel)) return missingChannelReason(ws, col.channel, sampleId);
  return null;
}

const STAT_CHANNEL = new Set(['mean', 'median', 'geomean', 'sd', 'cv', 'rsd', 'rcv', 'min', 'max', 'percentile', 'mode']);

/** Display text of a statistic cell: "n/a" when it does not apply to the sample, else `format(value)`. */
export function statCellText(ws: Workspace, sampleId: string | null, col: Pick<StatColumn, 'population' | 'stat' | 'channel' | 'ofPopulation'>, value: number, format: (v: number) => string): string {
  if (sampleId && statNotApplicableReason(ws, sampleId, col)) return 'n/a';
  return format(value);
}

/**
 * Populations shown in the tree for a sample: those that apply, plus (so the tree stays connected) nothing else.
 * Returns the set of population ids that apply to the sample.
 */
export function applicablePopIds(ws: Workspace, sampleId: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const p of ws.populations) if (!sampleId || applies(ws, sampleId, p.id)) out.add(p.id);
  return out;
}

/** Populations sharing a quadrant / split group with `p` (all regions of the gate), incl. `p`. */
export function gateGroupOf(ws: Workspace, p: Population): Population[] {
  const g = p.gate;
  if (g.type !== 'quadrant' && g.type !== 'split') return [p];
  return ws.populations.filter((q) => q.parentId === p.parentId && q.gate.type === g.type && (q.gate as { groupId: string }).groupId === g.groupId);
}

/**
 * The same scope without the members of group `groupId`: groups lose it; when the population had no scope, the other
 * groups if they cover every remaining sample, else the remaining samples by id.
 */
export function scopeWithout(ws: Workspace, scope: PopScope | undefined, groupId: string): PopScope {
  const grp = ws.groups.find((g) => g.id === groupId);
  const out = new Set(grp?.sampleIds ?? []);
  if (scope) {
    const groups = (scope.groups ?? []).filter((g) => g !== groupId);
    const samples = (scope.samples ?? []).filter((s) => !out.has(s));
    const res: PopScope = {};
    if (groups.length) res.groups = groups;
    if (samples.length) res.samples = samples;
    // samples of the removed group still reached through another listed group stay (group membership is live)
    return res;
  }
  const rest = ws.samples.filter((s) => !out.has(s.id)).map((s) => s.id);
  const others = ws.groups.filter((g) => g.id !== groupId && !g.sampleIds.some((id) => out.has(id)));
  const covered = new Set(others.flatMap((g) => g.sampleIds));
  if (others.length && rest.every((id) => covered.has(id)) && [...covered].every((id) => rest.includes(id))) return { groups: others.map((g) => g.id) };
  return { samples: rest };
}

/**
 * A group is deleted: populations scoped to it keep applying to the same samples (its members are listed instead of the
 * group). Works on immer drafts (call inside the update that removes the group).
 */
export function replaceGroupInScopes(pops: Population[], group: { id: string; sampleIds: string[] }) {
  for (const p of pops) {
    const sc = p.scope;
    if (!sc?.groups?.includes(group.id)) continue;
    sc.groups = sc.groups.filter((g) => g !== group.id);
    sc.samples = [...new Set([...(sc.samples ?? []), ...group.sampleIds])];
    if (!sc.groups.length) delete sc.groups;
    if (!sc.samples.length) delete sc.samples;
  }
}
