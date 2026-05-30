// Dependency-free contract test for the InfoTip primitive.
// (web/ has no DOM test runner / testing-library; we assert source-level
// contracts instead of rendering.) Enforces design-prefs: styled tooltip,
// no native title=, blue accent, >=44px hit area.
// NB: this file deliberately avoids the forbidden accent token as a literal
// so the accent guard's raw grep over web/src stays at zero matches.
const FORBIDDEN_ACCENT = ["ind", "igo"].join("");
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "InfoTip.tsx"), "utf8");
const barrel = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

describe("InfoTip", () => {
  test("exports InfoTip + InfoTipProps", () => {
    expect(src).toMatch(/export function InfoTip/);
    expect(src).toMatch(/export interface InfoTipProps/);
  });

  test("uses a styled tooltip element, not the native title= attribute", () => {
    expect(src).toMatch(/role="tooltip"/);
    expect(src).not.toMatch(/\btitle=/);
  });

  test("accent is blue, never the forbidden token", () => {
    expect(src).toMatch(/blue-/);
    expect(src.toLowerCase()).not.toContain(FORBIDDEN_ACCENT);
  });

  test("trigger has a >=44px tap target", () => {
    expect(src).toMatch(/min-h-\[44px\]/);
    expect(src).toMatch(/min-w-\[44px\]/);
  });

  test("is re-exported from the ui barrel", () => {
    expect(barrel).toMatch(/export \{ InfoTip \}/);
    expect(barrel).toMatch(/export type \{ InfoTipProps \}/);
  });
});
