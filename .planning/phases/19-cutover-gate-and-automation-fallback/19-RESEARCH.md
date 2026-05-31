# Phase 19: cutover-gate-and-automation-fallback - Research

## Summary

This phase decides the DEFAULT human backend based on a post-June-15 billing measurement, and wires the
"If PTY fails" fallback. The provider landscape (all fast-moving, secondary-sourced — re-verify before
relying):
- **Claude:** interactive Claude Code in a terminal stays on the subscription pool; programmatic
  (`claude -p`/Agent SDK/headless) moves to the separate credit pool June 15 2026. The OPEN question the
  gate answers is whether a PTY-wrapped interactive `claude` is classified interactive (expected) or
  programmatic (the risk that flips the default to Codex).
- **Codex (primary fallback):** ChatGPT Plus/Pro/Business/Enterprise/Edu subscriptions INCLUDE Codex
  usage (CLI/web/IDE/app) under plan limits via ChatGPT sign-in; purchasable extra credits on overage;
  no separate penalized credit pool by default. API-key sign-in is the separate usage-based path (which
  we never use). More permissive than Claude post-June-15. Already wired as a runner.
- **Gemini (NOT reliable):** Gemini CLI + Code Assist stop serving the individual / Google AI Pro /
  Google AI Ultra tiers starting June 18 2026, migrating to Antigravity CLI with tighter WEEKLY quotas
  (users report exhausting the weekly quota in a few thousand lines). Don't bet on it without
  re-verifying — stub seam only.
- **Grok (too immature):** Grok Build CLI early beta (~May 2026), no free tier, unsettled pricing.
  Not wired.

## Key findings

### 1. The four June-15 verification checks (R-PTY-21) — the gate content
From SPEC §"Verify after June 15":
1. **PTY interactive `claude` → which bucket?** Run a turn, watch the dual-bucket poll. Interactive →
   Claude stays default. Programmatic → default becomes Codex. THIS is the load-bearing check.
2. **`setup-token` vs `login` classification.** Test side by side. Hypothesis: `setup-token` may carry
   an SDK/programmatic classification. `login` (interactive OAuth, localhost redirect) is the default;
   `setup-token` is the only remote-auth path and is used only when a host can't be touched locally AND
   only after this classification is verified.
3. **Subagents / hooks / MCP inside an interactive session → which bucket?** Plausibly interactive (the
   main `claude` spawns Task subagents in-process under the same session/OAuth). Measure the residual.
4. **login-credential headless reclassification risk.** Watch for Anthropic moving to credential-based
   classification or rejecting headless use of `login` credentials. This is a MONITORING item, not a
   one-time measurement — note it as an ongoing risk in the runbook.

Measurement method: the Phase-18 dual-bucket poll gives a before/after snapshot; the gate procedure is
snapshot → controlled turn → snapshot → diff which bucket's used value moved. Operator-recorded
(`autonomous:false`), because the billing classification is too consequential to auto-assert.

### 2. Codex billing (R-PTY-23 primary fallback) — CONFIDENCE: HIGH
- ChatGPT subscription (Plus/Pro/Business/Enterprise/Edu) includes Codex usage across CLI/web/IDE/app
  under plan limits via ChatGPT sign-in; overage = purchasable credits, NOT a separate penalized pool.
- API-key sign-in is the distinct usage-based OpenAI Platform billing path — we NEVER use it (no API
  key, all phases). The Codex fallback uses ChatGPT-subscription sign-in only.
- No standalone Codex subscription; bundled into ChatGPT plans. So Codex on the subscription is the more
  permissive default if Claude-via-PTY turns out programmatic.
