# Phase 12 — Pause State & Resume Runbook

**Status:** paused 2026-05-28. Single canonical "where everything is" doc. Come back in 3 months, start here.

## 1. TL;DR

- **Works today:** Windows MSI preview (debug, unsigned) loads `https://app.remo-code.com` and completes magic-link auth via the `remo-code://` deep link. Android debug APK builds + sideloads via `adb`. Hub mobile endpoints are live in production.
- **Install:** `msiexec /i "C:\Users\artic\Downloads\RemoCode-Mobile-Preview-0.1.0.msi"` (Windows) or `adb install -r "C:\Users\artic\Downloads\RemoCode-Mobile-Preview-0.1.0.apk"` (Android).
- **Deferred:** iOS first build (needs Mac), release signing (Android keystore + Windows Authenticode), Windows/Android release CI, store listings, push, biometrics.
- **Refresh on resume:** verify Tauri CLI version still matches `Cargo.toml` pin (2.11.2), re-check `JAVA_HOME` (was UNSET at pause — see §8), re-pull `origin/main`, confirm hub endpoints unchanged.
- **Rest of doc:** §2 install, §3 layout, §4 hub, §5 web shim, §6 rebuild, §7 deferred, §8 resume checklist, §9 related docs.

---

## 2. Install + test

- **Or download from GitHub Releases:** tagged preview builds (Windows MSI + NSIS + Android APK) are published by `.github/workflows/release-mobile.yml` on every `mobile-v*.*.*` tag push. Grab the latest at <https://github.com/finedesignz/remo-code/releases?q=mobile-v> — no local build needed. Artifacts are UNSIGNED (same SmartScreen / "Install unknown apps" caveats as the local copies below).

### Windows preview (works today)

```powershell
msiexec /i "C:\Users\artic\Downloads\RemoCode-Mobile-Preview-0.1.0.msi"
```

Then launch "Remo Code" from the Start menu. The app loads `https://app.remo-code.com` and handles magic-link auth via the custom `remo-code://auth/callback` URL scheme registered by the MSI installer. Verified working by user 2026-05-28.

- Artifact: `C:\Users\artic\Downloads\RemoCode-Mobile-Preview-0.1.0.msi`
- Size: 8.6 MB
- Type: debug, **unsigned** (Windows SmartScreen will warn on first run)
- Built: 2026-05-28 from PR #142

### Android sideload (real phone, USB)

```powershell
adb install -r "C:\Users\artic\Downloads\RemoCode-Mobile-Preview-0.1.0.apk"
```

- Artifact: `C:\Users\artic\Downloads\RemoCode-Mobile-Preview-0.1.0.apk`
- Size: 168 MB
- Type: ARM64 debug, **unsigned**
- Built: 2026-05-28 from PR #158
- `adb.exe` path: `C:\Users\artic\AppData\Local\Android\Sdk\platform-tools\adb.exe` — confirmed on disk at pause time despite Android Studio IDE uninstall.
- Phone prerequisites: USB Debugging enabled (Settings → Developer Options).

### iOS

**Not buildable yet.** No Mac was available at pause time. Resume steps live in [docs/ios-sideload.md](./ios-sideload.md).

TL;DR of the iOS resume path:
- **MacInCloud** Pay-As-You-Go ($1/hr), preset "Xcode/iOS Dev", macOS Sequoia 15.7.3 on M1 mini, 25h credit minimum (~$28.75 total spend).
- Run `cargo tauri ios init`, commit the generated `mobile/tauri/src-tauri/gen/apple/` tree.
- Set repo var `ENABLE_IOS_BUILD=true` (currently unset).
- Trigger `.github/workflows/mobile-ios-build.yml` (gated by that var).

---

## 3. Source layout

```
mobile/tauri/
├── src-tauri/
│   ├── Cargo.toml                    # Tauri 2.11.2 pinned (line 17)
│   ├── tauri.conf.json               # mobile config (no app.windows[])
│   ├── tauri.windows.conf.json       # desktop overlay (MSI + NSIS targets)
│   ├── src/{lib.rs, main.rs}         # deep-link handler + entry points
│   ├── capabilities/default.json     # deep-link/shell/os/http permissions
│   ├── icons/                        # 1024x1024 + Windows/macOS variants
│   └── gen/android/                  # Gradle project (committed in PR #158)
│       └── app/src/main/AndroidManifest.xml  # remo-code:// intent-filter
└── ui/
    ├── index.html, src/main.ts       # vanilla TS, redirects to VITE_REMO_URL
    └── vite.config.ts                # builds to dist/
```

