# remo-code-terminal — Design Spec

**Date:** 2026-06-08
**Status:** Approved design, pending spec review → implementation plan
**New app repo:** `../remo-code-terminal` (sibling of `remo-code`)
**Supervisor seam lives in:** `remo-code` (this repo)

## Problem

The owner runs many concurrent `claude`/`codex` sessions across projects, today in
**Wave terminal** (Electron, heavy) with workspaces + tabs. Wave sessions are
completely disjoint from remo-code — no sync. When working remotely through remo-code,
internet latency on every keystroke is annoying; when local, there's no remo-code
integration at all. On reboot, every session must be manually relaunched and resumed.

Goal: **replace Wave with a fast, lightweight, local-first tabbed terminal whose
sessions ARE remo-code sessions** — open one locally and it shows up in remo-code
(and vice-versa, eventually); reboot and everything auto-reopens where it left off.
Local path must avoid the internet round-trip (instant typing at home); remote viewing
comes for free because the supervisor already relays to the hub.

## Non-goals (v1)

- Concurrent driving of the *same* session from local **and** browser at once
  (write-lock parity) — **fast-follow**, not v1.
- Codex support — **claude-only** in v1 (architecture stays backend-agnostic; codex is a
  later flag flip).
- The new app owning/relaying to the hub itself. The supervisor remains the **sole PTY
  owner and sole hub relay**.
- A general shell. v1 spawns the interactive `claude` TUI per session, not arbitrary
  shells.
- Mobile / cross-platform polish. Windows-first (matches the owner's machine + existing
  supervisor MSI).

## Key facts this design rests on (verified against code)

1. **Supervisor already on the machine**, autostarts on login (`tauri_plugin_autostart`),
   owns the Rust ConPTY host (`supervisor/tauri/src-tauri/src/pty_host.rs`), spawns the
   genuine interactive `claude` TUI (empty argv, env scrubbed of API keys via
   `supervisor/src/runners/env-sanitize.ts`).
2. **Sync is nearly free:** the supervisor pushes `session_inventory` to the hub every
   10s, derived live from in-memory `ProcessManager.runs`
   (`supervisor/src/hub-client.ts`). Any session the supervisor hosts appears remotely
   automatically — no per-session registration code.
3. **Rust PTY host supports multiple subscribers per session.** A local app can stream
   the same bytes the hub gets. Detach = close socket (PTY stays alive); scrollback ring
   buffer (256 KiB) replays on reattach.
4. **Gaps that become the build:** (a) sessions can only be *started* by a hub message
   today — no local trigger; (b) only local surfaces are the raw pty_host TCP and a
   `GET /sup/status` server — no control RPC; (c) **no persistence** of active sessions
   across supervisor restart / reboot.

## Architecture

```
┌─────────────────────────────┐          ┌──────────────────────────┐
│  remo-code-terminal (NEW)   │   WS     │  remo-code Supervisor     │
│  Tauri 2 shell, NO PTY      │◄────────►│  (existing, on machine)   │
│  • workspace bar + tabs     │ loopback │  • ProcessManager.start() │
│  • xterm.js panes           │127.0.0.1 │  • Rust ConPTY host       │──┐ spawns
│  • local layout persistence │  (fast)  │  • NEW local control+data │  │ claude
└─────────────────────────────┘          │    WS surface             │  ▼
                                          │  • session_inventory ─────┼─► HUB ─► browser/phone
                                          │  • NEW active-session     │  (remote sync, free)
                                          │    persist + boot restore │
                                          └──────────────────────────┘
```

The new app is a **pure UI client**. It owns no PTY, bundles no `portable-pty`, and never
talks to the hub. The supervisor stays the single PTY owner, so the local view and the
remote view are the same process and the same byte stream. The local path is
loopback-only (no internet); the supervisor's existing hub relay runs in parallel for
remote viewing.

## Component A — Supervisor seam (new code in `remo-code`)

### A1. Local control + data WebSocket
- New surface on `127.0.0.1` (proposed `ws://127.0.0.1:9106/ws/local`; reuse/extend the
  existing status server port or a sibling).
- **Reuses the existing `hub/src/ws/term-protocol.ts` frames** for data:
  `term.data` (out), `term.input` / `term.resize` / `term.attach` / `term.reattach` (in).
- **Adds a small control verb set:**
  - `session.list` → current inventory snapshot (same shape as `session_inventory`).
  - `session.spawn { cli, cwd }` → calls `ProcessManager.start()`; returns `session_id`.
  - `session.attach { session_id }` → begin streaming `term.data` for that session
    (with scrollback replay).
  - `session.detach { session_id }` → stop streaming (PTY stays alive).
  - `session.stop { session_id }` → terminate the session.
  - `inventory.subscribe` → push inventory deltas so the app's tab list stays live.
- **Auth:** loopback-only + a local token file (same pattern as
  `REMO_PTY_HOST_PORT_FILE`), no hub credentials involved.
- v1: **single writer per session** (the local app). No write-lock arbitration yet —
  concurrent browser driving is out of scope, so a session driven locally is not
  simultaneously driven from the browser. (Fast-follow adds parity with the hub's
  `/ws/client` write-lock.)

### A2. Local session origination
- `session.spawn` invokes the existing `ProcessManager.start()` path with
  `cli='claude'`, given `cwd`. Because `session_inventory` is derived from `runs`, the new
  session reaches the hub within ≤10s with no extra registration code — **this is the
  "open locally → appears in remo-code" half of sync.**

