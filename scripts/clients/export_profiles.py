#!/usr/bin/env python3
"""Sync client profiles back out of Supabase into the shared JSON files.

The database is canonical (see import_profiles.py + db/migrations/0012). The
file-based marketing agents (ekko/monarch/forge/archer) still read the JSON at
/docker/hermes-shared/client-profiles/*.json, so after the operator edits a
profile in the DB we must regenerate those files.

Reconstruction strategy: start from ``raw_profile`` (the full original JSON we
stored verbatim) and then overlay the normalized columns + child rows so that
**DB edits win** over the stale snapshot. Files are written atomically
(temp file in the same dir + os.replace) so an agent never reads a half-written
file.

stdlib only. Requires SUPABASE_URL + SUPABASE_SECRET_KEY in the env.

Usage (on the VPS):
    set -a; sudo cat /opt/voxhorizon/.env > /tmp/voxenv && . /tmp/voxenv; set +a
    sudo -E python3 export_profiles.py /docker/hermes-shared/client-profiles
See scripts/clients/README.md.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


# ---------------------------------------------------------------------------
# PostgREST client (read side)
# ---------------------------------------------------------------------------
class Supabase:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1"
        self.key = key

    def _headers(self):
        return {
            "apikey": self.key,
            "Authorization": "Bearer " + self.key,
            "Content-Type": "application/json",
        }

    def get(self, table, params):
        url = self.base + "/" + table + "?" + urllib.parse.urlencode(params, doseq=True)
        req = urllib.request.Request(url, headers=self._headers(), method="GET")
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise RuntimeError(
                "GET %s -> HTTP %s: %s" % (table, e.code, detail)
            ) from None


# ---------------------------------------------------------------------------
# helpers to set nested dotted paths
# ---------------------------------------------------------------------------
def _set(obj, path, value):
    """Set obj at dotted ``path`` to ``value`` unless value is None."""
    if value is None:
        return
    parts = path.split(".")
    node = obj
    for p in parts[:-1]:
        nxt = node.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            node[p] = nxt
        node = nxt
    node[parts[-1]] = value


# Maps a client_profiles column -> the dotted path it occupies in the JSON shape.
COLUMN_TO_PATH = {
    "tone": "brand.tone",
    "tagline": "brand.tagline",
    "voice_note": "ownership.voice_note",
    "brand_fonts": "brand.fonts",
    "logo_drive_id": "brand.logo_drive_id",
    "logo_alt_drive_id": "brand.logo_alt_drive_id",
    "legal_name": "company.legal_name",
    "business_type": "company.business_type",
    "ein": "company.ein",
    "license_number": "company.license_number",
    "years_in_business": "company.years_in_business",
    "owner_experience_years": "company.owner_experience_years",
    "family_owned": "company.family_owned",
    "background": "company.background",
    "google_reviews": "company.google_reviews",
    "google_rating": "company.google_rating",
    "bbb_rating": "company.bbb_rating",
    "average_project_value": "company.average_project_value",
    "minimum_project_size": "company.minimum_project_size",
    "residential_projects": "company.residential_projects",
    "commercial_projects": "company.commercial_projects",
    "total_work_orders": "company.total_work_orders",
    "projects_completed": "company.projects_completed",
    "warranty": "company.warranty",
    "financing": "company.financing",
    "business_hours": "company.business_hours",
    "appointment_availability": "company.appointment_availability",
    "licensed_insured": "company.licensed_insured",
    "contact_primary": "contact.primary",
    "contact_secondary": "contact.secondary",
    "contact_role": "contact.role",
    "contact_phone": "contact.phone",
    "contact_email": "contact.email",
    "company_email": "contact.company_email",
    "owner_name": "ownership.owner",
    "annual_revenue": "ownership.annual_revenue",
    "company_size": "ownership.company_size",
    "address": "location.address",
    "business_address": "location.business_address",
    "city": "location.city",
    "state": "location.state",
    "primary_city": "location.primary_city",
    "primary_zip": "location.primary_zip",
    "targeting": "location.targeting",
    "targeting_detail": "location.targeting_detail",
    "timezone": "location.timezone",
    "crm": "lead_handling.crm",
    "integration": "lead_handling.integration",
    "website": "lead_handling.website",
    "booking_flow": "lead_handling.booking_flow",
    "closebot_role": "lead_handling.closebot_role",
    "sales_rep": "lead_handling.sales_rep",
    "campaign_name": "campaign.name",
    "campaign_status": "campaign.status",
    "launch_date": "campaign.launch_date",
    "relaunch_date": "campaign.relaunch_date",
    "targeting_type": "campaign.targeting_type",
    "daily_budget": "campaign.budget_daily",
    "funnel": "campaign.funnel",
    "drive_docs_folder_id": "drive.docs_folder_id",
    "drive_assets_folder_id": "drive.assets_folder_id",
    "drive_creatives_folder_id": "drive.creatives_folder_id",
    "drive_performance_folder_id": "drive.performance_folder_id",
    "drive_resources_folder_id": "drive.resources_folder_id",
    "drive_meeting_notes_folder_id": "drive.meeting_notes_folder_id",
    "client_profile_doc_id": "drive.client_profile_doc_id",
    "stat_sheet_url": "drive.stat_sheet_url",
}


def reconstruct(client, profile_row, children):
    """Rebuild a single client's nested JSON. DB edits overlay raw_profile."""
    raw = profile_row.get("raw_profile") or {}
    # deep copy via json round-trip so we never mutate the source dict
    out = json.loads(json.dumps(raw))

    # identity / integration columns live on clients
    _set(out, "account", client.get("name"))
    _set(out, "ghl_location_id", client.get("ghl_location_id"))
    _set(out, "status", client.get("status"))
    _set(out, "drive.root_folder_id", client.get("drive_root_folder_id"))
    bc = client.get("brand_colors")
    if isinstance(bc, dict) and bc:
        _set(out, "brand.colors", bc)
    if client.get("cpl_target") is not None:
        out["cpl_target"] = client["cpl_target"]

    # overlay every normalized profile column at its dotted path
    for col, path in COLUMN_TO_PATH.items():
        _set(out, path, profile_row.get(col))

    # top-level snapshot fields
    _set(out, "monthly_budget", profile_row.get("monthly_budget"))
    if profile_row.get("daily_budget") is not None:
        out["daily_budget"] = profile_row["daily_budget"]

    # warranty_details jsonb -> company.warranty_* sub-fields
    wd = profile_row.get("warranty_details")
    if isinstance(wd, dict):
        for k, v in wd.items():
            _set(out, "company.warranty_" + k, v)

    # needs_input array
    ni = profile_row.get("needs_input")
    if isinstance(ni, list):
        out["needs_input"] = ni

    # child tables -> arrays (ordered by sort_order)
    _overlay_children(out, children)
    return out


