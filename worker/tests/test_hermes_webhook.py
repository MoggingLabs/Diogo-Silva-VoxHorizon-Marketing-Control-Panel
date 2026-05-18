"""Tests for the Hermes shell-hook event handler service.

We exercise:

* Event classification (known kinds vs ``custom``)
* Supabase row write on every well-formed event
* Best-effort error swallowing (a broken Supabase client must NOT raise)
* VAPID push fan-out only when ``kind=tool_completed`` and
  ``risk_class=spend``
* ``DASHBOARD_WEBHOOK_TOKEN`` env resolution

The Supabase client is replaced with a tiny fake table that records
every insert / select / delete so we can assert exact call shapes.
``push_delivery.send_push_notification`` is monkey-patched into a recorder
so we never touch ``pywebpush``.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

# ``push_delivery`` imports ``pywebpush`` lazily inside
# ``send_push_notification`` — we never actually call into that codepath
# because the service-level fixtures monkey-patch ``send_push_notification``
# itself. So no ``sys.modules`` shim is needed here, and crucially we do
# NOT register a fake ``pywebpush`` module that would interfere with
# ``test_push_delivery.py`` running in the same pytest session.

from src.services import hermes_webhook as service  # noqa: E402
from src.services import push_delivery as pd  # noqa: E402


# ---------------------------------------------------------------------------
# Fake Supabase plumbing
# ---------------------------------------------------------------------------


@dataclass
class _Result:
    data: list[dict[str, Any]] = field(default_factory=list)


class _FakeTable:
    """In-memory stand-in for the supabase query builder."""

    def __init__(self, parent: "_FakeSupabase", name: str) -> None:
        self.parent = parent
        self.name = name
        self._select_cols: str | None = None
        self._pending_insert: dict[str, Any] | None = None
        self._delete = False
        self._filters: list[tuple[str, Any]] = []

    def select(self, cols: str) -> "_FakeTable":
        self._select_cols = cols
        return self

    def insert(self, row: dict[str, Any]) -> "_FakeTable":
        self._pending_insert = row
        return self

    def delete(self) -> "_FakeTable":
        self._delete = True
        return self

    def eq(self, col: str, val: Any) -> "_FakeTable":
        self._filters.append((col, val))
        return self

    def execute(self) -> _Result:
        if self.parent.raise_on == self.name:
            raise RuntimeError(f"boom: {self.name}")
        if self._pending_insert is not None:
            self.parent.inserts.append((self.name, self._pending_insert))
            return _Result(data=[{"id": "row-1"}])
        if self._delete:
            return _Result(data=[])
        # select path: hand back whatever the test seeded.
        return _Result(data=list(self.parent.seeded.get(self.name, [])))


class _FakeSupabase:
    def __init__(self) -> None:
        self.inserts: list[tuple[str, dict[str, Any]]] = []
        self.seeded: dict[str, list[dict[str, Any]]] = {}
        self.raise_on: str | None = None

    def table(self, name: str) -> _FakeTable:
        return _FakeTable(self, name)


@pytest.fixture
def fake_sb(monkeypatch: pytest.MonkeyPatch) -> _FakeSupabase:
    sb = _FakeSupabase()
    monkeypatch.setattr(service, "get_supabase_admin", lambda: sb)
    monkeypatch.setattr(pd, "get_supabase_admin", lambda: sb)
    return sb


@pytest.fixture
def push_recorder(monkeypatch: pytest.MonkeyPatch) -> list[tuple[dict[str, Any], Any]]:
    sent: list[tuple[dict[str, Any], Any]] = []

    async def _record(sub: dict[str, Any], payload: Any) -> bool:
        sent.append((sub, payload))
        return True

    monkeypatch.setattr(service.push_delivery, "send_push_notification", _record)
    return sent


# ---------------------------------------------------------------------------
# Classification + payload shape
# ---------------------------------------------------------------------------


def test_classify_known_kinds_pass_through() -> None:
    for k in ("tool_completed", "session_started", "session_ended", "skill_invoked"):
        assert service._classify(k) == k


def test_classify_unknown_kind_becomes_custom() -> None:
    assert service._classify("oddly_named_hook") == "custom"


def test_classify_non_string_becomes_custom() -> None:
    assert service._classify(None) == "custom"
    assert service._classify(42) == "custom"  # type: ignore[arg-type]


def test_safe_payload_preserves_original_event() -> None:
    event = {"kind": "tool_completed", "tool_name": "Bash", "risk_class": "spend"}
    payload = service._safe_payload(event, "tool_completed")
    assert payload["source"] == service.HOOK_SOURCE
    assert payload["classified_kind"] == "tool_completed"
    assert payload["event"] is event


# ---------------------------------------------------------------------------
# handle_event — happy path
# ---------------------------------------------------------------------------


def test_handle_event_writes_pipeline_events_row(
    fake_sb: _FakeSupabase, push_recorder: list[Any]
) -> None:
    event = {"kind": "session_started", "session_id": "s-1"}
    asyncio.run(service.handle_event(event))

    pipeline_inserts = [r for n, r in fake_sb.inserts if n == "pipeline_events"]
    assert len(pipeline_inserts) == 1
    row = pipeline_inserts[0]
    assert row["pipeline_id"] is None
    assert row["kind"] == "session_started"
    assert row["stage"] is None
    assert row["payload"]["source"] == "hermes-hook"
    assert row["payload"]["classified_kind"] == "session_started"
    assert row["payload"]["event"]["session_id"] == "s-1"


def test_handle_event_custom_kind_still_persists(
    fake_sb: _FakeSupabase, push_recorder: list[Any]
) -> None:
    event = {"kind": "weird_new_hook", "data": {"x": 1}}
    asyncio.run(service.handle_event(event))

    rows = [r for n, r in fake_sb.inserts if n == "pipeline_events"]
    assert len(rows) == 1
    assert rows[0]["kind"] == "weird_new_hook"
    assert rows[0]["payload"]["classified_kind"] == "custom"


# ---------------------------------------------------------------------------
# handle_event — validation
# ---------------------------------------------------------------------------


def test_handle_event_rejects_non_dict(
    fake_sb: _FakeSupabase, push_recorder: list[Any]
) -> None:
    """A non-dict body is logged + dropped silently (no DB write)."""
    asyncio.run(service.handle_event("not-a-dict"))  # type: ignore[arg-type]
    asyncio.run(service.handle_event(["list"]))  # type: ignore[arg-type]
    asyncio.run(service.handle_event(None))  # type: ignore[arg-type]
    assert fake_sb.inserts == []
    assert push_recorder == []


def test_handle_event_rejects_missing_kind(
    fake_sb: _FakeSupabase, push_recorder: list[Any]
) -> None:
    """Body without a ``kind`` field is dropped (no DB write)."""
    asyncio.run(service.handle_event({"tool_name": "Bash"}))
    asyncio.run(service.handle_event({"kind": ""}))  # empty string
    asyncio.run(service.handle_event({"kind": 42}))  # not a string
    assert fake_sb.inserts == []
    assert push_recorder == []


# ---------------------------------------------------------------------------
# handle_event — VAPID fan-out
# ---------------------------------------------------------------------------


def test_handle_event_pushes_on_tool_completed_spend(
    fake_sb: _FakeSupabase, push_recorder: list[tuple[dict[str, Any], Any]]
) -> None:
    """``tool_completed`` + ``risk_class=spend`` fans out to every subscription."""
    fake_sb.seeded["push_subscriptions"] = [
        {"endpoint": "https://push.example/a", "keys": {"p256dh": "p", "auth": "a"}},
        {"endpoint": "https://push.example/b", "keys": {"p256dh": "p", "auth": "a"}},
    ]
    event = {
        "kind": "tool_completed",
        "tool_name": "MetaAdsAPI",
        "risk_class": "spend",
    }
    asyncio.run(service.handle_event(event))

    assert len(push_recorder) == 2
    subs = sorted(s["endpoint"] for s, _ in push_recorder)
    assert subs == ["https://push.example/a", "https://push.example/b"]
    # The payload describes the alert.
    _, payload = push_recorder[0]
    assert isinstance(payload, pd.PushPayload)
    assert payload.kind == "hermes_spend"
    assert "MetaAdsAPI" in payload.body


def test_handle_event_no_push_when_non_spend(
    fake_sb: _FakeSupabase, push_recorder: list[Any]
) -> None:
    """``tool_completed`` with risk_class != spend → no push."""
    fake_sb.seeded["push_subscriptions"] = [
        {"endpoint": "https://push.example/a", "keys": {"p256dh": "p", "auth": "a"}}
    ]
    event = {"kind": "tool_completed", "risk_class": "network"}
    asyncio.run(service.handle_event(event))
    assert push_recorder == []


def test_handle_event_no_push_when_not_tool_completed(
    fake_sb: _FakeSupabase, push_recorder: list[Any]
) -> None:
    """Even with risk_class=spend, a non-tool_completed kind doesn't push."""
    fake_sb.seeded["push_subscriptions"] = [
        {"endpoint": "https://push.example/a", "keys": {"p256dh": "p", "auth": "a"}}
    ]
    event = {"kind": "session_ended", "risk_class": "spend"}
    asyncio.run(service.handle_event(event))
    assert push_recorder == []


