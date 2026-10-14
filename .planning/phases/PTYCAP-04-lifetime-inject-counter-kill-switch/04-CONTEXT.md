# Phase 4: Lifetime Inject Counter + Kill Switch - Context

**Gathered:** 2026-10-13
**Status:** Ready for planning
**Decision record:** 3-seat refute-first panel (claude + codex + agy), `p4-gate1-{claude,codex,agy}.md`, reconciled with the orchestrator's earlier lock
(`p4-gap-research-brief.md` "Context (already decided)"). Evidence-weighted: an evidenced seat beats an unevidenced one; a seat that refuted (R) with
file:line evidence wins on that point. Grey areas answered by the panel, not a human. Phase 3 binding record: `PTYCAP-03-governed-automation-guard/03-CONTEXT.md`.

<domain>
## Phase Boundary

Phase 4 delivers: (SC-1) a LIFETIME per-counter inject ledger with an atomic, token-idempotent reserve immediately before every real send; (SC-2) an owner-facing
kill switch (hub-wide admin, per-user, per-session) that halts all machine-initiated automation, fresh-read, fail closed; (SC-3) a 60% daily-token-ceiling alarm
that EMAILS the owner, event-driven at token ingest; (SC-4) default daily token cap 50M -> 20M, documented prominently (owner pre-approved). It also replaces the two
fail-closed Phase-3 governor slots (`kill_switch`, `lifetime_counter`) and folds in the Phase 1 gap G-1 (PTY usage double count by `message.id`).

**In scope:** two additive tables + one alarm-claim table; counter/kill-switch module and gates; `counterKey` on `DispatchRequest`; reserve in `dispatch()`; kill-switch
gate in every non-human `gates: [` list + entry-point predicates; routes + OpenAPI; boot assertions; alarm at `recordTokenUsage`; cap constant + doc/test sweep; G-1 fix.

**Out of scope (explicitly):** kill-switch UI and Telegram trigger (Milestone GOV); automation `term.input` producer (Phase 5); heal/QC counter keys for event adapters
(Phase 7/8); cap-hit QC trigger consuming the `lifetime_inject` kind (Phase 9); active cancellation of in-flight turns (needs automation-ownership tracking); any prod env
change or flag flip (owner-only cutover; this run changes no prod env); changing the `DispatchGate` return shape.

**Honest scope statement (carry into VERIFICATION):** the gate lists cover `dispatch()`; SC-2 "halts ALL automation" is true only if the non-dispatch machine spawn
sites (D-09) are also guarded and pinned. Gate-list tests alone can stay green while a direct-send replay bypasses both controls.

</domain>

<decisions>
## Implementation Decisions

### Counter (SC-1)
- **D-01 (H1 A+):** Append-only ledger table `automation_inject_ledger`, NO foreign keys, plain TEXT ids (`user_id`, `session_id`, `counter_key`, `actor`, `token`, `created_at`,
  `released_at`), counted forever. The key is carried by ONE optional, server-set `DispatchRequest.counterKey` (precedent: `humanInteractive?: true`, never from client
  input, pipeline.ts:44-47) - NOT a `PipelineDeps` thunk (gates only see `req`, a second supply point can drift into a silent no-op). Derivation: `task:<scheduled_tasks.id>` where
  the dispatcher knows its task (orchestrator inject needs `taskId` threaded from macro-cycle `input.taskId` into `InjectInput`; scheduler agent/triage), else `session:<sessionId>`.
  Static pin: `counterKey` assigned only in allowlisted modules (mirrors Phase 3 D-09). Rejected: B (resets on supersede), C and D (a per-user aggregate is a bigger budget with a second
  reset surface; the daily token cap already bounds per-user spend). Residual documented: delete/recreate of a task or session re-mints the key. **Reversibility:** costly (07/08/09 consume the key).
