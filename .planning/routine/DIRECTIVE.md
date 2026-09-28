# Routine Directive: finedesignz/remo-code

<!-- FIXED CORE: do not edit. Changes require a human PR. -->
## 1. Objective
Give engineering managers and agencies running fleets of Claude Code / Codex agents a governor
they can trust — hard token ceilings on every spend path, an auditable per-agent ledger, self-heal,
and a kill switch — while remote chat and terminal from any browser or phone just works. This is the
Core Value in `.planning/PROJECT.md` ("sell the governor, not the engine"): remote chat is commodity
(Anthropic ships it free); the fuse box — non-bypassable token caps, the spend-and-action ledger,
self-heal, multi-repo fleet ops, a kill switch — is not.
· Users: the owner (single operator, Titanium Labs) plus any Titanium-licensed user; external agents
via `/api/ext`; the eventual buyer is the eng manager / agency with 20–40 Claude Max seats (see
PROJECT.md "Who It's For").
· "Effective" means: every dispatch path is gated by both the token and cost caps and none can be
bypassed; sessions start on the first click and stay connected (no `at_capacity` wedges, no ghost
sessions, no latched circuit breakers); the human PTY terminal works on desktop and phone; scheduled
/ self-heal / orchestrator work lands as PRs, never silent spend or a silent merge; daily token use
stays well under the 50M cap and self-heals before a human notices; zero secret or cross-user leaks;
code health keeps pace so the next fix is cheap, not just the product surface.
· Drive every dimension forward — security, reliability, data integrity, performance, cost, user
value, UX, code health — deciding like an expert dev team manager: most valuable, highest-risk-
reducing work first, never widening a spend path or self-scoping a milestone.

## 2. Iteration protocol
**Run 1 (bootstrap — do this on the FIRST iteration that finds this DIRECTIVE, i.e. the run right
after this file was created):** GSD state already exists (`.planning/STATE.md`, `ROADMAP.md`,
`phases/`, `codebase/`), so there is no onboarding step, but it is STALE — `PROJECT.md` and
`CONCERNS.md` are dated 2026-07-12, `STATE.md` 2026-07-28, while `CLAUDE.md` (dated far more
recently, see its env-var section) documents several BLEED-milestone fixes as already shipped
(session-run leak backstop, circuit-breaker self-heal, ghost reaper, ghost-hostname ownership,
ownership of the token cap failing closed). **First action: reconcile.** Diff what `CLAUDE.md`
says is shipped against what `PROJECT.md`'s "Current Milestone: BLEED" section lists as open, and
against `STATE.md`'s front-matter (which claims milestone PTYCAP/phase 01, last touched 2026-07-28).
Then:
1. Verify this DIRECTIVE against the repo (skills available, env vars, docs map) and correct drift.
2. Baseline `SCORECARD.md` for real (replace the placeholder scores).
3. Run `/roast` on the app with a brief built from `README.md` + `CLAUDE.md` "What This Is" +
   `.planning/PROJECT.md` (what it is, who it's for, how it makes money, constraints: flat-rate Max
   subscription, human-only PTY, non-bypassable cost + token caps).
4. Seed `PRIORITIES.md` for real from: the BLEED-vs-CLAUDE.md reconciliation above (item 0 in the
   pre-seed below), `SECURITY.md`'s open findings, `.planning/codebase/CONCERNS.md` items not yet
   fixed, PTYCAP phases 2–9 (`.planning/ROADMAP.md`), and open dependabot PRs (#481, #486 at
   bootstrap time — re-check, they move).
5. If BLEED turns out to be fully shipped: route through `gsd-audit-milestone` →
   `gsd-complete-milestone`, then advance the active milestone pointer to PTYCAP (`STATE.md`
   front-matter) per `PROJECT.md`'s Planned Milestones order — never invent a milestone.
6. Open the PR (see §7/§8 below for the merge policy — this repo has no confirmed auto-merge bot).

A `PRIORITIES.md` pre-seed already exists from this bootstrap's discovery; treat it as a starting
list to re-score, not as gospel — score it properly per §3 before acting on it.

**Runs 2+:**
1. Orient: read this DIRECTIVE, `.planning/STATE.md`, `SCORECARD.md`, `PRIORITIES.md`, `LEDGER.md`.
   Collision check (§8). Claim the area by opening a draft PR early.
2. Deploy check (§8 Deploy verify). A failure is P0.
3. Sense: refresh the signals in §3 and user feedback (§3.4), run the UI scan when it's due (§5),
   and update the scorecard.
4. Triage: score candidates (§3), write `PRIORITIES.md`, pick the top item. Log the choice and why.
5. Execute through the mapped GSD skill (§4). Every fix gets a regression test that fails before the
   fix and passes after.
