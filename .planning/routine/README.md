# Autonomous dev routine — state pointer

This repo has a scheduled, unattended dev routine (see the task's own stored prompt in the Routine
scheduler config). Its live state does **not** live on `main` — it lives on the `routine/state`
branch, which every iteration reads and pushes updates to directly (never as a PR into `main`).

Read, in order, on `routine/state`:
- `.planning/routine/DIRECTIVE.md` — the routine's operating manual (fixed core + tunable section).
- `.planning/routine/STATE.md` — resume point + lock heartbeat.
- `.planning/routine/SCORECARD.md` — the latest per-dimension baseline.
- `.planning/routine/PRIORITIES.md` — the current scored backlog.
- `.planning/routine/LEDGER.md` — one row per iteration that shipped (or attempted to ship) a change.

```bash
git fetch origin routine/state
git show origin/routine/state:.planning/routine/DIRECTIVE.md
```

This file on `main` is intentionally a pointer only, so the routine's fast-moving state doesn't
churn `main`'s history. It was created 2026-09-27 during the routine's structural bootstrap
(superseding an earlier, unmerged draft directive from PR #485).
