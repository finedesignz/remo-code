# coolify-ai-monitor vs remo-code (Phase 06 self-heal absorb)

Date: 2026-05-25
Scope: replace standalone `coolify-ai-monitor` (port 3032) with capability inside `remo-code`.

Sources read:
- `C:/Users/artic/GitHub/coolify-ai-monitor/README.md`
- `C:/Users/artic/GitHub/coolify-ai-monitor/src/index.js` (450 lines, single-file Express service)
- `C:/Users/artic/GitHub/coolify-ai-monitor/package.json`
- `C:/Users/artic/GitHub/remo-code/CLAUDE.md`
- `C:/Users/artic/GitHub/remo-code/docs/scheduled-tasks.md`
- `C:/Users/artic/GitHub/remo-code/.planning/phases/04-coolify-dev-supervisor/04-PLAN-008-self-heal-routing.md`
- `C:/Users/artic/GitHub/remo-code/hub/src/scheduler/senders/coolify.ts`

---

## 1. What `coolify-ai-monitor` does today

Single Express service. ~450 LOC. No DB schema beyond Mongo collections created on first insert.

| # | Capability | File / Route |
|---|---|---|
| F1 | **Log drain ingest** — Coolify pushes raw container logs to a public endpoint | `POST /logs/drain` (`src/index.js:215`) |
| F2 | **Deployment webhook ingest** — Coolify pushes `deployment.failed` events | `POST /webhook/coolify` (`src/index.js:264`) |
| F3 | **Regex error detector** — 16 hardcoded patterns (`/error/i`, `ECONNREFUSED`, `TypeError`, `SyntaxError`, …) flag lines as errors | `ERROR_PATTERNS` + `detectErrors()` (`src/index.js:28-87`) |
| F4 | **Claude AI analysis** — sends error lines + last 100 log lines to Claude via `claude-gateway` and parses JSON `{rootCause, severity, suggestedFix, prevention, codeChanges}` | `analyzeWithClaude()` (`src/index.js:89-167`) |
| F5 | **Auto GitHub issue creation** — extracts owner/repo from `git_repository`, opens issue tagged `bug/automated/<severity>` via Octokit | `createGitHubIssue()` + webhook handler (`src/index.js:170-207, 294-317`) |
| F6 | **MongoDB persistence** — two collections (`errors`, `deployments`), indexed by `timestamp`, `service+resolved` | `connectDB()` (`src/index.js:48-70`) |
| F7 | **Manual on-demand analysis** — paste-in-logs REST endpoint | `POST /analyze` (`src/index.js:335`) |
| F8 | **Query API** — list errors/deployments with filters (`service`, `resolved`, `status`, `limit`) | `GET /errors`, `GET /deployments` (`src/index.js:363, 390`) |
| F9 | **Resolve workflow** — mark a stored error resolved | `PATCH /errors/:id/resolve` (`src/index.js:416`) |
| F10 | **Health endpoint** | `GET /health` (`src/index.js:210`) |

Auth model: **none** on inbound endpoints. Public log drain + public webhook. Relies on URL obscurity.
Deploy target: Coolify (its own app on port 3032 per global port map).
Outbound deps: `claude-gateway.coolify.titaniumlabs.us` (LLM), GitHub via Octokit, Mongo.

---

## 2. Overlap — already in remo-code

