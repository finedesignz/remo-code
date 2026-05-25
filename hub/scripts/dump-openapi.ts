/**
 * Boot the hub in-process, fetch /openapi.json, write to docs/openapi.json.
 *
 * Used by `bun run docs:sync` and CI drift check. Does NOT call Bun.serve —
 * we invoke the Hono fetch handler directly so we don't need a port, DB, or
 * any side-effecting imports beyond what _openapi.ts pulls in.
 */
// Required env (JWT_SECRET, DATABASE_URL) is set by the `docs:openapi` npm
// script wrapper so transitive auth/db imports don't crash on a fresh checkout.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openapi } from "../src/api/_openapi.ts";

const res = await openapi.request("/openapi.json");
if (!res.ok) {
  console.error(`[dump-openapi] /openapi.json returned ${res.status}`);
  process.exit(1);
}
const spec = await res.json();

const outDir = resolve(import.meta.dir, "../../docs");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "openapi.json");
writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n");
console.log(`[dump-openapi] wrote ${outPath}`);
