# AIRIntel agent instructions

Read `docs/AIRROUTE_PROJECT_BRIEF.md`, `docs/architecture.md`, and `docs/provider-onboarding.md` before architectural or aviation-domain changes.

## Non-negotiable rules

- Never create simulated or mock aircraft, routes, provider payloads, or historical records without explicit user permission.
- Prefer deterministic calculations over AI guesses.
- Keep raw source observations, normalized observations, reconstructed flights, and analytical findings separate.
- Preserve provider identity, provider schema version, observed timestamp, and received timestamp.
- Use the evidence vocabulary **Observed**, **Calculated**, **Supported inference**, and **Unknown**.
- Never claim aircraft intent, passenger identity, surveillance, sensor use, or mission purpose from route geometry alone.
- Keep aircraft providers behind an adapter contract and provider secrets server-side.
- Validate external data and user input with Zod. TypeScript stays in strict mode.
- Use UTC internally and explicit aviation units in names.
- Do not connect solid track segments across reception gaps.
- Enable RLS on every table and keep browser-facing database roles (Neon Data API `authenticated`/`anonymous`) at zero privileges; all data access goes through the server API after Neon Auth JWT verification and an `access_grants` check.
- Never commit credentials or place server secrets in `VITE_*` variables.

## User-locked project priorities

1a. Reliable live recording; 1b. encounter replay, including recorded approach and departure.
2. Unique-encounter intelligence: scoped local rarity, sourced military classification, and evidence-based behavioral review.

- Count observed radius entries, not polling updates; preserve outside context for exits and re-entry.
- New dependencies and dependency changes require the owner's explicit approval first, including lockfile changes.
- Surveillance purpose and numerical likelihood remain Unknown without independent evidence; route geometry and military flags alone cannot establish them.

## Completion checks

Run `npm run typecheck`, `npm test`, and `npm run build`. Report files changed, commands, results, assumptions, blockers, and the next recommended task.
