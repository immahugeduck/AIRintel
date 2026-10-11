/**
 * DEV-ONLY LAYOUT HARNESS — NOT PART OF THE PRODUCTION BUILD.
 * Served only by `vite` dev at /e2e/harness.html (vite build uses index.html as its sole entry).
 * Renders the real list components with the SYNTHETIC TEST FIXTURES below so layouts can be screenshot and
 * measured without a live provider or database. These are not aircraft observations and must never be shipped
 * or presented as real data (AGENTS.md real-data policy).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AircraftList } from "../src/components/AircraftList";
import { BrandMark, HistoryIcon, ListIcon, LogIcon, MapIcon, MoreIcon, NetIcon } from "../src/components/Icons";
import { NetControl } from "../src/components/NetControl";
import { NettedDrawer } from "../src/components/NettedDrawer";
import { NettedPanel } from "../src/components/NettedPanel";
import { SelectedDock } from "../src/components/SelectedDock";
import { deriveNetStatus } from "../src/domain/net";
import type { NettedAircraft } from "../src/domain/netted";
import type { NetControlState } from "../src/lib/use-net";
import type { RadiusRow } from "../src/domain/radius-list";
import "../src/styles.css";

const FIXTURE = "TEST-FIXTURE";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const rows: RadiusRow[] = [
  { icao24: "f00001", callsign: "TEST101", registration: null, distanceNm: 1.4, altitudeFt: 3200, onGround: null, groundSpeedKt: 118, trackDeg: 90, observedAt: minutesAgo(0), origin: "live", provider: FIXTURE, latitude: 0, longitude: 0 },
  { icao24: "f00002", callsign: "TEST202", registration: null, distanceNm: 2.8, altitudeFt: 11250, onGround: null, groundSpeedKt: 305, trackDeg: 180, observedAt: minutesAgo(1), origin: "live", provider: FIXTURE, latitude: 0, longitude: 0 },
  { icao24: "f00003", callsign: null, registration: null, distanceNm: 4.9, altitudeFt: null, onGround: null, groundSpeedKt: null, trackDeg: null, observedAt: minutesAgo(3), origin: "recorded", provider: FIXTURE, latitude: 0, longitude: 0 },
  { icao24: "f00004", callsign: "TESTLONGCS", registration: null, distanceNm: 5.9, altitudeFt: 0, onGround: true, groundSpeedKt: 12, trackDeg: 0, observedAt: minutesAgo(12), origin: "recorded", provider: FIXTURE, latitude: 0, longitude: 0 },
];
const visit = (enteredMinutesAgo: number, stayMinutes: number, closestMi: number, observationCount: number) => ({ enteredAt: minutesAgo(enteredMinutesAgo), lastSeenInRadiusAt: minutesAgo(enteredMinutesAgo - stayMinutes), closestMi, observationCount });
const netted: NettedAircraft[] = [
  { icao24: "f00001", callsign: "TEST101", registration: "N0TEST1", aircraftTypeCode: "TST1", visitCount: 7, firstSeenAt: minutesAgo(600), lastSeenAt: minutesAgo(0), closestApproachMi: 0.8,
    visits: [visit(30, 4, 0.8, 5), visit(120, 1, 2.2, 1), visit(240, 12, 1.4, 9), visit(300, 0, 5.9, 1), visit(420, 3, 3.3, 3), visit(500, 2, 0.9, 2), visit(600, 6, 4.1, 4)] },
  { icao24: "f00002", callsign: "TEST202", registration: null, aircraftTypeCode: null, visitCount: 1, firstSeenAt: minutesAgo(90), lastSeenAt: minutesAgo(80), closestApproachMi: 3.1, visits: [visit(90, 10, 3.1, 6)] },
  { icao24: "f00003", callsign: null, registration: null, aircraftTypeCode: null, visitCount: 2, firstSeenAt: minutesAgo(300), lastSeenAt: minutesAgo(45), closestApproachMi: 6.4, visits: [visit(45, 0, 6.4, 1), visit(300, 0, 6.9, 1)] },
];
const netCases = {
  active: { enabled: true, updatedAt: minutesAgo(600), lastSuccessAt: minutesAgo(2), lastPolledAt: minutesAgo(2), lastPollStatus: "ok" },
  stale: { enabled: true, updatedAt: minutesAgo(600), lastSuccessAt: minutesAgo(47), lastPolledAt: minutesAgo(1), lastPollStatus: "provider_error" },
  pending: { enabled: true, updatedAt: minutesAgo(1), lastSuccessAt: null, lastPolledAt: null, lastPollStatus: null },
  paused: null,
} as const;

function Harness() {
  const params = new URLSearchParams(location.search);
  const view = (params.get("view") ?? "aircraft") as "aircraft" | "netted" | "more";
  const netCase = (params.get("net") ?? "active") as keyof typeof netCases;
  const netStatus = deriveNetStatus(netCases[netCase], new Date());
  const nettedState = { kind: "ready", source: "recorded", aircraft: params.get("empty") === "1" ? [] : netted, hours: 24, truncated: false, net: netStatus } as const;
  const [drawerOpen, setDrawerOpen] = useState(params.get("drawer") === "1");
  const controlState: NetControlState = { kind: "ready", data: { watchArea: netCase === "paused" ? null : { latitude: 39.7684, longitude: -86.1581, radiusMi: 7, enabled: true, createdAt: minutesAgo(600), updatedAt: minutesAgo(600) }, net: netStatus, receivedAt: new Date().toISOString() } };
  const empty = params.get("empty") === "1";
  const [selected, setSelected] = useState<string | null>(params.get("selected"));
  return (
    <div className="app-shell" data-view={view}>
      <header className="topbar">
        <div className="brand"><BrandMark /><div className="brand-copy"><strong>AIRIntel</strong><span>Layout harness · test fixtures</span></div></div>
        <span className="status-pill is-warn" role="status"><span className="pulse" aria-hidden="true" />Test fixtures</span>
        <button type="button" className="icon-button log-button" aria-haspopup="dialog" aria-expanded={drawerOpen} aria-label="Netted log, 10 entries in the last 24 hours" onClick={() => setDrawerOpen(true)}>
          <LogIcon /><span className="log-badge mono" aria-hidden="true">10</span>
        </button>
        <button type="button" className="button button-primary">Sign in</button>
      </header>
      <nav className="app-nav" aria-label="Main">
        {[["Map", MapIcon], ["Aircraft", ListIcon], ["Netted", NetIcon], ["History", HistoryIcon], ["More", MoreIcon]].map(([label, Icon]) => {
          const IconComponent = Icon as typeof MapIcon;
          return <button key={label as string} type="button" className="nav-item" aria-current={(label as string).toLowerCase() === view ? "page" : undefined}><IconComponent /><span>{label as string}</span></button>;
        })}
      </nav>
      <main id="main" className="app-main">
        <div className="map-region" />
        <div className="content-region">
          {view === "more"
            ? <NetControl state={controlState} area={{ latitude: 39.7684, longitude: -86.1581, radiusMi: 7, source: "device", updatedAt: null }} saving={false} saveError={netCase === "stale" ? "Test fixture: the net could not be updated (server answered 500)." : null} onToggle={() => undefined} onSignIn={() => undefined} />
            : view === "aircraft"
            ? <AircraftList rows={empty ? [] : rows} selectedIcao24={selected} onSelect={setSelected} radiusMi={7} loading={false} liveError={null} recordedNote={null} timeZone="America/Indiana/Indianapolis" />
            : <NettedPanel state={empty ? { ...nettedState, aircraft: [] } : nettedState} radiusMi={7} selectedIcao24={selected} onSelect={setSelected} profileLookup={false} timeZone="America/Indiana/Indianapolis" />}
        </div>
      </main>
      <NettedDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Netted log" subtitle="Entries into your 7 mi radius">
        <NettedPanel variant="drawer" state={empty ? { ...nettedState, aircraft: [] } : nettedState} radiusMi={7} selectedIcao24={selected} onSelect={setSelected} profileLookup={false} timeZone="America/Indiana/Indianapolis" newSince={minutesAgo(100)} onOpenNetSettings={() => undefined} />
      </NettedDrawer>
      {selected && <SelectedDock icao24={selected} row={rows.find((row) => row.icao24 === selected) ?? null} netted={netted.find((item) => item.icao24 === selected) ?? null} onClose={() => setSelected(null)} onShowMap={() => undefined} onDetails={() => undefined} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider></StrictMode>);
