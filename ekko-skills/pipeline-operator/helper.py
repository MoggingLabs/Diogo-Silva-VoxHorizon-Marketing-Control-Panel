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

Render routing (ideation always free; finals per-pipeline)
----------------------------------------------------------
``pipeline_operator_render`` routes by ``kind``, NOT by an env var:

* IDEATION (``kind="concept_preview"``) is HARDWIRED to the FREE codex model
  (gpt-image-2, LOW quality): each image is generated IN THE OPERATOR CONTAINER
  via Hermes' codex image-gen plugin (the operator's ChatGPT/Codex subscription,
  $0; see :mod:`codex_render`) and uploaded to ``/store_creative``. It is never
  selectable to a paid model.
* FINALS (``kind="final"``) use the manager's PER-PIPELINE "Finals model" choice,
  persisted at kickoff on ``config_draft.finals_render_backend`` +
  ``finals_render_model`` (default: the free codex model). The codex backend
  renders in-container at HIGH quality; the ``kie`` backend POSTs the chosen Kie
  model id (nano-banana-2 / Flux / Seedream) to ``/render``.

Both backends produce identical worker-side rows / events / cost lines, so the
dashboard is unaffected by the choice; only the bill is. The legacy
``RENDER_BACKEND`` env is no longer consulted for routing.

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

#: The FREE image model — codex/gpt-image-2. IDEATION (concept_preview) ALWAYS
#: uses this, regardless of any per-pipeline finals choice; it is the default
#: for finals too. Never selectable to a paid model for ideation.
FREE_MODEL = "gpt-image-2"

# ---------------------------------------------------------------------------
# Finals model registry — the manager's per-pipeline "Finals model" choice.
# ---------------------------------------------------------------------------
#
# Each entry maps a manager-facing label to the (backend, model) that renders
# the FINALS (generation) stage for that pipeline. IDEATION is NOT in here — it
# is hardwired to the free codex/gpt-image-2 model below. The label set here is
# the single source of truth the dashboard mirrors in its dropdown.
#
# Verified Kie model ids (see worker/src/services/kie.py): nano-banana-2,
# flux-2/pro-text-to-image (Flux), bytedance/seedream-v4-text-to-image (Seedream).
FINALS_MODELS: dict[str, dict[str, str]] = {
    "gpt-image-2 (free)": {"backend": BACKEND_OPENAI_CODEX, "model": FREE_MODEL},
    "nano-banana-2": {"backend": BACKEND_KIE, "model": "nano-banana-2"},
    "Flux": {"backend": BACKEND_KIE, "model": "flux-2/pro-text-to-image"},
    "Seedream": {
        "backend": BACKEND_KIE,
        "model": "bytedance/seedream-v4-text-to-image",
    },
}
#: Default finals model label — the FREE one.
DEFAULT_FINALS_LABEL = "gpt-image-2 (free)"

