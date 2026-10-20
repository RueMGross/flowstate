#!/usr/bin/env node
// FlowState lab AI proxy: lets labmates use FlowState's AI features without the Anthropic API key. The key stays on this
// server; browsers post the usual Messages API request here. Node 18+, no dependencies. Logs no prompt content.
// Configuration by environment variables (see README.md). Start: ANTHROPIC_API_KEY=... ALLOWED_ORIGINS=... node ai-proxy.mjs
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { Readable, pipeline } from 'node:stream';

const env = process.env;
// `node ai-proxy.mjs --new-code`: print a random personal access code (for LAB_USERS)
if (process.argv.includes('--new-code')) (console.log(randomBytes(18).toString('base64url')), process.exit(0));
const KEY = env.ANTHROPIC_API_KEY;
if (!KEY) (console.error('ANTHROPIC_API_KEY is not set'), process.exit(1));
const list = (v, d = '') => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);
const sha = (s) => createHash('sha256').update(String(s)).digest();
const ORIGINS = list(env.ALLOWED_ORIGINS);
const MODELS = list(env.MODELS, 'claude-sonnet-5-5');
const PASS = env.LAB_PASSPHRASE ?? '';
// personal access codes, "name:code" pairs (LAB_USERS) or a JSON file {"name": "code"} (LAB_USERS_FILE): each labmate
// has their own code, which can be revoked alone; usage is counted and logged per name
const USERS = new Map(list(env.LAB_USERS).map((p) => [p.slice(0, p.indexOf(':')).trim(), p.slice(p.indexOf(':') + 1).trim()]).filter(([n, c]) => n && c.length >= 12));
if (env.LAB_USERS_FILE)
  try {
    for (const [n, c] of Object.entries(JSON.parse(readFileSync(env.LAB_USERS_FILE, 'utf8')))) if (typeof c === 'string' && c.length >= 12) USERS.set(n, c);
  } catch (e) {
    (console.error(`LAB_USERS_FILE could not be read: ${e.message}`), process.exit(1));
  }
// codes are compared as SHA-256 digests: fixed length, so timingSafeEqual never throws, whatever the client sends
const CODES = new Map([...USERS].map(([n, c]) => [n, sha(c)]));
const PASS_SHA = sha(PASS);
// without any code or passphrase the proxy refuses every request, unless anonymous use is switched on explicitly
const UNCONFIGURED = !CODES.size && !PASS;
const ANONYMOUS = UNCONFIGURED && env.ALLOW_ANONYMOUS === '1';
const USER_MONTHLY = +(env.USER_MONTHLY_CAP ?? 1000);
const PER_MIN = +(env.RATE_PER_MINUTE ?? 10);
const MONTHLY = +(env.MONTHLY_CAP ?? 3000);
const MAX_BODY = +(env.MAX_BODY_MB ?? 8) * 1048576;
const MAX_TEXT = +(env.MAX_PROMPT_CHARS ?? 60000);
const MAX_IMAGES = +(env.MAX_IMAGES ?? 8);
// room for the model's reasoning: thinking tokens count toward max_tokens, and a JSON answer cut short is lost
const MAX_TOKENS = +(env.MAX_TOKENS ?? 16000);
const UPSTREAM = env.UPSTREAM ?? 'https://api.anthropic.com';
// personal (identity-linked, sk-ant-usr-...) keys need the workspace to act in; workspace keys need nothing
const WORKSPACE = (env.ANTHROPIC_WORKSPACE_ID ?? '').trim();
const USAGE_FILE = env.USAGE_FILE ?? './ai-proxy-usage.json';
if (!ORIGINS.length) console.warn('ALLOWED_ORIGINS is empty: every browser request will be refused');
if (UNCONFIGURED)
  console.warn(
    ANONYMOUS
      ? 'No personal codes and no LAB_PASSPHRASE, ALLOW_ANONYMOUS=1: requests without a code are accepted from the allowed origins'
      : 'No personal codes and no LAB_PASSPHRASE: every request is refused until a code is added (or ALLOW_ANONYMOUS=1 is set)',
  );

