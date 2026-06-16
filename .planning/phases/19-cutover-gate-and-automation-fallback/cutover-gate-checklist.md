# June-15 Cutover Gate — Checklist Artifact

Machine-/human-checkable companion to `docs/cutover-gate-june15.md`. One row per SPEC check.
Fill the **Result** column post-June-15 on a live account using the Phase-18 dual-bucket poll
(`subscription_usage` snapshot before/after one controlled interactive PTY turn).

Result values: `interactive` | `programmatic` | `unknown` (unmeasured) | `deferred` (measurement
intentionally not run — see regime update below).

> ## 2026-06-15 REGIME UPDATE — the billing cutover this gate guards was POSTPONED by Anthropic
>
> On 2026-06-15 Anthropic announced it is **not** making the previously-scheduled change that would
> move Agent SDK / `claude -p` / third-party-app usage off subscription rate limits onto a dedicated
> monthly credit pool. Their notice: *"Nothing changes for now. Agent SDK, claude -p, and third-party
> app usage continues to work with your subscription exactly as it did before today, and there's no
> credit to claim. Your subscription limits are unchanged."*
>
> **Consequence for this gate:** the billing-exposure premise — "an interactive `claude` PTY turn might
> land in the new *programmatic credit pool* instead of the interactive subscription buckets" — does
> **not** exist under the current (unchanged) billing regime. There is no separate programmatic pool to
> mis-bill into; all `claude` usage bills the subscription as before. The live Claude-PTY default
> (operator override since 2026-06-04) is therefore **billing-safe today**.
>
> The controlled before/after measurement (checks 1–3) is consequently recorded `deferred`, NOT run.
> It is **not abandoned** — it becomes the action triggered by **check 4 (ONGOING WATCH)**: re-run the
> dual-bucket diff *before* whatever future date Anthropic reschedules the programmatic-billing split.
> Until then, fail-safe-to-codex is unnecessary on billing grounds.

## Billing-classification checks (R-PTY-21)

| # | Check | Auth | Measurement (snapshot → turn → snapshot → diff) | Result | Recorded by | Date (ISO-8601) |
|---|-------|------|--------------------------------------------------|--------|-------------|-----------------|
| 1 | Interactive `claude` PTY turn → which bucket bills | login | dual-bucket poll diff | deferred (no programmatic pool in current regime — cutover postponed) | Michael (via Claude) | 2026-06-15 |
| 2a | setup-token vs login — `login` path | login | dual-bucket poll diff | deferred (regime postponed) | Michael (via Claude) | 2026-06-15 |
| 2b | setup-token vs login — `setup-token` path (SUSPECT) | setup-token | dual-bucket poll diff | deferred (regime postponed) | Michael (via Claude) | 2026-06-15 |
| 3 | Subagents / hooks / MCP inside an interactive session → bucket attribution | login | dual-bucket poll diff | deferred (regime postponed) | Michael (via Claude) | 2026-06-15 |
| 4 | Login-credential headless reclassification — **ONGOING WATCH (not one-time)** | login | dual-bucket poll diff, re-run on each provider-policy change | OPEN — re-run before Anthropic's rescheduled SDK/-p billing split | Michael (via Claude) | 2026-06-15 |

## Decision (R-PTY-22 — gated flip)

Apply the rule from `docs/cutover-gate-june15.md`:

- check 1 = `interactive` ⇒ `default_human_backend = 'claude'` (`claude_interactive_confirmed = true`)
- check 1 = `programmatic` ⇒ `default_human_backend = 'codex'` (fail-safe stays)
- check 1 = `unknown` ⇒ FAIL-SAFE: default = `codex-pty`; Claude-PTY NOT default.

> **2026-06-15 decision (regime-driven, not controlled-diff-driven):** with the programmatic-billing
> cutover postponed (above), an interactive `claude` PTY turn bills the subscription as before — the
> `programmatic` outcome the fail-safe protects against is not reachable in the current regime. The
> live operator override (Claude-PTY default since 2026-06-04) is recorded **justified**. This is
> reversible by config (`backend-selector.ts`) and is re-opened by check 4 the moment Anthropic
> reschedules the split.

| Field | Value | Recorded by | Date |
|-------|-------|-------------|------|
| `claude_interactive_confirmed` | `true` (operator override; justified by 2026-06-15 postponement) | Michael (via Claude) | 2026-06-15 |
| `default_human_backend` | `claude` (→ `claude-pty`; billing-safe under unchanged subscription regime) | Michael (via Claude) | 2026-06-15 |

## Deletion gate (Phase-17 ChatSurface rip — `tools/cutover-deletion-gate.mjs`)

Independent of the billing measurement. Open only after the two on-device attestations are recorded
in `16-VERIFICATION.md` (render_fidelity + mobile_reattach triplets) and the verdict flips to PASS.

| Item | Status | Notes |
|------|--------|-------|
| `node tools/cutover-deletion-gate.mjs` exits 0 | BLOCKED | render_fidelity/mobile_reattach FAIL; attestation triplets empty |
| render_fidelity on-device attestation (R-PTY-07) | PENDING | requires `by` + `at` + `device_build` |
| mobile_reattach on-device attestation (R-PTY-09) | PENDING | requires `by` + `at` + `device_build` |

> Cutover (flip + deletion) remains `deferred:blocked-on-manual-gate` for Phase 19.
