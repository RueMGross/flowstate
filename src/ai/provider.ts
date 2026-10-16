// AI providers of the optional assistant ("FlowState Assist"): one `complete` call for
//  - claude.ai: the page runs as a hosted artifact; `window.claude.use('sample')` asks Claude on the viewer's own account
//  - an Anthropic API key: direct browser call to api.anthropic.com
//  - a lab proxy: the same request posted to the lab's server (server/ai-proxy), which holds the key
//  - a test mock: `globalThis.__flowstateAiMock` (only set by tests)
// Nothing is sent unless the user starts an action; nothing is called on load.
import { useAiSettings } from './settings';

export type Tier = 'quick' | 'default' | 'complex';
export type ProviderKind = 'claude' | 'apikey' | 'proxy' | 'mock';

export interface CompleteRequest {
  prompt: string;
  images?: Blob[];
  tier?: Tier;
  signal?: AbortSignal;
  /** the whole answer so far, while it streams */
  onText?: (text: string) => void;
  maxTokens?: number;
  /** do not reuse a cached answer (claude.ai caches identical requests for 5 minutes) */
  fresh?: boolean;
}

export interface CompleteResult {
  text: string;
  /** model id, or 'claude.ai (default tier)' */
  model: string;
  /** the answer is not complete (token limit reached, or the stream ended early: see `incomplete`) */
  truncated: boolean;
  /** the stream ended before the end of the message (connection or proxy cut it off): `text` is only the part received */
  incomplete?: boolean;
}

export interface AiProvider {
  kind: ProviderKind;
  label: string;
  /** whether plot images can be sent */
  images: boolean;
  complete(r: CompleteRequest): Promise<CompleteResult>;
}

/** One failure shape for every provider; `code` follows the claude.ai sample codes where they exist. */
export class AiError extends Error {
  constructor(
    public code: string,
    message = '',
    public text?: string,
  ) {
    super(message || code);
  }
}

const MSG: Record<string, string> = {
  cancelled: 'Stopped.',
  not_configured: 'The AI assistant is off or not set up. Open AI settings to choose a provider.',
  not_granted: 'Claude was not allowed for this page. Reload the page to be asked again, or choose another provider in AI settings.',
  sampling_disabled: 'Claude is not available for this account or organization.',
  not_declared: 'This copy of FlowState does not declare the AI capability.',
  capability_disabled: 'The AI capability is not available in this view.',
  capability_removed: 'The AI capability is not available in this view.',
  images_unavailable: 'Images cannot be sent from this view. Turn off "Allow sending plot images" in AI settings, or use another provider.',
  image_rejected: 'The plot image was rejected.',
  rate_limited: 'Too many requests or usage limit reached (429). Wait a little, then try again.',
  session_expired: 'Your claude.ai session has expired. Sign in again.',
  refused: 'Claude declined this request.',
  empty_completion: 'The model returned no text. Try again or ask for less.',
  incomplete: 'The answer was cut off: the connection closed before it was complete. Try again.',
  invalid_json: 'The answer could not be read (no valid JSON). Try again.',
  prompt_too_large: 'The request is too large. Use fewer plots or a shorter text.',
  auth: 'The API key was rejected (401). Check the key in AI settings.',
  proxy_auth: 'The lab proxy rejected the request (401): check the passphrase in AI settings.',
  forbidden: 'Access denied (403).',
  not_found: 'Not found (404): check the model or the proxy URL.',
  bad_request: 'The request was rejected (400).',
  overloaded: 'The model is overloaded right now. Try again in a minute.',
  network: 'Could not reach the server: offline, wrong URL, or blocked by the browser (CORS / content security policy).',
  upstream_error: 'The AI service had a temporary problem. Try again.',
  invalid_request: 'The request could not be prepared.',
  transform_error: 'The request could not be prepared.',
  queue_overflow: 'Too many requests are waiting. Try again later.',
};

