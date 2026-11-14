#!/usr/bin/env bun
/**
 * CORCH-08 one-shot, idempotent backfill: provision at AgentAutofix every enrolled corch_projects row that is not
 * yet `provisioned` (projects enrolled before CORCH-08 default to `aaf_unprovisioned`, which the dispatcher
 * never dispatches).
 *
 * Env: DATABASE_URL, REMO_CORCH_AAF_URL, REMO_CORCH_AAF_TOKEN (scope projects:write),
 *      REMO_CORCH_AAF_INSTALLATION_ID. With any of the AAF vars unset nothing is called and every project stays
 *      aaf_unprovisioned (reported, exit code 1).
 *
 * Idempotent: a second run finds nothing left to do (provisioned rows are skipped) and AAF's provision endpoint is
 * itself idempotent. Prints counts only: never a token, never a response body.
 */
import { provisionExisting } from '../src/corch/aaf-provision.ts'
import { corchStore } from '../src/corch/store.ts'
import { sql } from '../src/db/postgres.ts'

try {
  const s = await provisionExisting(corchStore)
  console.log(`corch-provision-existing: total=${s.total} provisioned=${s.provisioned} failed=${s.failed}`)
  process.exitCode = s.failed > 0 ? 1 : 0
} finally {
  await sql.end({ timeout: 5 })
}