def _overlay_children(out, children):
    svc = _ordered(children.get("client_services", []))
    if svc:
        out["services"] = [r["service_name"] for r in svc]

    props = _ordered(children.get("client_value_props", []))
    usps = [r["prop_text"] for r in props if r["kind"] == "usp"]
    diffs = [r["prop_text"] for r in props if r["kind"] == "differentiator"]
    if usps:
        out["usps"] = usps
    if diffs:
        out["differentiators"] = diffs

    offers = _ordered(children.get("client_offers", []))
    if offers:
        out.setdefault("campaign", {})["current_offers"] = [
            r["offer_text"] for r in offers
        ]
    constraints = _ordered(children.get("client_offer_constraints", []))
    if constraints:
        out.setdefault("campaign", {})["offer_constraints"] = [
            r["constraint_text"] for r in constraints
        ]

    past = _ordered(children.get("client_past_projects", []))
    if past:
        out["past_projects"] = [r["url"] for r in past]

    _overlay_assets(out, _ordered(children.get("client_assets", [])))


def _overlay_assets(out, assets):
    if not assets:
        return
    a = out.setdefault("assets", {})
    reviews, team, external, creatives, project = [], [], [], [], []
    for r in assets:
        kind, source, ref = r["kind"], r["source"], r["ref"]
        if kind == "logo":
            a["logo"] = ref
        elif kind == "logo_alt":
            a["logo_alt"] = ref
        elif kind == "facebook_banner":
            a["facebook_banner"] = ref
        elif kind == "review":
            reviews.append(ref)
        elif kind == "team_photo":
            team.append(ref)
        elif kind == "external":
            external.append(ref)
        elif kind == "existing_creative":
            creatives.append(ref)
        elif kind == "project_photo":
            project.append(ref)
    if reviews:
        a["reviews"] = reviews
    if team:
        a["team_photos"] = team
    if external:
        a["external_assets"] = external
    if creatives:
        a["existing_creatives"] = creatives
    if project:
        # preserve original scalar shape when there was exactly one descriptor
        a["project_photos"] = project[0] if len(project) == 1 else project


def _ordered(rows):
    return sorted(rows, key=lambda r: (r.get("sort_order", 0), r.get("created_at", "")))


# ---------------------------------------------------------------------------
# atomic write
# ---------------------------------------------------------------------------
def write_atomic(path, obj):
    data = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    d = os.path.dirname(os.path.abspath(path))
    tmp = os.path.join(d, ".%s.tmp" % os.path.basename(path))
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# fetch + assemble
# ---------------------------------------------------------------------------
CHILD_TABLES = (
    "client_services",
    "client_value_props",
    "client_offers",
    "client_offer_constraints",
    "client_assets",
    "client_past_projects",
)


def assemble_client(sb, slug):
    rows = sb.get("clients", {"slug": "eq.%s" % slug, "select": "*"})
    if not rows:
        raise RuntimeError("no client with slug=%s" % slug)
    client = rows[0]
    cid = client["id"]
    prof = sb.get("client_profiles", {"client_id": "eq.%s" % cid, "select": "*"})
    profile_row = prof[0] if prof else {}
    children = {}
    for t in CHILD_TABLES:
        children[t] = sb.get(t, {"client_id": "eq.%s" % cid, "select": "*"})
    return reconstruct(client, profile_row, children)


def main(argv):
    out_dir = argv[1] if len(argv) > 1 else "/docker/hermes-shared/client-profiles"
    only = argv[2] if len(argv) > 2 else None  # optional single slug

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not url or not key:
        sys.stderr.write(
            "ERROR: SUPABASE_URL and SUPABASE_SECRET_KEY must be set in the env.\n"
        )
        return 2

    sb = Supabase(url, key)
    if only:
        slugs = [only]
    else:
        slugs = sorted(
            r["slug"] for r in sb.get("clients", {"select": "slug"})
        )

    for slug in slugs:
        obj = assemble_client(sb, slug)
        path = os.path.join(out_dir, slug + ".json")
        write_atomic(path, obj)
        print("wrote %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
