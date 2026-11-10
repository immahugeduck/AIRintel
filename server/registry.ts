import type { Queryable } from "./db.js";

/** Server-only current registry facts. Raw FAA rows and addresses never enter this shape. */
export type RegistryRow = {
  import_run_id: string; mode_s_hex: string | null;
  match_status: string | null; match_method: string | null; limitations: string[] | null; manual_review_status: string | null;
  record_id: string; snapshot_date: string; n_number: string; manufacturer_name: string | null; model_name: string | null; serial_number: string | null;
  registration_status: string | null; registrant_display_name: string | null; registrant_kind: string | null; owner_visibility: string;
};

type RegistryResult = {
  record: RegistryRow | null;
  status: "confirmed" | "conflict" | "unmatched";
  unavailableReason: "no_published_snapshot" | "no_exact_match" | "identity_unverified" | "conflict" | null;
  snapshotEffectiveAt: string | null;
};

/**
 * Read-only exact Mode-S resolution against ONE current published snapshot.
 * Never falls back to an older owner record or guesses an identity from a callsign.
 * Persisted matches are reviewed for conflicts, but are not required for an exact match.
 */
export async function lookupCurrentRegistry(db: Queryable, aircraft: { id: string; icao24: string; registration: string | null }, asOf: Date): Promise<RegistryResult> {
  const today = asOf.toISOString().slice(0, 10);
  const { rows: snapshots } = await db.query<{ id: string; snapshot_date: string; status: string }>(
    `select id, snapshot_date::text as snapshot_date, status
       from airintel_private.faa_import_runs
      where status = 'published' and snapshot_date <= $1::date
      order by snapshot_date desc, finished_at desc nulls last, started_at desc, id desc limit 1`,
    [today],
  );
  const snapshot = snapshots[0];
  // Defense in depth: do not trust a malformed / future / unpublished adapter result.
  if (!snapshot || snapshot.status !== "published" || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.snapshot_date) || snapshot.snapshot_date > today) {
    return { record: null, status: "unmatched", unavailableReason: "no_published_snapshot", snapshotEffectiveAt: null };
  }
  const snapshotEffectiveAt = `${snapshot.snapshot_date}T00:00:00Z`;
  const { rows } = await db.query<RegistryRow>(
    `select r.import_run_id, r.mode_s_hex, m.match_status, m.match_method, m.limitations, m.manual_review_status,
            r.id as record_id, r.snapshot_date::text as snapshot_date, r.n_number, r.manufacturer_name, r.model_name, r.serial_number,
            r.registration_status, r.registrant_display_name, r.registrant_kind, r.owner_visibility
       from public.aircraft_registry_records r
       left join public.aircraft_registry_matches m on m.registry_record_id = r.id and m.aircraft_id = $1
      where r.import_run_id = $2 and (r.mode_s_hex = $3 or r.id in
        (select registry_record_id from public.aircraft_registry_matches where aircraft_id = $1))
      limit 101`,
    [aircraft.id, snapshot.id, aircraft.icao24],
  );
  const candidates = rows.filter((row) => row.import_run_id === snapshot.id && row.snapshot_date === snapshot.snapshot_date);
  const conflict = (): RegistryResult => ({ record: null, status: "conflict", unavailableReason: "conflict", snapshotEffectiveAt });
  // Do not bypass a rejected decision or hide an unresolved conflict with another match.
  if (rows.length > 100 || candidates.some((row) => row.manual_review_status === "rejected" || row.match_status === "conflict" || (row.match_status !== null && row.mode_s_hex !== aircraft.icao24))) return conflict();
  const exact = candidates.filter((row) => row.mode_s_hex === aircraft.icao24);
  const records = new Map(exact.map((row) => [row.record_id, row]));
  if (records.size > 1) return conflict();
  const record = [...records.values()][0];
  if (!record) return { record: null, status: "unmatched", unavailableReason: "no_exact_match", snapshotEffectiveAt };
  // A provider registration mismatch is evidence of uncertainty, not permission to pick an owner.
  const observedRegistration = aircraft.registration?.trim().toUpperCase();
  if (observedRegistration && observedRegistration !== record.n_number) return conflict();
  // The previous normalizer stripped ~ from non-ICAO addresses. Do not attach FAA
  // facts to a known contaminated historical identity; do not rewrite raw history.
  const { rows: provenance } = await db.query<{ non_icao: boolean; verified_icao: boolean }>(
    `select exists (
       select 1 from airintel_private.raw_observations raw
       join public.aircraft_positions p on p.id = raw.position_id
       where p.aircraft_id = $1 and (left(trim(raw.payload->>'hex'), 1) = '~'
         or lower(trim(raw.payload->>'type')) in ('adsb_other', 'adsr_other', 'tisb_other', 'tisb_trackfile'))
     ) as non_icao,
     exists (
       select 1 from airintel_private.raw_observations raw
       join public.aircraft_positions p on p.id = raw.position_id
       where p.aircraft_id = $1 and lower(trim(raw.payload->>'hex')) = $2
         and coalesce(lower(trim(raw.payload->>'type')), '') not in ('adsb_other', 'adsr_other', 'tisb_other', 'tisb_trackfile')
     ) as verified_icao`, [aircraft.id, aircraft.icao24],
  );
  if (!provenance[0] || typeof provenance[0].non_icao !== "boolean" || typeof provenance[0].verified_icao !== "boolean") throw new Error("registry_identity_provenance_unavailable");
  if (provenance[0].non_icao) return conflict();
  // Expired raw evidence is not permission to guess the namespace of a legacy ID.
  // A current manually verified exact match may stand on its reviewed evidence.
  if (!provenance[0].verified_icao && record.manual_review_status !== "verified") {
    return { record: null, status: "unmatched", unavailableReason: "identity_unverified", snapshotEffectiveAt };
  }
  return {
    record: { ...record, match_status: "confirmed", match_method: "mode_s_hex_exact", limitations: record.limitations ?? [] },
    status: "confirmed", unavailableReason: null, snapshotEffectiveAt,
  };
}