def test_handle_event_push_handles_no_subscriptions(
    fake_sb: _FakeSupabase, push_recorder: list[Any]
) -> None:
    """No subscribers → no push attempts but row is still written."""
    # No seeded push_subscriptions table.
    event = {"kind": "tool_completed", "risk_class": "spend"}
    asyncio.run(service.handle_event(event))
    assert push_recorder == []
    assert any(n == "pipeline_events" for n, _ in fake_sb.inserts)


def test_handle_event_push_skips_garbage_rows(
    fake_sb: _FakeSupabase, push_recorder: list[Any]
) -> None:
    """Rows missing endpoint / non-dict rows are filtered out."""
    fake_sb.seeded["push_subscriptions"] = [
        "not-a-dict",  # type: ignore[list-item]
        {"keys": {"p256dh": "p", "auth": "a"}},  # missing endpoint
        {"endpoint": "", "keys": {}},  # empty endpoint
        {"endpoint": "https://push.example/ok", "keys": {"p256dh": "p", "auth": "a"}},
    ]
    event = {"kind": "tool_completed", "risk_class": "spend"}
    asyncio.run(service.handle_event(event))
    assert len(push_recorder) == 1
    assert push_recorder[0][0]["endpoint"] == "https://push.example/ok"


def test_handle_event_push_swallows_subscription_query_failure(
    monkeypatch: pytest.MonkeyPatch, push_recorder: list[Any]
) -> None:
    """A Supabase exception on the push_subscriptions select → no push, no raise."""
    sb = _FakeSupabase()
    sb.raise_on = "push_subscriptions"
    monkeypatch.setattr(service, "get_supabase_admin", lambda: sb)

    event = {"kind": "tool_completed", "risk_class": "spend"}
    # Must not raise.
    asyncio.run(service.handle_event(event))
    assert push_recorder == []


