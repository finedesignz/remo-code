# Phase-16 Task-0 — Rust-ConPTY Derisk Spike: FINDINGS + VERDICT

**Measured:** 2026-06-01 · Host: Windows 11 Pro 10.0.26200, x64 · Rust/cargo 1.96.0 · claude 2.1.159 (Opus 4.8)
**Spike source:** `supervisor/tauri/src-tauri/src/pty_spike.rs`
**Build manifest:** `supervisor/tauri/src-tauri/pty-spike/Cargo.toml` (standalone throwaway crate — see Build note)
**Chosen crate:** wezterm **`portable-pty` 0.8.1** (recommended candidate; the `conpty` crate alternative was NOT needed)

---

## VERDICT: **PASS → Option C (Rust-hosted ConPTY)**

The Tauri-side Rust process spawned the **genuine interactive `claude` TUI** through a Windows ConPTY
(via `portable-pty`), captured the real TUI render, and confirmed a written byte round-trips. Constraints 1
(no API key) and 5 (no programmatic flags) were honored. Phase 16 proceeds on **Option C**: PTY hosting
moves into the Tauri Rust process (`pty_host.rs`); the Bun sidecar relays bytes over a local channel; the
Node `pty-host.mjs` detour is **dropped on Windows**.

---

## Evidence (captured live, this host)

Spawn contract (mirrors `claude-runner.ts` / constraints 1 & 5):
- file: `claude`, argv: **EMPTY** (no `-p` / `--print` / `--input-format` / `--output-format` / stream-json)
- env: `CommandBuilder::env_remove("ANTHROPIC_API_KEY")` — the key was also absent from the shell; the spike
  ABORTS (exit 2) if `ANTHROPIC_API_KEY` is set, so the API-key path cannot be exercised.

Captured **1333 bytes** of the real interactive TUI (NOT a programmatic `-p` stream):

```
]0;✳ Claude Code … Claude Code v2.1.159 … Opus 4.8 (1M context) with low effort · Claude Max
… ~\GitHub\…\pty-spike
❯ Try "how does <filepath> work?"
←  for agents … ○ low · /effort
```

This is the genuine interactive welcome/banner + input box + status line — full ANSI screen control
(`[2J`, cursor moves, 24-bit color, bracketed-paste `[?2004h`). A `-p` stream emits structured text, never
this TUI chrome.

**Byte round-trip:** wrote 3 bytes (`ESC [ B`, arrow-down) to the PTY master → observed **32 bytes** of TUI
redraw reaction → **OK**. Input → TUI reacts → output observed: the master read/write seam works both ways.

**Trust prompt:** `trust-prompt detected: false` — this working directory is already trusted, so `claude`
skipped the "Quick safety check / Do you trust" gate and went straight to the input box. The PASS still
holds: the verdict requires (genuine TUI render OR >200 bytes of TUI output) AND a byte round-trip; the
substantial 1333-byte ANSI TUI banner + the 32-byte round-trip both cleared. (The Phase-15 Node proof
captured the literal trust-prompt string in an untrusted dir; the prompt is a property of dir-trust state,
not of the hosting runtime, and is not required to prove "this is the genuine interactive client.")

**Spike teardown:** `child.kill()` + `child.wait()` reaped the spawned `claude`; the spike does not leave its
own orphan. (Other `claude.exe` PIDs on the host are unrelated concurrent sessions — left untouched.)

---

## What Option C means for Tasks 1–3

- **Task 1:** `pty_host.rs` hosts the interactive `claude` ConPTY in the Tauri Rust process via `portable-pty`
  (`native_pty_system().openpty()` → `CommandBuilder::new("claude")`, `env_remove("ANTHROPIC_API_KEY")`,
  empty argv, master reader/writer, `resize`, `kill`). A thin `claude-pty-bridge.ts` Bun relay ferries raw
  bytes to/from Rust over a local channel. The Node `pty-host.mjs` detour is NOT used on Windows.
- **Task 2:** persistence (ring-buffer scrollback + detach-vs-kill) — the Rust host owns the PTY lifecycle and
  ties PTY lifetime to the supervisor process (dead-man's-switch by process ownership).
- **Task 3:** the branch-agnostic canary globs BOTH host paths (`pty_host.rs` + `claude-pty-bridge.ts` on C;
  `claude-pty-runner.ts` on A) so it holds regardless of branch.

## Packaging consequence

Option C ships **NO bundled JS runtime** for the PTY path. No `node.exe` / `node-pty` resource staging is
added to `tauri.conf.json` or `build-and-update.ps1`. The Option-A fallback packaging (Phase-15 SPIKE-FINDINGS
§3) is NOT exercised.

## Build note (why a standalone crate)

The spike source lives at the planned path `supervisor/tauri/src-tauri/src/pty_spike.rs`, but it is built via
a sibling standalone manifest `supervisor/tauri/src-tauri/pty-spike/Cargo.toml` rather than a `[[bin]]` in the
parent Tauri crate. Reason: the parent crate's `tauri-build` build-script REQUIRES a staged sidecar binary
(`binaries\remo-code-supervisor-x86_64-pc-windows-msvc.exe`) that is not present in a fresh worktree, so a
bare `cargo run --bin pty_spike` inside the Tauri crate fails in `tauri-build` before reaching the spike. The
standalone crate has zero Tauri coupling (only `portable-pty`), so it builds + runs cleanly. Run with:

```
cd supervisor/tauri/src-tauri/pty-spike && cargo run    # ANTHROPIC_API_KEY must be unset
```

Both the spike source and the standalone manifest are throwaway-grade; the production host is `pty_host.rs`
inside the Tauri crate (Task 1), which integrates with the crate's real lifecycle (no separate build).

## Linux / forkpty-under-Bun (Phase-15 open item)

NOT re-tested in this spike (Windows dev host only). The Phase-15 finding stands: the Node-host detour is a
**Windows-only** workaround for Bun's incomplete named-pipe sockets. On Option C the question is moot on
Windows (Rust hosts the PTY, not Bun). For Linux/Coolify supervisors, `portable-pty` uses `forkpty` directly
in the Rust process, so the Bun-forkpty limitation does not apply to the Rust host either — Option C is
expected to work cross-platform without a Node detour. Confirming Linux Rust-ConPTY is out of Phase-16 scope
(no Linux supervisor PTY surface ships this phase) and noted for Phase 17+.
