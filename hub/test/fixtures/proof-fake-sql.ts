/**
 * PTYCAP-05 in-memory fake of the `sql` tag, emulating ONLY the statements issued by
 * src/db/orchestrator-proof-dal.ts and sumSessionTokensSince (recognised by
 * distinctive text). Not a mock.module call and not a test file: each test does its
 * own `mock.module('../src/db/postgres.ts', () => ({ sql }))`. Tests assert
 * `state.unknown` is empty so an unmodeled statement fails loudly. `begin` snapshots
 * the store and restores it when the callback throws (rollback). The real SQL is
 * proven against Postgres by plan 05-08.
 */

export interface FakeTask {
  id: string
  user_id: string
  session_id: string
  task_type: string
  enabled: boolean
  macro_task_type: string
  proof_owned?: boolean
}
export interface FakeRow {
  task_id: string
  command: string
  enabled: boolean
  schedule_rule: unknown
}
export interface FakeAllow {
  user_id: string
  repo_ident: string
}
export interface FakeLedger {
  counter_key: string
  kind: string
  released_at: number | null
  created_at: number
}
export interface FakeTokenRow {
  session_id: string | null
  tokens: number
  created_at: number
}

export interface ProofFakeState {
  runs: any[]
  tasks: FakeTask[]
  rows: FakeRow[]
  allow: FakeAllow[]
  ledger: FakeLedger[]
  tokenUsage: FakeTokenRow[]
  sessions: Set<string>
  /** automation_kill_switch rows touched by arm / enable / disarm */
  kill: Array<{ id?: string; engaged_by?: string; scope: string; user_id: string | null; session_id: string; reason: string; engaged: boolean }>
  /** routine_queue rows (session_id, status) */
  queue: Array<{ session_id: string; status: string }>
  /** throw when this predicate matches the statement text (error injection) */
  failOn: ((text: string) => boolean) | null
  statements: string[]
  unknown: string[]
  beginCalls: number
  lockCalls: number
  /** the hashtext key of every advisory lock taken, in order */
  lockKeys: string[]
}

const ACTIVE = new Set(['armed', 'running'])
const INSERT_COLS = [
  'id', 'user_id', 'task_id', 'session_id', 'repo_ident', 'counter_key', 'branch', 'installation_id',
  'repo_owner', 'repo_name', 'default_branch', 'base_sha', 'ruleset_ids', 'ruleset_digest',
  'ruleset_updated_at', 'protection_shape', 'required_contexts', 'arm_preconditions',
  'max_injects', 'max_tokens', 'max_wall_ms', 'kill_switch_id',
] as const

