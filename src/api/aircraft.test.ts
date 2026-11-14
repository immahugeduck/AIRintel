import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/auth", () => ({ getAccessToken: async () => null }));
vi.mock("../lib/api-url", () => ({ aircraftApiEndpoint: () => "http://localhost/api/aircraft-nearby", resolveApiUrl: (u: string) => new URL(u) }));

const { fetchAircraft } = await import("./aircraft");

describe("fetchAircraft", () => {
  afterEach(() => vi.unstubAllGlobals());
  const capture = () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => { urls.push(String(url)); return new Response("{}", { status: 500 }); }));
    return urls;
  };

  it("sends the follow-me / fixed center mode so live encounters are tagged", async () => {
    const urls = capture();
    await fetchAircraft({ latitude: 39.76, longitude: -86.5, radiusNm: 6 }, undefined, "follow").catch(() => undefined);
    expect(new URL(urls[0]!).searchParams.get("center")).toBe("follow");
  });

  it("omits the center parameter when the mode is unknown", async () => {
    const urls = capture();
    await fetchAircraft({ latitude: 39.76, longitude: -86.5, radiusNm: 6 }).catch(() => undefined);
    expect(new URL(urls[0]!).searchParams.has("center")).toBe(false);
  });
});
