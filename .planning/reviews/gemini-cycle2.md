# Gemini adversarial plan review — cycle 2 (verification re-review)

Reviewer: `gemini -p` (CLI, non-interactive, `--approval-mode plan`). Status: AVAILABLE (PROBE_OK).
Scope: VERIFY whether cycle-2 replans (commits `915cdec`, `b569e4f`, `dee1f68`) CLOSE gemini's
cycle-1 HIGHs that map to the genuine H1–H10 set. One bounded `gemini` call per changed phase
(15/16/17/19/20), fed that phase's current PLAN text inline; plan-mode (read-only, no tool calls).
Phase 18 had no genuine gemini HIGH (cycle-1 cost-cap finding adjudicated OVER-EAGER) — not re-run.

Verdicts cross-checked against the actual current plan text (grep) where gemini returned
PARTIAL/OPEN, because gemini under-reads very large inline payloads.

Constraint legend: C1 no API key · C2 official client only · C3 human-only PTY guard ·
C4 interactive-only (no -p/stream-json) · C5 prove-before-delete · C6 Telegram fail-closed + lock.

---

## Per-HIGH verdicts (gemini's cycle-1 HIGHs → cycle-2 status)

### Phase 15 — pty-spike-and-compile-derisk
- **H7 orphaned-PTY-process-leak** → **CLOSED.** `runner.kill()` wired to session-closure + WS-disconnect;
  parent-PID dead-man's-switch; orphan-teardown test present.
- **H6 spawn-argv canary (gemini cycle-1 raised under C4)** → **CLOSED.** Behavioral spawn-interception
  test asserting exact exe/argv/env; no `-p`/`--input-format`/`--output-format`; provider-key denylist.
- *Tauri-updater-ABI (gemini cycle-1 HIGH)* — self-flagged cycle-1 as ALREADY-COVERED (the Phase-15
  compile-derisk checkpoint). Not re-raised.

### Phase 16 — hardened-pty-relay-and-mobile-terminal
- **H1 dispatch-source-integrity (C3)** → **CLOSED.** `humanOnlyPtyGate` derives actor from server-side
  hub auth context (cookie⇒human / api_key⇒agent); non-human `term.input` rejected before forward;
  negative test (automation cannot write via relay).
- **H2 PTY-hijack / per-session write authz** → **CLOSED.** Relay asserts `session_id ∈ subscribedSessions`
  AND DB-backed `canWriteTerminal(userId, sessionId)`; cross-user hijack test.
- **H3 agent-side ownership** → **CLOSED.** `/ws/agent` drops `term.*` for any `session_id` absent from
  that supervisor's advertised inventory; cross-host injection test.
- **H10 identity persistence** → **CLOSED.** `runner_type` + backend transcript path/id columns persisted
  at PTY spawn and read on resume.

### Phase 17 — codex-pty-runner-and-chatsurface-rip-and-replace
- **H4 mechanical one-way-door gate** → **CLOSED.** `tools/cutover-deletion-gate.mjs` parses the Phase-16
  ship-verdict artifact and exits non-zero (hard-aborting the deletion task, zero deletions) unless
  `verdict: PASS` AND explicit manual `render_fidelity`/`mobile_reattach` PASS fields are present;
  `web/test/cutover-deletion-gate.test.ts` proves abort on missing/FAIL/manual-field-absent.
  (Gemini returned PARTIAL on "missing green guard/relay-auth test markers" — downgraded after reading
  17-PLAN-002: the gate keys on the ship-verdict + manual render/reattach PASS fields, a valid equivalent
  to literal per-test markers; a CI-green-but-renders-wrong surface is explicitly rejected. Not a gap.)
- **gemini-17-C1 explicit `delete env.ANTHROPIC_API_KEY`** → **PARTIAL (minor).** `codex-pty-runner-env.test.ts`
  asserts the spawned env carries no `ANTHROPIC_API_KEY` and no forwarded Claude OAuth token (invariant is
  tested), but the plan pins the *assertion*, not the literal `delete env.X` line. Behaviorally covered;
  mechanism not pinned. Low-risk.
- **gemini-17-C4 Codex interactive argv** → **PARTIAL (by-design derisk).** The exact interactive Codex
  argv is explicitly left as a RESEARCH open item + `autonomous:false` operator-confirm checkpoint
  (17-PLAN-001 Task 1/2; Final summary records the confirmed argv). This is a deliberate compile-/runtime-
  derisk gate (same pattern as Phase-15), not an unaddressed plan hole. The rip (Task 3) depends on it,
  so the dependency is sequenced — but the argv itself is not yet locked in text. Track to closure at exec.

