// The start screen: continue the last analysis, open an earlier one (kept in this browser with its files), start a
// new one (files, a folder, a workspace file) or the example. Shown at start (unless switched off) and from the logo.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { newBlankWorkspace } from '../io/files';
import { currentSessionInfo, deleteRecent, downloadSavedSession, listRecent, openRecent, recentBytes, restoreInterrupted, restoreSession, restoreSettled, startAutosave, type RecentMeta } from '../io/session';
import { DEMO_NAME, loadDemo } from '../state/demo';
import { useStore } from '../state/store';
import { setupFor, type ExperimentSetup } from '../core/model';
import { APP_CONTACT_EMAIL, APP_STAGE, APP_VERSION, contactMailto } from '../legal/meta';
import { MESF_INFO, SIZE_INFO } from './calib/info';
import { InfoTip } from './widgets';
import { Icon } from './icons';
import { LOGO_CONTOURS, LOGO_GATE, LogoMark } from './Logo';
import { shellMode, useLayout } from './shell';
import { fitLargeScreen } from './SheetView';
import { layoutOf } from '../render/plateChart';
import { engine } from '../core/engine';

/**
 * A fresh view of an analysis opened from the start screen, not the zoom or sample panel of the one before: 100 %
 * from the top left (big screens: the page fills the worksheet area, as after a start without the start screen); the
 * sample panel shows the list when the analysis has no plates.
 */
export function freshView() {
  const lay = useLayout.getState();
  if (lay.sampleView === 'plate' && !layoutOf(useStore.getState().ws, engine).plates.length) lay.set({ sampleView: 'list' });
  // (the phone viewer fits the page width itself)
  if (shellMode() === 'phone') return;
  const st = useStore.getState();
  if (st.ui.zoom !== 1) st.setUI({ zoom: 1 });
  requestAnimationFrame(() => {
    document.querySelector('.sheet-scroll')?.scrollTo(0, 0);
    fitLargeScreen();
  });
}
const fitSoon = freshView;

const SKIP_KEY = 'fs.welcome.skip';

/** Whether the start screen is shown when the app starts (the user can switch it off). */
export function welcomeAtStart(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) !== '1';
  } catch {
    return true;
  }
}
function setWelcomeAtStart(on: boolean) {
  try {
    if (on) localStorage.removeItem(SKIP_KEY);
    else localStorage.setItem(SKIP_KEY, '1');
  } catch {
    /* storage unavailable: shown every time */
  }
}

const SETUP_KEY = 'fs.newSetup';

/** The setup chosen last for a new analysis (conventional without calibrations the first time). */
function lastSetup(): ExperimentSetup {
  try {
    const v = JSON.parse(localStorage.getItem(SETUP_KEY) ?? 'null') as Partial<ExperimentSetup> | null;
    if (v && (v.kind === 'conventional' || v.kind === 'nanoscale')) return { kind: v.kind, mesf: !!v.mesf, size: !!v.size };
  } catch {
    /* unreadable: default */
  }
  return setupFor('conventional');
}

interface WelcomeState {
  open: boolean;
  /** opened when the app started (nothing is open behind it yet) or later from the logo */
  atStart: boolean;
  /** what a new analysis started here needs */
  setup: ExperimentSetup;
}
export const useWelcome = create<WelcomeState>(() => ({ open: false, atStart: false, setup: lastSetup() }));

/** Choose the setup of the next new analysis (remembered for the next time). */
export function setNewSetup(s: ExperimentSetup) {
  useWelcome.setState({ setup: s });
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s));
  } catch {
    /* not remembered */
  }
}

export function showWelcome(atStart = false) {
  // messages about the work behind would sit over the start screen (and their actions open panels hidden by it)
  useStore.setState((s) => ({ ui: { ...s.ui, toasts: [] } }));
  useWelcome.setState({ open: true, atStart });
}
function closeWelcome() {
  newPending = false;
  useWelcome.setState({ open: false, atStart: false });
  // back to the logo that opened it (at start: the work area)
  requestAnimationFrame(() => (document.querySelector('button.brand') as HTMLElement | null)?.focus({ preventScroll: true }));
}

/**
 * A file picker opened from the start screen: the new analysis starts only when files arrive (a cancelled picker keeps
 * everything as it was). The app's file inputs ask consumeNewPending() first.
 */
