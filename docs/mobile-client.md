# Mobile Tauri client (Phase 12)

Native iOS + Android wrappers around the existing `web/` SPA, talking to
`https://app.remo-code.com` as a normal hub client. The phone never spawns a
CLI; it joins existing supervisor-hosted sessions over the same `/ws/client`
WebSocket the browser uses.

Phase 12.1 is **hub-only**. The Tauri shell, web platform shim, and CI release
pipeline ship in later sub-phases (12.2–12.5). What this PR provides:

1. CORS + cookie variant for Tauri WebView origins.
2. A magic-link deep-link handoff (`?platform=ios|android` →
   `remo-code://auth/callback?token=…`) and a finalize endpoint.
3. Public `.well-known/*` JSON files for Universal Links + App Links.

---

## Tauri WebView origins

| Platform | Origin header |
|---|---|
| iOS (WKWebView) | `tauri://localhost` |
| Android (System WebView) | `https://tauri.localhost` |

Both origins are added to `config.allowedOrigins` automatically when
`MOBILE_TAURI_ORIGINS_ENABLED=true` (default). They flow through the same
`hono/cors` middleware that handles the SPA's own origin. The `/ws/client`
origin check (`hub/src/index.ts`) accepts them through the same allow-list.

Set `MOBILE_TAURI_ORIGINS_ENABLED=false` to revert to browser-only behavior
(useful for production isolation during a rollback).

---

## Session cookie — Tauri variant

The default browser cookie is `__Host-remo_sid` (`HttpOnly; Secure;
SameSite=Lax; Path=/`). The `__Host-` prefix forbids `SameSite=None`, so the
Tauri variant uses a different name and attribute set:

| Attribute | Browser default | Tauri WebView |
|---|---|---|
| Name | `__Host-remo_sid` | `remo_sid` |
| `SameSite` | `Lax` | `None` |
| `Secure` | yes | yes |
| `HttpOnly` | yes | yes |
| `Partitioned` (CHIPS) | no | yes |
| `Path` | `/` | `/` |

The decision is centralized in `sessionCookieAttrsForOrigin(origin)` in
`hub/src/session.ts`. Both cookie names are recognized by `readSessionCookie`
and `parseSessionCookieFromHeader` so the WS upgrade and middleware paths work
identically for browser and mobile clients.

`clearSessionCookie` clears both names so signing out from either surface
purges any stray cookie left by the other.

---

## Deep-link magic-link handoff

The browser flow is unchanged: `POST /api/auth/login/request-link` → email →
`GET /api/auth/login/callback?token=<jwt>` → cookie + 302 to `/`.

For the mobile shell, add `?platform=ios` or `?platform=android` to the
callback URL. The hub:

1. Verifies the magic-link JWT (same as the browser path).
2. Reserves the `jti` for single-use replay protection (same Redis path).
3. **Skips** the browser cookie + SPA redirect.
4. Mints a one-time row in `auth_handoff_tokens` (60-second TTL, single-use).
5. 302s the browser to `remo-code://auth/callback?token=<opaque>`.

The Tauri shell catches the deep link, then exchanges the opaque token for a
real session:

```http
POST /api/auth/finalize-mobile
Origin: tauri://localhost
Content-Type: application/json

{ "token": "mh_…" }
```

The response sets the Tauri-variant cookie via `Set-Cookie: remo_sid=…;
SameSite=None; Secure; Partitioned; …` and returns:

```json
{
  "ok": true,
  "expires_at": "2026-06-04T16:27:35.512Z",
  "user": { "id": "…", "email": "…", "role": "user", "display_name": null }
}
```

### Single-use semantics

`consumeAuthHandoffToken(token)` in `hub/src/db/dal.ts` performs an atomic
`UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING …`. The
returning row is the only path that hands the caller a `{ userId }`; a second
concurrent caller's UPDATE matches zero rows and returns `null`. Combined with
the 60-second TTL, a captured deep link is unusable after first redemption or
after 60 seconds of inactivity, whichever comes first.

### Exclusion from the license gate

`/api/auth/finalize-mobile` lives under the existing `/api/auth/*` exclusion
list (`hub/src/index.ts`) — same rationale as the rest of the auth routes:
license state must not be a prerequisite for *acquiring* the session that
fetches license state.

---

## `.well-known/*` association files