- **D-02 (H2 NEW; supersedes (R) A and the AGY/post-send view):** The gate stays a NON-consuming check (`count since latest reset < cap`; DB error => block). Consumption is an atomic,
  idempotent RESERVE inside `dispatch()` after the online/park decision and BEFORE `store.open`/`deps.send` (pipeline.ts ~263-309): `INSERT ... SELECT ... WHERE count < cap
  ON CONFLICT (counter_key, token) DO NOTHING`, keyed by the dispatch token. Dropped, queued and parked requests never count; a promoted waiter re-enters `dispatch()` and the
  unique token makes a second reserve a no-op. If `deps.send` throws, stamp `released_at` (append-only compensation, never DELETE). Failure direction: pre-send over-counts (safe for a
  ceiling), post-send under-counts on crash/DB blip (unsafe). Rationale: Claude + Codex (high) refuted (R) with pipeline.ts evidence and 03-CONTEXT D-14/:158 (Phase 3 explicitly handed
  reserve-before-send to Phase 4); AGY's "exactly-one record" claim ignores the crash window. Reserve DB error => block (fail closed). **Reversibility:** costly.
- **D-03 (H2 corollary, Claude+Codex):** Grace replay at `inject.ts` ~395-401 calls `send()` directly (up to 10 min later, no gates/count/switch). It MUST re-enter `dispatch()` like the
  other replays (feedback, ask, error-capture, revanote, work, telegram, agent.ts). The PTY door (`pty-preflight.ts` `runChain`, constant token `pty-preflight:<sessionId>`) does not use
  `dispatch()`; the Phase 5 producer must mint a per-turn token and call the same reserve - pin with a caller test (Phase 3 D-12). Phase 4 ships the reserve as an exported function for it.
- **D-04 (H3 A amended):** Env `REMO_AUTOMATION_LIFETIME_INJECT_CAP`, default **1000** per `counter_key` (~10.4 days at the 4/hr ceiling; would have stopped the 2,192-turn incident).
  Non-positive/unparseable => default AND the hub refuses to boot (`assertAutomationControls()`, copy of `assertTokenCapConfig`, gates.ts:204-222); never unbounded. Exhaustion =>
  fail-closed block `lifetime_inject_exhausted:<n>>=<cap>`. Reset = `POST /api/automation/lifetime/reset {counter_key}` (cookie + `requireRecentAuth`, user-scoped, audited) that appends a
  RESET MARKER row; count = rows after the latest marker; ledger history never deleted (rule 6). Notification classes: `automation_halted:*` is BENIGN (no page, add to macro-cycle's
  benign list ~283-296); `lifetime_inject_exhausted` pages ONCE per (counter_key, reset epoch) via a durable claim (avoids a per-tick storm).
