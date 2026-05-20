"""Unit tests for the ``pipeline-operator`` helper.

``httpx.Client`` is patched into a recorder that captures every request and
returns scripted responses; the helper never talks over the wire. We exercise:

* Env var resolution (``WORKER_BASE_URL`` / ``WORKER_SHARED_SECRET``) and the
  Bearer auth header.
* ``pipeline_operator_read`` — GET path + returned object.
* ``pipeline_operator_brief`` — body shape, required-key validation, notes.
* ``pipeline_operator_render`` — body shape, kind validation, item validation,
  the ``parent_creative_id``-required-for-finals rule, batch passthrough.
* The conventional aliases point at the gating-canonical functions.
* HTTP error paths — 4xx/5xx, network errors, non-JSON / non-object bodies.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx
import pytest

HELPER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HELPER_DIR))

from helper import (  # noqa: E402
    PipelineOperatorError,
    get_pipeline,
    pipeline_operator_brief,
    pipeline_operator_read,
    pipeline_operator_render,
    post_brief,
    post_render,
)
import helper as helper_module  # noqa: E402


# ---------------------------------------------------------------------------
# Fake httpx plumbing
# ---------------------------------------------------------------------------


@dataclass
class _Request:
    method: str
    url: str
    json_body: Any


@dataclass
class _FakeResponse:
    status_code: int = 200
    body: Any = field(default_factory=dict)

    @property
    def text(self) -> str:
        try:
            return json.dumps(self.body)
        except TypeError:
            return str(self.body)

    def json(self) -> Any:
        if isinstance(self.body, str):
            raise ValueError("not json")
        return self.body


class _FakeClient:
    """Records every request; returns scripted responses (shared by ref)."""

    def __init__(
        self,
        *,
        base_url: str,
        headers: dict[str, str],
        timeout: Any,
        responses: list[_FakeResponse],
        raise_on: Optional[str] = None,
    ) -> None:
        self.base_url = base_url
        self.headers = headers
        self.timeout = timeout
        self._responses = responses
        self._raise_on = raise_on
        self.requests: list[_Request] = []

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *args: Any) -> None:
        return None

    def request(
        self, method: str, path: str, *, json: Any = None
    ) -> _FakeResponse:
        self.requests.append(_Request(method=method, url=path, json_body=json))
        if self._raise_on == method:
            raise httpx.ConnectError("simulated network failure")
        if not self._responses:
            raise AssertionError(f"unexpected extra request to {method} {path}")
        return self._responses.pop(0)


@pytest.fixture
def env_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_BASE_URL", "http://worker.test:8000")
    monkeypatch.setenv("WORKER_SHARED_SECRET", "shh-secret")


def _install_fake_client(
    monkeypatch: pytest.MonkeyPatch,
    responses: list[_FakeResponse],
    *,
    raise_on: Optional[str] = None,
) -> list[_FakeClient]:
    built: list[_FakeClient] = []
    queue = list(responses)

    def factory(*, base_url: str, headers: dict[str, str], timeout: Any) -> _FakeClient:
        c = _FakeClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            responses=queue,
            raise_on=raise_on,
        )
        built.append(c)
        return c

    monkeypatch.setattr(helper_module.httpx, "Client", factory)
    return built


# ---------------------------------------------------------------------------
# Env / auth
# ---------------------------------------------------------------------------


def test_missing_base_url_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORKER_BASE_URL", raising=False)
    monkeypatch.setenv("WORKER_SHARED_SECRET", "x")
    with pytest.raises(PipelineOperatorError, match="WORKER_BASE_URL"):
        pipeline_operator_read("p-1")


def test_missing_secret_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_BASE_URL", "http://worker.test:8000")
    monkeypatch.delenv("WORKER_SHARED_SECRET", raising=False)
    with pytest.raises(PipelineOperatorError, match="WORKER_SHARED_SECRET"):
        pipeline_operator_read("p-1")


def test_empty_env_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_BASE_URL", "")
    monkeypatch.setenv("WORKER_SHARED_SECRET", "")
    with pytest.raises(PipelineOperatorError, match="not set"):
        pipeline_operator_read("p-1")


def test_client_uses_bearer_auth_and_base_url(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    built = _install_fake_client(
        monkeypatch, responses=[_FakeResponse(200, {"status": "configuration"})]
    )
    pipeline_operator_read("p-1")
    assert len(built) == 1
    c = built[0]
    assert c.base_url == "http://worker.test:8000"
    assert c.headers["Authorization"] == "Bearer shh-secret"
    assert c.headers["Content-Type"] == "application/json"


def test_base_url_trailing_slash_stripped(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WORKER_BASE_URL", "http://worker.test:8000/")
    built = _install_fake_client(
        monkeypatch, responses=[_FakeResponse(200, {"status": "ideation"})]
    )
    pipeline_operator_read("p-1")
    assert built[0].base_url == "http://worker.test:8000"


# ---------------------------------------------------------------------------
# pipeline_operator_read
# ---------------------------------------------------------------------------


def test_read_calls_get_with_pipeline_path(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = {"pipeline_id": "p-1", "status": "ideation", "picks": {"image": []}}
    built = _install_fake_client(monkeypatch, responses=[_FakeResponse(200, state)])
    out = pipeline_operator_read("p-1")
    assert out == state
    req = built[0].requests[0]
    assert req.method == "GET"
    assert req.url == "/work/pipeline/tools/p-1"
    assert req.json_body is None


def test_read_rejects_blank_pipeline_id(env_set: None) -> None:
    with pytest.raises(PipelineOperatorError, match="pipeline_id"):
        pipeline_operator_read("   ")


def test_read_404_raises(env_set: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_client(
        monkeypatch, responses=[_FakeResponse(404, {"detail": "not found"})]
    )
    with pytest.raises(PipelineOperatorError, match="failed: 404"):
        pipeline_operator_read("ghost")


# ---------------------------------------------------------------------------
# pipeline_operator_brief
# ---------------------------------------------------------------------------


def _payload() -> dict[str, Any]:
    return {
        "market": "Austin TX roofing",
        "offer_text": "$99 roof inspection",
        "angles": ["before_after", "savings"],
    }


def test_brief_posts_expected_body(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    built = _install_fake_client(
        monkeypatch, responses=[_FakeResponse(200, {"ok": True, "brief_id": "b-1"})]
    )
    out = pipeline_operator_brief(
        pipeline_id="p-1", image_payload=_payload(), notes="sharpened offer"
    )
    assert out == {"ok": True, "brief_id": "b-1"}
    req = built[0].requests[0]
    assert req.method == "POST"
    assert req.url == "/work/pipeline/tools/brief"
    assert req.json_body == {
        "pipeline_id": "p-1",
        "image_payload": _payload(),
        "notes": "sharpened offer",
    }


def test_brief_omits_notes_when_none(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    built = _install_fake_client(
        monkeypatch, responses=[_FakeResponse(200, {"ok": True, "brief_id": "b-1"})]
    )
    pipeline_operator_brief(pipeline_id="p-1", image_payload=_payload())
    assert "notes" not in built[0].requests[0].json_body


def test_brief_requires_payload_keys(env_set: None) -> None:
    with pytest.raises(PipelineOperatorError, match="missing required keys"):
        pipeline_operator_brief(
            pipeline_id="p-1",
            image_payload={"market": "Austin", "offer_text": "$99"},  # no angles
        )


def test_brief_rejects_empty_payload(env_set: None) -> None:
    with pytest.raises(PipelineOperatorError, match="non-empty dict"):
        pipeline_operator_brief(pipeline_id="p-1", image_payload={})


def test_brief_rejects_non_string_notes(env_set: None) -> None:
    with pytest.raises(PipelineOperatorError, match="notes"):
        pipeline_operator_brief(
            pipeline_id="p-1",
            image_payload=_payload(),
            notes=123,  # type: ignore[arg-type]
        )


# ---------------------------------------------------------------------------
# pipeline_operator_render
# ---------------------------------------------------------------------------


def test_render_concept_preview_batches_all_items(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    resp = {"ok": True, "renders": [], "total_cost_usd": 0.08, "errors": []}
    built = _install_fake_client(monkeypatch, responses=[_FakeResponse(200, resp)])
    items = [
        {"concept": "before_after__a", "prompt": "prompt a"},
        {"concept": "savings__b", "prompt": "prompt b", "offer_text": "$99"},
    ]
    out = pipeline_operator_render(
        pipeline_id="p-1", kind="concept_preview", items=items
    )
    assert out == resp
    req = built[0].requests[0]
    assert req.method == "POST"
    assert req.url == "/work/pipeline/tools/render"
    # All items in ONE call (one spend gate).
    assert req.json_body == {
        "pipeline_id": "p-1",
        "kind": "concept_preview",
        "items": [
            {"concept": "before_after__a", "prompt": "prompt a"},
            {"concept": "savings__b", "prompt": "prompt b", "offer_text": "$99"},
        ],
    }


def test_render_final_requires_parent_creative_id(env_set: None) -> None:
    with pytest.raises(PipelineOperatorError, match="parent_creative_id is required"):
        pipeline_operator_render(
            pipeline_id="p-1",
            kind="final",
            items=[{"concept": "savings__b", "prompt": "final prompt"}],
        )


def test_render_final_passes_parent_creative_id(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    built = _install_fake_client(
        monkeypatch,
        responses=[_FakeResponse(200, {"ok": True, "renders": [], "total_cost_usd": 0.1, "errors": []})],
    )
    pipeline_operator_render(
        pipeline_id="p-1",
        kind="final",
        items=[
            {
                "concept": "savings__b",
                "prompt": "final prompt",
                "parent_creative_id": "cr-9",
            }
        ],
    )
    body = built[0].requests[0].json_body
    assert body["items"][0]["parent_creative_id"] == "cr-9"


def test_render_rejects_unknown_kind(env_set: None) -> None:
    with pytest.raises(PipelineOperatorError, match="kind must be one of"):
        pipeline_operator_render(
            pipeline_id="p-1",
            kind="teaser",
            items=[{"concept": "x", "prompt": "y"}],
        )


def test_render_rejects_empty_items(env_set: None) -> None:
    with pytest.raises(PipelineOperatorError, match="non-empty list"):
        pipeline_operator_render(
            pipeline_id="p-1", kind="concept_preview", items=[]
        )


def test_render_rejects_item_without_prompt(env_set: None) -> None:
    with pytest.raises(PipelineOperatorError, match=r"items\[0\].prompt"):
        pipeline_operator_render(
            pipeline_id="p-1",
            kind="concept_preview",
            items=[{"concept": "before_after__a"}],
        )


def test_render_rejects_item_without_concept(env_set: None) -> None:
    with pytest.raises(PipelineOperatorError, match=r"items\[0\].concept"):
        pipeline_operator_render(
            pipeline_id="p-1",
            kind="concept_preview",
            items=[{"prompt": "p"}],
        )


def test_render_strips_whitespace_in_items(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    built = _install_fake_client(
        monkeypatch,
        responses=[_FakeResponse(200, {"ok": True, "renders": [], "total_cost_usd": 0, "errors": []})],
    )
    pipeline_operator_render(
        pipeline_id="p-1",
        kind="concept_preview",
        items=[{"concept": "  before_after__a  ", "prompt": "  prompt a  "}],
    )
    item = built[0].requests[0].json_body["items"][0]
    assert item == {"concept": "before_after__a", "prompt": "prompt a"}


def test_render_per_item_errors_do_not_raise(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Worker reports per-item failures inside a 2xx body; helper returns it."""
    resp = {
        "ok": True,
        "renders": [{"creative_id": "cr-1", "concept": "a", "ratio": "1x1"}],
        "total_cost_usd": 0.02,
        "errors": [{"concept": "b", "error": "kie 429"}],
    }
    _install_fake_client(monkeypatch, responses=[_FakeResponse(200, resp)])
    out = pipeline_operator_render(
        pipeline_id="p-1",
        kind="concept_preview",
        items=[{"concept": "a", "prompt": "pa"}, {"concept": "b", "prompt": "pb"}],
    )
    assert out["errors"] == [{"concept": "b", "error": "kie 429"}]


