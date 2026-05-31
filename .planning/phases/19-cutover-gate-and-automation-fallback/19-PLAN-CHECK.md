# Phase 19 — Plan Check + Nyquist Verdict

**Checked:** 2026-05-31
**Checker:** orchestrator (gsd-plan-checker / gsd-nyquist-validator subagents unavailable in this
planning-agent context — no Task nesting. Manual review against the gsd-plan-checker + Nyquist rubric.
CAVEAT: not an independent subagent verdict — re-run the subagent checkers before execution if
available.)

## Requirement coverage (R-PTY-21..25)

| Req | Plan(s) | Covered |
|-----|---------|---------|
| R-PTY-21 June-15 cutover-gate runbook (not a build blocker) | 01 | ✅ |
| R-PTY-22 interactive-bucket confirmation flips default-on (fail-safe) | 02 | ✅ |
| R-PTY-23 if-PTY-fails fallback to Codex / future-Gemini seam (no API key) | 03 | ✅ |
| R-PTY-24 Telegram-on-programmatic-pool — SUPERSEDED, documented | 04 | ✅ (superseded by R-TG-01..12) |
| R-PTY-25 final docs sweep | 04 | ✅ |

No orphan requirements; no plan task without a requirement.

## Quality-gate checklist (per workflow step 8 rubric)

- [x] PLAN.md files created in phase dir (4 plans, waves 1-2-2-3)
- [x] Each plan has valid YAML frontmatter (wave, depends_on, files_modified, autonomous, requirements, must_haves)
- [x] Every task has `<read_first>` including the file being modified
- [x] Every task has `<acceptance_criteria>` with source/behavior/CLI assertions (no subjective language)
- [x] `<action>` blocks carry concrete identifiers (`resolveHumanBackend`, `default_human_backend`, `claude_interactive_confirmed`, `gemini-pty-runner.ts`, `docs/cutover-gate-june15.md`) without full implementations
- [x] Dependencies correct: 01 → 02 → 03; {01,02,03} → 04
- [x] Waves assigned (1: runbook; 2: selector + fallback; 3: docs)
- [x] must_haves derived from the phase goal + R-PTY-21..25
- [x] `<threat_model>` present on every plan (security_enforcement=true); the CRITICAL threats
      (silent programmatic-billed default T-19-02; API-key fallback creep T-19-03) each carry a NEGATIVE
      test (the dangerous path produces nothing)
- [x] Sequencing safeguard respected: gate is NOT a build blocker; only the default-on flip is gated;
      depends on Phase 17 (Codex runner) + Phase 18 (dual-bucket poll)
- [x] Hard constraints carried: no API key (negatively guarded across all runner paths); official client
      only; only human turns on the PTY (selector governs human sessions only); setup-token treated as
      suspect (gate check 2)
- [x] R-PTY-24 supersession stated explicitly + consistency-tested (no silent contradiction with Phase 20)
- [x] Provider facts (Codex subscription inclusion; Gemini June-18 sunset; Grok immaturity) re-verified
      via web search this planning pass and flagged fast-moving / re-verify-at-execution in RESEARCH

## Nyquist (validation sampling) verdict

VALIDATION.md present with a per-task verification map, sampling biased to the load-bearing security
invariants (no-API-key across fallback paths; fail-safe default ≠ Claude-PTY until gate-confirmed),
Wave-0 stubs, and explicit manual-only gating items (the four June-15 billing-classification checks on
a live account; the default-on flip; provider-fact re-verification). The CRITICAL invariants are sampled
with NEGATIVE tests, not just positive ones. The billing measurement itself is correctly scoped as an
operator-recorded manual step (too consequential to auto-assert). **Dimension 8: PASS.**

## Risks / decisions still open for the operator

1. **The four June-15 billing-classification results (HIGH, gating).** Whether PTY-interactive `claude`
   bills interactive or programmatic is unknown until measured on a live post-June-15 account (gate
   check 1) — it sets the default backend. `19-PLAN-001`/`19-PLAN-002` are `autonomous:false` for this.
2. **Provider-fact volatility (HIGH).** Codex subscription-inclusion, the Gemini June-18-2026 sunset +
   Antigravity weekly quotas, and Grok immaturity are all secondary-sourced + fast-moving. Confirmed via
   web search 2026-05-31, but MUST be re-verified at execution time. The Gemini seam is deliberately a
   stub (not a working backend) for exactly this reason.
3. **setup-token classification (MED).** May carry a programmatic classification; gate check 2 decides
   whether it stays a remote-auth fallback. `login` is the default until then.
4. **Selector config location (LOW).** Supervisor config vs hub user-setting — discretion; the gate flag
   must be operator-set, never auto-flipped (tested).

## Verdict

**PASS — ready to execute, gated on the manual June-15 billing-classification measurement (19-PLAN-001
runbook → 19-PLAN-002 default-on flip) which can only complete on a live post-June-15 account, and on
re-verifying the fast-moving provider facts at execution time.** Coverage complete (R-PTY-21..25, no
orphans; R-PTY-24 explicitly superseded), threat models present with the silent-programmatic-default +
API-key-fallback risks each negatively tested, the gate correctly scoped as a default-backend gate (not
a build/rip blocker), and the no-API-key invariant guarded across every runner path. Re-run independent
gsd-plan-checker / gsd-nyquist-validator subagents before execution if available (this verdict was
authored manually — no Task nesting in the planning-agent context).
