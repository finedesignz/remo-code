#!/usr/bin/env bun
/**
 * tools/smoke-https.ts
 *
 * Hits every public route the hub exposes and asserts a "route is alive"
 * status code (200/401/403). Anything else (404 / 5xx / network error)
 * fails the smoke.
 *
 * Per .claude/.../memory/feedback_https_url_smoke.md — /healthz alone
 * does NOT prove route health; we need full coverage to catch:
 *   - 502 from Bun idleTimeout / proxy drift
 *   - 500 from missing DAL helpers
 *   - 404 from middleware drift / license-gate regressions
 *
 * Usage:
 *   bun run tools/smoke-https.ts https://app.remo-code.com
 *   SMOKE_BASE_URL=https://app.remo-code.com bun run tools/smoke-https.ts
 *
 * Exit codes:
 *   0 — all probes returned an expected status
 *   1 — at least one probe failed
 *   2 — bad invocation (no base URL)
 */

interface Probe {
  path: string;
  method?: "GET" | "HEAD";
  // expected status codes — anything in this set passes.
  // 200 = OK, 401 = auth wall (route mounted, auth required),
  // 403 = forbidden (mounted, license/csrf gate). 404/5xx fail.
  ok: number[];
  notes?: string;
}

// Endpoint list per .claude/projects/.../memory/feedback_https_url_smoke.md
// "remo-code hub" section. Update both files in lockstep.
const PROBES: Probe[] = [
  { path: "/healthz",                                  ok: [200],         notes: "process up" },
  { path: "/api/profile",                              ok: [401, 403],    notes: "auth wall" },
  { path: "/api/profile/license",                      ok: [401, 403],    notes: "auth wall (not license-gated)" },
  { path: "/api/profile/cost-today",                   ok: [401, 403],    notes: "auth wall" },
  { path: "/api/sessions",                             ok: [401, 403],    notes: "auth wall" },
  { path: "/api/supervisors",                          ok: [401, 403],    notes: "auth wall" },
  { path: "/api/scheduled-tasks",                      ok: [401, 403],    notes: "auth wall" },
  { path: "/api/error-projects",                       ok: [401, 403],    notes: "auth wall" },
  { path: "/api/orchestrator",                         ok: [401, 403, 404], notes: "auth wall; tolerate 404 if subrouter unmounted" },
  { path: "/api/chat-tabs",                            ok: [401, 403],    notes: "auth wall" },
  { path: "/api/account/coolify-webhook-secret",       ok: [401, 403],    notes: "auth wall" },
  { path: "/api/account/coolify-webhook-attempts",     ok: [401, 403],    notes: "auth wall" },
  { path: "/openapi.json",                             ok: [200],         notes: "OpenAPI spec" },
  { path: "/docs",                                     ok: [200],         notes: "Scalar UI" },
];

interface Result {
  path: string;
  method: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  error?: string;
}

async function probe(baseUrl: string, p: Probe): Promise<Result> {
  const method = p.method ?? "GET";
  const url = `${baseUrl}${p.path}`;
  const t0 = performance.now();
  try {
    // 10s timeout — slow probes signal proxy trouble too.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(url, {
      method,
      redirect: "manual",
      headers: { "user-agent": "remo-code-smoke/1.0" },
      signal: ac.signal,
    });
    clearTimeout(timer);
    const status = res.status;
    return {
      path: p.path,
      method,
      status,
      ok: p.ok.includes(status),
      durationMs: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return {
      path: p.path,
      method,
      status: null,
      ok: false,
      durationMs: Math.round(performance.now() - t0),
      error: (e as Error).message,
    };
  }
}

async function main() {
  const baseUrl = (process.argv[2] || process.env.SMOKE_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    console.error("usage: bun run tools/smoke-https.ts <base-url>");
    console.error("   or: SMOKE_BASE_URL=https://... bun run tools/smoke-https.ts");
    process.exit(2);
  }
  console.log(`[smoke-https] base=${baseUrl}  probes=${PROBES.length}\n`);

  // Modest concurrency — be polite to prod, but don't take forever.
  const CONCURRENCY = 4;
  const results: Result[] = [];
  const queue = [...PROBES];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const p = queue.shift();
      if (!p) return;
      results.push(await probe(baseUrl, p));
    }
  });
  await Promise.all(workers);

  // Stable report order = input order.
  const byPath = new Map(results.map((r) => [r.path, r] as const));
  let failed = 0;
  for (const p of PROBES) {
    const r = byPath.get(p.path)!;
    const mark = r.ok ? "OK  " : "FAIL";
    const detail = r.error ? ` error=${r.error}` : ` expected=${p.ok.join("|")}`;
    console.log(`  ${mark} ${r.method.padEnd(4)} ${p.path.padEnd(50)} status=${r.status ?? "-"} ${r.durationMs}ms${r.ok ? "" : detail}`);
    if (!r.ok) failed++;
  }
  const passed = results.length - failed;
  console.log(`\n[smoke-https] ${passed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
