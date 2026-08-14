---
phase: PTYCAP-01-pty-token-accounting
fixed_at: 2026-07-28T11:30:00Z
review_path: .planning/phases/PTYCAP-01-pty-token-accounting/01-REVIEW.md
iteration: 2
findings_in_scope: 2
fixed: 2
skipped: 0
status: all_fixed
---

# Phase PTYCAP-01: Code Review Fix Report

**Fixed at:** 2026-07-28T11:30:00Z
**Source review:** .planning/phases/PTYCAP-01-pty-token-accounting/01-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 2 (0 critical, 1 warning, 1 info)
- Fixed: 2
- Skipped: 0

This is iteration 2 — a fix-verification pass. The prior iteration's CR-01/WR-01/WR-02 fixes were
independently re-confirmed by this pass's re-review (not re-touched here); WR-03 remains open by
design (non-blocking, noted for traceability only). Both new findings from this pass are fixed
below.

## Fixed Issues

### WR-04: `no-hub-side-transcript-fs.test.ts`'s guard regex is narrower than its stated goal

**Files modified:** `hub/test/no-hub-side-transcript-fs.test.ts`
**Commit:** d15d95e
**Applied fix:** Broadened `HOMEDIR_IDENTIFIER` from `/\bhomedir\b/` to
`/\bhomedir\b|process\.env\.(HOME|USERPROFILE)\b/`, exactly as the review suggested, so the canary
also catches a future hub-side module that derives a home-directory path via
`process.env.HOME`/`process.env.USERPROFILE` directly instead of `os.homedir()` — the same escape
hatch this phase's own `supervisor/test/pty-usage-tail.test.ts` `makeHome()` helper already uses.
Verified non-vacuous and non-regressive by re-running the full guard suite: `bun test
hub/test/no-hub-side-transcript-fs.test.ts` — all 4 tests still pass, including "matcher is
non-vacuous" (still finds the two pre-existing `hub/src/telegram/transcript/` offenders),
"every offender outside the allowlist is a hard failure" (allowlist unchanged, still zero
non-allowlisted offenders under the broadened pattern — the broadened regex only ever scans
`hub/src/**`, so it has zero effect on `supervisor/test`'s own use of `process.env.HOME`), "the
allowlist has exactly one entry" (unchanged), and "a comment mentioning the pattern neither trips
nor satisfies the check" (still passes — comment-stripping happens before the regex test,
independent of which pattern is used).

### IN-01: `POLL_INTERVAL_MS` export inconsistency between the ported file and its declared source of truth

**Files modified:** `supervisor/src/usage/pty-transcript-tail.ts`
**Commit:** 104749d
**Applied fix:** Checked first per the review's own guidance: grepped
`supervisor/src/usage/pty-usage-emitter.ts` and the full `supervisor/` tree for any import of
`POLL_INTERVAL_MS` from `pty-transcript-tail.ts` — none exists (the only other `POLL_INTERVAL_MS`
identifiers in the repo are unrelated same-named constants in `oauth-poll.ts`'s
`USAGE_POLL_INTERVAL_MS` and the Tauri UI's local `autoUpdater.ts`). Since nothing imports the
export, dropping it is the smaller, safer diff — changed `export const POLL_INTERVAL_MS = 500` to
`const POLL_INTERVAL_MS = 500`, restoring true byte-for-byte parity with the hub original
(`hub/src/telegram/transcript/tail.ts`) as the file's own header comment already claims. (Did not
need the header-comment-edit alternative since option (a) applied cleanly.)

## Verification

Ran the full targeted regression set after both fixes:
```
bun test hub/test/no-hub-side-transcript-fs.test.ts supervisor/test/pty-usage-tail.test.ts supervisor/test/pty-usage-path-containment.test.ts
# 27 pass, 0 fail, 53 expect() calls
```
Ran the full project QC gate:
```
bun run check-baseline
# baseline: pass=2059 skip=255 fail=0 total=2314
# actual:   pass=2059 skip=255 fail=0 total=2314
# OK — within tolerance.
```
No regressions introduced.

---

_Fixed: 2026-07-28T11:30:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
