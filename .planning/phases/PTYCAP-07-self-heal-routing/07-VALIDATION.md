# Phase 7 (PTYCAP) Validation Map - Unified Self-Heal Routing

Status: planned. Every row names the test file that proves it and the plan that creates it. All hub tests run from the repo root as `bun test hub/test/<file>`; e2e files are gated on `REMO_E2E_DB_URL` and run on `postgres:16` in CI (`bun run orchestrator:e2e`). No manual verification step exists in this phase (rule 12c: agents run everything).

Plans: 07-01 (types/config/keys) | 07-02 (ledger schema/DAL) | 07-03 (flag-OFF characterization) | 07-04 (governed launch adapter, liveness, launch leak) | 07-05 (resolve + routeHeal live path) | 07-06 (notify, autospawn, sweep) | 07-07 (sinks) | 07-08 (coolify + scheduled-task sources) | 07-09 (error-capture + feedback sources) | 07-10 (guards, final flag-OFF, incident e2e) | 07-11 (docs, CLAUDE.md, baseline).

Waves: W1 = 07-01, 07-02, 07-03, 07-04 (no file overlap) | W2 = 07-05 | W3 = 07-06, 07-07 | W4 = 07-08, 07-09 | W5 = 07-10 | W6 = 07-11.

Tracer note: the first end-to-end vertical slice is plan 07-05 Task 2 (one coolify event through flag, validation, resolution, ledger claim, six-gate chain, shared pipeline, sink, persisted outcome). Wave 1 holds independently verified enabling foundations (pure types, ledger, characterization, launch adapter) because the tracer needs all of them to exist; this is a deliberate, recorded deviation from lead-with-tracer ordering. Nyquist: every task `<verify>` carries an `<automated>` command; no MISSING scaffolds.

## Success criteria -> proof

| SC | Requirement | Proof (test file) | Plan | Command |
|----|-------------|-------------------|------|---------|
| SC1 one `routeHeal()` seam, guard fails CI on hand-rolled routing | SH-01, SH-02 | `hub/test/heal-single-seam.test.ts` (pin table, seam-isolation, self-check); `hub/test/heal-types.test.ts` (closed union); `hub/test/heal-source-coolify.test.ts`, `heal-source-scheduled-task.test.ts`, `heal-source-error-feedback.test.ts` (each source calls the seam) | 07-01, 07-08, 07-09, 07-10 | `bun test hub/test/heal-single-seam.test.ts` |
| SC2 live -> dispatch; allowlisted offline -> governed autospawn; else terminal `skipped/no_routable_session` + exactly one notification | SH-03, SH-04, SH-05 | `heal-route-live.test.ts` (live wins, zero spawns, ghost != live); `heal-resolve.test.ts`; `heal-route-autospawn.test.ts`; `heal-route-no-target.test.ts`; `heal-notify.test.ts` | 07-05, 07-06 | `bun test hub/test/heal-route-live.test.ts hub/test/heal-route-autospawn.test.ts hub/test/heal-route-no-target.test.ts` |
| SC3 rides the shared `hub/src/dispatch/` chain; capped users never send | SH-06 | `token-cap-coverage.test.ts` (heal list discovered + six gates in order); `heal-route-live.test.ts` (cost/token-capped user: zero sends); `session-start-senders-guard.test.ts`, `launch-callers-guard.test.ts`, `counter-key-assignment-guard.test.ts` (extended) | 07-05, 07-10 | `bun test hub/test/token-cap-coverage.test.ts hub/test/heal-route-live.test.ts` |
| SC4 no heal run pending to the 6h reaper; replay incident fixtures (runs 8a6e0534, fa377e27; task 0e16bf38) | SH-05 | `hub/test/e2e/heal-incident-replay.e2e.test.ts` (real Postgres, V1 + V2, concurrency, autospawn ledger); `heal-source-coolify.test.ts` (DB-free V1/V2); `heal-sweep.test.ts` (restart edge); `heal-route-autospawn.test.ts` (deadline) | 07-06, 07-08, 07-10 | `bun test hub/test/e2e/heal-incident-replay.e2e.test.ts` |
| SC5 flag OFF is a true no-op reproducing today's behaviour | SH-07 | `hub/test/heal-flag-off.test.ts` (traces recorded on UNMODIFIED code in 07-03, extended in 07-10: routeHeal never invoked for unset/empty/0/false/maybe/garbage; ON values are the sole switch); `heal-config.test.ts` (unrecognized value => OFF, call-time read) | 07-01, 07-03, 07-10 | `bun test hub/test/heal-flag-off.test.ts hub/test/heal-config.test.ts` |