| coolify-ai-monitor feature | remo-code equivalent | Path |
|---|---|---|
| F4 Claude AI analysis | Native — every session IS a Claude Code subprocess with full tool access; far richer than one-shot prompt | `agent/src/claude-runner.ts`, `agent/src/cli-runner.ts` |
| F6 persistence | Postgres (`messages`, `sessions`, `scheduled_task_runs`); `output_snippet` already captures log bodies for log_check runs | `hub/src/db/schema.sql`, `hub/src/scheduler/dispatcher.ts` |
| F8 query API (recent runs) | `GET /api/scheduled-task-runs` returns run history with snippets, cost, duration | `hub/src/api/scheduled-task-runs.ts` |
| F7 manual analysis | Send any prompt to any session via web UI or `POST /api/sessions/heal` (Phase 04 plan 008) | `web/src/components/...`, `04-PLAN-008-self-heal-routing.md` |
| Coolify log fetch (partial F1) | `log_check` task type pulls `/api/v1/applications/:uuid/logs` on a schedule | `hub/src/scheduler/senders/coolify.ts` |
| Routing of "fix this" prompts to a Claude session | `pickSessionTarget` + `POST /api/sessions/heal` (planned in Phase 04 plan 008) | `.planning/phases/04-coolify-dev-supervisor/04-PLAN-008-self-heal-routing.md` |
| F10 health | `GET /health` on hub | `hub/src/index.ts` |
| F9 resolve workflow | Run status (`success`/`failed`) + acknowledged flag on scheduled-task runs | scheduler tables |

Net: remo-code already covers AI analysis, persistence, query, manual triage, scheduled Coolify log pulls, and the dispatch endpoint to send a prompt to a Claude session.

---

## 3. Gaps — NOT in remo-code or current self-heal plan

| Gap | What's missing | Where it lives in coolify-ai-monitor |
|---|---|---|
| G1 | **Inbound `POST /logs/drain`** — receives push from Coolify's Log Drain feature (vs. remo-code's pull-via-`log_check`) | `src/index.js:215` |
| G2 | **Inbound `POST /webhook/coolify`** — Coolify deployment lifecycle webhook | `src/index.js:264` |
| G3 | **Regex error detector** — pattern-match log lines BEFORE spending an LLM call. remo-code's `log_check` currently fires the whole snippet to post-run actions without classification | `ERROR_PATTERNS` `src/index.js:28-45` |
| G4 | **Auto GitHub issue creation** with severity labels | `createGitHubIssue()` `src/index.js:170-207` |
| G5 | **Deployment-event awareness** — knows `deployment.failed` happened and ties analysis to a `deployment_uuid` + git repo | webhook handler `src/index.js:271-323` |
| G6 | **Structured analysis schema** — `{rootCause, severity, suggestedFix, prevention, codeChanges}` JSON contract for downstream automation | prompt in `analyzeWithClaude()` `src/index.js:93-110` |
| G7 | **Per-error resolve state** distinct from a run's success/fail (one log_check run can contain many errors) | `PATCH /errors/:id/resolve` |
| G8 | **Unauthenticated public ingress** for Coolify to push to (Coolify Log Drain has no auth header support out of the box) | both inbound routes |

---

## 4. Migration recommendation

| Gap | Verdict | Rationale |
|---|---|---|
| G1 log drain ingest | **(b) defer** — Phase 07+ | remo-code's `log_check` PULL model is strictly better: authenticated via `COOLIFY_TOKEN`, cron-controlled, no public ingress to harden. Only port log-drain if push-latency matters (currently it doesn't — `log_check` runs every N minutes). |
| G2 deployment webhook | **(a) absorb into Phase 06** | High value, low cost. Add `POST /api/coolify/webhook` to hub behind a per-user signing secret. Emits a synthetic "deployment_failed" event that the scheduler/dispatcher treats like a one-shot task → routes through `pickSessionTarget` → a Claude session triages it. Replaces F2 cleanly. |
| G3 regex pre-filter | **(a) absorb into Phase 06** | Cheap to port. Add a `LogErrorClassifier` utility (`hub/src/scheduler/log-classifier.ts`) called from `senders/coolify.ts` after the fetch. Skip post-run actions when no errors found → drops cost cap consumption. Patterns are 16 regexes, trivial. |
| G4 GitHub issue creation | **(a) absorb into Phase 06**, but as a **post-run action** not a hardcoded path | Already aligns with remo-code's post-run action architecture (`hub/src/scheduler/post-run/*`). Add `github_issue` alongside existing `notify_email`, `webhook`, etc. Reuse `post-run/template.ts` for body templating. |
| G5 deployment-event awareness | **(a) absorb into Phase 06** — comes for free with G2 | Webhook payload carries `application_uuid`, `git_repository`, `deployment_uuid`. Persist on the synthesized run row. |
| G6 structured analysis schema | **(a) absorb into Phase 06** | Codify as a scheduled-task `task_kind: 'triage'` template: prompt + JSON schema enforced via Claude's tool-use, results stored in `output_snippet` as JSON. Lets multiple post-run actions consume the same structured output (GitHub issue body, email summary, Telegram alert). |
| G7 per-error resolve state | **(c) drop** | Over-engineered for the new model. A triage run produces one structured analysis per fire; resolution is the resulting commit / GitHub issue close. The Mongo `errors.resolved` field never proved useful in coolify-ai-monitor (no UI for it). |
| G8 unauthenticated ingress | **(c) drop** — don't carry forward | Replace with HMAC-signed webhook secret per user. Existing Coolify webhook UI supports a custom header. |

