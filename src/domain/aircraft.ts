import { z } from "zod";

const nullableTrimmed = z.string().trim().min(1).nullable().optional();

export const observationSchema = z
  .object({
    provider: z.string().trim().min(1),
    providerRecordId: z.string().trim().min(1).optional(),
    icao24: z.string().trim().toLowerCase().regex(/^[0-9a-f]{6}$/),
    registration: nullableTrimmed,
    callsign: nullableTrimmed,
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    geometricAltitudeFt: z.number().finite().nullable().optional(),
    barometricAltitudeFt: z.number().finite().nullable().optional(),
    altitudeFt: z.number().finite().nullable().optional(),
    altitudeSource: z.enum(["geometric", "barometric", "provider"]).nullable().optional(),
    groundSpeedKt: z.number().finite().nonnegative().nullable().optional(),
    trackDeg: z.number().finite().min(0).lt(360).nullable().optional(),
    verticalRateFpm: z.number().finite().nullable().optional(),
    squawk: nullableTrimmed,
    onGround: z.boolean().nullable().optional(),
    emergencyStatus: nullableTrimmed,
    aircraftTypeCode: nullableTrimmed,
    category: nullableTrimmed,
    observedAt: z.iso.datetime({ offset: true }),
    receivedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((value, ctx) => {
    if (value.altitudeFt != null && value.altitudeSource == null) {
      ctx.addIssue({ code: "custom", path: ["altitudeSource"], message: "Altitude provenance is required" });
    }
    if (Date.parse(value.receivedAt) < Date.parse(value.observedAt) - 60_000) {
      ctx.addIssue({ code: "custom", path: ["receivedAt"], message: "Receipt precedes observation beyond allowed clock skew" });
    }
    if (Date.parse(value.observedAt) > Date.now() + 300_000) {
      ctx.addIssue({ code: "custom", path: ["observedAt"], message: "Observation is too far in the future" });
    }
  });

export type AircraftObservation = z.infer<typeof observationSchema>;

export const radiusQuerySchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  radiusNm: z.number().finite().positive().max(100),
});

export type RadiusQuery = z.infer<typeof radiusQuerySchema>;

export const aircraftResponseSchema = z.object({
  observations: z.array(observationSchema),
  receivedAt: z.iso.datetime({ offset: true }),
  sources: z.array(z.string().min(1)),
});

export const aircraftSummarySchema = z.object({
  id: z.uuid(),
  icao24: z.string().regex(/^[0-9a-f]{6}$/),
  registration: z.string().trim().min(1).nullable(),
  firstSeenAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }),
});

export const aircraftSearchResponseSchema = z.object({
  aircraft: z.array(aircraftSummarySchema).max(50),
  receivedAt: z.iso.datetime({ offset: true }),
});

export const trackPointSchema = z.object({
  provider: z.string().trim().min(1),
  icao24: z.string().trim().toLowerCase().regex(/^[0-9a-f]{6}$/),
  registration: nullableTrimmed,
  callsign: nullableTrimmed,
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  altitudeFt: z.number().finite().nullable().optional(),
  altitudeSource: z.enum(["geometric", "barometric", "provider"]).nullable().optional(),
  groundSpeedKt: z.number().finite().nonnegative().nullable().optional(),
  trackDeg: z.number().finite().min(0).lt(360).nullable().optional(),
  verticalRateFpm: z.number().finite().nullable().optional(),
  onGround: z.boolean().nullable().optional(),
  observedAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
}).superRefine((value, ctx) => {
  if (value.altitudeFt != null && value.altitudeSource == null) {
    ctx.addIssue({ code: "custom", path: ["altitudeSource"], message: "Altitude provenance is required" });
  }
  if (Date.parse(value.observedAt) > Date.now() + 300_000) {
    ctx.addIssue({ code: "custom", path: ["observedAt"], message: "Observation is too far in the future" });
  }
});

