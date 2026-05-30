# Coding Conventions

**Analysis Date:** 2026-05-28

## Naming Patterns

**Files:**
- TS source: `kebab-case.ts` (e.g. `session-queue.ts`, `coolify-webhook.ts`, `auto-name.ts`).
- React components: `PascalCase.tsx` (e.g. `SettingsPage.tsx`, `MessageBubble.tsx`, `ChatSurface.tsx`).
- UI primitives live in `web/src/components/ui/` and re-export through `index.ts`.
- Tests: `<unit>.test.ts` colocated under `hub/test/` or `supervisor/test/` (NOT next to source).
- E2E tests: `<feature>.e2e.test.ts` (e.g. `scheduled-tasks.e2e.test.ts`, `phase-08.e2e.test.ts`).

**Functions / vars:** `camelCase`. **Types / React components:** `PascalCase`. **Constants:** `SCREAMING_SNAKE_CASE` for env keys + module-scope literal sets (e.g. `SCAN_DIRS`, `EXCLUDE_FILE_SUFFIXES`).

**Zod schemas:** `<Name>Schema` suffix (`CreateSchema`, `TaskTypeEnum`).

## Code Style

**Formatting:** No prettier/eslint config committed at repo root. Style is consistent-by-convention:
- 2-space indent.
- Single quotes for strings.
- No semicolons in TS (e.g. `hub/src/api/scheduled-tasks.ts`).
- ESM imports with explicit `.ts` extension on intra-repo paths (Bun-native): `from '../db/dal.ts'`.

**TypeScript:**
- Hub has NO `tsconfig.json` and NO `typecheck` script — typing enforced at Bun runtime + `bun test`. Do NOT add `tsc --noEmit` to hub CI without first adding a tsconfig.
- `web/` uses `tsc -b && vite build` for build-time type checking. Strict React 19 + TS 5.7.
- Supervisor: TS source compiled to a sidecar binary via `bun build --compile`.

**Imports — order:**
1. Node/Bun built-ins (`node:fs`, `bun:test`).
2. Third-party (`hono`, `zod`, `croner`).
3. Intra-repo relative paths (`../db/dal.ts`).

Use named imports. Avoid default exports except for React components and Hono sub-apps.

## Error Handling

**Patterns:**
- Zod-validate all external boundaries: WS frames (`hub/src/ws/protocol.ts`, `agent-protocol.ts`), REST bodies (each `api/*.ts` declares its `*Schema`), webhook payloads, env config (`hub/src/config.ts`).
- Webhook + intake endpoints: read RAW body BEFORE JSON parse for HMAC verification. Constant-time signature compare. Reject `>5 min` timestamp skew.
- Internal errors: `try/catch` with structured `console.log`/`console.warn` prefixed by module (`[scheduler]`, `[supervisor]`, `[agent]`).
- Post-run / side-effect failures are LOG-ONLY — never fail the parent run (see `hub/src/scheduler/post-run/github-issue.ts`).
- Hono routes return JSON `{ error: '<code>' }` with HTTP status; never throw past the router boundary.

## Logging

**Framework:** `console.log` / `console.warn` / `console.error`. No structured logger lib.

**Conventions:**
- Prefix with bracket tag: `[supervisor]`, `[hub]`, `[scheduler]`, `[agent]`, `[webhook]`.
- Log security-relevant events (auth failures, HMAC mismatches, rate-limit hits, license-gate denials) at `warn`.
- Never log secrets, tokens, full JWTs, full webhook signatures, or env values.

## Comments

**When to comment:**
- Module-level doc block at top of every `hub/src/**` file explaining purpose + invariants (see `hub/test/scheduler.test.ts:1-22`, `hub/src/api/scheduled-tasks.ts:1-13`).
- Inline comments for non-obvious invariants (HMAC raw-body discipline, idempotency keys, cost-cap enforcement, license-gate exclusion list).
- `// Phase NN:` comments mark behavior pinned to a specific delivery phase (do NOT remove without phase-aware review).

**JSDoc/TSDoc:** Used on exported helpers in `hub/src/scheduler/`, `hub/src/error-capture/`, and `supervisor/src/`. Plain `/** */` blocks, not full TSDoc tags.

## Function Design

- Pure logic modules (`scheduler/cron.ts`, `scheduler/auto-name.ts`, `error-capture/fingerprint.ts`) export small named functions, no classes.
- DAL functions live in `*-dal.ts` files (`hub/src/db/dal.ts`, `scheduled-tasks-dal.ts`, `supervisor-dal.ts`, `revanote-dal.ts`). One function per query. Always `WHERE user_id = $1` for user-scoped tables.
- Hono routers exported as named `Hono` instance per file (e.g. `export const scheduledTasks = new Hono()`).

## Module Design

- One Hono sub-router per concern under `hub/src/api/`, mounted in `hub/src/index.ts`.
- OpenAPI-aware routes live in `hub/src/api/_openapi.ts` (or a sibling `OpenAPIHono`) and MUST be mounted BEFORE the plain-Hono twin or the twin must be deleted.
- No barrel `index.ts` except for `web/src/components/ui/index.ts` (UI primitive re-exports).

## Design Tokens (UI)

CSS custom properties on `:root` (defined in `web/src/index.css`):
- BG: `--bg-primary` (page), `--bg-secondary` (cards/panels), `--bg-tertiary` (hover/inputs).
- Text: `--text-primary`, `--text-secondary`, `--text-muted`, `--text-on-accent`.
- Borders: `--border-color` (sparingly).
- Code: `--code-bg`.

