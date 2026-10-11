// Retention helper for recorded observations (migration 0005: airintel_private.purge_aircraft_observations).
//   npm run db:retention -- --days 90            dry run: shows how many positions are older than 90 days
//   npm run db:retention -- --days 90 --apply    deletes them in bounded batches (positions + raw payloads)
// Days come from --days or NET_RETENTION_DAYS (minimum 7). Nothing runs automatically from this script.
import { connect } from "./lib/db.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const apply = args.includes("--apply");
const daysRaw = flag("--days") ?? process.env.NET_RETENTION_DAYS;
const days = Number(daysRaw);
if (!daysRaw || !Number.isInteger(days) || days < 7) {
  console.error("Provide a whole number of days >= 7: npm run db:retention -- --days 90 [--apply]");
  process.exit(2);
}
const batch = 5000;

const client = await connect();
try {
  const { rows: [count] } = await client.query("select count(*)::bigint as n from public.aircraft_positions where observed_at < now() - make_interval(days => $1::integer)", [days]);
  console.log(`${count.n} recorded position(s) are older than ${days} days.`);
  if (!apply) {
    console.log("Dry run. Re-run with --apply to delete them (raw payloads are removed with their positions; aircraft identities are kept).");
  } else {
    let total = 0;
    for (;;) {
      const { rows: [row] } = await client.query("select airintel_private.purge_aircraft_observations($1::integer, $2::integer) as deleted", [days, batch]);
      total += row.deleted;
      process.stdout.write(`\rdeleted ${total}`);
      if (row.deleted < batch) break;
    }
    await client.query("update airintel_private.net_sweep_state set last_purge_at = now(), last_purge_deleted = $1 where id", [total % batch]);
    console.log(`\nDone. Deleted ${total} position(s).`);
  }
} finally {
  await client.end();
}
