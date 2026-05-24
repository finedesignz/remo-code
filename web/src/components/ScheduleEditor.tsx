import { useEffect, useMemo, useState } from 'react'
import type { ScheduledTask, ScheduleCreateInput, TaskType, TargetKind, CatchupPolicy, PostRunAction } from '../hooks/useSchedules'
import { useCommands, type CommandRow } from '../hooks/useCommands'
import { useSessions } from '../hooks/useSessions'
import { hubFetch, HubFetchError } from '../lib/api'
import { compilePreset, nextRuns, validate as validateCron, browserTimezone, type Preset } from '../lib/cron'
import { PostRunActionsEditor } from './PostRunActionsEditor'
import { formatLocalTs, describeCron } from './SchedulesPage'

interface Props {
  token: string
  existing: ScheduledTask | null
  allSchedules: ScheduledTask[]
  onClose: () => void
  onSave: (data: ScheduleCreateInput) => Promise<void>
}

type PresetKind = Preset['kind']

interface Supervisor {
  id: string
  hostname: string
  online: boolean
}

const TASK_TYPES: Array<{ value: TaskType; label: string; desc: string }> = [
  { value: 'prompt', label: 'Prompt', desc: 'Send a freeform prompt' },
  { value: 'skill', label: 'Skill / slash command', desc: 'Invoke a synced command' },
  { value: 'security_scan', label: 'Security scan', desc: 'Routine security audit' },
  { value: 'log_check', label: 'Log check', desc: 'Pull and analyze server logs' },
  { value: 'continue_dev', label: 'Continue dev', desc: 'Keep development moving' },
]

