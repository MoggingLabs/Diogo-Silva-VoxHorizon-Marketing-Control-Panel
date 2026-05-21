"""Tests for :mod:`worker.src.services.operator_bridge`.

Mirrors ``test_hermes_bridge.py``: a MagicMock stands in for the Docker
SDK so nothing touches a real daemon. Surfaces under test:

* ``_build_argv`` — the operator ``hermes chat`` command-line.
* ``__init__`` — container resolution from arg / env / default.
* ``dispatch`` — creates the exec, drains stdout to completion, and
  raises ``OperatorBridgeError`` when the exec can't start.
* the singleton accessor + reset seam.
"""

from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import docker.errors
import pytest

from src.services.operator_bridge import (
    DEFAULT_OPERATOR_CONTAINER,
    OperatorBridge,
    OperatorBridgeError,
    _drain,
    get_operator_bridge,
    reset_operator_bridge,
)


def _make_fake_client(
    exec_id: str = "exec-op",
    chunks: list[bytes] | None = None,
    exec_create_dict: bool = True,
    exec_create_raises: Exception | None = None,
    exec_start_raises: Exception | None = None,
) -> MagicMock:
    api = MagicMock()
    if exec_create_raises:
        api.exec_create.side_effect = exec_create_raises
    else:
        api.exec_create.return_value = (
            {"Id": exec_id} if exec_create_dict else exec_id
        )

    def _gen() -> Iterator[bytes]:
        for c in chunks or []:
            yield c

    if exec_start_raises:
        api.exec_start.side_effect = exec_start_raises
    else:
        api.exec_start.return_value = _gen()

    client = MagicMock()
    client.api = api
    return client


# ---------------------------------------------------------------------------
# __init__ / container resolution
# ---------------------------------------------------------------------------


def test_init_uses_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPERATOR_CONTAINER_NAME", "custom-operator")
    bridge = OperatorBridge(client=_make_fake_client())
    assert bridge.container_name == "custom-operator"


def test_init_default_when_env_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPERATOR_CONTAINER_NAME", raising=False)
    bridge = OperatorBridge(client=_make_fake_client())
    assert bridge.container_name == DEFAULT_OPERATOR_CONTAINER
    assert DEFAULT_OPERATOR_CONTAINER == "hermes-agent-operator"


def test_init_explicit_name_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPERATOR_CONTAINER_NAME", "env-name")
    bridge = OperatorBridge(container_name="explicit", client=_make_fake_client())
    assert bridge.container_name == "explicit"


def test_init_constructs_from_env_when_client_absent() -> None:
    fake = _make_fake_client()
    with patch(
        "src.services.operator_bridge.docker.from_env", return_value=fake
    ) as p:
        bridge = OperatorBridge()
        assert bridge._client is fake
        p.assert_called_once_with()


# ---------------------------------------------------------------------------
# _build_argv
# ---------------------------------------------------------------------------


def test_build_argv_ignores_session_id() -> None:
    # The operator is stateless per dispatch; we do NOT pass a session flag
    # (--pass-session-id is a boolean on the Hermes CLI, not value-taking).
    # The pipeline id is carried in the instruction instead.
    assert OperatorBridge._build_argv("do it", "p-1") == [
        "hermes",
        "chat",
        "-q",
        "do it",
    ]


def test_build_argv_without_session() -> None:
    assert OperatorBridge._build_argv("do it", None) == [
        "hermes",
        "chat",
        "-q",
        "do it",
    ]


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_creates_exec_and_drains() -> None:
    client = _make_fake_client(exec_id="exec-1", chunks=[b"a", b"b"])
    bridge = OperatorBridge(container_name="hermes-agent-operator", client=client)

    await bridge.dispatch("render finals for p-9", "p-9")

    args, kwargs = client.api.exec_create.call_args
    assert args[0] == "hermes-agent-operator"
    assert args[1] == [
        "hermes",
        "chat",
        "-q",
        "render finals for p-9",
    ]
    assert kwargs == {"stdout": True, "stderr": True, "tty": False}
    client.api.exec_start.assert_called_once_with("exec-1", stream=True)


@pytest.mark.asyncio
async def test_dispatch_accepts_bare_exec_id() -> None:
    client = _make_fake_client(exec_id="bare-id", exec_create_dict=False)
    bridge = OperatorBridge(client=client)
    await bridge.dispatch("go", "s-1")
    client.api.exec_start.assert_called_once_with("bare-id", stream=True)


@pytest.mark.asyncio
async def test_dispatch_raises_on_not_found() -> None:
    client = _make_fake_client(
        exec_create_raises=docker.errors.NotFound("missing")
    )
    bridge = OperatorBridge(client=client)
    with pytest.raises(OperatorBridgeError):
        await bridge.dispatch("go", "s-1")


@pytest.mark.asyncio
async def test_dispatch_raises_on_api_error() -> None:
    client = _make_fake_client(
        exec_create_raises=docker.errors.APIError("boom")
    )
    bridge = OperatorBridge(client=client)
    with pytest.raises(OperatorBridgeError):
        await bridge.dispatch("go", "s-1")


@pytest.mark.asyncio
async def test_dispatch_swallows_stream_api_error() -> None:
    """A stream-time APIError is logged, not raised (response already sent)."""
    client = _make_fake_client(
        exec_start_raises=docker.errors.APIError("stream died")
    )
    bridge = OperatorBridge(client=client)
    # Should not raise.
    await bridge.dispatch("go", "s-1")


# ---------------------------------------------------------------------------
# _drain + singleton
# ---------------------------------------------------------------------------


def test_drain_exhausts_iterator() -> None:
    seen: list[bytes] = []

    def _gen() -> Iterator[bytes]:
        for c in (b"x", b"y"):
            seen.append(c)
            yield c

    _drain(_gen())
    assert seen == [b"x", b"y"]


def test_singleton_is_reused_and_resettable() -> None:
    reset_operator_bridge()
    with patch(
        "src.services.operator_bridge.docker.from_env",
        return_value=_make_fake_client(),
    ):
        a = get_operator_bridge()
        b = get_operator_bridge()
        assert a is b
        reset_operator_bridge()
        c = get_operator_bridge()
        assert c is not a
    reset_operator_bridge()
