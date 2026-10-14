/**
 * PTYCAP-07-06 Task 1 -- notifyOnce: claim-then-send, exactly ONE send attempt (SH-05, D-05,
 * AM-F3-2). DB-free: the claim / owner lookup / send seam is injected.
 */
import { describe, test, expect } from 'bun:test'
import { notifyOnce, buildNotification, type NotifyDeps, type NotifyEvent } from '../src/heal/notify.ts'

const EVENT: NotifyEvent = {
  user_id: 'u1',
  source: 'coolify_deploy',
  dedupe_key: 'coolify:d1',
  repo_ident: 'github://acme/web',
  notify_summary: 'deploy “failed” — build step…',
}

function mkDeps(over: Partial<NotifyDeps> = {}) {
  const rec = { claims: [] as string[], sends: [] as any[] }
  const deps: NotifyDeps = {
    claim: async (id) => {
      rec.claims.push(id)
      return true
    },
    resolveOwnerEmail: async () => 'owner@example.com',
    send: async (m) => {
      rec.sends.push(m)
      return true
    },
    ...over,
  }
  return { deps, rec }
}

describe('notifyOnce', () => {
  test('a won claim makes exactly one send attempt and reports notified true', async () => {
    const { deps, rec } = mkDeps()
    expect(await notifyOnce('ev1', EVENT, 'no_session_for_repo', deps)).toBe(true)
    expect(rec.claims).toEqual(['ev1'])
    expect(rec.sends.length).toBe(1)
    expect(rec.sends[0].to).toBe('owner@example.com')
  })

  test('a lost ownership claim performs zero send attempts', async () => {
    const { deps, rec } = mkDeps({ claim: async () => false })
    expect(await notifyOnce('ev1', EVENT, 'x', deps)).toBe(false)
    expect(rec.sends.length).toBe(0)
  })

  test('a send that returns false is attempted exactly once and never retried', async () => {
    const attempts: number[] = []
    const { deps } = mkDeps({
      send: async () => {
        attempts.push(1)
        return false
      },
    })
    expect(await notifyOnce('ev1', EVENT, 'x', deps)).toBe(false)
    expect(attempts.length).toBe(1)
  })

  test('a send that throws is attempted exactly once, swallowed, notified false', async () => {
    const attempts: number[] = []
    const { deps } = mkDeps({
      send: async () => {
        attempts.push(1)
        throw new Error('smtp down')
      },
    })
    expect(await notifyOnce('ev1', EVENT, 'x', deps)).toBe(false)
    expect(attempts.length).toBe(1)
  })

  test('a throwing claim sends nothing and does not throw out', async () => {
    const { deps, rec } = mkDeps({
      claim: async () => {
        throw new Error('db down')
      },
    })
    expect(await notifyOnce('ev1', EVENT, 'x', deps)).toBe(false)
    expect(rec.sends.length).toBe(0)
  })

  test('no owner address => claim consumed, nothing sent', async () => {
    const { deps, rec } = mkDeps({ resolveOwnerEmail: async () => null })
    expect(await notifyOnce('ev1', EVENT, 'x', deps)).toBe(false)
    expect(rec.sends.length).toBe(0)
  })
})

describe('notification content', () => {
  test('subject names the repo and the reason; unknown repo is stated', () => {
    expect(buildNotification(EVENT, 'no_session_for_repo').subject).toBe('[heal] github://acme/web: no_session_for_repo')
    expect(buildNotification({ ...EVENT, repo_ident: null }, 'why').subject).toBe('[heal] unknown repo: why')
  })

  test('every outbound string is ASCII-only, including curly quotes, dashes and ellipsis', () => {
    const m = buildNotification(EVENT, 'bad — reason “q” … é')
    for (const s of [m.subject, m.text, m.html]) expect(/^[\x20-\x7E\n]*$/.test(s)).toBe(true)
    expect(m.text).toContain('Dedupe key: coolify:d1')
    expect(m.text).toContain('Source: coolify_deploy')
    expect(m.text).toContain('Summary: deploy "failed" -- build step...')
  })

  test('untrusted text is escaped in html and length-capped', () => {
    const m = buildNotification({ ...EVENT, notify_summary: '<script>alert(1)</script>' }, 'r'.repeat(5000))
    expect(m.html).not.toContain('<script>')
    expect(m.subject.length).toBeLessThanOrEqual(300)
    expect(m.text.length).toBeLessThan(1500)
  })
})
