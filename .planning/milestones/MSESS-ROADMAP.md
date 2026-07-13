<!-- updated: 2026-07-13 -->
# Milestone MSESS — Multiple Sessions per Repo / Worktree / Branch — ROADMAP

**Requirements:** [MSESS-REQUIREMENTS.md](MSESS-REQUIREMENTS.md)
**Phase dirs:** `.planning/phases/MSESS-NN-slug/` — the `MSESS-` prefix is **mandatory**; a bare
`NN-slug` collides with concurrent milestones when `.planning/` merges.
**Status:** scoped only. Queued after **PTYCAP**. Not in flight.

## Sequencing risk — read before planning any phase

| Ships how | Phases | Consequence |
|---|---|---|
| **Hub-only** (Coolify deploy reaches prod immediately) | 01, 02, 05, 07*, 08, 09, 10, 11 | Safe to iterate. |
| **NEEDS A NEW SIGNED SUPERVISOR MSI** (cannot reach installed hosts without a release) | **03, 04, 06** | These touch `supervisor/` and/or the Rust `pty_host`. Nothing works on an installed host until an MSI is cut, signed (Azure Trusted Signing) and auto-updated out. Plan them as ONE release train, not three. |

\* Phase 07 is hub-only **only if** worktree creation is delegated to the supervisor's existing
`run_command` allowlist. If it needs a NEW supervisor command (`git_worktree_add`), 07 joins the MSI
train. Decide that in 07's discuss step — it is the single biggest scope fork in this milestone.

**Hard ordering constraints**
1. **PTYCAP must be shipped and proven first.** MSESS multiplies concurrent PTYs; CAP-05 consumes
   PTYCAP's ceiling. Do not start 06 (or arm 09's "+" button in prod) before PTYCAP is green.
2. **Phase 01 (schema) before everything.** Every other phase assumes per-session identity.
3. **Phases 05 + 06 (caps) before Phase 09 (the UI that lets a user create N sessions).** Ship the
   ceiling before the amplifier. Keep the "+" affordance behind a flag until 05/06 are live.
4. **Any DB migration a phase adds uses a milestone-prefixed id** — `msess_NNNN_slug`, never a bare
   date-numbered one. `schema.sql` **re-runs in full every hub boot** ⇒ idempotent DDL only; backfills
   are one-shot scripts in `hub/scripts/`.

## Phases

### MSESS-01 — identity-schema (hub-only)
**Goal:** session identity stops being the directory at the DB layer.
**REQ-IDs:** IDENT-01, IDENT-07, MIGR-01
**Success criteria**
- `idx_sessions_user_project_unique` (schema.sql:1258) and `idx_sessions_user_repo_key` (schema.sql:951) no longer forbid a 2nd live session on one `project_dir`/`repo_key`; whatever uniqueness the agent-reconnect race needs is re-expressed on the session handle.
- `idx_sessions_orchestrator_unique` (schema.sql:1011) is untouched and still rejects a 2nd open orchestrator.
- All DDL is idempotent and survives two consecutive hub boots against a populated DB; any backfill lives in `hub/scripts/msess-*.ts`.
- Migration (if any) is `msess_0001_session_handle`.

### MSESS-02 — agent-handle-protocol (hub-only)
**Goal:** `/ws/agent` can bind a socket to a *specific* session instead of find-or-create-by-dir.
**REQ-IDs:** IDENT-02, MIGR-02
**Success criteria**
- `agent-protocol.ts` accepts an optional `session_handle`; `agent.ts` binds to that row when present.
- A supervisor that omits the handle behaves EXACTLY as today (one session per dir) — proven by an existing-supervisor compat test.
- Two agent sockets on the same `project_dir` with different handles authenticate into two different session rows.

### MSESS-03 — supervisor-multi-runner (**NEW MSI**)
**Goal:** the supervisor hosts N CLI processes on one repo path.
**REQ-IDs:** IDENT-04, IDENT-05
**Success criteria**
- `activeRunIdForRepo` / `hasCrashedPendingForRepo` (process-manager.ts:273/287) key on the session handle, not `repoPath` — a second session spawns a second CLI.
- A repeated start for the SAME session still reuses the live runner (the run-leak fix that motivated the repoPath dedupe does not regress) — covered by a dedicated test.
- `session_inventory` (hub-client.ts:31) reports one entry per session handle; `supervisor-registry` liveness is per handle.

### MSESS-04 — resume-and-liveness (**NEW MSI**)
**Goal:** N sessions on one dir resume, teardown, and get reaped independently.
**REQ-IDs:** IDENT-03, IDENT-06, CAP-06
**Success criteria**
- Supervisor restart reconnects each of N sessions on one repo to ITS OWN transcript (resume is per-session, not per-dir).
- The ghost-reaper never reaps session X because sibling Y on the same dir looks live/dead; `isSessionLive` is handle-scoped.
- Idle teardown reaps each session on its own subscriber count; killing one leaves its siblings' CLI running (test proves it).

