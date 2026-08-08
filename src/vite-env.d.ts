/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  readonly VITE_MAPQUEST_KEY?: string;
  readonly VITE_MAPQUEST_TILE_URL?: string;
  readonly VITE_AIRCRAFT_API_URL?: string;
  readonly VITE_HISTORY_API_URL?: string;
  readonly VITE_PROFILE_API_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_DEFAULT_CENTER_LAT?: string;
  readonly VITE_DEFAULT_CENTER_LON?: string;
  readonly VITE_DEFAULT_RADIUS_NM?: string;
  readonly VITE_POLL_INTERVAL_SECONDS?: string;
}
