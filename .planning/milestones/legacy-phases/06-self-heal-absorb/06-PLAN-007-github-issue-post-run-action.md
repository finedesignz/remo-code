---
phase: 06-self-heal-absorb
plan: 007
type: execute
wave: 3
depends_on: [06-PLAN-006-triage-task-kind]
files_modified:
  - hub/src/scheduler/post-run/github-issue.ts
  - hub/src/scheduler/post-run/schema.ts
  - hub/src/scheduler/post-run/dispatcher.ts
  - hub/src/db/dal.ts
  - hub/test/post-run-github-issue.test.ts
  - package.json
autonomous: true
requirements: []

must_haves:
  truths:
    - "post_run_actions accepts a new {type:'github_issue', config:{repo_full_name, labels?, assignees?}} entry"
    - "Action creates a GitHub issue via gateway-loaded creds with severity-derived labels"
    - "Same (repo, application_uuid, deployment_uuid) within 24h does not double-post"
  artifacts:
    - path: "hub/src/scheduler/post-run/github-issue.ts"
      provides: "executeGithubIssue() post-run action handler"
      exports: ["executeGithubIssue"]
  key_links:
    - from: "post-run/dispatcher.ts"
      to: "post-run/github-issue.ts"
      via: "switch case 'github_issue'"
    - from: "github-issue.ts"
      to: "gateway pair (loadCredentials('github'))"
      via: "GATEWAY_URL/GATEWAY_API_KEY — never an env GITHUB_TOKEN"
---