| Route | Purpose | Content-Type |
|---|---|---|
| `GET /.well-known/apple-app-site-association` | iOS Universal Links | `application/json` |
| `GET /.well-known/assetlinks.json` | Android App Links | `application/json` |

Both are public (no auth, no license gate), mounted at the root in
`hub/src/index.ts` before any `/api/*` middleware.

### Environment

| Var | Default | Purpose |
|---|---|---|
| `MOBILE_BUNDLE_ID` | `com.finedesignz.remo-code` | App id for both files |
| `MOBILE_APPLE_TEAM_ID` | `TEAMID` | AASA `appID` prefix |
| `MOBILE_ANDROID_SHA256_FINGERPRINT` | `SHA256_PLACEHOLDER` | Android signing cert |

The literal defaults keep both routes serving in local dev. Production must
override both with the real signing identity values; failure to do so will
prevent Apple/Google from accepting deep links into the app.

Both files are emitted with `Cache-Control: public, max-age=300` — short
enough that rotating the team id or fingerprint propagates within five
minutes.

---

## File map (hub)

```
hub/
├── src/
│   ├── api/
│   │   ├── auth.ts          # +?platform=… branch in /login/callback
│   │   │                    # +POST /finalize-mobile
│   │   └── well-known.ts    # NEW — public AASA + assetlinks routes
│   ├── db/
│   │   ├── dal.ts           # +createAuthHandoffToken, +consumeAuthHandoffToken
│   │   └── schema.sql       # +auth_handoff_tokens table
│   ├── config.ts            # +mobile{TauriOriginsEnabled,TauriOrigins,
│   │                        #         AppleTeamId,AndroidSha256Fingerprint,
│   │                        #         BundleId}
│   ├── session.ts           # +isTauriOrigin, +sessionCookieAttrsForOrigin
│   │                        # +MOBILE_SESSION_COOKIE_NAME
│   └── index.ts             # mounts /.well-known router before /api/*
├── test/
│   ├── mobile-handoff.test.ts   # NEW — 7 tests
│   └── well-known.test.ts       # NEW — 2 tests
└── .env.example             # +MOBILE_* vars
```

---

## Mobile WebView surface (Phase 12.2)

The same `web/` SPA bundle ships to the desktop browser and to the Tauri 2 mobile
WebView. All mobile-only behavior is gated behind a runtime check so the
desktop browser build is unaffected.

### Platform shim — `web/src/lib/platform.ts`

Single source of truth for runtime platform detection. Pure module, no side
effects on import, no React.

```ts
import { isMobileApp, platform, appVersion } from './lib/platform'

isMobileApp()  // boolean — true iff window.__TAURI_INTERNALS__ is present
platform()     // 'ios' | 'android' | 'web' — sniffs UA only when isMobileApp()
appVersion()   // string | null — reads window.__REMO_APP_VERSION__ (injected by shell)
```

**Rule:** the web build MUST NOT import `@tauri-apps/api`. All Tauri APIs are
accessed via `window.__TAURI__` feature detection so the same bundle still
loads in a normal browser.

### Safe-area CSS contract — `web/src/index.css`

Three utility classes consume the iOS/Android safe-area insets. Browsers
without notches resolve `env()` to `0`, so the classes are zero-cost on
desktop.

| class         | effect                                          |
| ------------- | ----------------------------------------------- |
| `.safe-top`   | `padding-top: env(safe-area-inset-top)`         |
| `.safe-bottom`| `padding-bottom: env(safe-area-inset-bottom)`   |
| `.safe-x`     | `padding-left/right: env(safe-area-inset-...)`  |

Wired in: `AppChrome.tsx` top header (`safe-top safe-x`), `Layout.tsx` chat
header (`safe-top safe-x`), `ChatSurface.tsx` composer form (`safe-bottom`).
`web/index.html` already sets `viewport-fit=cover`. The root chrome uses
`100dvh` (not `100vh`) to survive the iOS Safari keyboard collapse.

### External-link interception — `web/src/lib/external-link.ts`

When `isMobileApp()` is true, a delegated `click` listener on `document`
captures anchor clicks that either carry `target="_blank"` OR point at a
different origin, and hands the URL to `window.__TAURI__.shell.open(href)`.
Same-origin in-app links pass through. Modifier-key clicks, non-primary mouse
buttons, and `defaultPrevented` events also pass through.

