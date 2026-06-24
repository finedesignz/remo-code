---
phase: 17-codex-pty-runner-and-chatsurface-rip-and-replace
plan: 03
subsystem: hub/translation + hub/telegram
tags: [deferred, telegram, translation, preserve-on-ambiguity]
status: DEFERRED — blocked-on-manual-gate (downstream of the gated ChatSurface deletion)
metrics:
  completed: 2026-06-01
---

# Phase 17 Plan 03: Remove Dead Translation + Mark Telegram Break — Summary (DEFERRED)

## Status: DEFERRED (blocked-on-manual-gate). Nothing removed; nothing marked.

This plan's two removal tasks are downstream consequences of the ChatSurface deletion in 17-02 T3, which
is blocked by the one-way-door gate (Phase-16 verdict PARTIAL). With ChatSurface intact, the preconditions
for both tasks are unmet.

## Translation classification (Task 1) — result: NO DEAD TRANSLATION
Import-graph reality in `hub/src/ws/agent.ts` (the agent-protocol→bubble translation/broadcast site):

| Translation path | Consumer(s) | Disposition |
|---|---|---|
| `thinking` / `tool_result` → `broadcastToSubscribers` | web ChatSurface (LIVE — not deleted) | PRESERVE |
| `tool_use` → `broadcastToSubscribers` + Telegram summarized fan-out | ChatSurface (LIVE) + Telegram bridge (LIVE) | PRESERVE |
| `text_delta` → placeholder/stream bubble | ChatSurface (LIVE) | PRESERVE |
| `assistant_message:final` → broadcast + server-side consumers | ChatSurface (LIVE) + Telegram bridge (LIVE) | PRESERVE |
| `usage_event` → token_usage / cost-cap | scheduler/automation + cost cap (non-bypassable) | PRESERVE (always) |

**Every translation path has a live consumer** because ChatSurface remains. There is no "exists ONLY to
feed the deleted human UI" path to remove. Per PRESERVE-on-ambiguity (the costliest error is deleting
automation/working translation), **nothing was removed.**

## Telegram break (Task 2) — DEFERRED, not performed
`hub/src/telegram/bridge.ts` (+ `approvals.ts`, `dispatch.ts`, `commands.ts`, `client.ts`) is a **live,
working** consumer of the `tool_use` / `assistant_message:final` source and the
`permission_request → onPermissionPending` path. The user actively relies on the Telegram bridge as a
workaround (per project memory). The spec frames the Telegram break as a *consequence* of deleting the
stream-json human runner path — which is gated. Removing the source now would break a working feature for
no benefit while ChatSurface still needs the same translation.

**No `// Phase 17 rip: ... rebuilt in Phase 20` markers were added** — adding "removed here" markers
without an actual removal would be misleading and would falsely advertise a break that has not occurred.
The bridge module is, of course, still on disk (nothing was touched).

## Preserved invariants (re-confirmed, untouched)
- `claude-runner.ts` + `session-bridge.ts` stream-json runner path: unchanged (R-PTY-16).
- `usage_event → token_usage` cost-cap source + `dailyCostCapGate`: unchanged (non-bypassable).
- mount-order, schema.sql idempotency: untouched.

## To unlock
Operator records the R-PTY-07 + R-PTY-09 on-device attestation triplets into `16-VERIFICATION.md`
(via `tools/emit-phase16-verdict.mjs`) → verdict flips to PASS → 17-02 T3 deletion runs → THEN 17-03
T1 (remove now-genuinely-dead translation) + T2 (Telegram break + Phase-20 markers) become executable.

## QC
- `bun run check-baseline`: pass=1181 skip=130 fail=0 total=1311 — within tolerance, fail=0.

## Self-Check: PASSED
- No hub files modified; Telegram bridge module present; classification recorded above.
