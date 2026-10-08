# Deployment audit — 2026-10-07

## Confirmed failure
Production deployment `dpl_7puvBYFGZTRtzEP5xU8sUF1S8qPf` was READY and served HTML and API health responses, but Chromium reproduced an empty page and:
`Cannot read properties of undefined (reading 'layerPointToLatLng')`.
LiveMap called getBounds() on a Leaflet circle before attaching it to a map. The map-first UI change introduced this error. Bounds now use shared spherical geometry without an unmounted layer.

## Repairs
- Add application/map error boundaries so rendering failures remain visible.
- Guard cleared, invalid, and out-of-range coordinate/radius inputs; validate environment defaults and enforce a minimum polling interval.
- Keep the map mounted when the radius changes, resetting trail data without reopening the basemap dialog.
- Validate saved/public Mapbox settings; let browser storage failures fall back to session configuration and allow dismissal of setup.
- Repair the package lock and use npm ci for deterministic Vercel installs.
- Add the missing local Vite /api proxy to the actual Hono server.
- Recover from failed session checks, sign-in and sign-out; clear protected query caches after sign-out.
- Preserve typed provider-configuration errors in the live API client.
- Reuse nautical-mile geometry in radius and route calculations; exclude reception gaps and cross-provider jumps from calculated travel/loitering.
- Remove 126 lines of obsolete introductory-card/sidebar CSS.
- Stop decoding already-decoded upload filenames a second time.

## Validation
- npm ci passed using the repaired lockfile.
- npm run typecheck passed.
- npm test: 69 passed, 6 database integration tests skipped.
- npm run build passed; dependency comment and >500 kB chunk warnings remain non-blocking.
- git diff --check passed.
- Chromium: repaired map/table rendered, radius and label/trail controls worked, no page exceptions; 390px mobile page had no horizontal overflow.
- Mathematical regression tests cover nautical miles, date-line crossing, antipodes, map-free bounds and poles; existing route test now covers reception gaps and continuous reception.

## Configuration and unfinished integrations
- Production /api/health reports database=true, auth=false. Server Neon Auth configuration must be restored before protected history/profile/evidence routes can work. Required settings are NEON_AUTH_BASE_URL and matching browser VITE_NEON_AUTH_URL, plus valid user access grants. No auth checks were removed.
- The Vercel connection returned 403 when listing environment metadata. This prevents inspecting or repairing those deployment settings through the available connection.
- recordObservations is implemented but only called by integration tests, not the public live gateway. Live browsing does not populate persistent history. An authenticated ingestion worker remains necessary; wiring public browsing directly to database writes would bypass the project's access model.
- Satellite endpoints are implemented but have no frontend controls; they are documented planned functionality, not part of page loading.
- The legacy starter, Neon Function and container deployment files are not active in this Vercel deployment. They were retained rather than deleting alternative deployment support.
- Failed preview dpl_ADCRQQfRpVHc6C7JSkMM4NneVTw3 reported Resource provisioning timed out; production later succeeded. This was a Vercel infrastructure failure.

The code repairs must be merged and deployed before the production page uses them. Configuration and ingestion are separate from the repaired rendering crash.
