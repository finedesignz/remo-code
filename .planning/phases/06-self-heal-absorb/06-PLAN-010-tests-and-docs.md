---
phase: 06-self-heal-absorb
plan: 010
type: execute
wave: 5
depends_on: [06-PLAN-008-self-heal-wire-up, 06-PLAN-009-retire-coolify-ai-monitor]
files_modified:
  - docs/scheduled-tasks.md
  - README.md
  - CLAUDE.md
autonomous: true
requirements: []

must_haves:
  truths:
    - "docs/scheduled-tasks.md describes the triage task_kind, coolify webhook ingress, log classifier gate, and github_issue post-run action"
    - "README.md mentions Phase 06 self-heal absorb capability"
    - "CLAUDE.md (project) documents the new modules and the gateway-pair GitHub creds rule"
    - "~/.claude/CLAUDE.md port-map removal for 3032 is queued (delegated to docs subagent)"
  artifacts:
    - path: "docs/scheduled-tasks.md"
      provides: "Updated authoritative scheduler doc"
    - path: "README.md"
      provides: "User-facing Phase 06 feature blurb"
    - path: "CLAUDE.md"
      provides: "Assistant guidance covering Phase 06 modules + invariants"
---

<objective>
Update all documentation surfaces to reflect Phase 06 and run the final phase-wide test sweep. Per project CLAUDE.md scheduler rule, scheduler changes MUST update `docs/scheduled-tasks.md` and the test contract in the same phase.

Purpose: Phase exit — docs current, tests green, port map cleaned.
Output: Updated 3 docs + green test sweep.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@docs/scheduled-tasks.md
@README.md
@CLAUDE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Update docs/scheduled-tasks.md with Phase 06 surfaces</name>
  <files>docs/scheduled-tasks.md</files>
  <read_first>
    - docs/scheduled-tasks.md (current full doc — find existing sections on task_kind, senders, post-run actions)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md (full)
  </read_first>
  <action>Add to `docs/scheduled-tasks.md`: (a) under "Task kinds" — new `triage` row with description "Webhook-triggered Coolify deployment triage; renders structured prompt, parses TriageResult JSON, drives self-heal via pickSessionTarget"; (b) new section "Coolify webhook ingress" documenting `POST /api/coolify/webhook/:user_id`, the two required headers, the rotate endpoint, and the persisted deployment metadata columns on `scheduled_task_runs`; (c) under "Senders" — new `triage.ts` entry; (d) under "Post-run actions" — new `github_issue` action with config schema, gateway-pair credential note, idempotency window (24h, hash of (repo, application_uuid, deployment_uuid)); (e) under "Log classifier" — new section describing the 16-pattern gate in `hub/src/scheduler/log-classifier.ts` and the cost-cap-preserving skip-on-clean behavior. Cross-link to `docs/coolify-webhook-migration.md`. Update the "When adding a new task type..." paragraph if needed.</action>
  <verify>
    <automated>grep -q "triage" docs/scheduled-tasks.md && grep -q "/api/coolify/webhook" docs/scheduled-tasks.md && grep -q "github_issue" docs/scheduled-tasks.md && grep -q "log-classifier" docs/scheduled-tasks.md</automated>
  </verify>
  <done>All four greps return matches.</done>
</task>

<task type="auto">
  <name>Task 2: Update README.md + project CLAUDE.md</name>
  <files>README.md, CLAUDE.md</files>
  <read_first>
    - README.md (find feature list — likely near top, look for "scheduled tasks" mention)
    - CLAUDE.md (project — find phase sections; Phase 05 has its own block at the end; add a parallel Phase 06 block)
  </read_first>
  <action>In `README.md`: add a short bullet under the feature list mentioning Coolify deployment triage + auto GitHub issue, with a link to `docs/coolify-webhook-migration.md`. In project `CLAUDE.md`: add a new section "## Phase 06: Coolify Self-Heal Absorb" mirroring the Phase 05 block — file map (`hub/src/scheduler/log-classifier.ts`, `triage-prompt.ts`, `triage-schema.ts`, `senders/triage.ts`, `post-run/github-issue.ts`, `api/coolify-webhook.ts`), key invariants (cost cap via `enforceCostCap`; GitHub creds via gateway pair, NEVER env `GITHUB_TOKEN`; idempotency by `(repo, application_uuid, deployment_uuid)` hash within 24h; webhook HMAC `X-Coolify-Signature: sha256=<hex>` with `X-Coolify-Timestamp` and 5-min skew), and the same-commit doc-update rule ("When adding a new triage payload field, post-run action, or webhook event type: update `docs/scheduled-tasks.md` and `docs/coolify-webhook-migration.md` in the same commit").</action>
  <verify>
    <automated>grep -q "Phase 06" CLAUDE.md && grep -q "coolify-webhook-migration" README.md</automated>
  </verify>
  <done>Both docs reference the new phase.</done>
</task>

<task type="auto">
  <name>Task 3: Remove port 3032 from global port map</name>
  <files>(global file — delegated)</files>
  <read_first>
    - ~/.claude/CLAUDE.md (port map table — find the `| 3032 | coolify-ai-monitor |` row)
  </read_first>
  <action>Edit `~/.claude/CLAUDE.md` (user-global instructions) to remove the row `| 3032 | coolify-ai-monitor | API | — |` from the port map table. No other changes to that file. This is a one-line deletion. Per user CLAUDE.md rule #14, this is part of the phase-completion docs sweep.</action>
  <verify>
    <automated>grep -c "coolify-ai-monitor" ~/.claude/CLAUDE.md</automated>
  </verify>
  <done>Grep count is 0 (row removed).</done>
</task>

<task type="auto">
  <name>Task 4: Phase-wide test sweep</name>
  <files>(no edits — verification only)</files>
  <read_first>
    - hub/test/log-classifier.test.ts
    - hub/test/coolify-sender-classifier.test.ts
    - hub/test/coolify-webhook.test.ts
    - hub/test/coolify-webhook-secret.test.ts
    - hub/test/triage-schema.test.ts
    - hub/test/post-run-github-issue.test.ts
    - hub/test/coolify-webhook-triage-e2e.test.ts
    - hub/test/scheduler.test.ts (existing — must remain green)
  </read_first>
  <action>From repo root run `cd hub && bun test` (full hub test suite) with `REMO_E2E_DB_URL` set. All Phase 06 tests plus the existing `scheduler.test.ts` and `scheduled-tasks.e2e.test.ts` must be green. If any pre-existing test breaks due to Phase 06 changes, fix the offending Phase 06 module — do NOT modify the existing test assertions unless the contract genuinely changed (in which case also update `docs/scheduled-tasks.md` in this plan).</action>
  <verify>
    <automated>cd hub ; REMO_E2E_DB_URL=$REMO_E2E_DB_URL bun test</automated>
  </verify>
  <done>Full hub test suite green.</done>
</task>

</tasks>

<verification>
- All grep checks above pass.
- Full hub test suite green.
- Port map no longer references 3032.
</verification>

<success_criteria>
- Phase 06 documentation surfaces complete and cross-linked.
- No test regressions.
- Global port map cleaned.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-010-SUMMARY.md` when done. Phase 06 closes.
</output>
