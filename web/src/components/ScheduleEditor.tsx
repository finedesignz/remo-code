import { useEffect, useMemo, useState } from 'react'
import type { ScheduledTask, ScheduleCreateInput, TaskType, TargetKind, CatchupPolicy, PostRunAction } from '../hooks/useSchedules'
import { useSessions } from '../hooks/useSessions'
import { hubFetch, HubFetchError } from '../lib/api'
import { nextRuns, validate as validateCron, browserTimezone } from '../lib/cron'
import { BranchPicker } from './BranchPicker'
import { TeabRepoPicker } from './TeabRepoPicker'
import { PostRunActionsEditor } from './PostRunActionsEditor'
import { ScheduleRulesBuilder } from './ScheduleRulesBuilder'
import { type ScheduleRule, ruleToCron, defaultRule, validateRule } from '../lib/schedule-rules'
import { computeTaskAutoName } from '../lib/task-name'
import { TASK_TEMPLATES, fillNotesPlaceholders } from '../lib/task-templates'
import { type GsdTemplate, templateScheduleRules, buildGsdTemplatePrompt } from '../lib/gsd-templates'

interface Props {
  token: string
  existing: ScheduledTask | null
  allSchedules: ScheduledTask[]
  /**
   * Optional GSD template to pre-fill a NEW task from (sugar over the normal
   * create). Ignored when `existing` is set (editing). Sets the prompt,
   * task_type, cadence, and default post-run actions; round-trips
   * `payload.template_id` + `payload.args.gsd` on save.
   */
  template?: GsdTemplate | null
  /**
   * Signed-in user's email, used to auto-fill the `<your@email>` /
   * NOTIFY_EMAIL placeholder in the prefilled Notes template.
   */
  userEmail?: string
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
  { value: 'teab', label: 'TEAB build' },
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

export function ScheduleEditor({ token, existing, allSchedules, template, userEmail, onClose, onSave }: Props) {
  // A template prefill only applies to NEW tasks (never override an edit).
  const tpl = existing ? null : template ?? null
  // Basic fields
  const [nameSuffix, setNameSuffix] = useState<string>(
    existing?.name_suffix ?? existing?.name ?? '',
  )
  const [suffixHydrated, setSuffixHydrated] = useState<boolean>(
    !existing || existing?.name_suffix != null,
  )
  const [taskType, setTaskType] = useState<TaskType>(existing?.task_type ?? tpl?.taskType ?? 'dev')
  // Prompt lives in `payload.prompt` (canonical) but legacy rows persisted it
  // only in the top-level `prompt` column — fall back to that so older tasks
  // still display their custom prompt on reopen.
  const [prompt, setPrompt] = useState<string>(
    existing?.payload?.prompt ?? (existing as any)?.prompt ?? (tpl ? buildGsdTemplatePrompt(tpl) : '') ?? '',
  )
  const [notes, setNotes] = useState<string>(() => {
    const existingNotes = existing?.payload?.notes ?? ''
    if (existingNotes) return existingNotes
    const initialType = existing?.task_type ?? 'dev'
    return fillNotesPlaceholders(TASK_TEMPLATES[initialType] ?? '', { email: userEmail })
  })
  // Once the user types into Notes we never auto-overwrite their text (incl.
  // editing an existing task, whose notes are treated as already authored).
  const [notesEdited, setNotesEdited] = useState<boolean>(!!(existing?.payload?.notes))

  const [scheduleRules, setScheduleRules] = useState<ScheduleRule[]>(() => {
    const r = existing?.schedule_rules
    if (Array.isArray(r) && r.length > 0) return r as ScheduleRule[]
    if (tpl) return templateScheduleRules(tpl)
    return [defaultRule()]
  })

  const browserTz = browserTimezone()
  const initialTz = existing?.timezone ?? browserTz
  const tzInList = COMMON_TZS.includes(initialTz) || initialTz === browserTz
  const [tzMode, setTzMode] = useState<'preset' | 'custom'>(tzInList ? 'preset' : 'custom')
  const [tz, setTz] = useState(initialTz)

  const [targetKind, setTargetKind] = useState<TargetKind>(existing?.target_kind ?? 'session')
  const [targetId, setTargetId] = useState<string | null>(existing?.target_id ?? null)
  // Branch the task should run against, mirroring the Connect/Start launch flow.
  // Stored additively in `payload.branch` (loose JSONB — no schema change).
  const [branch, setBranch] = useState<string>(existing?.payload?.branch ?? '')

  // Milestone TEAB — target repo for a `teab` build task (`teab run --repo <X>`).
  // Persisted on the dedicated `teab_repo_ident` column, not in payload.
  const [teabRepoIdent, setTeabRepoIdent] = useState<string>(existing?.teab_repo_ident ?? '')
  const isTeab = taskType === 'teab'
  // A `teab` task self-resolves its supervisor from the repo, so the generic
  // target picker is hidden and the target is normalized to all_supervisors
  // (keeps the auto-name non-empty + the API target_id requirement satisfied).
  useEffect(() => {
    if (taskType !== 'teab') return
    setTargetKind('all_supervisors')
    setTargetId(null)
  }, [taskType])

  // Coolify app bound to the selected target session (for the
  // `<coolify-app-slug>` / `<coolify-uuid>` placeholders). Resolved lazily from
  // the cache; unresolved values leave the placeholder intact.
  const [coolifyApp, setCoolifyApp] = useState<{ slug: string | null; uuid: string | null }>({ slug: null, uuid: null })
  useEffect(() => {
    if (targetKind !== 'session' || !targetId || !token) {
      setCoolifyApp({ slug: null, uuid: null })
      return
    }
    let cancelled = false
    void hubFetch<{ application_uuid?: string | null; app_slug?: string | null }>(
      token, `/api/sessions/${targetId}/coolify-app`,
    )
      .then((d) => {
        if (cancelled) return
        setCoolifyApp({ slug: d?.app_slug ?? null, uuid: d?.application_uuid ?? null })
      })
      .catch(() => { if (!cancelled) setCoolifyApp({ slug: null, uuid: null }) })
    return () => { cancelled = true }
  }, [targetKind, targetId, token])

  // The notes template prefilled with every placeholder we can resolve from the
  // current user + selected target. Reactive: changing target/type re-resolves.
  const resolvedNotesTemplate = useMemo(
    () => fillNotesPlaceholders(TASK_TEMPLATES[taskType] ?? '', {
      email: userEmail,
      coolifyAppSlug: coolifyApp.slug,
      coolifyAppUuid: coolifyApp.uuid,
    }),
    [taskType, userEmail, coolifyApp.slug, coolifyApp.uuid],
  )

  useEffect(() => {
    if (existing) return
    if (notesEdited) return
    setNotes(resolvedNotesTemplate)
  }, [resolvedNotesTemplate, notesEdited, existing])

  const [catchup, setCatchup] = useState<CatchupPolicy>(existing?.catchup_policy ?? 'skip')
  const [maxConcurrent, setMaxConcurrent] = useState(existing?.max_concurrent ?? 1)
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)

