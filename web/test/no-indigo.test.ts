// Accent guard: enforces the design-preferences.md "never indigo" rule.
// The app accent is BLUE; the forbidden indigo token must never reappear
// anywhere under web/src. This test recursively scans every source file and
// fails the build (reporting file:line) on any match, blocking reintroduction.
//
// NB: the forbidden token is assembled at runtime so this guard file itself
// does not contain the literal substring and never matches its own scan.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");
const FORBIDDEN = ["ind", "igo"].join(""); // assembled, not a literal
const FORBIDDEN_RE = new RegExp(FORBIDDEN, "i");

// Scan source-like files only; skip binaries/assets.
const SCAN_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".html",
  ".json",
  ".md",
  ".svg",
]);

function collect(): string[] {
  const glob = new Bun.Glob("**/*");
  const out: string[] = [];
  for (const rel of glob.scanSync({ cwd: SRC_DIR, onlyFiles: true })) {
    const dot = rel.lastIndexOf(".");
    const ext = dot === -1 ? "" : rel.slice(dot).toLowerCase();
    if (SCAN_EXT.has(ext)) out.push(join(SRC_DIR, rel));
  }
  return out;
}

describe("accent guard (no indigo under web/src)", () => {
  test("no source file contains the forbidden accent token", () => {
    const offenders: string[] = [];
    for (const file of collect()) {
      const text = readFileSync(file, "utf8");
      if (!FORBIDDEN_RE.test(text)) continue;
      text.split(/\r?\n/).forEach((line, i) => {
        if (FORBIDDEN_RE.test(line)) {
          offenders.push(`${relative(SRC_DIR, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    if (offenders.length > 0) {
      throw new Error(
        `Forbidden "${FORBIDDEN}" accent token found (use blue per design-preferences.md):\n` +
          offenders.join("\n")
      );
    }
    expect(offenders).toEqual([]);
  });
});