export const trackResponseSchema = z.object({
  aircraft: aircraftSummarySchema,
  points: z.array(trackPointSchema).max(10_000),
  windowStart: z.iso.datetime({ offset: true }),
  windowEnd: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  coverage: z.object({
    returnedPoints: z.number().int().nonnegative(),
    truncated: z.boolean(),
    sources: z.array(z.string().min(1)),
  }),
});

export const trackInsightsResponseSchema = z.object({
  aircraft: aircraftSummarySchema,
  windowStart: z.iso.datetime({ offset: true }),
  windowEnd: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  summary: z.object({
    pointCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().nonnegative(),
    altitudeFt: z.object({
      min: z.number().nullable(),
      max: z.number().nullable(),
      average: z.number().nullable(),
    }),
    groundSpeedKt: z.object({
      min: z.number().nullable(),
      max: z.number().nullable(),
      average: z.number().nullable(),
    }),
  }),
});

export const routeSummaryResponseSchema = z.object({
  aircraft: aircraftSummarySchema,
  windowStart: z.iso.datetime({ offset: true }),
  windowEnd: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  summary: z.object({
    pointCount: z.number().int().nonnegative(),
    durationMinutes: z.number().nonnegative(),
    totalDistanceNm: z.number().nonnegative(),
    averageGroundSpeedKt: z.number().nullable(),
    loiteringDetected: z.boolean(),
    loiteringMinutes: z.number().nonnegative(),
  }),
});

export const nearbyAircraftResponseSchema = z.object({
  query: z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    radiusNm: z.number().finite().positive().max(100),
  }),
  receivedAt: z.iso.datetime({ offset: true }),
  matches: z.array(
    z.object({
      icao24: z.string().regex(/^[0-9a-f]{6}$/),
      registration: z.string().trim().min(1).nullable(),
      callsign: z.string().trim().min(1).nullable(),
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
      observedAt: z.iso.datetime({ offset: true }),
      distanceNm: z.number().nonnegative(),
      altitudeFt: z.number().nullable(),
    }),
  ),
});

export type TrackInsightsQuery = { icao24: string; hours?: number };
export type RouteSummaryQuery = { icao24: string; hours?: number };
export type NearbyAircraftQuery = { latitude: number; longitude: number; radiusNm: number; hours?: number };

export type TrackPoint = z.infer<typeof trackPointSchema>;

export type TrackSegment = {
  kind: "observed" | "gap";
  points: TrackPoint[];
  gapDurationSeconds?: number;
};

export type ProviderTrack = { provider: string; segments: TrackSegment[] };

export type TrackSummary = {
  pointCount: number;
  sourceCount: number;
  altitudeFt: { min: number | null; max: number | null; average: number | null };
  groundSpeedKt: { min: number | null; max: number | null; average: number | null };
};

export type RouteSummary = {
  pointCount: number;
  durationMinutes: number;
  totalDistanceNm: number;
  averageGroundSpeedKt: number | null;
  loiteringDetected: boolean;
  loiteringMinutes: number;
};

export type NearbyAircraftMatch = {
  icao24: string;
  registration: string | null;
  callsign: string | null;
  latitude: number;
  longitude: number;
  observedAt: string;
  distanceNm: number;
  altitudeFt: number | null;
};

export function gapDurationSeconds(previousAt: string, currentAt: string): number {
  return (Date.parse(currentAt) - Date.parse(previousAt)) / 1000;
}

export function segmentTrack(points: TrackPoint[], gapThresholdSeconds = 120): TrackSegment[] {
  if (!Number.isFinite(gapThresholdSeconds) || gapThresholdSeconds <= 0) {
    throw new Error("Gap threshold must be a positive finite number");
  }
  if (points.length === 0) return [];

  const ordered = [...points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const segments: TrackSegment[] = [];
  let observed: TrackPoint[] = [ordered[0]!];

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    const gapSeconds = gapDurationSeconds(previous.observedAt, current.observedAt);
    if (gapSeconds > gapThresholdSeconds) {
      segments.push({ kind: "observed", points: observed });
      segments.push({ kind: "gap", points: [previous, current], gapDurationSeconds: gapSeconds });
      observed = [current];
    } else {
      observed.push(current);
    }
  }
  segments.push({ kind: "observed", points: observed });
  return segments;
}

