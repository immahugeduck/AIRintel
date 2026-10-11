-- Always-on net: server-side watch areas, sweep lease/state, query indexes and a retention helper.
--
-- Nothing here is readable by browser roles: tables live in airintel_private, have RLS enabled with NO policies,
-- and all access goes through the server API (JWT + access_grants) or the secret-protected sweep endpoint.
-- db/repeatable/R__lock_down_browser_roles.sql revokes everything in airintel_private from anon/anonymous/authenticated
-- on every migrate run, so no lockdown change is required for these objects.
-- Idempotent: safe to re-run.

-- One watch area per user (soft reference to neon_auth."user".id, like access_grants).
create table if not exists airintel_private.net_watch_areas (
  user_id uuid primary key,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_mi double precision not null default 7 check (radius_mi >= 1 and radius_mi <= 50),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Last sweep attempt (any outcome) and its machine-readable status (ok, provider_error, record_error, partial, ...).
  last_polled_at timestamptz,
  last_poll_status text check (last_poll_status is null or char_length(last_poll_status) <= 64),
  -- Last fully successful sweep; drives the "net is stale" warning.
  last_success_at timestamptz
);

alter table airintel_private.net_watch_areas enable row level security;
revoke all on airintel_private.net_watch_areas from public;

create index if not exists net_watch_areas_enabled_polled_idx
  on airintel_private.net_watch_areas (last_polled_at nulls first)
  where enabled;

-- Singleton row: overlap guard (lease) for the sweep, plus freshness shown by /api/health and the netted API.
create table if not exists airintel_private.net_sweep_state (
  id boolean primary key default true check (id),
  locked_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text check (last_status is null or char_length(last_status) <= 64),
  last_areas_polled integer,
  last_observations_inserted integer,
  last_purge_at timestamptz,
  last_purge_deleted integer
);

alter table airintel_private.net_sweep_state enable row level security;
revoke all on airintel_private.net_sweep_state from public;

insert into airintel_private.net_sweep_state (id) values (true) on conflict (id) do nothing;

-- Bounded time-window scans (netted log, retention purge). The existing BRIN on observed_at is too coarse for
-- selective windows and (aircraft_id, observed_at desc) cannot serve cross-aircraft time scans.
create index if not exists aircraft_positions_observed_at_idx
  on public.aircraft_positions (observed_at desc);

-- Retention helper. NOTHING calls this automatically unless the operator sets NET_RETENTION_DAYS (sweep endpoint)
-- or runs `npm run db:retention -- --apply`. It deletes raw observation history (positions + their raw payloads,
-- and flight_positions that point at them) older than the cutoff, in bounded batches. It never touches public.aircraft.
create or replace function airintel_private.purge_aircraft_observations(retention_days integer, batch_size integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if retention_days is null or retention_days < 1 then
    raise exception 'retention_days must be >= 1';
  end if;
  if batch_size is null or batch_size < 1 or batch_size > 100000 then
    raise exception 'batch_size must be between 1 and 100000';
  end if;
  with doomed as (
    select id from public.aircraft_positions
     where observed_at < now() - make_interval(days => retention_days)
     order by observed_at
     limit batch_size
  ), removed as (
    delete from public.aircraft_positions p using doomed d where p.id = d.id returning 1
  )
  select count(*)::integer into deleted_count from removed;
  return deleted_count;
end;
$$;

revoke all on function airintel_private.purge_aircraft_observations(integer, integer) from public;
