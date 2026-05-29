# Testing Patterns

**Analysis Date:** 2026-05-28

## Test Framework

**Runner:** `bun test` (built-in). No Jest, no Vitest.

**Assertion API:** `bun:test` — `describe`, `test`, `expect`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll`.

**Config:** None. Bun discovers `*.test.ts` automatically. No `jest.config` / `vitest.config` files.

**Run commands:**
```bash
cd hub && bun test                     # all hub tests
cd hub && bun test scheduler.test.ts   # single file
cd supervisor && bun test              # all supervisor tests
```

There is NO root `bun test` script — tests run per-package.

## Test File Organization

**Location — separate test dirs (NOT colocated):**
- `hub/test/*.test.ts` — 80+ files. Unit + integration.
- `hub/test/integration/` — multi-module flows (e.g. `auth-flow.test.ts`).
- `hub/test/fixtures/` — static JSON vectors + generator scripts (`titanium-vectors.json`, `gen-titanium-vectors.ts`).
- `supervisor/test/*.test.ts` — 11 files. Process-manager + runner + git + canaries.
- **`web/` has NO test runner.** UI components are NOT unit-tested. Web is covered only by `tsc -b` (type check) + Vite build + manual QC sweeps documented in `.planning/phases/<NN>/QC-UI.md`.

**Naming:**
- Unit / module tests: `<feature>.test.ts` (`scheduler.test.ts`, `cidr.test.ts`).
- End-to-end (DB-backed): `<feature>.e2e.test.ts` (`scheduled-tasks.e2e.test.ts`, `phase-08.e2e.test.ts`, `phase-11.e2e.test.ts`, `coolify-webhook-triage-e2e.test.ts`).
- Canaries: descriptive (`no-legacy-agent-spawn.test.ts`).

## Test Structure

Top-of-file module doc block explaining purpose + scope + DB requirements is the norm. Example pattern (`hub/test/scheduler.test.ts:1-22`):

```typescript
/**
 * Scheduler unit tests (W5/T23).
 * Covers pure-logic modules of the scheduler that don't depend on DB or WS
 * registries. Anything that requires a live Postgres or live socket lives in
 * scheduled-tasks.e2e.test.ts. Run with `bun test` from `hub/`.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { /* SUT */ } from '../src/scheduler/cron.ts'

