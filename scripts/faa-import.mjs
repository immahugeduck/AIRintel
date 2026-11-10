import { resolve } from "node:path";
import { connect } from "./lib/db.mjs";
import { DEFAULT_SOURCE_URL, importSnapshot } from "./lib/faa.mjs";

/**
 * npm run faa:import -- --input MASTER.txt --snapshot-date YYYY-MM-DD [--acftref ACFTREF.txt] [--source-url <faa.gov url>] [--publish]
 *
 * Imports the official FAA Releasable Aircraft Database (download ReleasableAircraft.zip from faa.gov and unzip it).
 * Without --publish the run is staged as "validated" and nothing changes for users; re-run with --publish (the same
 * file is recognized by its SHA-256 and only promoted) to make it the snapshot the profile/netted views use.
 * Uses DATABASE_URL_UNPOOLED / DATABASE_URL from the environment or .env.local (see scripts/lib/db.mjs).
 */
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const input = argument("--input");
const snapshotDate = argument("--snapshot-date");
if (!input || !snapshotDate) {
  console.error("Usage: npm run faa:import -- --input <MASTER.txt> --snapshot-date <YYYY-MM-DD> [--acftref <ACFTREF.txt>] [--source-url <https://www.faa.gov/...>] [--publish]");
  process.exit(1);
}

const client = await connect();
try {
  const summary = await importSnapshot(client, {
    inputPath: resolve(input),
    acftrefPath: argument("--acftref") ? resolve(argument("--acftref")) : null,
    snapshotDate,
    sourceUrl: argument("--source-url") ?? DEFAULT_SOURCE_URL,
    publish: process.argv.includes("--publish"),
    log: (message) => console.error(message),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status === "rejected") process.exitCode = 2;
} finally {
  await client.end();
}
