# 07-PLAN-H: Dead-code & cleanup (post-soak cutover)

**Stage:** H
**Wave:** 4 (depends on C, F, G — runs at D14)
**Mode:** standard
**TDD:** light (regression coverage; main work is deletions)
**Requirements:** R-AUTH-05, R-AUTH-07

<read_first>
- `07-CONTEXT.md` "Rollback", "D14 / D14+1" sections
- `~/.claude/plans/cheeky-watching-crystal.md` Stage H (Python original — same intent)
- Every file touched by C / D / E / F / G
- `README.md`, `CLAUDE.md` — the docs that must be updated
- `docs/` — locate all places mentioning auth/login/JWT
</read_first>

<tasks>

### H.1 Gate legacy path behind `ALLOW_LEGACY_LOGIN`
- Wrap `POST /api/auth/login`, `POST /api/auth/register`, and the bearer-token fallback in `authMiddleware` + WS auth: `if (!config.allowLegacyLogin) return c.json({ error: 'legacy_login_disabled' }, 410);`.
- KEEP the code present. Default `ALLOW_LEGACY_LOGIN=false` post-cutover.
<acceptance_criteria>
With `ALLOW_LEGACY_LOGIN=false`: legacy POST returns 410, bearer-token requests return 401, only cookie+Titanium-flow works. With `true`: legacy still works as fallback. Both states tested.
</acceptance_criteria>

### H.2 Hide legacy UI fallback
- Web build sets `VITE_HIDE_LEGACY_LOGIN=true` for prod after D14. Login page no longer shows "Use password instead".
- Document toggle in `docs/auth.md`.
<acceptance_criteria>
`web/dist` build with the flag set: search built HTML/JS for "Use password" → 0 matches.
</acceptance_criteria>

### H.3 Force-logout existing legacy JWT holders at D14
- Strategy: rotate `JWT_SECRET` env var on the prod deploy at D14. All HS256 JWTs immediately invalid. Users land at `/login`.
- Document the rotation step in `docs/auth.md` "D14 runbook" section.
- DO NOT rotate `SESSION_SECRET` — that would log out new Titanium-cookie users too.
<acceptance_criteria>
Pre-rotation: a legacy JWT verifies. Post-rotation: same JWT returns 401. Cookie sessions unaffected. Verified in staging before prod.
</acceptance_criteria>

### H.4 Update docs
- `README.md`: replace "POST /api/auth/login" examples with "magic-link". Document the cookie session model.
- `CLAUDE.md`: new section "Auth model (post-Phase 07)" describing the cookie + license-gate model + agent `api_keys` decoupling + the exclusion list.
- `docs/auth.md` (new): full auth architecture doc (rule #21). Includes:
  - Sequence diagram of magic-link flow (text or mermaid).
  - License-gating exclusion list with rationale.
  - CSRF model.
  - Re-auth gate list.
  - D0/D7/D14/D14+1 calendar.
  - Migration runbook (from PLAN-E.3 — move here).
  - Rollback procedure.
- `hub/src/api/_openapi.ts`: document new `/api/auth/*` endpoints + `/webhooks/titanium/license-changed` + license status endpoint. Run `bun run docs:sync`.
<acceptance_criteria>
`bun run docs:sync` exits 0; `docs/openapi.json` + `docs/api.md` include the new endpoints. `docs/auth.md` exists and is linked from `README.md`. CI docs-drift check passes.
</acceptance_criteria>

### H.5 Defer to Phase 07.5 (DO NOT do here)
- `password_hash` column drop.
- `bcrypt` package removal from `package.json`.
- Removal of `hub/src/auth/password.ts`.
- Removal of `ALLOW_LEGACY_LOGIN` flag + the wrapped legacy code.
- Removal of `JWT_SECRET` env var (only after grep confirms zero remaining uses).

Plan H explicitly stops at "gated, hidden, code present." Phase 07.5 issue will be filed at completion.
<acceptance_criteria>
Phase 07.5 issue filed in `gh issue create` with checklist (5 items above). Issue URL referenced in `docs/auth.md`.
</acceptance_criteria>

</tasks>

**Outputs:** legacy login gated + hidden, JWT_SECRET rotated, docs current, follow-up issue filed.

**Verification:** post-cutover smoke: only magic-link flow works; legacy POST returns 410; existing browser tabs holding stale JWTs land on /login on next request.
