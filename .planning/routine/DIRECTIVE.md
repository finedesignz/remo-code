# Routine Directive: finedesignz/remo-code

<!-- FIXED CORE: do not edit. Changes require a human PR. -->
## 1. Objective
Let the owner run, watch, and steer Claude Code / Codex sessions on their own machines from any browser
or phone: reliably, securely, and without runaway token spend.
· Users: the owner (single operator, Titanium Labs) plus any Titanium-licensed user; external agents via `/api/ext`.
· "Effective" means: sessions start on the first click and stay connected (no `at_capacity` wedges, no
ghost sessions, no latched circuit breakers); the human PTY terminal works on desktop and phone;
scheduled / self-heal / orchestrator work lands as PRs, never silent spend; daily token use stays well
under the 50M cap; zero secret or cross-user leaks.

## 2. Iteration protocol
**Run 1 (bootstrap):** GSD state already exists (`.planning/STATE.md`, `ROADMAP.md`, `phases/`,
`codebase/`), so there's no onboarding step. Verify this DIRECTIVE against the repo. Baseline
`SCORECARD.md`. Run `/roast` on the app with a brief built from `README.md` + `CLAUDE.md` "What This Is"
+ `.planning/PROJECT.md`: what it is, who it's for (the owner; Titanium-licensed devs), how it makes
money (Titanium license), and constraints (flat-rate Max subscription, human-only PTY, and the
cost + token caps). Seed `PRIORITIES.md` from `SECURITY.md` open findings, `.planning/codebase/CONCERNS.md`
FIX items, ROADMAP PTYCAP phases 2–6, and dependabot PRs. Open the PR.

**Runs 2+:**
1. Orient: read this DIRECTIVE, `.planning/STATE.md`, `SCORECARD.md`, `PRIORITIES.md`, `LEDGER.md`.
   Collision check (§8). Claim the area by opening a draft PR early.
2. Deploy check (§8 Deploy verify). A failure is P0.
3. Sense: refresh the signals in §3 and user feedback (C.4), run the UI scan when it's due (§5), and
   update the scorecard.
4. Triage: score candidates (§3), write `PRIORITIES.md`, pick the top item. Log the choice and why.
5. Execute through the mapped GSD skill (§4). Every fix gets a regression test that fails before the
   fix and passes after.
6. Verify: run the full local checks (§8). UI changes get screenshots at desktop and 390px, light and
   dark. Perf, cost, and DB items get before/after numbers.
7. PR: title `[<dimension>] <item>`. Body: why it was top priority (its score), the change, evidence,
   the feedback cluster it addresses, and "AAF merges on green". Drive CI (§8). Max 3 fix cycles.
8. Evaluate: run `/qc` on the iteration against the objective. Answer: Was this the right item? Did
   the target dimension improve (evidence)? Did anything regress? What would an expert manager have
   done differently? Give a 1–10 iteration score. When due (milestone boundary, or every
   `roast_every` iterations, §11), run `/roast` on the app and re-baseline the scorecard.
9. Tune: rewrite the TUNABLE section, one change per finding, and log each change in §14 with the
   score that drove it. Two iterations in a row scoring ≤4 → change strategy, not just tactics.
10. Close: update STATE (resume point + sentinel heartbeat line), `SCORECARD.md`, and `LEDGER.md`,
    all committed on the iteration's PR branch.

Stuck or over budget: stop cleanly (no broken commit), write the blocker and resume point, and let the
next iteration re-triage. Same failure 3× → lower that item's Confidence and move on. Budget: ~60 min
active; CI wait excluded.