def test_handle_event_push_swallows_send_failure(
    fake_sb: _FakeSupabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A broken send_push_notification still allows other rows to be tried."""
    fake_sb.seeded["push_subscriptions"] = [
        {"endpoint": "https://push.example/a", "keys": {"p256dh": "p", "auth": "a"}},
        {"endpoint": "https://push.example/b", "keys": {"p256dh": "p", "auth": "a"}},
    ]
    seen: list[str] = []

    async def _send(sub: dict[str, Any], _payload: Any) -> bool:
        seen.append(sub["endpoint"])
        if sub["endpoint"].endswith("/a"):
            raise RuntimeError("boom")
        return True

    monkeypatch.setattr(service.push_delivery, "send_push_notification", _send)

    event = {"kind": "tool_completed", "risk_class": "spend"}
    asyncio.run(service.handle_event(event))
    # Both endpoints were attempted; the exception on /a was swallowed.
    assert seen == ["https://push.example/a", "https://push.example/b"]


def test_handle_event_push_uses_fallback_tool_name(
    fake_sb: _FakeSupabase, push_recorder: list[tuple[dict[str, Any], Any]]
) -> None:
    """When ``tool_name`` is missing, the alert body falls back to ``tool`` then unknown."""
    fake_sb.seeded["push_subscriptions"] = [
        {"endpoint": "https://push.example/a", "keys": {"p256dh": "p", "auth": "a"}},
    ]
    event = {"kind": "tool_completed", "risk_class": "spend", "tool": "Edit"}
    asyncio.run(service.handle_event(event))
    _, payload = push_recorder[0]
    assert isinstance(payload, pd.PushPayload)
    assert "Edit" in payload.body


def test_handle_event_push_uses_unknown_when_no_name(
    fake_sb: _FakeSupabase, push_recorder: list[tuple[dict[str, Any], Any]]
) -> None:
    fake_sb.seeded["push_subscriptions"] = [
        {"endpoint": "https://push.example/a", "keys": {"p256dh": "p", "auth": "a"}},
    ]
    event = {"kind": "tool_completed", "risk_class": "spend"}
    asyncio.run(service.handle_event(event))
    _, payload = push_recorder[0]
    assert isinstance(payload, pd.PushPayload)
    assert "unknown tool" in payload.body


# ---------------------------------------------------------------------------
# handle_event — error swallowing
# ---------------------------------------------------------------------------


def test_handle_event_swallows_supabase_insert_failure(
    monkeypatch: pytest.MonkeyPatch, push_recorder: list[Any]
) -> None:
    """A broken pipeline_events insert is logged but never raises."""
    sb = _FakeSupabase()
    sb.raise_on = "pipeline_events"
    monkeypatch.setattr(service, "get_supabase_admin", lambda: sb)

    event = {"kind": "session_started"}
    # Must not raise.
    asyncio.run(service.handle_event(event))
    # The push side never fires because this is session_started not
    # tool_completed.
    assert push_recorder == []


def test_handle_event_swallows_get_supabase_admin_failure(
    monkeypatch: pytest.MonkeyPatch, push_recorder: list[Any]
) -> None:
    """A broken Supabase client factory must not raise out of handle_event."""

    def _broken() -> Any:
        raise RuntimeError("no supabase")

    monkeypatch.setattr(service, "get_supabase_admin", _broken)

    event = {"kind": "session_started"}
    asyncio.run(service.handle_event(event))
    assert push_recorder == []


# ---------------------------------------------------------------------------
# Token resolution
# ---------------------------------------------------------------------------


def test_get_dashboard_webhook_token_returns_env_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHBOARD_WEBHOOK_TOKEN", "  hermes-secret  ")
    assert service.get_dashboard_webhook_token() == "hermes-secret"


def test_get_dashboard_webhook_token_returns_none_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DASHBOARD_WEBHOOK_TOKEN", raising=False)
    assert service.get_dashboard_webhook_token() is None


def test_get_dashboard_webhook_token_returns_none_when_blank(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHBOARD_WEBHOOK_TOKEN", "    ")
    assert service.get_dashboard_webhook_token() is None
