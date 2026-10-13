/**
 * PTYCAP-04 in-memory fake of the `sql` tag, emulating ONLY the statements of
 * src/dispatch/automation-controls.ts (recognised by distinctive text). Not a
 * mock.module call and not a test file: each test file does its own
 * `mock.module('../src/db/postgres.ts', () => ({ sql }))`. The real SQL is
 * proven against Postgres by test/e2e/automation-controls-checks.ts (CI only).
 */
export interface LedgerRow {
  seq: number
  id: string
  user_id: string
  session_id: string | null
  counter_key: string
  actor: string
  token: string
  kind: 'inject' | 'reset' | 'page'
  created_at: number
  released_at: number | null
}
export interface KillRow {
  id: string
  scope: 'global' | 'user' | 'session'
  user_id: string | null
  session_id: string | null
  engaged: boolean
  reason: string | null
  engaged_by: string
  engaged_at: number
  released_by: string | null
  released_at: number | null
}
export interface RunLogRow {
  id: string
  session_id: string
  outcome: string
  inject_token: string | null
  created_at: number
}

export interface FakeState {
  ledger: LedgerRow[]
  kill: KillRow[]
  runlog: RunLogRow[]
  tasks: Array<{ id: string; session_id: string; task_type: string }>
  tables: { ledger: boolean; kill_switch: boolean; alarms: boolean }
  /** throw when this predicate matches the statement text (error injection) */
  failOn: ((text: string) => boolean) | null
  statements: string[]
  unknown: string[]
  beginCalls: number
  lockCalls: number
  seq: number
}

