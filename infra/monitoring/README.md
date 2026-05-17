# Monitoring

External monitoring for the VoxHorizon Marketing Control Panel. v1 is a single-operator system on a single VPS — the threat model is "the box fell over and Diogo didn't notice for two days." This doc covers the cheap, third-party watchdogs that fix that.

All accounts in this doc live under **`diogosilvaenterprise@gmail.com`**. See [`SECRETS.md`](../../SECRETS.md) for credential storage conventions.

---

## At a glance

| Layer           | Tool                 | What it watches                     | Free?            | Alert channel                     |
| --------------- | -------------------- | ----------------------------------- | ---------------- | --------------------------------- |
| Public HTTP     | Uptime Robot         | `https://worker.<domain>/work/ping` | Yes (5-min poll) | Email                             |
| Cron heartbeats | Healthchecks.io      | Each scheduled job pings on success | Yes (20 checks)  | Email                             |
| Vendor uptime   | Supabase status page | Supabase platform incidents         | Yes              | Status page + Uptime Robot mirror |

The three are independent on purpose: a single provider outage (incl. Uptime Robot itself) shouldn't blind us.

---

## 1. Uptime Robot — `/work/ping` HTTP monitor

Uptime Robot polls a public HTTP endpoint on a fixed interval. We point it at the **unauthenticated** `/work/ping` route added in VPS-6 (`worker/src/routes/ping.py`). That route returns `{"ok": true}` with no version / env info, so leaking it publicly is harmless.

### Setup

1. Go to https://uptimerobot.com and sign in (or create an account) using `diogosilvaenterprise@gmail.com`. Free tier is sufficient: 50 monitors, 5-minute polling.
2. Dashboard → **+ New Monitor**.
3. Fill in:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** `VoxHorizon worker — /work/ping`
   - **URL:** `https://worker.<your-domain>/work/ping`
     (substitute the production Caddy hostname — see [`SECRETS.md`](../../SECRETS.md) for the canonical mapping)
   - **Monitoring Interval:** 5 minutes (free-tier floor; bump to 1 min if upgraded)
   - **Monitor Timeout:** 30 seconds
   - **HTTP Method:** GET
   - **Keyword monitoring (optional but recommended):** Enable, look for `"ok": true` — that way a 200 with a corrupted body still alerts.
