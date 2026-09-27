# Routine State — finedesignz/remo-code

<!-- LOCK: a heartbeat under 90 min old means another session is actively iterating.
     Format: LOCK: <session-marker> | <ISO-8601 timestamp>
     A run finding a fresh LOCK logs one line below under History and ends without acting.
     A run finding no LOCK, or a stale one, writes its own LOCK at the top of its work and
     clears it (removes the line, or sets it to `LOCK: none`) before pushing at the end of
     its iteration. -->
LOCK: none

## Current status
Bootstrapped structurally on 2026-09-27. `DIRECTIVE.md`, `SCORECARD.md`, `PRIORITIES.md`, and
`LEDGER.md` exist but are placeholders — no scoring iteration has run yet.

## Resume point
**Next run must execute the DIRECTIVE's own "Run 1 (bootstrap)" protocol (§2):**
1. Reconcile `CLAUDE.md` (current) against `.planning/PROJECT.md`, `.planning/STATE.md`, and
   `.planning/codebase/CONCERNS.md` (all stale, ~2.5 months old at bootstrap time) — several BLEED
   items CONCERNS.md calls CRITICAL/HIGH look already-fixed per CLAUDE.md's env-var section. Confirm
   with git log / tests, then close out BLEED or say what's actually still open.
2. Baseline `SCORECARD.md` for real (replace the placeholder scores in this branch).
3. Run `/roast` on the app (brief: README.md + CLAUDE.md "What This Is" + PROJECT.md).
4. Seed `PRIORITIES.md` for real (score properly per DIRECTIVE §3; the current file has an unscored
   discovery pre-seed only).
5. Pick the top item, execute it through the mapped skill, ship a PR (see DIRECTIVE §9 — no
   confirmed merge bot; PR needs owner review to merge).
6. Push updated STATE/SCORECARD/PRIORITIES/LEDGER + DIRECTIVE tuning back to `routine/state`.

## Active work claimed by this session
None yet — no iteration has executed.

## History (most recent first)
- 2026-09-27 — Bootstrap run: created `routine/state` (this branch), `.planning/routine/DIRECTIVE.md`,
  `STATE.md`, `SCORECARD.md`, `PRIORITIES.md`, `LEDGER.md`; opened pointer PR adding
  `.planning/routine/README.md` on `main`; opened a review issue; closed superseded draft PR #485 and
  deleted its branch `claude/gifted-faraday-a3bkuy`. No scoring/execution iteration ran this session —
  per the top-level runbook, a bootstrap run ends after claiming state + opening the pointer PR/issue.
