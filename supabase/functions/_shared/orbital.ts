import * as sat from "npm:satellite.js@7.0.1";

export const PROPAGATION_LIBRARY = "satellite.js";
export const PROPAGATION_VERSION = "7.0.1";
export const CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/gp.php";
export const DEFAULT_GROUPS = ["STATIONS", "VISUAL", "WEATHER", "IRIDIUM-NEXT"] as const;
export type CelestrakGroup = typeof DEFAULT_GROUPS[number];

export type TleRecord = {
  provider: "celestrak";
  group: CelestrakGroup;
  noradId: string;
  name: string;
  tleLine1: string;
  tleLine2: string;
  elementEpoch: string;
  retrievedAt: string;
  sourceUrl: string;
};

export type Observer = { latitude: number; longitude: number; heightKm: number };

export type PropagatedSatellite = {
  evidenceClass: "calculated";
  provider: "celestrak";
  propagationLibrary: string;
  propagationVersion: string;
  noradId: string;
  name: string;
  group: CelestrakGroup;
  calculatedAt: string;
  elementEpoch: string;
  sourceRetrievedAt: string;
  latitude: number;
  longitude: number;
  altitudeKm: number;
  velocityKmS: number;
  elevationDeg: number;
  azimuthDeg: number;
  rangeKm: number;
  aboveHorizon: boolean;
};

export type SatellitePass = {
  evidenceClass: "calculated";
  provider: "celestrak";
  propagationLibrary: string;
  propagationVersion: string;
  noradId: string;
  name: string;
  group: CelestrakGroup;
  elementEpoch: string;
  sourceRetrievedAt: string;
  riseAt: string;
  setAt: string;
  riseAzimuthDeg: number;
  setAzimuthDeg: number;
  peakAt: string;
  peakElevationDeg: number;
  peakAzimuthDeg: number;
  durationSeconds: number;
};

type CacheEntry = { records: TleRecord[]; fetchedAtMs: number };
const cache = new Map<CelestrakGroup, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;

function tleEpochIso(line1: string): string {
  const field = line1.slice(18, 32).trim();
  if (!/^\d{5}\.\d+$/.test(field)) throw new Error("invalid_tle_epoch");
  const yy = Number(field.slice(0, 2));
  const day = Number(field.slice(2));
  if (!Number.isFinite(day) || day < 1 || day >= 367) throw new Error("invalid_tle_epoch");
  const year = yy >= 57 ? 1900 + yy : 2000 + yy;
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000).toISOString();
}

function tleNoradId(line1: string, line2: string): string {
  if (!line1.startsWith("1 ") || !line2.startsWith("2 ")) throw new Error("invalid_tle_lines");
  const one = line1.slice(2, 7).trim();
  const two = line2.slice(2, 7).trim();
  if (!/^\d{1,5}$/.test(one) || one !== two) throw new Error("tle_catalog_mismatch");
  return one;
}

export function celestrakUrl(group: CelestrakGroup): string {
  return `${CELESTRAK_BASE}?GROUP=${encodeURIComponent(group)}&FORMAT=TLE`;
}

export function parseTle(text: string, group: CelestrakGroup, retrievedAt: string, sourceUrl: string): TleRecord[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const records: TleRecord[] = [];
  for (let i = 0; i < lines.length;) {
    const first = lines[i]!;
    let name: string;
    let line1: string;
    let line2: string;
    if (first.startsWith("1 ")) {
      line1 = first;
      line2 = lines[i + 1] ?? "";
      const id = tleNoradId(line1, line2);
      name = `NORAD ${id}`;
      i += 2;
    } else {
      name = first.replace(/^0\s+/, "").trim();
      line1 = lines[i + 1] ?? "";
      line2 = lines[i + 2] ?? "";
      i += 3;
    }
    const noradId = tleNoradId(line1, line2);
    records.push({ provider: "celestrak", group, noradId, name, tleLine1: line1, tleLine2: line2, elementEpoch: tleEpochIso(line1), retrievedAt, sourceUrl });
  }
  return records;
}

export async function fetchCelestrakGroup(group: CelestrakGroup): Promise<TleRecord[]> {
  const cached = cache.get(group);
  if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) return cached.records;

  const sourceUrl = celestrakUrl(group);
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "text/plain",
      "User-Agent": "AIRIntel/0.1 orbital-data-adapter",
    },
  });
  if (!response.ok) throw new Error(`celestrak_http_${response.status}`);
  const retrievedAt = new Date().toISOString();
  const records = parseTle(await response.text(), group, retrievedAt, sourceUrl);
  if (records.length === 0) throw new Error("celestrak_empty_response");
  cache.set(group, { records, fetchedAtMs: Date.now() });
  return records;
}

export async function fetchCelestrakGroups(groups: CelestrakGroup[]): Promise<TleRecord[]> {
  const settled = await Promise.allSettled(groups.map(fetchCelestrakGroup));
  const records = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (records.length === 0) throw new Error("celestrak_all_groups_failed");

  // A satellite can exist in more than one CelesTrak group. Keep one record per NORAD id,
  // preferring the first requested group so the same propagated object is not returned twice.
  const byNorad = new Map<string, TleRecord>();
  for (const record of records) if (!byNorad.has(record.noradId)) byNorad.set(record.noradId, record);
  return [...byNorad.values()];
}

function observerGeodetic(observer: Observer) {
  return {
    longitude: sat.degreesToRadians(observer.longitude),
    latitude: sat.degreesToRadians(observer.latitude),
    height: observer.heightKm,
  };
}