4. Under **Select Alert Contacts To Notify**: tick the default email contact for `diogosilvaenterprise@gmail.com`. (If it's not set, add it under My Settings → Alert Contacts → Add Alert Contact first, then come back.)
5. **Create Monitor.** Confirm the first check turns green within 5 minutes.

### Status page (optional)

Uptime Robot can expose a public-ish status page that aggregates the monitors. For a single-operator project that's overkill; skip unless we ever need to show a partner.

### Verify it actually pages

Once a quarter, deliberately break it:

```bash
ssh deploy@<vps>
docker compose stop worker
# wait 10 min — confirm the email lands
docker compose start worker
```

If the email doesn't arrive, fix the alert contact before you need it.

---

## 2. Healthchecks.io — cron heartbeats

Healthchecks.io works backwards from Uptime Robot: each scheduled job pings a unique URL **on success**, and Healthchecks alerts if no ping arrives within the expected window. This is the right pattern for the audit / GHL / fatigue cron jobs (revised under #59 from launchd / on-Mac scheduling to **systemd timers on the VPS**).

### Setup

1. Go to https://healthchecks.io and sign in / sign up with `diogosilvaenterprise@gmail.com`. Free tier: 20 checks, 1-minute granularity, unlimited integrations.
2. Dashboard → **Add Check** for each scheduled job. Suggested initial set (one check each):
   - `meta-ads-pull` — every 15 min (grace 10 min)
   - `ghl-leads-pull` — every 15 min (grace 10 min)
   - `audit-image` — daily at 09:00 UTC (grace 1 hr)
   - `audit-video` — daily at 09:15 UTC (grace 1 hr)
   - `fatigue-sweep` — daily at 09:30 UTC (grace 1 hr)
3. Copy each check's **Ping URL** (looks like `https://hc-ping.com/<uuid>`).
4. In the systemd unit / wrapper script for each job, append a success ping. Two patterns:

   **Wrapper-script style** (no code change to the job):

   ```bash
   # /etc/voxhorizon/cron/run-meta-pull.sh
   set -euo pipefail
   docker compose exec -T worker python -m src.jobs.meta_ads_pull
   curl -fsS -m 10 --retry 3 https://hc-ping.com/<uuid> > /dev/null
   ```

   **In-worker style** (uses the helpers added in VPS-6):

   ```python
   # at the end of a successful job run
   from src.services.heartbeat import log_success
   log_success("meta-ads-pull")
   # then ping Healthchecks.io with httpx / requests
   ```

   The `sync_log` table (`db/migrations/0001_initial_schema.sql`) gives us a local history beyond Healthchecks' retention; the external ping is what actually triggers the alert.

5. Under **Integrations**, attach the email channel for `diogosilvaenterprise@gmail.com`. Optionally also a Slack / SMS channel — those are upgrades, not v1 requirements.

### Why two systems

- **Uptime Robot** = "is the worker reachable from the outside?" (Caddy + Docker + the Python process up?)
- **Healthchecks.io** = "are scheduled jobs actually running and finishing?" (cron + the integration code + the upstream APIs reachable?)

Both can fail without the other catching it. We need both.

---

## 3. Supabase status page

Supabase has its own public status page at https://status.supabase.com. When the platform has an incident — pooler down, storage degraded, dashboard offline — it shows up there before our app surfaces it as 5xx.

Two things to do:

1. **Subscribe to incident emails.** Visit https://status.supabase.com → "Subscribe to Updates" → enter `diogosilvaenterprise@gmail.com`. Free, zero-config.
2. **Add it to Uptime Robot as a third independent monitor.** Treat the status page itself as a poll target (HTTP keyword: look for `"All Systems Operational"` if you want to alert on Supabase incidents that flip the page). This is belt-and-suspenders — if Supabase's email gateway is also impacted, Uptime Robot still tells you.

---

## Alert runbook

When an alert fires (Uptime Robot or Healthchecks), the response is the same regardless of source.

### Step 1 — SSH in

```bash
ssh deploy@<vps-host>
cd /opt/voxhorizon         # or wherever the compose file lives
```

### Step 2 — Look at the worker

```bash
docker compose logs --tail=100 worker
docker compose ps
```

`docker compose ps` shows whether the container is running, restarting, or exited. The recent log tail almost always points at the cause.

### Step 3 — Map the symptom to a known failure mode

| Symptom in logs                                           | Likely cause                                 | Fix                                                                                            |
| --------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `kie.ai` HTTP 429 / `Too Many Requests`                   | Provider rate limit                          | Wait it out; if persistent, throttle the image queue (see `worker/src/services/queue.py`).     |
| `supabase` connection refused / DNS fail / 5xx            | Supabase incident or egress block            | Check https://status.supabase.com; check VPS egress firewall.                                  |
| Container exit code 137 / "OOMKilled" in `docker inspect` | Memory limit too tight                       | Bump `mem_limit` in `docker-compose.yml`; investigate leak before bumping repeatedly.          |
| `Invalid bearer token` 401s on every internal call        | `WORKER_SHARED_SECRET` mismatch after rotate | Vercel env + worker `.env` got out of sync; redeploy both with the new value (see SECRETS.md). |
| Worker reachable but `/work/health` 5xx, `/work/ping` 200 | Auth / Supabase init broke at startup        | `docker compose logs worker                                                                    | head -50` for the boot trace; usually a missing env var. |
| `Connection reset` from Caddy, worker is up               | Caddy → worker network broken or cert expiry | `docker compose logs caddy --tail=100`; check cert expiry (see "Not monitored" below).         |

### Step 4 — Restart sequence

```bash
docker compose up -d worker
```

This re-uses the existing image and re-creates only the worker container, preserving the running Caddy / Postgres / etc. If logs show the image itself is broken, pull a fresh one first:

```bash
docker compose pull worker && docker compose up -d worker
```

### Step 5 — Verify and close the loop

```bash
curl -fsS https://worker.<your-domain>/work/ping
# expect: {"ok":true}
```

Then watch Uptime Robot / Healthchecks for the next two intervals to confirm green. Note the incident in the project tracker so the failure mode shows up in the post-mortem rhythm.

---

## What's NOT monitored yet

Follow-ups, in rough priority order. None of these block v1, but they're known gaps:

- **Per-job heartbeats wired into the worker.** The building blocks exist (`worker/src/services/heartbeat.py`, the `sync_log` table) but no cron job calls `log_success` yet. Lands with #59 (systemd timers).
- **Browser Web Push delivery.** We send pushes via VAPID, but there's no canary that proves a real subscriber received one. Possible probe: an automated test subscription endpoint + a synthetic push + a webhook to confirm.
- **Caddy cert expiry.** Caddy auto-renews via ACME, but a stuck renewal silently expires the cert in 90 days. Add a separate Uptime Robot **SSL Expiry** monitor on `https://worker.<your-domain>` (free tier supports it). Alerts 30 days out.
- **Supabase quota burn.** Storage egress + database compute hit free-tier ceilings. The Supabase dashboard shows it; no external alert is wired.
- **Disk / RAM on the VPS itself.** Out of scope for app-level monitoring — handle via the host provider's built-in metrics or `node_exporter` if/when we add Prometheus.
- **Tailscale Funnel** (legacy path, prior to the Caddy migration). If we ever fall back to Funnel for any service, add a separate monitor for that hostname too.

---

## Cross-references

- Public probe implementation: [`worker/src/routes/ping.py`](../../worker/src/routes/ping.py)
- Authed counterpart with richer info: [`worker/src/routes/health.py`](../../worker/src/routes/health.py)
- Heartbeat helpers: [`worker/src/services/heartbeat.py`](../../worker/src/services/heartbeat.py)
- `sync_log` schema: [`db/SCHEMA.md`](../../db/SCHEMA.md#sync_log)
- Credential conventions: [`SECRETS.md`](../../SECRETS.md)
