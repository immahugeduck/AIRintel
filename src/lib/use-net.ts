import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { NetNotMigratedError, fetchWatchArea, saveWatchArea } from "../api/net";
import type { WatchAreaResponse } from "../domain/net";
import { AccessDeniedError, AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";
import type { WatchArea } from "./watch-area";

export type NetControlState =
  | { kind: "signed-out" }
  | { kind: "loading" }
  | { kind: "unavailable"; reason: "no-access" | "unconfigured" | "not-migrated" | "error"; message: string }
  | { kind: "ready"; data: WatchAreaResponse };

const sameArea = (a: { latitude: number; longitude: number; radiusMi: number }, b: { latitude: number; longitude: number; radiusMi: number }) =>
  Math.abs(a.latitude - b.latitude) < 1e-5 && Math.abs(a.longitude - b.longitude) < 1e-5 && Math.abs(a.radiusMi - b.radiusMi) < 1e-9;

export function describeNetError(error: unknown): NetControlState & { kind: "unavailable" } {
  if (error instanceof AccessDeniedError) return { kind: "unavailable", reason: "no-access", message: "Your account needs the history access grant before the net can run while the app is closed." };
  if (error instanceof ProviderNotConfiguredError) return { kind: "unavailable", reason: "unconfigured", message: "Sign-in or the database is not configured for this deployment, so the always-on net is unavailable." };
  if (error instanceof NetNotMigratedError) return { kind: "unavailable", reason: "not-migrated", message: error.message };
  return { kind: "unavailable", reason: "error", message: error instanceof Error ? error.message : "The net status could not be loaded." };
}

/**
 * Server-side net state for the signed-in user plus the enable/pause mutation.
 * While the net is enabled, changing the saved location/radius in this browser re-saves it (debounced) so the sweep
 * follows the user. A browser still on the unsaved default area never overwrites a saved server-side area.
 */
export function useNet(signedIn: boolean, area: WatchArea) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["watch-area"],
    queryFn: ({ signal }) => fetchWatchArea(signal),
    enabled: signedIn,
    refetchInterval: 60_000,
    retry: (count, error) => count < 1 && !(error instanceof AccessDeniedError || error instanceof AuthenticationRequiredError || error instanceof NetNotMigratedError || error instanceof ProviderNotConfiguredError),
  });
  const mutation = useMutation({
    mutationFn: saveWatchArea,
    onSuccess: (data) => { client.setQueryData(["watch-area"], data); void client.invalidateQueries({ queryKey: ["netted-aircraft"] }); },
  });
  const [saveError, setSaveError] = useState<string | null>(null);

  const saved = query.data?.watchArea ?? null;
  const setEnabled = async (enabled: boolean) => {
    setSaveError(null);
    // Toggling uses this browser's area, except a still-default browser must not clobber an already saved area.
    const source = enabled && area.source === "default" && saved ? saved : area;
    try {
      await mutation.mutateAsync({ latitude: source.latitude, longitude: source.longitude, radiusMi: source.radiusMi, enabled });
    } catch (error) {
      setSaveError(describeNetError(error).message);
    }
  };

  const syncKey = saved?.enabled && area.source !== "default" && area.updatedAt && Date.parse(area.updatedAt) > Date.parse(saved.updatedAt) && !sameArea(area, saved)
    ? `${area.latitude}:${area.longitude}:${area.radiusMi}` : null;
  const latest = useRef({ area, mutate: mutation.mutate });
  latest.current = { area, mutate: mutation.mutate };
  useEffect(() => {
    if (!syncKey) return;
    const timer = setTimeout(() => {
      const { area: current, mutate } = latest.current;
      mutate({ latitude: current.latitude, longitude: current.longitude, radiusMi: current.radiusMi, enabled: true }, { onError: (error) => setSaveError(describeNetError(error).message) });
    }, 1_500);
    return () => clearTimeout(timer);
  }, [syncKey]);

  const state: NetControlState = !signedIn ? { kind: "signed-out" }
    : query.data ? { kind: "ready", data: query.data }
      : query.isError ? describeNetError(query.error)
        : { kind: "loading" };
  return { state, saving: mutation.isPending, saveError, setEnabled, status: query.data?.net ?? null };
}

/** Re-renders every `intervalMs` so relative times ("2 min ago") stay fresh. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
