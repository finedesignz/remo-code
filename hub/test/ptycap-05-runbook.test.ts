/**
 * PTYCAP-05-09 - pins the load-bearing statements of the owner's proof runbook and the
 * CLAUDE.md env entry, so they cannot rot silently (T-05-39..41).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const RUNBOOK = join(REPO, 'docs', 'ptycap-05-proof-runbook.md')
const CLAUDE_MD = join(REPO, 'CLAUDE.md')

const text = existsSync(RUNBOOK) ? readFileSync(RUNBOOK, 'utf8') : ''
const lower = text.toLowerCase()

/** The ABORT AND ROLLBACK section body (from its heading to the next H2). */
function rollbackSection(): string {
  const start = text.indexOf('## 5. ABORT AND ROLLBACK')
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + 3)
  const next = rest.search(/\n## /)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('PTYCAP-05 proof runbook', () => {
  test('exists and is an OWNER GO/NO-GO gate', () => {
    expect(existsSync(RUNBOOK)).toBe(true)
    expect(text).toContain('OWNER GO')
  })

  test('rollback orders the kill switch / disarm BEFORE unsetting the proof flag', () => {
    const sec = rollbackSection()
    const stop = Math.min(
      ...['kill switch', '--disarm'].map((s) => sec.indexOf(s)).filter((i) => i >= 0),
    )
    const unset = sec.indexOf('unset REMO_ORCHESTRATOR_PROOF')
    expect(Number.isFinite(stop)).toBe(true)
    expect(unset).toBeGreaterThan(-1)
    expect(stop).toBeLessThan(unset)
    expect(sec).toContain('REMO_ORCHESTRATOR_AUTOSPAWN')
    expect(sec.toLowerCase()).toContain('redeploy')
    expect(sec.toLowerCase()).toContain('online')
  })

  test('names the three extra GitHub App permissions', () => {
    expect(text).toContain('Administration')
    expect(text).toContain('Checks')
    expect(text).toContain('Commit statuses')
  })

  test('requires an empty bypass list and rejects PR plus green check alone', () => {
    expect(text).toContain('EMPTY bypass list')
    expect(lower).toContain('require pull request plus green check')
    expect(lower).toContain('squash-merges')
  })

  test('covers the agent credential, the visibility dependency and honest scope', () => {
    expect(text).toContain('--agent-login')
    expect(text).toContain('proof_protection_unverifiable')
    expect(text).toContain('bypass_actors')
    expect(lower).toContain('live proof pending owner go')
    expect(lower).toContain('credential scrubbing is not relied on')
    expect(lower).toContain('term.input')
  })

  test('lists every arm refusal code', () => {
    for (const code of [
      'github_app_unconfigured',
      'invalid_budget',
      'invalid_schedule',
      'installation_not_owned',
      'repo_not_in_installation',
      'session_repo_mismatch',
      'proof_permissions_missing',
      'no_ci_workflow',
      'proof_protection_unverifiable',
      'proof_protection_insufficient',
      'agent_credential_is_admin',
      'other_repo_allowlisted',
      'proof_already_active',
    ]) {
      expect(text).toContain(`\`${code}\``)
    }
  })

  test('never instructs a merge of the proof PR (every merge line negates or is historical)', () => {
    const offenders = text
      .split('\n')
      .filter((l) => /merge/i.test(l))
      .filter((l) => !/(never|\bnot\b|rejects|squash-merges|merged)/i.test(l))
    expect(offenders).toEqual([])
  })

  test('contains no secret-looking values', () => {
    expect(/ghp_[A-Za-z0-9]{10,}|github_pat_|-----BEGIN|sk-[A-Za-z0-9]{20,}/.test(text)).toBe(false)
  })
})

describe('CLAUDE.md proof entry', () => {
  const md = readFileSync(CLAUDE_MD, 'utf8')

  test('documents the flag and the frozen budget knobs', () => {
    expect(md).toContain('REMO_ORCHESTRATOR_PROOF')
    for (const k of ['REMO_PROOF_MAX_INJECTS', 'REMO_PROOF_MAX_TOKENS', 'REMO_PROOF_MAX_WALL_MS']) {
      expect(md).toContain(k)
    }
  })

  test('links the runbook', () => {
    expect(md).toContain('ptycap-05-proof-runbook')
  })
})