`shouldOpenExternally(event, anchor, pageOrigin, mobile?)` is exported as a
pure function so it can be unit-tested without a DOM.

Installed once at boot from `web/src/main.tsx` via
`installExternalLinkInterceptor()`. No-op in a plain browser.

### Push registration stub — `web/src/lib/push.ts`

`async function registerForPush(): Promise<void>` — empty stub today. Logs one
line when `isMobileApp()` is true so dev-build callers are greppable. Real
implementation lands in Phase 12 v1.1; the surface is declared now so v1.1 is
a one-file change.

### Tests

- `web/src/lib/platform.test.ts` — `bun test`, mutates `window` / `navigator`.
- `web/src/lib/external-link.test.ts` — `bun test`, exercises the pure helper
  with synthetic click + anchor records.

Run from repo root: `bun test web/src/lib/platform.test.ts web/src/lib/external-link.test.ts`.

---

## Mobile shell (Phase 12.3)

The native iOS/Android binary lives at `mobile/tauri/` — a thin Tauri 2.x
WebView wrapper that loads the hosted SPA at `https://app.remo-code.com`. It's
the only piece that needs to be rebuilt per native release; the SPA itself
ships continuously through the hub's Docker image.

### Why a shell, not a port

- One UI codebase. The web SPA already runs in every browser; re-implementing
  it in React Native / Flutter would duplicate every Phase 03 grid-view fix,
  every scheduler UI tweak, every error-capture drawer.
- Native deep links. The `remo-code://auth/callback?token=<X>` scheme can only
  be claimed by a native binary registered with the OS. The shell exists
  primarily to own that scheme.
- App Store presence. Distribution + push-notification entitlements + biometric
  unlock (deferred) all require a real binary.

### Architecture

```
OS magic-link tap
  → remo-code://auth/callback?token=<X>            (custom scheme)
  OR
  → https://app.remo-code.com/auth/callback?token=<X>   (Universal Link / App Link)
  → mobile shell (src-tauri/src/lib.rs handle_deep_link)
  → WebView eval: POST /api/auth/finalize-mobile { token } credentials: include
  → hub sets opaque session cookie on WebView cookie jar
  → location.replace(https://app.remo-code.com)
  → full SPA loads, authenticated
```

### Files

- `mobile/tauri/src-tauri/Cargo.toml` — Tauri 2.11 + `tauri-plugin-deep-link`.
  Versions match `supervisor/tauri/src-tauri/Cargo.toml` exactly.
- `mobile/tauri/src-tauri/tauri.conf.json` — identifier `com.finedesignz.remo-code`,
  scheme `remo-code` (desktop) + Universal-Link/App-Link host
  `app.remo-code.com` with `pathPrefix: /auth/callback` (mobile), productName
  `Remo Code`, version `0.1.0`, CSP allowing `https://app.remo-code.com` and
  `wss://app.remo-code.com`.
- `mobile/tauri/src-tauri/src/lib.rs` — `#[tauri::mobile_entry_point]` `run()`
  function + deep-link handler that escapes the token through `serde_json` and
  evals a fetch+reload JS snippet in the WebView. Accepts both custom-scheme
  and Universal-Link/App-Link wake forms (keyed off scheme + path ending in
  `/callback`).
- `mobile/tauri/src-tauri/capabilities/default.json` — grants `deep-link`,
  `shell`, `os`, `http` to the `main` window.
- `mobile/tauri/ui/` — minimal Vite entry whose `main.ts` immediately
  `location.replace`s to `VITE_REMO_URL` (defaults to `https://app.remo-code.com`)
  after stashing `window.__REMO_APP_VERSION__` in `sessionStorage`.

### Phase 12.4 status