describe('cron util', () => {
  beforeEach(() => { /* reset module state */ })
  test('validates expression', () => {
    expect(validate('*/5 * * * *')).toBe(true)
  })
})
```

**Patterns:**
- `_reset()` helpers exported from modules with process-wide state (session-queue, registry) for `beforeEach` cleanup.
- Skip e2e files via `if (!process.env.REMO_E2E_DB_URL) { test.skip(...) }` rather than env-detect in `describe`.

## Mocking

**Framework:** Bun's built-in `mock()` / `spyOn()` from `bun:test`. No `jest.mock`, no `sinon`.

**Conventions:**
- Mock at the import boundary — replace exported functions of DAL / sender modules.
- Prefer dependency injection (pass deps as args) over import-time mocks. The scheduler dispatcher accepts senders as a parameter set for this reason.
- Fake clock: pass deterministic `now: Date` into pure functions (catchup, cost-cap) instead of mocking `Date.now`.

**What to mock:**
- Outbound network (Octokit, fetch to Coolify, fetch to gateway).
- WS sockets (use a minimal `{ send, readyState }` stub).
- Postgres (only when a pure-logic test accidentally pulls a DAL — prefer not to import DALs in unit tests).

**What NOT to mock:**
- `croner` — use it for real; its behavior is the contract.
- `zod` schemas — never bypass; validate real inputs.
- Crypto / HMAC — verify with real signatures over real raw bodies.

## Fixtures and Factories

- Static JSON in `hub/test/fixtures/` (e.g. `titanium-vectors.json` — EdDSA-signed Keygen tokens for offline JWKS verification tests).
- Generators next to fixtures (`gen-titanium-vectors.ts`) — run to refresh vectors when keys rotate.
- Inline factories at top of each test file for small shapes (mock sessions, mock tasks).

## Coverage

No enforced coverage threshold. No `bun test --coverage` in CI. Quality measured by test-count + behavioral assertions, not %.

## Test Types

**Unit tests** (no DB, no WS):
- Pure logic modules: cron, fingerprint, classifier, schema validation, template render, CIDR, idempotency hashing.
- ~50 files in `hub/test/`.

**Integration tests** (in-process, may touch DALs with mocked pg):
- Hono router behavior, middleware chains (license-gate, csrf, reauth, require-admin).
- WS protocol handshake + frame validation.

**E2E tests** (require live Postgres):
- Gated on `REMO_E2E_DB_URL` env var. Skip silently when unset.
- Files: `scheduled-tasks.e2e.test.ts`, `phase-08.e2e.test.ts`, `phase-11.e2e.test.ts`, `coolify-webhook-triage-e2e.test.ts`, `auth-flow.test.ts` (integration/), DAL migration tests.
- These account for the 93 `skip` count in CI runs.

**Canary tests:**
- `supervisor/test/no-legacy-agent-spawn.test.ts` — greps `supervisor/src/**` + `supervisor/tauri/src-tauri/**` for forbidden CLI tokens (`remo-code-agent`, retired npx invocations). FAILS the build if they reappear. Phase 09 regression guard.
- `hub/test/known-paths-registry.test.ts` — similar canary for path registry drift.

## Per-Phase QC Reports

Each phase ships QC reports under `.planning/phases/<NN>-<slug>/`:
- `QC-BUILD.md` — `bun install`, web tsc, web build, hub tsc (N/A), `hub/ bun test`, `supervisor/ bun test`. Counts + diff vs prior baseline.
- `QC-UI.md` — manual UI sweep (when phase touches `web/`).
- `REVIEW.md` — verifier subagent verdict.

## Current Test Counts (Phase 12 baseline, 2026-05-28)

From `.planning/phases/12-ui-restructure/QC-BUILD.md`:

| Package | Pass | Fail | Skip | Expects | Files | Time |
|---------|------|------|------|---------|-------|------|
| `hub/` | 495 | 7 | 93 | 1335 | 64 | 1130ms |
| `supervisor/` | 50 | 0 | — | 129 | 7 | 26.52s |

**Pre-existing 7 hub failures (carried from main, NOT regressions):**
1. `insertRunV2 started_at safety > passes a non-null Date for started_at when status=pending and started_at omitted`
2. `insertRunV2 started_at safety > passes a non-null Date for status=success path`
3. `insertRunV2 started_at safety > honors caller-provided started_at when given`
4. `insertRunV2 started_at safety > defends against an explicit null started_at (cron-fire registry path)`
5. `insertDeploymentRun started_at safety > passes now() (not null) for status=pending`
6. `supervisor-registry reconnect race > new register replaces old entry; isSupervisorOnline true`
7. `supervisor-registry reconnect race > stale close from replaced socket does NOT wipe live entry`

(Cumulative across hub + supervisor: ~545 pass + 7 baseline fail + 93 skip. The "600+ pass" figure cited in earlier phase reports includes revanote suite additions counted in hub/test.)

**93 skips:** all `*.e2e.test.ts` cases gated on missing `REMO_E2E_DB_URL`.

## Common Patterns

**Async testing:**
```typescript
test('promotes next waiter on idle', async () => {
  await onSessionIdleAndPromote(sessionId)
  expect(currentInFlight(sessionId)).toBe(null)
})
```

**Error testing:**
```typescript
test('rejects HMAC skew >5min', () => {
  const stale = Date.now() - 6 * 60 * 1000
  expect(() => verify(body, sig, stale)).toThrow(/skew/)
})
```

**Schema validation:**
```typescript
test('rejects bare prose as triage output', () => {
  expect(parseTriageOutput('looks broken')).toBeNull()
})
```

## What Is NOT Tested

- **Web UI components** — no test runner in `web/`. Manual QC only. Adding Vitest + React Testing Library is a known gap; covered by Phase 12 QC-UI sweep instead.
- **Tauri shell (`supervisor/tauri/src-tauri/**` Rust)** — no `cargo test` integration in CI. Only the TS sidecar in `supervisor/src/**` has unit coverage.
- **End-to-end browser flows** — no Playwright / Cypress. Manual smoke against `app.remo-code.com`.
- **CLI subprocess streaming behavior** — the actual `claude --input-format stream-json` and `codex app-server` JSON-RPC framing is mocked; real CLI integration is verified by manual session against the live supervisor MSI.

---

*Testing analysis: 2026-05-28*
