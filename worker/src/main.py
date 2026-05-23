"""FastAPI app entry. Wires routers, CORS, structlog."""

from __future__ import annotations

import logging
import sys

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routes import (
    creative,
    health,
    hermes_approval,
    hermes_approval_mode,
    hermes_chat,
    hermes_kanban,
    hermes_webhook,
    integrations,
    operator_stage_tools,
    pipeline,
    pipeline_tools,
    ping,
    qa_compliance,
)


def _configure_logging() -> None:
    """Configure structlog to emit JSON to stdout."""
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=logging.INFO,
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def create_app() -> FastAPI:
    """Build the FastAPI application.

    Kept as a factory so tests can override settings or skip side-effecty
    setup (e.g. logging) cleanly.
    """
    _configure_logging()
    settings = get_settings()

    app = FastAPI(
        title="VoxHorizon Worker",
        version="0.1.0",
        description="Local Python worker behind the Next.js marketing control panel.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.worker_cors_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router, tags=["health"])
    # Public, unauthenticated liveness probe for external uptime monitors
    # (Uptime Robot etc.). MUST stay free of auth dependencies — see
    # routes/ping.py and infra/monitoring/README.md (VPS-6).
    app.include_router(ping.router, tags=["ping"])

    # === image-generation pipeline (restored) ===
    # The deterministic image-generation pipeline that HI-8 deleted, brought
    # back because Ekko's `image-ad-prompting` skill is an interactive
    # prompt-writer, not an automated dashboard executor — and there's no
    # Supabase read path for it. These routes emit the exact `pipeline_events`
    # kinds (task_queued / task_running / task_done / task_error /
    # cost_recorded) the dashboard StageGeneration component and the Supabase
    # auto-advance trigger expect, so restoring them fixes the contract by
    # construction. /work/pipeline/ideation produces cheap concept previews;
    # /work/pipeline/generation renders the final 1:1 + 9:16 picks. The
    # config-draft route is also restored for completeness, but the dashboard
    # keeps its brief-draft interview on /work/hermes/chat (Ekko owns chat).
    app.include_router(pipeline.router, tags=["pipeline"])

    # === Wave A operator-tool endpoints ===
    # The dedicated Hermes "operator" agent drives the image-ad pipeline
    # above by calling these tool routes: GET state, author the brief,
    # render operator-authored prompts (the spend tool the approval plugin
    # gates), and a server-side dispatch the dashboard uses to kick the
    # operator after a stage-gate action. They EXTEND the pipeline (reuse
    # its services / event kinds / tables / triggers), never duplicate it.
    app.include_router(pipeline_tools.router, tags=["pipeline-tools"])

    # === P3 operator stage-persist endpoints ===
    # The post-generation siblings of the pipeline-tools router: the operator
    # delegates the judgment (copy / spec / finalize / monitor) and POSTs the
    # structured result here, where the worker validates + writes it and rolls
    # the per-(creative, stage) gate state forward. /signal tracks dispatch
    # completion + health. The operator has no tool here that clears a gate.
    app.include_router(
        operator_stage_tools.router, tags=["operator-stage-tools"]
    )

    # === P2 compliance + QA adjudication endpoints ===
    # /work/pipeline/tools/compliance_run + /qa_run: the operator submits
    # CANDIDATE findings only; the worker runs the deterministic + adjudication
    # engines, writes the append-only evidence (compliance_finding / qa_result)
    # and rolls the verdict onto creative_stage_state. The operator has no path
    # to write a pass — the verdict is always worker-owned (hard-gate invariant,
    # PIPELINE-REBUILD-ARCHITECTURE.md Layer 3).
    app.include_router(qa_compliance.router, tags=["qa-compliance"])

    # /work/creative/generate + /work/creative/composite — the per-brief
    # image generation + compositor surface used by the pipeline producers
    # and the standalone creative routes.
    app.include_router(creative.router, tags=["creative"])

    # === P5 integrations + monitor + observability (Layer 6) ===
    # The launch RECORDER + hard launch gate (re-checks preconditions
    # server-side), the Drive finalize recorder, the read-only GHL lead
    # webhook (deduped via the inbox), and the /work/metrics observability
    # snapshot. Meta + Drive stay operator-MCP — these endpoints RECORD and
    # GATE, they never call Meta/Drive. See routes/integrations.py.
    app.include_router(integrations.router, tags=["integrations"])

    # === wave 18 hermes-bridge routes ===
    # Three thin surfaces that proxy to the co-located Hermes/Ekko
    # container via docker.sock exec. /work/hermes/chat streams stdout
    # from `hermes chat -q` (HI-2); /work/hermes/kanban wraps the kanban
    # CLI for long-running orchestration (HI-3); /work/hermes/webhook
    # receives shell-hook callbacks from Hermes and fans out to
    # Supabase + VAPID (HI-4).
    app.include_router(hermes_chat.router, tags=["hermes-chat"])
    app.include_router(hermes_kanban.router, tags=["hermes-kanban"])
    app.include_router(hermes_webhook.router, tags=["hermes-webhook"])

    # === wave 19 dashboard-driven approvals ===
    # /work/hermes/approval is the worker side of the approval long-poll.
    # The Hermes plugin (voxhorizon-approvals, HI-13) POSTs here from
    # inside the Ekko container; this endpoint inserts a pending row,
    # polls Supabase for the operator's decision, and returns the verdict
    # to the plugin so the agent's tool call can proceed or abort.
    # Bearer-authed with VOXHORIZON_APPROVAL_TOKEN (separate from
    # WORKER_SHARED_SECRET — the plugin doesn't share the dashboard's key).
    app.include_router(hermes_approval.router, tags=["hermes-approval"])

    # === wave 24 approval-mode toggle ===
    # /work/hermes/approval-mode lets the dashboard flip the plugin between
    # ASK / AUTO_APPROVE (TTL-bounded) / HALT. Same bearer
    # (VOXHORIZON_APPROVAL_TOKEN) as the long-poll route — the plugin reads
    # this on every pre_tool_call (5s in-process cache) and short-circuits
    # the dashboard prompt for AUTO_APPROVE/HALT.
    app.include_router(
        hermes_approval_mode.router, tags=["hermes-approval-mode"]
    )

    # === seed the compliance_rule lookup (#394) ===
    # The compliance engine adjudicates from the in-memory ruleset
    # (services.compliance_rules), but the compliance_rule TABLE is a
    # display/lookup surface the UI joins findings against. Populate it from the
    # SAME source of truth on boot via an idempotent UPSERT, so the table is
    # never empty in any environment and never drifts from the Python ruleset.
    # Best-effort: this NEVER crashes startup — when Supabase isn't configured
    # (local boot, tests) or the table isn't migrated yet it logs and skips,
    # exactly like the worker booting without the admin client.
    from .services.compliance_rules_seed import seed_compliance_rules_safe

    seed_compliance_rules_safe()

    structlog.get_logger(__name__).info(
        "worker_started",
        tailscale_hostname=settings.tailscale_hostname,
        broll_backend=settings.broll_store_backend,
    )

    return app


app = create_app()
