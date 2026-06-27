---
phase: 16-hardened-pty-relay-and-mobile-terminal
plan: 02
subsystem: hub-ws-relay
tags: [pty, websocket, auth, human-guard, runner-type, security]
provides:
  - "authenticated, per-session-authorized raw-terminal relay (term.*)"
  - "humanOnlyPtyGate shared chokepoint (dispatch + relay)"
  - "per-session runner_type + persisted PTY identity (H10)"
  - "test-bound Phase-16 verdict artifact (producer for the Phase-17 cutover gate)"
requires:
  - 16-01
affects:
  - hub/src/ws
  - hub/src/dispatch
  - hub/src/db
  - hub/src/api
  - tools
tech-stack:
  patterns: ["server-inferred actor", "per-socket frame-direction allowlist", "DB host-ownership cross-validation", "single-source verdict schema (producer/consumer)"]
key-files:
  created:
    - hub/src/ws/origin-guard.ts
    - hub/src/runners/resume-binding.ts
    - tools/phase16-verdict-schema.mjs
    - tools/emit-phase16-verdict.mjs
    - tools/cutover-deletion-gate.mjs
    - hub/test/term-relay-auth.test.ts
    - hub/test/term-agent-inventory-auth.test.ts
    - hub/test/term-frame-direction-allowlist.test.ts
    - hub/test/term-ws-origin-guard.test.ts
    - hub/test/human-only-guard.test.ts
    - hub/test/term-relay-human-guard.test.ts
    - hub/test/pty-runner-type.test.ts
    - hub/test/pty-runner-resume-identity.test.ts
    - hub/test/phase16-verdict-artifact.test.ts
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VERIFICATION.md
  modified:
    - hub/src/ws/term-protocol.ts
    - hub/src/ws/client.ts
    - hub/src/ws/agent.ts
    - hub/src/index.ts
    - hub/src/dispatch/gates.ts
    - hub/src/db/schema.sql
    - hub/src/db/dal.ts
    - hub/src/api/sessions.ts
decisions:
  - "actor SERVER-INFERRED from connection identity (cookie⇒human, api_key⇒agent), never a payload field (H1)"
  - "per-socket frame-direction allowlist: term.input client-only, /ws/agent output-only term.data (NH-2)"
  - "missing Origin on /ws/client handshake is REJECTED (CSWSH hardening, NH-3)"
  - "spoofed-inventory defeated by DB host-ownership cross-validation, fail-closed on DB error (NH-1)"
  - "verdict artifact emitted PARTIAL until live device proofs attested — gate stays blocked (honest)"
metrics:
  duration: ~2h
  completed: 2026-06-01
---

# Phase 16 Plan 02: Authenticated Relay + Human Guard Summary

Stood up the authenticated, per-session-authorized, byte-faithful raw-terminal relay (isolated from the
structured pipeline), the shared human-only chokepoint that gates BOTH the dispatch pipeline and the
term.input relay with a server-inferred actor, the per-session runner_type + persisted backend-identity seam
that resume reads (no dual-spawn / mis-route), and the test-bound Phase-16 verdict artifact the Phase-17
cutover gate consumes — with the cost cap provably intact.

## What shipped

- **term-protocol.ts**: added `term.reattach` + the per-socket direction allowlists
  (`CLIENT_TO_HUB_TERM_TYPES` / `AGENT_TO_HUB_TERM_TYPES`). Still zero agent-protocol/RunnerEvent coupling.
- **client.ts relay** (`/ws/client`): direction allowlist (client-write only; a `term.data` injected by a
  client is rejected), `subscribedSessions` + DB `canWriteTerminal` ownership (H2 — no cross-user/
  cross-session hijack via a forged session_id), and the human-only chokepoint on `term.input` with a
  SERVER-INFERRED `human` actor (H1 — not a payload field).
- **agent.ts relay** (`/ws/agent`): OUTPUT-ONLY (`term.data`; a `term.input` on /ws/agent is rejected),
  INVENTORY authz (H3 — drop term.* for a session not advertised by THIS connection) + DB host-ownership
  cross-validation (NH-1 — a spoofed inventory entry for a session whose DB hostname ≠ the supervisor's
  hostname is dropped; fail-closed on DB error).
