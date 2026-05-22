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
  if (!installationIdStr || !state) return c.text('missing params', 400)
  let userId: string
  try {
    const payload = verifyJwt(state)
    userId = payload.sub
  } catch {
    return c.text('invalid state', 400)
  }
  const installationId = Number(installationIdStr)
  if (!Number.isFinite(installationId)) return c.text('bad installation_id', 400)

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

github.get('/installations', async (c) => {
  const userId = c.get('userId') as string
  const rows = await listInstallations(userId)
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
