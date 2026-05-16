"""Tests for the Supabase Storage helpers (creatives bucket)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from src.services import storage as storage_mod
from src.services.storage import (
    BUCKET,
    build_creative_path,
    sha256_short,
    slugify,
    upload_creative,
)


# ---------------------------------------------------------------------------
# slugify + build_creative_path — pure helpers
# ---------------------------------------------------------------------------


def test_slugify_lowercases_and_replaces_non_alnum() -> None:
    assert slugify("Sunny Day Roofing!") == "sunny-day-roofing"


def test_slugify_collapses_runs_of_separators() -> None:
    assert slugify("foo   bar---baz") == "foo-bar-baz"


def test_slugify_truncates_to_80_chars() -> None:
    long = "x" * 200
    assert len(slugify(long)) == 80


def test_slugify_falls_back_to_untitled_for_empty_input() -> None:
    assert slugify("") == "untitled"
    assert slugify("!!!") == "untitled"
    assert slugify("   ") == "untitled"


def test_build_creative_path_layout() -> None:
    path = build_creative_path(
        brief_id="11111111-1111-1111-1111-111111111111",
        concept="Sunny Day Roofing!",
        ratio="1x1",
        version="v1.0",
    )
    assert path == "11111111-1111-1111-1111-111111111111/sunny-day-roofing-1x1-v1.0.png"


def test_build_creative_path_includes_ratio_and_version() -> None:
    p9 = build_creative_path("b", "concept", "9x16", "v2.3")
    p16 = build_creative_path("b", "concept", "16x9", "v2.3")
    assert "-9x16-v2.3.png" in p9
    assert "-16x9-v2.3.png" in p16
    assert p9 != p16


# ---------------------------------------------------------------------------
# upload_creative — mocked Supabase client
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_png(tmp_path: Path) -> Path:
    p = tmp_path / "img.png"
    # Minimal PNG signature + a bit of body so byte counts are meaningful.
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"a" * 64)
    return p


@pytest.fixture
def mock_sb(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Patch `get_supabase_admin` to return a MagicMock client."""
    client = MagicMock(name="supabase_client")
    # Make `sb.storage.from_(BUCKET).upload(...)` chainable.
    bucket_proxy = MagicMock(name="bucket_proxy")
    client.storage.from_.return_value = bucket_proxy
    monkeypatch.setattr(storage_mod, "get_supabase_admin", lambda: client)
    return client


def test_upload_creative_calls_storage_with_expected_path(
    sample_png: Path, mock_sb: MagicMock
) -> None:
    path = asyncio.run(
        upload_creative(
            sample_png,
            brief_id="abc",
            concept="Sunny Day Roofing!",
            ratio="1x1",
            version="v1.0",
        )
    )
    assert path == "abc/sunny-day-roofing-1x1-v1.0.png"
    mock_sb.storage.from_.assert_called_once_with(BUCKET)

    bucket_proxy = mock_sb.storage.from_.return_value
    bucket_proxy.upload.assert_called_once()
    kwargs = bucket_proxy.upload.call_args.kwargs
    assert kwargs["path"] == "abc/sunny-day-roofing-1x1-v1.0.png"
    assert kwargs["file"] == sample_png.read_bytes()
    assert kwargs["file_options"] == {
        "content-type": "image/png",
        "x-upsert": "true",
    }


def test_upload_creative_respects_custom_content_type(
    sample_png: Path, mock_sb: MagicMock
) -> None:
    asyncio.run(
        upload_creative(
            sample_png,
            brief_id="b",
            concept="c",
            ratio="9x16",
            version="v1.0",
            content_type="image/webp",
        )
    )
    bucket_proxy = mock_sb.storage.from_.return_value
    assert bucket_proxy.upload.call_args.kwargs["file_options"]["content-type"] == "image/webp"


def test_upload_creative_raises_on_missing_file(
    tmp_path: Path, mock_sb: MagicMock
) -> None:
    missing = tmp_path / "nope.png"
    with pytest.raises(FileNotFoundError):
        asyncio.run(
            upload_creative(
                missing,
                brief_id="b",
                concept="c",
                ratio="1x1",
                version="v1.0",
            )
        )
    mock_sb.storage.from_.assert_not_called()


# ---------------------------------------------------------------------------
# sha256_short
# ---------------------------------------------------------------------------


def test_sha256_short_is_stable_and_truncated(sample_png: Path) -> None:
    digest = sha256_short(sample_png)
    assert len(digest) == 12
    assert digest == sha256_short(sample_png)


def test_sha256_short_n_controls_length(sample_png: Path) -> None:
    assert len(sha256_short(sample_png, n=16)) == 16
