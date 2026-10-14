/**
 * Orchestrator run-reservation guard (PR #509 follow-up).
 *
 * The orchestrator session has exactly ONE launcher, `launchOrchestrator`
 * (per-user advisory lock + open-run re-check). Every OTHER run-consuming path
 * funnels through `reserveSessionSlot(..., runFields)`, which must REFUSE a
 * reservation that targets the orchestrator session — by session id or by a
 * repo_path equal to its project_dir (spawn-on-error, supervisor /start,
 * POST /sessions, orphan replay all pass sessionId:null + a path).
 *
 * Also a structural guard: only an allowlist of files may INSERT session_runs.
 * A new run-opening path outside the guarded seam fails this test.
 */
import { describe, test, expect, mock } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ── fake sql: tagged template + begin(tx) dispatching on the query text ──────
const locks: string[] = []
let usedRepoPaths: string[] = []
let orchestrators: Array<{ id: string; project_dir: string | null }> = []
const inserts: any[][] = []
function fakeTx(strings: TemplateStringsArray, ...vals: any[]) {
  const q = strings.join('?')
  if (q.includes('pg_advisory_xact_lock')) { locks.push('advisory'); return Promise.resolve([]) }
  if (q.includes('FROM supervisors')) locks.push('supervisor')
  if (q.includes('FROM supervisors')) {
    return Promise.resolve([{ concurrency_budget: 4, concurrency_override: null }])
  }
  if (q.includes('COUNT(*)')) return Promise.resolve([{ running: '0' }])
  if (q.includes('DISTINCT repo_path')) return Promise.resolve(usedRepoPaths.map((repo_path) => ({ repo_path })))
  if (q.includes('FROM sessions') && q.includes('is_orchestrator')) {
    return Promise.resolve(orchestrators)
  }
  if (q.includes('INSERT INTO session_runs')) {
    inserts.push(vals)
    return Promise.resolve([{ id: 'run-new' }])
  }
  return Promise.resolve([])
}
const fakeSql: any = (...a: any[]) => (fakeTx as any)(...a)
fakeSql.begin = async (cb: any) => cb(fakeTx)
mock.module('../src/db/postgres.ts', () => ({ sql: fakeSql }))

const { reserveSessionSlot } = await import('../src/sessions/budget.ts')

const run = (over: Partial<{ sessionId: string | null; repoPath: string }> = {}) => ({
  sessionId: null,
  repoPath: '/repo/app',
  branch: null,
  pulled: false,
  initialPrompt: null,
  ...over,
})

