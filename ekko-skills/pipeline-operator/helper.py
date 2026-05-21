"""Thin worker-tool client for the pipeline operator agent.

This is the *mechanical* half of the ``pipeline-operator`` skill. ``SKILL.md``
is the playbook (when to read state, when to author a brief, when to render);
this module is the typed, validated HTTP surface the operator calls to talk to
the Wave-A worker endpoints:

* ``GET  {WORKER_BASE_URL}/work/pipeline/tools/{pipeline_id}``  → read state
* ``GET  {WORKER_BASE_URL}/work/client/{client_id}``            → client context
* ``POST {WORKER_BASE_URL}/work/pipeline/tools/brief``          → author brief
* ``POST {WORKER_BASE_URL}/work/pipeline/tools/render``         → render via Kie
* ``POST {WORKER_BASE_URL}/work/pipeline/tools/store_creative`` → store codex bytes

Conventions match the sibling dashboard skills: synchronous ``httpx.Client``,
a custom error type, lazy env reads (so importing is free and tests need no
env), and a fresh client per call.

Render backend (env ``RENDER_BACKEND``)
---------------------------------------
``pipeline_operator_render`` is backend-selectable. The DEFAULT, ``openai-codex``,
generates each image IN THE OPERATOR CONTAINER via Hermes' codex image-gen
plugin (the operator's ChatGPT/Codex subscription — gpt-image-2, $0; see
:mod:`codex_render`) and uploads the bytes to ``/store_creative``. Setting
``RENDER_BACKEND=kie`` restores the legacy paid path that POSTs to ``/render``.
Both backends produce identical worker-side rows / events / cost lines, so the
dashboard and the spend gate are unaffected by the choice; only the bill is.

Tool-name surface (THE GATING CONTRACT)
---------------------------------------
The approval plugin (voxhorizon-approvals) gates tool calls **by tool name**
(exact match against its allowlist / requires-approval sets — see
``ekko-plugins/voxhorizon_approvals/policy.py::evaluate``). So the three
operator capabilities are exposed under *distinct, stable* entrypoint names
that the operator policy references one-for-one:

* ``pipeline_operator_read``        — the READ tool (allowlisted; no spend)
* ``pipeline_operator_client_read`` — the CLIENT-CONTEXT tool (allowlisted; no spend)
* ``pipeline_operator_brief``       — the BRIEF tool (free Supabase write)
* ``pipeline_operator_render``      — the RENDER tool (**spend; requires approval**)

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
#: Render backend selector env var. ``openai-codex`` (default) generates the
#: image in-container via the operator's ChatGPT/Codex subscription ($0) and
#: uploads the bytes to the worker; ``kie`` POSTs to the worker's Kie /render
#: path (the legacy paid fallback).
ENV_RENDER_BACKEND = "RENDER_BACKEND"

#: Route prefix for the operator tool endpoints on the worker.
_TOOLS_PREFIX = "/work/pipeline/tools"

#: The render ``kind`` values the worker accepts (Wave A contract).
RENDER_KINDS: frozenset[str] = frozenset({"concept_preview", "final"})

#: Supported render backends.
BACKEND_OPENAI_CODEX = "openai-codex"
BACKEND_KIE = "kie"
RENDER_BACKENDS: frozenset[str] = frozenset({BACKEND_OPENAI_CODEX, BACKEND_KIE})
#: Default backend: the operator's subscription-backed codex renderer (free).
DEFAULT_RENDER_BACKEND = BACKEND_OPENAI_CODEX

#: Per-kind render parameters for the codex backend, mirroring the worker's
#: SOP (``pipeline_tools._CONCEPT_PREVIEW`` / ``_FINAL``): which ratios to
#: render and the version string each creative is stamped with.
_KIND_PARAMS: dict[str, dict[str, Any]] = {
    "concept_preview": {"ratios": ("1x1",), "version": "v0.ideation"},
    "final": {"ratios": ("1x1", "9x16"), "version": "v1.0"},
}


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


def _require_client_id(client_id: Any) -> str:
    if not isinstance(client_id, str) or not client_id.strip():
        raise PipelineOperatorError("client_id must be a non-empty string")
    return client_id.strip()


def _resolve_render_backend() -> str:
    """Resolve the active render backend from ``RENDER_BACKEND`` (env).

    Defaults to ``openai-codex`` (the operator's subscription-backed renderer).
    An unset / empty value uses the default; an unrecognized value raises so a
    typo in the container env fails loudly instead of silently spending on Kie.
    """
    raw = os.environ.get(ENV_RENDER_BACKEND, "").strip().lower()
    if not raw:
        return DEFAULT_RENDER_BACKEND
    if raw not in RENDER_BACKENDS:
        raise PipelineOperatorError(
            f"{ENV_RENDER_BACKEND} must be one of {sorted(RENDER_BACKENDS)}, "
            f"got {raw!r}"
        )
    return raw


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
# CLIENT READ — pipeline_operator_client_read (allowlisted; pure GET, no spend)
# ---------------------------------------------------------------------------


def pipeline_operator_client_read(client_id: str) -> dict[str, Any]:
    """Read the full client context for ``client_id``.

    Calls ``GET {WORKER_BASE_URL}/work/client/{client_id}`` and returns the
    worker's JSON: ``slug``, ``name``, ``service_type``, ``brand_colors``,
    ``profile`` (the typed ``client_profiles`` row or null), ``offers``,
    ``offer_constraints`` (the do-not-say rules), ``services``, ``value_props``
    (``usps`` / ``differentiators``), ``assets``, and ``past_projects``.

    Use this after ``pipeline_operator_read`` whenever the pipeline is linked to
    a client, so you can author on-brand, compliant ads from the client's REAL
    offers, brand voice, and proof points. This performs NO spend and the
    operator policy ALLOWLISTS it, so it never round-trips the manager.

    Raises:
        PipelineOperatorError: On missing env, network failure, non-2xx
            (e.g. 404 when the client is missing), or a non-object body.
    """
    cid = _require_client_id(client_id)
    return _request("GET", f"/work/client/{cid}")


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
    """Render a batch of concepts — THE SPEND-GATED TOOL.

    Each item is ``{concept, prompt, offer_text?, parent_creative_id?}`` (build
    them with the ``image-ad-authoring`` skill).

    * ``kind="concept_preview"`` renders 1:1 previews (ideation). Send ALL
      concepts in ONE call so the manager sees a single approval for the whole
      ideation batch.
    * ``kind="final"`` renders 1:1 + 9:16 finals (generation). Each item MUST
      carry ``parent_creative_id`` (the picked concept it derives from). 9:16 is
      a TRUE 9:16 (864x1536) on the codex backend.

    **Backend (env ``RENDER_BACKEND``, default ``openai-codex``):**

    * ``openai-codex`` — generate each image IN-CONTAINER via the operator's
      ChatGPT/Codex subscription (gpt-image-2 through the Codex Responses
      ``image_generation`` tool, $0) and upload the bytes to the worker's
      ``/work/pipeline/tools/store_creative``. No paid API.
    * ``kie`` — POST to the worker's ``/work/pipeline/tools/render`` (the legacy
      paid Kie path), kept as a selectable fallback.

    Either way the worker emits the SAME pipeline_events + cost line + creative
    row, so the dashboard, the auto-advance trigger, and the cost aggregator
    behave identically. The approval plugin gates this call by its tool name
    (``pipeline_operator_render``) regardless of backend — the manager approves
    in the dashboard before any render runs. The gate is unchanged.

    Returns ``{ok, renders:[...], total_cost_usd, errors:[...]}`` for both
    backends (the codex path synthesizes the same shape; ``total_cost_usd`` is
    0 there).

    Raises:
        PipelineOperatorError: On bad input, missing env, or a failed call.
            Per-item render failures are reported inside ``errors`` with a 2xx
            (they do NOT raise here), matching the Kie path.
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

    backend = _resolve_render_backend()
    if backend == BACKEND_KIE:
        body = {"pipeline_id": pid, "kind": kind, "items": normalized}
        return _request("POST", f"{_TOOLS_PREFIX}/render", json_body=body)
    return _render_via_codex(pipeline_id=pid, kind=kind, items=normalized)