### A3. Active-session persistence + boot restore
- Persist `{ session_id, cli, cwd }` for every running session to
  `%LOCALAPPDATA%\remo-code-supervisor\active-sessions.json` (write on start/stop).
- On supervisor startup, read the file and re-spawn each via `claude --continue`
  (resume-by-`project_dir` conversation continuity) in its `cwd`.
- This is the **"reboot → everything reopens where I left off"** mechanism. The Rust ring
  buffer does not survive a full process death; conversation continuity is provided by
  `claude --continue`, not by replaying old bytes.

## Component B — New app (`remo-code-terminal`)

### B1. Tauri 2 shell (minimal Rust)
- Window + optional tray + autostart only. **No PTY, no `portable-pty`** — keeps the
  binary small and RAM low; all heavy work stays in the supervisor.
- Frameless or thin-chrome window, dark, matching remo-code tokens.

### B2. UI
- **Workspace bar** (top) → **tabs** (one per session) → **xterm.js pane**.
- xterm.js + `@xterm/addon-fit`, wired identically to the web `TerminalSurface`:
  base64 `term.data` → `Uint8Array` → `term.write`; keystrokes → base64 `term.input`;
  container resize → `term.resize`; reattach replays scrollback.
- Styling uses remo-code design tokens (`--bg-primary`, blue accent) so it feels native to
  the ecosystem. (Design prefs: `~/.claude/design-preferences.md`.)

### B3. Transport
- One WebSocket to the supervisor local surface (A1). Reads token + port from the
  supervisor's local token/port file.
- On launch: connect → `inventory.subscribe` → for each persisted tab, `session.attach`.

### B4. Workspace / layout persistence (local)
- Local JSON: workspaces → ordered tabs → each tab's `session_id` + `cwd` + title.
- Workspaces and tab layout are a **local-only** concept; the `session_id` is the shared
  remo entity. On launch, reconnect and re-attach every tab to its live session.

### B5. New-session flow
- "+" → cwd/repo picker (recent-repos list, seeded from supervisor roots) → `session.spawn`
  → new tab attached to the returned `session_id`.

### B6. UI code sourcing (sub-decision — recommended)
- **Reimplement a minimal xterm wiring** in the new app rather than importing the whole
  `web/` package (keeps it lightweight). Lift the ~200-line `TerminalSurface` core +
  `term-protocol` types as a **reference** so framing/resize/reattach behavior matches
  exactly. (Alt — extract a shared package — deferred; more churn for v1.)

## Data flow

**Local keystroke:** xterm `onData` → base64 → `term.input` → supervisor local WS →
ProcessManager bridge → Rust PTY host → `claude`. Round-trip is loopback (sub-ms).

**Output:** `claude` → Rust PTY host → (a) supervisor local WS → app xterm (fast, local);
(b) supervisor hub relay → hub → browser (remote, parallel). Same bytes, two subscribers.

**Appears remotely:** `session.spawn` → `ProcessManager.runs` → next `session_inventory`
push (≤10s) → hub → browser session list.

## Error handling / edges

- **Supervisor offline:** app shows "supervisor offline," offers to launch it (installed);
  local features disabled until the WS connects.
- **Hub offline (traveling):** local terminal fully functional; remote sync silently
  resumes when the hub reconnects — no local degradation.
- **Reconnect:** app reconnects the local WS and `session.reattach`es each tab; scrollback
  replays for live sessions.
- **Same session opened locally and in browser (v1):** not actively prevented, but
  concurrent *driving* is out of scope; v1 assumes one active writer. **Fast-follow**
  mirrors the hub's existing `/ws/client` write-lock into the local surface for safe
  dual-driving.
- **Spawn failure:** `session.spawn` returns an error frame; tab shows the error, no
  zombie tab.

## Testing

- **Supervisor (A):** unit-test the local WS control verbs (`spawn`/`list`/`attach`/
  `stop`) against a mock ProcessManager; test persistence file write/read + boot-restore
  re-spawn; assert `session.spawn` results in an inventory entry. Reuse the repo's
  per-file-isolated Bun test gate (`bun run check-baseline`).
- **App (B):** component test the xterm wiring (base64 round-trip, resize) against a fake
  WS; layout persistence load/save; reconnect → reattach.
- **Integration (manual, v1 acceptance):** open a session locally → confirm it appears in
  the remo-code browser session list within ~10s; reboot the machine → confirm sessions
  auto-reopen and `claude --continue` restores conversation.

## Build order (→ implementation plan)

1. **Supervisor local control+data WS surface** + `session.spawn` / `list` / `attach` /
   `stop` (test with a script; no app yet).
2. **Active-session persistence + boot restore** in the supervisor.
3. **New Tauri app scaffold** + single-session xterm pane over the local WS.
4. **Tabs + workspaces + layout persistence + new-session picker** (v1 complete:
   Wave-replacement + auto-resume; sessions appear remotely).
5. *(Fast-follow)* **Write-lock parity** with the hub's `/ws/client` + concurrent
   local/remote driving verification; then **codex** behind the existing backend-agnostic
   `cli` field.

## Open items for the plan

- Exact local port/auth: extend the existing status server vs. a new sibling listener.
- Whether the local surface lives in the Bun sidecar (simplest, reuses term-protocol) or
  the Rust layer (closer to PTY, more work) — **lean Bun sidecar**.
- `claude --continue` resume semantics per `project_dir` when multiple sessions share a
  repo (disambiguation key for restore).
