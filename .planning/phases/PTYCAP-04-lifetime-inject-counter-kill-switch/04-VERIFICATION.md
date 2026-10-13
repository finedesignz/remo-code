---
phase: PTYCAP-04-lifetime-inject-counter-kill-switch
verified: 2026-10-13T22:40:00Z
status: gaps_found
score: 4/4 success criteria implemented and locally green; 2 gates red in real-Postgres CI
verdict: NO-SHIP (2 small test-side blockers, then SHIP-WITH-NOTES)
head: d864570f2e458bc01ebc512e13e038f2c4b277ae
pr: 506 (draft)
re_verification: false
behavior_unverified: 1
gaps:
  - truth: "04-02/04-05/04-08: DB-backed proof of the reserve SQL runs green in Woodpecker (existing e2e body, zero new tests)"
    status: failed
    reason: "hub/test/e2e/automation-controls-checks.ts newSession() (line ~57) inserts every session with the same user_id + project_dir '/tmp/e2e-automation'; the second call violates idx_sessions_user_project_unique (PostgresError duplicate key). The helper throws inside 'UNDER cap (control)' in orchestrator-tokencap.e2e.test.ts:174, so the concurrency / partial-unique / ON CONFLICT / count-after-reset proofs never executed."
    artifacts:
      - path: hub/test/e2e/automation-controls-checks.ts
        issue: "non-unique project_dir per fixture session"
    missing:
      - "unique project_dir per newSession() (e.g. '/tmp/e2e-automation-' + randomUUID())"
  - truth: "04-08: phase gate green - check-baseline fail 0"
    status: failed
    reason: "Woodpecker qc/pr-gate pipeline 866 (HEAD d864570): check-baseline fail=2 (skip=0 because the DB is present there). Failure 2: hub/test/e2e/orchestrator-autospawn.e2e.test.ts:210 expects launches[0] toEqual {userId, sessionId} but launch now also carries machine:true (04-07 launch option) - stale expectation. Local check-baseline is green only because these DB-gated tests skip locally."
    artifacts:
      - path: hub/test/e2e/orchestrator-autospawn.e2e.test.ts
        issue: "expectation not updated for the machine-origin launch option"
    missing:
      - "expect {userId, sessionId, machine: true} (or objectContaining)"
---

# Phase 4 (PTYCAP-04): Lifetime Inject Counter + Kill Switch - Verification

