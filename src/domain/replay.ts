import { distanceNm } from "./geometry.js";
import { milesToNm } from "./units.js";
import type { TrackPoint } from "./aircraft.js";
import { z } from "zod";
import type { NettedVisit } from "./netted.js";

export const REPLAY_CONTEXT_MS = 10 * 60_000;
export const MAX_REPLAY_WINDOW_MS = 24 * 3_600_000;
export const replayWindowSchema = z.object({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
}).refine(({ start, end }) => {
  const duration = Date.parse(end) - Date.parse(start);
  return duration > 0 && duration <= MAX_REPLAY_WINDOW_MS;
}, "Replay window must be positive and at most 24 hours");
export type ReplayWindow = z.infer<typeof replayWindowSchema>;

/** Bounded context around a saved encounter; never substitutes today's center. */
export function encounterReplayWindow(visit: NettedVisit, nowMs = Date.now()): ReplayWindow {
  const start = Date.parse(visit.enteredAt) - REPLAY_CONTEXT_MS;
  const end = Math.min(nowMs, Date.parse(visit.lastSeenInRadiusAt) + REPLAY_CONTEXT_MS, start + MAX_REPLAY_WINDOW_MS);
  return replayWindowSchema.parse({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
}

/** Most recent actual observation at/before a UTC instant; no interpolation. */
export function replayIndexAt(times: readonly number[], at: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= at) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/** Review context only. These per-provider transitions do not modify saved encounter counts. */
export function replayContext(points: readonly TrackPoint[], visit: NettedVisit) {
  if (visit.centerLatitude == null || visit.centerLongitude == null || !visit.radiusMi) return null;
  const radiusNm = milesToNm(visit.radiusMi);
  const streams = new Map<string, TrackPoint[]>();
  for (const point of points) {
    const stream = streams.get(point.provider) ?? [];
    stream.push(point); streams.set(point.provider, stream);
  }
  return [...streams].map(([provider, stream]) => {
    const ordered = [...stream].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    let inside = 0, nearOutside = 0, approach = 0, departure = 0, entries = 0;
    let previous: { at: number; inside: boolean } | null = null;
    for (const point of ordered) {
      const at = Date.parse(point.observedAt);
      const distance = distanceNm(visit.centerLatitude!, visit.centerLongitude!, point.latitude, point.longitude);
      const isInside = distance <= radiusNm;
      if (isInside) inside++;
      else if (distance <= radiusNm * 3) nearOutside++;
      if (at < Date.parse(visit.enteredAt)) approach++;
      if (at > Date.parse(visit.lastSeenInRadiusAt)) departure++;
      if (isInside && previous && !previous.inside && at - previous.at <= 120_000) entries++;
      previous = { at, inside: isInside };
    }
    return { provider, inside, nearOutside, approach, departure, entries };
  });
}
