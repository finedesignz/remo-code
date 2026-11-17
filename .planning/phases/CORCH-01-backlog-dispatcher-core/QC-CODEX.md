# QC-CODEX: CORCH-01 vs origin/main

seat: codex
model: OpenAI Codex v0.157.0, model gpt-6-astra (read-only reviewer run with bypass flag, no edits)
reviewed: origin/main..HEAD at 87ee8ecb4cdd0e58dbe0bfd7396d6e8182991bb0
END-OF-REVIEW present: yes
infra check: HEAD unchanged (87ee8ec...), only pre-existing untracked .planning files; codex changed nothing.

VERDICT: CONTENT BLOCK

1. **HIGH - Reclaimed runs can still send stale prompts.** hub/src/corch/dispatcher.ts:377
   Reclaim releases only active pipeline hooks; offline grace callbacks and queued waiters survive. Replay calls `dispatch()` again, while `runContext()` accepts ended runs and `markDispatched` ignores a failed `markRunRunning()`. An in-memory check confirmed all three CORCH gates accept an ended run. This permits untracked sends and overlapping retries. Fix: reject ended runs before replay and immediately before sending; invalidate pending callbacks when reclaiming.

2. **HIGH - Partial inventory is incorrectly treated as proof of absence.** hub/src/corch/reconciler.ts:37
   When `supervisor_id` is null, `forUser()` declares knowledge fresh if any supervisor has fresh inventory. After a crash between launch and `markRunLaunched`, supervisor A's inventory can reclaim a session still running on supervisor B whose inventory is unavailable. That allows a duplicate launch. Fix: require authoritative knowledge of the hosting supervisor; incomplete inventory must remain unknown.

3. **MED - Concurrent timer rearming can lose the only wakeup.** hub/src/corch/dispatcher.ts:514
   Queries finish independently, and every completion clears the current timer. Reproduced: a newer query installs a retry deadline, then an older query returns null and cancels it, leaving zero timers. The reconciler does not evaluate queued work. Fix: serialize/coalesce rearming or discard stale query results using a generation counter.

4. **MED - Stalled runs permanently starve reconciliation beyond the first 100.** hub/src/corch/store.ts:402
   Each pass selects the oldest 100 heartbeats. `markStalled()` never changes their ordering, so 100 runs with unknown inventory monopolize every subsequent pass. Later runs receive no heartbeat, reclaim, or notification processing. Fix: bounded pagination or a separate reconciliation cursor/timestamp without fabricating liveness.

5. **MED - Busy dispatches bypass bounded attempts and backoff.** hub/src/corch/dispatcher.ts:351
   The real pipeline invokes `markSkipped(token, 'session_busy')` before returning `dropped_busy`. CORCH first ends the run as a refusal with no attempt or deadline; the subsequent attempt-consuming transition becomes an idempotent no-op. Reproduced this callback ordering. The existing test only fakes the returned outcome. Fix: classify `session_busy` consistently with `dropped_busy`, and test the actual callback-before-return sequence.

6. **MED - Boot does not evaluate already-due backlog.** hub/src/corch/reconciler.ts:74
   Startup only arms a timer, whose query excludes deadlines already past. Work whose backoff expired during downtime receives no boot evaluation and depends on an unrelated later event. Fix: flag-guarded boot evaluation of due work, then arm the next future deadline.

Codex notes: focused unit tests 59 passed. No files changed; DB-mutating verification not run.

END-OF-REVIEW
