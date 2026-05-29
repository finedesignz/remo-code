import { createSign } from 'crypto'

interface AppConfig {
  appId: string
  privateKey: string
  slug: string
}

function readConfig(): AppConfig | null {
  const appId = process.env.GITHUB_APP_ID
  let privateKey = process.env.GITHUB_APP_PRIVATE_KEY
  const slug = process.env.GITHUB_APP_SLUG
  if (!appId || !privateKey || !slug) return null
  // Allow private key as base64-encoded PEM or raw PEM with \n escapes
  if (!privateKey.includes('BEGIN')) {
    try { privateKey = Buffer.from(privateKey, 'base64').toString('utf-8') } catch {}
  }
  privateKey = privateKey.replace(/\\n/g, '\n')
  return { appId, privateKey, slug }
}

export function isGitHubAppConfigured(): boolean {
  return readConfig() !== null
}

export function getGitHubAppSlug(): string | null {
  return readConfig()?.slug ?? null
}

function b64url(buf: Buffer | string) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function signAppJwt(): string {
  const cfg = readConfig()
  if (!cfg) throw new Error('github app not configured')
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: cfg.appId,
  }))
  const signingInput = `${header}.${payload}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(cfg.privateKey)
  return `${signingInput}.${b64url(signature)}`
}

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<number, CachedToken>()

export async function getInstallationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const appJwt = signAppJwt()
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'remo-code-hub',
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`github token mint failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const data: any = await res.json()
  // GitHub returns ISO timestamp for expires_at; ~1 hour ahead
  const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : Date.now() + 50 * 60_000
  tokenCache.set(installationId, { token: data.token, expiresAt })
  return data.token as string
}

export async function githubApiGet<T = any>(installationId: number, path: string): Promise<T> {
  const token = await getInstallationToken(installationId)
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'remo-code-hub',
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`github api ${path} ${res.status} ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

/**
 * GitHub API call with body (POST/PUT/PATCH). Surfaces status code on error
 * via the thrown error's `.status` property so callers can branch on 422/405/etc.
 * 404 returns null (used by GET-or-create flows like `ensureBranch`).
 */
export class GitHubApiError extends Error {
  status: number
  body: string
  constructor(status: number, body: string, msg: string) {
    super(msg)
    this.status = status
    this.body = body
  }
}

export async function githubApiRequest<T = any>(
  installationId: number,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getInstallationToken(installationId)
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'remo-code-hub',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new GitHubApiError(res.status, text, `github api ${method} ${path} ${res.status} ${text.slice(0, 200)}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// App-level API calls (use app JWT directly, not installation token)
export async function githubAppApiGet<T = any>(path: string): Promise<T> {
  const appJwt = signAppJwt()
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'remo-code-hub',
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`github app api ${path} ${res.status} ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

export async function listInstallationRepos(installationId: number) {
  const all: any[] = []
  let page = 1
  while (true) {
    const data: any = await githubApiGet(installationId, `/installation/repositories?per_page=100&page=${page}`)
    const repos = data.repositories || []
    all.push(...repos)
    if (repos.length < 100) break
    page++
    if (page > 10) break // safety
  }
  return all.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    name: r.name,
    owner: r.owner.login,
    default_branch: r.default_branch,
    private: r.private,
    description: r.description,
    updated_at: r.updated_at,
    clone_url: r.clone_url,
  }))
}

export async function listBranches(installationId: number, owner: string, repo: string) {
  const data: any = await githubApiGet(installationId, `/repos/${owner}/${repo}/branches?per_page=100`)
  return data.map((b: any) => ({ name: b.name, sha: b.commit?.sha }))
}

// Build a one-shot tokenized clone URL (token in URL is intentional — supervisor strips after clone)
export async function mintTokenizedCloneUrl(installationId: number, owner: string, repo: string): Promise<string> {
  const token = await getInstallationToken(installationId)
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
}
