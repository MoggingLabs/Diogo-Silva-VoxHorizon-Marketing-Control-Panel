"""Fan-out helper for Hermes approval notifications (HI-17 → Slack pivot).

After a fresh ``approvals`` row is inserted by :mod:`hermes_approval`, this
module is called fire-and-forget to notify the operator across two channels:

* **Always**: VAPID web push to every subscribed browser. The push surfaces
  a clickable notification that deep-links to ``/approvals/{id}``. Delivered
  via :func:`services.push_delivery.fanout_push` so we never reinvent the
  pywebpush envelope, the 404/410 cleanup, or the subscription iteration.

* **High-urgency only**: a Block Kit message to a single Slack channel via
  ``chat.postMessage``. The bot is `Ekko` (display name) in the
  ``voxhorizon-internal`` workspace; the channel is ``mkt-dept-updates``.
  Posts surface tool name, sanitized arg preview, estimated cost, and a
  primary CTA back to ``{DASHBOARD_BASE_URL}/approvals/{id}``.

Why Slack and not Resend? The previous implementation rendered a
``react-email`` template on the Next.js side and shipped via Resend. The
operator now lives in Slack daily — surfacing high-urgency approvals
where attention already is shortens response time. The Resend code path
(Next.js route + React template) stays in the tree as dormant code so
the pivot is reversible by flipping a future config flag.

High-urgency classification
---------------------------
Either signal flips the row to "high":

* ``risk_class == "external-write"`` — any tool that writes to a third
  party (Meta Ads, GHL, Drive, etc.). Spend may be zero but the blast
  radius is.
* ``context.estimated_cost > 50.0`` — the agent itself reports a cost
  estimate via the plugin. We pick $50 as the operator-attention floor.

Failure semantics
-----------------
This whole module is best-effort. The caller (``hermes_approval``) wraps
:func:`fan_out` in a ``try`` so a notification failure never breaks the
long-poll — the badge still updates via Supabase Realtime regardless,
which is the actual source of truth for the dashboard's "approval pending"
state. We log warnings rather than raise.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx
import structlog

from .push_delivery import PushPayload, fanout_push


log = structlog.get_logger(__name__)


#: Cost threshold above which an approval is treated as high-urgency. The
#: HI-17 spec calls for "spend > $50 estimated" — we use strict greater-than
#: so $50.00 itself does NOT trigger a Slack post (operator-defined floor).
HIGH_URGENCY_COST_THRESHOLD = 50.0

#: Risk classes considered high-urgency regardless of cost.
HIGH_URGENCY_RISK_CLASSES = frozenset({"external-write"})

#: Notification kind dispatched to the Service Worker. ``public/sw.js``
#: doesn't switch on kind — it just shows the title/body/url — but we
#: still tag it so the in-app notification feed can group these correctly.
APPROVAL_PUSH_KIND = "approval_pending"

#: Slack Web API endpoint. The chat.postMessage call requires
#: ``Authorization: Bearer <bot_token>`` and a JSON body containing at
#: minimum ``{channel, text}``. We always send ``blocks`` as well for the
#: rich layout; ``text`` is kept as the screenreader/notification fallback.
SLACK_API_URL = "https://slack.com/api/chat.postMessage"

#: Timeout for the Slack HTTP call. Slack typically responds in <500ms but
#: we cap conservatively — this is fire-and-forget, so if Slack stalls we
#: prefer moving on to blocking the worker's fan-out task.
SLACK_TIMEOUT_S = 10.0

#: Default dashboard base URL used in the CTA button when
#: ``DASHBOARD_BASE_URL`` is unset.
DEFAULT_DASHBOARD_BASE_URL = "https://dashboard.voxhorizon.com"

#: Truncation budget for the tool_args preview shown in the Slack block.
#: Slack's section block text limit is 3000 chars, but operators read these
#: at a glance — anything past ~600 chars is noise.
_MAX_ARGS_PREVIEW_CHARS = 600

#: Cost above which the message is decorated as alarm-level (red siren).
_COST_DANGER_THRESHOLD = 100.0

#: Regex used to redact sensitive keys before serializing tool_args into
#: the Slack message. We match against the KEY name, not the value, because
#: a value-based scrub would have to be schema-aware. Common naming
#: conventions covered: ``api_key``, ``apikey``, ``api-key``, ``secret``,
#: ``token``, ``password``, ``bot_token``, etc. Case-insensitive.
SENSITIVE_KEY_RE = re.compile(r"(token|secret|password|api[_-]?key)", re.I)


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def is_high_urgency(row: dict[str, Any]) -> bool:
    """Decide whether an approval should also trigger a Slack post.

    Args:
        row: The ``approvals`` row dict — at minimum ``risk_class`` and
            ``context`` are inspected. Missing / null values default to
            "not high urgency".

    Returns:
        ``True`` if the row should fire a Slack post, ``False`` otherwise.

    Examples:
        >>> is_high_urgency({"risk_class": "external-write"})
        True
        >>> is_high_urgency({"context": {"estimated_cost": 51.0}})
        True
        >>> is_high_urgency({"context": {"estimated_cost": 50.0}})
        False
        >>> is_high_urgency({"risk_class": "filesystem"})
        False
    """
    risk = row.get("risk_class")
    if isinstance(risk, str) and risk in HIGH_URGENCY_RISK_CLASSES:
        return True

    ctx = row.get("context") or {}
    if not isinstance(ctx, dict):
        return False

    cost_raw = ctx.get("estimated_cost")
    if cost_raw is None:
        return False
    try:
        cost = float(cost_raw)
    except (TypeError, ValueError):
        return False
    return cost > HIGH_URGENCY_COST_THRESHOLD


# ---------------------------------------------------------------------------
# Push payload construction
# ---------------------------------------------------------------------------


def _build_push_payload(row: dict[str, Any]) -> PushPayload:
    """Shape a :class:`PushPayload` from an approvals row.

    Matches the ``WebPushBody`` shape consumed by ``public/sw.js`` — title
    + body + url + kind. We keep the body short because the push service
    caps payloads at ~4KB after encryption.
    """
    tool_name = str(row.get("tool_name") or "tool")
    ctx = row.get("context") or {}
    skill_name = ""
    if isinstance(ctx, dict):
        raw_skill = ctx.get("skill_name")
        if isinstance(raw_skill, str):
            skill_name = raw_skill

    risk = row.get("risk_class") or "review"
    body_pieces = [str(risk)]
    if skill_name:
        body_pieces.append(skill_name)
    body = " • ".join(p for p in body_pieces if p).strip()

    approval_id = str(row.get("id") or "")
    url = f"/approvals/{approval_id}" if approval_id else "/approvals"

    return PushPayload(
        title=f"Approval needed: {tool_name}",
        body=body,
        url=url,
        kind=APPROVAL_PUSH_KIND,
    )


# ---------------------------------------------------------------------------
# Slack payload construction
# ---------------------------------------------------------------------------


def _sanitize_args(args: Any, _seen: set[int] | None = None) -> Any:
    """Recursively replace values under sensitive-named keys with a marker.

    The Slack message renders ``tool_args`` for the operator's eyes only,
    but Slack channels are logged + indexed by Slack — anything we post
    becomes part of the workspace's permanent record. To avoid leaking
    bot tokens, API keys, or operator passwords if an upstream caller
    ever puts one into ``tool_args`` by accident, we redact values whose
    KEYS match :data:`SENSITIVE_KEY_RE`. The value itself is never
    inspected (which would require schema knowledge).

    Lists are walked element-wise; scalars pass through unchanged. The
    output is deep-copied implicitly via dict/list comprehensions so the
    caller's original ``tool_args`` is not mutated.

    ``_seen`` is an internal set of ``id()`` values used to break circular
    references — a self-referential dict would otherwise blow the
    recursion limit. Cycles collapse to the literal string
    ``"<circular>"`` rather than raising.
    """
    if _seen is None:
        _seen = set()
    if isinstance(args, (dict, list)):
        oid = id(args)
        if oid in _seen:
            return "<circular>"
        _seen = _seen | {oid}
    if isinstance(args, dict):
        return {
            k: (
                "<redacted>"
                if isinstance(k, str) and SENSITIVE_KEY_RE.search(k)
                else _sanitize_args(v, _seen)
            )
            for k, v in args.items()
        }
    if isinstance(args, list):
        return [_sanitize_args(x, _seen) for x in args]
    return args


def _dashboard_url(approval_id: str) -> str:
    """Compose the absolute dashboard URL for the ``View in dashboard`` CTA.

    Reads ``DASHBOARD_BASE_URL`` from env, falling back to
    :data:`DEFAULT_DASHBOARD_BASE_URL`. Trailing slashes on the env value
    are tolerated; an empty ``id`` collapses to the queue listing.
    """
    base = os.environ.get("DASHBOARD_BASE_URL")
    if base is None or not base.strip():
        base = DEFAULT_DASHBOARD_BASE_URL
    base = base.rstrip("/")
    if not approval_id:
        return f"{base}/approvals"
    return f"{base}/approvals/{approval_id}"


def _format_cost(cost: float) -> str:
    """Format the cost as a human-readable USD string."""
    if cost >= 100.0:
        # Whole-dollar precision is enough at this magnitude.
        return f"${cost:,.0f}"
    return f"${cost:,.2f}"


def _build_text_fallback(row: dict[str, Any]) -> str:
    """Compose the screen-reader / notification ``text`` for the Slack post.

    Slack uses ``text`` as the notification body on desktop / mobile,
    and as the screenreader content when ``blocks`` are present. Keep
    it under ~150 chars and self-describing.
    """
    tool_name = str(row.get("tool_name") or "tool")
    risk = row.get("risk_class")
    ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
    cost_raw = ctx.get("estimated_cost") if isinstance(ctx, dict) else None
    parts = [f"Approval needed: {tool_name}"]
    if isinstance(risk, str) and risk:
        parts.append(f"risk={risk}")
    if cost_raw is not None:
        try:
            parts.append(f"est_cost={_format_cost(float(cost_raw))}")
        except (TypeError, ValueError):
            pass
    return " • ".join(parts)


def _build_blocks(row: dict[str, Any]) -> list[dict[str, Any]]:
    """Build the Block Kit message body for a high-urgency approval.

    Layout (top to bottom):

    1. ``header`` — ``Approval needed: {tool_name}`` with a leading icon
       indicating WHY the row is high-urgency (siren for external-write,
       money bag for cost-driven). Header text is plain-text only by
       Block Kit spec, so the icon is a single emoji char.
    2. ``section`` (mrkdwn) — context fields rolled into a single
       multi-line string. Only emits keys that are non-empty.
    3. ``section`` (mrkdwn) — estimated cost, bolded; prefixed with a
       siren emoji + ``HIGH SPEND`` marker when the value exceeds
       :data:`_COST_DANGER_THRESHOLD`.
    4. ``section`` (mrkdwn) — sanitized + truncated ``tool_args`` JSON,
       wrapped in a triple-backtick code fence.
    5. ``actions`` — single primary button linking to the dashboard
       approval detail page (env: ``DASHBOARD_BASE_URL``).
    """
    approval_id = str(row.get("id") or "")
    tool_name = str(row.get("tool_name") or "tool")
    risk = row.get("risk_class")
    ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
    if not isinstance(ctx, dict):
        ctx = {}

    # Header icon picks the dominant urgency signal: external-write wins
    # over cost (it's the broader-impact flag).
    if isinstance(risk, str) and risk in HIGH_URGENCY_RISK_CLASSES:
        icon = "⚠️"  # ⚠️
    else:
        icon = "\U0001f4b0"  # 💰
    header_text = f"{icon} Approval needed: {tool_name}"
    # Header block text has a 150-char limit; truncate defensively.
    if len(header_text) > 150:
        header_text = header_text[:147] + "..."

    blocks: list[dict[str, Any]] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": header_text, "emoji": True},
        }
    ]

    # Context section — only emit lines for fields we actually have.
    context_lines: list[str] = []
    pipeline_id = ctx.get("pipeline_id") or ctx.get("pipeline_name")
    brief_id = ctx.get("brief_id") or ctx.get("brief_id_human")
    creative_id = ctx.get("creative_id")
    skill_name = ctx.get("skill_name")
    session_id = row.get("ekko_session_id")
    if pipeline_id:
        context_lines.append(f"*Pipeline:* {pipeline_id}")
    if brief_id:
        context_lines.append(f"*Brief:* {brief_id}")
    if creative_id:
        context_lines.append(f"*Creative:* {creative_id}")
    if skill_name:
        context_lines.append(f"*Skill:* {skill_name}")
    if session_id:
        context_lines.append(f"*Session:* {session_id}")
    if isinstance(risk, str) and risk:
        context_lines.append(f"*Risk:* {risk}")
    if context_lines:
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "\n".join(context_lines)},
            }
        )

    # Cost section — only when set + numeric. When > $100, decorate as
    # alarm-level so it stands out even from other high-urgency posts.
    cost_raw = ctx.get("estimated_cost")
    if cost_raw is not None:
        try:
            cost = float(cost_raw)
        except (TypeError, ValueError):
            cost = None
        if cost is not None:
            formatted = _format_cost(cost)
            if cost > _COST_DANGER_THRESHOLD:
                cost_text = f"\U0001f6a8 *HIGH SPEND: {formatted}*"
            else:
                cost_text = f"*Estimated cost:* {formatted}"
            blocks.append(
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": cost_text},
                }
            )

    # Args preview — sanitize, JSON-serialize, truncate, code-fence.
    tool_args = row.get("tool_args") or {}
    sanitized = _sanitize_args(tool_args)
    try:
        args_json = json.dumps(sanitized, indent=2, default=str)
    except (TypeError, ValueError):
        args_json = repr(sanitized)
    if len(args_json) > _MAX_ARGS_PREVIEW_CHARS:
        args_json = args_json[:_MAX_ARGS_PREVIEW_CHARS] + "..."
    blocks.append(
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"```{args_json}```"},
        }
    )

    # Primary CTA — single button, linking to the dashboard detail page.
    blocks.append(
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {
                        "type": "plain_text",
                        "text": "Open in dashboard",
                        "emoji": True,
                    },
                    "style": "primary",
                    "url": _dashboard_url(approval_id),
                    "action_id": "open_approval",
                }
            ],
        }
    )

    return blocks


# ---------------------------------------------------------------------------
# Slack HTTP call
# ---------------------------------------------------------------------------


def _slack_config() -> tuple[str | None, str | None]:
    """Read the Slack bot token + channel ID from env.

    Returns ``(token, channel_id)``. Either side being None means the
    Slack fan-out is disabled — the worker logs and moves on rather than
    raising. Whitespace-only values count as unset.

    The token is sourced at deploy time from
    ``/docker/hermes-shared/config/secrets.json`` (the ``EKKO_SLACK_BOT_TOKEN``
    field) and surfaced into the worker container as ``SLACK_BOT_TOKEN``.
    The channel ID is the static Slack ID for ``#mkt-dept-updates``.
    """
    token = os.environ.get("SLACK_BOT_TOKEN")
    channel = os.environ.get("SLACK_APPROVAL_CHANNEL_ID")
    token = token.strip() if token else None
    channel = channel.strip() if channel else None
    return (token or None), (channel or None)


async def _post_slack(row: dict[str, Any]) -> None:
    """Post a high-urgency approval notification to Slack.

    Reads ``SLACK_BOT_TOKEN`` and ``SLACK_APPROVAL_CHANNEL_ID`` from env.
    If either is missing the function logs a warning and returns —
    fire-and-forget semantics mean we never raise.

    Failure modes (each logs ``slack_*`` and returns silently):

    * Env not configured → ``slack_notification_skipped_missing_env``
    * HTTP exception (timeout, DNS, TLS) → ``slack_post_exception``
    * Slack API returns ``{ok: False}`` → ``slack_post_failed``
    """
    token, channel = _slack_config()
    if not token or not channel:
        log.warning(
            "slack_notification_skipped_missing_env",
            has_token=bool(token),
            has_channel=bool(channel),
            approval_id=row.get("id"),
        )
        return

    blocks = _build_blocks(row)
    text_fallback = _build_text_fallback(row)
    payload = {"channel": channel, "text": text_fallback, "blocks": blocks}

    try:
        async with httpx.AsyncClient(timeout=SLACK_TIMEOUT_S) as client:
            resp = await client.post(
                SLACK_API_URL,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json=payload,
            )
    except httpx.HTTPError as exc:
        log.warning(
            "slack_post_exception",
            approval_id=row.get("id"),
            error=str(exc),
        )
        return
    except Exception as exc:  # noqa: BLE001 — fire-and-forget catch-all
        log.warning(
            "slack_post_exception",
            approval_id=row.get("id"),
            error=str(exc),
        )
        return

    # Slack always returns 200 even on logical errors — the actual
    # success/failure lives in the JSON body's ``ok`` field.
    try:
        data = resp.json() if resp.content else {}
    except (ValueError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict) or not data.get("ok"):
        log.warning(
            "slack_post_failed",
            approval_id=row.get("id"),
            status=resp.status_code,
            error=data.get("error") if isinstance(data, dict) else None,
        )
        return
    log.info(
        "slack_post_sent",
        approval_id=row.get("id"),
        ts=data.get("ts"),
    )


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


async def fan_out(row: dict[str, Any]) -> None:
    """Fan out notifications for a freshly-inserted approval row.

    Always fires a VAPID push (best-effort). For high-urgency rows,
    additionally posts a Block Kit message to Slack via the bot token.

    Args:
        row: The approvals row dict returned by Supabase. Should have at
            least ``id``, ``tool_name``, ``risk_class``, ``context``.

    Notes:
        * Never raises. Any exception is logged and swallowed — the caller
          (long-poll service) must not be blocked.
        * If push fan-out fails, Slack is still attempted.
        * If the Slack config (``SLACK_BOT_TOKEN`` /
          ``SLACK_APPROVAL_CHANNEL_ID``) is missing, the Slack step is
          skipped with a warning. Push still runs.
    """
    approval_id = row.get("id")

    # 1. Push — always. Wrapped so a push failure doesn't skip Slack.
    try:
        payload = _build_push_payload(row)
        sent, failed = await fanout_push(payload)
        log.info(
            "approval_push_fanout",
            approval_id=approval_id,
            sent=sent,
            failed=failed,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort
        log.warning(
            "approval_push_fanout_failed",
            approval_id=approval_id,
            error=str(exc),
        )

    # 2. Slack — only for high-urgency rows.
    if not is_high_urgency(row):
        log.info(
            "approval_slack_skipped_low_urgency",
            approval_id=approval_id,
            risk_class=row.get("risk_class"),
        )
        return

    await _post_slack(row)


__all__ = [
    "APPROVAL_PUSH_KIND",
    "HIGH_URGENCY_COST_THRESHOLD",
    "HIGH_URGENCY_RISK_CLASSES",
    "SLACK_API_URL",
    "fan_out",
    "is_high_urgency",
]