- Re-verify: plan multipliers + credit-overage mechanics change frequently (e.g. a "2x through May 31
  2026" promo was reported); the runbook treats Codex limits as plan-dependent + time-varying.

### 3. Gemini (R-PTY-23 stub seam only) — CONFIDENCE: HIGH (sunset), do-not-rely
- Gemini Code Assist IDE extensions + Gemini CLI STOP serving Gemini Code Assist for individuals,
  Google AI Pro, and Google AI Ultra starting June 18 2026 → migrate to Antigravity + Antigravity CLI.
- Antigravity CLI quota refreshes WEEKLY (down from Gemini CLI's ~1,000-request daily free tier); users
  report exhausting it within a few thousand lines of generated code. Pro/Ultra get higher daily limits
  for Antigravity.
- Conclusion: Gemini is NOT a reliable fallback for a remote-coding workflow. Build only a stubbed seam
  (interface + a runner that is feature-flagged off / throws not-implemented) so a future viable backend
  (possibly Antigravity once quotas settle) slots in. Re-verify post-June-18-2026 before any real wiring.

### 4. Grok (not wired) — CONFIDENCE: MEDIUM (per SPEC, secondary)
- Grok Build CLI early beta (~May 14 2026), no free tier, unsettled pricing (per SPEC). Not wired;
  revisit later. (Treated as a SPEC-stated fact; not independently re-verified this pass — re-verify if
  it becomes a candidate.)

### 5. No-API-key invariant (R-PTY-23, hard) — CONFIDENCE: HIGH (existing constraint)
- The fallback is a backend-CLI SWAP on the same backend-agnostic PTY surface, never the API. Both
  Claude and Codex runners `delete env.ANTHROPIC_API_KEY` (Claude) / use ChatGPT-subscription sign-in
  (Codex, not the API key). A guard test asserts no fallback path constructs an API-platform call.

### 6. Default-backend selector (R-PTY-22) — design
- A config (`default_human_backend`) governs which runner a NEW human session uses. Fail-safe default:
  NOT Claude-PTY until the interactive-bucket result is confirmed (so users are never silently put on a
  programmatic-billed path). After confirmation, flip to Claude; if confirmed programmatic, set Codex.
- The flip is a recorded operational config change gated on the runbook result — not auto.

### 7. QC gate
- `bun run check-baseline` (per-file isolation; register new test files in
  `tools/regression-baseline.json` if required). Docs-drift CI (`bun run docs:sync`) only if an endpoint
  changes (the selector config may or may not add a REST endpoint — discretion).

## Open technical questions for the implementer to resolve (feed SUMMARYs)
1. The ACTUAL bucket a PTY-wrapped interactive `claude` turn bills, measured on a live post-June-15
   account (check 1) — the gating result that sets the default backend.
2. `setup-token` vs `login` billing classification on the live account (check 2).
3. Subagent/hook/MCP residual bucket attribution (check 3).
4. The exact selector config key + where it lives (supervisor config vs hub user setting).

## Validation Architecture
- Runbook: a doc + checklist artifact exists encoding the four checks + the measurement procedure; a
  test asserts the checklist file is present and references the dual-bucket poll.
- Selector fail-safe: a test asserts that absent a confirmed-interactive result the default human
  backend is NOT Claude-PTY (no silent programmatic-billing default).
- Codex fallback: a test asserts the Codex PTY runner is selectable as a human backend through the same
  surface and that selecting it constructs NO API-platform/API-key call.
- Gemini seam: a test asserts the Gemini runner stub is present, feature-flagged off / not-implemented,
  and never selected by default.
- No-API-key: a guard test asserts no fallback path builds an `ANTHROPIC_API_KEY` env or API call.
- Supersession: a test/doc assertion that R-PTY-24 is marked superseded (Telegram NOT on programmatic
  pool — Phase 20), consistent across SPEC + ROADMAP + REQUIREMENTS.

## Sources
- Anthropic June-15 split (interactive terminal stays on subscription; programmatic onto separate dollar
  credit pool): The New Stack, InfoWorld, XDA (May 2026) — see Phase-18 RESEARCH sources.
- Codex on ChatGPT subscription (included under plan limits via ChatGPT sign-in; API-key = separate
  usage-based; no standalone Codex subscription): OpenAI Codex pricing/help pages + 2026 pricing
  explainers (developers.openai.com/codex/pricing; help.openai.com "Using Codex with your ChatGPT
  plan"). Secondary for the multipliers — re-verify.
- Gemini CLI / Code Assist sunset for individual/Pro/Ultra on June 18 2026 → Antigravity CLI, weekly
  quotas: Google Developers Blog "Transitioning Gemini CLI to Antigravity CLI"; Gemini Code Assist FAQs;
  Antigravity CLI migration guides + issue trackers (May 2026). Secondary — re-verify before relying.
- Grok Build CLI immaturity: SPEC §"If PTY fails" (secondary, not independently re-verified this pass).
- Existing infra: `supervisor/src/runners/*`, `supervisor/src/usage/oauth-poll.ts`, `hub/src/usage/store.ts`.

## RESEARCH COMPLETE