export type RegistryIdentity = {
  nNumber: string;
  /** FAA registrant kind as imported: business / government / individual / other / unknown. */
  registrantKind: string | null;
  /** Business and government registrants only; natural persons are redacted on import and stay null. */
  registrantName: string | null;
  /** "MANUFACTURER MODEL" from the FAA reference file, used when the provider reports no type designator. */
  model: string | null;
  /** FAA TYPE AIRCRAFT code ("4" fixed wing single, "5" multi, "6" rotorcraft, ...). */
  faaAircraftType: string | null;
};

/**
 * List-view registry facts for netted aircraft, from the newest published, non-future snapshot. Fails closed like
 * lookupCurrentRegistry: only a single exact Mode-S record counts, and an aircraft with a rejected or conflicting
 * persisted match gets nothing. Never throws (empty map on any failure, including a database without the registry
 * tables). The full owner/provenance checks stay in the profile view.
 */
export async function lookupRegistryIdentities(db: Queryable, icaos: readonly string[], asOf: Date = new Date()): Promise<Map<string, RegistryIdentity>> {
  const result = new Map<string, RegistryIdentity>();
  const wanted = [...new Set(icaos.filter((icao) => /^[0-9a-f]{6}$/.test(icao)))];
  if (wanted.length === 0) return result;
  try {
    const { rows } = await db.query<{ mode_s_hex: string; n_number: string; registrant_kind: string | null; registrant_display_name: string | null; manufacturer_name: string | null; model_name: string | null; aircraft_type_code: string | null }>(
      `with snapshot as (
         select id from airintel_private.faa_import_runs
          where status = 'published' and snapshot_date <= $2::date
          order by snapshot_date desc, finished_at desc nulls last, started_at desc, id desc limit 1
       ), candidates as (
         select r.mode_s_hex, count(*) over (partition by r.mode_s_hex) as records, r.n_number, r.registrant_kind,
                case when r.owner_visibility = 'displayable_entity' then r.registrant_display_name end as registrant_display_name,
                r.manufacturer_name, r.model_name, r.aircraft_type_code
           from public.aircraft_registry_records r
          where r.import_run_id = (select id from snapshot) and r.mode_s_hex = any($1::text[])
       )
       select c.mode_s_hex, c.n_number, c.registrant_kind, c.registrant_display_name, c.manufacturer_name, c.model_name, c.aircraft_type_code
         from candidates c
        where c.records = 1
          and not exists (
            select 1 from public.aircraft a
              join public.aircraft_registry_matches m on m.aircraft_id = a.id
             where a.icao24 = c.mode_s_hex and (m.match_status = 'conflict' or m.manual_review_status = 'rejected')
          )`,
      [wanted, asOf.toISOString().slice(0, 10)],
    );
    for (const row of rows) {
      const model = [row.manufacturer_name?.trim(), row.model_name?.trim()].filter(Boolean).join(" ");
      result.set(row.mode_s_hex, {
        nNumber: row.n_number,
        registrantKind: row.registrant_kind ?? null,
        registrantName: row.registrant_display_name?.trim() || null,
        model: model || null,
        faaAircraftType: row.aircraft_type_code?.trim() || null,
      });
    }
  } catch {
    result.clear();
  }
  return result;
}

/** List-view fallback: FAA N-numbers for aircraft that broadcast no registration (see lookupRegistryIdentities). */
export async function lookupRegistryRegistrations(db: Queryable, icaos: readonly string[], asOf: Date = new Date()): Promise<Map<string, string>> {
  const identities = await lookupRegistryIdentities(db, icaos, asOf);
  return new Map([...identities].map(([icao, identity]) => [icao, identity.nNumber]));
}
