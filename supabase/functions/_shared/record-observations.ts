import type { SupabaseClient } from "npm:@supabase/supabase-js@2.55.0";
import { z } from "npm:zod@4.0.15";

const nullableText = z.string().trim().min(1).nullable().optional();
const recorderObservationSchema = z.object({
  provider: z.string().trim().regex(/^[a-z0-9_-]+$/),
  providerSchemaVersion: z.string().trim().min(1).max(64),
  normalizationVersion: z.string().trim().min(1).max(64),
  providerRecordId: z.string().trim().min(1).max(256).optional(),
  icao24: z.string().trim().toLowerCase().regex(/^[0-9a-f]{6}$/),
  registration: nullableText,
  callsign: nullableText,
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  altitudeFt: z.number().finite().nullable().optional(),
  altitudeSource: z.enum(["geometric", "barometric", "provider"]).nullable().optional(),
  geometricAltitudeFt: z.number().finite().nullable().optional(),
  barometricAltitudeFt: z.number().finite().nullable().optional(),
  groundSpeedKt: z.number().finite().nonnegative().nullable().optional(),
  trackDeg: z.number().finite().min(0).lt(360).nullable().optional(),
  verticalRateFpm: z.number().finite().nullable().optional(),
  onGround: z.boolean().nullable().optional(),
  observedAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  raw: z.json(),
}).superRefine((value, ctx) => {
  if (value.altitudeFt != null && value.altitudeSource == null) ctx.addIssue({ code: "custom", path: ["altitudeSource"], message: "Altitude provenance is required" });
  if (Date.parse(value.receivedAt) < Date.parse(value.observedAt) - 60_000) ctx.addIssue({ code: "custom", path: ["receivedAt"], message: "Invalid provider clock order" });
  if (Date.parse(value.observedAt) > Date.now() + 300_000) ctx.addIssue({ code: "custom", path: ["observedAt"], message: "Observation is too far in the future" });
});

export type RecorderObservation = z.input<typeof recorderObservationSchema>;
export type RecordResult = { received: number; inserted: number; duplicate: number; rejected: number };

export async function recordObservations(database: SupabaseClient, input: RecorderObservation[]): Promise<RecordResult> {
  const result: RecordResult = { received: input.length, inserted: 0, duplicate: 0, rejected: 0 };
  for (const candidate of input) {
    const parsed = recorderObservationSchema.safeParse(candidate);
    if (!parsed.success) { result.rejected += 1; continue; }
    const observation = parsed.data;
    const dedupeKey = observation.providerRecordId
      ? [observation.provider, "record", observation.providerRecordId].join(":")
      : [observation.provider, observation.icao24, new Date(observation.observedAt).toISOString()].join(":");
    const { data, error } = await database.rpc("record_aircraft_observation", { input: { ...observation, dedupeKey } });
    if (error) { result.rejected += 1; continue; }
    if (data === true) result.inserted += 1;
    else result.duplicate += 1;
  }
  return result;
}
