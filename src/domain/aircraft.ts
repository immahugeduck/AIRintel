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

export type TrackInsightsQuery = { icao24: string; hours?: number };

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
