---
phase: 16
slug: hardened-pty-relay-and-mobile-terminal
status: final
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-31
hosting_decision_gate: 16-01-00  # Task-0 Rust-ConPTY spike: PASS → Option C, FAIL → Option A fallback
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for feedback sampling during the hardened relay + mobile terminal +
> human-only guard.
>
> **First validation point is the Task-0 Rust-ConPTY decision-gate spike** (16-01-00): from the Tauri Rust
> side, spawn the genuine interactive `claude` TUI (wezterm `portable-pty` recommended; `conpty` alternative),
> capture the real trust prompt, confirm byte round-trip — `ANTHROPIC_API_KEY` removed, NO programmatic flags.
> **PASS → Option C** (Rust-hosted PTY + Bun↔Rust byte channel; Node `pty-host.mjs` detour dropped on Windows).
> **FAIL → Option A** (bundled portable node.exe + node-pty + pty-host.mjs — Phase-15-proven fallback).
> Downstream runner/persistence/canary coverage branches on this verdict but stays verifiable either way.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (existing) + `cargo run`/`cargo check` (Tauri Rust spike, Option C path) |
| **Config file** | none — `bun test` discovers `*.test.ts`; baseline in `tools/regression-baseline.json` |
| **Quick run command** | `bun test supervisor/test/no-api-key-no-streamjson-pty.test.ts hub/test/human-only-guard.test.ts` |
| **Full suite command** | `bun run check-baseline` |
| **Estimated runtime** | quick ~5s; full per-file-isolated suite ~minutes; Task-0 spike interactive (manual-attended) |

---

## Sampling Rate

