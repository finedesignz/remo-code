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
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
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

async function runHubTests(outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "bun",
      ["test", "--reporter", "junit", "--reporter-outfile", outPath],
      { cwd: join(process.cwd(), "hub"), stdio: "inherit", shell: process.platform === "win32" },
    );
    proc.on("error", reject);
    proc.on("exit", (code) => {
      // bun test exits non-zero when any test fails — we still parse junit and decide.
      resolve();
      void code;
    });
  });
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
  const junitPath = join(tmp, "junit.xml");
  try {
    await runHubTests(junitPath);
    const xml = readFileSync(junitPath, "utf8");
    const got = parseJunit(xml);

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
