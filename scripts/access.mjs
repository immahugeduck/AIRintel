// Manage who may call the protected API routes (replaces Supabase app_metadata flags).
//   npm run access:grant -- --email you@example.com --scope history --scope profile
//   npm run access:revoke -- --email you@example.com
//   npm run access:list
// The user must have signed up through Neon Auth first (a row in neon_auth."user").
import { connect } from "./lib/db.mjs";

const [command = "list", ...rest] = process.argv.slice(2);
const values = (flag) => rest.flatMap((arg, index) => (arg === flag && rest[index + 1] ? [rest[index + 1]] : []));
const email = values("--email")[0]?.trim().toLowerCase();
const scopes = [...new Set(values("--scope").flatMap((value) => value.split(",")).map((value) => value.trim()))];
const allowed = new Set(["history", "profile"]);

const usage = () => { console.error("Usage: access.mjs grant --email <email> --scope history[,profile] | revoke --email <email> | list"); process.exit(2); };

if (command === "grant" && (!email || scopes.length === 0 || scopes.some((scope) => !allowed.has(scope)))) usage();
if (command === "revoke" && !email) usage();
if (!["grant", "revoke", "list"].includes(command)) usage();

const client = await connect();
try {
  if (command === "list") {
    const { rows } = await client.query(`select u.email, g.scopes, g.granted_at from airintel_private.access_grants g left join neon_auth."user" u on u.id = g.user_id order by g.granted_at`);
    console.table(rows);
  } else {
    const { rows } = await client.query(`select id from neon_auth."user" where lower(email) = $1`, [email]);
    const user = rows[0];
    if (!user) throw new Error(`No Neon Auth user with email ${email}. Sign up in the app first.`);
    if (command === "grant") {
      await client.query(
        `insert into airintel_private.access_grants (user_id, scopes) values ($1, $2)
         on conflict (user_id) do update set scopes = excluded.scopes, updated_at = now()`,
        [user.id, scopes],
      );
      console.log(`Granted ${scopes.join(", ")} to ${email}`);
    } else {
      const result = await client.query("delete from airintel_private.access_grants where user_id = $1", [user.id]);
      console.log(result.rowCount ? `Revoked access for ${email}` : `${email} had no grants`);
    }
  }
} finally {
  await client.end();
}
