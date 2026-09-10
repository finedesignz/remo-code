# Phase 19 Plan 03: Fallback (Codex + Gemini Seam) + Env-Sanitizer Summary

The "If PTY fails" fallback is a backend-CLI swap on the same PTY surface — Codex primary (ChatGPT sign-in), a stubbed Gemini seam — with the no-API-key invariant enforced by a single shared multi-provider env-sanitizer scrubbing every runner spawn env (incl. inherited + setup-token vars).

## Shipped
- `supervisor/src/runners/env-sanitize.ts` — `sanitizeSpawnEnv(baseEnv)`; `PROVIDER_KEY_DENYLIST` (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS, + CLAUDE_SETUP_TOKEN/ANTHROPIC_SETUP_TOKEN/SETUP_TOKEN) + anchored `CREDENTIAL_PATTERNS` (`*_API_KEY`/`*_AUTH_TOKEN`/`*_ACCESS_TOKEN`/`*_API_TOKEN`/`*_SETUP_TOKEN`); operates on the resolved env (inherited vars deleted); anchored so benign vars survive.
- `supervisor/src/runners/{claude,codex}-pty-runner.ts` — `build*PtyHostEnv` now routes through `sanitizeSpawnEnv` (replaces the ad-hoc deletes).
- `supervisor/src/runners/pty-host.mjs` — defense-in-depth denylist + pattern mirror (Node host can't import the `.ts`).
- `supervisor/src/runners/gemini-pty-runner.ts` — stubbed off-by-default seam (`GEMINI_BACKEND_ENABLED=false`); `start()` throws a clear not-available error; header documents June-18-2026 sunset → Antigravity weekly quotas; env helper still routes through the sanitizer.
- Codex primary fallback wired via `runner-factory` (selector `codex-pty` → CodexPtyRunner; ChatGPT-subscription sign-in, no API key).
- Tests (all green): `codex-fallback-no-apikey` (5), `gemini-seam-stub` (5), `no-apikey-fallback-guard` (12 — sanitizer unit + per-backend behavioral on the real spawn path incl. inherited + novel `FOO_API_KEY`/`MISTRAL_AUTH_TOKEN` pattern var + benign `MY_API_KEYBOARD_LAYOUT` survival + grep canary), `no-setup-token-on-interactive` (3).

## Re-verified facts (execution time)
- Codex: ChatGPT Plus/Pro/Business/Enterprise/Edu subscriptions include Codex usage under plan limits via sign-in; overage = purchasable credits, no separate penalized pool. No standalone Codex subscription.
- Gemini: Gemini CLI + Code Assist individual/Pro/Ultra tiers sunset June 18 2026 → Antigravity CLI with tighter WEEKLY quotas. Stub only; re-verify before any real wiring.

## Deviations
- **[Rule 2 — Security] Added setup-token envs to the sanitizer denylist + a `*_SETUP_TOKEN$` pattern.** T-19-03b requires setup-token-derived credentials never reach the interactive spawn; the named keys weren't pattern-matched by the original four patterns. Mirrored in `pty-host.mjs`. Committed in a0c41cb.

## Commit
- `a0c41cb` feat(19-03)

## Self-Check: PASSED
- env-sanitize.ts, gemini-pty-runner.ts, runner env-routing, pty-host.mjs, all 4 test files present; commit a0c41cb in log.