# ---------------------------------------------------------------------------
# Error paths shared by all calls
# ---------------------------------------------------------------------------


def test_network_error_raises(env_set: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_client(monkeypatch, responses=[], raise_on="GET")
    with pytest.raises(PipelineOperatorError, match="network error"):
        pipeline_operator_read("p-1")


def test_non_json_body_raises(env_set: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_client(monkeypatch, responses=[_FakeResponse(200, "not json")])
    with pytest.raises(PipelineOperatorError, match="non-JSON body"):
        pipeline_operator_read("p-1")


def test_non_object_body_raises(env_set: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_client(monkeypatch, responses=[_FakeResponse(200, [1, 2, 3])])
    with pytest.raises(PipelineOperatorError, match="non-object body"):
        pipeline_operator_read("p-1")


def test_5xx_raises(env_set: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_client(monkeypatch, responses=[_FakeResponse(503, {"detail": "down"})])
    with pytest.raises(PipelineOperatorError, match="failed: 503"):
        pipeline_operator_read("p-1")


# ---------------------------------------------------------------------------
# Aliases
# ---------------------------------------------------------------------------


def test_aliases_point_at_canonical_functions() -> None:
    assert get_pipeline is pipeline_operator_read
    assert post_brief is pipeline_operator_brief
    assert post_render is pipeline_operator_render
