---
phase: 16
slug: hardened-pty-relay-and-mobile-terminal
status: final
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-31
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for feedback sampling during the hardened relay + mobile terminal +
> human-only guard.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (existing) |
| **Config file** | none — `bun test` discovers `*.test.ts`; baseline in `tools/regression-baseline.json` |
| **Quick run command** | `bun test supervisor/test/no-api-key-no-streamjson-pty.test.ts hub/test/human-only-guard.test.ts` |
| **Full suite command** | `bun run check-baseline` |
| **Estimated runtime** | quick ~5s; full per-file-isolated suite ~minutes |

---

## Sampling Rate

- **After every task commit:** Run the quick canary/guard command for the touched area.
- **After every plan wave:** Run `bun run check-baseline`.
- **Before `/gsd:verify-work`:** Full suite green + the manual reattach + live-TUI mobile proofs done.
- **Max feedback latency:** ~5s for the canary/guard tests.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 16-01-01 | 01 | 1 | R-PTY-06 | T-16-01 | hardened runner argv has no `-p`/`--print`/stream-json | canary | `bun test supervisor/test/no-api-key-no-streamjson-pty.test.ts` | ✅ (Ph15) | ⬜ pending |
| 16-01-02 | 01 | 1 | R-PTY-06 | T-16-02/03 | `ANTHROPIC_API_KEY` stripped; no credentials/oauth import | unit/static | `bun test supervisor/test/pty-runner-env.test.ts` | ✅ (Ph15) | ⬜ pending |
| 16-01-03 | 01 | 1 | R-PTY-07 | T-16-04 | drop+reattach replays scrollback; PTY survives; no leak | integration | `bun test supervisor/test/pty-reattach-persistence.test.ts` | ❌ W0 | ⬜ pending |
| 16-02-01 | 02 | 2 | R-PTY-08 | T-16-07 | term path has zero RunnerEvent/agent-protocol coupling | static | `bun test hub/test/term-channel-isolation.test.ts` | ❌ W0 | ⬜ pending |
| 16-02-02 | 02 | 2 | R-PTY-08 | T-16-05 | term frames require auth+subscription; byte-faithful relay | integration | `bun test hub/test/term-relay-auth.test.ts` | ❌ W0 | ⬜ pending |
| 16-02-03 | 02 | 2 | R-PTY-11 | — | runner_type idempotent DDL; Telegram-default can't switch to PTY | unit | `bun test hub/test/pty-runner-type.test.ts` | ❌ W0 | ⬜ pending |
| 16-02-04 | 02 | 2 | R-PTY-10 | T-16-06/08 | automation source rejected for PTY session; cost cap intact | unit | `bun test hub/test/human-only-guard.test.ts` | ❌ W0 | ⬜ pending |
| 16-03-01 | 03 | 3 | R-PTY-09 | T-16-10 | reattach replays; session switch clears buffer | unit | `bun test web/test/terminal-surface.test.tsx` | ❌ W0 | ⬜ pending |
| 16-03-02 | 03 | 3 | R-PTY-09 | T-16-09 | themed xterm panel, no indigo | unit | `bun test web/test/no-indigo.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

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
| Dropped phone connection reattaches the live TUI with scrollback intact | R-PTY-07 | Requires a live `claude login` TUI + a real network drop | Launch supervisor + web on phone, start a pty-interactive session, run a long turn, kill wifi, reconnect — verify same session + scrollback |
| Mobile resize/scrollback/keyboard-viewport behaves on a real device | R-PTY-09 | On-screen keyboard + orientation only reproduce on a device | On a phone, rotate, open the keyboard, scroll back — verify cols/rows track and scrollback is reachable |
| Windows persistence mechanism (tmux unavailable) survives a drop | R-PTY-07 | Windows ConPTY + no native tmux; mechanism chosen at 16-01 T2 | On the Windows dev host, drop + reattach; confirm the documented mechanism (persistent PTY + ring-buffer) holds |
| Billing-bucket attribution of a PTY interactive turn | (Phase 19 gate) | Anthropic-side, post-June-15 only | Deferred — NOT part of Phase 16 acceptance |

---

## Notes

The load-bearing validations are (1) the disconnect→reattach persistence proof (R-PTY-07) on the Windows
dev host where tmux is unavailable, and (2) the human-only guard rejecting every automation source for
PTY sessions while leaving the non-bypassable cost cap intact (R-PTY-10 / constraint 3). A green canary +
`bun run` source proof is necessary but not sufficient for R-PTY-07 — the manual device reattach must pass.
