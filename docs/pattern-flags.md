# Pattern flags (`pattern-flags-v5`)

## v5 additions (2026-11-14)

Three signals, all measured against the radius **on your phone** (follow-mode sightings; when no sighting is tagged
`follow`, all sightings are used and the reason says the mode was not recorded):

- **`consecutive_days`** (Observed): seen on 5+ consecutive local days: +2, 7+: +3. Training fleets, charter and
  mostly-airport traffic: +1. Scheduled flight numbers: not scored.
- **`same_day_repeat`** (Observed): came back 2+ hours after its previous pass on the same local day. On 1–2 days +1,
  on 3+ days +2 (training/charter/airport: 0, or +1 at 3+ days). Passes minutes apart are one pass.
- **`close_dip`** (Calculated): inside 2 mi (1.74 NM) of the watch center, altitude fell ≥ 300 ft and/or ground speed
  fell ≥ 15 kt versus the last positions before entering that zone, **and recovered at least half the drop** after
  leaving it. Without recovery it is a descent (arrival), not a dip. One kind on any visit +1, both on one visit +2,
  both on 2+ visits +3 (trainers one less, minimum 1; trainers practice slow flight and descents). Both-kind dips on 2+
  visits are a `not_explained` context mismatch. Airport-area visits are not checked (approaches descend). Needs
  positions on both sides of the 2 mi zone. Every assessment reports coverage: `no_close_dip` (Calculated, 0) counts
  passes checked without a dip, `dip_unknown` (Unknown, 0) counts passes that could not be checked. In practice
  passes recorded with the app open (~20 s polling) are checkable; always-on net sweeps (1–2 positions) usually are
  not. A traversal's before/after samples stop at the zone boundary, so a re-entry never counts as recovery. Altitude is barometric as reported
  (25 ft steps, uncorrected for local pressure), which is why the threshold is 300 ft.

**Touch-and-go and near-field dips (2026-11-14).** A dip's low point is classified (`dipContext`):
reported on the ground (provider "ground", stored as 0 ft) or within 100 ft of a known field's elevation within 1 NM →
`touch_and_go` (0, not scored). Within 1 NM of a field but higher → `near_field_dip`, 0.5 per pass, max 1.5 (a low pass
or go-around looks like a dip). Elsewhere → full `close_dip`. Fields = `KNOWN_AIRSTRIPS` (private strips; empty until
entries are verified against FAA data) + `KNOWN_AIRPORTS`. Passes over public airports are usually airport-area visits
and not dip-checked at all, so in practice the 0.5 rule applies to private strips. GPS altitude is height above the
WGS-84 ellipsoid (roughly 50–115 ft below sea-level altitude in the US, and some transponders correct it), so "within
100 ft" can include low passes up to ~200 ft above the field.

**Control circles (2026-11-14).** Floor lowered from 10 mi to 3 mi and edge margin from 1 mi to 0.5 mi; circles still
may not overlap the watch circle or a regular place. Follow-me places now block a control only if used on 2+ local days
in the last 30 (driving through once no longer counts).

The v4 notes below still apply.

## v4 notes (pattern-flags-v4)

## v4 in one paragraph (2026-11-14)

Score **behavior**; treat **who the aircraft is** as context that has to fit what it did. Training-fleet and charter
labels lower the score (−3) but no longer force `routine`. Airport explanations are judged **per visit**: visits flown
within 3 NM of a known field at pattern height (`airport_area`) are not scored for circling, loitering or low/slow,
and every other visit is scored normally. Signals no label explains keep full weight: `followed_locations`,
`centered_orbit` away from airports (2+ visits for trainers), `control_absent`, and circling away from airports by a
charter jet or by mostly-airport traffic. Each assessment carries `context` (the label) and `fit`
(`consistent` / `not_explained`). A `not_explained` fit never sits below **Review**, so a mismatch is always
visible. Only published scheduled/cargo flight numbers still force `routine`. Added airports 2R2 (Danville) and
KGPC (Greencastle), and the BOLDFlight fleet (by FAA owner name).

**Known limit (Unknown):** an aircraft that only ever circles near an airport you happen to be close to is scored as
airport traffic. Control circles and `followed_locations` are the checks that still work there.

The v3 description below remains accurate for geometry, location correlation, identity and control passes; where it
says labels or airport patterns force `routine`, v4 replaces that.

# Pattern flags (v3 reference)

A deterministic review-priority ranking for netted aircraft. Code: `src/domain/patterns.ts` (pure scoring),
`src/domain/pattern-config.ts` (all regional lists and airports), `server/patterns.ts` (loads inputs), surfaced on
`GET /history?action=netted` as `aircraft[].pattern` plus a response-level `patternStatus`.