const TARGET_KINDS: Array<{ value: TargetKind; label: string; desc: string }> = [
  { value: 'session', label: 'A specific session', desc: 'One Claude Code session' },
  { value: 'supervisor', label: 'A specific supervisor', desc: 'One supervisor host' },
  { value: 'all_agents', label: 'All connected agents', desc: 'Fan out to every online session' },
  { value: 'all_supervisors', label: 'All supervisors', desc: 'Fan out to every supervisor' },
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
  const [name, setName] = useState(existing?.name ?? '')
  const [taskType, setTaskType] = useState<TaskType>(existing?.task_type ?? 'prompt')
  const [prompt, setPrompt] = useState<string>(existing?.payload?.prompt ?? '')
  const [skillName, setSkillName] = useState<string>(existing?.payload?.command ?? '')
  const [notes, setNotes] = useState<string>(existing?.payload?.notes ?? '')

  // Schedule
  const initialPreset = existing ? detectPreset(existing.cron_expr) : { kind: 'daily' as const, hh: 9, mm: 0 }
  const [presetKind, setPresetKind] = useState<PresetKind>(initialPreset.kind)
  const [daily, setDaily] = useState({ hh: initialPreset.kind === 'daily' ? initialPreset.hh : 9, mm: initialPreset.kind === 'daily' ? initialPreset.mm : 0 })
  const [everyN, setEveryN] = useState(initialPreset.kind === 'every_n_minutes' ? initialPreset.n : 30)
  const [weekdays, setWeekdays] = useState({ hh: initialPreset.kind === 'weekdays' ? initialPreset.hh : 9, mm: initialPreset.kind === 'weekdays' ? initialPreset.mm : 0 })
  const [customExpr, setCustomExpr] = useState(initialPreset.kind === 'custom' ? initialPreset.expr : (existing?.cron_expr ?? '0 9 * * *'))

  // Timezone
  const browserTz = browserTimezone()
  const initialTz = existing?.timezone ?? browserTz
  const tzInList = COMMON_TZS.includes(initialTz) || initialTz === browserTz
  const [tzMode, setTzMode] = useState<'preset' | 'custom'>(tzInList ? 'preset' : 'custom')
  const [tz, setTz] = useState(initialTz)

  // Target
  const [targetKind, setTargetKind] = useState<TargetKind>(existing?.target_kind ?? 'session')
  const [targetId, setTargetId] = useState<string | null>(existing?.target_id ?? null)

  // Options
  const [catchup, setCatchup] = useState<CatchupPolicy>(existing?.catchup_policy ?? 'skip')
  const [maxConcurrent, setMaxConcurrent] = useState(existing?.max_concurrent ?? 1)
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)

  // Post-run actions
  const [postRunActions, setPostRunActions] = useState<PostRunAction[]>(existing?.post_run_actions ?? [])

  // Submit
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cycleError, setCycleError] = useState<{ path: string[] } | null>(null)

  // Compile cron from preset
  const preset = buildPreset(presetKind, { daily, everyN, weekdays, customExpr })
  const cronExpr = useMemo(() => {
    try { return compilePreset(preset) } catch { return '' }
  }, [preset.kind, (preset as any).hh, (preset as any).mm, (preset as any).n, (preset as any).expr])
  const cronValidation = useMemo(() => validateCron(cronExpr), [cronExpr])
  const next3 = useMemo(() => cronValidation.ok ? nextRuns(cronExpr, tz, 3) : [], [cronExpr, tz, cronValidation.ok])

  // Sub-15 warning for non-prompt
  const intervalMinutes = estimateIntervalMinutes(preset)
  const subFifteenWarn = intervalMinutes !== null && intervalMinutes < 15 && taskType !== 'prompt'

  // Fetch supervisors when needed
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

  // Sessions for picker
  const { sessions } = useSessions(token)

  // Commands for skill picker
  const { rows: commands } = useCommands(taskType === 'skill' ? token : null)

  const handleSubmit = async () => {
    setError(null)
    setCycleError(null)
    if (!name.trim()) { setError('Name is required'); return }
    if (!cronValidation.ok) { setError(cronValidation.error || 'Invalid cron expression'); return }
    if ((targetKind === 'session' || targetKind === 'supervisor') && !targetId) {
      setError(`Choose a ${targetKind}`); return
    }

    const payload: Record<string, any> = {}
    if (taskType === 'prompt') payload.prompt = prompt.trim()
    if (taskType === 'skill') payload.command = skillName.trim()
    if (taskType === 'security_scan' || taskType === 'log_check' || taskType === 'continue_dev') {
      if (notes.trim()) payload.notes = notes.trim()
    }

    const input: ScheduleCreateInput = {
      name: name.trim(),
      task_type: taskType,
      target_kind: targetKind,
      target_id: targetKind === 'session' || targetKind === 'supervisor' ? targetId : null,
      payload,
      cron_expr: cronExpr,
      timezone: tz,
      catchup_policy: catchup,
      max_concurrent: maxConcurrent,
      enabled,
      post_run_actions: postRunActions,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/95 backdrop-blur-sm">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {existing ? 'Edit schedule' : 'New schedule'}
          </h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-2xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Name */}
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nightly security scan"
              className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </Field>

          {/* Task type */}
          <Field label="Task type">
            <RadioGroup
              options={TASK_TYPES}
              value={taskType}
              onChange={setTaskType}
            />
          </Field>

          {/* Task body */}
          {taskType === 'prompt' && (
            <Field label="Prompt">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="What should Claude do?"
                className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y min-h-[100px]"
              />
            </Field>
          )}
          {taskType === 'skill' && (
            <Field label="Slash command">
              <CommandPicker token={token} commands={commands} value={skillName} onChange={setSkillName} />
            </Field>
          )}
          {(taskType === 'security_scan' || taskType === 'log_check' || taskType === 'continue_dev') && (
            <Field label="Notes (optional)">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Any custom instructions..."
                className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
              />
            </Field>
          )}

          {/* Schedule preset */}
          <Field label="Schedule">
            <div className="space-y-2">
              <select
                value={presetKind}
                onChange={(e) => setPresetKind(e.target.value as PresetKind)}
                className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily at HH:MM</option>
                <option value="every_n_minutes">Every N minutes</option>
                <option value="weekdays">Weekdays at HH:MM</option>
                <option value="custom">Custom cron expression</option>
              </select>
              {presetKind === 'daily' && (
                <TimePicker hh={daily.hh} mm={daily.mm} onChange={(hh, mm) => setDaily({ hh, mm })} />
              )}
              {presetKind === 'weekdays' && (
                <TimePicker hh={weekdays.hh} mm={weekdays.mm} onChange={(hh, mm) => setWeekdays({ hh, mm })} />
              )}
              {presetKind === 'every_n_minutes' && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={59}
                    value={everyN}
                    onChange={(e) => setEveryN(Math.max(1, Math.min(59, parseInt(e.target.value || '1', 10))))}
                    className="w-20 px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-[var(--text-muted)]">minutes</span>
                </div>
              )}
              {presetKind === 'custom' && (
                <input
                  value={customExpr}
                  onChange={(e) => setCustomExpr(e.target.value)}
                  placeholder="0 9 * * *"
                  className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm font-mono text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              )}
              {!cronValidation.ok && cronExpr && (
                <p className="text-xs text-red-400">Invalid: {cronValidation.error}</p>
              )}
              {cronValidation.ok && (
                <p className="text-xs text-[var(--text-muted)] font-mono">
                  {describeCron(cronExpr)} <span className="text-[var(--text-muted)]/60">·</span> <span className="text-[var(--text-secondary)]">{cronExpr}</span>
                </p>
              )}
            </div>
          </Field>

          {/* Timezone */}
          <Field label="Timezone">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={tzMode === 'preset' ? tz : '__other__'}
                  onChange={(e) => {
                    if (e.target.value === '__other__') { setTzMode('custom') }
                    else { setTzMode('preset'); setTz(e.target.value) }
                  }}
                  className="flex-1 px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {!COMMON_TZS.includes(browserTz) && (
                    <option value={browserTz}>{browserTz} (browser)</option>
                  )}
                  {COMMON_TZS.map(t => <option key={t} value={t}>{t}{t === browserTz ? ' (browser)' : ''}</option>)}
                  <option value="__other__">Other...</option>
                </select>
              </div>
              {tzMode === 'custom' && (
                <input
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  placeholder="e.g. Africa/Cairo"
                  className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm font-mono text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              )}
            </div>
          </Field>

          {/* Next 3 runs preview */}
          {cronValidation.ok && next3.length > 0 && (
            <div className="bg-[var(--bg-primary)]/60 rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">Next 3 runs</div>
              <ul className="space-y-1">
                {next3.map((d, i) => (
                  <li key={i} className="text-xs text-[var(--text-secondary)] font-mono">{formatLocalTs(d)}</li>
                ))}
              </ul>
            </div>
          )}

          {subFifteenWarn && (
            <div className="bg-amber-500/10 ring-1 ring-amber-500/30 rounded-lg p-3 text-xs text-amber-300">
              Running this task more often than every 15 minutes is generally not recommended for
              non-prompt task types. Consider increasing the interval.
            </div>
          )}

          {/* Target */}
          <Field label="Target">
            <RadioGroup
              options={TARGET_KINDS}
              value={targetKind}
              onChange={(v) => { setTargetKind(v); setTargetId(null) }}
            />
            {targetKind === 'session' && (
              <div className="mt-2">
                <select
                  value={targetId ?? ''}
                  onChange={(e) => setTargetId(e.target.value || null)}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Choose a session...</option>
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>{s.name}{s.project_dir ? ` — ${s.project_dir}` : ''}</option>
                  ))}
                </select>
              </div>
            )}
            {targetKind === 'supervisor' && (
              <div className="mt-2">
                <select
                  value={targetId ?? ''}
                  onChange={(e) => setTargetId(e.target.value || null)}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Choose a supervisor...</option>
                  {supervisors.map(s => (
                    <option key={s.id} value={s.id}>{s.hostname}{s.online ? '' : ' (offline)'}</option>
                  ))}
                </select>
              </div>
            )}
          </Field>

          {/* Options */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Catchup policy">
              <select
                value={catchup}
                onChange={(e) => setCatchup(e.target.value as CatchupPolicy)}
                className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
                className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </Field>
          </div>

          {/* Enabled toggle */}
          <Field label="">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                aria-pressed={enabled}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-[var(--bg-tertiary)]'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}`} />
              </button>
              <span className="text-sm text-[var(--text-primary)]">Enabled</span>
            </label>
          </Field>

          {/* Post-run actions */}
          <PostRunActionsEditor
            actions={postRunActions}
            onChange={setPostRunActions}
            currentTaskId={existing?.id ?? null}
            allSchedules={allSchedules}
            cycleErrorPath={cycleError?.path}
          />

          {/* Errors */}
          {error && (
            <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg p-3 text-sm text-red-300">{error}</div>
          )}
          {cycleError && (
            <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg p-3 text-sm text-red-300">
              Chain creates a cycle: {cycleError.path.join(' → ')}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)]/95 backdrop-blur-sm">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40 rounded-lg transition-colors"
          >Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={saving || !cronValidation.ok || !name.trim()}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors"
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

function RadioGroup<T extends string>({
  options, value, onChange,
}: {
  options: Array<{ value: T; label: string; desc?: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="space-y-1">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
            value === opt.value
              ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'
          }`}
        >
          <div className="text-sm font-medium">{opt.label}</div>
          {opt.desc && <div className="text-xs text-[var(--text-muted)] mt-0.5">{opt.desc}</div>}
        </button>
      ))}
    </div>
  )
}

function TimePicker({ hh, mm, onChange }: { hh: number; mm: number; onChange: (hh: number, mm: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number" min={0} max={23} value={hh}
        onChange={(e) => onChange(clamp(parseInt(e.target.value || '0', 10), 0, 23), mm)}
        className="w-16 px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
      />
      <span className="text-[var(--text-muted)]">:</span>
      <input
        type="number" min={0} max={59} value={mm}
        onChange={(e) => onChange(hh, clamp(parseInt(e.target.value || '0', 10), 0, 59))}
        className="w-16 px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
      />
      <span className="text-xs text-[var(--text-muted)] ml-1">24-hour</span>
    </div>
  )
}

function CommandPicker({
  token, commands, value, onChange,
}: {
  token: string
  commands: CommandRow[]
  value: string
  onChange: (v: string) => void
}) {
  const [search, setSearch] = useState('')
  const hasCommands = commands.length > 0

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return commands.slice(0, 50)
    return commands.filter(c =>
      c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)
    ).slice(0, 50)
  }, [commands, search])

  if (!hasCommands) {
    return (
      <div className="space-y-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/security-review"
          className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <p className="text-xs text-[var(--text-muted)]">
          No synced commands yet. Type a slash command manually or connect a supervisor to sync commands.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search commands..."
        className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      <div className="max-h-60 overflow-y-auto bg-[var(--bg-primary)]/60 rounded-lg divide-y divide-white/5">
        {filtered.map(c => {
          const display = c.kind === 'skill' ? `/${c.name}` : `/${c.name}`
          const selected = value === display
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(display)}
              className={`w-full text-left px-3 py-2 transition-colors ${
                selected
                  ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-[var(--text-primary)]'
                  : 'hover:bg-[var(--bg-tertiary)]/40 text-[var(--text-secondary)]'
              }`}
            >
              <div className="text-sm font-mono">{display}</div>
              {c.description && <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{c.description}</div>}
            </button>
          )
        })}
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-xs text-[var(--text-muted)] text-center">No matches</div>
        )}
      </div>
      {value && (
        <p className="text-xs text-[var(--text-muted)]">Selected: <span className="font-mono text-emerald-300">{value}</span></p>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- */
/* Helpers                                                             */
/* ----------------------------------------------------------------- */

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min
  return Math.max(min, Math.min(max, v))
}

function buildPreset(
  kind: PresetKind,
  state: { daily: { hh: number; mm: number }; everyN: number; weekdays: { hh: number; mm: number }; customExpr: string },
): Preset {
  switch (kind) {
    case 'hourly': return { kind: 'hourly' }
    case 'daily': return { kind: 'daily', hh: state.daily.hh, mm: state.daily.mm }
    case 'every_n_minutes': return { kind: 'every_n_minutes', n: state.everyN }
    case 'weekdays': return { kind: 'weekdays', hh: state.weekdays.hh, mm: state.weekdays.mm }
    case 'custom': return { kind: 'custom', expr: state.customExpr }
  }
}

function detectPreset(expr: string): Preset {
  const parts = (expr || '').split(/\s+/)
  if (parts.length !== 5) return { kind: 'custom', expr }
  const [m, h, dom, mon, dow] = parts
  if (m === '0' && h === '*' && dom === '*' && mon === '*' && dow === '*') return { kind: 'hourly' }
  if (m.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = parseInt(m.slice(2), 10)
    if (Number.isFinite(n) && n >= 1 && n <= 59) return { kind: 'every_n_minutes', n }
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') {
    return { kind: 'daily', hh: parseInt(h, 10), mm: parseInt(m, 10) }
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '1-5') {
    return { kind: 'weekdays', hh: parseInt(h, 10), mm: parseInt(m, 10) }
  }
  return { kind: 'custom', expr }
}

function estimateIntervalMinutes(preset: Preset): number | null {
  switch (preset.kind) {
    case 'hourly': return 60
    case 'daily': return 60 * 24
    case 'weekdays': return 60 * 24
    case 'every_n_minutes': return preset.n
    case 'custom': return null
  }
}
