// Spectral unmixing view: single-stain controls -> reference spectra -> unmixed (derived) channels, with visual QC.
// Works for conventional cytometers (one detector per fluorochrome or more detectors than fluorochromes, e.g.
// CytoFLEX LX with 81 detectors) and full-spectrum instruments.
import { produce } from 'immer';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { engine } from '../core/engine';
import { popPath, type Workspace } from '../core/model';
import { endmemberNameFromSample, unmixOutputNames, type UnmixDef, type UnmixMethod } from '../core/unmix';
import { residualCheck, type ResidualCheck } from './unmix/residualCheck';
import { useRemoveDerived } from './calib/common';
import { useStore } from '../state/store';
import { Icon } from './icons';
import { Check, Modal, Num, Seg, Sel, Txt } from './widgets';
import { applyDraft, exportSpectraCsv, exportSpreadCsv, plannedOutputs, showUnmixPlots } from './unmix/apply';
import { groupOrder, MatrixHeatmap, RampLegend, Sparkline, SpectraPlot, slotColor, type MatrixCell, type SpectrumSeries } from './unmix/charts';
import { useUnmixLive, type Live, type RowResult } from './unmix/compute';
import {
  controlRow,
  defaultDetectorsFor,
  draftFromDef,
  duplicateDraft,
  guessControls,
  loadedSamples,
  newDraft,
  nextColor,
  useDrafts,
  type DerivedWithSetup,
  type Draft,
} from './unmix/draft';
import { channelWavelengths, complexityInfo, defsEquivalent, detectorCandidates, groupDetectors, isAfName, parseSpectraCsv, uniqueName } from './unmix/helpers';
import './unmix/unmix.css';

// ------------------------------------------------------------------ small icons

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const Ic = {
  up: () => svg(<path d="M6 15l6-6 6 6" />),
  down: () => svg(<path d="M6 9l6 6 6-6" />),
  warn: () => svg(<><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></>),
  err: () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>),
  ok: () => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />),
  info: () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>),
  import: () => svg(<><path d="M12 15V3M7 10l5 5 5-5" /><path d="M5 14v6h14v-6" /></>),
};

/** Leakage in % without a negative zero. */
const fmtPct = (v: number) => {
  const t = (v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0);
  return /^-0(\.0)?$/.test(t) ? t.slice(1) : t;
};

const nf = (n: number | undefined) => (n === undefined ? '–' : n.toLocaleString('en-US'));

const METHOD_TEXT: Record<UnmixMethod, ReactNode> = {
  ols: (
    <>
      <b>Ordinary least squares</b> is the scientific default: linear and unbiased, so negative populations stay centred on zero and MFIs are comparable between samples.
    </>
  ),
  wls: (
    <>
      <b>Weighted least squares</b> weights each detector by its expected noise (Poisson-like), which reduces the spreading of bright signals into dim populations. Somewhat slower; values stay unbiased on average.
    </>
  ),
  nnls: (
    <>
      <b>Non-negative least squares</b> forbids negative values. It looks tidy but biases dim and negative populations upwards (their noise can no longer go below zero). Use it for display only, never for MFI statistics.
    </>
  ),
};

/** Whether a draft belongs to this workspace (drafts of a previously open workspace are hidden). */
function visibleDraft(ws: Workspace, d: Draft) {
  if (ws.derived?.some((x) => x.id === d.id)) return true;
  const has = (id: string | null | undefined) => !!id && ws.samples.some((s) => s.id === id);
  if (d.setup.controls.some((c) => c.fixed || has(c.sampleId)) || has(d.setup.unstainedId)) return true;
  if (d.setup.controls.length) return false;
  return !d.origin?.length || d.origin.some(has);
}

// ------------------------------------------------------------------ view

