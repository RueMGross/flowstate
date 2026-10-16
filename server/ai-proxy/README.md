# FlowState lab AI proxy

Lets labmates use FlowState's optional AI features (FlowState Assist) without handing out the Anthropic API key. The
key stays on the server; FlowState posts the normal Messages API request to the proxy (AI settings > Lab proxy).

Two versions, same behaviour:

- `ai-proxy.mjs`: a single Node.js 18+ script without dependencies, for a lab server or VM (behind nginx / Caddy for HTTPS).
- `worker.js`: a Cloudflare Worker (no server to maintain).

## What it does

- Accepts only `POST /v1/messages` (and `GET /v1/models`, which lists the allowed models) from browser pages whose
  origin is in `ALLOWED_ORIGINS` (CORS allow-list). Requests without an allowed `Origin` header are refused.
- Access needs a personal code or the shared lab passphrase (`x-lab-passphrase` header, entered once in FlowState's
  AI settings). With neither configured, every request is refused (401) unless `ALLOW_ANONYMOUS=1` is set.
- Forwards only text and base64 image blocks, to an allow-listed model, with `max_tokens` capped; drops everything else
  (system prompts, tools, metadata). Malformed requests get a 400 answer; they never stop the proxy.
- Per-client rate limit (requests per minute), a monthly request cap per person and one for the whole lab.
- If the connection to Anthropic breaks in the middle of a streamed answer, the proxy aborts its response too, so
  FlowState shows an error instead of a cut-off answer that looks complete.
- Request size limits (body size, prompt characters, number of images).
- Logs one JSON line per request: time, a salted hash of the client IP, status, model, number of images and characters.
  Never the prompt, the images or the answer.

## Run the Node version

```bash
export ANTHROPIC_API_KEY=sk-ant-...            # the lab's key (keep it out of shell history / use a secrets file)
export ALLOWED_ORIGINS=https://flowstate.your-lab.example   
export LAB_PASSPHRASE='some long shared phrase' # or personal codes (LAB_USERS / LAB_USERS_FILE): one is needed
export MODELS=claude-sonnet-5-5                 # comma list; check GET https://api.anthropic.com/v1/models for current ids
node ai-proxy.mjs                               # listens on 127.0.0.1:8787
```

Put it behind your HTTPS reverse proxy (browsers block mixed content and the passphrase must not travel unencrypted),
e.g. nginx