Headline: **5 of 8 features absorb cleanly into Phase 06 + post-run action plumbing**, 2 defer, 1 drop.

---

## 5. Risks / conflicts

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Auth model mismatch** — coolify-ai-monitor is wide-open; remo-code is JWT-everywhere. Webhook ingress needs a new auth mechanism (HMAC + per-user shared secret stored in `users.coolify_webhook_secret`). | Med | Add column + endpoint in Phase 06; document Coolify webhook setup with header config. |
| R2 | **Database divergence** — coolify-ai-monitor uses Mongo; remo-code uses Postgres on Coolify (global rule #17). Existing error/deployment rows in Mongo will not be migrated. | Low | Document one-way cut. No historical value in old rows (Claude's analysis was prompt-only, not actionable). |
| R3 | **`pickSessionTarget` not yet shipped** — Phase 04 plan 008 (the routing primitive Phase 06 will rely on) is in plan state, not merged. Phase 06 cannot pre-empt it. | High | Sequence: ship Phase 04 plans 002/003/008 first, then Phase 06 builds on top. The plan in `04-PLAN-008` is explicit that self-heal becomes a thin HTTP client of `/api/sessions/heal`. |
| R4 | **Cost cap explosion** — coolify-ai-monitor calls Claude on every log batch. Wiring deployment webhooks into scheduler-style fan-out without gating could blow the daily cost cap. | Med | Force triage runs through the same `enforceCostCap` path as scheduled tasks (`hub/src/scheduler/dispatcher.ts`). Regex pre-filter (G3) is the first gate; cost cap is the second. |
| R5 | **GitHub token storage** — coolify-ai-monitor used a single global `GITHUB_TOKEN`. remo-code needs per-user GitHub credentials. Global rule says go through the **gateway pair** (Ottolax → service credentials), not env vars. | Med | Wire `github_issue` post-run action to fetch creds via `@mcp/shared`-style gateway lookup, same pattern as existing post-run senders. |
| R6 | **External `claude-code-self-heal` service (port 9114) still exists** — per Phase 04 plan 008 it stays as the HTTP client for a 2-week proving period. Don't tear it down when absorbing coolify-ai-monitor; they're independent components. | Low | Keep `claude-code-self-heal` running; only retire after `/api/sessions/heal` is stable. |
| R7 | **Coolify Log Drain header limits** — Coolify's Log Drain UI may not support custom auth headers (need to verify). If true, G1 cannot be securely absorbed and the "defer" verdict becomes "drop". | Low | Verify before scheduling G1 work. Even without G1, `log_check` pull covers the use case. |
| R8 | **Branch-management rule #19** — Phase 06 needs its own fresh branch (`feat/phase-06-error-capture`) off main; do NOT pile onto `feat/multichat-grid-view` which already has 5 concerns. | Med | Orchestrator: branch first, then dispatch. |

---

## 6. One-line summary

`coolify-ai-monitor` can be retired by absorbing its **deployment webhook ingest, regex pre-filter, structured triage prompt, and GitHub-issue post-run action** into Phase 06 on top of Phase 04's `pickSessionTarget` + `/api/sessions/heal`; the log-drain push path and per-error resolve UI are not worth porting because remo-code's pull-based `log_check` and run-status model already cover them better.
