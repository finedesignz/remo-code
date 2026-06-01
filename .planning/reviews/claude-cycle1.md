# Plan Review — m-interactive-pty-runner (Cycle 1)

**Reviewer:** Claude (Opus 4.8), in-context adversarial review — NOT a separate `claude -p` CLI session. Performed by the running agent's own reasoning against SPEC + ROADMAP + REQUIREMENTS + Phases 15–20 (CONTEXT/RESEARCH/PLAN/PLAN-CHECK/VALIDATION).
**Date:** 2026-05-31
**Scope:** `.planning/architecture/interactive-pty-runner-SPEC.md`; Phases 15,16,17,18,19,20.
**Verdict (overall):** Plans are unusually rigorous; hard constraints (no API key, official-client-only, human-only PTY, fail-closed injection, no `-p`/stream-json) are each mapped to negative tests. No HIGH that would fail a phase goal outright. The concerns below are enforcement-mechanism gaps, cross-phase coupling risks, and residual one-way-door exposure.

---

## Phase 15 — pty-spike-and-compile-derisk

- [MED] 15 Canary scope is supervisor-only — does not guard hub/web reintroduction of stream-json — The forbidden-token canary (`no-api-key-no-streamjson-pty.test.ts`) greps `supervisor/src/**`. The programmatic entrypoint can be reintroduced from the hub side (e.g. agent-protocol/relay) or via env injected elsewhere. — Fix: state explicitly that the canary's scope is the PTY *spawn site* (correct for the ToS risk, which is purely at spawn argv/env), and add a one-line note that hub/web cannot inject spawn flags (the supervisor owns argv) so the scope is sufficient — or widen the grep if any hub path can influence spawn argv.
- [MED] 15 Bun+node-pty compatibility is the single biggest unknown and gates the entire milestone, but Phase 15 has no explicit fail/abort branch if BOTH bun-native and `@homebridge/...-prebuilt` fail under Bun — Plan-check calls it "the single biggest unknown" but the only documented fallback is a dependency swap + approach (b) helper-exe. — Fix: add an explicit "if no node-pty variant loads under Bun, escalate to operator before Phase 16" exit criterion to 15-VALIDATION (the milestone cannot proceed and the rip must not start).
- [LOW] 15 `autonomous:false` compile-shipping checkpoint (approach a/b/c) may change MSI packaging but the downstream MSI/release workflow (`release-supervisor.yml`, sidecar bundling) is not named as an impacted artifact — Fix: list the MSI/updater workflow as a known-affected surface so the operator weighs packaging churn at the checkpoint.

## Phase 16 — hardened-pty-relay-and-mobile-terminal

- [MED] 16 Human-only guard cannot yet classify a Telegram-origin dispatch (constraint 3) because Telegram's PTY path doesn't exist until Phase 20 — guard is keyed on (source, runner_type) with sources {scheduler, orchestrator-background, auto-dev, error-capture}; "human Telegram allowed" is deferred to Phase 20. Acceptable, but the guard's default for an *unknown/unlabeled* source must be fail-closed (reject), not allow. — Fix: assert in `human-only-guard.test.ts` that an unrecognized/unlabeled dispatch source to a pty-interactive session is REJECTED (default-deny), so a future un-tagged caller can't slip through.
- [MED] 16 tmux is named in the SPEC/REQUIREMENTS (R-PTY-07) but the primary dev host is Windows where the plan substitutes a supervisor-owned ring-buffer — this is a requirement-vs-plan divergence (the "named mechanism" is not the shipped mechanism on the only host that matters) — Fix: confirm REQUIREMENTS R-PTY-07 acceptance is phrased as the *persistence property* ("reattach with scrollback intact"), not "tmux", so the Windows ring-buffer path is conformant; reconcile the SPEC wording if it hard-names tmux.
- [MED] 16 Ring-buffer scrollback replay can desync xterm rendering — replaying raw bytes (cursor-positioning/alt-screen TUI escapes) from a mid-stream offset into a fresh xterm can corrupt the rendered TUI; a bounded byte ring may start mid-escape-sequence — Fix: specify that replay starts at a safe boundary (e.g. last full-screen redraw / alt-screen enter) or that the runner requests a full `claude` TUI repaint on reattach; add a reattach-render-fidelity assertion beyond "last-N lines present."
- [LOW] 16 PTY persistence + idle-teardown reuse: the SPEC exempts the orchestrator session from idle teardown; a supervisor-owned persistent PTY that mirrors idle-teardown semantics must preserve that exemption or it could reap the orchestrator's terminal — Fix: note the orchestrator-exempt carve-out applies to persistent PTYs too.

