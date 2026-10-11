import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deriveNetStatus, type NetStatus } from "../domain/net";
import type { NettedAircraft, NettedVisit } from "../domain/netted";
import { NetControl } from "./NetControl";
import { NettedPanel, describeStay, type NettedState } from "./NettedPanel";

// TEST FIXTURES ONLY: synthetic values rendered to static markup to check labels, structure and honesty of wording.
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const visit = (enteredMinutesAgo: number, stay: number, closestMi: number, observationCount: number): NettedVisit => ({ enteredAt: iso(enteredMinutesAgo), lastSeenInRadiusAt: iso(enteredMinutesAgo - stay), closestMi, observationCount });
const item: NettedAircraft = { icao24: "f00001", callsign: "TEST101", registration: "N0TEST1", aircraftTypeCode: "TST1", visitCount: 3, firstSeenAt: iso(300), lastSeenAt: iso(10), closestApproachMi: 0.8, visits: [visit(10, 4, 0.8, 5), visit(120, 0, 2.2, 1), visit(300, 12, 1.4, 9)] };
const ready = (net: NetStatus | null): NettedState => ({ kind: "ready", source: "recorded", aircraft: [item], hours: 24, truncated: false, net });
const render = (state: NettedState, extra: Partial<Parameters<typeof NettedPanel>[0]> = {}) =>
  renderToStaticMarkup(<NettedPanel state={state} radiusMi={7} selectedIcao24={null} onSelect={() => undefined} profileLookup={false} timeZone="UTC" {...extra} />);

describe("describeStay", () => {
  it("only claims what the observations support", () => {
    expect(describeStay(visit(10, 0, 1, 1))).toBe("seen once inside");
    expect(describeStay(visit(10, 0, 1, 3))).toBe("3 sightings inside");
    expect(describeStay(visit(10, 4, 1, 5))).toBe("observed inside for 4 min");
  });
});

describe("NettedPanel entry log", () => {
  it("keeps entry logs collapsed in the tab and open in the drawer variant", () => {
    const tab = render(ready(null));
    expect(tab).toContain("Entry log · 3");
    expect(tab).not.toContain("visit-timeline");
    const drawer = render(ready(null), { variant: "drawer" });
    expect(drawer).toContain("visit-timeline");
    expect(drawer).toContain("Hide entry log");
    expect(drawer.match(/class="visit-entry"/g)).toHaveLength(3);
    expect(drawer).toContain("Entry 3");
    expect(drawer).toContain("seen once inside");
  });

  it("tags only entries that began after the previous open as New", () => {
    const html = render(ready(null), { variant: "drawer", newSince: iso(60) });
    expect(html.match(/class="new-tag"/g)).toHaveLength(1);
    expect(render(ready(null), { variant: "drawer", newSince: null })).not.toContain("new-tag");
  });

  it("shows net freshness and a stale warning with the 15 minute rule", () => {
    const stale = deriveNetStatus({ enabled: true, updatedAt: iso(900), lastSuccessAt: iso(40), lastPolledAt: iso(1), lastPollStatus: "provider_error" });
    const html = render(ready(stale));
    expect(html).toContain("Net stale");
    expect(html).toContain("No successful sweep in the last 15 minutes");
    const active = render(ready(deriveNetStatus({ enabled: true, updatedAt: iso(900), lastSuccessAt: iso(2), lastPolledAt: iso(2), lastPollStatus: "ok" })));
    expect(active).toContain("Net active — last sweep 2 min ago");
    expect(active).not.toContain("No successful sweep");
    const paused = render(ready(deriveNetStatus(null)), { onOpenNetSettings: () => undefined });
    expect(paused).toContain("Net paused");
    expect(paused).toContain("Keep netting when app is closed");
  });

  it("labels the drawer heading uniquely so the tab and drawer never share an id", () => {
    expect(render(ready(null), { variant: "drawer" })).toContain('id="netted-heading-drawer"');
    expect(render(ready(null))).toContain('id="netted-heading"');
  });
});

describe("NetControl", () => {
  const area = { latitude: 39.7684, longitude: -86.1581, radiusMi: 7, source: "device" as const, updatedAt: null };
  const props = { area, saving: false, saveError: null, onToggle: () => undefined, onSignIn: () => undefined };
  const data = (enabled: boolean) => ({ watchArea: { latitude: 39.7684, longitude: -86.1581, radiusMi: 7, enabled, createdAt: iso(10), updatedAt: iso(10) }, net: deriveNetStatus({ enabled, updatedAt: iso(10), lastSuccessAt: iso(1), lastPolledAt: iso(1), lastPollStatus: "ok" }), receivedAt: new Date().toISOString() });

  it("exposes an accessible switch reflecting the saved state and the honest status line", () => {
    const on = renderToStaticMarkup(<NetControl {...props} state={{ kind: "ready", data: data(true) }} />);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain("Net active — last sweep");
    const off = renderToStaticMarkup(<NetControl {...props} state={{ kind: "ready", data: data(false) }} />);
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain("Net paused");
  });

  it("disables the switch and explains why when signed out or unavailable", () => {
    const signedOut = renderToStaticMarkup(<NetControl {...props} state={{ kind: "signed-out" }} />);
    expect(signedOut).toContain("disabled");
    expect(signedOut).toContain("Sign in to save your watch area");
    const unavailable = renderToStaticMarkup(<NetControl {...props} state={{ kind: "unavailable", reason: "not-migrated", message: "migration 0005 has not been applied" }} />);
    expect(unavailable).toContain('role="alert"');
    expect(unavailable).toContain("migration 0005");
  });

  it("surfaces save errors", () => {
    const html = renderToStaticMarkup(<NetControl {...props} saveError="The net could not be updated (server answered 500)." state={{ kind: "ready", data: data(true) }} />);
    expect(html).toContain("server answered 500");
  });
});
