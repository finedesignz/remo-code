---
phase: 17-codex-pty-runner-and-chatsurface-rip-and-replace
plan: 01
subsystem: supervisor/pty-runner
tags: [codex, pty, interactive, backend-agnostic]
provides: [codex-pty-runner, pty-backend-selector]
requires: [phase-16-rust-conpty-host, phase-16-pty-bridge]
affects: [supervisor]
key-files:
  created:
    - supervisor/src/runners/codex-pty-runner.ts
    - supervisor/test/codex-pty-runner-env.test.ts
  modified:
    - supervisor/src/runners/pty-host.mjs
    - supervisor/src/runners/claude-pty-bridge.ts
    - supervisor/tauri/src-tauri/src/pty_host.rs
    - supervisor/src/index.ts
    - supervisor/test/no-api-key-no-streamjson-pty.test.ts
decisions:
  - "Interactive Codex argv = bare `codex`, EMPTY argv (TUI). Headless app-server/exec belong to the PRESERVED automation path, never the PTY."
  - "Codex env scrub strips BOTH OPENAI_API_KEY (provider) and ANTHROPIC_API_KEY (defense-in-depth) on every PTY spawn path."
  - "Backend selector lives in TWO mirrored seams: Option-A selectPtyRunner (index.ts) + Option-C selectPtyBridge/CodexPtyBridge (claude-pty-bridge.ts). Rust host selects the binary via the spawn frame `cli` field."
metrics:
  duration: ~1 turn
  completed: 2026-06-01
---

# Phase 17 Plan 01: Codex PTY Runner Summary

Added a backend-agnostic Codex interactive PTY runner mirroring the Phase-16 Claude PTY architecture (Option C Rust ConPTY + Bun bridge), proving the raw-terminal surface is backend-agnostic before the (gated) deletions. No deletions in this plan.

## Exact interactive Codex argv
`codex` with **EMPTY argv** (interactive TUI). NO `app-server` (JSON-RPC automation), NO `exec`, NO `-p`/`--print`/`--input-format`/`--output-format`/`stream-json`. Confirm against the installed Codex version at device-attestation time; the canary statically fails the build if any headless flag reappears.

## What was built
- `codex-pty-runner.ts` — near-verbatim mirror of `claude-pty-runner.ts`; spawns the Node pty-host with `file:'codex'`, raw bytes only, no RunnerEvent/agent-protocol/session-bridge/credentials/oauth-poll imports. Exports `buildCodexPtyHostEnv` (scrubs OPENAI_API_KEY + ANTHROPIC_API_KEY).
- Rust `pty_host.rs` — production Option-C byte path made backend-agnostic: spawn frame carries `cli` (`claude`|`codex`, default claude); `resolve_cli_binary` selects the interactive binary; `build_pty_env` now `env_remove`s BOTH provider keys.
- `claude-pty-bridge.ts` — `cli` option on the spawn frame + `CodexPtyBridge` subclass + `selectPtyBridge(cliKind)`.
- `index.ts` — `selectPtyRunner(cliKind)` = `cliKind==='codex' ? CodexPtyRunner : ClaudePtyRunner`. stream-json automation path (ClaudeRunner + session-bridge) untouched.
- `pty-host.mjs` — strips OPENAI_API_KEY in addition to ANTHROPIC_API_KEY regardless of `file`.
- Canary extended to scan `codex-pty-runner.ts` (forbidden flags incl. app-server/exec; literal `delete env.<KEY>` scrub-mechanism pin per PARTIAL-binding/NH-4-adjacent). New `codex-pty-runner-env.test.ts`.

## Human-only guard
The Codex PTY runner is selected only for `runner_type='pty-interactive'`, which rides the unchanged Phase-16 `humanOnlyPtyGate` (default-deny for non-`human` actors). Automation never reaches it. No dispatch/gate code changed.

## Tests
- `no-api-key-no-streamjson-pty.test.ts` + `codex-pty-runner-env.test.ts` + `pty-runner-env.test.ts`: **15 pass / 0 fail**.
- `pty-byte-relay` + `pty-reattach-persistence` + `pty-spawn-interception` + `pty-orphan-teardown`: **13 pass / 0 fail** (node-pty `AttachConsole failed` line is a headless subprocess artifact, not a test assertion — same as 16-VERIFICATION).

## Deviations from Plan
- **[Rule 3] tsc command non-applicable.** Plan's `cd supervisor; bun run tsc --noEmit -p .` fails — supervisor has no tsconfig.json. Verified via Bun's on-import typecheck during test runs instead.
- **[Rule 2] Production backend selector extended beyond `index.ts`.** The plan named only `index.ts` for selection, but the LIVE byte path on Windows is Option-C (Rust host + bridge), which hardcoded `claude`. Made the Rust host + bridge cli-aware (the real backend selector) and kept the `index.ts` Option-A selector as the documented mirror. Without this the Codex surface would not actually be reachable.
- **[Rule 2] OPENAI_API_KEY scrub added everywhere.** Codex's provider key is OPENAI_API_KEY; the Claude path only scrubbed ANTHROPIC_API_KEY. Added OPENAI_API_KEY removal to the Node host, Rust host, and the codex env-builder (hard constraint: no provider keys anywhere).

## Self-Check: PASSED
- codex-pty-runner.ts, codex-pty-runner-env.test.ts exist.
- Commit 35ad092 present.
