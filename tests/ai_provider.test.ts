// AI providers without network: the Anthropic API path (key and lab proxy) against a fake fetch (models list, streamed
// answer, 401 / 429 / 529 / network / abort), the claude.ai path against a fake window.claude, and the settings storage
// (the key is kept only when "Remember" is ticked).
import { vi } from 'vitest';

type Sample = (input: string, o?: Record<string, unknown>) => Promise<{ text: string; truncated: boolean; modelTierApplied?: string }>;
let sampleImpl: Sample = async () => ({ text: 'OK', truncated: false, modelTierApplied: 'default' });
const sampleCalls: { input: string; o?: Record<string, unknown> }[] = [];
const storage = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };

const { useAiSettings } = await import('../src/ai/settings');
const P = await import('../src/ai/provider');

const sse = (events: object[], status = 200) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const e of events) c.enqueue(enc.encode(`event: x\ndata: ${JSON.stringify(e)}\n\n`));
        c.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  );

const answer = (text: string, model = 'claude-sonnet-test') => [
  { type: 'message_start', message: { model } },
  ...text.match(/[\s\S]{1,5}/g)!.map((t) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })),
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
];

describe('Anthropic API key', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let next: () => Promise<Response> = async () => sse(answer('{"ok": true}'));
  g.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-haiku-9', display_name: 'Haiku 9' }, { id: 'claude-sonnet-9', display_name: 'Sonnet 9' }, { id: 'claude-sonnet-8' }] }), { status: 200 });
    return next();
  });

  it('is off by default; settings are stored without the key unless remembered', async () => {
    expect(useAiSettings.getState().provider).toBe('off');
    expect(await P.getProvider()).toBeNull();
    useAiSettings.getState().set({ provider: 'apikey', apiKey: 'sk-ant-api03-SECRET-1234567890' });
    expect([...storage.values()].join()).not.toContain('SECRET');
    expect(JSON.parse(storage.get('fs.ai.prefs')!).provider).toBe('apikey');
    useAiSettings.getState().set({ remember: true });
    expect(storage.get('fs.ai.secret')).toContain('SECRET');
    useAiSettings.getState().forgetSecrets();
    expect(storage.has('fs.ai.secret')).toBe(false);
    expect(useAiSettings.getState().apiKey).toBe('');
  });

  it('lists models (default: newest Sonnet) and streams an answer with the browser-access headers', async () => {
    useAiSettings.getState().set({ provider: 'apikey', apiKey: 'sk-ant-api03-SECRET-1234567890' });
    const models = await P.listModels('apikey');
    expect(models.map((m) => m.id)).toEqual(['claude-haiku-9', 'claude-sonnet-9', 'claude-sonnet-8']);
    expect(P.defaultModel(models)).toBe('claude-sonnet-9');
    useAiSettings.getState().set({ model: 'claude-sonnet-9' });
    const p = (await P.getProvider())!;
    expect(p.kind).toBe('apikey');
    const seen: string[] = [];
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const r = await p.complete({ prompt: 'hi', images: [png], onText: (t) => seen.push(t) });
    expect(r.text).toBe('{"ok": true}');
    expect(r.model).toBe('claude-sonnet-test');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(r.text);
    const c = calls[calls.length - 1];
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    const h = c.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-ant-api03-SECRET-1234567890');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(String(c.init.body));
    expect(body.model).toBe('claude-sonnet-9');
    expect(body.stream).toBe(true);
    expect(body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } });
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'hi' });
  });

  it('errors: 401, 429, 529, refusal, network, abort; messages never contain the key', async () => {
    const p = (await P.getProvider())!;
    const code = async (r: () => Promise<Response>) => {
      next = r;
      try {
        await p.complete({ prompt: 'x' });
      } catch (e) {
        expect(P.aiErrorMessage(e)).not.toContain('SECRET');
        return (e as InstanceType<typeof P.AiError>).code;
      }
      return 'ok';
    };
    const err = (status: number, type: string) => async () => new Response(JSON.stringify({ type: 'error', error: { type, message: `${type} happened` } }), { status });
    expect(await code(err(401, 'authentication_error'))).toBe('auth');
    expect(P.aiErrorMessage(new P.AiError('auth'))).toMatch(/401/);
    expect(await code(err(429, 'rate_limit_error'))).toBe('rate_limited');
    expect(await code(err(529, 'overloaded_error'))).toBe('overloaded');
    expect(await code(err(400, 'invalid_request_error'))).toBe('bad_request');
    expect(await code(async () => sse([{ type: 'message_start', message: { model: 'm' } }, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]))).toBe('overloaded');
    expect(await code(async () => sse([{ type: 'message_start', message: { model: 'm' } }, { type: 'message_delta', delta: { stop_reason: 'refusal' } }]))).toBe('refused');
    expect(
      await code(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBe('network');
    next = async () => sse(answer('slow answer'));
    const ctl = new AbortController();
    ctl.abort();
    g.fetch = vi.fn(async (_u: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return next();
    });
    await expect(p.complete({ prompt: 'x', signal: ctl.signal })).rejects.toMatchObject({ code: 'cancelled' });
    // a truncated answer is not taken as JSON
    next = async () => sse([...answer('{"a": 1').slice(0, -1), { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]);
    await expect(P.completeJson(p, { prompt: 'x' })).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('lab proxy: posts to the proxy with the passphrase, never the key', async () => {
    const calls2: { url: string; init: RequestInit }[] = [];
    g.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls2.push({ url, init });
      return url.endsWith('/v1/models') || url.includes('/v1/models?') ? new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-9' }] })) : sse(answer('hello'));
    });
    useAiSettings.getState().set({ provider: 'proxy', proxyUrl: 'https://proxy.lab.example/ai/', proxyPass: 'lab-pass', model: '' });
    expect((await P.listModels('proxy')).map((m) => m.id)).toEqual(['claude-sonnet-9']);
    const p = (await P.getProvider())!;
    expect(p.kind).toBe('proxy');
    expect((await p.complete({ prompt: 'x' })).text).toBe('hello');
    const c = calls2[calls2.length - 1];
    expect(c.url).toBe('https://proxy.lab.example/ai/v1/messages');
    const h = c.init.headers as Record<string, string>;
    expect(h['x-lab-passphrase']).toBe('lab-pass');
    expect(h['x-api-key']).toBeUndefined();
    g.fetch = vi.fn(async () => new Response('{"error":{"message":"bad passphrase"}}', { status: 401 }));
    await expect(p.complete({ prompt: 'x' })).rejects.toMatchObject({ code: 'proxy_auth' });
  });
});

describe('claude.ai hosted artifact', () => {
  it('uses window.claude sample with the model tier, images, signal and streaming; maps its error codes', async () => {
    const fn = Object.assign((input: string, o?: Record<string, unknown>) => (sampleCalls.push({ input, o }), sampleImpl(input, o)), { limits: async () => ({ images: { maxCount: 5 } }) });
    g.claude = { use: async (n: string) => (n === 'sample' ? fn : null) };
    useAiSettings.getState().set({ provider: 'auto' });
    const p = (await P.getProvider())!;
    expect(p.kind).toBe('claude');
    expect(p.images).toBe(true);
    sampleImpl = async (_i, o) => {
      (o!.onText as (u: { text: string }) => void)({ text: '{"found": false}' });
      return { text: '{"found": false}', truncated: false, modelTierApplied: 'default' };
    };
    const img = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const streamed: string[] = [];
    const { value, result } = await P.completeJson<{ found: boolean }>(p, { prompt: 'find', images: [img], tier: 'default', signal: new AbortController().signal, onText: (t) => streamed.push(t), fresh: true });
    expect(value.found).toBe(false);
    expect(result.model).toBe('claude.ai (default tier)');
    expect(streamed).toEqual(['{"found": false}']);
    const o = sampleCalls[0].o!;
    expect(o.modelTier).toBe('default');
    expect(o.images).toEqual([img]);
    expect(o.cache).toBe(false);
    expect(o.signal).toBeInstanceOf(AbortSignal);
    // no images: the option is left out, not undefined
    sampleImpl = async () => ({ text: 'x', truncated: false });
    await p.complete({ prompt: 'y' });
    expect('images' in sampleCalls[1].o!).toBe(false);
    for (const c of ['not_granted', 'rate_limited', 'refused', 'images_unavailable', 'session_expired']) {
      sampleImpl = async () => Promise.reject({ code: c, message: 'dev text' });
      await expect(p.complete({ prompt: 'z' })).rejects.toMatchObject({ code: c });
    }
    expect(P.aiErrorMessage({ code: 'not_granted', message: 'x' })).toMatch(/not allowed/);
    expect(P.aiErrorMessage({ code: 'some_new_code', message: 'dev text' })).toMatch(/temporary problem/);
  });
});
