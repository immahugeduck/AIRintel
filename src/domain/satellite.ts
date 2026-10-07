import { z } from "zod";

export const celestrakGroupSchema = z.enum(["STATIONS", "VISUAL", "WEATHER", "IRIDIUM-NEXT"]);
export type CelestrakGroup = z.infer<typeof celestrakGroupSchema>;

export const satelliteSourceRecordSchema = z.object({
  provider: z.literal("celestrak"),
  group: celestrakGroupSchema,
  noradId: z.string().regex(/^\d{1,9}$/),
  name: z.string().trim().min(1).max(200),
  tleLine1: z.string().startsWith("1 ").min(69),
  tleLine2: z.string().startsWith("2 ").min(69),
  elementEpoch: z.iso.datetime({ offset: true }),
  retrievedAt: z.iso.datetime({ offset: true }),
  sourceUrl: z.url(),
});

export type SatelliteSourceRecord = z.infer<typeof satelliteSourceRecordSchema>;

export const observerSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  heightKm: z.number().finite().min(-1).max(20).default(0),
});

export type SatelliteObserver = z.infer<typeof observerSchema>;

export const propagatedSatelliteSchema = z.object({
  evidenceClass: z.literal("calculated"),
  provider: z.literal("celestrak"),
  propagationLibrary: z.string().trim().min(1),
  propagationVersion: z.string().trim().min(1),
  noradId: z.string().regex(/^\d{1,9}$/),
  name: z.string().trim().min(1),
  group: celestrakGroupSchema,
  calculatedAt: z.iso.datetime({ offset: true }),
  elementEpoch: z.iso.datetime({ offset: true }),
  sourceRetrievedAt: z.iso.datetime({ offset: true }),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  altitudeKm: z.number().finite(),
  velocityKmS: z.number().finite().nonnegative(),
  elevationDeg: z.number().finite().min(-90).max(90),
  azimuthDeg: z.number().finite().min(0).lt(360),
  rangeKm: z.number().finite().nonnegative(),
  aboveHorizon: z.boolean(),
});

export type PropagatedSatellite = z.infer<typeof propagatedSatelliteSchema>;

export const satellitePassSchema = z.object({
  evidenceClass: z.literal("calculated"),
  provider: z.literal("celestrak"),
  propagationLibrary: z.string().trim().min(1),
  propagationVersion: z.string().trim().min(1),
  noradId: z.string().regex(/^\d{1,9}$/),
  name: z.string().trim().min(1),
  group: celestrakGroupSchema,
  elementEpoch: z.iso.datetime({ offset: true }),
  sourceRetrievedAt: z.iso.datetime({ offset: true }),
  riseAt: z.iso.datetime({ offset: true }),
  setAt: z.iso.datetime({ offset: true }),
  riseAzimuthDeg: z.number().finite().min(0).lt(360),
  setAzimuthDeg: z.number().finite().min(0).lt(360),
  peakAt: z.iso.datetime({ offset: true }),
  peakElevationDeg: z.number().finite().min(0).max(90),
  peakAzimuthDeg: z.number().finite().min(0).lt(360),
  durationSeconds: z.number().finite().positive(),
});

export type SatellitePass = z.infer<typeof satellitePassSchema>;

export const satelliteResponseSchema = z.object({
  calculatedAt: z.iso.datetime({ offset: true }),
  observer: observerSchema,
  sources: z.array(z.object({
    provider: z.literal("celestrak"),
    group: celestrakGroupSchema,
    retrievedAt: z.iso.datetime({ offset: true }),
    sourceUrl: z.url(),
  })),
  satellites: z.array(propagatedSatelliteSchema),
  limitations: z.array(z.string().min(1)),
});

export const satellitePassResponseSchema = z.object({
  calculatedAt: z.iso.datetime({ offset: true }),
  windowStart: z.iso.datetime({ offset: true }),
  windowEnd: z.iso.datetime({ offset: true }),
  observer: observerSchema,
  passes: z.array(satellitePassSchema).max(500),
  limitations: z.array(z.string().min(1)),
});

export function parseTleEpoch(line1: string): string {
  if (!line1.startsWith("1 ") || line1.length < 32) throw new Error("Invalid TLE line 1");
  const epochField = line1.slice(18, 32).trim();
  if (!/^\d{5}\.\d+$/.test(epochField)) throw new Error("Invalid TLE epoch field");

  const twoDigitYear = Number(epochField.slice(0, 2));
  const dayOfYear = Number(epochField.slice(2));
  if (!Number.isFinite(dayOfYear) || dayOfYear < 1 || dayOfYear >= 367) throw new Error("Invalid TLE day of year");

  // TLE convention: 57-99 => 1957-1999, 00-56 => 2000-2056.
  const year = twoDigitYear >= 57 ? 1900 + twoDigitYear : 2000 + twoDigitYear;
  const start = Date.UTC(year, 0, 1);
  const epochMs = start + (dayOfYear - 1) * 86_400_000;
  return new Date(epochMs).toISOString();
}

export function noradIdFromTle(line1: string, line2: string): string {
  if (!line1.startsWith("1 ") || !line2.startsWith("2 ")) throw new Error("Invalid TLE line prefixes");
  const line1Id = line1.slice(2, 7).trim();
  const line2Id = line2.slice(2, 7).trim();
  if (!/^\d{1,5}$/.test(line1Id) || line1Id !== line2Id) throw new Error("TLE catalog number mismatch");
  return line1Id;
}

export function parseCelestrakTleText(input: {
  text: string;
  group: CelestrakGroup;
  retrievedAt: string;
  sourceUrl: string;
}): SatelliteSourceRecord[] {
  const group = celestrakGroupSchema.parse(input.group);
  const retrievedAt = z.iso.datetime({ offset: true }).parse(input.retrievedAt);
  const sourceUrl = z.url().parse(input.sourceUrl);
  const lines = input.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const records: SatelliteSourceRecord[] = [];

  for (let index = 0; index < lines.length;) {
    const candidate = lines[index]!;
    let name: string;
    let line1: string;
    let line2: string;

    if (candidate.startsWith("1 ")) {
      // 2LE responses omit names. AIRIntel does not invent names; use catalog ID as a neutral identifier.
      line1 = candidate;
      line2 = lines[index + 1] ?? "";
      const noradId = noradIdFromTle(line1, line2);
      name = `NORAD ${noradId}`;
      index += 2;
    } else {
      name = candidate.replace(/^0\s+/, "").trim();
      line1 = lines[index + 1] ?? "";
      line2 = lines[index + 2] ?? "";
      index += 3;
    }

    const noradId = noradIdFromTle(line1, line2);
    records.push(satelliteSourceRecordSchema.parse({
      provider: "celestrak",
      group,
      noradId,
      name,
      tleLine1: line1,
      tleLine2: line2,
      elementEpoch: parseTleEpoch(line1),
      retrievedAt,
      sourceUrl,
    }));
  }

  return records;
}
