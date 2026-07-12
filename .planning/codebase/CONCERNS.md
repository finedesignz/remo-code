# Codebase Concerns

**Analysis Date:** 2026-07-12

> Adversarial audit. Ranked by severity. Every claim carries a file reference.
> Where the code contradicts the received narrative, that is called out in **bold**.

---

## Summary table

| # | Concern | Severity | Disposition |
|---|---------|----------|-------------|
| 1 | Auto-dev orchestrator: 2.83B cache-read token burn, zero PRs ever shipped | **CRITICAL** | **DELETE or PROVE** (hard deadline) |
| 2 | `finalizeOrphanedRunsForSupervisor` can never close a NULL-`session_id` run (SQL NULL semantics) → permanent `at_capacity` 429 | **CRITICAL** | FIX (one-line SQL) |
| 3 | Supervisor circuit-breaker latches OPEN forever; no reset, no alarm | **CRITICAL** | FIX |
| 4 | Token/cost caps are the ONLY thing between a loop bug and a dead subscription — and they don't cover every path | **HIGH** | FIX (widen coverage) |
| 5 | Six env-flag-gated half-live subsystems; neither deleted nor proven | **HIGH** | DELETE/PROVE per flag |
| 6 | Hostname-NULL ghost sessions re-anchored ~7/cycle by the supervisor | **HIGH** | FIX (supervisor side) |
| 7 | `schema.sql` re-runs in full on every hub boot | **HIGH** | ACCEPT + fence |
| 8 | PTY June-15 billing cutover gate never re-verified; ChatSurface undead | **MEDIUM** | PROVE or retire gate |
| 9 | Mobile Tauri client (Phase 12) paused 45 days, still in tree + CI | **MEDIUM** | DELETE |
| 10 | God-files: `dal.ts` 2304 LOC, `agent.ts` 1286, `telegram-webhook.ts` 1197 | **MEDIUM** | ACCEPT / split opportunistically |
| 11 | Regression baseline is 771/900 — 129 tests known-failing, gate is "don't get worse" | **MEDIUM** | FIX |
| 12 | **`error-capture/setup/snippet.ts` is NOT broken** — the brief is stale | — | (correction) |

---

## 1. Auto-dev orchestrator — CRITICAL

**The single most expensive subsystem in the repo, with zero shipped output.**

- **Incident (2026-07-11):** the 60s tick loop (`REMO_ORCHESTRATOR_TICK_INTERVAL_MS`, default 60000; `hub/src/orchestrator/controller.ts`) re-injected a macro prompt into one session ~1,440×/day for two days, burning **2.83 billion cache-read tokens** and killing the owner's Claude Max subscription.
- **Why the cap didn't stop it:** PR #335 summed only `input + output`. Cache-read is *not free* against a subscription rate limit. **Verified fixed** — `getTodayTokenTotal` now sums all four buckets: `hub/src/db/token-usage-dal.ts:203-215` (`input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`).
- **New rate ceiling verified:** `sessionInjectRateGate` at `hub/src/dispatch/gates.ts:242`, default 4 injects/hr/session (`DEFAULT_MAX_INJECTS_PER_HOUR = 4`, gates.ts:223). Wired into the inject gate list at `hub/src/orchestrator/inject.ts:30-33` alongside `thresholdGate`, `dailyCostCapGate`, `dailyTokenCapGate`. **This part of the brief checks out against the code.**
- **Zero output:** independently verified twice — the orchestrator has never taken a repo due→PR end-to-end. It ticks, reconciles `<<STATE>>`/`<<NOTIFY>>`/`<<GATE>>` sentinels (`hub/src/orchestrator/sentinels.ts`), writes `routine_run_log`, and produces nothing.

**Complexity it charges for:** `hub/src/orchestrator/` (controller 802 LOC + `inject.ts`, `queue.ts`, `macro-cycle.ts`, `sentinels.ts`, `notify.ts`, `task-macros.ts`, `stale-lock-reaper.ts`, `auto-launch.ts`, `orphan-resume.ts`), **12 dedicated env flags**, 2 DB migration scripts (`hub/scripts/migrate-legacy-tasks-to-orchestrator.ts`, `migrate-orchestrator-macro-task-type.ts`), the `orchestrator_rows` / `routine_queue` / `routine_run_log` / `orchestrator_autospawn_allowlist` tables, a dedicated Postgres e2e CI job, and a legacy-wave rollback path.

**Blast radius:** the owner's paid subscription (already realized once), hub CPU, DB write volume, and the cognitive load on every future reader of `hub/src/`.

