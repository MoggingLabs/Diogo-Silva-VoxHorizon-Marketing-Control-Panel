"""Tests for the web-push delivery wrapper.

The real ``pywebpush.webpush`` is imported lazily inside
:func:`send_push_notification`, so we monkey-patch it at the module level
through a small wrapper. We focus on three behaviors:

* VAPID key resolution from env var vs. kwarg.
* 404 / 410 from the push service → subscription is dropped.
* Successful send returns True; non-fatal errors return False.

The Supabase calls inside ``fanout_push`` are stubbed with a tiny in-memory
table so we can assert the iteration shape.
"""

from __future__ import annotations

import asyncio
import sys
import types
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest


# We need to install a fake `pywebpush` module BEFORE the service module is
# imported under push_delivery (it imports inside the function). We do this
# at import time so all tests see the same fake.
_fake_pywebpush = types.ModuleType("pywebpush")


class _FakeWebPushException(Exception):
    def __init__(self, message: str, response: MagicMock | None = None) -> None:
        super().__init__(message)
        self.response = response


_fake_pywebpush.WebPushException = _FakeWebPushException  # type: ignore[attr-defined]


# Default no-op webpush — tests override per-case.
def _default_webpush(*args: Any, **kwargs: Any) -> None:  # pragma: no cover
    return None


_fake_pywebpush.webpush = _default_webpush  # type: ignore[attr-defined]
sys.modules.setdefault("pywebpush", _fake_pywebpush)


from src.services import push_delivery as pd  # noqa: E402
from src.services.push_delivery import (  # noqa: E402
    PushPayload,
    fanout_push,
    send_push_notification,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@dataclass
class _Result:
    data: list[dict[str, Any]]


class _PushTable:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self._filters: list[tuple[str, str, Any]] = []
        self._select_called = False
        self._delete_called = False

    def select(self, _cols: str) -> "_PushTable":
        self._select_called = True
        return self

    def delete(self) -> "_PushTable":
        self._delete_called = True
        return self

    def eq(self, col: str, val: Any) -> "_PushTable":
        self._filters.append((col, "eq", val))
        return self

    def execute(self) -> _Result:
        if self._delete_called:
            # Drop matching rows in place.
            keep = []
            for row in self._rows:
                if not all(row.get(c) == v for c, _o, v in self._filters):
                    keep.append(row)
            self._rows[:] = keep
            return _Result(data=[])
        return _Result(data=list(self._rows))


class _FakeSupabase:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows if rows is not None else []
        self._last_table: _PushTable | None = None

    def table(self, name: str) -> _PushTable:
        assert name == "push_subscriptions", f"unexpected table {name}"
        self._last_table = _PushTable(self.rows)
        return self._last_table


@pytest.fixture
def fake_sb(monkeypatch: pytest.MonkeyPatch) -> _FakeSupabase:
    sb = _FakeSupabase()
    monkeypatch.setattr(pd, "get_supabase_admin", lambda: sb)
    return sb


@pytest.fixture
def vapid_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "test-private-key")


def _sub(endpoint: str = "https://push.example/sub-1") -> dict[str, Any]:
    return {"endpoint": endpoint, "keys": {"p256dh": "p", "auth": "a"}}


# ---------------------------------------------------------------------------
# PushPayload
# ---------------------------------------------------------------------------


def test_push_payload_to_dict_round_trip() -> None:
    p = PushPayload(title="t", body="b", url="/audit", kind="kill_threshold")
    assert p.to_dict() == {
        "title": "t",
        "body": "b",
        "url": "/audit",
        "kind": "kill_threshold",
    }


# ---------------------------------------------------------------------------
# send_push_notification
# ---------------------------------------------------------------------------


def test_send_push_requires_vapid_key(
    monkeypatch: pytest.MonkeyPatch, fake_sb: _FakeSupabase
) -> None:
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    with pytest.raises(RuntimeError, match="VAPID_PRIVATE_KEY"):
        asyncio.run(send_push_notification(_sub(), PushPayload(title="t", body="b")))


def test_send_push_calls_webpush_with_payload(
    monkeypatch: pytest.MonkeyPatch, fake_sb: _FakeSupabase, vapid_env: None
) -> None:
    captured: dict[str, Any] = {}

    def fake_webpush(*, subscription_info: Any, data: Any, vapid_private_key: Any, vapid_claims: Any) -> None:
        captured["subscription_info"] = subscription_info
        captured["data"] = data
        captured["vapid_private_key"] = vapid_private_key
        captured["vapid_claims"] = vapid_claims

    monkeypatch.setattr(_fake_pywebpush, "webpush", fake_webpush)

    ok = asyncio.run(send_push_notification(_sub(), PushPayload(title="t", body="b", url="/x")))

    assert ok is True
    import json

    parsed = json.loads(captured["data"])
    assert parsed["title"] == "t"
    assert parsed["url"] == "/x"
    assert captured["vapid_claims"]["sub"].startswith("mailto:")
    assert captured["vapid_private_key"] == "test-private-key"