let usage = { month: '', count: 0, users: {} };
try {
  const u = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
  if (u && typeof u === 'object' && typeof u.month === 'string') usage = { month: u.month, count: +u.count || 0, users: u.users && typeof u.users === 'object' ? u.users : {} };
} catch {}
const hits = new Map(); // client -> request times of the last minute

const anon = (ip) => createHash('sha256').update(ip + (env.LOG_SALT ?? '')).digest('hex').slice(0, 10);
const log = (ip, status, info = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), client: anon(ip), status, ...info }));
// errors are logged by kind and place only: messages can quote request content
const where = (e) => ({ error: String(e?.code ?? e?.name ?? 'Error'), at: (String(e?.stack ?? '').split('\n').find((l) => /^\s+at /.test(l)) ?? '').trim().slice(0, 160) });
/** Who sends: the name of a personal code, 'lab' for the shared passphrase, 'anyone' with ALLOW_ANONYMOUS=1 and nothing configured; null: refused. */
function whoIs(p) {
  const d = sha(typeof p === 'string' ? p : '');
  let who = null;
  for (const [name, code] of CODES) if (timingSafeEqual(d, code) && !who) who = name;
  if (!who && PASS && timingSafeEqual(d, PASS_SHA)) who = 'lab';
  return who ?? (ANONYMOUS ? 'anyone' : null);
}
const fail = (res, status, message) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } })));

/** The request as forwarded: allow-listed model, capped tokens, text and image blocks only. Returns [request, error, info]. */
function clean(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.messages) || !b.messages.length) return [null, 'messages missing'];
  if (b.messages.length > 6) return [null, 'too many messages (max 6)'];
  const model = b.model || MODELS[0];
  if (!MODELS.includes(model)) return [null, `model not allowed here (allowed: ${MODELS.join(', ')})`];
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
  const max_tokens = Math.min(MAX_TOKENS, Math.max(1, Math.floor(+b.max_tokens || 1024)));
  return [{ model, max_tokens, messages, stream: !!b.stream }, null, { model, chars, images }];
}

/** The monthly cap this request would exceed, or null. Synchronous: the final check runs right before the request is counted. */
function capReached(user) {
  const month = new Date().toISOString().slice(0, 7);
  if (usage.month !== month) usage = { month, count: 0, users: {} };
  if (usage.count >= MONTHLY) return 'monthly request cap of the lab proxy reached';
  if (CODES.has(user) && (usage.users[user] ?? 0) >= USER_MONTHLY) return 'your monthly request cap on the lab proxy is reached';
  return null;
}
function saveUsage() {
  try {
    // written whole to a temporary file, then renamed: the usage file is never left half-written
    writeFileSync(USAGE_FILE + '.tmp', JSON.stringify(usage));
    renameSync(USAGE_FILE + '.tmp', USAGE_FILE);
  } catch (e) {
    console.error(JSON.stringify({ t: new Date().toISOString(), usageFile: 'not written', ...where(e) }));
  }
}