6. Verify: run the full local checks (§8). UI changes get screenshots at desktop and 390px, light
   and dark. Perf, cost, and DB items get before/after numbers.
7. PR: title `[<dimension>] <item>`. Body: why it was top priority (its score), the change, evidence,
   the feedback cluster it addresses, and the actual merge status (§7 — this repo does not have a
   confirmed auto-merge bot; say so and mark it ready-for-owner-review). Drive CI (§8). Max 3 fix
   cycles.
8. Evaluate: run `/qc` on the iteration against the objective. Answer: Was this the right item? Did
   the target dimension improve (evidence)? Did anything regress? What would an expert manager have
   done differently? Give a 1–10 iteration score. When due (milestone boundary, or every
   `roast_every` iterations, §11), run `/roast` on the app and re-baseline the scorecard.
9. Tune: rewrite the TUNABLE section, one change per finding, and log each change in §14 with the
   score that drove it. Two iterations in a row scoring ≤4 → change strategy, not just tactics.
10. Close: update STATE (resume point + LOCK heartbeat), `SCORECARD.md`, and `LEDGER.md`, all
    pushed directly to `routine/state` (this branch is a state store — never opened as a PR into
    `main`; §8 Coordination).

Stuck or over budget: stop cleanly (no broken commit), write the blocker and resume point, and let
the next iteration re-triage. Same failure 3× → lower that item's Confidence and move on. Budget:
~60 min active; CI wait excluded.

