// Finding 1 (security, BLOCKER): the AgentAutofix comment widget must never
// forward the query string as `page_url` or in `element_meta.attrs.href` —
// this repo carries magic-link auth tokens (and other PII, e.g. emails in
// ?q=) in query params, and shape-based redaction would miss ordinary PII
// while still leaking secrets.
//
// This app is 100% hash-routed (#/, #/tasks, #/settings, #/grid — see
// web/src/lib/ui/nav.ts) and web/src/App.tsx force-normalizes
// `location.pathname` to `/` on every boot, so `location.origin +
// location.pathname` alone is a CONSTANT for every report — zero
// diagnostic value. The fix forwards the hash ROUTE PATH (the part before
// its own `?`) while still stripping every query string, wherever it
// appears (real `location.search`, or one embedded inside the hash).
//
// Finding 2 (security, BLOCKER): `ATTR_ALLOWLIST` includes `href`, and it
// used to be copied verbatim (200-char slice, no sanitization) into
// `element_meta.attrs.href` — the same leak class as page_url, reopened one
// field over (proven exploit path: MessageBubble.tsx renders chat markdown
// links straight into `<a href>`, so a token-bearing URL in a chat message
// was one Ctrl-click from exfiltration). The fix applies the same
// origin+pathname-only sanitization to href, drops `javascript:`/`data:`
// URIs entirely, and drops anything that fails to parse as a URL.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WIDGET_PATH = join(import.meta.dir, "..", "public", "agentautofix-widget.js");
const src = readFileSync(WIDGET_PATH, "utf8");

/** Extract a top-level `function name(...) { ... }` block from the widget
 * source by brace-matching (the functions are plain, non-nested-brace-heavy,
 * so this is reliable), then eval it standalone with a mocked `location` /
 * real global `URL` so the tests exercise the ACTUAL widget logic rather
 * than a reimplementation of it. */
