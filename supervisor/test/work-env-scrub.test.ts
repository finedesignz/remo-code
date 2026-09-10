/**
 * DEPLOY-CREDENTIAL SCRUB (milestone WORK).
 *
 * The prompt tells the work agent "do not publish". This test is what makes that TRUE
 * rather than merely requested: the CLI session an inbound client email can drive has NO
 * deploy credential in its environment, so an injected agent has nothing to deploy WITH.
 *
 * GITHUB_TOKEN/GH_TOKEN are deliberately KEPT: the agent's job is to push a BRANCH, and a
 * branch push is not a publish. Publishing is the hub's (hub/src/work/publish.ts) via the
 * `work_publish` supervisor command.
 */
import { describe, test, expect } from 'bun:test'
import {
  sanitizeSpawnEnv,
  isDeployCredentialEnvName,
  isCredentialEnvName,
  isGitPushCredentialEnvName,
} from '../src/runners/env-sanitize'

const DIRTY = {
  PATH: '/usr/bin',
  HOME: '/home/x',
  GITHUB_TOKEN: 'ghp_keepme',
  GH_TOKEN: 'gho_keepme',
  GITHUB_PAT: 'ghp_pat',
  GIT_ASKPASS: '/usr/bin/askpass',
  COOLIFY_TOKEN: 'coolify-secret',
  COOLIFY_URL: 'https://coolify.example',
  VERCEL_TOKEN: 'v1',
  NETLIFY_AUTH_TOKEN: 'n1',
  CLOUDFLARE_API_TOKEN: 'cf1',
  AWS_SECRET_ACCESS_KEY: 'aws1',
  AWS_ACCESS_KEY_ID: 'aws2',
  MYSITE_DEPLOY_TOKEN: 'd1',
  ANTHROPIC_API_KEY: 'sk-ant',
}

describe('the work session env carries no deploy credential', () => {
  test('every deploy credential is scrubbed with scrubDeployCredentials', () => {
    const env = sanitizeSpawnEnv(DIRTY as any, { scrubDeployCredentials: true })
    for (const k of [
      'COOLIFY_TOKEN',
      'COOLIFY_URL',
      'VERCEL_TOKEN',
      'NETLIFY_AUTH_TOKEN',
      'CLOUDFLARE_API_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'MYSITE_DEPLOY_TOKEN',
    ]) {
      expect(env[k]).toBeUndefined()
    }
  })

  test('provider API keys stay scrubbed, and benign vars survive', () => {
    const env = sanitizeSpawnEnv(DIRTY as any, { scrubDeployCredentials: true })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/x')
  })

  test('P0 #2 (option a): with scrubGitPush, the work session env cannot push — no git-push credential', () => {
    const env = sanitizeSpawnEnv(DIRTY as any, { scrubDeployCredentials: true, scrubGitPush: true })
    for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT', 'GIT_ASKPASS']) {
      expect(env[k]).toBeUndefined()
    }
    expect(isGitPushCredentialEnvName('GITHUB_TOKEN')).toBe(true)
    expect(isGitPushCredentialEnvName('GH_ENTERPRISE_TOKEN')).toBe(true)
    expect(isGitPushCredentialEnvName('PATH')).toBe(false)
  })

  test('the orchestrator (scrubGitPush=false) KEEPS its push credential — it opens PRs and self-gates', () => {
    const env = sanitizeSpawnEnv(DIRTY as any, { scrubDeployCredentials: true, scrubGitPush: false })
    expect(env.GITHUB_TOKEN).toBe('ghp_keepme')
    // deploy creds are still gone even for the orchestrator
    expect(env.COOLIFY_TOKEN).toBeUndefined()
  })

  test('the stream-json runner scrubs deploy creds always + git-push for non-orchestrator sessions', async () => {
    const src = await Bun.file(new URL('../src/runners/claude-runner.ts', import.meta.url)).text()
    expect(src).toContain('scrubDeployCredentials: true')
    expect(src).toContain('scrubGitPush: !isOrchestratorSession')
    // never rebuilds a raw env behind the scrubber's back
    expect(src).not.toContain('const env = { ...process.env }')
  })

  test('work_push_branch runs with the SUPERVISOR\'s own env (it holds the push credential the agent lacks)', async () => {
    const src = await Bun.file(new URL('../src/commands/work-git.ts', import.meta.url)).text()
    const push = src.slice(src.indexOf('export async function runWorkPushBranch'))
    expect(push.slice(0, 900)).toContain('const env = { ...process.env }')
  })

  test('work_build runs with deploy credentials scrubbed; a build must never deploy', async () => {
    const src = await Bun.file(new URL('../src/commands/work-git.ts', import.meta.url)).text()
    const build = src.slice(src.indexOf('export async function runWorkBuild'))
    expect(build.slice(0, 1500)).toContain('scrubDeployCredentials: true')
  })

  test('isCredentialEnvName still covers the provider class (no regression)', () => {
    expect(isCredentialEnvName('ANTHROPIC_API_KEY')).toBe(true)
    expect(isCredentialEnvName('MY_API_KEYBOARD_LAYOUT')).toBe(false)
  })
})
