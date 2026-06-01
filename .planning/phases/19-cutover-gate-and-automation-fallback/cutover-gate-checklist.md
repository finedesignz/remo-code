# June-15 Cutover Gate — Checklist Artifact

Machine-/human-checkable companion to `docs/cutover-gate-june15.md`. One row per SPEC check.
Fill the **Result** column post-June-15 on a live account using the Phase-18 dual-bucket poll
(`subscription_usage` snapshot before/after one controlled interactive PTY turn).

Result values: `interactive` | `programmatic` | `unknown` (unmeasured).

## Billing-classification checks (R-PTY-21)

| # | Check | Auth | Measurement (snapshot → turn → snapshot → diff) | Result | Recorded by | Date (ISO-8601) |
|---|-------|------|--------------------------------------------------|--------|-------------|-----------------|
| 1 | Interactive `claude` PTY turn → which bucket bills | login | dual-bucket poll diff | unknown | | |
| 2a | setup-token vs login — `login` path | login | dual-bucket poll diff | unknown | | |
| 2b | setup-token vs login — `setup-token` path (SUSPECT) | setup-token | dual-bucket poll diff | unknown | | |
| 3 | Subagents / hooks / MCP inside an interactive session → bucket attribution | login | dual-bucket poll diff | unknown | | |
| 4 | Login-credential headless reclassification — **ONGOING WATCH (not one-time)** | login | dual-bucket poll diff, re-run on each provider-policy change | unknown | | |

## Decision (R-PTY-22 — gated flip)

Apply the rule from `docs/cutover-gate-june15.md`:

- check 1 = `interactive` ⇒ `default_human_backend = 'claude'` (`claude_interactive_confirmed = true`)
- check 1 = `programmatic` ⇒ `default_human_backend = 'codex'` (fail-safe stays)
- check 1 = `unknown` ⇒ FAIL-SAFE: default = `codex-pty`; Claude-PTY NOT default.

| Field | Value | Recorded by | Date |
|-------|-------|-------------|------|
| `claude_interactive_confirmed` | (unset → fail-safe) | | |
| `default_human_backend` | `codex` (fail-safe default until measured) | | |

## Deletion gate (Phase-17 ChatSurface rip — `tools/cutover-deletion-gate.mjs`)

Independent of the billing measurement. Open only after the two on-device attestations are recorded
in `16-VERIFICATION.md` (render_fidelity + mobile_reattach triplets) and the verdict flips to PASS.

| Item | Status | Notes |
|------|--------|-------|
| `node tools/cutover-deletion-gate.mjs` exits 0 | BLOCKED | render_fidelity/mobile_reattach FAIL; attestation triplets empty |
| render_fidelity on-device attestation (R-PTY-07) | PENDING | requires `by` + `at` + `device_build` |
| mobile_reattach on-device attestation (R-PTY-09) | PENDING | requires `by` + `at` + `device_build` |

> Cutover (flip + deletion) remains `deferred:blocked-on-manual-gate` for Phase 19.
