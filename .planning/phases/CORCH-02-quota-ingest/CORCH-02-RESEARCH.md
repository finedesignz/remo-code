# CORCH-02 Research Record

## Recorded values

- BASE = `0f12261e0157edb75b87372638720fe7f625d1c5` (HEAD of phase-corch-02-quota-ingest before any edit)
- N0 = 253 (`cd hub && bun run typecheck | grep -c "error TS"` on BASE)

## Q1 - quota-death signal

Verdict: a hub-visible channel EXISTS (`content`, via onFinalize). Reset time is NOT reliably machine-parseable in the current CLI form.

### Trace (channel)

1. `supervisor/src/runners/claude-runner.ts` (~:446-:496): for a stream-json `assistant` event every `text` block is relayed as `text_delta` and appended to `this.fullText`; on the `result` event `fullText` is relayed as `assistant_message` and reset. The `result` event's own `result` string and `is_error` flag are NOT relayed.
2. The CLI renders a subscription limit as a synthetic assistant message (text block), so the limit text reaches the hub as `assistant_message` content, goes to `onSessionReply`, then `finalizeAndPromote` -> `store.onFinalize(token, content)` (`hub/src/dispatch/pipeline.ts` ~:618). That is the CORCH channel: onFinalize `content`.
3. `markFailed(token, error)` (pipeline.ts ~:571 and releaseClosedRun) carries hub-generated send-failure text, not CLI output. It is checked too (LD-Q10) but is not where the CLI signal arrives.
4. Planning grep (re-run): zero usage-limit handling in hub/src or supervisor/src.

### Primary source (CLI binary strings, claude 2.1.325, read-only `grep -a` of `~/.local/bin/claude.exe`)

- `You've hit your session limit` (5-hour window; the `session` label), and sibling labels in the same renderer (`Opus limit`, `Sonnet limit`, `weekly`, `fast`).
- Template fragments for the reset suffix: `` ` \xB7 resets ${n}` `` / `` ` \xB7 your ${limitName} resets ${resetTime}` `` - the reset is a localized human string (time-of-day, optional date, tz in parentheses), NOT an epoch.
- Legacy form (still matched by the CLI's own classifier regex `usage limit reached|...`): `Claude AI usage limit reached|<epoch seconds>` (epoch encoding).
- Auto-resume feature text (`Usage limit reached \xB7 continuing automatically`) is an interactive TUI line, not stream-json assistant content.
- API 429 rate limits are a different class (`rate limited` / overloaded, retried by the CLI); they are NOT a subscription death and are NOT classified here.

### Anchored patterns (whole trimmed text, <= 500 chars)

1. Legacy: `^Claude AI usage limit reached\|(\d{9,11})$` -> resetAt = epoch seconds * 1000.
2. Current: `^You've hit your (?:session|weekly|Opus|Sonnet|\w+) limit(?: ?[·|\-] ?(?:your [\w ]+ )?resets (.+))?\.?$` -> reset string kept as text; parsed to a Date only for an unambiguous form (see quota-death.ts); otherwise resetAt = null, and the store falls back to the earliest future of the row's `resets_5h` / `resets_7d` (LD-Q10).
3. `monthly spend limit` / `team's shared budget` are credit/spend limits, not window quota: NOT classified (a bounded wait on resets_5h/7d would be wrong).

### Verbatim samples used by tests

- `Claude AI usage limit reached|1760000000` (legacy, epoch)
- `You've hit your session limit · resets 3pm (America/Los_Angeles)` (current, human reset)
- `You've hit your weekly limit · resets Nov 18 at 9am (UTC)` (current, human reset, with date)

Caveat (stated plainly): the full composed strings above are assembled from the template fragments found in the binary plus the documented legacy form; the exact tz/date rendering was not captured from a live limit event. The classifier therefore treats an unparseable reset as null rather than guessing.

### Known limitation

`fullText` concatenates every text block of a turn, so a run that wrote prose and THEN hit the limit has content = prose + limit line, which does not match a whole-text anchor. LD-Q10 locks whole-text matching (false-positive safety, T-CORCH02-08); such a run follows the existing CORCH-01 no_pr path (consumes an attempt). Fail-safe direction, flagged for a later phase.

## Q2 - constraints

`corch_work_items.wait_reason` (schema.sql:1793) and `corch_runs.end_reason` (:1818) are plain `TEXT NULL`; no CHECK constraint. `quota_death` and `quota:<reason>` need no constraint change. `corch_projects.user_id` is `UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE` (LD-Q4 type).
