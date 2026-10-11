import { useId } from "react";
import { describeNetStatus, type NetStatus } from "../domain/net";
import { useNow, type NetControlState } from "../lib/use-net";
import type { WatchArea } from "../lib/watch-area";

/** One-line status ("Net active — last sweep 2 min ago") with a tone dot. Shared by the settings panel, Netted tab and drawer. */
export function NetStatusLine({ status, className = "" }: { status: NetStatus; className?: string }) {
  const now = useNow();
  const { tone, text } = describeNetStatus(status, now);
  return <p className={`net-status is-${tone} ${className}`.trim()} role="status"><span className="pulse" aria-hidden="true" />{text}</p>;
}

type Props = {
  state: NetControlState;
  area: WatchArea;
  saving: boolean;
  saveError: string | null;
  onToggle: (enabled: boolean) => void;
  onSignIn: () => void;
};

/** "Keep netting when app is closed": saves the watch area server-side so the scheduled sweep logs passes. */
export function NetControl({ state, area, saving, saveError, onToggle, onSignIn }: Props) {
  const ids = useId();
  const enabled = state.kind === "ready" && state.data.watchArea?.enabled === true;
  const watched = state.kind === "ready" ? state.data.watchArea : null;
  const interactive = state.kind === "ready";
  return (
    <section className="panel net-control" aria-labelledby={`${ids}-heading`}>
      <header className="panel-header">
        <div><p className="eyebrow">Always-on net</p><h2 id={`${ids}-heading`}>Keep netting when app is closed</h2></div>
      </header>

      <div className="switch-row">
        <div className="switch-copy">
          <label id={`${ids}-label`} htmlFor={`${ids}-switch`}>{enabled ? "Net on — logging passes server-side" : "Net off — logging only while the app is open"}</label>
          <span id={`${ids}-desc`} className="fine-print">
            {watched ? `Watching ${round(watched.latitude)}, ${round(watched.longitude)} · ${watched.radiusMi} mi radius.` : `Will watch ${round(area.latitude)}, ${round(area.longitude)} · ${area.radiusMi} mi${area.source === "default" ? " (the default area — use your location first for a personal net)" : ""}.`}
          </span>
        </div>
        <button
          id={`${ids}-switch`}
          type="button"
          role="switch"
          className="switch"
          aria-checked={enabled}
          aria-labelledby={`${ids}-label`}
          aria-describedby={`${ids}-desc`}
          disabled={!interactive || saving}
          onClick={() => onToggle(!enabled)}
        ><span className="switch-thumb" aria-hidden="true" /></button>
      </div>

      {state.kind === "ready" && <NetStatusLine status={state.data.net} />}
      {state.kind === "loading" && <p className="notice" role="status"><span className="spinner" aria-hidden="true" /> Checking the net…</p>}
      {state.kind === "signed-out" && (
        <div className="notice notice-warn" role="status">
          <p>Sign in to save your watch area on the server so aircraft are logged while this app is closed.</p>
          <button type="button" className="button button-primary" onClick={onSignIn}>Sign in</button>
        </div>
      )}
      {state.kind === "unavailable" && <p className={`notice ${state.reason === "error" ? "notice-error" : "notice-warn"}`} role="alert">{state.message}</p>}
      {saveError && <p className="notice notice-error" role="alert">{saveError}</p>}

      <p className="fine-print">
        When on, your watch area (location and radius) is stored on the AIRIntel server and a scheduled sweep records real aircraft near it every few minutes, so each entry into your radius is logged even when nobody has the app open. Turn it off to stop sweeps for your area; already recorded entries are kept.
      </p>
    </section>
  );
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;
