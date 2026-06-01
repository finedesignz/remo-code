# Synthesis — Cycle-1 Adversarial Plan Review (m-interactive-pty-runner, Phases 15–20)

**Date:** 2026-05-31
**Inputs:** `codex-cycle1.md` (HIGH 51 — heavy over-fire), `gemini-cycle1.md` (HIGH 14), `claude-cycle1.md` (HIGH 2).
**Method:** every distinct HIGH deduped across reviewers, then adjudicated against the SPEC
(`interactive-pty-runner-SPEC.md`), `REQUIREMENTS.md`, and each phase's CONTEXT/PLAN-00N/PLAN-CHECK/VALIDATION.
Cross-reviewer agreement raises confidence; the codex HIGH count is inflated (it re-fires the same 5
cross-phase themes per-phase and rates "make-it-explicit" items HIGH).

**Verdict line:** No HIGH fails a phase goal outright. The real remediation set is **9 GENUINE** items —
almost all enforcement-mechanism / artifact-hygiene gaps clustered at two seams (the raw `term.input`
relay boundary, and the phase-gating/metadata artifacts), plus a handful of phase-local test/scrub
tightenings. The bulk of findings are ALREADY-COVERED (mapped to a threat-model item + negative test in
the plans) or OVER-EAGER (contradict the deliberate human-exempt / rip-and-replace design).

---

## Consolidated HIGH table

