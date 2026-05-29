#!/usr/bin/env bun
/**
 * tools/migration-verify.ts
 *
 * Runs hub/src/db/schema.sql against $DATABASE_URL (expected: clean DB,
 * e.g. a CI Postgres service container). Streams stderr/stdout from psql
 * and FAILS if any line contains "ERROR:" — but NOTICE lines are allowed
 * (CREATE TABLE IF NOT EXISTS emits NOTICE "relation already exists, skipping").
 *
 * Earlier in this observability session, a migration crash was masked because
 * we conflated NOTICE and ERROR. This script distinguishes them explicitly.
 *
 * Requires `psql` on PATH (Ubuntu CI image has it; Windows local may not —
 * the workflow installs postgresql-client).
 *
 * Exit codes:
 *   0 — schema applied cleanly
 *   1 — at least one ERROR: line OR non-zero psql exit
 *   2 — bad invocation / can't find schema
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[migration-verify] DATABASE_URL not set");
    process.exit(2);
  }

  const schemaPath = join(process.cwd(), "hub", "src", "db", "schema.sql");
  if (!existsSync(schemaPath)) {
    console.error(`[migration-verify] schema not found: ${schemaPath}`);
    process.exit(2);
  }
  console.log(`[migration-verify] applying ${schemaPath} to ${dbUrl.replace(/:[^:@]*@/, ":***@")}`);

  const errors: string[] = [];
  const notices: number = 0; // count only — don't print every NOTICE
  let noticeCount = 0;

  const code: number = await new Promise((resolve, reject) => {
    // -v ON_ERROR_STOP=1 makes psql exit non-zero on the FIRST error,
    // which is the loudest signal. -X skips ~/.psqlrc for hermeticity.
    const proc = spawn(
      "psql",
      [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-f", schemaPath],
      { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" },
    );

    const onLine = (chunk: Buffer, from: "stdout" | "stderr") => {
      const lines = chunk.toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        // psql formats: "ERROR:  ..." / "NOTICE:  ..." / "psql:file:line: ERROR: ..."
        // Match both.
        if (/(^|:\s*)ERROR:\s/.test(line)) {
          errors.push(line);
          console.error(`[${from}] ${line}`);
        } else if (/(^|:\s*)NOTICE:\s/.test(line)) {
          noticeCount++;
        } else {
          // surface anything non-trivial (CREATE TABLE etc.) for the log
          console.log(`[${from}] ${line}`);
        }
      }
    };

    proc.stdout.on("data", (c) => onLine(c, "stdout"));
    proc.stderr.on("data", (c) => onLine(c, "stderr"));
    proc.on("error", reject);
    proc.on("exit", (c) => resolve(c ?? 1));
  });

  console.log(`\n[migration-verify] exit=${code}  errors=${errors.length}  notices=${noticeCount}`);

  if (code !== 0 || errors.length > 0) {
    console.error("\n[migration-verify] FAIL — schema apply did not run cleanly.");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("[migration-verify] OK — schema applied cleanly (NOTICEs ignored).");

  // Mark as used to satisfy `noUnusedLocals` if anyone tightens tsconfig.
  void notices;
}

void main();
