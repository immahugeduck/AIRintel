import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasScope } from "./auth.js";
import type { Queryable } from "./db.js";

// SYNTHETIC TEST VECTORS ONLY (made-up user ids), in an ephemeral WASM PostgreSQL instance with the real 0004 DDL.
let pg: PGlite;
const db: Queryable = { query: <Row extends QueryResultRow>(text: string, params?: readonly unknown[]) => pg.query<Row>(text, [...(params ?? [])]) as never };
const newUser = "33333333-3333-4333-8333-333333333331";
const revokedUser = "33333333-3333-4333-8333-333333333332";
const historyOnly = "33333333-3333-4333-8333-333333333333";

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec("create schema airintel_private;");
  await pg.exec(readFileSync(new URL("../db/migrations/0004_access_grants.sql", import.meta.url), "utf8"));
  await pg.query("insert into airintel_private.access_grants (user_id, scopes, note) values ($1, '{}', 'revoked'), ($2, '{history}', 'manual')", [revokedUser, historyOnly]);
});
afterAll(async () => { await pg.close(); });

describe("hasScope auto-provisioning against real DDL", () => {
  it("grants a brand-new signed-up account history and profile on first use", async () => {
    expect(await hasScope(db, newUser, "history")).toBe(true);
    expect(await hasScope(db, newUser, "profile")).toBe(true);
    const { rows } = await pg.query<{ scopes: string[]; note: string }>("select scopes, note from airintel_private.access_grants where user_id = $1", [newUser]);
    expect(rows).toEqual([{ scopes: ["history", "profile"], note: "auto: signed-up account" }]);
  });

  it("keeps a revoked account out instead of re-granting it", async () => {
    expect(await hasScope(db, revokedUser, "history")).toBe(false);
    expect(await hasScope(db, revokedUser, "profile")).toBe(false);
  });

  it("never widens an existing manual grant", async () => {
    expect(await hasScope(db, historyOnly, "history")).toBe(true);
    expect(await hasScope(db, historyOnly, "profile")).toBe(false);
  });

  it("rejects ids that are not uuids without touching the table", async () => {
    expect(await hasScope(db, "not-a-uuid", "history")).toBe(false);
  });
});