def test_send_push_deletes_subscription_on_410(
    monkeypatch: pytest.MonkeyPatch, fake_sb: _FakeSupabase, vapid_env: None
) -> None:
    """410 GONE → subscription is removed from the table."""
    fake_sb.rows.append(
        {"endpoint": "https://push.example/sub-1", "keys": {"p256dh": "p", "auth": "a"}}
    )

    def fake_webpush(**_kw: Any) -> None:
        resp = MagicMock()
        resp.status_code = 410
        raise _FakeWebPushException("gone", response=resp)

    monkeypatch.setattr(_fake_pywebpush, "webpush", fake_webpush)

    ok = asyncio.run(send_push_notification(_sub(), PushPayload(title="t", body="b")))
    assert ok is False
    assert fake_sb.rows == []  # row was deleted


def test_send_push_deletes_subscription_on_404(
    monkeypatch: pytest.MonkeyPatch, fake_sb: _FakeSupabase, vapid_env: None
) -> None:
    fake_sb.rows.append({"endpoint": "https://push.example/sub-1", "keys": {}})

    def fake_webpush(**_kw: Any) -> None:
        resp = MagicMock()
        resp.status_code = 404
        raise _FakeWebPushException("not found", response=resp)

    monkeypatch.setattr(_fake_pywebpush, "webpush", fake_webpush)

    ok = asyncio.run(send_push_notification(_sub(), PushPayload(title="t", body="b")))
    assert ok is False
    assert fake_sb.rows == []


def test_send_push_returns_false_on_5xx_without_delete(
    monkeypatch: pytest.MonkeyPatch, fake_sb: _FakeSupabase, vapid_env: None
) -> None:
    """Transient error → False, but subscription stays so the next run retries."""
    fake_sb.rows.append({"endpoint": "https://push.example/sub-1", "keys": {}})

    def fake_webpush(**_kw: Any) -> None:
        resp = MagicMock()
        resp.status_code = 502
        raise _FakeWebPushException("upstream", response=resp)

    monkeypatch.setattr(_fake_pywebpush, "webpush", fake_webpush)

    ok = asyncio.run(send_push_notification(_sub(), PushPayload(title="t", body="b")))
    assert ok is False
    assert len(fake_sb.rows) == 1  # NOT deleted


# ---------------------------------------------------------------------------
# fanout_push
# ---------------------------------------------------------------------------


def test_fanout_push_no_subscriptions_returns_zero(
    monkeypatch: pytest.MonkeyPatch, fake_sb: _FakeSupabase
) -> None:
    sent, failed = asyncio.run(fanout_push(PushPayload(title="t", body="b")))
    assert (sent, failed) == (0, 0)


def test_fanout_push_iterates_subscriptions(
    monkeypatch: pytest.MonkeyPatch, fake_sb: _FakeSupabase, vapid_env: None
) -> None:
    fake_sb.rows.extend(
        [
            {"endpoint": "https://push.example/a", "keys": {"p256dh": "p", "auth": "a"}},
            {"endpoint": "https://push.example/b", "keys": {"p256dh": "p", "auth": "a"}},
            {"endpoint": "https://push.example/c", "keys": {"p256dh": "p", "auth": "a"}},
        ]
    )

    seen: list[str] = []

    def fake_webpush(*, subscription_info: Any, data: Any, vapid_private_key: Any, vapid_claims: Any) -> None:
        seen.append(subscription_info["endpoint"])

    monkeypatch.setattr(_fake_pywebpush, "webpush", fake_webpush)

    sent, failed = asyncio.run(fanout_push(PushPayload(title="t", body="b")))
    assert sent == 3
    assert failed == 0
    assert seen == [
        "https://push.example/a",
        "https://push.example/b",
        "https://push.example/c",
    ]


def test_fanout_push_mixed_results(
    monkeypatch: pytest.MonkeyPatch, fake_sb: _FakeSupabase, vapid_env: None
) -> None:
    """One success + one 410 → sent=1, failed=1, expired sub is dropped."""
    fake_sb.rows.extend(
        [
            {"endpoint": "https://push.example/ok", "keys": {"p256dh": "p", "auth": "a"}},
            {"endpoint": "https://push.example/expired", "keys": {"p256dh": "p", "auth": "a"}},
        ]
    )

    def fake_webpush(*, subscription_info: Any, **_kw: Any) -> None:
        if subscription_info["endpoint"].endswith("/expired"):
            resp = MagicMock()
            resp.status_code = 410
            raise _FakeWebPushException("gone", response=resp)
        return None

    monkeypatch.setattr(_fake_pywebpush, "webpush", fake_webpush)

    sent, failed = asyncio.run(fanout_push(PushPayload(title="t", body="b")))
    assert sent == 1
    assert failed == 1
    # Only the surviving subscription remains.
    assert [r["endpoint"] for r in fake_sb.rows] == ["https://push.example/ok"]
