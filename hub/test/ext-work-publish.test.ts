/**
 * PUBLISH-AUTHORITY PROOFS (milestone WORK, post-QC rearchitecture).
 *
 * The agent PROPOSES a branch; the HUB DISPOSES. These tests pin the four conditions
 * that gate a live-site deploy — all of them HUB-OBSERVED — and prove the agent cannot
 * talk its way past any of them:
 *
 *   1. an agent claiming success on an auto_publish=false site ⇒ NO deploy call, published=false
 *   2. a branch whose diff strays outside site_dir ⇒ needs_human, NO deploy — even with auto_publish=true
 *   3. a failing hub HTTPS probe ⇒ NO deploy on an auto_publish=true site
 *   4. a failing hub BUILD ⇒ NO deploy
 *   5. the deploy call happens ONLY when all four conditions hold
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect } from 'bun:test'
import { runHubQc, isUnderSiteDir, type HubQc } from '../src/work/verify.ts'
import { publishWork, mayPublish } from '../src/work/publish.ts'
import type { WorkSite } from '../src/db/work-dal.ts'

const SITE = (over: Partial<WorkSite> = {}): WorkSite => ({
  id: 'site-1',
  user_id: 'u1',
  repo_ident: 'github://acme/hyperoptimizedwebsites',
  site_key: 'clientco',
  site_dir: 'sites/clientco',
  client_emails: ['owner@clientco.com'],
  auto_publish: false,
  publish_cmd: 'bun run deploy:clientco',
  build_cmd: 'bun run build',
  verify_url: 'https://clientco.example/',
  preview_verify_url: null,
  coolify_app_uuid: 'app-uuid',
  default_branch: 'main',
  ...over,
})

/** A supervisor RPC stub: canned reply per command. */
function stubRun(map: Record<string, any>, calls: string[] = []) {
  return (async (_sup: string, _u: string, command: string) => {
    calls.push(command)
    const v = map[command]
    if (!v) return { exit_code: 1, error: `no_stub_${command}` }
    return { exit_code: 0, snippet: JSON.stringify(v) }
  }) as any
}

const GOOD_DIFF = { files: ['sites/clientco/index.html'], head_sha: 'abc123' }

async function qcWith(over: {
  diff?: any
  build?: any
  status?: number
  site?: Partial<WorkSite>
}): Promise<HubQc> {
  const site = SITE(over.site ?? {})
  return runHubQc(
    {
      supervisorId: 's1',
      userId: 'u1',
      projectDir: 'C:/repo',
      branch: 'work/deadbeef',
      defaultBranch: 'main',
      siteDir: site.site_dir,
      buildCmd: site.build_cmd,
      verifyUrl: site.verify_url,
      previewVerifyUrl: site.preview_verify_url,
    },
    {
      runCommand: stubRun({
        work_diff_scope: over.diff ?? GOOD_DIFF,
        work_build: over.build ?? { build_exit_code: 0, output: 'ok' },
      }),
      fetchUrl: async () => ({ status: over.status ?? 200 }),
    },
  )
}

describe('hub diff-scope check makes site_dir a REAL boundary', () => {
  test('exact-segment prefix — sites/clientco2 is NOT under sites/clientco', () => {
    expect(isUnderSiteDir('sites/clientco/a.html', 'sites/clientco')).toBe(true)
    expect(isUnderSiteDir('sites/clientco2/a.html', 'sites/clientco')).toBe(false)
    expect(isUnderSiteDir('.github/workflows/ci.yml', 'sites/clientco')).toBe(false)
    expect(isUnderSiteDir('sites\\clientco\\a.html', 'sites/clientco')).toBe(true)
  })

  test('a stray file in the branch diff fails QC (hub-observed, not agent-reported)', async () => {
    const qc = await qcWith({
      diff: { files: ['sites/clientco/index.html', 'package.json'], head_sha: 'x' },
    })
    expect(qc.ok).toBe(false)
    expect(qc.failure).toBe('diff_out_of_scope')
    expect(qc.diff_scope.stray_files).toEqual(['package.json'])
  })

  test('an empty diff is not a pass', async () => {
    const qc = await qcWith({ diff: { files: [], head_sha: 'x' } })
    expect(qc.ok).toBe(false)
  })

  test('a failing build fails QC — the hub ran it, the agent did not report it', async () => {
    const qc = await qcWith({ build: { build_exit_code: 1, output: 'TS2345 boom' } })
    expect(qc.ok).toBe(false)
    expect(qc.failure).toBe('build_failed')
    expect(qc.build.exit_code).toBe(1)
  })

  test('a non-2xx HTTPS probe fails QC — a hallucinated 200 is unreachable from here', async () => {
    const qc = await qcWith({ status: 503 })
    expect(qc.ok).toBe(false)
    expect(qc.failure).toBe('probe_failed')
    expect(qc.probe.status).toBe(503)
  })

  test('no build_cmd / no verify_url is NOT a pass by omission (fail closed)', async () => {
    const noBuild = await qcWith({ site: { build_cmd: null } })
    expect(noBuild.ok).toBe(false)
    expect(noBuild.failure).toBe('build_failed')
    const noUrl = await qcWith({ site: { verify_url: null } })
    expect(noUrl.ok).toBe(false)
    expect(noUrl.failure).toBe('probe_failed')
  })

  test('all three hub checks green ⇒ qc.ok', async () => {
    const qc = await qcWith({})
    expect(qc.ok).toBe(true)
    expect(qc.diff_scope.ok && qc.build.ok && qc.probe.ok).toBe(true)
  })
})

