import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { RateLimiter, bearerToken, createJwtVerifier, hasScope } from "./auth.js";
import type { Queryable } from "./db.js";

const baseUrl = "https://ep-test.neonauth.us-east-2.aws.neon.build/neondb/auth";
const userId = "860dc360-609f-4b7d-9e70-ec93fe6414d3";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "EdDSA", use: "sig" };
  const verifier = createJwtVerifier({ baseUrl, keys: createLocalJWKSet({ keys: [jwk] }) });
  const sign = (claims: Record<string, unknown>, options: { issuer?: string; expiresIn?: string; key?: Parameters<SignJWT["sign"]>[0] } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", kid: "test-key" }).setSubject(userId).setIssuer(options.issuer ?? new URL(baseUrl).origin).setIssuedAt().setExpirationTime(options.expiresIn ?? "15m").sign(options.key ?? privateKey);
  return { verifier, sign };
}

describe("createJwtVerifier (Neon Auth tokens)", () => {
  it("accepts a valid EdDSA token from the Neon Auth origin and returns the user id", async () => {
    const { verifier, sign } = await setup();
    expect(await verifier(await sign({ email: "pilot@example.com" }))).toEqual({ id: userId, email: "pilot@example.com" });
  });

  it("rejects expired tokens, wrong issuers, banned users, forged signatures, and garbage", async () => {
    const { verifier, sign } = await setup();
    expect(await verifier(await sign({}, { expiresIn: "-1m" }))).toBeNull();
    expect(await verifier(await sign({}, { issuer: "https://evil.example.com" }))).toBeNull();
    expect(await verifier(await sign({ banned: true }))).toBeNull();
    const other = await generateKeyPair("EdDSA");
    expect(await verifier(await sign({}, { key: other.privateKey }))).toBeNull();
    expect(await verifier("not-a-jwt")).toBeNull();
  });
});

describe("bearerToken", () => {
  it("extracts only well-formed Bearer values", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("hasScope", () => {
  const dbReturning = (rows: Array<{ allowed: boolean }>): Queryable & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return { calls, query: async (_sql: string, params?: readonly unknown[]) => { calls.push([...(params ?? [])]); return { rows } as never; } };
  };

  it("is true only when the grant contains the scope", async () => {
    expect(await hasScope(dbReturning([{ allowed: true }]), userId, "history")).toBe(true);
    expect(await hasScope(dbReturning([{ allowed: false }]), userId, "profile")).toBe(false);
    expect(await hasScope(dbReturning([]), userId, "history")).toBe(false);
  });

  it("never queries with a malformed user id", async () => {
    const db = dbReturning([{ allowed: true }]);
    expect(await hasScope(db, "1; drop table x", "history")).toBe(false);
    expect(db.calls).toHaveLength(0);
  });
});

describe("RateLimiter", () => {
  it("blocks after the limit and recovers when the window resets", () => {
    let now = 1_000;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.hit("u")).toBeNull();
    expect(limiter.hit("u")).toBeNull();
    expect(limiter.hit("u")).toBe(60);
    expect(limiter.hit("other")).toBeNull();
    now += 60_001;
    expect(limiter.hit("u")).toBeNull();
  });
});
