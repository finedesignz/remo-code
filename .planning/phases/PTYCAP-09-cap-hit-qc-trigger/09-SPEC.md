# PTYCAP-09 — Cap-Hit → QC Trigger

> **Status: SPEC ONLY. Not buildable yet.**
> Build starts only after **PTYCAP Phase 4** (lifetime inject counter + kill switch) **and Phase 8**
> (the bounded QC engine) are green. Phase 9 does not build a new engine — it builds the *trigger*
> that points Phase 8's engine at a cap-hit cause. Building the trigger before the bounded engine
> exists recreates the unbounded-loop shape. Also blocked behind PR #346 (owns `gates.ts`).

---

## 1. Failure modes this is designed against

**The 2026-07-11 incident, restated as a shape:** *an automated reaction to a condition, which itself
created the condition, with no bound on the loop.* The orchestrator injected → burned tokens → the
tick fired again → injected again. 2,192 turns. 2.83B cache-read tokens. Max subscription dead.

**Phase 9 proposes: "when a cap is hit, spawn an AI to investigate the cap-hit."** That is *literally
the same shape* — a reaction to a spend condition, which spends. If a QC run can itself hit a cap and
that cap-hit fires another QC run, the incident recurs, but now it is a *designed* feature instead of
a bug. Therefore:

### The three anti-recursion invariants (non-negotiable, each individually test-enforced)

| # | Invariant | Enforcement |
|---|---|---|
| **AR-1** | A cap-hit raised **inside a QC run** escalates to the human and spawns **NOTHING**. | The cap-hit event carries a server-inferred `origin`; `origin='task_qc'` ⇒ notify-only, hard return before the enqueue. Test: QC-origin cap-hit ⇒ 0 QC runs enqueued. |
| **AR-2** | At most **one** QC run per `(task_id, cause)` per window. | DB-claimed dedupe (`INSERT ... ON CONFLICT DO NOTHING` on a unique key), not an in-memory set. Test: 100 concurrent identical cap-hits ⇒ exactly 1 QC run. |
| **AR-3** | QC runs on a **separate, bounded budget that a QC run cannot raise**. | `REMO_TASK_QC_TOKEN_CAP` (Phase 8, default 500K/run) + a per-day `REMO_CAP_QC_DAILY_RUNS` (default 3). The QC safe-fix allowlist contains no fix that can modify a cap. Test: `applyFix({kind:'raise_cap'})` throws. |

**Additional bounds:**
- Total QC runs triggered by cap-hits per user per day: `REMO_CAP_QC_DAILY_RUNS`, default **3**.
- A QC run triggered by a cap-hit is still subject to the Phase-4 **kill switch** and the **lifetime
  inject counter** — a thrown kill switch means zero QC spawns, no exception.
- If the daily token cap is already exceeded, the QC run **does not run** — it escalates immediately.
  (A cap-hit means there is no budget left; spending more to investigate is the incident.)

---

## 2. Current state (verified 2026-07-12)

- A cap block today is a `DispatchGate` returning `{ok:false, reason}` — `over_daily_cost_cap:…`,
  `over_daily_token_cap:<n>>=<cap>`, `over_session_inject_rate:<n>>=<cap>`,
  `programmatic_credit_halt:…` (`hub/src/dispatch/gates.ts`). The pipeline maps it to
  `{kind:'skipped', reason}` and the RunStore marks the run skipped.
- **That is the end of the story.** Nothing attributes the cause, nothing acts, the run is skipped and
  (for scheduled tasks) the owner gets a summary email. The next tick tries again and gets blocked
  again. The cap is a wall, not a signal.
- Phase 4 adds the lifetime inject counter + kill switch + a 60%-of-ceiling alarm email. Phase 9 is
  what happens at 100%.

---

## 3. Requirements (falsifiable)

