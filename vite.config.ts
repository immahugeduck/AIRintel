import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // SERVERSIDE_NEON_VITE_ is the prefix the Vercel Neon integration gives its public VITE_* vars
  // (SERVERSIDE_NEON_VITE_NEON_AUTH_URL). Only names starting with these prefixes reach the browser bundle.
  envPrefix: ["VITE_", "SERVERSIDE_NEON_VITE_"],
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false, rewrite: (path) => path.replace(/^\/api/, "") } } },
  test: { environment: "node", include: ["src/**/*.test.ts", "server/**/*.test.ts"] },
});
