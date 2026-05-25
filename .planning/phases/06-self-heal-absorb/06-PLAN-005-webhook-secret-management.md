---
phase: 06-self-heal-absorb
plan: 005
type: execute
wave: 2
depends_on: [06-PLAN-001-schema-migration]
files_modified:
  - hub/src/api/profile.ts
  - hub/src/db/dal.ts
  - web/src/components/SettingsPage.tsx
  - hub/test/coolify-webhook-secret.test.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "User can rotate their Coolify webhook secret via JWT-authed endpoint"
    - "Rotate returns a freshly-generated UUID secret and the webhook URL once"
    - "User can view current secret presence (boolean) but rotate is required to reveal a new value"
    - "Settings page surfaces the webhook URL and rotate button"
  artifacts:
    - path: "hub/src/api/profile.ts"
      provides: "POST /api/account/coolify-webhook-secret/rotate + GET /api/account/coolify-webhook-secret"
    - path: "web/src/components/SettingsPage.tsx"
      provides: "Coolify Webhook section under existing Account/Profile tab"
  key_links:
    - from: "POST /api/account/coolify-webhook-secret/rotate"
      to: "users.coolify_webhook_secret"
      via: "DAL update with gen_random_uuid()"
---

<objective>
Endpoint + UI for managing the per-user Coolify webhook signing secret. JWT-authed. Generates a UUID-v4 on rotate, returns it once, persists in `users.coolify_webhook_secret`.

Purpose: Required to enable plan 004's webhook route per user.
Output: Two API routes, DAL helper, Settings UI block.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@hub/src/api/profile.ts
@hub/src/db/dal.ts
@web/src/components/SettingsPage.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add rotate + status endpoints under /api/account/coolify-webhook-secret</name>
  <files>hub/src/api/profile.ts, hub/src/db/dal.ts</files>
  <read_first>
    - hub/src/api/profile.ts (existing JWT-authed endpoint patterns in this file)
    - hub/src/db/dal.ts (existing DAL update patterns + `sql` template tag usage)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"Auth + secrets"
  </read_first>
  <action>In `hub/src/db/dal.ts` add: `async function rotateUserCoolifyWebhookSecret(userId: string): Promise<string>` — runs `UPDATE users SET coolify_webhook_secret = gen_random_uuid()::text, updated_at = now() WHERE id = $1 RETURNING coolify_webhook_secret` and returns the new value; `async function getUserCoolifyWebhookStatus(userId: string): Promise<{ configured: boolean }>` — returns `{ configured: true }` if `coolify_webhook_secret IS NOT NULL`. In `hub/src/api/profile.ts` add two routes under the existing JWT-guarded section: `GET /api/account/coolify-webhook-secret` returning `{ configured: boolean, webhook_url: string }` where `webhook_url = `${process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com'}/api/coolify/webhook/${userId}``; `POST /api/account/coolify-webhook-secret/rotate` returning `{ secret: string, webhook_url: string, header_format: 'X-Coolify-Signature: sha256=<hex>', timestamp_header: 'X-Coolify-Timestamp' }`. The secret is shown ONCE; subsequent GETs return only `configured: true` (never the secret value).</action>
  <verify>
    <automated>cd hub ; bun test test/coolify-webhook-secret.test.ts</automated>
  </verify>
  <done>JWT-authed rotate returns a UUID secret + webhook URL; GET returns configured flag + URL; unauthed call returns 401.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Endpoint tests</name>
  <files>hub/test/coolify-webhook-secret.test.ts</files>
  <read_first>
    - hub/test/scheduled-tasks.e2e.test.ts (auth fixture + JWT minting pattern, REMO_E2E_DB_URL gating)
  </read_first>
  <behavior>
    - Unauthenticated POST/GET → 401
    - First POST rotate → returns a 36-char UUID secret + webhook_url string
    - Second POST rotate → returns a DIFFERENT secret value
    - GET after rotate → `configured: true`, no `secret` field in response
    - GET before any rotate (fresh user) → `configured: false`
  </behavior>
  <action>Create `hub/test/coolify-webhook-secret.test.ts` with `bun:test`. Mint a JWT for a test user using the same secret as the hub. Make HTTP calls against the in-test Hono app. Skip on missing `REMO_E2E_DB_URL`.</action>
  <verify>
    <automated>cd hub ; REMO_E2E_DB_URL=$REMO_E2E_DB_URL bun test test/coolify-webhook-secret.test.ts</automated>
  </verify>
  <done>All five behaviors pass.</done>
</task>

<task type="auto">
  <name>Task 3: Settings UI — Coolify Webhook section</name>
  <files>web/src/components/SettingsPage.tsx</files>
  <read_first>
    - web/src/components/SettingsPage.tsx (find the Account/Profile tab — existing section patterns: card layout, --bg-secondary, indigo button, copy-to-clipboard helpers if any)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md (decisions)
    - ~/.claude/CLAUDE.md "Frontend / CSS Conventions" (subtle, not bordered; indigo accent; rounded-xl cards)
  </read_first>
  <action>Add a new card under the Account/Profile tab titled "Coolify Webhook". On mount, `fetch('/api/account/coolify-webhook-secret', { headers: { Authorization: 'Bearer ' + token } })` and render: webhook URL (monospace, with a Copy button), configured status, and a "Rotate Secret" indigo button. Clicking rotate posts to the rotate endpoint, displays the returned secret in a copyable readonly field with a one-time warning ("This secret is shown only once. Copy it now."), and shows a brief 2-line Coolify setup hint pointing to the two required headers (`X-Coolify-Signature: sha256=<hex>`, `X-Coolify-Timestamp: <unix-seconds>`). Use existing CSS tokens (`bg-[var(--bg-secondary)]/60`, `rounded-xl`, `p-5`, indigo button `bg-indigo-600 hover:bg-indigo-500`). No new dependencies.</action>
  <verify>
    <automated>cd web ; bun run build</automated>
  </verify>
  <done>Build green; Settings → Account/Profile tab shows a new "Coolify Webhook" card with URL display + Rotate button + post-rotate one-time secret reveal.</done>
</task>

</tasks>

<verification>
- API tests green.
- `bun run build:web` green.
- Manual: rotate from UI, copy secret, use it in plan 004's webhook → 202.
</verification>

<success_criteria>
- Secret rotation is JWT-only; never leaked on subsequent GETs.
- UI gives users a one-time copy moment with clear warning.
- Webhook URL displayed matches what plan 004 mounts.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-005-SUMMARY.md` when done.
</output>