- **Task 0 (decision gate) FIRST:** Run the Rust-ConPTY spike attended; record PASS/FAIL in `16-SPIKE-FINDINGS-rust-conpty.md` before any runner/host task begins.
- **After every task commit:** Run the quick canary/guard command for the touched area.
- **After every plan wave:** Run `bun run check-baseline`.
- **Before `/gsd:verify-work`:** Full suite green + the manual reattach + live-TUI mobile proofs done.
- **Max feedback latency:** ~5s for the canary/guard tests.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 16-01-00 | 01 | 1 | R-PTY-06 | T-16-00 | Rust spike renders genuine interactive `claude` TUI; trust prompt captured; byte round-trip; API key removed; no programmatic flags → PASS Option C / FAIL Option A | spike (manual-attended) | `cargo run --bin pty_spike` (Tauri crate) + verdict in 16-SPIKE-FINDINGS-rust-conpty.md | ❌ W0 | ⬜ pending (gate) |
| 16-01-01 | 01 | 1 | R-PTY-06 | T-16-01 | chosen-branch host argv has no `-p`/`--print`/stream-json (globs node-pty-runner A + pty_host.rs/bridge C) | canary | `bun test supervisor/test/no-api-key-no-streamjson-pty.test.ts` | ✅ (Ph15) | ⬜ pending |
| 16-01-02 | 01 | 1 | R-PTY-06 | T-16-02/03 | `ANTHROPIC_API_KEY` stripped (delete on A / remove on C); no credentials/oauth import | unit/static | `bun test supervisor/test/pty-runner-env.test.ts` | ✅ (Ph15) | ⬜ pending |
| 16-01-03 | 01 | 1 | R-PTY-07 | T-16-04 | drop+reattach replays scrollback; PTY survives; no leak | integration | `bun test supervisor/test/pty-reattach-persistence.test.ts` | ❌ W0 | ⬜ pending |
| 16-02-01 | 02 | 2 | R-PTY-08 | T-16-07 | term path has zero RunnerEvent/agent-protocol coupling | static | `bun test hub/test/term-channel-isolation.test.ts` | ❌ W0 | ⬜ pending |
| 16-02-02 | 02 | 2 | R-PTY-08 | T-16-05 | term frames require auth+subscription; byte-faithful relay | integration | `bun test hub/test/term-relay-auth.test.ts` | ❌ W0 | ⬜ pending |
| 16-02-03 | 02 | 2 | R-PTY-11 | — | runner_type idempotent DDL; Telegram-default can't switch to PTY | unit | `bun test hub/test/pty-runner-type.test.ts` | ❌ W0 | ⬜ pending |
| 16-02-04 | 02 | 2 | R-PTY-10 | T-16-06/08 | automation source rejected for PTY session; cost cap intact | unit | `bun test hub/test/human-only-guard.test.ts` | ❌ W0 | ⬜ pending |
| 16-03-01 | 03 | 3 | R-PTY-09 | T-16-10 | reattach replays; session switch clears buffer | unit | `bun test web/test/terminal-surface.test.tsx` | ❌ W0 | ⬜ pending |
| 16-03-02 | 03 | 3 | R-PTY-09 | T-16-09 | themed xterm panel, no indigo | unit | `bun test web/test/no-indigo.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

> The downstream rows (16-01-01..03) are branch-agnostic by design: the canary globs BOTH host paths
> (`claude-pty-runner.ts` on Option A; `pty_host.rs` + `claude-pty-bridge.ts` on Option C), and the env/reattach
> assertions hold against whichever host the Task-0 verdict selected. No row is invalidated by either branch.

---

## Wave 0 Requirements

- [ ] `supervisor/tauri/src-tauri/src/pty_spike.rs` + `16-SPIKE-FINDINGS-rust-conpty.md` — Rust-ConPTY decision-gate spike (genuine interactive TUI + trust-prompt capture + byte round-trip → PASS/FAIL verdict)
- [ ] `supervisor/test/pty-reattach-persistence.test.ts` — disconnect→reattach scrollback stub
- [ ] `hub/test/term-channel-isolation.test.ts` — RunnerEvent-coupling static check stub
- [ ] `hub/test/term-relay-auth.test.ts` — auth/subscription gate + byte-faithful relay stub
- [ ] `hub/test/pty-runner-type.test.ts` — runner_type enum + Telegram-default guard stub
- [ ] `hub/test/human-only-guard.test.ts` — automation-source rejection + cost-cap-intact stub
- [ ] `web/test/terminal-surface.test.tsx` — reattach/session-switch buffer-clear stub

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| **Rust-ConPTY spike renders the genuine interactive `claude` TUI (decision gate)** | R-PTY-06 (Task 0) | Requires a live `claude login` TUI driven from Rust on the Windows dev host; the trust-prompt capture + byte round-trip is attended | With `ANTHROPIC_API_KEY` deleted from the shell, run the Rust spike (`cargo run --bin pty_spike`); confirm the real interactive trust/welcome prompt appears (NOT a programmatic `-p` stream) and an input byte round-trips; record PASS (Option C) or FAIL (Option A) in `16-SPIKE-FINDINGS-rust-conpty.md` |
| Dropped phone connection reattaches the live TUI with scrollback intact | R-PTY-07 | Requires a live `claude login` TUI + a real network drop | Launch supervisor + web on phone, start a pty-interactive session, run a long turn, kill wifi, reconnect — verify same session + scrollback |
| Mobile resize/scrollback/keyboard-viewport behaves on a real device | R-PTY-09 | On-screen keyboard + orientation only reproduce on a device | On a phone, rotate, open the keyboard, scroll back — verify cols/rows track and scrollback is reachable |
| Windows persistence mechanism (tmux unavailable) survives a drop | R-PTY-07 | Windows ConPTY + no native tmux; mechanism chosen at 16-01 T2 (Rust-owned on Option C, Node-owned on Option A) | On the Windows dev host, drop + reattach; confirm the documented mechanism (persistent PTY + ring-buffer) holds |
| Billing-bucket attribution of a PTY interactive turn | (Phase 19 gate) | Anthropic-side, post-June-15 only | Deferred — NOT part of Phase 16 acceptance |

---

## Notes

The load-bearing validations are (0) the **Task-0 Rust-ConPTY decision-gate spike** that selects the hosting
strategy (Option C target / Option A fallback) before any runner code is hardened, (1) the disconnect→reattach
persistence proof (R-PTY-07) on the Windows dev host where tmux is unavailable, and (2) the human-only guard
rejecting every automation source for PTY sessions while leaving the non-bypassable cost cap intact (R-PTY-10 /
constraint 3). A green canary + source proof is necessary but not sufficient for R-PTY-06/07 — the Task-0 spike
verdict and the manual device reattach must both pass.
</content>
