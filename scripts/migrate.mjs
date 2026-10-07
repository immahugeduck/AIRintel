// Applies db/migrations/*.sql once (in filename order) and db/repeatable/*.sql on every run.
// Usage: npm run db:migrate [-- --dry-run]
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect } from "./lib/db.mjs";

const root = resolve(import.meta.dirname, "..", "db");
const dryRun = process.argv.includes("--dry-run");
const sqlFiles = (dir) => readdirSync(join(root, dir)).filter((name) => name.endsWith(".sql")).sort();
const read = (dir, name) => readFileSync(join(root, dir, name), "utf8");
const checksum = (sql) => createHash("sha256").update(sql).digest("hex");

const client = await connect();
try {
  await client.query("select pg_advisory_lock(hashtext('airintel:migrate'))");
  await client.query("create schema if not exists airintel_private");
  await client.query(`create table if not exists airintel_private.schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const applied = new Map((await client.query("select name, checksum from airintel_private.schema_migrations")).rows.map((row) => [row.name, row.checksum]));

  let count = 0;
  for (const name of sqlFiles("migrations")) {
    const sql = read("migrations", name);
    const known = applied.get(name);
    if (known) {
      if (known !== checksum(sql)) throw new Error(`Migration ${name} was modified after it was applied. Add a new migration instead.`);
      continue;
    }
    console.log(`${dryRun ? "pending" : "applying"}  ${name}`);
    count += 1;
    if (dryRun) continue;
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into airintel_private.schema_migrations (name, checksum) values ($1, $2)", [name, checksum(sql)]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw new Error(`Migration ${name} failed: ${error.message}`);
    }
  }
  if (!dryRun) {
    for (const name of sqlFiles("repeatable")) {
      console.log(`running   ${name}`);
      await client.query(read("repeatable", name));
    }
  }
  console.log(count === 0 ? "Database is up to date." : `${dryRun ? "Pending" : "Applied"} ${count} migration(s).`);
} finally {
  await client.end();
}