### CQ-01 — A cap-hit emits ONE typed event with an attributed cause
- **Current:** a cap block is a string reason on a skipped run; no event, no attribution.
- **Target:** every blocking gate in `hub/src/dispatch/gates.ts` (cost cap, token cap, inject-rate,
  lifetime counter, programmatic halt) emits exactly one `CapHitEvent`:
  ```
  CapHitEvent = {
    user_id: string
    cap: 'daily_token' | 'daily_cost' | 'session_inject_rate' | 'lifetime_inject' | 'programmatic_halt'
    cause: {
      task_id: string | null
      session_id: string
      top_spender_task_id: string | null   // attributed from token_usage over the window
      share_pct: number | null             // that task's share of the window's tokens
    }
    origin: 'scheduler' | 'orchestrator' | 'error_capture' | 'feedback' | 'human' | 'task_qc'  // SERVER-INFERRED, never client-asserted
    observed_at: timestamptz
  }
  ```
- **Acceptance:**
  - [ ] Test: each of the five gates, when blocking, emits exactly one `CapHitEvent` with the right
        `cap` discriminant.
  - [ ] Test: `origin` is derived from the dispatch source on the server. A payload field claiming
        `origin: 'human'` cannot change it (negative test — mirrors the milestone's
        "actor is server-inferred" invariant).
  - [ ] Test: attribution names the top-spending task for the window from `token_usage`; when it
        cannot be determined, `top_spender_task_id` is `null` and the QC run is still allowed (with
        `cause: unattributed`).
  - [ ] Emitting the event is **best-effort and non-blocking**: an emit failure NEVER un-blocks the
        gate (the cap stays non-bypassable).

### CQ-02 — AR-1: a QC-origin cap-hit escalates and spawns nothing
- **Current:** n/a.
- **Target:** `if (event.origin === 'task_qc') { notifyHuman(event); return; }` — before any dedupe,
  any enqueue, any spawn. This is the single most important line in the phase.
- **Acceptance:**
  - [ ] Test: a `CapHitEvent` with `origin='task_qc'` produces **zero** QC runs enqueued, **zero**
        session launches, and exactly one escalation notification.
  - [ ] Test: this holds even when every other gate/flag/allowlist is permissive (the check is not
        conditional on any flag).
  - [ ] Static guard test: `hub/src/cap-qc/` contains no code path from an `origin='task_qc'` event
        to `launchSessionForUser` / `dispatch` / `enqueueQcRun`.

### CQ-03 — AR-2: one QC run per (task, cause) per window
- **Current:** n/a.
- **Target:** a DB-claimed dedupe key `(user_id, task_id, cap, window_bucket)`. The claim is
  `INSERT ... ON CONFLICT DO NOTHING`; loser = drop + log. Window default 24h
  (`REMO_CAP_QC_DEDUPE_WINDOW_MS`).
- **Acceptance:**
  - [ ] Test: 100 concurrent identical cap-hits ⇒ exactly ONE QC run enqueued; 99 logged as
        `deduped`.
  - [ ] Test: same task, DIFFERENT cap ⇒ a second QC run is allowed (a different cause is a different
        problem).
  - [ ] Test: dedupe survives a hub restart (it is in the DB, not memory).

### CQ-04 — AR-3: separate bounded budget, unraisable by QC
- **Current:** n/a.
- **Target:** the QC run uses Phase 8's engine and therefore Phase 8's `REMO_TASK_QC_TOKEN_CAP`, plus
  a per-day count ceiling `REMO_CAP_QC_DAILY_RUNS` (default 3). No safe-fix in Phase 8's allowlist can
  modify any cap or any env-derived ceiling.
- **Acceptance:**
  - [ ] Test: the 4th cap-triggered QC run in a day is refused with `over_cap_qc_daily_runs` and
        escalates instead.
  - [ ] Test: `applyFix({kind: 'raise_cap'})` / `{kind:'set_env'}` throws `unlisted_fix_kind`
        (Phase-8 guard, re-asserted here).
  - [ ] Test: with the daily token cap ALREADY exceeded, a cap-hit produces zero QC runs and one
        escalation (no "spend more to investigate the overspend").
  - [ ] Test: with the Phase-4 kill switch thrown, a cap-hit produces zero QC runs.

### CQ-05 — The QC pass tries to fix the CAUSE first
- **Current:** n/a.
- **Target:** the cap-triggered QC run is a Phase-8 QC pass **scoped to the attributed cause** — it
  audits the attributed task (or, if unattributed, the top-N spenders for the window) and applies only
  Phase-8 allowlisted safe fixes (e.g. `recompute_next_run_at` for a task firing far more often than
  intended, `backfill_payload_from_sibling` for a task retrying on a bad payload). Everything else is
  a proposal.
