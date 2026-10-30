import type { NettedAircraft } from "../domain/netted";

export interface NettedExportMeta { radiusMi: number; scope: string; exportedAt?: string }

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // spreadsheet formula guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const NETTED_CSV_COLUMNS = ["icao24", "callsign", "registration", "type", "visit_count", "first_seen_utc", "last_seen_utc", "closest_approach_mi", "latest_entry_utc", "latest_entry_last_in_radius_utc", "latest_entry_closest_mi", "latest_entry_observations"] as const;

export function nettedToCsv(aircraft: NettedAircraft[]): string {
  const rows = aircraft.map((a) => {
    const v = a.visits[0];
    return [a.icao24, a.callsign, a.registration, a.aircraftTypeCode, a.visitCount, a.firstSeenAt, a.lastSeenAt, a.closestApproachMi.toFixed(2), v?.enteredAt, v?.lastSeenInRadiusAt, v ? v.closestMi.toFixed(2) : null, v?.observationCount].map(csvCell).join(",");
  });
  return [NETTED_CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
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

export const nettedFilename = (ext: "csv" | "json", now = new Date()) => `airintel-netted-${now.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${ext}`;
