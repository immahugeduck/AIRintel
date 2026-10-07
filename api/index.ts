// Vercel Function entry: serves the whole Hono API under /api/* (see vercel.json rewrites).
//   /api/health  /api/history  /api/aircraft-profile  /api/aircraft-nearby  /api/satellites-nearby  /api/satellite-passes
// Env (set in the Vercel project): DATABASE_URL, NEON_AUTH_BASE_URL, ALLOWED_ORIGINS (+ optional ADSB_*).
import { Hono } from "hono";
import { app } from "../server/index.js";

const root = new Hono().route("/api", app);

export default { fetch: root.fetch };
