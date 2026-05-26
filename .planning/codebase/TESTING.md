# Testing Patterns

> **Note (Phase 09, 2026-05-26):** The agent/ workspace and channel/ plugin are retired. The local CLI runner now lives in supervisor/src/ and ships exclusively as a Tauri MSI desktop app. The hub /ws/agent route is unchanged. References below to agent/, npx remo-code-agent, claude-remote, or /ws/channel are historical. See .planning/phases/09-retire-npm-packages/.


**Analysis Date:** 2026-05-22

## Test Framework

**None configured.**

The repo has **zero project-owned tests**. No `vitest.config.*`, `jest.config.*`, `bun:test` files, or `*.test.ts` / `*.spec.ts` files exist under `hub/`, `web/`, `agent/`, or `channel/`. The only `*.test.ts` files in the tree live inside `node_modules/` (zod, fast-uri, style-to-js, etc.) and are not run by this project.

**Package scripts (root `package.json`):**
```json
"scripts": {
  "dev:hub": "cd hub && bun run dev",
  "dev:web": "cd web && bun run dev",
  "build:web": "cd web && bun run build"
}
```
No `test`, `test:watch`, or `coverage` script in any package.json (root, `hub/`, `web/`, `agent/`).

**Assertion library:** None installed.

**Runner:** Bun ships with `bun test` out of the box and is the natural choice if tests are added — no install needed.

## Test File Organization

Not applicable — no convention has been established. If/when tests are added, the natural placement given the existing layout would be:
- Co-located: `hub/src/auth/jwt.test.ts` next to `jwt.ts`
- Or grouped: `hub/test/` mirroring `hub/src/`

No precedent has been set.

## What Is Tested

**Nothing automatically.** All validation today is:

1. **TypeScript strict mode** — `strict: true` across all tsconfigs catches type errors at build time. Web build runs `tsc -b && vite build`.
2. **Zod runtime validation** on WS inbound messages (`hub/src/ws/protocol.ts`, `hub/src/ws/agent-protocol.ts`). This is the closest thing to a test boundary in the codebase — schemas reject malformed payloads at the edge.
3. **Manual smoke testing** via the dev hub + web + local agent loop documented in `CLAUDE.md` and `README.md`.

## What Is NOT Tested (Gaps)

This is a thorough list because the gaps are total. Priorities reflect security/correctness impact.

### High priority

- **Auth flow** (`hub/src/api/auth.ts`, `hub/src/auth/jwt.ts`, `hub/src/auth/password.ts`)
  - bcrypt hash/verify round-trip
  - JWT sign + verify, expiry behavior, tampered-token rejection
  - Login lockout / generic error messages (currently returns same `"Invalid credentials"` for bad email vs bad password — verified by reading code, not by test)
  - Registration-closed enforcement (`countUsers() > 0` check)
- **API key lifecycle** (`hub/src/api/api-keys.ts`, `hub/src/auth/api-key-middleware.ts`, `hub/src/utils/token.ts`)
  - SHA-256 hash storage and verification
  - `remo_` prefix + 32-byte base64url format enforcement (the regex `/^remo_[A-Za-z0-9_\-]{43}$/` is asserted only at the protocol Zod boundary)
  - Revocation
- **WebSocket protocol schemas** (`hub/src/ws/protocol.ts`)
  - Each discriminated-union variant accepts valid payloads and rejects:
    - missing `type`
    - oversize `content` (>1MB)
    - >5 images
    - oversize image data (>10MB base64)
    - malformed UUID `id`
    - bad token regex
  - Outbound type construction (no runtime check today)
- **Session ownership scoping** (`hub/src/db/dal.ts`)
  - Every user-scoped DAL function (`listSessions`, `getSession`, `findSessionByProjectDir`, etc.) must refuse cross-user access. This is enforced by `WHERE user_id = $1` clauses — but there is no test that proves a userId mismatch returns null/empty.
  - `findOrCreateAgentSession` token rotation behavior
- **Rate limiting** (`hub/src/middleware/rate-limit.ts`)
  - Window reset, 429 with `Retry-After` header, in-memory map purge
  - Per-IP WS connection cap (20), per-connection message rate limit (referenced in `CLAUDE.md`, implemented in `hub/src/ws/`)

### Medium priority

- **Hub WS handlers** (`hub/src/ws/client.ts`, `agent.ts`, `channel.ts`)
  - Auth timeout (5s)
  - Heartbeat ping/pong
  - Message relay between agent ↔ client subscribers
  - Session resume by `project_dir`
- **Agent stream-json parsing** (`agent/src/claude-runner.ts`)
  - Parsing of `thinking`, `text_delta`, `tool_use`, `tool_result`, `assistant_message` events
  - Behavior when Claude CLI exits unexpectedly
  - Queueing of user messages while runner is not yet ready (`runner.isReady` branch in `agent/src/index.ts`)
- **Agent config loading** (`agent/src/config.ts`) — precedence: CLI args > env vars > `~/.config/remo-code/config.json`
- **File attachment handling** — text embedding vs base64 image data URI, 10MB cap
- **Security headers** — CSP, HSTS, frame-ancestors actually emitted on every response
- **CORS** — `allowedOrigins` enforcement

### Lower priority

- **React hooks** (`web/src/hooks/`) — `useChat`, `useWebSocket` reconnect logic, `useTheme` localStorage round-trip, `useSessions` polling/subscribe behavior
- **React components** — `MessageBubble` markdown rendering with `rehype-sanitize`, `ToolUseBlock` / `ThinkingBlock` rendering, `FileAttachmentBar` drop/paste behavior
- **Setup form** flow (`web/src/components/SetupForm.tsx` + `hub/src/api/setup.ts`) — only first-admin path
- **Hash-based routing** in `web/src/App.tsx`

## Coverage

**Coverage tool:** None. **Coverage requirement:** None enforced.

Current effective coverage of production code: **0%** automated, 100% manual smoke.

## Test Types

- **Unit tests:** None.
- **Integration tests:** None.
- **E2E tests:** None. No Playwright/Cypress config, though a `.playwright-mcp/` directory exists at repo root (likely MCP tooling, not a configured test suite).
- **Type tests:** Implicit via `tsc -b` on web build only. Hub and agent rely on Bun's runtime TS — no separate `tsc --noEmit` check is wired into a script.

## Recommended Minimum if Tests Are Introduced

If adding tests, use `bun test` (zero-config, already available):

```bash
bun test                  # run all tests
bun test --watch          # watch mode
bun test --coverage       # coverage (built in)
```

**Priority order for first tests:**
1. `hub/src/ws/protocol.ts` Zod schemas — pure functions, highest leverage, no setup
2. `hub/src/auth/jwt.ts` + `password.ts` — pure crypto, easy to assert
3. `hub/src/utils/token.ts` — token format + hash
4. `hub/src/db/dal.ts` against a throwaway Postgres (e.g. testcontainers or a dedicated test DB) — proves `user_id` scoping
5. Agent stream-json parser — feed canned Claude output, assert emitted events

## Honest Summary

This is a small, fast-moving open-source project where the author has chosen to skip automated tests in favor of TypeScript strictness, Zod boundary validation, and manual testing on `app.remo-code.com`. The codebase is structured cleanly enough that tests could be bolted on incrementally without a rewrite — but as of 2026-05-22, none exist, and there is no testing convention to follow.

---

*Testing analysis: 2026-05-22*
