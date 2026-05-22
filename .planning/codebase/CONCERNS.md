# Codebase Concerns

**Analysis Date:** 2026-05-22

## Tech Debt

**Legacy `channel/` package & `/ws/channel` endpoint:**
- Issue: `channel/` workspace removed but `hub/src/ws/channel.ts` (177 lines) and the `/ws/channel` route are still wired into `hub/src/index.ts` (lines 103, 124–125, 158–179). `CLAUDE.md` says channel is legacy/back-compat. No active client uses it now.
- Files: `hub/src/ws/channel.ts`, `hub/src/index.ts`, `hub/src/db/dal.ts` (`createPluginSession`, `verifyChannelToken`)
- Impact: Dead code path with its own auth, rate limiting, and DB writes. Increases attack surface and maintenance burden.
- Fix approach: Confirm zero traffic on `/ws/channel`, then delete the route, the channel WS handler, `createPluginSession`, and the channel protocol schema. Drop the redundant `verifyChannelToken` path (agent flow uses `findOrCreateAgentSession` directly).

**Stale Supabase artifacts:**
- Issue: `supabase/migrations/001_initial.sql` … `005_allow_multiple_sessions_per_dir.sql` and the `supabase/` directory remain after the Supabase→Postgres migration (`docs/superpowers/plans/2026-04-27-migrate-supabase-to-postgres.md`). `README.md` and `web/src/vite-env.d.ts` still mention Supabase.
- Files: `supabase/migrations/*.sql`, `supabase/` (top-level), `README.md`, `web/src/vite-env.d.ts`
- Impact: Confusing for new contributors; risk of someone running the wrong migrations against the new Postgres DB.
- Fix approach: Delete `supabase/` after confirming `hub/src/db/schema.sql` is the canonical source. Strip Supabase references from README and `vite-env.d.ts`.

**Duplicate token-hashing utility lives in WS module:**
- Issue: `hashToken()` is exported from `hub/src/ws/channel.ts` (lines 35–40) and imported by `hub/src/auth/api-key-middleware.ts` and `hub/src/ws/agent.ts`. Layering violation — auth depends on a channel WS module.
- Files: `hub/src/ws/channel.ts`, `hub/src/auth/api-key-middleware.ts`, `hub/src/ws/agent.ts`
- Impact: Removing channel becomes harder; awkward import graph.
- Fix approach: Move `hashToken` (and `generateToken` from `hub/src/utils/token.ts`) into `hub/src/lib/crypto.ts` as proposed in stale PR #1.

**Stale open PR #1 `upstream-fixes`:**
- Issue: PR #1 (last updated 2026-03-21, ~14 days stale per memory) proposes shared crypto/api utils, hook leak fix in Layout, accessibility fixes, profile PATCH response fix, `TIER_LIMITS` Infinity → -1 fix, `Promise.all` parallelization, `useCallback` wrapping. Pre-dates the Supabase→Postgres migration — likely conflicts with the rewritten `hub/src/api/profile.ts`, `auth/middleware.ts`, and hooks. References `TIER_LIMITS` which no longer exists post-`004_remove_saas.sql`.
- Impact: Useful fixes are rotting. Merge will be conflict-heavy.
- Fix approach: Cherry-pick the non-Supabase-coupled wins (handler leak in `web/src/components/Layout.tsx`, accessibility on Sidebar, `Promise.all` opportunities, profile PATCH return shape) into a fresh branch off `main`. Close PR #1.

**WIP `web/src/components/ConnectModal.tsx`:**
- Issue: 24 lines added (per `git diff --stat`), uncommitted in working tree.
- Files: `web/src/components/ConnectModal.tsx`
- Impact: Risk of loss; unclear whether shippable.
- Fix approach: Review, commit if intended (likely "Generate New API Key" button + alias copy block), or revert.

**Pending migration plan still in `plans/`:**
- Issue: `docs/superpowers/plans/2026-04-27-migrate-supabase-to-postgres.md` is the active plan but core migration commits already landed (e4161f7, 2114eaa, 0a11e43, 2117dae, 3450ad7). Plan may be partially done.
- Impact: Source of truth ambiguity.
- Fix approach: Audit plan checklist against current code, mark done items, file follow-ups for the rest, then archive.

## Known Bugs

