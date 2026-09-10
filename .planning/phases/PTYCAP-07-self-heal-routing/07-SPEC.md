# PTYCAP-07 — Unified Self-Heal Routing

> **Status: SPEC ONLY. Not buildable yet.**
> Build starts only after (a) **PR #346** lands — it currently owns
> `hub/src/scheduler/senders/triage.ts`, `hub/src/dispatch/gates.ts`,
> `hub/src/db/supervisor-dal.ts`, `hub/src/sessions/stale-run-reaper.ts` and the four dispatchers —
> and (b) **PTYCAP Phases 1–4 are green**. Phase 4 (lifetime inject counter + kill switch) is a hard
> precondition: this phase ARMS failure-triggered unattended spawning.
> This spec MUST be rebased on #346's final shape before any plan is written.

---

## 1. Failure modes this is designed against

**The 2026-07-11 incident.** The orchestrator re-injected into ONE session every 60s for 48h and
burned 2.83B cache-read tokens, exhausting the owner's Max subscription. Two causes: the daily token
cap counted only input+output (cache-read was free-and-invisible), and `orchestrator_rows` carried no
cadence state. Fixed by #342/#343; the orchestrator is currently OFF
(`REMO_ORCHESTRATOR_ENABLED=0`).

**Phase 7 is the same capability class**: it lets a *machine event* (a deploy failure, a crashing
app) cause a *CLI spawn* with no human in the loop. Everything below is written to bound that.

**The concrete failure observed 2026-07-11 (the one this phase fixes).** Two runs — `8a6e0534` and
`fa377e27`, task `0e16bf38` (`__internal_coolify_deployment`), Coolify apps `xxhodf65` and
`zl7c3u88` — were created with `session_id = NULL`, sat `pending` for ~6h, were finalized
`failed`/`run_timeout` by `hub/src/scheduler/run-reaper.ts`, and emailed the owner. Nothing healed;
the owner got a 6-hour-late failure email for a deploy that broke at minute zero.

Why: `hub/src/api/coolify-webhook.ts` only short-circuits to `skipped`/`no_routable_session` when the
user has NO online agent session AND NO online supervisor at all. If *any* supervisor is online, it
dispatches; `sendTriage` then capacity-routes via `pickSessionTarget` to a supervisor spawn whose
run may never come back — and the metadata run row hangs until the 6h reaper.

**Blast-radius bounds this phase must hold:**

