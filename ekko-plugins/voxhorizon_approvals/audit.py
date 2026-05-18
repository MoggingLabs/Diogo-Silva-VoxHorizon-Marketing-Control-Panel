"""Append-only JSONL audit log for voxhorizon-approvals.

One JSON object per line, written to ``/opt/data/logs/voxhorizon-approvals.jsonl``
on the VPS (overridable for tests via :data:`AUDIT_LOG_PATH_ENV`).

The schema (kept stable so the dashboard can later tail-replay decisions):

::

    {
      "timestamp": "2026-05-18T03:14:15.926Z",  # UTC, RFC3339 / ISO-8601
      "tool": "kie_generate",                    # tool_name
      "decision": "approved",                    # "allow"/"approved"/"blocked"/...
      "reason": "operator approve",              # free-form
      "latency_ms": 12.4,                        # round-trip cost on the hot path
      "args_digest": "sha256:abc..."             # truncated args_hash for traceability
    }

Args themselves are NEVER written — they may contain secrets (tokens,
prompts with PII). ``args_digest`` is a 16-char prefix of the
``args_hash`` so identical calls cross-reference without leaking content.

Failure semantics: log_decision NEVER raises. A failing log line means
"oh well, we lost an audit event"; raising here would deadlock the
hot-path hook on a full disk. The error is silently swallowed; the
worker's structured logs remain the canonical source of truth.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

from .policy import args_hash


#: Env var to override the default audit log path. Used by tests to
#: point at ``tmp_path``; in production the default is fine.
AUDIT_LOG_PATH_ENV = "VOXHORIZON_APPROVAL_AUDIT_LOG"

#: Default location on the VPS (mapped to a docker volume).
DEFAULT_AUDIT_LOG_PATH = "/opt/data/logs/voxhorizon-approvals.jsonl"

# A module-level lock so multi-threaded Hermes (or test parallelism)
# doesn't interleave half-written JSON lines. The hot path is still
# fast — the lock is uncontended in steady state because the plugin's
# pre_tool_call hook is awaited serially per session.
_write_lock = threading.Lock()


def _resolve_path() -> Path:
    """Resolve the audit-log path; respects the env override."""
    raw = os.environ.get(AUDIT_LOG_PATH_ENV) or DEFAULT_AUDIT_LOG_PATH
    return Path(raw)


def _iso_now() -> str:
    """UTC ISO-8601 with millisecond precision and trailing ``Z``."""
    now = datetime.now(timezone.utc)
    # ``isoformat`` returns ``...+00:00``; the dashboard prefers a
    # trailing ``Z`` for compactness, and millisecond-precision means
    # the JSONL stays under 200 bytes per line in steady state.
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def log_decision(
    tool_name: str,
    args: dict | None,
    decision: str,
    *,
    reason: str = "",
    latency_ms: float | None = None,
) -> None:
    """Append one decision row to the audit log.

    Never raises. A logging failure is its own log-level error in
    structlog if available, but we keep the dependency surface narrow
    by silently swallowing here — Hermes' top-level error reporter
    surfaces hot-path exceptions if any propagate.

    Args:
        tool_name: Hermes tool identifier.
        args: The tool's arg dict; only its digest is recorded.
        decision: Human-readable verdict ("allow", "approved",
            "blocked", "ask_operator", "approved_with_caveat").
        reason: Free-form explanation (policy reason, operator note,
            "fail-closed: <error>", …).
        latency_ms: Time elapsed inside the hook, in milliseconds. None
            when the caller hasn't measured.
    """
    args = args or {}

    # ``args_hash`` is deterministic; take a 16-char prefix so the
    # JSONL stays compact. Full hash isn't needed because audit replay
    # cross-references against the worker's ``approvals`` table, which
    # stores the full tool_args.
    digest = "sha256:" + args_hash(tool_name, args)[:16]

    row: dict[str, object] = {
        "timestamp": _iso_now(),
        "tool": tool_name,
        "decision": decision,
        "reason": reason,
        "args_digest": digest,
    }
    if latency_ms is not None:
        # Round to two decimals — sub-10us precision is just noise on
        # the JSONL and inflates byte count for no benefit.
        row["latency_ms"] = round(float(latency_ms), 2)

    line = json.dumps(row, ensure_ascii=False, sort_keys=False) + "\n"

    path = _resolve_path()
    try:
        with _write_lock:
            # Ensure the directory exists. ``mkdir(parents=True,
            # exist_ok=True)`` is cheap (no-op when the dir is already
            # there) and means a fresh container doesn't need an init
            # script to create ``/opt/data/logs``.
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line)
    except OSError:
        # Best-effort. The dashboard's source of truth for approval
        # decisions is Supabase; this file is a secondary trace.
        return


__all__ = [
    "AUDIT_LOG_PATH_ENV",
    "DEFAULT_AUDIT_LOG_PATH",
    "log_decision",
]