# ---------------------------------------------------------------------------
# STORE — the worker side of the codex render (free; store pre-rendered bytes)
# ---------------------------------------------------------------------------


def pipeline_operator_store_creative(
    *,
    pipeline_id: str,
    kind: str,
    concept: str,
    ratio: str,
    version: str,
    prompt: str,
    image_b64: str,
    offer_text: Optional[str] = None,
    parent_creative_id: Optional[str] = None,
) -> dict[str, Any]:
    """Upload a pre-rendered (codex) image to the worker as a creative.

    Calls ``POST {WORKER_BASE_URL}/work/pipeline/tools/store_creative``. The
    worker uploads the bytes, records the creative + iteration + event rows,
    emits the same task_running/task_done pipeline_events, and records a
    zero-cost line against ``openai-codex``. Returns
    ``{creative_id, file_path_supabase, version}``.

    This is an internal helper for the codex render backend (not a separately
    gated tool): it is reached only THROUGH ``pipeline_operator_render`` after
    the spend gate has already cleared.
    """
    body: dict[str, Any] = {
        "pipeline_id": pipeline_id,
        "kind": kind,
        "concept": concept,
        "ratio": ratio,
        "version": version,
        "prompt": prompt,
        "image_b64": image_b64,
    }
    if offer_text is not None:
        body["offer_text"] = offer_text
    if parent_creative_id is not None:
        body["parent_creative_id"] = parent_creative_id
    return _request("POST", f"{_TOOLS_PREFIX}/store_creative", json_body=body)


