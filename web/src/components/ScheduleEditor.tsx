import { useEffect, useMemo, useState } from 'react'
import type { ScheduledTask, ScheduleCreateInput, TaskType, TargetKind, CatchupPolicy, PostRunAction } from '../hooks/useSchedules'
import { useSessions } from '../hooks/useSessions'
import { hubFetch, HubFetchError } from '../lib/api'
import { nextRuns, validate as validateCron, browserTimezone } from '../lib/cron'
import { PostRunActionsEditor } from './PostRunActionsEditor'
import { ScheduleRulesBuilder } from './ScheduleRulesBuilder'
import { type ScheduleRule, ruleToCron, defaultRule, validateRule } from '../lib/schedule-rules'
import { computeTaskAutoName } from '../lib/task-name'
import { TASK_TEMPLATES, isReplaceableNotes } from '../lib/task-templates'

interface Props {
  token: string
  existing: ScheduledTask | null
  allSchedules: ScheduledTask[]
  onClose: () => void
  onSave: (data: ScheduleCreateInput) => Promise<void>
}

interface Supervisor {
  id: string
  hostname: string
  online: boolean
}

const TASK_TYPES: Array<{ value: TaskType; label: string }> = [
  { value: 'dev', label: 'Dev' },
  { value: 'security', label: 'Security scan' },
  { value: 'log_check', label: 'Log check' },
]

const TARGET_KINDS: Array<{ value: TargetKind; label: string }> = [
  { value: 'session', label: 'One session' },
  { value: 'supervisor', label: 'One supervisor' },
  { value: 'all_agents', label: 'All sessions' },
  { value: 'all_supervisors', label: 'All supervisors' },
]

const COMMON_TZS = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
]

