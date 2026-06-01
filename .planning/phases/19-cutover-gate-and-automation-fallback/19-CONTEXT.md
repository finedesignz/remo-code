# Phase 19: cutover-gate-and-automation-fallback - Context

Encode the SPEC's "Verify after June 15" checks as an explicit, documented cutover GATE (a runbook + a
measurement procedure that consumes the Phase-18 dual-bucket poll), and wire the "If PTY fails" backend
fallback. The verification GATES THE DEFAULT BACKEND, not the rip: if Claude-via-PTY bills the
interactive bucket → Claude stays the default human backend; if it bills programmatic → the default
human backend becomes Codex. Automation stays on the programmatic/stream-json path behind the cost cap
(or moves to Codex). **No API key, ever.**

## Phase Boundary

**In scope.**
- A documented cutover-gate RUNBOOK (`docs/` + a checklist artifact) encoding the four SPEC checks:
  (1) which bucket a PTY interactive `claude` turn bills, (2) `setup-token` vs `login` classification,
  (3) subagents/hooks/MCP-inside-an-interactive-session bucket attribution, (4) login-credential
  headless-reclassification risk.
- A measurement PROCEDURE that uses the Phase-18 dual-bucket poll to read which bucket moved after a
  controlled turn (a before/after snapshot diff), so the gate decision is data-driven, not guessed.
- A default-backend SELECTOR wired so the green-light only flips the PTY runner default-on for human
  sessions after the interactive-bucket result is confirmed (a config flag / decision record, not an
  auto-flip).
- The "If PTY fails" fallback SEAM: route the human-coding UX to the existing Codex PTY runner
  (Phase 17) as the primary fallback; add a stubbed/optional FUTURE Gemini runner seam (interface only,
  not a working Gemini integration). No API-key path anywhere.
- Final docs sweep: README / CLAUDE.md / `docs/` describe the terminal surface, dual-bucket usage, the
  cutover gate, the rip-and-replace, and the no-API-key invariant. `bun run docs:sync` if endpoints
  changed.

