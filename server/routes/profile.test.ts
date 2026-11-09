import { describe, expect, it } from "vitest";
import type { Queryable } from "../db.js";
import { profileRoutes } from "./profile.js";
import { aircraftProfileSchema } from "../../src/domain/profile.js";

// Synthetic database/transport vectors only. No database connection or real records are used.
const aircraft = { id: "11111111-1111-4111-8111-111111111111", icao24: "abcdef", registration: "N99ZZ", first_seen_at: new Date(), last_seen_at: new Date() };
const registry = {
  match_status: "confirmed", match_method: "mode_s_hex_exact", limitations: [], manual_review_status: "verified",
  import_run_id: "33333333-3333-4333-8333-333333333333", mode_s_hex: "abcdef",
  record_id: "22222222-2222-4222-8222-222222222222", snapshot_date: "2026-11-08", n_number: "N99ZZ",
  manufacturer_name: null, model_name: null, serial_number: null, registration_status: null,
  registrant_display_name: "SYNTHETIC ENTITY", registrant_kind: "business", owner_visibility: "displayable_entity",
};
function database(record: typeof registry | null, positions: unknown[] = []): Queryable {
  return { query: async (sql: string) => {
    if (sql.includes("from public.aircraft where")) return { rows: [aircraft] } as never;
    if (sql.includes("from airintel_private.faa_import_runs")) return { rows: [{ id: registry.import_run_id, snapshot_date: "2026-11-08", status: "published" }] } as never;
    if (sql.includes("aircraft_registry_matches")) return { rows: record ? [record] : [] } as never;
    if (sql.includes("raw_observations")) return { rows: [{ non_icao: false, verified_icao: true }] } as never;
    if (sql.includes("aircraft_positions")) return { rows: positions } as never;
    return { rows: [] } as never;
  } };
}
async function profile(db: Queryable) {
  const response = await profileRoutes(db).request("/?icao24=ABCDEF");
  expect(response.status).toBe(200);
  return aircraftProfileSchema.parse(await response.json());
}

describe("profile evidence", () => {
  it.each(["withheld", "individual_redacted"])("preserves %s instead of turning it into generic unknown", async (owner_visibility) => {
    const result = await profile(database({ ...registry, owner_visibility }));
    expect(result.registryMatch.registeredOwner).toMatchObject({ value: null, evidenceLevel: "unknown", status: "withheld_or_unavailable" });
  });
  it("does not expose a natural-person name even if visibility is inconsistent", async () => {
    const result = await profile(database({ ...registry, registrant_kind: "individual" }));
    expect(result.registryMatch.registeredOwner.value).toBeNull();
  });
  it("keeps missing FAA evidence separate from observed registration", async () => {
    const result = await profile(database(null));
    expect(result.observedRegistration).toBe("N99ZZ");
    expect(result.registryMatch).toMatchObject({ status: "unmatched", nNumber: { value: null }, registeredOwner: { value: null } });
  });
  it("does not silently treat unknown ground state as airborne to fill statistics", async () => {
    const positions = Array.from({ length: 20 }, () => ({ altitude_ft: 6525, altitude_source: "barometric", ground_speed_kt: 240, on_ground: null, observed_at: new Date(), source_key: "adsb_lol" }));
    const result = await profile(database(null, positions));
    expect(result.statisticsBySource[0]).toMatchObject({ validObservationCount: 0, medianAltitudeFt: null, medianGroundSpeedKt: null, unknownGroundStateExcludedCount: 20 });
  });
});


