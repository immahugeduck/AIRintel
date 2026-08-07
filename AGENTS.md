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
- Enable RLS on every table in an exposed Supabase schema; browser roles receive least privilege.
- Never commit credentials or place server secrets in `VITE_*` variables.

## Completion checks

Run `npm run typecheck`, `npm test`, and `npm run build`. Report files changed, commands, results, assumptions, blockers, and the next recommended task.
