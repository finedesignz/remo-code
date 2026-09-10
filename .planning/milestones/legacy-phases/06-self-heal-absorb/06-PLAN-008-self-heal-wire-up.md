---
phase: 06-self-heal-absorb
plan: 008
type: execute
wave: 4
depends_on:
  - 06-PLAN-004-coolify-webhook-route
  - 06-PLAN-006-triage-task-kind
  - 06-PLAN-007-github-issue-post-run-action
external_depends_on:
  - 04-PLAN-008-self-heal-routing  # Phase 04 plan 008 — MUST be merged before executing this plan
files_modified:
  - hub/src/api/coolify-webhook.ts
  - hub/src/scheduler/dispatcher.ts
  - hub/src/scheduler/senders/triage.ts
  - hub/test/coolify-webhook-triage-e2e.test.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "deployment.failed webhook → triage run is dispatched through scheduler.enforceCostCap"
    - "Triage run resolves a target via pickSessionTarget from Phase 04 plan 008"
    - "Triage prompt is sent to the chosen session via POST /api/sessions/heal-equivalent path"
    - "Run output_snippet stores the validated TriageResult JSON; malformed → status=failed reason='triage_parse_error'"
    - "Daily cost cap still applies; cap-exceeded webhook events finalize with error='daily_cost_cap'"
  artifacts:
    - path: "hub/src/scheduler/senders/triage.ts"
      provides: "sendTriage(task, ctx, payload) — invokes pickSessionTarget + creates a child session"
  key_links:
    - from: "POST /api/coolify/webhook"
      to: "scheduler dispatcher (triage task)"
      via: "replace dispatchTriageStub with real fireTriage()"
    - from: "sendTriage"
      to: "Phase 04 plan 008 pickSessionTarget + /api/sessions/heal flow"
      via: "in-process call (not HTTP) to hub/src/sessions/routing.ts::pickSessionTarget"
---

<objective>
Replace the `dispatchTriageStub` stub from plan 004 with a real dispatch path: webhook → scheduler dispatcher → cost-cap gate → `pickSessionTarget` → create child session with the rendered triage prompt → on completion, parse TriageResult and finalize. Post-run actions (including `github_issue`) then fire normally per existing pipeline.

**HARD GATE:** This plan MUST NOT be executed until `04-PLAN-008-self-heal-routing` is merged to main. If `hub/src/sessions/routing.ts` does not exist, abort.

Purpose: Closes the loop — webhook absorbs the coolify-ai-monitor role end-to-end.
Output: New `senders/triage.ts`, updated dispatcher routing, replaced stub, e2e test.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@hub/src/scheduler/dispatcher.ts
@hub/src/scheduler/senders/coolify.ts
@hub/src/scheduler/triage-prompt.ts
@hub/src/scheduler/triage-schema.ts
@hub/src/api/coolify-webhook.ts
@.planning/phases/04-coolify-dev-supervisor/04-PLAN-008-self-heal-routing.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Hard-gate precheck — verify Phase 04 plan 008 is merged</name>
  <files>(none — gate task)</files>
  <read_first>
    - hub/src/sessions/routing.ts (if missing → abort plan)
    - hub/src/api/sessions.ts (must contain `/api/sessions/heal` handler)
  </read_first>
  <action>Run `test -f hub/src/sessions/routing.ts` and `grep -n "pickSessionTarget" hub/src/sessions/routing.ts`. If the file is missing OR the function is not exported, STOP and report `phase_04_plan_008_not_merged` — do not proceed with the remaining tasks. If present, continue.</action>
  <verify>
    <automated>test -f hub/src/sessions/routing.ts && grep -q "export.*pickSessionTarget" hub/src/sessions/routing.ts</automated>
  </verify>
  <done>Precheck passes — file exists and exports the routing primitive.</done>
</task>

<task type="auto">
  <name>Task 2: Implement senders/triage.ts — pickSessionTarget + prompt dispatch</name>
  <files>hub/src/scheduler/senders/triage.ts</files>
  <read_first>
    - hub/src/sessions/routing.ts (`pickSessionTarget` signature + return shape)
    - hub/src/api/sessions.ts (how `/api/sessions/heal` dispatches `create_child_session` WS message to supervisor / equivalent to local agent — copy the in-process call surface, do NOT round-trip via HTTP)
    - hub/src/scheduler/dispatcher.ts (`finalizeRun` signature + `trackRun`/`getRunContext`)
    - hub/src/scheduler/triage-prompt.ts (renderTriagePrompt)
    - hub/src/scheduler/triage-schema.ts (parseTriageOutput)
  </read_first>
  <action>Create `hub/src/scheduler/senders/triage.ts` exporting `async function sendTriage(task: ScheduledTask, ctx: { runId: string; taskId: string; userId: string }, payload: { application_uuid: string; deployment_uuid: string; git_repository?: string; commit_sha?: string; log_snippet: string }): Promise<void>`. Flow: (1) call `pickSessionTarget(ctx.userId)`; if `kind === 'none'` → `finalizeRun(ctx.runId, 'failed', 'no_target_available')` and return; (2) render prompt with `renderTriagePrompt(payload)`; (3) dispatch the prompt via the same in-process call surface `/api/sessions/heal` uses internally (re-export it as `dispatchHeal({ userId, target, prompt, runId })` from `hub/src/sessions/routing.ts` if not already exported; otherwise call the existing helper directly); (4) the session-completion path must call back into the scheduler — register the runId with `trackRun` and a callback that on `assistant_message` (final turn) invokes `parseTriageOutput(text)` → if ok: `finalizeRun(runId, 'success', null, { output_snippet: JSON.stringify(result.value) })`; if not ok: `finalizeRun(runId, 'failed', 'triage_parse_error', { output_snippet: text.slice(0, 4000) })`. If the Phase 04 plan 008 helper does not yet expose a completion callback hook, document the gap and use a polling fallback that reads the latest assistant message from the `messages` table for the spawned `session_id` (LIMIT 1 by created_at DESC, role='assistant', status='complete') every 5s up to 5 minutes; on timeout `finalizeRun(runId, 'failed', 'triage_timeout')`.</action>
  <verify>
    <automated>cd hub ; bun run tsc --noEmit</automated>
  </verify>
  <done>sendTriage compiles, calls pickSessionTarget, dispatches a prompt, finalizes the run with TriageResult JSON or a clear error reason.</done>