function extractFunction(name: string): string {
  const startMatch = src.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`));
  if (!startMatch || startMatch.index === undefined) {
    throw new Error(`function ${name} not found in widget source`);
  }
  let i = startMatch.index + startMatch[0].length;
  let depth = 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(startMatch.index, i);
}

function loadWithLocation(loc: { origin: string; pathname: string; hash: string; href: string }) {
  const hashRouteSrc = extractFunction("hashRoute");
  const sanitizeHrefSrc = extractFunction("sanitizeHref");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "location",
    "URL",
    `${hashRouteSrc}\n${sanitizeHrefSrc}\nreturn { hashRoute: hashRoute, sanitizeHref: sanitizeHref };`,
  );
  return factory(loc, URL) as { hashRoute: () => string; sanitizeHref: (raw: unknown) => string | null };
}

describe("agentautofix-widget page_url", () => {
  test("never sends the raw location.href as page_url", () => {
    expect(src).not.toMatch(/page_url:\s*location\.href/);
  });

  test("page_url composition includes the sanitized hash route, not raw location.pathname alone", () => {
    expect(src).toMatch(/page_url:\s*\(location\.origin \+ location\.pathname \+ hashRoute\(\)\)/);
  });

  test("hash route preserved, hash query stripped (#/settings?tab=x&token=SECRET -> #/settings)", () => {
    const { hashRoute } = loadWithLocation({
      origin: "https://app.remo-code.com",
      pathname: "/",
      hash: "#/settings?tab=connections&token=SECRET",
      href: "https://app.remo-code.com/#/settings?tab=connections&token=SECRET",
    });
    expect(hashRoute()).toBe("#/settings");
    expect(hashRoute()).not.toContain("token=");
    expect(hashRoute()).not.toContain("SECRET");
  });

  test("hash route with no query passes through unchanged (#/grid)", () => {
    const { hashRoute } = loadWithLocation({
      origin: "https://app.remo-code.com",
      pathname: "/",
      hash: "#/grid",
      href: "https://app.remo-code.com/#/grid",
    });
    expect(hashRoute()).toBe("#/grid");
  });

  test("real location.search never appears in the composed page_url, even if present", () => {
    const loc = {
      origin: "https://app.remo-code.com",
      pathname: "/",
      search: "?leaked=should-never-appear",
      hash: "#/tasks?tab=activity",
      href: "https://app.remo-code.com/?leaked=should-never-appear#/tasks?tab=activity",
    };
    const { hashRoute } = loadWithLocation(loc);
    const pageUrl = loc.origin + loc.pathname + hashRoute();
    expect(pageUrl).toBe("https://app.remo-code.com/#/tasks");
    expect(pageUrl).not.toContain("leaked");
    expect(pageUrl).not.toContain("?");
  });

  test("page_url is no longer a constant across different hash routes", () => {
    const settings = loadWithLocation({
      origin: "https://app.remo-code.com",
      pathname: "/",
      hash: "#/settings",
      href: "https://app.remo-code.com/#/settings",
    });
    const tasks = loadWithLocation({
      origin: "https://app.remo-code.com",
      pathname: "/",
      hash: "#/tasks",
      href: "https://app.remo-code.com/#/tasks",
    });
    expect(settings.hashRoute()).not.toBe(tasks.hashRoute());
  });
});

describe("agentautofix-widget href sanitization", () => {
  const loc = {
    origin: "https://app.remo-code.com",
    pathname: "/",
    hash: "#/",
    href: "https://app.remo-code.com/#/",
  };

  test("ATTR_ALLOWLIST still allows href (sanitized, not deleted)", () => {
    expect(src).toMatch(/ATTR_ALLOWLIST = \[[^\]]*'href'[^\]]*\]/);
  });

  test("href with a token query is sanitized — token absent, origin+pathname kept", () => {
    const { sanitizeHref } = loadWithLocation(loc);
    const result = sanitizeHref("https://app.remo-code.com/api/agentautofix/token?magic=SECRETTOKEN123");
    expect(result).toBe("https://app.remo-code.com/api/agentautofix/token");
    expect(result).not.toContain("SECRETTOKEN123");
    expect(result).not.toContain("magic=");
  });

  test("relative href with a query is sanitized against the current page origin", () => {
    const { sanitizeHref } = loadWithLocation(loc);
    const result = sanitizeHref("/settings/connections?token=abc123");
    expect(result).toBe("https://app.remo-code.com/settings/connections");
    expect(result).not.toContain("token=");
  });

  test("bare fragment href resolves without leaking a query", () => {
    const { sanitizeHref } = loadWithLocation(loc);
    const result = sanitizeHref("#section-2");
    expect(result).not.toBeNull();
    expect(result).not.toContain("?");
    expect(result).not.toContain("#");
  });

  test("javascript: URI is dropped entirely, not shipped", () => {
    const { sanitizeHref } = loadWithLocation(loc);
    expect(sanitizeHref("javascript:alert(document.cookie)")).toBeNull();
  });

  test("data: URI is dropped entirely, not shipped", () => {
    const { sanitizeHref } = loadWithLocation(loc);
    expect(sanitizeHref("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toBeNull();
  });

  test("malformed href does not crash and ships nothing sensitive", () => {
    const { sanitizeHref } = loadWithLocation(loc);
    const malformed = "http://a b c/path?token=SECRET"; // spaces in host -> fails URL parsing
    expect(() => sanitizeHref(malformed)).not.toThrow();
    const result = sanitizeHref(malformed);
    expect(result === null || !result.includes("SECRET")).toBe(true);
  });

  test("empty/null href does not crash", () => {
    const { sanitizeHref } = loadWithLocation(loc);
    expect(() => sanitizeHref("")).not.toThrow();
    expect(() => sanitizeHref(null)).not.toThrow();
    expect(sanitizeHref("")).toBeNull();
  });

  test("metaFor sanitizes href via sanitizeHref before falling through to the raw-copy branch", () => {
    expect(src).toMatch(/if \(a\.name === 'href'\) \{\s*\n\s*var safeHref = sanitizeHref\(a\.value\);\s*\n\s*if \(safeHref !== null\) attrs\.href = safeHref;\s*\n\s*continue;\s*\n\s*\}/);
  });
});
