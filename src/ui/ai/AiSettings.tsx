// "AI assistant settings": provider, key / proxy, model, what may be sent, privacy statement and cost note.
import { useEffect, useState } from 'react';
import { AiError, aiErrorMessage, claudeHost, defaultModel, listModels, type ModelInfo } from '../../ai/provider';
import { useAiSettings, type ProviderChoice } from '../../ai/settings';
import { isHostedArtifact } from '../../io/files';
import { Check, Modal } from '../widgets';
import { AI_TITLES, openAi, useProvider, type AiView } from './shared';

const CHOICES: [ProviderChoice, string][] = [
  ['off', 'Off'],
  ['auto', 'Automatic'],
  ['claude', 'claude.ai'],
  ['apikey', 'API key'],
  ['proxy', 'Lab proxy'],
];

export function AiSettingsDialog({ payload, onClose }: { payload?: { reason?: AiView; itemId?: string | null }; onClose: () => void }) {
  const s = useAiSettings();
  const provider = useProvider();
  const hosted = isHostedArtifact();
  const [host, setHost] = useState<boolean | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [mErr, setMErr] = useState('');
  const [test, setTest] = useState('');
  useEffect(() => void claudeHost().then((h) => setHost(!!h)), []);
  const showKey = s.provider === 'apikey' || (s.provider === 'auto' && host === false);
  const showProxy = s.provider === 'proxy' || (s.provider === 'auto' && host === false);
  const listKind = s.provider === 'proxy' || (showProxy && !s.apiKey.trim() && s.proxyUrl.trim()) ? 'proxy' : showKey ? 'apikey' : null;
  // the model list once a key (or proxy URL) is entered
  useEffect(() => {
    setMErr('');
    if (!listKind || (listKind === 'apikey' ? s.apiKey.trim().length < 20 : !s.proxyUrl.trim())) return setModels([]);
    let alive = true;
    const t = window.setTimeout(() => {
      listModels(listKind).then(
        (m) => {
          if (!alive) return;
          setModels(m);
          const cur = useAiSettings.getState();
          if (!m.some((x) => x.id === cur.model)) cur.set({ model: listKind === 'proxy' && !m.length ? '' : defaultModel(m) });
        },
        (e) => alive && (setModels([]), setMErr(aiErrorMessage(e))),
      );
    }, 500);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [listKind, s.apiKey, s.proxyUrl, s.proxyPass]);

  const runTest = async () => {
    setTest('Testing…');
    try {
      if (!provider) throw new Error('No provider is set up yet.');
      const r = await provider.complete({ prompt: 'Reply with the single word OK.', tier: 'quick', maxTokens: 8, fresh: true });
      setTest(r.incomplete ? aiErrorMessage(new AiError('incomplete')) : `Connected: ${r.model} answered "${r.text.trim().slice(0, 20)}".`);
    } catch (e) {
      setTest(e instanceof Error && !('code' in e) ? e.message : aiErrorMessage(e));
    }
  };
  const done = () => {
    onClose();
    if (payload?.reason && provider) void openAi(payload.reason, payload.itemId);
  };

  return (
    <Modal
      title="AI assistant settings"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="ai-note" style={{ flex: 1 }} role="status">
            {test}
          </span>
          <button className="btn" disabled={!provider} onClick={() => void runTest()} title="Sends one tiny request">
            Test
          </button>
          <button className="btn primary" onClick={done}>
            {payload?.reason && provider ? `Continue to ${AI_TITLES[payload.reason]}` : 'Done'}
          </button>
        </>
      }
    >
      <div className="ai-set">
        {payload?.reason && !provider && <p className="ai-err" style={{ marginTop: 0 }}>{AI_TITLES[payload.reason]} needs the AI assistant: choose a provider below.</p>}
        <div className="ai-seg" role="group" aria-label="AI provider">
          {CHOICES.map(([v, l]) => (
            <button key={v} className="btn sm" aria-pressed={s.provider === v} onClick={() => s.set({ provider: v })}>
              {l}
            </button>
          ))}
        </div>
        <p className="ai-note" style={{ marginTop: 0 }}>
          {s.provider === 'off' && 'The AI features are off (default). Nothing is ever sent.'}
          {s.provider === 'auto' && 'claude.ai when FlowState runs inside claude.ai, otherwise the API key or the lab proxy entered below.'}
          {s.provider === 'claude' && (host === false ? 'Not available: this copy is not running inside claude.ai. Choose API key or Lab proxy instead.' : 'Requests use your own Claude account; claude.ai asks you once to allow it. No key needed.')}
          {s.provider === 'apikey' && 'Your Anthropic API key, sent from this browser directly to api.anthropic.com.'}
          {s.provider === 'proxy' && "Your lab's proxy server holds the key, so labmates do not need it (see server/ai-proxy in the source)."}
          {hosted && (showKey || showProxy) && ' Inside claude.ai other network access is blocked, so the API key and proxy only work in a standalone copy.'}
        </p>
        {/* "complete the fields below" only where there are fields (claude.ai has none: the line above says why) */}
        {s.provider !== 'off' && (provider || showKey || showProxy) && <p className="ai-note">Now: {provider ? <b>{provider.label}</b> : 'not available yet (complete the fields below).'}</p>}
        {showKey && (
          <label className="ai-l">
            Anthropic API key
            <div className="ai-row" style={{ flexWrap: 'nowrap' }}>
              <input className="inp" type="password" autoComplete="off" spellCheck={false} value={s.apiKey} placeholder="sk-ant-…" aria-label="Anthropic API key" onChange={(e) => s.set({ apiKey: e.target.value })} />
              <button className="btn sm" disabled={!s.apiKey && !s.proxyPass} onClick={s.forgetSecrets} title="Remove the key and passphrase from memory and from this device">
                Forget key
              </button>
            </div>
          </label>
        )}
        {showKey && (/^sk-ant-usr/.test(s.apiKey.trim()) || s.workspaceId) && (
          <label className="ai-l">
            Workspace ID (a personal key works in the workspace named here: wrkspc_..., on the workspace's page in the Anthropic Console)
            <input className="inp" spellCheck={false} value={s.workspaceId} placeholder="wrkspc_…" aria-label="Anthropic workspace ID" onChange={(e) => s.set({ workspaceId: e.target.value })} />
          </label>
        )}
        {showProxy && (
          <>
            <label className="ai-l">
              Lab proxy URL
              <input className="inp" value={s.proxyUrl} placeholder="https://ai-proxy.your-lab.example" spellCheck={false} onChange={(e) => s.set({ proxyUrl: e.target.value })} />
            </label>
            <label className="ai-l">
              Your personal code or the lab passphrase (if the proxy asks for one)
              <input className="inp" type="password" autoComplete="off" value={s.proxyPass} onChange={(e) => s.set({ proxyPass: e.target.value })} />
            </label>
          </>
        )}
        {(showKey || showProxy) && (
          <>
            <label className="ai-l">
              Model
              {models.length ? (
                <select className="sel" value={s.model} onChange={(e) => s.set({ model: e.target.value })}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="inp" value={s.model} spellCheck={false} placeholder={listKind === 'proxy' ? 'proxy default' : 'enter the key to load the list'} onChange={(e) => s.set({ model: e.target.value })} />
              )}
            </label>
            {mErr && <p className="ai-err">Model list: {mErr}</p>}
            <Check checked={s.remember} onChange={(v) => s.set({ remember: v })} label="Remember the key / passphrase on this device (unencrypted in this browser's storage)" />
          </>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          <Check checked={s.allowImages} onChange={(v) => s.set({ allowImages: v })} label="Allow sending plot images" />
          <Check checked={s.anonymize} onChange={(v) => s.set({ anonymize: v })} label="Hide sample and file names from the AI (Sample 1, 2, …)" />
        </div>
        <div className="ai-priv">
          <p>
            <b>Privacy.</b> Something is sent only when you start an AI action, and each action shows exactly what it sends first: plot images (if allowed), channel names and marker labels (with the files' stain names, $PnS), gate names,
            event counts and statistics, compensation and calibration settings, sample names (hidden: "Sample 1, 2, …" with words such as "unstained" or "FMO") and text you type. From the FCS keywords also the instrument ($CYT) and, for
            Methods, the FCS version. AI auto-analysis adds per-sample medians and 95th percentiles, acquisition durations (from $BTIM and $ETIM), plates and wells, whether a spillover matrix is stored, and tube names if you tick them. Never the
            event data themselves, the FCS files or their other keywords.
          </p>
          <p>
            Requests go to Anthropic: in claude.ai under your own Claude account, otherwise under the account of the API key (directly or through your lab's proxy), and are handled under that account's terms. Do not use the AI features with
            identifiable patient data unless your institution permits it. The key is kept in memory only (unless you tick Remember) and is never written into workspaces, exports or logs.
          </p>
          <p>
            <b>Cost.</b> In claude.ai, requests count toward your plan's usage. With an API key or proxy they are billed per token: a gate request (one plot image and its context) costs well under 1 US cent with a Sonnet-class model, a methods
            text or a "Check analysis" a few cents; a strategy run makes one request per step.
          </p>
          <p>AI answers can be wrong. Gates are shown as previews you accept or cancel, texts are drafts to check.</p>
        </div>
      </div>
    </Modal>
  );
}

