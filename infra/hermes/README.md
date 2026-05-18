# `infra/hermes/` — Hermes shell-hooks deploy

This directory ships configuration for the Hermes agent (the Claude Code
harness running in the `hermes-agent-ekko` container on the VPS). Hermes is
not built from this repo — it's an external container with its own config
file at `/docker/hermes-agent-t4k4/data/config.yaml`. We can't deploy that
file via CI; the operator merges the patch by hand.

## What lives here

- `config.yaml.patch` — the YAML snippet to merge into Hermes' live config.
  Currently adds two shell-hooks:
  - `post_tool_call` (matcher: `kie_generate|elevenlabs_tts|submagic_caption|drive_upload|send_email`)
    — fires a non-blocking `curl` into the worker webhook so the dashboard
    can render tool-call activity in the pipeline timeline pane.
  - `on_session_end` — fires `POST .../session-end` so the dashboard knows
    when an Ekko chat session has wrapped (lets the chat UI clear the
    "thinking" indicator).

  Both hooks are **observers** — they do NOT gate tool execution. Approval
  gating for risky tools is handled by the separate
  `voxhorizon-approvals` plugin (HI-13).

## Why this isn't automated

Hermes' `config.yaml` is a single shared file owned by the upstream Hermes
container and edited by the operator for many concerns (Ekko skills config,
tool-call whitelists, MCP server settings, etc.). Auto-overwriting it would
clobber non-VoxHorizon settings. The operator applies our additions by
merging the patch's `hooks:` block into the live config.

The hooks themselves are smoke-tested at deploy time (step 6 below) — they
are NOT covered by repo unit tests because the test surface is
`docker exec hermes-agent-ekko hermes hooks doctor`, not Python.

## Deploy procedure

1. SSH into the VPS as `root` (or the deploy user with sudo).

2. Read the current Hermes config:

   ```bash
   sudo cat /docker/hermes-agent-t4k4/data/config.yaml
   ```

   Locate the top-level `hooks:` key (if any). Hermes accepts either no
   `hooks:` key, an empty mapping, or a mapping with one or more event
   types as children.

3. Merge the `hooks:` block from `infra/hermes/config.yaml.patch` into the
   live config:
   - If `hooks:` does NOT exist: append the entire `hooks:` block from
     `config.yaml.patch` verbatim at the end of the file.
   - If `hooks:` already exists and has a `post_tool_call:` list: append
     our matcher object to that list (matchers are independent). Same for
     `on_session_end:`.
   - If `hooks:` exists but has neither key yet: add both keys as children
     under it.

   YAML indentation matters — keep two spaces per level.

4. Add the two env vars to `/docker/hermes-agent-t4k4/.env`:

   ```
   DASHBOARD_WEBHOOK_URL=http://<worker-host>:8000/work/hermes/webhook
   DASHBOARD_WEBHOOK_TOKEN=<random 64-hex; same value as the worker's env>
   ```

   The token MUST match the worker's `DASHBOARD_WEBHOOK_TOKEN` env. The
   worker fails closed (HTTP 401) on any request whose `Authorization:
Bearer <token>` doesn't match. Generate the token once with
   `openssl rand -hex 32` and copy it into both `.env` files.

5. Restart Hermes so it loads the new hooks + env vars:

   ```bash
   docker restart hermes-agent-ekko
   ```

6. Validate the hooks parsed without syntax warnings:

   ```bash
   docker exec hermes-agent-ekko hermes hooks doctor
   ```

   You should see `post_tool_call` and `on_session_end` listed under
   "loaded hooks", with no warnings.

7. End-to-end smoke test — trigger a tool call that matches the
   `post_tool_call` matcher and confirm the worker webhook receives the
   POST. From the VPS:

   ```bash
   # Tail the worker's webhook log in one shell:
   docker compose -f /opt/dashboard-repo/docker-compose.yml logs -f worker \
     | grep webhook

   # In another shell, fire a trivial Hermes invocation that calls one of
   # the matched tools (kie_generate, elevenlabs_tts, etc.):
   docker exec hermes-agent-ekko hermes chat -q "run a tool that fires the post_tool_call hook"
   ```

   You should see a webhook log line within 5s of the tool call. If the
   worker logs an auth failure, recheck step 4 (both `.env` files must
   carry the same token).

## Troubleshooting

- `hermes hooks doctor` reports "unknown event type": you used an event
  name Hermes doesn't recognize. Cross-check the patch against the
  current Hermes hooks documentation — event names change between Hermes
  releases.
- Worker receives 0 webhook calls after a tool ran: check that the tool
  name actually matches the regex in the `post_tool_call.matcher`. The
  matcher is anchored as a regex; add the tool name with a `|` separator
  in `config.yaml` if not already covered.
- Hermes hangs after a tool call: shell hooks are fire-and-forget by
  design (`timeout: 5` caps each hook at 5s) — if Hermes is hanging,
  it's NOT these hooks. Check the approvals plugin (HI-13) instead.

## Pairs with

- `ekko-skills/dashboard-task-result/` — the canonical task lifecycle
  write. The hooks here are observability; the skill is state.
- `worker/src/services/hermes_webhook.py` — the worker-side receiver for
  the POSTs these hooks fire (HI-4).
