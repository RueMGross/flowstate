// "Analyze new files": choose the files (those not analyzed yet are ticked), say what you want to know, get a plan,
// tick off / comment on its groups, gates, figures and tables, have it revised, then let the AI carry it out.
import { useMemo, useRef, useState } from 'react';
import { analyzedSampleIds, DISCLAIMER, newSampleIds, outputDesc, parsePlan, planRequest, runAnalysis, type AnalysisPlan, type AnalysisResult } from '../../ai/analysis';
import { anon, chan } from '../../ai/context';
import type { GatePrep } from '../../ai/gate';
import { completeJson, type AiProvider } from '../../ai/provider';
import type { StrategyStep } from '../../ai/strategy';
import { engine } from '../../core/engine';
import { readProtocolFile, type Protocol } from '../../io/protocol';
import { useStore } from '../../state/store';
import { Busy, imagesOn, Sent, useJob, usePrivacy } from './shared';

type Phase = 'scope' | 'review' | 'run' | 'done';

function Note({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(!!value);
  if (!open)
    return (
      <button className="btn xs ai-note-btn" disabled={disabled} onClick={() => setOpen(true)} title="Say what should be done differently">
        Note
      </button>
    );
  return <input className="inp full" value={value} autoFocus={!value} disabled={disabled} placeholder="What should be different?" onChange={(e) => onChange(e.target.value)} />;
}

export function AnalysisView({ provider }: { provider: AiProvider | null }) {
  const ws = useStore((s) => s.ws);
  const { anonymize } = usePrivacy();
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  const [pick, setPick] = useState<Set<string>>(() => new Set(newSampleIds(useStore.getState().ws)));
  const done = useMemo(() => analyzedSampleIds(ws), [ws]);
  const [goal, setGoal] = useState('');
  const [protocol, setProtocol] = useState<Protocol | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [namesFor, setNamesFor] = useState(() => ({ hidden: anon(), names: !anon() }));
  const names = namesFor.hidden === anonymize ? namesFor.names : !anonymize;
  const [phase, setPhase] = useState<Phase>('scope');
  const [plan, setPlan] = useState<AnalysisPlan | null>(null);
  const [planIds, setPlanIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState('');
  const [prep, setPrep] = useState<GatePrep | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const job = useJob();
  const ids = loaded.filter((s) => pick.has(s.id)).map((s) => s.id);
  const req = useMemo(() => (ids.length ? planRequest(ws, ids, { names, goal, protocol }) : null), [ids.join(','), names, goal, protocol, anonymize, ws.populations, ws.samples]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = (feedback?: boolean) =>
    job.run(async (signal) => {
      if (!provider) return;
      const r = planRequest(useStore.getState().ws, ids, { names, goal, protocol, feedback: feedback && plan ? { plan, notes } : undefined });
      const { value } = await completeJson(provider, { prompt: r.prompt, tier: 'complex', signal, maxTokens: 16000, fresh: true });
      setPlan(parsePlan(useStore.getState().ws, r, value));
      setPlanIds(r.ids);
      if (feedback) setNotes('');
      setPhase('review');
    });

  const upPlan = (f: (p: AnalysisPlan) => AnalysisPlan) => setPlan((p) => (p ? f(p) : p));
  const upStep = (id: string, patch: Partial<StrategyStep>) => upPlan((p) => ({ ...p, gating: p.gating.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const run = () =>
    plan &&
    job.run(async (signal) => {
      setPhase('run');
      try {
        const r = await runAnalysis(plan, planIds, {
          provider: provider!,
          images: () => imagesOn(provider),
          signal,
          setHandle: () => {},
          setPrep,
          status: setStatus,
          step: upStep,
          names,
          protocol,
        });
        setResult(r);
      } finally {
        setPrep(null);
        setPhase('done');
      }
    });

  if (!loaded.length) return <p className="ai-note">Load the FCS files of an experiment first (drop them on the window).</p>;
  const st = useStore.getState();

  if (phase === 'scope') {
    const fresh = loaded.filter((s) => !done.has(s.id)).length;
    return (
      <>
        <p className="ai-note">
          The AI reads the files (instrument, channels, tube names, event counts and per-sample medians, no events), proposes groups, the gates still missing, figures and tables. You check the plan and say what should be different; then it gates, builds the figures and tables and drafts the results.
        </p>
        <div className="ai-card">
          <div className="ai-row">
            <b className="grow">
              Files: {ids.length} of {loaded.length}
            </b>
            <button className="btn xs" onClick={() => setPick(new Set(loaded.filter((s) => !done.has(s.id)).map((s) => s.id)))} title="Files not on any worksheet, chart or group yet">
              New ({fresh})
            </button>
            <button className="btn xs" onClick={() => setPick(new Set(loaded.map((s) => s.id)))}>
              All
            </button>
            <button className="btn xs" onClick={() => setPick(new Set())}>
              None
            </button>
          </div>
          {!fresh && <span className="ai-note">Every loaded file is on a sheet, chart or group already: tick the ones to analyze again.</span>}
          <div className="ai-files">
            {loaded.map((s) => (
              <label key={s.id} className="ai-check" title={s.fileName}>
                <input type="checkbox" checked={pick.has(s.id)} onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} />
                <span className="ai-fname">{s.name}</span>
                {done.has(s.id) && <span className="ai-note">analyzed</span>}
              </label>
            ))}
          </div>
        </div>
        <label className="ai-l">
          What do you want to find out? (optional)
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. CD69 activation of CD4 and CD8 T cells after stimulation vs unstimulated" />
        </label>
        <div className="ai-row">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xlsm,.docx,.csv,.tsv,.txt,.md"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f)
                readProtocolFile(f)
                  .then(setProtocol)
                  .catch((err: Error) => st.toast(err.message, 'error', { duration: 9000 }));
            }}
          />
          <button className="btn sm" onClick={() => fileRef.current?.click()} title="Your protocol (Excel, Word, CSV or text): plate layout, samples, conditions and experimental details. Read in this browser and sent with the plan and results requests, so the AI knows which well or tube is which condition and what the experiment expects">
            {protocol ? 'Other protocol…' : 'Attach protocol…'}
          </button>
          {protocol ? (
            <>
              <span className="grow ai-fname" title={protocol.name}>
                {protocol.name} <span className="ai-note">({protocol.text.length.toLocaleString('en-US')} characters{protocol.truncated ? ', shortened' : ''})</span>
              </span>
              <button className="icon-btn" aria-label="Remove the protocol" title="Remove" onClick={() => setProtocol(null)}>
                ×
              </button>
            </>
          ) : (
            <span className="grow ai-note">plate layout, conditions, experimental details (xlsx, docx, csv, txt)</span>
          )}
        </div>
        <label className="ai-check" title="The names typed at the cytometer tell the AI most about the samples. Off: only words such as unstained, beads or PBS are sent.">
          <input type="checkbox" checked={names} onChange={(e) => setNamesFor({ hidden: anonymize, names: e.target.checked })} /> Send tube names
        </label>
        {!names && <span className="ai-note">Tip: with the tube names the AI can tell controls, conditions and replicates apart; without them it guesses from the numbers.</span>}
        {req && <Sent prompt={req.prompt} provider={provider} />}
        <div className="ai-row">
          <button className="btn primary" disabled={!ids.length || job.busy || !provider} onClick={() => ask()}>
            Make a plan
          </button>
        </div>
        <Busy busy={job.busy} err={job.err} stop={job.stop} label="Planning the analysis…" />
      </>
    );
  }

  if (!plan) return null;
  const editing = phase === 'review';
  const commented = plan.gating.some((s) => s.remark?.trim() || !s.on) || plan.outputs.some((o) => o.note?.trim() && !o.note.startsWith('Off:')) || plan.outputs.some((o) => !o.on) || plan.groups.some((g) => !g.on) || !!notes.trim();
  const label = (id: string) => ws.samples.find((s) => s.id === id)?.name ?? '?';
  const progress = (
    <>
      {phase === 'run' && (
        <>
          <div className="ai-row" role="status">
            <span className="grow ai-note">{status || 'Starting…'}</span>
            <button className="btn sm" onClick={job.stop}>
              Stop
            </button>
          </div>
          {prep && <Sent prompt={prep.prompt} images={prep.image ? [prep.image.url] : []} provider={provider} />}
        </>
      )}
      {phase === 'done' && (
        <>
          {job.err && <p className="ai-err">{job.err}</p>}
          {result && (
            <div className="ai-card">
              <b>Done</b>
              <span>
                {result.gates} gate{result.gates === 1 ? '' : 's'}, {result.sheets.length} sheet{result.sheets.length === 1 ? '' : 's'}, {result.tables.length} table{result.tables.length === 1 ? '' : 's'}.
              </span>
              <div className="ai-row">
                {result.sheets.map((n) => (
                  <button key={n} className="btn xs" onClick={() => { const sh = useStore.getState().ws.worksheets.find((w) => w.name === n); if (sh) st.setUI({ view: 'sheet', activeSheetId: sh.id }); }}>
                    {n}
                  </button>
                ))}
                {result.tables.length > 0 && (
                  <button className="btn xs" onClick={() => { const t = useStore.getState().ws.tables.find((x) => x.name === result.tables[0]); st.setUI({ view: 'tables', ...(t ? { activeTableId: t.id } : {}) }); }}>
                    Tables
                  </button>
                )}
              </div>
              {result.skipped.length > 0 && (
                <ul className="ai-list ai-note">
                  {result.skipped.map((x, i) => (
                    <li key={i}>Not made: {x}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {result?.results && (
            <div className="ai-card">
              <b>Results (AI draft)</b>
              {result.results.headline && <span>{result.results.headline}</span>}
              <ul className="ai-list">
                {result.results.findings.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              {result.results.caveats.length > 0 && (
                <>
                  <b>Check</b>
                  <ul className="ai-list">
                    {result.results.caveats.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          <div className="ai-disclaimer" role="note">
            {DISCLAIMER} One Undo (Ctrl+Z) removes the whole analysis.
          </div>
          <div className="ai-row">
            <button className="btn" onClick={() => setPhase('review')}>
              Back to the plan
            </button>
            <button className="btn" onClick={() => { setPlan(null); setResult(null); setPick(new Set(newSampleIds(useStore.getState().ws))); setPhase('scope'); }}>
              New analysis
            </button>
          </div>
        </>
      )}
    </>
  );
  const planBody = (
    <>
      {plan.summary && <p>{plan.summary}</p>}
      {plan.gatingSample && <span className="ai-note">Gates are placed on: {label(plan.gatingSample)}</span>}
      {plan.groups.length > 0 && (
        <div className="ai-card">
          <b>Groups</b>
          {plan.groups.map((g) => (
            <label key={g.id} className="ai-check" title={g.sampleIds.map(label).join(', ')}>
              <input type="checkbox" checked={g.on} disabled={!editing} onChange={(e) => upPlan((p) => ({ ...p, groups: p.groups.map((x) => (x.id === g.id ? { ...x, on: e.target.checked } : x)) }))} />
              <span>
                {g.name} <span className="ai-note">({g.role}, {g.sampleIds.length})</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="ai-card">
        <b>Gating {plan.gating.length ? `(${plan.gating.filter((s) => s.on).length} step${plan.gating.filter((s) => s.on).length === 1 ? '' : 's'})` : ''}</b>
        {!plan.gating.length && <span className="ai-note">No new gates: the existing ones are used.</span>}
        {plan.gating.map((s) => (
          <div key={s.id} className={`ai-step${s.on ? '' : ' off'}`}>
            <input type="checkbox" checked={s.on} disabled={!editing} aria-label={`Include ${s.name}`} onChange={(e) => upStep(s.id, { on: e.target.checked })} />
            <b>{s.name}</b>
            {s.status ? <span className={`ai-st ${s.status}`}>{s.status}</span> : <span />}
            <span className="ai-note full">
              in {s.parent} · {s.plot === 'histogram' ? chan(ws, s.x) : `${chan(ws, s.x)} / ${chan(ws, s.y)}`} · {s.target}
            </span>
            {s.note && <span className="ai-note full">{s.note}</span>}
            {editing && (
              <span className="full">
                <Note value={s.remark ?? ''} onChange={(v) => upStep(s.id, { remark: v })} />
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="ai-card">
        <b>Figures and tables</b>
        {plan.outputs.map((o) => (
          <div key={o.id} className={`ai-step${o.on ? '' : ' off'}`}>
            <input type="checkbox" checked={o.on} disabled={!editing} aria-label={`Include ${o.title}`} onChange={(e) => upPlan((p) => ({ ...p, outputs: p.outputs.map((x) => (x.id === o.id ? { ...x, on: e.target.checked } : x)) }))} />
            <b>{o.title}</b>
            <span className="ai-st">{o.kind}</span>
            <span className="ai-note full">{outputDesc(ws, o)}</span>
            {o.why && <span className="ai-note full">{o.why}</span>}
            {editing && (
              <span className="full">
                {o.note?.startsWith('Off:') ? <span className="ai-note">{o.note}</span> : <Note value={o.note ?? ''} onChange={(v) => upPlan((p) => ({ ...p, outputs: p.outputs.map((x) => (x.id === o.id ? { ...x, note: v } : x)) }))} />}
              </span>
            )}
          </div>
        ))}
      </div>
      {(plan.assumptions.length > 0 || plan.questions.length > 0) && (
        <div className="ai-card">
          {plan.assumptions.length > 0 && (
            <>
              <b>Assumptions</b>
              <ul className="ai-list">
                {plan.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {plan.questions.length > 0 && (
            <>
              <b>Questions (answer them in the notes)</b>
              <ul className="ai-list">
                {plan.questions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {editing && (
        <>
          <label className="ai-l">
            Notes for the AI (what to change, answers to its questions)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. S5 and S6 are the unstimulated controls; also show CD25 on CD4 T cells" />
          </label>
          <div className="ai-disclaimer" role="note">
            {DISCLAIMER}
          </div>
          <div className="ai-row">
            <button className="btn primary" disabled={job.busy || !provider} onClick={run} title="Create the groups, gates, figures and tables, then draft the results (one Undo removes it all)">
              Run analysis
            </button>
            <button className="btn" disabled={job.busy || !commented || !provider} onClick={() => ask(true)} title="Send your ticks and notes back; the AI revises the plan">
              Revise plan
            </button>
            <span className="grow" />
            <button className="btn" disabled={job.busy} onClick={() => setPhase('scope')}>
              Back
            </button>
          </div>
          <Busy busy={job.busy} err={job.err} stop={job.stop} label="Revising the plan…" />
        </>
      )}
    </>
  );
  return (
    <>
      {progress}
      {editing ? (
        planBody
      ) : (
        <details className="ai-plan" open={phase === 'run'}>
          <summary>The plan</summary>
          {planBody}
        </details>
      )}
    </>
  );
}