describe('publishWork — the four conditions, and NO deploy call otherwise', () => {
  test('(1) auto_publish=false: NO deploy call, published=false, even with green QC', async () => {
    const qc = await qcWith({})
    const calls: string[] = []
    let redeploys = 0
    const out = await publishWork(
      {
        supervisorId: 's1',
        userId: 'u1',
        projectDir: 'C:/repo',
        branch: 'work/deadbeef',
        site: SITE({ auto_publish: false }),
        qc,
      },
      {
        runCommand: stubRun({ work_publish: { merged_sha: 'zzz', publish_exit_code: 0 } }, calls),
        redeploy: async () => {
          redeploys++
          return { ok: true }
        },
        fetchUrl: async () => ({ status: 200 }),
      },
    )
    expect(out.published).toBe(false)
    expect(out.deploy_status).toBe('not_permitted')
    expect(calls).toEqual([]) // work_publish was NEVER invoked
    expect(redeploys).toBe(0) // no Coolify deploy call
  })

  test('(2) diff strays outside site_dir ⇒ no deploy EVEN with auto_publish=true', async () => {
    const qc = await qcWith({
      diff: { files: ['sites/other/index.html'], head_sha: 'x' },
      site: { auto_publish: true },
    })
    const calls: string[] = []
    let redeploys = 0
    const out = await publishWork(
      {
        supervisorId: 's1',
        userId: 'u1',
        projectDir: 'C:/repo',
        branch: 'work/deadbeef',
        site: SITE({ auto_publish: true }),
        qc,
      },
      {
        runCommand: stubRun({ work_publish: { merged_sha: 'zzz', publish_exit_code: 0 } }, calls),
        redeploy: async () => {
          redeploys++
          return { ok: true }
        },
        fetchUrl: async () => ({ status: 200 }),
      },
    )
    expect(out.published).toBe(false)
    expect(out.deploy_status).toBe('qc_failed')
    expect(calls).toEqual([])
    expect(redeploys).toBe(0)
  })

  test('(3) failing hub HTTPS probe blocks the deploy on an auto_publish=true site', async () => {
    const qc = await qcWith({ status: 500, site: { auto_publish: true } })
    const calls: string[] = []
    const out = await publishWork(
      {
        supervisorId: 's1',
        userId: 'u1',
        projectDir: 'C:/repo',
        branch: 'work/deadbeef',
        site: SITE({ auto_publish: true }),
        qc,
      },
      {
        runCommand: stubRun({ work_publish: { merged_sha: 'z', publish_exit_code: 0 } }, calls),
        redeploy: async () => ({ ok: true }),
        fetchUrl: async () => ({ status: 200 }),
      },
    )
    expect(out.published).toBe(false)
    expect(calls).toEqual([])
  })

  test('(4) failing hub build blocks the deploy', async () => {
    const qc = await qcWith({ build: { build_exit_code: 2, output: 'boom' }, site: { auto_publish: true } })
    const calls: string[] = []
    const out = await publishWork(
      {
        supervisorId: 's1',
        userId: 'u1',
        projectDir: 'C:/repo',
        branch: 'work/deadbeef',
        site: SITE({ auto_publish: true }),
        qc,
      },
      {
        runCommand: stubRun({ work_publish: { merged_sha: 'z', publish_exit_code: 0 } }, calls),
        redeploy: async () => ({ ok: true }),
        fetchUrl: async () => ({ status: 200 }),
      },
    )
    expect(out.published).toBe(false)
    expect(calls).toEqual([])
  })

  test('(5) deploy happens ONLY when all four hold — and published=true is the HUB\'s act', async () => {
    const qc = await qcWith({ site: { auto_publish: true } })
    const calls: string[] = []
    const deployed: string[] = []
    const out = await publishWork(
      {
        supervisorId: 's1',
        userId: 'u1',
        projectDir: 'C:/repo',
        branch: 'work/deadbeef',
        site: SITE({ auto_publish: true }),
        qc,
      },
      {
        runCommand: stubRun({ work_publish: { merged_sha: 'sha999', publish_exit_code: 0 } }, calls),
        redeploy: async (uuid) => {
          deployed.push(uuid)
          return { ok: true }
        },
        fetchUrl: async () => ({ status: 200 }),
      },
    )
    expect(calls).toEqual(['work_publish'])
    expect(deployed).toEqual(['app-uuid'])
    expect(out.published).toBe(true)
    expect(out.deploy_status).toBe('published')
    expect(out.merged_sha).toBe('sha999')
    expect(out.revert_command).toContain('revert --no-edit sha999')
  })

  test('post-publish re-probe failure is recorded LOUDLY with the revert command', async () => {
    const qc = await qcWith({ site: { auto_publish: true } })
    let n = 0
    const out = await publishWork(
      {
        supervisorId: 's1',
        userId: 'u1',
        projectDir: 'C:/repo',
        branch: 'work/deadbeef',
        site: SITE({ auto_publish: true }),
        qc,
      },
      {
        runCommand: stubRun({ work_publish: { merged_sha: 'sha1', publish_exit_code: 0 } }),
        redeploy: async () => ({ ok: true }),
        fetchUrl: async () => ({ status: ++n === 1 ? 500 : 500 }),
      },
    )
    expect(out.deploy_status).toBe('live_probe_failed')
    expect(out.published).toBe(true) // it IS live — never lie in the reassuring direction
    expect(out.revert_command).toContain('revert')
  })

  test('mayPublish requires ALL FOUR — dropping any one is false', () => {
    const green: HubQc = {
      ok: true,
      failure: null,
      diff_scope: { ok: true, files: ['sites/clientco/x'], stray_files: [], head_sha: 'a' },
      build: { ok: true, ran: true, exit_code: 0 },
      probe: { ok: true, ran: true, url: 'u', status: 200 },
      observed_at: '',
    }
    expect(mayPublish(SITE({ auto_publish: true }), green)).toBe(true)
    expect(mayPublish(SITE({ auto_publish: false }), green)).toBe(false)
    expect(mayPublish(SITE({ auto_publish: true }), { ...green, ok: false })).toBe(false)
    expect(
      mayPublish(SITE({ auto_publish: true }), { ...green, build: { ...green.build, ok: false } }),
    ).toBe(false)
    expect(
      mayPublish(SITE({ auto_publish: true }), { ...green, probe: { ...green.probe, ok: false } }),
    ).toBe(false)
    expect(
      mayPublish(SITE({ auto_publish: true }), {
        ...green,
        diff_scope: { ...green.diff_scope, ok: false },
      }),
    ).toBe(false)
  })
})