export function UnmixView() {
  const ws = useStore((s) => s.ws);
  const dataVersion = useStore((s) => s.ui.dataVersion);
  const drafts = useDrafts((s) => s.drafts);
  const selectedId = useDrafts((s) => s.selectedId);
  const defs = useMemo(() => (ws.derived ?? []).filter((d) => d.kind === 'unmix') as DerivedWithSetup[], [ws.derived]);
  const nLoaded = loadedSamples(ws).length;

  // keep a valid selection: the selected draft, else the first definition, else a visible draft, else a new draft
  useEffect(() => {
    const s = useDrafts.getState();
    const sel = s.selectedId;
    if (sel) {
      const def = defs.find((d) => d.id === sel);
      if (s.drafts[sel] && (def || visibleDraft(ws, s.drafts[sel]))) return;
      if (def) {
        s.setDraft(draftFromDef(def));
        return;
      }
    }
    if (defs[0]) {
      if (!s.drafts[defs[0].id]) s.setDraft(draftFromDef(defs[0]));
      s.select(defs[0].id);
      return;
    }
    const vis = Object.values(s.drafts).find((d) => visibleDraft(ws, d));
    if (vis) s.select(vis.id);
    else if (nLoaded && s.autoRequested) {
      // opened by the user: a first draft from the samples that look like single-stain controls (none: nothing is made)
      useDrafts.setState({ autoRequested: false });
      if (guessControls(ws).controls.length && !(s.autoInitIds && ws.samples.some((x) => s.autoInitIds!.includes(x.id)))) {
        const d = newDraft(ws, { guess: true });
        useDrafts.setState({ autoInitIds: ws.samples.map((x) => x.id) });
        s.setDraft(d);
        s.select(d.id);
      }
    }
  }, [defs, ws, selectedId, drafts, nLoaded]);
  // leaving the view ends the request (files loaded later elsewhere make no draft)
  useEffect(() => () => useDrafts.setState({ autoRequested: false }), []);

  const draft = selectedId ? drafts[selectedId] ?? null : null;
  const live = useUnmixLive(draft, ws, dataVersion);

  if (!ws.samples.length)
    return (
      <div className="doc-view">
        <div className="um">
          <div className="card">
            <div className="card-body">
              <h3 style={{ marginTop: 0 }}>Spectral unmixing</h3>
              <p className="hint" style={{ maxWidth: 640 }}>
                Load single-stained controls (one FCS file per fluorochrome, beads or cells) and, ideally, an unstained sample. Unmixing works on conventional cytometers (every detector of all lasers, e.g. 81 on a CytoFLEX LX) and on full-spectrum instruments; the unmixed fluorochromes appear as new channels in every plot.
              </p>
            </div>
          </div>
        </div>
      </div>
    );

  return (
    <div className="doc-view">
      <div className="um">
        <DefsCard defs={defs} drafts={drafts} selectedId={selectedId} live={live} />
        {draft ? <Editor key={draft.id} draft={draft} live={live} defs={defs} /> : <div className="um-empty">Create an unmixing to start.</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ definitions list

function DefsCard({ defs, drafts, selectedId, live }: { defs: DerivedWithSetup[]; drafts: Record<string, Draft>; selectedId: string | null; live: Live }) {
  const ws = useStore((s) => s.ws);
  const st = useStore.getState();
  const ds = useDrafts.getState();
  const entries: { id: string; name: string; def?: DerivedWithSetup; draft?: Draft }[] = [
    ...defs.map((d) => ({ id: d.id, name: drafts[d.id]?.name ?? d.name, def: d, draft: drafts[d.id] })),
    ...Object.values(drafts)
      .filter((d) => !defs.some((x) => x.id === d.id) && visibleDraft(ws, d))
      .map((d) => ({ id: d.id, name: d.name, draft: d })),
  ];
  const taken = () => [...defs.map((d) => d.name), ...Object.values(useDrafts.getState().drafts).map((d) => d.name)];
  const create = () => {
    const d = newDraft(ws, { guess: !entries.length });
    ds.setDraft(d);
    ds.select(d.id);
  };
  const duplicate = (e: (typeof entries)[number]) => {
    const src = e.draft ?? (e.def ? draftFromDef(e.def) : null);
    if (!src) return;
    const c = duplicateDraft(src, taken());
    ds.setDraft(c);
    ds.select(c.id);
  };
  const [askRemove, removeDialog] = useRemoveDerived((id) => useDrafts.getState().dropDraft(id));
  const del = (e: (typeof entries)[number]) => {
    if (e.def) return askRemove(e.id);
    st.toast(`Discarded "${e.name}"`, 'info');
    ds.dropDraft(e.id);
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Spectral unmixing</h3>
        <span className="um-sub">
          {defs.length} applied{entries.length > defs.length ? `, ${entries.length - defs.length} not applied` : ''}
        </span>
        <span className="grow" />
        <button className="btn sm" onClick={create}>
          <Icon.plus /> New unmixing
        </button>
      </div>
      <div className="um-defs" role="listbox" aria-label="Unmixing definitions">
        {entries.map((e) => {
          const on = e.id === selectedId;
          const u = e.def?.unmix;
          const nCtl = e.draft?.setup.controls.length ?? u?.endmembers.length ?? 0;
          const meta = u
            ? `${u.endmembers.length} fluorochromes${u.includeAF && u.af?.length ? ' + AF' : ''}, ${u.detectors.length} detectors, ${u.method.toUpperCase()} · ${e.def!.outputs.length} channels`
            : `${nCtl} control${nCtl === 1 ? '' : 's'}, not applied`;
          const exportDef = on && live.def ? live.def : u;
          return (
            <div key={e.id} className={`um-def${on ? ' on' : ''}`} role="option" aria-selected={on} tabIndex={0} onClick={() => ds.select(e.id)} onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && ds.select(e.id)}>
              <div style={{ minWidth: 0 }}>
                <div className="nm">{e.name}</div>
                <div className="meta">{meta}</div>
              </div>
              <span className={`badge${u ? ' comp' : ''}`}>{u ? 'Applied' : 'Draft'}</span>
              <span className="acts" onClick={(k) => k.stopPropagation()}>
                <button className="icon-btn" title="Duplicate" aria-label={`Duplicate ${e.name}`} onClick={() => duplicate(e)}>
                  <Icon.copy />
                </button>
                <button className="icon-btn" title="Export reference spectra (CSV)" aria-label={`Export spectra of ${e.name}`} disabled={!exportDef} onClick={() => exportDef && exportSpectraCsv(exportDef)}>
                  <Icon.export />
                </button>
                <button className="icon-btn danger" title={u ? 'Delete (undo with Ctrl+Z)' : 'Discard draft'} aria-label={`Delete ${e.name}`} onClick={() => del(e)}>
                  <Icon.trash />
                </button>
              </span>
            </div>
          );
        })}
        {!entries.length && <div className="empty-note">No unmixing yet.</div>}
      </div>
      {removeDialog}
    </div>
  );
}

// ------------------------------------------------------------------ editor

function Editor({ draft, live, defs }: { draft: Draft; live: Live; defs: DerivedWithSetup[] }) {
  const ws = useStore((s) => s.ws);
  const st = useStore.getState();
  const setDraft = useDrafts((s) => s.setDraft);
  const up = (f: (d: Draft) => void) => setDraft(produce(useDrafts.getState().drafts[draft.id] ?? draft, f));
  const [busy, setBusy] = useState(false);
  const applied = defs.find((d) => d.id === draft.id);
  const markers = live.def ? live.used.map((i) => draft.setup.controls[i]?.marker) : [];
  // the setup refers to an unstained sample that is no longer in the workspace: what is applied cannot be reproduced
  const unGone = !!draft.setup.unstainedId && !ws.samples.some((s) => s.id === draft.setup.unstainedId);
  const status: 'new' | 'applied' | 'modified' | 'computing' = !applied
    ? 'new'
    : live.pending && !live.def
      ? 'computing'
      : live.def && defsEquivalent(live.def, applied.unmix) && markersEqual(applied, markers) && !unGone
        ? 'applied'
        : 'modified';

  const doApply = () => {
    const def = live.def;
    if (!def || !live.complete || busy) return;
    setBusy(true);
    requestAnimationFrame(() =>
      setTimeout(() => {
        try {
          const before = applied?.outputs.map((o) => o.name) ?? [];
          const d = applyDraft(draft, def, markers);
          up((x) => {
            x.created = d.unmix.created;
            x.note = undefined;
          });
          const gone = before.filter((n) => !d.outputs.some((o) => o.name === n));
          const note = gone.length ? `. ${gone.slice(0, 3).join(', ')}${gone.length > 3 ? ' …' : ''} no longer exist${gone.length === 1 ? 's' : ''}: plots and gates on ${gone.length === 1 ? 'it' : 'them'} show the channel as missing` : '';
          st.toast(`Applied "${d.name}": ${d.outputs.length} unmixed channel${d.outputs.length === 1 ? '' : 's'}${note}`, 'success', { action: { label: 'Show plots', run: () => showUnmixPlots(d.id) } });
        } catch (e) {
          st.toast(`Unmixing failed: ${(e as Error).message}`, 'error');
        } finally {
          setBusy(false);
        }
      }, 0),
    );
  };

  const canApply = !!live.def && live.complete && !live.pending && !busy && status !== 'applied';
  const statusText = { new: 'Not applied', applied: 'Applied', modified: 'Changes not applied', computing: 'Computing' }[status];
  return (
    <>
      <div className="um-head">
        <input
          className="inp name"
          aria-label="Unmixing name"
          value={draft.name}
          onChange={(e) =>
            up((d) => {
              d.name = e.target.value;
            })
          }
          onKeyDown={(e) => e.stopPropagation()}
        />
        <span className={`um-status ${status}`}>
          <span className="pip" />
          {statusText}
        </span>
        {(live.pending || busy) && (
          <span className="um-status" aria-live="polite">
            <span className="um-spin" /> {busy ? 'Unmixing…' : 'Computing signatures…'}
          </span>
        )}
        <span className="grow" />
        {applied && (
          <button className="btn" onClick={() => showUnmixPlots(applied.id)} title="New worksheet with plots of the unmixed controls">
            <Icon.sheet /> Show plots
          </button>
        )}
        <button className="btn primary" disabled={!canApply} onClick={doApply} title={canApply ? 'Create or update the unmixed channels' : undefined}>
          <Icon.spectrum /> {applied ? 'Apply changes' : 'Apply unmixing'}
        </button>
        {unGone && (
          <ul className="um-problems">
            <li>The unstained sample was removed from the workspace{live.af?.kind === 'stored' ? ': autofluorescence uses the signature stored with the applied unmixing' : ''}. Choose another unstained sample (step 3) or apply to keep the stored signature.</li>
          </ul>
        )}
        {!live.pending && live.problems.length > 0 && (
          <ul className="um-problems">
            {live.problems.slice(0, 4).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
            {live.problems.length > 4 && <li>{live.problems.length - 4} more problems</li>}
          </ul>
        )}
      </div>
      <ControlsCard draft={draft} live={live} up={up} />
      <DetectorsCard draft={draft} live={live} up={up} />
      <div className="um-cols">
        <AfCard draft={draft} live={live} up={up} />
        <MethodCard draft={draft} live={live} up={up} />
      </div>
      <QcCard draft={draft} live={live} />
      <ResidualCard draft={draft} def={live.def ?? applied?.unmix ?? null} samples={applied?.samples} />
    </>
  );
}

/**
 * Samples with signal the controls do not explain (residual check, see unmix/residualCheck.ts): computed in the
 * background after the definition settles.
 */
function ResidualCard({ draft, def, samples }: { draft: Draft; def: UnmixDef | null; samples?: string[] }) {
  const ws = useStore((s) => s.ws);
  const dataVersion = useStore((s) => s.ui.dataVersion);
  const [res, setRes] = useState<{ def: UnmixDef; check: ResidualCheck | null } | null>(null);
  const controlIds = draft.setup.controls.map((c) => c.sampleId).filter((x): x is string => !!x && engine.has(x));
  const key = controlIds.join('|') + '#' + (draft.setup.unstainedId ?? '');
  useEffect(() => {
    if (!def || !controlIds.length) {
      setRes(null);
      return;
    }
    const t = window.setTimeout(() => {
      try {
        setRes({ def, check: residualCheck(useStore.getState().ws, def, controlIds, draft.setup.unstainedId, { samples }) });
      } catch (e) {
        console.warn('Residual check failed', e);
        setRes(null);
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [def, key, ws.samples, dataVersion, samples]); // eslint-disable-line react-hooks/exhaustive-deps
  const check = res && res.def === def ? res.check : null;
  if (!check || !check.checked) return null;
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  return (
    <div className={`card um-resid${check.flags.length ? ' warn' : ''}`} role={check.flags.length ? 'alert' : 'status'}>
      <div className="card-head">
        <h3>{check.flags.length ? <Ic.warn /> : <Ic.ok />} Signal the controls do not explain</h3>
        <span className="grow" />
        <span className="um-sub">
          {check.checked} sample{check.checked === 1 ? '' : 's'} checked; unexplained part of the signal in the controls: up to {check.refMedian.toFixed(3)} (median)
        </span>
      </div>
      <div className="card-body">
        {check.flags.length ? (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              In these samples the stained events keep much more signal after unmixing than the controls do: a fluorochrome (or autofluorescence) without a control, a control that does not match the stain in the sample, or other detector settings. Unmixed values of these samples are unreliable until it is fixed (add the missing control, an unstained sample for autofluorescence, or check the detectors).
            </p>
            <table className="data um-resid-table">
              <thead>
                <tr>
                  <th className="left">Sample</th>
                  <th title="Median relative residual of the brighter half of the events, compared with the controls' positive events">Median residual</th>
                  <th title={`Brighter events with more than ${check.refHigh.toFixed(2)} of their signal unexplained`}>High-residual events</th>
                </tr>
              </thead>
              <tbody>
                {check.flags.slice(0, 12).map((f) => (
                  <tr key={f.sampleId}>
                    <td className="left">{f.name}</td>
                    <td className="num">
                      {f.median.toFixed(3)} ({Number.isFinite(f.ratio) ? f.ratio.toFixed(1) : '>10'}x the controls)
                    </td>
                    <td className="num">{pct(f.frac)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {check.flags.length > 12 && <p className="hint">{check.flags.length - 12} more samples.</p>}
          </>
        ) : (
          <p className="hint" style={{ margin: 0 }}>
            The unmixed samples keep about as much unexplained signal as the controls: no sign of a missing fluorochrome.
          </p>
        )}
      </div>
    </div>
  );
}

function markersEqual(applied: DerivedWithSetup, markers: (string | undefined)[]) {
  return markers.every((m, k) => (m?.trim() || undefined) === (applied.outputs[k]?.label || undefined));
}

type Up = (f: (d: Draft) => void) => void;

// ------------------------------------------------------------------ 1 controls

function popOptions(ws: Workspace) {
  return ws.populations.map((p) => ({ value: p.id, label: popPath(ws, p.id) }));
}

function ControlsCard({ draft, live, up }: { draft: Draft; live: Live; up: Up }) {
  const ws = useStore((s) => s.ws);
  const st = useStore.getState();
  const [picker, setPicker] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const used = new Set(draft.setup.controls.map((c) => c.sampleId));
  const likely = guessControls(ws).controls.filter((id) => !used.has(id) && id !== draft.setup.unstainedId);
  const pops = popOptions(ws);
  const groups = useGroups(draft, draft.detectors);
  const order = useMemo(() => groupOrder(draft.detectors, groups), [draft.detectors, groups]);
  const groupsAt = useMemo(() => {
    const at: number[] = [];
    let n = 0;
    groups.forEach((g, k) => {
      if (k) at.push(n);
      n += g.detectors.length;
    });
    return at;
  }, [groups]);
  const addSamples = (ids: string[]) => {
    if (!ids.length) return;
    up((d) => {
      for (const id of ids) if (!d.setup.controls.some((c) => c.sampleId === id)) d.setup.controls.push(controlRow(ws, id, d.setup.controls));
      if (!d.detectors.length) d.detectors = defaultDetectorsFor(ws, ids);
      d.note = undefined;
    });
  };
  const importCsv = async (f: File) => {
    try {
      const text = await f.text();
      const ds = engine.samples.get(draft.setup.controls.find((c) => c.sampleId && engine.has(c.sampleId))?.sampleId ?? loadedSamples(ws)[0]?.id ?? '')?.ds;
      const known = ds?.channels.map((c) => c.name) ?? draft.detectors;
      const t = parseSpectraCsv(text, known);
      let nAf = 0;
      up((d) => {
        const fresh = !d.setup.controls.length;
        for (const em of t.endmembers) {
          if (isAfName(em.name)) {
            (d.setup.afFixed ??= []).push({ name: em.name.toUpperCase().startsWith('AF') ? em.name : 'AF', detectors: t.detectors, signature: em.signature });
            nAf++;
            continue;
          }
          d.setup.controls.push({
            key: `uc_${Math.random().toString(36).slice(2, 10)}`,
            name: uniqueName(em.name, d.setup.controls.map((c) => c.name)),
            pos: 'auto',
            neg: 'auto',
            color: nextColor(d.setup.controls),
            fixed: { detectors: t.detectors, signature: em.signature, source: f.name },
          });
        }
        if (fresh || !d.detectors.length) {
          const avail = new Set(known.map((k) => k.toLowerCase()));
          const dets = ds ? t.detectors.filter((x) => avail.has(x.toLowerCase())) : t.detectors;
          d.detectors = dets.length ? dets : t.detectors;
        }
      });
      const n = t.endmembers.length - nAf;
      const now = useDrafts.getState().drafts[draft.id]?.detectors ?? [];
      const lower = new Set(t.detectors.map((x) => x.toLowerCase()));
      const lacking = now.filter((x) => !lower.has(x.toLowerCase()));
      const avail = new Set(known.map((k) => k.toLowerCase()));
      const libDets = t.detectors.filter((x) => !ds || avail.has(x.toLowerCase()));
      st.toast(
        `Imported ${n} spectr${n === 1 ? 'um' : 'a'}${nAf ? ` and ${nAf} AF spectr${nAf === 1 ? 'um' : 'a'}` : ''} over ${t.detectors.length} detectors from ${f.name}` +
          (lacking.length ? `. The library has no values for ${lacking.length} selected detector${lacking.length === 1 ? '' : 's'}.` : ''),
        lacking.length ? 'info' : 'success',
        lacking.length && libDets.length ? { action: { label: 'Use library detectors', run: () => up((d) => void (d.detectors = libDets)) } } : {},
      );
    } catch (e) {
      st.toast(`${f.name}: ${(e as Error).message}`, 'error');
    }
  };
  const sortByPeak = () => {
    const pos = new Map(order.map((di, k) => [di, k]));
    const key = (c: Draft['setup']['controls'][number]) => {
      const p = live.rows[c.key]?.peak;
      return p === undefined ? Infinity : pos.get(p) ?? Infinity;
    };
    up((d) => {
      d.setup.controls = d.setup.controls.map((c, i) => ({ c, i, k: key(c) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.c);
    });
  };
  const move = (i: number, d: number) =>
    up((x) => {
      const c = x.setup.controls;
      const j = i + d;
      if (j < 0 || j >= c.length) return;
      [c[i], c[j]] = [c[j], c[i]];
    });
  return (
    <div className="card">
      <div className="card-head">
        <h3>
          <span className="step">1</span>Single-stained controls
        </h3>
        <span className="um-sub">One per fluorochrome. Signatures update as you edit.</span>
        <span className="grow" />
        {draft.setup.controls.length > 2 && (
          <button className="btn sm" onClick={sortByPeak} title="Order the controls by the position of their peak detector (laser by laser), as in the spectra plot">
            Sort by peak
          </button>
        )}
      </div>
      {draft.note && (
        <p className="um-note">
          <Ic.info />
          <span className="grow">{draft.note}</span>
          <button className="um-link" onClick={() => up((d) => void (d.note = undefined))}>
            Dismiss
          </button>
        </p>
      )}
      <div className="um-ctl-tools">
        <button className="btn sm" onClick={() => setPicker(true)} disabled={!loadedSamples(ws).length}>
          <Icon.plus /> Add controls…
        </button>
        <button className="btn sm" disabled={!likely.length} onClick={() => addSamples(likely)} title="Samples whose names contain Comp, Single stain, Beads, Ctrl, Control, Ref …">
          <Icon.wand /> Add likely controls{likely.length ? ` (${likely.length})` : ''}
        </button>
        <button className="btn sm" onClick={() => fileRef.current?.click()} title="Reference spectra as CSV: one row per detector, one column per fluorochrome (as exported here)">
          <Ic.import /> Import spectra (CSV)
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) importCsv(f);
          }}
        />
        <span className="grow" style={{ flex: 1 }} />
        <label className="um-sub" htmlFor="um-posmode" title="Automatic positives: the brightest 3 % of the events in the peak detector, or every event above the negative population (more events, includes dimmer cells)">
          Auto positives
        </label>
        <Sel
          id="um-posmode"
          value={draft.setup.posMode ?? 'top'}
          ariaLabel="Automatic positive events"
          options={[
            { value: 'top', label: 'Brightest 3 %' },
            { value: 'all', label: 'Whole positive population' },
          ]}
          onChange={(v) => up((d) => void (d.setup.posMode = v === 'all' ? 'all' : undefined))}
        />
        <label className="um-sub" htmlFor="um-scope">
          Auto selection uses
        </label>
        <Sel
          id="um-scope"
          value={pops.some((p) => p.value === draft.setup.scope) ? draft.setup.scope : 'root'}
          ariaLabel="Events used for automatic selection"
          options={[{ value: 'root', label: 'All events' }, ...pops]}
          onChange={(v) => up((d) => void (d.setup.scope = v))}
        />
      </div>
      {draft.setup.controls.length ? (
        <div className="um-ctl-grid">
          <div className="um-ctl-headrow">
            <span />
            <span>Endmember</span>
            <span title={draft.setup.posMode === 'all' ? 'Auto: every event above the negative population in the peak detector (saturated events excluded). Or choose a gated population.' : 'Auto: the brightest 3 % of the events in the peak detector (saturated events excluded). Or choose a gated population.'}>Positive</span>
            <span title="Auto: the control's own negative events when it has a distinct negative population (beads, partly stained cells), else the unstained sample. Or force the unstained sample or a gated population.">Negative</span>
            <span>Spectrum</span>
            <span>Peak · events</span>
            <span />
          </div>
          {draft.setup.controls.map((c, i) => (
            <ControlRowView key={c.key} draft={draft} index={i} res={live.rows[c.key]} busy={live.computing.has(c.key) || (live.pending && !live.rows[c.key])} up={up} move={move} pops={pops} order={order} groupsAt={groupsAt} />
          ))}
        </div>
      ) : (
        <div className="card-body">
          <div className="um-empty">
            No controls yet. Add one single-stained sample per fluorochrome (beads or cells), or import reference spectra from a CSV library.
          </div>
        </div>
      )}
      {picker && <AddControlsModal draft={draft} onClose={() => setPicker(false)} onAdd={addSamples} />}
    </div>
  );
}

function ControlRowView({
  draft,
  index,
  res,
  busy,
  up,
  move,
  pops,
  order,
  groupsAt,
}: {
  draft: Draft;
  index: number;
  res: RowResult | undefined;
  busy: boolean;
  up: Up;
  move: (i: number, d: number) => void;
  pops: { value: string; label: string }[];
  order: number[];
  groupsAt: number[];
}) {
  const ws = useStore((s) => s.ws);
  const c = draft.setup.controls[index];
  const n = draft.setup.controls.length;
  const sample = c.sampleId ? ws.samples.find((s) => s.id === c.sampleId) : undefined;
  const set = (f: (x: Draft['setup']['controls'][number]) => void) =>
    up((d) => {
      const r = d.setup.controls.find((x) => x.key === c.key);
      if (r) f(r);
    });
  const withMissing = (v: string, opts: { value: string; label: string }[]) => (opts.some((o) => o.value === v) ? opts : [...opts, { value: v, label: 'Missing population' }]);
  const unName = draft.setup.unstainedId ? ws.samples.find((s) => s.id === draft.setup.unstainedId)?.name : undefined;
  let msg: { cls: string; icon: ReactNode; text: string; title?: string };
  if (busy && !res) msg = { cls: '', icon: <span className="um-spin" />, text: 'Computing…' };
  else if (!res) msg = { cls: '', icon: null, text: '' };
  else if (res.kind === 'error') msg = { cls: 'err', icon: <Ic.err />, text: res.error ?? 'Error', title: [res.error, ...res.warnings].join('\n') };
  else if (res.warnings.length) msg = { cls: 'warn', icon: <Ic.warn />, text: res.warnings[0] + (res.warnings.length > 1 ? ` (+${res.warnings.length - 1} more)` : ''), title: res.warnings.join('\n') };
  else if (res.kind === 'library') msg = { cls: '', icon: <Ic.info />, text: `Library spectrum${res.source ? ` from ${res.source}` : ''}` };
  else
    msg = {
      cls: '',
      icon: <Ic.ok />,
      text: res.negSource === 'unstained' ? `Negatives from the unstained sample${unName ? ` (${unName})` : ''}` : res.negSource === 'population' ? 'Negatives from the selected population' : 'Negatives: dim events of the control itself',
    };
  const peakName = res?.peak !== undefined ? draft.detectors[res.peak] : undefined;
  return (
    <div className={`um-ctl${res?.kind === 'error' ? ' err' : ''}${busy ? ' busy' : ''}`} role="group" aria-label={`Control ${c.name}`}>
      <span className="sw" style={{ background: slotColor(c.color) }} />
      <Txt value={c.name} ariaLabel="Endmember name" onChange={(v) => set((r) => void (r.name = v.trim() || r.name))} />
      {c.fixed ? (
        <span className="um-sub" style={{ gridColumn: '3 / 5' }}>
          Library spectrum (no control sample)
        </span>
      ) : (
        <>
          <Sel value={c.pos} ariaLabel={`Positive events of ${c.name}`} options={withMissing(c.pos, [{ value: 'auto', label: draft.setup.posMode === 'all' ? 'Auto (all positive)' : 'Auto (brightest)' }, ...pops])} onChange={(v) => set((r) => void (r.pos = v))} />
          <Sel
            value={c.neg}
            ariaLabel={`Negative events of ${c.name}`}
            options={withMissing(c.neg, [{ value: 'auto', label: 'Auto' }, { value: 'unstained', label: 'Unstained sample' }, ...pops])}
            onChange={(v) => set((r) => void (r.neg = v))}
          />
        </>
      )}
      <Sparkline values={res?.signature} slot={c.color} peak={res?.peak} order={order} groupsAt={groupsAt} />
      <div className="peak" title={peakName}>
        <b>{peakName ?? '–'}</b>
        <span>{res?.nPos !== undefined ? `${nf(res.nPos)} + / ${nf(res.nNeg)} −` : res?.kind === 'library' ? 'library' : ''}</span>
      </div>
      <span className="acts">
        <button className="icon-btn" aria-label={`Move ${c.name} up`} title="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
          <Ic.up />
        </button>
        <button className="icon-btn" aria-label={`Move ${c.name} down`} title="Move down" disabled={index === n - 1} onClick={() => move(index, 1)}>
          <Ic.down />
        </button>
        <button className="icon-btn danger" aria-label={`Remove ${c.name}`} title="Remove" onClick={() => up((d) => void (d.setup.controls = d.setup.controls.filter((x) => x.key !== c.key)))}>
          <Icon.close />
        </button>
      </span>
      <span className="src" title={sample?.name ?? c.sampleName}>
        {c.fixed ? c.fixed.source ?? 'Imported' : sample?.name ?? `${c.sampleName ?? 'Sample'} (removed)`}
      </span>
      <span className={`msg ${msg.cls}`} title={msg.title ?? msg.text}>
        {msg.icon}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{msg.text}</span>
        {res?.overridable === 'weak' && (
          <button className="um-link" style={{ flex: 'none', marginLeft: 6 }} onClick={() => set((r) => void (r.allowWeak = true))} title="Use this sample as a control although it shows no distinct stained population">
            Use anyway
          </button>
        )}
        {c.allowWeak && res?.kind !== 'error' && res?.warnings.some((w) => /override/.test(w)) && (
          <button className="um-link" style={{ flex: 'none', marginLeft: 6 }} onClick={() => set((r) => void delete r.allowWeak)} title="Treat a missing stained population as an error again">
            Undo override
          </button>
        )}
      </span>
    </div>
  );
}

function AddControlsModal({ draft, onClose, onAdd }: { draft: Draft; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const ws = useStore((s) => s.ws);
  const loaded = loadedSamples(ws);
  const used = new Set(draft.setup.controls.map((c) => c.sampleId));
  const likely = new Set(guessControls(ws).controls);
  const [sel, setSel] = useState<Set<string>>(() => new Set(loaded.filter((s) => likely.has(s.id) && !used.has(s.id) && s.id !== draft.setup.unstainedId).map((s) => s.id)));
  const [filter, setFilter] = useState('');
  const shown = loaded.filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));
  const selectable = shown.filter((s) => !used.has(s.id) && s.id !== draft.setup.unstainedId);
  return (
    <Modal
      title="Add single-stained controls"
      onClose={onClose}
      footer={
        <>
          <span className="um-sub" style={{ marginRight: 'auto' }}>
            {sel.size} selected
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!sel.size}
            onClick={() => {
              onAdd(loaded.filter((s) => sel.has(s.id)).map((s) => s.id));
              onClose();
            }}
          >
            Add {sel.size || ''}
          </button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="inp" style={{ flex: 1, width: 'auto' }} placeholder="Filter by name" aria-label="Filter samples" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn sm" onClick={() => setSel(new Set([...sel, ...selectable.map((s) => s.id)]))}>
          All
        </button>
        <button className="btn sm" onClick={() => setSel(new Set([...sel].filter((id) => !shown.some((s) => s.id === id))))}>
          None
        </button>
        <button className="btn sm" onClick={() => setSel(new Set(selectable.filter((s) => likely.has(s.id)).map((s) => s.id)))}>
          Likely controls
        </button>
      </div>
      <div className="um-pick">
        {shown.map((s) => {
          const dis = used.has(s.id) || s.id === draft.setup.unstainedId;
          return (
            <label key={s.id} className={dis ? 'dis' : ''}>
              <input
                type="checkbox"
                disabled={dis}
                checked={dis ? used.has(s.id) : sel.has(s.id)}
                onChange={(e) => {
                  const n = new Set(sel);
                  if (e.target.checked) n.add(s.id);
                  else n.delete(s.id);
                  setSel(n);
                }}
              />
              <span className="nm" title={s.name}>
                {s.name}
              </span>
              <span className="meta">{used.has(s.id) ? 'added' : s.id === draft.setup.unstainedId ? 'unstained' : `→ ${endmemberNameFromSample(s.name)}`}</span>
              <span className="meta">{nf(s.eventCount)} events</span>
            </label>
          );
        })}
        {!shown.length && <div className="empty-note">No loaded sample matches.</div>}
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>
        The endmember name is taken from the sample name ("Compensation-FITC" → FITC) and can be edited.
      </p>
    </Modal>
  );
}

// ------------------------------------------------------------------ 2 detectors

function detectorSource(ws: Workspace, draft: Draft) {
  const id = draft.setup.controls.find((c) => c.sampleId && engine.has(c.sampleId))?.sampleId ?? (draft.setup.unstainedId && engine.has(draft.setup.unstainedId) ? draft.setup.unstainedId : loadedSamples(ws)[0]?.id);
  return id ? engine.samples.get(id)?.ds ?? null : null;
}

function useGroups(draft: Draft, list: string[]) {
  const ws = useStore((s) => s.ws);
  const ds = detectorSource(ws, draft);
  return useMemo(() => groupDetectors(list, ds ? channelWavelengths(ds.keywords, ds.channels.map((c) => c.name)) : {}), [list, ds]);
}

function DetectorsCard({ draft, live, up }: { draft: Draft; live: Live; up: Up }) {
  const ws = useStore((s) => s.ws);
  const [open, setOpen] = useState(false);
  const ds = detectorSource(ws, draft);
  const showHW = !!draft.setup.showHW;
  const all = useMemo(() => {
    const c = ds ? detectorCandidates(ds.channels.map((x) => x.name), showHW) : [];
    return [...c, ...draft.detectors.filter((d) => !c.includes(d))];
  }, [ds, showHW, draft.detectors]);
  const groups = useGroups(draft, all);
  const sel = new Set(draft.detectors);
  const setSel = (next: Set<string>) => up((d) => void (d.detectors = all.filter((x) => next.has(x))));
  const peaks = new Map<string, number[]>();
  draft.setup.controls.forEach((c) => {
    const r = live.rows[c.key];
    if (r?.peak !== undefined) {
      const n = draft.detectors[r.peak];
      peaks.set(n, [...(peaks.get(n) ?? []), c.color]);
    }
  });
  const dflt = defaultDetectorsFor(ws, draft.setup.controls.map((c) => c.sampleId));
  return (
    <div className="card">
      <div className="card-head">
        <h3>
          <span className="step">2</span>Detectors
        </h3>
        <span className="um-sub">
          {draft.detectors.length} of {all.length} selected
        </span>
        <span className="grow" />
        <button className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Choose detectors'}
        </button>
      </div>
      <div className="card-body">
        {!open ? (
          <div className="um-det-sum">
            {groups.map((g) => {
              const n = g.detectors.filter((d) => sel.has(d)).length;
              return (
                <span key={g.id} className={`um-chip${n ? ' on' : ''}`} style={{ cursor: 'default' }}>
                  {g.label} {n}/{g.detectors.length}
                </span>
              );
            })}
            {!groups.length && <span className="hint">Add a control to list its detectors.</span>}
            <span className="hint" style={{ marginLeft: 6 }}>
              Use every fluorescence detector of all lasers: more detectors separate similar fluorochromes better.
            </span>
          </div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <Check checked={showHW} label="Show height and width channels" onChange={(v) => up((d) => void (d.setup.showHW = v))} />
              <span className="grow" style={{ flex: 1 }} />
              <button className="btn sm" disabled={!dflt.length} onClick={() => up((d) => void (d.detectors = dflt))} title="All fluorescence area channels">
                Default ({dflt.length})
              </button>
            </div>
            {groups.map((g) => {
              const n = g.detectors.filter((d) => sel.has(d)).length;
              return (
                <div key={g.id} className="um-group">
                  <div className="um-group-head">
                    {g.label}
                    <span className="cnt">
                      {n}/{g.detectors.length}
                    </span>
                    <button className="um-link" disabled={n === g.detectors.length} onClick={() => setSel(new Set([...sel, ...g.detectors]))}>
                      All
                    </button>
                    <button className="um-link" disabled={!n} onClick={() => setSel(new Set([...sel].filter((x) => !g.detectors.includes(x))))}>
                      None
                    </button>
                  </div>
                  <div className="um-chips">
                    {g.detectors.map((d) => {
                      const on = sel.has(d);
                      const pk = peaks.get(d);
                      return (
                        <button
                          key={d}
                          className={`um-chip${on ? ' on' : ''}`}
                          aria-pressed={on}
                          title={pk ? `${d}: peak detector of ${draft.setup.controls.filter((c) => pk.includes(c.color)).map((c) => c.name).join(', ')}` : d}
                          onClick={() => {
                            const nx = new Set(sel);
                            if (on) nx.delete(d);
                            else nx.add(d);
                            setSel(nx);
                          }}
                        >
                          {pk?.slice(0, 3).map((s, k) => <span key={k} className="pk" style={{ background: slotColor(s) }} />)}
                          {d}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 3 autofluorescence

function AfCard({ draft, live, up }: { draft: Draft; live: Live; up: Up }) {
  const ws = useStore((s) => s.ws);
  const loaded = loadedSamples(ws);
  const controlIds = new Set(draft.setup.controls.map((c) => c.sampleId));
  const unOpts = [
    { value: '', label: 'None' },
    ...ws.samples.filter((s) => engine.has(s.id) || s.id === draft.setup.unstainedId).map((s) => ({ value: s.id, label: s.name + (controlIds.has(s.id) ? ' (used as control)' : '') })),
    ...(draft.setup.unstainedId && !ws.samples.some((s) => s.id === draft.setup.unstainedId) ? [{ value: draft.setup.unstainedId, label: 'Removed sample' }] : []),
  ];
  const af = live.af;
  const k = draft.setup.afK;
  const hasAf = !!af?.endmembers.length;
  return (
    <div className="card um-form">
      <div className="card-head">
        <h3>
          <span className="step">3</span>Autofluorescence
        </h3>
      </div>
      <div className="card-body">
        <div className="frow">
          <label htmlFor="um-un">Unstained sample</label>
          <Sel id="um-un" value={draft.setup.unstainedId ?? ''} ariaLabel="Unstained sample" options={unOpts} onChange={(v) => up((d) => void (d.setup.unstainedId = v || null))} />
        </div>
        <div className="frow">
          <label />
          <Check checked={draft.includeAF} label="Treat autofluorescence as a channel" onChange={(v) => up((d) => void (d.includeAF = v))} />
        </div>
        <div className="frow">
          <label htmlFor="um-afk">AF signatures</label>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span style={{ width: 64, flex: 'none' }}>
              <Num id="um-afk" value={k} min={1} max={8} step={1} digits={0} ariaLabel="Number of autofluorescence signatures" onChange={(v) => up((d) => void (d.setup.afK = Math.max(1, Math.min(8, Math.round(v)))))} />
            </span>
            {k > 1 && (
              <Seg
                value={draft.afMode}
                options={[
                  { value: 'best', label: 'Best per cell', title: 'Each event uses the AF signature that fits it best: one "AF" channel plus "AF Index"' },
                  { value: 'all', label: 'All as channels', title: 'Every AF signature is unmixed as its own channel' },
                ]}
                onChange={(v) => up((d) => void (d.afMode = v))}
              />
            )}
          </div>
        </div>
        <div className="um-kv">
          {hasAf ? (
            <>
              {af!.endmembers.map((e) => (
                <div key={e.name}>
                  <b>{e.name}</b>: peak {e.peak !== undefined ? draft.detectors[e.peak] : '–'}
                  {e.nPos ? `, ${nf(e.nPos)} events` : ''}
                  {af!.kind === 'stored' ? ' (stored)' : af!.kind === 'library' ? ' (library)' : ''}
                </div>
              ))}
              {[...af!.warnings].map((w, i) => (
                <div key={i} style={{ color: 'var(--warn-text)' }}>
                  {w}
                </div>
              ))}
              {!draft.includeAF && <div className="hint">Shown in the spectra below; not unmixed until "Treat autofluorescence as a channel" is on.</div>}
            </>
          ) : live.afError ? (
            <div style={{ color: 'var(--danger)' }}>{live.afError}</div>
          ) : !loaded.length ? null : (
            <div className="hint">Choose the unstained sample of the cells you will unmix. Bead controls do not need it.</div>
          )}
          {draft.setup.afFixed?.length && draft.setup.unstainedId ? <div className="hint">Library AF spectra are used only without an unstained sample.</div> : null}
          {draft.setup.afFixed?.length ? (
            <button className="um-link" style={{ paddingLeft: 0 }} onClick={() => up((d) => void delete d.setup.afFixed)}>
              Remove library AF spectra
            </button>
          ) : null}
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          Extracting autofluorescence helps with dim markers on bright cells (myeloid cells, tissue). Several signatures capture cell types with different autofluorescence.
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 4 method and outputs

function MethodCard({ draft, live, up }: { draft: Draft; live: Live; up: Up }) {
  const ws = useStore((s) => s.ws);
  const outputs = useMemo(() => {
    if (!live.def) return [];
    const names = unmixOutputNames(live.def, []);
    return plannedOutputs(ws, live.def, live.def.endmembers.map(() => undefined)).map((o, k) => ({ ...o, base: names[k], row: k < live.def!.endmembers.length ? draft.setup.controls[live.used[k]] : undefined }));
  }, [live, ws, draft]);
  return (
    <div className="card um-form">
      <div className="card-head">
        <h3>
          <span className="step">4</span>Method and outputs
        </h3>
      </div>
      <div className="card-body">
        <div className="frow">
          <label>Method</label>
          <div>
            <Seg
              value={draft.method}
              options={[
                { value: 'ols', label: 'OLS', title: 'Ordinary least squares (default)' },
                { value: 'wls', label: 'WLS', title: 'Weighted least squares' },
                { value: 'nnls', label: 'NNLS', title: 'Non-negative least squares' },
              ]}
              onChange={(v) => up((d) => void (d.method = v))}
            />
          </div>
        </div>
        <p className="um-explain">{METHOD_TEXT[draft.method]}</p>
        {draft.method === 'wls' && (
          <div className="frow" style={{ marginTop: 8 }}>
            <label />
            <Check checked={draft.nonNegative} label="Also forbid negative values (display only)" onChange={(v) => up((d) => void (d.nonNegative = v))} />
          </div>
        )}
        <div className="frow" style={{ marginTop: 10 }}>
          <label>Residual output</label>
          <div>
            <Seg
              value={draft.residual}
              options={[
                { value: 'none', label: 'None' },
                { value: 'rms', label: 'RMS', title: 'Root mean square of the per-detector residuals: high where the spectra do not explain an event' },
                { value: 'ssr', label: 'Sum of squares' },
              ]}
              onChange={(v) => up((d) => void (d.residual = v))}
            />
          </div>
        </div>
        <div className="frow" style={{ alignItems: 'start', marginTop: 10 }}>
          <label style={{ paddingTop: 3 }}>Output channels</label>
          {outputs.length ? (
            <div className="um-outs">
              {outputs.map((o, k) => (
                <OutputRow key={k} name={o.name} base={o.base} range={o.range} slot={o.row ? o.row.color : 'af'} marker={o.row?.marker} onMarker={o.row ? (v) => up((d) => {
                  const r = d.setup.controls.find((x) => x.key === o.row!.key);
                  if (r) r.marker = v.trim() || undefined;
                }) : undefined} />
              ))}
            </div>
          ) : (
            <span className="hint">Appear when the controls have signatures.</span>
          )}
        </div>
      </div>
    </div>
  );
}

function OutputRow({ name, base, range, slot, marker, onMarker }: { name: string; base: string; range: number; slot: number | 'af'; marker?: string; onMarker?: (v: string) => void }) {
  return (
    <>
      <span className="sw" style={{ width: 10, height: 10, borderRadius: '50%', background: slotColor(slot) }} />
      <span className="nm" title={name !== base ? `Renamed: "${base}" is already a channel name` : undefined}>
        {name}
      </span>
      {onMarker ? <Txt value={marker ?? ''} placeholder="Marker (optional)" ariaLabel={`Marker for ${name}`} onChange={onMarker} /> : <span className="um-sub">{name === 'AF Index' ? 'which AF signature fits best' : ''}</span>}
      <span className="rg">{range >= 1e6 ? `2^${Math.round(Math.log2(range))}` : nf(Math.round(range))}</span>
    </>
  );
}

// ------------------------------------------------------------------ 5 quality control

function QcCard({ draft, live }: { draft: Draft; live: Live }) {
  const [mode, setMode] = useState<'lines' | 'heatmap'>(draft.setup.controls.length > 12 ? 'heatmap' : 'lines');
  const groups = useGroups(draft, draft.detectors);
  const series: SpectrumSeries[] = [];
  draft.setup.controls.forEach((c) => {
    const r = live.rows[c.key];
    if (r?.signature && r.signature.length === draft.detectors.length) series.push({ key: c.key, name: c.name, values: r.signature, slot: c.color, note: r.kind === 'stored' ? 'stored' : r.kind === 'library' ? 'library' : undefined });
  });
  live.af?.endmembers.forEach((e, i) => {
    if (e.signature.length === draft.detectors.length) series.push({ key: 'af_' + i, name: e.name, values: e.signature, slot: 'af', afIndex: i, note: draft.includeAF ? undefined : 'not unmixed' });
  });
  const q = live.quality;
  const ci = q ? complexityInfo(q.complexity) : complexityInfo(NaN);
  const slots = (names: string[]) =>
    names.map((n) => {
      const c = draft.setup.controls.find((x) => x.name.trim() === n);
      return c ? c.color : ('af' as const);
    });
  // most similar pair
  let best: { a: string; b: string; s: number } | null = null;
  if (q) for (let i = 0; i < q.names.length; i++) for (let j = i + 1; j < q.names.length; j++) if (!best || q.similarity[i][j] > best.s) best = { a: q.names[i], b: q.names[j], s: q.similarity[i][j] };
  const sp = live.spread;
  const spNames = sp?.names ?? [];
  const spRows = sp?.rows ?? [];
  let ssmMax = 0;
  let leakMax = 0.02;
  if (sp)
    for (const i of spRows)
      for (let j = 0; j < spNames.length; j++) {
        if (j === i) continue;
        if (Number.isFinite(sp.ssm[i][j])) ssmMax = Math.max(ssmMax, sp.ssm[i][j]);
        if (Number.isFinite(sp.leakage[i][j])) leakMax = Math.max(leakMax, Math.abs(sp.leakage[i][j]));
      }
  return (
    <div className="card um-qc">
      <div className="card-head">
        <h3>
          <span className="step">5</span>Quality control
        </h3>
        <span className="grow" />
        <Seg
          value={mode}
          options={[
            { value: 'lines', label: 'Lines' },
            { value: 'heatmap', label: 'Heatmap' },
          ]}
          onChange={setMode}
        />
        <button className="btn sm" disabled={!live.def} onClick={() => live.def && exportSpectraCsv(live.def)} title="Reference spectra as CSV (detectors x endmembers), to reuse as a library">
          <Icon.export /> Export spectra (CSV)
        </button>
      </div>
      <div className="card-body" style={{ opacity: live.pending ? 0.75 : 1, transition: 'opacity 150ms' }}>
        <h4>Reference spectra</h4>
        <p className="um-sub">Normalised to the peak detector (max = 1), detectors grouped by laser. Hover to read values; click a legend entry to hide it.</p>
        {series.length ? <SpectraPlot detectors={draft.detectors} groups={groups} series={series} mode={mode} /> : <div className="um-empty">Spectra appear when controls are added.</div>}
        <div className={`um-qc-grid${(q?.names.length ?? 0) > 9 ? ' wide' : ''}`} style={{ marginTop: 22 }}>
          <div>
            <h4>Similarity matrix</h4>
            <p className="um-sub">Cosine similarity of the spectra (1 = identical). Pairs above 0.98 are outlined: they cannot be separated reliably.</p>
            {q && q.names.length > 1 ? (
              <>
                <MatrixHeatmap
                  label="Similarity matrix"
                  rows={q.names}
                  cols={q.names}
                  rowSlots={slots(q.names)}
                  ramp="seq"
                  cells={q.similarity.map((r, i) => r.map((v, j): MatrixCell => (i === j ? { v: null } : { v, t: Math.max(0, v), text: v.toFixed(2), flag: v > 0.98 })))}
                  tip={(i, j) => (i === j ? q.names[i] : `${q.names[i]} vs ${q.names[j]}: ${q.similarity[i][j].toFixed(3)}`)}
                />
                <RampLegend ramp="seq" lo="0" hi="1" />
              </>
            ) : (
              <div className="um-empty">Needs two or more spectra.</div>
            )}
          </div>
          <div>
            <h4>Complexity index</h4>
            <p className="um-sub">Condition number of the spectra: how much unmixing amplifies noise (1 = independent spectra).</p>
            <div className="um-ci">
              <span className="big">{q ? (Number.isFinite(q.complexity) ? q.complexity.toFixed(q.complexity < 10 ? 2 : 1) : '∞') : '–'}</span>
              {ci.level !== 'none' && <span className={`lvl ${ci.level}`}>{ci.level[0].toUpperCase() + ci.level.slice(1)}</span>}
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              {ci.text}
            </p>
            {q && (
              <ul className="um-pairs">
                {q.similarPairs.map((p) => (
                  <li key={p.a + p.b}>
                    <Ic.warn />
                    <span>
                      <b>{p.a}</b> and <b>{p.b}</b>: {p.similarity.toFixed(3)}
                    </span>
                  </li>
                ))}
                {!q.similarPairs.length && best && (
                  <li>
                    Most similar: <b>{best.a}</b> and <b>{best.b}</b> ({best.s.toFixed(3)})
                  </li>
                )}
                {q.warnings
                  .filter((w) => !/too similar/.test(w))
                  .map((w) => (
                    <li key={w} style={{ color: 'var(--warn-text)' }}>
                      {w}
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <div>
            <h4 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              Spillover spreading after unmixing
              <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={!sp || !spRows.length} onClick={() => sp && exportSpreadCsv(draft.name || 'unmixing', sp)} title="Spreading and leakage matrices as CSV">
                <Icon.export /> CSV
              </button>
            </h4>
            <p className="um-sub">Spread (√ intensity units) that each control (row) adds to the other channels (columns), from the controls' own events with the current method. Hover for exact values.</p>
            {sp && spRows.length ? (
              <>
                <MatrixHeatmap
                  label="Spillover spreading matrix"
                  rows={spRows.map((i) => spNames[i])}
                  cols={spNames}
                  rowSlots={slots(spRows.map((i) => spNames[i]))}
                  ramp="org"
                  cells={spRows.map((i) => spNames.map((_, j): MatrixCell => {
                    const v = sp.ssm[i][j];
                    return i === j || !Number.isFinite(v) ? { v: null } : { v, t: ssmMax > 0 ? v / ssmMax : 0, text: v >= 0.05 ? v.toFixed(1) : '' };
                  }))}
                  tip={(r, j) => {
                    const i = spRows[r];
                    const v = sp.ssm[i][j];
                    return i === j ? spNames[i] : `${spNames[i]} spreads into ${spNames[j]}: ${Number.isFinite(v) ? v.toFixed(2) : 'n/a'}`;
                  }}
                />
                <RampLegend ramp="org" lo="0" hi={ssmMax.toFixed(1)} />
              </>
            ) : (
              <div className="um-empty">{live.spreadError ?? (live.pending ? 'Computing…' : 'Needs controls with positive and negative events.')}</div>
            )}
          </div>
          <div>
            <h4>Leakage after unmixing</h4>
            <p className="um-sub">Signal of each control (row) left in the other channels, as % of its own signal. Near 0 % is good (blank below 0.05 %); above 5 % is outlined.</p>
            {sp && spRows.length ? (
              <>
                <MatrixHeatmap
                  label="Leakage matrix"
                  rows={spRows.map((i) => spNames[i])}
                  cols={spNames}
                  rowSlots={slots(spRows.map((i) => spNames[i]))}
                  ramp="div"
                  cells={spRows.map((i) => spNames.map((_, j): MatrixCell => {
                    const v = sp.leakage[i][j];
                    return i === j || !Number.isFinite(v) ? { v: null } : { v, t: v / leakMax, text: Math.abs(v) >= 0.0005 ? fmtPct(v) : '', flag: Math.abs(v) > 0.05 };
                  }))}
                  tip={(r, j) => {
                    const i = spRows[r];
                    const v = sp.leakage[i][j];
                    return i === j ? spNames[i] : `${spNames[i]} in ${spNames[j]}: ${Number.isFinite(v) ? (v * 100).toFixed(2) + ' %' : 'n/a'}`;
                  }}
                />
                <RampLegend ramp="div" lo={`−${(leakMax * 100).toFixed(0)} %`} mid="0" hi={`+${(leakMax * 100).toFixed(0)} %`} />
              </>
            ) : (
              <div className="um-empty">{live.spreadError ?? (live.pending ? 'Computing…' : 'Needs controls with positive and negative events.')}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
