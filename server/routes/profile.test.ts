import { describe, expect, it } from "vitest";
import type { Queryable } from "../db.js";
import { profileRoutes } from "./profile.js";
import { aircraftProfileSchema } from "../../src/domain/profile.js";

// Synthetic database/transport vectors only. No database connection or real records are used.
const aircraft = { id: "11111111-1111-4111-8111-111111111111", icao24: "abcdef", registration: "N99ZZ", first_seen_at: new Date(), last_seen_at: new Date() };
const registry = {
  match_status: "confirmed", match_method: "mode_s_hex_exact", limitations: [], manual_review_status: "verified",
  record_id: "22222222-2222-4222-8222-222222222222", snapshot_date: "2026-11-08", n_number: "N99ZZ",
  manufacturer_name: null, model_name: null, serial_number: null, registration_status: null,
  registrant_display_name: "SYNTHETIC ENTITY", registrant_kind: "business", owner_visibility: "displayable_entity",
};
function database(record: typeof registry | null, positions: unknown[] = []): Queryable {
  return { query: async (sql: string) => {
    if (sql.includes("from public.aircraft where")) return { rows: [aircraft] } as never;
    if (sql.includes("aircraft_registry_matches")) return { rows: record ? [record] : [] } as never;
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