describe('P0 #1 — SHA pin end to end (TOCTOU)', () => {
  test('QC verifies SHA_A; if the branch tip moved, work_publish aborts and NO deploy happens', async () => {
    // QC observed head_sha = 'abc123' (GOOD_DIFF). Simulate the supervisor detecting a
    // moved tip: work_publish returns exit_code 1 error branch_moved_after_qc (parseSnippet
    // -> null), so publishWork must NOT redeploy and must report published=false.
    const qc = await qcWith({ site: { auto_publish: true } })
    expect(qc.diff_scope.head_sha).toBe('abc123')
    let redeploys = 0
    const out = await publishWork(
      {
        supervisorId: 's1', userId: 'u1', projectDir: 'C:/repo',
        branch: 'work/deadbeef', site: SITE({ auto_publish: true }), qc,
      },
      {
        runCommand: (async (_s: string, _u: string, command: string, args: string[]) => {
          if (command === 'work_publish') {
            // The hub passed the VERIFIED sha as args[3].
            expect(args[3]).toBe('abc123')
            return { exit_code: 1, error: 'branch_moved_after_qc: verified abc123 but origin/work/deadbeef is def456' }
          }
          return { exit_code: 1, error: 'no_stub' }
        }) as any,
        redeploy: async () => { redeploys++; return { ok: true } },
        fetchUrl: async () => ({ status: 200 }),
      },
    )
    expect(out.published).toBe(false)
    expect(out.deploy_status).toBe('branch_moved_after_qc')
    expect(redeploys).toBe(0)
  })

  test('publishWork passes the QC-verified head_sha (not the branch ref) to work_publish', async () => {
    const qc = await qcWith({ site: { auto_publish: true }, diff: { files: ['sites/clientco/x.html'], head_sha: 'feedface99' } })
    let seenSha: string | null = null
    await publishWork(
      { supervisorId: 's1', userId: 'u1', projectDir: 'C:/repo', branch: 'work/deadbeef', site: SITE({ auto_publish: true }), qc },
      {
        runCommand: (async (_s: string, _u: string, _c: string, args: string[]) => {
          seenSha = args[3]
          return { exit_code: 0, snippet: JSON.stringify({ merged_sha: 'm1', publish_exit_code: 0 }) }
        }) as any,
        redeploy: async () => ({ ok: true }),
        fetchUrl: async () => ({ status: 200 }),
      },
    )
    expect(seenSha).toBe('feedface99')
  })
})
