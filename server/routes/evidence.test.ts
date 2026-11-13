import { beforeEach, describe, expect, it, vi } from "vitest";

// Vercel Blob is replaced so no network/storage is touched; the test only checks which paths each account may use.
const blob = vi.hoisted(() => ({
  put: vi.fn(async (pathname: string) => ({ pathname: `${pathname}-rnd`, url: "https://blob.test/x", downloadUrl: "https://blob.test/x?download=1", contentType: "image/png" })),
  get: vi.fn(async () => ({ statusCode: 200, stream: new Response("img").body, blob: { contentType: "image/png", contentDisposition: "inline" } })),
}));
vi.mock("@vercel/blob", () => blob);

const { createApp } = await import("../app.js");

const origin = "http://localhost:5173";
const me = "860dc360-609f-4b7d-9e70-ec93fe6414d3";
const other = "11111111-1111-4111-8111-111111111111";
const app = createApp({
  db: { query: async () => ({ rows: [{ allowed: true }] }) as never },
  verifier: async (token) => (token === "good" ? { id: me, email: null } : null),
  allowedOrigins: new Set([origin]),
  adsb: null,
});
const headers = { origin, authorization: "Bearer good" };
const view = (pathname: string) => app.request(`/evidence/view?pathname=${encodeURIComponent(pathname)}`, { headers });

describe("evidence per-account isolation", () => {
  beforeEach(() => { blob.put.mockClear(); blob.get.mockClear(); });

  it("stores uploads under the caller's own folder", async () => {
    const response = await app.request("/evidence/upload?filename=photo.png", { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) });
    expect(response.status).toBe(201);
    expect(blob.put.mock.calls[0]?.[0]).toBe(`airintel/evidence/${me}/photo.png`);
  });

  it("serves the caller's folder and legacy flat paths, but not another account's folder", async () => {
    expect((await view(`airintel/evidence/${me}/photo-abc.png`)).status).toBe(200);
    expect((await view("airintel/evidence/photo-legacy123.png")).status).toBe(200);
    expect((await view(`airintel/evidence/${other}/photo-abc.png`)).status).toBe(404);
    expect((await view(`airintel/evidence/${me}/../${other}/photo-abc.png`)).status).toBe(400);
    expect(blob.get).toHaveBeenCalledTimes(2);
  });
});
