# CORCH-09 plan: slot injection, worktree, PR lookup, memlog claim

REQ: CORCH-R3.8, R4.1-R4.5. Branch phase-corch-09-slot-injection-worktree, PR base phase-corch-08-aaf-event-receiver. All flags stay OFF.

Tasks (each test-first):
1. Supervisor slot module `supervisor/src/slot.ts`; hello `account_slot` only when `REMO_ACCOUNT_SLOT` set; `claude-runner.ts` slot spawn env (token + config dir required, API key scrubbed, git push env kept). Tests: `supervisor/test/corch-slot.test.ts`.
2. Supervisor commands `corch.worktree_ensure|worktree_remove|pr_lookup` (`corch-worktree.ts`), sandbox via assertTargetWithinRoots/assertWithinRoots, deterministic path/branch, credential helper by env reference, replies without credentials. Tests: `corch-worktree.test.ts` (temp git repos, fake gh).
3. Hub seams: `memlog.ts` (refusing default), `workspace.ts` (real Workspace, PrLookup, release, heartbeat), dispatcher wiring (`PrLookup.runId`, optional `Workspace.release/heartbeat`, memlog wait schedule, blocked release, `releaseWorkItemNow`), AAF closure release hook, reconciler heartbeat, `corch.*` in `EXT_READ_COMMANDS`, `store.latestRunForItem`. Tests: `corch-workspace.test.ts`, extended `corch-aaf-events.test.ts`.
4. Guards: `hub/test/corch-no-token-guard.test.ts` (no token/API key in hub, halt before every frame).
5. e2e with fake slot supervisor + fake memlog on real Postgres: `hub/test/e2e/corch-slot.e2e.test.ts`.
6. Docs: `docs/corch.md`, CLAUDE.md env; docs:sync.
7. Research: memlog transport (none => BLOCKED-ON-MCP for R3.8, 7e request), env-sanitize, allowlist.

Done when: supervisor and hub corch tests + guards green, check-baseline green, Codex QC-PASS, PR open (stacked).
