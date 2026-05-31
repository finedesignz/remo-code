---
phase: 19-cutover-gate-and-automation-fallback
plan: 04
type: execute
wave: 3
depends_on:
  - 19-01
  - 19-02
  - 19-03
files_modified:
  - README.md
  - CLAUDE.md
  - docs/usage-cost.md
  - docs/cutover-gate-june15.md
  - hub/test/docs-supersession.test.ts
autonomous: true
requirements:
  - R-PTY-24
  - R-PTY-25
must_haves:
  truths:
    - "R-PTY-24 ('Telegram stays on the stream-json programmatic pool by structural necessity') is documented as SUPERSEDED by R-TG-01..12 — Phase 20 sources Telegram from the transcript (read-only over the human's interactive session), so Telegram does NOT consume the programmatic pool; not worked around with an API key"
    - "README / CLAUDE.md / docs document the terminal surface, dual-bucket usage, the cutover gate, the rip-and-replace, the backend selector + fallback, and the no-API-key invariant"
    - "Docs are consistent across SPEC + ROADMAP + REQUIREMENTS (no silent contradiction)"
  artifacts:
    - path: "docs/usage-cost.md"
      provides: "dual-bucket + cutover-gate + supersession note"
  key_links:
    - from: "R-PTY-24 supersession note"
      to: "R-TG-01..12 (Phase 20 transcript-tail)"
      via: "consistent statement across SPEC + ROADMAP + REQUIREMENTS + docs"
      pattern: "Telegram = read-only transcript observer, NOT on programmatic pool"
---

<objective>
Final docs sweep: pin the supersession of R-PTY-24 (Telegram NOT on the programmatic pool — Phase 20)
and document the whole terminal-surface / dual-bucket / cutover-gate / fallback / no-API-key story
across README + CLAUDE.md + docs, with no cross-document contradiction.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/19-cutover-gate-and-automation-fallback/19-CONTEXT.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@README.md
@CLAUDE.md
@docs/usage-cost.md
</context>

<threat_model>
- **T-19-05 — Silent contradiction between R-PTY-24 and Phase 20 (MED).** Leaving R-PTY-24's
  "Telegram-stays-programmatic" stance un-superseded contradicts Phase 20 (Telegram read-only from the
  transcript, NOT on the programmatic pool), confusing future executors. Mitigation: an explicit
  supersession note in SPEC/ROADMAP/REQUIREMENTS/docs; a test asserts the supersession marker is present
  and consistent. Block on: MED.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Docs sweep — terminal surface, dual-bucket, gate, rip, fallback, no-API-key</name>
  <files>README.md, CLAUDE.md, docs/usage-cost.md, docs/cutover-gate-june15.md</files>
  <read_first>
    - README.md, CLAUDE.md (existing architecture + cross-cutting invariants sections)
    - docs/usage-cost.md (the dual-bucket section added in Phase 18)
  </read_first>
  <acceptance_criteria>
    - README + CLAUDE.md describe: the universal PTY terminal surface (rip-and-replace), dual-bucket usage (interactive vs programmatic), the June-15 cutover gate, the default-backend selector + Codex/Gemini-stub fallback, and the no-API-key invariant
    - docs/cutover-gate-june15.md (from 19-01) is linked from the docs map
    - No drift: doc references match the real selector key, the dual-bucket WS shape, and the gate runbook
    - `bun run docs:sync` run if any endpoint changed (likely none — selector/gate are internal)
  </acceptance_criteria>
  <action>
    Update the docs concisely; reuse existing section structure. Keep wording consistent with the SPEC.
  </action>
  <verify>
    <automated>cd hub; bun run check-baseline 2>$null</automated>
  </verify>
  <done>The terminal-surface story is documented end to end with no drift.</done>
</task>

<task type="auto">
  <name>Task 2: R-PTY-24 supersession note + consistency test</name>
  <files>docs/usage-cost.md, hub/test/docs-supersession.test.ts</files>
  <read_first>
    - .planning/REQUIREMENTS.md (the existing R-PTY-24 + the R-TG supersession note)
    - .planning/architecture/interactive-pty-runner-SPEC.md (Phase 20 Telegram section)
  </read_first>
  <acceptance_criteria>
    - A clear note states R-PTY-24 is SUPERSEDED by R-TG-01..12: Telegram is a read-only transcript observer over the human's interactive session and does NOT consume the programmatic pool; never worked around with an API key
    - A test asserts the supersession marker exists in REQUIREMENTS + docs and that no doc still claims "Telegram stays on the programmatic pool by structural necessity" without the superseded caveat
  </acceptance_criteria>
  <action>
    Add the note; author the consistency test (string presence/absence across the relevant files).
  </action>
  <verify>
    <automated>cd hub; bun test test/docs-supersession.test.ts 2>$null</automated>
  </verify>
  <done>The Telegram billing stance is consistent across all planning + docs surfaces.</done>
</task>

</tasks>

<verification>
- README + CLAUDE.md + docs cover surface/dual-bucket/gate/rip/fallback/no-API-key
- R-PTY-24 marked superseded consistently; no un-caveated contradiction remains
- `bun run docs:sync` clean (no drift); `bun run check-baseline` green
</verification>

<success_criteria>
The full milestone is documented coherently, the no-API-key invariant is stated, and the R-PTY-24 /
Phase-20 Telegram supersession is consistent across SPEC, ROADMAP, REQUIREMENTS, and docs.
</success_criteria>

<output>
Create `.planning/phases/19-cutover-gate-and-automation-fallback/19-04-SUMMARY.md`.
</output>