export function createFakeSql() {
  const state: FakeState = {
    ledger: [],
    kill: [],
    runlog: [],
    tasks: [],
    tables: { ledger: true, kill_switch: true, alarms: true },
    failOn: null,
    statements: [],
    unknown: [],
    beginCalls: 0,
    lockCalls: 0,
    seq: 0,
  }
  let idn = 0
  const nid = (p: string) => `${p}${++idn}`
  const maxReset = (key: string) =>
    Math.max(0, ...state.ledger.filter((r) => r.counter_key === key && r.kind === 'reset').map((r) => r.seq))

  function run(strings: TemplateStringsArray, values: any[]): any[] {
    const text = strings.join('?').replace(/\s+/g, ' ')
    state.statements.push(text)
    if (state.failOn && state.failOn(text)) throw new Error('fake_sql_failure')

    if (text.includes('pg_advisory_xact_lock')) {
      state.lockCalls++
      return []
    }
    if (text.includes('to_regclass')) return [{ ...state.tables }]

    // ── kill switch ──
    if (text.includes('SELECT scope, engaged FROM automation_kill_switch')) {
      const [userId, sessionId] = values
      const order = { global: 0, user: 1, session: 2 } as const
      const hits = state.kill
        .filter(
          (k) =>
            k.engaged &&
            (k.scope === 'global' ||
              (k.scope === 'user' && k.user_id === userId) ||
              (k.scope === 'session' && k.session_id === sessionId)),
        )
        .sort((a, b) => order[a.scope] - order[b.scope])
      return hits.slice(0, 1).map((k) => ({ scope: k.scope, engaged: k.engaged }))
    }
    if (text.includes('INSERT INTO automation_kill_switch')) {
      const [scope, userId, sessionId, reason, engagedBy] = values
      const dup = state.kill.some(
        (k) =>
          k.engaged &&
          k.scope === scope &&
          (scope === 'global' || (scope === 'user' && k.user_id === userId) || (scope === 'session' && k.session_id === sessionId)),
      )
      if (dup) return []
      const row: KillRow = {
        id: nid('ks_'), scope, user_id: userId, session_id: sessionId, engaged: true,
        reason, engaged_by: engagedBy, engaged_at: Date.now(), released_by: null, released_at: null,
      }
      state.kill.push(row)
      return [{ id: row.id }]
    }
    if (text.includes('UPDATE automation_kill_switch')) {
      const [releasedBy, scope, userId, sessionId] = values
      const out: any[] = []
      for (const k of state.kill) {
        if (k.engaged && k.scope === scope && k.user_id === userId && k.session_id === sessionId) {
          k.engaged = false
          k.released_by = releasedBy
          k.released_at = Date.now()
          out.push({ id: k.id })
        }
      }
      return out
    }
    if (text.includes('SELECT id, scope, user_id, session_id, engaged')) {
      const [userId] = values
      return state.kill.filter(
        (k) => k.engaged && (k.scope === 'global' || ((k.scope === 'user' || k.scope === 'session') && k.user_id === userId)),
      )
    }

    // ── ledger ──
    if (text.includes('SELECT id, released_at FROM automation_inject_ledger')) {
      const [key, token] = values
      return state.ledger.filter((r) => r.counter_key === key && r.token === token && r.kind === 'inject').slice(0, 1)
    }
    if (text.includes('UNION')) {
      const [sessionId, mins, , outcomes] = values
      const since = Date.now() - mins * 60_000
      const keys = new Set<string>()
      for (const r of state.ledger) {
        if (r.session_id === sessionId && r.kind === 'inject' && r.released_at == null && r.created_at >= since) keys.add(r.token)
      }
      for (const r of state.runlog) {
        if (r.session_id === sessionId && (outcomes as string[]).includes(r.outcome) && r.created_at >= since) {
          keys.add(r.inject_token ?? `runlog:${r.id}`)
        }
      }
      return [{ n: String(keys.size) }]
    }
    if (text.includes('SELECT COUNT(*)::text AS n FROM automation_inject_ledger')) {
      const [key] = values
      const floor = maxReset(key)
      const n = state.ledger.filter(
        (r) => r.counter_key === key && r.kind === 'inject' && r.released_at == null && r.seq > floor,
      ).length
      return [{ n: String(n) }]
    }
    if (text.includes('UPDATE automation_inject_ledger SET released_at = NULL')) {
      const [id] = values
      const row = state.ledger.find((r) => r.id === id && r.released_at != null)
      if (row) row.released_at = null
      return []
    }
    if (text.includes('UPDATE automation_inject_ledger SET released_at = now()')) {
      const [key, token] = values
      for (const r of state.ledger) {
        if (r.counter_key === key && r.token === token && r.kind === 'inject' && r.released_at == null) r.released_at = Date.now()
      }
      return []
    }
    if (text.includes('INSERT INTO automation_inject_ledger')) {
      let row: LedgerRow
      if (text.includes("'page:'")) {
        const [userId, sessionId, key, kind] = values
        row = {
          seq: ++state.seq, id: nid('lg_'), user_id: userId, session_id: sessionId, counter_key: key,
          actor: 'page', token: `page:${kind}:${maxReset(key)}`, kind: 'page', created_at: Date.now(), released_at: null,
        }
      } else if (text.includes('WHERE EXISTS')) {
        const [userId, key, actor, token] = values
        if (!state.ledger.some((r) => r.counter_key === key && r.user_id === userId)) return []
        row = {
          seq: ++state.seq, id: nid('lg_'), user_id: userId, session_id: null, counter_key: key,
          actor, token, kind: 'reset', created_at: Date.now(), released_at: null,
        }
      } else if (text.includes("'inject')")) {
        const [userId, sessionId, key, actor, token] = values
        row = {
          seq: ++state.seq, id: nid('lg_'), user_id: userId, session_id: sessionId, counter_key: key,
          actor, token, kind: 'inject', created_at: Date.now(), released_at: null,
        }
      } else {
        state.unknown.push(text)
        return []
      }
      if (state.ledger.some((r) => r.counter_key === row.counter_key && r.token === row.token)) {
        state.seq-- // ON CONFLICT DO NOTHING (a real BIGSERIAL would burn the value; irrelevant to ordering)
        return []
      }
      state.ledger.push(row)
      return [{ id: row.id }]
    }

    // ── scheduled task lookup ──
    if (text.includes('FROM scheduled_tasks')) {
      const [sessionId] = values
      return state.tasks.filter((t) => t.session_id === sessionId && t.task_type === 'orchestrator').slice(0, 1)
    }

    state.unknown.push(text)
    return []
  }

  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    try {
      return Promise.resolve(run(strings, values))
    } catch (err) {
      return Promise.reject(err)
    }
  }
  sql.begin = async (fn: (tx: any) => Promise<any>) => {
    state.beginCalls++
    return fn(sql)
  }
  return { sql, state }
}