describe('reserveSessionSlot orchestrator guard', () => {
  test('refuses when repo_path equals the orchestrator project_dir (sessionId null)', async () => {
    orchestrators = [{ id: 'orch-1', project_dir: 'C:\\Users\\Me\\GitHub' }]
    inserts.length = 0
    const r: any = await reserveSessionSlot('u1', 'sup1', run({ repoPath: 'c:/users/me/github/' }))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('orchestrator_session')
    expect(r.sessionId).toBe('orch-1')
    expect(inserts.length).toBe(0)
  })

  test('refuses when sessionId is the orchestrator session', async () => {
    orchestrators = [{ id: 'orch-1', project_dir: '/some/dir' }]
    inserts.length = 0
    const r: any = await reserveSessionSlot('u1', 'sup1', run({ sessionId: 'orch-1' }))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('orchestrator_session')
    expect(inserts.length).toBe(0)
  })

  test('refuses dot-segment / double-slash aliases of the orchestrator dir', async () => {
    orchestrators = [{ id: 'orch-1', project_dir: '/root/orch' }]
    usedRepoPaths = []
    for (const alias of ['/root/orch/.', '/root//orch/', '/root/x/../orch']) {
      const r: any = await reserveSessionSlot('u1', 'sup1', run({ repoPath: alias }))
      expect(r.reason).toBe('orchestrator_session')
    }
  })

  test('refuses a cwd an orchestrator run actually used (reused row, other supervisor root)', async () => {
    orchestrators = [{ id: 'orch-1', project_dir: '/old/root' }]
    usedRepoPaths = ['/new/root']
    const r: any = await reserveSessionSlot('u1', 'sup1', run({ repoPath: '/new/root' }))
    expect(r.reason).toBe('orchestrator_session')
    usedRepoPaths = []
  })

  test('forward-slash UNC paths are case-insensitive (Windows share aliases cannot evade the guard)', async () => {
    orchestrators = [{ id: 'orch-1', project_dir: '//Server/Share/Repo' }]
    usedRepoPaths = []
    for (const alias of ['//server/share/repo', '\\\\SERVER\\Share\\Repo\\']) {
      const r: any = await reserveSessionSlot('u1', 'sup1', run({ repoPath: alias }))
      expect(r.reason).toBe('orchestrator_session')
    }
  })

  test('POSIX paths are case-sensitive (no false positive)', async () => {
    orchestrators = [{ id: 'orch-1', project_dir: '/srv/Code' }]
    usedRepoPaths = []
    const r: any = await reserveSessionSlot('u1', 'sup1', run({ repoPath: '/srv/code' }))
    expect(r.ok).toBe(true)
  })

  test('takes the per-user orchestrator advisory lock before the supervisor lock', async () => {
    orchestrators = []
    locks.length = 0
    await reserveSessionSlot('u1', 'sup1', run())
    expect(locks[0]).toBe('advisory')
    expect(locks[1]).toBe('supervisor')
  })

  test('allows an ordinary repo and consumes the run row', async () => {
    orchestrators = [{ id: 'orch-1', project_dir: '/root' }]
    inserts.length = 0
    const r: any = await reserveSessionSlot('u1', 'sup1', run({ sessionId: 's2', repoPath: '/root/app' }))
    expect(r.ok).toBe(true)
    expect(r.run.id).toBe('run-new')
    expect(inserts.length).toBe(1)
  })

  test('a known non-orchestrator sessionId at the orchestrator project_dir is allowed (id decides)', async () => {
    orchestrators = [{ id: 'orch-1', project_dir: '/root' }]
    const r: any = await reserveSessionSlot('u1', 'sup1', run({ sessionId: 's2', repoPath: '/root' }))
    expect(r.ok).toBe(true)
  })

  test('allows when the user has no orchestrator session', async () => {
    orchestrators = []
    const r: any = await reserveSessionSlot('u1', 'sup1', run())
    expect(r.ok).toBe(true)
  })

  test('gate-only form (no runFields) is not guarded and consumes nothing', async () => {
    orchestrators = [{ id: 'orch-1', project_dir: '/repo/app' }]
    inserts.length = 0
    const r: any = await reserveSessionSlot('u1', 'sup1')
    expect(r.ok).toBe(true)
    expect(inserts.length).toBe(0)
  })
})

describe('structural guard: who may open a session_run', () => {
  // budget.ts = guarded seam; auto-launch.ts = the advisory-locked orchestrator
  // launcher; supervisor-dal.ts = the raw `createRun` helper (no production
  // caller; any new caller is caught by the createRun check below).
  const ALLOWED_INSERT = new Set([
    'sessions/budget.ts',
    'orchestrator/auto-launch.ts',
    'db/supervisor-dal.ts',
  ])
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (p.endsWith('.ts')) out.push(p)
    }
    return out
  }
  const root = join(import.meta.dir, '..', 'src')
  const files = walk(root).map((p) => ({
    rel: p.slice(root.length + 1).replace(/\\/g, '/'),
    text: readFileSync(p, 'utf8'),
  }))

  test('only allowlisted files INSERT INTO session_runs', () => {
    const offenders = files.filter((f) => /INSERT\s+INTO\s+session_runs/i.test(f.text) && !ALLOWED_INSERT.has(f.rel))
    expect(offenders.map((f) => f.rel)).toEqual([])
  })

  test('no production caller of the unguarded createRun() helper', () => {
    const offenders = files.filter(
      (f) => f.rel !== 'db/supervisor-dal.ts' && /(^|[^\w.])createRun\s*\(/m.test(f.text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    )
    expect(offenders.map((f) => f.rel)).toEqual([])
  })
})