/** Message for the user (never contains the key). */
export function aiErrorMessage(e: unknown): string {
  const err = e instanceof AiError ? e : toAiError(e);
  const base = MSG[err.code];
  // local conditions (no plot, no data) carry their own message; unknown service codes count as upstream errors
  if (!base) return err.code.startsWith('no_') && err.message !== err.code ? err.message : MSG.upstream_error;
  const detail = ['bad_request', 'forbidden', 'not_found', 'upstream_error'].includes(err.code) && err.message && err.message !== err.code ? ` ${err.message.slice(0, 220)}` : '';
  return base + detail;
}

export function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  const o = e as { code?: unknown; message?: unknown; text?: unknown; name?: unknown } | null;
  if (o && typeof o.code === 'string') return new AiError(o.code, typeof o.message === 'string' ? o.message : '', typeof o.text === 'string' ? o.text : undefined);
  if (o && o.name === 'AbortError') return new AiError('cancelled');
  return new AiError('upstream_error', o && typeof o.message === 'string' ? o.message : '');
}

// ------------------------------------------------------------------ JSON answers

/** Parse a JSON answer tolerantly: the whole text, else one fenced block, else the first { or [ to the last } or ]. */
export function parseJsonTolerant<T = unknown>(text: string): T {
  const tries = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) tries.push(fence[1].trim());
  const a = text.search(/[{[]/);
  const b = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t) as T;
    } catch {
      /* next */
    }
  }
  throw new AiError('invalid_json', 'no JSON value in the answer', text);
}

export async function completeJson<T>(p: AiProvider, r: CompleteRequest): Promise<{ value: T; result: CompleteResult }> {
  const result = await p.complete(r);
  if (result.incomplete) throw new AiError('incomplete', 'the connection closed before the answer was complete', result.text);
  if (result.truncated) throw new AiError('invalid_json', 'the answer was cut short', result.text);
  return { value: parseJsonTolerant<T>(result.text), result };
}

// ------------------------------------------------------------------ claude.ai hosted artifact

type SampleFn = ((input: string, o?: Record<string, unknown>) => Promise<{ text: string; truncated: boolean; modelTierApplied?: string }>) & {
  limits?: () => Promise<{ images?: unknown }>;
};

let host: Promise<{ fn: SampleFn; images: boolean } | null> | null = null;

/** The claude.ai sample capability (null outside a Claude viewer). Resolving it asks the viewer nothing and costs nothing. */
export function claudeHost(): Promise<{ fn: SampleFn; images: boolean } | null> {
  if (host) return host;
  const w = globalThis as { claude?: { use?: (n: string) => Promise<unknown> } };
  const use = w.claude?.use;
  host = !use
    ? Promise.resolve(null)
    : (use.call(w.claude, 'sample') as Promise<SampleFn | null>)
        .then(async (fn) => {
          if (typeof fn !== 'function') return null;
          const lim = await fn.limits?.().catch(() => null);
          return { fn, images: !!lim?.images };
        })
        .catch(() => null);
  return host;
}

function claudeProvider(fn: SampleFn, images: boolean): AiProvider {
  return {
    kind: 'claude',
    label: 'claude.ai (your Claude account)',
    images,
    async complete(r) {
      const o: Record<string, unknown> = { modelTier: r.tier ?? 'default' };
      if (r.images?.length) o.images = r.images;
      if (r.signal) o.signal = r.signal;
      if (r.onText) o.onText = ({ text }: { text: string }) => r.onText!(text);
      if (r.fresh) o.cache = false;
      try {
        const res = await fn(r.prompt, o);
        return { text: res.text, model: `claude.ai (${res.modelTierApplied ?? r.tier ?? 'default'} tier)`, truncated: !!res.truncated };
      } catch (e) {
        throw toAiError(e);
      }
    },
  };
}

// ------------------------------------------------------------------ Anthropic Messages API (key or lab proxy)

export const ANTHROPIC_BASE = 'https://api.anthropic.com';