async function handle(req, res) {
  // behind a reverse proxy (TRUST_PROXY=1) the client is the LAST X-Forwarded-For entry, the one the nearest proxy
  // added; earlier entries come from the client and can be forged
  const ip = (env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim()) || req.socket.remoteAddress || '?';
  const origin = req.headers.origin;
  if (!origin || !ORIGINS.includes(origin)) return log(ip, 403, { origin: origin ?? null }), fail(res, 403, 'origin not allowed');
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'content-type, x-lab-passphrase');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204, { 'access-control-max-age': '600' }), res.end();
  const user = whoIs(req.headers['x-lab-passphrase']);
  if (!user)
    return log(ip, 401), fail(res, 401, UNCONFIGURED ? 'this lab proxy has no access codes yet: its admin has to add one (sudo flowstate-ai add NAME)' : 'wrong or missing lab passphrase or personal code');
  let path;
  try {
    path = new URL(req.url ?? '/', 'http://x').pathname.replace(/\/+$/, '');
  } catch {
    return log(ip, 400, { reason: 'bad request target' }), fail(res, 400, 'malformed request target');
  }
  if (req.method === 'GET' && path.endsWith('/v1/models'))
    return res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ data: MODELS.map((id) => ({ type: 'model', id, display_name: id })) }));
  if (req.method !== 'POST' || !path.endsWith('/v1/messages')) return fail(res, 404, 'only POST /v1/messages and GET /v1/models');
  const now = Date.now();
  const who = CODES.has(user) ? 'user:' + user : ip; // rate limit per person when known, else per address
  const recent = (hits.get(who) ?? []).filter((t) => now - t < 60000);
  if (recent.length >= PER_MIN) return log(ip, 429, { user }), fail(res, 429, 'rate limit: wait a minute');
  hits.set(who, [...recent, now]);
  const early = capReached(user); // spares reading the body when the cap is already reached
  if (early) return log(ip, 429, { user, cap: true }), fail(res, 429, early);
  const chunks = [];
  let size = 0;
  try {
    for await (const c of req) {
      if ((size += c.length) > MAX_BODY) return log(ip, 413), fail(res, 413, 'request too large');
      chunks.push(c);
    }
  } catch {
    return log(ip, 400, { reason: 'upload aborted' }), res.destroy(); // the client went away while sending
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return fail(res, 400, 'invalid JSON');
  }
  const [out, err, info] = clean(body);
  if (err) return log(ip, 400, { reason: err.slice(0, 40) }), fail(res, 400, err);
  // checked again and counted with no await in between: concurrent requests cannot all pass the same last free slot
  const cap = capReached(user);
  if (cap) return log(ip, 429, { user, cap: true }), fail(res, 429, cap);
  usage.count++;
  usage.users[user] = (usage.users[user] ?? 0) + 1;
  saveUsage();
  const ctl = new AbortController();
  res.on('close', () => ctl.abort()); // the browser stopped: stop the upstream request too
  let up;
  try {
    up = await fetch(`${UPSTREAM}/v1/messages`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01', ...(WORKSPACE ? { 'anthropic-workspace-id': WORKSPACE } : {}) }, body: JSON.stringify(out) });
  } catch {
    return log(ip, 502, { ...info, user }), fail(res, 502, 'Anthropic API not reachable');
  }
  log(ip, up.status, { ...info, user, n: usage.count });
  res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
  if (!up.body) return res.end();
  // an upstream failure mid-answer aborts the response (no clean end): the browser sees a broken answer, not a short one
  pipeline(Readable.fromWeb(up.body), res, (e) => e && res.destroy());
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(JSON.stringify({ t: new Date().toISOString(), status: 500, ...where(e) }));
    try {
      if (!res.headersSent) fail(res, 500, 'internal proxy error');
      else res.destroy();
    } catch {
      res.destroy();
    }
  });
});
server.on('error', (e) => (console.error(`FlowState AI proxy cannot listen: ${e.message}`), process.exit(1)));
server.listen(+(env.PORT ?? 8787), env.HOST ?? '127.0.0.1', function () {
  console.log(`FlowState AI proxy on ${env.HOST ?? '127.0.0.1'}:${this.address().port}; origins ${ORIGINS.join(', ') || '(none)'}; models ${MODELS.join(', ')}`);
});
// last safety nets: one bad request must never take the proxy down for everyone
process.on('unhandledRejection', (e) => console.error(JSON.stringify({ t: new Date().toISOString(), unhandledRejection: true, ...where(e) })));
process.on('uncaughtException', (e) => console.error(JSON.stringify({ t: new Date().toISOString(), uncaughtException: true, ...where(e) })));