iOS would add `mobile/tauri/src-tauri/gen/apple/` (not present at pause).

### Key constants

- **App identifier:** `com.finedesignz.remo-code`
- **Custom URL scheme:** `remo-code://auth/callback` (Windows + Android)
- **Universal Link / App Link host:** `app.remo-code.com`, `pathPrefix: /auth/callback`
- **Tauri version:** 2.11.2 (must stay in lockstep with `supervisor/tauri/src-tauri/Cargo.toml`)

---

## 4. Hub surfaces (production at `app.remo-code.com`)

All shipped in PR #105, live since.

| Endpoint | File | Notes |
|---|---|---|
| `GET /api/auth/login/callback?platform=ios\|android` | `hub/src/api/auth.ts:220` (`?platform=` branch at line 264) | Mints `auth_handoff_tokens` row, 302s to `remo-code://auth/callback?token=…` instead of cookie. |
| `POST /api/auth/finalize-mobile` | `hub/src/api/auth.ts:358` | Atomic single-use UPDATE consumes token, creates session, emits Tauri-variant cookie. Not license-gated. |
| `GET /.well-known/apple-app-site-association` | `hub/src/api/well-known.ts:32` | Public JSON, no auth, no license gate. |
| `GET /.well-known/assetlinks.json` | `hub/src/api/well-known.ts:60` | Same. |

Supporting infra:

- **Cookie origin discrimination:** `hub/src/session.ts:69` — `sessionCookieAttrsForOrigin(origin)`. Browser default `__Host-remo_sid; SameSite=Lax`. Tauri origins (`tauri://localhost` iOS, `https://tauri.localhost` Android) get unprefixed `remo_sid; SameSite=None; Secure; Partitioned`. `readSessionCookie` / `parseSessionCookieFromHeader` accept both.
- **Handoff token table:** `hub/src/db/schema.sql:857` — `auth_handoff_tokens` (uuid pk, fk → `users`, sha-256 `token_hash`, `purpose='mobile_handoff'`, 60s `expires_at`, nullable `consumed_at`).
- **DAL:** `hub/src/db/dal.ts:1561` (`createAuthHandoffToken`) + `:1578` (`consumeAuthHandoffToken` — atomic `UPDATE … RETURNING`, no read-then-write race).
- **Config env:** `MOBILE_TAURI_ORIGINS_ENABLED` (default `true`), `MOBILE_BUNDLE_ID`, `MOBILE_APPLE_TEAM_ID`, `MOBILE_ANDROID_SHA256_FINGERPRINT`.

Invariants (do not change on resume without re-reading [docs/mobile-client.md](./mobile-client.md)):

- `/api/auth/finalize-mobile` is **not** license-gated (same rule as the rest of `/api/auth/*`).
- Tauri origins are **additional** — disabling `MOBILE_TAURI_ORIGINS_ENABLED` reverts to browser-only without further code changes.
- `/ws/agent` and `/ws/client` are unchanged by Phase 12. Tauri WS traffic is byte-identical to browser WS traffic.

---

## 5. Web shim surfaces

`web/src/lib/`:

- `platform.ts` — `isMobileApp()`, `platform()`, `appVersion()`. Detects Tauri runtime.
- `external-link.ts` — `shouldOpenExternally`, `installExternalLinkInterceptor`. Routes non-app links through the OS browser.
- `push.ts` — stub for v1.1 push notifications. Not wired.
- Tests: `platform.test.ts`, `external-link.test.ts`.

Safe-area CSS (iOS notch / Android cutout): `web/src/index.css` — `.safe-top`, `.safe-bottom`, `.safe-x`.

---

## 6. Rebuilding from scratch

If artifacts are gone in 3 months.

### Windows preview MSI

```powershell
cd C:/Users/artic/GitHub/remo-code/mobile/tauri/ui
bun install
cd ../src-tauri
cargo tauri build --debug
```

MSI lands at `target/debug/bundle/msi/Remo Code_0.1.0_x64_en-US.msi`.

### Android debug APK

1. Verify env vars (these were set at install time, may have drifted):
   ```powershell
   echo $env:ANDROID_HOME $env:NDK_HOME $env:JAVA_HOME
   ```