Hard invariants (ROADMAP): no provider API key on the PTY path (no PTY change in this phase; `supervisor` untouched, verified by `git diff --name-only` in 07-11); actor server-inferred (no client-asserted field enters a HealEvent; user_id comes from the source's authenticated owner); no dispatch path outside the gate chain (`token-cap-coverage.test.ts` + `heal-single-seam.test.ts`); caps in tokens (no cap/gate edits: `git diff --name-only -- hub/src/dispatch/gates.ts` empty in 07-04/07-05/07-06); additive idempotent DDL (`heal-schema.test.ts` + `tools/schema-sql-lint.ts` + `schema-double-apply.e2e.test.ts`).

## Mandatory amendments (GATES/verdict.md) -> task + test

| ID | Amendment | Task | Test |
|----|-----------|------|------|
| AM-F1-1 | Governed pre-launch adapter extracted (post-flag part); heal has its own flag, not `REMO_ORCHESTRATOR_ENABLED` | 07-04 T2/T3; 07-01 T1 | `governed-launch.test.ts`; `heal-config.test.ts` (armed with orchestrator-enabled unset); `heal-route-autospawn.test.ts` |
| AM-F1-2 | Full gate list + atomic lifetime reservation BEFORE `session.start`; idempotent on replay; released on launch failure / grace expiry | 07-04 T2; 07-06 T2 | `governed-launch.test.ts` (call order gates, reserve, ledger, launch; release on refusal); `heal-route-autospawn.test.ts` (release on failure, deadline, grace expiry) |
| AM-F1-3 | `autospawn-launch` ledger row fail-closed | 07-04 T2 | `governed-launch.test.ts` (ledger throw => refused, released, zero launches); e2e autospawn ledger case |
| AM-F1-4 | Launch primitive closes its reserved run on every non-launch exit | 07-04 T1 | `launch-run-leak.test.ts` |
| AM-F1-5 | Error-capture + feedback stop using ensureOnline when flag ON; spawn-on-error stays for flag OFF / Revanote | 07-07 T2; 07-09 T1/T2 | `heal-source-error-feedback.test.ts` (ensure-online spy zero on ON, present on OFF); `heal-flag-off.test.ts`; `spawn-on-error.test.ts` unchanged; `git diff` pins on `spawn-on-error.ts`, `ask/`, `revanote/` |
| AM-F1-6 | Caller inventory corrected (ask calls launch primitive directly; Revanote is the other spawn-on-error caller) | 07-11 T1/T3 | docs assertion in 07-11 verify; `launch-callers-guard.test.ts` (ask in MACHINE set) |
| AM-F2-1 | `bound_session_id` via `getSession(id, userId)`; reject missing/deleted/rootless/foreign/PTY-ineligible/repo-mismatched; no silent repo fallback | 07-05 T1 | `heal-resolve.test.ts` (each rejection; `listSessionIdsForRepoKey` zero calls; two-user isolation); `heal-source-error-feedback.test.ts` (foreign-tenant feedback key) |
| AM-F2-2 | Hydrate canonical `repo_ident` from owned session; none derivable => `no_routable_session` even if live | 07-01 T2; 07-05 T1/T3 | `heal-repo-ident.test.ts`; `heal-resolve.test.ts` (live session without ident => none) |
| AM-F2-3 | Offline bound session autospawns only if its repo is allowlisted | 07-06 T2 | `heal-route-autospawn.test.ts` (bound offline, allowlisted vs not) |
| AM-F2-4 | `bound_session_id` only on sources with a binding (discriminated union) | 07-01 T1 | `heal-types.test.ts` (coolify rejects it; the other three require it) |
| AM-F3-1 | Atomic claim: tx advisory lock on (user, source-namespaced key), window check, insert; unique index backstop | 07-02 T2 | `heal-events-dal.test.ts` (lock precedes insert); `e2e/heal-events.e2e.test.ts` (8-way concurrency, bucket straddle) |
| AM-F3-2 | Columns trigger/dispatch run, outcome, updated_at, notification_claimed_at; conditional UPDATE ownership; "exactly one send attempt" | 07-02 T1/T2; 07-06 T1 | `heal-schema.test.ts`; `e2e/heal-events.e2e.test.ts` (8-way notification claim); `heal-notify.test.ts` |
| AM-F3-3 | Retention >= 24h; per-user cap on new claims/hour; Coolify table untouched for flag-OFF | 07-02 T1/T2; 07-08 T1 | `e2e/heal-events.e2e.test.ts` (prune keeps 23h row, user cap); `heal-config.test.ts` (retention floor); `git grep claimDeployFailure -- hub/src/heal` empty |
| AM-F4-1 | Key only from server-derived canonical `repo_ident`; null refused | 07-01 T2; 07-05 T2/T3 | `heal-counter-key.test.ts`; `heal-route-live.test.ts` (key equals builder output); `heal-route-guards.test.ts` (ident derived from owned session) |
| AM-F4-2 | One shared key builder; `POST /heal` unchanged, documented prefix-compatible only | 07-01 T2; 07-11 T1 | `heal-counter-key.test.ts` (source-text pin on `api/sessions.ts`); docs assertion |
| AM-F4-3 | `heal/route.ts` added to the counter-key assignment guard | 07-05 T2; 07-10 T1 | `counter-key-assignment-guard.test.ts` (allowlist entry + only-route.ts assertion) |
| AM-F4-4 | Per-repo hourly rate bound; exhaustion reported in the outcome | 07-05 T3 | `heal-route-guards.test.ts` (`refused:repo_rate_bound`) |
| AM-F5-1 | Fire only on a real failed transition of a non-internal, repo-bound task; exclude reaper-finalized runs | 07-08 T2 | `heal-source-scheduled-task.test.ts` (matrix of ineligible statuses/flags) |
| AM-F5-2 | Hook between claimed terminal UPDATE and post-run processing; exactly one notification owner | 07-08 T2 | `heal-source-scheduled-task.test.ts` (hook-before-onRunFinalized order; suppress only when heal notified) |
| AM-F5-3 | Durable provenance (trigger vs dispatch run); recursion guard BEFORE the dedupe claim and fails closed; durable internal marker | 07-02 T1/T2/T3; 07-05 T3; 07-08 T2 | `e2e/heal-events.e2e.test.ts` (ancestry, unique trigger); `heal-internal-task.test.ts`; `heal-route-guards.test.ts` (claim zero calls on guard true/throw) |
| AM-F5-4 | A failed child heal run cannot create another heal event; per-task daily ceiling | 07-08 T2 | `heal-source-scheduled-task.test.ts` (child internal run, ledger-ancestry run, ceiling) |

## Spec requirement -> test (SPEC section 6, with the actual file names)

| Requirement | Test file |
|-------------|-----------|
| SH-01 | `heal-single-seam.test.ts` |
| SH-02 | `heal-types.test.ts`, `heal-source-*.test.ts` |
| SH-03 | `heal-route-live.test.ts`, `heal-resolve.test.ts` |
| SH-04 | `heal-route-autospawn.test.ts`, `governed-launch.test.ts` |
| SH-05 | `heal-route-no-target.test.ts`, `e2e/heal-incident-replay.e2e.test.ts` (spec's `heal-incident-replay.test.ts`, renamed to the repo's `.e2e.test.ts` convention) |
| SH-06 | `token-cap-coverage.test.ts`, `heal-route-live.test.ts` |
| SH-07 | `heal-flag-off.test.ts`, `heal-config.test.ts` |

## Suites that must stay green and UNMODIFIED (diff-pinned in the plans)

`orchestrator-autospawn-inject`, `orchestrator-autospawn-gate`, `orchestrator-autospawn-allowlist`, `orchestrator-inject-counterkey`, `orchestrator-inject-rate-gate`, `orchestrator-tick-reinject`, `e2e/orchestrator-autospawn.e2e` (07-04); `coolify-webhook`, `coolify-webhook-triage-e2e`, `triage-routing` (07-02, 07-08); `error-capture-dispatch` (07-07, 07-09); `feedback-webhook`, `feedback-key-ownership`, `feedback-prompt` (07-09); `scheduler`, `scheduler-run-reaper`, `stale-run-reaper`, `triage-finding-forward` (07-08); `spawn-on-error` (07-09).

## Phase gate (before PR)

1. `bun run check-baseline` (07-11) exits 0; `bun run docs:sync` leaves `docs/openapi.json` and `docs/api.md` unchanged; `bun run tools/schema-sql-lint.ts` exits 0.
2. `REMO_E2E_DB_URL=<disposable postgres:16> bun run orchestrator:e2e` exits 0 (CI runs this against the Woodpecker `postgres:16` service; PGlite-only green is not sufficient: reference_pglite_vs_postgres_e2e_divergence).
3. Independent verifier (rule 13) -> `VERIFICATION.md`; `/qc` before PR (rule 7). Flag stays OFF in Coolify; allowlist stays EMPTY; arming is the owner's go/no-go per `docs/orchestrator-autospawn-runbook.md`.

## Accepted residuals (recorded, not gaps)

- Notification guarantee is exactly one send attempt, not exactly-once delivery (needs an outbox / provider idempotency contract; out of scope, AM-F3-2).
- Orchestrator launch ordering (gates after spawn) is intentionally unchanged to keep its proven e2e behaviour; the governed ordering applies to heal only (07-04 decision, T-07-13).
- Events refused by the per-user claim cap have no ledger row and therefore no notification (flood bound by design).
- A hub restart inside the spawn window is covered by the boot sweep (07-06 T3), not the process-local timer.
