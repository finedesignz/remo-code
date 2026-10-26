# Quick: Titanium login = redirect only (fleet login standard S1 + S3 check)

Owner directive 2026-10-25: every app uses the Titanium Labs login; no in-app credentials.

## Definition of done
- Login entry (POST /auth/start) redirects to https://auth.titaniumlabs.us/login?app_id=remo-code&return_url=<REMO_PUBLIC_URL>/auth/callback...
- No in-app email form, no server call to the portal's send-magic-link, no credential route, no legacy-login flag, no Bearer-JWT login.
- Logged-out page has a visible button to the redirect (web form POST, app shell JSON start).
- Callback/exchange/state/PKCE/confirm validation untouched.
- Stale docs removed.

## Detect (done before editing)
Hosted redirect + exchange already existed (hub/src/api/titanium-auth.ts). Remaining surface to delete:
POST /auth/email (server send-magic-link), /api/auth/login|register|login/request-link|login/callback|finalize-mobile,
/api/setup/*, ALLOW_LEGACY_LOGIN, LEGACY_MAGIC_LINK_LOGIN, MAGIC_LINK_SECRET, Bearer JWT (REST + /ws/client + reauth),
web email form / password form / SetupForm / AuthCallback page, migrate-users script.

## Tasks
1. Hub: delete the routes + config + Bearer branches; /auth/start gains the app-shell JSON leg.
2. Web: Login = button only; useAuth cookie-only; drop SetupForm/AuthCallback/legacy helpers.
3. Tests: delete legacy tests, migrate WS tests to cookie auth, add titanium-redirect-only.test.ts, rewrite email tests as app-start tests.
4. Docs: rewrite docs/auth.md, patch CLAUDE.md, AGENTS.md, mobile-client.md, code comments.
5. QC (Sonnet + Codex, 2 rounds max), then PR. No merge, no deploy.
