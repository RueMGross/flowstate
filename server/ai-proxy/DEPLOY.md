# Lab AI proxy on your own server

Goal: labmates use FlowState's AI features with the lab's Anthropic account, and the API key never leaves the server.

## 1. Key and spending limit (Anthropic Console)

1. Create a workspace of its own, e.g. "FlowState lab", and set a monthly spend limit (e.g. 30 USD).
2. Create an API key in that workspace only. It can do nothing but spend that budget. (A personal, identity-linked
   key, `sk-ant-usr-...`, works too, but it is tied to your person and needs a named workspace: the Default workspace
   has no ID. For a server, the workspace key is the better choice.)
3. Never put the key into FlowState, an HTML file, a repository, a chat or an e-mail. If it leaks: delete it in the
   console and create a new one (only the server's env file changes).

## 2. Install (one script, adds only its own files)

Copy this folder to the server and run, with the proxy's address and the address of the FlowState page:

```bash
sudo ./install.sh ai.your-lab.example https://flowstate.your-lab.example
```

If port 8787 is taken by another program, give another one at the first install: `sudo PORT_OVERRIDE=8788
./install.sh ...` (later runs keep it). Running the script again updates the proxy and keeps settings and codes.

It creates the service user `flowstate-ai`, `/opt/flowstate-ai`, `/etc/flowstate-ai` (settings, codes), the systemd
service `flowstate-ai`, an nginx server block of its own (`/etc/nginx/sites-available/flowstate-ai`, checked with
`nginx -t` before the reload, disabled again if the check fails) and the admin command `flowstate-ai`. Nothing else is
changed; running it again keeps the settings.

Then:

1. DNS: `ai.your-lab.example` points to the server.
2. HTTPS for that name, the same way as the other sites (e.g. `sudo certbot --nginx -d ai.your-lab.example`).
3. **In your own terminal** (the key is typed hidden and never lands in a log, a chat or the shell history):
   `sudo flowstate-ai setkey`. A personal key (`sk-ant-usr-...`) also asks for its workspace ID.
4. A code per labmate: `sudo flowstate-ai add alex` (printed once; give it to that person only). One shared code
   for the whole lab works too (`sudo flowstate-ai add lab`); personal codes can be revoked one by one. Until the
   first code exists, the proxy refuses every request (401).
5. Check: `sudo flowstate-ai status`, `sudo flowstate-ai test alex` (answers "OK" through the whole chain).

Later: `sudo flowstate-ai remove NAME` revokes a code (it warns when that was the last one: the proxy then refuses
every request until a code is added), `sudo flowstate-ai users` shows requests per person this month,
`sudo flowstate-ai setkey` replaces the key (e.g. after rotating it in the Console).

Update the proxy (after a FlowState release changed `server/ai-proxy`): copy the new folder to the server and run
`sudo ./install.sh ai.your-lab.example https://flowstate.your-lab.example` again. It replaces `ai-proxy.mjs` and the admin command
and restarts the service; settings, codes, port and the nginx file are kept. If it prints a note about
`X-Forwarded-For` (site file from an older install), add that line to the nginx file as shown.

## 3. Model ids

`MODELS` in `/etc/flowstate-ai/env` lists the allowed models (first = default). Check current ids at
https://docs.claude.com/en/docs/about-claude/models; after a change: `sudo systemctl restart flowstate-ai`.

## 4. In FlowState

AI tab > AI settings > Lab proxy: URL `https://ai.your-lab.example`, then the personal code. "Hide sample and file
names" stays on unless names are needed (e.g. for "AI auto-analysis", which asks per request).

## What leaves the browser

Only what each AI action shows under "Sent" before you click: plot images, channel and gate names, counts and
statistics, tube names if allowed, text you type. Never the FCS files or events, never operator names. Requests are
processed by Anthropic under the lab's API account (commercial terms). The proxy logs time, status, model, size and the
person's name, never content. Do not use it for identifiable patient data unless your institution allows it.

## Revoking and limits

- A person leaves or a code leaks: `sudo flowstate-ai remove NAME` (or remove the line from `users.json`, then
  `sudo systemctl restart flowstate-ai`).
- Each person: `RATE_PER_MINUTE` (10) and `USER_MONTHLY_CAP`; the whole lab: `MONTHLY_CAP` and the console spend limit.
- Usage per person this month: `/opt/flowstate-ai/usage.json`.

## A hosted lab copy with the AI built in (optional)

If the lab opens FlowState from your web server behind a password, the page can use the proxy without anyone entering a
code: the web server adds the code itself, only for requests that passed the password.

1. A code for the website: `sudo flowstate-ai add web`. Put it into a file only root can read, e.g.
   `/etc/nginx/snippets/flowstate-ai-web.conf` (mode 600) with the line `proxy_set_header X-Lab-Passphrase "<code>";`.
2. Next to the protected page (here at `/flowstate/`), a path to the proxy that checks the same login, e.g. in nginx:

   ```nginx
   location /flowstate/ai/ {
     # the same login check as the page itself (cookie, Basic Auth ...); refuse with 401 otherwise
     proxy_pass http://127.0.0.1:8787/;
     proxy_http_version 1.1;
     proxy_buffering off;
     proxy_read_timeout 300s;
     proxy_set_header X-Forwarded-For $remote_addr;
     proxy_set_header Origin "https://your-site.example";   # one of ALLOWED_ORIGINS
     include /etc/nginx/snippets/flowstate-ai-web.conf;
   }
   ```

3. Build that copy with the proxy as its default:
   `VITE_LAB_PROXY_URL=/flowstate/ai VITE_LAB_PROXY_DEFAULT=1 npm run build:single`, and serve
   `artifact/flowstate-standalone.html` as the page. Its AI starts on the lab proxy; its settings are stored apart from
   a public copy on the same site.

Anyone who knows the page password can then spend the lab's budget: keep the monthly caps and the console spend limit
set. `sudo flowstate-ai remove web` switches the website's AI off again.