**Out of scope.**
- The dual-bucket poll itself (Phase 18 builds it; Phase 19 only consumes it in the measurement).
- A working Gemini integration (only a stubbed seam — Gemini is NOT a reliable backend, see RESEARCH).
- Any Grok integration (too immature).
- The rip (Phase 17) and the PTY surface (15–16).
- Any API-key fallback (forbidden, all phases).
- Telegram routing — superseded: Phase 20 sources Telegram from the transcript (read-only over the
  human's interactive session), so Telegram does NOT consume the programmatic pool. R-PTY-24 is treated
  as SUPERSEDED by R-TG-01..12 (state it explicitly; do not silently contradict).

## Sequencing (HARD)

- **Depends on Phase 17 AND Phase 18.** Phase 17 produces the PTY surface + Codex PTY runner (the
  fallback target); Phase 18 produces the dual-bucket poll (the measurement instrument). The gate
  measurement cannot run without both.
- **The gate is NOT a build blocker.** Phases 15–18 are buildable + shippable BEFORE June 15. Only the
  DEFAULT-ON flip for human PTY sessions is gated on the June-15 measurement (R-PTY-21/22). The runbook
  is authored now; the measurement is executed after June 15 on a live account.
- The default-backend decision is a one-way-ish operational choice but reversible by config; record it.

## Implementation Decisions (LOCKED — from spec + roadmap)

### Cutover-gate runbook = measurement, not a build blocker (R-PTY-21)
- A `docs/` runbook + a machine-checkable checklist artifact encoding the four SPEC checks.
- The measurement uses a controlled procedure: snapshot the dual buckets (Phase 18) → run ONE
  interactive PTY `claude` turn → snapshot again → diff which bucket moved. Repeated for the four
  variants (interactive vs setup-token; with/without subagents/hooks/MCP).
- The runbook is authored in this phase; the measurement is run on a live post-June-15 account (an
  `autonomous:false` operator step — the gate output is human-recorded, not auto-asserted).

### Interactive-bucket confirmation flips default-on (R-PTY-22)
- A default-backend selector config (e.g. a `default_human_backend: 'claude' | 'codex'` setting, exact
  key = discretion) governs which runner a NEW human session uses.
- Flip to Claude-PTY-default-on ONLY after the measurement confirms interactive billing. If
  Claude-via-PTY bills programmatic, the selector defaults to Codex. The flip is a recorded config
  change gated on the runbook result — NOT an automatic behavior.
- A guard test asserts the selector exists and that, absent a confirmed-interactive result, the default
  is NOT Claude-PTY (fail-safe: do not default users onto a programmatic-billed path silently).

### "If PTY fails" fallback to Codex / future-Gemini seam (R-PTY-23)
- Codex is the PRIMARY fallback: the existing Codex PTY runner (Phase 17) is wired as a selectable human
  backend through the SAME terminal surface (backend-agnostic). OpenAI's ChatGPT subscription INCLUDES
  Codex usage under plan limits (no separate penalized credit pool by default — see RESEARCH), so Codex
  is more permissive than Claude post-June-15.
- A FUTURE Gemini runner seam: an interface/stub only (e.g. `gemini-pty-runner.ts` that throws
  "not implemented" / is feature-flagged off). Gemini is NOT a reliable fallback (CLI + Code Assist
  individual/Pro/Ultra tiers reportedly stop serving June 18 2026 → Antigravity CLI with tighter weekly
  quotas — see RESEARCH). The seam exists so a future viable backend slots in; it is not a working path.
- Grok is explicitly NOT wired (too immature).
- HARD: NO code path falls back to `ANTHROPIC_API_KEY` / API-platform billing. The fallback is a
  backend-CLI swap on the same PTY surface, never the API.

### Telegram supersession (documented, R-PTY-24 superseded)
- State explicitly in docs + the supersession note: R-PTY-24's "Telegram stays on the stream-json
  programmatic pool by structural necessity" NO LONGER holds — Phase 20 sources Telegram from the
  transcript (read-only over the human's interactive session), so Telegram does NOT consume the
  programmatic pool. Treat R-PTY-24 as superseded by R-TG-01..12. Do not work around with an API key.

### Final docs sweep (R-PTY-25)
- README / CLAUDE.md / `docs/` document the terminal surface, dual-bucket usage, the cutover gate, the
  rip-and-replace, the no-API-key invariant, and the backend-selector + fallback. `bun run docs:sync`
  if any endpoint changed.

### Constraints carried (spec §Hard constraints)
- No `ANTHROPIC_API_KEY` ever; no API-key fallback (the fallback is a backend swap).
- Official client only; never reuse/extract the OAuth token.
- Only genuine human turns touch the PTY (the selector governs human sessions only; automation stays on
  the programmatic path).
- Interactive CLI only for human sessions (no `-p`, no stream-json).
- `setup-token` is suspect (may carry programmatic classification) — used only when a host can't be
  touched locally, and only after its billing classification is verified (check 2). `login` is the
  default interactive OAuth.
- QC gate: `bun run check-baseline`.

### Claude's Discretion
- Exact selector config key + storage; the runbook checklist file format (Markdown table vs YAML); the
  Gemini seam's exact shape (stub class vs interface + factory); whether the measurement diff helper is
  a small script in `hub/scripts/` or a documented manual procedure.

## Canonical References

### Source spec (authoritative)
- `.planning/architecture/interactive-pty-runner-SPEC.md` §"Verify after June 15", §"If PTY fails",
  §"Sequencing safeguard", §"Hard constraints".

### Phase-18 measurement instrument (consume — do not rebuild)
- `supervisor/src/usage/oauth-poll.ts` (dual-bucket poll), `hub/src/usage/store.ts` (snapshot),
  `subscription_usage` WS path — the before/after bucket diff source.

### Phase-17 fallback target (wire — already present)
- `supervisor/src/runners/codex-pty-runner.ts` (Codex on the terminal surface), the backend-agnostic
  runner selection (`cliKind`), `supervisor/src/runners/types.ts`.

### Backend selector + runner registry
- `supervisor/src/runners/*` runner registry; the human-session backend choice.

### Cross-cutting invariants
- CLAUDE.md §"Cross-cutting invariants": cost cap non-bypassable; OAuth token never serialized; docs
  updated in the same commit as behavior changes; `/openapi.json` + `/docs` contract (docs-drift CI).

## Specific Ideas
- The gate is "measure, then decide" — the dual-bucket poll already gives the before/after evidence, so
  the runbook is mostly a recording procedure + a config flip, not new infrastructure.
- The backend-agnostic terminal surface (Phase 15–17) means the fallback is a one-line backend swap;
  the Gemini seam proves the abstraction holds for a third backend without committing to Gemini.

## Deferred Ideas
- A working Gemini (Antigravity CLI) backend once its quotas/tiers settle — re-verify post-June-18-2026.
- A Grok Build CLI backend once it leaves beta + pricing settles.
- Auto-measuring the gate (an automated before/after diff that flips the selector) — deferred; the
  billing classification is too consequential to auto-flip; keep it operator-recorded.

---
Status: ready for planning.
