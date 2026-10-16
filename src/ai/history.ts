// Several workspace changes made by one AI action (a strategy run) become one undo step.
import type { Workspace } from '../core/model';
import { stepActor, useStore } from '../state/store';

/**
 * Merge the undo steps made since `before` was the current workspace into one. With `actor` (see runAs / markStep in
 * state/store.ts), only steps made by that actor are merged, and only runs of consecutive ones: edits the user made in
 * between (e.g. while an AI run waited for the model) stay undo steps of their own. Returns false if `before` is not
 * in the history (or nothing was changed since).
 */
export function squashSince(before: Workspace, actor?: string): boolean {
  const s = useStore.getState();
  if (s.ws === before) return false;
  const i = s.past.lastIndexOf(before);
  if (i < 0) return false;
  if (actor === undefined) {
    useStore.setState({ past: s.past.slice(0, i + 1), lastKey: null });
    return true;
  }
  // chain[0] = before, chain[k] = the workspace after step k
  const chain = [...s.past.slice(i), s.ws];
  const keep: Workspace[] = [before];
  // a state between two steps of the actor is dropped: the two become one step
  for (let k = 1; k < chain.length - 1; k++) if (!(stepActor(chain[k]) === actor && stepActor(chain[k + 1]) === actor)) keep.push(chain[k]);
  useStore.setState({ past: [...s.past.slice(0, i), ...keep], lastKey: null });
  return true;
}

/** Number of undo steps from `before` to the current workspace (-1: `before` is not in the history). */
export function stepsSince(before: Workspace): number {
  const s = useStore.getState();
  if (s.ws === before) return 0;
  const i = s.past.lastIndexOf(before);
  return i < 0 ? -1 : s.past.length - i;
}

/** Toast action that undoes the whole AI action while nothing else was changed since. */
export function undoRunAction(after: Workspace) {
  return {
    label: 'Undo',
    run: () => {
      const s = useStore.getState();
      if (s.ws === after) s.undo();
      else s.toast('Other changes were made since. Use Undo (Ctrl+Z) to step back.', 'info');
    },
  };
}
