---
phase: 16-hardened-pty-relay-and-mobile-terminal
plan: 01
subsystem: pty-runner
tags: [pty, conpty, rust, persistence, derisk-spike]
provides:
  - "Rust-hosted interactive `claude` ConPTY (Option C)"
  - "Bun↔Rust byte bridge (claude-pty-bridge.ts)"
  - "supervisor-owned PTY persistence + detach-vs-kill (pty-persistence.ts)"
requires: []
affects:
  - supervisor/tauri/src-tauri
  - supervisor/src/runners
tech-stack:
  added: ["portable-pty 0.8 (Rust ConPTY)", "base64 0.22 (Rust)"]
  patterns: ["loopback-TCP byte relay", "bounded scrollback ring-buffer", "process-ownership dead-man's-switch"]
key-files:
  created:
    - supervisor/tauri/src-tauri/src/pty_spike.rs
    - supervisor/tauri/src-tauri/pty-spike/Cargo.toml
    - supervisor/tauri/src-tauri/src/pty_host.rs
    - supervisor/src/runners/claude-pty-bridge.ts
    - supervisor/src/runners/pty-persistence.ts
    - supervisor/test/pty-reattach-persistence.test.ts
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-SPIKE-FINDINGS-rust-conpty.md
  modified:
    - supervisor/tauri/src-tauri/Cargo.toml
    - supervisor/tauri/src-tauri/src/lib.rs
    - supervisor/test/no-api-key-no-streamjson-pty.test.ts
    - supervisor/test/pty-runner-env.test.ts
decisions:
  - "Task-0 Rust-ConPTY spike PASSED → Option C adopted (PTY hosted in Tauri Rust; Node detour dropped on Windows)"
  - "Bun↔Rust channel = loopback TCP socket + port token file (not Tauri IPC — the Bun sidecar is not a webview)"
  - "Windows persistence = supervisor-owned persistent PTY + ring-buffer (tmux unavailable on Windows)"
metrics:
  duration: ~1.5h
  completed: 2026-06-01
---

# Phase 16 Plan 01: PTY Runner + Persistence Summary

Rust-ConPTY derisk spike PASSED → the interactive `claude` PTY is now hosted in the Tauri Rust process
(`pty_host.rs`) via wezterm `portable-pty`, with a thin Bun byte-relay (`claude-pty-bridge.ts`) over a
loopback socket and supervisor-owned persistence (`pty-persistence.ts`) implementing the detach-vs-kill
policy; the no-API-key / no-stream-json invariants are locked behind a branch-agnostic canary.

## Task-0 verdict + chosen branch

