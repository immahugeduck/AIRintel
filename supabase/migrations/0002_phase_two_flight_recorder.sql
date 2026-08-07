create table if not exists public.flights (
  id uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null default 'open' check (status in ('open', 'complete', 'review_required')),
  reconstruction_version text not null,
  reconstruction_confidence double precision check (reconstruction_confidence is null or reconstruction_confidence between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);

alter table public.aircraft_positions
  add column if not exists dedupe_key text,
  add column if not exists normalization_version text,
  add column if not exists geometric_altitude_ft double precision,
  add column if not exists barometric_altitude_ft double precision,
  add column if not exists observation_registration text;

create unique index if not exists aircraft_positions_dedupe_key_idx
  on public.aircraft_positions (dedupe_key)
  where dedupe_key is not null;

create index if not exists raw_observations_source_received_idx
  on airintel_private.raw_observations (source_id, received_at desc);

create index if not exists aircraft_positions_callsign_time_idx
  on public.aircraft_positions (upper(callsign) text_pattern_ops, observed_at desc)
  where callsign is not null;

create index if not exists aircraft_icao24_pattern_idx
  on public.aircraft (icao24 text_pattern_ops);

create index if not exists aircraft_registration_pattern_idx
  on public.aircraft (upper(registration) text_pattern_ops)
  where registration is not null;

create table if not exists public.aircraft_aliases (
  id bigint generated always as identity primary key,
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  source_id uuid not null references public.data_sources(id),
  alias_type text not null check (alias_type in ('registration')),
  alias_value text not null,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (aircraft_id, source_id, alias_type, alias_value),
  check (last_observed_at >= first_observed_at)
);

create index if not exists aircraft_aliases_aircraft_idx on public.aircraft_aliases (aircraft_id);
create index if not exists aircraft_aliases_value_idx on public.aircraft_aliases (upper(alias_value) text_pattern_ops);
alter table public.aircraft_aliases enable row level security;
revoke all on public.aircraft_aliases from anon, authenticated;

create index if not exists flights_aircraft_started_idx on public.flights (aircraft_id, started_at desc);

create table if not exists public.flight_positions (
  flight_id uuid not null references public.flights(id) on delete cascade,
  position_id bigint not null references public.aircraft_positions(id) on delete cascade,
  sequence_number integer not null check (sequence_number >= 0),
  primary key (flight_id, position_id),
  unique (flight_id, sequence_number)
);

create index if not exists flight_positions_position_idx on public.flight_positions (position_id);

create table if not exists public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'running' check (status in ('running', 'completed', 'partial', 'failed')),
  observations_received integer not null default 0 check (observations_received >= 0),
  observations_inserted integer not null default 0 check (observations_inserted >= 0),
  observations_rejected integer not null default 0 check (observations_rejected >= 0),
  error_code text,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);

create index if not exists ingestion_runs_source_started_idx on public.ingestion_runs (source_id, started_at desc);

alter table public.flights enable row level security;
alter table public.flight_positions enable row level security;
alter table public.ingestion_runs enable row level security;

revoke all on public.flights, public.flight_positions, public.ingestion_runs from anon, authenticated;

create or replace function public.record_aircraft_observation(input jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_uuid uuid;
  aircraft_uuid uuid;
  position_bigint bigint;
begin
  insert into public.data_sources (key, display_name, provider_schema_version)
  values (input->>'provider', input->>'provider', input->>'providerSchemaVersion')
  on conflict (key) do update set provider_schema_version = excluded.provider_schema_version
  returning id into source_uuid;

  insert into public.aircraft (icao24, registration, first_seen_at, last_seen_at)
  values (input->>'icao24', nullif(input->>'registration', ''), (input->>'observedAt')::timestamptz, (input->>'observedAt')::timestamptz)
  on conflict (icao24) do update set
    registration = case
      when excluded.last_seen_at >= public.aircraft.last_seen_at
        then coalesce(excluded.registration, public.aircraft.registration)
      else public.aircraft.registration
    end,
    first_seen_at = least(public.aircraft.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(public.aircraft.last_seen_at, excluded.last_seen_at),
    updated_at = now()
  returning id into aircraft_uuid;

  if nullif(input->>'registration', '') is not null then
    insert into public.aircraft_aliases (aircraft_id, source_id, alias_type, alias_value, first_observed_at, last_observed_at)
    values (aircraft_uuid, source_uuid, 'registration', input->>'registration', (input->>'observedAt')::timestamptz, (input->>'observedAt')::timestamptz)
    on conflict (aircraft_id, source_id, alias_type, alias_value) do update set
      first_observed_at = least(public.aircraft_aliases.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(public.aircraft_aliases.last_observed_at, excluded.last_observed_at);
  end if;

  if nullif(input->>'providerRecordId', '') is not null and exists (
    select 1 from public.aircraft_positions
    where source_id = source_uuid and provider_record_id = input->>'providerRecordId'
  ) then
    return false;
  end if;

  insert into public.aircraft_positions (
    aircraft_id, source_id, provider_record_id, dedupe_key, normalization_version,
    callsign, observation_registration, position, latitude, longitude, altitude_ft, altitude_source,
    geometric_altitude_ft, barometric_altitude_ft, ground_speed_kt, track_deg,
    vertical_rate_fpm, on_ground, observed_at, received_at
  ) values (
    aircraft_uuid, source_uuid, nullif(input->>'providerRecordId', ''), input->>'dedupeKey', input->>'normalizationVersion',
    nullif(input->>'callsign', ''), nullif(input->>'registration', ''),
    st_setsrid(st_makepoint((input->>'longitude')::double precision, (input->>'latitude')::double precision), 4326)::geography,
    (input->>'latitude')::double precision, (input->>'longitude')::double precision,
    (input->>'altitudeFt')::double precision, nullif(input->>'altitudeSource', ''),
    (input->>'geometricAltitudeFt')::double precision, (input->>'barometricAltitudeFt')::double precision,
    (input->>'groundSpeedKt')::double precision, (input->>'trackDeg')::double precision,
    (input->>'verticalRateFpm')::double precision, (input->>'onGround')::boolean,
    (input->>'observedAt')::timestamptz, (input->>'receivedAt')::timestamptz
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into position_bigint;

  if position_bigint is null then return false; end if;

  insert into airintel_private.raw_observations (
    position_id, source_id, provider_schema_version, payload, received_at
  ) values (
    position_bigint, source_uuid, input->>'providerSchemaVersion', input->'raw', (input->>'receivedAt')::timestamptz
  );
  return true;
end;
$$;

revoke all on function public.record_aircraft_observation(jsonb) from public, anon, authenticated;
grant execute on function public.record_aircraft_observation(jsonb) to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Browser access remains unavailable. Server-side Edge Functions use the secret/service
-- role and return narrowly validated DTOs after provider redistribution terms are approved.
