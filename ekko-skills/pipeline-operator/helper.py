"""Thin worker-tool client for the pipeline operator agent.

This is the *mechanical* half of the ``pipeline-operator`` skill. ``SKILL.md``
is the playbook (when to read state, when to author a brief, when to render);
this module is the typed, validated HTTP surface the operator calls to talk to
the Wave-A worker endpoints:

* ``GET  {WORKER_BASE_URL}/work/pipeline/tools/{pipeline_id}``  → read state
* ``POST {WORKER_BASE_URL}/work/pipeline/tools/brief``          → author brief
* ``POST {WORKER_BASE_URL}/work/pipeline/tools/render``         → render (SPEND)

Conventions match the sibling dashboard skills: synchronous ``httpx.Client``,
a custom error type, lazy env reads (so importing is free and tests need no
env), and a fresh client per call.

Tool-name surface (THE GATING CONTRACT)
---------------------------------------
The approval plugin (voxhorizon-approvals) gates tool calls **by tool name**
(exact match against its allowlist / requires-approval sets — see
``ekko-plugins/voxhorizon_approvals/policy.py::evaluate``). So the three
operator capabilities are exposed under *distinct, stable* entrypoint names
that the operator policy references one-for-one:

* ``pipeline_operator_read``   — the READ tool (allowlisted; no spend)
* ``pipeline_operator_brief``  — the BRIEF tool (free Supabase write)
* ``pipeline_operator_render`` — the RENDER tool (**spend; requires approval**)

Do NOT rename ``pipeline_operator_render`` without updating
``policy.operator.yaml`` in the plugin — the gate keys on this exact name.
``get_pipeline`` / ``post_brief`` / ``post_render`` remain as readable
aliases, but the gating-canonical names are the ``pipeline_operator_*`` ones.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx


class PipelineOperatorError(Exception):
    """Raised when a worker tool call fails (network, HTTP error, or config)."""


#: Worker base URL env var (e.g. ``http://worker:8000``).
ENV_WORKER_BASE_URL = "WORKER_BASE_URL"
#: Bearer shared secret env var (matches the worker's ``verify_secret``).
ENV_WORKER_SHARED_SECRET = "WORKER_SHARED_SECRET"

#: Route prefix for the operator tool endpoints on the worker.
_TOOLS_PREFIX = "/work/pipeline/tools"

#: The render ``kind`` values the worker accepts (Wave A contract).
RENDER_KINDS: frozenset[str] = frozenset({"concept_preview", "final"})


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _client() -> httpx.Client:
    """Build an httpx client pointed at the worker, authed with the secret.

    Reads ``WORKER_BASE_URL`` and ``WORKER_SHARED_SECRET`` from the
    environment. Both must be set; an empty string counts as unset so a
    misconfigured ``.env`` fails loudly rather than calling an anon worker.

    The read timeout is generous (120s) because ``render`` is a synchronous
    batch — the operator waits for Kie to finish so it can narrate the
    results to the manager.
    """
    url = os.environ.get(ENV_WORKER_BASE_URL, "").strip().rstrip("/")
    secret = os.environ.get(ENV_WORKER_SHARED_SECRET, "").strip()
    if not url or not secret:
        raise PipelineOperatorError(
            f"{ENV_WORKER_BASE_URL} or {ENV_WORKER_SHARED_SECRET} not set"
        )
    return httpx.Client(
        base_url=url,
        headers={
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
        },
        timeout=httpx.Timeout(connect=5.0, read=120.0, write=30.0, pool=30.0),
    )


def _request(
    method: str, path: str, *, json_body: Optional[dict[str, Any]] = None
) -> dict[str, Any]:
    """Issue one worker call and return the decoded JSON object.

    Any transport error or non-2xx is re-raised as
    :class:`PipelineOperatorError` with the response body so the operator can
    narrate a clear failure to the manager rather than retrying blindly.
    """
    try:
        with _client() as c:
            resp = c.request(method, path, json=json_body)
    except httpx.HTTPError as exc:
        raise PipelineOperatorError(
            f"network error calling {method} {path}: {exc}"
        ) from exc

    if resp.status_code >= 300:
        snippet = resp.text[:500] if resp.text else ""
        raise PipelineOperatorError(
            f"{method} {path} failed: {resp.status_code} {snippet}"
        )

    try:
        data = resp.json()
    except ValueError as exc:
        raise PipelineOperatorError(
            f"{method} {path} returned non-JSON body: {resp.text[:200]}"
        ) from exc

    if not isinstance(data, dict):
        raise PipelineOperatorError(
            f"{method} {path} returned non-object body: {resp.text[:200]}"
        )
    return data


def _require_pipeline_id(pipeline_id: Any) -> str:
    if not isinstance(pipeline_id, str) or not pipeline_id.strip():
        raise PipelineOperatorError("pipeline_id must be a non-empty string")
    return pipeline_id.strip()


# ---------------------------------------------------------------------------
# READ — pipeline_operator_read (allowlisted by the operator policy)
# ---------------------------------------------------------------------------


def pipeline_operator_read(pipeline_id: str) -> dict[str, Any]:
    """Read the full pipeline state for ``pipeline_id``.

    Calls ``GET {WORKER_BASE_URL}/work/pipeline/tools/{pipeline_id}`` and
    returns the worker's JSON: ``status``, ``format_choice``, ``config_draft``,
    ``picks``, ``brief``, ``concepts``, ``finals``, ``events_tail``.

    This is the operator's first move on every dispatch. It performs NO spend
    and the operator policy ALLOWLISTS it, so it never round-trips the manager.

    Raises:
        PipelineOperatorError: On missing env, network failure, non-2xx
            (e.g. 404 when the pipeline is missing), or a non-object body.
    """
    pid = _require_pipeline_id(pipeline_id)
    return _request("GET", f"{_TOOLS_PREFIX}/{pid}")


# ---------------------------------------------------------------------------
# BRIEF — pipeline_operator_brief (free Supabase write; not spend-gated)
# ---------------------------------------------------------------------------


def pipeline_operator_brief(
    *,
    pipeline_id: str,
    image_payload: dict[str, Any],
    notes: Optional[str] = None,
) -> dict[str, Any]:
    """Author / upsert the image brief for the pipeline.

    Calls ``POST {WORKER_BASE_URL}/work/pipeline/tools/brief`` with
    ``{pipeline_id, image_payload, notes?}``. ``image_payload`` must carry the
    worker-required keys ``market``, ``offer_text``, ``angles`` — build it with
    the ``image-ad-authoring`` skill's ``build_image_brief`` so it is valid
    before it leaves the agent.

    This is a free database write (no paid API), so the operator policy does
    not gate it for spend; the manager reviews the brief through the dashboard
    stage gate instead. Returns ``{ok, brief_id}``.

    Raises:
        PipelineOperatorError: On bad input, missing env, or a failed call.
    """
    pid = _require_pipeline_id(pipeline_id)
    if not isinstance(image_payload, dict) or not image_payload:
        raise PipelineOperatorError("image_payload must be a non-empty dict")
    missing = [
        k for k in ("market", "offer_text", "angles") if k not in image_payload
    ]
    if missing:
        raise PipelineOperatorError(
            f"image_payload missing required keys: {missing}"
        )

    body: dict[str, Any] = {"pipeline_id": pid, "image_payload": image_payload}
    if notes is not None:
        if not isinstance(notes, str):
            raise PipelineOperatorError("notes must be a string or None")
        body["notes"] = notes
    return _request("POST", f"{_TOOLS_PREFIX}/brief", json_body=body)


# ---------------------------------------------------------------------------
# RENDER — pipeline_operator_render (THE SPEND TOOL; requires approval)
# ---------------------------------------------------------------------------


def pipeline_operator_render(
    *,
    pipeline_id: str,
    kind: str,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    """Render a batch of concepts — THE SPEND TOOL.

    Calls ``POST {WORKER_BASE_URL}/work/pipeline/tools/render`` with
    ``{pipeline_id, kind, items}``. Each item is
    ``{concept, prompt, offer_text?, parent_creative_id?}`` (build them with
    the ``image-ad-authoring`` skill).

    * ``kind="concept_preview"`` renders 1:1 @ 1K previews (ideation). Send
      ALL concepts in ONE call so the manager sees a single spend approval for
      the whole ideation batch.
    * ``kind="final"`` renders 1:1 + 9:16 @ 2K finals (generation). Each item
      MUST carry ``parent_creative_id`` (the picked concept it derives from).

    This call spends real money on Kie renders, so the approval plugin gates
    it: the manager approves the spend in the dashboard before the worker
    runs. The gate keys on this function's tool name
    (``pipeline_operator_render``) — see ``policy.operator.yaml``.

    Returns ``{ok, renders:[...], total_cost_usd, errors:[...]}``.

    Raises:
        PipelineOperatorError: On bad input, missing env, or a failed call.
            (Per-item Kie failures are reported by the worker inside
            ``errors`` with a 2xx — they do NOT raise here.)
    """
    pid = _require_pipeline_id(pipeline_id)
    if kind not in RENDER_KINDS:
        raise PipelineOperatorError(
            f"kind must be one of {sorted(RENDER_KINDS)}, got {kind!r}"
        )
    if not isinstance(items, list) or not items:
        raise PipelineOperatorError("items must be a non-empty list")

    normalized: list[dict[str, Any]] = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            raise PipelineOperatorError(f"items[{idx}] must be a dict")
        concept = item.get("concept")
        prompt = item.get("prompt")
        if not isinstance(concept, str) or not concept.strip():
            raise PipelineOperatorError(
                f"items[{idx}].concept must be a non-empty string"
            )
        if not isinstance(prompt, str) or not prompt.strip():
            raise PipelineOperatorError(
                f"items[{idx}].prompt must be a non-empty string"
            )
        out: dict[str, Any] = {
            "concept": concept.strip(),
            "prompt": prompt.strip(),
        }
        offer_text = item.get("offer_text")
        if offer_text is not None:
            if not isinstance(offer_text, str):
                raise PipelineOperatorError(
                    f"items[{idx}].offer_text must be a string"
                )
            out["offer_text"] = offer_text
        parent = item.get("parent_creative_id")
        if kind == "final":
            # Finals are children of a picked concept; the worker needs the
            # parent to set creatives.parent_creative_id.
            if not isinstance(parent, str) or not parent.strip():
                raise PipelineOperatorError(
                    f"items[{idx}].parent_creative_id is required for "
                    "kind='final'"
                )
            out["parent_creative_id"] = parent.strip()
        elif parent is not None:
            if not isinstance(parent, str):
                raise PipelineOperatorError(
                    f"items[{idx}].parent_creative_id must be a string"
                )
            out["parent_creative_id"] = parent
        normalized.append(out)

    body = {"pipeline_id": pid, "kind": kind, "items": normalized}
    return _request("POST", f"{_TOOLS_PREFIX}/render", json_body=body)


# ---------------------------------------------------------------------------
# Conventional aliases (contract naming). The gating-canonical names are the
# pipeline_operator_* functions above; these are thin readability aliases.
# ---------------------------------------------------------------------------

get_pipeline = pipeline_operator_read
post_brief = pipeline_operator_brief
post_render = pipeline_operator_render


__all__ = [
    "ENV_WORKER_BASE_URL",
    "ENV_WORKER_SHARED_SECRET",
    "PipelineOperatorError",
    "RENDER_KINDS",
    "get_pipeline",
    "pipeline_operator_brief",
    "pipeline_operator_read",
    "pipeline_operator_render",
    "post_brief",
    "post_render",
]
