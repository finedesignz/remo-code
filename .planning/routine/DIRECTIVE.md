# Routine Directive: finedesignz/remo-code

<!-- FIXED CORE: do not edit. Changes require a human PR. -->

## 1. Objective
Governance and reliability layer for fleets of coding agents (see `.planning/PROJECT.md` → Core Value).
**Users:** eng managers / agencies with many Claude Max seats (buyer); solo devs self-hosting (funnel).
**"Effective" means:**
- Every spend path is token-capped and proven to fire (`hub/test/token-cap-coverage.test.ts` + `token-cap-gate-fires` green).
- Sessions start and stay up: no `at_capacity` wedges, breakers close, reapers reap, prod `/health` 200.
- Owner milestones advance in order (PROJECT.md → Planned Milestones); PTYCAP blocks everything else.
- Remote terminal/chat works on desktop and phone; end-user feedback gets resolved.

## 2. Iteration protocol
**Run 1 (bootstrap):**
1. Read CLAUDE.md, PROJECT.md, ROADMAP.md, STATE.md, `git log -50`. Code wins over stale status docs.
   Known drift at authoring (2026-09-26): STATE.md says PTYCAP-01 "executing, 2026-07-28", but
   PTYCAP-01 merged in #395 (2026-09-10), has 4/4 SUMMARYs and **no VERIFICATION.md**.
2. Create `.planning/routine/{SCORECARD,PRIORITIES,LEDGER}.md` and `feedback/`. Baseline the
   scorecard (§3.1) with evidence.
3. `/roast` the app ("just run it"; brief = PROJECT.md "What This Is / Core Value / Who It's For",
   open-core pricing, Position on Anthropic, constraints in §9).
4. Seed PRIORITIES from the roast, the watch list (§13), and the roadmap. PR: `[routine] bootstrap`.

**Runs 2+:**
1. **Orient:** read this file, STATE, SCORECARD, PRIORITIES, LEDGER. List open PRs on
   `finedesignz/remo-code`; skip any item whose files an open PR already touches (collision).
2. **Deploy check** (§8). Failure → P0.
3. **Sense:** refresh signals (§3.4) and feedback; UI scan when due (§5); update SCORECARD.
4. **Triage:** score candidates (§3), write PRIORITIES, pick the top item. Log choice + score.
5. **Execute** via the mapped GSD skill (§4) on a branch off `origin/main`
   (`<type>/<slug>`; CLAUDE.md worktree rule applies on a shared checkout). Every fix gets a
   regression test.
6. **Verify:** all checks for touched areas (§8). UI: screenshots desktop + 390px, light + dark.
   Perf/cost/DB: before/after numbers. tsc error count must not rise (ratchet, §8).
7. **PR:** title `[<dimension>] <item>`; body = why it was top (score), change, evidence, feedback
   cluster addressed, "needs signed supervisor MSI" if `supervisor/**` changed, "AAF merges on
   green". Drive CI (§8); max **3** fix-push cycles.
8. **Evaluate** (§6).
9. **Tune** (§6).
10. **Close:** update STATE.md (heartbeat + resume point), SCORECARD, LEDGER; release claims.

**Stuck / over budget:** stop cleanly (no broken commit), write blocker + resume point, let the
next run re-triage. Same failure 3× → lower that item's Confidence and move on.

## 3. Prioritization engine

### 3.1 Scorecard (0–10, evidence required)
| Dimension | Evidence here |
|---|---|
| Security | `bun audit`, open Dependabot/Renovate security PRs, `/qc` security lens, invariants in CLAUDE.md "Cross-cutting invariants", SECURITY.md |
| Reliability | AAF forwarded errors, Coolify hub logs, post-deploy smoke status, reaper/breaker behavior, failing tests |
| Data integrity | `bun run schema-lint`, `bun run migration-verify`, schema.sql idempotency, user_id scoping |
| Performance | smoke timings, Coolify CPU/mem, web bundle size (`web/dist`) |
| Cost | token caps on every gate list, `token_usage` trend (if reachable), CI minutes (GHA Windows = 2×) |
| User value | ROADMAP/PROJECT milestone progress, AAF widget comments, GitHub issues, roast Buyer |
| UX/UI | UI scan (§5), design rules (§7) |
| Code health | tsc error count (hub), tests not in CI, check-baseline headroom |
| Observability/docs | `/health`, `/openapi.json` + `/docs`, docs-drift, Docs-map docs updated with behavior |

### 3.2 P0 (preempts everything)
- Exploitable vuln, leaked secret, or a broken invariant: ungated dispatch path, API key reaching
  the PTY path, untrusted inbound text gaining trust, api key able to mint api keys.