### Phase 19 — cutover-gate-and-automation-fallback
- **H8 selector no-legacy / explicit pty runner ids** → **PARTIAL (spawn-arg test gap).** Human paths use
  explicit `claude-pty`/`codex-pty` IDs and the selector excludes the legacy stream-json runner, but the
  plan does not pin a *per-runner spawn-arg negative test* asserting no `-p`/`--input-format` reaches a
  human-selected runner's argv (it leans on the Phase-16/17 canary). Add an explicit Phase-19 selector→argv
  assertion. Folds with H6.
- **H9 provider env-sanitize** → **CLOSED.** Centralized PTY-spawn env sanitization denylists all provider
  keys (ANTHROPIC/OPENAI/GEMINI/GOOGLE + SDK env); per-backend spawned-env test.
- **gemini-19 setup-token (C2)** → **CLOSED.** Negative test: setup-token stays in supervisor ephemeral
  memory, never serialized/persisted to hub.
- **gemini-19 C3 runtime enforcement** → **PARTIAL.** Enforcement lives in `resolveHumanBackend` (selector),
  not as an in-`PtyRunner.spawn()` hard `isHuman=false` reject. Synthesis already classed the in-runner
  assert as cheap defense-in-depth on top of the H1 relay guard (the primary boundary). Acceptable;
  optional defense-in-depth add.

### Phase 20 — telegram-transcript-tail
- **H10-dependent Codex transcript-id mapping** → **CLOSED.** `TranscriptSource` adapter resolves from the
  named persisted backend transcript path/id (Phase-16/17 identity), not newest-file guessing; adapter-
  selection test from real metadata.
- **gemini-20 TOCTOU stale approvals (C6)** → **CLOSED.** A tap resolves exactly one `(sessionId,requestId)`,
  removed on resolve; a superseded/expired pending injects nothing; injection targets only the bound
  session's PTY.
- **gemini-20 mid-turn response interleaving (C6)** → **PARTIAL (named gap, mitigated).** The permission
  RESPONSE path is **exempt from `turnLock.acquire`** (20-PLAN-004 lines 62/79/102/120) rather than taking
  the short-lived micro-lock gemini recommended in cycle-1. Mitigation in the plan: the response is injected
  to the *holder's in-flight turn* only, and only the lock holder is actively writing during a pending
  prompt — so it does not interleave with a competing writer. Residual gap: concurrent raw xterm keystrokes
  from the same holder during the response inject are not paused for the byte injection. Low-risk; a
  micro-lock around the injection would fully close it. Not goal-blocking.

---

## NEW HIGH introduced by the cycle-2 additions

**None genuinely new.** Every "NEW HIGH" gemini emitted per phase was a restatement of that phase's own
threat-model IDs (T-15-04 unauth-attach, T-16-01/02/05/08, T-17-04b gate-bypass, T-19-02c/02d/03b,
T-20-03/07/08/09/10) — i.e. the plans' existing, mitigated threats, not regressions created by the replan.
The cycle-2 additions (relay authz, human chokepoint, orphan teardown, behavioral spawn interception,
mechanical cutover gate, env-sanitize, persisted identity) introduce no new HIGH attack surface.

---

## Counts

- **CLOSED:** 10  (H7, H6/15, H1, H2, H3, H10/16, H4, H9, setup-token, H10-mapping/20, TOCTOU/20 = 11 lines;
  consolidated mapped-HIGH = 10 distinct closed)
- **PARTIAL:** 5  (17-C1 minor, 17-C4 by-design derisk, H8 spawn-arg test gap, 19-C3 defense-in-depth,
  20 mid-turn response micro-lock)
- **OPEN:** 0  (no mapped HIGH left fully unaddressed; 17-C4 is a sequenced derisk checkpoint, not open-ended)
- **NEW HIGH:** 0

**Bottom line:** all four critical security HIGHs (H1/H2/H3 relay+ownership, H4 mechanical one-way-door)
are CLOSED. Remaining PARTIALs are low-risk tightenings (pin the literal env-delete + a Phase-19 selector→argv
negative test + an optional micro-lock on permission-response injection) and one by-design derisk (Codex
argv confirmed at exec). No genuine HIGH is goal-blocking; no new HIGH introduced by cycle-2.
