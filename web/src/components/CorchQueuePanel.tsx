/**
 * web/src/components/CorchQueuePanel.tsx
 * CORCH-11 (R6.1, R6.3): the central-orchestrator queue. Updated live from the hub's `corch_queue` WS event
 * (no polling). Pause/resume, item priority and cancel-queued controls; icon buttons with tooltips, status as a dot
 * with an accessible name. Accent = blue only.
 *
 * `CorchQueueView` is hook-free (renderToStaticMarkup-testable); `CorchQueuePanel` wires it to the hub.
 */
import type { ReactNode } from 'react'
import { Tooltip } from './ui/Tooltip'
import { useCorchQueue, type CorchQueue, type CorchQueueActions, type CorchQueueItem } from '../hooks/useCorchQueue'

const shortRepo = (r: string) => r.replace(/^github:\/\//, '')

const DOT: Record<string, string> = {
  running: 'bg-blue-500',
  pr_open: 'bg-blue-300',
  queued: 'bg-[var(--text-muted)]',
  blocked: 'bg-red-400',
  done: 'bg-emerald-400',
  cancelled: 'bg-[var(--border-color)]',
  stalled: 'bg-amber-400',
  launching: 'bg-blue-300',
}

function Dot({ state, label }: { state: string; label?: string }) {
  const name = label ?? state
  return (
    <Tooltip label={name}>
      <span role="img" aria-label={name} className={`inline-block h-2 w-2 rounded-full shrink-0 ${DOT[state] ?? DOT.queued}`} />
    </Tooltip>
  )
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:text-blue-400 hover:bg-blue-600/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]"
      >
        {children}
      </button>
    </Tooltip>
  )
}

const svg = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
const PauseIcon = () => (<svg {...svg} aria-hidden="true"><path d="M5 3v10M11 3v10" /></svg>)
const PlayIcon = () => (<svg {...svg} aria-hidden="true"><path d="M5 3l8 5-8 5z" /></svg>)
const UpIcon = () => (<svg {...svg} aria-hidden="true"><path d="M3 10l5-5 5 5" /></svg>)
const DownIcon = () => (<svg {...svg} aria-hidden="true"><path d="M3 6l5 5 5-5" /></svg>)
const CancelIcon = () => (<svg {...svg} aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>)

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.round(seconds / 60)
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

function waitText(i: CorchQueueItem): string | null {
  if (i.status !== 'queued') return i.status === 'blocked' ? (i.wait_reason ?? 'blocked') : null
  return i.wait_reason
}

function ItemRow({ item, actions }: { item: CorchQueueItem; actions: CorchQueueActions }) {
  const queued = item.status === 'queued'
  const wait = waitText(item)
  return (
    <li className="flex items-center gap-2 py-2 border-b border-[var(--border-color)] last:border-0" data-status={item.status}>
      <Dot state={item.status} />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-[var(--text-primary)] truncate">{item.title}</div>
        <div className="text-[11px] text-[var(--text-muted)] truncate">
          {shortRepo(item.repo_ident)}
          {wait ? ` · ${wait}` : ''}
          {item.attempts > 0 ? ` · attempt ${item.attempts}` : ''}
        </div>
      </div>
      {item.pr_url && (
        <a href={item.pr_url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-400 hover:text-blue-300 underline truncate max-w-[120px]">
          PR
        </a>
      )}
      <span className="text-[11px] tabular-nums text-[var(--text-muted)] w-6 text-right" aria-label={`priority ${item.priority}`}>
        {item.priority}
      </span>
      <IconButton label="Raise priority" onClick={() => void actions.setPriority(item.id, item.priority + 1)}>
        <UpIcon />
      </IconButton>
      <IconButton label="Lower priority" onClick={() => void actions.setPriority(item.id, item.priority - 1)}>
        <DownIcon />
      </IconButton>
      {queued && (
        <IconButton label="Cancel" onClick={() => void actions.cancel(item.id)}>
          <CancelIcon />
        </IconButton>
      )}
    </li>
  )
}

export function CorchQueueView({ queue, error, actions }: { queue: CorchQueue | null; error: string | null; actions: CorchQueueActions }) {
  if (!queue) {
    return (
      <section aria-label="Queue" className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 text-xs text-[var(--text-muted)]">
        {error ?? 'Loading queue'}
      </section>
    )
  }
  const open = queue.items.filter((i) => i.status !== 'done' && i.status !== 'cancelled')
  const closed = queue.items.filter((i) => i.status === 'done' || i.status === 'cancelled')
  return (
    <section aria-label="Queue" className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Queue</h2>
        {queue.paused && <Dot state="stalled" label="Paused" />}
        <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
          {queue.live_runs.length}/{queue.max_concurrent_runs}
        </span>
        <span className="ml-auto" />
        <IconButton label={queue.paused ? 'Resume dispatch' : 'Pause dispatch'} onClick={() => void actions.setPaused(!queue.paused)}>
          {queue.paused ? <PlayIcon /> : <PauseIcon />}
        </IconButton>
      </div>
      {error && <div role="alert" className="text-[11px] text-red-400">{error}</div>}

      {queue.live_runs.length > 0 && (
        <ul aria-label="Live runs" className="space-y-1">
          {queue.live_runs.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
              <Dot state={r.status} />
              <span className="truncate flex-1">{shortRepo(r.repo_ident)}</span>
              {r.account_slot && <span className="text-[11px] text-[var(--text-muted)]">{r.account_slot}</span>}
              <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{age(r.age_seconds)}</span>
            </li>
          ))}
        </ul>
      )}

      {open.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)]">Idle</div>
      ) : (
        <ul aria-label="Work items">{open.map((i) => <ItemRow key={i.id} item={i} actions={actions} />)}</ul>
      )}
      {closed.length > 0 && (
        <ul aria-label="Recently closed" className="opacity-60">
          {closed.map((i) => <ItemRow key={i.id} item={i} actions={actions} />)}
        </ul>
      )}

      {queue.quota_accounts.length > 0 && (
        <ul aria-label="Quota accounts" className="flex flex-wrap gap-x-4 gap-y-1 pt-1 border-t border-[var(--border-color)]">
          {queue.quota_accounts.map((a) => (
            <li key={a.account_id} className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
              <Dot state={a.eligible ? 'done' : 'blocked'} label={a.eligible ? 'Eligible' : (a.reason ?? 'Ineligible')} />
              <span>{a.slot ?? a.account_id}</span>
              {a.five_h_pct !== null && <span className="tabular-nums">{Math.round(a.five_h_pct)}%</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface Props {
  token: string
  subscribe: (handler: (msg: any) => void) => () => void
}

export function CorchQueuePanel({ token, subscribe }: Props) {
  const { queue, error, actions } = useCorchQueue(token, subscribe)
  return <CorchQueueView queue={queue} error={error} actions={actions} />
}
