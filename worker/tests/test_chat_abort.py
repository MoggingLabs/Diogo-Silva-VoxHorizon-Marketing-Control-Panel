"""Unit tests for :mod:`worker.src.services.chat_abort`."""

from __future__ import annotations

import time

import pytest

from src.services.chat_abort import ChatAbortStore, _reset_store, get_store


@pytest.fixture(autouse=True)
def _reset() -> None:
    _reset_store()


def test_initial_state_clean() -> None:
    """A fresh store should report no aborts."""
    store = ChatAbortStore()
    assert store.is_aborted("image", "c-1") is False
    assert store.is_aborted("video", "c-1") is False


def test_request_then_is_aborted() -> None:
    store = ChatAbortStore()
    store.request("image", "c-1")
    assert store.is_aborted("image", "c-1") is True
    # Different creative id → different key.
    assert store.is_aborted("image", "c-2") is False
    # Different kind → different key.
    assert store.is_aborted("video", "c-1") is False


def test_clear_drops_flag() -> None:
    store = ChatAbortStore()
    store.request("image", "c-1")
    store.clear("image", "c-1")
    assert store.is_aborted("image", "c-1") is False


def test_ttl_expires_stale_flags() -> None:
    """An old flag should be silently pruned when polled."""
    # 0.05s TTL so the test runs fast.
    store = ChatAbortStore(ttl_seconds=0.05)
    store.request("video", "vc-1")
    assert store.is_aborted("video", "vc-1") is True
    time.sleep(0.06)
    assert store.is_aborted("video", "vc-1") is False


def test_get_store_returns_singleton() -> None:
    s1 = get_store()
    s2 = get_store()
    assert s1 is s2


def test_request_is_idempotent() -> None:
    """Repeated requests refresh the timestamp; one clear still wipes it."""
    store = ChatAbortStore()
    store.request("image", "c-x")
    store.request("image", "c-x")
    store.request("image", "c-x")
    assert store.is_aborted("image", "c-x") is True
    store.clear("image", "c-x")
    assert store.is_aborted("image", "c-x") is False


def test_clear_all_wipes_every_flag() -> None:
    store = ChatAbortStore()
    store.request("image", "a")
    store.request("video", "b")
    store.request("image", "c")
    store.clear_all()
    assert store.is_aborted("image", "a") is False
    assert store.is_aborted("video", "b") is False
    assert store.is_aborted("image", "c") is False