| Bound | Value |
|---|---|
| Spawns per heal event | ≤ 1 (dedupe-claimed) |
| Spawn precondition | repo on `orchestrator_autospawn_allowlist` (default EMPTY ⇒ nothing spawns) |
| Gate chain | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate, <Phase-4 lifetime + kill switch>]` — non-bypassable |
| Time-to-terminal for an un-routable failure | seconds, not 6h |
| Notifications per heal event | exactly 1 |
| Default state | flag OFF ⇒ byte-for-byte today's behaviour |

---

## 2. Current state (verified in this worktree, 2026-07-12)

Four failure sources, four different routing stories:

| Source | Entry | Routing today | Dispatch today |
|---|---|---|---|
| Coolify deploy failure | `hub/src/api/coolify-webhook.ts` → `dispatchTriage` → `hub/src/scheduler/senders/triage.ts` | `resolveRepoKeyedAgentSession` first, else `pickSessionTarget` (capacity) | shared `dispatch()` for the `local_agent` pick; **legacy `pending` map + `sendToSupervisor`** for the `supervisor` pick |
| Scheduled-task failure | `hub/src/scheduler/dispatcher.ts` `finalizeRun` | none — a failed run just emails | none (no heal) |
| Error capture | `hub/src/error-capture/*` → shared dispatch, `ensureOnline` = `hub/src/dispatch/spawn-on-error.ts` | bound session only | shared `dispatch()`; spawn gated by `REMO_SPAWN_ON_ERROR` (default OFF) |
| Feedback intake | `hub/src/webhooks/intake.ts` | bound session only | shared `dispatch()` |

Two spawn primitives already exist and disagree:
- `hub/src/dispatch/spawn-on-error.ts::ensureSessionOnline` — leak-safe reserve→createRun→
  `session.start`→bounded poll→proactive `endRun`; flag `REMO_SPAWN_ON_ERROR` (default OFF).
- `hub/src/orchestrator/inject.ts::maybeAutospawnOffline` — allowlist + token cap + launch-count cap
  + grace park; flags `REMO_ORCHESTRATOR_ENABLED` + `REMO_ORCHESTRATOR_AUTOSPAWN` (both default OFF).

---

## 3. Requirements (falsifiable)

### SH-01 — One `routeHeal()` seam, four callers
- **Current:** four sources with four routing/dispatch stories (table above).
- **Target:** a new module `hub/src/heal/route.ts` exports
  `routeHeal(event: HealEvent): Promise<HealOutcome>`. All four sources construct a `HealEvent` and
  call it. No source constructs its own `PipelineDeps`, `pickSessionTarget` call, or
  `sendToSupervisor` frame for a heal.
- **Acceptance:**
  - [ ] `hub/src/heal/route.ts` exists and exports `routeHeal` + the `HealEvent`/`HealOutcome` types.
  - [ ] Guard test `hub/test/heal-single-seam.test.ts` greps `hub/src/{api/coolify-webhook,scheduler,error-capture,webhooks}` for `pickSessionTarget(`, `sendToSupervisor(`, and `dispatch(` used on a heal path, and FAILS if any is found outside `hub/src/heal/`.
  - [ ] Every heal dispatch's `gates:` array is discovered by the existing `hub/test/token-cap-coverage.test.ts` scan.

### SH-02 — `HealEvent` is a closed, source-agnostic union
- **Current:** `TriagePayload` (Coolify-shaped) is the only structured failure payload;
  error-capture and feedback carry their own shapes.
- **Target:**
  ```
  HealEvent = {
    user_id: string
    source: 'coolify_deploy' | 'scheduled_task' | 'error_capture' | 'feedback'
    repo_ident: string | null        // github://owner/repo | path://<abs>
    dedupe_key: string               // source-supplied fingerprint
    prompt: string                   // fully rendered by the source
    metadata_run_id: string | null   // the row that MUST reach a terminal status
  }
  ```
- **Acceptance:**
  - [ ] All four sources compile against `HealEvent` with no `any` cast.
  - [ ] A source that cannot resolve a `repo_ident` passes `null` and is routed by SH-05 (fail fast), never by capacity.

### SH-03 — LIVE session wins: dispatch into it, never spawn
- **Current:** `sendTriage` prefers a repo-keyed live session (good) but falls back to a
  **capacity-picked stranger / fresh supervisor spawn** (bad — a fix for repo X can land in a session
  bound to repo Y, and costs a cold spawn).
- **Target:** when `resolveRepoKeyedAgentSession(user, repo_ident)` returns a session that is LIVE
  (live agent channel AND not a ghost — reuse `inject.ts::defaultIsSessionLive`), `routeHeal`
  dispatches the heal turn into THAT session through the shared pipeline. **No spawn, no capacity
  fallback, near-zero marginal cost** (warm CLI, already holds repo context).
- **Acceptance:**
  - [ ] Test: repo-bound session live ⇒ outcome `dispatched_live`; `launchSessionForUser` and
        `sendToSupervisor` are never called (spies assert 0 calls).
  - [ ] Test: repo-bound session is a GHOST (`status='online' AND hostname IS NULL`) ⇒ NOT treated as
        live; routes to SH-04/SH-05.
  - [ ] `pickSessionTarget` capacity-routing is REMOVED from the heal path (a heal never lands in a
        session bound to a different repo). Guard test asserts no `pickSessionTarget` import in
        `hub/src/heal/`.

### SH-04 — OFFLINE + allowlisted: autospawn via the existing BSA path, then dispatch
- **Current:** two competing spawn primitives (§2); the orchestrator's is the governed one and the
  heal paths do not use it.
- **Target:** when the repo session is offline/absent AND `isRepoAutospawnAllowed(user, repo_ident)`
  is true AND the gate chain passes, `routeHeal` spawns via the **existing BSA path**
  (`launchSessionForUser` + grace park, as `inject.ts::maybeAutospawnOffline` does) and the parked
  heal prompt is delivered on the runner's reconnect. The pre-launch AND-chain from
  `maybeAutospawnOffline` is reused verbatim: orchestrator-enabled ∧ autospawn-enabled ∧ allowlisted
  ∧ supervisor-online ∧ not over token cap ∧ not over the per-day launch cap ∧ (Phase 4) kill switch
  not thrown ∧ lifetime counter not exhausted.
- **Open question (flag to the owner at plan time — do NOT decide in this spec):** whether
  `spawn-on-error.ts` is (a) retired in favour of the BSA path, or (b) kept and made to call the same
  AND-chain. I do not know which the owner prefers; both are defensible and #346 may move this code.
- **Acceptance:**
  - [ ] Test: offline + allowlisted + all gates pass ⇒ exactly ONE `launchSessionForUser` call;
        outcome `autospawn_launched`; prompt parked in grace.
  - [ ] Test: offline + allowlisted + `REMO_ORCHESTRATOR_AUTOSPAWN` OFF ⇒ zero launches; SH-05 path.
  - [ ] Test: two heal events with the same `dedupe_key` inside the window ⇒ exactly ONE launch.
  - [ ] Test: token cap exceeded ⇒ zero launches, outcome `refused:over_token_cap`.

### SH-05 — OFFLINE + NOT allowlisted: fail FAST, terminal, one email
- **Current:** the incident. `session_id=NULL` metadata run sits `pending` ~6h → `run-reaper` →
  `failed`/`run_timeout` → one late, useless email.
- **Target:** `routeHeal` returns `{ kind: 'no_routable_session' }` **within the same request**, and
  finalizes `metadata_run_id` as `skipped` / `no_routable_session` (the semantics
  `coolify-webhook.ts` already uses — `skipped`, not `failed`, so `on:'success'` post-run chains do
  not fire). Exactly one notification, sent immediately, naming the repo and why it was un-routable.
- **Acceptance:**
  - [ ] Test replaying the incident fixture (task `0e16bf38`, apps `xxhodf65` / `zl7c3u88`, no live
        repo session, repo not allowlisted): the metadata run reaches a terminal status in
        **< 5 seconds** of the webhook, with `error = 'no_routable_session'`.
  - [ ] Test: NO run row anywhere is left `ended_at IS NULL` / `status='pending'` after the event
        (regression guard for the NULL-`session_id` orphan-run leak class).
  - [ ] Test: exactly one notification is emitted per `dedupe_key` (not one per source, not one per
        retry).
  - [ ] The 6h `run-reaper` never fires for a heal run in the incident fixture (assert reaper sees
        zero candidates).

### SH-06 — Rides the shared dispatch chain; no hand-rolled dispatch
- **Current:** `sendTriage`'s supervisor branch bypasses the pipeline entirely (legacy `pending` map
  + `onTriageAssistantMessage`), so it is NOT behind the queue/grace/finalize machinery.
- **Target:** every heal dispatch goes through `hub/src/dispatch/pipeline.ts::dispatch()` with a
  `RunStore` that finalizes via `onSessionReply`. CLAUDE.md invariant: "Don't hand-roll
  per-subsystem dispatch/queue/grace."
- **Acceptance:**
  - [ ] The legacy triage `pending` map + `onTriageAssistantMessage` hook are removed OR provably
        unreachable from the heal path (guard test).
  - [ ] `hub/test/token-cap-coverage.test.ts` passes with the heal gate list included.
  - [ ] Test: a cost-capped / token-capped user's heal event NEVER calls `send` (IR-1).

### SH-07 — Flag-gated; OFF is a true no-op
- **Current:** n/a.
- **Target:** `REMO_HEAL_UNIFIED` (default **OFF**). When OFF, each source keeps its current code
  path byte-for-byte.
- **Acceptance:**
  - [ ] Test: with the flag unset, the Coolify/error-capture/feedback paths produce identical
        outcomes to `main` (snapshot/behaviour test).
  - [ ] Test: unrecognized flag value ⇒ treated as OFF.

---

## 4. Env knobs

| Knob | Default | Disabled semantics |
|---|---|---|
| `REMO_HEAL_UNIFIED` | `0` (OFF) | OFF ⇒ every source keeps its current path; `routeHeal` is never called |
| `REMO_HEAL_DEDUPE_WINDOW_MS` | `900000` (15 min, matching the existing Coolify storm-dedupe window) | non-positive / non-finite ⇒ default (never "no dedupe") |
| `REMO_HEAL_SPAWN_TIMEOUT_MS` | `25000` (parity with `REMO_SPAWN_ON_ERROR_TIMEOUT_MS`) | non-positive / non-finite ⇒ default |
| *inherited, unchanged* | | |
| `REMO_ORCHESTRATOR_AUTOSPAWN` | OFF | OFF ⇒ SH-04 never spawns; every offline heal takes SH-05 |
| `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` | 50M (Phase 4 lowers to ~20M) | non-positive ⇒ token ceiling disabled (fail-open) |
| `REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES` | 20 | non-positive ⇒ launch-count cap disabled |

`orchestrator_autospawn_allowlist` stays **EMPTY by default** ⇒ with default config, Phase 7 spawns
nothing, ever. It only stops the 6h hang.

---

## 5. DDL

`schema.sql` **re-runs in full every hub boot** ⇒ idempotent, additive DDL only. Backfills →
`hub/scripts/` one-shots.

Additive only:

```sql
-- heal event ledger: one row per HealEvent, the dedupe + audit source.
CREATE TABLE IF NOT EXISTS heal_events (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  repo_ident   TEXT,
  dedupe_key   TEXT NOT NULL,
  outcome      TEXT,            -- dispatched_live | autospawn_launched | no_routable_session | refused:<reason>
  metadata_run_id TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_heal_events_dedupe ON heal_events(user_id, dedupe_key, created_at DESC);
```

No column is dropped, no existing table altered. **No `UPDATE`/`DELETE` in `schema.sql`.**

*Uncertain:* whether the existing Coolify `claimDeployFailure` dedupe table can serve as the dedupe
source instead of a new one. If it can, prefer it and drop this table from the plan — I have not read
that table's schema closely enough to assert it.

---

## 6. Tests that prove the requirements

| Test file | Proves |
|---|---|
| `hub/test/heal-single-seam.test.ts` | SH-01 (static guard: no dispatch/routing outside `hub/src/heal/`) |
| `hub/test/heal-route-live.test.ts` | SH-03 (live wins; zero spawns; ghost ≠ live) |
| `hub/test/heal-route-autospawn.test.ts` | SH-04 (allowlist + gates + one launch + dedupe) |
| `hub/test/heal-route-no-target.test.ts` | SH-05 (terminal < 5s; zero orphan runs; one email) |
| `hub/test/e2e/heal-incident-replay.test.ts` (real Postgres, Woodpecker `postgres:16`) | SH-05 against the incident fixture; the run-reaper sees zero candidates |
| `hub/test/token-cap-coverage.test.ts` (extend) | SH-06 (heal gate list scanned) |
| `hub/test/heal-flag-off.test.ts` | SH-07 (default OFF = no-op) |

---

## 7. In scope

- `hub/src/heal/route.ts` — the single routing seam + `HealEvent`/`HealOutcome`.
- Rewiring the four failure sources to call it (behind `REMO_HEAL_UNIFIED`).
- Removing capacity-based (`pickSessionTarget`) routing **from the heal path**.
- Terminal-status guarantee for heal metadata runs (kill the 6h hang).
- One dedupe/audit ledger (`heal_events`) + one notification per event.
- Reuse of the existing BSA autospawn AND-chain and the shared dispatch pipeline.

**Reasoning:** the value is entirely in *one decision made once*. Four half-healers is how a repo can
be healed by a session bound to a different repo, and how a metadata run sits pending for six hours.

## 8. Out of scope

- **Changing any cap value or gate semantics.** Phases 1–4 own the caps; Phase 7 consumes them. A cap
  change hidden inside a routing phase is exactly how the 2026-07-11 blindspot shipped.
- **Populating `orchestrator_autospawn_allowlist`.** Arming is an owner go/no-go
  (`docs/orchestrator-autospawn-runbook.md`), not a code change.
- **Flipping `REMO_ORCHESTRATOR_ENABLED` / `REMO_ORCHESTRATOR_AUTOSPAWN`.** They stay OFF.
- **Any PTY-path change.** Heal dispatch is programmatic/stream-json. Phases 2–3 own the PTY gate.
  A heal turn must never write to a `pty-interactive` session while `governedAutomationPtyGate` is
  OFF.
- **Auto-merging a heal's PR.** A heal produces a branch/PR at most; the no-auto-merge guard is
  untouched.
- **The Telegram/Revanote paths.** They are inbound *human* channels, not failure sources.
- **`pickSessionTarget` itself** — still used by non-heal scheduled tasks; not deleted, just not used
  by heals.

**Reasoning:** every out-of-scope item is either (a) a cap/arming decision that belongs to the owner,
or (b) a second capability that would make the blast radius of a routing bug unbounded.