**What it is not.** Per AGENTS.md this never claims intent, mission, sensor use or surveillance. Training aircraft
fly turns around a point on purpose; medical, news, survey, pipeline and police flights loiter. A high score means
"look at this one first". Every reason carries an evidence label (Observed / Calculated / Supported inference / Unknown).

## Passes

1. **Routine explanations (weed out, never overridden).** Scheduled airline/cargo flight numbers, fractional/charter
   jets, and local training fleets matched by callsign designator, registration pattern or FAA owner name
   (`TRAINING_FLEETS`: LIFT Academy `LTA`, Vincennes University `N…VU`, Purdue `PDU` / `N…PU` / Purdue owner names,
   Indiana State `ISU`, ATP `CXK` / ATP owner, Tom Wood Aviation `N…TW`). The FAA registration is used when the aircraft
   did not broadcast one. Also: airport traffic pattern (`airport_pattern`, −3: within 3 NM of a `KNOWN_AIRPORTS` field
   and median altitude ≤ field elevation + 2,500 ft), cruise transit (−3), steady climb/descent (−2). A routine
   aircraft keeps tier `routine` (score capped at 0) even if it circles, loiters or shows up at several of your places.
2. **Behavior from geometry.** Circling is judged from positions, not reported track, so it works at 5 s, 60 s and
   5 min sampling: a visit is assessable with ≥ 3 positions over ≥ 3 min. `circling` (+3) is either a winding
   (bearing around the visit centroid turns ≥ 300° net, every step ≤ 120°, spread ≤ 3 NM, ≥ 40 kt) or a confined
   track (≥ 5 min, ≥ 40 kt, spread ≤ 2.5 NM, distance flown ≥ a full circle of that spread). Hovering/parked
   aircraft are not "circling". `centered_orbit` (+2, orbit within 2 NM of the watch center), `loiter` (+2/+3),
   `low_slow` (+1, needs ≥ 3 positions).
3. **Correlation with your locations (time-aware).** `followed_locations` (+4, +5 when on ≥ 2 local days) needs pairs
   of sightings at your watch centers ≥ 20 NM apart **within 6 hours of each other**, so "flew near home in May and
   near work in June" no longer counts. `separate_places` (+1) is the weaker "seen at several places" fact.
4. **Identity facts.** adsb.lol `dbFlags` from the stored raw payloads (`military_flag` +2, `privacy_address` PIA +1,
   `ladd` +1), FAA owner type (`government_owner` +2 for government registrants, but not universities/colleges/
   schools), rotorcraft (`rotorcraft_loiter` +1, ADS-B category A7 or FAA aircraft type 6, only when it also circles or
   loiters), identity gaps (+1). The FAA model is shown as the type when no ICAO type code was broadcast.
5. **Control comparison.** Control circles must not overlap your watch circle or any watch center used on 2+ local days in
   the last 30 (follow me history): center distance ≥ max(3 mi, both radii + 0.5 mi). Sightings are counted per local day
   (America/Indianapolis). `control_common` −2, `control_absent` +1, as in v2.

Plus recurrence (+2, ≥ 5 entries on ≥ 3 local days; 0 for routine aircraft). Days are counted in
`PATTERN_TIME_ZONE` (America/Indianapolis), not UTC.

**Tiers:** `routine` (pass 1), `priority` (score ≥ 7; capped at `review` when coverage is sparse and there is no
`followed_locations`), `review` (≥ 4), `insufficient` ("Not enough data": no assessable visit and no positive
behavioral reason), `low`. Coverage is `ok` / `limited` / `sparse`.

**Loading.** Log scope scores the newest 20 encounters per aircraft with their positions, evenly downsampled to 180
per visit (`downsampled` reason), and up to 500 saved sightings per aircraft for pass 3, in chunks of 40 aircraft (no
global row cap). `patternStatus` is `ok`, `partial` (flags or controls could not be loaded; scores still shown) or
`failed` (some aircraft could not be scored); the panel shows a notice instead of silently dropping them.

## Limitations (Unknown, not guessed)

- **Follow me** re-centers the watch circle while the app is open; each encounter stores its center and
  `center_mode` (`follow` / `fixed`, migration 0007). While the app is closed the always-on net keeps the last center.
  `GET /health` reports `net.writer` (`stale_suspected` when new sweep encounters lack the tag, meaning an older
  deployment is running the sweep) and `build` (commit of the running deployment); the sweep response carries `build`.
- Most sweep visits have 1–2 positions; such aircraft get `insufficient` or `limited` coverage rather than a guess.
- Fleet, operator and airport lists are regional defaults in `src/domain/pattern-config.ts`.

## UI and export

Netted cards show a badge (Priority review / Review / Not enough data / Routine · reason) and a "Why flagged" list. A filter row offers
All / Flagged / Hide routine (sorted by tier then score). CSV adds `latest_entry_center_lat/lon`, `pattern_tier`,
`pattern_score`, `pattern_reasons`.
