"""Tests for the JSONL audit logger."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from voxhorizon_approvals.audit import (
    AUDIT_LOG_PATH_ENV,
    DEFAULT_AUDIT_LOG_PATH,
    log_decision,
)


@pytest.fixture
def audit_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Point the audit logger at a temp file."""
    p = tmp_path / "audit.jsonl"
    monkeypatch.setenv(AUDIT_LOG_PATH_ENV, str(p))
    return p


def test_log_decision_writes_one_jsonl_row(audit_path: Path) -> None:
    log_decision(
        "read_file",
        {"path": "/etc/hosts"},
        "allow",
        reason="allowlisted",
        latency_ms=0.42,
    )
    raw = audit_path.read_text(encoding="utf-8")
    assert raw.endswith("\n"), "newline terminator missing"
    row = json.loads(raw)
    assert row["tool"] == "read_file"
    assert row["decision"] == "allow"
    assert row["reason"] == "allowlisted"
    assert row["latency_ms"] == 0.42
    assert row["args_digest"].startswith("sha256:")
    # Timestamp should parse as ISO with trailing Z.
    assert row["timestamp"].endswith("Z")


def test_log_decision_appends_each_row(audit_path: Path) -> None:
    for i in range(3):
        log_decision(
            "send_email",
            {"to": f"x{i}@example.com"},
            "approved",
            reason="op",
            latency_ms=10.0,
        )
    lines = audit_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 3
    rows = [json.loads(line) for line in lines]
    digests = {r["args_digest"] for r in rows}
    # Three different argsets → three distinct digests.
    assert len(digests) == 3


def test_log_decision_omits_args_payload(audit_path: Path) -> None:
    """Args are NEVER serialised — only the digest."""
    log_decision(
        "send_email",
        {"body": "SECRET BODY DATA"},
        "approved",
        reason="op",
    )
    raw = audit_path.read_text(encoding="utf-8")
    assert "SECRET BODY DATA" not in raw
    row = json.loads(raw)
    assert "args" not in row
    assert "tool_args" not in row


def test_log_decision_handles_none_args(audit_path: Path) -> None:
    log_decision("read_file", None, "allow", reason="")
    row = json.loads(audit_path.read_text(encoding="utf-8"))
    assert row["tool"] == "read_file"
    assert "args_digest" in row


def test_log_decision_omits_latency_when_none(audit_path: Path) -> None:
    log_decision("read_file", {}, "allow", reason="")
    row = json.loads(audit_path.read_text(encoding="utf-8"))
    assert "latency_ms" not in row


def test_log_decision_handles_unicode(audit_path: Path) -> None:
    log_decision(
        "send_email",
        {"body": "héllo"},
        "approved",
        reason="ok",
    )
    raw = audit_path.read_text(encoding="utf-8")
    # ensure_ascii=False keeps multi-byte chars intact.
    row = json.loads(raw)
    assert row["tool"] == "send_email"


def test_log_decision_creates_parent_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Hot install on a fresh container shouldn't need pre-made dirs."""
    nested = tmp_path / "deeply" / "nested" / "audit.jsonl"
    monkeypatch.setenv(AUDIT_LOG_PATH_ENV, str(nested))
    log_decision("read_file", {}, "allow", reason="")
    assert nested.exists()


def test_log_decision_swallows_unwritable_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failing write must NOT raise — the hot path can't be deadlocked."""
    monkeypatch.setenv(AUDIT_LOG_PATH_ENV, "/proc/this/path/cannot/be/written")
    # No exception even though the path is bogus.
    log_decision("read_file", {}, "allow", reason="")


def test_default_path_is_used_when_env_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When no env override is provided the default constant is honoured."""
    monkeypatch.delenv(AUDIT_LOG_PATH_ENV, raising=False)
    # We can't actually write to ``/opt/data/logs`` in tests; just
    # verify the resolver chose the default (audit's swallow-on-error
    # then keeps the test green).
    from voxhorizon_approvals import audit as audit_mod

    assert audit_mod._resolve_path() == Path(DEFAULT_AUDIT_LOG_PATH)


def test_log_decision_rounds_latency(audit_path: Path) -> None:
    log_decision(
        "read_file", {}, "allow", reason="", latency_ms=1.23456789
    )
    row = json.loads(audit_path.read_text(encoding="utf-8"))
    assert row["latency_ms"] == 1.23
