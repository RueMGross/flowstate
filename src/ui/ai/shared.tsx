// Shared state and pieces of the AI assistant UI.
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { aiErrorMessage, getProvider, toAiError, type AiProvider } from '../../ai/provider';
import { useAiSettings } from '../../ai/settings';
import { useStore } from '../../state/store';

export type AiView = 'help' | 'analysis' | 'experiment' | 'gate' | 'strategy' | 'markers' | 'writer' | 'check';

export const AI_TITLES: Record<AiView, string> = {
  help: 'How do I …',
  analysis: 'Analyze new files',
  experiment: 'Describe experiment',
  gate: 'Gate with AI',
  strategy: 'AI gating strategy',
  markers: 'Marker labels',
  writer: 'Methods & legend',
  check: 'Check analysis',
};

export const useAiPanel = create<{
  view: AiView | null;
  itemId: string | null;
  /** text a view starts with (e.g. the gating goal the experiment reading suggested) */
  seed: string;
  open: (v: AiView, itemId?: string | null, seed?: string) => void;
  close: () => void;
}>((set) => ({
  view: null,
  itemId: null,
  seed: '',
  open: (view, itemId = null, seed = '') => set({ view, itemId, seed }),
  close: () => set({ view: null, itemId: null, seed: '' }),
}));

/** Open an AI feature; without a provider the settings open first (and the feature after a provider is set). */
export async function openAi(view: AiView, itemId?: string | null, seed?: string) {
  if (await getProvider()) useAiPanel.getState().open(view, itemId, seed);
  else useStore.getState().setUI({ dialog: { kind: 'aiSettings', payload: { reason: view, itemId } } });
}

/** The provider the settings select (re-resolved when they change). */
export function useProvider(): AiProvider | null {
  const s = useAiSettings();
  const [p, setP] = useState<AiProvider | null>(null);
  useEffect(() => {
    let alive = true;
    void getProvider().then((x) => alive && setP(x));
    return () => {
      alive = false;
    };
  }, [s.provider, s.apiKey, s.model, s.proxyUrl, s.proxyPass]);
  return p;
}

/** Whether images may be sent with this provider. */
export function imagesOn(p: AiProvider | null): boolean {
  return !!p?.images && useAiSettings.getState().allowImages;
}

/**
 * "Hide sample and file names" and "Allow sending plot images", subscribed: a view that is open while they change
 * re-renders and rebuilds what it sends (and the "Sent" preview) from the current settings.
 */
export function usePrivacy(): { anonymize: boolean; allowImages: boolean } {
  const anonymize = useAiSettings((s) => s.anonymize);
  const allowImages = useAiSettings((s) => s.allowImages);
  return { anonymize, allowImages };
}

/** Whether a prepared request (gate, check) was built with the current settings and may be sent as it is. */
export function prepCurrent(p: { anonymized: boolean; withImages: boolean } | null, provider: AiProvider | null): boolean {
  return !!p && p.anonymized === useAiSettings.getState().anonymize && p.withImages === imagesOn(provider);
}

/** Inputs a prepared request was built from: rebuild only when one of them changed (compared by identity). */
export function sameInputs(a: readonly unknown[] | null, b: readonly unknown[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

/** One request at a time with Stop; errors become a message; aborted on unmount. */
export function useJob() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const run = async (f: (signal: AbortSignal) => Promise<void>) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setBusy(true);
    setErr('');
    try {
      await f(c.signal);
    } catch (e) {
      const a = toAiError(e);
      if (a.code !== 'cancelled' && ctl.current === c) setErr(aiErrorMessage(a));
    } finally {
      if (ctl.current === c) {
        ctl.current = null;
        setBusy(false);
      }
    }
  };
  return { busy, err, setErr, run, stop: () => ctl.current?.abort() };
}

/** Exactly what an action sends: the images and the full text. */
export function Sent({ prompt, images, provider }: { prompt: string; images?: string[]; provider: AiProvider | null }) {
  const [big, setBig] = useState(-1);
  const n = images?.length ?? 0;
  return (
    <div className="ai-sent">
      <div>
        <b>Sent to {provider?.label ?? 'the AI'}:</b> {n ? `${n} plot image${n > 1 ? 's' : ''} and ` : ''}
        {prompt.length.toLocaleString('en-US')} characters of text. No event data.
      </div>
      {n > 0 && (
        <div className="ai-thumbs">
          {images!.map((u, i) => (
            <img key={u} src={u} alt={`Plot image ${i + 1} as sent`} className={big === i ? 'big' : ''} onClick={() => setBig(big === i ? -1 : i)} />
          ))}
        </div>
      )}
      <details>
        <summary>Show the text</summary>
        <pre>{prompt}</pre>
      </details>
    </div>
  );
}

export function Busy({ busy, err, stop, label = 'Thinking…' }: { busy: boolean; err: string; stop: () => void; label?: string }) {
  if (!busy && !err) return null;
  return (
    <div className="ai-row" role="status">
      {busy && <span className="grow ai-note">{label}</span>}
      {busy && (
        <button className="btn sm" onClick={stop}>
          Stop
        </button>
      )}
      {!busy && err && <span className="ai-err">{err}</span>}
    </div>
  );
}

export function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}

export async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t);
    useStore.getState().toast('Copied', 'success');
  } catch {
    useStore.getState().toast('Could not copy; select the text and press Ctrl+C.', 'info');
  }
}
