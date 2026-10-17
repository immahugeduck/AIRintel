import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { NetNotMigratedError, fetchWatchArea, saveWatchArea } from "../api/net";
import type { WatchAreaResponse } from "../domain/net";
import { AccessDeniedError, AuthenticationRequiredError, ProviderNotConfiguredError } from "../providers/contracts";
import { defaultWatchArea, type WatchArea } from "./watch-area";

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

/** True when the account's saved area should replace this browser's area (new device, or changed elsewhere). */
export function shouldAdoptServerArea(area: WatchArea, saved: { latitude: number; longitude: number; radiusMi: number; updatedAt: string } | null): boolean {
  if (!saved || sameArea(area, saved)) return false;
  if (area.source === "default" || !area.updatedAt) return true;
  return Date.parse(saved.updatedAt) > Date.parse(area.updatedAt);
}

type AccountArea = { latitude: number; longitude: number; radiusMi: number; updatedAt: string };

/** True when the area was chosen in this browser during the current signed-in session (not left over from before). */
const changedThisSession = (area: WatchArea, sessionStartedAt: number) => Boolean(area.updatedAt) && Date.parse(area.updatedAt!) >= sessionStartedAt;

/**
 * True when this browser's area should be saved to the account: it was changed during this signed-in session and is
 * newer than the account's copy. An area left in browser storage from before sign-in (possibly another person on a
 * shared browser) is never uploaded into an account.
 */
export function shouldSaveBrowserArea(area: WatchArea, saved: AccountArea | null, sessionStartedAt: number): boolean {
  if (area.source === "default" || !changedThisSession(area, sessionStartedAt)) return false;
  if (!saved) return true;
  return Date.parse(area.updatedAt!) > Date.parse(saved.updatedAt) && !sameArea(area, saved);
}

/**
 * True when the account has no saved area but this browser still holds a non-default area from before sign-in.
 * That area is not known to belong to this account, so it is cleared back to the deployment default.
 */
export function shouldClearForeignArea(area: WatchArea, saved: AccountArea | null, sessionStartedAt: number): boolean {
  return !saved && area.source !== "default" && !changedThisSession(area, sessionStartedAt);
}

/**
 * Server-side net state for the signed-in user plus the enable/pause mutation.
 * The watch area is account-backed: when signed in, the area saved to the account is loaded into this browser
 * (`onAdoptArea`) if it is newer (or this browser still has the default), and a newer area chosen in this browser is
 * saved to the account (debounced), keeping the net's enabled/paused setting. Browser storage stays the fallback
 * when signed out or when the server is unavailable. A still-default browser never overwrites a saved area.
 */
export function useNet(signedIn: boolean, area: WatchArea, onAdoptArea?: (next: WatchArea) => void) {
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

  const latestAdopt = useRef({ saved, onAdoptArea });
  latestAdopt.current = { saved, onAdoptArea };
  // Start of the current signed-in session; only areas chosen after it may be uploaded to the account.
  const [sessionStartedAt, setSessionStartedAt] = useState(() => Date.now());
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current) setSessionStartedAt(Date.now());
    wasSignedIn.current = signedIn;
  }, [signedIn]);

  // Clear a leftover (pre-sign-in) area when the account has none, instead of copying it into the account.
  const clearKey = signedIn && query.isSuccess && !mutation.isPending && shouldClearForeignArea(area, saved, sessionStartedAt) ? `${area.latitude}:${area.longitude}:${area.radiusMi}:${area.updatedAt}` : null;
  useEffect(() => {
    const adopt = latestAdopt.current.onAdoptArea;
    if (!clearKey || !adopt) return;
    adopt(defaultWatchArea());
  }, [clearKey]);

  // Load the account's area into this browser.
  const adoptKey = signedIn && query.isSuccess && !mutation.isPending && shouldAdoptServerArea(area, saved) ? `${saved!.latitude}:${saved!.longitude}:${saved!.radiusMi}:${saved!.updatedAt}` : null;
  useEffect(() => {
    const { saved: current, onAdoptArea: adopt } = latestAdopt.current;
    if (!adoptKey || !current || !adopt) return;
    adopt({ latitude: current.latitude, longitude: current.longitude, radiusMi: current.radiusMi, source: "saved", updatedAt: current.updatedAt });
  }, [adoptKey]);

  // Save a newer browser area to the account.
  const syncKey = signedIn && query.isSuccess && shouldSaveBrowserArea(area, saved, sessionStartedAt) ? `${area.latitude}:${area.longitude}:${area.radiusMi}` : null;
  const latest = useRef({ area, mutate: mutation.mutate, enabled: saved?.enabled ?? false });
  latest.current = { area, mutate: mutation.mutate, enabled: saved?.enabled ?? false };
  useEffect(() => {
    if (!syncKey) return;
    const timer = setTimeout(() => {
      const { area: current, mutate, enabled } = latest.current;
      mutate({ latitude: current.latitude, longitude: current.longitude, radiusMi: current.radiusMi, enabled }, { onError: (error) => setSaveError(describeNetError(error).message) });
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
