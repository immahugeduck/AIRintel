/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  readonly VITE_MAPBOX_ACCESS_TOKEN?: string;
  readonly VITE_MAPBOX_STYLE?: string;
  readonly VITE_AIRCRAFT_API_URL?: string;
  readonly VITE_HISTORY_API_URL?: string;
  readonly VITE_PROFILE_API_URL?: string;
  readonly VITE_NEON_AUTH_URL?: string;
  /** Set by the Vercel Neon integration; used when VITE_NEON_AUTH_URL is unset. Exposed via envPrefix in vite.config.ts. */
  readonly SERVERSIDE_NEON_VITE_NEON_AUTH_URL?: string;
  readonly VITE_DEFAULT_CENTER_LAT?: string;
  readonly VITE_DEFAULT_CENTER_LON?: string;
  /** Default watch radius in statute miles (7 when unset). */
  readonly VITE_DEFAULT_RADIUS_MI?: string;
  readonly VITE_POLL_INTERVAL_SECONDS?: string;
}
