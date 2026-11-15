// hub/src/corch/aaf-provision.ts
//
// CORCH-08 (CORCH-R5.7): make an enrolled repo an AgentAutofix project by calling AAF's
//   POST {REMO_CORCH_AAF_URL}/api/projects/provision   body { repo_slugs: ["owner/name"], installation_id }
//   Authorization: Bearer {REMO_CORCH_AAF_TOKEN}       (a token with scope projects:write)
// and record the outcome on corch_projects (aaf_provision_status, aaf_project_id).
//
// FAIL CLOSED: any failure (env unset, bad URL, network error, timeout, non-200, malformed body, repo missing
// from the reply) is `aaf_unprovisioned`, which the dispatcher never dispatches. Provisioning NEVER throws and
// never blocks enrollment. The token is read only to build one Authorization header: it is never logged, stored
// or returned. The AAF response is untrusted data: only a well-formed project id for the SAME repo is kept.

import { aafProvisionConfig } from './flag.ts'
import type { CorchProject, CorchStore } from './store.ts'

export type ProvisionOutcome =
  | { status: 'provisioned'; aafProjectId: string }
  | { status: 'aaf_unprovisioned'; reason: string }

export interface ProvisionDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}

const REAL_DEPS: ProvisionDeps = { fetch: (url, init) => fetch(url, init) }
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 256 * 1024
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

/** github://owner/name -> owner/name, or null when the ident is not a github one. */
export function repoSlugFromIdent(repoIdent: string): string | null {
  const m = /^github:\/\/([a-z0-9._-]+)\/([a-z0-9._-]+)$/.exec(repoIdent)
  return m ? `${m[1]}/${m[2]}` : null
}

export async function provisionRepoIdent(repoIdent: string, deps: ProvisionDeps = REAL_DEPS): Promise<ProvisionOutcome> {
  const unprovisioned = (reason: string): ProvisionOutcome => ({ status: 'aaf_unprovisioned', reason })
  const cfg = aafProvisionConfig()
  if (cfg.state !== 'on') return unprovisioned(cfg.state === 'off' ? 'env_unset' : cfg.signature)
  const slug = repoSlugFromIdent(repoIdent)
  if (!slug) return unprovisioned('not_a_github_repo')
  try {
    const res = await deps.fetch(`${cfg.baseUrl}/api/projects/provision`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ repo_slugs: [slug], installation_id: cfg.installationId }),
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (res.status !== 200) return unprovisioned(`http_${res.status}`)
    const text = await res.text()
    if (text.length > MAX_RESPONSE_BYTES) return unprovisioned('bad_response')
    const parsed: any = JSON.parse(text)
    const list = Array.isArray(parsed?.projects) ? parsed.projects : null
    if (!list) return unprovisioned('bad_response')
    const hit = list.find((p: any) => typeof p?.repo_slug === 'string' && p.repo_slug.toLowerCase() === slug)
    const id = hit?.project_id
    if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) return unprovisioned('bad_response')
    return { status: 'provisioned', aafProjectId: id }
  } catch (err: any) {
    // Error NAME only: the message could echo a URL or response text.
    return unprovisioned(err?.name === 'TimeoutError' ? 'timeout' : 'unreachable')
  }
}

/**
 * Provision one enrolled project and persist the result. Never throws. An already provisioned project is left
 * alone (provisioning is idempotent at AAF, but a transient failure must not downgrade a provisioned project).
 */
export async function provisionProject(
  store: Pick<CorchStore, 'setProvisionResult'>,
  project: CorchProject,
  deps: ProvisionDeps = REAL_DEPS,
): Promise<CorchProject> {
  if (project.aaf_provision_status === 'provisioned') return project
  try {
    const out = await provisionRepoIdent(project.repo_ident, deps)
    if (out.status === 'aaf_unprovisioned') {
      console.warn(`[corch] aaf provision project=${project.id}: ${out.reason}`)
      return project // already aaf_unprovisioned (the early return above covers provisioned): nothing to write
    }
    const updated = await store.setProvisionResult(project.id, {
      status: 'provisioned',
      aafProjectId: out.aafProjectId,
    })
    return updated ?? project
  } catch (err: any) {
    console.warn(`[corch] aaf provision record failed project=${project.id}: ${err?.message ?? err}`)
    return project
  }
}

export interface ProvisionExistingSummary {
  total: number
  provisioned: number
  failed: number
}

/** One-shot backfill for projects enrolled before CORCH-08 (hub/scripts/corch-provision-existing.ts). Idempotent. */
export async function provisionExisting(
  store: Pick<CorchStore, 'listUnprovisionedProjects' | 'setProvisionResult'>,
  deps: ProvisionDeps = REAL_DEPS,
): Promise<ProvisionExistingSummary> {
  const todo = await store.listUnprovisionedProjects()
  let provisioned = 0
  for (const p of todo) {
    const after = await provisionProject(store, p, deps)
    if (after.aaf_provision_status === 'provisioned') provisioned++
  }
  return { total: todo.length, provisioned, failed: todo.length - provisioned }
}
