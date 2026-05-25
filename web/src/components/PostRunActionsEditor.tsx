import { useMemo, useState } from 'react'
import type { PostRunAction, PostRunActionType, PostRunActionOn, ScheduledTask } from '../hooks/useSchedules'

interface Props {
  actions: PostRunAction[]
  onChange: (next: PostRunAction[]) => void
  currentTaskId: string | null
  allSchedules: ScheduledTask[]
  cycleErrorPath?: string[]
}

const ACTION_TYPES: Array<{ value: PostRunActionType; label: string }> = [
  { value: 'chain_task', label: 'Chain another task' },
  { value: 'notify_email', label: 'Send email' },
  { value: 'notify_telegram', label: 'Send Telegram' },
  { value: 'notify_web_push', label: 'Web push notification' },
  { value: 'webhook', label: 'POST to webhook' },
]

const ON_VALUES: Array<{ value: PostRunActionOn; label: string }> = [
  { value: 'success', label: 'on success' },
  { value: 'failure', label: 'on failure' },
  { value: 'always', label: 'always' },
  { value: 'cost_exceeded', label: 'on cost cap exceeded' },
]

const TEMPLATE_VARS = [
  '{{task_name}}',
  '{{status}}',
  '{{output_snippet}}',
  '{{cost_usd}}',
  '{{duration_ms}}',
  '{{run_url}}',
]

function defaultActionConfig(type: PostRunActionType): Record<string, any> {
  switch (type) {
    case 'notify_email':
      return {
        to: '',
        subject: '[{{status}}] {{task_name}}',
        body:
          'Scheduled task "{{task_name}}" finished with status: {{status}}.\n\n' +
          'Duration: {{duration_ms}}ms\n' +
          'Cost: ${{cost_usd}}\n' +
          'Run: {{run_url}}\n\n' +
          '--- Output snippet ---\n' +
          '{{output_snippet}}',
      }
    case 'notify_telegram':
      return {
        body:
          '*{{task_name}}* — {{status}}\n' +
          'Duration: {{duration_ms}}ms · Cost: ${{cost_usd}}\n' +
          '[View run]({{run_url}})\n\n' +
          '`{{output_snippet}}`',
      }
    case 'notify_web_push':
      return {
        title: '{{task_name}} — {{status}}',
        body: '{{output_snippet}}',
      }
    case 'webhook':
      return { url: '' }
    case 'chain_task':
      return {}
    default:
      return {}
  }
}