2. **At pause time, `JAVA_HOME` was UNSET / `$null`.** Android Studio was uninstalled and almost certainly took the bundled JBR with it. Before any Android build:
   ```powershell
   winget install Microsoft.OpenJDK.17
   # then set JAVA_HOME to the install path (typically C:\Program Files\Microsoft\jdk-17.x.y-hotspot)
   ```
3. `rustup target add aarch64-linux-android` if missing.
4. From repo root:
   ```powershell
   cargo tauri android build --debug --apk
   ```
5. APK at `mobile/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.

### iOS

See [docs/ios-sideload.md](./ios-sideload.md). Mac required; not buildable on this workstation.

---

## 7. Deferred / NOT done

- **iOS first build** — needs Mac (MacInCloud or owned). Runbook: [docs/ios-sideload.md](./ios-sideload.md). CI workflow `.github/workflows/mobile-ios-build.yml` exists but is gated by repo var `ENABLE_IOS_BUILD == 'true'` (currently unset).
- **Release signing** — Android (Play Store release keystore) and Windows (Authenticode cert) are both unsigned. SmartScreen will warn on Windows; Android sideload works but Play Store upload is blocked.
- **Release CI for Android + Windows** — only iOS has a CI workflow. Android + Windows are local-build only.
- **Version tag + release cut** — no `mobile-v0.1.0` tag exists. Phase 12.5 (release) and 12.6 (store submission) from the original plan are deferred.
- **App Store / Play Store listings** — not started. Requires paid Apple Dev ($99/yr) + Play Console ($25 one-time).
- **Push notifications** — `web/src/lib/push.ts` stub only. v1.1 scope.
- **Biometric unlock, offline message queue, background sync** — v1.1+ scope.

---

## 8. State refresh checklist on resume

Before any new Tauri work after the pause:

- [ ] `git pull origin main` — main may have moved significantly.
- [ ] `cargo tauri --version` — was 2.11.2 at pause.
- [ ] Confirm `mobile/tauri/src-tauri/Cargo.toml` (line 17) still pins to whatever `supervisor/tauri/src-tauri/Cargo.toml` pins. Bump if supervisor moved.
- [ ] Re-read [docs/mobile-client.md](./mobile-client.md) for post-pause hub changes.
- [ ] Confirm `hub/src/api/auth.ts` `/finalize-mobile` endpoint still exists at line ~358 (grep `finalize-mobile`).
- [ ] Confirm `auth_handoff_tokens` table still in `hub/src/db/schema.sql` (line ~857).
- [ ] Confirm `app.remo-code.com` TLS cert is valid (Tauri WebView is strict).
- [ ] **Android specifically:** confirm `ANDROID_HOME`, `NDK_HOME` still resolve. **`JAVA_HOME` was unset at pause** — must be fixed before any Android build (see §6 step 2).
- [ ] If iOS: secure a Mac, then follow [docs/ios-sideload.md](./ios-sideload.md).

---

## 9. Related docs + planning

- [docs/mobile-client.md](./mobile-client.md) — full architecture, hub surfaces, web shim, mobile shell, lifecycle drift.
- [docs/ios-sideload.md](./ios-sideload.md) — MacInCloud + AltStore runbook.
- [mobile/tauri/README.md](../mobile/tauri/README.md) — local dev commands, toolchain bootstrap.
- [.planning/phases/12-mobile-tauri-client/PLAN.md](../.planning/phases/12-mobile-tauri-client/PLAN.md) — original sub-phase plan.
- [.planning/phases/12-mobile-tauri-client/PHASE-12-REPLAN.md](../.planning/phases/12-mobile-tauri-client/PHASE-12-REPLAN.md) — 12.3.1 review reconciling plan vs main.

### Merged PRs (history)

- **#105** — 12.1 hub mobile auth (`/finalize-mobile`, `.well-known/*`, `auth_handoff_tokens`)
- **#110** — 12.2 web platform shim (`platform.ts`, `external-link.ts`, safe-area CSS)
- **#111** — 12.3 Tauri mobile shell scaffold (`mobile/tauri/` tree)
- **#142** — 12.3.1 desktop preview + doc sweep + PLAN restore (Windows MSI build path)
- **#152** — iOS CI workflow + MacInCloud runbook + AltStore docs
- **#158** — 12.4 Android: platform-gen + debug APK build
