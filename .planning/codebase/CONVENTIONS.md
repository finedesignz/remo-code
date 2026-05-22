# Coding Conventions

**Analysis Date:** 2026-05-22

## Naming Patterns

**Files:**
- TypeScript modules: `kebab-case.ts` — e.g. `hub/src/ws/agent-protocol.ts`, `hub/src/auth/api-key-middleware.ts`, `hub/src/middleware/rate-limit.ts`, `agent/src/claude-runner.ts`, `agent/src/hub-client.ts`, `web/src/lib/auth.ts`
- React components: `PascalCase.tsx` — e.g. `web/src/components/ChatPanel.tsx`, `MessageBubble.tsx`, `ActivityFeed.tsx`, `ThinkingBlock.tsx`
- React hooks: `useCamelCase.ts` in `web/src/hooks/` — `useAuth.ts`, `useChat.ts`, `useTheme.ts`, `useWebSocket.ts`, `useSessions.ts`
- Schema/SQL: `lowercase.sql` — e.g. `hub/src/db/schema.sql`

**Functions:**
- `camelCase` for normal functions: `getUserByEmail`, `signJwt`, `findOrCreateAgentSession`, `loadConfig`
- `PascalCase` for React components: `function App()`, `export function AuthForm()`

**Variables:**
- `camelCase` locals: `tokenHash`, `sessionId`, `projectDir`
- `UPPER_SNAKE_CASE` for module-level constants: `VERSION = '0.3.6'` in `agent/src/index.ts`

**Types & Schemas:**
- `PascalCase` for types and Zod schemas: `HubToAgent`, `HubToClient`, `ClientSendMessage`, `ChannelAuth`, `AssistantMessage`
- Zod schemas declared in `PascalCase` matching the message `type` literal they validate (`hub/src/ws/protocol.ts`)

**Database columns / JSON payloads:**
- `snake_case` over the wire and in DB: `session_id`, `user_id`, `project_dir`, `token_hash`, `last_activity`, `created_at`, `password_hash`, `api_key`
- Web/agent code uses `snake_case` for WS payload fields to match the protocol exactly; internal locals stay `camelCase`

## Code Style

**Formatting:**
- No Prettier, ESLint, or Biome config in the repo. Style enforced by author convention only.
- Indentation: 2 spaces.
- Semicolons: **mixed** — hub `api/` files use semicolons (`hub/src/api/auth.ts`), hub `ws/` and most other files omit them (`hub/src/ws/protocol.ts`, `hub/src/index.ts`). When adding code, match the surrounding file.
- Quotes: single quotes dominant in `hub/src/ws/`, `hub/src/index.ts`, `agent/`, `web/`; double quotes in `hub/src/api/auth.ts` and `hub/src/db/dal.ts`. Match the file.
- Trailing commas in multi-line arrays/objects.

**Linting:**
- None configured. Do not introduce ESLint/Biome unless asked.

## TypeScript Usage

