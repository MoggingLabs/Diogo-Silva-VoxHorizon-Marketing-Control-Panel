# Caddy reverse proxy

Caddy fronts the Next.js dashboard on the VPS container path:

```
browser -> Cloudflare (proxy ON, SSL/TLS Full strict)
        -> Caddy (Let's Encrypt cert, ports 80/443/443-udp)
        -> web:3000 (compose network, no public binding)
```

The worker has **no public hostname** under this topology — it is only reachable from inside the compose network (`web` calls `worker:8000` over the bearer-token-authenticated internal API). See "Worker access for debugging" below.

The Caddyfile lives at the repo root (`/Caddyfile`) and is bind-mounted read-only into the `caddy` service in `docker-compose.yml`. The site address is parameterised: `{$VOXHORIZON_DASHBOARD_HOST:dashboard.voxhorizon.example.com}`. Set `VOXHORIZON_DASHBOARD_HOST` in the compose env (or `/opt/voxhorizon/.env` on the VPS) to pick a hostname; the default fallback is the placeholder `dashboard.voxhorizon.example.com` so an unconfigured stack never tries to obtain a real cert.

---

## Local development

You do **not** need Caddy to run the dashboard locally. The dev workflow is unchanged from the Mac path:

- Run the worker directly (`bash scripts/serve.sh` from `worker/`) and hit it at `http://localhost:8000`.
- Run the Next.js app at `http://localhost:3000`. It talks to the worker over plaintext loopback. No TLS, no reverse proxy, no Cloudflare.

You should only need to exercise Caddy locally when reproducing a TLS-specific or SSE-buffering bug. Two ways:

### Option A — `caddy run` against a local hostname (recommended)

This skips Docker and uses Caddy's built-in dev workflow.

1. Install Caddy: `brew install caddy` (Mac) or follow https://caddyserver.com/docs/install.
2. From the repo root:

   ```bash
   VOXHORIZON_DASHBOARD_HOST=dashboard.localhost caddy run --config Caddyfile
   ```

3. Caddy serves at `https://dashboard.localhost`. It auto-installs its local CA into your trust store on first run (Mac will prompt for sudo); browsers then trust the self-signed cert.
4. Make sure the dashboard is running on `localhost:3000` — Caddy's `reverse_proxy web:3000` directive resolves `web` via your DNS, so add `127.0.0.1 web` to `/etc/hosts` _or_ edit the Caddyfile locally to `reverse_proxy localhost:3000` (don't commit that edit).

### Option B — `docker compose up caddy web worker` against `.localhost`

If you want to test the exact production wiring:

1. Set `VOXHORIZON_DASHBOARD_HOST=dashboard.localhost` in a `.env` next to `docker-compose.yml`.
2. `docker compose up --build web worker caddy` (worker stays internal — it's only there because `web` calls into it).
3. Caddy uses its **internal** issuer for `.localhost` (no public ACME call). You'll need to import Caddy's root cert (`docker exec <caddy> cat /data/caddy/pki/authorities/local/root.crt`) into your trust store to silence browser warnings.
4. The site is reachable at `https://dashboard.localhost`.

The Caddyfile itself is identical between dev and prod — only `VOXHORIZON_DASHBOARD_HOST` and the Cloudflare wiring change.

---

## Production handoff

When deploying to the VPS:

1. **DNS.** Cloudflare → DNS → add A record `dashboard.voxhorizon.com` → VPS public IP. Proxy status: **ON** (orange cloud). Do **not** add a public record for the worker — it stays internal.
2. **TLS mode.** Cloudflare → SSL/TLS → Overview → set mode to **Full (strict)**. This makes Cloudflare validate Caddy's Let's Encrypt cert end-to-end instead of accepting self-signed (Full) or skipping TLS to origin entirely (Flexible).
3. **VPS env.** Set `VOXHORIZON_DASHBOARD_HOST=dashboard.voxhorizon.com` in `/opt/voxhorizon/.env` (chmod 600, owner `deploy`). The compose stack picks it up via `${VOXHORIZON_DASHBOARD_HOST}` substitution.
4. **Firewall.** The VPS host firewall must allow inbound TCP 80, TCP 443, and UDP 443 (HTTP/3). Outbound must reach Let's Encrypt (`acme-v02.api.letsencrypt.org`) for ACME issuance/renewal.
5. **First boot.** `docker compose up -d`. Watch `docker compose logs -f caddy` — you should see an ACME challenge succeed and `certificate obtained successfully` within a few seconds.
6. **Smoke test.** From outside the VPS: `curl -sS https://dashboard.voxhorizon.com/` — should return the dashboard HTML (or the configured login redirect). From a browser: open `https://dashboard.voxhorizon.com/` and confirm the app loads end-to-end.

---

## Worker access for debugging

The worker has no public hostname under this topology — Caddy only fronts the dashboard, and the worker is reachable only from inside the compose network. To probe `/work/*` endpoints during incident response:

1. SSH into the VPS.
2. From `web` (which has `WORKER_SHARED_SECRET` in its environment, so you don't need to copy the bearer out by hand):

   ```bash
   docker compose exec web sh -c 'curl -fsS -H "Authorization: Bearer $WORKER_SHARED_SECRET" http://worker:8000/work/health'
   ```

3. Or, from inside the worker container itself (skips the auth check entirely since you're already on the same loopback as the FastAPI process):

   ```bash
   docker compose exec worker curl -fsS http://localhost:8000/work/health
   ```

If you need to inspect the worker from outside the VPS, prefer an SSH tunnel (`ssh -L 8000:worker:8000 voxhorizon-vps`) over exposing a hostname — the worker's only authn is a shared secret and is not designed to be internet-facing.

---

## SSE streaming preservation

The Caddyfile's `reverse_proxy` block sets `flush_interval -1`. This is critical for the chat-with-Ekko SSE endpoint.

Under the dashboard-fronted topology, SSE flows are: **browser → Caddy → `web:3000` (Next.js API route, e.g. `/api/creatives/[id]/chat` or `/api/pipelines/[id]/config/draft`) → `worker:8000` (FastAPI `StreamingResponse`)**. Caddy's job is to forward chunks from `web` to the browser without buffering — the Next.js route is itself a transparent passthrough of the worker's SSE stream.

By default, Caddy buffers small response writes before flushing them to the client to reduce syscall overhead. For SSE that means tokens emitted by the worker (and forwarded by `web`) pile up in Caddy's proxy buffer and arrive at the browser in a single chunk when the agent turn ends — defeating the streaming UX.

`flush_interval -1` tells Caddy: _flush after every write_. Combined with FastAPI's `StreamingResponse` and the Next.js route's `ReadableStream` passthrough, this gives the browser sub-100ms token latency end-to-end.

If you ever see chat tokens "thunking" in at the end of a turn instead of streaming, the first thing to check is whether something has accidentally removed or overridden `flush_interval -1` (then verify the Next.js route isn't accidentally `await response.text()`-ing the upstream).

---

## Monitoring

- **Access logs.** JSON, rotated at 50 MB, 5 files kept. Written to `/var/log/caddy/access.log` inside the container; persisted to the `voxhorizon-caddy-logs` named volume. `docker compose logs caddy` shows stdout/stderr (admin events, ACME activity).
- **Cert expiry.** Caddy renews ~30 days before expiry automatically. Watch for "could not renew certificate" lines in `docker compose logs caddy`. The cert state lives in `voxhorizon-caddy-data`.
- **External uptime probe.** Uptime Robot (configured in `infra/monitoring/`) hits `https://dashboard.voxhorizon.com/` every 5 minutes — TLS failures, DNS failures, and 5xx from Caddy all surface there.
