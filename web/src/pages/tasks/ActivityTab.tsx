/**
 * Phase 12 W4a — Activity tab.
 *
 * User-wide run feed across ALL scheduled tasks. Filter chips at the top
 * (All | In Progress | Completed | Failed). Click a row → `<Drawer>` with
 * run output snippet + error + raw metadata.
 *
 * Server endpoint: `GET /api/tasks/activity?status=&before=&limit=` keyset
 * pagination via `before=<started_at ISO>`. Returns `{ runs, next_cursor }`.
 */
import { useEffect, useMemo, useState } from "react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Drawer } from "../../components/ui/Drawer";
import { EmptyState } from "../../components/ui/EmptyState";
import { LoadingState } from "../../components/ui/LoadingState";
import { StatusPill, type StatusKind } from "../../components/ui/StatusPill";
import { hubFetch } from "../../lib/api";
import { formatCostUsd, formatDuration, formatRelativeAgo } from "../../lib/format";

type ServerStatusFilter = "in_progress" | "completed" | "failed";
type UiFilter = "all" | ServerStatusFilter;

const FILTERS: Array<{ key: UiFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "in_progress", label: "In Progress" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

const PAGE_SIZE = 50;

interface ActivityRow {
  id: string;
  task_id: string;
  task_name?: string | null;
  task_type?: string | null;
  status: string;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  output_snippet: string | null;
  error: string | null;
  target_kind?: string | null;
  target_id?: string | null;
  session_id?: string | null;
  supervisor_id?: string | null;
}

interface Props {
  token: string;
}

export function ActivityTab({ token }: Props) {
  const [filter, setFilter] = useState<UiFilter>("all");
  const [runs, setRuns] = useState<ActivityRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<ActivityRow | null>(null);

  // Initial fetch + on filter change.
  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    setErr(null);
    setCursor(null);
    setHasMore(false);
    const qs = new URLSearchParams();
    qs.set("limit", String(PAGE_SIZE));
    if (filter !== "all") qs.set("status", filter);
    hubFetch<{ runs?: ActivityRow[]; next_cursor?: string | null }>(
      token,
      `/api/tasks/activity?${qs.toString()}`,
    )
      .then((r) => {
        if (cancelled) return;
        const list = Array.isArray(r?.runs) ? r.runs : [];
        setRuns(list);
        setCursor(r?.next_cursor ?? null);
        setHasMore(list.length === PAGE_SIZE && !!r?.next_cursor);
      })
      .catch((e) => {
        if (!cancelled) setErr(e?.message ?? "Failed to load activity");
      });
    return () => {
      cancelled = true;
    };
  }, [token, filter]);

  const loadMore = async () => {
    if (loadingMore || !hasMore || !cursor) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(PAGE_SIZE));
      qs.set("before", cursor);
      if (filter !== "all") qs.set("status", filter);
      const r = await hubFetch<{ runs?: ActivityRow[]; next_cursor?: string | null }>(
        token,
        `/api/tasks/activity?${qs.toString()}`,
      );
      const list = Array.isArray(r?.runs) ? r.runs : [];
      setRuns((prev) => [...(prev ?? []), ...list]);
      setCursor(r?.next_cursor ?? null);
      setHasMore(list.length === PAGE_SIZE && !!r?.next_cursor);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = f.key === filter;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={
                active
                  ? "px-3 py-1 rounded-full text-xs font-medium bg-blue-600/20 ring-1 ring-blue-500/30 text-blue-300"
                  : "px-3 py-1 rounded-full text-xs font-medium bg-[var(--bg-tertiary)]/40 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/70"
              }
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <ActivityBody
        runs={runs}
        err={err}
        loadingMore={loadingMore}
        hasMore={hasMore}
        onOpen={setOpenRun}
        onLoadMore={loadMore}
      />

      <RunDrawer run={openRun} onClose={() => setOpenRun(null)} />
    </div>
  );
}