| # | Consolidated HIGH concern | Reviewers | Verdict | Phase · Plan | One-line remediation |
|---|---|---|---|---|---|
| H1 | Raw `term.input` relay bypasses the human-only guard **and** the cost-cap chokepoint (guard lives only in `dispatch/pipeline.ts`; relay forwards by `session_id` w/o gating) | codex, gemini, claude | **GENUINE** | 16 · PLAN-002 | Add a `term.input` relay-boundary check that derives actor/source from hub auth context (cookie=human vs api_key) and rejects non-`human_interactive` writes **before** forwarding; add negative test that automation cannot write via the relay. |
| H2 | No per-session ownership authz on `term.attach`/`term.input` — client-supplied `session_id` lets any cookie-holder hijack a live TUI (relay routes by id, no `subscribedSessions`/`canWriteTerminal` check) | codex, gemini | **GENUINE** | 16 · PLAN-002 | Before relaying any `term.*` frame, assert `session_id ∈ socket.subscribedSessions` AND a DB-backed `canWriteTerminal(userId, sessionId)`; reject otherwise. Add `term-relay-auth.test.ts` cross-user/cross-host injection cases (file already listed — extend it). |
| H3 | Agent-side ownership: term frames routed to `/ws/agent` by `session_id` without proving the supervisor advertised/owns it (cross-agent injection) | codex | **GENUINE** | 16 · PLAN-002 | On the `/ws/agent` side, drop `term.*` for any `session_id` not in that supervisor's advertised inventory (`supervisor-registry`). Add test. |
| H4 | One-way-door sequencing gate (Phase 17) enforced only by a narrative `17-02-PRECHECK.md` + operator text, not a machine-verifiable Phase-16 PASS artifact | codex, claude | **GENUINE** | 17 · PLAN-001 (gate task) | Replace the note-file precheck with a hard dependency: a mechanical gate script that asserts named Phase-16 PASS artifacts exist (e.g. `16-02-SUMMARY.md` + a `16-VERIFICATION` verdict=PASS line + green `human-only-guard`/`term-relay-auth` test markers) and **fails execution / aborts deletion** if absent; record immutable evidence paths. |
| H5 | PLAN-CHECK says PASS while VALIDATION frontmatter says `nyquist_compliant:false`, `wave_0_complete:false`, `status:draft` in **every** phase; each bundle also carries a duplicate PLAN-CHECK block | codex | **GENUINE** (hygiene) | 15–20 · all PLAN-CHECK/VALIDATION | Reconcile the frontmatter (flip to `true`/`final` once wave-0 stubs land, or correct PLAN-CHECK to PARTIAL); de-dupe the duplicated PLAN-CHECK block. Blocks clean execution metadata, not goals. |
| H6 | Static grep canaries are too weak for the no-API-key / no-`-p` / official-client invariants (misses argv built via helpers, tmux builders, config merges, inherited `process.env`, non-Anthropic provider keys) | codex, gemini | **GENUINE** | 15·PLAN-002, 16·PLAN-002, 17·PLAN-001, 19·PLAN-002 | Add behavioral spawn-interception tests asserting **exact exe/argv/env** from the real supervisor instantiation path (intercept `node-pty.spawn` + tmux builder); assert no `-p`/`--input-format`/`--output-format` and a denylist of provider key envs. Static grep stays as a cheap canary only. |
| H7 | Orphaned-PTY process leak — `runner.kill()` not wired to session teardown / WS disconnect (zombie `claude` + pty host procs) | gemini | **GENUINE** | 15·PLAN-002 / 16·PLAN-001 | Hook `runner.kill()` to supervisor session-closure + `/ws/agent` disconnect lifecycle in `supervisor/src/index.ts`; add a dead-man's-switch (parent-PID poll) so the PTY self-terminates if the supervisor dies. Add teardown test. |
| H8 | Phase-19 selector can pick the legacy stream-json Claude runner (generic `claude` id) → human path emits `--input-format/--output-format`, violating interactive-only billing | codex | **GENUINE** | 19·PLAN-002 | Use explicit runner IDs `claude-pty`/`codex-pty` (never generic `claude`/`codex`) on human paths; spawn-arg test rejects programmatic flags on any human-selected runner. |
| H9 | Phase-19 API-key scrub too narrow — Codex/Gemini fallback inherits `OPENAI_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY`/SDK env (only `ANTHROPIC_API_KEY` deleted) | codex | **GENUINE** | 19·PLAN-001/002 | Centralize PTY-spawn env sanitization across all providers (denylist all known provider key envs); test the actual spawned env for Claude/Codex/Gemini. |
| — | Phase-18 "human PTY bypasses `dailyCostCapGate`" framed as cost-cap-invariant violation | gemini, codex | **OVER-EAGER (core ALREADY-COVERED)** | 18·PLAN-002 | SPEC deliberately exempts human interactive turns from the *halt* (R-PTY-18a); Task 2 keeps the single gate chokepoint and adds `isOverProgrammaticHalt` as a `dispatch_source` **predicate**, default-OFF. Dismissed as a violation. *Optional tightening:* make explicit that all dispatch still **enters** the gate (predicate decides), so global USD visibility isn't lost — but no replan needed. |
| — | Phase-18 leak-detector race / false positive (point-in-time in-flight check vs 5-min poll) | gemini, codex | **ALREADY-COVERED** | 18·PLAN-003 | T-18-04 already mandates "drain WITH legit in-flight automation does NOT false-alert." *Optional:* state the fix mechanism explicitly — correlate delta against `token_usage` ledger for the interval, not live in-flight status. |
| — | Phase-19 missing C4 flag negative test (`-p`/stream-json sneaking onto PTY argv) | gemini | **ALREADY-COVERED by H6/H8** | 19 | Folded into H6/H8 spawn-arg assertions; not a separate item. |
| — | Phase-19 `setup-token` serialization to hub not prohibited | gemini, codex | **GENUINE (small)** → folded | 19 | Add a negative test: `setup-token` stays in supervisor ephemeral memory, never serialized/persisted to hub. (Tracked under Phase-19 checklist.) |
| — | Phase-19 C3 runtime enforcement gap — `PtyRunner.spawn()` should hard-reject `isHuman=false` (defense-in-depth) | gemini | **ALREADY-COVERED by H1** | 19 | The relay-boundary guard (H1) is the primary enforcement; an in-runner `PTY_REJECT_AUTOMATION` assert is a cheap defense-in-depth add, not a separate gap. |
| — | Phase-19 existing Claude-PTY sessions keep taking human turns after a failed June-15 gate | codex | **GENUINE (small)** → folded | 19 | Gate human turns AND creation; on `programmatic` billing result, disable/unlist Claude-PTY backend + alert + operator override. Add to Phase-19 checklist. |
| — | Phase-20 turn-lock locks byte frames not turns (per-frame acquire queues normal mid-line typing) | codex, gemini | **ALREADY-COVERED** | 20 | SPEC defines lock keyed on **observed turn-completion** (transcript `turn_complete`/prompt-ready), not per-byte; release is completion-driven. *Optional:* PLAN must state explicit turn framing (hold from first printable input until Enter; paste/control-key exceptions). |
| — | Phase-20 permission-response lock-bypass too broad (non-holder can inject into stale TUI) | codex, gemini | **ALREADY-COVERED** | 20 | SPEC: a tap injects nothing unless its `(sessionId,requestId)` is still pending/unresolved; bypass is scoped to a currently-pending prompt. *Optional:* PLAN add `{pending,resolved,superseded,expired}` state checked immediately before injection. |
| — | Phase-20 Codex `session_meta` / transcript-id mapping may not exist after the rip | codex | **GENUINE (small)** → folded | 20 | Name the exact DAL/session field or supervisor-registry API the `TranscriptSource` adapter resolves from; test adapter selection from real metadata (depends on H10 identity persistence). |
| H10 | Session/transcript identity unestablished — PTY backend mode + Claude/Codex transcript ids + per-session ownership assumed but never persisted/plumbed | codex | **GENUINE** | 16·PLAN-002 (runner_type) + 17 | `runner_type` persistence is in 16·PLAN-002; **extend** it to also capture+persist the backend transcript path/id at PTY spawn (Phase 16/17) so Phase-20 `TranscriptSource` + H2 ownership can key off real data. |
| — | Phase-15 Tauri updater ABI mismatch (`.node` vs sidecar exe) | gemini | **ALREADY-COVERED** | 15·PLAN-003 | This is exactly the `autonomous:false` compile-derisk checkpoint Phase 15 exists to resolve; record in SPIKE-FINDINGS. No replan. |
| — | Phase-17 premature deletion before surface proven | codex, claude | **ALREADY-COVERED (mechanism gap = H4)** | 17 | T-17-04 gate exists; the only real gap is that it's a note file → see H4. |