**Verdict — not softened:** a subsystem that has cost a subscription and delivered **zero** PRs across two independent verification passes has negative expected value. #342's fixes are real, but they are *damage limiters*, not evidence the thing works.

**Disposition: DELETE, or PROVE under a hard deadline.**
- Set a date. If the orchestrator has not produced ONE merged production PR, unattended, within 30 days of re-arming: delete `hub/src/orchestrator/`, its tables, its flags, and its CI job.
- Do NOT re-arm (`REMO_ORCHESTRATOR_ENABLED=1`) without: (a) a *lifetime* max-injects counter per task row, not just a rate; (b) an inject-loop alarm emailing the owner at >20 injects/day/session; (c) a dry-run that proves due→PR on a throwaway repo first.
- Currently `REMO_ORCHESTRATOR_ENABLED=0` in prod. **Keep it there until the above exists.**

---

## 2. NULL-`session_id` run leak → permanent `at_capacity` — CRITICAL

**Root cause located. It is a classic SQL three-valued-logic bug.**

`hub/src/db/supervisor-dal.ts:305-312`:
```sql
UPDATE session_runs SET ended_at = now(), exit_reason = 'orphaned_no_inventory'
WHERE supervisor_id = $1 AND ended_at IS NULL
  AND started_at < now() - interval '30 seconds'
  AND NOT (session_id = ANY($2))
```
If `session_id IS NULL`, then `session_id = ANY(...)` → **NULL**, `NOT NULL` → **NULL**, the row does not match, and the run is **never closed by the orphan reconciler**. The web "Start ▶" path creates exactly these NULL-`session_id` rows.

The sibling sweep `finalizeOpenRunsForSupervisor` (`supervisor-dal.ts:278-284`) *does* close them — but only on supervisor socket close. A long-lived supervisor accumulates them indefinitely.

**Blast radius:** `hub/src/sessions/budget.ts:8,25` computes the effective concurrency cap from `COUNT(session_runs WHERE ended_at IS NULL)`. Leaked rows eat the entire budget, so **every** launch returns `at_capacity` 429 — `hub/src/api/sessions.ts:645`, `hub/src/api/orchestrator.ts:104`, `hub/src/api/supervisors.ts:164`. The whole system becomes unable to start a session. The current mitigation is a **manual prod SQL statement**, which is not a mitigation.

**Disposition: FIX.**
1. `AND session_id IS DISTINCT FROM ALL(...)` (or explicitly `(session_id IS NULL OR NOT (session_id = ANY(...)))`).
2. Add an absolute-age reaper: any open run older than `REMO_RUN_MAX_MS` is closed regardless of shape, so *no* run can leak forever whatever the next bug is.
3. Regression test: a NULL-`session_id` run gets reaped.

---

## 3. Supervisor circuit-breaker latches OPEN with no reset — CRITICAL

`supervisor/src/process-manager.ts:462-467` — on the crash path, once the breaker trips it logs `circuit breaker open — stopping` and sets state `stopped` with `lastExit.reason = 'circuit_open'`. **There is no half-open probe, no cooldown reset, and no hub-visible signal.**

**Observed:** the TitaniumTower supervisor spawned **zero** CLIs from 2026-07-07 onward (`session_runs.exit_reason='circuit_open'`), while the hub reported perfectly healthy. Scheduled tasks, orchestrator, and Telegram all silently no-opped.

**Blast radius:** total, silent loss of autonomy on a host — indistinguishable from "nothing was scheduled." Recovery required a full local supervisor restart, discovered by hand.

**Disposition: FIX.**
1. Half-open reset: retry one spawn every N minutes after the trip.
2. Publish breaker state in `session_inventory` → hub → Connections UI, and email on trip.
3. Watchdog: "tasks due but zero CLI spawns in 24h" → alert.

---

## 4. The cost/token cap is load-bearing safety, and it is thin — HIGH

`hub/src/dispatch/gates.ts` is the only thing standing between a loop bug and a dead subscription. Three problems:

1. **The dollar cap is theatre on a flat-rate plan.** `isOverCostCap` (gates.ts:67) caps USD. On a Max subscription, dollars are meaningless — the cap that mattered on 2026-07-11 was the token cap, and it was wrong.
2. **The default token cap would not have prevented the incident anyway.** `DEFAULT_DAILY_TOKEN_CAP = 50_000_000` (gates.ts:161). The burn was ~1.4B tokens/day — **28× the default cap**. So the cap was not merely mis-summed; on the burning path it evidently **never fired at all**, or the burn would have halted at 50M on day one. *Open question worth answering before re-arming anything:* did that session dispatch through `inject.ts` (gated) or through a path with no token gate?
3. **The PTY human path has no token gate.** The invariant says manual/interactive chat "IS now capped" via `dailyCostCapGate` — but that is the *dollar* cap, and the PTY path spawns the genuine TUI whose usage is only recorded post-hoc. A runaway there is, in practice, uncapped.

