// Group- / sample-specific gating trees: setting a population's scope and copying gates to a group.
import { popById, type PopScope, type Population } from '../core/model';
import { applies, cleanScope, gateGroupOf, inScope, inScopeChain, scopeLabel, scopeWithout } from '../core/scope';
import { cloneGates, collectGates } from '../ui/gateOps';
import { useStore, type ToastAction } from './store';

function undoTo(after: unknown): ToastAction {
  return {
    label: 'Undo',
    run: () => {
      const s = useStore.getState();
      if (s.ws === after) s.undo();
      else s.toast('Other changes were made since. Use Undo (Ctrl+Z) to step back.', 'info');
    },
  };
}

/**
 * Set the samples a population and its subtree apply to (undefined: all samples). Quadrant and split gates change as a
 * whole (all regions). Samples outside the scope show the populations as n/a.
 */
export function setPopScope(popId: string, scope: PopScope | undefined, opts: { quiet?: boolean } = {}) {
  const st = useStore.getState();
  const ws = st.ws;
  const pop = popById(ws, popId);
  if (!pop) return;
  const clean = cleanScope(ws, scope);
  const ids = new Set(gateGroupOf(ws, pop).map((p) => p.id));
  st.update((w) => {
    for (const p of w.populations) {
      if (!ids.has(p.id)) continue;
      if (clean) p.scope = structuredClone(clean);
      else delete p.scope;
    }
  });
  st.setUI((u) => ({ dataVersion: u.dataVersion + 1 }));
  if (opts.quiet) return;
  const after = useStore.getState();
  const active = after.ui.activeSampleId;
  const hidden = active && !applies(after.ws, active, popId);
  const what = ids.size > 1 ? `'${pop.name}' and the other regions of its gate` : `'${pop.name}'`;
  after.toast(`${what} now appl${ids.size > 1 ? 'y' : 'ies'} to ${scopeLabel(after.ws, clean)}${hidden ? ' (not to the active sample: shown under "Show all")' : ''}`, 'success', {
    action: undoTo(after.ws),
  });
}

/**
 * Copy a population's gate with its subpopulations for the samples of group `groupId`: the copies sit next to the
 * original under the same parent, keep its names (tables match populations by name across groups) and apply to that
 * group only; the original stops applying to the group's samples. Returns the top-level copies.
 */
export function copyGatesToGroup(popId: string, groupId: string): Population[] {
  const st = useStore.getState();
  const ws = st.ws;
  const pop = popById(ws, popId);
  const grp = ws.groups.find((g) => g.id === groupId);
  if (!pop || !grp) return [];
  if (pop.parentId && !grp.sampleIds.some((sid) => inScopeChain(ws, sid, pop.parentId))) {
    const par = popById(ws, pop.parentId);
    st.toast(`'${par?.name}' does not apply to group ${grp.name}, so copies under it would not either. Copy '${par?.name}' (or a population above it) to the group instead.`, 'error');
    return [];
  }
  const clip = collectGates(ws, popId, true);
  if (!clip) return [];
  const made = cloneGates(ws, clip, pop.parentId, { keepNames: true, scope: { groups: [groupId] } });
  const roots = [...clip.roots];
  // the original keeps applying to the other samples only (if it reached the group's samples at all)
  const overlaps = grp.sampleIds.some((sid) => inScope(ws, pop.scope, sid));
  const narrowed = overlaps ? scopeWithout(ws, pop.scope, groupId) : null;
  st.update((w) => {
    if (narrowed)
      for (const p of w.populations) if (roots.includes(p.id)) p.scope = structuredClone(narrowed);
    // the copies right after the original's gate group, so the tree keeps its order
    const last = Math.max(...roots.map((r) => w.populations.findIndex((p) => p.id === r)));
    const subs = new Set(clip.pops.map((p) => p.id));
    let at = last;
    for (let i = last + 1; i < w.populations.length; i++) if (subs.has(w.populations[i].id)) at = i;
    w.populations.splice(at + 1, 0, ...made);
  });
  st.setUI((u) => ({ dataVersion: u.dataVersion + 1 }));
  const after = useStore.getState();
  const tops = made.filter((p) => p.parentId === pop.parentId);
  const active = after.ui.activeSampleId;
  if (active && grp.sampleIds.includes(active) && tops[0]) after.setUI({ selectedPopId: tops[0].id });
  after.toast(
    `Copied ${clip.label} for group ${grp.name}${narrowed ? `; the original now applies to ${scopeLabel(after.ws, narrowed)}` : ''}. Adjust the copied gates on a sample of ${grp.name}.`,
    'success',
    { action: undoTo(after.ws), duration: 10000 },
  );
  return tops;
}
