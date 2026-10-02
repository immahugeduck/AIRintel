-- Replaces the Supabase `app_metadata.airintel_access` / `airintel_profile_access`
-- flags. Neon Auth (Managed Better Auth) does not allow custom JWT claims, so
-- per-user entitlements live in the database and are checked by the API after
-- the JWT has been verified.
--
-- user_id is the Neon Auth user id (neon_auth."user".id, a uuid). It is a soft
-- reference on purpose: the neon_auth schema only exists once Neon Auth is
-- enabled on the branch, and this migration must also run on a plain Postgres.
create table if not exists airintel_private.access_grants (
  user_id uuid primary key,
  scopes text[] not null default '{}'
    check (scopes <@ array['history', 'profile']::text[]),
  note text,
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table airintel_private.access_grants enable row level security;
revoke all on airintel_private.access_grants from public;
