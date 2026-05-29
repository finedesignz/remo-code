#!/usr/bin/env bun
/**
 * tools/check-baseline.ts
 *
 * Runs `bun test` in hub/ with junit reporter, parses the testsuites root element
 * for tests/skipped/failures, compares vs tools/regression-baseline.json.
 *
 * Exit codes:
 *   0 — within tolerance
 *   1 — drift detected (fail > 0 OR pass < pass_min OR skip > skip_max)
 *   2 — could not run / parse
 *
 * Usage: bun run tools/check-baseline.ts
 */

import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface Baseline {
  pass: number;
  skip: number;
  fail: number;
  total: number;
  tolerance: {
    pass_min: number;
    skip_max: number;
    fail_max: number;
  };
}

interface Counts {
  pass: number;
  skip: number;
  fail: number;
  total: number;
}

function parseJunit(xml: string): Counts {
  // Bun emits a root <testsuites tests="N" failures="N" skipped="N" ...>
  const root = xml.match(/<testsuites\b[^>]*>/);
  if (!root) throw new Error("no <testsuites> root in junit output");
  const attr = (name: string): number => {
    const m = root[0].match(new RegExp(`${name}="(\\d+)"`));
    if (!m) throw new Error(`missing attr ${name} on <testsuites>`);
    return parseInt(m[1], 10);
  };
  const total = attr("tests");
  const fail = attr("failures");
  const skip = attr("skipped");
  const pass = total - fail - skip;
  return { pass, skip, fail, total };
}

// Recursively collect *.test.ts files under hub/test, relative to hub/.
function collectTestFiles(hubDir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(childAbs, childRel);
      else if (ent.name.endsWith(".test.ts")) out.push(`test/${childRel}`);
    }
  };
  walk(join(hubDir, "test"), "");
  return out.sort();
}

function runOneFile(hubDir: string, relFile: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "bun",
      ["test", relFile, "--reporter", "junit", "--reporter-outfile", outPath],
      { cwd: hubDir, stdio: "inherit", shell: process.platform === "win32" },
    );
    proc.on("error", reject);
    proc.on("exit", () => resolve()); // non-zero on failures — we parse junit and decide.
  });
}

// Per-file process isolation: run EACH test file in its own `bun test <file>`
// process and aggregate the junit totals. Bun's `mock.module()` is process-global
// and first-write-wins, so a partial mock in one file otherwise leaks into the
// next, making the full-suite run ORDER-DEPENDENT (passes on one platform's
// file-glob order, cascades "Export named X not found" / stale stubs on another).
// Separate processes share no module registry → zero cross-file leakage,
// permanently, regardless of future polluting tests. Makes local == CI.
async function runHubTestsIsolated(tmpDir: string): Promise<Counts> {
  const hubDir = join(process.cwd(), "hub");
  const files = collectTestFiles(hubDir);
  const agg: Counts = { pass: 0, skip: 0, fail: 0, total: 0 };
  let i = 0;
  for (const rel of files) {
    const outPath = join(tmpDir, `junit-${i++}.xml`);
    await runOneFile(hubDir, rel, outPath);
    let c: Counts;
    try {
      c = parseJunit(readFileSync(outPath, "utf8"));
    } catch (e) {
      // A file that fails to even produce junit (load crash) counts as a hard
      // failure so the gate flags it rather than silently dropping its tests.
      console.error(`[check-baseline] ${rel}: could not parse junit (${(e as Error).message}) — counting 1 fail`);
      c = { pass: 0, skip: 0, fail: 1, total: 1 };
    }
    agg.pass += c.pass;
    agg.skip += c.skip;
    agg.fail += c.fail;
    agg.total += c.total;
  }
  return agg;
}

async function main() {
  const baselinePath = join(process.cwd(), "tools", "regression-baseline.json");
  let baseline: Baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (e) {
    console.error(`[check-baseline] cannot read ${baselinePath}: ${(e as Error).message}`);
    process.exit(2);
  }

  const tmp = mkdtempSync(join(tmpdir(), "remo-baseline-"));
  try {
    const got = await runHubTestsIsolated(tmp);

    console.log("\n[check-baseline] results");
    console.log(`  baseline: pass=${baseline.pass} skip=${baseline.skip} fail=${baseline.fail} total=${baseline.total}`);
    console.log(`  actual:   pass=${got.pass} skip=${got.skip} fail=${got.fail} total=${got.total}`);

    const failures: string[] = [];
    if (got.fail > baseline.tolerance.fail_max) {
      failures.push(`fail=${got.fail} > tolerance.fail_max=${baseline.tolerance.fail_max}`);
    }
    if (got.pass < baseline.tolerance.pass_min) {
      failures.push(`pass=${got.pass} < tolerance.pass_min=${baseline.tolerance.pass_min} (regression)`);
    }
    if (got.skip > baseline.tolerance.skip_max) {
      failures.push(`skip=${got.skip} > tolerance.skip_max=${baseline.tolerance.skip_max} (too many skips)`);
    }

    if (failures.length) {
      console.error("\n[check-baseline] DRIFT:");
      for (const f of failures) console.error(`  - ${f}`);
      console.error("\nIf intentional, update tools/regression-baseline.json in the same PR.");
      process.exit(1);
    }
    console.log("\n[check-baseline] OK — within tolerance.");
  } catch (e) {
    console.error(`[check-baseline] error: ${(e as Error).message}`);
    process.exit(2);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

void main();
