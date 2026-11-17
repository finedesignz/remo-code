# QC round 1 (Codex, external seat responded) - QC-FAIL, 9 findings

Diff: `git diff phase-corch-08-aaf-event-receiver...d0aaec8`.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | Slot token can leave via runner output (child can print its env) | FIXED: with the slot set every runner event is passed through `redactSecret` (exact token value) before the listener; test |
| 2 | HIGH | Reused clone not bound to requested repo; credential helper not host-scoped | FIXED: `originMatches` (toplevel + `origin` url) -> `clone_origin_mismatch`; helper keyed `credential.https://github.com.helper`; tests |
| 3 | HIGH | Scheduled generic commands can invoke advertised `corch.*` | FIXED: `corch.*` no longer advertised (`NATIVE`); hub RPC allowlist unchanged; test |
| 4 | MED | No-slot spawn still inherits token/config dir | ADJUDICATED by-design, see QC-ADJUDICATION.md |
| 5 | MED | Cleanup missing on reclaim-blocked and gsd-console cancel; doc said no cancel path | FIXED: reclaim releases (blocked/requeued); `applyGsdcBoards` reports cancelled ids -> `releaseWorkItemNow(cancelled)` (removes worktree); docs corrected |
| 6 | MED | Claim not unwound on post-resolve failure paths / rejected send | FIXED: try/catch around the whole post-claim section; `releaseIfClaimed` on every requeue end (refusal, failure, quota death, reclaim); tests |
| 7 | HIGH | RPC timeout releases the claim while git may still run | FIXED: supervisor kills git/gh at 240s (< hub 600s); a `supervisor_timeout` never releases the claim; tests |
| 8 | HIGH | Removal force-deletes without branch ownership / canonical sandbox | FIXED: canonical path sandboxed; only a worktree on exactly `corch/<id>` is removed (`worktree_wrong_branch`); test |
| 9 | MED | Heartbeat stops at pr_open; failed heartbeat ignored | FIXED: reconciler heartbeats `pr_open` items (`prOpenItems`); a not-recorded heartbeat is logged; e2e |
