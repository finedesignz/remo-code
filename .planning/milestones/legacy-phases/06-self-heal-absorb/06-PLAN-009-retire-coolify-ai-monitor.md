---
phase: 06-self-heal-absorb
plan: 009
type: execute
wave: 5
depends_on: [06-PLAN-008-self-heal-wire-up]
files_modified:
  - docs/coolify-webhook-migration.md
autonomous: false
requirements: []

must_haves:
  truths:
    - "Migration runbook exists documenting how to point Coolify webhooks at remo-code and stop coolify-ai-monitor"
    - "1-week parallel-soak guidance is captured"
    - "Port 3032 removal from the global port map is queued for docs plan 010"
  artifacts:
    - path: "docs/coolify-webhook-migration.md"
      provides: "Step-by-step retirement runbook for coolify-ai-monitor"
  key_links:
    - from: "Coolify webhook UI"
      to: "https://app.remo-code.com/api/coolify/webhook/<user_id>"
      via: "user reconfigures webhook target + headers"
---

<objective>
Document and execute the soak + retire path for the legacy `coolify-ai-monitor` Coolify app. No new product code — runbook + checkpoint for stopping the legacy service.

Purpose: Phase 06's exit criterion — old app stopped, port freed.
Output: `docs/coolify-webhook-migration.md` + a human-verify checkpoint that stops the Coolify app.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@.planning/analysis/coolify-ai-monitor-vs-remo-code.md
@C:/Users/artic/GitHub/coolify-ai-monitor/README.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write coolify-webhook-migration runbook</name>
  <files>docs/coolify-webhook-migration.md</files>
  <read_first>
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"Retire coolify-ai-monitor"
    - .planning/analysis/coolify-ai-monitor-vs-remo-code.md §"Migration recommendation"
  </read_first>
  <action>Create `docs/coolify-webhook-migration.md` with sections: (1) Why retire — one-paragraph summary citing the absorption of G2/G3/G4/G5/G6 into Phase 06; (2) Pre-cutover checklist — Phase 04 plan 008 merged; Phase 06 plans 001-008 deployed; user has rotated a webhook secret via Settings; user has confirmed `POST /api/coolify/webhook/<user_id>` returns 202 with a hand-rolled signed payload (include the curl one-liner); (3) Cutover steps — in Coolify webhook UI, change the destination URL from the old `coolify-ai-monitor` URL to `https://app.remo-code.com/api/coolify/webhook/<user_id>`, add the two required headers (`X-Coolify-Signature: sha256=<hex>`, `X-Coolify-Timestamp: <unix-seconds>`); (4) Soak period — run both old and new for 7 days, compare row counts (old Mongo `errors` count vs new `scheduled_task_runs WHERE task_kind='triage'`), assert no missed deployments; (5) Retire — stop the `coolify-ai-monitor` Coolify app via UI or API, do NOT delete the app for 30 more days (rollback window), then schedule deletion; (6) Port-map cleanup — link to plan 010 which removes port 3032 from `~/.claude/CLAUDE.md`. Use plain markdown — no fences inside fences.</action>
  <verify>
    <automated>test -f docs/coolify-webhook-migration.md && grep -q "X-Coolify-Signature" docs/coolify-webhook-migration.md && grep -q "soak" docs/coolify-webhook-migration.md</automated>
  </verify>
  <done>Runbook exists with all six sections and references the correct header names.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: Human checkpoint — confirm 7-day soak complete and stop coolify-ai-monitor</name>
  <what-built>Phase 06 webhook + triage stack running in production; legacy `coolify-ai-monitor` app on port 3032 still receiving the same webhook fire-and-forget.</what-built>
  <how-to-verify>
    1. Confirm at least 7 calendar days have passed since both endpoints went live in parallel.
    2. Pull last-7-day row counts: `psql $DATABASE_URL -c "SELECT count(*) FROM scheduled_task_runs WHERE task_kind='triage' AND scheduled_for > now() - interval '7 days'"` — note count A.
    3. From `coolify-ai-monitor` Mongo (or its `GET /errors?limit=1000`), count last-7-day error documents — note count B.
    4. Assert |A - B| / max(A, B) < 0.10 (within 10% — accounts for retries / dedupe differences).
    5. Confirm at least one triage run produced a GitHub issue end-to-end.
    6. In Coolify UI, stop the `coolify-ai-monitor` application (do NOT delete). Wait 5 minutes. Confirm new `deployment.failed` events still produce remo-code triage runs.
  </how-to-verify>
  <resume-signal>Type "retired" to proceed to plan 010 (tests + docs cleanup), or describe issues to stay in this plan.</resume-signal>
</task>

</tasks>

<verification>
- `docs/coolify-webhook-migration.md` exists and is referenced from the README update in plan 010.
- After checkpoint approval, `curl http://46.224.61.233:3032/health` returns connection refused (app stopped).
</verification>

<success_criteria>
- Soak comparison met (|A-B| < 10%).
- Legacy app stopped (not deleted) — 30-day rollback window preserved.
- Migration doc covers cutover + retire + rollback.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-009-SUMMARY.md` when done.
</output>
