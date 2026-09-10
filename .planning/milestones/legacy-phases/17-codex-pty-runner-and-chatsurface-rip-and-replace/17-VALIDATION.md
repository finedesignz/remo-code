---
phase: 17
slug: codex-pty-runner-and-chatsurface-rip-and-replace
status: final
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-31
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for the Codex PTY runner + the one-way-door rip-and-replace.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (existing) |
| **Config file** | none — `bun test` discovers `*.test.ts`; baseline in `tools/regression-baseline.json` |
| **Quick run command** | `bun test hub/test/automation-translation-preserved.test.ts web/test/no-human-chatsurface.test.tsx` |
| **Full suite command** | `bun run check-baseline` (+ `cd web; bun run build`) |
| **Estimated runtime** | quick ~5s; full per-file-isolated suite ~minutes + web build |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the touched area.
- **After every plan wave:** Run `bun run check-baseline` + `cd web; bun run build`.
- **Before any deletion (17-02/03):** Confirm the Phase-16 VERIFICATION verdict = PASS (one-way-door gate).
- **Before `/gsd:verify-work`:** Full suite + web build green; automation-preservation + Telegram-marker proofs done.
- **Max feedback latency:** ~5s for the canary/preservation tests.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 17-01-01 | 01 | 1 | R-PTY-12 | T-17-01/02 | Codex PTY runner interactive-only, env-clean, no RunnerEvent | canary/static | `bun test supervisor/test/no-api-key-no-streamjson-pty.test.ts` | ✅ | ✅ green |
| 17-01-02 | 01 | 1 | R-PTY-12 | T-17-02 | Codex env carries no API key / no forwarded OAuth | unit | `bun test supervisor/test/codex-pty-runner-env.test.ts` | ✅ | ✅ green |
| 17-02-01 | 02 | 2 | R-PTY-13b | T-17-04 | MECHANICAL deletion gate aborts unless Phase-16 verdict PASS + provenance | gate/unit | `bun test web/test/cutover-deletion-gate.test.ts` | ✅ | ✅ green (gate ENFORCED; real artifact ABORTS) |
| 17-02-02 | 02 | 2 | R-PTY-13 | T-17-05/06 | no ChatSurface/bubble path for human sessions; chrome intact | static/render | `bun test web/test/no-human-chatsurface.test.tsx` | ❌ | 🚫 blocked-on-manual-gate (ChatSurface NOT deleted; deletion deferred to device attestation) |
| 17-02-03 | 02 | 2 | R-PTY-13 | T-17-06 | no indigo; web builds | unit/build | `bun test web/test/no-indigo.test.ts; cd web; bun run build` | ✅ | ✅ green |
| 17-03-01 | 03 | 3 | R-PTY-14/16 | T-17-07/08 | usage/cost-cap + automation finalize PRESERVED after rip | regression | `bun test hub/test/automation-translation-preserved.test.ts` | ❌ | 🚫 blocked-on-manual-gate (no dead translation while ChatSurface live; nothing removed) |
| 17-03-02 | 03 | 3 | R-TG-12 | T-17-09 | Telegram break marked for Phase 20; bridge module on disk | static/grep | `bun test hub/test/telegram-break-marked.test.ts` | ❌ | 🚫 blocked-on-manual-gate (Telegram source still live + working; not removed) |

### Deferred (blocked-on-manual-gate)

The destructive half of Phase 17 is BLOCKED by the one-way-door gate. `tools/cutover-deletion-gate.mjs`
exits non-zero against the real `16-VERIFICATION.md` (`verdict: PARTIAL`, `render_fidelity: FAIL`,
`mobile_reattach: FAIL`, empty `manual_attestation` triplets). Per that gate, the following remain deferred:

- **17-02 T3** — delete ChatSurface / bubble components / feeding hooks. DEFERRED. ChatSurface is intact;
  the terminal surface is already routed behind the existing `localStorage remo:pty-interactive` flag
  (Phase 16), so the routing seam exists without the deletion.
- **17-03 T1** — remove dead human-UI-only translation. DEFERRED. While ChatSurface remains live, the
  agent-protocol→bubble translation in `hub/src/ws/agent.ts` still has live consumers (ChatSurface web
  render + Telegram fan-out + usage/cost-cap). NOTHING is provably dead; PRESERVE-on-ambiguity ⇒ no removal.
- **17-03 T2** — remove + mark the Telegram structured-event source. DEFERRED. The Telegram bridge is a
  live, working consumer of the same translation. Removing it now would break a working feature for no
  benefit, and the break is contractually a consequence of the (gated) human-UI deletion. No markers were
  added (adding "removed here" markers without removal would be misleading).

To unlock: an operator records the two on-device attestation triplets (R-PTY-07 phone reattach, R-PTY-09
mobile resize/scrollback) into `16-VERIFICATION.md` via `tools/emit-phase16-verdict.mjs`, flipping the
verdict to PASS. Then 17-02 T3 / 17-03 T1+T2 may execute.

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `supervisor/test/codex-pty-runner-env.test.ts` — Codex env-hygiene stub
- [ ] `web/test/no-human-chatsurface.test.tsx` — no-human-chat-UI assertion stub
- [ ] `hub/test/automation-translation-preserved.test.ts` — usage/cost-cap + finalize preservation stub
- [ ] `hub/test/telegram-break-marked.test.ts` — Phase-20 marker + bridge-module-present stub
- [ ] `17-02-PRECHECK.md` — one-way-door gate note (Phase-16 verdict)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Phase-16 terminal surface is PROVEN before deletions | R-PTY-13/15 (gate) | Depends on Phase-16 ship-verdict + manual device proofs | Confirm 16-VERIFICATION = PASS; record in 17-02-PRECHECK.md before deleting anything |
| Claude AND Codex human sessions both render correctly on the terminal surface | R-PTY-12/15 | Requires live `claude login` + Codex login TUIs | Start a Claude PTY session and a Codex PTY session; verify both render + take input |
| App chrome (sidebar/nav) intact after ChatSurface deletion | R-PTY-13 | Visual; build-green ≠ chrome-correct | Load the app; confirm sidebar/nav/theme unchanged, only conversation region is now the terminal |
| Telegram is non-functional but recoverable (markers present) | R-TG-12 | Confirms the explicit-break contract | Send a Telegram message → no structured bridge response; grep confirms Phase-20 markers + bridge module present |
| Automation (scheduled run) still finalizes + is cost-capped after the rip | R-PTY-14/16 | End-to-end automation path | Trigger a scheduled-style dispatch; confirm it runs, finalizes, and counts against the cost cap |

---

## Notes

The load-bearing validations are (1) the ONE-WAY-DOOR GATE — no deletion until Phase-16 verification is
PASS; (2) the automation-preservation regression (usage_event/cost-cap + scheduler/error-capture finalize
survive the rip) — deleting automation-needed translation is the costliest error and the rule is
PRESERVE-on-ambiguity; and (3) the explicit Telegram-break markers so Phase 20 can rebuild. A green web
build is necessary but not sufficient — the automation-preservation test and the manual chrome smoke must pass.
