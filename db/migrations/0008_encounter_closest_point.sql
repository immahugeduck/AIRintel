-- Closest-point snapshot for every encounter.
--
-- Each encounter already stores its closest distance to the watch center. This adds the flight state at that moment,
-- taken from the single recorded observation nearest the center (Observed values exactly as the provider reported
-- them; never interpolated between samples): when it happened, where the aircraft was, altitude (+ its provenance),
-- ground speed, track, vertical rate and on-ground state. Encounter duration stays derived from entered_at and
-- last_seen_in_radius_at.
--
-- closest_point_basis: 'at_write' = captured by the server when the encounter was written (server/encounters.ts);
-- 'backfill' = derived once by this migration from retained public.aircraft_positions for encounters logged before it.
-- Encounters whose positions were already purged by retention stay null (Unknown).
--
-- Like every airintel_private table: RLS on, no policies, no browser access (the repeatable lockdown also revokes it).
-- Additive and idempotent: nullable new columns; the backfill only fills rows whose snapshot is still null.

alter table airintel_private.encounters
  add column if not exists closest_at timestamptz,
  add column if not exists closest_latitude double precision check (closest_latitude is null or closest_latitude between -90 and 90),
  add column if not exists closest_longitude double precision check (closest_longitude is null or closest_longitude between -180 and 180),
  add column if not exists closest_altitude_ft double precision,
  add column if not exists closest_altitude_source text check (closest_altitude_source is null or closest_altitude_source in ('geometric', 'barometric', 'provider')),
  add column if not exists closest_ground_speed_kt double precision check (closest_ground_speed_kt is null or closest_ground_speed_kt >= 0),
  add column if not exists closest_track_deg double precision check (closest_track_deg is null or (closest_track_deg >= 0 and closest_track_deg < 360)),
  add column if not exists closest_vertical_rate_fpm double precision,
  add column if not exists closest_on_ground boolean,
  add column if not exists closest_point_basis text check (closest_point_basis is null or closest_point_basis in ('at_write', 'backfill'));

-- One-time backfill: for each encounter without a snapshot, the retained position of the same aircraft inside the
-- encounter's own time span that was nearest its own watch center (ties: earliest). Applied only when that position's
-- distance matches the encounter's stored closest distance within 0.05 NM: when the center moved during an encounter
-- (follow me, or live view and sweep measuring from different centers) the stored center cannot identify the sample
-- the stored distance came from, and those encounters stay Unknown rather than get a mismatched snapshot.
with best as (
  select e.id, p.dist_nm, p.observed_at, p.latitude, p.longitude, p.altitude_ft, p.altitude_source, p.ground_speed_kt, p.track_deg, p.vertical_rate_fpm, p.on_ground
    from airintel_private.encounters e
    join public.aircraft a on a.icao24 = e.icao24
    cross join lateral (
      select d.dist_nm, p.observed_at, p.latitude, p.longitude, p.altitude_ft, p.altitude_source, p.ground_speed_kt, p.track_deg, p.vertical_rate_fpm, p.on_ground
        from public.aircraft_positions p
        cross join lateral (
          select public.st_distance(
                   public.st_setsrid(public.st_makepoint(p.longitude, p.latitude), 4326)::public.geography,
                   public.st_setsrid(public.st_makepoint(e.center_longitude, e.center_latitude), 4326)::public.geography,
                   false) / 1852.0 as dist_nm
        ) d
       where p.aircraft_id = a.id
         and p.observed_at between e.entered_at and e.last_seen_in_radius_at
       order by d.dist_nm, p.observed_at
       limit 1
    ) p
   where e.closest_at is null
)
update airintel_private.encounters e
   set closest_at = best.observed_at,
       closest_latitude = best.latitude,
       closest_longitude = best.longitude,
       closest_altitude_ft = best.altitude_ft,
       closest_altitude_source = case when best.altitude_ft is null then null
                                      when best.altitude_source in ('geometric', 'barometric', 'provider') then best.altitude_source end,
       closest_ground_speed_kt = case when best.ground_speed_kt >= 0 then best.ground_speed_kt end,
       closest_track_deg = case when best.track_deg >= 0 and best.track_deg < 360 then best.track_deg end,
       closest_vertical_rate_fpm = best.vertical_rate_fpm,
       closest_on_ground = best.on_ground,
       closest_point_basis = 'backfill'
  from best
 where e.id = best.id
   and abs(best.dist_nm - e.closest_approach_nm) <= 0.05;
