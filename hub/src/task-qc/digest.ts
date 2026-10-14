/**
 * PTYCAP-08 task-quality digest (D-19, verdict F1-A5). Built ONLY from typed fields of the
 * engine result: detector / severity / proposal kind are enums, ids are validated against a
 * fixed pattern before they reach a command, and every free-text value (task names, evidence
 * strings, errors) goes through safeText (ASCII, control-free, truncated) and is HTML-escaped
 * separately in the html part. Commands are fixed templates per proposal kind; values are
 * quoted by the one SQL quoter (sqlLiteral). The output holds only characters 9, 10 and
 * 32-126 (global rule 7b). No raw task row and no raw run error ever reaches this module.
 */
import { sendEmail } from '../lib/email.ts'
import { sqlLiteral } from './safe-fixes.ts'
import { safeText, type Evidence, type Finding, type ProposalKind, type Severity, type TaskQcResult } from './types.ts'

export interface TaskQcDigest {
  subject: string
  text: string
  html: string
  /** the findings whose blocks are in `text`/`html` (a size or count cut leaves the rest out); applied fixes are not listed */
  shown: Finding[]
}

export interface DigestInput {
  findings: TaskQcResult['findings']
  applied: TaskQcResult['applied']
  truncated: boolean
}

export interface DigestOptions {
  userName?: string
  /** origin such as https://app.example.com; ignored unless it matches the strict pattern */
  appBaseUrl?: string
  now?: Date
  /** sendDigest only: upper bound in ms on the email request (the sender passes the pass time left) */
  sendTimeoutMs?: number
}

