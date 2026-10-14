# Phase 4 Plan Check (read-only review of 04-01..04-08)

Scope: SC-1..SC-4, locked D-01..D-19, hard invariants (fail closed, default-OFF no-op, additive DDL / schema-sql-lint, human paths open, no LLM key, no polling).

## Coverage (goal-backward)

| Criterion / decision | Covered by | Status |
|---|---|---|
| SC-1 lifetime ledger, atomic pre-send reserve | 04-02 T1/T2, 04-03 (all counted paths, replay re-entry), 04-04 (PTY door reserve) | Covered |
| SC-2 kill switch hub/user/session, fresh read, fail closed | 04-02 (table, predicate, final pre-send check), 04-05 (routes, tenancy), 04-06 (all non-human lists + scheduler/tick entries), 04-07 (spawn sites, orphan defer, pins) | Covered |
| SC-3 60% alarm email, event-driven, durable claim | 04-05 T3 | Covered |
| SC-4 cap 50M -> 20M, last commit | 04-08 T3 | Covered (see MINOR on "last") |
| G-1 first commit | 04-01 | Covered |
| Phase 3 slot hand-off | 04-04 | Covered |

Dependency graph acyclic; waves consistent (1 / 2 / 3,3,3 / 4 / 5 / 6). No same-wave files_modified overlap (03/04/05 disjoint). schema.sql additions are DDL only (CREATE ... IF NOT EXISTS; lint bans statement-leading UPDATE/INSERT/DELETE/TRUNCATE/DROP only; CHECK literals are fine). Human chain, telegram human list, cloud send, PTY_HUMAN_TURN_GATES untouched and pinned. No polling (injectable trailing-edge timers; setInterval banned by acceptance). No API key.

## Findings

MAJOR | 04-02:T1 (also 04-05:T3, 04-08:T1) | Every new SQL path (advisory-lock reserve, kill-switch partial unique indexes, page/alarm ON CONFLICT claims, seq-after-reset count, text/uuid casts) is exercised only by hand-written fake sql objects matching statements by text. That validates plan logic, not Postgres. The sole real-DB proof is one locally-skipped test in wave 6 (04-08:T1), unrunnable before the PR. Repo memory records this failure class (lax local vs postgres:16 CI broke #367, #371). A bad cast/index predicate would surface only as CI red after all 8 plans. | Pull real-DB proof forward: require 04-02 to run reserve/preSendGuard/engage/release once against a real postgres:16 (throwaway container or scratch DB, never prod) and record output in 04-02-SUMMARY; or build the e2e in wave 2. Keep the single-test skip accounting.

MINOR | 04-08:T3 / D-14 | "Cap commit is LAST" cannot hold if the executor commits 04-08-SUMMARY/STATE afterwards; acceptance `git log -1 --format=%s` is tautological. | Define "last code commit" or fold summary/state into it; check `git log -n 3` excluding docs(planning) commits.

MINOR | 04-03:T3, 04-04..04-07 | Plans repair "every test that breaks" with leaf mocks but those files are absent from files_modified; wave-3 siblings each gate on full check-baseline while the others are mid-edit (racy in one tree, merge-conflict-prone across worktrees). | Sequence 03/04/05 or gate baseline after merge; assign ownership of shared mock repairs.

MINOR | 04-05 context/read_first | hub/src/api/require-admin.ts does not exist; real path is hub/src/auth/require-admin.ts (verified: reads c.get('userRole'), 403 body {error:'forbidden', reason:'admin_required'} as assumed). | Correct the path.

MINOR | 04-02 scope | T1 spans schema + ~300-line module + pipeline + inject + tracer test (5 files). Quality-degradation risk only. | Optionally split.

INFO | 04-04:T1 | With PTY flag ON, ask/work/telegram governed lists have no counterKey (D-05 exempt) so lifetime_counter governor refuses lifetime_counter_key_missing until Phase 5/7. Fail-closed, flag default OFF, no worse than Phase 3. Document.

INFO | 04-04:T2 | Door reserve with caller-supplied key/token slightly exceeds D-03 wording but is justified (F-6) and caller-pinned.

## Verify sanity
Commands are runnable bun test <file> with count floors; none grep-pipe-vacuous. 04-08:T1 passes on "1 skipped" by design. 04-05:T2 docs:sync needs network (BLOCKED path defined).

BLOCKERS: 0 | MAJOR: 1 | MINOR: 4 | INFO: 2

VERDICT: REVISE (fix the MAJOR; fold in MINORs)