**Disposition: FIX.** Make the token cap primary (dollars advisory). Drop the default to something survivable (≈5M/day). Add a test that enumerates every dispatch entry point — inject, scheduler, telegram, error-capture, feedback, revanote, PTY — and asserts each carries `dailyTokenCapGate`. Email the owner at 60% of cap.

---

## 5. Six env-gated half-live subsystems — HIGH

Each is a code path that is neither deleted nor proven, and each multiplies the state space of every future change:

| Flag | State | Where |
|---|---|---|
| `REMO_ORCHESTRATOR_ENABLED` | OFF (post-incident) | `hub/src/orchestrator/controller.ts` |
| `REMO_ORCHESTRATOR_AUTOSPAWN` | OFF, empty allowlist | `hub/src/orchestrator/inject.ts` |
| `REMO_ORCHESTRATOR_LEGACY_WAVES` | dead rollback path | `hub/src/orchestrator/controller.ts` |
| `REMO_PTY_INTERACTIVE` | ON, but its own deletion gate is unmet | `supervisor/src/runners/backend-selector.ts` |
| `REMO_TELEGRAM_TRANSCRIPT_TAIL` | OFF ("keep OFF") | `hub/src/telegram/` |
| TEAB (`REMO_TEAB_*`) | needs an unreleased signed MSI | `hub/src/scheduler/senders/` |

Plus ~20 more `REMO_*` tuning knobs across `hub/src` + `supervisor/src`.

**Worst offender:** `REMO_ORCHESTRATOR_LEGACY_WAVES` is a *rollback path for a subsystem that has never worked*. It is rollback to nothing.

**Disposition:** **DELETE `REMO_ORCHESTRATOR_LEGACY_WAVES` now.** For every other flag, write down the exact condition under which it flips permanently — or delete the branch. **A flag with no flip condition is dead code with extra risk.**

---

## 6. Hostname-NULL ghost sessions, ~7 re-anchored per cycle — HIGH

`hub/src/ws/ghost-reaper.ts` reaps `status='online' AND hostname IS NULL` rows after `GHOST_GRACE_MS` (default 120000; `ghost-reaper.ts:42`). The reaper works — but **the supervisor keeps recreating them**, re-authing on `/ws/agent` without a hostname and minting a fresh phantom channel every cycle (~7 observed). The hub is mopping a running tap.

**Blast radius:** a phantom channel satisfies a naive `getChannel != null` liveness check, so injects dispatch into the void and autospawn never fires. `hub/src/orchestrator/inject.ts:99-100` now guards with `isSessionLive` — correct, but it is a *workaround*; the ghosts still churn the DB and the reaper log every cycle.

**Disposition: FIX on the supervisor side** — make `hostname` a required field of the `/ws/agent` auth frame and reject the connection (`4001 hostname_required`) when absent. Requires a new signed MSI, so the hub-side guard is load-bearing until then.

---

## 7. `schema.sql` re-runs in full every hub boot — HIGH

