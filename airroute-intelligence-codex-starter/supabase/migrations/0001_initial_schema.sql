-- AirRoute Intelligence
-- Initial PostgreSQL/PostGIS schema
-- Review in a non-production Supabase project before applying.

create extension if not exists postgis;
create extension if not exists pgcrypto;

create table if not exists public.data_sources (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  display_name text not null,
  source_type text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.aircraft (
  id uuid primary key default gen_random_uuid(),
  icao24 text not null unique,
  registration text,
  manufacturer text,
  model text,
  aircraft_type_code text,
  category text,
  registered_owner text,
  owner_type text,
  country text,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aircraft_icao24_format check (icao24 ~ '^[0-9a-fA-F]{6}$')
);

create index if not exists aircraft_registration_idx
  on public.aircraft (upper(registration));

create table if not exists public.aircraft_aliases (
  id uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  alias_type text not null,
  alias_value text not null,
  valid_from timestamptz,
  valid_to timestamptz,
  source_id uuid references public.data_sources(id),
  created_at timestamptz not null default now(),
  unique (aircraft_id, alias_type, alias_value, valid_from)
);

create table if not exists public.aircraft_positions (
  id bigint generated always as identity primary key,
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  source_id uuid not null references public.data_sources(id),
  provider_record_id text,
  callsign text,
  position geography(point, 4326) not null,
  latitude double precision not null,
  longitude double precision not null,
  altitude_ft double precision,
  altitude_source text,
  geometric_altitude_ft double precision,
  barometric_altitude_ft double precision,
  ground_speed_kt double precision,
  track_deg double precision,
  vertical_rate_fpm double precision,
  squawk text,
  on_ground boolean,
  emergency_status text,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint aircraft_position_lat check (latitude between -90 and 90),
  constraint aircraft_position_lon check (longitude between -180 and 180),
  constraint aircraft_position_track check (track_deg is null or (track_deg >= 0 and track_deg < 360))
);

create index if not exists aircraft_positions_aircraft_time_idx
  on public.aircraft_positions (aircraft_id, observed_at desc);

create index if not exists aircraft_positions_time_idx
  on public.aircraft_positions (observed_at desc);

create index if not exists aircraft_positions_geo_idx
  on public.aircraft_positions using gist (position);

create unique index if not exists aircraft_positions_dedupe_idx
  on public.aircraft_positions (
    aircraft_id,
    source_id,
    observed_at,
    coalesce(provider_record_id, '')
  );

create table if not exists public.flights (
  id uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  route geometry(linestring, 4326),
  origin_airport_code text,
  destination_airport_code text,
  distance_nm double precision,
  duration_seconds integer,
  min_altitude_ft double precision,
  max_altitude_ft double precision,
  reconstruction_confidence double precision,
  reconstruction_version text not null default 'v1',
  status text not null default 'open',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flights_time_order check (ended_at is null or ended_at >= started_at),
  constraint flights_confidence check (
    reconstruction_confidence is null or
    reconstruction_confidence between 0 and 1
  )
);

create index if not exists flights_aircraft_time_idx
  on public.flights (aircraft_id, started_at desc);

create index if not exists flights_route_idx
  on public.flights using gist (route);

create table if not exists public.flight_positions (
  flight_id uuid not null references public.flights(id) on delete cascade,
  position_id bigint not null references public.aircraft_positions(id) on delete cascade,
  sequence_number integer not null,
  primary key (flight_id, position_id),
  unique (flight_id, sequence_number)
);

create table if not exists public.watch_zones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  zone_type text not null,
  geometry geography(geometry, 4326) not null,
  altitude_floor_ft double precision,
  altitude_ceiling_ft double precision,
  is_active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists watch_zones_geo_idx
  on public.watch_zones using gist (geometry);

create table if not exists public.zone_events (
  id uuid primary key default gen_random_uuid(),
  watch_zone_id uuid not null references public.watch_zones(id) on delete cascade,
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  flight_id uuid references public.flights(id) on delete set null,
  entered_at timestamptz not null,
  exited_at timestamptz,
  minimum_distance_m double precision,
  minimum_altitude_ft double precision,
  dwell_seconds integer,
  confidence double precision,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.orbit_events (
  id uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  flight_id uuid references public.flights(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  center geometry(point, 4326) not null,
  mean_radius_m double precision,
  radius_stddev_m double precision,
  estimated_revolutions double precision,
  confidence double precision not null,
  algorithm_version text not null,
  evidence jsonb not null default '[]'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint orbit_event_time_order check (ended_at >= started_at),
  constraint orbit_event_confidence check (confidence between 0 and 1)
);

create index if not exists orbit_events_center_idx
  on public.orbit_events using gist (center);

create table if not exists public.behavior_findings (
  id uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  flight_id uuid references public.flights(id) on delete cascade,
  finding_type text not null,
  started_at timestamptz,
  ended_at timestamptz,
  confidence double precision not null,
  observed jsonb not null default '[]'::jsonb,
  calculated jsonb not null default '[]'::jsonb,
  supported_inference jsonb not null default '[]'::jsonb,
  unknowns jsonb not null default '[]'::jsonb,
  algorithm_version text not null,
  created_at timestamptz not null default now(),
  constraint behavior_finding_confidence check (confidence between 0 and 1)
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  normalized_name text not null,
  organization_type text,
  ein text,
  irs_subsection text,
  ntee_code text,
  tax_exempt_status text,
  city text,
  state text,
  country text,
  source_id uuid references public.data_sources(id),
  source_updated_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists organizations_normalized_name_idx
  on public.organizations (normalized_name);

create table if not exists public.aircraft_ownership (
  id uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  registered_owner_name text not null,
  normalized_owner_name text not null,
  organization_id uuid references public.organizations(id) on delete set null,
  relationship_type text not null default 'registered_owner',
  valid_from date,
  valid_to date,
  match_method text,
  match_confidence double precision,
  manually_verified boolean not null default false,
  source_id uuid references public.data_sources(id),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ownership_match_confidence check (
    match_confidence is null or match_confidence between 0 and 1
  )
);

create table if not exists public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'running',
  requested_area jsonb,
  observations_received integer not null default 0,
  observations_inserted integer not null default 0,
  observations_rejected integer not null default 0,
  provider_quota jsonb,
  error_summary text,
  metadata jsonb not null default '{}'::jsonb
);

-- RLS is intentionally not fully configured in this initial migration.
-- Before production:
-- 1. Enable RLS on user-owned tables.
-- 2. Restrict watch_zones to auth.uid() = user_id.
-- 3. Keep ingestion writes server-side.
-- 4. Review which aircraft data may be read publicly.