Codex's remaining ~30 HIGHs are per-phase restatements of themes H1/H4/H5/H6/H10 or items already
mapped to a plan threat-model + negative test (e.g. unauth attach=T-16-05, automation-drives-PTY=T-16-06,
API-key-creep=T-19-03, fail-closed injection in SPEC). Treated as ALREADY-COVERED duplicates of the
consolidated rows above and not enumerated individually.

---

## Cycle-2 remediation checklist (GENUINE only, grouped by phase)

### Phase 15 — pty-spike-and-compile-derisk
- [ ] **H7** Wire `runner.kill()` to session-closure + WS-disconnect in `supervisor/src/index.ts`; add a parent-PID dead-man's-switch; add an orphan-teardown test. *(also lands in 16·PLAN-001)*
- [ ] **H6** PLAN-002: replace the `node -e`/parametrized test command seam with a mocked `ptySpawn` factory NOT exported to runtime; add a spawn-argv assertion (production runner hardcoded to `claude`, empty Claude argv in PTY mode).
- [ ] **H5** Reconcile 15 PLAN-CHECK/VALIDATION frontmatter; de-dupe duplicated PLAN-CHECK block.

### Phase 16 — hardened-pty-relay-and-mobile-terminal  *(the security seam — most load-bearing)*
- [ ] **H1** Add human-only enforcement at the `term.input` relay boundary: derive actor from hub auth context (cookie⇒human, api_key⇒agent), reject any non-`human_interactive` write before forward; negative test (automation cannot write via relay).
- [ ] **H2** Per-session write authz on `term.attach`/`term.input`: assert `session_id ∈ subscribedSessions` + DB-backed `canWriteTerminal(userId, sessionId)`; extend `term-relay-auth.test.ts` with cross-user hijack cases.
- [ ] **H3** `/ws/agent` side: drop `term.*` for a `session_id` not in that supervisor's advertised inventory; add cross-host injection test.
- [ ] **H6** Add behavioral spawn-interception test (intercept `node-pty.spawn` + tmux builder) asserting exact exe/argv/env from the real instantiation path; provider-key env denylist; no `-p`/`--input-format`/`--output-format`.
- [ ] **H10** Extend `runner_type` persistence (16·PLAN-002) to also capture+persist backend transcript path/id at PTY spawn.
- [ ] **H5** Reconcile 16 PLAN-CHECK/VALIDATION frontmatter; de-dupe.

### Phase 17 — codex-pty-runner-and-chatsurface-rip-and-replace  *(the one-way door)*
- [ ] **H4** Replace the `17-02-PRECHECK.md` note-file gate with a mechanical gate script: assert named Phase-16 PASS artifacts + green guard/relay-auth test markers exist; abort deletion (non-zero exit) if absent; record immutable evidence paths.
- [ ] **H6** Keep/extend a Claude-PTY spawn-argv canary after the new backend branch (binary=`claude`, no programmatic flags); test the **final spawned env** post supervisor/global-config merge for both Claude- and Codex-PtyRunner.
- [ ] **H5** Reconcile 17 PLAN-CHECK/VALIDATION; de-dupe.