function ActivityBody({
  runs,
  err,
  loadingMore,
  hasMore,
  onOpen,
  onLoadMore,
}: {
  runs: ActivityRow[] | null;
  err: string | null;
  loadingMore: boolean;
  hasMore: boolean;
  onOpen: (r: ActivityRow) => void;
  onLoadMore: () => void;
}) {
  if (err) return <EmptyState title="Couldn't load activity" description={err} />;
  if (runs === null) return <LoadingState label="Loading activity…" />;
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        description="Recent scheduled-task runs across all your tasks will show up here."
      />
    );
  }
  return (
    <div className="space-y-2">
      {runs.map((r) => (
        <RunRow key={r.id} run={r} onClick={() => onOpen(r)} />
      ))}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onLoadMore}
            loading={loadingMore}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function RunRow({ run, onClick }: { run: ActivityRow; onClick: () => void }) {
  const pill = useMemo(() => statusToPill(run.status), [run.status]);
  const started = run.started_at ? new Date(run.started_at) : null;
  const cost = formatCostUsd(run.cost_usd);
  const dur = formatDuration(run.duration_ms);
  return (
    <Card
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      padded={false}
      className="cursor-pointer hover:bg-[var(--bg-secondary)]/80 transition-colors"
    >
      <div className="p-4 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">
              {run.task_name ?? "(deleted task)"}
            </h3>
            <StatusPill status={pill.status} size="sm" label={pill.label} />
            {run.task_type && (
              <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">
                {run.task_type}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
            {started && <span>{formatRelativeAgo(started)}</span>}
            <span>{dur}</span>
            {cost && <span>{cost}</span>}
            {run.session_id && (
              <span className="font-mono text-[10px]">
                session: {run.session_id.slice(0, 8)}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function RunDrawer({ run, onClose }: { run: ActivityRow | null; onClose: () => void }) {
  if (!run) return null;
  const pill = statusToPill(run.status);
  const started = run.started_at ? new Date(run.started_at) : null;
  const finished = run.finished_at ? new Date(run.finished_at) : null;
  return (
    <Drawer
      open={!!run}
      onClose={onClose}
      title={run.task_name ?? "Run details"}
    >
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={pill.status} label={pill.label} />
          {run.task_type && (
            <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">
              {run.task_type}
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-y-1 gap-x-3 text-xs">
          <dt className="text-[var(--text-muted)]">Started</dt>
          <dd className="text-[var(--text-secondary)]">
            {started ? started.toLocaleString() : "—"}
          </dd>
          <dt className="text-[var(--text-muted)]">Finished</dt>
          <dd className="text-[var(--text-secondary)]">
            {finished ? finished.toLocaleString() : "—"}
          </dd>
          <dt className="text-[var(--text-muted)]">Duration</dt>
          <dd className="text-[var(--text-secondary)]">
            {formatDuration(run.duration_ms)}
          </dd>
          <dt className="text-[var(--text-muted)]">Cost</dt>
          <dd className="text-[var(--text-secondary)]">
            {formatCostUsd(run.cost_usd) ?? "—"}
          </dd>
          {run.session_id && (
            <>
              <dt className="text-[var(--text-muted)]">Session</dt>
              <dd className="text-[var(--text-secondary)] font-mono break-all">
                {run.session_id}
              </dd>
            </>
          )}
          {run.supervisor_id && (
            <>
              <dt className="text-[var(--text-muted)]">Supervisor</dt>
              <dd className="text-[var(--text-secondary)] font-mono break-all">
                {run.supervisor_id}
              </dd>
            </>
          )}
        </dl>

        {run.error && (
          <div>
            <div className="text-xs text-[var(--text-muted)] mb-1">Error</div>
            <pre className="text-xs bg-red-500/10 ring-1 ring-red-500/20 text-red-300 rounded-lg p-3 whitespace-pre-wrap break-all">
              {run.error}
            </pre>
          </div>
        )}

        {run.output_snippet && (
          <div>
            <div className="text-xs text-[var(--text-muted)] mb-1">Output</div>
            <pre className="text-xs bg-[var(--code-bg,var(--bg-tertiary))] rounded-lg p-3 whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
              {run.output_snippet}
            </pre>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function statusToPill(status: string): { status: StatusKind; label: string } {
  switch (status) {
    case "success":
      return { status: "success", label: "completed" };
    case "failure":
    case "failed":
      return { status: "error", label: "failed" };
    case "running":
    case "in_flight":
    case "pending":
      return { status: "pending", label: "in progress" };
    case "skipped":
      return { status: "idle", label: "skipped" };
    case "cancelled":
      return { status: "idle", label: "cancelled" };
    default:
      return { status: "idle", label: status };
  }
}

export default ActivityTab;
