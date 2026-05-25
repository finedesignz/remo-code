/**
 * Error-capture SDK auto-install endpoint (W5).
 *
 *   POST /api/error-setup/:project_id
 *
 * Body:
 *   {
 *     supervisor_id: string,
 *     repo_path: string,
 *     coolify_app_uuid?: string,
 *     redeploy?: boolean
 *   }
 *
 * Flow (locked design):
 *   1. Load error_project for (user, project_id) → build DSN.
 *   2. Resolve online supervisor; 503 if offline.
 *   3. Ask supervisor to READ key files at repo_path (package.json,
 *      next.config.*, manage.py, wsgi.py, requirements.txt, top-level *.py).
 *      Uses the supervisor's `read_file` command via `run_command`.
 *   4. detectStack(files) → if null, 422 + (TODO merge) notify user.
 *   5. getSnippet(stack, dsn) → entry_prepend + manifest patch.
 *   6. Read entry file, injectSnippet → if alreadyConfigured, return 200.
 *   7. Send supervisor commands to: write entry, update manifest, git add /
 *      commit / push (single composite `error_setup_apply` command).
 *   8. If coolify_app_uuid: setCoolifyEnv(SENTRY_DSN). If redeploy: redeploy.
 *   9. Return { ok, stack, dsn, commit_pushed, coolify_env_set, redeployed }.
 *
 * Supervisor command dependency: requires `error_setup_apply` (or equivalent
 * read+write+git) registered in supervisor_commands for the target
 * supervisor. If absent, we fail with `supervisor_command_missing` so the
 * UI can prompt the user to install the supervisor companion script.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { config } from '../config.ts'
import { getErrorProject } from '../db/error-capture-dal.ts'
import { getSupervisor, sendRequest } from '../ws/supervisor-registry.ts'
import { sql } from '../db/postgres.ts'
import { detectStack, type RepoFile } from '../error-capture/setup/detect.ts'
import {
  getSnippet, injectSnippet, addSentryDep, addPythonSentryRequirement,
} from '../error-capture/setup/snippet.ts'
import { setCoolifyEnv, redeployCoolifyApp } from '../error-capture/setup/coolify-env.ts'

export const errorSetup = new Hono()

const BodySchema = z.object({
  supervisor_id: z.string().min(1),
  repo_path: z.string().min(1).max(1024),
  coolify_app_uuid: z.string().min(1).max(128).optional(),
  redeploy: z.boolean().optional(),
})

// Files we ask the supervisor to read. Missing entries are silently
// ignored — detect.ts decides based on what's present.
const PROBE_FILES = [
  'package.json',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'manage.py',
  'wsgi.py',
  'requirements.txt',
  // Common single-file FastAPI / Django wsgi locations
  'main.py',
  'app.py',
  'server.py',
  'src/main.py',
  'src/app.py',
  'src/server.py',
  // Common entry candidates for express
  'src/index.ts', 'src/index.js',
  'src/server.ts', 'src/server.js',
  'src/app.ts', 'src/app.js',
  'index.ts', 'index.js',
  'server.ts', 'server.js',
]

interface ReadFileResult { path: string; content: string | null }

async function supervisorReadFiles(
  supervisorId: string,
  repoPath: string,
  paths: string[],
): Promise<ReadFileResult[]> {
  // Dispatch one composite request — `error_setup_probe` — that the
  // supervisor implements by reading all candidate files at once and
  // returning a `repo.op_result` with `data: { files: [...] }`.
  //
  // We use the generic `repo.scan` shape's req/resp envelope; the
  // supervisor distinguishes by `op` field.
  const reqMsg: any = {
    type: 'run_command',
    command: 'error_setup_probe',
    args: [repoPath, ...paths],
  }
  // For now we shoehorn through sendRequest with a synthesized req_id —
  // the supervisor must echo it back in op_result.req_id.
  const res = await sendRequest<any>(supervisorId, reqMsg, 15_000)
  if (!res || !Array.isArray(res?.files)) return []
  return res.files as ReadFileResult[]
}

function commandRegistered(supervisorId: string, name: string): Promise<boolean> {
  return sql<{ id: string }[]>`
    SELECT id FROM supervisor_commands
    WHERE supervisor_id = ${supervisorId} AND kind = 'command' AND name = ${name}
    LIMIT 1
  `.then(rows => rows.length > 0)
}

function buildDsn(sentryKey: string, projectId: string): string {
  const base = (process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com').replace(/\/+$/, '')
  // Strip protocol for DSN host portion.
  const url = new URL(base)
  return `${url.protocol}//${sentryKey}@${url.host}/${projectId}`
}

errorSetup.post('/:project_id', async (c) => {
  const userId = c.get('userId') as string
  const projectId = c.req.param('project_id')

  // 1. Load project
  const project = await getErrorProject(projectId, userId)
  if (!project) return c.json({ error: 'project_not_found' }, 404)

  // Parse + validate body
  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await c.req.json())
  } catch (err: any) {
    return c.json({ error: 'bad_request', detail: err?.message }, 400)
  }

  const dsn = buildDsn(project.sentry_key, project.id)

  // 2. Resolve supervisor
  const entry = getSupervisor(body.supervisor_id)
  if (!entry) return c.json({ error: 'supervisor_offline' }, 503)
  if (entry.userId !== userId) return c.json({ error: 'forbidden' }, 403)

  // 3. Supervisor capability check
  const has = await commandRegistered(body.supervisor_id, 'error_setup_probe')
  if (!has) {
    return c.json({
      error: 'supervisor_command_missing',
      missing: ['error_setup_probe'],
      hint: 'Install the Remo supervisor companion to enable one-click SDK install.',
    }, 412)
  }

  // 3b. Read candidate files
  let files: ReadFileResult[]
  try {
    files = await supervisorReadFiles(body.supervisor_id, body.repo_path, PROBE_FILES)
  } catch (err: any) {
    return c.json({ error: 'supervisor_read_failed', detail: err?.message }, 502)
  }
  const presentFiles: RepoFile[] = files
    .filter((f): f is ReadFileResult & { content: string } => typeof f.content === 'string')
    .map(f => ({ path: f.path, content: f.content }))

  // 4. Detect stack
  const detection = detectStack(presentFiles)
  if (detection.stack === null) {
    // TODO(merge): call notify('stack_not_detected', { user_id: userId,
    //   project_id: projectId, tried: detection.tried }) so the W2 notify
    //   module emails the user a copy-paste init snippet. Cannot wire here
    //   without coupling — the notify kinds don't yet include this case.
    return c.json({ error: 'stack_not_detected', tried: detection.tried }, 422)
  }

  // 5. Build snippet plan
  const plan = getSnippet(detection.stack, dsn)

  // 6. Inject into entry file
  const entryFile = presentFiles.find(f => f.path === detection.entry_file)
  if (!entryFile) {
    // Detection said this file exists but our probe didn't load it (path
    // outside PROBE_FILES). Bail — caller can widen probe list.
    return c.json({ error: 'entry_file_not_probed', entry_file: detection.entry_file }, 500)
  }
  const injected = injectSnippet(entryFile.content, plan.entry_prepend)

  // Build the manifest patch
  const manifestFile = presentFiles.find(f => f.path === detection.manifest_file)
  let manifestPatch: { path: string; content: string } | null = null
  let manifestAlreadyConfigured = false
  if (plan.manifest_kind === 'package.json' && manifestFile) {
    const stackForDep = detection.stack === 'node-nextjs' ? 'node-nextjs' : 'node-express'
    const dep = addSentryDep(manifestFile.content, stackForDep)
    manifestAlreadyConfigured = dep.alreadyConfigured
    if (!dep.alreadyConfigured) {
      manifestPatch = { path: detection.manifest_file, content: dep.content }
    }
  } else if (plan.manifest_kind === 'requirements.txt' && manifestFile) {
    const reqPatch = addPythonSentryRequirement(manifestFile.content)
    manifestAlreadyConfigured = reqPatch.alreadyConfigured
    if (!reqPatch.alreadyConfigured) {
      manifestPatch = { path: detection.manifest_file, content: reqPatch.content }
    }
  }

  if (injected.alreadyConfigured && manifestAlreadyConfigured) {
    return c.json({
      ok: true,
      alreadyConfigured: true,
      stack: detection.stack,
      dsn,
      entry_file: detection.entry_file,
      manifest_file: detection.manifest_file,
    })
  }

  // 7. Dispatch the apply command. The supervisor companion is responsible
  //    for: writing the entry file, updating the manifest, git add -A,
  //    git commit -m "...", git push to default branch.
  const applyAvailable = await commandRegistered(body.supervisor_id, 'error_setup_apply')
  if (!applyAvailable) {
    return c.json({
      error: 'supervisor_command_missing',
      missing: ['error_setup_apply'],
    }, 412)
  }

  const writes: { path: string; content: string }[] = []
  if (!injected.alreadyConfigured) writes.push({ path: detection.entry_file, content: injected.content })
  if (manifestPatch) writes.push(manifestPatch)

  let commitPushed = false
  let supervisorError: string | null = null
  try {
    const applyRes = await sendRequest<any>(body.supervisor_id, {
      type: 'run_command',
      command: 'error_setup_apply',
      args: [
        body.repo_path,
        JSON.stringify({
          writes,
          commit_message: 'feat: install Sentry SDK for error capture',
        }),
      ],
    } as any, 60_000)
    commitPushed = !!applyRes?.ok
    if (!commitPushed) supervisorError = applyRes?.error ?? 'apply_failed'
  } catch (err: any) {
    supervisorError = err?.message ?? 'apply_request_failed'
  }

  // 8. Coolify env push (optional)
  let coolifyEnvSet: boolean | null = null
  let coolifyEnvError: string | null = null
  let redeployed: boolean | null = null
  let redeployError: string | null = null
  if (body.coolify_app_uuid && commitPushed) {
    const envRes = await setCoolifyEnv(body.coolify_app_uuid, 'SENTRY_DSN', dsn)
    coolifyEnvSet = envRes.ok
    if (!envRes.ok) coolifyEnvError = envRes.error ?? 'unknown'
    if (envRes.ok && body.redeploy === true) {
      const dep = await redeployCoolifyApp(body.coolify_app_uuid)
      redeployed = dep.ok
      if (!dep.ok) redeployError = dep.error ?? 'unknown'
    }
  }

  return c.json({
    ok: commitPushed,
    stack: detection.stack,
    dsn,
    entry_file: detection.entry_file,
    manifest_file: detection.manifest_file,
    commit_pushed: commitPushed,
    supervisor_error: supervisorError,
    coolify_env_set: coolifyEnvSet,
    coolify_env_error: coolifyEnvError,
    redeployed,
    redeploy_error: redeployError,
  })
})

// Silence unused-import linters if config is referenced elsewhere later
void config
