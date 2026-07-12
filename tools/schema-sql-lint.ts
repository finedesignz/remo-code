#!/usr/bin/env bun
/**
 * tools/schema-sql-lint.ts
 *
 * hub/src/db/schema.sql is applied by hub/src/db/migrate.ts and RE-RUNS IN FULL
 * ON EVERY HUB BOOT. "Idempotent DDL only" was a convention enforced by nothing
 * but prose — one UPDATE/INSERT/DELETE/DROP/TRUNCATE that slips in re-fires
 * against PRODUCTION on every deploy, with no rollback (see incident #176).
 *
 * This lint hard-fails on any statement-leading data-mutating / destructive
 * keyword in schema.sql.
 *
 * Escape hatch (deliberate, reviewed, one statement at a time): put
 *
 *   -- schema-lint: allow <reason>
 *
 * in the comment block immediately above the statement. A pragma exempts ONLY
 * the next statement. Adding one is a code-review decision — the pragma is not
 * a way to make the lint quiet, it is a way to record that a mutating statement
 * is convergent (its WHERE clause matches zero rows once applied) and that you
 * accept it re-running on every boot forever.
 *
 * Exit codes:
 *   0 — clean (allowed-by-pragma statements are listed, not failed)
 *   1 — an un-pragma'd mutating statement was found
 *   2 — could not read schema.sql
 *
 * Usage: bun run tools/schema-sql-lint.ts [path/to/schema.sql]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Statement-leading keywords that must never re-run against prod on boot. */
const BANNED = ["UPDATE", "INSERT", "DELETE", "TRUNCATE", "DROP"] as const;

const PRAGMA = /--\s*schema-lint:\s*allow\b(.*)$/im;

export interface Finding {
  line: number;
  keyword: string;
  /** The offending statement, comments stripped, first line only. */
  statement: string;
  /** Non-null when a `-- schema-lint: allow` pragma exempted it. */
  allowedReason: string | null;
}

/**
 * Split `sqlText` into statements on top-level `;`, tracking, per statement:
 *   - `raw`   — the source slice INCLUDING its leading comment block (that is
 *               where a pragma lives),
 *   - `code`  — the same slice with comments removed (so `-- ... INSERTED ...`
 *               prose and `DROP` inside a comment can never trip the lint),
 *   - `line`  — 1-based line of the first code character.
 *
 * Quoting rules mirror hub/src/db/migrate.ts's splitter (single/double quotes,
 * dollar-quoting, line + nested block comments) so the lint sees exactly the
 * statements the migrator will execute.
 */
function splitStatements(sqlText: string): Array<{ prefix: string; code: string; line: number }> {
  const out: Array<{ prefix: string; code: string; line: number }> = [];
  let raw = "";
  let code = "";
  let codeLine = 0;
  /** raw text preceding the statement's first code character (its comment block). */
  let prefix = "";
  let line = 1;
  let i = 0;
  const n = sqlText.length;

  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let blockDepth = 0;
  let dollarTag: string | null = null;

  const pushCode = (s: string) => {
    if (codeLine === 0 && s.trim().length > 0) {
      codeLine = line;
      prefix = raw.slice(0, raw.length - s.length);
    }
    code += s;
  };
  const flush = () => {
    if (code.trim().length > 0) out.push({ prefix, code, line: codeLine });
    raw = "";
    code = "";
    prefix = "";
    codeLine = 0;
  };

  while (i < n) {
    const c = sqlText[i];
    const c2 = sqlText[i + 1];
    if (c === "\n") line++;

    if (inLineComment) {
      raw += c;
      if (c === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (blockDepth > 0) {
      raw += c;
      if (c === "/" && c2 === "*") { blockDepth++; raw += c2; i += 2; continue; }
      if (c === "*" && c2 === "/") { blockDepth--; raw += c2; i += 2; continue; }
      i++;
      continue;
    }
    if (dollarTag !== null) {
      if (c === "$" && sqlText.startsWith(dollarTag, i)) {
        raw += dollarTag; pushCode(dollarTag);
        i += dollarTag.length; dollarTag = null; continue;
      }
      raw += c; pushCode(c); i++; continue;
    }
    if (inSingle) {
      raw += c; pushCode(c);
      if (c === "'") {
        if (c2 === "'") { raw += c2; pushCode(c2); i += 2; continue; }
        inSingle = false;
      }
      i++; continue;
    }
    if (inDouble) {
      raw += c; pushCode(c);
      if (c === '"') {
        if (c2 === '"') { raw += c2; pushCode(c2); i += 2; continue; }
        inDouble = false;
      }
      i++; continue;
    }
    if (c === "-" && c2 === "-") { inLineComment = true; raw += c + c2; i += 2; continue; }
    if (c === "/" && c2 === "*") { blockDepth = 1; raw += c + c2; i += 2; continue; }
    if (c === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sqlText.slice(i));
      if (tag) { raw += tag[0]; pushCode(tag[0]); i += tag[0].length; continue; }
      raw += c; pushCode(c); i++; continue;
    }
    if (c === "'") { inSingle = true; raw += c; pushCode(c); i++; continue; }
    if (c === '"') { inDouble = true; raw += c; pushCode(c); i++; continue; }
    if (c === ";") { flush(); i++; continue; }

    raw += c;
    pushCode(c);
    i++;
  }
  flush();
  return out;
}

export function lintSchemaSql(sqlText: string): Finding[] {
  const findings: Finding[] = [];
  for (const stmt of splitStatements(sqlText)) {
    const code = stmt.code.trim();
    const first = /^([A-Za-z]+)/.exec(code)?.[1]?.toUpperCase();
    if (!first || !(BANNED as readonly string[]).includes(first)) continue;
    // A pragma is only honoured in the comment block attached to THIS statement.
    const m = PRAGMA.exec(stmt.prefix);
    findings.push({
      line: stmt.line,
      keyword: first,
      statement: code.split("\n")[0].trim(),
      allowedReason: m ? (m[1] ?? "").trim() || "(no reason given)" : null,
    });
  }
  return findings;
}

function main() {
  const target = process.argv[2] ?? resolve(import.meta.dir, "../hub/src/db/schema.sql");
  let text: string;
  try {
    text = readFileSync(target, "utf-8");
  } catch (err: any) {
    console.error(`[schema-lint] cannot read ${target}: ${err.message}`);
    process.exit(2);
  }

  const findings = lintSchemaSql(text);
  const violations = findings.filter((f) => f.allowedReason === null);
  const allowed = findings.filter((f) => f.allowedReason !== null);

  for (const f of allowed) {
    console.log(`[schema-lint] allowed  ${target}:${f.line}  ${f.keyword} — ${f.allowedReason}`);
  }

  if (violations.length === 0) {
    console.log(`[schema-lint] OK — no un-pragma'd mutating statements (${allowed.length} allowed).`);
    process.exit(0);
  }

  console.error(
    `\n[schema-lint] FAIL — schema.sql re-runs IN FULL on every hub boot, so these\n` +
      `statements would re-fire against PRODUCTION on every deploy:\n`,
  );
  for (const f of violations) {
    console.error(`  ${target}:${f.line}  ${f.keyword}\n    ${f.statement}`);
  }
  console.error(
    `\nMove data changes to a one-shot script in hub/scripts/. If the statement is\n` +
      `genuinely convergent and must live here, add above it:\n` +
      `  -- schema-lint: allow <why this matches zero rows once applied>\n`,
  );
  process.exit(1);
}

if (import.meta.main) main();