### MSESS-05 — caps-and-budget (hub-only)
**Goal:** N-per-repo cannot re-create the `at_capacity` lockout or an unbounded spend fan-out.
**REQ-IDs:** CAP-01, CAP-02, CAP-03, CAP-04
**Success criteria**
- Server-side per-(user,repo) cap and per-user live-session cap, both enforced at create/launch, both returning a clear refusal (not a silent no-op).
- Every launched session's `session_runs` row carries a real (non-NULL) `session_id` and passes through `reserveSessionSlot` (budget.ts:64).
- `dailyTokenCapGate` + `dailyCostCapGate` remain on every dispatch path, unmodified; no new seam skips them.

### MSESS-06 — pty-token-accounting (**NEW MSI**; depends on PTYCAP)
**Goal:** N PTYs cannot multiply past the user's PTY token ceiling.
**REQ-IDs:** CAP-05
**Success criteria**
- PTY token usage is attributed per session AND aggregated per user; the aggregate is what the ceiling gates on.
- With the ceiling set low, opening a 2nd PTY on the same repo is refused once the user aggregate is exhausted — proven live, not asserted.
- The no-API-key-on-PTY and human-only-PTY invariants are unchanged (guard tests still green).

### MSESS-07 — worktree-lifecycle (hub-only *if* no new supervisor command; see note above)
**Goal:** the safe path — one worktree per session — is the default, and branch conflicts are refused.
**REQ-IDs:** WT-01, WT-02, WT-03, WT-04
**Success criteria**
- "New session on this repo" defaults to creating a git worktree and binds the session to it.
- Two worktrees of the SAME GitHub repo hold live sessions simultaneously (the old `repo_key` collapse is gone).
- Starting a session on an occupied dir with a different branch is refused `branch_conflict` + offers a worktree; HEAD is never switched under a live session.
- Deleting a session that owns a hub-created worktree offers `git worktree remove`; a user-created directory is never deleted.

### MSESS-08 — shared-tree-risk (hub-only)
**Goal:** same-dir multi-session is possible, deliberate, visible, and never driven by automation.
**REQ-IDs:** RISK-01, RISK-02, RISK-03
**Success criteria**
- The 2nd+ session on an occupied directory requires an explicit acknowledgement persisted on the row; it cannot be created silently or by API default.
- Such a session is flagged in every list surface ("shares working tree with N others").
- Orchestrator / scheduler / autospawn dispatch refuses a directory-sharing session (`refused:shared_tree`) — guard-tested.

### MSESS-09 — ui-sessions-per-repo (hub-only; gate the "+" until 05/06 are live)
**Goal:** N sessions per repo are nameable, listable, and switchable like terminal tabs.
**REQ-IDs:** UI-01, UI-02, UI-03, UI-04
**Success criteria**
- Every session has an inline-editable name, defaulting `<repo> #2`, `#3`, …; rename persists.
- The sidebar / Connections table nests N sessions under one repo row (repo grouping respected), not N duplicate repo rows.
- A "+" on a repo row creates another session, driving the WT-01 worktree-or-same-dir choice.
- Grid view holds ≥2 sessions of the same repo in different cells, each with its own scrollback and a distinguishable label, inside the existing 12-subscription cap.

### MSESS-10 — out-of-band-addressing (hub-only)
**Goal:** every non-web surface addresses a *session*, never "the repo".
**REQ-IDs:** UI-05
**Success criteria**
- Telegram bind and deep links resolve a session handle; binding by repo alone is rejected as ambiguous when N>1 (with a disambiguation list).
- An existing single-session bind keeps working unchanged (no user-visible breakage).

### MSESS-11 — prove-out-and-release (hub + the MSI train)
**Goal:** the whole thing is proven against real Postgres and a real host, and shipped.
**REQ-IDs:** QC-01, QC-02, QC-03, MIGR-03
**Success criteria**
- e2e (real Postgres): two sessions on ONE `project_dir` ⇒ two rows, two runs, two CLI processes, two independent transcripts; no reaper/teardown kills a sibling.
- e2e: N-per-repo leaks zero open `session_runs`; the `at_capacity` class does not return.
- CI guard fails if a new multi-session launch/dispatch seam omits `dailyTokenCapGate` / `dailyCostCapGate` / `reserveSessionSlot`.
- Docs + `CLAUDE.md` updated in the same commit; the signed supervisor MSI carrying phases 03/04/06 is released and the release-gating table (MIGR-03) is stated in the docs.

## Coverage validation — 100%

31 requirements, each mapped to **exactly one** phase.

| Phase | REQ-IDs | Count |
|---|---|---|
| MSESS-01 | IDENT-01, IDENT-07, MIGR-01 | 3 |
| MSESS-02 | IDENT-02, MIGR-02 | 2 |
| MSESS-03 | IDENT-04, IDENT-05 | 2 |
| MSESS-04 | IDENT-03, IDENT-06, CAP-06 | 3 |
| MSESS-05 | CAP-01, CAP-02, CAP-03, CAP-04 | 4 |
| MSESS-06 | CAP-05 | 1 |
| MSESS-07 | WT-01, WT-02, WT-03, WT-04 | 4 |
| MSESS-08 | RISK-01, RISK-02, RISK-03 | 3 |
| MSESS-09 | UI-01, UI-02, UI-03, UI-04 | 4 |
| MSESS-10 | UI-05 | 1 |
| MSESS-11 | QC-01, QC-02, QC-03, MIGR-03 | 4 |
| **Total** | | **31 / 31** |

No requirement is unmapped; no requirement appears in two phases.
