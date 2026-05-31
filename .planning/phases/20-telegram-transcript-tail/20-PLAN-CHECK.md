# Phase 20 — Plan Check + Nyquist Verdict

**Checked:** 2026-05-31
**Checker:** orchestrator (gsd-plan-checker / gsd-nyquist-validator subagents unavailable in this
planning-agent context; manual review against the gsd-plan-checker + Nyquist rubric. Caveat: not an
independent subagent verdict — re-run the subagent checkers before execution if available.)

## Requirement coverage (R-TG-01..12)

| Req | Plan(s) | Covered |
|-----|---------|---------|
| R-TG-01 backend-agnostic adapter | 01 | ✅ |
| R-TG-02 Claude adapter | 01 | ✅ |
| R-TG-03 Codex adapter + scrape fallback | 01 | ✅ |
| R-TG-04 output re-sourced | 02 | ✅ |
| R-TG-05 pending detected, (sessionId,requestId) | 03 | ✅ |
| R-TG-06 fail-CLOSED | 03 | ✅ |
| R-TG-07 existing inline UX | 03 | ✅ |
| R-TG-08 keystroke injection (not permission_response) | 03 | ✅ |
| R-TG-09 disambiguation / one-decision / stale-reject | 03 | ✅ |
| R-TG-10 write-arbitration turn lock | 04 | ✅ |
| R-TG-11 human-only guard | 05 | ✅ |
| R-TG-12 explicit break + docs | 05 (+ Phase-17 ROADMAP note) | ✅ |

No orphan requirements; no plan task without a requirement.

## Quality-gate checklist (per workflow step 8 rubric)

- [x] PLAN.md files created in phase dir (5 plans, waves 1-2-2-3-4)
- [x] Each plan has valid YAML frontmatter (wave, depends_on, files_modified, autonomous, requirements, must_haves)
- [x] Every task has `<read_first>` including the file being modified
- [x] Every task has `<acceptance_criteria>` with source/behavior/CLI assertions (no subjective language)
- [x] `<action>` blocks carry concrete identifiers (adapter names, `(sessionId, requestId)` key, `term.input` frame, `selectAdapter(cliKind)`, fixture paths) without full implementations
- [x] Dependencies correct: 01 → {02, 03}; 03 → 04; {02,03,04} → 05
- [x] Waves assigned for ordered execution (1: adapters; 2: output + permission; 3: arbitration; 4: guard+docs)
- [x] must_haves derived from the phase goal + the 5 user decisions
- [x] `<threat_model>` present on every plan (security_enforcement=true); the CRITICAL threat
      (mis-parse→auto-approval, T-20-06) carries 5-layer defense + a NEGATIVE test; HIGH threats
      (cross-session, stale-tap, unauthorized approver, interleave, automation-via-Telegram) each
      mitigated + test-enforced
- [x] Sequencing safeguard respected: Phase 20 depends on Phase 17 (rip first), not before
- [x] Hard constraints carried: no API key (transcript read-only — Telegram NOT on programmatic pool);
      official client only; human-only guard; interactive CLI only
- [x] Supersession of R-PTY-11/R-PTY-24 stated explicitly in REQUIREMENTS + ROADMAP + SPEC (no silent contradiction)

## Nyquist (validation sampling) verdict

VALIDATION.md present with a per-task verification map, sampling rate biased to the load-bearing
security invariants, Wave-0 stubs + shared fixtures, and explicit manual-only gating items (per-backend
keystroke byte capture; live permission round-trip; Codex path/schema re-verification). The CRITICAL
and HIGH invariants are each sampled with a NEGATIVE test (the dangerous path produces nothing), not
just a positive one. Backend-agnosticism is itself sampled across both backends. **Dimension 8: PASS.**

## Risks / decisions still open for the operator

1. **Per-backend keystroke byte sequences (HIGH, gating).** Must be captured from live Claude + Codex
   TUIs (RESEARCH §4). The keystroke-map is provisional until then — `20-PLAN-003` task 3 is
   `autonomous:false` for this reason.
2. **Codex rollout path/format (MED, version-unstable).** Community-reverse-engineered; re-verify on
   the installed Codex version + the Windows sessions-dir path before relying. The scrape fallback is
   the safety net (no permissions surfaced in fallback).
3. **Claude transcript record `type` discriminators (MED).** Treated as unstable; unknown ⇒ skip+log.
   Capture the real discriminators from a live `~/.claude/projects/.../<id>.jsonl` during 20-01.
4. **Turn-complete detection in Codex scrape mode (MED).** Prompt-ready marker reliability affects lock
   release; a safety TTL backstops it.

## Verdict

**PASS — ready to execute, gated on the manual keystroke-byte capture (decision 3, plan 03 task 3) and
the Codex path/schema re-verification (plan 01 task 3).** Coverage complete (R-TG-01..12, no orphans),
threat models present with the CRITICAL auto-approval risk defended in depth and negatively tested,
sequencing-after-17 honored, and the prior-stance supersession made explicit across SPEC + ROADMAP +
REQUIREMENTS. Re-run independent gsd-plan-checker / gsd-nyquist-validator subagents before execution if
available (this verdict was authored manually).

### Cycle-2 addendum (2026-05-31) — H10 (Phase-20 portion) closed

**Re-verdict: PASS (clarified).** SYNTHESIS-cycle1 H10's Phase-20 slice (Codex `session_meta` transcript-id
mapping + the Claude sessionUUID==filename assumption made explicit) is addressed in 20-PLAN-001: `open(ctx)`
now EXPLICITLY carries the transcript-identity inputs (`ctx.sessionId` for Claude's UUID==filename-stem
assumption; `ctx.codexRolloutId` matched against the rollout file's `session_meta` id), both sourced from
the session record PERSISTED at PTY spawn (Phase-16/17, cross-ref H10 persistence which the Phase-16 agent
owns). The absent-id / missing-file path now deterministically DEGRADES to scrape-mode (no newest-file
guess), with a test asserting correct-file-on-id vs scrape-on-absent. New requirement: **R-TG-13**. This
is a light make-explicit edit; the upstream persistence of those ids is a Phase-16 dependency, not changed
here. H5 frontmatter reconciliation left to the H5 sweep agent.
