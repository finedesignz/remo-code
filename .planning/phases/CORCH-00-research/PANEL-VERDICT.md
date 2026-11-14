# CORCH panel verdict (locked 2026-11-13 by milestone orchestrator)

Seats: A (correctness/failure modes), B (scope/reuse), C (security/ops), all sonnet, independent. Files: PANEL-A.md, PANEL-B.md, PANEL-C.md. Owner not asked (rule 10).

| Fork | Locked verdict | Vote |
|---|---|---|
| F1 dispatcher | REPLACE: new repo-keyed cross-repo work-item queue in hub (`hub/src/corch/`), reusing only dispatch primitives (gate chain incl. cost+token caps, kill switch, lifetime ledger with new counter-key kind `corch:<work_item_id>`, governedLaunch/launch primitive, slot reserve). Do not extend runMacroCycle/routine_queue/orchestrator rows. New flag `REMO_CORCH_ENABLED` default OFF; hub refuses to boot with both `REMO_CORCH_ENABLED` and `REMO_ORCHESTRATOR_ENABLED` ON. Old orchestrator untouched until retire phase. | 3/3 |
| F2 backlog | Hub Postgres is the system of record (`corch_projects`, `corch_work_items`, `corch_runs`; additive DDL in schema.sql). Candidate phases come ONLY from gsd-console (`gsdc_` board:read: `GET /api/board/projects`, `/{id}` columns, `GET /api/board/stream` SSE as trigger). No supervisor `.planning` reads. Owner priority, concurrency cap, per-project daily token budget live in hub tables. AAF tickets + memlog requests enter via one idempotent explicit-scope enqueue endpoint (`ext:corch`), behind a default-empty repo allowlist. Mirrored text is fenced as untrusted data (`fenceUntrusted`), never instructions. gsd-console down/stale = no new candidates (fail closed). | 3/3 |
| F3 quota | CUG POSTs its existing usage-snapshot v1 (email dropped) to `POST /api/quota/snapshot` with EXPLICIT-only scope `quota:publish`; hub persists latest per account in Postgres (`corch_quota_accounts`, upsert); AAF reads `GET /api/quota/snapshot` with EXPLICIT-only `quota:read` at claim time (no timer). Fail closed: snapshot older than 600s, account reading older than 900s, or source != live => account ineligible; no eligible account => item waits (not consumed). `five_h_pct` null = unknown, not 0: eligible only if 7d known and below ceiling, max 1 concurrent session on that account. A 429/quota death blocks that account until its reset time. | 3/3 (storage: Postgres per A, over B's in-memory, so AAF and restart keep continuity) |
| F4 server worker | One headless Linux supervisor container per account slot on Coolify (cloud-session Bun source path, no tray/ConPTY), each holding exactly ONE `CLAUDE_CODE_OAUTH_TOKEN` as a Coolify runtime secret; registers with its own `purpose='host'` key and advertises `account_slot`. Hub picks an account by picking a supervisor; token never transits or is stored in the hub. Worktree per work item created by a new allowlisted supervisor command at a deterministic path; per-slot `CLAUDE_CONFIG_DIR`. Desktop supervisors are not CORCH dispatch targets in v1 (unknown account). Single all-tokens container rejected: one prompt-injected session could read five other tokens. | 2/1 (A,C over B) |
| F5 PR closure | Identity: code is identity-agnostic; PRs come from same-repo `corch/<work_item_id>` branches pushed by the worker's git credential. Preferred author = dedicated machine user with write (A,C); creating it is an owner action listed in the cutover list (12b gate 4). AAF: (1) `POST /api/projects/provision` over existing `provisionReposCoreWith` (scope `projects:write`), hub calls it on project enrollment; (2) red-CI adoption by convention: head ref `corch/*` + same-repo + author in `CORCH_TRUSTED_PR_AUTHORS` + provisioned project => route failing checks to `enqueuePrFollowupInTransaction` kind `ci`. (3) AAF outbox table + existing `signedPost`; events `pr.merged`, `pr.closed` (unmerged), `pr.failed` (fix ladder exhausted). Hub receiver uses `runIntake` pattern: raw body, constant-time HMAC over `${ts}.${rawBody}`, 5-min skew, dedupe on `event_id`, mounted before auth catch-all. `pr.closed` unmerged = item -> `blocked`, never auto-requeued. Noted exposure (C): AAF trusted-PR auto-merge skips review gate on green CI; out of scope, logged. | 3/3 on provision+outbox; adoption-by-convention + author allowlist merges B and C |

## Phase order (F6) - one phase = one PR in one repo
1. remo-code CORCH-01 backlog tables + dispatcher core (manual enqueue API, priority, concurrency cap, per-project daily token budget, claim/heartbeat/reclaim, requeue on death/quota with `not_before`, `corch:` counter key + guard updates, gate chain, flag OFF + mutual exclusion; quota provider interface defaulting to "no snapshot" = fail closed).
2. remo-code CORCH-02 quota ingest + per-account selection.
3. claude-usage-guard CORCH-03 publisher (`hub_publish.rs`).
4. remo-code CORCH-04 gsd-console ingestion.
5. agentautofix CORCH-05 provision API + convention adoption.
6. agentautofix CORCH-06 outbound event outbox.
7. agentautofix CORCH-07 quota feed read before fixer launch.
8. remo-code CORCH-08 AAF event receiver + closure transitions + provision on enrollment.
9. remo-code CORCH-09 supervisor account-slot injection + worktree command.
10. remo-code CORCH-10 Linux per-slot supervisor image + Coolify runbook (not deployed with real tokens).
11. remo-code CORCH-11 status view, remote pause/priority, Telegram /queue.
12. remo-code CORCH-12 throwaway-repo end-to-end proof + enable runbook.
13. remo-code CORCH-13 retire overlapping flag-OFF code (macro orchestrator path, merge-command, PR wave-runner, heal duplication where AAF owns it).

Precondition to verify in CORCH-01 research: PTYCAP Phase 4 ledger "2 open HIGH races" (seat A) - confirm stale or real before relying on the ledger for idempotency.
