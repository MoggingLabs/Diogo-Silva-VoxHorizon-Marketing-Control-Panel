"""voxhorizon-approvals — Hermes plugin entry point.

Wires a single ``pre_tool_call`` hook that gates every tool dispatch:

1. Mode probe (see :mod:`.mode`). 5s in-process cache, fail-to-ASK on
   any error. Short-circuits the dashboard prompt when the operator
   has flipped the mode to AUTO_APPROVE or HALT — runs at the TOP of
   the hook, BEFORE allowlist / cache lookups, so the cheap allow path
   is unaffected.
2. Pure-function policy check (see :mod:`.policy`). Hot path: <50us.
3. If "allow" → return ``None`` (let Hermes proceed) + audit.
4. If "ask_operator" AND mode is AUTO_APPROVE → audit + allow.
5. If "ask_operator" AND mode is HALT → audit + block.
6. If "ask_operator" AND mode is ASK → check the in-process session
   cache (see :mod:`.client._SessionCache`). Cache hit: <1us, returns
   immediately.
7. Cache miss → HTTP POST to the worker; block on the operator's
   decision (long poll, ~3-30s typical, configurable timeout).
8. Operator approves → audit + return ``None``.
9. Operator rejects → audit + return ``{"action": "block", "message": ...}``.
10. ANY exception → fail-closed: audit + return ``{"action": "block", ...}``.

The hook is SYNCHRONOUS — this is Hermes' real ``pre_tool_call``
contract. Hermes invokes the hook and uses its RETURN value directly
(``hermes_cli/plugins.py::get_pre_tool_call_block_message`` calls the
hook via ``invoke_hook`` and does NOT ``await`` it); an ``async`` hook
would return an un-awaited coroutine that Hermes silently ignores,
bypassing the gate. Blocking is correct: the gate must hold the tool
call open until the operator decides. The hook signature is:

::

    def on_pre_tool_call(
        tool_name: str, args: dict, task_id: str, **kwargs
    ) -> dict | None

Returning ``None`` permits the call. Returning ``{"action": "block",
"message": str}`` aborts it.

This file is import-side-effect-free: ``register`` is the only externally
called entry point, and it creates the client and registers the hook.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Callable

from .audit import log_decision
from .client import ApprovalClient, ApprovalVerdict
from .mode import ModeState, fetch_mode
from .policy import Decision, args_hash, evaluate
from .policy_overlay import load_overlay

#: Env var that opts a deployment into the operator-tunable policy overlay.
#: When set to the path of an EXISTING file, ``register`` loads that overlay
#: and routes decisions through ``PolicyOverlay.evaluate``; otherwise the hook
#: calls the plain in-code :func:`policy.evaluate` and Ekko's behavior is
#: byte-identical to before this overlay existed. This is how the dedicated
#: operator agent (which ships ``policy.operator.yaml`` as its ``policy.yaml``)
#: gates ``pipeline_operator_render`` while Ekko stays unchanged.
POLICY_PATH_ENV = "VOXHORIZON_APPROVAL_POLICY_PATH"

#: A decision function with the same signature as :func:`policy.evaluate`.
EvaluateFn = Callable[[str, dict], Decision]

#: Risk classes that AUTO_APPROVE must NEVER cover (E6.5). AUTO_APPROVE is a
#: convenience for the low-stakes round-trips; it must not become an
#: unbounded-spend / unrestricted-launch window. Tools tagged with one of
#: these classes ALWAYS fall through to the normal ASK / in-code gate even
#: while the operator mode is AUTO_APPROVE:
#:
#:   * ``spend``          — paid APIs (kie, ElevenLabs, Submagic) AND the
#:                          operator overlay's gated launch tools, which the
#:                          overlay tags ``spend`` (Meta activate / launch
#:                          create live ad entities = irreversible real spend).
#:   * ``external-write`` — mutating a third party (Slack, Drive, email).
#:
#: ``filesystem`` / ``unknown`` are intentionally NOT here: AUTO_APPROVE may
#: still cover them (they are local / reversible and the operator opted in).
AUTO_APPROVE_NEVER_RISK_CLASSES: frozenset[str] = frozenset(
    {"spend", "external-write"}
)


def _resolve_evaluate() -> EvaluateFn:
    """Pick the decision function for this deployment.

    Opt-in + env-gated: if ``VOXHORIZON_APPROVAL_POLICY_PATH`` points at an
    existing file, load it as a :class:`PolicyOverlay` and return its
    ``evaluate``; otherwise return the plain in-code :func:`policy.evaluate`
    (exact pre-overlay behavior). Resolved once at ``register`` time so the
    hot path pays no per-call file-stat cost.
    """
    raw = os.environ.get(POLICY_PATH_ENV, "").strip()
    if raw and Path(raw).is_file():
        return load_overlay(raw).evaluate
    return evaluate


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
    # Resolve the decision function once. Default = plain in-code policy
    # (Ekko-safe); overlay only when the deployment opts in via env.
    decide: EvaluateFn = _resolve_evaluate()

    def on_pre_tool_call(
        tool_name: str,
        args: dict,
        task_id: str,
        **kwargs: Any,
    ) -> dict[str, str] | None:
        """Gate one tool call.

        Synchronous to match Hermes' ``pre_tool_call`` contract (the
        host uses the return value directly without awaiting). See the
        module docstring for the decision flow.
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
            decision: Decision = decide(tool_name, args)

            if decision.action == "allow":
                _audit(
                    tool_name,
                    args,
                    "allow",
                    reason=decision.reason,
                    t0=t0,
                )
                return None

            # A "block" decision comes only from the opt-in overlay's
            # blocklist (the in-code engine never emits "block"). It is a hard
            # reject with no operator prompt — short-circuit before the mode
            # probe and the long-poll.
            if decision.action == "block":
                _audit(
                    tool_name,
                    args,
                    "blocked",
                    reason=decision.reason,
                    t0=t0,
                )
                return _block(
                    f"Blocked by policy: {decision.reason}"
                )

            # ask_operator path — first check the operator-controlled
            # mode. AUTO_APPROVE short-circuits to allow; HALT
            # short-circuits to block. ASK falls through to the
            # existing cache + long-poll flow.
            #
            # fetch_mode caches the result for 5s in-process and
            # fails-to-ASK on any error, so the worst case is a 5s
            # delay before a dashboard mode flip propagates.
            try:
                mode_state: ModeState = fetch_mode()
                effective_mode = mode_state.effective_mode
            except Exception:  # noqa: BLE001 — fail-to-ASK for any error
                effective_mode = "ASK"

            # E6.5: AUTO_APPROVE must NEVER cover spend-class or
            # external-write/launch-class tools. Those always fall through
            # to the normal ASK / in-code gate (the long-poll below) even
            # under AUTO_APPROVE, so the convenience mode can't open an
            # unbounded-spend / unrestricted-launch window. We audit the
            # refusal-to-auto-approve so the trail shows WHY a tool still
            # asked while AUTO_APPROVE was on.
            if (
                effective_mode == "AUTO_APPROVE"
                and decision.risk_class in AUTO_APPROVE_NEVER_RISK_CLASSES
            ):
                _audit(
                    tool_name,
                    args,
                    "ask",
                    reason=(
                        f"auto_mode:AUTO_APPROVE does not cover "
                        f"{decision.risk_class}-class tool; falling through "
                        f"to operator approval"
                    ),
                    t0=t0,
                )
                effective_mode = "ASK"

            if effective_mode == "AUTO_APPROVE":
                _audit(
                    tool_name,
                    args,
                    "approved",
                    reason=(
                        f"auto_mode:AUTO_APPROVE expires "
                        f"{mode_state.expires_at or '?'}"
                    ),
                    t0=t0,
                )
                # Also write an approvals-table row via the worker so
                # the dashboard's audit page reflects the auto-approve
                # decision. Fire-and-forget — a failed audit write
                # MUST NOT block the agent's tool call.
                client.write_auto_decision(
                    tool_name=tool_name,
                    args=args,
                    session_id=session_id,
                    tool_call_id=tool_call_id,
                    risk_class=decision.risk_class,
                    decision="approved",
                    decided_by="auto_mode:AUTO_APPROVE",
                    notes=(
                        f"Auto-approved by operator mode. "
                        f"Mode TTL expires "
                        f"{mode_state.expires_at or 'unknown'}."
                    ),
                )
                return None

            if effective_mode == "HALT":
                _audit(
                    tool_name,
                    args,
                    "blocked",
                    reason="auto_mode:HALT",
                    t0=t0,
                )
                client.write_auto_decision(
                    tool_name=tool_name,
                    args=args,
                    session_id=session_id,
                    tool_call_id=tool_call_id,
                    risk_class=decision.risk_class,
                    decision="rejected",
                    decided_by="auto_mode:HALT",
                    notes=(
                        "Approvals halted by operator. "
                        "Re-enable in the dashboard."
                    ),
                )
                return _block(
                    "Approvals halted by operator. "
                    "Re-enable in the dashboard."
                )

            # mode == ASK — check the in-process cache first.
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

            verdict = client.request_approval(
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
    "AUTO_APPROVE_NEVER_RISK_CLASSES",
    "ApprovalClient",
    "ApprovalVerdict",
    "Decision",
    "ModeState",
    "POLICY_PATH_ENV",
    "args_hash",
    "evaluate",
    "fetch_mode",
    "load_overlay",
    "log_decision",
    "register",
]
