"""Supabase publish helper for Hermes-driven kanban task completion.

This module is invoked by the Hermes agent at the end of every kanban task
execution. It records the final task output to ``hermes_tasks.result`` so the
dashboard's kanban view can render it, flips ``hermes_tasks.status`` to
``completed`` or ``failed``, and emits a paired ``pipeline_events`` row with
``source='hermes-task'`` so the pipeline timeline pane picks up the lifecycle
transition without polling.

Authentication uses the Supabase service-role key so writes bypass RLS — same
pattern as the sibling ``dashboard-publish`` and ``dashboard-chat-publish``
skills (HI-9, HI-10).

The helper is intentionally synchronous (``httpx.Client``) so it can be invoked
from arbitrary Hermes skill entry points without dragging in an async runtime.
Every call opens a fresh HTTP client; module import does not touch the
environment so unit tests can import safely without ``SUPABASE_URL`` set.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx


class DashboardTaskResultError(Exception):
    """Raised when a Supabase write fails (network, HTTP error, or config)."""


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _client() -> httpx.Client:
    """Build an httpx client pointed at the Supabase REST endpoint.

    Reads ``SUPABASE_URL`` and ``SUPABASE_SECRET_KEY`` from the
    environment. Both must be set; an empty string counts as unset so
    misconfigured ``.env`` files fail loudly rather than silently
    authenticating as anon.
    """
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SECRET_KEY", "")
    if not url or not key:
        raise DashboardTaskResultError(
            "SUPABASE_URL or SUPABASE_SECRET_KEY not set"
        )
    return httpx.Client(
        base_url=f"{url}/rest/v1",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        timeout=10.0,
    )


def _request(
    method: str,
    path: str,
    *,
    body: dict[str, Any],
    params: Optional[dict[str, str]] = None,
) -> list[dict[str, Any]]:
    """Issue a single REST call against Supabase and return decoded rows.

    Wraps both PATCH (``hermes_tasks`` update) and POST (``pipeline_events``
    insert) so the two write paths share identical error handling. Any HTTP
    error (4xx or 5xx) is re-raised as ``DashboardTaskResultError`` with the
    response body so the caller can decide whether to retry.
    """
    try:
        with _client() as c:
            resp = c.request(method, path, json=body, params=params)
    except httpx.HTTPError as exc:
        raise DashboardTaskResultError(
            f"network error calling {method} {path}: {exc}"
        ) from exc

    if resp.status_code >= 300:
        raise DashboardTaskResultError(
            f"{method} {path} failed: {resp.status_code} {resp.text}"
        )

    try:
        rows = resp.json()
    except ValueError as exc:
        raise DashboardTaskResultError(
            f"{method} {path} returned non-JSON body: {resp.text}"
        ) from exc

    if not isinstance(rows, list):
        raise DashboardTaskResultError(
            f"{method} {path} returned non-list body: {resp.text}"
        )
    return rows


# ---------------------------------------------------------------------------
# Public function
# ---------------------------------------------------------------------------


def publish_task_result(
    *,
    kanban_task_id: str,
    pipeline_id: Optional[str],
    result: dict[str, Any],
    success: bool,
) -> dict[str, Any]:
    """Record a kanban task's final output to the dashboard.

    Performs two writes in sequence:

    1. ``PATCH /rest/v1/hermes_tasks?kanban_task_id=eq.<id>`` — writes the
       ``result`` jsonb column and flips ``status`` to ``completed`` when
       ``success`` is True, ``failed`` otherwise. The kanban id is the
       Hermes-side primary key (text, UNIQUE on the dashboard side).
    2. ``POST /rest/v1/pipeline_events`` — emits a paired timeline row with
       ``source='hermes-task'`` and ``kind='task_completed'`` /
       ``'task_failed'`` so the pipeline timeline pane reflects the lifecycle
       transition without polling. ``payload`` carries the kanban id + the
       full result so timeline consumers don't need a second round-trip.

    The function deliberately does NOT swallow exceptions. Hermes' worker
    pattern wraps the call in its own retry / error-surfacing logic; bubbling
    up makes failures visible to the operator instead of producing a stale
    "running" row.

    Args:
        kanban_task_id: The Hermes-side primary key of the kanban task. UNIQUE
            on ``hermes_tasks.kanban_task_id``.
        pipeline_id: The dashboard pipeline this task feeds, or ``None`` when
            the task isn't pipeline-scoped (e.g. ad-hoc operator request).
            ``pipeline_events.pipeline_id`` is nullable for hook / task rows.
        result: The skill's final output payload. Stored verbatim in
            ``hermes_tasks.result`` and mirrored into the timeline event's
            ``payload`` so the dashboard can render the result inline.
        success: ``True`` for ``completed`` / ``task_completed`` transitions,
            ``False`` for ``failed`` / ``task_failed``.

    Returns:
        A dict with two keys: ``task`` (the updated ``hermes_tasks`` row) and
        ``event`` (the inserted ``pipeline_events`` row).

    Raises:
        DashboardTaskResultError: If env vars are missing, the network call
            fails, or Supabase returns a non-2xx response. The ``hermes_tasks``
            update happens first; if the timeline insert subsequently fails
            the task row is already updated (and the dashboard is the system
            of record — the timeline event is observability, not state).
    """
    if not isinstance(kanban_task_id, str) or not kanban_task_id:
        raise DashboardTaskResultError("kanban_task_id must be a non-empty string")
    if pipeline_id is not None and (
        not isinstance(pipeline_id, str) or not pipeline_id
    ):
        raise DashboardTaskResultError(
            "pipeline_id must be a non-empty string or None"
        )
    if not isinstance(result, dict):
        raise DashboardTaskResultError("result must be a dict")
    if not isinstance(success, bool):
        raise DashboardTaskResultError("success must be a bool")

    task_status = "completed" if success else "failed"
    event_kind = "task_completed" if success else "task_failed"

    # 1. Update the kanban mirror row. PostgREST returns the updated rows
    #    when the request carries ``Prefer: return=representation`` (set on
    #    the shared client). An empty list means no row matched the
    #    ``kanban_task_id`` filter — that's an operator-visible bug, not a
    #    silent miss, so we raise.
    task_rows = _request(
        "PATCH",
        "/hermes_tasks",
        body={"status": task_status, "result": result},
        params={"kanban_task_id": f"eq.{kanban_task_id}"},
    )
    if not task_rows:
        raise DashboardTaskResultError(
            f"hermes_tasks update matched 0 rows for kanban_task_id={kanban_task_id!r}"
        )
    updated_task = task_rows[0]

    # 2. Emit the timeline event. ``pipeline_id`` is left out of the body
    #    when None so PostgREST records NULL (rather than failing on the
    #    string "None"). ``payload`` carries the kanban id + result so
    #    timeline consumers don't need to join back to ``hermes_tasks``.
    event_body: dict[str, Any] = {
        "kind": event_kind,
        "source": "hermes-task",
        "payload": {
            "kanban_task_id": kanban_task_id,
            "result": result,
            "success": success,
        },
    }
    if pipeline_id is not None:
        event_body["pipeline_id"] = pipeline_id

    event_rows = _request("POST", "/pipeline_events", body=event_body)
    if not event_rows:
        raise DashboardTaskResultError(
            "pipeline_events insert returned empty body"
        )

    return {"task": updated_task, "event": event_rows[0]}


__all__ = [
    "DashboardTaskResultError",
    "publish_task_result",
]
