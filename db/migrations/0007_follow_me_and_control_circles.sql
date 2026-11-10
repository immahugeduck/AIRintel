-- Follow-me mode and fixed control circles.
--
-- 1. Follow me: the watch area can track the phone. When the browser moves the center (> 1 mi), it saves the new
--    center through the existing watch-area API. Each encounter now records whether its center was a follow-me fix
--    or a fixed (manually set / tapped once) location, so pattern pass 3 ("same airframe at your different
--    locations") can tell real moves from a stale center.
-- 2. Control circles: up to two stationary circles per account that the user does NOT visit. The sweep counts the
--    distinct aircraft seen inside each one per UTC day. Comparing an aircraft's days at the controls with its days
--    in the user's own circle separates "common local traffic" from "shows up where I am".
--
-- Like every airintel_private table: RLS on, no policies, no browser access (the repeatable lockdown also revokes it).
-- Additive and idempotent: new columns are nullable/defaulted, new tables use if-not-exists.

alter table airintel_private.net_watch_areas
  add column if not exists follow_me boolean not null default false;

alter table airintel_private.encounters
  add column if not exists center_mode text check (center_mode is null or center_mode in ('follow', 'fixed'));

create table if not exists airintel_private.net_control_areas (
  id uuid primary key default gen_random_uuid(),
  -- Soft reference to neon_auth."user".id (same convention as net_watch_areas).
  user_id uuid not null,
  slot smallint not null check (slot in (1, 2)),
  label text not null default '' check (char_length(label) <= 40),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_mi double precision not null default 7 check (radius_mi >= 1 and radius_mi <= 50),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_polled_at timestamptz,
  last_poll_status text check (last_poll_status is null or char_length(last_poll_status) <= 64),
  last_success_at timestamptz,
  unique (user_id, slot)
);

alter table airintel_private.net_control_areas enable row level security;
revoke all on airintel_private.net_control_areas from public;

create index if not exists net_control_areas_enabled_polled_idx
  on airintel_private.net_control_areas (last_polled_at nulls first)
  where enabled;

-- One row per (control circle, aircraft, UTC day): enough to compare "days seen at the control" without storing
-- another copy of positions (those already live in public.aircraft_positions).
create table if not exists airintel_private.control_sightings (
  control_area_id uuid not null references airintel_private.net_control_areas(id) on delete cascade,
  icao24 text not null check (icao24 ~ '^[0-9a-f]{6}$'),
  day date not null,
  observation_count integer not null default 0 check (observation_count >= 0),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  closest_approach_nm double precision not null check (closest_approach_nm >= 0),
  primary key (control_area_id, icao24, day),
  check (last_seen_at >= first_seen_at)
);

alter table airintel_private.control_sightings enable row level security;
revoke all on airintel_private.control_sightings from public;

create index if not exists control_sightings_icao_day_idx on airintel_private.control_sightings (icao24, day desc);