export function segmentTracksByProvider(points: TrackPoint[], gapThresholdSeconds = 120): ProviderTrack[] {
  const grouped = new Map<string, TrackPoint[]>();
  for (const point of points) grouped.set(point.provider, [...(grouped.get(point.provider) ?? []), point]);
  return [...grouped.entries()].map(([provider, providerPoints]) => ({
    provider,
    segments: segmentTrack(providerPoints, gapThresholdSeconds),
  }));
}

export function summarizeTrackPoints(points: TrackPoint[]): TrackSummary {
  const altitudeValues = points.map((point) => point.altitudeFt).filter((value): value is number => value != null);
  const speedValues = points.map((point) => point.groundSpeedKt).filter((value): value is number => value != null);

  return {
    pointCount: points.length,
    sourceCount: new Set(points.map((point) => point.provider)).size,
    altitudeFt: {
      min: altitudeValues.length > 0 ? Math.min(...altitudeValues) : null,
      max: altitudeValues.length > 0 ? Math.max(...altitudeValues) : null,
      average: altitudeValues.length > 0 ? altitudeValues.reduce((sum, value) => sum + value, 0) / altitudeValues.length : null,
    },
    groundSpeedKt: {
      min: speedValues.length > 0 ? Math.min(...speedValues) : null,
      max: speedValues.length > 0 ? Math.max(...speedValues) : null,
      average: speedValues.length > 0 ? speedValues.reduce((sum, value) => sum + value, 0) / speedValues.length : null,
    },
  };
}

function haversineDistanceNm(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusNm = 3440.065; // nautical miles
  const deltaLatitude = toRadians(latitude2 - latitude1);
  const deltaLongitude = toRadians(longitude2 - longitude1);
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(toRadians(latitude1)) * Math.cos(toRadians(latitude2)) * Math.sin(deltaLongitude / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusNm * c;
}

export function summarizeRoute(points: TrackPoint[], loiteringRadiusNm = 0.25, loiteringMinMinutes = 5): RouteSummary {
  if (points.length === 0) {
    return { pointCount: 0, durationMinutes: 0, totalDistanceNm: 0, averageGroundSpeedKt: null, loiteringDetected: false, loiteringMinutes: 0 };
  }

  const ordered = [...points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const durationMinutes = Math.max(0, (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 60_000);
  const speeds = ordered.map((point) => point.groundSpeedKt).filter((value): value is number => value != null);
  let totalDistanceNm = 0;
  let loiteringMinutes = 0;
  let currentLoiteringMinutes = 0;

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    const distanceNm = haversineDistanceNm(previous.latitude, previous.longitude, current.latitude, current.longitude);
    totalDistanceNm += distanceNm;
    const gapMinutes = Math.max(0, (Date.parse(current.observedAt) - Date.parse(previous.observedAt)) / 60_000);
    if (distanceNm <= loiteringRadiusNm) {
      currentLoiteringMinutes += gapMinutes;
      if (currentLoiteringMinutes >= loiteringMinMinutes) loiteringMinutes = Math.max(loiteringMinutes, currentLoiteringMinutes);
    } else {
      currentLoiteringMinutes = 0;
    }
  }

  return {
    pointCount: ordered.length,
    durationMinutes,
    totalDistanceNm,
    averageGroundSpeedKt: speeds.length > 0 ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : null,
    loiteringDetected: loiteringMinutes >= loiteringMinMinutes,
    loiteringMinutes,
  };
}
