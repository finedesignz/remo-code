/**
 * Phase 07 — one-shot license provisioning for all existing remo-code users.
 *
 * For each user in `users`:
 *   1. GET keygen /licenses?filter[metadata][remo_code_user_id]={id} — skip if exists.
 *   2. POST keygen /licenses with product + policy + metadata{remo_code_user_id,email}, name "remo-code: {email}".
 *
 * Rate limit: 200ms between creates.
 * Output: .planning/phases/07-titanium-auth-cutover/license-provisioning-log.json
 *
 * Env required: DATABASE_URL, KEYGEN_API_URL, KEYGEN_ACCOUNT_ID, KEYGEN_ADMIN_TOKEN,
 *               KEYGEN_PRODUCT_ID, KEYGEN_POLICY_ID
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const KEYGEN_URL = (process.env.KEYGEN_API_URL || "").replace(/\/+$/, "");
const ACCOUNT = process.env.KEYGEN_ACCOUNT_ID;
const TOKEN = process.env.KEYGEN_ADMIN_TOKEN;
const PRODUCT = process.env.KEYGEN_PRODUCT_ID;
const POLICY = process.env.KEYGEN_POLICY_ID;
const OUTPUT_PATH = process.env.OUTPUT_PATH || resolve(".planning/phases/07-titanium-auth-cutover/license-provisioning-log.json");

if (!DATABASE_URL || !KEYGEN_URL || !ACCOUNT || !TOKEN || !PRODUCT || !POLICY) {
  console.error("Missing env: need DATABASE_URL, KEYGEN_API_URL, KEYGEN_ACCOUNT_ID, KEYGEN_ADMIN_TOKEN, KEYGEN_PRODUCT_ID, KEYGEN_POLICY_ID");
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/vnd.api+json",
  Accept: "application/vnd.api+json",
};

const sql = postgres(DATABASE_URL, { ssl: "prefer", max: 2 });

type Result = { user_id: string; email: string; action: "created" | "existing_skipped" | "error"; license_id?: string; license_key_preview?: string; error?: string };
const results: Result[] = [];

const users = await sql<{ id: string; email: string }[]>`SELECT id::text AS id, email FROM users ORDER BY created_at`;
console.log(`Found ${users.length} users`);

for (const u of users) {
  try {
    // 1. Lookup existing
    const lookupUrl = `${KEYGEN_URL}/v1/accounts/${ACCOUNT}/licenses?filter[metadata]=${encodeURIComponent(JSON.stringify({ remo_code_user_id: u.id }))}`;
    const lookup = await fetch(lookupUrl, { headers });
    if (lookup.ok) {
      const lj = await lookup.json() as any;
      if (Array.isArray(lj.data) && lj.data.length > 0) {
        results.push({ user_id: u.id, email: u.email, action: "existing_skipped", license_id: lj.data[0].id });
        console.log(`  skip ${u.email} — already has license ${lj.data[0].id}`);
        continue;
      }
    }

    // 2. Create
    const createBody = {
      data: {
        type: "licenses",
        attributes: {
          name: `remo-code: ${u.email}`,
          metadata: { remo_code_user_id: u.id, email: u.email, app_slug: "remo-code" },
        },
        relationships: {
          product: { data: { type: "products", id: PRODUCT } },
          policy: { data: { type: "policies", id: POLICY } },
        },
      },
    };
    const create = await fetch(`${KEYGEN_URL}/v1/accounts/${ACCOUNT}/licenses`, { method: "POST", headers, body: JSON.stringify(createBody) });
    if (!create.ok) {
      const errBody = await create.text();
      results.push({ user_id: u.id, email: u.email, action: "error", error: `${create.status}: ${errBody.slice(0, 300)}` });
      console.log(`  ERROR ${u.email}: ${create.status} ${errBody.slice(0, 200)}`);
    } else {
      const cj = await create.json() as any;
      const lid = cj.data?.id;
      const key = cj.data?.attributes?.key || "";
      results.push({ user_id: u.id, email: u.email, action: "created", license_id: lid, license_key_preview: key.slice(0, 8) + "…" });
      console.log(`  created ${u.email} → ${lid}`);
    }
    await new Promise(r => setTimeout(r, 200));
  } catch (e: any) {
    results.push({ user_id: u.id, email: u.email, action: "error", error: e?.message || String(e) });
  }
}

await sql.end();

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
const summary = {
  total_users: users.length,
  created: results.filter(r => r.action === "created").length,
  existing_skipped: results.filter(r => r.action === "existing_skipped").length,
  errors: results.filter(r => r.action === "error").length,
  generated_at: new Date().toISOString(),
  results,
};
writeFileSync(OUTPUT_PATH, JSON.stringify(summary, null, 2));
console.log(`\nWrote ${OUTPUT_PATH}`);
console.log(`Total: ${summary.total_users}  created: ${summary.created}  skipped: ${summary.existing_skipped}  errors: ${summary.errors}`);
process.exit(summary.errors > 0 ? 1 : 0);
