import { Hono } from 'hono'
import {
  isGitHubAppConfigured, getGitHubAppSlug,
  listInstallationRepos, listBranches, githubAppApiGet,
} from '../auth/github-app'
import {
  saveGitHubInstallation, listInstallations, getInstallation,
} from '../db/supervisor-dal'
import { signJwt, verifyJwt } from '../auth/jwt'

export const github = new Hono()

function require503IfNotConfigured(c: any) {
  if (!isGitHubAppConfigured()) {
    return c.json({ error: 'github app not configured on hub' }, 503)
  }
  return null
}

github.get('/install_url', (c) => {
  const blocked = require503IfNotConfigured(c)
  if (blocked) return blocked
  const slug = getGitHubAppSlug()
  const userId = c.get('userId') as string
  // Pass user-id signed as state so the callback can attribute the install.
  const state = signJwt({ sub: userId, role: 'install', email: '' }, 600) // 10 min
  const url = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`
  return c.json({ url })
})

// Callback receives ?installation_id, ?setup_action, ?state
// state is a short-lived JWT containing the user's id (signed when they hit /install_url).
github.get('/callback', async (c) => {
  const installationIdStr = c.req.query('installation_id')
  const state = c.req.query('state')
  if (!installationIdStr) return c.redirect('/#/supervisor?github=error&msg=missing_installation_id')
  const installationId = Number(installationIdStr)
  if (!Number.isFinite(installationId)) return c.redirect('/#/supervisor?github=error&msg=bad_installation_id')

  // Resolve user: prefer state JWT, fall back to single-user lookup.
  let userId: string | null = null
  if (state) {
    try { userId = verifyJwt(state).sub } catch {}
  }
  if (!userId) {
    // Single-tenant fallback: only safe when there's exactly one user in the DB.
    const { countUsers } = await import('../db/dal')
    const { sql } = await import('../db/postgres')
    const count = await countUsers()
    if (count === 1) {
      const rows = await sql`SELECT id FROM users LIMIT 1`
      userId = rows[0]?.id ?? null
    }
  }
  if (!userId) return c.redirect('/#/supervisor?github=error&msg=no_user_context')

  let accountLogin = 'unknown'
  let accountType = 'User'
  try {
    const inst: any = await githubAppApiGet(`/app/installations/${installationId}`)
    accountLogin = inst.account?.login ?? 'unknown'
    accountType = inst.account?.type ?? 'User'
  } catch (err: any) {
    console.error('[github callback] account lookup failed', err.message)
  }
  await saveGitHubInstallation({ installationId, userId, accountLogin, accountType })
  return c.redirect('/#/supervisor?github=connected')
})

// Sync: query GitHub for all installations of this App and persist them.
// Useful when the install was done directly on github.com without our /install_url flow.
github.get('/sync', async (c) => {
  if (!isGitHubAppConfigured()) return c.json({ error: 'github app not configured' }, 503)
  const userId = c.get('userId') as string
  try {
    const installs: any[] = await githubAppApiGet('/app/installations')
    let saved = 0
    for (const inst of installs) {
      await saveGitHubInstallation({
        installationId: inst.id,
        userId,
        accountLogin: inst.account?.login ?? 'unknown',
        accountType: inst.account?.type ?? 'User',
      })
      saved++
    }
    return c.json({ ok: true, saved })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

github.get('/installations', async (c) => {
  const userId = c.get('userId') as string
  let rows = await listInstallations(userId)
  // If we have none but the App is configured, auto-sync from GitHub.
  // Handles the case where the user installed directly via github.com without going through /install_url.
  if (rows.length === 0 && isGitHubAppConfigured()) {
    try {
      const installs: any[] = await githubAppApiGet('/app/installations')
      for (const inst of installs) {
        await saveGitHubInstallation({
          installationId: inst.id,
          userId,
          accountLogin: inst.account?.login ?? 'unknown',
          accountType: inst.account?.type ?? 'User',
        })
      }
      rows = await listInstallations(userId)
    } catch (err: any) {
      console.error('[github] auto-sync failed', err.message)
    }
  }
  return c.json({ installations: rows, configured: isGitHubAppConfigured() })
})

github.get('/repos', async (c) => {
  const blocked = require503IfNotConfigured(c)
  if (blocked) return blocked
  const userId = c.get('userId') as string
  const installations = await listInstallations(userId)
  const out: any[] = []
  for (const inst of installations as any[]) {
    try {
      const repos = await listInstallationRepos(inst.id)
      for (const r of repos) out.push({ ...r, installation_id: inst.id, account: inst.account_login })
    } catch (err: any) {
      console.error('[github repos]', inst.id, err.message)
    }
  }
  return c.json({ repos: out })
})

github.get('/repos/:owner/:repo/branches', async (c) => {
  const blocked = require503IfNotConfigured(c)
  if (blocked) return blocked
  const userId = c.get('userId') as string
  const owner = c.req.param('owner')
  const repo = c.req.param('repo')
  const installations = await listInstallations(userId)
  for (const inst of installations as any[]) {
    try {
      const branches = await listBranches(inst.id, owner, repo)
      return c.json({ branches })
    } catch {}
  }
  return c.json({ error: 'no installation matches this repo' }, 404)
})