- **Acceptance:**
  - [ ] Test: a cap-hit attributed to a task with a broken `next_run_at` (firing every tick) ⇒ the QC
        run applies `recompute_next_run_at` and emails what it did.
  - [ ] Test: a cap-hit attributed to a task whose prompt is simply expensive ⇒ **no auto-fix** (prompt
        editing is not allowlisted) ⇒ a proposal + escalation.
  - [ ] Test: the QC run NEVER re-enables, re-injects, or retries the capped work. Fixing the cause is
        config-only; the capped work resumes on the next natural cadence, under the cap.

### CQ-06 — Escalation is a real escalation
- **Current:** a skipped run in a summary email.
- **Target:** when QC cannot fix the cause (unattributed, unlisted fix, QC-origin, budget exhausted,
  kill switch thrown), the human gets ONE email naming: the cap, the number, the attributed cause (or
  "unattributed"), what QC tried, and the exact remediation the owner can apply. Sent via the existing
  E4A sender (send field `from_inbox_id`, NOT `inbox_id`).
- **Acceptance:**
  - [ ] Test: each escalation reason produces exactly one email, and the email names the reason.
  - [ ] Test: escalations are throttled — no more than one email per `(user, cap)` per hour, even
        under a cap-hit storm (an already-capped user's every subsequent dispatch also hits the cap).

### CQ-07 — Flag-gated; OFF is exactly today's behaviour
- **Target:** `REMO_CAP_QC_ENABLED` default **OFF**. When OFF, a cap-hit behaves exactly as it does
  today: the gate blocks, the run is skipped, the existing notification fires. No event bus, no QC.
- **Acceptance:**
  - [ ] Test: flag unset ⇒ zero `CapHitEvent` handlers run, zero QC runs, gate behaviour byte-identical
        to `main`.
  - [ ] Test: `REMO_CAP_QC_ENABLED=1` but `REMO_TASK_QC_ENABLED=0` ⇒ cap-hits escalate (email) but
        never spawn a QC run — the trigger cannot outrun its engine.

---

## 4. Env knobs

| Knob | Default | Disabled semantics |
|---|---|---|
| `REMO_CAP_QC_ENABLED` | `0` (OFF) | OFF ⇒ a cap-hit behaves exactly as today (block + skip + existing email) |
| `REMO_CAP_QC_DAILY_RUNS` | `3` | non-positive / non-finite ⇒ **0** (fail-CLOSED — unlike the caps, which fail open, a *spawn* ceiling must never fail open) |
| `REMO_CAP_QC_DEDUPE_WINDOW_MS` | `86400000` (24h) | non-positive / non-finite ⇒ default (never "no dedupe") |
| `REMO_CAP_QC_ESCALATION_THROTTLE_MS` | `3600000` (1h) | non-positive ⇒ default |
| *inherited from Phase 8* | | |
| `REMO_TASK_QC_ENABLED` | `0` | OFF ⇒ cap-hits escalate only; the engine does not exist to spawn |
| `REMO_TASK_QC_TOKEN_CAP` | `500000` | the QC run's own ceiling |

**Note the deliberate asymmetry:** the spend *caps* fail OPEN when misconfigured (a broken cap must
not brick the app); the *spawn* ceilings here fail CLOSED (a broken spawn ceiling must not spawn).

---

## 5. DDL

`schema.sql` **re-runs in full every hub boot** ⇒ idempotent, additive DDL only. Backfills →
`hub/scripts/` one-shots. **No `UPDATE`/`DELETE` in `schema.sql`.**

```sql
-- The cap-hit ledger. Doubles as the AR-2 dedupe claim (unique key) and the audit
-- trail for "why did QC run".
CREATE TABLE IF NOT EXISTS cap_hit_events (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cap           TEXT NOT NULL,   -- daily_token | daily_cost | session_inject_rate | lifetime_inject | programmatic_halt
  origin        TEXT NOT NULL,   -- server-inferred dispatch source (incl. 'task_qc')
  task_id       TEXT,
  session_id    TEXT,
  top_spender_task_id TEXT,
  share_pct     NUMERIC,
  window_bucket TEXT NOT NULL,   -- floor(now / dedupe_window) — the AR-2 bucket
  disposition   TEXT NOT NULL,   -- qc_enqueued | deduped | escalated_qc_origin | escalated_no_budget | escalated_kill_switch | escalated_unfixable
  qc_run_id     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- AR-2: the dedupe claim. One QC run per (user, task, cap, window).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cap_hit_dedupe
  ON cap_hit_events(user_id, cap, COALESCE(task_id, ''), window_bucket)
  WHERE disposition = 'qc_enqueued';
CREATE INDEX IF NOT EXISTS idx_cap_hit_user ON cap_hit_events(user_id, created_at DESC);
```

*Uncertain:* whether a partial unique index on a `COALESCE` expression is the cleanest claim primitive
here versus a dedicated `cap_qc_claims` table. Both work; the plan should pick one and justify it. I
have not benchmarked either against this schema.

---

## 6. Tests that prove the requirements

| Test file | Proves |
|---|---|
| `hub/test/cap-hit-event.test.ts` | CQ-01 (five gates emit; origin server-inferred; emit failure never un-blocks the gate) |
| `hub/test/cap-qc-anti-recursion.test.ts` | **AR-1 / CQ-02** — QC-origin cap-hit ⇒ 0 spawns, 1 escalation, under every flag combination |
| `hub/test/cap-qc-dedupe.test.ts` | **AR-2 / CQ-03** — 100 concurrent ⇒ 1 run; survives restart |
| `hub/test/cap-qc-budget.test.ts` | **AR-3 / CQ-04** — daily-run ceiling fails CLOSED; cap-already-exceeded ⇒ no run; kill switch ⇒ no run; `raise_cap` fix throws |
| `hub/test/cap-qc-fix-cause.test.ts` | CQ-05 (allowlisted fix applied; expensive-prompt case ⇒ proposal only; never retries the capped work) |
| `hub/test/cap-qc-escalation.test.ts` | CQ-06 (one email per reason; storm throttled) |
| `hub/test/cap-qc-flag-off.test.ts` | CQ-07 (OFF = today; trigger-without-engine ⇒ escalate only) |
| `hub/test/e2e/cap-qc.test.ts` (real Postgres) | The whole chain: seeded runaway task ⇒ cap-hit ⇒ 1 QC run ⇒ `recompute_next_run_at` applied ⇒ no second QC run |

---

## 7. In scope

- `CapHitEvent` emission from every blocking gate, with server-inferred `origin` and cause
  attribution from `token_usage`.
- The three anti-recursion invariants (AR-1/2/3) and their tests.
- A bounded trigger that enqueues **at most one** Phase-8 QC run per (task, cause) per window.
- Escalation email with real content, throttled.
- `cap_hit_events` ledger (dedupe claim + audit trail).

**Reasoning:** a cap that only says "no" teaches nothing and repeats forever. The value is in the
attribution and the one bounded corrective action. The design is 80% brakes and 20% engine, on
purpose.

## 8. Out of scope

- **Raising, relaxing, or auto-tuning any cap.** Not in the QC safe-fix allowlist; not reachable from
  any Phase-9 code path. A system that can raise its own ceiling has no ceiling.
- **Retrying the capped work.** The capped turn stays capped. QC fixes CONFIG; the work resumes on its
  own cadence, under the (unchanged) cap.
- **QC-ing a cap-hit that a QC run caused.** AR-1. It escalates. Always.
- **More than one QC run per cause per window.** AR-2.
- **A new QC engine.** Phase 9 is a trigger. If Phase 8's engine is not green, Phase 9 escalates and
  spawns nothing (CQ-07).
- **Human-turn cap-hits triggering QC.** A human hitting their own cap needs a message, not an
  investigation. `origin='human'` ⇒ notify-only in v1.
  *(Uncertain — the owner may want human cap-hits QC'd later. Deliberately excluded for now: it is
  additive and can be turned on from evidence.)*
- **Any UI.** Email is the surface. The receipts/kill-switch UI is Milestone GOV.

**Reasoning:** every excluded item is a path by which a spend-reaction could increase spend. That is
the exact bug that cost the owner a Max subscription; it does not get to ship twice, and it certainly
does not get to ship as a feature.
