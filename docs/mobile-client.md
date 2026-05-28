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

## File map

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

## Related docs

- [docs/auth.md](auth.md) — magic-link cookie session architecture (Phase 07)
- [.planning/phases/12-mobile-tauri-client/PLAN.md](../.planning/phases/12-mobile-tauri-client/PLAN.md) — full Phase 12 plan