- Prod down: `https://app.remo-code.com/health` not `{ok:true}`, smoke red, last deploy failed.
- Data corruption/loss, or a non-idempotent statement in `hub/src/db/schema.sql`.
- Runaway spend: daily tokens > **2×** trailing-7-day, any token-cap hit, or cap config disabled.
- SLO breach (p95 > **800 ms** or error rate > **1%**) once a measurement source exists.
- Feedback cluster reporting a blocking failure in a core flow (sign-in, start session, terminal I/O).
Order: security > data > prod down > cost > perf.

### 3.3 Scoring
`Priority = (Impact × Reach × Urgency × Confidence) ÷ Effort + age bonus`
Impact 1–10 · Reach 1–10 · Urgency 1–3 · Confidence 0.5–1.0 · Effort 1–5 (>3 → split) · age +0.5/iteration (cap §11).
Impact guide: exposed exploit = P0, auth-only exploit 8, hardening 3 · core-flow bug 9, workaround 5,
cosmetic 1–2 · feature by objective fit 1–10 · DB breaking prod = P0, slowing 8, hygiene 2 · SLO
breach = P0, visible slowness 7 · runaway cost = P0, >20% savings 6 · broken core page 7,
inconsistency 3–4 · debt blocking roadmap 6, general debt 2.
**Roadmap rule:** the next unblocked PTYCAP phase is a candidate every run with Impact ≥ 8.
Tie-break: lowest scorecard dimension wins.

### 3.4 Signal sources
| Signal | Source |
|---|---|
| Errors | AAF forwarded errors (hub self-capture → `hub/src/agentautofix/reporter.ts`); Coolify hub logs (Coolify MCP via lazy launcher) |
| Deps | `bun audit` (root); open Dependabot/Renovate PRs |
| Deploy/perf | Coolify deployment status + metrics; Woodpecker `post-deploy-smoke` on main |
| Cost | `GET /api/usage/cost` only if an authenticated route is provisioned for the routine; else **none yet: skip** (never mint a key yourself) |
| Slow queries / p95 | **none yet: skip** |
| Feedback | see 3.5 |
| Roadmap | `.planning/ROADMAP.md` (PTYCAP), `.planning/PROJECT.md` Planned Milestones |

### 3.5 User feedback
Sources in order: AAF widget comments (widget live in `web/src/components/AgentautofixWidget.tsx`),
GitHub issues on `finedesignz/remo-code`, remo-code's own feedback intake if a `feedback_keys` row
exists for this app, then `.planning/routine/feedback/*.md` (fallback inbox).
Each run: pull new, dedupe, cluster, link to PRIORITIES. Feedback raises Reach (distinct users),
Impact (blocking vs annoyance), Confidence (real users > hunch). PR body names the cluster; mark
resolved on merge. When the feedback system ships, plug it in here.

## 4. Routing map
| Top item | Execute with |
|---|---|
| P0 prod down / broken deploy | `gsd-debug` → fix or revert PR |
| Security | `gsd-secure-phase` / `gsd-audit-fix` |
| Bug | `gsd-debug` → `gsd-quick` |
| Data / DB / perf / cost | `gsd-quick` with before/after measurement |
| Unverified executed phase (PTYCAP-01 now) | `gsd-verify-work` → `gsd-validate-phase` / `gsd-add-tests` |
| Next PTYCAP phase (strictly serial 1→6) | `gsd-discuss-phase` → `gsd-plan-phase` → `gsd-execute-phase`, ONE phase per run (or `gsd-autonomous` scoped to one phase) |
| All milestone phases verified | `gsd-audit-milestone` → `gsd-complete-milestone` (+ `/roast`) |
| No active milestone | `gsd-new-milestone` with the NEXT item from PROJECT.md Planned Milestones only (gate-panel) |
| Feature not on roadmap | `gsd-capture` to backlog; never promote it to a milestone |
| UI issue | `gsd-ui-review` audit; `gsd-quick` fix |
| Code-health ratchet (tsc, tests not in CI) | `gsd-quick` |
| Tiny/obvious | `gsd-fast` |
No matching skill → plan, implement via a Sonnet subagent, same test/QC bar.

## 5. UI scan
- Cadence: touched pages every run; full key-route scan every **3** runs (tunable).
- Run: Postgres 16 locally (apt or docker); `bun install`; `DATABASE_URL=… JWT_SECRET=<32+ chars>
  ALLOW_LEGACY_LOGIN=true TITANIUM_BYPASS=true bun run dev:hub` (3040) + `bun run dev:web` (5173,
  `VITE_HUB_URL=http://localhost:3040`); `POST /api/auth/register` a throwaway local user.
  No Postgres available → scan public pages only (`#/login`, `#/privacy`, `#/terms`) and mark the
  scan "partial" in SCORECARD. Never log into prod.