**Strictness:**
- `strict: true` everywhere. Confirmed in `web/tsconfig.json` (also `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `noEmit`, bundler resolution).
- `noUnusedLocals` / `noUnusedParameters` are **off** — unused vars are allowed.

**Module style:**
- ESM only (`"type": "module"` in every package).
- `allowImportingTsExtensions: true` — hub uses explicit `.ts` extensions in imports (`from "../db/dal.ts"`); web/agent typically omit extensions. Match the file.
- `isolatedModules: true` + `moduleDetection: force` → each file must be a module.

**Types:**
- Prefer `type` aliases + discriminated unions for protocol messages (see `HubToClient`, `HubToAgent` in `hub/src/ws/protocol.ts`).
- `interface` used for local option bags (e.g. `RateLimitOptions` in `hub/src/middleware/rate-limit.ts`).
- `unknown` for opaque payloads (`tool_input: unknown`); avoid `any` (one `as any` cast in `agent/src/index.ts:51` is acknowledged as a shortcut).

## Import Organization

**Order (observed in `hub/src/index.ts`, `web/src/App.tsx`):**
1. Third-party packages (`hono`, `react`, `zod`)
2. Local modules by feature, grouped roughly by layer (config → auth → api → ws)
3. Node built-ins last when present (`fs`, `path`)

**Path style:**
- Relative paths only (`./config`, `../db/dal.ts`). No path aliases configured.
- React imports use named imports: `import { useState, useEffect, useCallback } from 'react'`.
- Type-only imports use `import type { ... }` (`import type { AuthUser } from './lib/auth.ts'`, `import type { HubToAgent } from './types'`).

## File Organization

**Hub layout (`hub/src/`):**
- `index.ts` — Hono app wiring, security headers, CORS, route mounting, WS upgrade
- `config.ts` — env var loading
- `api/<resource>.ts` — one Hono sub-router per resource (`auth.ts`, `sessions.ts`, `messages.ts`, `api-keys.ts`, `setup.ts`, `profile.ts`, `plugin.ts`); export named router (e.g. `export const authRouter = new Hono()`)
- `auth/` — `jwt.ts`, `password.ts`, `middleware.ts`, `api-key-middleware.ts`
- `db/` — `postgres.ts` (postgres.js client), `dal.ts` (all SQL queries), `schema.sql`
- `middleware/` — cross-cutting (e.g. `rate-limit.ts`)
- `ws/` — `protocol.ts` (Zod schemas + outbound types), `client.ts`, `agent.ts`, `channel.ts`, `agent-protocol.ts`, `registry.ts`
- `utils/` — small helpers (`token.ts`)

**Web layout (`web/src/`):**
- `App.tsx`, `main.tsx`, `index.css`
- `components/` — one PascalCase file per component, flat (no nested folders)
- `hooks/` — one `useXxx.ts` per concern
- `lib/` — pure helpers (`auth.ts`)

**Agent layout (`agent/src/`):**
- `index.ts` — entry, CLI startup, pre-flight checks
- `config.ts`, `types.ts`, `hub-client.ts`, `claude-runner.ts`, `local-ui.ts`

## WebSocket Protocol & Zod Validation

All inbound WS messages MUST be validated with Zod before use. Pattern from `hub/src/ws/protocol.ts`:

```ts
export const ClientSendMessage = z.object({
  type: z.literal('send_message'),
  session_id: z.string().min(1).max(256),
  content: z.string().min(1).max(1_000_000),
  id: z.string().uuid(),
  images: z.array(z.object({
    media_type: z.string(),
    data: z.string().max(10_000_000),
  })).max(5).optional(),
})

export const ClientInbound = z.discriminatedUnion('type', [
  ClientAuth, ClientSendMessage, ClientSubscribe,
  ClientPermissionResponse, ClientQuestionResponse,
  z.object({ type: z.literal('pong') }),
])
```

**Rules:**
- Inbound payloads → Zod schemas (`Client*`, `Channel*`, `Agent*`)
- Outbound payloads → plain TypeScript discriminated union types (`HubToClient`, `HubToAgent`, `HubToChannel`). Hub constructs them, no runtime validation.
- Every schema includes explicit bounds: `.min`, `.max`, `.uuid()`, `.regex(/^remo_[A-Za-z0-9_\-]{43}$/)` for tokens.
- Use `z.discriminatedUnion('type', [...])` for top-level inbound messages.
- Always include the trivial `{ type: 'pong' }` in the inbound union for heartbeat.

## Error Handling

**Hono routes:**
- Validate inputs at top of handler; return `c.json({ error: '...' }, 4xx)` for client errors.
- Generic message for auth failures: `"Invalid credentials"` (never reveal whether email exists) — see `hub/src/api/auth.ts`.
- Setup/admin guarded by internal check (e.g. `countUsers() > 0` rejects registration after first admin).

**Global handler (`hub/src/index.ts`):**
```ts
app.onError((err, c) => {
  console.error('[error]', err.message)
  return c.json({ error: 'internal error' }, 500)
})
```
Never leak internal error details to clients. Log to `console.error` with a tag prefix `[error]`, `[remo-agent]`, etc.

**WebSocket:**
- Parse with `Schema.safeParse(...)`; on failure, close the socket or send `{ type: 'auth_error', error: '...' }`. Never throw out of a WS handler.
- 5s auth timeout, per-IP connection caps (20), per-connection message rate limits — enforced in `hub/src/ws/`.

**Agent:**
- Pre-flight checks fail fast with `process.exit(1)` and a helpful message (see `agent/src/index.ts` claude CLI check).
- Log prefix: `[remo-agent]`.

## Logging

**Framework:** `console.log` / `console.error` only. No structured logger.

**Conventions:**
- Tag prefix in brackets: `[error]`, `[remo-agent]`.
- Hub logs errors via the global `onError` handler.
- Agent forwards human-readable logs to the hub via `agent_log` WS messages (`sendLog(...)` in `agent/src/index.ts`).

## Security Headers & CORS

All set centrally in `hub/src/index.ts`:
- CSP, HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy, Permissions-Policy
- CORS scoped to `/api/*` only, origins from `config.allowedOrigins`
- Auth ordering: `/api/auth` and `/api/setup` are public; `/api/plugin/*` uses API key middleware (must be mounted **before** the JWT catch-all); `/api/*` after that is JWT-protected.

## Theming (CSS Custom Properties)

**Pattern:** Tailwind 4 + CSS variables on `<html>` class `.light` / `.dark`. Defined in `web/src/index.css`.

**Variable names (always reference via `var(--name)` in JSX):**
- Backgrounds: `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-input`
- Text: `--text-primary`, `--text-secondary`, `--text-muted`, `--text-on-accent`
- Chrome: `--border-color`, `--scrollbar-thumb`, `--scrollbar-hover`, `--code-bg`

**Usage in components:**
```tsx
<div className="bg-[var(--bg-primary)] text-[var(--text-muted)]">...</div>
```
Never hardcode hex colors in components. If a new visual concern is needed, add a `--name` to both `.light` and `.dark` blocks in `index.css`.

**Theme toggle:** `web/src/hooks/useTheme.ts` — persists to `localStorage` key `remo-theme`, falls back to `prefers-color-scheme`, toggles classes on `document.documentElement`.

## Function Design

**Size:** Small route handlers (5–30 lines). DAL functions are single-query wrappers.

**Parameters:**
- Positional args for ≤3 parameters (e.g. `createUser(email, hash, role)`).
- Object bag for option-heavy APIs (`rateLimit({ windowMs, max, keyFn })`).

**Return values:**
- DAL returns row objects or `null`, never throws on "not found" — use `rows[0] ?? null` pattern (`hub/src/db/dal.ts`).
- Async by default; never mix callbacks.

## Database Access

**Client:** `postgres` (postgres.js) tagged-template. Single instance exported from `hub/src/db/postgres.ts` as `sql`.

**Rules:**
- All SQL lives in `hub/src/db/dal.ts`. Route handlers never write inline SQL.
- Always parameterize: ``sql`SELECT ... WHERE id = ${sessionId}` `` — never string-concatenate.
- Every user-scoped query MUST include `WHERE user_id = ${userId}` (see `listSessions`, `getSession`).
- DAL function names: `verbResource` — `getSessionById`, `findSessionByProjectDir`, `findOrCreateAgentSession`, `countUsers`.

## Module Design

**Exports:**
- Named exports throughout; default export only for React `App.tsx`.
- No barrel (`index.ts` re-export) files; import directly from source module.

**React component conventions:**
- Function components only; no class components.
- Hooks at top of body; effects after state declarations.
- Props typed inline or via local `type Props = { ... }`.

---

*Convention analysis: 2026-05-22*
