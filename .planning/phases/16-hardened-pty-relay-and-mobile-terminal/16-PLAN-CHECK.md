# Phase 16 — Plan Check + Nyquist Verdict

**Checked:** 2026-05-31
**Checker:** orchestrator (gsd-plan-checker subagent unavailable in this agent context — Task nesting not available; manual review against the gsd-plan-checker rubric. `workflow.plan_review_convergence` is now enabled in `.planning/config.json`, so a convergence pass should re-run this check when the GSD CLI/subagents are available.)

## Requirement coverage (R-PTY-06..11)

| Req | Covered by | Acceptance is verifiable? |
|-----|-----------|---------------------------|
| R-PTY-06 (claude-pty-runner module, no API key, raw bytes) | 16-PLAN-001 (T1 runner, T3 canary+env) | Yes — extended grep-canary + env unit test + tsc |
| R-PTY-07 (tmux/persistence + reattach, scrollback intact) | 16-PLAN-001 (T2 persistence, T3 reattach test) | Yes — automated ring-buffer replay + manual device reattach |
| R-PTY-08 (authenticated raw-terminal relay, isolated) | 16-PLAN-002 (T1 schema, T2 relay+auth) | Yes — isolation static test + auth/relay integration test |
| R-PTY-09 (mobile reconnect/resize/scrollback) | 16-PLAN-003 (T1 hook, T2 surface) | Yes — buffer-clear test + no-indigo + build + manual device |
| R-PTY-10 (human-only dispatch guard) | 16-PLAN-002 (T4 humanOnlyPtyGate) | Yes — per-automation-source rejection + cost-cap-intact test |
| R-PTY-11 (per-session runner type; Telegram stays stream-json) | 16-PLAN-002 (T3 runner_type + Telegram guard) | Yes — enum + Telegram-default rejection test |

**No orphan requirements. No plan without a requirement.**

## Cycle-2 additions (2026-05-31, SYNTHESIS-cycle1 H1/H2/H3/H7/H10 — the security seam)