- **origin-guard.ts + index.ts**: the `/ws/client` handshake rejects a disallowed OR **missing** Origin
  (NH-3 / CSWSH — a forged-origin socket can't ride the cookie to act as human).
- **gates.ts**: `humanOnlyPtyGate` (DispatchGate) + `humanOnlyRejectsActor` (shared decision) +
  `AUTOMATION_ACTORS`. Composes WITH `dailyCostCapGate` — the PTY path adds no uncapped route.
- **schema.sql**: idempotent `ADD COLUMN IF NOT EXISTS runner_type` (DEFAULT 'stream-json', CHECK in
  {stream-json,pty-interactive}) + nullable `pty_backend_id` / `transcript_path`. No backfill.
- **dal.ts**: `setSessionRunnerType` (with the Telegram-default pty guard, R-PTY-11), `getSessionRunnerType`,
  `setSessionPtyIdentity`, `getSessionPtyIdentity`, `canWriteTerminal` (H2), `getSessionHostname` (NH-1).
- **sessions.ts**: `PATCH /:id/runner-type` (opt-in; 409 on the Telegram-default guard) + `GET
  /:id/runner-identity`.
- **resume-binding.ts**: pure `decideResume` — persisted runner_type is authoritative; rebind same backend /
  spawn once on persisted mode / noop if live-bound. No dual-spawn, no mis-route (H10).
- **Task 5 (producer)**: `phase16-verdict-schema.mjs` (single-source schema), `emit-phase16-verdict.mjs`
  (test-bound automated signals + attestation-triplet-required manual signals), `cutover-deletion-gate.mjs`
  (minimal consumer enforcing the GATE-PASS RULE). Emitted `16-VERIFICATION.md` = PARTIAL (automated PASS,
  manual device proofs pending).

## Verification

- 42 PLAN-002 tests pass together (no mock-pollution): term-channel-isolation, term-relay-auth (cross-user/
  cross-session + byte-faithful + direction), term-agent-inventory-auth (cross-host + spoofed-inventory +
  direction), term-frame-direction-allowlist, term-ws-origin-guard, human-only-guard, term-relay-human-guard,
  pty-runner-type, pty-runner-resume-identity, phase16-verdict-artifact.
- `bun run check-baseline` green (pass=1181, skip=130, fail=0).

## Deviations from Plan

**1. [Rule 3 — Blocking] Built a minimal `cutover-deletion-gate.mjs` (the Phase-17-owned consumer)**
- **Found during:** Task 5. The verdict-artifact round-trip test requires the consumer to exist, but
  `cutover-deletion-gate.mjs` is owned by Phase 17 / 17-PLAN-002 T1.
- **Fix:** shipped a MINIMAL gate that imports the shared `phase16-verdict-schema.mjs` and enforces only the
  GATE-PASS RULE (no deletion logic). Phase 17 owns/extends it. The verdict-evaluation contract is pinned
  ONCE in the shared schema module so producer + consumer can't drift — this satisfies the H11/NH-4
  single-source requirement without pre-empting Phase-17's deletion work.

**2. [Honest-state, not a defect] `16-VERIFICATION.md` emitted as PARTIAL**
- The two manual device proofs (R-PTY-07 disconnect→reattach on a real device; R-PTY-09 mobile
  resize/scrollback) are the VALIDATION Manual-Only rows and require an operator attestation triplet that the
  executor cannot truthfully fabricate. The emitter therefore wrote `render_fidelity: FAIL` /
  `mobile_reattach: FAIL` (no triplet) and `verdict: PARTIAL`. The Phase-17 cutover gate stays correctly
  BLOCKED until the operator runs the live device proofs and re-emits with the triplets — exactly the
  forgery-proof behavior the threat model (T-16-16) requires.

## Known Stubs

None affecting the plan goal. The relay path is fully wired; the supervisor-side `term.*`↔Rust-PTY-host
binding (which supervisor relays term.data and consumes term.input) is the integration the supervisor
runner-type dispatch completes (seam present via 16-01's bridge).

## Self-Check: PASSED
- All created files present; commits c2c3870 (term-protocol), f998c46 (runner_type/identity), 9332162
  (relay+guard), b7e218c (verdict artifact). 42 tests + baseline green.