function apiHeaders(kind: 'apikey' | 'proxy'): Record<string, string> {
  const s = useAiSettings.getState();
  if (kind === 'proxy') return s.proxyPass ? { 'x-lab-passphrase': s.proxyPass } : {};
  const ws = s.workspaceId.trim();
  // personal (identity-linked) keys act in the workspace named per request
  return { 'x-api-key': s.apiKey.trim(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', ...(ws ? { 'anthropic-workspace-id': ws } : {}) };
}

function apiBase(kind: 'apikey' | 'proxy'): string {
  return kind === 'proxy' ? useAiSettings.getState().proxyUrl.trim().replace(/\/+$/, '') : ANTHROPIC_BASE;
}

async function httpError(kind: 'apikey' | 'proxy', res: Response): Promise<AiError> {
  let msg = '';
  try {
    const j = JSON.parse(await res.text());
    msg = String(j?.error?.message ?? j?.message ?? '');
  } catch {
    /* no JSON body */
  }
  const s = res.status;
  const code =
    s === 401 ? (kind === 'proxy' ? 'proxy_auth' : 'auth') : s === 403 ? 'forbidden' : s === 404 ? 'not_found' : s === 413 ? 'prompt_too_large' : s === 429 ? 'rate_limited' : s === 529 || s === 503 ? 'overloaded' : s === 400 ? 'bad_request' : 'upstream_error';
  return new AiError(code, msg);
}

async function apiFetch(kind: 'apikey' | 'proxy', path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(apiBase(kind) + path, { ...init, headers: { ...apiHeaders(kind), ...(init.headers as Record<string, string>) } });
  } catch (e) {
    throw init.signal?.aborted ? new AiError('cancelled') : new AiError('network', (e as Error)?.message);
  }
  if (!res.ok) throw await httpError(kind, res);
  return res;
}

export interface ModelInfo {
  id: string;
  name: string;
}

/** Models the key (or the proxy's allow-list) can use, newest first as the API returns them. */
export async function listModels(kind: 'apikey' | 'proxy'): Promise<ModelInfo[]> {
  const res = await apiFetch(kind, '/v1/models?limit=100', { method: 'GET' });
  const j = (await res.json()) as { data?: { id?: string; display_name?: string }[] };
  return (j.data ?? []).filter((m) => typeof m.id === 'string').map((m) => ({ id: m.id!, name: m.display_name || m.id! }));
}

/** Sensible default: the newest Sonnet-class model of the list, else the first one. */
export function defaultModel(models: ModelInfo[]): string {
  return (models.find((m) => /sonnet/i.test(m.id)) ?? models[0])?.id ?? '';
}

async function blobToBase64(b: Blob): Promise<string> {
  const u8 = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function apiProvider(kind: 'apikey' | 'proxy'): AiProvider {
  const model = useAiSettings.getState().model;
  return {
    kind,
    label: kind === 'proxy' ? `Lab proxy (${model || 'proxy default'})` : `Anthropic API (${model})`,
    images: true,
    async complete(r) {
      const content: unknown[] = [];
      for (const b of r.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: b.type || 'image/png', data: await blobToBase64(b) } });
      content.push({ type: 'text', text: r.prompt });
      const body = { model, max_tokens: r.maxTokens ?? 2000, stream: true, messages: [{ role: 'user', content }] };
      const res = await apiFetch(kind, '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: r.signal });
      return readStream(res, model, r);
    },
  };
}

/**
 * Server-sent events of the Messages API: text deltas, the model, the stop reason, errors. A stream that ends without
 * message_stop and without a stop reason was cut off (network, proxy, upstream): its text is marked incomplete.
 */
async function readStream(res: Response, model: string, r: CompleteRequest): Promise<CompleteResult> {
  let text = '';
  let stop = '';
  let ended = false;
  const reader = res.body?.getReader();
  if (!reader) throw new AiError('upstream_error', 'no response body');
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (let last = false; !last; ) {
      const { done, value } = await reader.read();
      // at the end, a last line without its newline is read too
      if (done) {
        last = true;
        buf += dec.decode() + '\n';
      } else buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let ev: { type?: string; message?: { model?: string }; delta?: { type?: string; text?: string; stop_reason?: string }; error?: { type?: string; message?: string } };
        try {
          ev = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (ev.type === 'message_start' && ev.message?.model) model = ev.message.model;
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          text += ev.delta.text;
          r.onText?.(text);
        } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
        else if (ev.type === 'message_stop') ended = true;
        else if (ev.type === 'error') {
          const t = ev.error?.type ?? '';
          throw new AiError(t === 'overloaded_error' ? 'overloaded' : t === 'rate_limit_error' ? 'rate_limited' : 'upstream_error', ev.error?.message ?? '', text || undefined);
        }
      }
    }
  } catch (e) {
    if (r.signal?.aborted) throw new AiError('cancelled', '', text || undefined);
    throw e instanceof AiError ? e : new AiError('network', (e as Error)?.message, text || undefined);
  }
  if (stop === 'refusal') throw new AiError('refused');
  if (r.signal?.aborted) throw new AiError('cancelled', '', text || undefined);
  if (!ended && !stop) {
    // cut off mid-way: never returned as a whole answer
    if (!text.trim()) throw new AiError('incomplete', 'the stream ended before the answer');
    return { text, model, truncated: true, incomplete: true };
  }
  if (!text.trim()) throw new AiError('empty_completion');
  return { text, model, truncated: stop === 'max_tokens' };
}