**Goal:** A slow grind is as impossible as a fast loop.
**Branch:** phase-ptycap-04-lifetime-counter-kill-switch @ d864570 (draft PR #506). Nothing pushed or merged by this verification.
**Ship verdict:** **NO-SHIP** until the two CI test fixes above land and Woodpecker qc goes green. Product code is complete and locally proven; the blockers are fixture/expectation defects, but they mean the real-Postgres proof (a stated phase gate) has never actually run.

## Success criteria

| SC | Verdict | Evidence |
|---|---|---|
| SC-1 lifetime per-task counter | PASS | Durable append-only `automation_inject_ledger` (schema.sql:1605-1622, unique (counter_key, token) idx) with atomic advisory-lock reserve-before-send in `hub/src/dispatch/automation-controls.ts` (`DEFAULT_LIFETIME_INJECT_CAP = 1000`, line 32). Tests run individually: automation-tracer 11 pass (real `dispatch()` pipeline), dispatch-reserve 9, governed-pty-gate 34, reserve-caller-guard / counter-key-assignment-guard / replay-reentry-guard / scheduler-counter-keys all in check-baseline. DB-backed SQL proof: NOT proven (see gap 1). |
| SC-2 owner kill switch, hub-wide + per-session | PASS | `automation_kill_switch` table + global partial unique idx (schema.sql:1624-1638); routes `/api/automation/kill-switch/{engage,release,state}` mounted index.ts:497, step-up on release/reset (index.ts:448-450), engage needs no step-up. automation-api 23 pass, kill-switch-coverage 10 pass (kill gate first in every non-human gates list), scheduler-halt 11, once-rearm 6, orphan-resume-halt 19, sessions-heal-halt 11, scheduler-supervisor/teab-sender-halt 6/4. Human surfaces (Telegram, cloud send, human PTY chain) classified exempt and pinned. |
| SC-3 owner emailed at 60% of daily token ceiling | PASS | `DEFAULT_ALARM_PCT = 60` (automation-controls.ts:33), event-driven listener `registerTokenCapAlarm` (observability/token-cap-alarm.ts), registered before `Bun.serve` (M4 fix). token-cap-alarm 26 pass, token-usage-listener in baseline. Real E4A delivery is runtime-only: behavior_unverified (below). |
| SC-4 default daily token cap 50M -> ~20M | PASS | `DEFAULT_DAILY_TOKEN_CAP = 20_000_000` (hub/src/dispatch/gates.ts:164). token-cap-coverage 3 pass; orchestrator-token-cap / token-cap-gate-fires updated. Supervisor SC-4 guards pass unchanged: no-api-key-no-streamjson-pty 5, no-apikey-fallback-guard 7, default-backend-selector 22, no-legacy-agent-spawn 1, plus hub human-only-guard 8. |

## Plan must_haves (summary)

| Plan | Verdict | Notes |
|---|---|---|
| 04-01 supervisor message.id dedupe + 0.15.1 | PASS | pty-usage-tail 34 pass, version-drift 3 pass, tauri.conf / Cargo.toml / ui package.json = 0.15.1, supervisor/package.json untouched (diff empty). |
| 04-02 ledger + atomic reserve tracer | PARTIAL | Tracer through real pipeline PASS (11/11). The "DB-backed proof added to an existing e2e body" truth is satisfied structurally (zero new tests) but the proof THROWS in CI (gap 1). |
| 04-03 counter keys / replay re-entry | PASS | guards + dispatch-reserve green; Woodpecker autospawn e2e exposes stale expectation (gap 2, test-only). |
| 04-04 real governors + PTY door reserve | PASS | governed-pty-gate 34, pty-door-guard / pty-preflight / human-only-guard green. |
| 04-05 routes + 60% alarm + boot asserts | PARTIAL | Routes/alarm/boot-order PASS locally; "alarm claim uniqueness in real-Postgres helper" unproven (gap 1). |
| 04-06 gates coverage + scheduler/tick halt | PASS | kill-switch-coverage, scheduler-halt, orchestrator-tick-halt green. |
| 04-07 launch/heal/orphan halt + release resume | PASS | orphan-resume-halt, sessions-heal-halt, launch-callers-guard, session-start-senders-guard green. |
| 04-08 docs + cap change + phase gate | PARTIAL | Docs/OpenAPI present (docs-drift CI pass); tsc errors 427 = baseline (counted from CI log); schema-lint ran. Gate "check-baseline fail 0" FAILS in CI (gap 2); migration-verify and orchestrator:e2e never ran (pipeline stopped). Literal truth "token-cap change is in the LAST CODE commit" is NOT met: nine QC-fix commits touching hub/src follow 386f031 (e01a243..d864570). Procedural only; the cap change is intact. |

## Tool evidence

- Local `bun run check-baseline` (root): exit 0; actual pass=2701 skip=259 fail=0 (baseline pass=2652 skip=259 fail=0). The documented phase16 flake did not appear. Skip count unchanged at 259.
- Supervisor tests individually: all pass (listed above). `path-containment` is named `pty-usage-path-containment.test.ts` in this repo; it is part of the baseline run (green).
- `gh pr checks 506` (state as-is, no polling): `ci/woodpecker/pr/qc` FAIL, `ci/woodpecker/pr/docs-drift` pass, `supervisor-build` pass, `ai-review` pending. qc pipeline 866 pr-gate step log (read via woodpecker-api, step 251720): `[check-baseline] DRIFT: fail=2 > fail_max=0; actual pass=2881 skip=0 fail=2`; tsc 427 errors (informational, = baseline).

## The two open Codex QC findings (independently assessed)

**(a) orphan-resume.ts:303 reopen via `UPDATE ... NOT EXISTS` - CONFIRMED (real, narrow, MEDIUM-HIGH).**
`reopenOrphanIfNoReplacement` is a bare single statement. Under READ COMMITTED the NOT EXISTS subquery sees only rows committed at statement start; a concurrent `launchOrchestrator` tx (which serializes on a per-user `pg_advisory_xact_lock`, auto-launch.ts:160, a lock the reopen does NOT take) can commit a replacement open run in that window, leaving two open runs for the session (double resume). `session_runs` has no partial unique index on open runs per session (schema.sql:117-134), so nothing backstops it. Fix: take the same per-user advisory xact lock around the reopen (or add a partial unique index on open runs per session).

**(b) supervisor.ts:69 / teab.ts:124 rearm keyed on `schedule_kind === 'once'` alone - CONFIRMED (real, narrow, MEDIUM).**
The dispatcher correctly gates re-arm on `opts.onceClaimed` (dispatcher.ts:247). The senders do not receive that signal. `runNow` with `isManual:true` deliberately runs a DISABLED task (dispatcher.ts:190-195), and a completed once task is exactly `enabled=false, payload.completed_reason='once_completed'`, which is the sole guard of `rearmOnceTask` (scheduled-tasks-dal.ts:461-475). So a human Run Now on a completed once supervisor/teab task whose late halt fires re-enables it, and the once-due sweep would re-fire it after release (duplicate run). `senders/work.ts:84` has the same shape (re-arms on any `automation_halted` skip). Fix: pass `onceClaimed` through the run context and re-arm only when true.

Both are edge-case races/overrides in halt-recovery paths, not violations of SC-1..SC-4 as written; neither is test-covered.

## Human verification / behavior-unverified

1. 60% alarm email actually delivered via E4A in prod (runtime; no test can prove delivery). Test: set a low ceiling, cross 60%, confirm one email per user per local day. Expected: exactly one delivered email.

## Required before ship

1. Fix `newSession()` project_dir uniqueness in automation-controls-checks.ts; re-run Woodpecker so the real-Postgres reserve/concurrency proof actually executes.
2. Update orchestrator-autospawn.e2e.test.ts:210 expectation for `machine: true`.
3. Confirm migration-verify and orchestrator:e2e (never reached) pass in the next Woodpecker run.
4. Recommended (ship-with-notes acceptable if owner defers): fix findings (a) and (b) with regression tests.
5. Owner note already in docs/PR: prod `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` must be checked; 20M default applies only where unset.

---
_Verified: 2026-10-13_
_Verifier: Claude (gsd-verifier); covered_digest omitted (fingerprint verb not run within scope cap)_
