#!/usr/bin/env bash
# Install the FlowState lab AI proxy on a Linux server with systemd and nginx (Debian / Ubuntu).
#   sudo ./install.sh [domain] [origin]        e.g. sudo ./install.sh ai.your-lab.example https://flowstate.your-lab.example
#   another port at the first install (8787 taken):  sudo PORT_OVERRIDE=8788 ./install.sh ...
# Running it again updates ai-proxy.mjs and the admin command; settings, codes, port and nginx file are kept.
# Until the first code is added (flowstate-ai add NAME) the proxy refuses every request.
# Adds only its own files: /opt/flowstate-ai, /etc/flowstate-ai, /etc/systemd/system/flowstate-ai.service,
# /etc/nginx/sites-available/flowstate-ai (+ link in sites-enabled), /usr/local/bin/flowstate-ai.
# Existing sites, nginx files and services are not changed. Safe to run again (existing settings are kept).
# The API key is NOT asked here: afterwards run `sudo flowstate-ai setkey` in your own terminal (typed hidden).
set -euo pipefail

DOMAIN="${1:-ai.your-lab.example}"
ORIGIN="${2:-https://flowstate.your-lab.example}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# port of the proxy on 127.0.0.1: the one set at the first install, else $PORT_OVERRIDE, else 8787
PORT="$(grep -E '^PORT=' /etc/flowstate-ai/env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-${PORT_OVERRIDE:-8787}}"

[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
command -v node >/dev/null || { echo "Node.js 18 or newer is needed (e.g. apt install nodejs)."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node.js $NODE_MAJOR is too old: 18 or newer is needed."; exit 1; }
[ -f "$HERE/ai-proxy.mjs" ] || { echo "ai-proxy.mjs not found next to install.sh."; exit 1; }
if ss -ltn 2>/dev/null | grep -q ":$PORT " && ! systemctl is-active --quiet flowstate-ai; then
  echo "Port $PORT is used by another program: run again with PORT_OVERRIDE=<free port>."; exit 1
fi

# service user and files
id flowstate-ai >/dev/null 2>&1 || useradd --system --home /opt/flowstate-ai --shell /usr/sbin/nologin flowstate-ai
install -d -o flowstate-ai -g flowstate-ai -m 750 /opt/flowstate-ai
install -o root -g flowstate-ai -m 644 "$HERE/ai-proxy.mjs" /opt/flowstate-ai/ai-proxy.mjs
install -d -o root -g flowstate-ai -m 750 /etc/flowstate-ai
if [ ! -f /etc/flowstate-ai/env ]; then
  umask 027
  cat > /etc/flowstate-ai/env <<ENV
ANTHROPIC_API_KEY=
ANTHROPIC_WORKSPACE_ID=
ALLOWED_ORIGINS=$ORIGIN
LAB_USERS_FILE=/etc/flowstate-ai/users.json
MODELS=claude-sonnet-5-5,claude-haiku-5-5
RATE_PER_MINUTE=10
USER_MONTHLY_CAP=500
MONTHLY_CAP=3000
HOST=127.0.0.1
PORT=$PORT
TRUST_PROXY=1
USAGE_FILE=/opt/flowstate-ai/usage.json
LOG_SALT=$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')
ENV
  chown root:flowstate-ai /etc/flowstate-ai/env
  chmod 640 /etc/flowstate-ai/env
fi
[ -f /etc/flowstate-ai/users.json ] || { echo '{}' > /etc/flowstate-ai/users.json; chown root:flowstate-ai /etc/flowstate-ai/users.json; chmod 640 /etc/flowstate-ai/users.json; }
install -o root -g root -m 755 "$HERE/flowstate-ai" /usr/local/bin/flowstate-ai

cat > /etc/systemd/system/flowstate-ai.service <<'UNIT'
[Unit]
Description=FlowState lab AI proxy
After=network-online.target
Wants=network-online.target

[Service]
User=flowstate-ai
Group=flowstate-ai
EnvironmentFile=/etc/flowstate-ai/env
ExecStart=/usr/bin/env node /opt/flowstate-ai/ai-proxy.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/flowstate-ai

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable flowstate-ai >/dev/null 2>&1
# started once a key is set (flowstate-ai setkey); restarted when it already runs (update)
if grep -q '^ANTHROPIC_API_KEY=.\+' /etc/flowstate-ai/env; then systemctl restart flowstate-ai; fi

# nginx: a server block of its own for the proxy's name
if command -v nginx >/dev/null; then
  SITE=/etc/nginx/sites-available/flowstate-ai
  if [ ! -f "$SITE" ]; then
    cat > "$SITE" <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;
  location / {
    proxy_pass http://127.0.0.1:$PORT/;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 300s;
    proxy_set_header X-Forwarded-For \$remote_addr;
    client_max_body_size 10m;
  }
}
NGINX
  fi
  ln -sfn "$SITE" /etc/nginx/sites-enabled/flowstate-ai
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
  else
    rm -f /etc/nginx/sites-enabled/flowstate-ai
    echo "nginx -t failed with the new site: it was disabled again, nginx was not reloaded."; nginx -t || true; exit 1
  fi
  # a site file from an older install is kept as it is: point out a missing X-Forwarded-For line (TRUST_PROXY=1 would
  # otherwise take the address from a header the client chose, and the per-address rate limit could be dodged)
  if ! grep -q 'proxy_set_header X-Forwarded-For' "$SITE"; then
    echo "Note: $SITE does not set X-Forwarded-For. Add this line to each of its 'location /' blocks:"
    echo "    proxy_set_header X-Forwarded-For \$remote_addr;"
    echo "then: sudo nginx -t && sudo systemctl reload nginx"
  fi
fi

# without any code (and no LAB_PASSPHRASE) the proxy refuses every request: say so instead of looking broken
NO_CODES=""
if [ "$(node -e 'try { process.stdout.write(String(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "{}")).length)) } catch { process.stdout.write("0") }' /etc/flowstate-ai/users.json)" = 0 ] \
  && ! grep -q '^LAB_PASSPHRASE=.\+' /etc/flowstate-ai/env && ! grep -q '^LAB_USERS=.\+' /etc/flowstate-ai/env; then
  NO_CODES="
No access code exists yet: until step 4 the proxy refuses every request (401)."
fi

cat <<DONE

Installed. Next:
  1. DNS: $DOMAIN must point to this server.
  2. HTTPS for $DOMAIN, the same way as the other sites of this server (e.g. sudo certbot --nginx -d $DOMAIN).
  3. In your own terminal (the key is typed hidden, it never appears in a log or chat):
       sudo flowstate-ai setkey
  4. One code per labmate:   sudo flowstate-ai add alex
  5. Check:                  sudo flowstate-ai status ; sudo flowstate-ai test alex
In FlowState: AI settings > Lab proxy, URL https://$DOMAIN, then the person's code.$NO_CODES
To update the proxy later: copy the new folder to the server and run this script again.
DONE
