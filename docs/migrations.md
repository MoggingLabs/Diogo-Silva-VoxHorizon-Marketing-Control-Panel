# Migrations: expand/contract on a live multi-tenant DB

Status: E5.5 / #523.

This is the rule book for changing the database schema without breaking the
running app. It exists because schema and code deploy on **separate tracks**:

- Migrations are **forward-only** files in `db/migrations`, named `0001..N`. There
  are no `down` scripts and **no `schema_migrations` ledger** table.
- Schema is pushed **manually** via `supabase db push`. The code deploy
  (`deploy-stack.yml`) does **not** apply migrations.

So at any moment the live DB can be AHEAD of the running code (the push ran, the
deploy has not) or, if someone forgets the push, BEHIND it. The whole point of
the discipline below is to make the AHEAD state always safe, and to catch the
BEHIND state loudly:

- **Pre-deploy gate** (`deploy-stack.yml`): probes a sentinel object before
  rolling images and FAILS the deploy if the DB is behind the code's required
  schema floor. The running stack is left untouched.
- **In-app guard** (`worker/src/services/schema_guard.py`): on worker startup,
  probes the same sentinel and LOUDLY logs `schema_guard_behind` on a proven
  mismatch (best-effort: it never crashes startup, so dev / health-only boots are
  fine).

Both probe the SAME sentinel: the table the latest required migration creates.
Presence of that table proves the schema is at/above that migration (no ledger
needed). See [Keeping the schema floor in sync](#keeping-the-schema-floor-in-sync).

---

## The core rule: additive-first (expand/contract)

> **Never do a destructive or incompatible schema change in one step on a live
> DB.** Split it into an EXPAND step (additive, backward compatible), a code
> migration, and only later a CONTRACT step (the cleanup).

Concretely, a single migration must be backward compatible with the
**previously deployed** code image. The schema may run ahead of the code; the
code must keep working against it. That is what lets you roll code back without
touching the DB (see [docs/runbooks/rollback.md](./runbooks/rollback.md)).

### Forbidden in a single step (on a live multi-tenant table)

- An **in-place `NOT NULL`** add on an existing column (old code inserts rows
  without it -> writes fail).
- A **type change** of an existing column (old code reads/writes the old type).
- A **rename** of a column or table (old code references the old name).
- A **drop** of a column or table the currently-deployed code still reads.
- A **table rebuild** (drop + recreate) in one migration.

### Always allowed (additive, backward compatible)

- `create table if not exists ...` (a brand new table).
- `add column ... ` that is **nullable** or has a **default** (old code ignores
  it).
- `create index if not exists ...` (use `concurrently` for big tables; note it
  cannot run inside a transaction).
- Adding a new ENUM **value** (`alter type ... add value`), never removing one.
- A new constraint added `not valid` first, then `validate constraint` in a later
  step.

---

## Expand/contract recipes

### Add a required column

Wrong (one step): `add column foo text not null`. Old code inserts without `foo`
and every write fails the instant the migration lands.

Right (three deploys):

1. **Expand**: `add column foo text;` (nullable). Backfill existing rows in the
   same or a follow-up migration. Ship.
2. **Migrate code**: deploy code that writes `foo` on every insert/update and
   tolerates a null `foo` it reads from pre-backfill rows.
3. **Contract**: once all rows have `foo` and all running code writes it,
   `alter table ... alter column foo set not null;` (validate-then-enforce for a
   check constraint). Ship.

### Rename a column (`old_name` -> `new_name`)

1. **Expand**: `add column new_name <type>;`. Backfill `new_name := old_name`.
2. **Migrate code**: deploy code that writes BOTH columns and reads `new_name`
   (falling back to `old_name` if needed).
3. **Migrate code again**: deploy code that uses only `new_name`.
4. **Contract**: `drop column old_name;` once no running code references it.

### Change a column type

Treat exactly like a rename: add a new column of the new type, dual-write,
cut reads over, drop the old. Never `alter column ... type ...` in place on a
live table.

### Drop a column or table

1. **Migrate code**: deploy code that no longer reads OR writes it.
2. **Contract**: `drop column` / `drop table` only AFTER every running image is
   on code that ignores it. (Remember the previous image must still be a safe
   rollback target until you are sure you will not roll back to it.)

---

## Writing a migration file

- Name it `NNNN_short_description.sql` with the next zero-padded number after the
  current highest in `db/migrations`. The chain is applied in lexical order.
- Make every statement **idempotent / re-runnable**: `create table if not
  exists`, `create index if not exists`, guard `alter type ... add value` with a
  catalog check or `if not exists` where supported. `supabase db push` is
  idempotent and may re-run the chain.
- Match the existing conventions: RLS deny-all on worker-owned tables, the
  `set_updated_at()` trigger on `updated_at` tables, FK `on delete` chosen
  deliberately (see neighbouring migrations).
- Keep it Supabase-targeted. The CI migration tiers prepend `db/ci-bootstrap.sql`
  to provide the `anon` / `authenticated` / `service_role` roles, the
  `supabase_realtime` publication, and the `storage` schema that a bare Postgres
  lacks. Do not assume those exist in the migration itself beyond what the
  bootstrap provides.

### CI checks your migration

- `migration-apply` (in `ci.yml`) applies `0001..N` to a clean Postgres and fails
  on the first error. This is the authoritative SQL-correctness gate.
- `worker-integration` applies the same chain and runs `pytest -m integration`,
  which asserts real FK / CHECK / trigger / enum behaviour (the in-memory test
  double ignores constraints, which is how a FK break once shipped undetected).
- `sql-lint` (sqlfluff) is advisory.

---

## Keeping the schema floor in sync

When a new migration becomes a **hard code dependency** (the code will break
against a DB that lacks it), bump the floor so both guards require it:

1. In `worker/src/services/schema_guard.py`, set `REQUIRED_MIGRATION` to the new
   migration's file name (without `.sql`) and `SENTINEL_TABLE` to a table that
   migration **creates** (the presence test). The unit test
   `test_schema_guard.py` asserts the named migration file exists and creates
   that table, so a typo fails CI.
2. In `.github/workflows/deploy-stack.yml`, update `REQUIRED_MIGRATION` and
   `REQUIRED_SENTINEL_TABLE` in the pre-deploy migration gate to the SAME values.

Most additive migrations do NOT need a floor bump: only bump when the code
genuinely cannot run without the new object. If the new migration does not create
a table (e.g. it only adds a column), pick the most recent migration that does
create a table as the sentinel, or extend the guard to probe a column with
`information_schema.columns` (keep the deploy gate's psql probe in lockstep).

---

## The deploy + push order (the happy path)

For an additive change, the order is forgiving because the schema can lead:

1. Land the migration file on `main` (PR, CI green).
2. `supabase db push` the new migration to the live project.
3. Run `deploy-stack` to roll the new code. The pre-deploy gate confirms the
   schema floor is met (the push in step 2 satisfies it) and proceeds.

If you deploy before pushing (step 3 before step 2) and the new code requires the
migration, the pre-deploy gate **blocks the deploy** and the running stack is
untouched. Run the push, then re-run the deploy. This is the intended safety net,
not an error to route around.
