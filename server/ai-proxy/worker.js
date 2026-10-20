// FlowState lab AI proxy as a Cloudflare Worker (alternative to ai-proxy.mjs). Secrets: ANTHROPIC_API_KEY, LAB_PASSPHRASE
// and/or LAB_USERS ("name:code" pairs: personal codes; at least one of the two, else every request is refused unless
// ALLOW_ANONYMOUS is "1"). Vars: ALLOWED_ORIGINS, MODELS, MONTHLY_CAP, USER_MONTHLY_CAP, MAX_PROMPT_CHARS, MAX_IMAGES,
// MAX_TOKENS, MAX_BODY_MB. Optional bindings: RATE_LIMITER (Workers rate limiting API), USAGE (KV namespace for the
// monthly caps; KV has no atomic increment, so these counts are approximate). Logs no prompt content. See README.md.
const json = (status, message, h = {}) => new Response(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } }), { status, headers: { ...h, 'content-type': 'application/json' } });
const list = (v, d = '') => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);
const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
/** Constant-time comparison of two SHA-256 digests (always 32 bytes, whatever the client sent). */
const same = (a, b) => {
  let d = 0;
  for (let i = 0; i < 32; i++) d |= a[i] ^ b[i];
  return d === 0;
};

/** The request as forwarded, same rules as ai-proxy.mjs: allow-listed model, capped tokens, text and image blocks only. Returns [request, error, info]. */
function clean(b, env, models) {
  const MAX_TEXT = +(env.MAX_PROMPT_CHARS ?? 60000);
  const MAX_IMAGES = +(env.MAX_IMAGES ?? 8);
  if (!b || typeof b !== 'object' || !Array.isArray(b.messages) || !b.messages.length) return [null, 'messages missing'];
  if (b.messages.length > 6) return [null, 'too many messages (max 6)'];
  const model = b.model || models[0];
  if (!models.includes(model)) return [null, `model not allowed here (allowed: ${models.join(', ')})`];
  let chars = 0;
  let images = 0;
  const messages = [];
  for (const m of b.messages) {
    if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant')) return [null, 'each message needs the role user or assistant'];
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) return [null, 'message content must be text or a list of blocks'];
    const content = [];
    for (const c of typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content) {
      if (c?.type === 'text' && typeof c.text === 'string') (chars += c.text.length), content.push({ type: 'text', text: c.text });
      else if (c?.type === 'image' && c.source?.type === 'base64' && /^image\/(png|jpeg|webp|gif)$/.test(c.source.media_type) && typeof c.source.data === 'string')
        images++, content.push({ type: 'image', source: { type: 'base64', media_type: c.source.media_type, data: c.source.data } });
      else return [null, 'only text and base64 image blocks are forwarded'];
    }
    if (!content.length) return [null, 'empty message'];
    messages.push({ role: m.role, content: typeof m.content === 'string' ? m.content : content });
  }
  if (chars > MAX_TEXT) return [null, `prompt too long (max ${MAX_TEXT} characters)`];
  if (images > MAX_IMAGES) return [null, `too many images (max ${MAX_IMAGES})`];
  const max_tokens = Math.min(+(env.MAX_TOKENS ?? 16000), Math.max(1, Math.floor(+b.max_tokens || 1024)));
  return [{ model, max_tokens, messages, stream: !!b.stream }, null, { model, chars, images }];
}

async function handle(req, env, h) {
  // a personal code (LAB_USERS) or the shared passphrase; with neither configured, refused unless ALLOW_ANONYMOUS=1
  const given = await sha(req.headers.get('x-lab-passphrase') ?? '');
  const users = list(env.LAB_USERS).map((p) => [p.slice(0, p.indexOf(':')).trim(), p.slice(p.indexOf(':') + 1).trim()]).filter(([n, c]) => n && c.length >= 12);
  const pass = env.LAB_PASSPHRASE ?? '';
  let user = null;
  for (const [name, code] of users) if (same(given, await sha(code)) && !user) user = name;
  if (!user && pass && same(given, await sha(pass))) user = 'lab';
  const unconfigured = !users.length && !pass;
  if (!user && unconfigured && env.ALLOW_ANONYMOUS === '1') user = 'anyone';
  if (!user) return json(401, unconfigured ? 'this lab proxy has no access codes yet: its admin has to set LAB_USERS or LAB_PASSPHRASE' : 'wrong or missing lab passphrase or personal code', h);
  const personal = users.some(([n]) => n === user);
  const models = list(env.MODELS, 'claude-sonnet-5-5');
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  if (req.method === 'GET' && path.endsWith('/v1/models')) return new Response(JSON.stringify({ data: models.map((id) => ({ type: 'model', id, display_name: id })) }), { headers: { ...h, 'content-type': 'application/json' } });
  if (req.method !== 'POST' || !path.endsWith('/v1/messages')) return json(404, 'only POST /v1/messages and GET /v1/models', h);
  const ip = req.headers.get('cf-connecting-ip') ?? '?';
  if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key: personal ? 'user:' + user : ip })).success) return json(429, 'rate limit: wait a minute', h);
  const maxBody = +(env.MAX_BODY_MB ?? 8) * 1048576;
  if (+(req.headers.get('content-length') ?? 0) > maxBody) return json(413, 'request too large', h);
  const text = await req.text();
  if (text.length > maxBody) return json(413, 'request too large', h);
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    return json(400, 'invalid JSON', h);
  }
  const [out, err, info] = clean(b, env, models);
  if (err) return json(400, err, h);
  // monthly caps for the whole lab and per personal code, kept in KV (approximate: KV has no atomic increment)
  if (env.USAGE) {
    const month = new Date().toISOString().slice(0, 7);
    const userKey = `${month}:user:${user}`;
    const [all, mine] = (await Promise.all([env.USAGE.get(month), personal ? env.USAGE.get(userKey) : '0'])).map((v) => +(v ?? 0) || 0);
    if (all >= +(env.MONTHLY_CAP ?? 3000)) return json(429, 'monthly request cap of the lab proxy reached', h);
    if (personal && mine >= +(env.USER_MONTHLY_CAP ?? 1000)) return json(429, 'your monthly request cap on the lab proxy is reached', h);
    // a failed counter write (e.g. KV's one write per key and second) must not fail the request
    await Promise.all([env.USAGE.put(month, String(all + 1)), personal ? env.USAGE.put(userKey, String(mine + 1)) : null]).catch((e) => console.log(JSON.stringify({ usage: 'not written', error: e?.name ?? 'Error' })));
  }
  let up;
  try {
    up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', ...(env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } : {}) },
      body: JSON.stringify(out),
    });
  } catch {
    return json(502, 'Anthropic API not reachable', h);
  }
  console.log(JSON.stringify({ status: up.status, model: info.model, user, images: info.images, chars: info.chars }));
  return new Response(up.body, { status: up.status, headers: { ...h, 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin');
    if (!origin || !list(env.ALLOWED_ORIGINS).includes(origin)) return json(403, 'origin not allowed');
    const h = { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-headers': 'content-type, x-lab-passphrase', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...h, 'access-control-max-age': '600' } });
    try {
      return await handle(req, env, h);
    } catch (e) {
      // never a bare Cloudflare 500 without CORS headers (the browser would only see a network error); no content logged
      console.log(JSON.stringify({ status: 500, error: e?.name ?? 'Error' }));
      return json(500, 'internal proxy error', h);
    }
  },
};
