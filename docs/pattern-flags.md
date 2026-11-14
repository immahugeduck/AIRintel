# Pattern flags (`pattern-flags-v4`)

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
5. **Control comparison.** Control circles must not overlap your watch circle or any watch center used in the last 30
   days (follow me history): center distance ≥ max(10 mi, both radii + 1 mi). Sightings are counted per local day
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
