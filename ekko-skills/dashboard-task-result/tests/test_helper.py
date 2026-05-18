"""Unit tests for the ``dashboard-task-result`` helper.

We exercise:

* Input validation (kanban_task_id, pipeline_id, result, success types).
* Env var resolution (``SUPABASE_URL`` / ``SUPABASE_SECRET_KEY``).
* Successful round-trip: PATCH ``hermes_tasks`` then POST
  ``pipeline_events`` with the right payload shape.
* The success / failure status mapping (``completed`` ↔ ``task_completed``,
  ``failed`` ↔ ``task_failed``).
* The ``pipeline_id=None`` branch — must omit the field from the body so
  PostgREST records NULL rather than the string ``"None"``.
* HTTP error paths — 4xx, 5xx, network errors, non-JSON bodies, 0-row
  PATCH matches.

``httpx.Client`` is patched into a recorder that captures every request and
returns whatever the test seeded; the helper module is never actually
talking over the wire.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx
import pytest

# The helper lives one level up from this tests/ directory. Adding the
# parent to sys.path lets us import it without dragging in the rest of
# the repo's Python tooling.
HELPER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HELPER_DIR))

from helper import (  # noqa: E402
    DashboardTaskResultError,
    publish_task_result,
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
    params: dict[str, str]


@dataclass
class _FakeResponse:
    status_code: int = 200
    body: Any = field(default_factory=list)

    @property
    def text(self) -> str:
        try:
            return json.dumps(self.body)
        except TypeError:
            return str(self.body)

    def json(self) -> Any:
        if isinstance(self.body, str):
            # Simulate a non-JSON body — raise ValueError like httpx does
            raise ValueError("not json")
        return self.body


class _FakeClient:
    """Records every request issued through it; returns scripted responses.

    The response queue is shared by reference across all clients built by
    the factory so the helper can open a fresh client per HTTP call (its
    actual pattern) while still draining a single ordered list of scripted
    responses across the whole publish call.
    """

    def __init__(
        self,
        *,
        base_url: str,
        headers: dict[str, str],
        timeout: float,
        responses: list[_FakeResponse],
        raise_on: Optional[str] = None,
    ) -> None:
        self.base_url = base_url
        self.headers = headers
        self.timeout = timeout
        # Share by reference — siblings need to see prior pops.
        self._responses = responses
        self._raise_on = raise_on
        self.requests: list[_Request] = []

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *args: Any) -> None:
        return None

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[dict[str, str]] = None,
    ) -> _FakeResponse:
        self.requests.append(
            _Request(
                method=method,
                url=path,
                json_body=json,
                params=dict(params or {}),
            )
        )
        if self._raise_on == method:
            raise httpx.ConnectError("simulated network failure")
        if not self._responses:
            raise AssertionError(
                f"unexpected extra request to {method} {path}"
            )
        return self._responses.pop(0)


@pytest.fixture
def env_set(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set the two Supabase env vars to plausible (non-empty) values."""
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-service-role")


def _install_fake_client(
    monkeypatch: pytest.MonkeyPatch,
    responses: list[_FakeResponse],
    *,
    raise_on: Optional[str] = None,
) -> list[_FakeClient]:
    """Patch ``httpx.Client`` inside the helper module with our recorder.

    Returns a list (populated as the helper constructs clients) so each test
    can inspect every request the helper made. The ``responses`` list is
    captured by reference: each fresh ``_FakeClient`` reads from it, so
    pops are visible across siblings (the helper opens a new client per
    HTTP call).
    """
    built: list[_FakeClient] = []
    # One shared queue across every factory call this test makes.
    queue = list(responses)

    def factory(*, base_url: str, headers: dict[str, str], timeout: float) -> _FakeClient:
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
# Input validation
# ---------------------------------------------------------------------------


