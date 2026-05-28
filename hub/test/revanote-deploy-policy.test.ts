import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { decidePolicy, loadDeployPolicy } from '../src/revanote/deploy-policy'

describe('loadDeployPolicy', () => {
  const savedEnv = { ...process.env }
  beforeEach(() => {
    delete process.env.REVANOTE_AUTOMERGE_BRANCH
    delete process.env.REVANOTE_STAGING_BRANCH
    delete process.env.REVANOTE_DEPLOY_BRANCH
  })
  afterEach(() => {
    process.env = { ...savedEnv }
  })

  test('defaults', () => {
    const p = loadDeployPolicy()
    expect(p.automergeBranch).toBe('main')
    expect(p.stagingBranch).toBe('agent-staging')
    expect(p.deployBranch).toBe('main')
  })

  test('env overrides', () => {
    process.env.REVANOTE_AUTOMERGE_BRANCH = 'master'
    process.env.REVANOTE_STAGING_BRANCH = 'next'
    process.env.REVANOTE_DEPLOY_BRANCH = 'prod'
    const p = loadDeployPolicy()
    expect(p.automergeBranch).toBe('master')
    expect(p.stagingBranch).toBe('next')
    expect(p.deployBranch).toBe('prod')
  })
})

describe('decidePolicy', () => {
  const policy = { automergeBranch: 'main', stagingBranch: 'agent-staging', deployBranch: 'main' }

  test('github + minor + ci_green → auto_merged to main', () => {
    const d = decidePolicy({ riskClass: 'minor', repoKind: 'github', ciGreen: true }, policy)
    expect(d.decision).toBe('auto_merged')
    expect(d.baseBranch).toBe('main')
    expect(d.performMerge).toBe(true)
    expect(d.notify).toBe(false)
  })

  test('github + minor + ci_not_green → pr_opened, no notify, no merge', () => {
    const d = decidePolicy({ riskClass: 'minor', repoKind: 'github', ciGreen: false }, policy)
    expect(d.decision).toBe('pr_opened')
    expect(d.baseBranch).toBe('main')
    expect(d.performMerge).toBe(false)
    expect(d.notify).toBe(false)
  })

  test('github + major → pr_opened to agent-staging, notify', () => {
    const d = decidePolicy({ riskClass: 'major', repoKind: 'github', ciGreen: true }, policy)
    expect(d.decision).toBe('pr_opened')
    expect(d.baseBranch).toBe('agent-staging')
    expect(d.performMerge).toBe(false)
    expect(d.notify).toBe(true)
  })

  test('github + breaking → pr_opened to staging, notify', () => {
    const d = decidePolicy({ riskClass: 'breaking', repoKind: 'github', ciGreen: true }, policy)
    expect(d.decision).toBe('pr_opened')
    expect(d.baseBranch).toBe('agent-staging')
    expect(d.notify).toBe(true)
  })

  test('local_path: never auto-merge, never notify, no remote action', () => {
    const minor = decidePolicy({ riskClass: 'minor', repoKind: 'local_path', ciGreen: true }, policy)
    expect(minor.performMerge).toBe(false)
    expect(minor.notify).toBe(false)
    expect(minor.rationale).toBe('local_path_no_remote_action')

    const major = decidePolicy({ riskClass: 'major', repoKind: 'local_path', ciGreen: true }, policy)
    expect(major.performMerge).toBe(false)
    expect(major.notify).toBe(false)
  })
})
