/**
 * Phase 12 W2 — PATCH /api/users/me/prompts + PATCH /api/users/me/profile.
 *
 * Validation + secret-stripping paths. DAL is stubbed so no DB needed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { Hono } from 'hono'

let lastPromptsPatch: any = null
let lastProfilePatch: any = null

const stubUpdatePrompts = mock(async (uid: string, patch: any) => {
  lastPromptsPatch = patch
  return {
    auto_nudge_idle_sessions: patch.auto_nudge_idle_sessions ?? false,
    claude_global_md: patch.claude_global_md ?? null,
    codex_agents_md: patch.codex_agents_md ?? null,
    codex_config_toml: patch.codex_config_toml ?? null,
  }
})

const stubUpdateProfileExt = mock(async (uid: string, patch: any) => {
  lastProfilePatch = patch
  return {
    id: uid,
    display_name: patch.display_name ?? null,
    avatar_url: patch.avatar_url ?? null,
    timezone: patch.timezone ?? 'UTC',
    notifications: patch.notifications ?? {},
  }
})

// Spread real modules so cross-test imports of unrelated symbols still resolve.
const realDalUsers = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({
  ...realDalUsers,
  updateUserPrompts: stubUpdatePrompts,
  updateUserProfileExt: stubUpdateProfileExt,
}))

// api/supervisors (which exports usersMe) imports budget + supervisor-dal +
// supervisor-registry + ws/registry + github-app. Sibling tests mock these
// partially; spread real surfaces so cross-load order doesn't break.
const realBudgetUM = await import('../src/sessions/budget.ts')
mock.module('../src/sessions/budget.ts', () => ({ ...realBudgetUM }))
const realSupDalUM = await import('../src/db/supervisor-dal.ts')
mock.module('../src/db/supervisor-dal.ts', () => ({ ...realSupDalUM }))
const realSupRegUM = await import('../src/ws/supervisor-registry.ts')
mock.module('../src/ws/supervisor-registry.ts', () => ({ ...realSupRegUM }))
const realWsRegUM = await import('../src/ws/registry.ts')
mock.module('../src/ws/registry.ts', () => ({ ...realWsRegUM }))
const realGhAppUM = await import('../src/auth/github-app.ts')
mock.module('../src/auth/github-app.ts', () => ({ ...realGhAppUM }))

let app: Hono
beforeAll(async () => {
  const { usersMe } = await import('../src/api/supervisors')
  app = new Hono()
  app.use('/api/users/me/*', async (c, next) => {
    c.set('userId', 'u1' as any)
    return next()
  })
  app.route('/api/users/me', usersMe)
})

async function patch(path: string, body: any): Promise<Response> {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/users/me/prompts', () => {
  test('200 with all valid fields', async () => {
    const res = await patch('/api/users/me/prompts', {
      auto_nudge_idle_sessions: true,
      claude_global_md: '# claude',
      codex_agents_md: '# agents',
      codex_config_toml: 'model = "gpt-5"',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.auto_nudge_idle_sessions).toBe(true)
    expect(body.stripped_secret_lines).toBe(0)
  })

  test('strips secret-looking lines from codex_config_toml', async () => {
    const res = await patch('/api/users/me/prompts', {
      codex_config_toml: 'model = "gpt-5"\napi_key = "sk-bad"\ntoken = "x"\nsecret = "y"\npassword = "z"\nfoo = "ok"',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stripped_secret_lines).toBe(4)
    expect(lastPromptsPatch.codex_config_toml).not.toContain('api_key')
    expect(lastPromptsPatch.codex_config_toml).toContain('foo')
  })

  test('null clears a blob', async () => {
    const res = await patch('/api/users/me/prompts', { codex_agents_md: null })
    expect(res.status).toBe(200)
    expect(lastPromptsPatch.codex_agents_md).toBeNull()
  })

  test('400 on wrong type', async () => {
    const res = await patch('/api/users/me/prompts', { auto_nudge_idle_sessions: 'yes' })
    expect(res.status).toBe(400)
  })

  test('empty body is a no-op 200', async () => {
    const res = await patch('/api/users/me/prompts', {})
    expect(res.status).toBe(200)
  })
})

describe('PATCH /api/users/me/profile', () => {
  test('200 setting display_name + timezone', async () => {
    const res = await patch('/api/users/me/profile', {
      display_name: 'Mike',
      timezone: 'America/Los_Angeles',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.display_name).toBe('Mike')
    expect(body.timezone).toBe('America/Los_Angeles')
  })

  test('`name` alias maps to display_name', async () => {
    const res = await patch('/api/users/me/profile', { name: 'Alias' })
    expect(res.status).toBe(200)
    expect(lastProfilePatch.display_name).toBe('Alias')
  })

  test('400 on invalid timezone', async () => {
    const res = await patch('/api/users/me/profile', { timezone: 'Mars/Olympus' })
    expect(res.status).toBe(400)
  })

  test('400 on non-data: avatar_url', async () => {
    const res = await patch('/api/users/me/profile', { avatar_url: 'https://evil/img.png' })
    expect(res.status).toBe(400)
  })

  test('accepts data:image/png;base64,...', async () => {
    const res = await patch('/api/users/me/profile', {
      avatar_url: 'data:image/png;base64,AAAA',
    })
    expect(res.status).toBe(200)
  })

  test('null clears avatar', async () => {
    const res = await patch('/api/users/me/profile', { avatar_url: null })
    expect(res.status).toBe(200)
    expect(lastProfilePatch.avatar_url).toBeNull()
  })

  test('notifications JSONB blob passes through', async () => {
    const res = await patch('/api/users/me/profile', {
      notifications: { email_digest: true, web_push: false },
    })
    expect(res.status).toBe(200)
    expect(lastProfilePatch.notifications.email_digest).toBe(true)
  })
})
