#!/usr/bin/env python3
"""Unit tests for the structured client-targeting logic (migration 0013).

Covers the import-side parsing/derivation (ZIP + radius_miles parsing,
build_profile_row's targeting columns + needs_input gap tracking) and the
export-side round-trip (the `targeting` object reconstruction). Logic only —
no DB, no live files.

stdlib only; run with::

    python3 -m pytest scripts/clients/test_targeting.py
    # or, with no pytest available:
    python3 scripts/clients/test_targeting.py
"""

import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(module_name, filename):
    """Load a sibling stdlib-only script by path (no package install needed)."""
    spec = importlib.util.spec_from_file_location(
        module_name, os.path.join(_HERE, filename)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


imp = _load("import_profiles_under_test", "import_profiles.py")
exp = _load("export_profiles_under_test", "export_profiles.py")


# ---------------------------------------------------------------------------
# ZIP parsing
# ---------------------------------------------------------------------------
def test_parse_zip_prefers_first_value():
    assert imp.parse_zip("75002", "14431 Valerio St, CA 91405") == "75002"


def test_parse_zip_from_address_when_no_explicit():
    assert imp.parse_zip(None, "555 Front St, San Diego, CA 92101") == "92101"


def test_parse_zip_strips_plus_four():
    assert imp.parse_zip("91405-1234") == "91405"


def test_parse_zip_preserves_leading_zero():
    assert imp.parse_zip("01970 Salem MA") == "01970"


def test_parse_zip_none_when_absent():
    assert imp.parse_zip(None, "Memphis, Millington, Cordova, TN") is None
    assert imp.parse_zip() is None


# ---------------------------------------------------------------------------
# radius parsing
# ---------------------------------------------------------------------------
def test_parse_radius_plain_miles():
    assert imp.parse_radius_miles("Within 150 miles from ZIP 91405") == 150.0


def test_parse_radius_hyphen_mile():
    assert imp.parse_radius_miles("150-mile radius from Van Nuys") == 150.0


def test_parse_radius_abbrev_mi():
    assert imp.parse_radius_miles("within 25 mi") == 25.0


def test_parse_radius_decimal():
    assert imp.parse_radius_miles("12.5 miles") == 12.5


def test_parse_radius_scans_multiple_sources():
    # first source has no radius, second one does
    assert (
        imp.parse_radius_miles("North Dallas / DFW metro", "150-mile radius")
        == 150.0
    )


def test_parse_radius_none_without_miles_unit():
    # a bare number (e.g. a street number / zip) is NOT a radius
    assert imp.parse_radius_miles("Radius pin around Baldwin, MD") is None
    assert imp.parse_radius_miles("18383 Preston Rd") is None
    assert imp.parse_radius_miles(None) is None


# ---------------------------------------------------------------------------
# build_profile_row — targeting columns + needs_input gap tracking
# ---------------------------------------------------------------------------
def _row(profile):
    col = imp.Collector(profile)
    return imp.build_profile_row("client-id", profile, col)


def test_build_row_sh_quality_full_radius():
    profile = {
        "location": {
            "address": "14431 Valerio Street #203, Van Nuys, CA 91405",
            "targeting": "Within 150 miles from ZIP 91405",
        },
        "campaign": {"targeting_type": "radius"},
    }
    row = _row(profile)
    assert row["targeting_address"] == "14431 Valerio Street #203, Van Nuys, CA 91405"
    assert row["targeting_zip"] == "91405"  # parsed out of the address
    assert row["targeting_radius_miles"] == 150.0
    # nothing about targeting should be flagged as a gap
    assert "location.address" not in row["needs_input"]
    assert "location.primary_zip" not in row["needs_input"]
    assert "targeting_radius_miles" not in row["needs_input"]


def test_build_row_kris_radius_pin_no_distance():
    profile = {
        "location": {
            "address": "13523 Long Green Pike, Baldwin MD 21013",
            "targeting": "Radius pin around Baldwin, MD",
        },
        "campaign": {
            "targeting_type": "radius_pin",
            "targeting_detail": "Baldwin, MD (switched from zip code targeting)",
        },
    }
    row = _row(profile)
    assert row["targeting_address"] == "13523 Long Green Pike, Baldwin MD 21013"
    assert row["targeting_zip"] == "21013"
    # radius_pin with no explicit distance -> NULL + tracked gap
    assert row["targeting_radius_miles"] is None
    assert "targeting_radius_miles" in row["needs_input"]
    assert "location.address" not in row["needs_input"]


def test_build_row_explicit_primary_zip_wins_over_address():
    profile = {
        "location": {
            "address": "18383 Preston Rd, Dallas, TX 75252",
            "primary_zip": "75002",
            "targeting": "North Dallas / DFW metro",
        },
        "campaign": {"targeting_detail": "North of Dallas, DFW metro"},
    }
    row = _row(profile)
    assert row["targeting_zip"] == "75002"  # primary_zip, not the address's 75252
    assert row["targeting_radius_miles"] is None
    assert "targeting_radius_miles" in row["needs_input"]


def test_build_row_needs_input_address_sentinel():
    profile = {
        "location": {
            "address": "NEEDS_INPUT",
            "targeting": "Memphis, Millington, Cordova, TN",
        },
    }
    row = _row(profile)
    assert row["targeting_address"] is None
    assert row["targeting_zip"] is None
    assert row["targeting_radius_miles"] is None
    # all three gaps tracked
    assert "location.address" in row["needs_input"]
    assert "location.primary_zip" in row["needs_input"]
    assert "targeting_radius_miles" in row["needs_input"]


def test_build_row_all_targeting_missing():
    profile = {}
    row = _row(profile)
    assert row["targeting_address"] is None
    assert row["targeting_zip"] is None
    assert row["targeting_radius_miles"] is None
    assert "location.address" in row["needs_input"]
    assert "location.primary_zip" in row["needs_input"]
    assert "targeting_radius_miles" in row["needs_input"]


def test_build_row_needs_input_idempotent():
    """Re-running the gap tracking must not duplicate paths."""
    profile = {"location": {"address": "NEEDS_INPUT"}}
    col = imp.Collector(profile)
    imp.build_profile_row("client-id", profile, col)
    # build a second time on the SAME collector to simulate accidental re-use
    row2 = imp.build_profile_row("client-id", profile, col)
    assert row2["needs_input"].count("location.address") == 1
    assert row2["needs_input"].count("targeting_radius_miles") == 1


def test_build_row_merges_file_needs_input():
    profile = {
        "location": {"address": "13523 Long Green Pike, Baldwin MD 21013"},
        "needs_input": ["brand.tagline"],
    }
    row = _row(profile)
    assert "brand.tagline" in row["needs_input"]  # file's own list preserved
    assert "targeting_radius_miles" in row["needs_input"]  # plus the new gap


# ---------------------------------------------------------------------------
# export round-trip — the structured `targeting` object
# ---------------------------------------------------------------------------
def test_reconstruct_targeting_object_full():
    client = {"id": "c-1", "name": "SH Quality Roofing"}
    profile_row = {
        "raw_profile": {"account": "SH Quality Roofing", "location": {}},
        "targeting_address": "14431 Valerio Street #203, Van Nuys, CA 91405",
        "targeting_zip": "91405",
        "targeting_radius_miles": 150,
        "targeting_type": "radius",
        "targeting": "Within 150 miles from ZIP 91405",
    }
    out = exp.reconstruct(client, profile_row, {})
    assert out["targeting"] == {
        "address": "14431 Valerio Street #203, Van Nuys, CA 91405",
        "zip": "91405",
        "radius_miles": 150,
        "type": "radius",
        "description": "Within 150 miles from ZIP 91405",
    }
    # the free-text prose still lands under location.targeting (unchanged path)
    assert out["location"]["targeting"] == "Within 150 miles from ZIP 91405"
    # campaign.targeting_type still round-trips via COLUMN_TO_PATH too
    assert out["campaign"]["targeting_type"] == "radius"


def test_reconstruct_targeting_object_partial_skips_nulls():
    client = {"id": "c-1", "name": "Kris Konstruction"}
    profile_row = {
        "raw_profile": {},
        "targeting_address": "13523 Long Green Pike, Baldwin MD 21013",
        "targeting_zip": "21013",
        "targeting_radius_miles": None,  # gap
        "targeting_type": "radius_pin",
        "targeting": "Radius pin around Baldwin, MD",
    }
    out = exp.reconstruct(client, profile_row, {})
    assert out["targeting"] == {
        "address": "13523 Long Green Pike, Baldwin MD 21013",
        "zip": "21013",
        "type": "radius_pin",
        "description": "Radius pin around Baldwin, MD",
    }
    assert "radius_miles" not in out["targeting"]


def test_reconstruct_no_targeting_block_when_all_null():
    client = {"id": "c-1", "name": "Aquarium Container Pools"}
    profile_row = {"raw_profile": {}}
    out = exp.reconstruct(client, profile_row, {})
    assert "targeting" not in out


def test_import_export_round_trip():
    """A profile imported then exported reproduces the structured targeting."""
    profile = {
        "account": "SH Quality Roofing",
        "location": {
            "address": "14431 Valerio Street #203, Van Nuys, CA 91405",
            "targeting": "Within 150 miles from ZIP 91405",
        },
        "campaign": {"targeting_type": "radius"},
    }
    col = imp.Collector(profile)
    row = imp.build_profile_row("c-1", profile, col)
    # carry the column names the exporter reads off the DB row
    profile_row = {
        "raw_profile": profile,
        "targeting_address": row["targeting_address"],
        "targeting_zip": row["targeting_zip"],
        "targeting_radius_miles": row["targeting_radius_miles"],
        "targeting_type": row["targeting_type"],
        "targeting": row["targeting"],
    }
    out = exp.reconstruct({"id": "c-1", "name": "SH Quality Roofing"}, profile_row, {})
    assert out["targeting"]["zip"] == "91405"
    assert out["targeting"]["radius_miles"] == 150.0
    assert out["targeting"]["type"] == "radius"


# ---------------------------------------------------------------------------
# allow `python3 test_targeting.py` without pytest installed
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("PASS", name)
            except AssertionError as e:  # noqa: PERF203
                failures += 1
                print("FAIL", name, "->", e)
    print("\n%d test(s), %d failure(s)" % (
        sum(1 for n in globals() if n.startswith("test_")), failures
    ))
    sys.exit(1 if failures else 0)