**`verifyApiKey` return shape mismatch with `apiKeyMiddleware`:**
- Symptoms: `hub/src/auth/api-key-middleware.ts:19-20` does `c.set('userId', keyData.user_id)` and `c.set('apiKeyId', keyData.id)`. But `hub/src/db/dal.ts:110-117` `verifyApiKey()` returns **a bare string** (`rows[0].user_id as string`), not an object. So `keyData.user_id` is `undefined` (string property access yields undefined) and `apiKeyId` is also undefined.
- Files: `hub/src/db/dal.ts` (lines 110–117), `hub/src/auth/api-key-middleware.ts` (lines 13–20)
- Trigger: Any request to `/api/plugin/*` using `remokey_…` Bearer auth. Downstream handlers reading `c.get('userId')` will get undefined and likely 401/empty queries.
- Workaround: None currently; agent uses WS `/ws/agent` which calls `verifyApiKey` directly and uses the returned string correctly (`hub/src/ws/agent.ts:71`).
- Fix: Either change `verifyApiKey` to return `{ user_id, id }` (matching what middleware expects and `verifyApiKey` previously did per PR #1 description), or change middleware to `c.set('userId', keyData)` and drop `apiKeyId`.

**Agent auto-restart loop on persistent Claude CLI failure:**
- Symptoms: `agent/src/claude-runner.ts:122-139` blindly restarts after 3s on any non-zero exit. If `claude` is not installed, OAuth missing, or `--dangerously-skip-permissions` rejected, the agent will respawn forever, spamming logs and the hub status feed.
- Files: `agent/src/claude-runner.ts`
- Trigger: Missing `claude` binary; revoked OAuth; corrupted resume id.
- Fix: Add exponential backoff and a max-attempt cap; surface a hard error to the hub after N consecutive immediate failures.

## Security Considerations

**No login throttling / brute-force protection on `/api/auth/login`:**
- Risk: `hub/src/api/auth.ts` has no per-IP or per-email rate limit. The generic `rateLimit({ max: 120/min, keyFn: userId })` in `index.ts:76` only applies AFTER `authMiddleware`, so it does not cover `/api/auth/*` (mounted before it at line 64). Bcrypt rounds=12 slows attackers but does not stop credential stuffing.
- Files: `hub/src/api/auth.ts`, `hub/src/index.ts` (lines 63-76), `hub/src/middleware/rate-limit.ts`
- Current mitigation: Generic identical error string ("Invalid credentials"); 8-char password minimum; registration locked after first user.
- Recommendations: Add `rateLimit({ windowMs: 60_000, max: 10, keyFn: c => c.req.header('cf-connecting-ip')||'anon' })` in front of `/api/auth/login`. Consider account lockout after N failures per email.

**JWT lifetime is 30 days with no refresh / revocation:**
- Risk: `hub/src/auth/jwt.ts:15` signs with `expiresIn: "30d"` (HS256). No `jti`, no allow/deny list, no `iat` rotation. A leaked token (e.g., XSS, accidental log) is valid for a month and cannot be invalidated without rotating `JWT_SECRET` (which logs everyone out).
- Files: `hub/src/auth/jwt.ts`, `hub/src/auth/middleware.ts`
- Current mitigation: HTTPS only via CSP `connect-src 'self' wss:` and HSTS header.
- Recommendations: Shorter access tokens (15–60 min) + refresh token in httpOnly cookie, or a token revocation table keyed by `jti`. At minimum, support rotating `JWT_SECRET` per-user via a `users.token_version` column.

**JWT secret silently falls back to empty string in dev:**
- Risk: `hub/src/config.ts:4` sets `jwtSecret: process.env.JWT_SECRET || ""`. The length check in `hub/src/auth/jwt.ts:4` throws on import, but only because `""` is < 32 chars. If someone sets `JWT_SECRET` to anything ≥ 32 chars in dev, the boot succeeds with a weak value.
- Files: `hub/src/config.ts`, `hub/src/auth/jwt.ts`
- Recommendations: Fail fast on `!process.env.JWT_SECRET` in `config.ts` rather than relying on length check. Add an entropy check or require base64-encoded 256-bit value.

**Database URL has hardcoded default with credentials:**
- Risk: `hub/src/config.ts:3` defaults to `postgresql://postgres:postgres@localhost:5432/remocode`. If `DATABASE_URL` is unset in production by mistake, the hub silently connects to a local-default DSN that may exist with weak creds.
- Fix: Throw on missing `DATABASE_URL` in production.

**API keys have no expiry and no scoping:**
- Risk: `api_keys` table (`hub/src/db/schema.sql:38-49`) has `revoked_at` but no `expires_at`. Only one active key per user (unique index). One key = full account control via `/ws/agent`. Long-lived keys are stored as SHA-256 (not bcrypt) — fast to crack if the hash leaks.
- Files: `hub/src/db/schema.sql`, `hub/src/api/api-keys.ts`, `hub/src/db/dal.ts` (`verifyApiKey`)
- Current mitigation: `remokey_` prefix + 32 random bytes = ~256 bits entropy; SHA-256 is fine for high-entropy secrets.
- Recommendations: Add `expires_at` column + rotation flow; consider per-key scopes (read-only browse vs. agent connect).

**WebSocket rate limits are per-connection, not per-user:**
- Risk: `hub/src/ws/client.ts:13` MSG_RATE_MAX = 30/10s per *connection*. Per-IP cap is 100 connections (`hub/src/index.ts:88`). A single attacker IP can therefore send 3000 msg/10s if it opens 100 sockets — and behind Cloudflare, `cf-connecting-ip` collapses to one IP only for one client; multiple users behind the same NAT share the 100 budget (DoS each other).
- Files: `hub/src/index.ts:87-94, 112-119`, `hub/src/ws/client.ts:84-90`, `hub/src/ws/agent.ts:46-51`, `hub/src/ws/channel.ts:121-128`
- Recommendations: Cap per *user* once authenticated (e.g., 5 connections / 50 msg/s); accept that per-IP NAT collisions need a higher ceiling but enforce per-user as authoritative.

**Per-IP WS limit derived from untrusted headers:**
- Risk: `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` read directly from request (`hub/src/index.ts:114`). If the server is exposed without a fronting proxy, a client can spoof these headers to bypass the 100/IP cap entirely.
- Mitigation: Document that the server must run behind Cloudflare/Coolify reverse proxy. Optionally: only trust forwarded headers when remote address is in a known proxy CIDR.

**JWT subscribe/auth path leaks 1015 close-code timing:**
- Risk: `hub/src/ws/client.ts:36-40, 65` closes with `4001 Unauthorized` only on bad JWT. Browser distinguishes valid-but-wrong-user from invalid-token via the close code. Low impact.
- Files: `hub/src/ws/client.ts`

**Origin check applies only to `/ws/client`:**
- Risk: `hub/src/index.ts:103-110` validates origin only for the browser socket. `/ws/agent` and `/ws/channel` accept any origin (intentional — they're called from native clients). But this also means a malicious site running JS could open `/ws/agent` and brute-force API keys without an origin block.
- Mitigation: Agent endpoint already requires a valid `remokey_` and has 120 msg/10s cap; brute-force at that rate is infeasible against 256-bit keys. Acceptable, but worth documenting.

**Stored XSS surface via embedded image data URIs in chat history:**
- Risk: `hub/src/ws/client.ts:147-153` builds markdown `![image-N](data:image/...;base64,...)` and persists it. If the web renderer ever switches to a markdown lib that accepts arbitrary URI schemes (`javascript:`), this becomes XSS via malicious base64-prefixed payloads. Currently safe — depends on the markdown sanitizer in the web UI.
- Files: `hub/src/ws/client.ts`, web markdown renderer (verify `MessageBubble.tsx` uses DOMPurify or react-markdown defaults)

**Agent runs Claude CLI with `--dangerously-skip-permissions`:**
- Risk: `agent/src/claude-runner.ts:83` always passes `--dangerously-skip-permissions`. Combined with the agent forwarding `permission_request` events to the browser, the permission UI exists but the CLI flag overrides it. Any compromised browser session can drive arbitrary shell/file operations on the user's dev machine.
- Files: `agent/src/claude-runner.ts:77-83`
- Recommendations: Either remove the flag and rely on the explicit `permission_request` round-trip, or make the flag opt-in via CLI arg / config with prominent warning.

## Performance Bottlenecks

**`broadcastToSubscribers` JSON-stringifies per-recipient (suspected):**
- Problem: In `hub/src/ws/agent.ts:121-123, 133-140`, every `thinking`, `text_delta`, `tool_use`, `tool_result` event triggers a broadcast. For a chatty Claude session with N subscribed browsers, each event is potentially re-serialized N times depending on `registry.ts` implementation.
- Files: `hub/src/ws/registry.ts` (not read here — verify), `hub/src/ws/agent.ts`
- Fix: Stringify once outside the per-recipient loop.

**`pushSessionList` after every channel connect / disconnect:**
- Problem: `hub/src/ws/channel.ts:171-176` and `hub/src/ws/agent.ts:108, 199-203` call `listSessions(userId)` and broadcast the full list on every connect/close. For a user with many sessions reconnecting frequently, this is O(sessions) DB query per event.
- Fix: Diff-based session updates, or cache last list per user with TTL.

**In-memory rate-limit map grows unbounded between purges:**
- Problem: `hub/src/middleware/rate-limit.ts:14-22` purges every 60s. Between purges, an attacker can flood unique `keyFn` values (e.g., spoofed auth headers via `c.req.header('authorization')?.slice(0, 20)` for plugin route) to inflate the map.
- Files: `hub/src/middleware/rate-limit.ts`, `hub/src/index.ts:70`
- Fix: Cap map size; LRU eviction.

## Fragile Areas

**Session resume by `project_dir` string match:**
- Files: `hub/src/db/dal.ts:25-32, 45-60`, `agent/src/claude-runner.ts`
- Why fragile: Path normalization is `replace(/\\/g, '/')` in `hub/src/ws/agent.ts:77` only. Trailing slash, case sensitivity (Windows!), symlinks, and `~` expansion can all create duplicate sessions for "the same" directory.
- Safe modification: Canonicalize via `path.resolve` + lowercase on Windows before insert/lookup.
- Test coverage: None observed.

**Agent reconnect unregisters but doesn't close old WS:**
- Files: `hub/src/ws/agent.ts:84-89`
- Why fragile: Comment explicitly says "don't close — the old WS may already be dead". If the old WS is *not* dead, two live agents claim the same session and both try to write to Claude's stdin via separate spawned processes. Ghost agents linger until heartbeat ping fails.
- Safe modification: Send a `kick` message + grace period before unregistering, then force-close.

**`channel/` workspace referenced in `bun.lock` and root `package.json` (verify):**
- Why fragile: If the workspace is half-removed (manifest gone but lockfile retains it), `bun install` behavior diverges between fresh and incremental installs.
- Fix approach: Run `bun install` on a clean clone and diff `bun.lock`.

## Scaling Limits

**In-memory client/channel registry (`hub/src/ws/registry.ts`):**
- Current capacity: Single-process. All subscribed clients and channels live in process memory.
- Limit: Hub cannot scale horizontally — a second hub instance would not see sessions registered on the first.
- Scaling path: Move registry to Redis pub/sub or use sticky sessions at the load balancer with cross-instance broadcasts.

**Single active API key per user:**
- Current: `idx_api_keys_user_active` unique index where `revoked_at IS NULL` (`hub/src/db/schema.sql:48`). Creating a new key revokes the old one (`createApiKey` in `dal.ts:127`).
- Limit: User cannot run agents on two machines with separate keys.
- Scaling path: Drop the unique constraint; add UI to list/manage multiple keys.

## Dependencies at Risk

**`bcryptjs` instead of native `bcrypt`:**
- Risk: `bcryptjs` is pure-JS, ~5x slower than native `bcrypt`. Rounds=12 means each login takes meaningful CPU under load. Bun supports `bcrypt` natively via `Bun.password`.
- Files: `hub/src/auth/password.ts`
- Migration plan: Replace with `Bun.password.hash(plain, { algorithm: 'bcrypt', cost: 12 })` and `Bun.password.verify(...)`. Migration is transparent — same hash format.

**`jsonwebtoken`:**
- Risk: Maintained but mature. Consider `jose` (audited, WebCrypto-based) for future-proof JWT handling, especially if moving to EdDSA / asymmetric signing.

## Missing Critical Features

**No password reset flow:**
- Problem: Forgotten password = locked account forever (registration closes after first admin in `hub/src/api/auth.ts:24`). No email/reset endpoint.
- Blocks: Single-user self-hosted is OK, but any multi-user expansion needs reset.

**No email verification:**
- Problem: `users.email` is just a string. No proof of ownership.
- Blocks: Password reset, transactional notifications.

**No audit log:**
- Problem: API key generation/revocation, login, session deletion all happen without an audit trail.
- Blocks: Incident forensics if a key leaks.

**No structured logging:**
- Problem: All logging is `console.log("[area] message")`. Hard to filter, query, or alert on in production.
- Fix: Adopt `pino` or similar; log JSON in production.

## Test Coverage Gaps

**Zero automated tests detected:**
- What's not tested: Everything. No `*.test.ts` / `*.spec.ts` files found via Glob. No `jest.config.*` / `vitest.config.*` in repo root.
- Files: All of `hub/src/**`, `agent/src/**`, `web/src/**`
- Risk: Every refactor (e.g., resolving PR #1) requires manual smoke testing. Subtle regressions like the `verifyApiKey` return-shape bug above can ship undetected.
- Priority: **High** — at minimum, integration tests for `/api/auth/login`, `/api/auth/register`, `/ws/agent` auth, `/ws/client` auth + send_message, and `verifyApiKey`.

**No CI checks visible:**
- `tsc --noEmit` and `bun run build:web` are not in any GitHub Action (no `.github/workflows/` mentioned). Typescript errors can land on `main`.
- Priority: **Medium** — add a CI workflow that runs `bun install`, type-checks all workspaces, and builds web.

## Flagged TODOs / FIXMEs

**Single TODO in repo:**
- `docs/superpowers/plans/2026-03-28-streaming-agent-architecture.md:568`: "TODO: handle images (save to temp file, reference in prompt) — Phase 2"
- Status: Image handling has shipped (`agent/src/claude-runner.ts:153-170` builds image blocks inline). This TODO is stale — update or remove the plan doc.

No FIXME / HACK / XXX comments in source code.

---

*Concerns audit: 2026-05-22*
