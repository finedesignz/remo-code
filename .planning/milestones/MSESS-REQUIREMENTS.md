<!-- updated: 2026-07-13 -->
# Milestone MSESS — Multiple Sessions per Repo / Worktree / Branch — REQUIREMENTS

**Milestone CODE:** `MSESS` (phase dirs/labels prefixed `MSESS-NN-slug`, collision-safe per global rule).
**Status:** SCOPED ONLY — not the current milestone. Queued in `.planning/PROJECT.md` **after PTYCAP**.
**Owner request (verbatim):** *"add the ability to have multiple sessions for the same repo and worktree or branch. similar to what can be done in a terminal on the host machine."*

## Goal

Give the user what a host terminal gives them: **N concurrent, independent sessions against the
same repo** — same worktree, same branch, several tabs — each with its own CLI process, its own
PTY, its own scrollback, individually named, addressable and switchable in the web/phone UI.

Today that is structurally impossible: **session identity IS the directory.** Two hub unique
indexes and one supervisor-side dedupe collapse every start for the same repo onto ONE row and ONE
runner. This milestone moves identity from *directory* to *session*, and adds the caps that must
exist before a spend amplifier ships.

## Why it is gated on PTYCAP

Each session is a live PTY. N sessions per repo multiplies concurrent PTYs, i.e. it multiplies the
one path that today has **no token ceiling** (the human PTY path). Owner rule: *cap the PTY path
BEFORE arming automation on it.* MSESS ships only on top of a token-gated PTY.

## The three cases (different difficulty — do not conflate)

| Case | Meaning | Difficulty |
|---|---|---|
| **A — worktree-per-session** | Each session gets its own directory (`repo-<slug>` worktree). Distinct `project_dir` ⇒ mostly works TODAY (modulo `repo_key` uniqueness, which collapses two worktrees of one GitHub repo onto one row). | Low — unblock + first-class UX. |
| **B — same dir, different branch** | Not real: a checkout has ONE HEAD. Two sessions "on different branches" in one dir means one of them silently switches HEAD under the other. **Must be refused, not supported.** | N/A — must be blocked. |
| **C — same dir, same branch, N sessions** | The hard case, and the literal ask. Requires per-session identity end-to-end AND an explicit concurrent-write hazard acceptance. | High. |

## Recommendation (design stance for this milestone)

**ENCOURAGE worktree-per-session; ALLOW same-dir multi-session with eyes open.**