<objective>
Add `github_issue` as a new post-run action type alongside `notify_email`, `webhook`, etc. Pulls GitHub PAT from the gateway pair (rule #19), creates a severity-labeled issue from the triage result with idempotency by (repo, application_uuid, deployment_uuid).

Purpose: G4 absorption (GitHub issue creation), wired as a first-class post-run action.
Output: New executor + schema entry + dispatcher case + test.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@hub/src/scheduler/post-run/schema.ts
@hub/src/scheduler/post-run/dispatcher.ts
@hub/src/scheduler/post-run/webhook.ts
@hub/src/scheduler/post-run/email.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Extend post-run schema with github_issue action</name>
  <files>hub/src/scheduler/post-run/schema.ts</files>
  <read_first>
    - hub/src/scheduler/post-run/schema.ts (existing discriminated union pattern)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"GitHub-issue post-run action (G4)" — config shape
  </read_first>
  <action>In `hub/src/scheduler/post-run/schema.ts` add a new Zod object `GithubIssueAction = z.object({ type: z.literal('github_issue'), ...Base, config: z.object({ repo_full_name: z.string().regex(/^[^/]+\/[^/]+$/), labels: z.array(z.string()).max(20).optional(), assignees: z.array(z.string()).max(10).optional() }) })`. Add it to the `PostRunAction` `z.discriminatedUnion('type', [...])` list. Export the new schema. Do not modify `detectChainCycles` (only chain_task contributes edges).</action>
  <verify>
    <automated>cd hub ; bun run tsc --noEmit</automated>
  </verify>
  <done>Type union compiles; valid `github_issue` action passes validatePostRunActions; invalid repo_full_name (no slash) is rejected.</done>
</task>

<task type="auto">
  <name>Task 2: Implement executeGithubIssue with gateway creds + idempotency</name>
  <files>hub/src/scheduler/post-run/github-issue.ts, hub/src/db/dal.ts, package.json</files>
  <read_first>
    - hub/src/scheduler/post-run/webhook.ts (pattern for an executor function + ctx shape + log-only failure)
    - hub/src/scheduler/post-run/email.ts (pattern for an executor that does outbound HTTP with templating)
    - ~/.claude/CLAUDE.md "MCP Server Authentication Architecture" §"Gateway credential endpoints" — `GET /api/credentials/service/github` returns `{ token, ... }`
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"GitHub-issue post-run action (G4)"
  </read_first>
  <action>Add `@octokit/rest` to `hub/package.json` dependencies (verify with `npm view @octokit/rest version` before adding — use latest stable). Create `hub/src/scheduler/post-run/github-issue.ts` exporting `executeGithubIssue(action: PostRunAction, ctx: { userId: string; templateVars: Record<string, unknown>; runId: string }): Promise<void>`. Flow: (1) guard `action.type !== 'github_issue'` → return; (2) load GitHub token: `const gwUrl = process.env.GATEWAY_URL; const gwKey = process.env.GATEWAY_API_KEY; const res = await fetch(`${gwUrl}/api/credentials/service/github`, { headers: { 'X-Api-Key': gwKey } });` — on non-200 fall back to FALLBACK_GATEWAY_URL/FALLBACK_GATEWAY_API_KEY; parse `{ token }`; if no token, console.warn and return; (3) parse triage result: `const triage = parseTriageOutput(String(ctx.templateVars.output_snippet ?? ''))`; if `!triage.ok` log warn and fall back to generic title "Deployment failed: <error or 'unknown'>"; (4) idempotency: derive `idempotencyHash = sha256(`${repo_full_name}|${application_uuid}|${deployment_uuid}`)`, then call new DAL helper `hasOpenIssueForHash(userId: string, hash: string, windowHours: number): Promise<boolean>` — if true, log info and return. After successful issue creation, call `recordOpenIssueForHash(userId, hash, issueNumber, repo_full_name)`. Both helpers in `hub/src/db/dal.ts` backed by a new tiny table — see Task 3; (5) build title: `[${triage.severity ?? 'unknown'}] ${triage.error_type ?? 'Deployment failure'} — ${ctx.templateVars.application_uuid ?? 'app'}`; body: rendered Markdown including `root_cause`, `suggested_fix`, `confidence`, `affected_files`, `commit_sha`, `git_repository`, `run_url` from templateVars; (6) labels: combine `action.config.labels ?? []` with derived `[`severity:${triage.severity}`, 'automated', 'remo-code']`; (7) call Octokit `issues.create({ owner, repo, title, body, labels, assignees })`. Log-only on failure (no throw). In `post-run/dispatcher.ts` extend the `executeAction` switch with `case 'github_issue': await executeGithubIssue(action, { userId: args.task.user_id, templateVars, runId: args.runId }); return;`.</action>
  <verify>
    <automated>cd hub ; bun run tsc --noEmit</automated>
  </verify>
  <done>TypeScript green. Dispatcher routes `github_issue` to the new executor. No env `GITHUB_TOKEN` referenced anywhere in `hub/src/`.</done>
</task>

<task type="auto">
  <name>Task 3: Idempotency table + DAL helpers + test</name>
  <files>hub/src/db/schema.sql, hub/src/db/dal.ts, hub/test/post-run-github-issue.test.ts</files>
  <read_first>
    - hub/src/db/schema.sql (where 06-PLAN-001 added columns — colocate new table near scheduled_task_runs)
    - hub/src/scheduler/post-run/github-issue.ts (from task 2)
  </read_first>
  <action>In `hub/src/db/schema.sql` add: `CREATE TABLE IF NOT EXISTS github_issue_idempotency ( user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, hash TEXT NOT NULL, repo_full_name TEXT NOT NULL, issue_number INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, hash) );` and `CREATE INDEX IF NOT EXISTS idx_gh_idem_created ON github_issue_idempotency(created_at);`. In `hub/src/db/dal.ts` implement `hasOpenIssueForHash(userId, hash, windowHours)` → `SELECT 1 FROM github_issue_idempotency WHERE user_id=$1 AND hash=$2 AND created_at > now() - ($3 || ' hours')::interval LIMIT 1` returning boolean, and `recordOpenIssueForHash(userId, hash, issueNumber, repoFullName)` → INSERT with `ON CONFLICT (user_id, hash) DO NOTHING`. Create `hub/test/post-run-github-issue.test.ts`: stub `fetch` to return a fake gateway token then a fake Octokit-equivalent response; assert the second run with the same (repo, app_uuid, deployment_uuid) skips creation (Octokit-equivalent fetch called only once). Skip on missing `REMO_E2E_DB_URL`.</action>
  <verify>
    <automated>cd hub ; REMO_E2E_DB_URL=$REMO_E2E_DB_URL bun test test/post-run-github-issue.test.ts</automated>
  </verify>
  <done>Schema applies; helpers return correct booleans; idempotency test green.</done>
</task>

</tasks>

<verification>
- `bun test hub/test/post-run-github-issue.test.ts` green.
- `grep -n "GITHUB_TOKEN" hub/src/` returns nothing (creds via gateway only).
- `grep -n "github_issue" hub/src/scheduler/post-run/dispatcher.ts` shows the new case.
</verification>

<success_criteria>
- New action type registered, validated, dispatched.
- Credentials always via gateway pair.
- Duplicate triage events for the same deployment do not create duplicate issues.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-007-SUMMARY.md` when done.
</output>