### Phase 18 — billing-guardrail-dual-bucket-usage
- [ ] *(make-explicit, optional)* State in PLAN-002 that all dispatch still **enters** `dailyCostCapGate`; `programmatic_halt` is a `dispatch_source` predicate, not a gate bypass (preserves global USD visibility). Core design already correct.
- [ ] *(make-explicit, optional)* PLAN-003: leak-detector correlates usage delta vs `token_usage` ledger for the poll interval, not live in-flight status.
- [ ] **H5** Reconcile 18 PLAN-CHECK/VALIDATION; de-dupe.

### Phase 19 — cutover-gate-and-automation-fallback
- [ ] **H8** Explicit runner IDs `claude-pty`/`codex-pty` on human paths; spawn-arg test rejects programmatic flags.
- [ ] **H9** Centralize PTY-spawn env sanitization across all providers (denylist `OPENAI_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY`/SDK env); test actual spawned env per backend.
- [ ] setup-token negative test (never serialized/persisted to hub).
- [ ] Existing Claude-PTY sessions: gate human turns AND creation; disable/unlist on `programmatic` result + alert + operator override.
- [ ] **H5** Reconcile 19 PLAN-CHECK/VALIDATION; de-dupe.

### Phase 20 — telegram-transcript-tail  *(sequenced strictly after 17)*
- [ ] Codex `session_meta`/transcript-id mapping: name exact DAL/registry field + adapter-selection test (depends on H10).
- [ ] *(make-explicit, optional)* PLAN: explicit turn framing for the lock (printable→Enter; paste/control exceptions) and pending-state `{pending,resolved,superseded,expired}` checked immediately before injection. SPEC already mandates the behavior; PLAN should pin the mechanism.
- [ ] *(make-explicit)* One shared per-session transcript fanout (single tailer) feeding Telegram + permission-detector + turn-lock-release, decoupled from Telegram bridge lifecycle.
- [ ] **H5** Reconcile 20 PLAN-CHECK/VALIDATION; de-dupe.

---

## Per-phase convergence verdict

| Phase | Verdict | Genuine HIGHs (this phase's edits) |
|---|---|---|
| 15 — pty-spike-and-compile-derisk | **NEEDS-REPLAN** | H7 (orphan kill), H6 (spawn-argv test seam), H5 (metadata) |
| 16 — hardened-pty-relay-and-mobile-terminal | **NEEDS-REPLAN** | H1, H2, H3 (relay guard + ownership authz), H6, H10, H5 — **the critical cluster** |
| 17 — codex-pty-runner-rip-and-replace | **NEEDS-REPLAN** | H4 (mechanical one-way-door gate), H6 (post-rip canary), H5 |
| 18 — billing-guardrail-dual-bucket-usage | **CLEAN** (no genuine HIGH; 2 optional make-explicit + H5 hygiene) | — |
| 19 — cutover-gate-and-automation-fallback | **NEEDS-REPLAN** | H8 (explicit pty runner ids), H9 (provider key scrub), setup-token test, post-gate session disable, H5 |
| 20 — telegram-transcript-tail | **NEEDS-REPLAN (light)** | transcript-id mapping (H10-dependent), shared fanout; rest are make-explicit; H5 |

**H5 (metadata reconcile + duplicate PLAN-CHECK removal)** applies to all six phases — a mechanical
hygiene sweep, not a design replan.

---

## Counts (deduped set)

- **Distinct consolidated HIGH concerns:** ~21 (after merging codex's 51 / gemini's 14 / claude's 2).
- **GENUINE:** **9** numbered (H1–H10, with H4 absorbing 17's gate; H6 spanning 4 phases) **+ 3 small folded** (setup-token serialization, post-gate Claude-PTY disable, Codex transcript-id mapping) = **12 actionable plan edits**, concentrated in Phases 16/17/19.
- **ALREADY-COVERED:** ~7 (premature-deletion gate exists, fail-closed injection in SPEC, turn-lock completion-keyed, permission-response scoping, unauth attach=T-16-05, leak-detector no-false-alert intent, updater-ABI = the Phase-15 checkpoint) — make-explicit tightening only, no replan.
- **OVER-EAGER / WRONG:** ~2 (Phase-18 "human PTY cost-cap bypass = invariant violation" contradicts the deliberate human-exempt-from-halt design; Gemini-stub UX / checklist-machine-readability LOW noise) — dismissed; plus the bulk of codex's ~30 per-phase HIGH restatements of themes H1/H4/H5/H6/H10.

**Bottom line:** ship the 12 edits above (real focus = the Phase-16 `term.input` relay guard + ownership
authz, the Phase-17 mechanical gate, the Phase-19 provider scrub + explicit runner ids, and the H5
metadata sweep). Everything else is already in the plans' threat models or contradicts the accepted design.