`hub/src/db/schema.sql`, applied by `hub/src/db/migrate.ts`. Idempotent-DDL-only is a **convention enforced by nothing but CLAUDE.md**. One `UPDATE` / `INSERT` / `DROP` slipped into that file re-fires against production **on every deploy**, with no rollback. This already happened once (#176).

**Blast radius:** production data loss, repeatedly, silently.

**Disposition: ACCEPT the design + FENCE it.** Add a CI lint that hard-fails if `schema.sql` contains `UPDATE `, `INSERT `, `DELETE `, `DROP `, or `TRUNCATE` outside a comment. Cheap, permanent, closes the entire class.

---

## 8. PTY billing cutover gate never re-verified; ChatSurface is undead — MEDIUM

`tools/cutover-deletion-gate.mjs` + `docs/cutover-gate-june15.md` exist and still gate deletion of the stream-json chat path. **The June-15 deadline has passed (today: 2026-07-12) and the attestation was never re-run** — Anthropic postponed the billing split and the gate was never updated to say so.

Consequence: `web/src/components/ChatSurface.tsx` (876 LOC), its transport adapter, its hooks, and `ChatSurfaceShowcase.tsx` are kept alive as "fallback" for a cutover that already shipped (`REMO_PTY_INTERACTIVE` is ON in prod). Two parallel human surfaces are maintained indefinitely.

**Disposition: PROVE or retire the gate.** Either re-run the on-device attestation and delete ChatSurface, or rewrite the gate doc to state "ChatSurface is permanent; PTY is default." A gate whose deadline silently lapsed means **nobody owns the decision** — that is the actual defect.

---

## 9. Mobile Tauri client paused 45 days — MEDIUM

Phase 12 paused 2026-05-28 (`docs/phase-12-pause-state.md`). iOS was never built. The shell remains in tree with three dormant GitHub Actions workflows: `.github/workflows/release-mobile.yml`, `mobile-ios-build.yml`, `mobile-shell-typecheck.yml`.

**Disposition: DELETE.** A phase that has not moved in six weeks is not paused, it is abandoned. Archive the shell to a branch, remove the workflows. Leaving it taxes every dependency bump and typecheck run.

---

## 10. God-files — MEDIUM

| File | LOC |
|---|---|
| `hub/src/db/dal.ts` | 2304 |
| `web/src/components/SupervisorPage.tsx` | 1289 |
| `hub/src/ws/agent.ts` | 1286 |
| `hub/src/api/telegram-webhook.ts` | 1197 |
| `web/src/components/GridPage.tsx` | 1091 |
| `hub/src/orchestrator/controller.ts` | 802 |

`dal.ts` at 2304 LOC is the merge-conflict epicentre for every parallel worktree session. The domain DALs (`token-usage-dal.ts`, `orchestrator-rows-dal.ts`, `supervisor-dal.ts`, …) were already extracted — `dal.ts` is the residue.

**Disposition: ACCEPT**, split opportunistically when touching. Do **not** schedule a refactor phase while items 1–4 are open; the risk/benefit is bad.

---

## 11. Regression baseline is a ratchet, not a gate — MEDIUM

`tools/regression-baseline.json` + `bun run check-baseline`: baseline is **771 passing of 900**, `fail_max: 0`. That means **~129 tests are known-failing** and the gate only asserts we do not get *worse*. New code merges green while a ninth of the suite is red.

**Blast radius:** unknown — and given items 2, 3, and 6 all shipped to prod undetected, "unknown" is not comforting. Any of the 129 could be flagging a live defect.

**Disposition: FIX.** Triage all 129 in one pass: fix, delete, or `.skip` with a linked issue. **A permanently-red baseline is worse than no baseline, because it launders failure as normal.**

---

## 12. Correction — `error-capture/setup/snippet.ts` is NOT broken

**The brief is stale here, and flagging that matters more than agreeing.**

`hub/src/error-capture/setup/snippet.ts:1-30` explicitly documents the UUID-vs-integer `BadDsn` problem **and already implements the fix**: it emits a **dependency-free reporter**, not the Sentry SDK. Node uses built-in `node:https` (`snippet.ts:45-90`); Python uses stdlib `urllib.request` (`snippet.ts:105-175`). Both hand-parse `https://<key>@<host>/<uuid>` and POST a raw Sentry envelope to `/api/sentry/<uuid>/envelope/?sentry_key=…`, the exact shape `hub/src/error-capture/envelope.ts` accepts. It is fail-open by construction ("any reporting error is swallowed; it can NEVER take the host app down"). Header cites the proving PRs (finedesignz/mcp-factory #73 / #74). No app installing this snippet will crash-loop.

**Residual concern (LOW):** the reporter is now a **bespoke wire-format client** coupled to `envelope.ts`. If the intake's accepted envelope shape drifts, every installed app silently stops reporting, with no error anywhere. **Disposition:** add a contract test feeding `getSnippet()`'s emitted payload through the real envelope parser.

---

## Test Coverage Gaps

**Orchestrator due→PR path:**
- What's not tested: the *outcome*. The e2e harness (`hub/test/e2e/`, Woodpecker `postgres:16`) proves ticks, sentinel reconciliation, and `routine_run_log` writes — while the one thing the subsystem exists to do (produce a PR) has never been exercised.
- Risk: **this is the most dangerous kind of coverage — it is green, and it proves nothing that matters.**
- Priority: **High**

**Run leak / capacity:**
- Files: `hub/src/db/supervisor-dal.ts:305`, `hub/src/sessions/budget.ts`
- Not tested: that a NULL-`session_id` open run is ever reaped. It isn't (item 2).
- Priority: **High**

**Circuit-breaker recovery:**
- Files: `supervisor/src/process-manager.ts:462`
- Not tested: that the supervisor ever leaves the open state. It doesn't (item 3).
- Priority: **High**

**Cap coverage:**
- Files: `hub/src/dispatch/gates.ts`
- Not tested: that every dispatch entry point carries `dailyTokenCapGate` (item 4).
- Priority: **High**

---

*Concerns audit: 2026-07-12*