- The **default** "New session on this repo" action **offers to create a git worktree** (`git worktree add ../<repo>-<slug> -b <branch>`) and binds the new session to it. This is the safe, git-native equivalent of "another terminal tab", and it is the shape the repo's own CLAUDE.md already mandates for humans.
- **Same-dir multi-session is ALLOWED but must be a deliberate, warned choice.** Rationale: it is what the owner literally asked for, and it is genuinely correct for the common read/query/review session ("second tab to ask questions while the first builds"). N *writing* agents in one working tree WILL corrupt each other (`.git/index.lock` contention, one agent's `git checkout`/`stash` ripping files out from under another, half-applied edits). So: same-dir sessions beyond the first are created in an explicit **`concurrent_writes_acknowledged`** state, are visually flagged in the UI, and default to a **read-oriented** posture.
- **Case B (same dir, different branch) is REFUSED** with an actionable error that offers to create a worktree instead. Never silently switch HEAD.

## Requirements (REQ-IDs)

### IDENT — session identity moves from directory to session

- **IDENT-01 (drop dir-as-identity in DB):** `sessions` gains a stable per-session key and the two
  unique indexes that pin one-live-session-per-dir/per-repo are replaced by ones that permit N:
  `idx_sessions_user_project_unique` on `(user_id, project_dir) WHERE deleted_at IS NULL AND is_rootless=false`
  (schema.sql:1258) and `idx_sessions_user_repo_key` on `(user_id, repo_key)` (schema.sql:951).
  Uniqueness must be preserved on whatever key still needs it (the agent-reconnect race the old index
  guarded) — i.e. it becomes unique on the *session handle*, not on the directory.
- **IDENT-02 (agent auth carries a session handle):** `/ws/agent` auth (`agent-protocol.ts:57`,
  `agent.ts:339-390`) accepts an optional `session_handle` alongside `project_dir`. When present, the hub
  binds the socket to THAT session row; when absent it falls back to today's find-or-create-by-dir so
  older supervisors keep working unchanged.
- **IDENT-03 (resume is per-session, not per-dir):** the "resume with full history" guarantee is
  re-anchored on the session handle. Restarting a supervisor reconnects each of the N sessions on a repo
  to its own CLI transcript, not all of them to one.
- **IDENT-04 (supervisor runner keyed by session, not repoPath):** the supervisor no longer treats a
  second start for a live `repoPath` as a duplicate (`process-manager.ts:287 activeRunIdForRepo`,
  `:273 hasCrashedPendingForRepo`) — dedupe keys on the session handle so a genuine second session on
  the same repo spawns a second CLI, while a repeated start for the SAME session still reuses the
  live runner (the leak fix that motivated the repoPath dedupe must not regress).
- **IDENT-05 (session_inventory reports handles):** the supervisor's `session_inventory` frame
  (`hub-client.ts:31`) and the hub registry (`ws/supervisor-registry.ts`) express liveness per session
  handle, so "is this session alive" never means "is anything alive in this directory".
- **IDENT-06 (ghost-reaper stays sound):** the ghost signature (`online AND hostname IS NULL` with a
  phantom channel, `ws/ghost-reaper.ts`) and the inject-side `isSessionLive` check must remain correct
  when N rows share one `project_dir`. No sweep may reap session X because session Y on the same dir
  looks live (or dead).
- **IDENT-07 (orchestrator uniqueness untouched):** `idx_sessions_orchestrator_unique`
  (schema.sql:1011, `is_orchestrator=true` partial unique) is NOT relaxed — exactly one open
  orchestrator session per user still holds. Multi-session applies to ordinary repo sessions only.

### WT — worktrees and branches

- **WT-01 (worktree-per-session, first class):** creating a session on a repo that already has a live
  session offers "new git worktree" as the default, runs `git worktree add`, and binds the new session
  to the new directory.
- **WT-02 (two worktrees of one repo are two sessions):** distinct worktrees of the same GitHub repo
  must be able to hold live sessions simultaneously (today `repo_key` uniqueness collapses them).
- **WT-03 (refuse same-dir-different-branch):** starting a session on an existing directory with a
  branch that differs from its current HEAD is refused with `branch_conflict` and an offer to create
  a worktree. HEAD is never switched under a live session.
- **WT-04 (worktree lifecycle):** removing a session that owns a hub-created worktree offers to
  `git worktree remove` it; never deletes a directory the user created.

### RISK — same-directory concurrency hazard

- **RISK-01 (explicit acknowledgement):** the 2nd+ session on an already-occupied directory can only
  be created with an explicit acknowledgement (persisted on the session row), never silently.
- **RISK-02 (visible flag):** any session sharing a directory with another live session is visually
  marked in the sidebar/grid ("shares working tree with N others").
- **RISK-03 (no automation on shared trees):** orchestrator/scheduler/autospawn dispatch NEVER targets
  a session flagged as directory-sharing. Automation gets a worktree or it gets nothing.

### CAP — spend + concurrency ceilings (non-negotiable)

- **CAP-01 (per-repo session cap):** a hard cap on live sessions per (user, repo), default small
  (e.g. 4), enforced server-side at create/launch.
- **CAP-02 (per-user live-session cap):** a hard global cap on live sessions per user, enforced at the
  same seam as CAP-01.
- **CAP-03 (concurrency budget still authoritative):** every launched session still passes through
  `reserveSessionSlot` (`hub/src/sessions/budget.ts:64`) inside its `FOR UPDATE` window. N-per-repo
  must not re-create the `at_capacity` lockout class: each session's run row carries a real
  `session_id` (never NULL) so the open-run count can never drift.
- **CAP-04 (token cap unchanged and non-bypassable):** `dailyTokenCapGate` (all four token buckets) and
  the per-session inject-rate ceiling remain on every dispatch path, unmodified. Multi-session must not
  introduce a new dispatch seam that skips them.
- **CAP-05 (PTY token accounting per session):** PTYCAP's ceiling is enforced per session AND in
  aggregate per user, so N PTYs cannot multiply past the user ceiling. **Hard dependency on PTYCAP.**
- **CAP-06 (idle teardown per session):** idle teardown (`hub/src/ws/idle-teardown.ts`) reaps each
  session independently on its own subscriber count; N idle tabs on one repo are N reaps, and reaping
  one must not kill its siblings' CLI.

### UI — naming, listing, switching

- **UI-01 (user-nameable sessions):** every session has an editable display name, defaulting to
  `<repo> #2`, `<repo> #3`, …; rename is inline in the sidebar and persists.
- **UI-02 (sidebar groups N under one repo):** the sidebar/Connections table nests the N sessions under
  their repo row (respecting existing repo grouping), rather than showing N identical repo rows.
- **UI-03 (new-session affordance):** a "+" on a repo row creates another session on that repo, driving
  the WT-01 worktree-or-same-dir choice.
- **UI-04 (grid handles siblings):** grid view (cap 12 subscriptions) can hold multiple sessions of the
  same repo in different cells, each with its own scrollback, without cell/label collision.
- **UI-05 (Telegram/deep-link addressing):** a session is addressable by handle, not by repo, on every
  out-of-band surface (Telegram bind, deep links) — binding to "the repo" is ambiguous once N exist.

### MIGR — migration + compatibility

- **MIGR-01 (idempotent DDL only):** all schema changes are idempotent DDL in `hub/src/db/schema.sql`
  (it **re-runs in full on every hub boot**). Any data backfill is a one-shot script in `hub/scripts/`,
  never inline. Migration id, if the phase adds one, is milestone-prefixed: `msess_NNNN_slug`.
- **MIGR-02 (old supervisors keep working):** a supervisor that does not send a session handle must
  continue to behave exactly as today (one session per dir). No installed host breaks on hub deploy.
- **MIGR-03 (release gating stated):** every phase is labelled **hub-only** (ships with a Coolify
  deploy) or **needs a new signed supervisor MSI** (cannot reach installed hosts without a release).

### QC — proof

- **QC-01 (e2e: N sessions, one dir):** real-Postgres e2e proving two sessions on ONE `project_dir`
  hold two distinct rows, two distinct runs, two distinct CLI processes, and two independent
  transcripts — and that neither reaper/teardown/ghost sweep kills the other.
- **QC-02 (regression: no run leak):** e2e proving N-per-repo does not leak open `session_runs`
  (the `at_capacity` lockout class) — every launched run carries a `session_id` and closes.
- **QC-03 (guard test: caps cannot be bypassed):** a test that fails CI if any new multi-session
  dispatch/launch seam omits `dailyTokenCapGate` / `dailyCostCapGate` / `reserveSessionSlot`.

## Future Requirements (explicitly deferred)

- **Session templates / cloning** (fork a session with its cwd + name preset).
- **Cross-session broadcast** ("send this prompt to all sessions on repo X").
- **Automatic worktree GC** (prune worktrees whose session has been dead N days).
- **Per-session model/backend override** (session 1 on Claude, session 2 on Codex, same repo).
- **Shared-tree write serialization** (a real cross-session git-index lease) — only if same-dir
  writing turns out to be a demanded workflow rather than an accepted-risk edge.

## Out of Scope (with reasoning)

- **Relaxing `idx_sessions_orchestrator_unique`.** Exactly one orchestrator per user is a load-bearing
  invariant across the auto-dev machinery; multi-session has no need of a second orchestrator.
- **Making same-dir concurrent WRITES safe.** Git offers no such guarantee; the correct answer is a
  worktree. Attempting index arbitration would be a large, low-value, high-risk subsystem.
- **Multi-session for automation/orchestrator dispatch.** Automation gets exactly one session per repo
  (RISK-03). Fanning the orchestrator out across N sessions is a spend multiplier with no proven value.
- **Changing the PTY human-only guard or the no-API-key-on-PTY invariant.** Untouched.
- **Raising the grid's 12-subscription cap.** Orthogonal; N-per-repo must fit inside the existing cap.
- **Any new spend ceiling design.** PTYCAP owns that; MSESS consumes it.
