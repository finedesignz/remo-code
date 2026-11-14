# QC round 3 (Codex, external seat responded) - QC-FAIL, 4 findings (all fixed after the round; NOT re-reviewed externally: round cap reached)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | Cancellation bypasses the timeout fence (claim release / concurrent removal) | FIXED: the `unconfirmed` fence applies to every status incl. done/cancelled (skipped + logged); e2e assertion |
| 2 | MED | Worktree created before a refused launch cannot be removed (supervisor_id persisted only after launch) | FIXED: `Workspace.release` resolves the host via the bound account (`quota.supervisorFor(run.account_slot)`) and no longer requires worktree_path (removal is idempotent); unit test |
| 3 | MED | gh lookup honors inherited GH_HOST | FIXED: `--repo github.com/owner/name`, GH_HOST and GH_REPO removed from env; test |
| 4 | MED | 5 newer fork PRs can hide the same-repo PR | FIXED: `--limit 100` before the same-repo filter; test |

After the fixes: hub corch tests + e2e, kill-switch-coverage, supervisor guards and corch tests all green; `bun run check-baseline` OK (pass=4213 fail=0).
