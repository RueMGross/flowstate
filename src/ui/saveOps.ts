// Saving from the UI: a workspace still called "Untitled workspace" is named first (the name becomes the file name).
import { saveTemplate, saveWorkspaceBundle, saveWorkspaceJson } from '../io/files';
import { emptyWorkspace, type Workspace } from '../core/model';
import { useStore } from '../state/store';
import { isControlSampleName } from './layoutOps';

export type SaveKind = 'json' | 'bundle' | 'template';

const UNTITLED = emptyWorkspace().name;

export function needsName(ws: Workspace): boolean {
  const n = ws.name.trim();
  return !n || n === UNTITLED;
}

const SAVERS: Record<SaveKind, () => Promise<unknown>> = { json: saveWorkspaceJson, bundle: saveWorkspaceBundle, template: saveTemplate };

export function runSave(kind: SaveKind) {
  void SAVERS[kind]();
}

/** Save, asking for a name first while the workspace is untitled. */
export function requestSave(kind: SaveKind) {
  const st = useStore.getState();
  if (needsName(st.ws)) st.setUI({ dialog: { kind: 'saveName', payload: { kind } } });
  else runSave(kind);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** ISO date (YYYY-MM-DD) of an FCS $DATE such as "11-OCT-2026", "2026-10-11" or "10/11/2026", else null. */
export function isoDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  let m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/](\d{2,4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (mo > 0) return `${y}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

/** A sensible default name: the common start of the sample names (else the first sample) and the acquisition date. */
export function suggestName(ws: Workspace, today = new Date()): string {
  const all = ws.samples.map((s) => s.name.trim()).filter(Boolean);
  // controls (unstained, beads, compensation tubes) say little about the experiment
  const exp = all.filter((n) => !isControlSampleName(n));
  const names = exp.length ? exp : all;
  let base = '';
  if (names.length > 1) {
    let pre = names[0];
    for (const n of names) while (pre && !n.startsWith(pre)) pre = pre.slice(0, -1);
    // (wells: "Plate1_A1", "Plate1_A2" share "Plate1_A", the row letter is not part of the name)
    if (/[\s_\-.][A-Pa-p]$/.test(pre) && names.every((n) => /^\d/.test(n.slice(pre.length)))) pre = pre.slice(0, -1);
    base = pre.replace(/[\s_\-.(]+$/, '');
    if (base.length < 4) base = '';
  }
  if (!base) base = names[0] ?? 'Analysis';
  const date = isoDate(ws.samples.map((s) => s.info?.Date).find(Boolean)) ?? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return base.includes(date) ? base : `${base} ${date}`;
}

/**
 * Name of a new analysis from its data (when files are opened into an untitled workspace): the experiment named in the
 * FCS keywords (FACSDiva "EXPERIMENT NAME", CytExpert / others $PROJ), else the folder opened, else the common start of
 * the sample names; with the acquisition date. The start screen lists earlier analyses by this name.
 */
export function autoName(ws: Workspace, keywordsOf: (id: string) => Record<string, string> | undefined, today = new Date()): string {
  const count = new Map<string, number>();
  for (const s of ws.samples) {
    const kw = keywordsOf(s.id) ?? {};
    const v = (kw['EXPERIMENT NAME'] || kw['$PROJ'] || kw['PROJECT'] || '').trim().replace(/\.(xit|ncf|exp|cxp)$/i, '');
    if (v && !/^(untitled|experiment|default|project)$/i.test(v)) count.set(v, (count.get(v) ?? 0) + 1);
  }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  const folder = ws.samples.map((s) => s.info?.['Folder']?.split('/')[0]).find(Boolean);
  let base = best && best[1] >= ws.samples.length / 2 ? best[0] : folder;
  // all on plates (CytExpert names such as "01-Well-A1" say no more): the plates
  if (!base && ws.samples.length >= 3 && ws.samples.every((x) => x.plate)) {
    const plates = [...new Set(ws.samples.map((x) => x.plate!))];
    base = plates.length <= 3 ? plates.join(', ') : `${plates.length} plates`;
  }
  if (!base) return suggestName(ws, today);
  const date = isoDate(ws.samples.map((s) => s.info?.Date).find(Boolean));
  // a folder or experiment named with the date already ("Exp_20250201_1", "250826 bead sizes"): no second date
  const compact = date ? date.replace(/-/g, '') : '';
  const has = !date || base.includes(date) || base.includes(compact) || new RegExp(`(^|\\D)${compact.slice(2)}(\\D|$)`).test(base);
  return has ? base : `${base} ${date}`;
}