**VERDICT: PASS → Option C.** The Rust spike (`pty_spike.rs`, built via the standalone `pty-spike/` crate
to avoid the parent Tauri crate's sidecar-staging build requirement) spawned the genuine interactive `claude`
TUI through a Windows ConPTY — captured 1333 bytes of the real banner + input box + status line (full ANSI
screen control), `ANTHROPIC_API_KEY` removed, EMPTY argv, no programmatic flags — and confirmed a byte
round-trip (arrow-down → 32-byte TUI redraw). Trust prompt was not shown (this dir is already trusted; the
prompt is a function of dir-trust state, not the runtime). Full evidence in `16-SPIKE-FINDINGS-rust-conpty.md`.

Consequence: PTY hosting lives in `pty_host.rs`; the Node `pty-host.mjs` detour is DROPPED on Windows; **no
JS runtime is bundled** for the PTY path (Option-A packaging untouched).

## Bun↔Rust byte-channel mechanism

A **loopback TCP socket** (`127.0.0.1:<ephemeral>`), chosen over Tauri command/event because the Bun
supervisor sidecar is a separate process, not a webview, so it cannot use Tauri IPC. The Rust host
(`spawn_host`, started in `lib.rs` setup before the sidecar) writes its bound port to a token file
(`REMO_PTY_HOST_PORT_FILE`, default `%LOCALAPPDATA%\remo-code-supervisor\pty-host.port`); the bridge reads
it. Wire protocol mirrors the Phase-15 framing for continuity: 4-byte big-endian length prefix + UTF-8 JSON;
raw byte payloads are base64 under `d`. Frames: bridge→host `spawn`/`reattach`/`input`/`resize`/`kill`;
host→bridge `spawned`/`scrollback`/`data`/`exit`/`error`.

## Windows persistence mechanism + tmux finding + ring-buffer cap

`tmux` is **not available on the Windows dev host** (confirmed: Windows always returns false from the
`tmuxAvailable()` probe). Windows persistence therefore uses the **supervisor-owned persistent PTY +
bounded ring-buffer** baseline: the Rust host owns the ConPTY and a 256 KiB scrollback ring per session;
`pty-persistence.ts` keeps a matching 256 KiB Bun-side coordinating ring as the cross-platform baseline. On
POSIX where tmux is present, the same coordinator can front a detached tmux session for survival across
supervisor restarts (capability-gated). **Ring-buffer cap: 256 KiB (`DEFAULT_SCROLLBACK_CAP_BYTES`).**

## Detach-vs-kill policy (R-PTY-27 / H7)

- client WS DISCONNECT → **DETACH** (PTY + scrollback survive; reattach replays)
- session CLOSE / idle-reap (grace mirrors hub `REMO_SESSION_IDLE_GRACE_SECONDS`, default 300s) / supervisor
  SHUTDOWN → **KILL**
- crashed supervisor → the Rust host ties PTY lifetime to the supervisor process, so every child PTY dies
  with it (process-ownership dead-man's-switch — no orphan `claude`). `kill_all()` also runs on Tauri
  `ExitRequested`.

## Linux / forkpty-under-Bun (Phase-15 open item)

The Node-host detour was a **Windows-only** workaround for Bun's incomplete named-pipe sockets. On Option C
the question is moot on Windows (Rust hosts the PTY). On Linux, `portable-pty` uses `forkpty` directly in the
Rust process, so the Bun-forkpty limitation does not apply to the Rust host either — Option C is expected to
work cross-platform without a Node detour. Confirming Linux Rust-ConPTY is out of Phase-16 scope (no Linux
PTY surface ships this phase); noted for Phase 17+.

## Verification

- `cargo check` (Tauri crate, with stub `binaries/` + `ui/dist/`) green — `pty_host.rs` compiles.
- `bun build` of `claude-pty-bridge.ts` green.
- `supervisor/test`: no-api-key-no-streamjson-pty (branch-agnostic canary), pty-runner-env (A + C
  assertions), pty-spawn-interception, pty-reattach-persistence — all green (14+ tests). Canary proven to
  FAIL on a reintroduced `--input-format` flag, then reverted.

## Deviations from Plan

**1. [Rule 3 — Blocking] Spike built via standalone crate, not a `[[bin]]` in the Tauri crate**
- **Found during:** Task 0. A `[[bin]] pty_spike` inside the Tauri crate triggers `tauri-build`, which
  aborts because a fresh worktree has no staged sidecar binary (`binaries\remo-code-supervisor-*.exe`).
- **Fix:** kept the spike source at the planned path `src/pty_spike.rs` but added a sibling standalone
  manifest `pty-spike/Cargo.toml` (zero Tauri coupling, only `portable-pty`) so `cargo run` works. Documented
  in SPIKE-FINDINGS §Build note. Throwaway-grade; production host is `pty_host.rs` (no separate build).

**2. [Rule 3 — Blocking] Stub `binaries/` + `ui/dist/` to let `cargo check` run**
- The Tauri crate's build requires a staged sidecar exe and a built web `ui/dist`. Both are `.gitignore`d
  build artifacts. Created throwaway stubs so `cargo check` validates `pty_host.rs`. Not committed.

**Note on Task-2 `autonomous:false`:** the Windows persistence mechanism was determined by the Task-0 spike
verdict (Option C → Rust-owned persistent PTY + ring-buffer; tmux unavailable on Windows), which is the
plan's documented default — not a grey-area. Recorded above; no separate operator checkpoint required (the
decision gate was operator-pre-authorized).

## Known Stubs

None affecting the plan goal. The `pty_host.rs` ↔ `claude-pty-bridge.ts` end-to-end byte path is implemented;
wiring it into the supervisor's per-session runner-type dispatch is Plan 02 (runner_type) + Plan 03 (surface).

## Self-Check: PASSED
- pty_host.rs, claude-pty-bridge.ts, pty-persistence.ts, pty_spike.rs, 16-SPIKE-FINDINGS-rust-conpty.md,
  pty-reattach-persistence.test.ts — all present.
- Commits: d4ede20 (spike), 5d4e3f2 (Option C host+bridge), ed2973d (persistence), c5373d1 (canary/env).
