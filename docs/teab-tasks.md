# TEAB Tasks — Titanium Edge AutoBuilder as a Scheduled Task

Milestone **TEAB** (planning: [.planning/TEAB-MILESTONE.md](../.planning/TEAB-MILESTONE.md))
makes **Titanium Edge AutoBuilder** (TEAB — a standalone Node CLI,
`teab run --repo <project>`) a first-class remo-code scheduled-task action. A TEAB
task is scheduled and targeted exactly like any other task, but its executor is
`teab run --repo <X>` running **on the supervisor host** instead of a Claude prompt
injected into a session.

> **Status:** shipped on `feat/teab-task` (Phases TEAB-01..08). The hub side ships
> with the normal hub deploy; **the supervisor side requires a new signed MSI** — see
> [Release gating](#release-gating) below.

---

## Why this shape

- TEAB itself spawns headless `claude` subagents to drive a repo's `.planning/`
  roadmap to completion. It MUST run where the repos + `claude` + `teab` live — the
  **supervisor host**. The hub is containerized and cannot see them.
- remo-code tasks normally only inject a prompt into a session. The supervisor
  already exposes a generic, allowlisted `run_command` registry
  (`supervisor/src/commands/index.ts` → `getHandler`). A new `teab_run` handler slots
  in there with zero new RPC surface and no arbitrary-shell hole.
- A TEAB roadmap runs for **hours** — far longer than the hub can hold a turn open
  (idle-teardown reaps subscriber-less sessions). So the model is **background spawn
  on the supervisor + hub-driven poll-to-terminal**, never a blocking foreground turn.

---

## Architecture

```
  Scheduled task (task_type:'teab', teab_repo_ident)
        │  cron fires → dispatcher (threshold → cost-cap gates)
        ▼
  hub/src/scheduler/senders/teab.ts  ──run_command teab_run [repoIdent]──▶  Supervisor
        │  startTeabPoll() (hub-owned, no subscriber dep)                         │
        │                                                                         ▼
        │                                              supervisor/src/commands/teab-run.ts
        │                                              preflight (fail-closed) → spawn DETACHED
        │  ◀──run_finished started-ack {run_id,pid}───  `teab run --repo <repo>`
        │  ──run_command teab_status [teabRunId]──▶  (poll loop every REMO_TEAB_POLL_INTERVAL_MS)
        │  ◀──{state, exit_code, events_tail}────────
        ▼
  state:'exited' (or REMO_TEAB_MAX_RUN_MS ceiling)
        │  finalizeRun(success|failed, …) → mirror teab_last_status
        ▼
  Post-run action pipeline (email / telegram / webhook) — unchanged
```

---

## Supervisor: `teab_run` / `teab_status`

`supervisor/src/commands/teab-run.ts`, registered in
`supervisor/src/commands/index.ts` (`HANDLERS`) and advertised in
`nativeSupervisorCommands()`.

- **`teab_run` args `[repoPath]`** → background-spawns `teab run --repo <repo>`
  **detached** (`detached: true`, `child.unref()` — survives a supervisor restart),
  tracks the child PID + a ring-buffered events tail in an in-memory run registry
  (keyed by an internal `teab_<uuid>` run id), and returns a started ack
  **immediately** (`{ run_id, started: true, pid }`) without awaiting completion.
- **`teab_status` args `[runId]`** → `{ state: 'running'|'exited', exit_code, events_tail }`
  (last 50 tail lines) for a given internal run id; `unknown_run` if absent.

### Preflight — fails CLOSED

`preflightTeab()` returns the FIRST specific error before any spawn:

| error | meaning |
|---|---|
| `repo_not_found` | `repoPath` missing / not absolute / not present on disk |
| `teab_not_found` | `teab` (or `TEAB_BIN`) not resolvable on PATH |
| `claude_not_found` | `claude` (or `TEAB_CLAUDE_BIN`) not resolvable on PATH |
| `missing_planning` | target repo has no `.planning/` directory |
| `missing_guard_hook` | target repo missing `.claude/hooks/irreversible-action-guard.mjs` (the D3 Tier-1 guard) |

### Hard spawn invariant

Mirrors the human-PTY path. The supervisor launches **only** the `teab` binary with
an exact `['run','--repo',<repo>]` argv — nothing else. It NEVER passes a
programmatic flag (`-p`/`--print`/`--input-format`/`--output-format`/`stream-json`),
an API key, or `--dangerously-skip-permissions` / `bypassPermissions`. **TEAB owns
its own `claude` spawns and permission contract** — the target repo's D3
`irreversible-action-guard.mjs` hook is what enforces TEAB's Tier-1 contract, NOT
`bypassPermissions`. Spawn env is routed through the shared
`supervisor/src/runners/env-sanitize.ts` scrubber, so no inherited provider
credential leaks through.

Guarded by `supervisor/test/no-programmatic-tokens.test.ts` family
(`teab-no-programmatic-tokens.test.ts`) — the canary asserts the constructed argv
never contains a forbidden token.

### Breadcrumb

`supervisor/src/runners/teab-breadcrumb.ts` writes a **fail-open** START/STOP
breadcrumb per run (same pattern as `session-breadcrumb.ts`) so a run is observable
across a supervisor restart that wipes the in-memory registry.

---

## Hub: data model + routing

### `task_type: 'teab'`

- Added to `TaskType` in `hub/src/db/scheduled-tasks-dal.ts`; accepted + persisted by
  `hub/src/api/scheduled-tasks.ts`; `auto-name.ts` label updated.
- **Additive columns** `teab_repo_ident` (the build target — `github://owner/repo`
  or `path://<abs>`) and `teab_last_status` (last poll mirror). Idempotent DDL in
  `schema.sql` **and** a one-shot `hub/scripts/migrate-teab-task-columns.ts`
  (schema.sql re-runs every boot → backfills live in `hub/scripts/`, never inline).

### Dispatch + poll-to-terminal

`hub/src/scheduler/dispatcher.ts` routes `task_type === 'teab'` — **after** the
existing gate pre-check (`threshold → cost-cap`) — to
`hub/src/scheduler/senders/teab.ts`:

1. `resolveTeabSupervisorId()` picks the online supervisor that hosts the repo
   (prefers the one whose inventory contains `teab_repo_ident`; falls back to the
   sole/first online supervisor). No online supervisor → `skipped/no_online_supervisor`.
2. Marks the run `in_flight`, mirrors `teab_last_status='started'`, emits
   `run_command teab_run args:[repoIdent]`.
3. `startTeabPoll()` registers a **hub-owned** background poll (interval `unref`'d, no
   subscriber dependency → **survives idle-teardown**). The started-ack carries the
   supervisor's internal teab run id; from then on each tick emits
   `run_command teab_status` and `handleTeabRunEvent` correlates the reply:
   - started-ack → capture internal id, mirror `teab_last_status='running'`, kick an
     immediate status poll;
   - `{state:'exited'}` → finalize `success` (exit 0) / `failed` (`teab_exit_<n>`);
   - terminal `run_finished` (error / non-zero) → finalize `failed`;
   - `REMO_TEAB_MAX_RUN_MS` deadline lapses → finalize `failed/teab_run_timeout`.
4. `finalizeRun()` fires the existing **post-run action pipeline**
   (email / telegram / webhook), exactly like every other task type. Terminal-once
   guard means a late/duplicate event never double-finalizes.

Wired into `hub/src/ws/agent.ts` (supervisor `run_finished` events route through
`handleTeabRunEvent` before the generic run handling).

### Cost / token cap stays non-bypassable

TEAB dispatch flows through the dispatcher's existing gate pre-check
(`checkUserThreshold` → `isOverCostCap`) before the sender is ever reached — the
cap is **not** re-implemented or bypassed. The same non-bypassable
`dailyCostCapGate` (and, on the orchestrator inject path, `dailyTokenCapGate`)
applies. A TEAB build's own `claude` spend is the operator's concern on the
supervisor host; the remo-code cap still governs whether the task is allowed to
dispatch.

---

## Web: task editor

- `web/src/components/ScheduleEditor.tsx` offers a **"TEAB build"** task type.
- `web/src/components/TeabRepoPicker.tsx` is a repo picker mirroring the existing
  Connect repo→session flow; saving persists `teab_repo_ident`.
- `web/src/pages/tasks/ScheduleTab.tsx` renders a `teab_last_status` status pill.
- Accent stays **blue** (`web/test/no-indigo.test.ts` green).

---

## Environment variables

| Var | Side | Default | Purpose |
|---|---|---|---|
| `REMO_TEAB_POLL_INTERVAL_MS` | hub | `30000` (30s) | `teab_status` poll cadence (read at poll-start; non-positive/non-finite ⇒ default) |
| `REMO_TEAB_MAX_RUN_MS` | hub | `21600000` (6h) | Hard ceiling; in-flight run finalized `failed/teab_run_timeout` past it |
| `TEAB_BIN` | supervisor | `teab` | Override the TEAB binary name/path the supervisor invokes |
| `TEAB_CLAUDE_BIN` | supervisor | `claude` | TEAB's own claude-binary override (used by preflight resolution) |
| `TEAB_GUARD_HOOK_PATH` | supervisor | — | TEAB's own D3 guard-hook path knob (consumed by TEAB, not remo-code) |

---

## Release gating

**A new signed supervisor MSI is REQUIRED** for the `teab_run`/`teab_status`
capability to exist on installed hosts. The hub changes deploy with the normal hub
rollout, but an OLD supervisor MSI has no `teab_run` handler — a TEAB task dispatched
to it finalizes as a command error. Cutting the MSI is **release-gated, not
auto-cut**: push a `supervisor-v*.*.*` tag → `.github/workflows/release-supervisor.yml`
builds + signs the MSI + publishes `latest.json` for the auto-updater (local:
`pwsh -File supervisor/tauri/scripts/build-and-update.ps1`). Until installed hosts
update, TEAB tasks have no executor.

---

## Tests

- **Supervisor:** `supervisor/test/teab-run.test.ts` (spawn-args, preflight modes,
  status transitions), `supervisor/test/teab-no-programmatic-tokens.test.ts`
  (forbidden-token canary), `supervisor/test/teab-lifecycle.test.ts` (concurrent
  registry + reaping + breadcrumb).
- **Hub:** `hub/test/teab-task-type.test.ts` (type + DAL round-trip),
  `hub/test/teab-sender.test.ts` (routing + supervisor resolution + gate
  pass-through), `hub/test/teab-poll.test.ts` (poll → finalize + timeout),
  `hub/test/teab-e2e.test.ts` (mock supervisor socket: due task → `teab_run` →
  poll → finalize → post-run, without a real `teab`/`claude`).
- QC gate: `bun run check-baseline` (hub suite, per-file isolation, `fail_max:0`).