</task>

<task type="auto">
  <name>Task 3: Route 'triage' task_kind through dispatcher + replace webhook stub</name>
  <files>hub/src/scheduler/dispatcher.ts, hub/src/api/coolify-webhook.ts</files>
  <read_first>
    - hub/src/scheduler/dispatcher.ts (find where task_kind switches into senders — `log_check` → senders/coolify, `prompt`/`skill` → agent, etc.)
    - hub/src/api/coolify-webhook.ts (from plan 004 — has `dispatchTriageStub`)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"Webhook ingress" + §"Triage schema"
  </read_first>
  <action>In `hub/src/scheduler/dispatcher.ts` extend the task_kind routing switch to add `case 'triage': await sendTriage(task, ctx, task.payload as TriagePayload); return;`. The cost-cap check (`isOverCostCap`) MUST run BEFORE this case the same way it runs for all other kinds — do not bypass it. In `hub/src/api/coolify-webhook.ts` replace the body of `dispatchTriageStub` with the real path: ensure an internal triage task exists for this user (lazy-create via DAL helper `ensureInternalTriageTask(userId): Promise<string>` — a row with `task_kind='triage'`, `enabled=false` (so the cron does not auto-fire), `name='__internal_triage'`); insert/update the existing pending run (already created on `deployment.failed`) to set `task_id` to that internal task id; then call `dispatcher.runNow(taskId, userId, { triggeredByRunId: null, chainDepth: 0 })` with the payload populated from the webhook event (`application_uuid`, `deployment_uuid`, `git_repository`, `commit_sha`, `log_snippet` from a fresh `senders/coolify.fetchLogs`-equivalent call OR an empty string with a note that the LLM should infer from metadata if log fetch fails). Cost-cap-exceeded → run finalizes with `error='daily_cost_cap'` per existing semantics — post-run actions with `on='cost_exceeded'` still fire.</action>
  <verify>
    <automated>cd hub ; bun run tsc --noEmit ; bun test test/coolify-webhook-triage-e2e.test.ts</automated>
  </verify>
  <done>Dispatcher routes triage tasks; webhook stub replaced; cost-cap path intact.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: End-to-end test — webhook → triage run → GitHub issue</name>
  <files>hub/test/coolify-webhook-triage-e2e.test.ts</files>
  <read_first>
    - hub/test/coolify-webhook.test.ts (plan 004 — auth fixture)
    - hub/test/post-run-github-issue.test.ts (plan 007 — Octokit stub)
    - hub/src/sessions/routing.ts (mock pickSessionTarget to return a deterministic local_agent target)
  </read_first>
  <behavior>
    - Fire a valid HMAC-signed `deployment.failed` webhook → assert a `scheduled_task_runs` row exists with `task_kind` of an internal triage task and `status` ∈ {pending, running}.
    - Stub the session dispatch to immediately "complete" the run with a valid TriageResult JSON → assert the run row's final `output_snippet` parses as a TriageResult and `status='success'`.
    - With a `github_issue` post-run action configured on the internal triage task, assert the Octokit issues.create stub is invoked once with severity-derived label.
    - Cost cap exceeded before fire → run finalizes with `error='daily_cost_cap'`, no session dispatch attempted.
    - Malformed assistant response → `status='failed'`, `error='triage_parse_error'`.
  </behavior>
  <action>Create `hub/test/coolify-webhook-triage-e2e.test.ts` (`bun:test`, skip on missing `REMO_E2E_DB_URL`). Mock `pickSessionTarget` and the session dispatch helper from `hub/src/sessions/routing.ts` via module monkey-patch. Mock `fetch` for the gateway-credentials + Octokit calls. Drive the flow by POSTing to the in-test Hono app at `/api/coolify/webhook/:userId` with a hand-signed body. Clean up rows + monkey-patches in afterAll.</action>
  <verify>
    <automated>cd hub ; REMO_E2E_DB_URL=$REMO_E2E_DB_URL bun test test/coolify-webhook-triage-e2e.test.ts</automated>
  </verify>
  <done>All five behaviors green.</done>
</task>

</tasks>

<verification>
- Precheck file/grep returns true (Phase 04 plan 008 merged).
- e2e test green.
- `grep -n "dispatchTriageStub" hub/src` returns no remaining stub body (only the rebound export, if kept for tests).
</verification>

<success_criteria>
- Full webhook → session-dispatch → TriageResult → GitHub-issue chain works end-to-end.
- Cost cap honored.
- Parse errors surface cleanly as `triage_parse_error`.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-008-SUMMARY.md` when done.
</output>
