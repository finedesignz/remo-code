# 07-PLAN-J: TEMPLATE.md extraction (the user's primary deliverable)

**Stage:** J
**Wave:** 4 (depends on H — concrete experience informs the template)
**Mode:** standard
**TDD:** N/A (writing artifact)
**Requirements:** (none — this is the cross-app deliverable; meta-requirement of the phase per CONTEXT.md)

<read_first>
- All prior 07-* docs in this phase
- `~/.claude/plans/cheeky-watching-crystal.md` — Stage J intent
- `~/.claude/CLAUDE.md` rules #16, #17, #18, #21
- `_templates/bun-hono-app/` (if exists in GitHub root) — template starter convention
</read_first>

<tasks>

### J.1 Write `.planning/phases/07-titanium-auth-cutover/TEMPLATE.md`
- Top section: **What this template is** — a stack-agnostic checklist for porting any app in the portfolio onto Titanium Licensing auth (identity + license-gating + audit + CSRF + session model). Reusable verbatim per global rule #16.
- Section: **Stage-by-stage checklist** (10 stages A–J) — each stage one paragraph, agnostic of stack, citing the locked decisions (alg pinning, opaque sessions, dual-auth window, email-collision policy, exclusion list, etc.).
- Section: **Email-collision policy** — copy verbatim from CONTEXT.md. This is load-bearing for every consuming app.
- Section: **D0/D7/D14/D14+1 calendar** — copy verbatim from CONTEXT.md.
- Section: **Exclusion-list pattern** — guidance: every app explicitly opts public routes / webhook handlers / agent endpoints OUT of license-gating; gating is opt-out, not opt-in.
- Section: **16-row test matrix** — generalized from PLAN-I.
- Section: **Per-stack adapters** — table:

  | Stack | Auth-middleware location | Cookie API | JWKS lib | Redis client | Magic-link email | Rate-limit lib | Reference impl |
  |---|---|---|---|---|---|---|---|
  | Bun + Hono | `hub/src/auth/middleware.ts` style | `c.req.header('Cookie')` + manual `Set-Cookie` | `jose` | `ioredis` | emails4agents (rule #7) | `hub/src/middleware/rate-limit.ts` | **THIS PHASE** — remo-code Phase 07 |
  | Next.js App Router | `middleware.ts` + route handlers | `cookies()` from `next/headers` | `jose` | `ioredis` | emails4agents | `@upstash/ratelimit` if Redis present | TBD |
  | Express | `app.use(authMiddleware)` | `cookie-parser` | `jose` | `ioredis` | emails4agents | `express-rate-limit` | TBD |
  | FastAPI | dep-injection per route | `Request.cookies` / `Response.set_cookie` | `pyjwt[crypto]` + `cryptography` | `redis-py` | emails4agents (via HTTP) | `slowapi` | claude-code-cli-gateway Phase 02 (architect template) |
  | Tauri desktop | local file-backed session | OS keychain + local file | `jose` (TS-side) | none (local-only) | OS browser for magic-link via deep-link plugin | none (single-user) | TBD |

- Section: **Environment variables** — canonical names (every app uses the same env var names):
  - `TITANIUM_KEYGEN_API_URL`, `TITANIUM_ACCOUNT_ID`, `TITANIUM_PRODUCT_ID`, `TITANIUM_PORTAL_TOKEN`, `TITANIUM_ADMIN_TOKEN`, `TITANIUM_REDIS_URL`, `TITANIUM_LICENSE_CACHE_TTL_SECONDS`, `MAGIC_LINK_SECRET`, `SESSION_SECRET`, `ALLOW_LEGACY_LOGIN`, optionally `TITANIUM_WEBHOOK_SECRET`.
  - Each app sets its own `TITANIUM_PRODUCT_ID` (one Keygen Product per app).
- Section: **DB schema deltas** — canonical column names (every app reuses):
  - On user table: `titanium_subject`, `titanium_email`, `last_titanium_sync_at`, `license_status`, `license_id`, `license_checked_at`, `titanium_link_status`, `candidate_subject`; `password_hash` becomes nullable.
  - New tables: `auth_sessions`, `auth_events`. **Note for adapters with naming conflicts** (remo-code's existing `sessions` table for Claude convos): rename to `auth_sessions` — never overload.
- Section: **Anti-patterns** (Karpathy rule #11):
  - Don't bundle stages — one commit per A–J.
  - Don't centralize JWT shape across apps; each app owns its own context vars.
  - Don't add ORM "while we're here."
  - Don't share the same `MAGIC_LINK_SECRET` across apps — per-app secret.
  - Don't share the `__Host-` cookie name across apps — per-app prefix (`__Host-remo_sid`, `__Host-cgw_sid`, etc.).
- Section: **Open questions to ask the user BEFORE starting any app's cutover**:
  1. Keygen Product ID for this app — exists?
  2. License model — per-user or per-tenant?
  3. Webhook availability for `license.changed`?
  4. Existing rate-limit + security-headers middleware in this app — present?
  5. Cookie name to use (`__Host-<slug>_sid`).
  6. List of public/webhook/agent routes to OPT OUT of license-gating.
- Section: **Rollback recipe** — `ALLOW_LEGACY_LOGIN=true` redeploy; keep `password_hash` for ≥1 release.
- Footer: link back to the reference implementations:
  - `C:\Users\artic\GitHub\remo-code\.planning\phases\07-titanium-auth-cutover\` (Bun/Hono — this phase)
  - `C:\Users\artic\GitHub\claude-code-cli-gateway\.planning\phases\02-titanium-auth-cutover\` (FastAPI — architect template)
- Header note: **this template lives at `~/.claude/plans/titanium-auth-cutover-TEMPLATE.md` after Phase 07 completes** (copy to global plans dir so future apps find it without needing remo-code clone).
<acceptance_criteria>
File exists at the planning path. Every section listed above is present. Mermaid sequence diagram for the magic-link flow included (text-mode acceptable). Linked from `docs/auth.md`. After Phase 07 ships: copied to `~/.claude/plans/titanium-auth-cutover-TEMPLATE.md` (documented in Phase H or in the post-cutover commit).
</acceptance_criteria>

### J.2 Cross-link to global rules
- Append a line to `~/.claude/CLAUDE.md` rule #16 referencing the template path. **This is a global-rules edit — confirm with user before applying.** If user confirms during execution, the planner adds it; if not, leave `~/.claude/CLAUDE.md` untouched and just put the template under `.planning/phases/07-titanium-auth-cutover/TEMPLATE.md`.
<acceptance_criteria>
EITHER the global CLAUDE.md edit is made AND committed in a separate commit on user's settings repo (if tracked), OR a TODO is documented in the phase's `docs/auth.md` noting the template path for future portfolio cutovers.
</acceptance_criteria>

</tasks>

**Outputs:** the cross-app reusable TEMPLATE.md.

**Verification:** content review by user. The phase's primary success criterion (per CONTEXT.md "TEMPLATE.md ... PRIMARY DELIVERABLE") is met when the user accepts the template as portfolio-ready.
