# Deploy-Safety Assessment — feat/interactive-pty-runner → main + Coolify hub redeploy

**Date:** 2026-06-01 · **Verifier:** Claude (independent) · **Branch:** feat/interactive-pty-runner

## VERDICT: ⚠️ DON'T-SHIP-HUB AS-IS (one behavior regression, NOT a crash)

The hub will **boot and run without crashing** in the Coolify container. The PTY runner +
backend-selector are supervisor-local and flag-gated (`REMO_PTY_INTERACTIVE`), so they do
NOT change prod hub behavior. **BUT** there is ONE non-flagged, non-additive prod-hub
behavior change that WILL alter the live user's experience the moment it deploys:

> **Telegram OUTBOUND summaries go SILENT.** Phase 17 deleted the `assistant_message:final`
> event bus that fed the Telegram outbound bridge; Phase 20 re-sourced the bridge to tail the
> CLI transcript files on the LOCAL filesystem. In the Coolify container those files do not
> exist → every Claude session resolves to **scrape-mode**, which **emits nothing**. So a
> Telegram user who today receives assistant replies in Telegram will receive **none** after
> deploy (until the supervisor is also on the PTY path with transcript files the hub can read
> — which it cannot, because hub and supervisor are different hosts).

This is the device-gate concern made concrete: the transcript host-locality assumption
(CLI + transcripts on the same host as the consumer) is FALSE for the Coolify hub.

---

## A. Non-flagged, non-additive runtime prod-hub changes (vs origin/main)

Almost everything is either additive or flag-gated:

- **PTY runner / backend-selector / runner-factory** — supervisor-only (the supervisor is
  NOT deployed; it runs on the dev machine). Live runner choice in `session-bridge.ts` is
  gated by `REMO_PTY_INTERACTIVE` (default off → stream-json `ClaudeRunner`, unchanged).
- **`hub/src/ws/agent.ts` term.* relay** — ADDITIVE short-circuit, only entered when
  `isTermFrameType(parsed)` (a `term.data` frame). A stream-json supervisor with the flag
  off never sends these, so the structured agent-protocol path is byte-for-byte unchanged.
- **`hub/src/ws/client.ts` term channel, `term-protocol.ts`, `term-ws.ts`** — additive new
  frame types; dormant unless a PTY session exists.
- **dual-bucket usage (Phase 18)** — additive WS fields + store; `programmatic_halt_usd`
  defaults NULL = OFF (no surprise hard-stop).
- **dispatch/gates.ts** — `humanOnlyPtyGate` added, composes with the existing cost cap; no
  change to the existing cost-cap behavior.

**The one exception (NOT additive, NOT flagged):**
- **`hub/src/telegram/bridge.ts` + `dispatch.ts` + `permission-surfacing.ts`** — the
  outbound Telegram path was **replaced**. `startTelegramBridge()` no longer subscribes to
  any assistant-final event bus (it's deleted — see bridge.ts header comment L11). Outbound
  now comes ONLY from `subscribeToSessionTranscript()` (lazy, per-session on inbound
  dispatch) reading transcript files. **This always runs in prod** (no flag), and changes
  observable Telegram behavior.

## B. Telegram transcript-tail host-locality (THE KEY RISK)

**Does the hub-side tail read the LOCAL filesystem?** YES.
- `hub/src/telegram/transcript/claude-adapter.ts` → `claudeTranscriptPath()` =
  `join(homedir(), '.claude', 'projects', <slug>, '<sessionId>.jsonl')`. `homedir()` resolves
  to the CONTAINER's home, where no `~/.claude/projects/...` exists. The persisted
  `sessions.transcript_path` (recorded at PTY spawn on the dev host) is also a dev-host path,
  meaningless in the container.
- `codex-adapter.ts` similarly reads `~/.codex/...` local paths.

**Does it FAIL GRACEFULLY?** YES — no crash, no throw on boot or on dispatch:
- `claude-adapter.open()`: `existsSync(candidate)` is false → returns `{ mode: 'scrape',
  path: null }`. No throw.
- `tail.ts tailJsonl()`: even if a path were tailed, `stat(path)` is wrapped in try/catch
  and simply returns when the file is absent; `fs.watch` is try/caught; the poll backstop is
  a cheap stat. **No unhandled rejection, no crash.**
- `manager.ts`: consumer-fan is try/caught per consumer; a missing session row returns null
  cleanly.
- The Telegram bridge boot (`startTelegramBridge`) only sets webhook + commands; transcript
  subscription is lazy per-session and no-ops on absence.

**Net container behavior when those paths don't exist:** the hub boots normally, the
existing Telegram inbound bridge still works (inbound user→session dispatch is unchanged and
does NOT depend on transcripts), and the hub does NOT crash. **Outbound assistant text to
Telegram simply yields nothing** (every session is scrape-mode and scrape-mode emits no
entries on the hub — the byte-scrape feed only exists on the PTY/terminal path, which is off
in prod). Permission surfacing also never fires (scrape-mode never emits a permission).

## C. Telegram behavior change for the 1 live user; old consumer intact?

- **Observable change: YES.** Outbound Telegram replies that the live user currently gets
  (sourced from the stream-json `assistant_message` via the now-deleted event bus) will
  STOP. Inbound (user types in Telegram → session) is unaffected.
- **Old stream-json outbound consumer intact? NO.** The Phase-20 verify claim that the old
  consumer was preserved does **not** hold for the outbound path: the `assistant_message:
  final` event-bus subscription was DELETED (Phase 17 rip), and the bridge was fully
  re-sourced to the transcript tail. There is no side-by-side old consumer. (The stream-json
  *runner* itself is intact and still persists `messages` to the DB — only the Telegram
  outbound feed was cut.)

## D. schema.sql idempotency — PASS

All new DDL re-runs safely every boot: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
(`programmatic_halt_usd` NULL; `runner_type` DEFAULT 'stream-json'; `pty_backend_id`,
`transcript_path` nullable), and the `sessions_runner_type_check` constraint is added inside
a `DO $$ ... IF NOT EXISTS (information_schema.check_constraints) ...` guard. No backfills in
schema.sql. Existing rows default to `stream-json` — unchanged.

## E. QC baseline — PASS

`bun run check-baseline` with a dummy 32-char JWT_SECRET: **pass=1274 skip=130 fail=0**
(baseline 1263) — within tolerance, **fail=0**.

---

## Recommendation

The merge is fine; the **hub redeploy is the problem for the live Telegram user**. Options
before redeploying the prod hub:

1. **Preferred:** keep the deleted `assistant_message:final` → Telegram outbound consumer as
   a fallback that runs when `transcriptMode(sessionId) === 'scrape'` (i.e. no local
   transcript) — so prod (stream-json, no local files) still gets Telegram summaries from the
   DB/event path, and only PTY-on hosts use the transcript tail. This restores the "old
   consumer intact" guarantee Phase 20 assumed.
2. **Or** gate the transcript re-sourcing behind the same `REMO_PTY_INTERACTIVE` flag so the
   prod hub keeps the existing outbound path until the PTY cutover actually happens.
3. **Or** accept the regression knowingly: redeploy is non-crashing; the only loss is
   Telegram outbound summaries for the single live user until the device gate opens. If that
   user does not currently rely on Telegram outbound, ship is acceptable.

**Bottom line:** No crash, no boot failure, schema-safe, baseline-green — but redeploying the
hub silently kills Telegram outbound replies because the transcript tail reads a local
filesystem that is empty in the Coolify container. Do NOT redeploy the hub expecting "no
behavior change" until the outbound path is restored or flag-gated (option 1 or 2).
