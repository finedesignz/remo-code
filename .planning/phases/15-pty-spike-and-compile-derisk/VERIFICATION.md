---
phase: 15-pty-spike-and-compile-derisk
verified: 2026-05-31T00:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: human_needed
  note: "Previously HALTED at autonomous:false operator checkpoint (packaging). Operator decided 2026-05-31 (Option C target / A fallback). Checkpoint now resolved; goal verified."
---

# Phase 15: PTY Spike & Compile Derisk — Verification Report

**Phase Goal:** Derisk `node-pty` (does interactive `claude` PTY work?) and define the
compile/shipping contract for Phase 16. Spike phase — proof + decision, not production.
**Verified:** 2026-05-31
**Status:** PASS
**Re-verification:** Yes — after operator resolved the packaging checkpoint that halted the phase.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | node-pty derisked: interactive `claude` TUI proven to render via PTY | ✓ VERIFIED | SPIKE-FINDINGS §1.4 — 1047 bytes incl. real trust prompt captured under Node ConPTY; verdict WORKS-WITH-helper-exe |
| 2 | PTY runner + Node host exist with locked spawn contract (file `claude`, empty argv, no API key, no -p/stream-json) | ✓ VERIFIED | `claude-pty-runner.ts` L94 `delete env.ANTHROPIC_API_KEY`, L10–16 constraints, L116 empty argv; `pty-host.mjs` present; canary tests green |
| 3 | Raw-terminal WS channel isolated from agent-protocol | ✓ VERIFIED | `hub/src/ws/term-protocol.ts` (57 LOC) + `hub/test/term-channel-isolation.test.ts` pass |
| 4 | Web terminal surface exists | ✓ VERIFIED | `web/src/components/TerminalSurface.tsx` (121 LOC, xterm), wired into ChatLayout.tsx |
| 5 | Compile/shipping contract defined + operator packaging decision recorded | ✓ VERIFIED | SPIKE-FINDINGS §3 (3 options + recommendation) and §6 (operator decision verbatim, 2026-05-31) |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `supervisor/src/runners/claude-pty-runner.ts` | Bun-side PTY runner, raw bytes, contract-locked | ✓ VERIFIED | 6738 B; injectable host-spawn seam; strips ANTHROPIC_API_KEY |
| `supervisor/src/runners/pty-host.mjs` | Node host, node-pty/ConPTY, dead-man teardown | ✓ VERIFIED | 5449 B |
| `hub/src/ws/term-protocol.ts` | Isolated `term.*` WS channel | ✓ VERIFIED | 2228 B |
| `web/src/components/TerminalSurface.tsx` | xterm panel | ✓ VERIFIED | 4263 B; wired in ChatLayout |
| `.planning/.../15-SPIKE-FINDINGS.md` | Shipping contract + decision | ✓ VERIFIED | §6 records operator decision verbatim |

### Commits

| SHA | Subject | Status |
|-----|---------|--------|
| 9a7a75d | Plan 01 — PTY runner + spawn-interception/teardown canaries | ✓ present |
| 8b98296 | Plan 02 — raw-terminal WS channel isolated from agent-protocol | ✓ present |
| 452d382 | Plan 03 — xterm panel + SPIKE-FINDINGS | ✓ present |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| PTY canary suite (6 files) | `bun test <6 pty/term files>` | 14 pass / 0 fail / 48 expect | ✓ PASS |
| Full QC baseline gate | `bun run check-baseline` | actual 1139 pass / 0 fail / 130 skip (baseline 785/0); within tolerance, OK | ✓ PASS |

Note: a `node-pty conpty_console_list_agent.js AttachConsole failed` line prints to stderr from a
spawned ConPTY helper in this headless-console context — it does not fail any test (suite green).

### Anti-Patterns Found

None blocking. SPIKE-FINDINGS §5 lists explicitly-deferred items (intentional, not debt markers).

### Deferred to Phase 16 (PARTIAL — not blocking the derisk goal)

| Item | Why deferred | Addressed in |
|------|--------------|-------------|
| Rust-ConPTY derisk spike (real interactive `claude` TUI from Tauri Rust) | Operator chose Option C as target; must be proven before betting on it | Phase 16 (opening spike) |
| Linux / forkpty-under-Bun verification | Windows-only proven this spike | Phase 16 |
| End-to-end PTY turn through a fully-built MSI sidecar | Blocked on packaging decision (now made) | Phase 16 |
| Packaging delta (build-and-update.ps1 / tauri.conf.json resources / sidecar node-path) | Intentionally untouched — Phase 16 Rust spike decides if Option-A bundling is even needed | Phase 16 |

### Operator Checkpoint Resolution

The phase halted at the `autonomous:false` packaging checkpoint (Plan 03 T3). Operator decision
recorded verbatim in SPIKE-FINDINGS §6 (2026-05-31): **Option C (Rust ConPTY) = target, gated by a
Phase-16 opening derisk spike; Option A (bundled Node + prebuilt node-pty, already proven) = fallback.**
Checkpoint resolved — no longer blocks phase completion.

### Gaps Summary

No gaps blocking the Phase 15 goal. The phase's purpose (derisk node-pty + define the
compile/shipping contract) is fully met: interactive `claude` over PTY is empirically proven, the
spawn contract is code-locked and test-guarded, the WS/web seam exists, and the shipping decision is
made and recorded. Remaining items are explicitly scoped to Phase 16 (Rust spike, Linux, end-to-end
MSI, packaging delta) and are not Phase-15 deliverables.

---

_Verified: 2026-05-31_
_Verifier: Claude (gsd-verifier)_
