create extension if not exists postgis;
create extension if not exists pgcrypto;

create schema if not exists airintel_private;
revoke all on schema airintel_private from public, anon, authenticated;

create table if not exists public.data_sources (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_-]+$'),
  display_name text not null,
  provider_schema_version text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.aircraft (
  id uuid primary key default gen_random_uuid(),
  icao24 text not null unique check (icao24 ~ '^[0-9a-f]{6}$'),
  registration text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_seen_at >= first_seen_at)
);

create index if not exists aircraft_registration_upper_idx on public.aircraft (upper(registration)) where registration is not null;

create table if not exists public.aircraft_positions (
  id bigint generated always as identity primary key,
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  source_id uuid not null references public.data_sources(id),
  provider_record_id text,
  callsign text,
  position geography(point, 4326) not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  altitude_ft double precision,
  altitude_source text check (altitude_source in ('geometric', 'barometric', 'provider')),
  ground_speed_kt double precision check (ground_speed_kt is null or ground_speed_kt >= 0),
  track_deg double precision check (track_deg is null or (track_deg >= 0 and track_deg < 360)),
  vertical_rate_fpm double precision,
  on_ground boolean,
  observed_at timestamptz not null,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  check ((altitude_ft is null and altitude_source is null) or (altitude_ft is not null and altitude_source is not null)),
  check (received_at >= observed_at - interval '1 minute')
);

create index if not exists aircraft_positions_aircraft_time_idx on public.aircraft_positions (aircraft_id, observed_at desc);
create index if not exists aircraft_positions_time_brin_idx on public.aircraft_positions using brin (observed_at);
create index if not exists aircraft_positions_geo_idx on public.aircraft_positions using gist (position);
create unique index if not exists aircraft_positions_provider_record_idx on public.aircraft_positions (source_id, provider_record_id) where provider_record_id is not null;
create unique index if not exists aircraft_positions_source_time_idx on public.aircraft_positions (aircraft_id, source_id, observed_at) where provider_record_id is null;

create table if not exists airintel_private.raw_observations (
  id bigint generated always as identity primary key,
  position_id bigint not null unique references public.aircraft_positions(id) on delete cascade,
  source_id uuid not null references public.data_sources(id),
  provider_schema_version text not null,
  payload jsonb not null,
  received_at timestamptz not null,
  retention_until timestamptz,
  created_at timestamptz not null default now()
);

alter table public.data_sources enable row level security;
alter table public.aircraft enable row level security;
alter table public.aircraft_positions enable row level security;
alter table airintel_private.raw_observations enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema airintel_private from anon, authenticated;

-- Ingestion uses the server-side service role. Public read policies are deliberately
-- absent until provider redistribution terms and deployment access rules are approved.
