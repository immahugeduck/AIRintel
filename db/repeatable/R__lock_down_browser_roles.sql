-- Re-runs on every `npm run db:migrate` (idempotent).
--
-- AIRIntel never exposes tables to browser roles: every read goes through the
-- server-side API, which verifies the Neon Auth JWT and the user's access grant.
-- If the Neon Data API (or anything else) is enabled later it will use the
-- `authenticated` / `anonymous` roles; this makes sure those roles - and the
-- Supabase-era `anon` role if a dump was ever restored - keep zero access.
do $$
declare
  browser_role text;
begin
  foreach browser_role in array array['anon', 'anonymous', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = browser_role) then
      execute format('revoke all on schema airintel_private from %I', browser_role);
      execute format('revoke all on all tables in schema airintel_private from %I', browser_role);
      execute format('revoke all on all tables in schema public from %I', browser_role);
      execute format('revoke all on all sequences in schema public from %I', browser_role);
      execute format('revoke execute on all functions in schema public from %I', browser_role);
      execute format('alter default privileges in schema public revoke all on tables from %I', browser_role);
      execute format('alter default privileges in schema public revoke all on sequences from %I', browser_role);
      execute format('alter default privileges in schema public revoke execute on functions from %I', browser_role);
    end if;
  end loop;
end
$$;
