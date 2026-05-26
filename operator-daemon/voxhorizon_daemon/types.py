"""Pydantic models matching the worker's work_queue REST surface.

The shapes mirror the bodies in
``worker/src/routes/work_queue.py`` (PR-1) plus the rows the
``claim_work_item`` RPC returns. Kept here as a single source of truth so
the daemon's drain loop never reads dict keys by string anywhere outside
this module.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# The canonical ``work_item_kind`` enum from migration 0050. Listed
# verbatim so a future kind addition shows up here as a typecheck failure
# before it can ship.
WorkItemKind = Literal[
    "operator_dispatch",
    "outbox_meta_record_launch",
    "outbox_drive_finalize_verified",
    "outbox_ghl_send",
    "kie_video_render",
    "kie_image_render",
    "kie_tts",
    "ffmpeg_compose",
    "worker_ideation",
    "worker_generation",
    "worker_monitor",
    "broll_search",
    "other",
]


# ``work_item_status`` from the same migration.
WorkItemStatus = Literal[
    "queued",
    "claimed",
    "running",
    "completed",
    "failed",
    "timed_out",
    "cancelled",
]


# The five values the consumer ever writes to ``work_item_consumers.status``
# from this side. ``degraded`` is an admin-side value we do not write here.
ConsumerStatus = Literal["starting", "live", "stopped", "down"]


# The seven ``error_kind`` values the daemon classifies. The full set is
# free-form text in the DB; this Literal captures the values the daemon
# itself emits so tests + dashboards have a closed enumeration.
DaemonErrorKind = Literal[
    "auth_expired",
    "llm_4xx",
    "llm_5xx",
    "docker_exec_failed",
    "hermes_crashed",
    "skill_missing",
    "consumer_shutdown",
    "claim_token_rotated",
    "unknown",
]


class WorkItem(BaseModel):
    """A row returned by ``POST /work/queue/claim``.

    Only the fields the daemon reads are typed. Anything extra is accepted
    (``extra='allow'``) so a forward-compatible worker can add columns
    without breaking the consumer.
    """

    model_config = ConfigDict(extra="allow")

    id: str
    kind: WorkItemKind
    pipeline_id: str | None = None
    creative_id: str | None = None
    brief_id: str | None = None
    status: WorkItemStatus
    attempt: int = 0
    claim_token: str
    claimed_by: str
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = None


class StartupCheckEntry(BaseModel):
    """One sub-check inside a :class:`StartupCheck`.

    The ``ok`` flag is the load-bearing bit; ``detail`` is opaque diagnostic
    payload the dashboard renders verbatim.
    """

    ok: bool
    detail: dict[str, Any] = Field(default_factory=dict)


class StartupCheck(BaseModel):
    """Result of the daemon's startup self-test.

    All three sub-checks must pass for the daemon to mark itself ``live``.
    A single ``ok=False`` entry takes the daemon to ``down`` and the Docker
    healthcheck red, which is the LOUD failure signal the redesign hinges
    on.
    """

    queue_reachable: StartupCheckEntry
    hermes_container_up: StartupCheckEntry
    hermes_auth: StartupCheckEntry

    @property
    def all_ok(self) -> bool:
        return (
            self.queue_reachable.ok
            and self.hermes_container_up.ok
            and self.hermes_auth.ok
        )

    def first_failure(self) -> str | None:
        """Name the first failing sub-check (stable order for logging)."""
        if not self.queue_reachable.ok:
            return "queue_reachable"
        if not self.hermes_container_up.ok:
            return "hermes_container_up"
        if not self.hermes_auth.ok:
            return "hermes_auth"
        return None


class AuthProbeResult(BaseModel):
    """Result of :func:`hermes_exec.HermesExec.auth_probe`.

    The probe runs inside the operator container. The daemon never opens
    auth.json itself; it asks the container to read its own file via
    ``docker exec``.
    """

    ok: bool
    detail: dict[str, Any] = Field(default_factory=dict)


class ChatResult(BaseModel):
    """Result of :func:`hermes_exec.HermesExec.chat`.

    ``stdout_tail`` is the LAST 4 KB of stdout (the head is irrelevant for
    error diagnosis; the tail tends to carry the failure message).
    """

    exit_code: int
    stdout_tail: str = ""
    error_kind: DaemonErrorKind | None = None


__all__ = [
    "AuthProbeResult",
    "ChatResult",
    "ConsumerStatus",
    "DaemonErrorKind",
    "StartupCheck",
    "StartupCheckEntry",
    "WorkItem",
    "WorkItemKind",
    "WorkItemStatus",
]