def test_rejects_empty_kanban_task_id(env_set: None) -> None:
    with pytest.raises(DashboardTaskResultError, match="kanban_task_id"):
        publish_task_result(
            kanban_task_id="",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_rejects_non_string_kanban_task_id(env_set: None) -> None:
    with pytest.raises(DashboardTaskResultError, match="kanban_task_id"):
        publish_task_result(
            kanban_task_id=123,  # type: ignore[arg-type]
            pipeline_id=None,
            result={},
            success=True,
        )


def test_rejects_empty_pipeline_id(env_set: None) -> None:
    with pytest.raises(DashboardTaskResultError, match="pipeline_id"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id="",
            result={},
            success=True,
        )


def test_rejects_non_string_pipeline_id(env_set: None) -> None:
    with pytest.raises(DashboardTaskResultError, match="pipeline_id"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=42,  # type: ignore[arg-type]
            result={},
            success=True,
        )


def test_rejects_non_dict_result(env_set: None) -> None:
    with pytest.raises(DashboardTaskResultError, match="result"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result="not a dict",  # type: ignore[arg-type]
            success=True,
        )


def test_rejects_non_bool_success(env_set: None) -> None:
    with pytest.raises(DashboardTaskResultError, match="success"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success="yes",  # type: ignore[arg-type]
        )


# ---------------------------------------------------------------------------
# Env var resolution
# ---------------------------------------------------------------------------


def test_missing_supabase_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-key")
    with pytest.raises(DashboardTaskResultError, match="SUPABASE_URL"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_missing_secret_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    with pytest.raises(DashboardTaskResultError, match="SUPABASE_SECRET_KEY"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_empty_env_vars_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "")
    with pytest.raises(DashboardTaskResultError, match="not set"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_client_built_with_secret_headers(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    built = _install_fake_client(
        monkeypatch,
        responses=[
            _FakeResponse(status_code=200, body=[{"id": "task-1"}]),
            _FakeResponse(status_code=201, body=[{"id": "evt-1"}]),
        ],
    )
    publish_task_result(
        kanban_task_id="kt-1",
        pipeline_id=None,
        result={},
        success=True,
    )
    # Two HTTP calls = two clients (the helper opens a fresh client per
    # request). Both must be configured with the service-role headers.
    assert len(built) == 2
    for c in built:
        assert c.base_url == "https://test.supabase.co/rest/v1"
        assert c.headers["apikey"] == "test-service-role"
        assert c.headers["Authorization"] == "Bearer test-service-role"
        assert c.headers["Prefer"] == "return=representation"
        assert c.timeout == 10.0


# ---------------------------------------------------------------------------
# Happy path: success=True
# ---------------------------------------------------------------------------


def test_happy_path_success_true(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    task_row = {
        "id": "uuid-task",
        "kanban_task_id": "kt-1",
        "status": "completed",
        "result": {"video_url": "https://x/y.mp4"},
    }
    event_row = {
        "id": "uuid-event",
        "kind": "task_completed",
        "source": "hermes-task",
        "pipeline_id": "uuid-pipeline",
    }
    built = _install_fake_client(
        monkeypatch,
        responses=[
            _FakeResponse(status_code=200, body=[task_row]),
            _FakeResponse(status_code=201, body=[event_row]),
        ],
    )

    out = publish_task_result(
        kanban_task_id="kt-1",
        pipeline_id="uuid-pipeline",
        result={"video_url": "https://x/y.mp4"},
        success=True,
    )

    assert out == {"task": task_row, "event": event_row}

    # 1st request: PATCH /hermes_tasks?kanban_task_id=eq.kt-1
    patch_req = built[0].requests[0]
    assert patch_req.method == "PATCH"
    assert patch_req.url == "/hermes_tasks"
    assert patch_req.params == {"kanban_task_id": "eq.kt-1"}
    assert patch_req.json_body == {
        "status": "completed",
        "result": {"video_url": "https://x/y.mp4"},
    }

    # 2nd request: POST /pipeline_events
    post_req = built[1].requests[0]
    assert post_req.method == "POST"
    assert post_req.url == "/pipeline_events"
    assert post_req.json_body == {
        "kind": "task_completed",
        "source": "hermes-task",
        "pipeline_id": "uuid-pipeline",
        "payload": {
            "kanban_task_id": "kt-1",
            "result": {"video_url": "https://x/y.mp4"},
            "success": True,
        },
    }


# ---------------------------------------------------------------------------
# Happy path: success=False
# ---------------------------------------------------------------------------


def test_happy_path_success_false(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    built = _install_fake_client(
        monkeypatch,
        responses=[
            _FakeResponse(status_code=200, body=[{"id": "t", "status": "failed"}]),
            _FakeResponse(status_code=201, body=[{"id": "e", "kind": "task_failed"}]),
        ],
    )

    out = publish_task_result(
        kanban_task_id="kt-9",
        pipeline_id=None,
        result={"error": "kie_generate timeout"},
        success=False,
    )

    # Status / kind both flipped.
    patch_req = built[0].requests[0]
    assert patch_req.json_body["status"] == "failed"

    post_req = built[1].requests[0]
    assert post_req.json_body["kind"] == "task_failed"
    assert post_req.json_body["payload"]["success"] is False

    # No pipeline_id key when None — PostgREST must record NULL, not "None".
    assert "pipeline_id" not in post_req.json_body

    # Return value carries both inserted rows.
    assert out["task"]["status"] == "failed"
    assert out["event"]["kind"] == "task_failed"


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_patch_4xx_raises(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_client(
        monkeypatch,
        responses=[_FakeResponse(status_code=400, body={"message": "bad enum"})],
    )
    with pytest.raises(DashboardTaskResultError, match="PATCH /hermes_tasks failed: 400"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_patch_5xx_raises(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_client(
        monkeypatch,
        responses=[_FakeResponse(status_code=503, body={"message": "db down"})],
    )
    with pytest.raises(DashboardTaskResultError, match="503"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_patch_zero_rows_matched_raises(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A successful PATCH that matched nothing means the kanban row is missing."""
    _install_fake_client(
        monkeypatch,
        responses=[_FakeResponse(status_code=200, body=[])],
    )
    with pytest.raises(
        DashboardTaskResultError,
        match="matched 0 rows for kanban_task_id='kt-ghost'",
    ):
        publish_task_result(
            kanban_task_id="kt-ghost",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_pipeline_event_insert_5xx_raises(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the timeline insert fails the task row is already updated; we still
    surface the error so the operator sees it (don't silently swallow)."""
    _install_fake_client(
        monkeypatch,
        responses=[
            _FakeResponse(status_code=200, body=[{"id": "t"}]),
            _FakeResponse(status_code=500, body={"message": "boom"}),
        ],
    )
    with pytest.raises(DashboardTaskResultError, match="POST /pipeline_events failed: 500"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_pipeline_event_insert_empty_body_raises(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_client(
        monkeypatch,
        responses=[
            _FakeResponse(status_code=200, body=[{"id": "t"}]),
            _FakeResponse(status_code=201, body=[]),
        ],
    )
    with pytest.raises(DashboardTaskResultError, match="empty body"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_network_error_raises(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_client(monkeypatch, responses=[], raise_on="PATCH")
    with pytest.raises(DashboardTaskResultError, match="network error"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_non_json_response_raises(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_client(
        monkeypatch,
        responses=[_FakeResponse(status_code=200, body="not actually json")],
    )
    with pytest.raises(DashboardTaskResultError, match="non-JSON body"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )


def test_non_list_response_raises(
    env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_client(
        monkeypatch,
        responses=[_FakeResponse(status_code=200, body={"not": "a list"})],
    )
    with pytest.raises(DashboardTaskResultError, match="non-list body"):
        publish_task_result(
            kanban_task_id="kt-1",
            pipeline_id=None,
            result={},
            success=True,
        )
