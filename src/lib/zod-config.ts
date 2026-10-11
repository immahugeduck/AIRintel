import { z } from "zod";

// Zod 4 probes `new Function()` to JIT-compile validators. The production CSP (script-src 'self', no 'unsafe-eval')
// forbids that and the probe would raise a CSP violation on every load. Interpreted validation is plenty fast here.
// This module is imported first in main.tsx so it runs before any schema is constructed.
z.config({ jitless: true });
