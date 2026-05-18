"""Helper for the ``dashboard-chat-publish`` skill.

Writes a single row to ``chat_messages`` (see
``db/migrations/0005_chat_messages.sql``) via PostgREST so the dashboard
side-panel chat log persists each assistant turn even after the SSE
stream closes.

Why PostgREST instead of the ``supabase`` Python SDK:
- Keeps the skill container dependency surface small (httpx only).
- Mirrors how other Hermes skills talk to Supabase from the dashboard
  side; no need to bundle a heavy SDK for a single insert.

The public entry point is :func:`publish_message`. Everything else is
private implementation detail.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

__all__ = ["publish_message"]


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# DB enum: ``chat_author``. The Ekko-side role of an assistant turn is
# stored as ``ekko`` in the database, not ``assistant`` — the table was
# designed before the agent had a generic name. Translation happens in
# :func:`_map_role`.
_ROLE_TO_AUTHOR: dict[str, str] = {
    "user": "user",
    "assistant": "ekko",
    "system": "system",
}

# DB enum: ``chat_creative_type``. Anything else is rejected before we
# even ask Supabase to validate it.
_VALID_CREATIVE_TYPES: frozenset[str] = frozenset({"image", "video"})

# Default request timeout. Insert is a single round-trip; if it can't
# finish in 10s we'd rather surface the failure than block the chat
# loop.
_TIMEOUT_S = 10.0


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _require_env() -> tuple[str, str]:
    """Pull Supabase env vars or raise a loud RuntimeError.

    Loud-fail matches ``worker/src/supabase_client.get_supabase_admin``
    — silent skips when persistence is misconfigured would lose chat
    history without anyone noticing.
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not url:
        raise RuntimeError(
            "SUPABASE_URL must be set to publish chat messages."
        )
    if not key:
        raise RuntimeError(
            "SUPABASE_SECRET_KEY must be set to publish chat messages."
        )
    return url, key


def _parse_thread_id(thread_id: str) -> tuple[str, str]:
    """Split ``"<type>:<uuid>"`` into ``(creative_type, creative_id)``.

    The polymorphic thread key documented in
    ``db/migrations/0005_chat_messages.sql`` is the pair
    ``(creative_type, creative_id)``. The skill exposes it as a single
    opaque ``thread_id`` so callers don't need to know the schema
    internals.
    """
    if not isinstance(thread_id, str) or ":" not in thread_id:
        raise ValueError(
            "thread_id must be of the form '<creative_type>:<creative_id>', "
            f"got: {thread_id!r}"
        )
    creative_type, _, creative_id = thread_id.partition(":")
    creative_type = creative_type.strip()
    creative_id = creative_id.strip()
    if creative_type not in _VALID_CREATIVE_TYPES:
        raise ValueError(
            "thread_id prefix must be 'image' or 'video', "
            f"got: {creative_type!r}"
        )
    if not creative_id:
        raise ValueError(
            "thread_id is missing the creative_id suffix after the colon."
        )
    return creative_type, creative_id


def _map_role(role: str) -> str:
    """Translate caller-facing role to the ``chat_author`` enum value."""
    if not isinstance(role, str):
        raise ValueError(f"role must be a string, got: {type(role).__name__}")
    try:
        return _ROLE_TO_AUTHOR[role]
    except KeyError as exc:
        raise ValueError(
            "role must be one of 'user', 'assistant', 'system'; "
            f"got: {role!r}"
        ) from exc


def _build_payload(
    creative_type: str,
    creative_id: str,
    author: str,
    content: str,
    tool_calls: list[Any] | None,
) -> dict[str, Any]:
    """Assemble the JSON body for the PostgREST insert.

    When ``tool_calls`` is provided, ``content_type`` is ``'tool_call'``
    and the list lands in ``metadata.tool_calls``. Otherwise we write a
    plain text row.
    """
    payload: dict[str, Any] = {
        "creative_type": creative_type,
        "creative_id": creative_id,
        "author": author,
        "content": content,
    }
    if tool_calls is None:
        payload["content_type"] = "text"
        payload["metadata"] = {}
    else:
        payload["content_type"] = "tool_call"
        payload["metadata"] = {"tool_calls": tool_calls}
    return payload


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def publish_message(
    thread_id: str,
    role: str,
    content: str,
    tool_calls: list[Any] | None = None,
) -> dict[str, Any]:
    """Append a chat message row to ``chat_messages``.

    Args:
        thread_id: Format ``"<creative_type>:<creative_id>"`` where
            ``creative_type`` is ``image`` or ``video`` and
            ``creative_id`` is the creative uuid.
        role: ``"user"``, ``"assistant"``, or ``"system"``. Maps to
            ``chat_author`` enum value (``assistant`` → ``ekko``).
        content: The rendered text the dashboard should display.
            Empty string allowed; ``None`` raises ``ValueError``.
        tool_calls: Optional list of tool-call envelopes; when given,
            stored under ``metadata.tool_calls`` and the row is flagged
            ``content_type='tool_call'``.

    Returns:
        The inserted row as a dict (Supabase returns the representation
        when ``Prefer: return=representation`` is set).

    Raises:
        ValueError: Bad ``thread_id``, ``role``, or ``content``.
        RuntimeError: Supabase env vars missing.
        httpx.HTTPStatusError: Supabase returned non-2xx; the caller
            decides whether to retry.
        RuntimeError: Supabase returned 2xx but the response body did
            not contain the inserted row (defensive — should not
            happen with ``return=representation``).
    """
    if content is None:
        raise ValueError("content must not be None; pass an empty string instead.")
    if not isinstance(content, str):
        raise ValueError(
            f"content must be a string, got: {type(content).__name__}"
        )

    creative_type, creative_id = _parse_thread_id(thread_id)
    author = _map_role(role)

    url, key = _require_env()

    payload = _build_payload(
        creative_type=creative_type,
        creative_id=creative_id,
        author=author,
        content=content,
        tool_calls=tool_calls,
    )

    endpoint = f"{url.rstrip('/')}/rest/v1/chat_messages"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        # Ask PostgREST to echo the inserted row so the caller can act
        # on the assigned uuid / timestamp.
        "Prefer": "return=representation",
    }

    response = httpx.post(
        endpoint,
        headers=headers,
        json=payload,
        timeout=_TIMEOUT_S,
    )
    # 2xx-or-die: surfacing the HTTPStatusError keeps the failure mode
    # observable in worker logs and lets the Hermes chat loop decide
    # whether to resend.
    response.raise_for_status()

    body = response.json()
    # PostgREST returns a JSON array even for a single-row insert.
    if isinstance(body, list):
        if not body:
            raise RuntimeError(
                "Supabase returned an empty representation after insert; "
                "expected the new chat_messages row."
            )
        return body[0]
    if isinstance(body, dict):
        # Defensive: PostgREST configured to return a single object.
        return body
    raise RuntimeError(
        "Unexpected Supabase response shape after chat_messages insert: "
        f"{type(body).__name__}"
    )
