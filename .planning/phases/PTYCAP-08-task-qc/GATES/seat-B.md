# Seat B - safety / blast-radius lens

Basis: 08-FORKS.md, 08-SPEC TQC-03/04/06/07, 08-CONTEXT D-01..D-25, hub/src/scheduler/dispatcher.ts (fireTask kill-switch pre-gate at ~236-248, routeToSender ~679-734, sender dir has agent/coolify/supervisor/teab/triage/work only), db/scheduled-tasks-dal.ts:17-26 (TaskType union), 09-SPEC AR-1 / CQ-04 / CQ-05 (origin='task_qc' => notify-only, fix kinds are pure code).

## FORK-1: VERDICT ACCEPT-WITH-AMENDMENT -> Option A (deterministic, no model)

Evidence:
- Option A makes SC3 (no dev loop, no in-flight mutation, no auto-disable) structurally true: the sender never imports dispatch()/injectOrchestratorPrompt/task-macros. Option B/C make the model's output select which row is rewritten (task prompts and error strings are attacker-influenced data; fenceUntrusted only reduces, does not remove, that surface).
- 09-SPEC CQ-05 reuses fix kinds that are pure code, and AR-1 requires a hard non-recursive return keyed on a server-inferred origin. A zero-model engine cannot spawn a QC run, so recursion is impossible by construction; with a model it is a policy.
- sender list shows no existing hub-side non-dispatch sender precedent for writes (coolify.ts is read-ish) - so the new sender is the first one that writes scheduled_tasks; that raises the bar on the guard tests, not the model question.

Amendments:
1. Export the engine as a pure entry `runTaskQcPass({userId, scope?: {taskIds, detectors}, origin})` taking NO dispatch/send dependency, so Phase 9 calls the same function. Scope param must only NARROW (task ids / detector kinds); it can never widen the allowlist.
2. Engine has no import path to the Phase-9 cap-QC enqueue; Phase 9 imports Phase 8, never the reverse (module-graph guard both directions).
3. Supersession of TQC-07 (500K ceiling) must be written into 08-SPEC and 09-SPEC inherited-knob table in the same PR, plus a hard per-run cap on rows written (e.g. max 25 auto-fixes/run, excess => proposals) as the replacement bound, since the token ceiling no longer limits blast radius.
4. Digest/email text must be built only from typed fields, not interpolating raw run `error`/prompt text unescaped (injection into mail).

## FORK-2: VERDICT ACCEPT-WITH-AMENDMENT -> Option A (scheduled_tasks row)

Evidence:
- fireTask runs isAutomationHalted BEFORE every task_type branch (dispatcher.ts ~236-248), so the kill switch covers QC for free; Option B would need a re-implemented pre-gate and a setInterval poller (rule 23, restart double-fire).
- TaskType union (scheduled-tasks-dal.ts:17-26) is already extended per feature (teab, work); mechanical.

Amendments (blast-radius risks introduced by the row model):
1. `session_id` is NOT NULL with ON DELETE CASCADE (schema.sql ~158): the seeded task_qc row must bind to a stable session or deleting that session silently deletes the auditor. Choose/define the anchor (orchestrator/rootless session) and add a boot-seed check that re-seeds if missing; D-20 engine-failure email must cover "row vanished".
2. Halt scope: taskSessionId(task) feeds the per-session kill switch, so QC would be silenced by a session-scoped halt on its anchor session. Acceptable (fails closed) but tests must pin it: user-scope halt => read-only run, session-scope halt on anchor => skipped, not written.
3. fireTask spend pre-gates (cost/token caps) run before the branch; a zero-token QC task could be skipped by an exhausted daily cap, hiding failures exactly when cap-hit QC (Phase 9) matters. Exempt task_qc from spend pre-gates or record `skipped` with a benign, non-SKIP_FOREVER-flaggable reason (D-23 already covers halted/lifetime reasons; add cost/token cap reasons).
4. API: reject user create/edit/delete-of-payload for task_qc (D-25) AND reject user-initiated `enabled` flips by chain_task/Run Now from setting unexpected cron; floor cadence 60 min. Owner disable stays honoured (inert).
5. Enum sync test across the four places (schema CHECK, DAL union, zod, auto-name) is mandatory, not optional.

Cross-cutting safety pins to keep verbatim: static grep guard (no `enabled` in UPDATE scheduled_tasks under hub/src/task-qc/), FOR UPDATE + in-flight re-check inside the same tx as the write and findings insert, AUTOFIX default OFF with ENABLED prerequisite, lifetime counter reserved before the first write.