| Req | Covered by | Acceptance is verifiable? |
|-----|-----------|---------------------------|
| R-PTY-28 (human-only guard on the term.input RELAY path; server-inferred actor — H1) | 16-PLAN-002 (**reworked T4**: shared humanOnlyPtyGate chokepoint applied to BOTH dispatch pipeline AND relay ingress; actor inferred from connection) | Yes — `term-relay-human-guard.test.ts`: automation/agent term.input rejected on relay; client-asserted `source:"human"` cannot bypass server-inferred actor |
| R-PTY-29 (per-session write authz on term.attach/term.input; no cross-session/cross-user hijack — H2) | 16-PLAN-002 (**reworked T2**: subscribedSessions + DB-backed `canWriteTerminal`) | Yes — `term-relay-auth.test.ts` named cross-session + cross-user hijack cases |
| R-PTY-30 (/ws/agent-side inventory authz for term.* — H3) | 16-PLAN-002 (**reworked T2**: drop term.* for session_id ∉ supervisor's advertised inventory) | Yes — `term-agent-inventory-auth.test.ts` cross-host injection dropped |
| R-PTY-31 (persist runner identity + transcript path/id; resume reads persisted mode — H10) | 16-PLAN-002 (**reworked T3**: nullable backend-identity/transcript-path idempotent columns; resume re-binds) | Yes — `pty-runner-resume-identity.test.ts`: resume reads persisted mode, no dual-spawn, no mis-route |
| R-PTY-27 (orphan PTY teardown; explicit detach-vs-kill policy — H7, Phase-16 portion) | 16-PLAN-001 (T2 acceptance + T-16-04 threat: disconnect DETACHES, close/idle/shutdown KILL; dead-man's-switch) | Yes — no orphan after close/idle/shutdown; survives a mere disconnect |

**Cycle-2 verdict (Phase 16):** the load-bearing security gaps the synthesis flagged are now closed in
the PLAN as concrete tasks with named negative tests and threat IDs (T-16-10..15). Critically, the
human-only guard is no longer confined to `dispatch/pipeline.ts` — it is a SHARED chokepoint that also
gates the raw `term.input` relay with a SERVER-INFERRED actor (H1), and cross-session/cross-user hijack
(H2) + cross-host injection (H3) + dual-spawn/mis-route on resume (H10) each have a named negative test.
**PASS holds** for Phase 16. (H5 frontmatter/VALIDATION reconciliation + the duplicate-PLAN-CHECK de-dupe
are OUT of scope here — owned by the H5 sweep agent.)

## Cycle-3 additions (2026-05-31, FINAL — adjudicated cycle-2 remainder: H11/NH-4 + NH-1/NH-2/NH-3)

| Req | Covered by | Acceptance is verifiable? |
|-----|-----------|---------------------------|
| R-PTY-32 (Phase-16 EMITS the test-bound verdict artifact the Phase-17 gate consumes — H11/NH-4) | 16-PLAN-002 (**new Task 5** + §shared_verdict_artifact_schema single-source contract; `tools/emit-phase16-verdict.mjs` derives PASS from real test exit codes + structured manual-attestation triplets) | Yes — `phase16-verdict-artifact.test.ts`: a script-emitted fully-green artifact passes the real `cutover-deletion-gate.mjs` (exit 0); a forged/provenance-stripped artifact is rejected |
| R-PTY-33 (per-socket terminal-frame DIRECTION allowlist — NH-2) | 16-PLAN-002 (**Task 2**: `term.input` only on /ws/client; /ws/agent output-only `term.data`) | Yes — `term-frame-direction-allowlist.test.ts`: `term.input` on /ws/agent rejected |
| R-PTY-34 (Origin/CSWSH enforcement on /ws/client handshake — NH-3) | 16-PLAN-002 (**Task 2**: handshake Origin ∈ HUB_ALLOWED_ORIGINS) | Yes — `term-ws-origin-guard.test.ts`: disallowed-Origin handshake rejected, allowed proceeds |
| R-PTY-35 (inventory cross-validated against DB host-ownership — NH-1) | 16-PLAN-002 (**Task 2**: cross-validate inventory-claimed session vs DB host-ownership) | Yes — `term-agent-inventory-auth.test.ts` (extended): spoofed inventory entry for a non-owned session dropped |

**Cycle-3 verdict (Phase 16):** the producer side of the Phase-16→Phase-17 verdict contract (H11/NH-4) is
now a concrete Phase-16 task emitting the artifact from REAL test output with a single shared schema both
sides reference; the three WS-seam surfaces the cycle-2 relay guard introduced (NH-1 inventory self-assertion,
NH-2 frame-direction, NH-3 CSWSH/Origin) are each closed in 16-PLAN-002 Task 2 with named negative tests.
**PASS holds** for Phase 16. (H5 reconciliation still excluded — owned by the H5 sweep agent; SPEC/ROADMAP
untouched.)

## Quality-gate checklist (per workflow step 8 rubric)

- [x] PLAN.md files created in phase dir (3 plans, waves 1-2-3)
- [x] Each plan has valid YAML frontmatter (wave, depends_on, files_modified, autonomous, requirements, must_haves)
- [x] Every task has `<read_first>` including the file being modified
- [x] Every task has `<acceptance_criteria>` with source/behavior/CLI assertions (no subjective language)
- [x] `<action>` blocks carry concrete identifiers (exact argv tokens, `delete (env as any).ANTHROPIC_API_KEY`, frame kinds `term.*`, `ADD COLUMN IF NOT EXISTS runner_type`, gate name) without full implementations
- [x] Dependencies correct: 01 → (02 ∥ depends on 01) → 03 (depends on 01+02): runner+persistence → relay+guard+runner_type → mobile surface
- [x] Waves assigned for ordered execution
- [x] must_haves derived from the phase goal
- [x] `<threat_model>` present on every plan (security_enforcement=true); HIGH threats (programmatic-flag leak, API-key, OAuth reuse, unauth attach, automation-drives-PTY, cost-cap bypass) each mitigated + test-enforced
- [x] Cross-cutting invariants honored: cost-cap non-bypassable (humanOnlyPtyGate composes WITH dailyCostCapGate); schema.sql idempotent DDL only (runner_type `ADD COLUMN IF NOT EXISTS`, no backfill); raw-terminal channel isolated from agent-protocol; no deletion this phase (sequencing safeguard)

## Nyquist (validation sampling) verdict

VALIDATION.md present with a per-task verification map, sampling rate, Wave-0 stubs, and manual-only
verifications. The load-bearing risks (runner-correctness, disconnect persistence, channel isolation,
auth, human-only guard, mobile UX) each have a sampling mechanism. The disconnect→reattach proof on the
Windows dev host (tmux unavailable) and the human-only guard are correctly flagged as the gating
verifications. **Dimension 8: PASS.**

## Risks / decisions still open for the operator

1. **Windows persistence mechanism (16-01 T2, autonomous:false).** tmux is not native on the Windows dev
   host. The plan defaults to supervisor-owned persistent PTY + output ring-buffer as the cross-platform
   baseline, with tmux on POSIX for survival across supervisor restarts. Operator confirms the Windows
   mechanism before sign-off — it determines reattach UX on the primary dev host.
2. **node-pty compile-shipping contract** is inherited from Phase-15 SPIKE-FINDINGS; this phase consumes
   it. If Phase 15 chose approach (b)/(c) (helper-exe / out-of-band), the runner's load path follows that.
3. **runner_type rollout** is opt-in and default `stream-json`; no behavior changes for existing sessions.
   The Telegram-default guard is interim — Phase 20 supersedes it (moves Telegram onto the PTY surface).
4. **June-15 billing classification** is OUT of Phase 16 acceptance — it gates the Phase 19 default-on
   cutover, not this relay.

## Verdict

**PASS — ready for `/gsd:execute-phase 16`.** All six requirements covered with verifiable acceptance
criteria, security threat models on every plan (constraint-3 human-only guard and unauth-attach treated as
HIGH boundaries), cost-cap and schema-idempotency invariants honored, and a Nyquist-compliant validation
strategy. The genuine risks (Windows persistence, node-pty shipping) are isolated into early tasks with
explicit operator checkpoints. No deletion occurs here — the sequencing safeguard holds.
