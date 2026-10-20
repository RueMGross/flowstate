// Marker labels, Methods & legend writer, Check analysis and Describe experiment.
import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../../core/engine';
import { prepareCheck, parseIssues, type CheckIssue, type CheckPrep } from '../../ai/check';
import { sampleLabel } from '../../ai/context';
import { applyMarkers, markerRequest, markerRows, mergeMarkers, type MarkerRow } from '../../ai/markers';
import { workspaceSummary } from '../../ai/methods';
import { experimentRequest, parseExperiment, type ExperimentReading } from '../../ai/experiment';
import { anon } from '../../ai/context';
import { useAiSettings } from '../../ai/settings';
import { uid } from '../../core/model';
import { annotateWellValues } from '../../state/plateOps';
import { legendPrompt, methodsPrompt } from '../../ai/prompts';
import { AiError, aiErrorMessage, completeJson, type AiProvider } from '../../ai/provider';
import { useStore } from '../../state/store';
import { revealItems } from '../layoutOps';
import { Busy, copyText, imagesOn, openAi, prepCurrent, sameInputs, Sent, useJob, usePrivacy } from './shared';

export function MarkersView({ provider }: { provider: AiProvider | null }) {
  const ws = useStore((s) => s.ws);
  const [panel, setPanel] = useState('');
  const [rows, setRows] = useState<MarkerRow[] | null>(null);
  const { anonymize } = usePrivacy();
  const base = useMemo(() => markerRows(ws), [ws]);
  // anonymize: markerRequest reads the setting; listed so the text follows it while the panel is open
  const prompt = useMemo(() => markerRequest(ws, base, panel), [ws, base, panel, anonymize]); // eslint-disable-line react-hooks/exhaustive-deps
  const job = useJob();
  const suggest = () =>
    job.run(async (signal) => {
      if (!provider) return;
      const { value } = await completeJson(provider, { prompt, tier: 'quick', signal, maxTokens: 4000 });
      setRows(mergeMarkers(base, value));
    });
  const apply = () => {
    const n = rows ? applyMarkers(rows) : 0;
    useStore.getState().toast(n ? `Set ${n} marker label${n > 1 ? 's' : ''} (Undo reverts them)` : 'No labels changed', n ? 'success' : 'info');
    setRows(null);
  };
  const up = (i: number, p: Partial<MarkerRow>) => setRows((r) => r && r.map((x, k) => (k === i ? { ...x, ...p } : x)));
  if (!base.length) return <p className="ai-note">No fluorescence channels in this workspace.</p>;
  return (
    <>
      <label className="ai-l">
        Panel description (optional): paste the antibody panel, e.g. "CD3 FITC, CD8 PE, CD45 PerCP-Cy5.5"
        <textarea value={panel} onChange={(e) => setPanel(e.target.value)} />
      </label>
      <Sent prompt={prompt} provider={provider} />
      <div className="ai-row">
        <button className="btn primary" disabled={job.busy || !provider} onClick={suggest}>
          Suggest labels
        </button>
      </div>
      <Busy busy={job.busy} err={job.err} stop={job.stop} />
      {rows && (
        <>
          <table className="ai-table">
            <thead>
              <tr>
                <th />
                <th>Channel</th>
                <th>Now</th>
                <th>Suggested</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.channel} title={r.note}>
                  <td>
                    <input type="checkbox" checked={r.accept} disabled={!r.suggestion.trim()} aria-label={`Use the suggestion for ${r.channel}`} onChange={(e) => up(i, { accept: e.target.checked })} />
                  </td>
                  <td>{r.channel}</td>
                  <td>{r.current || '-'}</td>
                  <td>
                    <input className="inp" value={r.suggestion} aria-label={`Label for ${r.channel}`} onChange={(e) => up(i, { suggestion: e.target.value, accept: !!e.target.value.trim() })} />
                    {r.note && <div className="ai-note">{r.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ai-row">
            <button className="btn primary" disabled={!rows.some((r) => r.accept)} onClick={apply}>
              Apply {rows.filter((r) => r.accept).length === 1 ? '1 label' : `${rows.filter((r) => r.accept).length} labels`}
            </button>
            <button className="btn" onClick={() => setRows(null)}>
              Discard
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function WriterView({ provider }: { provider: AiProvider | null }) {
  const ws = useStore((s) => s.ws);
  const sheetId = useStore((s) => s.ui.activeSheetId);
  const [sid, setSid] = useState(useStore.getState().ui.activeSampleId);
  const { anonymize } = usePrivacy();
  const [summary, setSummary] = useState(() => workspaceSummary(ws, sid, sheetId));
  // the name setting the summary was built with, and whether it was edited by hand since
  const builtHidden = useRef(anonymize);
  const [edited, setEdited] = useState(false);
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<'methods' | 'legend'>('methods');
  const [out, setOut] = useState({ methods: '', legend: '' });
  const job = useJob();
  const build = (s = sid) => {
    builtHidden.current = useAiSettings.getState().anonymize;
    return workspaceSummary(useStore.getState().ws, s, sheetId);
  };
  const rebuild = (s = sid) => {
    setSummary(build(s));
    setEdited(false);
    setNote('');
  };
  // "Hide sample and file names" changed while the panel is open: the summary is built again with the new setting
  useEffect(() => {
    if (builtHidden.current === anonymize) return;
    setNote(edited ? `Summary rebuilt because "Hide sample and file names" was turned ${anonymize ? 'on' : 'off'}; your edits to it were replaced.` : '');
    setSummary(build());
    setEdited(false);
  }, [anonymize]); // eslint-disable-line react-hooks/exhaustive-deps
  const prompt = kind === 'methods' ? methodsPrompt(summary) : legendPrompt(summary);
  const write = () =>
    job.run(async (signal) => {
      if (!provider) return;
      const k = kind;
      // never send a summary built with the other name setting
      let sum = summary;
      if (builtHidden.current !== useAiSettings.getState().anonymize) {
        sum = build();
        setSummary(sum);
        setEdited(false);
      }
      setOut((o) => ({ ...o, [k]: '' }));
      const r = await provider.complete({ prompt: k === 'methods' ? methodsPrompt(sum) : legendPrompt(sum), tier: 'default', signal, maxTokens: 5000, fresh: true, onText: (t) => setOut((o) => ({ ...o, [k]: t })) });
      setOut((o) => ({ ...o, [k]: r.text + (r.incomplete ? '\n[cut off: the connection closed before the answer was complete]' : r.truncated ? '\n[cut short]' : '') }));
      if (r.incomplete) job.setErr(aiErrorMessage(new AiError('incomplete')));
    });
  const text = out[kind];
  return (
    <>
      <div className="ai-row">
        <div className="seg">
          {(['methods', 'legend'] as const).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === 'methods' ? 'Methods paragraph' : 'Figure legend'}
            </button>
          ))}
        </div>
      </div>
      <label className="ai-l">
        Counts from sample
        <select
          className="sel"
          value={sid ?? ''}
          onChange={(e) => {
            setSid(e.target.value);
            rebuild(e.target.value);
          }}
        >
          {ws.samples
            .filter((s) => engine.has(s.id))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {sampleLabel(ws, s.id)}
              </option>
            ))}
        </select>
      </label>
      <label className="ai-l">
        Summary of the workspace (built here; edit or shorten it before sending)
        <textarea
          rows={10}
          value={summary}
          onChange={(e) => {
            setSummary(e.target.value);
            setEdited(true);
          }}
        />
      </label>
      {note && <p className="ai-note">{note}</p>}
      <div className="ai-row">
        <button className="btn sm" onClick={() => rebuild()}>
          Rebuild summary
        </button>
      </div>
      <Sent prompt={prompt} provider={provider} />
      <div className="ai-row">
        <button className="btn primary" disabled={job.busy || !provider || !summary.trim()} onClick={write}>
          {kind === 'methods' ? 'Write methods paragraph' : 'Write figure legend'}
        </button>
      </div>
      <Busy busy={job.busy && !text} err={job.err} stop={job.stop} />
      {text && (
        <div className="ai-card">
          <div className="ai-out">{text}</div>
          <div className="ai-row">
            <span className="grow ai-note">Draft by AI: check every statement and fill the [to fill] places.</span>
            {job.busy ? (
              <button className="btn sm" onClick={job.stop}>
                Stop
              </button>
            ) : (
              <button className="btn sm" onClick={() => void copyText(text)}>
                Copy
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function CheckView({ provider }: { provider: AiProvider | null }) {
  const ws = useStore((s) => s.ws);
  const sheetId = useStore((s) => s.ui.activeSheetId);
  const sid = useStore((s) => s.ui.activeSampleId);
  const [prep, setPrepState] = useState<CheckPrep | null>(null);
  const [res, setRes] = useState<{ issues: CheckIssue[]; summary: string; sheetId: string } | null>(null);
  const cur = useRef<CheckPrep | null>(null);
  const job = useJob();
  const setPrep = (p: CheckPrep | null) => {
    cur.current?.images.forEach((i) => URL.revokeObjectURL(i.url));
    cur.current = p;
    setPrepState(p);
  };
  const { anonymize, allowImages } = usePrivacy();
  // what will be sent, rebuilt when the sheet, sample, data or privacy settings change (also once a check that ran
  // meanwhile is done)
  const inputs = [ws, sheetId, sid, provider, anonymize, allowImages];
  const built = useRef<unknown[] | null>(null);
  useEffect(() => {
    if (job.busy || sameInputs(built.current, inputs)) return;
    let alive = true;
    const t = window.setTimeout(() => {
      prepareCheck(ws, sheetId, sid, imagesOn(provider)).then(
        (p) => {
          if (!alive) return p.images.forEach((i) => URL.revokeObjectURL(i.url));
          built.current = inputs;
          setPrep(p);
        },
        (e) => alive && job.setErr(aiErrorMessage(e)),
      );
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [...inputs, job.busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setPrep(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // a request built with other privacy settings is never shown as "sent" or sent (the new one follows in a moment)
  const ready = prepCurrent(prep, provider);
  const check = () =>
    job.run(async (signal) => {
      if (!provider || !prep || !prepCurrent(prep, provider)) return;
      const { value } = await completeJson(provider, { prompt: prep.prompt, images: prep.images.map((i) => i.blob), tier: 'default', signal, maxTokens: 6000, fresh: true });
      setRes({ ...parseIssues(value, prep.items), sheetId });
    });
  const goTo = (id: string) => {
    useStore.getState().setUI({ view: 'sheet', activeSheetId: res?.sheetId ?? sheetId, selectedItemIds: [id], keyItemId: id, selectedPopId: null });
    revealItems([id]);
  };
  return (
    <>
      <p className="ai-note">Sends the plots of this worksheet (up to 8) with the gating tree and counts, and lists potential problems. These are suggestions from the AI, not a validation: check each one yourself.</p>
      {prep && ready && <Sent prompt={prep.prompt} images={prep.images.map((i) => i.url)} provider={provider} />}
      <div className="ai-row">
        <button className="btn primary" disabled={!prep || !ready || !prep.items.length || job.busy || !provider} onClick={check}>
          Check analysis
        </button>
      </div>
      <Busy busy={job.busy} err={job.err} stop={job.stop} />
      {res && (
        <>
          {res.summary && <p>{res.summary}</p>}
          {!res.issues.length && <p className="ai-ok">No issues reported.</p>}
          {res.issues.map((x, i) => (
            <div key={i} className="ai-card">
              <div className="ai-row">
                <span className={`ai-sev ${x.severity}`}>{x.severity}</span>
                <b className="grow">{x.title}</b>
                {x.itemId && (
                  <button className="btn xs" onClick={() => goTo(x.itemId!)}>
                    Go to plot
                  </button>
                )}
              </div>
              {x.detail && <span>{x.detail}</span>}
              {x.population && <span className="ai-note">Population: {x.population}</span>}
            </div>
          ))}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Describe experiment (what was measured)

const GROUP_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#8c564b', '#e377c2', '#bcbd22', '#7f7f7f'];

/** The AI reads the loaded files (summaries, no events) and describes the experiment, its groups and the next steps. */
export function ExperimentView({ provider }: { provider: AiProvider | null }) {
  const ws = useStore((s) => s.ws);
  const dataVersion = useStore((s) => s.ui.dataVersion);
  const { anonymize } = usePrivacy();
  // "Send tube names": the user's choice under the current name setting; when "Hide sample and file names" switches
  // while the panel is open, it follows the setting again (the box can be ticked again)
  const [namesFor, setNamesFor] = useState(() => ({ hidden: anon(), names: !anon() }));
  const names = namesFor.hidden === anonymize ? namesFor.names : !anonymize;
  const setNames = (v: boolean) => setNamesFor({ hidden: anonymize, names: v });
  const [res, setRes] = useState<ExperimentReading | null>(null);
  const [pick, setPick] = useState<boolean[]>([]);
  const job = useJob();
  const loaded = ws.samples.some((s) => engine.has(s.id));
  // the request is rebuilt when samples, data or the name settings change (not on every edit of the analysis)
  const req = useMemo(() => (loaded ? experimentRequest(ws, { names }) : null), [ws.samples, dataVersion, names, loaded, anonymize]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = () =>
    job.run(async (signal) => {
      if (!provider || !req) return;
      const { value } = await completeJson(provider, { prompt: req.prompt, tier: 'default', signal, maxTokens: 6000, fresh: true });
      const r = parseExperiment(useStore.getState().ws, req, value);
      setRes(r);
      setPick(r.groups.map(() => true));
    });
  const st = useStore.getState();
  const label = (id: string) => sampleLabel(ws, id);
  const applySetup = () => {
    if (!res?.setup) return;
    const s = res.setup;
    st.update((w) => {
      w.setup = { ...s };
    });
    st.toast(`Experiment set to ${s.kind}${s.mesf || s.size ? ` with ${[s.mesf && 'MESF', s.size && 'size'].filter(Boolean).join(' and ')} calibration` : ''}.`, 'success', { action: { label: 'Undo', run: () => useStore.getState().undo() } });
  };
  const chosen = res ? res.groups.filter((_, i) => pick[i]) : [];
  const makeGroups = () => {
    if (!chosen.length) return;
    let made = 0;
    st.update((w) => {
      for (const g of chosen) {
        const ex = w.groups.find((x) => x.name === g.name);
        if (ex) ex.sampleIds = [...g.sampleIds];
        else {
          w.groups.push({ id: uid('grp'), name: g.name, color: GROUP_COLORS[w.groups.length % GROUP_COLORS.length], sampleIds: [...g.sampleIds] });
          made++;
        }
      }
    });
    st.toast(`${chosen.length} group${chosen.length > 1 ? 's' : ''} (${made} new). Use them in charts, tables and gate scopes.`, 'success', { action: { label: 'Undo', run: () => useStore.getState().undo() } });
  };
  const onPlates = chosen.some((g) => g.sampleIds.some((id) => { const s = ws.samples.find((x) => x.id === id); return !!(s?.plate && s.well); }));
  const writeLayout = () => {
    const entries = chosen.flatMap((g) =>
      g.sampleIds.flatMap((id) => {
        const s = ws.samples.find((x) => x.id === id);
        return s?.plate && s.well ? [{ plate: s.plate, well: s.well, value: g.name }] : [];
      }),
    );
    annotateWellValues(entries, 'Condition');
    st.toast(`"Condition" set for ${entries.length} well${entries.length === 1 ? '' : 's'} (plate layout).`, 'success', { action: { label: 'Show plates', run: () => useStore.getState().setUI({ view: 'plate' }) } });
  };
  const doStep = (s: ExperimentReading['steps'][number]) => {
    const ui = useStore.getState().setUI;
    switch (s.action) {
      case 'setup':
        applySetup();
        break;
      case 'groups':
        makeGroups();
        break;
      case 'strategy':
        void openAi('strategy', null, s.goal ?? '');
        break;
      case 'size':
      case 'mesf':
        // a setup that hides this calibration shows it (without a setup every tool is shown already)
        if (st.ws.setup && !st.ws.setup[s.action])
          st.update((w) => {
            if (w.setup) w.setup = { ...w.setup, [s.action]: true };
          });
        ui({ view: 'calib', calibMode: s.action, ribbonTab: 'calib' });
        break;
      case 'compensation':
        ui({ view: 'comp', ribbonTab: 'comp' });
        break;
      case 'plates':
        ui({ view: 'plate', ribbonTab: 'tables' });
        break;
    }
  };
  const stepButton: Partial<Record<string, string>> = { setup: 'Apply', groups: 'Create groups', strategy: 'Gating strategy', size: 'Size calibration', mesf: 'MESF calibration', compensation: 'Compensation', plates: 'Plates' };
  if (!loaded) return <p className="ai-note">Load the FCS files of an experiment first.</p>;
  return (
    <>
      <p className="ai-note">
        Sends what the files say (instrument, channels, tube names, plates, event counts, acquisition times and per-sample medians), no events and no operator names. The AI describes the experiment and
        suggests groups and next steps; nothing changes until you apply it.
      </p>
      <label className="ai-check" title="The names typed at the cytometer tell the AI most about the samples. Off: only words such as unstained, beads or PBS are sent.">
        <input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} /> Send tube names (without plate number and well)
      </label>
      {req && <Sent prompt={req.prompt} provider={provider} />}
      <div className="ai-row">
        <button className="btn primary" disabled={!req || job.busy || !provider} onClick={ask}>
          {res ? 'Ask again' : 'Describe this experiment'}
        </button>
      </div>
      <Busy busy={job.busy} err={job.err} stop={job.stop} />
      {res && (
        <>
          {res.summary && <p>{res.summary}</p>}
          {res.setup && (
            <div className="ai-card">
              <div className="ai-row">
                <b className="grow">
                  {res.setup.kind === 'nanoscale' ? 'Nanoscale' : 'Conventional'} experiment
                  {res.setup.mesf || res.setup.size ? `, ${[res.setup.mesf && 'MESF', res.setup.size && 'size'].filter(Boolean).join(' and ')} calibration` : ', no calibration'}
                </b>
                <button className="btn xs" onClick={applySetup}>
                  Apply
                </button>
              </div>
              {res.calibWhy && <span className="ai-note">{res.calibWhy}</span>}
            </div>
          )}
          {res.groups.length > 0 && (
            <div className="ai-card">
              <b>Groups</b>
              {res.groups.map((g, i) => (
                <label key={i} className="ai-check" title={g.sampleIds.map(label).join(', ')}>
                  <input type="checkbox" checked={!!pick[i]} onChange={(e) => setPick((p) => p.map((x, k) => (k === i ? e.target.checked : x)))} />
                  <span>
                    {g.name} <span className="ai-note">({g.role}, {g.sampleIds.length} sample{g.sampleIds.length === 1 ? '' : 's'})</span>
                  </span>
                </label>
              ))}
              <div className="ai-row">
                <button className="btn xs" disabled={!chosen.length} onClick={makeGroups}>
                  Create {chosen.length === 1 ? '1 group' : `${chosen.length} groups`}
                </button>
                {onPlates && (
                  <button className="btn xs" disabled={!chosen.length} onClick={writeLayout} title='Write the group names into the plate layout (key "Condition")'>
                    Into plate layout
                  </button>
                )}
              </div>
            </div>
          )}
          {res.steps.length > 0 && (
            <div className="ai-card">
              <b>Next steps</b>
              <ol className="ai-list">
                {res.steps.map((s, i) => (
                  <li key={i}>
                    <div className="ai-row">
                      <span className="grow">{s.title}</span>
                      {stepButton[s.action] && (
                        <button className="btn xs" onClick={() => doStep(s)}>
                          {stepButton[s.action]}
                        </button>
                      )}
                    </div>
                    {s.detail && <span className="ai-note">{s.detail}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {res.questions.length > 0 && (
            <div className="ai-card">
              <b>Open questions</b>
              <ul className="ai-list">
                {res.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="ai-note">Suggestions from the AI: check them against what you did.</p>
        </>
      )}
    </>
  );
}
