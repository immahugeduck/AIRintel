-- Encounter timing bounds and the center used for the closest point.
--
-- An encounter's recorded duration (last_seen_in_radius_at - entered_at) only spans the observations seen INSIDE the
-- radius, so with ~1-minute sampling it always undercounts the real time inside. These columns keep the observations
-- just OUTSIDE the radius around it (Observed timestamps), when they fall within the 10-minute reception gap:
--   last_outside_before_entry_at  the aircraft crossed into the radius between this and entered_at
--   first_outside_after_exit_at   it crossed out between last_seen_in_radius_at and this
-- so time inside lies between (last_seen_in_radius_at - entered_at) and (first_outside_after_exit_at -
-- last_outside_before_entry_at). Null = no outside observation close enough in time (Unknown).
--
-- closest_center_latitude/longitude: the watch center the closest distance was measured from at that moment. With
-- follow me the center moves during an encounter, so center_latitude/longitude (the center at entry) is not enough
-- to place the closest point relative to the user.
--
-- Like every airintel_private table: RLS on, no policies, no browser access (the repeatable lockdown also revokes it).
-- Additive and idempotent: nullable new columns; the backfills only fill rows that are still null.

alter table airintel_private.encounters
  add column if not exists last_outside_before_entry_at timestamptz,
  add column if not exists first_outside_after_exit_at timestamptz,
  add column if not exists closest_center_latitude double precision check (closest_center_latitude is null or closest_center_latitude between -90 and 90),
  add column if not exists closest_center_longitude double precision check (closest_center_longitude is null or closest_center_longitude between -180 and 180);

-- Snapshots written so far (0008 backfill) were all measured from the encounter's stored center.
update airintel_private.encounters
   set closest_center_latitude = center_latitude, closest_center_longitude = center_longitude
 where closest_at is not null and closest_center_latitude is null;

-- Entry bound: the aircraft's last retained position within 10 minutes before entry, if it was outside this
-- encounter's radius as measured from this encounter's center.
with prior as (
  select e.id, p.observed_at
    from airintel_private.encounters e
    join public.aircraft a on a.icao24 = e.icao24
    cross join lateral (
      select p.observed_at, p.latitude, p.longitude
        from public.aircraft_positions p
       where p.aircraft_id = a.id
         and p.observed_at < e.entered_at
         and p.observed_at >= e.entered_at - interval '10 minutes'
       order by p.observed_at desc
       limit 1
    ) p
   where e.last_outside_before_entry_at is null
     and public.st_distance(
           public.st_setsrid(public.st_makepoint(p.longitude, p.latitude), 4326)::public.geography,
           public.st_setsrid(public.st_makepoint(e.center_longitude, e.center_latitude), 4326)::public.geography,
           false) / 1852.0 > e.radius_nm
)
update airintel_private.encounters e set last_outside_before_entry_at = prior.observed_at from prior where e.id = prior.id;

-- Exit bound: the first retained position within 10 minutes after the last one inside, if it was outside. Encounters
-- that are still open (the aircraft has not been seen leaving) are skipped.
with after_exit as (
  select e.id, p.observed_at
    from airintel_private.encounters e
    join public.aircraft a on a.icao24 = e.icao24
    cross join lateral (
      select p.observed_at, p.latitude, p.longitude
        from public.aircraft_positions p
       where p.aircraft_id = a.id
         and p.observed_at > e.last_seen_in_radius_at
         and p.observed_at <= e.last_seen_in_radius_at + interval '10 minutes'
       order by p.observed_at
       limit 1
    ) p
   where e.first_outside_after_exit_at is null
     and not exists (select 1 from airintel_private.user_aircraft_tallies t where t.open_encounter_id = e.id)
     and public.st_distance(
           public.st_setsrid(public.st_makepoint(p.longitude, p.latitude), 4326)::public.geography,
           public.st_setsrid(public.st_makepoint(e.center_longitude, e.center_latitude), 4326)::public.geography,
           false) / 1852.0 > e.radius_nm
)
update airintel_private.encounters e set first_outside_after_exit_at = after_exit.observed_at from after_exit where e.id = after_exit.id;
