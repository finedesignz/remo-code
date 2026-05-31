---
phase: 20
slug: telegram-transcript-tail
status: draft
nyquist_compliant: true
created: 2026-05-31
---

# Phase 20 — Validation Strategy

Security-sensitive phase (permission injection + write arbitration). Sampling is biased toward the
fail-closed and arbitration invariants, which are the load-bearing risks.

---

## Test Infrastructure

- `bun test` in `hub/` (per-file isolation via `bun run check-baseline`; register new test files in
  `tools/regression-baseline.json` if the gate requires it).
- Fixture transcripts committed under `hub/test/fixtures/`: `claude-transcript.jsonl`,
  `codex-rollout.jsonl`, `unrecognized-rollout.jsonl`, plus inline malformed-permission fixtures.
- No DB schema added; no new prod endpoint expected (turn lock + registry are in-memory). `docs:sync`
  only if an endpoint changes.

---

## Sampling Rate

- CRITICAL invariants (fail-closed parse; no auto-approve; no mid-turn interleave; human-only guard):
  100% — each has a dedicated assertion plus a negative test (the dangerous path produces nothing).
- HIGH invariants (deterministic session→file mapping; (sessionId,requestId) keying; correct-PTY
  injection; stale-tap rejection): one positive + one adversarial test each.
- MED/quality (final-only forwarding, queue bound, TTL release): one test each.
- Backend coverage: every adapter-facing assertion runs against BOTH a Claude fixture and a Codex
  fixture (or the Codex scrape fallback) — backend-agnosticism is itself sampled.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|--------|
| 20-01-01 | 01 | 1 | R-TG-01 | T-20-02 | bridge sees only TranscriptEntry; selectAdapter by cliKind | unit | `bun test hub/test/transcript-backend-agnostic.test.ts` | ⬜ pending |
| 20-01-02 | 01 | 1 | R-TG-02 | T-20-01 | Claude file resolved deterministically; unknown type skipped | unit | `bun test hub/test/transcript-adapter-claude.test.ts` | ⬜ pending |
| 20-01-03 | 01 | 1 | R-TG-03 | T-20-03 | Codex rollout by session_meta id; fallback emits no permission_request | unit | `bun test hub/test/transcript-adapter-codex.test.ts` | ⬜ pending |
| 20-02-01 | 02 | 2 | R-TG-04 | T-20-04/05 | final assistant_text only; no onAssistantMessageFinal import | unit | `bun test hub/test/telegram-output-from-transcript.test.ts` | ⬜ pending |
| 20-03-01 | 03 | 2 | R-TG-06 | T-20-06 | malformed permission ⇒ zero prompts + zero keystrokes | unit (neg) | `bun test hub/test/telegram-permission-failclosed.test.ts` | ⬜ pending |
| 20-03-02 | 03 | 2 | R-TG-05/07/09 | T-20-07/08/09 | (sessionId,requestId) keying; no collision; stale/unauth tap rejected | unit | `bun test hub/test/telegram-permission-disambiguation.test.ts` | ⬜ pending |
| 20-03-03 | 03 | 2 | R-TG-08 | T-20-07 | injected bytes match mapping; correct PTY only; no permission_response | unit | `bun test hub/test/telegram-keystroke-inject.test.ts` | ⬜ pending |
| 20-04-01 | 04 | 3 | R-TG-10 | T-20-10/11/12 | queued not interleaved; release on turn_complete; response bypasses lock | unit | `bun test hub/test/pty-turn-lock.test.ts` | ⬜ pending |
| 20-05-01 | 05 | 4 | R-TG-11 | T-20-13 | human msg allowed; automation Telegram-origin rejected | unit (neg) | `bun test hub/test/telegram-human-only-guard.test.ts` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

All test files above are Wave-0 stubs to author first (they fail until the impl lands), so the gate
tracks them from the start. Fixtures (`hub/test/fixtures/*.jsonl`) are Wave-0 artifacts shared by
plans 01–04.

---

## Manual-Only Verifications (the gating items)

1. **Per-backend keystroke byte capture** (plan 03, task 3) — the literal TUI accept/deny/option bytes
   for live Claude + Codex must be captured by hand; until then the keystroke-map is provisional. This
   is the Phase-20 analogue of Phase-15's compile-shipping spike: an `autonomous:false` checkpoint.
2. **Live permission round-trip** — against a real Claude TUI and a real Codex TUI: a Telegram tap
   drives a real prompt; an ambiguous prompt surfaces nothing.
3. **Codex rollout path/schema re-verification** on the Windows dev host + the installed Codex version
   (the documented path/format is community-sourced and version-unstable).

---

## Notes

- The fail-closed and arbitration invariants are tested as NEGATIVE assertions (the dangerous path
  produces nothing), not just positive ones — this is deliberate for a security-sensitive phase.
- Backend-agnosticism is sampled, not assumed: every adapter assertion runs on both backends.