// Synthetic snapshot/match vectors; this suite never connects to a database.
describe("current published FAA snapshot resolution", () => {
  const snapshot = { id: registry.import_run_id, snapshot_date: "2026-11-08", status: "published" };
  function registryDb(records: Record<string, unknown>[], selectedSnapshot: typeof snapshot | null = snapshot, legacyNonIcao = false): Queryable {
    return { query: async (sql: string) => {
      if (sql.includes("from public.aircraft where")) return { rows: [aircraft] } as never;
      if (sql.includes("from airintel_private.faa_import_runs")) return { rows: selectedSnapshot ? [selectedSnapshot] : [] } as never;
      if (sql.includes("raw_observations")) return { rows: [{ non_icao: legacyNonIcao, verified_icao: !legacyNonIcao }] } as never;
      if (sql.includes("aircraft_registry_records")) {
        // Model the legacy query's conflict exclusion / limit to reproduce its unsafe fallback.
        const result = sql.includes("m.match_status <> 'conflict'") ? records.filter((r) => r.match_status !== "conflict").slice(0, 1) : records;
        return { rows: result } as never;
      }
      return { rows: [] } as never;
    } };
  }
  it("reports that no published FAA source is available without inventing registry facts", async () => {
    const result = await profile(registryDb([], null));
    expect(result.registryMatch).toMatchObject({ status: "unmatched", unavailableReason: "no_published_snapshot", manufacturer: { value: null } });
  });
  it("resolves an exact Mode-S match without requiring a precomputed match row", async () => {
    const result = await profile(registryDb([{ ...registry, match_status: null, match_method: null, manual_review_status: null }]));
    expect(result.registryMatch).toMatchObject({ status: "confirmed", method: "mode_s_hex_exact", nNumber: { value: "N99ZZ" } });
  });
  it("does not resurrect registry facts from an older snapshot", async () => {
    const result = await profile(registryDb([{ ...registry, import_run_id: "old-snapshot", snapshot_date: "2026-01-01" }]));
    expect(result.registryMatch).toMatchObject({ status: "unmatched", unavailableReason: "no_exact_match", nNumber: { value: null } });
  });
  it("keeps an unresolved conflict dominant over a confirmed candidate", async () => {
    const result = await profile(registryDb([registry, { ...registry, record_id: "conflicting-row", match_status: "conflict" }]));
    expect(result.registryMatch).toMatchObject({ status: "conflict", nNumber: { value: null }, registeredOwner: { value: null } });
  });
  it("does not choose arbitrarily between duplicate exact Mode-S rows", async () => {
    const result = await profile(registryDb([registry, { ...registry, record_id: "duplicate-hex-row" }]));
    expect(result.registryMatch.status).toBe("conflict");
    expect(result.registryMatch.registeredOwner.value).toBeNull();
  });
  it("does not bypass a rejected match through automatic exact matching", async () => {
    const result = await profile(registryDb([{ ...registry, manual_review_status: "rejected" }]));
    expect(result.registryMatch.status).toBe("conflict");
    expect(result.registryMatch.nNumber.value).toBeNull();
  });
  it("does not override a Mode-S conflict using an exact registration string", async () => {
    const result = await profile(registryDb([{ ...registry, mode_s_hex: "fedcba", match_method: "registration_string_exact" }]));
    expect(result.registryMatch.status).toBe("conflict");
    expect(result.registryMatch.nNumber.value).toBeNull();
  });
  it("fails closed when the observed registration disagrees with an exact Mode-S record", async () => {
    const result = await profile(registryDb([{ ...registry, n_number: "N88ZZ" }]));
    expect(result.registryMatch.status).toBe("conflict");
    expect(result.registryMatch.registeredOwner.value).toBeNull();
  });
  it("does not enrich a historically conflated non-ICAO track", async () => {
    const result = await profile(registryDb([registry], snapshot, true));
    expect(result.registryMatch).toMatchObject({ status: "conflict", registeredOwner: { value: null } });
  });
  it("rejects an unpublished snapshot even if returned by the query adapter", async () => {
    const result = await profile(registryDb([registry], { ...snapshot, status: "staging" }));
    expect(result.registryMatch).toMatchObject({ status: "unmatched", unavailableReason: "no_published_snapshot", nNumber: { value: null } });
  });
});
