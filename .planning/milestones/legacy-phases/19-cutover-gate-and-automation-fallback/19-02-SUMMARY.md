# Phase 19 Plan 02: Default-Backend Selector Summary

Gated, fail-safe default-backend selector: new human sessions resolve only to explicit PTY runner ids (`claude-pty`/`codex-pty`), default to `codex-pty` until the cutover gate confirms interactive billing, and the flip stays an operator-recorded config change — not an auto-flip.

## Shipped
- `supervisor/src/runners/backend-selector.ts` — `resolveHumanBackend(ctx, config)` → `'claude-pty' | 'codex-pty'`; hard-rejects legacy/non-PTY ids (throws); defense-in-depth `ctx.isHuman` assertion; fail-safe `codex-pty` until `claudeInteractiveConfirmed`; on a `programmatic` gate result Claude-PTY is disabled/unlisted (alert + operator-override-clearable). Config key: `defaultHumanBackend: 'claude'|'codex'`; gate state: `{ result, claudeInteractiveConfirmed, operatorOverrideClaudePty? }` (operator-recorded; no runtime writer).
- `supervisor/src/runners/runner-factory.ts` — id → runner instance (`runnerForHumanBackend`, `selectHumanPtyRunner`); separate module so tests/harness import without booting the supervisor `main()`.
- `supervisor/src/index.ts` — re-exports the human-backend selection helpers.
- `supervisor/test/default-backend-selector.test.ts` — 14 pass: fail-safe, gated flip, hard-reject, human-only throw, post-`programmatic` disable + alert + override, no-auto-flip grep, selector→spawn-argv (real spawn seam) carries no `-p`/`--input-format`/`--output-format`/`stream-json`.

## Selector config + gate-flag location
- Selector config struct (`BackendSelectorConfig`) is passed in by the caller; the gate flag (`claudeInteractiveConfirmed`) is an operator-recorded value (per the runbook), never written by runtime code (test-asserted).

## Deviations
None — plan executed as written. (`runners/index.ts` in the plan = the existing `supervisor/src/index.ts` selector seam; the id→runner map lives in the new `runner-factory.ts` to avoid `main()` side-effects.)

## Commit
- `a13db90` feat(19-02)

## Self-Check: PASSED
- backend-selector.ts, runner-factory.ts, default-backend-selector.test.ts present; commit a13db90 in log.
