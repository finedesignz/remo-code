---
phase: 06-self-heal-absorb
plan: 006
type: execute
wave: 3
depends_on: [06-PLAN-002-log-classifier, 06-PLAN-004-coolify-webhook-route]
files_modified:
  - hub/src/scheduler/triage-prompt.ts
  - hub/src/scheduler/triage-schema.ts
  - hub/src/db/scheduled-tasks-dal.ts
  - hub/test/triage-schema.test.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "task_kind 'triage' is recognized by the scheduler type union"
    - "Triage prompt template injects deployment metadata + log snippet"
    - "TriageResult JSON shape is Zod-validated; malformed → run failed with reason 'triage_parse_error'"
  artifacts:
    - path: "hub/src/scheduler/triage-prompt.ts"
      provides: "renderTriagePrompt(payload) → string"
      exports: ["renderTriagePrompt"]
    - path: "hub/src/scheduler/triage-schema.ts"
      provides: "TriageResult Zod schema + parseTriageOutput helper"
      exports: ["TriageResult", "parseTriageOutput"]
  key_links:
    - from: "triage-schema.parseTriageOutput"
      to: "scheduler dispatcher run finalization (plan 008 wire-up)"
      via: "validated JSON stored in output_snippet"
---

<objective>
Define the triage prompt template, the structured-output JSON schema, and the parse/validate helper. Add `'triage'` to the task_kind type union. Wiring into webhook dispatch + dispatcher routing lives in plan 008.

Purpose: G6 absorption (structured analysis schema).
Output: prompt template + schema + parser + tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@hub/src/db/scheduled-tasks-dal.ts
@C:/Users/artic/GitHub/coolify-ai-monitor/src/index.js
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: TriageResult schema + parser</name>
  <files>hub/src/scheduler/triage-schema.ts, hub/test/triage-schema.test.ts</files>
  <read_first>
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"Triage schema (G6)" — exact field shape
    - hub/src/scheduler/post-run/schema.ts (existing Zod patterns in this codebase)
  </read_first>
  <behavior>
    - Valid JSON with all required fields → `{ ok: true, value: TriageResult }`
    - Missing `root_cause` → `{ ok: false, error: 'triage_parse_error', detail: '...' }`
    - `severity` outside enum → ok: false
    - `confidence` outside [0,1] → ok: false
    - Bare prose (not JSON) → ok: false
    - JSON wrapped in ```json fences → parser strips fences then validates ok
    - `affected_files` optional array of strings is accepted when present, omitted when not
  </behavior>
  <action>Create `hub/src/scheduler/triage-schema.ts` exporting: `TriageResult` Zod schema matching CONTEXT.md §"Triage schema" exactly — `error_type: z.string().min(1)`, `severity: z.enum(['low','medium','high','critical'])`, `root_cause: z.string().min(1)`, `suggested_fix: z.string().min(1)`, `confidence: z.number().min(0).max(1)`, `affected_files: z.array(z.string()).optional()`. Export `type TriageResult = z.infer<typeof TriageResult>`. Export `function parseTriageOutput(raw: string): { ok: true; value: TriageResult } | { ok: false; error: 'triage_parse_error'; detail: string }`. Implementation: trim, strip leading/trailing ```json ... ``` fence if present (regex), JSON.parse with try/catch (catch → ok:false), then TriageResult.safeParse. Create matching test file using `bun:test`.</action>
  <verify>
    <automated>cd hub ; bun test test/triage-schema.test.ts</automated>
  </verify>
  <done>All seven behaviors green.</done>
</task>

<task type="auto">
  <name>Task 2: Triage prompt template</name>
  <files>hub/src/scheduler/triage-prompt.ts</files>
  <read_first>
    - C:/Users/artic/GitHub/coolify-ai-monitor/src/index.js (lines 93-110 — original prompt shape for tone/fields, reference only)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"Triage schema (G6)" + specifics §"Triage prompt shape"
    - hub/src/scheduler/triage-schema.ts (from task 1 — keep field names in sync)
  </read_first>
  <action>Create `hub/src/scheduler/triage-prompt.ts` exporting `function renderTriagePrompt(input: { application_uuid: string; deployment_uuid: string; git_repository?: string; commit_sha?: string; log_snippet: string }): string`. The returned string MUST: (a) instruct Claude that it is a deployment triage assistant; (b) list the deployment context fields verbatim; (c) include the last 100 lines of `log_snippet` inside a fenced block; (d) demand a single JSON object response matching the TriageResult schema with field names exactly: `error_type`, `severity` (one of `low|medium|high|critical`), `root_cause`, `suggested_fix`, `confidence` (0..1), optional `affected_files` (array of repo-relative paths); (e) explicitly forbid markdown, prose, or fences around the JSON. Cap log_snippet to the last 100 newline-delimited lines via `split(/\r?\n/).slice(-100).join('\n')`. No DB calls, no side effects.</action>
  <verify>
    <automated>cd hub ; bun run -e "import('./src/scheduler/triage-prompt.ts').then(m => { const s = m.renderTriagePrompt({ application_uuid: 'a', deployment_uuid: 'd', log_snippet: 'line\\nline' }); if (!s.includes('error_type') || !s.includes('severity')) process.exit(1); console.log('ok') })"</automated>
  </verify>
  <done>renderTriagePrompt returns a string mentioning all five required JSON field names and the deployment context.</done>
</task>

<task type="auto">
  <name>Task 3: Extend task_kind type union to include 'triage'</name>
  <files>hub/src/db/scheduled-tasks-dal.ts</files>
  <read_first>
    - hub/src/db/scheduled-tasks-dal.ts (find the `task_kind` / `ScheduledTask` type union — search for `task_kind` or `'log_check'`)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"Triage schema" — "task_kind: 'triage' on scheduled_tasks (existing column accepts a string; add to type union)"
  </read_first>
  <action>In `hub/src/db/scheduled-tasks-dal.ts` locate the TypeScript type union for `task_kind` (e.g. `'prompt' | 'skill' | 'supervisor_command' | 'log_check'`) and add `| 'triage'`. If a runtime list/enum exists for validation in the API layer, add `'triage'` there too. Do NOT change the DB column type (it is already plain TEXT). Do not add CHECK constraints — keep the column open per existing project convention.</action>
  <verify>
    <automated>cd hub ; bun run tsc --noEmit 2>&1 | head -50</automated>
  </verify>
  <done>TypeScript compiles. `grep -n "'triage'" hub/src/db/scheduled-tasks-dal.ts` shows the new union member.</done>
</task>

</tasks>

<verification>
- `bun test hub/test/triage-schema.test.ts` green.
- `tsc --noEmit` green (no type errors from the new union member).
</verification>

<success_criteria>
- Schema + parser handle valid, fenced, and malformed inputs correctly.
- Prompt template names every required JSON field.
- Type union recognizes `'triage'`.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-006-SUMMARY.md` when done.
</output>