// ------------------------------------------------------------------ test mock

/** Test hook: a function answering a request with text, or {error: code}. Only tests set it. */
export type MockFn = (r: { prompt: string; images: Blob[]; tier: Tier }) => string | { error: string } | Promise<string | { error: string }>;

function mockHook(): MockFn | null {
  const f = (globalThis as { __flowstateAiMock?: unknown }).__flowstateAiMock;
  return typeof f === 'function' ? (f as MockFn) : null;
}

function mockProvider(fn: MockFn): AiProvider {
  return {
    kind: 'mock',
    label: 'Test mock (no data leave the page)',
    images: true,
    async complete(r) {
      const out = await fn({ prompt: r.prompt, images: r.images ?? [], tier: r.tier ?? 'default' });
      if (typeof out !== 'string') throw new AiError(out.error);
      // stream in a few pieces, like the real providers
      let text = '';
      for (const part of out.match(/[\s\S]{1,40}/g) ?? []) {
        if (r.signal?.aborted) throw new AiError('cancelled', '', text || undefined);
        await new Promise((ok) => setTimeout(ok, 15));
        text += part;
        r.onText?.(text);
      }
      if (r.signal?.aborted) throw new AiError('cancelled', '', text || undefined);
      return { text: out, model: 'mock-model', truncated: false };
    },
  };
}

// ------------------------------------------------------------------ selection

/** The provider the settings select, or null (off / not configured / not available in this view). */
export async function getProvider(): Promise<AiProvider | null> {
  const s = useAiSettings.getState();
  if (s.provider === 'off') return null;
  const mock = mockHook();
  if (mock) return mockProvider(mock);
  if (s.provider === 'claude' || s.provider === 'auto') {
    const h = await claudeHost();
    if (h) return claudeProvider(h.fn, h.images);
    if (s.provider === 'claude') return null;
  }
  if ((s.provider === 'apikey' || s.provider === 'auto') && s.apiKey.trim() && s.model) return apiProvider('apikey');
  if ((s.provider === 'proxy' || s.provider === 'auto') && s.proxyUrl.trim()) return apiProvider('proxy');
  return null;
}

/** getProvider, or an AiError('not_configured'). */
export async function requireProvider(): Promise<AiProvider> {
  const p = await getProvider();
  if (!p) throw new AiError('not_configured');
  return p;
}
