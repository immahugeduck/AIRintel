import { useEffect, useRef, useState } from "react";
import { geolocationErrorMessage, recenterOn, shouldRecenter, type WatchArea } from "./watch-area";

export type FollowState =
  | { kind: "off" }
  | { kind: "waiting" }
  | { kind: "following"; lastFixAt: string; accuracyM: number | null }
  | { kind: "error"; message: string };

/**
 * Follow me: while `area.followMe` is on and the app is open, watches the device position and re-centers the watch
 * area when a precise fix is more than FOLLOW_RECENTER_MI away. Moving the area goes through `onChange`, so it is
 * stored in this browser and (signed in) saved to the account by useNet, which moves the always-on net and makes
 * every later encounter record that location as its center. Geolocation is only requested after the user turns
 * follow me on (an explicit tap), never on load.
 */
export function useFollowMe(area: WatchArea, onChange: (next: WatchArea) => void): FollowState {
  const [state, setState] = useState<FollowState>({ kind: "off" });
  const latest = useRef({ area, onChange });
  latest.current = { area, onChange };
  const enabled = area.followMe === true;

  useEffect(() => {
    if (!enabled) { setState({ kind: "off" }); return; }
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) { setState({ kind: "error", message: geolocationErrorMessage(null) }); return; }
    setState({ kind: "waiting" });
    const id = navigator.geolocation.watchPosition(
      (position) => {
        const fix = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null };
        setState({ kind: "following", lastFixAt: new Date(position.timestamp || Date.now()).toISOString(), accuracyM: fix.accuracyM });
        const { area: current, onChange: change } = latest.current;
        if (current.followMe && shouldRecenter(current, fix)) change(recenterOn(current, fix));
      },
      (error) => setState({ kind: "error", message: geolocationErrorMessage(error.code) }),
      { enableHighAccuracy: true, timeout: 30_000, maximumAge: 60_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  return state;
}