export function PostRunActionsEditor({
  actions, onChange, currentTaskId, allSchedules, cycleErrorPath,
}: Props) {
  const [open, setOpen] = useState(actions.length > 0)

  const otherSchedules = useMemo(
    () => allSchedules.filter(s => s.id !== currentTaskId),
    [allSchedules, currentTaskId],
  )

  // Best-effort client-side cycle detection: if a chain target's chain set
  // (transitive) contains currentTaskId, mark it as a would-be cycle.
  const cycleSet = useMemo(() => {
    const result = new Set<string>()
    if (!currentTaskId) return result
    const graph = new Map<string, string[]>()
    for (const s of allSchedules) {
      const outs: string[] = []
      for (const a of s.post_run_actions || []) {
        if (a.type === 'chain_task' && a.config?.task_id) outs.push(a.config.task_id)
      }
      graph.set(s.id, outs)
    }
    // Add the in-progress draft chains too
    const draftOuts: string[] = []
    for (const a of actions) {
      if (a.type === 'chain_task' && a.config?.task_id) draftOuts.push(a.config.task_id)
    }
    if (currentTaskId) graph.set(currentTaskId, draftOuts)
    // For each candidate target, check if reaching it then following graph hits currentTaskId
    for (const candidate of otherSchedules) {
      if (canReach(candidate.id, currentTaskId, graph)) result.add(candidate.id)
    }
    return result
  }, [actions, currentTaskId, allSchedules, otherSchedules])

  const update = (idx: number, patch: Partial<PostRunAction>) => {
    onChange(actions.map((a, i) => i === idx ? { ...a, ...patch, config: patch.config ?? a.config } : a))
  }

  const updateConfig = (idx: number, patch: Record<string, any>) => {
    onChange(actions.map((a, i) => i === idx ? { ...a, config: { ...a.config, ...patch } } : a))
  }

  const add = () => {
    onChange([...actions, { type: 'notify_email', on: 'success', config: defaultActionConfig('notify_email') }])
    setOpen(true)
  }

  const remove = (idx: number) => {
    onChange(actions.filter((_, i) => i !== idx))
  }

  return (
    <div className="bg-[var(--bg-primary)]/40 rounded-xl">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3"
      >
        <div className="text-left">
          <div className="text-sm font-semibold text-[var(--text-primary)]">When this task finishes...</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">
            {actions.length === 0
              ? 'No actions yet — add one to chain another task or get notified'
              : `${actions.length} action${actions.length === 1 ? '' : 's'} configured`}
          </div>
        </div>
        <svg
          width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          className={`text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {actions.map((action, idx) => {
            const inCycle = cycleErrorPath && action.type === 'chain_task' && action.config?.task_id && cycleErrorPath.includes(action.config.task_id)
            return (
              <div
                key={idx}
                className={`rounded-lg p-3 space-y-2 ${
                  inCycle ? 'bg-red-500/10 ring-1 ring-red-500/40' : 'bg-[var(--bg-secondary)]/60'
                }`}
              >
                <div className="flex items-center gap-2">
                  <select
                    value={action.type}
                    onChange={(e) => {
                      const nextType = e.target.value as PostRunActionType
                      update(idx, { type: nextType, config: defaultActionConfig(nextType) })
                    }}
                    className="flex-1 px-2.5 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <select
                    value={action.on}
                    onChange={(e) => update(idx, { on: e.target.value as PostRunActionOn })}
                    className="px-2.5 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {ON_VALUES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <input
                    type="number"
                    min={0}
                    value={action.delay_seconds ?? ''}
                    placeholder="0s"
                    onChange={(e) => {
                      const v = e.target.value === '' ? undefined : Math.max(0, parseInt(e.target.value, 10))
                      update(idx, { delay_seconds: v })
                    }}
                    title="Delay in seconds before firing this action"
                    className="w-16 px-2 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    title="Remove action"
                    aria-label="Remove action"
                    className="p-1.5 text-[var(--text-muted)] hover:text-red-400 rounded hover:bg-[var(--bg-tertiary)]/40 transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <line x1="3" y1="3" x2="9" y2="9" />
                      <line x1="9" y1="3" x2="3" y2="9" />
                    </svg>
                  </button>
                </div>

                {/* Type-specific config */}
                {action.type === 'chain_task' && (
                  <select
                    value={action.config?.task_id ?? ''}
                    onChange={(e) => updateConfig(idx, { task_id: e.target.value })}
                    className="w-full px-2.5 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Choose a task...</option>
                    {otherSchedules.map(s => (
                      <option key={s.id} value={s.id} disabled={cycleSet.has(s.id)}>
                        {s.name}{cycleSet.has(s.id) ? ' (would cycle)' : ''}
                      </option>
                    ))}
                  </select>
                )}

                {action.type === 'notify_email' && (
                  <div className="space-y-2">
                    <input
                      type="email"
                      value={action.config?.to ?? ''}
                      onChange={(e) => updateConfig(idx, { to: e.target.value })}
                      placeholder="Recipient (blank = your account email)"
                      className="w-full px-2.5 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <input
                      value={action.config?.subject ?? ''}
                      onChange={(e) => updateConfig(idx, { subject: e.target.value })}
                      placeholder="Subject (supports {{vars}})"
                      className="w-full px-2.5 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <textarea
                      value={action.config?.body ?? ''}
                      onChange={(e) => updateConfig(idx, { body: e.target.value })}
                      rows={3}
                      placeholder="Body — supports {{template_vars}}"
                      className="w-full px-2.5 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
                    />
                    <TemplateHints />
                  </div>
                )}

                {(action.type === 'notify_telegram' || action.type === 'notify_web_push') && (
                  <div className="space-y-2">
                    {action.type === 'notify_web_push' && (
                      <input
                        value={action.config?.title ?? ''}
                        onChange={(e) => updateConfig(idx, { title: e.target.value })}
                        placeholder="Title"
                        className="w-full px-2.5 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    )}
                    <textarea
                      value={action.config?.body ?? ''}
                      onChange={(e) => updateConfig(idx, { body: e.target.value })}
                      rows={2}
                      placeholder="Message — supports {{template_vars}}"
                      className="w-full px-2.5 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
                    />
                    <TemplateHints />
                  </div>
                )}

                {action.type === 'webhook' && (
                  <input
                    type="url"
                    value={action.config?.url ?? ''}
                    onChange={(e) => updateConfig(idx, { url: e.target.value })}
                    placeholder="https://example.com/hook"
                    className="w-full px-2.5 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                )}
              </div>
            )
          })}

          <button
            type="button"
            onClick={add}
            className="w-full px-3 py-2 text-xs text-indigo-300 hover:text-indigo-200 bg-indigo-600/10 hover:bg-indigo-600/20 rounded-lg transition-colors font-medium inline-flex items-center justify-center gap-1.5"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="6" y1="2.5" x2="6" y2="9.5" />
              <line x1="2.5" y1="6" x2="9.5" y2="6" />
            </svg>
            Add action
          </button>
        </div>
      )}
    </div>
  )
}

function TemplateHints() {
  return (
    <div className="flex flex-wrap gap-1">
      <span className="text-[10px] text-[var(--text-muted)] mr-1">vars:</span>
      {TEMPLATE_VARS.map(v => (
        <span key={v} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]/60 text-[var(--text-secondary)]">
          {v}
        </span>
      ))}
    </div>
  )
}

function canReach(start: string, goal: string, graph: Map<string, string[]>): boolean {
  if (start === goal) return true
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    const outs = graph.get(cur) || []
    for (const next of outs) {
      if (next === goal) return true
      if (!seen.has(next)) stack.push(next)
    }
  }
  return false
}