export const MAX_FINDINGS_RENDERED = 200
export const MAX_BODY_CHARS = 100_000
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const BASE_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/
const SAFE_FIX_KINDS = ['normalize_timezone', 'backfill_payload_from_sibling', 'rebind_dead_session']
const SEVERITY_RANK: Record<Severity, number> = { high: 0, warn: 1, info: 2 }
const MAX_ROLLBACK_CHARS = 2000
const PLACEHOLDER = {
  cron: 'REPLACE_WITH_CRON',
  tz: 'REPLACE_WITH_IANA_TIMEZONE',
  uuid: 'REPLACE_WITH_APPLICATION_UUID',
  repo: 'REPLACE_WITH_REPO_IDENT',
  session: 'REPLACE_WITH_LIVE_SESSION_ID',
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const isAsciiLine = (s: string) => [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126)

function evidenceLines(evidence: Evidence): string[] {
  const lines: string[] = []
  for (const [k, v] of Object.entries(evidence ?? {})) {
    let val: string
    if (Array.isArray(v)) val = v.slice(0, 20).map((x) => safeText(x, 80)).join(', ')
    else if (v !== null && typeof v === 'object') val = safeText(JSON.stringify(v), 120)
    else val = safeText(v, 120)
    lines.push(`${safeText(k, 40)}: ${val}`)
  }
  return lines
}

interface Rendered {
  /** advisory sentence, always present */
  sentence: string
  /** extra typed lines (reason, candidates, would-apply) */
  notes: string[]
  /** command lines, already indented relative to the proposal */
  command: string[]
}

const PROPOSAL_SENTENCE: Record<ProposalKind, string> = {
  propose_disable: 'Proposal (not applied): disable this task if it should stop running.',
  reregister_job: 'Proposal (not applied): re-enable and re-arm this task.',
  fix_cron: 'Proposal (not applied): replace the invalid cron expression.',
  fix_timezone: 'Proposal (not applied): set a valid IANA timezone.',
  fix_payload: 'Proposal (not applied): set payload.application_uuid.',
  set_teab_repo: 'Proposal (not applied): set the TEAB repo identifier.',
  rebind_session: 'Proposal (not applied): point this task at a live session.',
  review_cadence: 'Proposal (not applied): this task fires far more often than it produces output; slow its cadence.',
  review_prompt_size: 'Advisory only: this prompt is among the largest; consider trimming it. No command.',
  merge_duplicates: 'Proposal (not applied): these tasks are duplicates; disable all but the first.',
}

/** Fixed template per proposal kind. Returns no command when the task id is not a safe id. */
function renderProposal(f: Finding, baseUrl: string): Rendered {
  const kind = f.proposal.kind
  const sentence = PROPOSAL_SENTENCE[kind] ?? `Proposal (not applied): ${safeText(kind, 40)}.`
  const notes: string[] = []
  const reason = f.proposal.params.reason
  if (typeof reason === 'string') notes.push(`Held because: ${safeText(reason, 40)}`)
  const candidates = f.proposal.params.candidates
  if (typeof candidates === 'number' && Number.isFinite(candidates)) {
    notes.push(`${Math.max(0, Math.floor(candidates))} candidates found; no automatic choice was made.`)
  }
  const wouldFix = f.evidence.would_fix
  if (typeof wouldFix === 'string' && SAFE_FIX_KINDS.includes(wouldFix)) {
    notes.push(`Auto-fix is off; would apply: ${wouldFix}`)
  }

  const idRaw = f.proposal.params.taskId
  const id = typeof idRaw === 'string' ? idRaw : f.taskId
  if (kind === 'review_prompt_size') return { sentence, notes, command: [] }
  if (!SAFE_ID.test(id)) {
    return { sentence, notes: [...notes, '(unrecognized task id: no command emitted)'], command: [] }
  }

  const patch = (target: string, body: string): string[] => [`PATCH ${baseUrl}/api/scheduled-tasks/${target}`, `  body: ${body}`]
  const idLit = sqlLiteral(id)
  switch (kind) {
    case 'propose_disable':
      return { sentence, notes, command: patch(id, '{"enabled":false}') }
    case 'reregister_job':
      return { sentence, notes, command: patch(id, '{"enabled":true}') }
    case 'fix_cron':
    case 'review_cadence':
      return { sentence, notes, command: patch(id, `{"cron_expr":"${PLACEHOLDER.cron}"}`) }
    case 'fix_timezone':
      return { sentence, notes, command: [`UPDATE scheduled_tasks SET timezone = ${sqlLiteral(PLACEHOLDER.tz)} WHERE id = ${idLit}`] }
    case 'fix_payload':
      return {
        sentence,
        notes,
        command: [
          `UPDATE scheduled_tasks SET payload = payload || jsonb_build_object('application_uuid', ${sqlLiteral(PLACEHOLDER.uuid)}::text) WHERE id = ${idLit}`,
        ],
      }
    case 'set_teab_repo':
      return { sentence, notes, command: [`UPDATE scheduled_tasks SET teab_repo_ident = ${sqlLiteral(PLACEHOLDER.repo)} WHERE id = ${idLit}`] }
    case 'rebind_session': {
      const stale = f.proposal.params.staleSessionId
      const staleLit = sqlLiteral(typeof stale === 'string' ? safeText(stale, 64) : '')
      const live = sqlLiteral(PLACEHOLDER.session)
      return {
        sentence,
        notes,
        command: [
          `UPDATE scheduled_tasks SET session_id = ${live}, target_id = ${live} WHERE id = ${idLit} AND session_id IS NOT DISTINCT FROM ${staleLit}`,
        ],
      }
    }
    case 'merge_duplicates': {
      const members = Array.isArray(f.evidence.memberIds) ? f.evidence.memberIds : []
      const others = members.filter((m): m is string => typeof m === 'string' && SAFE_ID.test(m) && m !== id).slice(0, 10)
      return { sentence, notes, command: others.flatMap((m) => patch(m, '{"enabled":false}')) }
    }
    default:
      return { sentence, notes, command: [] }
  }
}

interface Block {
  text: string
  html: string
}

function findingBlock(f: Finding, n: number, baseUrl: string): Block {
  const head = `#${n} ${safeText(f.detector, 24)} [${safeText(f.severity, 8)}] ${safeText(f.taskName)} (${safeText(f.taskId, 64)})`
  const ev = evidenceLines(f.evidence)
  const p = renderProposal(f, baseUrl)
  const body = [`Disposition: proposed`, ...ev, p.sentence, ...p.notes]
  const textLines = [head, ...body.map((l) => `  ${l}`), ...p.command.map((l) => `  ${l}`)]
  const html =
    `<h3>${esc(head)}</h3><ul>${body.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` +
    (p.command.length ? `<pre>${p.command.map(esc).join('\n')}</pre>` : '')
  return { text: textLines.join('\n'), html }
}

function appliedBlock(a: TaskQcResult['applied'][number], n: number): Block {
  const head = `${n}. ${safeText(a.fix, 40)} on ${safeText(a.finding.taskName)} (${safeText(a.taskId, 64)})`
  const rollbackOk = a.rollbackSql.length <= MAX_ROLLBACK_CHARS && isAsciiLine(a.rollbackSql)
  const rollback = rollbackOk
    ? `rollback SQL: ${a.rollbackSql}`
    : `rollback SQL (non-ASCII or oversized data) not shown: read rollback_sql from task_qc_findings for task ${safeText(a.taskId, 64)}`
  const lines = [`before: ${safeText(JSON.stringify(a.before), 300)}`, `after: ${safeText(JSON.stringify(a.after), 300)}`, rollback]
  // The writer changes the stored column only; the in-memory cron job reads its timezone when it is
  // armed, so an invalid-timezone job stays unarmed until the next hub boot or a task edit re-arms it.
  if (a.fix === 'normalize_timezone') lines.push('note: the stored timezone is corrected; the job is re-armed at the next hub restart or when the task is next edited')
  return {
    text: [`  ${head}`, ...lines.map((l) => `     ${l}`)].join('\n'),
    html: `<h3>${esc(head)}</h3><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`,
  }
}

export function buildDigest(result: DigestInput, opts: DigestOptions = {}): TaskQcDigest | null {
  if (result.findings.length === 0) return null
  const baseUrl = opts.appBaseUrl && BASE_URL.test(opts.appBaseUrl) ? opts.appBaseUrl : ''

  const appliedFindings = new Set<Finding>(result.applied.map((a) => a.finding))
  const open = result.findings
    .filter((f) => !appliedFindings.has(f))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .map((x) => x.f)

  const subject = `Task quality: ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}, ${result.applied.length} applied`

  const perDetector = new Map<string, number>()
  for (const f of result.findings) perDetector.set(safeText(f.detector, 24), (perDetector.get(safeText(f.detector, 24)) ?? 0) + 1)
  const counts = [...perDetector.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, n]) => `${d} ${n}`).join(', ')
  const summaryParts = [
    opts.userName ? `owner ${safeText(opts.userName, 60)}` : '',
    `${result.findings.length} finding(s) (${counts})`,
    `${result.applied.length} fix(es) applied automatically`,
    opts.now ? `run time ${opts.now.toISOString()}` : '',
    result.truncated ? 'TRUNCATED: this pass hit a bound, so not every task or run was audited' : '',
  ].filter(Boolean)
  const summary = `Summary: ${summaryParts.join('; ')}`

  const textHead = [subject, '', summary, '']
  const htmlHead = [`<p>${esc(subject)}</p>`, `<p>${esc(summary)}</p>`]
  let textLen = textHead.join('\n').length
  const budget = MAX_BODY_CHARS - 300
  const textParts: string[] = []
  const htmlParts: string[] = []
  let sizeCut = false

  const push = (b: Block): boolean => {
    if (textLen + b.text.length + 2 > budget) {
      sizeCut = true
      return false
    }
    textParts.push(b.text)
    htmlParts.push(b.html)
    textLen += b.text.length + 2
    return true
  }

  // Applied fixes first: their rollback SQL is the one thing a size cut must never hide.
  if (result.applied.length > 0) {
    const title = `APPLIED AUTOMATICALLY (${result.applied.length})`
    textParts.push(title)
    htmlParts.push('<h2>Applied automatically</h2>')
    textLen += title.length + 2
    for (let i = 0; i < result.applied.length && !sizeCut; i++) push(appliedBlock(result.applied[i]!, i + 1))
  }

  let shown = 0
  if (open.length > 0 && !sizeCut) {
    const title = `FINDINGS (${open.length})`
    textParts.push(title)
    htmlParts.push('<h2>Findings</h2>')
    textLen += title.length + 2
    const cap = Math.min(open.length, MAX_FINDINGS_RENDERED)
    for (let i = 0; i < cap; i++) {
      if (!push(findingBlock(open[i]!, i + 1, baseUrl))) break
      shown++
    }
  }

  const notShown = open.length - shown
  const tail: string[] = []
  if (sizeCut) {
    tail.push(`[digest truncated: size cap reached; ${notShown} finding(s) not shown]`)
  } else if (notShown > 0) {
    tail.push(`${notShown} more finding(s) not shown (cap ${MAX_FINDINGS_RENDERED} per digest).`)
  }
  const text = [...textHead, textParts.join('\n\n'), ...(tail.length ? ['', ...tail] : [])].join('\n') + '\n'
  const html = htmlHead.join('') + htmlParts.join('') + tail.map((l) => `<p>${esc(l)}</p>`).join('')
  return { subject, text, html, shown: open.slice(0, shown) }
}

/**
 * One email per call; a null digest (zero findings) sends nothing. `shown` is what the email
 * actually contained, so a caller marks only those findings delivered (an over-long digest cuts
 * the rest, which must be reported again).
 */
export async function deliverDigest(
  result: DigestInput,
  user: { email: string; name?: string },
  opts: Omit<DigestOptions, 'userName'> = {},
): Promise<{ delivered: boolean; shown: Finding[] }> {
  const digest = buildDigest(result, { ...opts, userName: user.name })
  if (!digest) return { delivered: false, shown: [] }
  const delivered = await sendEmail({ to: user.email, subject: digest.subject, html: digest.html, text: digest.text, timeoutMs: opts.sendTimeoutMs })
  return { delivered, shown: digest.shown }
}

/** deliverDigest, reduced to the helper's boolean. */
export async function sendDigest(
  result: DigestInput,
  user: { email: string; name?: string },
  opts: Omit<DigestOptions, 'userName'> = {},
): Promise<boolean> {
  return (await deliverDigest(result, user, opts)).delivered
}
