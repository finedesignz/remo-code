---
phase: 06-self-heal-absorb
plan: 003
type: execute
wave: 2
depends_on: [06-PLAN-002-log-classifier]
files_modified:
  - hub/src/scheduler/senders/coolify.ts
  - hub/src/db/scheduled-tasks-dal.ts
  - hub/test/coolify-sender-classifier.test.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "log_check runs with no detected errors skip post-run actions"
    - "Runs with detected errors continue to post-run dispatch unchanged"
    - "Skipped-clean runs finalize with status=success and a marker output_snippet"
  artifacts:
    - path: "hub/src/scheduler/senders/coolify.ts"
      provides: "log_check sender with classifier gate before finalize"
  key_links:
    - from: "senders/coolify.ts"
      to: "log-classifier.ts"
      via: "classifyLog() call after fetchLogs"
---

<objective>
Wire `classifyLog` into the `log_check` sender so clean log fetches finalize without triggering post-run actions. Preserve all existing behavior (cost capture, snippet truncation, HTTP error paths).

Purpose: Implements the cost-cap gate from CONTEXT.md §"Regex pre-filter (G3)".
Output: Updated `senders/coolify.ts`; integration test asserting skip-on-clean.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@hub/src/scheduler/senders/coolify.ts
@hub/src/scheduler/log-classifier.ts
@hub/src/scheduler/dispatcher.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add suppress-post-run hook to finalizeRun + wire classifier in coolify sender</name>
  <files>hub/src/scheduler/senders/coolify.ts, hub/src/db/scheduled-tasks-dal.ts</files>
  <read_first>
    - hub/src/scheduler/senders/coolify.ts (full)
    - hub/src/scheduler/dispatcher.ts (`finalizeRun` signature and how it triggers afterRun)
    - hub/src/scheduler/post-run/dispatcher.ts (`afterRun` entry point — we want to skip it for clean runs)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"Regex pre-filter (G3)" — "skips post-run actions entirely"
  </read_first>
  <action>In `hub/src/scheduler/dispatcher.ts` extend the `finalizeRun` options object to accept an optional `skip_post_run?: boolean` flag. When `skip_post_run === true`, the function still updates the run row to `success`/`failed` but MUST NOT invoke `afterRun` from `post-run/dispatcher.ts`. Do not change any other `finalizeRun` call sites. In `hub/src/scheduler/senders/coolify.ts`: after the successful `await res.text()` and snippet computation, before the success `finalizeRun` call, import `classifyLog` from `../log-classifier.ts` and call `const cls = classifyLog(snippet)`. If `cls.hasErrors === false` AND `res.ok`, call `finalizeRun(ctx.runId, 'success', null, { duration_ms: ..., output_snippet: '[no errors detected]', skip_post_run: true })` and return. If `cls.hasErrors === true` keep the existing success path (post-run actions fire normally) and additionally prefix the output_snippet with a one-line summary header `[errors detected: N matches, max severity=high|med]\n` followed by the original snippet, truncated to MAX_SNIPPET (4000). HTTP failure path and timeout path are unchanged. Update `RunCtxLike` / `FinalizeOptions` types in scheduled-tasks-dal.ts only if needed to expose `skip_post_run` cleanly — otherwise keep the new flag local to dispatcher.ts.</action>
  <verify>
    <automated>cd hub ; bun test test/coolify-sender-classifier.test.ts</automated>
  </verify>
  <done>Clean logs → run row status=success, output_snippet='[no errors detected]', afterRun NOT called. Logs with `ECONNREFUSED` → run status=success, snippet has `[errors detected: ...]` prefix, afterRun called.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Integration test for classifier gate</name>
  <files>hub/test/coolify-sender-classifier.test.ts</files>
  <read_first>
    - hub/test/scheduled-tasks.e2e.test.ts (DB-gating + skip-on-no-DB pattern via REMO_E2E_DB_URL)
    - hub/src/scheduler/senders/coolify.ts (updated in task 1)
  </read_first>
  <behavior>
    - Mock `fetch` (or use a local HTTP server) to return clean log text → assert run finalizes success, post-run dispatcher NOT invoked, snippet === '[no errors detected]'.
    - Mock `fetch` returning text containing `TypeError: x is not a function` → assert run finalizes success, snippet starts with `[errors detected:`, post-run dispatcher IS invoked.
    - Mock `fetch` returning HTTP 502 → assert run finalizes failed (existing path), no classifier interference.
  </behavior>
  <action>Create `hub/test/coolify-sender-classifier.test.ts` using `bun:test`. Stub `globalThis.fetch` per case (save/restore in beforeEach/afterEach). Stub the post-run dispatcher by spying on `afterRun` (re-export or monkey-patch the imported module). Skip the file if `REMO_E2E_DB_URL` is not set (matches the project's existing e2e pattern). Insert a minimal user + scheduled_task fixture before each case; clean up in afterAll.</action>
  <verify>
    <automated>cd hub ; REMO_E2E_DB_URL=$REMO_E2E_DB_URL bun test test/coolify-sender-classifier.test.ts</automated>
  </verify>
  <done>All three cases green when REMO_E2E_DB_URL is set; file skips cleanly when unset.</done>
</task>

</tasks>

<verification>
- `bun test hub/test/coolify-sender-classifier.test.ts` green.
- Manual: trigger a `log_check` task against an app with clean logs → confirm no post-run email/webhook fires.
</verification>

<success_criteria>
- Clean logs skip post-run actions; cost cap untouched.
- Error logs preserve existing post-run behavior.
- HTTP failure paths unchanged.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-003-SUMMARY.md` when done.
</output>