- Routes: `#/home`, `#/grid`, `#/tasks`, `#/schedules`, `#/activity`, `#/settings`
  (Connections · Credentials · Usage · Profile), `#/supervisor`, `#/error-capture`, `#/revanote`, `#/login`.
- Screenshot desktop + 390px, light + dark (Playwright, Chromium at `/opt/pw-browsers`).
- Look for: misalignment, overflow/horizontal scroll, clipped text, off-token colors (accent BLUE,
  orange CTA-only, never indigo), missing loading/empty/error states, contrast/focus, console errors.
- **Fix what you notice**: small issues ship as a separate commit in the same PR if budget allows;
  larger ones go to PRIORITIES. UX/UI lowest dimension → `gsd-ui-review`.

## 6. Evaluation and self-tuning
- **Every run:** `/qc` (cross-model) on the iteration. Required answers: right item? target
  dimension improved (evidence)? any regression? what would an expert manager have done
  differently? → iteration score 1–10 in LEDGER.
- **Cross-model `/qc` must PASS before the PR opens** when the diff touches any §7 sensitive path.
- **`/roast`:** Run 1, each milestone boundary, and every **5** runs (tunable); re-baseline SCORECARD.
- **Tune:** rewrite only §10–14. One change per finding, each logged in §14 with the score that
  drove it. Two consecutive runs scoring ≤ 4 → change strategy, not tactics.

## 7. Standards (QC bar)
**Repo rules (CLAUDE.md wins on conflict):**
- Cross-cutting invariants in CLAUDE.md are law: non-bypassable cost AND token caps on every
  `gates: [...]`; no provider API key / programmatic flags on the PTY path; untrusted inbound
  fenced via `hub/src/dispatch/untrusted.ts`, machine self-heal propose-only; webhooks read raw
  body first, constant-time compare, mount before `/api/*` auth; api keys never mint api keys;
  actor server-inferred; one orchestrator per user.
- `hub/src/db/schema.sql`: idempotent DDL only, re-runs every boot; backfills → `hub/scripts/` one-shots.
- Use `hub/src/dispatch/` for dispatch/queue/grace; never hand-roll per subsystem.
- Behavior change → update its `docs/*.md` (Docs map) in the same PR; route change → `bun run docs:sync`.
- New CI check → `.woodpecker/*.yaml`; GHA only for Windows/macOS/signing.
- `tools/regression-baseline.json`: re-measure and state why in the same PR when counts move;
  never loosen `pass_min`/`skip_max` to get green; skips only if `REMO_E2E_DB_URL`-gated.
**House mandates:** Titanium Licensing only for auth/billing (no NextAuth/Clerk/etc.); keep AAF
widget + error forwarding intact; bugs in other repos → `autofix-report`; credentials via
gateway/broker per request, never new per-service env creds; LLM calls follow
`cost-aware-llm-pipeline`; `/qc` is the QC step; STATE heartbeat for `gsd-sentinel`.
**Baseline (gaps only):** server-side user_id scoping + cross-tenant denial tests; zod at every
boundary; SSRF guard on user URLs; CSRF on browser state changes; typed errors; index what you
filter; 390px no horizontal scroll; loading/empty/error/success states; WCAG 2.2 AA; plain,
sentence-case copy; no stack traces in UI.
**Sensitive paths (cross-model `/qc` required):**
`hub/src/auth/**`, `hub/src/csrf.ts`, `hub/src/license-gate.ts`, `hub/src/titanium-client.ts`,
`hub/src/api/{auth,api-keys,webhooks-titanium,admin,account}.ts`, `hub/src/dispatch/**`,
`hub/src/ext/**`, `hub/src/api/ext.ts`, `hub/src/work/**`, `hub/src/webhooks/**`,
`hub/src/api/*-webhook.ts`, `hub/src/feedback/**`, `hub/src/error-capture/**`,
`hub/src/orchestrator/**`, `hub/src/ws/{agent,protocol,agent-protocol}.ts`,
`hub/src/middleware/security-headers.ts`, `hub/src/db/schema.sql`, `hub/scripts/**`,
`supervisor/src/runners/**`, `supervisor/src/process-manager.ts`, `supervisor/tauri/src-tauri/**`,
`.woodpecker/**`, `.github/workflows/**`, `Dockerfile`, `tools/regression-baseline.json`.

## 8. Operations
**Checks (repo root unless noted):**
- All: `bun install --frozen-lockfile`
- hub: `bun run schema-lint` · `bun run check-baseline` · `bun run migration-verify` and
  `bun run orchestrator:e2e` (need Postgres; run with `REMO_E2E_DB_URL` if available, else CI covers)