let newPending = false;
export function consumeNewPending(): boolean {
  const p = newPending && useWelcome.getState().open;
  newPending = false;
  return p;
}

/**
 * Leave the start screen for a new, empty analysis: what was open (or the stored session, at start) is kept as an
 * earlier analysis.
 */
export function startNewFromWelcome() {
  // (a session that broke the last start is kept as an earlier analysis: no warning at the next start)
  if (useWelcome.getState().atStart) restoreSettled();
  newBlankWorkspace(useWelcome.getState().setup);
  closeWelcome();
  startAutosave();
  // (not at the zoom of the analysis before; the view is fitted once the files are in, see freshView)
  if (shellMode() !== 'phone' && useStore.getState().ui.zoom !== 1) useStore.getState().setUI({ zoom: 1 });
}

// ------------------------------------------------------------------ formatting

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtBytes(b: number): string {
  if (!(b > 0)) return '0 MB';
  if (b < 1e6) return `${Math.max(1, Math.round(b / 1e3))} kB`;
  if (b < 1e9) return `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
  return `${(b / 1e9).toFixed(1)} GB`;
}

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function metaLine(m: Pick<RecentMeta, 'samples' | 'plates' | 'populations'>): string {
  // (sample names are added where analyses share a name)
  const parts = [plural(m.samples, 'sample')];
  if (m.plates) parts.push(plural(m.plates, 'plate'));
  if (m.populations) parts.push(plural(m.populations, 'gate'));
  return parts.join(' · ');
}

// ------------------------------------------------------------------ icons

const ContinueIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 5.5v13l10-6.5z" />
  </svg>
);
const SparkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20V4M4 20h16" />
    <circle cx="9" cy="14" r="1.2" fill="currentColor" />
    <circle cx="11.5" cy="11.5" r="1.2" fill="currentColor" />
    <circle cx="16" cy="8" r="1.6" fill="currentColor" />
    <circle cx="14" cy="15" r="1" fill="currentColor" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
  </svg>
);

// ------------------------------------------------------------------ the screen

export interface WelcomeActions {
  openFcs: () => void;
  openFolder: () => void;
  openWorkspace: () => void;
  /** "Getting started" and keyboard shortcuts (dialogs of the app) */
  help: () => void;
  about: () => void;
}

export function Welcome({ actions }: { actions: WelcomeActions }) {
  const { open, atStart } = useWelcome();
  const ws = useStore((s) => s.ws);
  const [stored, setStored] = useState<RecentMeta | null | undefined>(undefined);
  const [recent, setRecent] = useState<RecentMeta[] | null>(null);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [keptBytes, setKeptBytes] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [atStartPref, setAtStartPref] = useState(welcomeAtStart);
  // the last start broke down while opening the stored session (read when shown: the flag goes once the user chose)
  const interrupted = open && atStart && restoreInterrupted();

  const refresh = () => {
    void listRecent().then(setRecent);
    void recentBytes().then(setKeptBytes);
    if (atStart) void currentSessionInfo().then(setStored);
    try {
      void navigator.storage?.estimate?.().then((e) => setUsage({ used: e.usage ?? 0, quota: e.quota ?? 0 }));
    } catch {
      /* no estimate */
    }
  };
  useEffect(() => {
    if (!open) return;
    setConfirmDel(null);
    refresh();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // a modal screen: the app behind takes no focus and is hidden from assistive technology; Tab stays on the screen
  useEffect(() => {
    if (!open) return;
    const behind = Array.from(document.querySelectorAll<HTMLElement>('.app > :not(.welcome):not(.toasts):not(.modal-back):not(.dropzone-full):not(input)'));
    for (const el of behind) el.setAttribute('inert', '');
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || document.querySelector('.modal-back')) return;
      const el = root.current;
      if (!el) return;
      const f = Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', trap, true);
    return () => {
      for (const el of behind) el.removeAttribute('inert');
      window.removeEventListener('keydown', trap, true);
    };
  }, [open]);

  // Escape: a delete question open answers "Keep"; else back to the open analysis (not at start: there is none)
  const confirmRef = useRef(confirmDel);
  confirmRef.current = confirmDel;
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      // (a dialog over the start screen closes first, on its own)
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-back') || useStore.getState().ui.dialog) return;
      const del = confirmRef.current;
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        setConfirmDel(null);
        requestAnimationFrame(() => (root.current?.querySelector(`[data-del="${del}"]`) as HTMLElement | null)?.focus());
        return;
      }
      if (atStart) return;
      e.stopPropagation();
      closeWelcome();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [open, atStart]);

  if (!open) return null;

  // what "Continue" opens: at start the stored session; later the analysis open behind the screen
  const openNow = !atStart && ws.samples.length > 0 && ws.name !== DEMO_NAME;
  const demoNow = !atStart && ws.name === DEMO_NAME;
  const cont: { name: string; meta: string; when?: string } | null = openNow
    ? { name: ws.name, meta: metaLine({ samples: ws.samples.length, plates: new Set(ws.samples.map((s) => s.plate).filter(Boolean)).size, populations: ws.populations.length }), when: 'open now' }
    : stored
      ? { name: stored.name, meta: metaLine(stored), when: `saved ${ago(stored.savedAt)}` }
      : null;

  const run = async (key: string, f: () => Promise<unknown> | void) => {
    setBusy(key);
    try {
      await f();
    } finally {
      setBusy(null);
    }
  };
  const doContinue = () =>
    run('continue', async () => {
      if (!atStart) {
        closeWelcome();
        return;
      }
      closeWelcome();
      const r = await restoreSession();
      if (r.status === 'failed') useStore.getState().setUI({ dialog: { kind: 'restoreProblem', payload: { reason: 'failed', message: r.message } } });
      startAutosave();
      fitSoon();
    });
  const doExample = () => {
    // the analysis open (or stored) is kept as an earlier one; the example itself is never stored
    if (atStart) restoreSettled();
    newBlankWorkspace();
    loadDemo();
    closeWelcome();
    startAutosave();
    fitSoon();
  };
  const doRecent = (id: string) =>
    run(id, async () => {
      if (atStart) restoreSettled();
      const ok = await openRecent(id);
      if (ok) {
        closeWelcome();
        startAutosave();
        fitSoon();
      } else refresh();
    });
  const doDelete = (id: string) =>
    run('del' + id, async () => {
      await deleteRecent(id);
      setConfirmDel(null);
      refresh();
      // focus stays in the list (the next analysis), else on New analysis
      requestAnimationFrame(() => (root.current?.querySelector('.wl-item, .wl-new .btn.primary') as HTMLElement | null)?.focus());
    });
  const keep = (id: string) => {
    setConfirmDel(null);
    requestAnimationFrame(() => (root.current?.querySelector(`[data-del="${id}"]`) as HTMLElement | null)?.focus());
  };
  // a picker: the new analysis starts when files are chosen (App's inputs call consumeNewPending)
  const newWith = (f: () => void) => () => {
    newPending = true;
    f();
  };
  const dupNames = new Set((recent ?? []).map((r) => r.name).filter((n, i, a) => a.indexOf(n) !== i));

  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-label="FlowState start screen" ref={root}>
      {/* the logo's density and gate, large and faint, behind the cards */}
      <svg className="wl-deco" viewBox="0 0 64 64" aria-hidden="true">
        {LOGO_CONTOURS.map(([d, c], i) => (
          <path key={i} d={d} fill={c} />
        ))}
        <path d={LOGO_GATE} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
      <div className="wl-inner">

        <div className="wl-body">
        <header className="wl-head">
          <LogoMark size={72} />
          <div className="wl-title">
            <h1>
              <b>Flow</b>State <span className="beta-tag wl-beta">{APP_STAGE}</span>
            </h1>
            <p>Flow cytometry analysis in your browser. Your files stay on this computer.</p>
          </div>
          {!atStart && (
            <button className="btn wl-close" onClick={closeWelcome} title="Back to the open analysis (Esc)">
              <Icon.close /> Close
            </button>
          )}
        </header>
        <div className="wl-grid">
          <div className="wl-col">
            {cont && (
              <div className={`wl-card wl-continue${interrupted ? ' warn' : ''}`}>
                <button className="wl-card-main" onClick={doContinue} disabled={!!busy} autoFocus>
                  <span className="wl-ic primary">
                    <ContinueIcon />
                  </span>
                  <span className="wl-txt">
                    <span className="wl-h">{atStart ? 'Continue where you left off' : 'Back to the open analysis'}</span>
                    <span className="wl-name" title={cont.name}>
                      {cont.name}
                    </span>
                    <span className="wl-meta">
                      {cont.meta}
                      {cont.when ? ` · ${cont.when}` : ''}
                    </span>
                  </span>
                  {busy === 'continue' && <span className="wl-busy">Opening…</span>}
                </button>
                {interrupted && (
                  <div className="wl-warn" role="status">
                    The last start stopped while this analysis was opening. Try again, keep a copy first, or start something else (it stays under Earlier analyses).
                    <div className="row" style={{ gap: 6, marginTop: 6 }}>
                      <button className="btn sm" onClick={() => void downloadSavedSession()}>
                        Download a copy
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {demoNow && (
              <div className="wl-card">
                <button className="wl-card-main" onClick={closeWelcome} autoFocus>
                  <span className="wl-ic">
                    <ContinueIcon />
                  </span>
                  <span className="wl-txt">
                    <span className="wl-h">Back to the example</span>
                    <span className="wl-meta">Synthetic data; changes to the example are not kept.</span>
                  </span>
                </button>
              </div>
            )}

            <div className="wl-card wl-new">
              <div className="wl-card-main static">
                <span className="wl-ic">
                  <Icon.fcs />
                </span>
                <span className="wl-txt">
                  <span className="wl-h">New analysis</span>
                  <span className="wl-meta">
                    FCS or LMD files<span className="wl-folder">, or a whole export folder</span>: wells and plates are recognised from names and keywords.
                  </span>
                </span>
              </div>
              <SetupPicker />
              <div className="wl-acts">
                <button className="btn primary" onClick={newWith(actions.openFcs)} autoFocus={!cont && !demoNow}>
                  <Icon.fcs /> Open FCS files
                </button>
                <button className="btn wl-folder" onClick={newWith(actions.openFolder)}>
                  <Icon.open /> Open folder
                </button>
                <button className="btn" onClick={newWith(actions.openWorkspace)} title="A FlowState workspace (.json / .zip), a FlowJo workspace (.wsp) or Gating-ML">
                  <Icon.save /> Open workspace
                </button>
              </div>
              <div className="wl-drop" aria-hidden="true">
                or drop files or a folder anywhere on this window
              </div>
            </div>

            <div className="wl-card">
              <button className="wl-card-main" onClick={doExample}>
                <span className="wl-ic">
                  <SparkIcon />
                </span>
                <span className="wl-txt">
                  <span className="wl-h">Try the example</span>
                  <span className="wl-meta">A T-cell activation panel with gates, a figure and a table (synthetic data), to see what FlowState does.</span>
                </span>
              </button>
            </div>
          </div>

          <div className="wl-col">
            <aside className="wl-beta-note" role="note" aria-label="Beta software">
              <b>Work in progress.</b> FlowState is beta software, so unexpected behaviour can occur. Please verify critical results against
              your raw data or another program. Found a problem or have an idea? Let me know:{' '}
              <a href={contactMailto('Problem report')} target="_blank" rel="noopener noreferrer" className="contact-mail">
                {APP_CONTACT_EMAIL}
              </a>
            </aside>
            <section className="wl-card wl-recent" aria-label="Earlier analyses">
              <div className="wl-recent-head">
                <h2>Earlier analyses</h2>
                {recent && recent.length > 0 && keptBytes > 0 && <span className="hint">{fmtBytes(keptBytes)} of FCS files kept</span>}
              </div>
              {recent === null ? (
                <p className="hint">Looking…</p>
              ) : recent.length === 0 ? (
                <p className="hint wl-empty">
                  When you start something new, the analysis you worked on is kept here with its files, so you can come back to it.
                </p>
              ) : (
                <ul className="wl-list">
                  {recent.map((r) => (
                    <li key={r.id} className={busy === r.id ? 'busy' : ''}>
                      <button className="wl-item" onClick={() => doRecent(r.id)} disabled={!!busy} title={`Open "${r.name}"${r.firstSamples.length ? `\n${r.firstSamples.join('\n')}` : ''}`}>
                        <span className="wl-item-ic">{r.plates ? <Icon.plate /> : <Icon.fcs />}</span>
                        <span className="wl-txt">
                          <span className="wl-name">{r.name}</span>
                          <span className="wl-meta">
                            {metaLine(r)}
                            {r.instruments.length ? ` · ${r.instruments.join(', ')}` : ''}
                          </span>
                          {dupNames.has(r.name) && r.firstSamples.length > 0 && <span className="wl-meta wl-samples">{r.firstSamples.join(', ')}</span>}
                        </span>
                        <span className="wl-when">
                          {busy === r.id ? 'Opening…' : ago(r.usedAt)}
                          <span className="wl-size">{r.files < r.samples ? `${r.files} of ${r.samples} files` : fmtBytes(r.bytes)}</span>
                        </span>
                      </button>
                      {confirmDel === r.id ? (
                        <span className="wl-del-confirm">
                          <button className="btn sm danger" onClick={() => doDelete(r.id)} disabled={!!busy}>
                            Delete
                          </button>
                          {/* (the safe choice has the focus) */}
                          <button className="btn sm" autoFocus onClick={() => keep(r.id)}>
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button className="icon-btn wl-del" data-del={r.id} title="Delete this analysis and its stored files from this browser" aria-label={`Delete ${r.name}`} onClick={() => setConfirmDel(r.id)}>
                          <TrashIcon />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="hint wl-store">
                Kept in this browser only, nothing is uploaded. Clearing the browser's site data removes them; use Save with data to keep a copy as a file.
                {/* (the browser's estimate can be far off, e.g. for pages opened from a file: shown only when it counts at least the files kept) */}
                {usage && usage.quota > 0 && usage.used > 0 && usage.used >= keptBytes ? ` Browser storage used: ${fmtBytes(usage.used)} of ${fmtBytes(usage.quota)}.` : ''}
              </p>
            </section>
          </div>
        </div>

        </div>
        <footer className="wl-foot">
          <label className="wl-check">
            <input
              type="checkbox"
              checked={atStartPref}
              onChange={(e) => {
                setAtStartPref(e.target.checked);
                setWelcomeAtStart(e.target.checked);
              }}
            />
            Show this screen at start
          </label>
          <span className="wl-sep" />
          <FootLink onClick={actions.help}>Getting started</FootLink>
          <FootLink onClick={actions.about}>About and licenses</FootLink>
          <span className="wl-mail">
            Questions or feedback:{' '}
            <a href={contactMailto()} target="_blank" rel="noopener noreferrer" className="contact-mail">
              {APP_CONTACT_EMAIL}
            </a>
          </span>
          <span className="wl-ver">Version {APP_VERSION}</span>
        </footer>
      </div>
    </div>
  );
}

function FootLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button className="link-btn" onClick={onClick}>
      {children}
    </button>
  );
}

/** Kind of experiment and the calibration tools of a new analysis (the rest of the app hides what is not needed). */
function SetupPicker() {
  const setup = useWelcome((s) => s.setup);
  return (
    <div className="wl-setup" role="group" aria-label="What the new analysis needs">
      <div className="wl-setup-kind" role="radiogroup" aria-label="Kind of experiment">
        {(
          [
            ['conventional', 'Conventional', 'Cells and beads: compensation, gating, statistics'],
            ['nanoscale', 'Nanoscale', 'EVs, viruses, liposomes: scatter on log axes, size and MESF calibration'],
          ] as const
        ).map(([k, label, title]) => (
          <button key={k} role="radio" aria-checked={setup.kind === k} className={setup.kind === k ? 'on' : ''} title={title} onClick={() => setNewSetup(setupFor(k))}>
            {label}
          </button>
        ))}
      </div>
      <fieldset className="wl-calib">
        <legend>Calibrators</legend>
        <span className="wl-calib-opt">
          <label>
            <input type="checkbox" checked={setup.mesf} onChange={(e) => setNewSetup({ ...setup, mesf: e.target.checked })} /> MESF / ERF
          </label>
          <InfoTip label="MESF / ERF">{MESF_INFO}</InfoTip>
        </span>
        <span className="wl-calib-opt">
          <label>
            <input type="checkbox" checked={setup.size} onChange={(e) => setNewSetup({ ...setup, size: e.target.checked })} /> Size (Mie)
          </label>
          <InfoTip label="size calibration (Mie)">{SIZE_INFO}</InfoTip>
        </span>
      </fieldset>
    </div>
  );
}
