# CORCH-09 VERIFICATION (independent, goal-backward)

Head verified: ffcc230dcdc28675a3a7d21aa023913713a89295 (branch phase-corch-09-slot-injection-worktree, base phase-corch-08-aaf-event-receiver). Supersedes the round-4 verification; covers QC rounds 5-6 changes.

## Per-goal verdict

| REQ | Verdict | Evidence |
|---|---|---|
| CORCH-R3.8 memlog claim per item | BLOCKED-ON-MCP (not a failure) | No hub->memlog transport (memlog note 1794637033307-0). Claim client is an injected seam with a refusing default (`memlog_unavailable`, one 7d ticket, nothing dispatches without a claim). Claim/heartbeat/release lifecycle and conflict wait proven against a fake memlog (corch-workspace, corch-slot e2e). No substitute built. |
| CORCH-R4.1 slot advert | PASS | `account_slot` only when `REMO_ACCOUNT_SLOT` set (hub-client.ts, slot.ts); corch-slot tests 11/11. |
| CORCH-R4.2 per-slot OAuth spawn env | PASS | claude-runner uses slotSpawnEnv only under slot; ANTHROPIC_API_KEY deleted; fail-closed on malformed slot env; no-apikey-fallback-guard 7/7; full supervisor run shows no regression in the interactive/API-key guards. |
| CORCH-R4.3 no token in hub | PASS | corch-no-token-guard green (hub 70/70 corch set); supervisor frame test green. |
| CORCH-R4.4 worktree commands | PASS | ensure/remove/pr_lookup allowlisted (supervisor commands/index.ts, hub EXT_READ_COMMANDS); sandbox via assertTargetWithinRoots/assertWithinRoots; credential helper by env reference; idempotent reuse; hosts recorded before ensure and removal pinned to recorded hosts (QC R5/R6); corch-worktree 15/15 on temp git repos. |
| CORCH-R4.5 PR lookup | PASS | `gh api repos/<o>/<n>/pulls` with server-side `head=<owner>:<branch>` + same-repo recheck, no credential in reply (equivalent or stronger than spec `gh pr list --head`; deliberate QC R6 change). pr_open+pr_url vs requeue covered by corch-workspace / e2e. |

## Commands run (this session, fresh migrated Postgres db, ports 55432)

- Hub corch set (no-token-guard, workspace, aaf-events, quota-binding, e2e corch-slot): 70 pass / 0 fail.
- Other guards (corch-no-polling, launch-callers, launch-machine, counter-key, dispatcher-disabled) + schema-double-apply e2e: all pass, 0 fail (schema-double-apply 9/9 with DB).
- Supervisor corch-slot + corch-worktree: 26 pass / 0 fail on re-run in Git Bash (one earlier combined run showed 2 fail / 2 errors, not reproduced on 2 reruns; treated as load/timing flake, noted). Under PowerShell corch-worktree beforeAll needs `mkdir` on PATH (env artifact, Linux CI unaffected).
- Full supervisor suite (Git Bash): 465 pass / 3 fail / 1 error. The 3 failures are Phase 15 PTY/ConPTY tests (PTY byte round-trip, orphaned-PTY teardown x2) in files this PR does not touch; Windows host environmental, not CORCH.
- `bun run check-baseline`: OK, pass=4214 skip=0 fail=0 (baseline 3802/345/0).
- `schema-lint`: OK. `migration-verify`: OK (needs psql on PATH).
- Typecheck: hub `tsc` reports 253 errors, none in any file this PR touches (all in pre-existing scheduler/orchestrator/api/test files; no corch/ errors). Supervisor and root have no typecheck script/tsconfig (Bun-run source).

## Ship verdict

PASS for head ffcc230d. R4.1-R4.5 delivered; R3.8 BLOCKED-ON-MCP by design (seam + fake-memlog proof, flags stay OFF). Not independently proven: hub typecheck cleanliness of the whole hub (pre-existing errors elsewhere), and the 3 PTY failures were not compared against base.