function normalizeAzimuth(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function propagateRecord(record: TleRecord, observer: Observer, at: Date): PropagatedSatellite | null {
  try {
    const satrec = sat.twoline2satrec(record.tleLine1, record.tleLine2);
    if (satrec.error) return null;
    const pv = sat.propagate(satrec, at);
    if (!pv || !pv.position || typeof pv.position === "boolean" || !pv.velocity || typeof pv.velocity === "boolean") return null;

    const gmst = sat.gstime(at);
    const geodetic = sat.eciToGeodetic(pv.position, gmst);
    const ecf = sat.eciToEcf(pv.position, gmst);
    const look = sat.ecfToLookAngles(observerGeodetic(observer), ecf);
    const velocityKmS = Math.sqrt(pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2);
    const elevationDeg = sat.radiansToDegrees(look.elevation);

    return {
      evidenceClass: "calculated",
      provider: "celestrak",
      propagationLibrary: PROPAGATION_LIBRARY,
      propagationVersion: PROPAGATION_VERSION,
      noradId: record.noradId,
      name: record.name,
      group: record.group,
      calculatedAt: at.toISOString(),
      elementEpoch: record.elementEpoch,
      sourceRetrievedAt: record.retrievedAt,
      latitude: sat.degreesLat(geodetic.latitude),
      longitude: sat.degreesLong(geodetic.longitude),
      altitudeKm: geodetic.height,
      velocityKmS,
      elevationDeg,
      azimuthDeg: normalizeAzimuth(sat.radiansToDegrees(look.azimuth)),
      rangeKm: Math.max(0, look.rangeSat),
      aboveHorizon: elevationDeg >= 0,
    };
  } catch {
    return null;
  }
}

function lookAt(satrec: sat.SatRec, observer: Observer, atMs: number): { elevationDeg: number; azimuthDeg: number } | null {
  try {
    const at = new Date(atMs);
    const pv = sat.propagate(satrec, at);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;
    const gmst = sat.gstime(at);
    const ecf = sat.eciToEcf(pv.position, gmst);
    const look = sat.ecfToLookAngles(observerGeodetic(observer), ecf);
    return { elevationDeg: sat.radiansToDegrees(look.elevation), azimuthDeg: normalizeAzimuth(sat.radiansToDegrees(look.azimuth)) };
  } catch {
    return null;
  }
}

function refineHorizonCrossing(satrec: sat.SatRec, observer: Observer, leftMs: number, rightMs: number, rising: boolean): number {
  let left = leftMs;
  let right = rightMs;
  for (let i = 0; i < 18; i += 1) {
    const mid = (left + right) / 2;
    const look = lookAt(satrec, observer, mid);
    if (!look) break;
    if (rising) {
      if (look.elevationDeg >= 0) right = mid; else left = mid;
    } else {
      if (look.elevationDeg >= 0) left = mid; else right = mid;
    }
  }
  return (left + right) / 2;
}

export function predictPassesForRecord(record: TleRecord, observer: Observer, startMs: number, endMs: number): SatellitePass[] {
  if (endMs <= startMs) return [];
  const satrec = sat.twoline2satrec(record.tleLine1, record.tleLine2);
  if (satrec.error) return [];

  const coarseStepMs = 60_000;
  const passes: SatellitePass[] = [];
  let previousAt = startMs;
  let previous = lookAt(satrec, observer, startMs);
  let riseAt: number | null = previous && previous.elevationDeg >= 0 ? startMs : null;

  for (let currentAt = startMs + coarseStepMs; currentAt <= endMs; currentAt += coarseStepMs) {
    const current = lookAt(satrec, observer, currentAt);
    if (!previous || !current) {
      previous = current;
      previousAt = currentAt;
      continue;
    }

    if (previous.elevationDeg < 0 && current.elevationDeg >= 0) {
      riseAt = refineHorizonCrossing(satrec, observer, previousAt, currentAt, true);
    } else if (previous.elevationDeg >= 0 && current.elevationDeg < 0 && riseAt != null) {
      const setAt = refineHorizonCrossing(satrec, observer, previousAt, currentAt, false);
      const riseLook = lookAt(satrec, observer, riseAt);
      const setLook = lookAt(satrec, observer, setAt);
      if (riseLook && setLook && setAt > riseAt) {
        let peakAt = riseAt;
        let peak = riseLook;
        for (let sampleAt = riseAt; sampleAt <= setAt; sampleAt += 10_000) {
          const sample = lookAt(satrec, observer, sampleAt);
          if (sample && sample.elevationDeg > peak.elevationDeg) {
            peak = sample;
            peakAt = sampleAt;
          }
        }
        const exactSet = lookAt(satrec, observer, setAt);
        if (exactSet && exactSet.elevationDeg > peak.elevationDeg) {
          peak = exactSet;
          peakAt = setAt;
        }
        passes.push({
          evidenceClass: "calculated",
          provider: "celestrak",
          propagationLibrary: PROPAGATION_LIBRARY,
          propagationVersion: PROPAGATION_VERSION,
          noradId: record.noradId,
          name: record.name,
          group: record.group,
          elementEpoch: record.elementEpoch,
          sourceRetrievedAt: record.retrievedAt,
          riseAt: new Date(riseAt).toISOString(),
          setAt: new Date(setAt).toISOString(),
          riseAzimuthDeg: riseLook.azimuthDeg,
          setAzimuthDeg: setLook.azimuthDeg,
          peakAt: new Date(peakAt).toISOString(),
          peakElevationDeg: Math.max(0, peak.elevationDeg),
          peakAzimuthDeg: peak.azimuthDeg,
          durationSeconds: (setAt - riseAt) / 1000,
        });
      }
      riseAt = null;
    }

    previous = current;
    previousAt = currentAt;
  }

  return passes;
}