export function createProofFakeSql() {
  const state: ProofFakeState = {
    runs: [],
    tasks: [],
    rows: [],
    allow: [],
    ledger: [],
    tokenUsage: [],
    sessions: new Set(),
    kill: [],
    queue: [],
    failOn: null,
    statements: [],
    unknown: [],
    beginCalls: 0,
    lockCalls: 0,
    lockKeys: [],
  }
  let idn = 0
  const nid = (p: string) => `${p}${++idn}`
  const dup = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
  const isActive = (r: any) => ACTIVE.has(r.status)

  function exec(strings: TemplateStringsArray, values: any[]): any[] {
    const text = strings.join('?').replace(/\s+/g, ' ')
    state.statements.push(text)
    if (state.failOn && state.failOn(text)) throw new Error('fake_sql_failure')

    if (text.includes('pg_advisory_xact_lock')) {
      state.lockCalls++
      return []
    }

    // ── halt / cancel (arm), release (enable) ──
    if (text.includes('INSERT INTO automation_kill_switch') && text.includes('FROM orchestrator_proof_runs')) {
      // disarm: engage for the user's ACTIVE run sessions (evaluated against the store BEFORE the run update)
      for (const r of state.runs) {
        if (r.user_id === values[0] && isActive(r) && !state.kill.some((k) => k.engaged && k.scope === 'session' && k.session_id === r.session_id)) {
          state.kill.push({ id: nid('kill_'), engaged_by: 'arm-orchestrator-proof', scope: 'session', user_id: r.user_id, session_id: r.session_id, reason: 'proof disarmed', engaged: true })
        }
      }
      return []
    }
    if (text.includes('SELECT id, engaged_by FROM automation_kill_switch')) {
      return state.kill
        .filter((k) => k.engaged && k.scope === 'session' && k.session_id === values[0])
        .map((k) => ({ id: k.id, engaged_by: k.engaged_by ?? 'unknown' }))
    }
    if (text.includes('INSERT INTO automation_kill_switch')) {
      const [userId, sessionId, engagedBy] = values
      if (state.kill.some((k) => k.engaged && k.scope === 'session' && k.session_id === sessionId)) return [] // ON CONFLICT DO NOTHING
      const row = { id: nid('kill_'), engaged_by: engagedBy, scope: 'session', user_id: userId, session_id: sessionId, reason: 'proof armed', engaged: true }
      state.kill.push(row)
      return [{ id: row.id }]
    }
    if (text.includes("UPDATE routine_queue SET status = 'cancelled'")) {
      for (const q of state.queue) if (q.session_id === values[0] && q.status === 'pending') q.status = 'cancelled'
      return []
    }
    if (text.includes('UPDATE automation_kill_switch SET engaged = false') && text.includes('WHERE id =')) {
      const id = values[values.length - 1] // arm releases a stale proof halt by id; enable releases ITS row by id
      for (const k of state.kill) if (k.engaged && k.id === id) k.engaged = false
      return []
    }

    // ── arm ──
    if (text.includes('SELECT repo_ident FROM orchestrator_autospawn_allowlist')) {
      return state.allow.filter((a) => a.user_id === values[0]).map((a) => ({ repo_ident: a.repo_ident }))
    }
    if (text.includes('SELECT id FROM orchestrator_proof_runs WHERE user_id')) {
      return state.runs.filter((r) => r.user_id === values[0] && isActive(r)).slice(0, 1).map((r) => ({ id: r.id }))
    }
    if (text.includes('SELECT count(*) AS n FROM scheduled_tasks')) {
      const enabledOrch = state.tasks.filter((t) => t.task_type === 'orchestrator' && t.enabled)
      if (text.includes('NOT (user_id =')) {
        const [userId, sessionId] = values // dry-run read
        return [{ n: String(enabledOrch.filter((t) => !(t.user_id === userId && t.session_id === sessionId)).length) }]
      }
      return [{ n: String(enabledOrch.filter((t) => t.id !== values[0]).length) }] // in-tx check
    }
    if (text.includes('SELECT id FROM scheduled_tasks')) {
      const [userId, sessionId] = values
      return state.tasks
        .filter((t) => t.user_id === userId && t.session_id === sessionId && t.task_type === 'orchestrator')
        .slice(0, 1)
        .map((t) => ({ id: t.id }))
    }
    if (text.includes("UPDATE scheduled_tasks SET enabled = false, macro_task_type = 'dev'")) {
      const [taskId, userId] = values
      for (const t of state.tasks) if (t.id === taskId && t.user_id === userId) Object.assign(t, { enabled: false, macro_task_type: 'dev', proof_owned: true })
      return []
    }
    if (text.includes('INSERT INTO scheduled_tasks')) {
      const [userId, sessionId] = values
      const t: FakeTask = { id: nid('task_'), user_id: userId, session_id: sessionId, task_type: 'orchestrator', enabled: false, macro_task_type: 'dev', proof_owned: true }
      state.tasks.push(t)
      return [{ id: t.id }]
    }
    if (text.includes('INSERT INTO orchestrator_rows')) {
      const [taskId, rule] = values
      state.rows.push({ task_id: taskId, command: 'proof', enabled: true, schedule_rule: rule })
      return []
    }
    if (text.includes('INSERT INTO orchestrator_autospawn_allowlist')) {
      const [userId, repoIdent] = values
      if (!state.allow.some((a) => a.user_id === userId && a.repo_ident === repoIdent)) state.allow.push({ user_id: userId, repo_ident: repoIdent })
      return []
    }
    if (text.includes('INSERT INTO orchestrator_proof_runs')) {
      const row: any = {}
      INSERT_COLS.forEach((c, i) => (row[c] = values[i]))
      // the three partial unique indexes WHERE status IN ('armed','running')
      for (const c of ['user_id', 'repo_ident', 'task_id'] as const) {
        if (state.runs.some((r) => isActive(r) && r[c] === row[c])) throw dup()
      }
      Object.assign(row, {
        status: 'armed', outcome: null, outcome_detail: null, pr_url: null, pr_number: null,
        last_ci_state: null, last_inject_outcome: null, tokens_hwm: 0,
        armed_at: new Date().toISOString(), updated_at: new Date().toISOString(), started_at: null, terminal_at: null,
      })
      state.runs.push(row)
      return [{ ...row }]
    }

    // ── disarm / enable ──
    if (text.includes("UPDATE orchestrator_proof_runs SET status = 'disarmed'")) {
      const [detail, userId] = values
      const out: any[] = []
      for (const r of state.runs) {
        if (r.user_id === userId && isActive(r)) {
          Object.assign(r, { status: 'disarmed', outcome: null, outcome_detail: detail, terminal_at: 'now' })
          out.push({ ...r })
        }
      }
      return out
    }
    if (text.includes('UPDATE scheduled_tasks SET enabled = false WHERE id') && text.includes("task_type = 'orchestrator'")) {
      const [taskId, userId] = values // disableProofTask
      for (const t of state.tasks) if (t.id === taskId && t.user_id === userId && t.task_type === 'orchestrator') t.enabled = false
      return []
    }
    if (text.includes('UPDATE scheduled_tasks SET enabled = false WHERE id')) {
      const [taskId, userId] = values // disarm
      for (const t of state.tasks) if (t.id === taskId && t.user_id === userId) t.enabled = false
      return []
    }
    if (text.includes('UPDATE scheduled_tasks SET enabled = true WHERE id')) {
      const [taskId, userId] = values
      for (const t of state.tasks) if (t.id === taskId && t.user_id === userId) t.enabled = true
      return []
    }
    if (text.includes("UPDATE orchestrator_rows SET enabled = false WHERE task_id")) {
      for (const r of state.rows) if (r.task_id === values[0] && r.command === 'proof') r.enabled = false
      return []
    }
    if (text.includes('DELETE FROM orchestrator_autospawn_allowlist')) {
      if (!(text.includes('user_id =') && (text.includes('repo_ident =') || text.includes('lower(repo_ident) =')))) {
        state.unknown.push(text) // a bare / partially keyed DELETE is a rule-6 violation
        return []
      }
      const [userId, repoIdent] = values
      const ci = text.includes('lower(repo_ident) =') // canonical compare: also removes a mixed-case twin
      state.allow = state.allow.filter((a) => !(a.user_id === userId && (ci ? a.repo_ident.toLowerCase() === repoIdent : a.repo_ident === repoIdent)))
      return []
    }
    if (text.includes("SELECT * FROM orchestrator_proof_runs WHERE user_id = ? AND status = 'armed'")) {
      return state.runs.filter((r) => r.user_id === values[0] && r.status === 'armed').slice(0, 1).map((r) => ({ ...r }))
    }

    // ── tracer subset ──
    if (text.includes("SET status = 'running'")) {
      const r = state.runs.find((x) => x.task_id === values[0] && isActive(x))
      if (!r) return []
      r.status = 'running'
      r.started_at = r.started_at ?? 'now'
      return [{ ...r }]
    }
    if (text.includes('SELECT 1 AS n FROM orchestrator_proof_runs WHERE task_id')) {
      return state.runs.some((r) => r.task_id === values[0]) ? [{ n: 1 }] : []
    }
    if (text.includes('UPDATE orchestrator_proof_runs SET status = ?, outcome = ?') && text.includes('WHERE id =')) {
      const [status, outcome, detail, prUrl, prNumber, runId] = values
      const r = state.runs.find((x) => x.id === runId && isActive(x))
      if (!r) return []
      Object.assign(r, { status, outcome, outcome_detail: detail, pr_url: prUrl ?? r.pr_url, pr_number: prNumber ?? r.pr_number, terminal_at: 'now' })
      return [{ ...r }]
    }
    if (text.includes('UPDATE orchestrator_proof_runs SET status = ?, outcome = ?') && text.includes('WHERE task_id =')) {
      const [status, outcome, detail, taskId] = values
      const r = state.runs.find((x) => x.task_id === taskId && isActive(x))
      if (!r) return []
      Object.assign(r, { status, outcome, outcome_detail: detail, terminal_at: 'now' })
      return [{ ...r }]
    }

    // ── reads / counters ──
    if (text.includes('FROM orchestrator_proof_runs WHERE counter_key')) {
      const rows = state.runs.filter((r) => r.counter_key === values[0])
      return rows.slice(-1).map((r) => ({ ...r }))
    }
    if (text.includes('FROM orchestrator_proof_runs WHERE session_id')) {
      return state.runs.filter((r) => r.session_id === values[0] && isActive(r)).slice(-1).map((r) => ({ ...r }))
    }
    if (text.includes('FROM orchestrator_proof_runs WHERE repo_ident')) {
      return state.runs.filter((r) => r.repo_ident === values[0] && isActive(r)).slice(0, 1).map((r) => ({ ...r }))
    }
    if (text.includes('SELECT * FROM orchestrator_proof_runs WHERE user_id = ? ORDER BY armed_at DESC LIMIT')) {
      return state.runs.filter((r) => r.user_id === values[0]).slice().reverse().slice(0, values[1]).map((r) => ({ ...r }))
    }
    if (text.includes('FROM automation_inject_ledger')) {
      const [key, since] = values
      const n = state.ledger.filter((l) => l.counter_key === key && l.kind === 'inject' && l.released_at == null && l.created_at >= Number(since)).length
      return [{ n }]
    }
    if (text.includes('tokens_hwm = GREATEST')) {
      const [prUrl, prNumber, ci, inj, tokens, runId] = values
      const r = state.runs.find((x) => x.id === runId && isActive(x))
      if (!r) return []
      r.pr_url = prUrl ?? r.pr_url
      r.pr_number = prNumber ?? r.pr_number
      r.last_ci_state = ci ?? r.last_ci_state
      r.last_inject_outcome = inj ?? r.last_inject_outcome
      r.tokens_hwm = Math.max(Number(r.tokens_hwm), Number(tokens ?? 0))
      return [{ ...r }]
    }
    if (text.includes('EXISTS (SELECT 1 FROM sessions WHERE id')) {
      const [sessionId, , since] = values // EXISTS(sessionId), WHERE session_id = sessionId, created_at >= since
      const sum = state.tokenUsage
        .filter((t) => t.session_id === sessionId && t.created_at >= Number(since))
        .reduce((a, t) => a + t.tokens, 0)
      return [{ sum: String(sum), session_exists: state.sessions.has(sessionId) }]
    }

    state.unknown.push(text)
    return []
  }

  function tag(strings: TemplateStringsArray, ...values: any[]) {
    try {
      return Promise.resolve(exec(strings, values))
    } catch (err) {
      return Promise.reject(err)
    }
  }
  const sql: any = tag
  sql.json = (v: unknown) => v
  // Real advisory-lock semantics: pg_advisory_xact_lock(hashtext(K)) blocks until the holder's
  // transaction ends. Keyed by the text value, so two txs only exclude each other on the SAME key.
  const lockChains = new Map<string, Promise<void>>()
  async function acquire(key: string): Promise<() => void> {
    const prev = lockChains.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    lockChains.set(key, prev.then(() => mine))
    await prev
    return release
  }
  sql.begin = async (fn: (tx: any) => Promise<any>) => {
    state.beginCalls++
    const held: Array<() => void> = []
    const take = () => structuredClone({ runs: state.runs, tasks: state.tasks, rows: state.rows, allow: state.allow, kill: state.kill, queue: state.queue })
    let snap = take()
    try {
      const tx: any = (strings: TemplateStringsArray, ...values: any[]) => {
        if (strings.join('?').includes('pg_advisory_xact_lock')) {
          state.lockCalls++
          state.lockKeys.push(String(values[0]))
          state.statements.push(strings.join('?').replace(/\s+/g, ' '))
          return acquire(String(values[0])).then((rel) => {
            held.push(rel)
            snap = take() // a real tx sees the state committed by the previous lock holder
            return []
          })
        }
        return tag(strings, ...values)
      }
      tx.json = sql.json
      return await fn(tx)
    } catch (err) {
      state.runs = snap.runs
      state.tasks = snap.tasks
      state.rows = snap.rows
      state.allow = snap.allow
      state.kill = snap.kill
      state.queue = snap.queue
      throw err
    } finally {
      for (const rel of held) rel()
    }
  }
  return { sql, state }
}
