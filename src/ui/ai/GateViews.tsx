// "Gate with AI" and the AI gating strategy (proposal, editable checklist, step-by-step run).
import { useEffect, useMemo, useRef, useState } from 'react';
import { allChannels, popById, type PlotItem, type Workspace } from '../../core/model';
import { askAiGate, prepareAiGate, previewAiGate, TARGETS, type GateOutcome, type GatePrep } from '../../ai/gate';
import { AiError, aiErrorMessage, completeJson, type AiProvider } from '../../ai/provider';
import { parseStrategy, runStrategy, strategyRequest, type StrategyStep } from '../../ai/strategy';
import { chan, popName } from '../../ai/context';
import { useStore } from '../../state/store';
import type { AutoPreviewHandle } from '../gateOps';
import { Busy, imagesOn, prepCurrent, sameInputs, Sent, useAiPanel, useJob, usePrivacy } from './shared';

const plotLabel = (ws: Workspace, p: PlotItem, i: number) =>
  `${i + 1}. ${p.plotType === 'histogram' ? chan(ws, p.xParam) : `${chan(ws, p.xParam)} / ${chan(ws, p.yParam)}`} · ${popName(ws, p.layers.find((l) => l.visible !== false)?.population ?? 'root')}`;

/** keeps the latest prepared request; revokes the image URL of the one it replaces */
function usePrep() {
  const [prep, setPrepState] = useState<GatePrep | null>(null);
  const cur = useRef<GatePrep | null>(null);
  const setPrep = (p: GatePrep | null) => {
    if (cur.current?.image && cur.current !== p) URL.revokeObjectURL(cur.current.image.url);
    cur.current = p;
    setPrepState(p);
  };
  useEffect(() => () => setPrep(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  return [prep, setPrep] as const;
}

export function GateView({ provider }: { provider: AiProvider | null }) {
  const ws = useStore((s) => s.ws);
  const sheetId = useStore((s) => s.ui.activeSheetId);
  const sel = useStore((s) => s.ui.selectedItemIds);
  const sampleId = useStore((s) => s.ui.activeSampleId);
  const sheet = ws.worksheets.find((w) => w.id === sheetId) ?? ws.worksheets[0];
  const plots = sheet.items.filter((i): i is PlotItem => i.kind === 'plot');
  const asked = useAiPanel((s) => s.itemId);
  const [itemId, setItemId] = useState(() => [asked, ...sel].find((id) => plots.some((p) => p.id === id)) ?? plots[0]?.id ?? '');
  const [target, setTarget] = useState('');
  const [prep, setPrep] = usePrep();
  const [res, setRes] = useState<{ out: GateOutcome; status: string } | null>(null);
  const job = useJob();
  // a plot selected on the sheet becomes the plot to gate
  useEffect(() => {
    const s = sel.find((id) => plots.some((p) => p.id === id));
    if (s && !job.busy) setItemId(s);
  }, [sel.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = plots.some((p) => p.id === itemId);
  const { anonymize, allowImages } = usePrivacy();
  // what will be sent, rebuilt locally when the plot, target, data or privacy settings change (also once a request
  // that ran meanwhile is done)
  const inputs = [itemId, target, sampleId, ws, provider, valid, anonymize, allowImages];
  const built = useRef<unknown[] | null>(null);
  useEffect(() => {
    if (!valid || !target.trim() || job.busy || sameInputs(built.current, inputs)) return;
    let alive = true;
    const t = window.setTimeout(() => {
      prepareAiGate(itemId, target, imagesOn(provider)).then(
        (p) => {
          if (!alive) return p.image && URL.revokeObjectURL(p.image.url);
          built.current = inputs;
          setPrep(p);
          job.setErr('');
        },
        (e) => alive && (setPrep(null), job.setErr(aiErrorMessage(e))),
      );
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [...inputs, job.busy]); // eslint-disable-line react-hooks/exhaustive-deps
  // a request built with other privacy settings is never sent (the new one follows in a moment)
  const ready = !!prep && prep.itemId === itemId && prep.target === target.trim() && prepCurrent(prep, provider);

  const send = (fresh: boolean) =>
    job.run(async (signal) => {
      if (!prep || !provider) return;
      setRes(null);
      useStore.getState().setUI({ view: 'sheet' });
      const out = await askAiGate(prep, provider, signal, fresh);
      if (!out.choice.seed) return setRes({ out, status: out.choice.note });
      const h = await previewAiGate(prep, out, (popId) =>
        setRes((r) => (r?.out === out ? { out, status: popId ? `Gate "${popById(useStore.getState().ws, popId)?.name}" created (Undo removes it).` : 'No gate created.' } : r)),
      );
      setRes({ out, status: h === 'none' ? 'The auto gate found no population at this position.' : h ? 'Preview on the plot: adjust the tightness there, then OK (Enter) or Cancel (Esc).' : 'Open the sheet with this plot to see the preview.' });
    });

  const a = res?.out.answer;
  return (
    <>
      {!plots.length ? (
        <p className="ai-note">This worksheet has no plots. Add a plot first.</p>
      ) : (
        <label className="ai-l">
          Plot
          <select className="sel" value={valid ? itemId : ''} onChange={(e) => setItemId(e.target.value)}>
            {plots.map((p, i) => (
              <option key={p.id} value={p.id}>
                {plotLabel(ws, p, i)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="ai-l">
        Population to gate
        <input className="inp" list="ai-targets" value={target} placeholder="e.g. lymphocytes, singlets, live cells, CD4+ T cells" onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ready && !job.busy && send(false)} />
        <datalist id="ai-targets">
          {TARGETS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>
      {ready && <Sent prompt={prep!.prompt} images={prep!.image ? [prep!.image.url] : []} provider={provider} />}
      <div className="ai-row">
        <button className="btn primary" disabled={!ready || job.busy || !provider} onClick={() => send(false)}>
          Send to AI
        </button>
        {res && (
          <button className="btn" disabled={!ready || job.busy} onClick={() => send(true)} title="Ask again (not from the cache)">
            Ask again
          </button>
        )}
      </div>
      <Busy busy={job.busy} err={job.err} stop={job.stop} />
      {res && a && (
        <div className="ai-card" aria-live="polite">
          <b>
            {a.found === false ? 'Not found' : res.out.name}
            {typeof a.confidence === 'number' ? ` · confidence ${Math.round(a.confidence * 100)}%` : ''}
          </b>
          {typeof a.rationale === 'string' && <span>{a.rationale.slice(0, 500)}</span>}
          <span className="ai-note">{res.status}</span>
        </div>
      )}
      <p className="ai-note">
        The AI only points at the population. The boundary is drawn by FlowState's auto gate from the event density, so the gate is reproducible; the gate records that it was seeded by AI (badge "AI" on the plot).
      </p>
    </>
  );
}

// ------------------------------------------------------------------ strategy

export function StrategyView({ provider }: { provider: AiProvider | null }) {
  const ws = useStore((s) => s.ws);
  const sampleId = useStore((s) => s.ui.activeSampleId);
  const [goal, setGoal] = useState(() => useAiPanel.getState().seed);
  const [steps, setSteps] = useState<StrategyStep[]>([]);
  const [notes, setNotes] = useState('');
  const [phase, setPhase] = useState<'propose' | 'edit' | 'run' | 'done'>('propose');
  const [prep, setPrep] = usePrep();
  const [deciding, setDeciding] = useState(false);
  const handle = useRef<AutoPreviewHandle | null>(null);
  const acceptAll = useRef(false);
  const job = useJob();
  const { anonymize } = usePrivacy();
  // anonymize: strategyRequest reads the setting; listed so the text follows it while the panel is open
  const prompt = useMemo(() => strategyRequest(ws, sampleId, goal), [ws, sampleId, goal, anonymize]); // eslint-disable-line react-hooks/exhaustive-deps
  const chans = useMemo(() => allChannels(ws).map((c) => c.name), [ws]);

  const propose = () =>
    job.run(async (signal) => {
      if (!provider) return;
      const { value } = await completeJson(provider, { prompt, tier: 'default', signal, maxTokens: 2500, fresh: true });
      const r = parseStrategy(useStore.getState().ws, value);
      if (!r.steps.length) throw new AiError('invalid_json', 'no steps');
      setSteps(r.steps);
      setNotes(r.notes);
      setPhase('edit');
    });

  const up = (id: string, patch: Partial<StrategyStep>) => setSteps((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const run = () => {
    if (!provider) return;
    acceptAll.current = false;
    setSteps((ss) => ss.map((s) => ({ ...s, status: s.on ? 'waiting' : undefined, note: s.on ? undefined : s.note })));
    setPhase('run');
    void job
      .run(async (signal) => {
        await runStrategy(
          steps.filter((s) => s.on),
          {
            provider,
            // asked per step: "Allow sending plot images" may change during the run
            images: () => imagesOn(provider),
            signal,
            update: up,
            setHandle: (h) => {
              handle.current = h;
              setDeciding(!!h);
            },
            setPrep,
            acceptAll: () => acceptAll.current,
          },
        );
      })
      .finally(() => setPhase('done'));
  };

  if (phase === 'propose')
    return (
      <>
        <label className="ai-l">
          What do you want to analyse? (optional)
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. CD4 and CD8 T cells and their activation (CD69)" />
        </label>
        <Sent prompt={prompt} provider={provider} />
        <div className="ai-row">
          <button className="btn primary" disabled={job.busy || !provider} onClick={propose}>
            Propose a strategy
          </button>
        </div>
        <Busy busy={job.busy} err={job.err} stop={job.stop} />
        <p className="ai-note">The proposal is made from the channel names, marker labels and sample hints only (no images). You can edit it before anything is gated.</p>
      </>
    );

  const parents = (i: number) => ['All events', ...steps.slice(0, i).map((s) => s.name), ...ws.populations.map((p) => p.name)].filter((v, k, a) => a.indexOf(v) === k);
  const editing = phase === 'edit';
  return (
    <>
      {notes && editing && <p className="ai-note">{notes}</p>}
      <div className="ai-steps">
        {steps.map((s, i) => (
          <div key={s.id} className={`ai-step${s.on ? '' : ' off'}`}>
            <input type="checkbox" checked={s.on} disabled={!editing} aria-label={`Include ${s.name}`} onChange={(e) => up(s.id, { on: e.target.checked })} />
            {editing ? <input className="inp" value={s.name} aria-label="Population name" onChange={(e) => up(s.id, { name: e.target.value })} /> : <b>{s.name}</b>}
            {editing ? (
              <button className="icon-btn" aria-label={`Remove ${s.name}`} title="Remove step" onClick={() => setSteps((ss) => ss.filter((x) => x.id !== s.id))}>
                ×
              </button>
            ) : (
              <span className={`ai-st ${s.status ?? ''}`}>{s.status ?? 'off'}</span>
            )}
            {editing ? (
              <>
                <div className="ai-axes">
                  <select className="sel" aria-label="Parent" value={s.parent} onChange={(e) => up(s.id, { parent: e.target.value })}>
                    {[s.parent, ...parents(i)].filter((v, k, a) => a.indexOf(v) === k).map((p) => (
                      <option key={p} value={p}>
                        in {p}
                      </option>
                    ))}
                  </select>
                  <select className="sel" aria-label="Plot type" value={s.plot} onChange={(e) => up(s.id, { plot: e.target.value as StrategyStep['plot'] })}>
                    <option value="2d">2D</option>
                    <option value="histogram">Histogram</option>
                  </select>
                </div>
                <div className="ai-axes">
                  {(['x', 'y'] as const).map((ax) =>
                    ax === 'y' && s.plot === 'histogram' ? null : (
                      <select key={ax} className="sel" aria-label={`${ax.toUpperCase()} channel`} value={s[ax]} onChange={(e) => up(s.id, { [ax]: e.target.value, on: true, note: undefined })}>
                        {!s[ax] && <option value="">{ax.toUpperCase()}: choose</option>}
                        {chans.map((c) => (
                          <option key={c} value={c}>
                            {ax.toUpperCase()}: {chan(ws, c)}
                          </option>
                        ))}
                      </select>
                    ),
                  )}
                </div>
                <input className="inp full" value={s.target} aria-label="What to gate" placeholder="What to gate on this plot" onChange={(e) => up(s.id, { target: e.target.value })} />
              </>
            ) : (
              <span className="ai-note full">
                in {s.parent} · {s.plot === 'histogram' ? chan(ws, s.x) : `${chan(ws, s.x)} / ${chan(ws, s.y)}`}
              </span>
            )}
            {s.note && <span className="ai-note full">{s.note}</span>}
          </div>
        ))}
      </div>
      {editing && (
        <>
          <p className="ai-note">
            Run makes a new worksheet "AI gating". For each step it adds the plot, sends that plot's image and a request like "Gate with AI" to {provider?.label ?? 'the AI'}, and shows the auto gate preview: accept, adjust (tightness) or skip it. One Undo removes the whole run.
          </p>
          <div className="ai-row">
            <button className="btn primary" disabled={!steps.some((s) => s.on && s.x && (s.plot === 'histogram' || s.y)) || !provider} onClick={run}>
              Run
            </button>
            <button className="btn" onClick={() => setPhase('propose')}>
              Back
            </button>
          </div>
        </>
      )}
      {phase === 'run' && (
        <div className="ai-row" data-ag-keep="">
          <button className="btn primary" disabled={!deciding} onClick={() => handle.current?.ok()} title="Create this gate">
            Accept
          </button>
          <button className="btn" disabled={!deciding} onClick={() => handle.current?.cancel()} title="No gate for this step">
            Skip
          </button>
          <button
            className="btn"
            onClick={() => {
              acceptAll.current = true;
              handle.current?.ok();
            }}
            title="Accept this and every following gate as the auto gate finds it"
          >
            Accept all
          </button>
          <span className="grow" />
          <button className="btn" onClick={job.stop}>
            Stop
          </button>
        </div>
      )}
      {phase === 'run' && <p className="ai-note">{deciding ? 'Adjust the tightness under the plot if needed, then Accept (or OK there).' : 'Asking the AI…'}</p>}
      {phase === 'run' && prep && <Sent prompt={prep.prompt} images={prep.image ? [prep.image.url] : []} provider={provider} />}
      {job.err && <p className="ai-err">{job.err}</p>}
      {phase === 'done' && (
        <div className="ai-row">
          <span className="grow ai-note">{steps.filter((s) => s.status === 'done').length} gates created.</span>
          <button className="btn" onClick={() => setPhase('edit')}>
            Back to the list
          </button>
        </div>
      )}
    </>
  );
}
