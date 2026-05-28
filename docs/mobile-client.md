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

## Related docs

- [docs/auth.md](auth.md) — magic-link cookie session architecture (Phase 07)
- [.planning/phases/12-mobile-tauri-client/PLAN.md](../.planning/phases/12-mobile-tauri-client/PLAN.md) — full Phase 12 plan