  const [postRunActions, setPostRunActions] = useState<PostRunAction[]>(
    existing?.post_run_actions ?? (tpl?.defaultPostRunActions as PostRunAction[] | undefined) ?? [],
  )

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
    if (tpl) payload.template_id = tpl.id
    return computeTaskAutoName(
      {
        task_type: taskType,
        target_kind: targetKind,
        target_id: targetKind === 'session' || targetKind === 'supervisor' ? targetId : null,
        payload,
        cron_expr: cronExpr,
        teab_repo_ident: teabRepoIdent,
      },
      { sessions, supervisors },
    )
  }, [taskType, targetKind, targetId, prompt, notes, cronExpr, sessions, supervisors, tpl, teabRepoIdent])

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
    if (isTeab && !teabRepoIdent.trim()) { setError('Pick a repo for the TEAB build'); return }
    if (!isTeab && (targetKind === 'session' || targetKind === 'supervisor') && !targetId) {
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
    // Persist the chosen branch (repo→branch picker). Only meaningful for a
    // single-session target; additive JSONB field, ignored by older readers.
    if (targetKind === 'session' && targetId && branch.trim()) {
      payload.branch = branch.trim()
    }
    if (taskType === 'dev') payload.prompt = prompt.trim()
    if (taskType === 'security' || taskType === 'log_check') {
      if (notes.trim()) payload.notes = notes.trim()
    }
    // GSD template provenance — additive, fully back-compat (the hub payload is
    // loose JSONB). `args.gsd` carries operator intent the dev controller reads
    // without re-parsing the prompt. The cost cap is NOT touched here.
    if (tpl) {
      payload.template_id = tpl.id
      payload.args = {
        ...(payload.args ?? {}),
        gsd: { planFirst: tpl.guardrails.planFirst, autoMerge: tpl.guardrails.autoMerge },
      }
    }

    const input: ScheduleCreateInput = {
      name_suffix: nameSuffix.trim(),
      task_type: taskType,
      target_kind: isTeab ? 'all_supervisors' : targetKind,
      target_id: isTeab
        ? null
        : (targetKind === 'session' || targetKind === 'supervisor' ? targetId : null),
      payload,
      schedule_rules: scheduleRules,
      timezone: tz,
      catchup_policy: catchup,
      max_concurrent: maxConcurrent,
      enabled,
      post_run_actions: cleanedActions,
      ...(isTeab ? { teab_repo_ident: teabRepoIdent.trim() } : {}),
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
          <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
            {existing ? 'Edit schedule' : 'New schedule'}
            {tpl && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-600/20 text-blue-300 ring-1 ring-blue-500/30">
                GSD: {tpl.label}
              </span>
            )}
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
            {isTeab ? (
              <Field label="TEAB repo">
                <TeabRepoPicker token={token} value={teabRepoIdent} onChange={setTeabRepoIdent} />
              </Field>
            ) : (
              <Field label="Target">
                <select
                  value={targetKind}
                  onChange={(e) => { setTargetKind(e.target.value as TargetKind); setTargetId(null) }}
                  className={selectCls}
                >
                  {TARGET_KINDS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Field>
            )}
          </div>

          {/* Row: Target selector + Timezone */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {!isTeab && (
            <Field label={targetKind === 'session' ? 'Repo (session)' : targetKind === 'supervisor' ? 'Supervisor' : 'Scope'}>
              {targetKind === 'session' && (
                <select
                  value={targetId ?? ''}
                  onChange={(e) => { setTargetId(e.target.value || null); setBranch('') }}
                  className={selectCls}
                >
                  <option value="">Choose a session...</option>
                  {[...sessions].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map(s => (
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
            )}
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

          {/* Branch picker — mirrors the Connect/Start launch flow. Only shown
              for a single-session target (the session is the repo). */}
          {targetKind === 'session' && (
            <Field label="Branch">
              <BranchPicker
                token={token}
                sessionId={targetId}
                value={branch}
                onChange={setBranch}
              />
              <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                Pick the branch this task runs against — same picker as launching a session.
              </p>
            </Field>
          )}

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
                onChange={(e) => { setNotes(e.target.value); setNotesEdited(true) }}
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
