---
phase: 20-telegram-transcript-tail
verified: 2026-06-01T00:00:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
verifier: independent (Claude Opus 4.8)
critical_regression_check: CLEAN
---

# Phase 20: Telegram Transcript-Tail — Independent Verification

**Verdict: PASS**

Phase goal: re-source the Telegram outbound bridge + permission/injection path off
backend-agnostic transcript adapters (stream-json event bus already removed in
Phase 17), with fail-closed permission surfacing, PTY write-arbitration, and a
human-only guard — WITHOUT breaking the still-live stream-json/ChatSurface path.

> **Deploy-safety amendment (2026-06-01):** the Phase-20 OUTBOUND re-sourcing was
> originally unconditional, which would have silently killed Telegram outbound replies
> on the prod Coolify hub (no local CLI transcript files there → transcript tail emits
> nothing). The bridge is now **flag-gated on `REMO_PTY_INTERACTIVE`**: flag OFF (prod
> default) restores the stream-json `assistant_message:final` / `session_activity` /
> `permission_pending` event-bus consumer (host-agnostic); flag ON uses the
> transcript-tail source documented below. Permission injection, turn-lock, and the
> human-only guard are unchanged regardless of the flag. See `.planning/DEPLOY-SAFETY.md`
> (verdict now SHIP-HUB-OK) and `telegram-outbound-source-gate.test.ts`.

## Critical Regression Check (#2) — CLEAN

The phase did NOT break the live stream-json path or any shared subsystem.

- **Phase 20 commit range:** `2d07cb6..8b635fc` (5 plans + docs).
- **`hub/src/dispatch/` — UNTOUCHED by Phase 20** (`git diff 12407c1~1..8b635fc -- hub/src/dispatch/**` empty). Non-telegram consumers (scheduler, error-capture, revanote, intake) unaffected.
- **`web/src/components/ChatSurface.tsx` — UNTOUCHED by Phase 20** (diff empty). ChatSurface deletion is gated (Phase 17 cutover gate); ChatSurface is still LIVE and still receives its events.
- **`hub/src/ws/agent.ts` — UNTOUCHED.** Still emits the full stream-json fan (`thinking`/`tool_use`/`text_delta`/`assistant_message`) to web clients AND fans `tool_use` to server-side consumers (Telegram summarized streaming). The live agent→web stream-json path is intact.
- **`hub/src/ws/client.ts` change is additive + scoped:** adds a per-connection `writerId` and gates ONLY `term.input` (PTY) frames through the turn lock. `send_message`/`permission_response`/`question_response` (the live stream-json client path) are unchanged.
- The "rewrote the bridge off the deleted event bus" narrative is accurate but the event bus was deleted in **Phase 17**, not Phase 20. Phase 20 only re-sourced the bridge from the transcript tail. No stream-json event source that the live ChatSurface (or any other subsystem) needs was removed by Phase 20.

**Regression test files (per-file isolation, as the QC gate runs them):**

| File | Result |
|---|---|
| `hub/test/mount-order.test.ts` | pass, fail=0 |
| `hub/test/scheduler.test.ts` | pass, fail=0 |
| `hub/test/error-capture*.test.ts` | pass, fail=0 |
| `hub/test/revanote-*.test.ts` (7 files) | pass in isolation, fail=0 |
| `hub/test/dispatch*.test.ts` | pass, fail=0 |

NOTE: running these files together in ONE `bun test` process produced 4
`broadcastRevanoteEvent`/`broadcastToUser` "export not found" failures. These are
the documented Bun `mock.module` process-global pollution artifact
(`feedback_bun_mock_pollution.md`): the exports DO exist in
`hub/src/ws/registry.ts` (lines 163, and broadcastToUser) and every file passes in
isolation. The QC gate runs each file in its own process and reports fail=0. Not a
real regression.

## Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Backend-agnostic adapters exist + route + deterministic path + skip unknown + Codex never emits permission | VERIFIED | see below |
| 2 | Live stream-json/ChatSurface + shared dispatch NOT broken | VERIFIED | Critical Regression Check above |
| 3 | Fail-closed permission injection, keyed, stale-tap blocked | VERIFIED | see below |
| 4 | Write-arbitration single-writer turn lock | VERIFIED | see below |
| 5 | Human-only guard composes with cost cap, stream-json unaffected | VERIFIED | see below |
| 6 | check-baseline fail=0; no API keys; no stream-json on PTY path | VERIFIED | see below |

### #1 — Backend-agnostic adapters

