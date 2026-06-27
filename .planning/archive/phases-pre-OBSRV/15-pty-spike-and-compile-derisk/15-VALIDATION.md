---
phase: 15
slug: pty-spike-and-compile-derisk
status: final
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-31
---

# Phase 15 — Validation Strategy

> Per-phase validation contract for feedback sampling during the PTY spike + compile-derisk.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (existing) |
| **Config file** | none — `bun test` discovers `*.test.ts`; baseline in `tools/regression-baseline.json` |
| **Quick run command** | `bun test supervisor/test/no-api-key-no-streamjson-pty.test.ts` |
| **Full suite command** | `bun run check-baseline` |
| **Estimated runtime** | quick ~3s; full per-file-isolated suite ~minutes |

---

## Sampling Rate

- **After every task commit:** Run the quick canary command for the touched area.
- **After every plan wave:** Run `bun run check-baseline`.
- **Before `/gsd:verify-work`:** Full suite green + the manual byte-relay + compile-shipping proofs done.
- **Max feedback latency:** ~5s for the canary.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 15-01-01 | 01 | 1 | R-PTY-01 | T-15-01 | spawned `claude` argv has no `-p`/`--print`/stream-json flags | canary/unit | `bun test supervisor/test/no-api-key-no-streamjson-pty.test.ts` | ❌ W0 | ⬜ pending |
| 15-01-02 | 01 | 1 | R-PTY-01 | T-15-02 | `ANTHROPIC_API_KEY` deleted from spawned env | unit | `bun test supervisor/test/pty-runner-env.test.ts` | ❌ W0 | ⬜ pending |
| 15-02-01 | 02 | 2 | R-PTY-03 | T-15-03 | terminal path has zero `RunnerEvent` import/coupling | static/unit | `bun test hub/test/term-channel-isolation.test.ts` | ❌ W0 | ⬜ pending |
| 15-02-02 | 02 | 2 | R-PTY-02 | — | typed input reaches PTY; PTY bytes reach client | integration | `bun test supervisor/test/pty-byte-relay.test.ts` | ❌ W0 | ⬜ pending |
| 15-03-01 | 03 | 3 | R-PTY-05 | — | xterm panel themed, no indigo | unit | `bun test web/test/no-indigo.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `supervisor/test/no-api-key-no-streamjson-pty.test.ts` — canary stub for R-PTY-01 (argv + env grep)
- [ ] `supervisor/test/pty-runner-env.test.ts` — env-delete assertion stub
- [ ] `hub/test/term-channel-isolation.test.ts` — RunnerEvent-coupling static check stub
- [ ] `supervisor/test/pty-byte-relay.test.ts` — input-injection / output-byte round-trip stub
- [ ] xterm deps installed in `web/` (`@xterm/xterm`, `@xterm/addon-fit`)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Interactive `claude` TUI renders in xterm.js; a typed turn is answered | R-PTY-02, R-PTY-05 | Requires a live `claude login` credential + real TUI redraw | Launch supervisor + web, open a PTY session, type a prompt, observe the TUI respond in the panel |
| node-pty ships from the COMPILED sidecar (chosen approach a/b/c works) | R-PTY-04 | Requires building the sidecar via `bun build --compile` and exercising the PTY through it | Build sidecar, launch it, spawn a PTY turn through it; record which approach worked in SPIKE-FINDINGS |
| Billing-bucket attribution of a PTY interactive turn | (Phase 19 gate) | Anthropic-side, post-June-15 only | Deferred — NOT part of Phase 15 acceptance |

---

## Notes

The compile-shipping proof (R-PTY-04) is the load-bearing validation: a green canary + a working
`bun run` source spike is necessary but NOT sufficient — the phase only passes when the chosen node-pty
shipping approach is demonstrated through a built sidecar and documented for Phase 16.
