# Priorities — finedesignz/remo-code

**Status:** UNSCORED PRE-SEED. These candidates come from static discovery (PROJECT.md, CONCERNS.md,
STATE.md, open PRs) during the 2026-09-27 bootstrap, not from a real scoring pass. The next run must
score each with DIRECTIVE §3.3 (`Impact × Reach × Urgency × Confidence ÷ Effort + age bonus`) before
acting on any of them, and must run its own P0 scan (§3.2) first — none of these were checked against
live prod signals.

## Candidate 0 — Reconcile stale planning docs against CLAUDE.md (do this first, it gates scoring)
`PROJECT.md`/`STATE.md`/`CONCERNS.md` (all ~2.5 months stale) disagree with `CLAUDE.md` (current)
about whether BLEED-milestone fixes shipped: the NULL-`session_id` run leak, the latched circuit
breaker, ghost-hostname churn, and the token cap missing cache-read all read as already fixed in
CLAUDE.md's env-var section (`fix/stop-the-bleed`), but `CONCERNS.md` still calls them CRITICAL/HIGH
and `PROJECT.md` still lists BLEED as the current, in-flight milestone. Until this is resolved, the
scorecard's Reliability/Data-integrity/Cost baseline and the correct active-milestone pointer can't
be trusted. Likely effort 1–2 (git-log + test verification, then a docs update); likely outcome is
either closing out BLEED (`gsd-audit-milestone` → `gsd-complete-milestone`) or surfacing genuinely
still-open work.

## Candidate 1 — Baseline the scorecard + `/roast`
Required by the DIRECTIVE's own Run 1 protocol before any real prioritization can happen. Not
optional; not really "competing" with other items, more a prerequisite gate.

## Candidate 2 — PTYCAP Phase 2 (PTY pre-flight gate)
Per `.planning/ROADMAP.md`: "a programmatic turn cannot be written to the PTY without passing the
full gate chain." Phase 1 (token accounting) appears shipped per CLAUDE.md's usage-cost.md summary
("PTYCAP Phase 1 adds a second, supervisor-side source... RECORD only, gating is Phase 2"). This is
squarely the routine's Core Value (non-bypassable caps) and PROJECT.md calls PTYCAP a blocker for
every later milestone. High likely Impact or unlock value; needs Effort estimation once the current
STATE.md phase status is confirmed fresh (it was last touched 2026-07-28 — re-verify before trusting
"1/4 plans done").

## Candidate 3 — Hub typecheck error count
CONCERNS.md/CLAUDE.md reference a stale error count (documented as "393 at the 2026-07 baseline" in
the superseded draft DIRECTIVE from PR #485); CI reports it but doesn't gate. Re-measure
(`bunx tsc --noEmit -p hub/tsconfig.json`) and decide whether it's trending up or down before scoring
this as a code-health item.

## Candidate 4 — Open dependabot PRs
- #481 `@hono/zod-openapi` 0.18→0.19 (hub/src/api/_openapi.ts risk — watch for OpenAPI schema
  breakage).
- #486 Tauri + tauri-plugin-single-instance + tauri-plugin-updater minor/patch bump
  (supervisor/tauri/src-tauri — Rust/Windows-only via GHA `supervisor-build`).
Low effort, low-to-moderate risk; verify CI, don't just approve blindly (RUSTSEC advisories are
mentioned in #486's own changelog — check they don't apply to shipped code paths).

## Candidate 5 — god-files
`hub/src/db/dal.ts` (2304 LOC per CONCERNS.md, unverified fresh), `hub/src/ws/agent.ts` (1286),
`hub/src/api/telegram-webhook.ts` (1197). CONCERNS.md disposition: "ACCEPT / split
opportunistically" — low urgency, revisit only if it's blocking a specific fix.

## Candidate 6 — Regression baseline known-failing tests
CONCERNS.md (stale, 2026-07-12) cites 771/900 passing, 129 known-failing, disposition FIX. Re-measure
via `bun run check-baseline`'s current pass/skip numbers before trusting this figure — it may already
be resolved by `baseline-triage` (one of BLEED's four fixers per PROJECT.md).

## Not a priority (explicitly out of scope per DIRECTIVE hard lines)
- Any new milestone not on `.planning/PROJECT.md`'s Planned Milestones list.
- Flipping any of the flags/allowlists named in DIRECTIVE §10.
- Cutting a new supervisor release / pushing a `supervisor-v*` tag.
