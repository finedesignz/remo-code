// hub/src/corch/routes.ts
//
// CORCH-01: enrollment + enqueue routes.
//   cookie  /api/corch/projects   POST, GET, PATCH /:id
//   cookie  /api/corch/work-items POST, GET
//   ext     POST /api/ext/corch/work-items  (explicit ext:corch scope, enforced in extApiKeyMiddleware)
// With the flag OFF these only store and list rows: the evaluate trigger is a no-op (CORCH-R1.2).
// API-key rejection on the cookie routes comes from the existing authMiddleware (no corch-local auth).

import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { corchStore, type CorchProject, type CorchStore, type CorchWorkItem } from './store.ts'
import { corchEnabled } from './flag.ts'
import { provisionProject } from './aaf-provision.ts'

type Env = { Variables: { userId: string } }

const REPO_IDENT_RE = /^github:\/\/[a-z0-9._-]+\/[a-z0-9._-]+$/

/** Lowercased canonical github://owner/repo, or an error code. */
function canonicalIdent(raw: string): { ok: true; ident: string } | { ok: false; error: string } {
  const ident = raw.trim().toLowerCase()
  if (ident.startsWith('path://')) return { ok: false, error: 'path_ident_not_supported' }
  if (!REPO_IDENT_RE.test(ident)) return { ok: false, error: 'invalid_repo_ident' }
  return { ok: true, ident }
}

/** Injected so route tests need no module mocks. The default lazily imports the dispatcher (LD-2). */
export interface RouteDeps {
  store: CorchStore
  evaluate(userId: string): Promise<void>
  /** CORCH-08: provision the repo at AAF and persist the result. Never throws; failure leaves aaf_unprovisioned. */
  provision(project: CorchProject): Promise<CorchProject>
}

const REAL_ROUTE_DEPS: RouteDeps = {
  store: corchStore,
  evaluate: async (userId) => (await import('./dispatcher.ts')).evaluateUserNow(userId),
  // Flag OFF is a true no-op: no AAF call and no write. Projects enrolled while OFF are backfilled with
  // hub/scripts/corch-provision-existing.ts at cutover.
  provision: async (project) => (corchEnabled() ? provisionProject(corchStore, project) : project),
}

/** Fire-and-forget evaluate trigger. Never awaited in the response path; never touches the DB when OFF. */
function triggerEvaluate(deps: RouteDeps, userId: string): void {
  if (!corchEnabled()) return
  void deps
    .evaluate(userId)
    .catch((err) => console.warn(`[corch] evaluate trigger failed user=${userId}: ${err?.message ?? err}`))
}

const ProjectCreate = z.object({
  repo_ident: z.string().min(1).max(300),
  priority: z.number().int().default(0),
  daily_token_budget: z.number().int().positive().default(2_000_000),
  enabled: z.boolean().default(true),
  accept_external: z.boolean().default(false),
})

const ProjectPatch = z.object({
  priority: z.number().int().optional(),
  daily_token_budget: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  accept_external: z.boolean().optional(),
})

const WorkItemFields = {
  title: z.string().min(1).max(500),
  body: z.string().max(20000).default(''),
  priority: z.number().int().default(0),
  source_ref: z.string().min(1).max(200).optional(),
}

const CookieWorkItem = z.object({ project_id: z.string().uuid(), ...WorkItemFields })

const ExtWorkItem = z.object({
  repo_ident: z.string().min(1).max(300),
  source: z.enum(['aaf', 'memlog', 'manual']),
  title: WorkItemFields.title,
  body: WorkItemFields.body,
  priority: WorkItemFields.priority,
  source_ref: z.string().min(1).max(200),
})

const STATUSES = ['queued', 'running', 'pr_open', 'done', 'blocked', 'cancelled'] as const

