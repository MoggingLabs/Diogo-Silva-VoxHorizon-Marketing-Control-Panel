#!/usr/bin/env python3
"""Seed / re-sync client profiles from the shared JSON files into Supabase.

The dashboard's canonical home for per-client brand / company / campaign
knowledge is the database (tables created in db/migrations/0012_client_data_layer.sql).
That data originated as JSON files at /docker/hermes-shared/client-profiles/*.json,
which are bind-mounted into the file-based marketing agents. This script reads
that directory and upserts every profile into the DB.

Talks to Supabase via PostgREST (no 3rd-party deps -- stdlib only). Requires
SUPABASE_URL and SUPABASE_SECRET_KEY (service role, bypasses RLS) in the env.

Idempotent: parent rows are upserted (merge-duplicates on the natural key) and
child rows are delete-then-bulk-insert, so re-running converges to the file state.

Usage (on the VPS):
    set -a; sudo cat /opt/voxhorizon/.env > /tmp/voxenv && . /tmp/voxenv; set +a
    sudo -E python3 import_profiles.py /docker/hermes-shared/client-profiles
See scripts/clients/README.md for the exact, safe invocation.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

NEEDS_INPUT = "NEEDS_INPUT"

# ---------------------------------------------------------------------------
# service_type derivation
# ---------------------------------------------------------------------------
# service_type enum (after migration 0012): roofing | remodeling |
# general_contracting | construction | pools.
POOL_HINTS = ("pool",)
ROOFING_HINTS = ("roof", "shingle", "gutter")
REMODEL_HINTS = ("remodel", "renovation", "kitchen", "bathroom", "adu")
GC_HINTS = ("general contract", "general contracting")


def derive_service_type(profile):
    """Pick the best-fit service_type enum value from services + account name."""
    services = [str(s).lower() for s in (profile.get("services") or [])]
    account = str(profile.get("account") or "").lower()
    blob = account + " " + " ".join(services)

    # Pool *brands* -> pools. Require the brand to be pool-focused (name says
    # pool, or pools dominate the service list) so a remodeler that merely
    # offers "pools (container pools)" as one of many services isn't miscast.
    pool_services = sum(1 for s in services if any(h in s for h in POOL_HINTS))
    pool_in_name = any(h in account for h in POOL_HINTS)
    if pool_in_name or (services and pool_services * 2 >= len(services)):
        return "pools"

    # General contractors / explicit GC naming.
    if any(h in account for h in GC_HINTS) or any(
        "general contract" in s for s in services
    ):
        return "general_contracting"

    # Roofing-dominant: majority of listed services mention roofing terms.
    roof_services = sum(
        1 for s in services if any(h in s for h in ROOFING_HINTS)
    )
    if services and roof_services * 2 >= len(services):
        return "roofing"
    if roof_services and "roofing" in account:
        return "roofing"

    # Remodelers.
    if any(h in blob for h in REMODEL_HINTS):
        return "remodeling"

    # Fall back to the generic construction vertical.
    return "construction"


# ---------------------------------------------------------------------------
# value coercion helpers
# ---------------------------------------------------------------------------
def _is_needs_input(v):
    return isinstance(v, str) and v.strip() == NEEDS_INPUT


class Collector:
    """Resolves dotted paths against a profile, recording NEEDS_INPUT hits.

    Any value equal to the string "NEEDS_INPUT" is stored as NULL and its
    dot-path is appended to ``needs_input`` (later merged with the file's own
    needs_input array).
    """

    def __init__(self, profile):
        self.profile = profile
        self.needs_input = []

    def get(self, path):
        """Return the raw value at a dot-path, or None if missing.

        Records NEEDS_INPUT paths and returns None for them.
        """
        node = self.profile
        for part in path.split("."):
            if not isinstance(node, dict) or part not in node:
                return None
            node = node[part]
        if _is_needs_input(node):
            if path not in self.needs_input:
                self.needs_input.append(path)
            return None
        return node

    # typed accessors -------------------------------------------------------
    def text(self, path):
        v = self.get(path)
        if v is None:
            return None
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False)
        if isinstance(v, bool):
            return "true" if v else "false"
        return str(v)

    def integer(self, path):
        v = self.get(path)
        if v is None:
            return None
        if isinstance(v, bool):
            return None
        if isinstance(v, int):
            return v
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, str):
            s = v.strip()
            if s.isdigit():
                return int(s)
        return None  # mixed strings like "< 1 (4 months)" stay null

    def number(self, path):
        v = self.get(path)
        if v is None:
            return None
        if isinstance(v, bool):
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v.strip())
            except ValueError:
                return None
        return None

    def boolean(self, path):
        v = self.get(path)
        if v is None:
            return None
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            s = v.strip().lower()
            if s in ("true", "yes", "y"):
                return True
            if s in ("false", "no", "n"):
                return False
        return None

    def date(self, path):
        v = self.get(path)
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            # accept ISO-ish YYYY-MM-DD only; anything else -> null
            parts = s.split("-")
            if len(parts) == 3 and all(p.isdigit() for p in parts):
                return s
        return None

    def jsonb(self, path):
        """Return value only if it's an object/array (else None)."""
        v = self.get(path)
        if isinstance(v, (dict, list)):
            return v
        return None