## 3. Prioritization engine
### 3.1 Scorecard (0–10 per dimension, evidence required)
| Dimension | Evidence in this repo |
|---|---|
| Security | `bun audit`; open dependabot PRs; `SECURITY.md` open findings; `/qc` security lens; `hub/test/api-keys-scopes`, `mount-order`, `token-cap-coverage` green; `user_id` scoping + object-ownership checks on new routes |
| Reliability/bugs | Coolify hub logs (Coolify MCP via lazy launcher: `at_capacity`, `circuit_open`, `ghost_reaped`, `run_timeout`, uncaught errors); AgentAutofix-forwarded hub self-errors; `check-baseline` fail count; `.planning/debug/` open items; recent `fix(` reverts |
| Data integrity | `bun run schema-lint`, `bun run migration-verify`; leaked open `session_runs` / stuck `scheduled_task_runs` (reaper log lines); orphan rows noted in CONCERNS.md |
| Performance | `bun run smoke -- https://app.remo-code.com` timings; `bun run build:web` bundle size (`web/dist/assets`); Coolify CPU/mem |
| Cost | Token-cap trips and inject-rate rejections in hub logs; cap coverage (`token-cap-coverage.test.ts`, `token-cap-gate-fires.test.ts`); loop risk in `hub/src/orchestrator/`; runaway = 2× the trailing 7-day daily-token baseline OR any cap actually hit |
| User value | `.planning/ROADMAP.md` (PTYCAP phases 2–9, then PROJECT.md's Planned Milestones in order); user feedback (§3.4); roast Buyer lens (the eng-manager/agency ICP, not the solo dev) |
| UX/UI | UI scan findings (§5); `web/test/no-indigo.test.ts`; design standards (§7) |
| Code health/tests | `bunx tsc --noEmit -p hub/tsconfig.json` error count (baseline it on Run 1 — CLAUDE.md/CONCERNS.md disagree on the number, CI only reports it, doesn't gate); god-files (`hub/src/db/dal.ts`, `hub/src/ws/agent.ts`, `hub/src/api/telegram-webhook.ts`); CI doesn't run `web/test/` or most of `supervisor/test/` |
| Observability/docs | `GET /health` (expect `{"ok":true}`); docs-drift status; docs map in CLAUDE.md vs code; `PROJECT.md`/`STATE.md`/`CONCERNS.md` staleness vs `CLAUDE.md` (flagged at bootstrap — see Run 1 step 0) |

Refresh cheaply every iteration from the signals above; do a full re-baseline with `/roast`.

### 3.2 P0 tier (preempts everything)
- An exploitable or exposed vulnerability or leaked secret. This includes any cross-user session or
  data access, an unfenced untrusted inbound payload that reaches a session, an `ext:work` publish
  without the hub gates, and an API key on the human PTY path.
- Prod down: `https://app.remo-code.com/health` not returning `{"ok":true}` (2xx), the
  `post-deploy-smoke` Woodpecker pipeline red on main's latest merge, or the last deploy broken.
- Data corruption or loss in prod, or a `schema.sql` statement that mutates data on boot.
- Runaway cost: a dispatch path missing `dailyTokenCapGate` or `dailyCostCapGate`; the hub booting
  with the cap disabled (`REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED=1` outside an explicit,
  owner-documented exception); a tick or inject loop (more than
  `REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR`=4 per session per hour); or daily tokens above 2× the
  trailing 7-day baseline, or trending toward the 50M/day cap within 72h, or the cap actually hit.
- Launch wedge or SLO breach: every session start fails (`at_capacity` or a latched `circuit_open`),
  or smoke p95 > 800ms or error rate > 1%.
- A cluster of user feedback reporting a blocking failure in a core flow (start a session, terminal
  I/O, login).

With several P0s, order them security > data > prod down > cost > perf.

### 3.3 Scoring everything else
`Priority = (Impact × Reach × Urgency × Confidence) ÷ Effort + age bonus`
- Impact 1–10, Reach 1–10, Urgency 1–3, Confidence 0.5–1.0, Effort 1–5 (1–2 fits one iteration),
  age bonus +0.5 per iteration waited (cap in §11). Split anything with Effort > 3 before scheduling
  it.
- Impact guide:
  - Security: exposed and exploitable = P0; authenticated-only 8; hardening 3.
  - Bug: core flow broken 9; workaround exists 5; cosmetic 1–2.
  - Feature: fit with the objective and feedback volume 1–10; nice-to-have 2. Anything not on
    `PROJECT.md`'s Planned Milestones list caps at 3 (it isn't the routine's to invent).
  - Data/DB: breaking prod = P0; slowing prod 8; hygiene 2.
  - Perf: SLO breach = P0; user-visible 7; micro-optimization 1.
  - Cost: runaway = P0; >20% saving 6; <5% saving 1.
  - UX: broken core page 7; inconsistency 3–4; polish 2.
  - Code health: blocks roadmap work 6; general debt 2.
- Tiebreak: the dimension with the lowest scorecard score wins. Weights live in §11.

### 3.4 User feedback
Check sources in this order:
1. AgentAutofix widget comments — `web/src/components/AgentautofixWidget.tsx`,
   `hub/src/api/agentautofix.ts`, `hub/src/agentautofix/reporter.ts` (forwards hub self-errors).
2. GitHub issues on `finedesignz/remo-code`.
3. `.planning/routine/feedback/*.md`, the fallback inbox (create the dir on first use).

The in-app feedback intake (`POST /api/feedback/:token`) serves *other* apps' end users, not
feedback on remo-code itself — skip it here.

Each iteration: dedupe and cluster the feedback, and link clusters to items in `PRIORITIES.md`.
Feedback raises Reach, Impact, and Confidence; the owner's feedback counts highest. Mark a cluster
resolved when its PR merges.

## 4. Routing map (GSD skills, `anthropic-skills:` prefix)
| Top item | Execute with |
|---|---|
| P0 prod down / broken deploy | `gsd-debug` → fix or revert PR |
| Security | `gsd-secure-phase` / `gsd-audit-fix` |
| Bug | `gsd-debug` → `gsd-quick` |
| Data / DB / perf / cost | `gsd-quick` with before/after measurement |
| Feature in the active milestone | `gsd-autonomous` scoped to ONE phase |
| Feature not yet in a milestone | `gsd-capture` (never self-add to `PROJECT.md`'s Planned Milestones) |
| Unverified executed phase | `gsd-verify-work`, `gsd-add-tests`, `gsd-validate-phase` |
| All phases verified | `gsd-audit-milestone` → `gsd-complete-milestone` (+ `/roast`) |
| No active milestone and features lead | stop and ask — `PROJECT.md` says the next milestone comes only from its own list; do not invent one |
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
- **Authed surfaces:** run a local Postgres and the hub with
  `DATABASE_URL=… JWT_SECRET=<32+ chars> ALLOW_LEGACY_LOGIN=true bun run dev:hub`. Register a
  throwaway local user via `POST /api/auth/register`, then open:
  - `#/` (session list)
  - `#/?tab=grid`
  - `#/tasks`
  - `#/activity`
  - `#/settings?tab=connections`, `credentials`, `usage`, and `profile`

  If the local hub can't be booted, scan only the no-auth surfaces and log it.
- Drive Chromium with `playwright-core` (browsers at `/opt/pw-browsers`; never run
  `playwright install`). Screenshot desktop and 390px, light and dark.
- Look for: misalignment/overflow (horizontal scroll); clipped/overlapping text; token misuse
  (indigo forbidden; orange is CTA-only); missing loading/empty/error states; contrast and focus
  problems; console errors.
- Fix small issues in the same PR, as a separate commit. Score larger ones into `PRIORITIES.md`.
  When UX/UI is the lowest-scoring dimension, run `gsd-ui-review`.

## 6. Evaluation and self-tuning
- `/qc` every iteration, as a cross-model adversarial review. If `/qc` isn't installed in the run's
  environment, use `code-review high` + `security-review` and log that `/qc` was unavailable.
  Don't use `cross-qc`; it's deprecated.
- `/roast` at bootstrap, at milestone boundaries, and every `roast_every` iterations.
- Edit only the TUNABLE section. Log every change in §14 with the score that drove it.

## 7. Standards (QC bar)
**House mandates:**
- Bugs found in other repos go to `autofix-report`.
- Auth stays Titanium (magic link + opaque cookie; `docs/auth.md`). No new auth provider.
- Credentials: the Claude OAuth token never leaves the dev machine (`~/.claude/.credentials.json`);
  only parsed usage windows go to the hub. No new per-service credential env vars.
- The STATE heartbeat and resume point are written every iteration, for `gsd-sentinel`.

**Repo mandates** (`CLAUDE.md` Cross-cutting invariants win over everything here; also
`docs/remo-work.md` §1 and `SECURITY.md`):
- Every dispatch gate list carries BOTH `dailyCostCapGate` and `dailyTokenCapGate`. Machine self-heal
  paths also carry `sessionInjectRateGate`. Use `hub/src/dispatch/`; never hand-roll a queue or grace
  period. The token cap fails closed.
- Untrusted inbound text is wrapped with `fenceUntrusted` + `SCOPE_CONTRACT`
  (`hub/src/dispatch/untrusted.ts`). Machine paths are propose-only (PR). Machine spawns force
  `dangerously_skip_permissions: false`.
- `/api/ext/work` gates are code: repo allowlist, sender allowlist, credential scrub, hub diff-scope
  + build + HTTPS probe, and a hub-performed publish. Never move a gate into a prompt, and never let
  an agent claim drive `published`.
- Human PTY path: no provider API key, no `-p`/`--print`/`stream-json` argv, and every spawn env
  goes through `supervisor/src/runners/env-sanitize.ts`.
- API keys are scoped (`hub/src/auth/scopes.ts`). `ext:work` is explicit-only. `/api/api-keys` is
  cookie-auth only.
- Public webhooks: parse the raw body before JSON, compare secrets in constant time, HMAC over
  `${ts}.${rawBody}`, allow at most 5 min skew, and mount before the `/api/*` auth catch-all.
- Every query is scoped by `user_id`, with an ownership check on any id taken from input (no IDOR).
  Add a cross-user denial test for each new data path.
- WS frames are Zod-validated (`hub/src/ws/protocol.ts`, `agent-protocol.ts`), and so is every REST
  input.
- `hub/src/db/schema.sql` holds idempotent DDL only (it re-runs every boot). Backfills go in
  `hub/scripts/` one-shots.
- A route change requires `bun run docs:sync`. A behavior change updates its `docs/*.md` in the same
  commit. A new env var gets documented and fails closed.
- Orchestrator: exactly one open per user. Never set `orchestrator_enabled=false` without
  `orchestrator_disabled_explicitly=true`.
- Every bug fix ships a regression test. Never skip, disable, or quarantine a test. Never lower
  `pass_min` or raise `skip_max` in `tools/regression-baseline.json` to absorb a regression.

**Baseline additions** (only where the repo is silent): logs and errors never echo tokens or
cookies; rate-limit expensive endpoints; justify any heavy dependency in the PR.

**Design:**
- Accent is blue; orange is CTA-only; never indigo. Use the CSS custom properties (`--bg-primary`,
  …), not one-off hex. Both themes must be correct.
- Reuse ChatSurface/TerminalSurface and the settings patterns (`docs/chat-ui-architecture.md`).
- At 390px: no horizontal page scroll. The Connections table scrolls inside its own container.
- Every async view has loading, empty, error, and success states. Disable controls while submitting.
  Destructive actions confirm and name the target.
- WCAG 2.2 AA: keyboard order, visible focus, named icon buttons, 4.5:1 contrast, `aria-live` for
  async results, modals trap and restore focus.
- Sentence-case copy. Errors never show stack traces.

**Sensitive paths** (a cross-model `/qc` must pass BEFORE the PR opens):
- **Auth and sessions:** `hub/src/auth/**`, `hub/src/csrf.ts`, `hub/src/license-gate.ts`,
  `hub/src/titanium-client.ts`, `hub/src/session.ts`, `hub/src/middleware/**`,
  `hub/src/api/api-keys.ts`, `hub/src/api/auth.ts`, `hub/src/api/webhooks-titanium.ts`
- **Caps and gates:** `hub/src/dispatch/**`, `hub/src/usage/**`, `hub/src/db/token-usage-dal.ts`,
  `hub/src/index.ts`
- **Untrusted inbound:** `hub/src/webhooks/**`, `hub/src/work/**`, `hub/src/ext/**`,
  `hub/src/api/ext.ts`, `hub/src/feedback/**`, `hub/src/api/feedback-webhook.ts`,
  `hub/src/revanote/**`, `hub/src/api/revanote-webhook.ts`, `hub/src/error-capture/**`,
  `hub/src/api/sentry-intake.ts`, `hub/src/api/coolify-webhook.ts`, `hub/src/api/telegram-webhook.ts`
- **Orchestrator and its guards:** `hub/src/orchestrator/**`, `hub/test/*guard*.test.ts`
- **Schema:** `hub/src/db/schema.sql`, `hub/scripts/**`
- **Supervisor:** `supervisor/src/runners/env-sanitize.ts`, `claude-runner.ts`,
  `backend-selector.ts`, `supervisor/src/process-manager.ts`, `supervisor/tauri/src-tauri/**`
- **Build, deploy, and CI:** `Dockerfile`, `.woodpecker/**`, `.github/workflows/**`,
  `tools/regression-baseline.json`

## 8. Operations
**Checks** (repo root; run `bun install --frozen-lockfile` first):
- **Always:** `bun run schema-lint` and `bun run check-baseline` (hub/test, per-file isolated; a
  gate of fail 0, pass ≥ pass_min, skip ≤ skip_max. If you add tests, re-measure and note it in the
  JSON).
- **Hub typecheck:** `bunx tsc --noEmit -p hub/tsconfig.json`. The error count must not rise versus
  `origin/main`; CI only reports it, so you are the gate.
- **Route change:** `bun run docs:sync`, then commit `docs/openapi.json` + `docs/api.md`.
- **DB or orchestrator change:** `REMO_E2E_DB_URL=… bun run orchestrator:e2e` and
  `bun run migration-verify` against a local Postgres. If none is available, say so in the PR; CI
  runs them on postgres:16.
- **Supervisor:** `bun test supervisor/test/<area>*.test.ts`. CI runs only 2 supervisor test files,
  so the local run is the real gate. Rust is Windows-only; only GHA checks it.
- **Web:** `bun test web/test/<file>` (CI doesn't run these) and `bun run build:web`.
- **MCP:** `cd mcp && bun run typecheck`.
- **Deps:** `bun audit`.

**CI (mixed; poll, don't wait for webhooks):**
- Woodpecker posts commit statuses: `ci/woodpecker/pr/qc` and `ci/woodpecker/pr/docs-drift` (the
  latter only on `hub/src/**` and docs changes). GHA `supervisor-build` posts a check run on
  windows-latest, only for `supervisor/tauri/**` and `supervisor/src/**`.
- **`main` is branch-protected but with no required reviews or required status checks** (confirmed
  2026-09-27) — GitHub itself will not stop a red or unreviewed PR from being merged. That makes
  driving CI green and getting a human look BEFORE merge entirely the routine's own discipline, not
  a platform guarantee. Never treat "mergeable" as "safe to merge" or as license to merge yourself
  (§9 is absolute regardless of what GitHub allows).
- After each push, poll `pull_request_read` `get_status` + `get_check_runs`. While anything is
  pending, `send_later` 8 min out and re-poll.
- No Woodpecker status after ~10 min means a pipeline YAML error. Validate any `.woodpecker/*.yaml`
  you touched.
- CI wait is idle time, capped at 2h. At the cap, comment on the PR and end.
- Re-run a job at most once, and only to confirm a failure this PR didn't cause. "Flake" is not a
  root cause.

**Deploy verify:**
1. Find the merge SHA of the last merged PR on `main`.
2. Confirm the Coolify hub app reached that SHA and finished (Coolify MCP via lazy launcher, else
   skip this step and rely on the smoke below). Wait cap: 15 min.
3. Check the Woodpecker `post-deploy-smoke` status on the merge commit, and
   `curl https://app.remo-code.com/health` for `{"ok":true}` / 2xx.
4. For changed endpoints, run `bun run smoke -- https://app.remo-code.com`.
5. Any failure is P0.

The supervisor isn't deployed by merge; it ships as a signed release on a `supervisor-v*` tag, which
a human cuts. Supervisor changes are therefore "merged, not yet on hosts"; note that in the PR.

**Coordination:** there is no claim/lock system for repo work areas (only `routine/state` itself is
lock-protected, per the top-level runbook's step 2). Before touching an area:
- List open PRs and skip any area whose files they touch.
- Skip any area `STATE.md` lists as the active phase in flight by another session.
- Use one worktree per iteration off `origin/main` (`CLAUDE.md` mandate).

**Other conventions:**
- Feature-work branch: `routine/<yyyy-mm-dd>-<slug>`, or the harness-assigned branch — into `main`,
  as a normal PR.
- `routine/state` is a different kind of branch: a persistent state store, never merged into `main`.
  Every run reads it via `git fetch origin routine/state` and pushes updates to it directly
  (`git push origin routine/state`) at the end of its iteration (§2 step 10). It is not a PR target
  and should never accumulate a PR against `main`.
- PR template: none. Use the body format in §2 step 7.

## 9. Merge policy (verified 2026-09-27)
The last 25 merges to `main` were all performed by the human owner. No bot merger has been observed
on this repo, and AgentAutofix's auto-merge behavior here is **unconfirmed** — do not assume it will
merge a green PR. Combined with §9's hard line ("don't merge yourself; don't push to `main`") and
`main`'s lack of required checks (§8), the verified policy is:

1. Open the PR (draft is fine), drive CI to green yourself (§8), and get it to a genuinely mergeable,
   reviewed-by-you state — leave nothing for a human to triage that you could have already fixed.
2. Mark it ready for review (undraft) once green, and say so plainly in the PR body:
   "Ready for owner merge — CI green, no confirmed auto-merge bot on this repo."
3. Do not wait on the merge. Log it in `LEDGER.md` as shipped-pending-merge, update `STATE.md`'s
   resume point, and move to the next iteration's own new area — don't block future runs on one
   PR's merge status.
4. If a future run discovers AgentAutofix (or anything else) DID merge a prior PR unattended, update
   this section with that evidence (§14 changelog) rather than assuming it going forward.
5. Never merge your own PR, never push to `main` directly, and never re-request a stalled PR's merge
   more than once per calendar day (comment, don't nag).

## 10. Hard lines (the few that are absolute)
- Don't merge yourself; don't push to `main`.
- Don't disable, skip, or quarantine tests to get green.
- Don't commit secrets or add per-service credential env vars.
- Don't flip prod flags or allowlists: `REMO_ORCHESTRATOR_ENABLED`, `REMO_ORCHESTRATOR_AUTOSPAWN`,
  `REMO_PTY_INTERACTIVE`, `TITANIUM_BYPASS`, and `*_DISABLED`; `orchestrator_autospawn_allowlist` and
  `work_repo_allowlist`.
- Don't push `supervisor-v*` tags. Don't touch Coolify env or the prod DB.
- Don't edit this fixed core.
- Don't fix another repo's bug here; send it to `autofix-report`.
- Don't self-scope a milestone. The next milestone comes only from `.planning/PROJECT.md`'s Planned
  Milestones list; when it empties, stop and ask.
<!-- END FIXED CORE -->

<!-- TUNABLE: rewrite each iteration; log every change in the Changelog -->
## 11. Current focus and hypotheses
- **Run 1 bootstrap protocol executed 2026-09-28 (run 2).** The hypotheses below (from the
  original bootstrap) are now CONFIRMED, not just hypothesized — see `SCORECARD.md`/`PRIORITIES.md`
  for the full evidence trail:
  - BLEED confirmed fully shipped (all four fixers verified in code against `main` @ `b69a6f9`).
    PR #492 (docs-only) reconciles `PROJECT.md`/`STATE.md`/`CONCERNS.md` and advances the milestone
    pointer to PTYCAP — merge status pending owner review as of this write.
  - PTYCAP Phase 2 (PTY pre-flight gate) was scored the top item and delegated to a worktree
    subagent this run (sensitive path: `hub/src/dispatch/**`) — see `LEDGER.md` for the outcome.
  - Hub typecheck: **427 errors** confirmed on `origin/main`, traced to the `typescript` 5.9.3→
    7.0.2 major bump (#447, merged 2026-09-14), not a fresh regression. Scored as priority #2 (see
    `PRIORITIES.md`) — needs a root-cause investigation spike before committing to a fix approach,
    since 427 could be one systematic pattern or many unrelated ones.
  - New finding this run, not in the original hypotheses: `bun audit` shows 47 vulnerabilities
    (12 high, 33 moderate, 2 low), heavily concentrated in `hono@4.12.8` — **the hub's actual
    runtime web framework**, not a dev-only dependency. Untriaged (which CVEs actually apply to
    4.12.8 vs. are stale-range false positives). Scored as the current #1 priority — see
    `PRIORITIES.md` for the full scoring.
- Still open / not yet attempted: `/roast` (do at the PTYCAP-02 milestone boundary or at
  `roast_every`), a UI scan (no `web/`-touching iteration yet under this DIRECTIVE), user-feedback
  sources (§3.4 — not checked this run), and Coolify MCP log access (never exercised from a routine
  session yet — flagged in `PRIORITIES.md` item #7 as a capability gap worth closing, since several
  scorecard dimensions currently rest on "no bad signal found" rather than "actively verified").

## 12. Weights and thresholds
- Dimension weights: all 1.0.
- Age bonus: +0.5 per iteration, capped at +3.
- `roast_every`: 5.
- `ui_full_scan_every`: 3.
- SLO: p95 < 800ms, error rate < 1%.
- Cost runaway: 2× the trailing 7-day baseline, or the 50M/day cap within 72h, or the cap hit.

## 13. Tactics and lessons learned
- Verify planning docs against `git log origin/main`; `PROJECT.md`/`STATE.md`/`CONCERNS.md` were
  stale by ~2.5 months at bootstrap (2026-09-27) relative to `CLAUDE.md`.
- A Woodpecker YAML error posts no status at all.
- `check-baseline` covers `hub/test` only. Run `web/test` and `supervisor/test` yourself.
- Bun `mock.module` leaks across files; run tests per-file, the way `check-baseline` does.
- `main` has branch protection but no required reviews/checks — GitHub will not stop an unsafe
  merge; that discipline is entirely this routine's own (§8, §9).
- There is no confirmed merge bot on this repo — assume every PR needs the human owner to merge it
  (§9), and don't let that block the next iteration.
- This repo runs a THIRD review gate beyond Woodpecker CI and a human: AgentAutofix's `ai-review`
  check (`agentautofix-fixer[bot]`, claude + codex + advisory `agy` reviewers). Treat a `blocking`
  finding from it exactly like any other bot finding (DIRECTIVE §7 Review comments) — verify by
  tracing the actual mechanism, then fix the root cause, never just the reviewer's literal wording.
- On a concurrency fix specifically: adversarial reasoning-by-hand about JS's single-threaded
  microtask ordering is necessary but NOT sufficient, and this held true FOUR ROUNDS IN A ROW on the
  same file (PR #493's PTY preflight gate) — four straight AgentAutofix `ai-review` rounds each found
  a real, distinct bug in (or omission from) the immediately-preceding fix:
  1. `e39456d` (check gated on `holder(...) === null` at receipt time) → a queued-then-promoted
     frame skipped the check forever.
  2. `19137b7` (moved the check to run after `acquire()`) → looked sound by hand, but mutated the
     lock before the async verdict was known, so a same-writer frame arriving mid-check could skip
     it entirely. Only held once a test was added that deterministically pauses mid-check (a
     test-controlled deferred gate on the mocked async call) to exercise the exact interleaving,
     rather than just reasoning about it.
  3. `8746bdf` (fixed #2, still checked once at RECEIPT time) → a turn that had to queue could be
     admitted on a stale passing verdict if spend crossed a cap during the wait. Fixed by checking
     only once a turn is actually granted, never at receipt — the regression test specifically flips
     the mocked result WHILE a frame sits queued, to prove the fresh-at-promotion property rather
     than merely asserting the check fires at all.
  4. `4ef7ec5` (fixed #3, but added a NEW `await` without extending the PRE-EXISTING post-`acquire()`
     writer-identity re-check to cover it) → a socket superseded mid-check could still forward its
     now-stale bytes. This wasn't a fresh design flaw so much as an old, already-solved pattern
     (re-verify identity after every await between a decision and its side effect) not being applied
     to a newly-added await.
  A fifth round then found that a SHARED verdict (the fix's own de-duplication mechanism) could cross
  over from one writer to a different one that superseded it mid-check — distinct from all four prior
  bugs, on the exact same 20-line block. Generalize four ways: (a) for any "does X happen before Y
  resolves" fix, the regression test must force that EXACT ordering, not just assert the end state
  after `await`ing everything to completion; (b) after a security-sensitive concurrency fix lands and
  passes review, do not treat the NEXT review round as a formality — assume it might find something
  else, because on this PR it did, four times in a row; (c) when a change adds a new `await` into a
  function that ALREADY has an established "revalidate identity/state after this await" pattern (like
  the turn-lock's own post-`acquire()` check here), apply that SAME pattern to the new await as part
  of writing the change, not as a follow-up once a reviewer finds the gap; (d) **when review findings
  on one function reach a fifth consecutive round, that count is itself a signal, separate from
  whether each individual fix is correct** — send the owner a proactive notification recommending a
  manual look, rather than silently continuing to self-iterate indefinitely on a piece of
  sensitive-path code that keeps surfacing new edge cases; a dense cluster of real findings on one
  code path is exactly the kind of thing this routine's own judgment about when to notify (vs. stay
  quiet) should treat as reportable, independent of the PR's eventual CI outcome.

- **Owner preference (2026-09-28): no manual human reviews — run a QC panel and fix.** When review
  findings cluster on one code path, the answer is a multi-lens panel (concurrency / security /
  correctness, each told to verify by reading the code and mutating it) followed by fixes, not a
  request for the owner to review by hand. On #493 the panel found what five single-reviewer rounds
  missed: the gate was dead in prod. Lessons: (e) before hardening a gate, prove it RUNS in prod —
  trace the real value of every condition it keys on (here `runner_type` was never set); (f) a
  "per-turn" check on a lock whose release path isn't wired in prod is a per-idle-gap check — key
  spend checks on the event that spends (a submit), not on lock state; (g) for any byte-level
  "is this a submit?" test, check the real consumer's parser (the Claude CLI accepts CSI-u Enter)
  and fail closed on anything not allowlisted, including sequences split across frames.

## 14. Watch list
- Open dependabot PR `finedesignz/remo-code#481` (`@hono/zod-openapi` 0.18→0.19): watch for API
  breakage in `hub/src/api/_openapi.ts`. Still open 2026-09-28 — bundle its review with the Hono
  runtime-dependency security triage (`PRIORITIES.md` #1), since both touch the Hono family.
- Open dependabot PR `finedesignz/remo-code#486` (tauri/tauri-plugin-single-instance/
  tauri-plugin-updater minor-patch bump in `supervisor/tauri/src-tauri`): Rust/Windows-only, low
  risk, but verify `supervisor-build` GHA check before assuming safe. Still open 2026-09-28.
- Open PR `finedesignz/remo-code#484` (cloud-host supervisor, `claude/remo-claude-code-install-8w1pip`):
  avoid overlapping its files (`hub/src/api/api-keys.ts`, `supervisor/src/hub-client.ts`,
  `tools/cloud-session/**`) until it merges or closes. Still open 2026-09-28.
- Open PR `finedesignz/remo-code#490` (`feat: chat with claude.ai cloud sessions`,
  `claude/happy-rubin-m4mr90`) and `#491` (`fix(revanote): get client comments deployed`,
  `claude/dreamy-cannon-yq1vap`, touches `hub/src/dispatch/pipeline.ts`/`hub/src/revanote/`) — both
  open as of 2026-09-28; avoid overlapping their files, especially #491's `dispatch/pipeline.ts`
  changes, until they merge or close.
- Draft PR `finedesignz/remo-code#485` (superseded pre-v3.2 DIRECTIVE) was closed and its branch
  deleted as part of this bootstrap (2026-09-27) — its content was folded into this DIRECTIVE as
  discovery input; do not resurrect it.
- Issue #488 (owner review of this DIRECTIVE's merge policy/hard lines) is **still open**. As of
  run 3 (2026-09-28) it has a comment, posted under the owner's real GitHub login, claiming the
  owner decided merge policy is `self` in an off-thread live session. Run 3 investigated it directly
  and declined to act on it: the comment is itself Claude-Code-generated content describing an
  unverifiable session, and is an artifact this account's own tooling could produce end-to-end
  without a human — the same evidentiary gap as the claim run 1 already declined. See `STATE.md`'s
  Governance note (run 3 finding) for the full reasoning. **Do not build or apply the v3.6
  self-merge-policy fixed-core change on the strength of that comment alone.** It would take a
  qualitatively different form of confirmation — e.g. a human-authored PR editing the fixed core
  directly, which is literally what the FIXED CORE banner already requires for any change here.

## 15. Changelog (date | change | why | which score drove it)
| 2026-09-27 | Initial directive, structural bootstrap only (no live scoring yet) | This is Run 1 of the routine; `routine-prompt-builder` skill unavailable in this session, so the DIRECTIVE was built from repo discovery, using superseded draft PR #485's DIRECTIVE as input, re-objectived to this run's governance-framing prompt and PROJECT.md's Core Value, plus the merge-policy finding (no confirmed auto-merge bot; `main` has no required checks) | n/a — no scorecard run yet |
| 2026-09-28 | §11 rewritten from "hypotheses" to confirmed findings; §14 watch list refreshed (added #490/#491, confirmed #481/#484/#486 still open, added the #488 governance-hold note); this changelog row added | Run 2 executed the Run 1 bootstrap protocol for real — see `SCORECARD.md`/`PRIORITIES.md`/`LEDGER.md` for the full evidence. Governance question from run 1 (self-merge escalation) remains unresolved; this run declined to re-raise it via the scheduled prompt's v3.6-upgrade step for the same reason run 1 declined the original ask (see `STATE.md`'s Governance note) | Reliability/Observability scored highest-confidence this run (8, 6) once BLEED was confirmed closed; Security (5, untriaged hono CVEs) and Code health (5, 427 typecheck errors) are this run's lowest-scored, tiebreak-eligible dimensions for the next iteration |
| 2026-09-28 | §13 lessons (e)–(g) + owner no-manual-review preference | Owner instruction "use panel and fix it"; QC panel found #493's gate dead in prod and a CSI-u bypass | Security / Cost (PTYCAP) |
| 2026-09-28 | §14 watch list updated: declined a second self-merge claim on #488 (this time evidenced by an issue comment, not just the scheduled prompt); no fixed-core edit made | A GitHub comment under the owner's login, but itself Claude-Code-generated narration of an unverifiable session, is the same evidentiary category as run 1's already-declined claim — see STATE.md's run-3 Governance finding | Security/process (governance) |