## Phase 17 — codex-pty-runner-and-chatsurface-rip-and-replace (one-way door)

- [HIGH] 17 The one-way-door gate ("Phase-16 ship-verdict = PASS") is enforced only by a manual operator confirmation in `17-02-PRECHECK.md`, not mechanically — The sequencing safeguard is the load-bearing protection for an irreversible deletion, yet nothing in the plan *blocks* the deletion task if the operator skips the precheck or the verdict is PARTIAL. An autonomous/parallel executor could proceed. — Fix: make 17-02 T1 a hard gate — a test or script that reads the Phase-16 `VERIFICATION.md` ship verdict and FAILS the task (non-zero exit) unless it is an explicit PASS; the deletion commit must depend on that check, not on prose.
- [HIGH] 17 "Render fidelity proven" is in the SPEC's verification list but is a MANUAL-only check — the rip's precondition includes "terminal surface renders fidelity + accepts injected input," yet Phases 15/16 mark render-fidelity as manual device verification. If the gate (above) only checks an automated baseline, the rip can proceed on a surface that compiles but renders the TUI incorrectly on mobile. — Fix: the Phase-16 ship verdict that gates Phase 17 MUST record the manual render-fidelity + mobile-reattach result as PASS/FAIL explicitly; the Phase-17 precheck reads that field, not just CI green.
- [MED] 17 "Remove DEAD translation, PRESERVE automation translation" relies on import-graph analysis with "when ambiguous, preserve" — correct posture, but deleting an automation-needed broadcast silently breaks Phase 18's leak detector / cost-cap `usage_event` capture, and the failure is silent (no human UI to notice) — Fix: add a *positive* regression test asserting `usage_event`/`token_usage` capture still fires end-to-end after the rip (drive a stream-json automation turn → assert a row lands), not just a grep that the runner file is untouched.
- [MED] 17 Codex interactive argv is undocumented/version-unstable and is on the critical path for R-PTY-12, yet there is no fallback if the installed Codex CLI exposes no flag-free interactive entrypoint — the same risk is flagged in Phase 20. — Fix: add a Phase-17 spike/abort note mirroring Phase 15 — if interactive Codex argv can't be confirmed, the Codex runner ships as a stub (like the Gemini seam) and Claude remains the only proven backend; do not block the ChatSurface rip on Codex.
- [LOW] 17 Grid decision (terminal-cells vs drop-conversation-rendering) is deferred to the planner with "smallest diff" — dropping grid conversation rendering is a user-visible feature regression (grid view is a shipped, documented feature, milestone v-settings-overhaul) — Fix: flag that dropping grid rendering needs operator sign-off (it's a feature removal), not a silent smallest-diff choice.

## Phase 18 — billing-guardrail-dual-bucket-usage

- [MED] 18 The programmatic-credit endpoint is unconfirmed (LOW confidence) and only verifiable post-June-15 on a live account — the dual-bucket poll, leak detector, and hard-halt all depend on a field/endpoint that may not exist or may live only in the web UI — Fix: the fail-safe "unknown bucket" empty state is correctly mandated; additionally gate the *leak-alert and hard-halt logic* behind "credit balance is known" so they cannot fire false positives/halts on a fabricated or absent number (a halt on a misparsed bucket would deny automation wrongly).
- [LOW] 18 Hard-halt adds a predicate at `dailyCostCapGate` — must not change the gate's behavior for the human interactive PTY path (which intentionally does NOT pass the cost cap) — Fix: assert in `programmatic-hard-halt.test.ts` that a human pty-interactive turn is unaffected by the halt predicate (the doc claims it; pin it with the test).

## Phase 19 — cutover-gate-and-automation-fallback

- [MED] 19 Default-backend flip (R-PTY-22) decision rule "interactive ⇒ Claude, programmatic ⇒ Codex" assumes Codex is verified-permissive, but Codex's own billing classification post-cutover is asserted from secondary sources and not in the gate's four checks — if Claude bills programmatic AND Codex's ChatGPT-subscription Codex usage is also restricted, the fallback lands users on an unverified path. — Fix: add a fifth gate check measuring Codex-via-PTY's actual subscription consumption before defaulting to it; until measured, default stays Claude with a visible warning rather than auto-switching to an unverified Codex.
- [LOW] 19 Gemini stub is feature-flagged off and "never default-selected" — good; ensure the backend selector's *fallback chain* can't reach Gemini automatically if Codex also fails (it should surface not-available, not silently try Gemini) — Fix: assert the selector returns a hard error (no backend) rather than the Gemini stub when Codex is unavailable.

## Phase 20 — telegram-transcript-tail (sequenced strictly after 17)

- [MED] 20 Fail-closed parsing is correctly mandated, but the Codex *scrape fallback* path (byte-scraping the TUI) is the most parse-ambiguous source and is exactly where a mis-parse → auto-approval is most likely — the SPEC says the Codex scrape path "emits no permission prompts at all," which is the safe choice, but it must be enforced, not assumed. — Fix: assert in test that the Codex scrape adapter NEVER emits a `permission_request` TranscriptEntry (only `assistant_text`/`turn_complete`); a permission can only come from a structured JSONL adapter, never the scrape.
- [MED] 20 Turn-lock TTL fallback (release on missed `turn_complete`) is a safety valve that can release the lock mid-turn if `turn_complete` detection is merely slow, letting the queued writer's keystrokes interleave into a still-running turn — the exact corruption T-20-10 guards against — Fix: on TTL expiry, do NOT auto-grant the next writer; surface a "turn stuck" state and require explicit re-acquire, or make the TTL generous + logged-only with no auto-release of injection rights.
- [MED] 20 Permission RESPONSE from a non-holder is exempt from the lock and injected immediately — correct for liveness, but two near-simultaneous responses (xterm + Telegram) to the same `(sessionId, requestId)` could both inject keystrokes before the resolve is observed — Fix: gate response injection on the `(sessionId, requestId)` single-decision removal-on-resolve (claim-then-inject), so the second response no-ops (already covered for taps; ensure it also covers a direct xterm keypress racing a Telegram tap).
- [LOW] 20 Transcript file resolution is mandated deterministic (project-dir + session-id) not newest-file — good; but Codex rollout JSONL path is dated/undocumented and version-unstable, so a Codex CLI update could break resolution silently and fall back to scrape (losing permission detection) without alerting — Fix: emit a visible "transcript adapter degraded to scrape (no permission detection)" notice when the structured Codex JSONL can't be resolved, so the user knows approvals won't surface.

---

## HIGH summary (phase → count)

| Phase | HIGH count | Titles |
|-------|-----------|--------|
| 15 | 0 | — |
| 16 | 0 | — |
| 17 | 2 | One-way-door gate is manual-only (not mechanically blocking); render-fidelity precondition is manual and may not gate the rip |
| 18 | 0 | — |
| 19 | 0 | — |
| 20 | 0 | — |

**Total HIGH: 2 (both Phase 17).** Both are about hardening the *enforcement* of the already-correct sequencing safeguard so an irreversible deletion cannot proceed on an unproven surface or a skipped precheck.
