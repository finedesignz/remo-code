# PTYCAP-08 — Periodic Task QC + Optimization

> **Status: SPEC ONLY. Not buildable yet.**
> Build starts only after **PTYCAP Phase 4** (lifetime inject counter + kill switch) is green, and
> after **PR #346** lands (it owns `hub/src/dispatch/gates.ts` and the four dispatchers). This phase
> gives an AI write-access to task CONFIG; the Phase-4 counter + kill switch are the preconditions.
> Phase 8 may be built in parallel with Phase 7 (disjoint files).

---

## 1. Failure modes this is designed against

**The 2026-07-11 incident.** A wedged 60s orchestrator tick re-injected into ONE session for 48h,
burning 2.83B cache-read tokens and killing the owner's Max subscription. The daily token cap was
blind to cache-read; `orchestrator_rows` had no cadence state. Fixed (#342/#343); orchestrator OFF.

**Phase 8 is the same capability class, one step nastier**: a *recurring, unattended* task whose job
is to *modify other tasks*. Three specific ways this could go wrong, each explicitly bounded below:

| Failure mode | Bound |
|---|---|
| The QC task opens a dev loop and grinds (the incident shape) | Its own small token ceiling (`REMO_TASK_QC_TOKEN_CAP`, default 500K), a **separate** ceiling from the daily cap; it diagnoses CONFIG, it never plans/builds/PRs |
| The QC task auto-disables a task the owner deliberately set | **Auto-disable is not on the allowlist and cannot be added to it.** TQC-04 |
| The QC task mutates a row another session is mid-write on | Writes only to `scheduled_tasks` rows with no in-flight run; skip-and-propose otherwise. TQC-06 |
| The QC task "fixes" something wrong and hides it | Every write emits a `task_qc_findings` audit row with before/after + rollback SQL, and is named in the digest email |
| The QC task recursively QCs itself | It excludes its own `task_type='task_qc'` rows from the audit set |

---

## 2. Current state (verified 2026-07-12)

- `scheduled_tasks`: `id, user_id, session_id NOT NULL, name, cron_expression, prompt, enabled,
  last_run_at, next_run_at, on_complete, created_at, updated_at` + additive
  `task_type, target_kind, target_id, payload, cron_expr, timezone, catchup_policy,
  macro_task_type, teab_*, email_summary` (see `hub/src/db/schema.sql`).
- **Nothing audits these rows.** A task that fails, skips forever, or never fires is invisible until
  the owner reads emails and notices.
- **A real misconfiguration exists today:** `log_check` rows whose `payload` lacks
  `application_uuid` finalize `no_application_uuid` on every run, forever, silently. (Memory:
  `project_logcheck_classifier_401_falsepos.md`.)
- Run history lives in `scheduled_task_runs` (status: `success | failed | skipped | skipped_quota`)
  and `routine_run_log` (orchestrator rows).

---

## 3. Requirements (falsifiable)

### TQC-01 — A recurring, bounded meta-task exists
- **Current:** no such task.
- **Target:** a new `task_type = 'task_qc'` scheduled task. One per user, at most one open run.
  Default cadence: daily. It reads `scheduled_tasks` + recent `scheduled_task_runs` and produces
  findings.
- **Acceptance:**
  - [ ] `task_type` CHECK constraint extended additively to include `'task_qc'` (idempotent DDL).
  - [ ] Test: a second `task_qc` run for the same user while one is in flight is dropped, logged.
  - [ ] Test: the QC audit set EXCLUDES `task_type='task_qc'` rows (no self-QC).

### TQC-02 — Six detectors, classification without writes
- **Current:** none.
- **Target:** `hub/src/task-qc/detectors.ts` — pure functions over rows, no writes:

| Detector | Fires when |
|---|---|
| `FAILING` | ≥ N consecutive `failed` runs (default N=3) |
| `SKIP_FOREVER` | ≥ N consecutive `skipped`/`skipped_quota` with the SAME reason, and ≥ 0 `success` in the window |
| `NEVER_FIRED` | `enabled=true` AND (`last_run_at IS NULL` for > 2 cadence intervals, OR `next_run_at` is NULL/in the past by > 2 intervals, OR the cron expression is unparseable) |
| `MISCONFIGURED` | a per-`task_type` payload schema check fails (e.g. `log_check` payload without `application_uuid`; `teab` without `teab_repo_ident`) |
| `DEAD_SESSION` | `session_id` references a session that is deleted, or has been offline for > 7d with no supervisor that could host it |
| `OPTIMIZE` | cadence far hotter than the observed work (e.g. runs every 5 min but ≥ 90% of runs finalize with no change), prompt length in the top decile, or two enabled tasks with an identical `(task_type, target, prompt)` triple |

- **Acceptance:**
  - [ ] Each detector has a unit test with a fixture row that fires it and one that does not.
  - [ ] `MISCONFIGURED` fires on the real observed case: a `log_check` row whose `payload` has no
        `application_uuid`.
  - [ ] Detectors are pure: a test asserts zero SQL writes during a full detector pass (spy on `sql`).
  - [ ] `SKIP_FOREVER` does NOT fire on a task whose skips are `no_errors_detected` (that is a clean
        no-op **by design**, per `project_logcheck_classifier_401_falsepos.md`) — it is on an explicit
        benign-reason ignore list.

### TQC-03 — Auto-fix ONLY from a literal allowlist
- **Current:** n/a.
- **Target:** `hub/src/task-qc/safe-fixes.ts` exports a frozen, enumerated `SAFE_FIXES` set. The
  writer accepts a fix **only** if `SAFE_FIXES.has(fix.kind)`; anything else throws. Initial set
  (owner-approvable, all reversible, all config-only):

  | Fix kind | Effect |
  |---|---|
  | `recompute_next_run_at` | recompute `next_run_at` from `cron_expr` + `timezone` for a NEVER_FIRED task with a valid cron |
  | `normalize_timezone` | set `timezone` to the user's profile tz when NULL/invalid |
  | `backfill_payload_from_sibling` | copy a missing `payload.application_uuid` from another enabled task on the SAME app/repo, only when EXACTLY ONE unambiguous sibling exists |
  | `rebind_dead_session` | repoint `session_id` to the user's live session bound to the SAME `repo_ident`, only when EXACTLY ONE such session exists |

- **Acceptance:**
  - [ ] Test: `applyFix({kind: 'disable_task'})` **throws** (`unlisted_fix_kind`) and writes nothing.
  - [ ] Test: `applyFix({kind: 'edit_prompt'})` throws. (Prompt content is never auto-edited — it is
        the thing that spends tokens.)
  - [ ] Test: `backfill_payload_from_sibling` with TWO candidate siblings ⇒ no write, emits a
        PROPOSAL instead.
  - [ ] Test: every applied fix writes a `task_qc_findings` row with `before_json`, `after_json`,
        `rollback_sql`.
  - [ ] `REMO_TASK_QC_AUTOFIX` default OFF ⇒ **zero writes**, everything becomes a proposal.

### TQC-04 — It NEVER auto-disables a deliberately-set task
- **Current:** n/a.
- **Target:** `disable_task` / `enabled=false` is not in `SAFE_FIXES` and the writer has no code path
  that can set `enabled`. A task the owner turned on stays on until the owner turns it off.
- **Acceptance:**
  - [ ] Static guard test: `grep` finds no `enabled` in any `UPDATE scheduled_tasks` inside
        `hub/src/task-qc/` — CI fails if one appears.
  - [ ] Test: a task with 500 consecutive failures is reported, proposed-for-disable in the email,
        and left `enabled=true` in the DB.

### TQC-05 — Everything else is an emailed PROPOSAL, never a write
- **Current:** n/a.
- **Target:** one digest email per QC run (via the existing E4A sender — send field is
  `from_inbox_id`, NOT `inbox_id`), listing: finding, evidence (run ids, reasons, counts), proposed
  fix, and the exact command/SQL the owner can run to apply it. Zero findings ⇒ **no email**.
- **Acceptance:**
  - [ ] Test: a run with only proposals sends exactly ONE email and performs zero `UPDATE`s.
  - [ ] Test: a run with zero findings sends zero emails (no daily noise).
  - [ ] Test: the email body names every finding and every applied auto-fix.

### TQC-06 — Never mutates a row with in-flight work
- **Current:** n/a.
- **Target:** before any write, the writer checks for an open `scheduled_task_runs` row
  (`ended_at IS NULL` / status `pending`) for that `task_id`, and for a live dispatch on its
  `session_id`. If either exists ⇒ skip the write, emit a proposal.
- **Acceptance:**
  - [ ] Test: task with an open run ⇒ zero writes, one proposal, reason `in_flight`.
  - [ ] Test: two concurrent QC runs cannot both write the same row (row-level `FOR UPDATE` or an
        advisory lock; single-replica assumption noted, same as `spawn-on-error.ts`).

### TQC-07 — Its own small, separate token ceiling; no dev loop
- **Current:** n/a.
- **Target:** the QC run dispatches through the shared pipeline with the standard gate chain PLUS a
  QC-specific ceiling `REMO_TASK_QC_TOKEN_CAP` (default 500,000 tokens/run). Its prompt is a
  DIAGNOSTIC prompt: read config + run history, emit findings JSON. It has no plan/build/PR macro,
  and it never enqueues one.
- **Acceptance:**
  - [ ] Test: the QC gate list includes `dailyTokenCapGate` (found by `token-cap-coverage.test.ts`)
        AND the QC-specific ceiling.
  - [ ] Test: a QC run exceeding the QC ceiling is halted with `over_task_qc_token_cap` — and the
        halt does NOT consume the user's whole daily budget.
  - [ ] Guard test: the QC prompt/macro contains none of the dev macro's build verbs and the QC
        module never imports `task-macros.ts`'s dev macro or `injectOrchestratorPrompt` with a build
        context.
  - [ ] Test: a QC run cannot enqueue another QC run (recursion guard — this is Phase 9's core
        invariant, asserted here too).

### TQC-08 — Flag-gated; OFF is a true no-op
- **Target:** `REMO_TASK_QC_ENABLED` default **OFF**. When OFF, no task is created, nothing scans,
  nothing emails.
- **Acceptance:**
  - [ ] Test: flag unset ⇒ zero DB reads from the QC module, zero emails, no scheduler registration.

---

## 4. Env knobs

| Knob | Default | Disabled semantics |
|---|---|---|
| `REMO_TASK_QC_ENABLED` | `0` (OFF) | OFF ⇒ nothing runs; true no-op |
| `REMO_TASK_QC_AUTOFIX` | `0` (OFF) | OFF ⇒ **report-only**: every finding is a proposal, zero writes |
| `REMO_TASK_QC_TOKEN_CAP` | `500000` | non-positive / non-finite ⇒ ceiling disabled (fail-open) — **but the daily token cap still applies** |
| `REMO_TASK_QC_FAIL_STREAK` | `3` | non-positive ⇒ default (never 0 — a 0-streak would flag everything) |
| `REMO_TASK_QC_CADENCE_CRON` | `0 9 * * *` (daily 09:00 user tz) | — |

Recommended arming order: `ENABLED=1` with `AUTOFIX=0` for ≥ 1 week (report-only soak; the owner
reads the digests and confirms the detectors do not lie), THEN `AUTOFIX=1`.

---

## 5. DDL

`schema.sql` **re-runs in full every hub boot** ⇒ idempotent, additive DDL only. Backfills →
`hub/scripts/` one-shots. **No `UPDATE`/`DELETE` in `schema.sql`.**

```sql
-- additive: new task_type value (the existing CHECK is rebuilt idempotently the
-- same way the Phase-11 workflow types were added — see schema.sql precedent).
-- 'task_qc' joins the existing enum; no existing row changes value.

CREATE TABLE IF NOT EXISTS task_qc_findings (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id       TEXT,                     -- the task_qc run that produced it
  task_id      TEXT NOT NULL,            -- the audited task (no FK: task may be deleted)
  detector     TEXT NOT NULL,            -- FAILING | SKIP_FOREVER | NEVER_FIRED | MISCONFIGURED | DEAD_SESSION | OPTIMIZE
  severity     TEXT NOT NULL DEFAULT 'info',
  disposition  TEXT NOT NULL,            -- auto_fixed | proposed | skipped_in_flight
  fix_kind     TEXT,                     -- non-null only when disposition='auto_fixed'
  before_json  JSONB,
  after_json   JSONB,
  rollback_sql TEXT,
  evidence     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_qc_findings_user ON task_qc_findings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_qc_findings_task ON task_qc_findings(task_id, created_at DESC);
```

*Uncertain:* the exact idempotent form for extending the `task_type` CHECK constraint. `schema.sql`
already does this (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ... CHECK (...)` plus a later drop/add of
the constraint) and there is a `schema-lint` CI fence on mutating statements. The plan must copy the
existing Phase-11 pattern exactly rather than invent one — I have not read that lint's full rule set.

---

## 6. Tests that prove the requirements

| Test file | Proves |
|---|---|
| `hub/test/task-qc-detectors.test.ts` | TQC-02 (six detectors, fixtures incl. the real `log_check` payload case; benign-reason ignore list) |
| `hub/test/task-qc-safe-fixes.test.ts` | TQC-03 (unlisted fix throws; ambiguous sibling ⇒ proposal; audit row written) |
| `hub/test/task-qc-never-disables.test.ts` | TQC-04 (static grep guard + 500-failure fixture stays enabled) |
| `hub/test/task-qc-proposals.test.ts` | TQC-05 (one email, zero writes; zero findings ⇒ zero emails) |
| `hub/test/task-qc-in-flight.test.ts` | TQC-06 (open run ⇒ skip-and-propose) |
| `hub/test/task-qc-budget.test.ts` | TQC-07 (QC ceiling; no dev macro import; cannot enqueue a QC run) |
| `hub/test/task-qc-flag-off.test.ts` | TQC-08 (OFF = no-op) |
| `hub/test/e2e/task-qc.test.ts` (real Postgres) | End-to-end: seeded broken tasks ⇒ correct findings, correct writes under `AUTOFIX=1`, zero writes under `AUTOFIX=0` |

---

## 7. In scope

- A recurring `task_qc` task type + its diagnostic macro prompt.
- Six pure detectors over `scheduled_tasks` + `scheduled_task_runs`.
- A frozen safe-fix allowlist + an auditing writer (`task_qc_findings` with rollback SQL).
- A digest proposal email for everything not auto-fixed.
- Optimization *proposals* (cadence, prompt cost, redundant tasks).
- Its own separate, small token ceiling.

**Reasoning:** the value is a machine noticing what a human will not — a task that has been silently
skipping for six weeks. The risk is that same machine editing things. Detection is where the value
is; the allowlist keeps the writing boring.

## 8. Out of scope

- **Auto-disabling any task.** Ever. TQC-04. The owner enables tasks deliberately; a machine
  disabling one is a silent loss of function, and the machine cannot know intent.
- **Auto-editing task prompts.** The prompt is the thing that spends tokens; an AI rewriting the
  prompt that governs an AI's spending is the recursion we are trying to kill.
- **Auto-changing cadence.** Proposed only. A cadence change silently multiplies spend.
- **Creating or deleting tasks.** Config repair only.
- **Any dev/build/PR work.** QC diagnoses config. If the fix requires code, it emits a proposal; a
  human (or a Phase-7 heal) does the code.
- **Touching another session's in-flight work.** TQC-06.
- **Changing cap values or gate semantics.** Phases 1–4 own those.
- **A UI.** The digest email is the surface for this milestone; the receipts page is Milestone GOV.

**Reasoning:** every excluded capability is one where a wrong decision is (a) silent and (b)
expensive. The allowlist is small on purpose: it can be grown later, from evidence, once the owner
has read a month of report-only digests.