export function createCorchRoutes(deps: RouteDeps = REAL_ROUTE_DEPS): Hono<Env> {
  const corchRoutes = new Hono<Env>()

  corchRoutes.post('/projects', async (c) => {
    const userId = c.get('userId')
    let body: z.infer<typeof ProjectCreate>
    try {
      body = ProjectCreate.parse(await c.req.json())
    } catch (err: any) {
      return c.json({ error: 'bad_request', detail: err?.message }, 400)
    }
    const ident = canonicalIdent(body.repo_ident)
    if (!ident.ok) return c.json({ error: ident.error }, 400)
    const r = await deps.store.createProject({
      userId,
      repoIdent: ident.ident,
      priority: body.priority,
      dailyTokenBudget: body.daily_token_budget,
      enabled: body.enabled,
      acceptExternal: body.accept_external,
    })
    // CORCH-08: enrolling calls AAF provision. It never throws and never blocks enrollment: any failure (or unset
    // env) leaves the project aaf_unprovisioned (not dispatchable).
    const project = await deps.provision(r.project).catch(() => r.project)
    return c.json({ project, created: r.created }, r.created ? 201 : 200)
  })

  corchRoutes.get('/projects', async (c) => {
    return c.json({ projects: await deps.store.listProjects(c.get('userId')) })
  })

  corchRoutes.patch('/projects/:id', async (c) => {
    const userId = c.get('userId')
    let body: z.infer<typeof ProjectPatch>
    try {
      body = ProjectPatch.parse(await c.req.json())
    } catch (err: any) {
      return c.json({ error: 'bad_request', detail: err?.message }, 400)
    }
    // A non-UUID id would raise a Postgres cast error (500): it can match no project, so it is a 404.
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'project_not_found' }, 404)
    const r = await deps.store.updateProject(userId, id, {
      priority: body.priority,
      dailyTokenBudget: body.daily_token_budget,
      enabled: body.enabled,
      acceptExternal: body.accept_external,
    })
    if (!r) return c.json({ error: 'project_not_found' }, 404)
    // CORCH-08: re-enabling retries provisioning (an already provisioned project is left alone).
    let project = r.project
    if (!r.previousEnabled && r.project.enabled) {
      project = await deps.provision(r.project).catch(() => r.project)
      triggerEvaluate(deps, userId)
    }
    return c.json({ project })
  })

  corchRoutes.post('/work-items', async (c) => {
    const userId = c.get('userId')
    let body: z.infer<typeof CookieWorkItem>
    try {
      body = CookieWorkItem.parse(await c.req.json())
    } catch (err: any) {
      return c.json({ error: 'bad_request', detail: err?.message }, 400)
    }
    const project = await deps.store.getProject(userId, body.project_id)
    if (!project) return c.json({ error: 'project_not_found' }, 404)
    const r = await deps.store.enqueueWorkItem({
      userId,
      projectId: project.id,
      source: 'manual',
      sourceRef: body.source_ref ?? `manual:${randomUUID()}`,
      title: body.title,
      body: body.body,
      priority: body.priority,
    })
    if (r.created) triggerEvaluate(deps, userId)
    return c.json({ item: r.item, created: r.created }, r.created ? 201 : 200)
  })

  corchRoutes.get('/work-items', async (c) => {
    const raw = c.req.query('status')
    if (raw !== undefined && !(STATUSES as readonly string[]).includes(raw)) {
      return c.json({ error: 'bad_request', detail: 'invalid status' }, 400)
    }
    const items: CorchWorkItem[] = await deps.store.listWorkItems(c.get('userId'), (raw as CorchWorkItem['status']) ?? null, 200)
    return c.json({ items })
  })

  return corchRoutes
}

// ── ext: explicit ext:corch scope (the gate is in extApiKeyMiddleware, like ext:work) ──

export function createExtCorchRoutes(deps: RouteDeps = REAL_ROUTE_DEPS): Hono<Env> {
  const extCorchRoutes = new Hono<Env>()

  extCorchRoutes.post('/work-items', async (c) => {
    const userId = c.get('userId')
    let body: z.infer<typeof ExtWorkItem>
    try {
      body = ExtWorkItem.parse(await c.req.json())
    } catch (err: any) {
      return c.json({ error: 'bad_request', detail: err?.message }, 400)
    }
    const ident = canonicalIdent(body.repo_ident)
    if (!ident.ok) return c.json({ error: ident.error }, 400)
    const project = await deps.store.getProjectByIdent(userId, ident.ident)
    if (!project || !project.enabled || !project.accept_external) {
      return c.json({ error: 'project_not_accepting' }, 403)
    }
    const r = await deps.store.enqueueWorkItem({
      userId,
      projectId: project.id,
      source: body.source,
      sourceRef: body.source_ref,
      title: body.title,
      body: body.body,
      priority: body.priority,
    })
    if (r.created) triggerEvaluate(deps, userId)
    return c.json({ item: r.item, created: r.created }, r.created ? 201 : 200)
  })
  return extCorchRoutes
}

export const corchRoutes = createCorchRoutes()
export const extCorchRoutes = createExtCorchRoutes()
