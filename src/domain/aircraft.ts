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