## 3. Prioritization engine
### 3.1 Scorecard (0–10 per dimension, evidence required)
| Dimension | Evidence in this repo |
|---|---|
| Security | `bun audit`; open dependabot PRs; `SECURITY.md` open findings; `/qc` security lens; `hub/test/api-keys-scopes`, `mount-order`, `token-cap-coverage` green; `user_id` scoping + object-ownership checks on new routes |
| Reliability/bugs | Coolify hub logs (Coolify MCP via lazy launcher: `at_capacity`, `circuit_open`, `ghost_reaped`, `run_timeout`, uncaught errors); AAF-forwarded hub self-errors; `check-baseline` fail count; `.planning/debug/` open items; recent `fix(` reverts |
| Data integrity | `bun run schema-lint`, `bun run migration-verify`; leaked open `session_runs` / stuck `scheduled_task_runs` (reaper log lines); orphan rows noted in CONCERNS.md |
| Performance | `bun run smoke -- https://app.remo-code.com` timings; `bun run build:web` bundle size (`web/dist/assets`); Coolify CPU/mem |
| Cost | Token-cap trips and inject-rate rejections in hub logs; cap coverage (`token-cap-coverage.test.ts`); loop risk in `hub/src/orchestrator/`. Live `token_usage` totals need an auth cookie, so there's no unattended read: none yet, skip the live number |
| User value | `.planning/ROADMAP.md` (PTYCAP phases 2–9); user feedback (C.4); roast Buyer lens |
| UX/UI | UI scan findings (§5); `web/test/no-indigo.test.ts`; design standards (§7) |
| Code health/tests | `bunx tsc --noEmit -p hub/tsconfig.json` error count (393 at the 2026-07 baseline; CI only reports it); god-files (`hub/src/db/dal.ts`, `hub/src/ws/agent.ts`, `hub/src/api/telegram-webhook.ts`); CI doesn't run `web/test/` or most of `supervisor/test/` |
| Observability/docs | `/health` + `/healthz`; docs-drift status; docs map in CLAUDE.md vs code (CLAUDE.md still lists `.woodpecker/supervisor-build.yaml`, which moved to GHA in #480) |

Refresh cheaply every iteration from the signals above; do a full re-baseline with `/roast`.

### 3.2 P0 tier (preempts everything)
- An exploitable or exposed vulnerability or leaked secret. This includes any cross-user session or
  data access, an unfenced untrusted inbound payload that reaches a session, an `ext:work` publish
  without the hub gates, and an API key on the human PTY path.
- Prod down: `https://app.remo-code.com/health` not 2xx, the `post-deploy-smoke` Woodpecker pipeline
  red on main's latest merge, or the last deploy broken.
- Data corruption or loss in prod, or a `schema.sql` statement that mutates data on boot.
- Runaway cost: a dispatch path missing `dailyTokenCapGate` or `dailyCostCapGate`; the hub booting with
  the cap disabled; a tick or inject loop (more than `REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR`=4 per
  session per hour); or daily tokens above 2× the trailing 7-day baseline, or trending toward the 50M
  cap within 72h.
- Launch wedge or SLO breach: every session start fails (`at_capacity` or a latched `circuit_open`), or
  smoke p95 > 800ms or error rate > 1%.
- A cluster of user feedback reporting a blocking failure in a core flow (start a session, terminal I/O,
  login).

With several P0s, order them security > data > prod down > cost > perf.

### 3.3 Scoring everything else
`Priority = (Impact × Reach × Urgency × Confidence) ÷ Effort + age bonus`
- Impact 1–10, Reach 1–10, Urgency 1–3, Confidence 0.5–1.0, Effort 1–5 (1–2 fits one iteration),
  age bonus +0.5 per iteration waited (cap in §11). Split anything with Effort > 3 before scheduling it.
- Impact guide:
  - Security: exposed and exploitable = P0; authenticated-only 8; hardening 3.
  - Bug: core flow broken 9; workaround exists 5; cosmetic 1–2.
  - Feature: fit with the objective and feedback volume 1–10; nice-to-have 2.
  - Data/DB: breaking prod = P0; slowing prod 8; hygiene 2.
  - Perf: SLO breach = P0; user-visible 7; micro-optimization 1.
  - Cost: runaway = P0; >20% saving 6; <5% saving 1.
  - UX: broken core page 7; inconsistency 3–4; polish 2.
  - Code health: blocks roadmap work 6; general debt 2.
- Tiebreak: the dimension with the lowest scorecard score wins. Weights live in §11.

### 3.4 User feedback
Check sources in this order:
1. AgentAutofix widget comments. AAF is wired in: `web/src/components/AgentautofixWidget.tsx`,
   `hub/src/api/agentautofix.ts`, and `hub/src/agentautofix/reporter.ts` (which forwards hub self-errors).
2. GitHub issues on `finedesignz/remo-code`.
3. `.planning/routine/feedback/*.md`, the fallback inbox.

The in-app feedback intake (`POST /api/feedback/:token`) serves *other* apps' end users and is not
feedback on remo-code itself, so skip it here.

Each iteration: dedupe and cluster the feedback, and link clusters to items in `PRIORITIES.md`.
Feedback raises Reach, Impact, and Confidence, and the owner's feedback counts highest. Mark a cluster
resolved when its PR merges.

## 4. Routing map (GSD skills, `anthropic-skills:` prefix)
| Top item | Execute with |
|---|---|
| P0 prod down / broken deploy | `gsd-debug` → fix or revert PR |
| Security | `gsd-secure-phase` / `gsd-audit-fix` |
| Bug | `gsd-debug` → `gsd-quick` |
| Data / DB / perf / cost | `gsd-quick` with before/after measurement |
| Feature in the active milestone (PTYCAP, phases 2–6 open; Phase 1 merged in #395) | `gsd-autonomous` scoped to ONE phase |
| Feature not on the roadmap | `gsd-phase` add, or `gsd-capture` if it isn't top yet |
| Unverified executed phase | `gsd-verify-work`, `gsd-add-tests`, `gsd-validate-phase` |
| All phases verified | `gsd-audit-milestone` → `gsd-complete-milestone` (+ `/roast`) |
| No active milestone and features lead | `gsd-review-backlog` → `gsd-new-milestone` (gates → `gsd-gate-panel`) |
| UI issue | `gsd-ui-review` for audits; `gsd-quick` for fixes |
| Tiny/obvious | `gsd-fast` |

No matching skill → plan it yourself, implement through a Sonnet subagent, same test/QC bar.
`.planning/config.json` has `mode: yolo`; keep it.

## 5. UI scan
- Cadence: pages touched every iteration; a full scan of key routes every `ui_full_scan_every` (§11).
- **No-auth surfaces:** run `bun run dev:web` and open:
  - `http://localhost:5173/#/login`
  - `#/dev/chat-surface`
  - `#/dev/mobile-accordion`
  - `/terminal-harness.html` (TerminalSurface with a stub transport)
- **Authed surfaces:** run a local Postgres (`psql` is present) and the hub with
  `DATABASE_URL=… JWT_SECRET=<32+ chars> ALLOW_LEGACY_LOGIN=true bun run dev:hub`. Register a throwaway
  local user via `POST /api/auth/register`, then open:
  - `#/` (session list)
  - `#/?tab=grid`
  - `#/tasks`
  - `#/activity`
  - `#/settings?tab=connections`, `credentials`, `usage`, and `profile`

  If the local hub can't be booted, scan only the no-auth surfaces and log it.
- Drive Chromium with `playwright-core` (browsers are at `/opt/pw-browsers`; never run
  `playwright install`). Screenshot desktop and 390px, light and dark.
- Look for:
  - misalignment and overflow (horizontal scroll)
  - clipped or overlapping text
  - token misuse (indigo is forbidden; orange is CTA-only)
  - missing loading, empty, and error states
  - contrast and focus problems
  - console errors
- Fix small issues in the same PR, as a separate commit. Score larger ones into `PRIORITIES.md`. When
  UX/UI is the lowest-scoring dimension, run `gsd-ui-review`.

## 6. Evaluation and self-tuning
- `/qc` every iteration, as a cross-model adversarial review. If `/qc` isn't installed in the run's
  environment, use `code-review high` + `security-review` and log that `/qc` was unavailable.
  Don't use `cross-qc`; it's deprecated.
- `/roast` at bootstrap, at milestone boundaries, and every `roast_every` iterations.
- Edit only the TUNABLE section. Log every change in §14 with the score that drove it.

## 7. Standards (QC bar)
**House mandates:**
- AgentAutofix merges PRs on green. Keep the widget and error forwarding intact.
- Bugs found in other repos go to `autofix-report`.
- Auth stays Titanium (magic link + opaque cookie; `docs/auth.md`). No new auth provider.
- Credentials: the Claude OAuth token never leaves the dev machine (`~/.claude/.credentials.json`); only
  parsed usage windows go to the hub. No new per-service credential env vars.
- The STATE heartbeat and resume point are written every iteration, for `gsd-sentinel`.

**Repo mandates** (`CLAUDE.md` Cross-cutting invariants win over everything here; also `docs/remo-work.md`
§1 and `SECURITY.md`):
- Every dispatch gate list carries BOTH `dailyCostCapGate` and `dailyTokenCapGate`. Machine self-heal
  paths also carry `sessionInjectRateGate`. Use `hub/src/dispatch/`; never hand-roll a queue or grace
  period. The token cap fails closed.
- Untrusted inbound text is wrapped with `fenceUntrusted` + `SCOPE_CONTRACT` (`hub/src/dispatch/untrusted.ts`).
  Machine paths are propose-only (PR). Machine spawns force `dangerously_skip_permissions: false`.
- `/api/ext/work` gates are code: repo allowlist, sender allowlist, credential scrub, hub diff-scope +
  build + HTTPS probe, and a hub-performed publish. Never move a gate into a prompt, and never let an
  agent claim drive `published`.
- Human PTY path: no provider API key, no `-p`/`--print`/`stream-json` argv, and every spawn env goes
  through `supervisor/src/runners/env-sanitize.ts`.
- API keys are scoped (`hub/src/auth/scopes.ts`). `ext:work` is explicit-only. `/api/api-keys` is
  cookie-auth only.
- Public webhooks: parse the raw body before JSON, compare secrets in constant time, HMAC over
  `${ts}.${rawBody}`, allow at most 5 min skew, and mount before the `/api/*` auth catch-all.
- Every query is scoped by `user_id`, with an ownership check on any id taken from input (no IDOR). Add
  a cross-user denial test for each new data path.
- WS frames are Zod-validated (`hub/src/ws/protocol.ts`, `agent-protocol.ts`), and so is every REST input.
- `hub/src/db/schema.sql` holds idempotent DDL only (it re-runs every boot). Backfills go in
  `hub/scripts/` one-shots.
- A route change requires `bun run docs:sync`. A behavior change updates its `docs/*.md` in the same
  commit. A new env var gets documented and fails closed.
- Orchestrator: exactly one open per user. Never set `orchestrator_enabled=false` without
  `orchestrator_disabled_explicitly=true`.
- Every bug fix ships a regression test. Never skip, disable, or quarantine a test. Never lower
  `pass_min` or raise `skip_max` in `tools/regression-baseline.json` to absorb a regression.

**Baseline additions** (only where the repo is silent): logs and errors never echo tokens or cookies;
rate-limit expensive endpoints; justify any heavy dependency in the PR.

**Design:**
- Accent is blue; orange is CTA-only; never indigo. Use the CSS custom properties (`--bg-primary`, …),
  not one-off hex. Both themes must be correct.
- Reuse ChatSurface/TerminalSurface and the settings patterns (`docs/chat-ui-architecture.md`).
- At 390px: no horizontal page scroll. The Connections table scrolls inside its own container.
- Every async view has loading, empty, error, and success states. Disable controls while submitting.
  Destructive actions confirm and name the target.
- WCAG 2.2 AA: keyboard order, visible focus, named icon buttons (the #469 toolbar pattern), 4.5:1
  contrast, `aria-live` for async results, modals trap and restore focus.
- Sentence-case copy. Errors never show stack traces.

**Sensitive paths** (a cross-model `/qc` must pass BEFORE the PR opens):
- **Auth and sessions:** `hub/src/auth/**`, `hub/src/csrf.ts`, `hub/src/license-gate.ts`,
  `hub/src/titanium-client.ts`, `hub/src/session.ts`, `hub/src/middleware/**`, `hub/src/api/api-keys.ts`,
  `hub/src/api/auth.ts`, `hub/src/api/webhooks-titanium.ts`
- **Caps and gates:** `hub/src/dispatch/**`, `hub/src/usage/**`, `hub/src/db/token-usage-dal.ts`,
  `hub/src/index.ts`
- **Untrusted inbound:** `hub/src/webhooks/**`, `hub/src/work/**`, `hub/src/ext/**`, `hub/src/api/ext.ts`,
  `hub/src/feedback/**`, `hub/src/api/feedback-webhook.ts`, `hub/src/revanote/**`,
  `hub/src/api/revanote-webhook.ts`, `hub/src/error-capture/**`, `hub/src/api/sentry-intake.ts`,
  `hub/src/api/coolify-webhook.ts`, `hub/src/api/telegram-webhook.ts`
- **Orchestrator and its guards:** `hub/src/orchestrator/**`, `hub/test/*guard*.test.ts`
- **Schema:** `hub/src/db/schema.sql`, `hub/scripts/**`
- **Supervisor:** `supervisor/src/runners/env-sanitize.ts`, `claude-runner.ts`, `backend-selector.ts`,
  `supervisor/src/process-manager.ts`, `supervisor/tauri/src-tauri/**`
- **Build, deploy, and CI:** `Dockerfile`, `.woodpecker/**`, `.github/workflows/**`,
  `tools/regression-baseline.json`

## 8. Operations
**Checks** (repo root; run `bun install --frozen-lockfile` first):
- **Always:** `bun run schema-lint` and `bun run check-baseline` (hub/test, per-file isolated; a gate of
  fail 0, pass ≥ pass_min, skip ≤ skip_max. If you add tests, re-measure and note it in the JSON).
- **Hub typecheck:** `bunx tsc --noEmit -p hub/tsconfig.json`. The error count must not rise versus
  `origin/main`; CI only reports it, so you are the gate.
- **Route change:** `bun run docs:sync`, then commit `docs/openapi.json` + `docs/api.md`.
- **DB or orchestrator change:** `REMO_E2E_DB_URL=… bun run orchestrator:e2e` and `bun run migration-verify`
  against a local Postgres. If none is available, say so in the PR; CI runs them on postgres:16.
- **Supervisor:** `bun test supervisor/test/<area>*.test.ts`. CI runs only 2 supervisor test files, so
  the local run is the real gate. Rust is Windows-only; only GHA checks it.
- **Web:** `bun test web/test/<file>` (CI doesn't run these) and `bun run build:web`.
- **MCP:** `cd mcp && bun run typecheck`.
- **Deps:** `bun audit`.

**CI (mixed; poll, don't wait for webhooks):**
- Woodpecker posts commit statuses: `ci/woodpecker/pr/qc` and `ci/woodpecker/pr/docs-drift` (the
  latter only on `hub/src/**` and docs changes). GHA `supervisor-build` posts a check run on
  windows-latest, only for `supervisor/tauri/**` and `supervisor/src/**`.
- After each push, poll `pull_request_read` `get_status` + `get_check_runs`. While anything is pending,
  `send_later` 8 min out and re-poll.
- No Woodpecker status after ~10 min means a pipeline YAML error. Validate any `.woodpecker/*.yaml` you
  touched.
- CI wait is idle time, capped at 2h. At the cap, comment on the PR and end.
- Re-run a job at most once, and only to confirm a failure this PR didn't cause. "Flake" is not a root
  cause.

**Deploy verify:**
1. Find the merge SHA of the last merged PR on `main`.
2. Confirm the Coolify hub app reached that SHA and finished (Coolify MCP via lazy launcher, else skip
   this step and rely on the smoke below). Wait cap: 15 min.
3. Check the Woodpecker `post-deploy-smoke` status on the merge commit, and
   `curl https://app.remo-code.com/health` for a 2xx.
4. For changed endpoints, run `bun run smoke -- https://app.remo-code.com`.
5. Any failure is P0.

The supervisor isn't deployed by merge; it ships as a signed release on a `supervisor-v*` tag, which a
human cuts. Supervisor changes are therefore "merged, not yet on hosts"; note that in the PR.

**Coordination:** there's no claim or lock system. Before you touch an area:
- List open PRs and skip any area whose files they touch.
- Skip any area STATE.md lists as the active phase in flight by another session.
- Use one worktree per iteration off `origin/main` (CLAUDE.md mandate).

**Other conventions:**
- Branch: `routine/<yyyy-mm-dd>-<slug>`, or the harness-assigned branch.
- PR template: none. Use the body format in §2 step 7.
- Merge: AgentAutofix, squash, on green. There's no approvals check or CODEOWNERS, so don't wait on one.

## 9. Hard lines (the few that are absolute)
- Don't merge yourself; don't push to `main`.
- Don't disable, skip, or quarantine tests to get green.
- Don't commit secrets or add per-service credential env vars.
- Don't flip prod flags or allowlists: `REMO_ORCHESTRATOR_ENABLED`, `REMO_ORCHESTRATOR_AUTOSPAWN`,
  `REMO_PTY_INTERACTIVE`, `TITANIUM_BYPASS`, and `*_DISABLED`; `orchestrator_autospawn_allowlist` and
  `work_repo_allowlist`.
- Don't push `supervisor-v*` tags. Don't touch Coolify env or the prod DB.
- Don't edit this fixed core.
- Don't fix another repo's bug here; send it to `autofix-report`.
<!-- END FIXED CORE -->

<!-- TUNABLE: rewrite each iteration; log every change in the Changelog -->
## 10. Current focus and hypotheses
- No data yet. Starting hypotheses:
  - Cost and reliability are the weakest dimensions. See CONCERNS.md #1–#6 and the 2026-07 cache-read
    burn.
  - PTYCAP Phase 2 (the PTY pre-flight gate) is the highest-value roadmap item.
  - The hub typecheck (393 errors, reported but not gating) is the largest code-health lever.

## 11. Weights and thresholds
- Dimension weights: all 1.0.
- Age bonus: +0.5 per iteration, capped at +3.
- `roast_every`: 5.
- `ui_full_scan_every`: 3.
- SLO: p95 < 800ms, error rate < 1%.
- Cost runaway: 2× the trailing 7-day baseline, or the 50M/day cap within 72h.

## 12. Tactics and lessons learned
- Verify planning docs against `git log origin/main`; STATE.md is stale (last touched 2026-09-10).
- A Woodpecker YAML error posts no status at all.
- check-baseline covers `hub/test` only. Run `web/test` and `supervisor/test` yourself.
- Bun `mock.module` leaks across files; run tests per-file, the way check-baseline does.

## 13. Watch list
- Open dependabot PR `finedesignz/remo-code#481` (`@hono/zod-openapi` 0.18→0.19): watch for API
  breakage in `hub/src/api/_openapi.ts`.
- Open PR `finedesignz/remo-code#484` (cloud-host supervisor): avoid overlapping its files.

## 14. Changelog (date | change | why | which score drove it)
| 2026-09-27 | Initial directive | Bootstrap from repo discovery | n/a |
