import { minutesInside, straightPassMinutes } from "./encounter-compare.js";
import { compassPoint } from "./geometry.js";
import type { NettedAircraft, NettedVisit } from "./netted.js";

/**
 * Pass signatures (`pass-signature-v1`): a coarse, deterministic summary of HOW an aircraft passed through the radius,
 * built only from each entry's closest-point snapshot (Observed) and timing (Calculated). Grouping one aircraft's
 * passes by signature gives its habits; grouping across aircraft gives the common lanes over the user's location.
 *
 * Bands are deliberately wide: with ~1-minute sampling and provider noise, narrow bands would make every pass unique
 * and nothing would group. A signature describes behavior; it never identifies an aircraft (the ICAO24 address does)
 * and never says why it flew that way.
 */
export const PASS_SIGNATURE_VERSION = "pass-signature-v1";

export type AltitudeBand = "ground" | "under-1k" | "1k-3k" | "3k-10k" | "10k-plus";
export type SpeedBand = "slow" | "light" | "fast" | "very-fast";
export type Heading = ReturnType<typeof compassPoint>;
export type Side = "N" | "E" | "S" | "W" | "over";
export type Dwell = "transit" | "slowed" | "lingered";
export type DayPart = "night" | "morning" | "afternoon" | "evening";

/** Band edges in explicit units. */
export const SIGNATURE_BANDS = {
  altitudeFt: { under1k: 1_000, to3k: 3_000, to10k: 10_000 },
  speedKt: { slow: 60, light: 140, fast: 250 },
  /** Time inside ÷ straight-pass time at the recorded speed. */
  dwell: { slowed: 1.5, lingered: 3 },
  /** A pass within this fraction of the radius from the center is "over" the center rather than on a side. */
  overCenterFraction: 0.1,
  /** "New pattern": the aircraft has at least this many signed passes and this path appears only once among them. */
  newPatternMinPasses: 5,
  /** A lane is a path flown by at least this many different aircraft. */
  laneMinAircraft: 3,
} as const;

export type PassSignature = {
  altitude: AltitudeBand;
  speed: SpeedBand;
  heading: Heading;
  side: Side;
  /** Null when the speed was too low/unknown for a straight-pass comparison or the pass was a single sighting. */
  dwell: Dwell | null;
  dayPart: DayPart;
  weekend: boolean;
  /** Path key used for habits and lanes: altitude | speed | heading | side. */
  key: string;
};

const altitudeBand = (feet: number, onGround: boolean | null): AltitudeBand => {
  const B = SIGNATURE_BANDS.altitudeFt;
  if (onGround === true) return "ground";
  return feet < B.under1k ? "under-1k" : feet < B.to3k ? "1k-3k" : feet < B.to10k ? "3k-10k" : "10k-plus";
};

const speedBand = (knots: number): SpeedBand => {
  const B = SIGNATURE_BANDS.speedKt;
  return knots < B.slow ? "slow" : knots < B.light ? "light" : knots < B.fast ? "fast" : "very-fast";
};

const SIDES = ["N", "E", "S", "W"] as const;

function localParts(iso: string, timeZone?: string): { hour: number; weekend: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", { ...(timeZone ? { timeZone } : {}), hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  return { hour, weekend: weekday === "Sat" || weekday === "Sun" };
}

