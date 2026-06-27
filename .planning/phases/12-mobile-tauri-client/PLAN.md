# Phase 12 — Mobile Tauri Client

> **Reconstructed 2026-05-28.** The original PLAN.md was never committed
> (`gh api …PLAN.md?ref=feat/mobile-tauri` → 404). This document is the
> canonical record, seeded from PR #105 / #110 / #111 bodies, the replan
> review at `.planning/phases/12-mobile-tauri-client/PHASE-12-REPLAN.md`,
> and `docs/mobile-client.md`. Future edits land here, not in PR bodies.

## Status

| Sub-phase | PR | Status | Notes |
|---|---|---|---|
| 12.1 — hub finalize + CORS + cookie variant | [#105](https://github.com/finedesignz/remo-code/pull/105) | **DONE** | `POST /api/auth/finalize-mobile`, `.well-known/*`, `auth_handoff_tokens` table, Tauri-origin cookie config. |
| 12.2 — web platform shims | [#110](https://github.com/finedesignz/remo-code/pull/110) | **DONE** | `web/src/lib/{platform,external-link,push}.ts`, safe-area CSS. |
| 12.3 — Tauri scaffold | [#111](https://github.com/finedesignz/remo-code/pull/111) | **DONE** | `mobile/tauri/` pinned to supervisor Tauri 2.11.2, deep-link handler, CSP, `mobile-shell-typecheck.yml`. |
| 12.3.1 — desktop preview + doc sweep | (this PR) | **IN-FLIGHT** | Windows MSI/NSIS preview build, icon placeholder + Win/mac fan-out, PLAN restore, stale-doc fixes, lifecycle drift docs. |
| 12.4 — platform generation + signing | — | **PENDING** | `gen/apple/` (Mac), `gen/android/` (SDK+NDK), iOS/Android icon fan-out, Apple Developer + Play upload key. |
| 12.5 — release CI | — | **PENDING** | `mobile-shell-release.yml` on `mobile-v*.*.*` tags. Matrix: `macos-latest` (iOS `.ipa` → TestFlight) + `ubuntu-latest` (Android `.aab` → Play Internal). |
| 12.6 — docs / version / release | — | **PENDING** | Lockstep bump (`Cargo.toml` + `tauri.conf.json` + `ui/package.json` + `Cargo.lock`), tag `mobile-v0.2.0`, verify via TestFlight + Play Internal (NOT a `/health` poll — no hub artifact). |

## Cross-cutting invariants

- Mobile shell talks ONLY to `/ws/client` over the hosted SPA — never `/ws/agent`.
- Tauri dep versions track `supervisor/tauri/` exactly (currently `tauri 2.11.2` / `tauri-build 2.6.2` / `tauri-plugin-shell 2.3.5`).
- No hub secrets embedded; all auth flows via opaque-cookie magic-link → `/api/auth/finalize-mobile` handoff.
- Lifecycle: foreground = WS connected; ≥5 min background = supervisor may have killed the runner (PR #128, `REMO_SESSION_IDLE_GRACE_SECONDS=300`); next foreground = PR #133 auto-resume.
- License-expired UX surfaces from BOTH HTTP 402 AND `/ws/client` mutating-message rejects (PR #104).
- Deep-link tokens MUST be `serde_json::to_string`-escaped before JS interpolation. Never concatenate raw token strings into the eval payload.

## 12.4 — Platform generation + signing (revised scope)

- `cargo tauri ios init` on a Mac host; commit `gen/apple/` (project files only, build artefacts `.gitignore`d).
- `cargo tauri android init` on an SDK 34 + NDK r26+ host; commit `gen/android/`.
- Re-fan-out iOS/Android icon variants — 12.3.1 already shipped Windows/macOS variants + the 1024×1024 source.
- Apple Developer Program enrollment; commit signing identity refs (NOT the cert) to repo secrets.
- Google Play upload key generation; store in repo secrets.
- **Removed from original plan:** `POST /api/auth/finalize-mobile` — already shipped in 12.1 (PR #105).

## 12.5 — Release CI (revised scope)

- `.github/workflows/mobile-shell-release.yml`, triggered on `mobile-v*.*.*` tags.
- Matrix:
  - `macos-latest` → `cargo tauri ios build --release` → `.ipa` → TestFlight upload via `xcrun altool` or fastlane.
  - `ubuntu-latest` → `cargo tauri android build --release` → `.aab` → Play Console upload via `gradle-play-publisher` or Google's REST API.
- **Removed from original plan:** Tauri updater key reuse from supervisor — mobile stores own their update delivery.

## 12.6 — Docs / version / release (revised scope)

- Lockstep version bump across `mobile/tauri/src-tauri/Cargo.toml`, `tauri.conf.json`, `ui/package.json`, `Cargo.lock`.
- Tag `mobile-v0.2.0`.
- **Removed from original plan:** Coolify `/health` poll — no hub artefact in this phase. Verify instead via TestFlight build appearing in App Store Connect + Play Internal Testing track.

## Related

- [PHASE-12-REPLAN.md](PHASE-12-REPLAN.md) — full replan review with drift analysis.
- [docs/mobile-client.md](../../../docs/mobile-client.md) — architecture + lifecycle expectations.
- [mobile/tauri/README.md](../../../mobile/tauri/README.md) — build commands + deep-link contract.
