import { useEffect, useMemo, useState } from 'react'
import type { ScheduledTask } from '../hooks/useSchedules'
import { formatTsInTz, TaskTypeChip } from './SchedulesPage'

interface Props {
  schedules: ScheduledTask[]
  onOpen: (scheduleId: string) => void
}

interface Entry {
  scheduleId: string
  scheduleName: string
  timezone: string
  taskType: ScheduledTask['task_type']
  ts: Date
}

const MAX_ENTRIES = 8

export function UpcomingRunsPanel({ schedules, onOpen }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [, setTick] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const entries = useMemo<Entry[]>(() => {
    const now = Date.now()
    const out: Entry[] = []
    for (const s of schedules) {
      if (!s.enabled) continue
      const sources: string[] = (s.next_3_runs && s.next_3_runs.length > 0)
        ? s.next_3_runs
        : (s.next_fire_at ? [s.next_fire_at] : [])
      for (const iso of sources) {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) continue
        if (d.getTime() < now) continue
        out.push({
          scheduleId: s.id,
          scheduleName: s.name,
          timezone: s.timezone,
          taskType: s.task_type,
          ts: d,
        })
      }
    }
    out.sort((a, b) => a.ts.getTime() - b.ts.getTime())
    return out.slice(0, MAX_ENTRIES)
  }, [schedules])

  const hasAnyEnabled = schedules.some(s => s.enabled)
  if (!hasAnyEnabled) return null
  // Hide entirely if nothing in the future at all
  if (entries.length === 0) return null

  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-4 mb-4 max-w-4xl">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider flex-1">
          Upcoming
        </h3>
        <span className="text-xs text-[var(--text-muted)] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]/60">
          {entries.length}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand upcoming runs' : 'Collapse upcoming runs'}
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40 transition-colors"
        >
          <svg
            width="14" height="14" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </div>

      {!collapsed && (
        <div className="mt-3 space-y-0.5">
          {entries.map((e, i) => (
            <button
              key={`${e.scheduleId}-${e.ts.getTime()}-${i}`}
              type="button"
              onClick={() => onOpen(e.scheduleId)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-[var(--bg-tertiary)]/40 transition-colors"
            >
              <span className="text-sm text-[var(--text-primary)] tabular-nums whitespace-nowrap">
                {formatTsInTz(e.ts, e.timezone)}
              </span>
              <span className="text-sm text-[var(--text-secondary)] truncate flex-1 min-w-0">
                {e.scheduleName}
              </span>
              <TaskTypeChip type={e.taskType} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