**Aesthetic rules (per global `~/.claude/design-preferences.md` + repo CLAUDE.md):**
- **Subtle, not bordered.** Cards = `bg-[var(--bg-secondary)]/60` over `bg-[var(--bg-primary)]`. Reserve borders for active state, modals, header separators.
- **Radius:** `rounded-xl` cards/dialogs, `rounded-lg` inputs/buttons/list items, `rounded` chips. **NEVER** `rounded-2xl` or larger.
- **Accent:** **blue** (migrated indigo→blue, milestone v-settings-overhaul; orange = primary-CTA only; **never indigo** — `web/test/no-indigo.test.ts` guards). Primary buttons `bg-blue-600 hover:bg-blue-500`. Active `bg-blue-600/20 ring-1 ring-blue-500/30`. Tokens in `~/.claude/design-preferences.md`.
- **Status colors:** emerald (good), amber (warn), red (error), gray (offline). Solid icons at 400, soft bg at /20 + ring.
- **Padding:** card `p-5`, input/button `px-3 py-2`, list item `px-3 py-2`.
- **Spacing:** `space-y-4`/`5` between sections, `gap-2`/`3` inline.
- **Headers:** card heading `text-sm font-semibold text-[var(--text-primary)]`. Captions `text-xs text-[var(--text-muted)]`.
- **Forbidden:** custom hex, drop shadows beyond default, gradients, `shadow-2xl+`, `rounded-2xl+`.

Canonical reference: `web/src/components/SettingsPage.tsx`.

## UI Primitives

All in `web/src/components/ui/` — re-exported via `index.ts`. Use these instead of bespoke markup:

| Primitive | File | Use for |
|-----------|------|---------|
| `AppShell` | `AppShell.tsx` | Page chrome / sidebar layout |
| `Card` | `Card.tsx` | Panel + section container |
| `Modal` | `Modal.tsx` | Centered dialog |
| `Drawer` | `Drawer.tsx` | Side-panel (run details, error detail) |
| `Tabs` | `Tabs.tsx` | Settings sub-nav |
| `Button` | `Button.tsx` | All buttons (variants: primary/secondary/ghost/danger) |
| `Field` | `Field.tsx` | Form input wrapper (label + hint + error) |
| `StatusPill` | `StatusPill.tsx` | Status chips (success / failure / pending / disabled) |
| `EmptyState` | `EmptyState.tsx` | No-rows placeholder |
| `LoadingState` | `LoadingState.tsx` | Spinner / skeleton |
| `ErrorBoundary` | `ErrorBoundary.tsx` | Wrap pages to catch render errors |
| `HeaderRight` | `HeaderRight.tsx` | Top-right header slot (license badge + nav) |

When adding a new surface, compose primitives first; introduce a new primitive only if 3+ places need the same shape.

## Git Workflow

**Branch naming:**
- `feat/<slug>` — new feature
- `fix/<slug>` — bug fix
- `refactor/<slug>` — non-behavioral change
- `chore/<slug>` — deps / tooling / docs
- `phase-<NN>-<slug>` — GSD phase work

**Worktree discipline (MANDATORY — repo CLAUDE.md):**
- Main session stays on `main` in `C:\Users\artic\GitHub\remo-code`.
- Every feature/phase gets its own worktree: `git worktree add ../remo-code-<slug> -b <branch> origin/main`.
- All implementation, planning docs (`.planning/phases/<NN>-<slug>/`), agent dispatches happen in the worktree — NEVER the main checkout (parallel sessions wipe untracked files).
- After merge: `git worktree remove ../remo-code-<slug> ; git branch -D <branch>`.

**Commit messages:**
- Conventional-commit-ish: `feat(scope): summary`, `fix(scope): summary`, `chore(scope): summary`.
- Scope examples: `scheduler`, `webhook`, `auth`, `web`, `supervisor`, `07-bypass`, `coolify-webhook`.
- Body explains the WHY + invariants touched. Reference phase + plan IDs when applicable.

**PR hygiene:**
- One branch = one concern = one PR.
- Run `gh pr list` periodically to surface stale branches.
- Squash-merge with `--delete-branch`.

## Docs Co-Update Rule

Per repo CLAUDE.md, code changes in these areas MUST update the matching doc in the SAME commit:

| Code area | Doc to update |
|-----------|---------------|
| `hub/src/scheduler/**`, scheduler tests | `docs/scheduled-tasks.md` |
| `hub/src/error-capture/**`, error intake | `docs/error-capture.md` |
| Grid / multichat (`GridPage`, `ChatSurface`, `MobileAccordion`) | `docs/grid-view.md` |
| Codex runner / rootless / seed files | `docs/codex-and-rootless.md` |
| Auth / license / magic-link / sessions | `docs/auth.md` |
| Coolify webhook (`hub/src/api/coolify-webhook.ts`) | `docs/scheduled-tasks.md` + `docs/coolify-webhook-migration.md` |
| Any `hub/src/api/**` route migrated to OpenAPI | run `bun run docs:sync`; commit `docs/openapi.json` + `docs/api.md` |

CI workflow `.github/workflows/docs-drift.yml` fails PRs that change `hub/src/**` without a matching spec update.

---

*Convention analysis: 2026-05-28*
