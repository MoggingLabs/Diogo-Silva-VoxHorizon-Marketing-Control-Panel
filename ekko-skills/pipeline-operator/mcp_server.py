"""Stdio MCP server exposing the pipeline-operator worker tools.

This is the *transport* half of the ``pipeline-operator`` skill. ``SKILL.md``
is the playbook, ``helper.py`` is the validated HTTP client, and this module
publishes that client's three capabilities as **real, named MCP tools** so the
operator agent invokes them as first-class tools (and the voxhorizon-approvals
plugin can gate the spend tool ``pipeline_operator_render`` by name).

Single source of truth
-----------------------
This server does **not** reimplement any HTTP or validation. Each tool is a
thin wrapper that delegates straight to the matching ``helper.py`` function;
``helper.py`` stays the only place that talks to the worker, reads env
(``WORKER_BASE_URL`` / ``WORKER_SHARED_SECRET``), and validates payloads.

The gating contract (tool names)
--------------------------------
The three tools are published under the helper's exact entrypoint names so the
approval policy (``ekko-plugins/voxhorizon_approvals/policy.operator.yaml``)
maps one-for-one:

* ``pipeline_operator_read``        — READ tool (allowlisted; no spend)
* ``pipeline_operator_client_read`` — CLIENT-CONTEXT tool (allowlisted; no spend)
* ``pipeline_operator_brief``       — BRIEF tool (free Supabase write)
* ``pipeline_operator_render``      — RENDER tool (**spend; requires approval**)

Run it over stdio (the default Hermes MCP transport)::

    python mcp_server.py
"""

from __future__ import annotations

import os
import sys
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

# Import the helper as a sibling module. When Hermes launches this file
# directly (``python mcp_server.py``) the skill directory is not necessarily on
# ``sys.path``; add it so ``import helper`` resolves to the co-located client.
_SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
if _SKILL_DIR not in sys.path:
    sys.path.insert(0, _SKILL_DIR)

import helper  # noqa: E402  (path tweak must run before this import)

#: The MCP server name. Hermes namespaces tools by this when it advertises
#: them, presenting ``mcp_<server>_<tool>`` with single underscores — the
#: hyphen is normalized to ``_`` — e.g.
#: ``mcp_pipeline_operator_pipeline_operator_render``. The approval overlay
#: keys on that exact full name (see policy.operator.yaml).
SERVER_NAME = "pipeline-operator"

mcp = FastMCP(SERVER_NAME)


@mcp.tool()
def pipeline_operator_read(pipeline_id: str) -> dict[str, Any]:
    """Read the full pipeline state for a pipeline_id.

    Use this FIRST on every dispatch, before any other action. Returns the
    worker's state object (``status``/stage, ``format_choice``,
    ``config_draft``, ``picks``, ``brief``, ``concepts``, ``finals``,
    ``events_tail``) so you can branch on the current stage and stay
    idempotent. No spend, no side effects — the operator policy allowlists it.
    """
    return helper.pipeline_operator_read(pipeline_id)


@mcp.tool()
def pipeline_operator_client_read(client_id: str) -> dict[str, Any]:
    """Read the client's brand / company / campaign context for a client_id.

    Use this AFTER ``pipeline_operator_read`` whenever the pipeline is linked to
    a client (the pipeline read carries a compact ``client`` block; this returns
    the FULL context). Returns ``slug``, ``name``, ``service_type``,
    ``brand_colors``, ``profile`` (the typed client_profiles row or null),
    ``offers``, ``offer_constraints`` (the do-not-say rules you MUST honor),
    ``services``, ``value_props`` (``usps`` / ``differentiators``), ``assets``,
    and ``past_projects``. Author on-brand, compliant ads from this: the
    client's REAL offers, brand voice/tone, proof points, and local market. No
    spend, no side effects — the operator policy allowlists it.
    """
    return helper.pipeline_operator_client_read(client_id)


@mcp.tool()
def pipeline_operator_brief(
    pipeline_id: str,
    image_payload: dict[str, Any],
    notes: Optional[str] = None,
    concepts: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Author or upsert the image brief for the pipeline.

    Use this in the ``configuration`` stage to record the brief the manager
    will review. ``image_payload`` must carry ``market``, ``offer_text``, and
    ``angles`` (build it with the ``image-ad-authoring`` skill).

    PASS ``concepts`` — the full set of N concept specs (each
    ``{concept, prompt, offer_text?}`` from ``build_concept``) — so the brief
    PERSISTS the whole concept plan. That lets the ideation render run as a
    single deterministic, worker-driven pass over the stored plan: you then call
    ``pipeline_operator_render(pipeline_id, "concept_preview")`` with NO items
    and the worker renders ALL persisted concepts at once, with no LLM in the
    per-image loop. Author all N concepts up front and pass them here.

    This is a free Supabase write — no paid API — so it is not spend-gated; the
    manager reviews the brief via the dashboard stage gate. Returns
    ``{ok, brief_id}``.
    """
    return helper.pipeline_operator_brief(
        pipeline_id=pipeline_id,
        image_payload=image_payload,
        notes=notes,
        concepts=concepts,
    )


@mcp.tool()
def pipeline_operator_render(
    pipeline_id: str,
    kind: str,
    items: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Render a stage's images in ONE deterministic pass — THE SPEND-GATED TOOL.

    PREFERRED: OMIT ``items``. The worker then renders the PERSISTED plan —
    every concept spec you stored via ``pipeline_operator_brief(concepts=...)``
    for ``kind="concept_preview"``, or one final per pick for ``kind="final"`` —
    ALL in one pass. You just trigger the stage; you do NOT author or loop items
    at render time, so a slow render can never collapse to "only one concept
    landed". A retried render resumes the remainder (already-rendered concepts
    are skipped). This is the path the SKILL prescribes.

    Legacy: pass ``items`` (``{concept, prompt, offer_text?,
    parent_creative_id?}``) to render exactly those — kept for back-compat.

    Use ``kind="concept_preview"`` in the ``ideation`` stage and ``kind="final"``
    in the ``generation`` stage (finals need ``parent_creative_id``; the
    deterministic path threads it from the picks; 9:16 finals come back as a true
    864x1536).

    The backend is chosen by the operator container's ``RENDER_BACKEND`` env: by
    default (``openai-codex``) the image is generated in-container on the
    manager's ChatGPT/Codex subscription ($0) and uploaded to the worker;
    ``kie`` restores the legacy paid path. Either way the approval plugin gates
    this call by name — the manager approves in the dashboard before any render
    runs. Returns ``{ok, renders, total_cost_usd, errors, skipped}``
    (``total_cost_usd`` is 0 on the codex backend).
    """
    return helper.pipeline_operator_render(
        pipeline_id=pipeline_id,
        kind=kind,
        items=items,
    )


def main() -> None:
    """Run the server over stdio (the default Hermes MCP transport)."""
    mcp.run()


if __name__ == "__main__":
    main()
