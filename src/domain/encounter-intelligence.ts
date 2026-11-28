import type { NettedAircraft } from "./netted.js";

/** Local frequency among distinct aircraft returned in this log, never global fleet rarity. */
export function localTypeFrequency(item: NettedAircraft, aircraft: readonly NettedAircraft[]) {
  const type = item.aircraftTypeCode?.trim().toUpperCase();
  if (!type) return null;
  const known = new Map(aircraft.filter((a) => a.aircraftTypeCode?.trim()).map((a) => [a.icao24, a.aircraftTypeCode!.trim().toUpperCase()]));
  const matching = [...known.values()].filter((value) => value === type).length;
  return { type, matching, knownAircraft: known.size, uncommon: known.size >= 20 && matching / known.size <= 0.05 };
}

// Identity and ownership are deliberately excluded: neither establishes activity or purpose.
const BEHAVIOR_CODES = new Set(["circling", "centered_orbit", "loiter", "low_slow", "close_dip", "followed_locations", "recurrence"]);
export function encounterIntelligence(item: NettedAircraft, aircraft: readonly NettedAircraft[]) {
  const pattern = item.pattern;
  return {
    frequency: localTypeFrequency(item, aircraft),
    military: pattern?.reasons.find((reason) => reason.code === "military_flag") ?? null,
    behavior: pattern?.reasons.filter((reason) => BEHAVIOR_CODES.has(reason.code) && reason.weight > 0) ?? [],
    coverage: pattern?.coverage ?? "sparse",
    surveillanceLikelihood: "Unknown" as const,
  };
}
