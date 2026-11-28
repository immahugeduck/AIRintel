# AIRIntel implementation prompt — owner-locked refinement

Reviewed against main 5a5264e on 2026-11-28. Re-check the repository before reusing this prompt.

## Extraction

React 19 / Vite 7 / strict TypeScript / plain CSS / TanStack Query 5 / Zod 4.
Leaflet with react-leaflet and Mapbox Static Tiles. Hono API; Neon Auth JWT verification,
access grants; Neon Postgres/PostGIS through pg and raw SQL. Provider adapters normalize readsb feeds.
No Next.js, Tailwind, shadcn, or ORM is present. Package version ranges are declarations, not guarantees
of the resolved version. See package-lock.json for the installed graph.

## Refined prompt

Implement these priorities in order:

**1a — Reliable recording.** Trace the real provider → adapter → recorder → per-account encounter path.
Collect a bounded context outside the watch circle so approaches, departures and observed exits are retained.
Increment encounter counts on first observed entry, observed outside-to-inside re-entry, or the documented
reception-gap rule; never increment for each polling update. Preserve idempotency across live polling and sweeps.
Keep browser geolocation separate from fixed/background watch centers. Do not overwrite old evidence.

**1b — Encounter replay.** Let users select saved encounters and request retained observations from their
historical time window, with bounded approach/departure context. Add time-based scrubbing and play/pause,
keyboard-operable controls, explicit coverage/truncation/retention limitations and mobile map visibility.
Refresh active selected tracks without erasing usable data during refresh or resetting the selected timestamp.
Use the saved center when available; label unknown historical centers and moving-center limitations.
Keep source streams and reception gaps separate. Preserve closest-point altitude/speed/distance snapshots.

**2 — Aircraft and unique-encounter intelligence.** Build on existing deterministic pattern and pass-signature
analysis, with local type frequency, sourced military classifications, recurrent entries, orbits, dwell,
location/control comparison and routine alternative explanations. Label rarity by dataset, sample size,
missing types and scope; do not turn local frequency into a worldwide rarity claim. Expose behavior that
can justify investigating surveillance potential, but keep intent and numerical surveillance likelihood
Unknown without independent supporting evidence. A military flag, owner, missing callsign or route pattern
alone does not establish purpose, equipment use, occupants, or targeting.

Read AGENTS.md and the required architecture/domain/provider documents before changing architecture.
Inspect src/App.tsx, src/components/{ReplayPanel,LiveMap,NettedPanel}.tsx, src/api/history.ts,
src/domain/{aircraft,netted,patterns,pass-signature,encounter-compare}.ts,
server/{recorder,live-recording,encounters,net-sweep,patterns}.ts, server/routes/{aircraft,history}.ts,
and relevant SQL migrations/tests. Verify contracts before adding endpoints or changing DTOs.

Include loading, refresh, empty, configuration-required, unauthenticated, access-denied and error states.
Keep mobile support from 360px, labeled controls, keyboard access, 44px targets and reduced-motion support.
Run npm run typecheck, npm test and npm run build; report skips and actual end-to-end evidence separately.
Create a reviewable PR and, when authorized and checks pass, merge main and verify Vercel's exact merge SHA.

Output findings with file references, changed files, additional files/migrations, environment-variable names
without values, check results, assumptions, blockers and next task. When returning code outside a repository,
provide complete changed-file contents rather than placeholders.

Hard constraints:
- Owner approval is required before adding or changing any dependencies or lockfile graph.
- Keep the existing stack, provider adapter boundary, Zod validation, strict TypeScript, RLS, server-only DB access,
  JWT verification and access grants. Never expose server secrets through VITE_* or commits.
- Preserve raw vs normalized data, provider identity/schema, UTC observed/received timestamps and aviation units.
- Use Observed, Calculated, Supported inference and Unknown; never invent real-world aircraft/history/evidence.
- Do not connect solid segments across reception gaps or source streams, fabricate probabilities, invent
  endpoints/package versions, rewrite historical evidence, or run production migrations without authorization.
