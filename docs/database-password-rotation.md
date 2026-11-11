# Rotating the Neon database password

This repository does not store database credentials. Keep the password in the deployment provider's environment-variable settings and in an ignored local environment file only.

## Hosted deployment

For the Vercel deployment:

1. In Neon, copy the connection string for the database role whose password was reset. Use the pooled connection string for `DATABASE_URL`.
2. In Vercel, open the project settings and update `DATABASE_URL` for each environment that should use the rotated credential (Production, Preview, and Development as applicable). Preserve the rest of the connection string and replace only the old credential.
3. Save the variable and redeploy so the running deployment receives the new value.
4. Check the deployment logs and exercise a database-backed Sky Net feature to confirm the app can connect and read/write as expected.

Do not add a `VITE_` prefix to database variables; credentials must remain server-side. Never paste a live URL or password into this repository, a commit, an issue, or a client-side setting.

## Local development and migrations

- Put the pooled connection string in `DATABASE_URL` in your ignored local environment file.
- Put the unpooled connection string in `DATABASE_URL_UNPOOLED` only where local migration or database scripts require it.
- Confirm the local environment file is ignored by Git before saving credentials.
- Run migrations only when a required schema change is pending; password rotation alone does not require a schema migration.

## If connections still fail

Confirm the username, database name, host, port, SSL settings, and URL-encoding of any special characters in the password. Check that the updated variable is set in the environment serving the deployment and that a fresh deployment has completed. Do not share the full connection string in logs or support messages.
