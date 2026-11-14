# QC round 2 (Codex, external seat responded) - QC-FAIL, 7 findings

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | Token redaction incomplete (split chunks, keys, git tokens) | FIXED keys + GH_TOKEN/GITHUB_TOKEN + multi-secret; split/re-encoded ADJUDICATED (QC-ADJUDICATION.md) |
| 2 | MED | attachSession failure leaks the claim (no worktree_path yet) | FIXED: in-process `claimOwner` recorded right after resolve; e2e test |
| 3 | HIGH | Old run cleanup can release a newer run's claim | FIXED: per-item lock + owner fencing; `releaseIfClaimed` skips when a newer run owns it; e2e test |
| 4 | HIGH | Timeout bound per command, not per operation; final-attempt blocked release defeats "no release on timeout" | FIXED: one 480s budget per ensure (shared deadline), `unconfirmed` set blocks release for blocked/requeued after a timeout; tests |
| 5 | MED | Release looks only at the newest run | FIXED: `latestRunForItem` prefers the newest run WITH a worktree |
| 6 | MED | gh lookup not bound to the repo (GH_REPO override) | FIXED: `--repo owner/name` passed by the hub, `GH_REPO` removed from env; tests |
| 7 | MED | pr_open heartbeat starves beyond 500 items | FIXED: id-cursor pagination (200/pass); store ordered by id |
