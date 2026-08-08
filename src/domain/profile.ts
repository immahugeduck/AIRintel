import { z } from "zod";

const utcTimestamp = z.iso.datetime({ offset: true });
const evidenceLevelSchema = z.enum(["observed", "calculated", "unknown"]);

export const evidenceStatusSchema = z.enum(["available", "unknown", "conflict", "withheld_or_unavailable"]);
export const matchStatusSchema = z.enum(["confirmed", "corroborated", "conflict", "unmatched", "withheld_or_unavailable"]);

export const evidenceFieldSchema = z.object({
  value: z.string().nullable(),
  evidenceLevel: evidenceLevelSchema,
  status: evidenceStatusSchema,
  source: z.string().min(1),
  sourceRecordId: z.string().nullable(),
  sourceEffectiveAt: utcTimestamp.nullable(),
  matchMethod: z.string().nullable(),
  limitations: z.array(z.string().min(1)),
}).superRefine((field, context) => {
  if ((field.status === "unknown" || field.status === "withheld_or_unavailable") && field.value !== null) {
    context.addIssue({ code: "custom", path: ["value"], message: "unknown or withheld evidence cannot contain a value" });
  }
  if (field.status === "available" && (field.value === null || field.evidenceLevel === "unknown")) {
    context.addIssue({ code: "custom", path: ["status"], message: "available evidence requires a non-null observed or calculated value" });
  }
  if (field.evidenceLevel === "unknown" && field.value !== null) {
    context.addIssue({ code: "custom", path: ["evidenceLevel"], message: "unknown evidence cannot contain a value" });
  }
});

export const sourceStatisticsSchema = z.object({
  provider: z.string().min(1),
  windowStart: utcTimestamp,
  windowEnd: utcTimestamp,
  validObservationCount: z.number().int().nonnegative(),
  observedDays: z.number().int().nonnegative(),
  medianAltitudeFt: z.number().finite().nullable(),
  p10AltitudeFt: z.number().finite().nullable(),
  p90AltitudeFt: z.number().finite().nullable(),
  altitudeBasis: z.enum(["geometric", "barometric", "provider", "mixed", "unknown"]),
  medianGroundSpeedKt: z.number().finite().nonnegative().nullable(),
  p10GroundSpeedKt: z.number().finite().nonnegative().nullable(),
  p90GroundSpeedKt: z.number().finite().nonnegative().nullable(),
  onGroundExcludedCount: z.number().int().nonnegative(),
  unknownGroundStateExcludedCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  algorithmVersion: z.string().min(1),
}).superRefine((statistics, context) => {
  if (Date.parse(statistics.windowStart) > Date.parse(statistics.windowEnd)) {
    context.addIssue({ code: "custom", path: ["windowEnd"], message: "windowEnd must not precede windowStart" });
  }

  const checkOrder = (p10: number | null, median: number | null, p90: number | null, path: string) => {
    if (p10 !== null && median !== null && p90 !== null && !(p10 <= median && median <= p90)) {
      context.addIssue({ code: "custom", path: [path], message: "percentiles must satisfy p10 <= median <= p90" });
    }
  };

  checkOrder(statistics.p10AltitudeFt, statistics.medianAltitudeFt, statistics.p90AltitudeFt, "medianAltitudeFt");
  checkOrder(statistics.p10GroundSpeedKt, statistics.medianGroundSpeedKt, statistics.p90GroundSpeedKt, "medianGroundSpeedKt");
});

export const aircraftProfileSchema = z.object({
  aircraftId: z.uuid(),
  icao24: z.string().regex(/^[0-9a-f]{6}$/),
  observedRegistration: z.string().nullable(),
  firstObservedAt: utcTimestamp,
  lastObservedAt: utcTimestamp,
  registryMatch: z.object({
    status: matchStatusSchema,
    method: z.string().nullable(),
    snapshotEffectiveAt: utcTimestamp.nullable(),
    nNumber: evidenceFieldSchema,
    manufacturer: evidenceFieldSchema,
    model: evidenceFieldSchema,
    serialNumber: evidenceFieldSchema,
    registrationStatus: evidenceFieldSchema,
    registeredOwner: evidenceFieldSchema,
  }),
  operator: z.object({
    documentedOperator: evidenceFieldSchema,
    actualOperatorForFlight: z.literal("Unknown"),
  }),
  statisticsBySource: z.array(sourceStatisticsSchema),
  receivedAt: utcTimestamp,
}).superRefine((profile, context) => {
  if (Date.parse(profile.firstObservedAt) > Date.parse(profile.lastObservedAt)) {
    context.addIssue({ code: "custom", path: ["lastObservedAt"], message: "lastObservedAt must not precede firstObservedAt" });
  }
});

export type AircraftProfile = z.infer<typeof aircraftProfileSchema>;

export function normalizeNNumber(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^N(?:[1-9][0-9]{0,4}|[1-9][0-9]{0,3}[A-HJ-NP-Z]|[1-9][0-9]{0,2}[A-HJ-NP-Z]{2})$/.test(normalized)) throw new Error("Invalid FAA N-number format");
  return normalized;
}
