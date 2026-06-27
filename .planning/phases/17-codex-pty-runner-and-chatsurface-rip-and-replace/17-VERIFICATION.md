---
phase: 17-codex-pty-runner-and-chatsurface-rip-and-replace
verified: 2026-06-01T00:00:00Z
status: passed
score: 5/5 must-haves verified (Plan 001 + gate-enforcement); deletion items legitimately deferred behind device gate
verifier: independent (gsd-verifier, worktree feat/interactive-pty-runner)
re_verification:
  previous_status: none
  note: initial independent verification
---

# Phase 17: Codex PTY Runner + ChatSurface Rip-and-Replace — Independent Verification

**Phase Goal:** Add backend-agnostic interactive Codex PTY runner (additive); gate the destructive
ChatSurface rip behind the Phase-16 ship-verdict one-way-door. Deletion + its dependents DEFERRED
because the Phase-16 device-gated verdict is PARTIAL.

**Verdict: PASS.** Plan 001 (Codex PTY runner) and the cutover-deletion-gate enforcement are genuinely
complete. The only deferrals are the legitimately device-gated deletion items (ChatSurface removal,
dead-translation removal, telegram break) — all blocked by the real PARTIAL Phase-16 verdict, not skipped.

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Codex PTY runner spawns bare interactive `codex`, EMPTY argv | ✓ VERIFIED | `codex-pty-runner.ts:123` — `sendFrame({ t:'spawn', file:'codex', args:[], ... })`. No `-p`/`exec`/`app-server`/stream-json tokens anywhere in source. |
| 2 | Scrubs OPENAI_API_KEY + ANTHROPIC_API_KEY | ✓ VERIFIED | `buildCodexPtyHostEnv` (l.98-103) deletes both. Rust `build_pty_env` (pty_host.rs:99-104) `env_remove` both. Env test asserts both `toBeUndefined`. |
| 3 | No stream-json/headless flags, no agent-protocol/credentials/oauth-poll/session-bridge imports | ✓ VERIFIED | grep of banned tokens returns nothing; module imports only node:child_process/url/path. |
| 4 | Rust backend selector routes by `cli` field | ✓ VERIFIED | `pty_host.rs:108 resolve_cli_binary` → `"codex"=>"codex"`, default `"claude"`; spawn frame reads `cli` (l.325); empty argv (l.138). TS selector `index.ts:27 selectPtyRunner` → `cliKind==='codex' ? CodexPtyRunner : ClaudePtyRunner`. |
| 5 | Spawn-contract canary EXTENDED to codex | ✓ VERIFIED | `no-api-key-no-streamjson-pty.test.ts`: CODEX_RUNNER in ALL_HOST_FILES + PTY_RUNNERS; tests reject app-server/exec, require `file:'codex'`, pin OPENAI_API_KEY scrub. **Injection proof:** inserting `args:['exec']` → canary test FAILS (1 fail), reverted clean. |
| 6 | cutover-deletion-gate ABORTS on real 16-VERIFICATION | ✓ VERIFIED | `node tools/cutover-deletion-gate.mjs` → exit 1, reasons: `verdict=PARTIAL, render_fidelity=FAIL, mobile_reattach=FAIL, render_fidelity_attestation_incomplete, mobile_reattach_attestation_incomplete`. |
| 7 | Test pins the gate-abort | ✓ VERIFIED | `web/test/cutover-deletion-gate.test.ts:91` — "the REAL Phase-16 artifact currently ABORTS the gate" `expect(runGate(real)).not.toBe(0)`. 8 pass / 0 fail. |
| 8 | ChatSurface NOT deleted | ✓ VERIFIED | `web/src/components/ChatSurface.tsx` + `web/src/hooks/useChatSurface.ts` both present. |

**Score:** 5/5 must-haves from 17-PLAN-001 verified; gate enforcement (002 T1) complete.

## Confirmed Deferrals (legitimately device-gated — NOT gaps)

- **ChatSurface deletion (Plan 002 T3):** blocked by gate (Phase-16 verdict PARTIAL, attestation triplets
  empty). Requires real device-build manual attestation to flip the verdict to PASS. Correct per one-way-door.
- **Dead-translation removal (Plan 003 T1):** thinking/tool_result→broadcast still feeds the LIVE ChatSurface
  (not deleted), so removal would break a working path. PRESERVE-on-ambiguity. Correctly deferred.
- **Telegram break (Plan 003 T2):** downstream of the gated deletion; removing now breaks a working feature.
  Correctly deferred.

No automatable work was skipped under the deferral excuse: Plan 001 fully shipped (runner + Rust selector
+ TS selector + canary extension + env test), and the gate + its enforcement test are complete and green.

## Test Counts (real, this run)

| Suite | Result |
|-------|--------|
| `supervisor/test/no-api-key-no-streamjson-pty.test.ts` + `codex-pty-runner-env.test.ts` | 11 pass / 0 fail (43 expects) |
| `web/test/cutover-deletion-gate.test.ts` | 8 pass / 0 fail |
| Canary injection (`args:['exec']`) | 1 fail (as designed), reverted clean |
| `bun run check-baseline` | pass=1181 skip=130 fail=0 total=1311 — within tolerance, **fail=0** |

## Non-Gated Gaps

None. All non-deferred work is complete and verified against source.

---
_Verified independently: 2026-06-01 — Claude (gsd-verifier), worktree feat/interactive-pty-runner._