- `hub/src/telegram/transcript/claude-adapter.ts` and `codex-adapter.ts` both exist.
- `selectAdapter(cliKind)` in `transcript/index.ts` routes `'codex' → CodexTranscriptAdapter`, else `ClaudeTranscriptAdapter`. Bridge/detector consume only the `TranscriptEntry` union.
- **Deterministic path (never newest-file):** Claude — persisted `ctx.transcriptPath` WINS, else `claudeTranscriptPath(projectDir, sessionId)` (filename-stem = session id); absent ⇒ scrape-mode, never a dir-listing guess. Codex — persisted path WINS, else `resolveCodexRolloutByMetaId` matches `session_meta.payload.id === ctx.codexRolloutId` (matches the id, does NOT pick newest); absent ⇒ scrape-mode.
- **Unknown record skipped + counted:** both `mapClaudeRecord`/`mapCodexRecord` `default: onUnknown(); return null`; `skippedUnknownCount` exposed.
- **Codex scrape never emits permission_request:** documented + enforced — `mapCodexRecord` has no `permission_request` branch in file-mode and scrape-mode emits only assistant_text + turn_complete.
- Tests (isolated, all pass): `transcript-adapter-claude.test.ts` (8), `transcript-adapter-codex.test.ts` (8), `transcript-backend-agnostic.test.ts` (4).

### #3 — Fail-closed permission injection

- `permission-detector.ts` is fail-closed: accepts ONLY a `permission_request`/`user_question` entry carrying `{sessionId, requestId, non-empty enumerated options[]}`; no default/timeout/parse-uncertain approval; ambiguous ⇒ null. Negative-tested.
- Approvals keyed by `(requestId, userId[, sessionId])`; `injectPtyKeystroke(sessionId, bytes)` routes a `term.input` frame to ONLY that session's agent channel (no cross-session injection).
- **Stale/replayed taps blocked:** `takePendingPrompt(requestId, userId, sessionId)` REMOVES the pending prompt on consumption — a replayed tap finds nothing.
- Tests (isolated, all pass): `telegram-permission-failclosed.test.ts` (7), `telegram-keystroke-inject.test.ts` (6), `telegram-permission-disambiguation.test.ts` (7).

### #4 — Write-arbitration

- `turn-lock.ts`: single-writer per session, bounded FIFO queue (oldest dropped on overflow), releases on observed `turn_complete` (`onTurnComplete → release`) or 10-min safety TTL backstop. `allowResponseBypass` — a permission/question RESPONSE bypasses the lock (answering is not a new turn).
- `ws/client.ts` gates `term.input` through `acquire(session_id, writerId)`; drops the frame if not granted (no out-of-turn injection). resize/attach/reattach control frames bypass.
- Test (isolated, pass): `pty-turn-lock.test.ts` (7).

### #5 — Human-only guard

- `hub/src/telegram/dispatch.ts` composes `gates: [thresholdGate, dailyCostCapGate, guard]` — `humanOnlyPtyGate` is composed WITH (never replacing) the non-bypassable cost cap. Automation source on a pty-interactive session ⇒ `automation_blocked` (distinct outcome, logged, nothing injected). Stream-json sessions unaffected.
- Test (isolated, pass): `telegram-human-only-guard.test.ts` (4), `telegram-output-from-transcript.test.ts` (7).

### #6 — Baseline + no-API-key + no-stream-json-on-PTY

- `bun run check-baseline` (JWT_SECRET 32+ char dummy): **baseline pass=1263 skip=130 fail=0 / actual pass=1263 skip=130 fail=0 — OK, within tolerance. fail=0 confirmed.**
- **No provider API keys introduced** by Phase 20 (diff grep for OPENAI/ANTHROPIC_API_KEY / `sk-` empty).
- **No stream-json dependency reintroduced on the PTY path** — the only "stream-json" mentions in the transcript dir are comments describing the *removed* (Phase 17) event bus; injection rides the byte-faithful `term.input` relay, never a stream-json pipe.

## Deferred Item (genuinely deferred — NOT hiding broken wiring)

`keystroke-map.ts` literal accept/deny/option byte sequences are PROVISIONAL,
pending live-TUI stdin capture (run TUI → trigger prompt → record stdin bytes per
choice → replace constants). Confirmed this is the ONLY pending item: the wiring is
complete and tested — `keystroke-map.toBase64` → `pty-inject.injectPtyKeystroke` →
`term.input` frame routed to the bound session; fail-closed gating, turn-lock
arbitration, and disambiguation are all fully implemented and pass tests now. The
byte VALUES are the single thing awaiting live verification; the injection path is
not broken. Documented in `keystroke-map.ts` header and `20-VALIDATION.md`.

## Gaps

None. All 5 plans implemented; the critical regression check is clean.

---

_Independently verified against source. Verifier: Claude (gsd-verifier), Opus 4.8._
