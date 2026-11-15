# QC round 5 (Codex, external seat responded) - QC-FAIL, 2 MED (fixed)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | MED | launch re-resolves the account supervisor after ensure and overwrites supervisor_id | FIXED: dispatcher resolveTarget refuses any supervisor other than the one recorded before worktree_ensure; test in corch-quota-binding |
| 2 | MED | cleanup picks an older run host (worktree_path ordering) | FIXED: store.workspaceHostsForItem; release removes on every recorded host; test |

QC-R4 MEDs: (1) pr_lookup now gh api pulls with server-side head=owner:branch, --hostname github.com, head repo re-checked; (2) host recorded before ensure via store.recordRunSupervisor, release never guesses (no recorded host: logged, left). Both confirmed resolved by Codex.
