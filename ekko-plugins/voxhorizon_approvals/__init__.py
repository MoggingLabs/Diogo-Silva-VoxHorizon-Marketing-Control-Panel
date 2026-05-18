"""voxhorizon-approvals — Hermes plugin entry point.

Wires a single ``pre_tool_call`` hook that gates every tool dispatch:

1. Pure-function policy check (see :mod:`.policy`). Hot path: <50us.
2. If "allow" → return ``None`` (let Hermes proceed) + audit.
3. If "ask_operator" → check the in-process session cache (see
   :mod:`.client._SessionCache`). Cache hit: <1us, returns immediately.
4. Cache miss → HTTP POST to the worker; await the operator's decision
   (long poll, ~3-30s typical, configurable timeout).
5. Operator approves → audit + return ``None``.
6. Operator rejects → audit + return ``{"action": "block", "message": ...}``.
7. ANY exception → fail-closed: audit + return ``{"action": "block", ...}``.

The hook signature matches Hermes' plugin contract:

::

    async def on_pre_tool_call(
        tool_name: str, args: dict, task_id: str, **kwargs
    ) -> dict | None

Returning ``None`` permits the call. Returning ``{"action": "block",
"message": str}`` aborts it.

This file is import-side-effect-free: ``register`` is the only externally
called entry point, and it creates the client and registers the hook.
"""

from __future__ import annotations

import time
from typing import Any

from .audit import log_decision
from .client import ApprovalClient, ApprovalVerdict
from .policy import Decision, args_hash, evaluate


# Block-response shape Hermes expects. Pre-built so the hot path
# doesn't have to construct a dict literal on every veto (marginal but
# the goal of this plugin is to be aggressively cheap).
def _block(message: str) -> dict[str, str]:
    return {"action": "block", "message": message}


def register(ctx: Any) -> None:
    """Hermes plugin entry point.

    ``ctx`` is the plugin host's registration context. It must expose
    ``register_hook(name: str, handler)``. We don't type it because the
    Hermes plugin host doesn't publish a typed stub; the duck-typed
    contract is intentional.

    Args:
        ctx: Hermes plugin context with ``register_hook(name, handler)``.
    """
    client = ApprovalClient()

    async def on_pre_tool_call(
        tool_name: str,
        args: dict,
        task_id: str,
        **kwargs: Any,
    ) -> dict[str, str] | None:
        """Gate one tool call.

        See module docstring for the decision flow.
        """
        # Use the perf counter — wall clock would drift under NTP and
        # is irrelevant for latency measurement.
        t0 = time.perf_counter()
        args = args or {}
        session_id = (
            kwargs.get("session_id")
            or kwargs.get("ekko_session_id")
            or "default"
        )
        # The plugin's deterministic id surface needs a stable handle
        # per tool call; Hermes' ``tool_call_id`` is preferable but
        # ``task_id`` is the documented fallback.
        tool_call_id = (
            kwargs.get("tool_call_id")
            or kwargs.get("ekko_tool_call_id")
            or task_id
        )

        try:
            decision: Decision = evaluate(tool_name, args)

            if decision.action == "allow":
                _audit(
                    tool_name,
                    args,
                    "allow",
                    reason=decision.reason,
                    t0=t0,
                )
                return None

            # ask_operator path — check the in-process cache first.
            cached: ApprovalVerdict | None = client.cache_get(
                session_id, tool_name, args
            )
            if cached is not None and cached.decision in (
                "approved",
                "approved_with_caveat",
            ):
                _audit(
                    tool_name,
                    args,
                    "approved",
                    reason=f"cached: {cached.notes or 'approve and remember'}",
                    t0=t0,
                )
                return None

            verdict = await client.request_approval(
                tool_name=tool_name,
                args=args,
                session_id=session_id,
                tool_call_id=tool_call_id,
                risk_class=decision.risk_class,
            )

            if verdict.decision in ("approved", "approved_with_caveat"):
                _audit(
                    tool_name,
                    args,
                    "approved",
                    reason=verdict.notes or "operator approve",
                    t0=t0,
                )
                return None

            _audit(
                tool_name,
                args,
                "blocked",
                reason=f"operator reject: {verdict.notes or 'no reason given'}",
                t0=t0,
            )
            return _block(
                f"Operator denied: {verdict.notes or 'no reason given'}"
            )

        except Exception as exc:  # noqa: BLE001 — fail-closed for ANY error
            _audit(
                tool_name,
                args,
                "blocked",
                reason=f"plugin error: {exc}",
                t0=t0,
            )
            return _block(
                f"Approval plugin error (fail-closed): {exc}"
            )

    ctx.register_hook("pre_tool_call", on_pre_tool_call)


def _audit(
    tool_name: str,
    args: dict,
    decision: str,
    *,
    reason: str,
    t0: float,
) -> None:
    """Stamp the decision into the audit log with measured latency."""
    latency_ms = (time.perf_counter() - t0) * 1000.0
    log_decision(
        tool_name,
        args,
        decision,
        reason=reason,
        latency_ms=latency_ms,
    )


__all__ = [
    "ApprovalClient",
    "ApprovalVerdict",
    "Decision",
    "args_hash",
    "evaluate",
    "log_decision",
    "register",
]
