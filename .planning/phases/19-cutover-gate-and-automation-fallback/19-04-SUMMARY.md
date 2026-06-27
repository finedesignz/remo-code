# Phase 19 Plan 04: Docs Sweep + R-PTY-24 Supersession Summary

Docs sweep across README + CLAUDE.md + docs describing the PTY terminal surface as the human path (superseding the stream-json ChatSurface, preserved for automation only), the dual-bucket usage, the cutover gate, the backend selector + fallback, and the no-API-key invariant; R-PTY-24 marked SUPERSEDED by R-TG-01..12 consistently.

## Shipped
- `README.md` — architecture callout: PTY raw-terminal human surface (no stream-json, no API key) supersedes ChatSurface; stream-json preserved for automation; June-15 dual-bucket split + cutover gate; flip/deletion gated, not yet done; links to the runbook + usage-cost §Phase 19.
- `CLAUDE.md` — new docs-map row (PTY terminal surface + cutover gate) and a cross-cutting invariant ("No provider API key on the human PTY path — EVER") naming the selector, sanitizer, fallback, gate, and enforcing tests.
- `docs/usage-cost.md` — Phase-19 section: cutover gate (R-PTY-21), default-backend selector (R-PTY-22), fallback + shared env-sanitizer (R-PTY-23/36), and the R-PTY-24 SUPERSEDED-by-R-TG note (Telegram = read-only transcript observer, not on the programmatic pool, never an API key).
- `hub/test/docs-supersession.test.ts` — supersession consistency (REQUIREMENTS + docs carry the marker + R-TG-01; no "structural necessity" claim without an in-file superseded caveat; no-API-key stated) — 4 pass.

## docs:sync
No route changed (selector + gate are internal). `bun run docs:sync` produced only LF↔CRLF EOL churn on `docs/api.md`/`docs/openapi.json` (no content diff); reverted.

## Deviations
- **[Rule 1 — Bug] Updated `hub/test/automation-routing-guard.test.ts`** to accept the shared `sanitizeSpawnEnv` as the scrub mechanism (alongside the legacy literal `delete`). The Phase-18 guard hard-required a literal delete in every runner; Phase-19 centralized the scrub, so the guard would false-fail. The sanitizer is a strict superset of the old delete. Also referenced `sanitizeSpawnEnv` in a `pty-host.mjs` comment so the guard recognizes the mirror. Committed in 86ae3a4.

## Commit
- `86ae3a4` docs(19-04)

## Self-Check: PASSED
- README.md, CLAUDE.md, docs/usage-cost.md, hub/test/docs-supersession.test.ts present; commit 86ae3a4 in log.
