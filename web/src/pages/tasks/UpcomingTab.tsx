/**
 * Phase 12 W4a — Upcoming tasks tab.
 *
 * Consumes `GET /api/tasks/upcoming?limit=&offset=`. Renders one card per row:
 * name + next-run (relative + absolute) + humanized cron + target. Click a row
 * to open the existing `ScheduleRunsDrawer` for that task's run history.
 *
 * Reuses Wave 1b primitives (Card, StatusPill, EmptyState, LoadingState).
 */
import { useEffect, useMemo, useState } from "react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { LoadingState } from "../../components/ui/LoadingState";
import { StatusPill } from "../../components/ui/StatusPill";
import { hubFetch } from "../../lib/api";
import { humanizeCron } from "../../lib/cron-humanize";
import { formatRelativeAgo } from "../../lib/format";
import { describeTarget, formatTsInTz } from "../../components/SchedulesPage";
import { ScheduleRunsDrawer } from "../../components/ScheduleRunsDrawer";
import { useSchedules, type ScheduledTask } from "../../hooks/useSchedules";

const PAGE_SIZE = 50;

interface Props {
  token: string;
  subscribe?: (handler: (msg: any) => void) => () => void;
}

interface UpcomingRow {
  id: string;
  name: string;
  task_type: ScheduledTask["task_type"];
  target_kind: ScheduledTask["target_kind"];
  target_id: string | null;
  cron_expr?: string;
  cron_expression?: string;
  timezone: string;
  next_fire_at: string | null;
  enabled: boolean;
}

export function UpcomingTab({ token, subscribe }: Props) {
  const [items, setItems] = useState<UpcomingRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);

  // We rely on useSchedules to translate the upcoming row into a full
  // ScheduledTask when the drawer opens — drawer needs the full shape.
  const { schedules } = useSchedules(token);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setErr(null);
    hubFetch<{ tasks?: UpcomingRow[] }>(
      token,
      `/api/tasks/upcoming?limit=${PAGE_SIZE}&offset=0`,
    )
      .then((r) => {
        if (cancelled) return;
        const rows = Array.isArray(r?.tasks) ? r.tasks : [];
        setItems(rows);
        setOffset(rows.length);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch((e) => {
        if (!cancelled) setErr(e?.message ?? "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const r = await hubFetch<{ tasks?: UpcomingRow[] }>(
        token,
        `/api/tasks/upcoming?limit=${PAGE_SIZE}&offset=${offset}`,
      );
      const rows = Array.isArray(r?.tasks) ? r.tasks : [];
      setItems((prev) => [...(prev ?? []), ...rows]);
      setOffset((o) => o + rows.length);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  };

  const drawerTask = drawerTaskId
    ? schedules.find((s) => s.id === drawerTaskId) ?? null
    : null;

  if (err) {
    return (
      <EmptyState
        title="Couldn't load upcoming tasks"
        description={err}
      />
    );
  }
  if (items === null) return <LoadingState label="Loading upcoming tasks…" />;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No upcoming runs"
        description="Scheduled tasks with a next-fire-at in the future will appear here."
      />
    );
  }

  return (
    <div className="space-y-3">
      {items.map((t) => (
        <UpcomingRowCard
          key={t.id}
          row={t}
          onClick={() => setDrawerTaskId(t.id)}
        />
      ))}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={loadMore}
            loading={loadingMore}
          >
            Load more
          </Button>
        </div>
      )}
      {drawerTask && (
        <ScheduleRunsDrawer
          token={token}
          task={drawerTask}
          subscribe={subscribe}
          onClose={() => setDrawerTaskId(null)}
        />
      )}
    </div>
  );
}

function UpcomingRowCard({
  row,
  onClick,
}: {
  row: UpcomingRow;
  onClick: () => void;
}) {
  const next = row.next_fire_at ? new Date(row.next_fire_at) : null;
  const cronExpr = row.cron_expr || row.cron_expression || "";
  const cronSummary = useMemo(() => humanizeCron(cronExpr), [cronExpr]);
  const targetSummary = useMemo(
    () => describeTarget({ target_kind: row.target_kind, target_id: row.target_id }),
    [row.target_kind, row.target_id],
  );

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
      className="cursor-pointer hover:bg-[var(--bg-secondary)]/80 transition-colors"
      padded={false}
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                {row.name}
              </h3>
              <StatusPill status="info" size="sm" label={row.task_type} />
              {!row.enabled && (
                <StatusPill status="idle" size="sm" label="disabled" />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
              <span>{cronSummary}</span>
              <span>{targetSummary}</span>
              {next && (
                <span>
                  Next:{" "}
                  <span className="text-[var(--text-secondary)]">
                    in {formatRelativeAgoFuture(next)} · {formatTsInTz(next, row.timezone)}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** "in 3h" / "in 12m" — uses formatRelativeAgo but trims the trailing " ago". */
function formatRelativeAgoFuture(d: Date): string {
  const now = new Date();
  // Spoof a "past" date so formatRelativeAgo formats the magnitude correctly.
  const spoof = new Date(now.getTime() - (d.getTime() - now.getTime()));
  const s = formatRelativeAgo(spoof);
  return s.replace(/\s+ago$/i, "");
}

export default UpcomingTab;
