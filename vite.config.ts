import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // One Zod copy in the bundle: nested copies inside the Neon Auth packages ignore `z.config({ jitless })` and would
  // probe `new Function()` (a CSP violation under script-src 'self').
  resolve: { dedupe: ["zod"] },
  // SERVERSIDE_NEON_VITE_ is the prefix the Vercel Neon integration gives its public VITE_* vars
  // (SERVERSIDE_NEON_VITE_NEON_AUTH_URL). Only names starting with these prefixes reach the browser bundle.
  envPrefix: ["VITE_", "SERVERSIDE_NEON_VITE_"],
  build: {
    rollupOptions: {
      output: {
        // Long-cacheable vendor chunks; Leaflet stays inside the lazily loaded map chunk.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          if (/node_modules\/(@tanstack|zod)\//.test(id)) return "vendor-data";
          return undefined;
        },
      },
    },
  },
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false, rewrite: (path) => path.replace(/^\/api/, "") } } },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts"] },
});
