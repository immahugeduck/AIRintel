-- Per-account encounter log and lifetime per-aircraft counters.
--
-- Every signed-in user gets their own log: one row per encounter (an aircraft entering that user's watch radius,
-- `netted-visits-v1` semantics) and one tally row per (user, aircraft) holding the lifetime encounter count.
-- Rows are written by the server only (live view recordings and the always-on sweep) and read through the
-- history API (JWT + `history` grant). Like every airintel_private table: RLS on, no policies, no browser access
-- (db/repeatable/R__lock_down_browser_roles.sql also revokes it on every migrate run).
-- Additive and idempotent: creates new objects only; nothing existing is altered or dropped.

create table if not exists airintel_private.encounters (
  id uuid primary key default gen_random_uuid(),
  -- Soft reference to neon_auth."user".id (same convention as access_grants / net_watch_areas).
  user_id uuid not null,
  icao24 text not null check (icao24 ~ '^[0-9a-f]{6}$'),
  callsign text check (callsign is null or char_length(callsign) <= 16),
  registration text check (registration is null or char_length(registration) <= 16),
  entered_at timestamptz not null,
  last_seen_in_radius_at timestamptz not null,
  closest_approach_nm double precision not null check (closest_approach_nm >= 0),
  observation_count integer not null default 1 check (observation_count >= 1),
  -- The watch area this encounter was measured against, and which writer detected it.
  center_latitude double precision not null check (center_latitude between -90 and 90),
  center_longitude double precision not null check (center_longitude between -180 and 180),
  radius_nm double precision not null check (radius_nm > 0),
  source text not null check (source in ('live', 'sweep')),
  algorithm_version text not null default 'netted-visits-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_seen_in_radius_at >= entered_at)
);

alter table airintel_private.encounters enable row level security;
revoke all on airintel_private.encounters from public;

create index if not exists encounters_user_entered_idx on airintel_private.encounters (user_id, entered_at desc);
create index if not exists encounters_user_aircraft_entered_idx on airintel_private.encounters (user_id, icao24, entered_at desc);

create table if not exists airintel_private.user_aircraft_tallies (
  user_id uuid not null,
  icao24 text not null check (icao24 ~ '^[0-9a-f]{6}$'),
  -- Lifetime number of encounters; only ever incremented by the server.
  encounter_count integer not null default 0 check (encounter_count >= 0),
  first_encountered_at timestamptz,
  last_encountered_at timestamptz,
  last_seen_in_radius_at timestamptz,
  closest_approach_nm double precision check (closest_approach_nm is null or closest_approach_nm >= 0),
  last_callsign text check (last_callsign is null or char_length(last_callsign) <= 16),
  last_registration text check (last_registration is null or char_length(last_registration) <= 16),
  -- Detection state: the newest observation already processed for this user and whether it was inside the radius.
  -- Observations at or before last_observed_at are ignored, so replays and overlapping writers never double count.
  last_observed_at timestamptz,
  last_inside boolean not null default false,
  open_encounter_id uuid references airintel_private.encounters(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, icao24)
);

alter table airintel_private.user_aircraft_tallies enable row level security;
revoke all on airintel_private.user_aircraft_tallies from public;

create index if not exists user_aircraft_tallies_user_last_idx on airintel_private.user_aircraft_tallies (user_id, last_seen_in_radius_at desc nulls last);
