// "How do I …?": ask about FlowState in your own words; the answer comes as steps with "Show me", which opens the ribbon
// tab and rings the button (or panel) the step uses. Only the question and the open view are sent, never data.
import { useEffect, useMemo, useState } from 'react';
import { HELP_EXAMPLES, helpPrompt, parseHelp, type HelpAnswer } from '../../ai/manual';
import { completeJson, type AiProvider } from '../../ai/provider';
import { useStore } from '../../state/store';
import { Busy, Sent, useAiPanel, useJob } from './shared';
import { clearSpotlight, showTarget } from './spotlight';

/** Where the user is (no names, no data): the view, the ribbon tab, how much is loaded. */
function whereNow(): string {
  const { ws, ui } = useStore.getState();
  const loaded = ws.samples.length;
  return `the ${ui.view} view, ribbon tab "${ui.ribbonTab}"; ${loaded ? `${loaded} sample${loaded === 1 ? '' : 's'} loaded` : 'no samples loaded yet'}, ${ws.populations.length} gates, ${ws.groups.length} groups, ${ws.tables.length} tables`;
}

export function HelpView({ provider }: { provider: AiProvider | null }) {
  const seed = useAiPanel((s) => s.seed);
  const [q, setQ] = useState(seed);
  const [asked, setAsked] = useState<{ q: string; a: HelpAnswer }[]>([]);
  const job = useJob();
  const prompt = useMemo(() => (q.trim() ? helpPrompt(q, whereNow()) : ''), [q]);
  useEffect(() => clearSpotlight, []);
  const ask = (text = q) =>
    job.run(async (signal) => {
      if (!provider || !text.trim()) return;
      const { value } = await completeJson(provider, { prompt: helpPrompt(text, whereNow()), tier: 'quick', signal, maxTokens: 4000 });
      const a = parseHelp(value);
      setAsked((h) => [{ q: text.trim(), a }, ...h].slice(0, 6));
      setQ('');
      // the first step that points at something is shown right away
      const first = a.steps.find((s) => s.show);
      if (first?.show) void showTarget(first.show, first.text);
    });
  return (
    <>
      <label className="ai-l">
        How do I …
        <textarea
          value={q}
          rows={2}
          style={{ minHeight: 44 }}
          placeholder="e.g. make a histogram overlay of two samples"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (q.trim() && !job.busy) void ask();
            }
          }}
        />
      </label>
      <div className="ai-row">
        <button className="btn primary" disabled={!q.trim() || job.busy || !provider} onClick={() => void ask()}>
          Ask
        </button>
        <span className="grow ai-note">Sends only your question and which view is open, no data.</span>
      </div>
      {prompt && (
        <details className="ai-note">
          <summary>What is sent</summary>
          <Sent prompt={prompt} provider={provider} />
        </details>
      )}
      <Busy busy={job.busy} err={job.err} stop={job.stop} />
      {!asked.length && !job.busy && (
        <div className="ai-chips">
          {HELP_EXAMPLES.map((x) => (
            <button key={x} className="chip" disabled={!provider} onClick={() => void ask(x)}>
              {x}
            </button>
          ))}
        </div>
      )}
      {asked.map(({ q: question, a }, k) => (
        <div key={k + question} className="ai-card">
          <b>{question}</b>
          {a.answer && <span>{a.answer}</span>}
          {a.steps.length > 0 && (
            <ol className="ai-list">
              {a.steps.map((s, i) => (
                <li key={i}>
                  <div className="ai-row">
                    <span className="grow">{s.text}</span>
                    {s.show && (
                      <button className="btn xs" onClick={() => void showTarget(s.show!, s.text)} title="Open the tab and point at it">
                        Show me
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {a.tip && <span className="ai-note">Tip: {a.tip}</span>}
        </div>
      ))}
      {asked.length > 0 && <p className="ai-note">Answers come from the AI with FlowState's built-in manual; press ? for all keyboard shortcuts.</p>}
    </>
  );
}