const dayPartOf = (hour: number): DayPart => (hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening");

/**
 * Signature of one entry, or null when the snapshot lacks altitude, speed or heading (those passes are "unsigned" and
 * left out of habits and lanes rather than guessed).
 */
export function signPass(visit: NettedVisit, radiusMi: number | null | undefined, timeZone?: string): PassSignature | null {
  const point = visit.closest;
  if (!point) return null;
  const onGround = point.onGround;
  if (point.groundSpeedKt === null || point.trackDeg === null || (point.altitudeFt === null && onGround !== true)) return null;
  const altitude = altitudeBand(point.altitudeFt ?? 0, onGround);
  const speed = speedBand(point.groundSpeedKt);
  const heading = compassPoint(point.trackDeg);
  const radius = visit.radiusMi ?? radiusMi ?? null;
  const side: Side = point.bearingFromCenterDeg === null || (radius !== null && visit.closestMi <= radius * SIGNATURE_BANDS.overCenterFraction)
    ? "over"
    : SIDES[Math.round((((point.bearingFromCenterDeg % 360) + 360) % 360) / 90) % 4]!;
  const straight = straightPassMinutes(visit, radius);
  const stayed = minutesInside(visit);
  const dwell: Dwell | null = straight === null || (visit.observationCount <= 1 && stayed === 0) ? null
    : stayed >= straight * SIGNATURE_BANDS.dwell.lingered ? "lingered"
      : stayed >= straight * SIGNATURE_BANDS.dwell.slowed ? "slowed" : "transit";
  const { hour, weekend } = localParts(point.at, timeZone);
  return { altitude, speed, heading, side, dwell, dayPart: dayPartOf(hour), weekend, key: [altitude, speed, heading, side].join("|") };
}

export type Habit = {
  key: string;
  /** Representative signature (the newest pass with this path). */
  signature: PassSignature;
  count: number;
  dayParts: Record<DayPart, number>;
  weekendCount: number;
  dwell: Record<Dwell, number>;
};

export type AircraftHabits = {
  /** Passes that could be signed (have altitude, speed and heading at the closest point). */
  signed: number;
  /** Habits, most frequent first (ties: most recent first). */
  habits: Habit[];
  /** Signature per entry, aligned with the aircraft's `visits` array (null = unsigned). */
  perVisit: (PassSignature | null)[];
};

const emptyDayParts = (): Record<DayPart, number> => ({ night: 0, morning: 0, afternoon: 0, evening: 0 });
const emptyDwell = (): Record<Dwell, number> => ({ transit: 0, slowed: 0, lingered: 0 });

/** Groups one aircraft's entries (newest first, as served) by path signature. */
export function aircraftHabits(visits: readonly NettedVisit[], radiusMi: number | null | undefined, timeZone?: string): AircraftHabits {
  const perVisit = visits.map((visit) => signPass(visit, radiusMi, timeZone));
  const byKey = new Map<string, Habit & { order: number }>();
  perVisit.forEach((signature, index) => {
    if (!signature) return;
    let habit = byKey.get(signature.key);
    if (!habit) {
      habit = { key: signature.key, signature, count: 0, dayParts: emptyDayParts(), weekendCount: 0, dwell: emptyDwell(), order: index };
      byKey.set(signature.key, habit);
    }
    habit.count += 1;
    habit.dayParts[signature.dayPart] += 1;
    if (signature.weekend) habit.weekendCount += 1;
    if (signature.dwell) habit.dwell[signature.dwell] += 1;
  });
  const habits = [...byKey.values()].sort((a, b) => b.count - a.count || a.order - b.order).map(({ order: _order, ...habit }) => habit);
  return { signed: perVisit.filter(Boolean).length, habits, perVisit };
}

/** True when this pass's path is new for the aircraft: enough signed history and this path seen only this once. */
export function isNewPattern(signature: PassSignature | null, habits: AircraftHabits): boolean {
  if (!signature || habits.signed < SIGNATURE_BANDS.newPatternMinPasses) return false;
  return (habits.habits.find((habit) => habit.key === signature.key)?.count ?? 0) === 1;
}

export type Lane = { key: string; signature: PassSignature; aircraft: number; passes: number };

/** Paths shared by at least `laneMinAircraft` different aircraft, most aircraft first. */
export function commonLanes(habitsByAircraft: ReadonlyMap<string, AircraftHabits>): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const habits of habitsByAircraft.values()) {
    for (const habit of habits.habits) {
      const lane = lanes.get(habit.key) ?? { key: habit.key, signature: habit.signature, aircraft: 0, passes: 0 };
      lane.aircraft += 1;
      lane.passes += habit.count;
      lanes.set(habit.key, lane);
    }
  }
  return [...lanes.values()].filter((lane) => lane.aircraft >= SIGNATURE_BANDS.laneMinAircraft).sort((a, b) => b.aircraft - a.aircraft || b.passes - a.passes);
}

/** Habits for every aircraft in the list, keyed by ICAO24. */
export function habitsForAll(aircraft: readonly NettedAircraft[], radiusMi: number | null | undefined, timeZone?: string): Map<string, AircraftHabits> {
  return new Map(aircraft.map((item) => [item.icao24, aircraftHabits(item.visits, radiusMi, timeZone)]));
}

const ALTITUDE_LABEL: Record<AltitudeBand, string> = { ground: "on the ground", "under-1k": "under 1,000 ft", "1k-3k": "1,000–3,000 ft", "3k-10k": "3,000–10,000 ft", "10k-plus": "above 10,000 ft" };
const SPEED_LABEL: Record<SpeedBand, string> = { slow: "under 60 kt", light: "60–140 kt", fast: "140–250 kt", "very-fast": "over 250 kt" };
const SIDE_LABEL: Record<Side, string> = { N: "your N side", E: "your E side", S: "your S side", W: "your W side", over: "right over your center" };
export const DAY_PART_LABEL: Record<DayPart, string> = { night: "nights", morning: "mornings", afternoon: "afternoons", evening: "evenings" };
export const DWELL_LABEL: Record<Dwell, string> = { transit: "passing straight through", slowed: "slower than a straight pass", lingered: "lingering" };

/** "1,000–3,000 ft · 60–140 kt · heading S · passes your E side" */
export function describePath(signature: PassSignature): string {
  return `${ALTITUDE_LABEL[signature.altitude]} · ${SPEED_LABEL[signature.speed]} · heading ${signature.heading} · passes ${SIDE_LABEL[signature.side]}`;
}

/** "mostly weekday afternoons" style summary of when a habit happens; null when there is no clear majority. */
export function describeWhen(habit: Habit): string | null {
  const [part, count] = (Object.entries(habit.dayParts) as [DayPart, number][]).sort((a, b) => b[1] - a[1])[0]!;
  if (count / habit.count < 0.6) return null;
  const weekendShare = habit.weekendCount / habit.count;
  const days = weekendShare >= 0.8 ? "weekend " : weekendShare <= 0.2 ? "weekday " : "";
  return `${count === habit.count ? "always" : "mostly"} ${days}${DAY_PART_LABEL[part]}`;
}
