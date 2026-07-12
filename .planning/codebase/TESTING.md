# Testing Patterns

**Analysis Date:** 2026-07-12

## Test Framework

**Runner:** `bun test` (Bun's built-in runner + `bun:test` assertions). There is **no** Jest, Vitest, Mocha, or Playwright suite in this repo.

**Config:** `hub/bunfig.toml` — the only test config that matters:

```toml
[test]
preload = ["./test/_setup.ts"]
```

**React component tests** (`web/test/*.test.tsx`) also run under `bun test`, using `react-dom/server` / DOM-shim style assertions rather than a full RTL+jsdom harness.

## Run Commands

```bash
bun run check-baseline        # THE QC GATE — per-file isolated hub suite vs baseline. Run this before every PR.
bun test hub/test             # raw hub suite (order-dependent; can pollute — see below)
bun test web/test             # web suite
bun test supervisor/test      # supervisor suite
bun run orchestrator:e2e      # bun test hub/test/e2e/*.e2e.test.ts (needs REMO_E2E_DB_URL)
bun run migration-verify      # tools/migration-verify.ts — schema.sql idempotency / backfill rule
bun run smoke -- https://app.remo-code.com   # prod HTTPS smoke (tools/smoke-https.ts)
```

## The QC Gate: `bun run check-baseline`

`tools/check-baseline.ts` is the enforced gate. It:

1. Recursively collects every `hub/test/**/*.test.ts`.
2. **Runs each file in its OWN `bun test` process** with `--reporter junit --reporter-outfile <tmp>`.
3. Sums the junit `<testsuites tests/failures/skipped>` roots.
4. Compares against `tools/regression-baseline.json`.

**Exit codes:** `0` within tolerance · `1` drift (any fail > 0, or pass < `pass_min`, or skip > `skip_max`) · `2` could not run/parse.

### Why per-file isolation (do not "optimize" this away)

**Bun's `mock.module()` is process-global and first-write-wins.** A partial mock registered in one test file shadows the real module — or another file's mock — for every *subsequent* file in the same `bun test` run. That makes a single-process suite **order-dependent**: green on Windows local, cascading `Export named X not found` on Linux CI. ~100 of the 229 hub test files use `mock.module`.

Two mitigations, both required:
- `hub/test/_setup.ts` (preloaded via bunfig) registers a root-scope `afterAll(() => mock.restore())`, which Bun runs at the end of *every* test file, before the next file starts.
- `check-baseline` spawns **one process per file** so contamination is structurally impossible.

If a test passes in isolation but fails in the full suite, **suspect mock pollution first**, not a real bug.

### `tools/regression-baseline.json`

```json
{ "pass": 1709, "skip": 232, "fail": 0, "total": 1956,
  "tolerance": { "pass_min": 700, "skip_max": 250, "fail_max": 0 } }
```

- `pass`/`total` are **informational snapshots**. The **enforced** values are the tolerance triplet.
- **`fail_max` is 0 and stays 0.** Never raise it.
- `skip_max` absorbs the env-gated e2e suites (they self-skip when `REMO_E2E_DB_URL` is unset). Raise it (with a note in `_comment`) when a milestone adds gated e2e files.
- Adding/removing tests intentionally ⇒ update `captured_at` + `_comment` + counts in the same PR.

## Where Tests Live

| Path | Scope |
|---|---|
| `hub/test/` | 229 files — the bulk. Routers, DALs, WS protocol, dispatch gates, scheduler, orchestrator, reapers, auth. |
| `hub/test/e2e/` | Postgres-backed orchestrator e2e (`*.e2e.test.ts` + `orchestrator-harness.ts`). |
| `hub/test/integration/` | Cross-module flows (e.g. `auth-flow.test.ts`). |
| `hub/test/fixtures/` | `claude-transcript.jsonl`, `codex-rollout.jsonl`, `codex-tree/`, `titanium-vectors.json` (+ its generator `gen-titanium-vectors.ts`). |
| `web/test/` | 12 files — component + guard tests (`terminal-surface.test.tsx`, `no-indigo.test.ts`, `cutover-deletion-gate.test.ts`). |
| `supervisor/test/` | ~40 files — runners, PTY, process manager, oauth poll, TEAB, plus the API-key/legacy-spawn guards. |

Tests are in a sibling `test/` dir per package — **not** co-located with source.

## Guard / Canary Tests (fail the build on regression)

These encode invariants, not features. If one fails, you violated an architectural rule — **fix the code, never the guard.**

| Guard | Location | Invariant |
|---|---|---|
| `no-legacy-agent-spawn` | `supervisor/test/no-legacy-agent-spawn.test.ts` | The retired `remo-code-agent` / `claude-remote` package name and `--append-system-prompt` must never reappear. |
| `no-api-key-no-streamjson-pty` | `supervisor/test/` | Human PTY path spawns the genuine TUI with an allowlist-of-one argv: no API key, no `-p`/`--print`/`--input-format`/`--output-format`/`stream-json`. |
| `no-apikey-fallback-guard` | `supervisor/test/` | Fallback on backend failure is a CLI swap (Codex/Gemini), never an API-key path. |
| `default-backend-selector` | `supervisor/test/` | Human sessions resolve only to `claude-pty`/`codex-pty`, never the legacy stream-json runner. |
| `no-setup-token-on-interactive` | `supervisor/test/` | Setup token is scrubbed from interactive spawn env. |
| `session-skip-permissions-ceiling` | `supervisor/test/` | `--dangerously-skip-permissions` only when operator-blessed in config. |
| `teab-no-programmatic-tokens` | `supervisor/test/` | TEAB runs carry no programmatic claude flags / bypassPermissions. |
| `no-indigo` | `web/test/no-indigo.test.ts` | Zero occurrences of the forbidden accent token anywhere under `web/src` (any source-like extension). Reports `file:line`. |
| `mount-order` | `hub/test/mount-order.test.ts` | Public webhooks mount BEFORE the `/api/*` auth catch-all; license gate after auth; `/ws/agent` keyed by `api_keys`. |
| `orchestrator-macro-path-guard` | `hub/test/` | The cycle runner defaults to the MACRO path; the legacy wave path stays behind `REMO_ORCHESTRATOR_LEGACY_WAVES=1`. |
| `orchestrator-autospawn-no-automerge.guard` | `hub/test/` | Autospawn never auto-merges. |
| `automation-routing-guard` / `human-only-guard` | `hub/test/` | No automation drives the human PTY. |
| `cutover-deletion-gate` | `web/test/cutover-deletion-gate.test.ts` + `tools/cutover-deletion-gate.mjs` | ChatSurface deletion is blocked unless the Phase-16 verdict artifact is fully green with complete provenance (a hand-forged verdict fails the provenance check). Exit 0 = deletions allowed. |
| `version-drift` | `supervisor/test/version-drift.test.ts` | Reported supervisor version matches `tauri.conf.json`. |

## Postgres e2e Harness

`hub/test/e2e/orchestrator-harness.ts` + nine `*.e2e.test.ts` suites (macro-cycle, due-waves, queue-lock, cost-cap, notify, verify-tail, autospawn, legacy-wave-parity, harness smoke).

- **Gated by `REMO_E2E_DB_URL`** — unset ⇒ the suites *skip* (that's what `skip_max: 250` in the baseline absorbs). Never make them fail-on-missing-DB.
- The harness refuses a non-local host unless `REMO_E2E_ALLOW_NONLOCAL=1` — a safety rail so it can never be pointed at prod. CI opts in because its Postgres is a disposable service container.
- In CI: a real `postgres:16` service (`.woodpecker/qc.yaml`), DB `remo_ci`, user/pass `remo`. The pipeline `pg_isready`-waits before running.
- Run locally: `REMO_E2E_DB_URL=postgres://... bun run orchestrator:e2e`.

## Mocking

**Framework:** `bun:test` `mock()` / `mock.module()`.

**Rules:**
- `mock.module` is **process-global**. Register mocks in a `beforeAll` at file scope; rely on the preloaded `afterAll(mock.restore)` in `hub/test/_setup.ts` for teardown. Never assume a sibling file's module graph is clean.
- **What to mock:** the Postgres `sql` tag, outbound HTTP (Coolify, GitHub, Titanium, E4A), the supervisor WS channel, `child_process` spawn in supervisor tests.
- **What NOT to mock:** the dispatch gate chain, Zod schemas, or the DAL's user-scoping — those *are* the thing under test. Orchestrator DB semantics get a real Postgres (e2e), not a mock.
- Guard tests mock nothing — they read source files off disk and assert on their text (see `web/test/no-indigo.test.ts` scanning `web/src` with `Bun.Glob`).

## CI Pipelines

**Woodpecker is primary** (`.woodpecker/*.yaml`, one pipeline per file, runner is `linux/amd64` only).

| Pipeline | Trigger | Does |
|---|---|---|
| `.woodpecker/qc.yaml` | `pull_request` → `main` | The PR gate. `postgres:16` service; `bun install --frozen-lockfile` → `bunx tsc --noEmit -p hub/tsconfig.json` (informational) → **`bun run check-baseline`** → **`bun run migration-verify`** → an explicit orchestrator data-model/queue/run-log/stage-preset/merge-command/migrate/feedback test run → **`bun run orchestrator:e2e`** (belt-and-suspenders, so the Postgres proof is visible in the logs). |
| `.woodpecker/docs-drift.yaml` | `pull_request` touching `hub/src/**`, `docs/openapi.json`, `docs/api.md` | Runs `bun run docs:sync` and fails if `git diff` on `docs/openapi.json` / `docs/api.md` is non-empty. Fix = run docs:sync and commit. |
| `.woodpecker/post-deploy-smoke.yaml` | `push` → `main` | Sleeps 120s for the Coolify rollout, then `bun run smoke -- https://app.remo-code.com`. |

**GOTCHA:** Woodpecker rewrites `${...}` **anywhere** in a `.woodpecker/*.yaml` — including inside comments and shell strings — before the step runs. Use plain literals; a `${}` reference silently collapsed the smoke `sleep` to empty and the escaped form errored the parser. Do not "parameterize" these files.

**GitHub Actions is reserved for what the Linux runner can't do:** `release-supervisor.yml` (windows-latest, signed MSI + `latest.json`, TAURI signing secrets), `release-mobile.yml`, `mobile-ios-build.yml` (macOS toolchain), `mobile-shell-typecheck.yml` (paused). Adding a check ⇒ default to a new `.woodpecker/*.yaml`; reach for GHA only if it needs Windows/macOS or signing secrets.

## Writing a New Test

1. Put it in `<package>/test/<subject>.test.ts`. Mirror the source-file name.
2. Header comment: what invariant it holds and why (house style — see `hub/test/_setup.ts`).
3. Needs a real DB? Make it an `hub/test/e2e/*.e2e.test.ts`, gate on `REMO_E2E_DB_URL`, **skip** (not fail) when unset, and reuse `orchestrator-harness.ts`.
4. Run `bun run check-baseline` — it must stay `fail: 0`. If your file added N tests, bump the informational counts in `tools/regression-baseline.json` (and `skip_max` if you added gated e2e).
5. If you're encoding an invariant rather than a behavior, write it as a **guard**: scan source text, report `file:line`, and never allow the offending token back.

## Coverage

**No coverage tool, no coverage threshold.** The gate is `fail_max: 0` plus the guard tests. Do not introduce a coverage gate without a decision — it would immediately fail on the supervisor's Rust/PTY seams.

---

*Testing analysis: 2026-07-12*
