# Client profiles: DB <-> shared JSON sync

Per-client brand / company / campaign knowledge (the data the dashboard operator
authors ads from) has two homes:

- **The database is canonical.** Tables `clients` + `client_profiles` and the
  child tables (`client_services`, `client_value_props`, `client_offers`,
  `client_offer_constraints`, `client_assets`, `client_past_projects`), created
  in `db/migrations/0012_client_data_layer.sql`. The operator reads/edits here.
- **The shared JSON files** at `/docker/hermes-shared/client-profiles/*.json` on
  the VPS, bind-mounted into the file-based marketing agents
  (ekko / monarch / forge / archer). These must stay in sync so those agents
  keep working.

```
shared JSON files  --import_profiles.py-->  Supabase (canonical)
shared JSON files  <--export_profiles.py--  Supabase (canonical)
```

`import_profiles.py` seeds / re-syncs the DB **from** the files (one-time seed,
or to re-pull manual file edits). `export_profiles.py` regenerates the files
**from** the DB after the operator edits a profile — DB values win, layered over
the original `raw_profile` snapshot so nothing the agents expect is dropped.

Both scripts are **stdlib only** (no pip installs) and talk to Supabase via
PostgREST using the service-role key (bypasses RLS). Both are idempotent.

## Credentials

Read from `/opt/voxhorizon/.env` on the VPS (root-readable):

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (service role)

Never print these. The snippets below load them into the env without echoing.

## Running the import (seed / re-sync DB from files)

The VPS host has `python3` (3.12) and the files at
`/docker/hermes-shared/client-profiles` (root-readable), so run on the host:

```bash
ssh voxhorizon-vps

# load creds into the env without echoing them
sudo cat /opt/voxhorizon/.env > /tmp/voxenv && set -a && . /tmp/voxenv && set +a

# copy the script up (or git pull the repo on the box), then:
sudo -E python3 import_profiles.py /docker/hermes-shared/client-profiles

rm -f /tmp/voxenv
```

Prints a per-client summary and final row counts. Safe to re-run: parents are
upserted (merge-duplicates on `slug` / `client_id`); child rows are
delete-by-client then bulk re-inserted preserving order via `sort_order`.

If the host ever lacks python or the file mount, run inside a marketing agent
container that has both (files mounted at `/opt/data/shared/client-profiles`):

```bash
docker exec -i -e SUPABASE_URL -e SUPABASE_SECRET_KEY hermes-agent-ekko \
  python3 - < import_profiles.py /opt/data/shared/client-profiles
```

## Running the export (regenerate files from DB)

```bash
ssh voxhorizon-vps
sudo cat /opt/voxhorizon/.env > /tmp/voxenv && set -a && . /tmp/voxenv && set +a

# all clients:
sudo -E python3 export_profiles.py /docker/hermes-shared/client-profiles
# or a single slug:
sudo -E python3 export_profiles.py /docker/hermes-shared/client-profiles kris-konstruction

rm -f /tmp/voxenv
```

Files are written atomically (temp file + `os.replace`) so a file-based agent
never reads a partially written profile.

## Field mapping notes

- `clients`: `slug` = filename (no `.json`); `name` = `account`; `status` =
  top-level `status`; `service_type` is **derived** (pools → `pools`; general
  contractors → `general_contracting`; roofing-dominant → `roofing`;
  remodelers → `remodeling`; else `construction`); `brand_colors` =
  `brand.colors` only when it is an object (else `{}`); `ghl_location_id`,
  `drive_root_folder_id` (= `drive.root_folder_id`), `cpl_target` (null if
  absent).
- `client_profiles`: typed columns mapped from nested paths (see
  `import_profiles.py` `build_profile_row`). `warranty_details` collects the
  `company.warranty_*` sub-fields into a jsonb object. `raw_profile` stores the
  entire original JSON.
- **`NEEDS_INPUT` handling:** any value equal to the string `"NEEDS_INPUT"` is
  stored as NULL and its dot-path is appended to `needs_input` (merged with the
  file's own `needs_input` array).
- **Mixed-type text columns** (`google_reviews`, `projects_completed`,
  `minimum_project_size`, `financing`) store the stringified value;
  `google_rating` → float or null; booleans (`family_owned`,
  `licensed_insured`) → bool or null.
- Child tables: `services[]` → `client_services`; `usps[]` /
  `differentiators[]` → `client_value_props` (`kind` usp/differentiator);
  `campaign.current_offers[]` → `client_offers`;
  `campaign.offer_constraints[]` → `client_offer_constraints`; `past_projects[]`
  → `client_past_projects`; assets (logo/logo_alt/facebook_banner, reviews,
  team_photos, external_assets, existing_creatives, project_photos/pictures) →
  `client_assets`. Creative descriptors like `Name (1x1, 9x16)` are split into
  `label` + `formats`.
