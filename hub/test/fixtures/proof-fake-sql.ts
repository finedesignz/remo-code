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
  /** throw when this predicate matches the statement text (error injection) */
  failOn: ((text: string) => boolean) | null
  statements: string[]
  unknown: string[]
  beginCalls: number
  lockCalls: number
}

const ACTIVE = new Set(['armed', 'running'])
const INSERT_COLS = [
  'id', 'user_id', 'task_id', 'session_id', 'repo_ident', 'counter_key', 'branch', 'installation_id',
  'repo_owner', 'repo_name', 'default_branch', 'base_sha', 'ruleset_ids', 'ruleset_digest',
  'ruleset_updated_at', 'protection_shape', 'required_contexts', 'arm_preconditions',
  'max_injects', 'max_tokens', 'max_wall_ms',
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
    failOn: null,
    statements: [],
    unknown: [],
    beginCalls: 0,
    lockCalls: 0,
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

    // ── arm ──
    if (text.includes('SELECT repo_ident FROM orchestrator_autospawn_allowlist')) {
      return state.allow.filter((a) => a.user_id === values[0]).map((a) => ({ repo_ident: a.repo_ident }))
    }
    if (text.includes('SELECT id FROM orchestrator_proof_runs WHERE user_id')) {
      return state.runs.filter((r) => r.user_id === values[0] && isActive(r)).slice(0, 1).map((r) => ({ id: r.id }))
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
      for (const t of state.tasks) if (t.id === taskId && t.user_id === userId) Object.assign(t, { enabled: false, macro_task_type: 'dev' })
      return []
    }
    if (text.includes('INSERT INTO scheduled_tasks')) {
      const [userId, sessionId] = values
      const t: FakeTask = { id: nid('task_'), user_id: userId, session_id: sessionId, task_type: 'orchestrator', enabled: false, macro_task_type: 'dev' }
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
      if (!(text.includes('user_id =') && text.includes('repo_ident ='))) {
        state.unknown.push(text) // a bare / partially keyed DELETE is a rule-6 violation
        return []
      }
      const [userId, repoIdent] = values
      state.allow = state.allow.filter((a) => !(a.user_id === userId && a.repo_ident === repoIdent))
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
  sql.begin = async (fn: (tx: any) => Promise<any>) => {
    state.beginCalls++
    const snap = structuredClone({ runs: state.runs, tasks: state.tasks, rows: state.rows, allow: state.allow })
    try {
      const tx: any = tag
      tx.json = sql.json
      return await fn(tx)
    } catch (err) {
      state.runs = snap.runs
      state.tasks = snap.tasks
      state.rows = snap.rows
      state.allow = snap.allow
      throw err
    }
  }
  return { sql, state }
}