export function ScheduleEditor({ token, existing, allSchedules, onClose, onSave }: Props) {
  // Basic fields
  const [nameSuffix, setNameSuffix] = useState<string>(
    existing?.name_suffix ?? existing?.name ?? '',
  )
  const [suffixHydrated, setSuffixHydrated] = useState<boolean>(
    !existing || existing?.name_suffix != null,
  )
  const [taskType, setTaskType] = useState<TaskType>(existing?.task_type ?? 'dev')
  const [prompt, setPrompt] = useState<string>(existing?.payload?.prompt ?? '')
  const [notes, setNotes] = useState<string>(() => {
    const existingNotes = existing?.payload?.notes ?? ''
    if (existingNotes) return existingNotes
    const initialType = existing?.task_type ?? 'dev'
    return TASK_TEMPLATES[initialType] ?? ''
  })

  useEffect(() => {
    if (existing) return
    setNotes(prev => isReplaceableNotes(prev) ? (TASK_TEMPLATES[taskType] ?? '') : prev)
  }, [taskType, existing])

  const [scheduleRules, setScheduleRules] = useState<ScheduleRule[]>(() => {
    const r = existing?.schedule_rules
    if (Array.isArray(r) && r.length > 0) return r as ScheduleRule[]
    return [defaultRule()]
  })

  const browserTz = browserTimezone()
  const initialTz = existing?.timezone ?? browserTz
  const tzInList = COMMON_TZS.includes(initialTz) || initialTz === browserTz
  const [tzMode, setTzMode] = useState<'preset' | 'custom'>(tzInList ? 'preset' : 'custom')
  const [tz, setTz] = useState(initialTz)

  const [targetKind, setTargetKind] = useState<TargetKind>(existing?.target_kind ?? 'session')
  const [targetId, setTargetId] = useState<string | null>(existing?.target_id ?? null)

  const [catchup, setCatchup] = useState<CatchupPolicy>(existing?.catchup_policy ?? 'skip')
  const [maxConcurrent, setMaxConcurrent] = useState(existing?.max_concurrent ?? 1)
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)

  const [postRunActions, setPostRunActions] = useState<PostRunAction[]>(existing?.post_run_actions ?? [])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cycleError, setCycleError] = useState<{ path: string[] } | null>(null)

  const cronExpr = useMemo(() => {
    if (!scheduleRules[0]) return ''
    try { return ruleToCron(scheduleRules[0], tz) } catch { return '' }
  }, [scheduleRules, tz])
  const rulesValid = useMemo(
    () => scheduleRules.length > 0 && scheduleRules.every(r => validateRule(r) === null),
    [scheduleRules],
  )
  const cronValidation = useMemo(() => {
    if (!rulesValid) return { ok: false, error: 'Pick a valid date/time for each rule' } as const
    return validateCron(cronExpr)
  }, [cronExpr, rulesValid])

  const intervalMinutes = useMemo(() => {
    if (!cronValidation.ok) return null
    const r = nextRuns(cronExpr, tz, 2)
    if (r.length < 2) return null
    return Math.round((r[1].getTime() - r[0].getTime()) / 60000)
  }, [cronExpr, tz, cronValidation.ok])
  const subFifteenWarn = intervalMinutes !== null && intervalMinutes < 15 && taskType !== 'dev'

  const [supervisors, setSupervisors] = useState<Supervisor[]>([])
  useEffect(() => {
    if (targetKind !== 'supervisor' || !token) return
    let cancelled = false
    void hubFetch<{ supervisors?: Supervisor[] } | Supervisor[]>(token, '/api/supervisors')
      .then((d: any) => {
        if (cancelled) return
        const list = Array.isArray(d) ? d : Array.isArray(d?.supervisors) ? d.supervisors : []
        setSupervisors(list)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [targetKind, token])

  const { sessions } = useSessions(token)

  const prefix = useMemo(() => {
    const payload: Record<string, any> = {}
    if (taskType === 'dev') payload.prompt = prompt
    if (taskType === 'security' || taskType === 'log_check') {
      if (notes) payload.notes = notes
    }
    return computeTaskAutoName(
      {
        task_type: taskType,
        target_kind: targetKind,
        target_id: targetKind === 'session' || targetKind === 'supervisor' ? targetId : null,
        payload,
        cron_expr: cronExpr,
      },
      { sessions, supervisors },
    )
  }, [taskType, targetKind, targetId, prompt, notes, cronExpr, sessions, supervisors])

  useEffect(() => {
    if (suffixHydrated) return
    if (!prefix) return
    const raw = (existing?.name ?? '').trim()
    if (!raw) { setSuffixHydrated(true); return }
    const lowerRaw = raw.toLowerCase()
    const lowerPrefix = prefix.toLowerCase()
    if (lowerRaw.startsWith(lowerPrefix)) {
      let rest = raw.slice(prefix.length).trim()
      rest = rest.replace(/^[—\-:]+\s*/, '')
      setNameSuffix(rest)
    }
    setSuffixHydrated(true)
  }, [prefix, suffixHydrated, existing?.name])

  const handleSubmit = async () => {
    setError(null)
    setCycleError(null)
    if (!cronValidation.ok) { setError(cronValidation.error || 'Invalid cron expression'); return }
    if ((targetKind === 'session' || targetKind === 'supervisor') && !targetId) {
      setError(`Choose a ${targetKind}`); return
    }
    if (!prefix) { setError('Pick a task type, target, and schedule first'); return }

    for (let i = 0; i < postRunActions.length; i++) {
      const a = postRunActions[i]
      if (a.type === 'webhook' && !(a.config?.url ?? '').trim()) {
        setError(`Post-run action #${i + 1}: webhook URL is required`); return
      }
      if (a.type === 'chain_task' && !(a.config?.task_id ?? '').trim()) {
        setError(`Post-run action #${i + 1}: choose a task to chain`); return
      }
    }

    const cleanedActions: PostRunAction[] = postRunActions.map(a => {
      if (a.type === 'notify_email') {
        const cfg = { ...(a.config || {}) }
        if (typeof cfg.to === 'string' && cfg.to.trim() === '') delete cfg.to
        return { ...a, config: cfg }
      }
      return a
    })

    const payload: Record<string, any> = {}
    if (taskType === 'dev') payload.prompt = prompt.trim()
    if (taskType === 'security' || taskType === 'log_check') {
      if (notes.trim()) payload.notes = notes.trim()
    }

    const input: ScheduleCreateInput = {
      name_suffix: nameSuffix.trim(),
      task_type: taskType,
      target_kind: targetKind,
      target_id: targetKind === 'session' || targetKind === 'supervisor' ? targetId : null,
      payload,
      schedule_rules: scheduleRules,
      timezone: tz,
      catchup_policy: catchup,
      max_concurrent: maxConcurrent,
      enabled,
      post_run_actions: cleanedActions,
    }

    setSaving(true)
    try {
      await onSave(input)
    } catch (e) {
      if (e instanceof HubFetchError) {
        if (e.body?.error === 'chain_cycle' && Array.isArray(e.body?.path)) {
          setCycleError({ path: e.body.path })
        } else {
          setError(e.message || 'Save failed')
        }
      } else if (e instanceof Error) {
        setError(e.message)
      } else {
        setError('Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  const selectCls = 'w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-orange-500'
  const previewNext = cronValidation.ok ? nextRuns(cronExpr, tz, 1)[0] : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[var(--bg-secondary)] rounded-xl ring-1 ring-white/5 max-w-3xl w-full max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3.5 bg-[var(--bg-secondary)]/95 backdrop-blur-sm">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {existing ? 'Edit schedule' : 'New schedule'}
          </h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-2xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Row: Task type + Target kind */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Task type">
              <select
                value={taskType}
                onChange={(e) => setTaskType(e.target.value as TaskType)}
                className={selectCls}
              >
                {TASK_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Target">
              <select
                value={targetKind}
                onChange={(e) => { setTargetKind(e.target.value as TargetKind); setTargetId(null) }}
                className={selectCls}
              >
                {TARGET_KINDS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
          </div>

          {/* Row: Target selector + Timezone */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label={targetKind === 'session' ? 'Session' : targetKind === 'supervisor' ? 'Supervisor' : 'Scope'}>
              {targetKind === 'session' && (
                <select
                  value={targetId ?? ''}
                  onChange={(e) => setTargetId(e.target.value || null)}
                  className={selectCls}
                >
                  <option value="">Choose a session...</option>
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>{s.name}{s.project_dir ? ` — ${s.project_dir}` : ''}</option>
                  ))}
                </select>
              )}
              {targetKind === 'supervisor' && (
                <select
                  value={targetId ?? ''}
                  onChange={(e) => setTargetId(e.target.value || null)}
                  className={selectCls}
                >
                  <option value="">Choose a supervisor...</option>
                  {supervisors.map(s => (
                    <option key={s.id} value={s.id}>{s.hostname}{s.online ? '' : ' (offline)'}</option>
                  ))}
                </select>
              )}
              {(targetKind === 'all_agents' || targetKind === 'all_supervisors') && (
                <div className="px-3 py-2 text-sm text-[var(--text-muted)] bg-[var(--bg-primary)]/40 rounded-lg">
                  Fans out to every {targetKind === 'all_agents' ? 'online session' : 'supervisor'}.
                </div>
              )}
            </Field>
            <Field label="Timezone">
              <div className="space-y-2">
                <select
                  value={tzMode === 'preset' ? tz : '__other__'}
                  onChange={(e) => {
                    if (e.target.value === '__other__') { setTzMode('custom') }
                    else { setTzMode('preset'); setTz(e.target.value) }
                  }}
                  className={selectCls}
                >
                  {!COMMON_TZS.includes(browserTz) && (
                    <option value={browserTz}>{browserTz} (browser)</option>
                  )}
                  {COMMON_TZS.map(t => <option key={t} value={t}>{t}{t === browserTz ? ' (browser)' : ''}</option>)}
                  <option value="__other__">Other...</option>
                </select>
                {tzMode === 'custom' && (
                  <input
                    value={tz}
                    onChange={(e) => setTz(e.target.value)}
                    placeholder="e.g. Africa/Cairo"
                    className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm font-mono text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                )}
              </div>
            </Field>
          </div>

          {/* Schedule + next-run preview */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 md:items-start">
            <Field label="Schedule">
              <ScheduleRulesBuilder rules={scheduleRules} timezone={tz} onChange={setScheduleRules} />
            </Field>
            {previewNext && (
              <div className="md:mt-6 inline-flex items-center px-3 py-2 rounded-lg bg-orange-600/20 ring-1 ring-orange-500/30 text-xs text-orange-300 whitespace-nowrap self-start">
                Next: {previewNext.toLocaleString(undefined, { timeZone: tz, dateStyle: 'short', timeStyle: 'short' })}
              </div>
            )}
          </div>

          {subFifteenWarn && (
            <div className="bg-amber-500/10 ring-1 ring-amber-500/30 rounded-lg p-3 text-xs text-amber-300">
              Running this task more often than every 15 minutes is generally not recommended for
              non-prompt task types. Consider increasing the interval.
            </div>
          )}

          {/* Row: catchup + max concurrent + enabled */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Catchup policy">
              <select
                value={catchup}
                onChange={(e) => setCatchup(e.target.value as CatchupPolicy)}
                className={selectCls}
              >
                <option value="skip">Skip missed runs</option>
                <option value="run_once">Run once on resume</option>
              </select>
            </Field>
            <Field label="Max concurrent">
              <input
                type="number"
                min={1}
                max={10}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(Math.max(1, Math.min(10, parseInt(e.target.value || '1', 10))))}
                className={selectCls}
              />
            </Field>
            <Field label="Enabled">
              <label className="flex items-center gap-3 cursor-pointer select-none h-[38px]">
                <button
                  type="button"
                  onClick={() => setEnabled(!enabled)}
                  aria-pressed={enabled}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-orange-600' : 'bg-[var(--bg-tertiary)]'}`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}`} />
                </button>
                <span className="text-sm text-[var(--text-primary)]">{enabled ? 'On' : 'Off'}</span>
              </label>
            </Field>
          </div>

          {/* Name */}
          <Field label="Name">
            <div className="flex items-stretch rounded-lg bg-[var(--bg-primary)]/60 focus-within:ring-2 focus-within:ring-orange-500 overflow-hidden">
              <div
                className="px-3 py-2 text-sm bg-[var(--bg-tertiary)]/50 whitespace-nowrap font-medium select-text max-w-[60%] overflow-hidden text-ellipsis"
                title={prefix || 'Auto-generated prefix'}
              >
                {prefix
                  ? <span className="text-[var(--text-secondary)]">{prefix}</span>
                  : <span className="text-[var(--text-muted)] italic">Auto…</span>}
              </div>
              <input
                value={nameSuffix}
                onChange={(e) => setNameSuffix(e.target.value)}
                placeholder="(optional) add a note — e.g. nightly, high-priority"
                className="flex-1 min-w-0 bg-transparent px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
              />
            </div>
            <p className="mt-1.5 text-xs text-[var(--text-muted)]">
              Name auto-updates when type, target, or schedule changes. The prefix is fixed; type to add your own note after it.
            </p>
          </Field>

          {/* Prompt / Notes */}
          {taskType === 'dev' && (
            <Field label="Prompt">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="What should Claude do?"
                className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-orange-500 resize-y min-h-[100px]"
              />
            </Field>
          )}
          {(taskType === 'security' || taskType === 'log_check') && (
            <Field label="Notes (optional)">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Any custom instructions..."
                className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-orange-500 resize-y"
              />
            </Field>
          )}

          {/* Post-run actions */}
          <PostRunActionsEditor
            actions={postRunActions}
            onChange={setPostRunActions}
            currentTaskId={existing?.id ?? null}
            allSchedules={allSchedules}
            cycleErrorPath={cycleError?.path}
          />

          {error && (
            <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg p-3 text-sm text-red-300">{error}</div>
          )}
          {cycleError && (
            <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg p-3 text-sm text-red-300">
              Chain creates a cycle: {cycleError.path.join(' → ')}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 px-5 py-3 bg-[var(--bg-secondary)]/95 backdrop-blur-sm">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40 rounded-lg transition-colors"
          >Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={saving || !cronValidation.ok || !prefix}
            className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors"
          >
            {saving ? 'Saving...' : (existing ? 'Save changes' : 'Create schedule')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- */
/* Sub-components                                                      */
/* ----------------------------------------------------------------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <label className="block text-xs text-[var(--text-muted)] mb-1.5">{label}</label>}
      {children}
    </div>
  )
}