- **D-05 (M1, Claude):** Coverage matrix - the lifetime counter applies to: orchestrator inject (both lists), scheduler agent + triage, and the governed PTY chain. Other adapters
  (error-capture, feedback, revanote, ask, work, cloud send) get the kill switch ONLY, listed in a test-pinned exemption set with one-line reasons (event streams have no task; a per-session cap of
  1000 would brick a busy repo's self-heal). Phase 7/8 supply their keys.

### Kill switch (SC-2)
- **D-06 (H4 A+):** Table `automation_kill_switch` (scope `global|user|session`, `user_id`, `session_id` TEXT NULL, `engaged`, `reason`, `engaged_by`, `engaged_at`, `released_by`,
  `released_at`; additive DDL + partial unique indexes), read FRESH on every check, plus call-time env break-glass `REMO_AUTOMATION_KILL_SWITCH` (`1|true|yes|on`; engaged regardless of DB;
  restart latency documented - not "immediate"). DB read error => ENGAGED (fail closed). Tenancy: `global` engage/release is ADMIN-only (`requireAdmin`); `user` scope halts the caller's own
  automation; `session` scope verifies `sessions.user_id == caller` (else IDOR). Exported predicate `isAutomationHalted({userId, sessionId})`. Block reason `automation_halted:<scope>`.
  Routes (cookie auth, `_openapi.ts`, `bun run docs:sync`): `GET /api/automation/kill-switch`; `POST .../engage` (NO step-up, precedent orchestrator `/stop`, index.ts:428-440);
  `POST .../release` (`requireRecentAuth`). No UI.
- **D-07 (H4 C rejected):** No blanket `session.stop` on engage (would hit human sessions and collide with `user_stopped`, orphan-resume.ts:13-17). Engage = "no new send or spawn after
  engagement". Active-run cancellation is a deferred, opt-in follow-up once automation ownership is tracked. In-flight turns (e.g. 6h TEAB) are a documented residual.
- **D-08 (H5 A+; Codex/Claude evidence beats Brief seat):** Shared `automationKillSwitchGate` is FIRST in EVERY non-human `gates: [` list (orchestrator inject x2, scheduler agent, triage, error-capture,
  feedback, revanote, ask, work, cloud send) and the pty-preflight AUTOMATION branch; never the Telegram human list or the human chain. New coverage test modeled on token-cap-coverage with an
  explicit human allowlist (pty-preflight's variable list is invisible to the scan - separate pin). Gate is non-consuming; Phase 3 governor slot IS this same implementation (D-11).
- **D-09 (H5 corrections + Codex MF "final check"):** Entry-point/spawn coverage via `isAutomationHalted`: (a) scheduler check goes in `fireTask`'s pre-gate block beside threshold/cost cap
  (dispatcher.ts ~220/246), NOT in `fire()` and NOT keyed on `!isManual` (once-task email work passes `isManual:true`, :127); this covers `fire()`, `runNow()`, chain_task, webhook triage,
  triage/teab/run_command. Manual Run Now is BLOCKED (it launches automated work; release is one call). (b) Machine `maybeAutoLaunchOrchestrator` only (not human `/start` or Telegram);
  `orphan-resume` DEFERS without finalizing so release resumes it; BSA autospawn pre-launch chain; orchestrator tick entry. (c) A FINAL halt check immediately before every machine
  send/spawn (linearization), in addition to the entry check. (d) An enumerating pin test over all `session.start` senders (spawn-on-error:236 is post-gate and covered by lists; telegram/launch,
  auto-launch, orphan-resume, api/sessions x2, api/supervisors) with explicit machine/human classification, D-01-style.
- **D-10 (MF-1, AGY):** Queued waiters are not purged on engage; promotion re-runs the full gate list (IR-2) so the switch drops them. No queue mutation.

### Slot hand-off
- **D-11 (H9 A, Claude amendment adopted):** Phase 4 replaces the `kill_switch` and `lifetime_counter` bodies in `hub/src/dispatch/governed-pty.ts` (names, `GOVERNOR_ORDER`, test setter kept).
  Real logic lives in a neutral module (`hub/src/dispatch/automation-controls.ts`) that both the slots and the dispatcher-list gates delegate to (ten non-PTY adapters must not import a PTY-named
  module); identity test: the dispatcher-list gate is the governor-slot object/delegate. `governor_not_implemented:*` disappears by design - rewrite the Phase 3 tests that pin it (03-01/03-02 plans).
  Composed prefix `automation_blocked_on_pty:<actor>:` unchanged; bare reasons in dispatcher lists: `automation_halted:<scope>`, `lifetime_inject_exhausted:<n>>=<cap>`. Planner MUST verify
  governed-pty.ts on the Phase 3 branch (two seats could not see it in their checkout).
- **D-12 (M6, Claude):** No `DispatchGate` signature change. 09-SPEC `CapHitEvent` derives its `cap` discriminant from stable reason prefixes (style of inject.ts ~289-290/421-424) and
  `task_id` from `req.counterKey`.

### Alarm (SC-3)
- **D-13 (H6 A+ - Claude/Codex evidence beats Brief/AGY record-before-send):** Evaluate event-driven AFTER the token-ledger commit in `recordTokenUsage` (callers: ws/agent.ts:822 and
  cloud/ingest.ts:82; late dynamic import to avoid the gates.ts<->DAL cycle; fire-and-forget, errors swallowed). Coalesce with a TRAILING-EDGE per-user timer (a drop-throttle can miss the final
  crossing). Threshold `REMO_TOKEN_CAP_ALARM_PCT`, default 60; garbage => 60, never off; no alarm when the cap is explicitly disabled. Day = the user's tz (`userTimezone`, gates.ts:72-77).
  Claim is ATOMIC and DURABLE in a small DEDICATED table (e.g. `token_cap_alarms`, `UNIQUE(user_id, local_date)`, `delivered` boolean, `attempts`, `last_attempt_at`): the claim is taken first, but
  `delivered` is set only when `sendEmail` returns true (it returns false without throwing on missing E4A env/non-2xx, email.ts:17-32); undelivered claims are retried on later usage events after a
  cooldown, bounded. Rejected: extending the `notifications_sent` CHECK (rollback drops it, no uniqueness) and plain record-before-send (burns the day's only alarm with zero emails sent).
  Delivery: direct `lib/email.ts sendEmail` to `users.email` (independent of `notify_channels`, cannot be muted) PLUS best-effort `fanOutNotify` limited to inapp+telegram. The existing 80%
  orchestrator-cycle alert is unchanged. Rejected: B (email side effect inside a gate) and C (polling, rule 23).

### Cap default (SC-4)
- **D-14 (H7 A, unanimous high):** `DEFAULT_DAILY_TOKEN_CAP` (gates.ts:163) -> 20_000_000. Update every assertion/doc that describes the shipped default (gates.ts incl. the stale "fail-open" comment :156-161,
  the token-cap test files + e2e, orchestrator-metrics.ts:71, CLAUDE.md 4 spots; `web/test/term-refusal.test.ts:14` is a fixture only). Document prominently in CLAUDE.md and the PR body: applies only where
  `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` is unset; human PTY usage counts and the human preflight checks it on every Enter; prod env must be checked before deploy (owner action; this run changes none).
  The cap commit lands LAST in the PR (see D-15).

### G-1 fold-in
- **D-15 (H8 A, unanimous):** Fix in the Phase 4 PR as FIRST commit (own commit): `supervisor/src/usage/pty-usage-emitter.ts` dedupes on `message.id` (fallback uuid), keeps per-bucket maxima, emits only
  POSITIVE deltas for a repeated id (clamp negatives to 0), with a three-records-one-id fixture test. Includes the supervisor version bump; PR body states the hub/MSI ordering window (the hub deploys on
  merge, hosts need a signed MSI; effective PTY ceiling ~10.9M real tokens until hosts update) and that supervisor tests are not in qc.yaml (run them locally).

### Boot and ops
- **D-16 (M4):** `assertAutomationControls()` at boot (exit 1): validates the lifetime-cap and alarm-pct env and that the three new tables exist (migrate.ts swallows per-statement DDL failures,
  :176-183, which would otherwise make every gate fail closed behind one log line).
- **D-17 (M5):** Owner emergency path with no UI = the API (cookie/JWT) + env break-glass. Record a GOV follow-up for a Telegram/UI trigger. Release needs a session under 15 min old; recovery is
  re-login (reauth.ts:42-44,63-66).
- **D-18 (MF-2, AGY):** Count top-level dispatches only (one `dispatch()` = one reserve); subagent/internal tool turns are not counted.
- **D-19 (invariants):** All DDL additive + idempotent in schema.sql (no INSERT/UPDATE/DELETE there; tools/schema-sql-lint.ts), backfills only in hub/scripts/; new env flags default to no-op where they
  are flags; no LLM API key; no new polling; no new skipped tests (skip baseline 259 vs `skip_max` 260), use DB-free unit tests with leaf-module mocks.

### Claude's Discretion
Table/column names beyond those above; module file names; plan/task ordering (except D-15 first, D-14 last); test file names; exact route payload shapes.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase text and invariants
- `.planning/ROADMAP.md` lines 14-28 (hard invariants), 95-115 (Phase 3 + Phase 4)
- `.planning/phases/PTYCAP-03-governed-automation-guard/03-CONTEXT.md` (D-02 slot contract, D-12, D-14), `03-RESEARCH.md` sections 3-8 + DESIGN SEAMS, `GATES/design-fork-1.md`
- `.planning/phases/PTYCAP-07-self-heal-routing/07-SPEC.md` (~121-124), `PTYCAP-08-task-qc/08-SPEC.md`, `PTYCAP-09-cap-hit-qc-trigger/09-SPEC.md` (~32-33, 57-72, 254) - consumers
- `.planning/phases/PTYCAP-01-pty-token-accounting/01-VERIFICATION.md` (G-1, L66-69)
- Panel inputs: `p4-design-fork-brief.md`, `p4-gate1-{claude,codex,agy}.md`, `p4-gap-research-brief.md`

### Code
- `hub/src/dispatch/pipeline.ts` (DispatchRequest L36-54; dispatch() ~223-330; promotion ~495), `gates.ts` (cap L150-222, rate L274-282), `governed-pty.ts`, `pty-preflight.ts` (L33-43, runChain L175-182)
- `hub/src/orchestrator/inject.ts` (L81-90 InputInput, L329, L395-401 grace replay), `macro-cycle.ts` (L43, L225, L283-296), `auto-launch.ts`, `orphan-resume.ts`
- `hub/src/scheduler/dispatcher.ts` (L127, 156-201, 220, 246, 271, 320, 610-669)
- `hub/src/db/token-usage-dal.ts` (L35-74, 209-220), `ws/agent.ts` (L791-840), `cloud/ingest.ts` (L72-97), `lib/email.ts`, `orchestrator/notify.ts`, `observability/cap-alert.ts`
- `hub/src/db/schema.sql` (L156-169, 380-394, 731-742), `db/migrate.ts` (L176-183), `hub/src/auth/reauth.ts`, `hub/src/index.ts` (L397-450), `hub/test/token-cap-coverage.test.ts`
- `supervisor/src/usage/pty-usage-emitter.ts` (L328-362)

### Tests and docs
- `hub/test/{token-cap-coverage,token-cap-gate-fires,pty-preflight,pty-door-guard,governed-pty-gate}.test.ts`, `hub/test/e2e/orchestrator-tokencap.e2e.test.ts`, `tools/schema-sql-lint.ts`
- `CLAUDE.md` (env section, docs map), `docs/usage-cost.md`, `hub/src/api/_openapi.ts` + `bun run docs:sync`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `assertTokenCapConfig` pattern; `requireRecentAuth`; `humanInteractive?: true` server-set-field precedent; Phase 3 `_setGovernorsForTests`; `sendEmail` (never throws); `userTimezone`.
- Test pattern: leaf-module mocks + `?t=${Date.now()}` cache-busting imports; scan-with-self-check (token-cap-coverage.test.ts:77-94).

### Integration Points
- `DispatchRequest` gains `counterKey?`; `dispatch()` gains reserve/release; ~11 adapter files gain the kill-switch gate (+ counter gate for D-05 set); `recordTokenUsage` gains the alarm hook; `index.ts` mounts routes.

</code_context>

<specifics>
## Specific Ideas

Greppable reasons: `automation_halted:<scope>`, `lifetime_inject_exhausted:<n>>=<cap>`, `automation_blocked_on_pty:<actor>:<reason>`.

</specifics>

<deferred>
## Deferred Ideas

- Kill-switch UI / Telegram trigger -> Milestone GOV. Opt-in `stop_running` cancellation of active runs (needs automation-ownership tracking). Per-user aggregate lifetime ceiling (rejected, revisit only on evidence).
- Heal/QC counter keys for event adapters -> Phase 7/8. `lifetime_inject` cap-hit QC kind -> Phase 9. Automation PTY byte-producer + per-turn token -> Phase 5.

</deferred>

## Panel record

| Fork | Claude | Codex | AGY | Locked |
|---|---|---|---|---|
| H1 counter identity | A+ (key on DispatchRequest) med-high | A+ med | A high | A+ (D-01) |
| H2 count vs consume | NEW: non-consuming gate + atomic pre-send reserve | NEW: same, token-idempotent | A (post-send insert) | NEW pre-send reserve (D-02/03); evidence beats AGY |
| H3 cap + exhaustion | A, 1000, reset marker row | A amended, reset epoch | A | A 1000 + reset marker + once-per-epoch page (D-04) |
| H4 kill switch storage | A with amendments (tenancy, opt-in stop) | A+ (tenancy, no blanket stop) | A | A+ global admin-only, no blanket stop (D-06/07) |
| H5 coverage | A + 4 corrections | A+ (structural coverage) | A | A+ (D-08/09/10) |
| H6 alarm | A + atomic claim/delivered flag, dedicated table | A+ trailing-edge, partial unique claim | A (record-before-send) | A+ dedicated table + delivered flag + trailing edge (D-13) |
| H7 20M | A high | A high | A high | A (D-14) |
| H8 G-1 | A (commit 1, version bump) | A | A | A, first commit (D-15) |
| H9 slots | A, neutral module | A | A | A + neutral module (D-11) |
| M1 coverage matrix | Claude: orch+scheduler+PTY count | - | - | D-05 |
| M2/M3 notif classes, tenancy | Claude | Codex (tenancy) | - | D-04, D-06 |
| M4 boot assertions | Claude | - | - | D-16 |
| M5 owner emergency path | Claude | - | - | D-17 |
| M6 CapHitEvent mapping | Claude | - | - | D-12 |
| Final pre-send halt check | - | Codex | - | D-09(c) |
| Queued runs on engage | - | - | AGY MF-1 | D-10 |
| Top-level only counting | - | - | AGY MF-2 | D-18 |

## Residual risks (from seats' RISKS)

1. **Bypass of non-dispatch spawn/send sites** (Claude R1, Codex R1): grace replay, machine auto-launch, orphan-resume, run_command/teab, in-flight turns. Mitigated by D-03, D-09, the `session.start` pin; in-flight turns remain a documented residual (D-07).
2. **Silent no-op / brick** (Claude R2, Codex R2/R3): swallowed DDL failure (D-16), burned alarm slot (D-13), key drift (D-01), replaceable keys / entity churn re-minting a key (documented residual), overshoot from non-atomic count (D-02), global switch halting other tenants (D-06).
3. **Self-lockout** (Claude R3, AGY R1): human PTY Enter blocks at the lowered cap with env-plus-redeploy recovery; release needs a fresh session (<15 min), recovery via re-login; env break-glass needs a restart. GOV owns the UI/Telegram path.
4. **G-1 / cap ordering window** (Claude R2iv): hub cap drops 2.5x before hosts get the fixed MSI; mitigated by commit order and PR-body disclosure.
5. **Negative-delta edge in G-1** (AGY R3): clamp to 0; unverified assumption that later records for a message.id carry >= usage (Claude UNABLE-TO-VERIFY) - fixture test must cover out-of-order.
6. **Alarm overhead** (AGY refutation): in-memory trailing-edge coalescing before any async lookup (D-13).
7. **Unverified by seats:** governed-pty.ts presence on the Phase 3 branch (planner re-check); prod `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` value (owner action, not an owner-only decision for this phase).

## CANNOT-CONCLUDE

None. SC-4 20M cap is owner pre-approved.

---

*Phase: 4-lifetime-inject-counter-kill-switch*
*Context gathered: 2026-10-13*