- **Android — shipped on `feat/mobile-android`.** `gen/android/` Gradle project
  committed; debug APK build verified with Android Studio SDK + NDK
  `27.3.13750724` on Windows 11. Local artifact:
  `mobile/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
  (~168 MB, ARM64). Sideload + toolchain bootstrap docs in
  [`mobile/tauri/README.md`](../mobile/tauri/README.md).
- **iOS — pending (MacInCloud track).** `gen/apple/` Xcode project + `cargo tauri
  ios init` run separately.
- **Deferred to 12.5.** Code-signing (Apple Developer Program; Google Play
  upload key), `mobile-shell-release.yml` for `mobile-v*.*.*` tags, brand-icon
  refresh, AAB packaging for Play Store.

### CI

`.github/workflows/mobile-shell-typecheck.yml` runs `cargo check` against the
host x86_64-unknown-linux-gnu target on every push that touches `mobile/tauri/`.
This catches Rust regressions without needing Android NDK or Xcode in CI; the
real mobile build matrix lands with Phase 12.4.

### iOS distribution path (Windows-only developer)

The lead maintainer develops on Windows full-time, so the iOS path is
optimized for never needing a local Mac after a one-shot init step:

- **MacInCloud first-time init** (~30 min, smallest plan ~$25/month on the
  Managed Server tier — you cancel immediately after). Run
  `cargo tauri ios init` on the rented Mac, commit the generated
  `mobile/tauri/src-tauri/gen/apple/` tree on a `feat/mobile-ios-init`
  branch, open a PR, disconnect.
- **GitHub Actions `mobile-ios-build` workflow** (`.github/workflows/mobile-ios-build.yml`)
  on `macos-14` produces an unsigned `.ipa` for every subsequent build.
  Triggered by `workflow_dispatch`, by `mobile-ios-v*` tags (which also
  publish a GitHub Release), and by PRs touching `mobile/tauri/**` for
  typecheck-only. Gated behind repo variable `ENABLE_IOS_BUILD=true` to
  avoid burning macOS minutes by accident.
- **AltStore sideload on Windows** — install AltServer + AltStore, pair
  the iPhone, drag the `.ipa` onto AltServer. AltStore re-signs with a
  free Apple ID; the app refreshes every 7 days as long as AltServer is
  running. Three-app sideload limit per Apple ID, no push notifications.
- **App Store distribution** requires the paid Apple Developer Program
  ($99/yr) and code-signing secrets in CI — out of scope for the
  Windows-only path.

Full runbook: [`docs/ios-sideload.md`](ios-sideload.md).

---

## Lifecycle expectations on mobile

Three post-12.3 hub changes shape the mobile shell's runtime contract.
The mobile WebView wrapper does NOT need to handle any of these explicitly
— the hosted SPA already does — but they are documented here so anyone
debugging "my session went quiet after I backgrounded the app" knows the
expected sequence.

### WS reconnect after backgrounding

Mobile WebViews kill open WebSockets when the screen turns off or the app
is backgrounded for any non-trivial period (iOS suspends the JS runtime
within seconds; Android varies by OEM). The existing `/ws/client`
reconnect loop in the hosted SPA detects the close, backs off, and
reconnects on next foreground. No mobile-shell code change required.

### 300s idle teardown (PR #128, commit `4e7d2fe`)

`REMO_SESSION_IDLE_GRACE_SECONDS` defaults to 300. When the last web
client subscribed to a session disconnects, the supervisor starts a 5-min
grace timer; if no client reattaches within the window, the supervisor
kills the underlying Claude / Codex CLI subprocess. A backgrounded mobile
session that crosses the 5-min boundary will therefore find the runner
dead on foreground.

### Auto-resume orphans (PR #133, commit `35fa2c9`)

When the SPA reconnects `/ws/client` and resubscribes to a session whose
runner was torn down by the idle grace, the supervisor auto-respawns the
runner from the persisted message history — unless the session is in the
`user_stopped` state (explicit "Stop" press), which is honored. From the
mobile UX perspective: foreground → reconnect → resubscribe → first
typed message lands → runner respawns transparently.

### License-gate WS check (PR #104, commit `9c9ebdc`)

`/ws/client` rejects `send_message`, `permission_response`, and
`question_response` payloads when `users.license_status != 'active'`.
A license-expired mobile user can still observe activity (read-only) but
any mutating action surfaces the same gate the desktop SPA already
renders. The mobile shell does not need its own HTTP 402 surfacing — the
SPA banner is the single source of truth.

---

## Related docs

- [docs/auth.md](auth.md) — magic-link cookie session architecture (Phase 07)
- [mobile/tauri/README.md](../mobile/tauri/README.md) — mobile shell build + deep-link contract
- [.planning/phases/12-mobile-tauri-client/PLAN.md](../.planning/phases/12-mobile-tauri-client/PLAN.md) — Phase 12 plan (reconstructed 2026-05-28)