```nginx
location /ai/ {
  proxy_pass http://127.0.0.1:8787/;
  proxy_buffering off;
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

and set `TRUST_PROXY=1` so the rate limit uses the client address nginx passes on. `proxy_buffering off` keeps the
streamed answers streaming; `X-Forwarded-For $remote_addr` replaces whatever the client sent in that header. In
FlowState enter `https://your-server.example/ai` as the proxy URL. Run it as a service (systemd, pm2) with the
variables in an environment file readable only by the service user. On a server set up with `install.sh` (see
DEPLOY.md), update the proxy by copying the new folder there and running `sudo ./install.sh` again: settings and codes
are kept.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (required) | the API key (best: a key of a workspace of its own with a spend limit) |
| `ANTHROPIC_WORKSPACE_ID` | (none) | only for a personal (identity-linked, `sk-ant-usr-`) key: the workspace it acts in (`wrkspc_...`) |
| `ALLOWED_ORIGINS` | (none: refuse all) | origins of the FlowState pages, comma-separated. A FlowState HTML file opened from disk sends `Origin: null`; add `null` only if you accept that any local file can then use the proxy (the passphrase still applies). |
| `LAB_PASSPHRASE` | (none) | shared passphrase (this and/or personal codes are needed, see `ALLOW_ANONYMOUS`) |
| `LAB_USERS` / `LAB_USERS_FILE` | (none) | personal access codes: `name:code,name:code`, or a JSON file `{"name": "code"}` (codes of at least 12 characters; make one with `node ai-proxy.mjs --new-code`). Each labmate enters their own code in FlowState where the passphrase goes. |
| `ALLOW_ANONYMOUS` | off | `1`: when no personal code and no passphrase are configured, accept requests without a code from the allowed origins (anyone who can load such a page spends the lab's budget). Without it such a proxy refuses every request. Ignored as soon as a code or passphrase exists. |
| `USER_MONTHLY_CAP` | 1000 | requests per person (personal code) and calendar month |
| `MODELS` | `claude-sonnet-5-5` | allowed model ids; the first is used when the request names none |
| `RATE_PER_MINUTE` | 10 | requests per client and minute |
| `MONTHLY_CAP` | 3000 | requests per calendar month (UTC) for everyone |
| `MAX_BODY_MB` / `MAX_PROMPT_CHARS` / `MAX_IMAGES` / `MAX_TOKENS` | 8 / 60000 / 8 / 4096 | size limits |
| `PORT` / `HOST` | 8787 / 127.0.0.1 | where to listen |
| `TRUST_PROXY` | off | `1`: take the client address from the last `X-Forwarded-For` entry (the one the reverse proxy adds; earlier entries can be forged). Only behind a reverse proxy, with the proxy itself listening on 127.0.0.1 |
| `USAGE_FILE` | `./ai-proxy-usage.json` | where the monthly count is kept |
| `LOG_SALT` | (empty) | salt for the hashed client addresses in the log |

Typical use: one gate request is one plot image plus about 1,000 words of context. A monthly cap of 3000 requests with a
Sonnet-class model stays in the range of a few tens of US dollars; check current prices and set a spend limit on the
key in the Anthropic console as a second safeguard.

## Cloudflare Worker

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put LAB_USERS               # personal codes "name:code,name:code", and/or:
npx wrangler secret put LAB_PASSPHRASE          # (one of the two is needed, else every request gets 401)
npx wrangler deploy worker.js --name flowstate-ai-proxy --compatibility-date 2025-01-01 \
  --var ALLOWED_ORIGINS:https://flowstate.your-lab.example --var MODELS:claude-sonnet-5-5 --var MONTHLY_CAP:3000
```

Same request checks and limits as the Node version (`ALLOW_ANONYMOUS`, `USER_MONTHLY_CAP`, `MAX_PROMPT_CHARS`,
`MAX_IMAGES`, `MAX_TOKENS`, `MAX_BODY_MB` can be set with `--var`). Rate limit and monthly caps need bindings in
`wrangler.toml` (without them the worker runs without these limits). The KV counters (whole lab and per personal code)
are approximate: KV has no atomic increment, so a burst of parallel requests can pass a cap by a few.

```toml
[[unsafe.bindings]]            # Workers rate limiting API
name = "RATE_LIMITER"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 10, period = 60 }

[[kv_namespaces]]              # monthly counters
binding = "USAGE"
id = "<your KV namespace id>"
```

## Personal codes instead of one passphrase

With `LAB_USERS` every labmate has their own code: a code that leaks or a person who leaves is removed alone (edit the
list, restart the service; with `install.sh`: `sudo flowstate-ai remove NAME`), the log shows requests per name (never
their content) and `USER_MONTHLY_CAP` limits each person. The shared `LAB_PASSPHRASE` can stay as well or be left out.
One shared code for the whole lab is simply a single entry, e.g. `{"lab": "...."}`. Removing the last code (with no
passphrase set) makes the proxy refuse every request until a code is added again.

```bash
node ai-proxy.mjs --new-code     # prints a random code; do this once per person
# /etc/flowstate-ai/users.json (readable only by the service user):
# { "alex": "....", "sam": "...." }
```

## Privacy

The proxy forwards what FlowState shows the user before sending (rendered plot images, channel and gate names, counts,
text the user typed) to Anthropic under the lab's API account. It stores nothing but the monthly count. Tell your
labmates who operates the proxy and do not use it for identifiable patient data unless your institution permits it.
