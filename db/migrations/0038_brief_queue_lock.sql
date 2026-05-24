-- 0038_brief_queue_lock.sql
-- Durable, cross-process per-brief serialization for the worker queue (E5.3).
--
-- The worker used an in-memory asyncio.Lock per brief_id (worker/src/services/
-- queue.py). That lock cannot survive a process restart and cannot coordinate
-- across more than one worker process: two processes would each see an empty
-- in-memory map and run the same brief's Kie.ai renders in parallel, violating
-- the image-generation SOP (one PNG finished before the next) and the Kie.ai
-- rate limits.
--
-- This migration moves the mutex into Postgres as a DURABLE LEASE ROW rather
-- than a session advisory lock. A lease row is the correct primitive here for
-- two reasons:
--   1. The worker holds the lock across an `async with get_queue().acquire()`
--      block that spans many separate PostgREST round-trips. PostgREST pools
--      connections, so a SESSION-level advisory lock taken on one backend
--      could not be reliably released from another backend, and a TRANSACTION-
--      level lock would drop the instant the first RPC committed. A row-backed
--      lease is owned by an opaque token, not a connection, so it is immune to
--      pooling.
--   2. A lease has a visible owner + expiry, so a crashed holder's lock is
--      reclaimable (stale-takeover) instead of wedging the brief forever.
--
-- The claim/release/heartbeat are exposed as RPCs so the worker's supabase
-- client (REST only) can call them. All functions pin search_path per the
-- 0011/0029 hardening convention.

-- ---------------------------------------------------------------------------
-- Lease table. One row per brief currently locked; the row is deleted on
-- release. `owner_token` is an opaque per-acquire uuid the worker generates so
-- only the holder can release/extend. `expires_at` lets a crashed holder's
-- lock be reclaimed.
-- ---------------------------------------------------------------------------
create table brief_queue_locks (
  brief_id     text primary key,
  owner_token  uuid not null,
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null,
  heartbeats   int not null default 0
);

comment on table brief_queue_locks is
  'Durable per-brief mutex lease for the worker queue (E5.3). Replaces the '
  'in-memory asyncio.Lock so serialization survives restart + spans processes. '
  'Row present = brief locked; deleted on release; reclaimable after expires_at.';

-- Internal coordination table -- never published to realtime, deny-all RLS
-- (service role bypasses). The worker is the only writer.
alter table brief_queue_locks enable row level security;

-- ---------------------------------------------------------------------------
-- Try to claim the lease for a brief. Non-blocking:
--   * returns true  -> caller now owns the lease (token recorded)
--   * returns false -> another live holder owns it; caller should back off+retry
-- Stale leases (expires_at <= now) are taken over atomically. The INSERT ...
-- ON CONFLICT DO UPDATE only writes when the existing row is expired, so a live
-- holder is never displaced; the WHERE on the UPDATE makes the takeover atomic
-- under concurrency (only one claimant's update matches).
-- ---------------------------------------------------------------------------
create or replace function try_claim_brief_lock(
  p_brief_id text,
  p_owner_token uuid,
  p_ttl_seconds double precision
) returns boolean
  language plpgsql
  volatile
  set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_claimed boolean;
begin
  insert into brief_queue_locks (brief_id, owner_token, acquired_at, expires_at)
  values (
    p_brief_id,
    p_owner_token,
    v_now,
    v_now + make_interval(secs => greatest(p_ttl_seconds, 1)::double precision)
  )
  on conflict (brief_id) do update
     set owner_token = excluded.owner_token,
         acquired_at = excluded.acquired_at,
         expires_at  = excluded.expires_at,
         heartbeats  = 0
   where brief_queue_locks.expires_at <= v_now
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

comment on function try_claim_brief_lock(text, uuid, double precision) is
  'Non-blocking per-brief lease claim. True = acquired (fresh or stale-takeover), '
  'false = a live holder exists. Release with release_brief_lock(token).';

-- ---------------------------------------------------------------------------
-- Extend the lease the caller owns (heartbeat) so a long critical section is
-- not reclaimed mid-flight. No-op (returns false) if the caller is not the
-- current owner.
-- ---------------------------------------------------------------------------
create or replace function heartbeat_brief_lock(
  p_brief_id text,
  p_owner_token uuid,
  p_ttl_seconds double precision
) returns boolean
  language plpgsql
  volatile
  set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_ok boolean;
begin
  update brief_queue_locks
     set expires_at = v_now + make_interval(secs => greatest(p_ttl_seconds, 1)::double precision),
         heartbeats = heartbeats + 1
   where brief_id = p_brief_id
     and owner_token = p_owner_token
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

comment on function heartbeat_brief_lock(text, uuid, double precision) is
  'Extend the lease expiry for the brief the caller owns. False if not owner.';

-- ---------------------------------------------------------------------------
-- Release the lease the caller owns. Deleting only when owner_token matches
-- makes a double-release / foreign release a safe no-op (returns false).
-- ---------------------------------------------------------------------------
create or replace function release_brief_lock(
  p_brief_id text,
  p_owner_token uuid
) returns boolean
  language plpgsql
  volatile
  set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
begin
  delete from brief_queue_locks
   where brief_id = p_brief_id
     and owner_token = p_owner_token
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

comment on function release_brief_lock(text, uuid) is
  'Release the per-brief lease owned by p_owner_token. False if the caller did '
  'not hold it (double-release / stale token are safe no-ops).';
