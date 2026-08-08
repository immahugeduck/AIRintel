create table if not exists airintel_private.faa_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_url text not null check (source_url like 'https://www.faa.gov/%'),
  source_filename text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_date date not null,
  importer_version text not null,
  schema_version text not null,
  status text not null check (status in ('staging', 'validated', 'published', 'rejected', 'failed')),
  rows_received integer not null default 0 check (rows_received >= 0),
  rows_accepted integer not null default 0 check (rows_accepted >= 0),
  rows_rejected integer not null default 0 check (rows_rejected >= 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_code text,
  unique (source_sha256),
  check (finished_at is null or finished_at >= started_at)
);

create table if not exists airintel_private.faa_registry_raw (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references airintel_private.faa_import_runs(id) on delete cascade,
  source_file text not null,
  source_row_number integer not null check (source_row_number > 0),
  source_row_hash text not null check (source_row_hash ~ '^[0-9a-f]{64}$'),
  raw_row jsonb not null,
  validation_status text not null check (validation_status in ('accepted', 'quarantined')),
  error_codes text[] not null default '{}',
  retention_until timestamptz not null default (now() + interval '30 days'),
  unique (import_run_id, source_file, source_row_number)
);

create index if not exists faa_registry_raw_import_idx on airintel_private.faa_registry_raw (import_run_id);

create or replace function public.purge_expired_faa_registry_raw()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  delete from airintel_private.faa_registry_raw where retention_until <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.purge_expired_faa_registry_raw() from public, anon, authenticated;
grant execute on function public.purge_expired_faa_registry_raw() to service_role;

create table if not exists public.aircraft_registry_records (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references airintel_private.faa_import_runs(id),
  snapshot_date date not null,
  registry_unique_id text not null,
  n_number text not null check (n_number ~ '^N([1-9][0-9]{0,4}|[1-9][0-9]{0,3}[A-HJ-NP-Z]|[1-9][0-9]{0,2}[A-HJ-NP-Z]{2})$'),
  mode_s_hex text check (mode_s_hex is null or mode_s_hex ~ '^[0-9a-f]{6}$'),
  serial_number text,
  manufacturer_code text,
  manufacturer_name text,
  model_code text,
  model_name text,
  aircraft_type_code text,
  registration_status text,
  registrant_display_name text,
  registrant_kind text check (registrant_kind is null or registrant_kind in ('individual', 'business', 'government', 'nonprofit', 'trust', 'other', 'unknown')),
  owner_visibility text not null default 'unavailable' check (owner_visibility in ('displayable_entity', 'individual_redacted', 'withheld', 'unavailable')),
  source_row_hash text not null check (source_row_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (import_run_id, registry_unique_id)
);

create index if not exists registry_records_mode_s_snapshot_idx on public.aircraft_registry_records (mode_s_hex, snapshot_date desc) where mode_s_hex is not null;
create index if not exists registry_records_n_number_idx on public.aircraft_registry_records (n_number text_pattern_ops, snapshot_date desc);
create index if not exists registry_records_import_idx on public.aircraft_registry_records (import_run_id);

create table if not exists public.aircraft_registry_matches (
  id uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  registry_record_id uuid not null references public.aircraft_registry_records(id) on delete cascade,
  match_status text not null check (match_status in ('confirmed', 'corroborated', 'conflict', 'unmatched', 'withheld_or_unavailable')),
  match_method text not null check (match_method in ('mode_s_hex_exact', 'registration_string_exact', 'manual')),
  matcher_version text not null,
  limitations text[] not null default '{}',
  manual_review_status text not null default 'pending' check (manual_review_status in ('pending', 'verified', 'rejected')),
  matched_at timestamptz not null default now(),
  unique (aircraft_id, registry_record_id, match_method)
);

create index if not exists registry_matches_aircraft_idx on public.aircraft_registry_matches (aircraft_id, matched_at desc);
create index if not exists registry_matches_record_idx on public.aircraft_registry_matches (registry_record_id);

create table if not exists public.aircraft_operator_associations (
  id uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft(id) on delete cascade,
  operator_name text not null,
  association_status text not null check (association_status in ('documented', 'probable', 'conflict', 'rejected')),
  source_url text not null,
  source_effective_at timestamptz,
  retrieved_at timestamptz not null,
  valid_from date,
  valid_to date,
  review_status text not null default 'pending' check (review_status in ('pending', 'verified', 'rejected')),
  limitations text[] not null default '{}',
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create index if not exists operator_associations_aircraft_idx on public.aircraft_operator_associations (aircraft_id, retrieved_at desc);

alter table public.aircraft_registry_records enable row level security;
alter table public.aircraft_registry_matches enable row level security;
alter table public.aircraft_operator_associations enable row level security;
alter table airintel_private.faa_import_runs enable row level security;
alter table airintel_private.faa_registry_raw enable row level security;

revoke all on public.aircraft_registry_records, public.aircraft_registry_matches, public.aircraft_operator_associations from anon, authenticated;
revoke all on airintel_private.faa_import_runs, airintel_private.faa_registry_raw from public, anon, authenticated;

-- Edge Functions use the service role after independently authenticating and
-- authorizing the caller. Browser roles never receive direct table access.
grant select on public.aircraft_registry_records, public.aircraft_registry_matches, public.aircraft_operator_associations to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema airintel_private revoke all on tables from public, anon, authenticated;
alter default privileges in schema airintel_private revoke all on sequences from public, anon, authenticated;
