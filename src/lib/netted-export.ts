import type { NettedAircraft } from "../domain/netted";
import { knotsToMph } from "../domain/units";
import { straightPassMinutes, timeInside } from "../domain/encounter-compare";
import { aircraftHabits, isNewPattern } from "../domain/pass-signature";

export interface NettedExportMeta { radiusMi: number; scope: string; exportedAt?: string }

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // spreadsheet formula guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const NETTED_CSV_COLUMNS = ["icao24", "callsign", "registration", "type", "visit_count", "first_seen_utc", "last_seen_utc", "closest_approach_mi", "latest_entry_utc", "latest_entry_last_in_radius_utc", "latest_entry_closest_mi", "latest_entry_observations", "latest_entry_center_lat", "latest_entry_center_lon", "pattern_tier", "pattern_score", "pattern_reasons", "pattern_context", "pattern_fit", "latest_entry_closest_at_utc", "latest_entry_closest_altitude_ft", "latest_entry_closest_speed_mph", "latest_entry_closest_track_deg"] as const;

/** One row per entry (pass), for comparing passes in a spreadsheet. */
export const NETTED_ENTRY_CSV_COLUMNS = ["icao24", "callsign", "registration", "type", "entry_number", "entered_utc", "last_in_radius_utc", "minutes_inside", "observations_inside", "closest_mi", "closest_at_utc", "closest_altitude_ft", "altitude_source", "on_ground", "closest_speed_mph", "closest_track_deg", "vertical_rate_fpm", "bearing_from_center_deg", "center_lat", "center_lon", "closest_point_basis", "last_outside_before_entry_utc", "first_outside_after_exit_utc", "max_minutes_inside", "straight_pass_minutes", "sig_altitude_band", "sig_speed_band", "sig_heading", "sig_side", "sig_dwell", "sig_day_part", "sig_weekend", "sig_path_key", "sig_new_pattern"] as const;

const mph = (kt: number | null | undefined) => (kt == null ? null : knotsToMph(kt).toFixed(0));
const round = (value: number | null | undefined, digits = 0) => (value == null ? null : value.toFixed(digits));

export function nettedToCsv(aircraft: NettedAircraft[]): string {
  const rows = aircraft.map((a) => {
    const v = a.visits[0];
    return [a.icao24, a.callsign, a.registration, a.aircraftTypeCode, a.visitCount, a.firstSeenAt, a.lastSeenAt, a.closestApproachMi.toFixed(2), v?.enteredAt, v?.lastSeenInRadiusAt, v ? v.closestMi.toFixed(2) : null, v?.observationCount, v?.centerLatitude ?? null, v?.centerLongitude ?? null, a.pattern?.tier ?? null, a.pattern?.score ?? null, a.pattern ? a.pattern.reasons.filter((r) => r.weight !== 0).map((r) => `${r.code}(${r.weight > 0 ? "+" : ""}${r.weight})`).join("; ") : null, a.pattern?.context ?? null, a.pattern?.fit ?? null, v?.closest?.at ?? null, round(v?.closest?.altitudeFt), mph(v?.closest?.groundSpeedKt), round(v?.closest?.trackDeg)].map(csvCell).join(",");
  });
  return [NETTED_CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

export function nettedEntriesToCsv(aircraft: NettedAircraft[], radiusMi?: number): string {
  const rows = aircraft.flatMap((a) => { const habits = aircraftHabits(a.visits, radiusMi); return a.visits.map((v, index) => {
    const c = v.closest;
    const sig = habits.perVisit[index] ?? null;
    const minutes = Math.max(0, (Date.parse(v.lastSeenInRadiusAt) - Date.parse(v.enteredAt)) / 60_000);
    return [a.icao24, a.callsign, a.registration ?? a.registryRegistration ?? null, a.aircraftTypeCode, a.visitCount - index, v.enteredAt, v.lastSeenInRadiusAt, minutes.toFixed(1), v.observationCount, v.closestMi.toFixed(2),
      c?.at ?? null, round(c?.altitudeFt), c?.altitudeSource ?? null, c?.onGround ?? null, mph(c?.groundSpeedKt), round(c?.trackDeg), round(c?.verticalRateFpm), round(c?.bearingFromCenterDeg),
      v.centerLatitude ?? null, v.centerLongitude ?? null, c?.basis ?? null,
      v.enteredAfter ?? null, v.exitedBefore ?? null, round(timeInside(v).atMost, 1), round(straightPassMinutes(v, v.radiusMi ?? radiusMi), 1),
      sig?.altitude ?? null, sig?.speed ?? null, sig?.heading ?? null, sig?.side ?? null, sig?.dwell ?? null, sig?.dayPart ?? null, sig ? sig.weekend : null, sig?.key ?? null, sig ? isNewPattern(sig, habits) : null].map(csvCell).join(",");
  }); });
  return [NETTED_ENTRY_CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

export function nettedToJson(aircraft: NettedAircraft[], meta: NettedExportMeta): string {
  return JSON.stringify({ exportedAt: meta.exportedAt ?? new Date().toISOString(), radiusMi: meta.radiusMi, scope: meta.scope, count: aircraft.length, aircraft }, null, 2);
}

export function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const nettedFilename = (ext: "csv" | "json", now = new Date(), kind: "netted" | "entries" = "netted") => `airintel-${kind}-${now.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${ext}`;