def _render_via_codex(
    *, pipeline_id: str, kind: str, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """Generate each item's image(s) via codex, then store them on the worker.

    Mirrors the worker's per-kind ratio fan-out (concept_preview → 1x1; final →
    1x1 + 9x16) and synthesizes the same ``{ok, renders, total_cost_usd,
    errors}`` shape the Kie ``/render`` path returns. Per-item failures land in
    ``errors`` (a 2xx-equivalent) so one bad render doesn't abort the batch —
    matching the Kie path's behaviour.

    The image bytes are generated in-process via :mod:`codex_render` (the
    operator's ChatGPT/Codex subscription) and uploaded base64-encoded; cost is
    always 0 because nothing is paid.
    """
    import base64 as _b64

    # Imported lazily so the Kie path and the unit tests don't require Hermes.
    import codex_render

    params = _KIND_PARAMS[kind]
    ratios: tuple[str, ...] = params["ratios"]
    version: str = params["version"]

    renders: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for item in items:
        concept = item["concept"]
        prompt = item["prompt"]
        offer_text = item.get("offer_text")
        parent = item.get("parent_creative_id")
        for ratio in ratios:
            try:
                image_bytes = codex_render.render_image(prompt, ratio)
                image_b64 = _b64.b64encode(image_bytes).decode("ascii")
                stored = pipeline_operator_store_creative(
                    pipeline_id=pipeline_id,
                    kind=kind,
                    concept=concept,
                    ratio=ratio,
                    version=version,
                    prompt=prompt,
                    image_b64=image_b64,
                    offer_text=offer_text,
                    parent_creative_id=parent,
                )
                renders.append(
                    {
                        "creative_id": stored.get("creative_id"),
                        "concept": concept,
                        "ratio": ratio,
                        "file_path_supabase": stored.get("file_path_supabase"),
                        "cost_usd": 0,
                    }
                )
            except Exception as exc:  # noqa: BLE001 — collect, don't abort batch
                errors.append(
                    {"concept": concept, "ratio": ratio, "error": str(exc)}
                )

    return {
        "ok": True,
        "renders": renders,
        "total_cost_usd": 0,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# Conventional aliases (contract naming). The gating-canonical names are the
# pipeline_operator_* functions above; these are thin readability aliases.
# ---------------------------------------------------------------------------

get_pipeline = pipeline_operator_read
get_client = pipeline_operator_client_read
post_brief = pipeline_operator_brief
post_render = pipeline_operator_render


__all__ = [
    "ENV_WORKER_BASE_URL",
    "ENV_WORKER_SHARED_SECRET",
    "ENV_RENDER_BACKEND",
    "BACKEND_OPENAI_CODEX",
    "BACKEND_KIE",
    "RENDER_BACKENDS",
    "DEFAULT_RENDER_BACKEND",
    "PipelineOperatorError",
    "RENDER_KINDS",
    "get_client",
    "get_pipeline",
    "pipeline_operator_brief",
    "pipeline_operator_client_read",
    "pipeline_operator_read",
    "pipeline_operator_render",
    "pipeline_operator_store_creative",
    "post_brief",
    "post_render",
]
