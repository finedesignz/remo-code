// Finding 1 (security): the AgentAutofix comment widget must never forward
// the query string or hash fragment as `page_url` — this repo carries
// magic-link auth tokens (and other PII, e.g. emails in ?q=) in query
// params, and shape-based redaction would miss ordinary PII while still
// leaking secrets. The fix strips query/hash outright via
// `location.origin + location.pathname`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WIDGET_PATH = join(import.meta.dir, "..", "public", "agentautofix-widget.js");

describe("agentautofix-widget page_url", () => {
  const src = readFileSync(WIDGET_PATH, "utf8");

  test("never sends the raw location.href as page_url", () => {
    expect(src).not.toMatch(/page_url:\s*location\.href/);
  });

  test("builds page_url from origin + pathname only", () => {
    expect(src).toMatch(/page_url:\s*\(location\.origin \+ location\.pathname\)/);
  });

  test("origin+pathname composition drops query string and hash", () => {
    const loc = {
      origin: "https://app.remo-code.com",
      pathname: "/settings",
      href: "https://app.remo-code.com/settings?token=super-secret&q=user@example.com#frag",
    };
    const pageUrl = (loc.origin + loc.pathname).slice(0, 2000);
    expect(pageUrl).toBe("https://app.remo-code.com/settings");
    expect(pageUrl).not.toContain("token=");
    expect(pageUrl).not.toContain("user@example.com");
    expect(pageUrl).not.toContain("#frag");
  });
});
