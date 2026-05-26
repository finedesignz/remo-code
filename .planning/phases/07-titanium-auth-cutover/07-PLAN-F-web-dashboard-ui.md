# 07-PLAN-F: Web dashboard UI swap

**Stage:** F
**Wave:** 3 (depends on C; parallel with D, E)
**Mode:** standard
**TDD:** light (manual smoke per rule #12 — UI work is hard to test cheaply; assert key behaviors with Vitest where it fits)
**Requirements:** R-AUTH-04 (web side), R-AUTH-09 (cookie usage)

<read_first>
- `07-CONTEXT.md` "Login flow endpoints", "Dashboard session"
- `07-PATTERNS.md` rows for `web/src/pages/Login.tsx`, `AuthCallback.tsx`, `hubFetch.ts`
- `web/src/components/LoginPage.tsx` — current login form
- `web/src/lib/hubFetch.ts` — fetch wrapper
- `web/src/App.tsx` — routing setup
- `web/src/components/SettingsPage.tsx` — canonical visual style (rule #15 + project CLAUDE.md)
- `~/.claude/design-preferences.md` — global design preferences (rule #15)
</read_first>

<tasks>

### F.1 Refactor `web/src/components/LoginPage.tsx` → `web/src/pages/Login.tsx`
- Replace email+password form with single-input email + "Send magic link" button.
- On submit: `POST /api/auth/login/request-link` with `credentials: 'include'`. Show "Check your email" success state regardless of API response (enumeration prevention).
- During soak ONLY: show small "Use password instead" link below the form. Hidden when `import.meta.env.VITE_HIDE_LEGACY_LOGIN === 'true'` (D7 flip).
- Match Tailwind palette: indigo accent, `rounded-xl` card, `bg-[var(--bg-secondary)]/60`, no heavy borders.
<acceptance_criteria>
Manual smoke: form submits, success state shows, "Use password instead" toggle drives back to a legacy password sub-form. `VITE_HIDE_LEGACY_LOGIN=true` hides the link. Visual matches SettingsPage palette.
</acceptance_criteria>

### F.2 Add `web/src/pages/AuthCallback.tsx`
- Mounted at route `/auth/callback`.
- Reads `?token=…` from URL. Calls `GET /api/auth/login/callback?token=…` with `credentials: 'include'` (browser will follow Set-Cookie).
- On success (302 from hub): `window.location.replace('/')`.
- On 409: shows "Link mismatch — contact support" error.
- On 401/410: shows "Link expired" + back-to-login button.
- Loading spinner during the round-trip.
<acceptance_criteria>
Manual smoke: pasting a valid magic-link URL completes login and lands on dashboard. Expired link shows error. Reused link shows 409.
</acceptance_criteria>

### F.3 Extend `web/src/lib/hubFetch.ts`
- Set `credentials: 'include'` on every request.
- Before every mutating request (POST/PUT/PATCH/DELETE): read `csrf_token` from `document.cookie`, attach as `X-CSRF-Token` header. Throw early if cookie missing on a mutating request.
- Remove all `Authorization: Bearer ${localStorage.session}` attachments (those go away post-cutover; during soak keep them as a fallback if no session cookie present).
- Remove `localStorage.session` writes on login success (cookie is now the source of truth).
<acceptance_criteria>
All authenticated REST calls succeed via cookie. POST without CSRF cookie present throws a clear client-side error (caught by an upstream toast). Vitest unit test for `hubFetch` covers GET + POST + CSRF attach.
</acceptance_criteria>

### F.4 Header / nav: license badge dot + email display
- Header (existing `Sidebar.tsx` / nav area) shows authenticated user's email + a license-status dot:
  - Green = ACTIVE
  - Amber = EXPIRED grace
  - Red = SUSPENDED/BANNED (also force-redirect to a "license required" page)
- License status loaded from a new `GET /api/profile/license` endpoint (additive to `hub/src/api/profile.ts`; returns `{ status, license_id?, checked_at }`).
<acceptance_criteria>
Manual smoke: dot color matches stub Titanium state. Visual matches design tokens (`text-emerald-400`, `text-amber-400`, `text-red-400`).
</acceptance_criteria>

### F.5 Remove password-change UI
- If `web/src/components/SettingsPage.tsx` exposes a password-change form: remove it; replace with a link to Titanium portal (`${TITANIUM_PORTAL_URL}/account`).
- "Display name", "avatar", "timezone" panels remain unchanged.
<acceptance_criteria>
SettingsPage renders without the password card. Link to Titanium portal visible, opens in new tab.
</acceptance_criteria>

### F.6 Routing wiring in `web/src/App.tsx`
- Add routes: `/login`, `/auth/callback`.
- On 401 from any `hubFetch` call: redirect to `/login`.
- On 402 from hubFetch: show a "License required" inline banner (don't redirect — read-only grace should let user still browse).
<acceptance_criteria>
Manual smoke: 401 redirects, 402 shows banner. Both styled per design tokens.
</acceptance_criteria>

</tasks>

**Outputs:** new login + callback pages, updated `hubFetch`, license badge, password-change removed. Web fully drives the new flow.

**Verification:** end-to-end manual smoke (dev hub + dev web): enter email, receive magic-link (stub logged to console), paste URL into browser, land on dashboard, license dot green, mutating request succeeds with CSRF.
