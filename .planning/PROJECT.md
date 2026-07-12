<!-- updated: 2026-07-12 -->
# Project — remo-code

## What This Is

Open-source control plane for local coding-agent CLIs. A **Tauri Supervisor** (MSI, one per host)
runs on the developer's own machine, spawns their own `claude`/`codex` CLI against their own
subscription, and relays to a **hub** (Bun + Hono, port 3040) over `/ws/agent`; browsers and phones
connect to `/ws/client`. Live at **https://app.remo-code.com** (Coolify, Docker). Repo:
`finedesignz/remo-code`. Architecture + invariants: `CLAUDE.md`, `.planning/codebase/`.

**The source code never leaves the developer's machine. The hub never sees a provider API key.**
That is a compliance posture, not an implementation detail — it is enforced by an argv
allowlist-of-one, `env-sanitize.ts`, and guard tests that fail the build on regression.

## Core Value — sell the governor, not the engine

**Anthropic already ships remote chat.** "Remote Control" (Feb 2026) bridges a local Claude Code
session to the web + iOS/Android apps, free, first-party. Remote chat is commodity. We do not
compete there — we give it away.

**What no one ships is the fuse box.** remo-code is the **governance and reliability layer for
fleets of coding agents**:

- **Hard, non-bypassable token ceilings** on every dispatch path (not dollar caps — dollars are
  meaningless on a flat-rate subscription; tokens are the real currency).
- **A per-agent, per-repo, per-turn spend-and-action ledger** (`token_usage`, `routine_run_log`,
  `session_runs`) — the CloudTrail for what your team's agents actually did.
- **Self-heal**: ghost-reaper, run-reaper, stale-lock reaper, supervisor circuit breaker with
  half-open recovery, resume-by-`project_dir`, error-capture → auto-repair. Anthropic's Remote
  Control has none of this and breaks.
- **Multi-repo fleet ops**: scheduled unattended runs, dependency-aware waves, deploy-verify tails.
- **A kill switch.**

This was earned the hard way. On 2026-07-11 a runaway orchestrator loop burned **2.83 billion
cache-read tokens in two days and killed the owner's Claude Max subscription**. The cap existed and
was blind to cache-read. Worse, a subsequent audit found `dailyTokenCapGate` rode **only** the
orchestrator inject path — scheduler, error-capture, feedback, revanote, and Telegram were six more
unbounded spend paths. All seven are now gated, and the cap is *proven to fire* against real
Postgres. The scar tissue is the product.

## Who It's For

**The buyer is the eng manager / agency with 20–40 Claude Max seats and no visibility into who
burned what.** Not the solo dev — solo devs self-host and pay $0, and that is structural, not a
pricing mistake: for this ICP, willingness-to-pay and capability-to-self-host are the *same trait*.

Open-core, on the GitLab/Sentry line:

| Free / MIT — the funnel | Paid — the business |
|---|---|
| Hub, supervisor, terminal, chat | Teams, SSO, RBAC |
| Single-user scheduling, Telegram | Org spend ledger + policy caps |
| Self-host it, fork it, love it | Audit log with retention, org-wide kill switch |
| | Hosted, supported, SLA |

**Never** gate on session count (a tax on evangelists, patched out in an afternoon). **Never**
paywall the orchestrator (it paywalls the weakest asset and gives away the strongest).

## Position on Anthropic

Automation drives the **genuine interactive TUI**, on the user's own subscription — the path
Anthropic subsidizes and promotes. Their enforcement targets *abuse and runaway over-usage*; a
capped, rate-limited, audited orchestrator is the opposite of that. **Our governance layer is our
ToS position**: we are the operator who caps, logs, and can prove it.

Engineered metering-agnostic regardless: caps are denominated in **tokens**, the
interactive-vs-programmatic dual-bucket ledger is the early-warning signal, and if programmatic use
is ever metered at API rates we re-price the team tier — we do not rearchitect.

## Shipped Milestones

- **v1.0** (Phases 01–14) — shipped + archived 2026-06-02.
- **m-interactive-pty-runner** (Phases 15–20) — interactive PTY is the default human surface, 2026-06-04.
- **TMAC** (Phases TMAC-01..06) — macro-prompt orchestrator cycle-runner, 2026-06-08.

## Cancelled

- **OBSRV** (Orchestrator Observability & Shadow Dry-Run) — **CANCELLED 2026-07-12**, 0/6 phases.
  It was scoped by the orchestrator *for itself* (a governance violation that also broke `main`),
  and it was six phases of scaffolding to safely arm a subsystem whose entire premise has since
  changed. Its good half survives: the `routine_run_log` read API + Activity panel become the
  **receipts page** (Milestone GOV). The built `OBSRV-04` autospawn-shadow work is salvaged, not
  discarded.

## Planned Milestones (Roadmap)

Owner-curated. **The autonomous orchestrator may draw its next milestone ONLY from this list.** It
may never self-scope a product direction; when this list empties, it STOPS and asks.

1. **BLEED** — close the three CRITICALs + prove the caps. *(in flight)*
2. **PTYCAP** — token-gate the interactive PTY path. **Blocks everything else.**
3. **GOV** — the governance surface: org spend ledger, policy caps, audit, kill switch, receipts page.
4. **TENANT** — real multi-tenancy: retire `TITANIUM_BYPASS`, working magic-link, per-user supervisor pairing, prove isolation.
5. **MONEY** — Titanium Licensing billing, plans, entitlements, the paid tier.
6. **ONBOARD** — a stranger self-serves: signup → MSI → pair → first session → first scheduled task.
7. **AUTO** — governed PTY autonomy + the 30-night public receipts log. **Monetized only after the log is green.**
8. **DEBT** — retire the half-live flags (legacy waves, ChatSurface/cutover gate, TEAB MSI, mobile).

## Current Milestone: BLEED — Stop the Bleeding

**Goal:** the app cannot silently wedge, and the spend ceiling is proven — not asserted.

Four independent fixers in flight:
- **#346** — NULL-`session_id` run leak (permanent `at_capacity` lockout); circuit breaker latched
  open 5 days with no alarm; `dailyTokenCapGate` extended to all seven dispatch paths + proven to
  fire against real Postgres.
- **safety-fences** — CI lint fencing `schema.sql` (it re-runs in full every boot); delete the
  `REMO_ORCHESTRATOR_LEGACY_WAVES` dead rollback path; snippet↔envelope contract test.
- **baseline-triage** — the 129 known-failing tests. A green suite that hides a ninth of itself is
  how all three CRITICALs shipped undetected. One test literally pinned the run-leak bug as
  *intended behavior*.
- **ghost-hostname** — stop hostname-NULL ghost-session churn at the supervisor source.

**Definition of Done:** zero known-failing tests; every dispatch path provably gated; no run can
leak; the breaker self-heals and is visible; `schema.sql` cannot carry a mutating statement.

## Untested Assumption (the biggest open risk)

**Nobody has ever paid for this, and demand for the team tier is unvalidated.** The cheapest test —
post the fleet-ops angle (N repos, overnight, hard ceiling, reviewable PR in the morning) to
r/ClaudeAI + HN with a $99/mo team waitlist — has **not been run**. Fewer than 20 emails and the
ICP is wrong, learned for the price of one Reddit post. Run it before building Milestone MONEY.