- hub types (ratchet): `bunx tsc --noEmit -p hub/tsconfig.json 2>&1 | grep -c "error TS"` — record
  before/after; must not rise (393 known at authoring; CI step is `|| echo` informational)
- docs: `bun run docs:sync` → `git diff --quiet -- docs/openapi.json docs/api.md`
- web: `cd web && bun run build` · `bun test web/test` (not in CI; run locally)
- supervisor: `bun test supervisor/test` (CI runs only 2 of these files) · Rust is Windows-only →
  GHA `supervisor-build` is the gate
- mcp: `cd mcp && bun run typecheck`

**CI (mixed → poll):** Woodpecker commit statuses (`qc` pr-gate, `docs-drift`) + GHA
`supervisor-build` (path-filtered to `supervisor/**`). After each push poll `get_status` and
`get_check_runs`; while pending, `send_later` 10 min out. No status after ~10 min → validate touched
CI YAML. CI wait is idle time, capped at **2 h**; at cap, comment on the PR and end. Re-run a job at
most once, only to confirm a failure not caused by this PR. "Flake" is not a root cause.

**Deploy verify:** last merged PR SHA → Coolify app for `app.remo-code.com` reached it and finished
(Coolify MCP via lazy launcher; wait cap 15 min) → `curl https://app.remo-code.com/health` expects
`{"ok":true}`; `/openapi.json` 200; `/api/sessions` 401; or `bun run smoke -- https://app.remo-code.com`.
Also read Woodpecker `post-deploy-smoke` on that SHA. Failure → P0 (fix-forward or revert PR).
Supervisor changes are NOT live until a signed MSI ships; never report them as deployed.

**Coordination:** no claim tool; collisions = open PRs touching the same files. **Branch:**
`<type>/<slug>` off `origin/main`. **PR template:** none. **Merge:** AAF on green.

## 9. Hard lines (absolute)
- Don't merge yourself; don't push to `main`.
- Don't disable, skip, or quarantine tests; don't loosen baseline tolerances to get green.
- Don't commit secrets or add per-service credential env vars.
- Don't change prod env/flags (`REMO_ORCHESTRATOR_*`, `*_AUTOSPAWN`, `REMO_PTY_INTERACTIVE`,
  `TITANIUM_BYPASS`, `*_TOKEN_CAP*`) or populate `orchestrator_autospawn_allowlist` /
  `work_repo_allowlist`. Owner-only.
- Don't push `supervisor-v*` tags or cut releases.
- Don't weaken a cross-cutting invariant or its guard test.
- PTYCAP phases are strictly serial: never start Phase N+1 before N is verified; never Phase 3
  before 2; never Phases 7–9 before 4 (9 after 8).
- Don't self-scope milestones or product direction: next milestone comes only from PROJECT.md
  Planned Milestones; when the list is empty, stop and record "needs owner". (OBSRV was cancelled
  for exactly this.)
- Don't edit this fixed core.
- Don't fix another repo's bug here; send it to `autofix-report`.
<!-- END FIXED CORE -->

<!-- TUNABLE: rewrite each iteration; log every change in the Changelog -->

## 10. Current focus and hypotheses
- Focus: close PTYCAP-01 (verify + reconcile STATE/ROADMAP), then PTYCAP-02 PTY pre-flight gate.
- Hypothesis: status-doc drift is hiding real progress; verifying PTYCAP-01 unblocks the serial chain.

## 11. Weights and thresholds
- Dimension weights: all 1.0 (no data yet).
- Age bonus: +0.5/iteration, cap +3.
- UI full scan: every 3 runs. Roast: every 5 runs.
- SLO: p95 < 800 ms, error rate < 1%. Runaway: 2× trailing-7-day tokens.

## 12. Tactics and lessons learned
- Code wins over STATE.md; check `git log` before trusting any status line.
- Check-baseline runs hub/test only, each file in its own process; supervisor/web tests must be run explicitly.
- Woodpecker has no Windows agent (removed 2026-09-15); never add `platform: windows/amd64` pipelines.

## 13. Watch list
- hub tsc: 393 pre-existing errors, CI step non-gating (`|| echo`). Burn down, then make it gate.
- `web/test` (~20 files + `browser/`) not run in CI; `supervisor/test` 59 of 61 files not run in CI.
- CLAUDE.md "CI" section still lists `supervisor-build.yaml` on Woodpecker; it moved to GHA (#480). Doc drift.
- Stray empty `build-err.txt` at repo root.
- `TITANIUM_BYPASS=true` in prod (owner milestone TENANT; do not touch, track only).
- No p95/error-rate or cost source reachable unattended.

## 14. Changelog
| Date | Change | Why | Score |
|---|---|---|---|
| 2026-09-26 | Directive authored | routine-prompt-builder v3 | n/a |
