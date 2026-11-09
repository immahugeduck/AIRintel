import { afterEach, describe, expect, it, vi } from "vitest";

// Synthetic HTTP vectors only: no requests reach a real auth service.
const authUrl = "https://auth.example.invalid/neondb/auth";
const jwt = () => `eyJhbGciOiJFZERTQSJ9.${btoa(JSON.stringify({ sub: "synthetic-user", exp: Math.floor(Date.now() / 1000) + 900 }))}.synthetic-signature`;

async function configuredClient(token: string | null, tokenStatus = token === null ? 401 : 200) {
  vi.resetModules();
  vi.stubEnv("VITE_NEON_AUTH_URL", authUrl);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = url.includes("/token")
      ? token ? { token } : { message: "Unauthenticated" }
      : { session: { id: "synthetic-session", token: "opaque-session-not-a-jwt", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), userId: "synthetic-user" }, user: { id: "synthetic-user", email: "fixture@example.invalid", name: "Synthetic", emailVerified: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
    return new Response(JSON.stringify(body), { status: url.includes("/token") ? tokenStatus : 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { module: await import("./auth"), fetchMock };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("Managed Neon auth SDK contract", () => {
  it("gets the API JWT from the documented token endpoint, not the opaque session token", async () => {
    const token = jwt();
    const { module, fetchMock } = await configuredClient(token);
    expect(await module.getAccessToken()).toBe(token);
    expect(fetchMock.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).includes("/token"))).toBe(true);
    const requests = fetchMock.mock.calls.length;
    expect(await module.getAccessToken()).toBe(token);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    module.clearAccessToken();
    expect(await module.getAccessToken()).toBe(token);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(requests);
  });

  it("does not forward opaque tokens as JWT bearer credentials", async () => {
    const { module } = await configuredClient("opaque-session-not-a-jwt");
    expect(await module.getAccessToken()).toBeNull();
  });

  it("treats an unauthenticated JWT response as signed out", async () => {
    const { module } = await configuredClient(null);
    expect(await module.getAccessToken()).toBeNull();
  });

  it("does not disguise auth service failures as a signed-out session", async () => {
    const { module } = await configuredClient(null, 500);
    await expect(module.getAccessToken()).rejects.toMatchObject({ status: 500 });
  });

  it("retains the programmatic sign-in, sign-up, sign-out and session API", async () => {
    const { module, fetchMock } = await configuredClient(jwt());
    const auth = module.getAuthClient()!;
    expect(typeof auth.signIn.email).toBe("function");
    expect(typeof auth.signUp.email).toBe("function");
    expect(typeof auth.signOut).toBe("function");
    const signedIn = await auth.signIn.email({ email: "fixture@example.invalid", password: "synthetic-password-not-real" });
    expect(signedIn.error).toBeNull();
    const signedUp = await auth.signUp.email({ name: "Synthetic", email: "fixture@example.invalid", password: "synthetic-password-not-real" });
    expect(signedUp.error).toBeNull();
    const signedOut = await auth.signOut();
    expect(signedOut.error).toBeNull();
    const result = await auth.getSession();
    expect(result.data?.user.email).toBe("fixture@example.invalid");
    for (const route of ["/sign-in/email", "/sign-up/email", "/sign-out", "/get-session"]) {
      expect(fetchMock.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).endsWith(route))).toBe(true);
    }
  });
});