#: Per-kind render parameters for the codex backend, mirroring the worker's
#: SOP (``pipeline_tools._CONCEPT_PREVIEW`` / ``_FINAL``): which ratios to
#: render, the version string each creative is stamped with, and the codex image
#: quality (ideation is LOW/cheap; finals are HIGH for production-grade output).
_KIND_PARAMS: dict[str, dict[str, Any]] = {
    "concept_preview": {
        "ratios": ("1x1",),
        "version": "v0.ideation",
        "quality": "low",
    },
    "final": {"ratios": ("1x1", "9x16"), "version": "v1.0", "quality": "high"},
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


def _resolve_finals_model(state: dict[str, Any]) -> tuple[str, str]:
    """Resolve the per-pipeline FINALS (backend, model) from pipeline state.

    The manager's "Finals model" choice is persisted at kickoff on
    ``config_draft.finals_render_backend`` + ``finals_render_model``. When absent
    or unrecognized we fall back to the FREE default (codex/gpt-image-2) so a
    pipeline created before this feature, or with a stale value, still renders
    finals for $0. IDEATION never calls this — it is hardwired to the free model.
    """
    default = FINALS_MODELS[DEFAULT_FINALS_LABEL]
    config_draft = state.get("config_draft")
    if not isinstance(config_draft, dict):
        return default["backend"], default["model"]
    backend = config_draft.get("finals_render_backend")
    model = config_draft.get("finals_render_model")
    if not isinstance(backend, str) or backend not in RENDER_BACKENDS:
        return default["backend"], default["model"]
    if not isinstance(model, str) or not model.strip():
        return default["backend"], default["model"]
    return backend, model.strip()


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
    concepts: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Author / upsert the image brief for the pipeline.

    Calls ``POST {WORKER_BASE_URL}/work/pipeline/tools/brief`` with
    ``{pipeline_id, image_payload, notes?, concepts?}``. ``image_payload`` must
    carry the worker-required keys ``market``, ``offer_text``, ``angles`` —
    build it with the ``image-ad-authoring`` skill's ``build_image_brief`` so it
    is valid before it leaves the agent.

    ``concepts`` is the full set of N concept specs (each
    ``{concept, prompt, offer_text?}`` — build them with ``build_concept`` and
    ``assert_distinct_concepts``). Persisting them HERE, at brief time, is what
    lets the ideation render run as a single DETERMINISTIC, worker-driven pass
    over the stored plan: ``pipeline_operator_render(pipeline_id, "concept_preview")``
    then renders ALL persisted concepts with no LLM in the per-image loop, and a
    retried render resumes the remainder instead of re-authoring. Author every
    concept up front and pass them all here.

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
    if concepts is not None:
        body["concepts"] = _normalize_concept_specs(concepts)
    return _request("POST", f"{_TOOLS_PREFIX}/brief", json_body=body)


def _normalize_concept_specs(
    concepts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Validate + normalize the persisted concept specs for the brief body.

    Each must be ``{concept, prompt}`` (+ optional ``offer_text`` /
    ``parent_creative_id`` passthrough). Mirrors the per-item validation in
    :func:`pipeline_operator_render` so a malformed plan fails loudly at brief
    time rather than producing a broken deterministic render later.
    """
    if not isinstance(concepts, list) or not concepts:
        raise PipelineOperatorError("concepts must be a non-empty list")
    out: list[dict[str, Any]] = []
    for idx, spec in enumerate(concepts):
        if not isinstance(spec, dict):
            raise PipelineOperatorError(f"concepts[{idx}] must be a dict")
        concept = spec.get("concept")
        prompt = spec.get("prompt")
        if not isinstance(concept, str) or not concept.strip():
            raise PipelineOperatorError(
                f"concepts[{idx}].concept must be a non-empty string"
            )
        if not isinstance(prompt, str) or not prompt.strip():
            raise PipelineOperatorError(
                f"concepts[{idx}].prompt must be a non-empty string"
            )
        norm: dict[str, Any] = {
            "concept": concept.strip(),
            "prompt": prompt.strip(),
        }
        offer_text = spec.get("offer_text")
        if offer_text is not None:
            if not isinstance(offer_text, str):
                raise PipelineOperatorError(
                    f"concepts[{idx}].offer_text must be a string"
                )
            norm["offer_text"] = offer_text
        out.append(norm)
    return out


# ---------------------------------------------------------------------------
# RENDER — pipeline_operator_render (THE SPEND TOOL; requires approval)
# ---------------------------------------------------------------------------


def pipeline_operator_render(
    *,
    pipeline_id: str,
    kind: str,
    items: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Render a stage's images in ONE deterministic pass — THE SPEND-GATED TOOL.

    **Preferred (deterministic) usage: omit ``items``.** The worker/helper then
    fans out over the PERSISTED plan — every concept spec authored at brief time
    (``concept_preview``) or one final per pick (``final``) — and renders ALL of
    them in a single pass. The operator just triggers the stage; it does NOT
    author or loop items at render time, so a slow render can never collapse to
    "only one concept landed". A retried render resumes the remainder
    idempotently (already-rendered concepts are skipped). This is the path the
    SKILL prescribes — persist all N concepts via ``pipeline_operator_brief`` and
    then call ``pipeline_operator_render(pipeline_id, kind)``.

    Legacy / explicit usage: pass ``items`` (``{concept, prompt, offer_text?,
    parent_creative_id?}``) to render exactly those. Kept for back-compat and
    one-off renders.

    * ``kind="concept_preview"`` renders 1:1 previews (ideation). IDEATION IS
      ALWAYS FREE: it renders via codex/gpt-image-2 (LOW quality) regardless of
      the ``RENDER_BACKEND`` env or the pipeline's finals choice — never paid,
      never selectable. The deterministic path renders ALL persisted concepts in
      one approval.
    * ``kind="final"`` renders 1:1 + 9:16 finals (generation). The image model is
      the manager's PER-PIPELINE "Finals model" choice, persisted at kickoff on
      ``config_draft.finals_render_backend`` + ``finals_render_model`` (default:
      the free codex/gpt-image-2). Each item MUST carry ``parent_creative_id``
      (the picked concept it derives from); the deterministic path threads it
      from the picks automatically. 9:16 is a TRUE 9:16 (864x1536) on codex.

    **Finals backend (per pipeline, NOT the env):**

    * ``openai-codex`` — generate each image IN-CONTAINER via the operator's
      ChatGPT/Codex subscription (gpt-image-2 through the Codex Responses
      ``image_generation`` tool, $0, HIGH quality for finals) and upload the
      bytes to the worker's ``/work/pipeline/tools/store_creative``. No paid API.
      This is also the ideation path (LOW quality).
    * ``kie`` — POST to the worker's ``/work/pipeline/tools/render`` (the paid Kie
      path) with the chosen Kie model id (nano-banana-2 / Flux / Seedream).

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

    # Resolve the (backend, model) for THIS render.
    #   * IDEATION (concept_preview) is HARDWIRED to the free codex/gpt-image-2.
    #     It never consults RENDER_BACKEND or the finals choice — it can never be
    #     a paid model.
    #   * FINALS read the manager's per-pipeline choice from pipeline state
    #     (config_draft.finals_render_backend / finals_render_model), defaulting
    #     to the free codex model.
    if kind == "concept_preview":
        backend, model = BACKEND_OPENAI_CODEX, FREE_MODEL
        state: Optional[dict[str, Any]] = None
    else:
        state = pipeline_operator_read(pid)
        backend, model = _resolve_finals_model(state)

    # Deterministic path: no items supplied → render the persisted plan.
    if items is None:
        if backend == BACKEND_KIE:
            # The worker resolves the persisted plan itself for the Kie path; we
            # thread the chosen model id so it renders with the finals model.
            body = {"pipeline_id": pid, "kind": kind, "model": model}
            return _request("POST", f"{_TOOLS_PREFIX}/render", json_body=body)
        resolved = _resolve_deterministic_items(pid, kind, state=state)
        if not resolved:
            # Nothing to render — empty plan or everything already done.
            return {
                "ok": True,
                "renders": [],
                "total_cost_usd": 0,
                "errors": [],
                "skipped": [],
            }
        return _render_via_codex(pipeline_id=pid, kind=kind, items=resolved)

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

    if backend == BACKEND_KIE:
        body = {
            "pipeline_id": pid,
            "kind": kind,
            "items": normalized,
            "model": model,
        }
        return _request("POST", f"{_TOOLS_PREFIX}/render", json_body=body)
    return _render_via_codex(pipeline_id=pid, kind=kind, items=normalized)


def _resolve_deterministic_items(
    pipeline_id: str, kind: str, *, state: Optional[dict[str, Any]] = None
) -> list[dict[str, Any]]:
    """Build the codex render batch from the PERSISTED plan (no items supplied).

    Reads pipeline state and, for ``concept_preview``, returns every persisted
    concept spec not yet stored at ``v0.ideation``; for ``final``, returns one
    item per picked creative (``parent_creative_id`` threaded) not yet stored at
    ``v1``. The already-rendered skip makes a retried render resume the
    remainder — the exact fix for a pipeline stuck at 1/N concepts.

    This keeps the LLM out of the per-image loop entirely: the operator triggers
    the stage, and the deterministic plan comes from the brief it already
    authored, not from prompts re-held across a long synchronous render.

    ``state`` is an optional already-fetched pipeline read (the finals path reads
    it once to resolve the per-pipeline model and reuses it here); when omitted we
    fetch it.
    """
    if state is None:
        state = pipeline_operator_read(pipeline_id)
    specs = _persisted_concepts_from_state(state)

    if kind == "concept_preview":
        done = {
            c.get("concept")
            for c in (state.get("concepts") or [])
            if isinstance(c, dict) and c.get("concept")
        }
        out: list[dict[str, Any]] = []
        for spec in specs:
            concept = str(spec.get("concept") or "").strip()
            prompt = str(spec.get("prompt") or "").strip()
            if not concept or not prompt or concept in done:
                continue
            item: dict[str, Any] = {"concept": concept, "prompt": prompt}
            if spec.get("offer_text"):
                item["offer_text"] = spec["offer_text"]
            out.append(item)
        return out

    # final: one item per pick; recover concept + prompt from the picked
    # creative and the persisted plan, thread parent_creative_id.
    picks = state.get("picks")
    picked_ids = (picks.get("image", []) if isinstance(picks, dict) else []) or []
    specs_by_concept = {
        str(s.get("concept")): s for s in specs if s.get("concept")
    }
    by_id = {
        c.get("creative_id"): c
        for c in (state.get("concepts") or [])
        if isinstance(c, dict)
    }
    done = {
        f.get("concept")
        for f in (state.get("finals") or [])
        if isinstance(f, dict) and f.get("concept")
    }
    out = []
    for cid in picked_ids:
        row = by_id.get(cid)
        if not isinstance(row, dict):
            continue
        concept = str(row.get("concept") or "").strip()
        if not concept or concept in done:
            continue
        spec = specs_by_concept.get(concept)
        prompt = (
            str(spec.get("prompt")).strip()
            if spec and spec.get("prompt")
            else None
        )
        if not prompt:
            continue
        item = {
            "concept": concept,
            "prompt": prompt,
            "parent_creative_id": str(cid),
        }
        if spec and spec.get("offer_text"):
            item["offer_text"] = spec["offer_text"]
        out.append(item)
    return out


def _persisted_concepts_from_state(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull the persisted concept specs out of a pipeline read response.

    The brief endpoint mirrors them onto ``config_draft.concepts`` (and the
    brief payload's ``concepts`` key); prefer config_draft, fall back to the
    brief payload.
    """
    config_draft = state.get("config_draft")
    if isinstance(config_draft, dict):
        specs = config_draft.get("concepts")
        if isinstance(specs, list) and specs:
            return [s for s in specs if isinstance(s, dict)]
        payload = config_draft.get("image_payload")
        if isinstance(payload, dict):
            specs = payload.get("concepts")
            if isinstance(specs, list) and specs:
                return [s for s in specs if isinstance(s, dict)]
    brief = state.get("brief")
    if isinstance(brief, dict) and isinstance(brief.get("payload"), dict):
        specs = brief["payload"].get("concepts")
        if isinstance(specs, list) and specs:
            return [s for s in specs if isinstance(s, dict)]
    return []


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
    # Per-kind codex image quality: ideation is LOW (cheap previews), finals are
    # HIGH (production-grade). Passed explicitly so the operator container's
    # OPENAI_IMAGE_QUALITY env (set to low for ideation) can't downgrade finals.
    quality: str = params["quality"]

    renders: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for item in items:
        concept = item["concept"]
        prompt = item["prompt"]
        offer_text = item.get("offer_text")
        parent = item.get("parent_creative_id")
        for ratio in ratios:
            try:
                image_bytes = codex_render.render_image(
                    prompt, ratio, quality=quality
                )
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
    "FREE_MODEL",
    "FINALS_MODELS",
    "DEFAULT_FINALS_LABEL",
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