# ---------------------------------------------------------------------------
# PostgREST client
# ---------------------------------------------------------------------------
class Supabase:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1"
        self.key = key

    def _headers(self, extra=None):
        h = {
            "apikey": self.key,
            "Authorization": "Bearer " + self.key,
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def _request(self, method, path, params=None, body=None, prefer=None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
        extra = {"Prefer": prefer} if prefer else None
        req = urllib.request.Request(
            url, data=data, headers=self._headers(extra), method=method
        )
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise RuntimeError(
                "%s %s -> HTTP %s: %s" % (method, path, e.code, detail)
            ) from None

    def upsert(self, table, row, on_conflict, select="*"):
        """Upsert a single row, return the resulting row."""
        params = {"on_conflict": on_conflict, "select": select}
        prefer = "resolution=merge-duplicates,return=representation"
        out = self._request(
            "POST", "/" + table, params=params, body=[row], prefer=prefer
        )
        return out[0] if out else None

    def delete_by(self, table, **eq):
        params = {k: "eq.%s" % v for k, v in eq.items()}
        self._request("DELETE", "/" + table, params=params, prefer="return=minimal")

    def insert_many(self, table, rows):
        if not rows:
            return
        self._request(
            "POST", "/" + table, body=rows, prefer="return=minimal"
        )

    def count(self, table):
        # client_profiles' PK is client_id (no id column); use a HEAD-style
        # count with no select so it works for every table.
        url = self.base + "/" + table + "?select=count"
        req = urllib.request.Request(
            url,
            headers=self._headers({"Prefer": "count=exact", "Range": "0-0"}),
            method="GET",
        )
        with urllib.request.urlopen(req) as resp:
            cr = resp.headers.get("Content-Range", "*/0")
            return int(cr.split("/")[-1])


# ---------------------------------------------------------------------------
# mapping: profile -> client_profiles row
# ---------------------------------------------------------------------------
def build_profile_row(client_id, profile, col):
    """Map a source profile to the client_profiles columns via Collector ``col``."""
    # warranty_details: collect the warranty_* sub-fields of company.* .
    company = profile.get("company") or {}
    warranty_details = {}
    for k, v in company.items():
        if k.startswith("warranty_") and not _is_needs_input(v):
            warranty_details[k[len("warranty_"):]] = v

    row = {
        "client_id": client_id,
        # brand / voice
        "tone": col.text("brand.tone"),
        "tagline": col.text("brand.tagline"),
        "voice_note": col.text("ownership.voice_note"),
        "brand_fonts": col.jsonb("brand.fonts"),
        "logo_drive_id": col.text("brand.logo_drive_id"),
        "logo_alt_drive_id": col.text("brand.logo_alt_drive_id"),
        # company facts
        "legal_name": col.text("company.legal_name"),
        "business_type": col.text("company.business_type"),
        "ein": col.text("company.ein"),
        "license_number": col.text("company.license_number"),
        "years_in_business": col.integer("company.years_in_business"),
        "owner_experience_years": col.integer("company.owner_experience_years"),
        "family_owned": col.boolean("company.family_owned"),
        "background": col.text("company.background"),
        "google_reviews": col.text("company.google_reviews"),
        "google_rating": col.number("company.google_rating"),
        "bbb_rating": col.text("company.bbb_rating"),
        "average_project_value": col.text("company.average_project_value"),
        "minimum_project_size": col.text("company.minimum_project_size"),
        "residential_projects": col.integer("company.residential_projects"),
        "commercial_projects": col.integer("company.commercial_projects"),
        "total_work_orders": col.integer("company.total_work_orders"),
        "projects_completed": col.text("company.projects_completed"),
        "warranty": col.text("company.warranty"),
        "warranty_details": warranty_details or None,
        "financing": col.text("company.financing"),
        "business_hours": col.text("company.business_hours"),
        "appointment_availability": col.text("company.appointment_availability"),
        "licensed_insured": col.boolean("company.licensed_insured"),
        # contact
        "contact_primary": col.text("contact.primary"),
        "contact_secondary": col.text("contact.secondary"),
        "contact_role": col.text("contact.role"),
        "contact_phone": col.text("contact.phone"),
        "contact_email": col.text("contact.email"),
        "company_email": col.text("contact.company_email"),
        # ownership
        "owner_name": col.text("ownership.owner"),
        "annual_revenue": col.text("ownership.annual_revenue"),
        "company_size": col.text("ownership.company_size"),
        # location / targeting
        "address": col.text("location.address"),
        "business_address": col.text("location.business_address"),
        "city": col.text("location.city"),
        "state": col.text("location.state"),
        "primary_city": col.text("location.primary_city"),
        "primary_zip": col.text("location.primary_zip"),
        "targeting": col.text("location.targeting"),
        "targeting_detail": col.text("location.targeting_detail"),
        "timezone": col.text("location.timezone"),
        # lead handling
        "crm": col.text("lead_handling.crm"),
        "integration": col.text("lead_handling.integration"),
        "website": col.text("lead_handling.website"),
        "booking_flow": col.text("lead_handling.booking_flow"),
        "closebot_role": col.text("lead_handling.closebot_role"),
        "sales_rep": col.text("lead_handling.sales_rep"),
        # campaign snapshot
        "campaign_name": col.text("campaign.name"),
        "campaign_status": col.text("campaign.status"),
        "launch_date": col.date("campaign.launch_date"),
        "relaunch_date": col.date("campaign.relaunch_date"),
        "targeting_type": col.text("campaign.targeting_type"),
        "daily_budget": (
            col.number("campaign.budget_daily")
            if col.number("campaign.budget_daily") is not None
            else col.number("daily_budget")
        ),
        "monthly_budget": col.number("monthly_budget"),
        "funnel": col.jsonb("campaign.funnel"),
        # drive folders
        "drive_docs_folder_id": col.text("drive.docs_folder_id"),
        "drive_assets_folder_id": col.text("drive.assets_folder_id"),
        "drive_creatives_folder_id": col.text("drive.creatives_folder_id"),
        "drive_performance_folder_id": col.text("drive.performance_folder_id"),
        "drive_resources_folder_id": col.text("drive.resources_folder_id"),
        "drive_meeting_notes_folder_id": col.text("drive.meeting_notes_folder_id"),
        "client_profile_doc_id": col.text("drive.client_profile_doc_id"),
        "stat_sheet_url": col.text("drive.stat_sheet_url"),
    }

    # needs_input = file's own list merged with collected NEEDS_INPUT paths.
    file_needs = profile.get("needs_input") or []
    if not isinstance(file_needs, list):
        file_needs = [file_needs]
    merged, seen = [], set()
    for item in list(file_needs) + col.needs_input:
        key = str(item)
        if key not in seen:
            seen.add(key)
            merged.append(item)
    row["needs_input"] = merged
    row["raw_profile"] = profile
    return row


# ---------------------------------------------------------------------------
# mapping: profile -> child-table rows
# ---------------------------------------------------------------------------
def _clean_list(value):
    """Normalize an array field, dropping NEEDS_INPUT entries."""
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]
    out = []
    for v in value:
        if _is_needs_input(v):
            continue
        if v is None:
            continue
        out.append(v)
    return out


def parse_creative_descriptor(desc):
    """Split 'Name (1x1, 9x16)' into (label, formats).

    A trailing parenthetical of the form ``(<formats>)`` becomes ``formats``;
    everything before it is the ``label``. If the trailing paren does not look
    like a format list (e.g. '(folder)'), keep it as part of the label.
    """
    s = str(desc).strip()
    if s.endswith(")") and "(" in s:
        idx = s.rfind("(")
        inner = s[idx + 1:-1].strip()
        head = s[:idx].strip()
        tokens = [t.strip() for t in inner.split(",")]
        # treat as formats only if every token looks like WxH (e.g. 1x1, 9x16)
        looks_like_formats = bool(tokens) and all(
            _is_ratio(t) for t in tokens
        )
        if looks_like_formats and head:
            return head, ", ".join(tokens)
    return s, None


def _is_ratio(tok):
    parts = tok.lower().split("x")
    return len(parts) == 2 and all(p.strip().isdigit() for p in parts)


def build_children(client_id, profile):
    """Return a dict of {table_name: [rows]} for all child tables."""
    children = {
        "client_services": [],
        "client_value_props": [],
        "client_offers": [],
        "client_offer_constraints": [],
        "client_assets": [],
        "client_past_projects": [],
    }

    # services -> client_services
    for i, name in enumerate(_clean_list(profile.get("services"))):
        children["client_services"].append(
            {"client_id": client_id, "service_name": str(name), "sort_order": i}
        )

    # usps -> value_props(kind=usp); differentiators -> kind=differentiator
    for i, txt in enumerate(_clean_list(profile.get("usps"))):
        children["client_value_props"].append(
            {
                "client_id": client_id,
                "kind": "usp",
                "prop_text": str(txt),
                "sort_order": i,
            }
        )
    for i, txt in enumerate(_clean_list(profile.get("differentiators"))):
        children["client_value_props"].append(
            {
                "client_id": client_id,
                "kind": "differentiator",
                "prop_text": str(txt),
                "sort_order": i,
            }
        )

    campaign = profile.get("campaign") or {}
    # campaign.current_offers -> client_offers
    for i, txt in enumerate(_clean_list(campaign.get("current_offers"))):
        children["client_offers"].append(
            {
                "client_id": client_id,
                "offer_text": str(txt),
                "active": True,
                "sort_order": i,
            }
        )
    # campaign.offer_constraints -> client_offer_constraints
    for i, txt in enumerate(_clean_list(campaign.get("offer_constraints"))):
        children["client_offer_constraints"].append(
            {
                "client_id": client_id,
                "constraint_text": str(txt),
                "sort_order": i,
            }
        )

    # past_projects -> client_past_projects
    for i, url in enumerate(_clean_list(profile.get("past_projects"))):
        children["client_past_projects"].append(
            {"client_id": client_id, "url": str(url), "sort_order": i}
        )

    # assets -> client_assets
    children["client_assets"] = build_assets(client_id, profile.get("assets") or {})
    return children


def build_assets(client_id, assets):
    rows = []
    order = [0]

    def add(kind, source, ref, formats=None, label=None):
        rows.append(
            {
                "client_id": client_id,
                "kind": kind,
                "source": source,
                "ref": str(ref),
                "formats": formats,
                "label": label,
                "sort_order": order[0],
            }
        )
        order[0] += 1

    # single-value filename assets
    if assets.get("logo") and not _is_needs_input(assets.get("logo")):
        add("logo", "filename", assets["logo"])
    if assets.get("logo_alt") and not _is_needs_input(assets.get("logo_alt")):
        add("logo_alt", "filename", assets["logo_alt"])
    if assets.get("facebook_banner") and not _is_needs_input(
        assets.get("facebook_banner")
    ):
        add("facebook_banner", "filename", assets["facebook_banner"])

    # reviews[] -> kind=review, source=filename
    for ref in _clean_list(assets.get("reviews")):
        add("review", "filename", ref)

    # team_photos[] -> kind=team_photo, source=filename
    for ref in _clean_list(assets.get("team_photos")):
        add("team_photo", "filename", ref)

    # external_assets[] -> kind=external, source=url
    for ref in _clean_list(assets.get("external_assets")):
        add("external", "url", ref)

    # existing_creatives[] -> kind=existing_creative, source=descriptor
    for ref in _clean_list(assets.get("existing_creatives")):
        label, formats = parse_creative_descriptor(ref)
        add("existing_creative", "descriptor", ref, formats=formats, label=label)

    # project_photos / project_pictures descriptor strings (string or list)
    for key in ("project_photos", "project_pictures"):
        val = assets.get(key)
        if val is None or _is_needs_input(val):
            continue
        items = val if isinstance(val, list) else [val]
        for ref in items:
            if _is_needs_input(ref) or ref is None:
                continue
            add("project_photo", "descriptor", ref)

    return rows


# ---------------------------------------------------------------------------
# mapping: profile -> clients row
# ---------------------------------------------------------------------------
def build_client_row(slug, profile):
    colors = profile.get("brand", {}).get("colors")
    brand_colors = colors if isinstance(colors, dict) else {}

    daily = profile.get("daily_budget")  # noqa: F841 (kept for clarity)

    cpl = profile.get("cpl_target")
    if _is_needs_input(cpl):
        cpl = None

    return {
        "slug": slug,
        "name": profile.get("account"),
        "status": profile.get("status") or "active",
        "service_type": derive_service_type(profile),
        "brand_colors": brand_colors,
        "ghl_location_id": profile.get("ghl_location_id"),
        "drive_root_folder_id": (profile.get("drive") or {}).get("root_folder_id"),
        "cpl_target": cpl,
    }


# ---------------------------------------------------------------------------
# per-file driver
# ---------------------------------------------------------------------------
def import_file(sb, path):
    slug = os.path.splitext(os.path.basename(path))[0]
    with open(path, "r", encoding="utf-8") as fh:
        profile = json.load(fh)

    # 1) upsert clients (on slug), read back the id
    client_row = build_client_row(slug, profile)
    saved = sb.upsert("clients", client_row, on_conflict="slug", select="id,slug")
    client_id = saved["id"]

    # 2) upsert client_profiles (on client_id)
    col = Collector(profile)
    profile_row = build_profile_row(client_id, profile, col)
    sb.upsert("client_profiles", profile_row, on_conflict="client_id", select="client_id")

    # 3) child tables: delete-by-client then bulk insert (preserve order)
    children = build_children(client_id, profile)
    counts = {}
    for table, rows in children.items():
        sb.delete_by(table, client_id=client_id)
        sb.insert_many(table, rows)
        counts[table] = len(rows)

    print(
        "  %-30s id=%s  type=%-18s status=%-8s"
        % (slug, client_id, client_row["service_type"], client_row["status"])
    )
    print(
        "    services=%d value_props=%d offers=%d constraints=%d "
        "assets=%d past_projects=%d needs_input=%d"
        % (
            counts["client_services"],
            counts["client_value_props"],
            counts["client_offers"],
            counts["client_offer_constraints"],
            counts["client_assets"],
            counts["client_past_projects"],
            len(profile_row["needs_input"]),
        )
    )
    return slug


def main(argv):
    src = argv[1] if len(argv) > 1 else "/docker/hermes-shared/client-profiles"
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not url or not key:
        sys.stderr.write(
            "ERROR: SUPABASE_URL and SUPABASE_SECRET_KEY must be set in the env.\n"
        )
        return 2

    if not os.path.isdir(src):
        sys.stderr.write("ERROR: source dir not found: %s\n" % src)
        return 2

    files = sorted(
        os.path.join(src, f)
        for f in os.listdir(src)
        if f.endswith(".json") and os.path.isfile(os.path.join(src, f))
    )
    if not files:
        sys.stderr.write("ERROR: no .json files in %s\n" % src)
        return 2

    sb = Supabase(url, key)
    print("Importing %d client profile(s) from %s" % (len(files), src))
    done = []
    for path in files:
        try:
            done.append(import_file(sb, path))
        except Exception as e:  # noqa: BLE001 -- surface per-file failures, keep going
            sys.stderr.write("  FAILED %s: %s\n" % (path, e))

    print("\nDone. %d/%d imported." % (len(done), len(files)))
    # final tallies straight from the DB
    for t in (
        "clients",
        "client_profiles",
        "client_services",
        "client_value_props",
        "client_offers",
        "client_offer_constraints",
        "client_assets",
        "client_past_projects",
    ):
        try:
            print("  %-26s %d rows" % (t, sb.count(t)))
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("  count(%s) failed: %s\n" % (t, e))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
