/**
 * Phase 12 W4a — Schedule tab.
 *
 * CRUD list of scheduled tasks, grouped by repo (target session's project_dir)
 * via `GET /api/tasks/schedule?group_by=repo`. Fan-out targets land in an
 * "Unassigned" group. Each group is an accordion collapsible by repo.
 *
 * CRUD reuses the existing `ScheduleEditor` modal and `useSchedules` hook.
 * Run-history drawer reuses the existing `ScheduleRunsDrawer`.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { LoadingState } from "../../components/ui/LoadingState";
import { StatusPill, type StatusKind } from "../../components/ui/StatusPill";
import { hubFetch } from "../../lib/api";
import { humanizeCron } from "../../lib/cron-humanize";
import {
  describeTarget,
  formatTsInTz,
} from "../../components/SchedulesPage";
import { ScheduleEditor } from "../../components/ScheduleEditor";
import { ScheduleRunsDrawer } from "../../components/ScheduleRunsDrawer";
import { useSchedules, type ScheduledTask } from "../../hooks/useSchedules";
import { GSD_TEMPLATES, type GsdTemplate } from "../../lib/gsd-templates";

type SortMode = "default" | "next_run";
type StatusFilter = "all" | "enabled" | "disabled" | "upcoming";

// Tasks fired/firing within this window count as "Upcoming" for the filter.
const UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000;

interface Props {
  token: string;
  subscribe?: (handler: (msg: any) => void) => () => void;
}

interface ScheduleGroup {
  key: string;
  label: string;
  tasks: ScheduledTask[];
}

export function ScheduleTab({ token, subscribe }: Props) {
  const {
    schedules,
    loading,
    error,
    create,
    update,
    remove,
    toggle,
    refetch,
  } = useSchedules(token);

  const [groups, setGroups] = useState<ScheduleGroup[] | null>(null);
  const [groupsErr, setGroupsErr] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [editTemplate, setEditTemplate] = useState<GsdTemplate | null>(null);
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Single-page toolbar state (Upcoming folded into a sort + filter).
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Fetch grouping shape from the backend whenever schedules change.
  // Server returns tasks keyed by repo, but full task fields (including
  // `last_run_status`, `next_3_runs`, etc.) come from `useSchedules`.
  // We hydrate by id-matching against `schedules`.
  useEffect(() => {
    let cancelled = false;
    hubFetch<{ groups?: ScheduleGroup[] }>(
      token,
      "/api/tasks/schedule?group_by=repo",
    )
      .then((r) => {
        if (cancelled) return;
        setGroups(Array.isArray(r?.groups) ? r.groups : []);
        setGroupsErr(null);
      })
      .catch((e) => {
        if (!cancelled) setGroupsErr(e?.message ?? "Failed to load schedule");
      });
    return () => {
      cancelled = true;
    };
  }, [token, schedules.length]);

  // Build the rendered groups from the backend grouping (key/label) but
  // re-resolve each task against the full `useSchedules` list for live
  // status fields (last_run, cost, etc.).
  const renderedGroups = useMemo<ScheduleGroup[]>(() => {
    if (!groups) return [];
    const byId = new Map(schedules.map((s) => [s.id, s]));
    const q = search.trim().toLowerCase();
    const now = Date.now();
    const matches = (t: ScheduledTask): boolean => {
      if (q && !(t.name ?? "").toLowerCase().includes(q)) return false;
      if (statusFilter === "enabled" && !t.enabled) return false;
      if (statusFilter === "disabled" && t.enabled) return false;
      if (statusFilter === "upcoming") {
        if (!t.enabled || !t.next_fire_at) return false;
        const ms = new Date(t.next_fire_at).getTime();
        if (!(ms >= now && ms - now <= UPCOMING_WINDOW_MS)) return false;
      }
      return true;
    };
    const sortTasks = (arr: ScheduledTask[]): ScheduledTask[] => {
      if (sortMode !== "next_run") return arr;
      // "Next run" sort: soonest next_fire_at first; tasks without a next run
      // (disabled / no schedule) sink to the bottom.
      return [...arr].sort((a, b) => {
        const av = a.next_fire_at ? new Date(a.next_fire_at).getTime() : Infinity;
        const bv = b.next_fire_at ? new Date(b.next_fire_at).getTime() : Infinity;
        return av - bv;
      });
    };
    return groups.map((g) => ({
      ...g,
      tasks: sortTasks(
        g.tasks
          .map((t) => byId.get((t as any).id) ?? (t as ScheduledTask))
          .filter(Boolean)
          .filter(matches),
      ),
    }));
  }, [groups, schedules, search, statusFilter, sortMode]);

  const handleNew = () => {
    setEditing(null);
    setEditTemplate(null);
    setNewMenuOpen(false);
    setEditorOpen(true);
  };
  const handleNewFromTemplate = (tpl: GsdTemplate) => {
    setEditing(null);
    setEditTemplate(tpl);
    setNewMenuOpen(false);
    setEditorOpen(true);
  };
  const handleEdit = (s: ScheduledTask) => {
    setEditing(s);
    setEditTemplate(null);
    setEditorOpen(true);
  };
  const handleClose = () => {
    setEditorOpen(false);
    setEditing(null);
    setEditTemplate(null);
  };
  const handleDelete = async (id: string) => {
    try {
      await remove(id);
    } catch {
      // remove() already surfaces error via useSchedules state
    }
    setConfirmingDelete(null);
  };
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const drawerTask = drawerTaskId
    ? schedules.find((s) => s.id === drawerTaskId) ?? null
    : null;

  // States
  if (loading && schedules.length === 0 && groups === null) {
    return <LoadingState label="Loading schedules…" />;
  }
  if (error || groupsErr) {
    return (
      <EmptyState
        title="Couldn't load schedule"
        description={error ?? groupsErr ?? "Unknown error"}
        action={{ label: "Retry", onClick: () => void refetch() }}
      />
    );
  }
  const isEmpty = renderedGroups.every((g) => g.tasks.length === 0);

  return (
    <div className="space-y-4">
      {/* Page header + New Task split button */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Tasks</h1>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {schedules.length} task{schedules.length === 1 ? "" : "s"} across{" "}
            {renderedGroups.length} group{renderedGroups.length === 1 ? "" : "s"}.{" "}
            <span>
              Activity moved —{" "}
              <a href="#/activity" className="text-blue-400 hover:text-blue-300 underline">
                view it here
              </a>
              .
            </span>
          </p>
        </div>
        <NewTaskMenu
          open={newMenuOpen}
          onToggle={() => setNewMenuOpen((v) => !v)}
          onClose={() => setNewMenuOpen(false)}
          onBlank={handleNew}
          onTemplate={handleNewFromTemplate}
        />
      </div>

      {/* Toolbar: search · status filter · sort */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="px-3 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="px-3 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="Filter tasks"
        >
          <option value="all">All</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="upcoming">Upcoming (24h)</option>
        </select>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="px-3 py-1.5 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="Sort tasks"
        >
          <option value="default">Group order</option>
          <option value="next_run">Next run</option>
        </select>
      </div>

      {isEmpty ? (
        <EmptyState
          title="No scheduled tasks"
          description="Create your first scheduled task — it will be grouped here by repo."
          action={{ label: "Create schedule", onClick: handleNew }}
        />
      ) : (
        <div className="space-y-3">
          {renderedGroups.map((g) => {
            if (g.tasks.length === 0) return null;
            const open = !collapsed.has(g.key);
            return (
              <Card key={g.key} padded={false}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g.key)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--bg-tertiary)]/40 rounded-xl transition-colors"
                  aria-expanded={open}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Chevron open={open} />
                    <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                      {g.label}
                    </h3>
                    <StatusPill
                      status="idle"
                      size="sm"
                      label={`${g.tasks.length}`}
                    />
                  </div>
                </button>
                {open && (
                  <div className="px-2 pb-2 space-y-1">
                    {g.tasks.map((t) => (
                      <ScheduleRow
                        key={t.id}
                        task={t}
                        confirming={confirmingDelete === t.id}
                        onClick={() => setDrawerTaskId(t.id)}
                        onEdit={() => handleEdit(t)}
                        onToggle={() => void toggle(t.id, !t.enabled)}
                        onDelete={() => setConfirmingDelete(t.id)}
                        onConfirmDelete={() => void handleDelete(t.id)}
                        onCancelDelete={() => setConfirmingDelete(null)}
                      />
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {editorOpen && (
        <ScheduleEditor
          token={token}
          existing={editing}
          template={editTemplate}
          allSchedules={schedules}
          onClose={handleClose}
          onSave={async (data) => {
            if (editing) {
              await update(editing.id, data);
            } else {
              await create(data);
            }
            handleClose();
          }}
        />
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

function NewTaskMenu({
  open,
  onToggle,
  onClose,
  onBlank,
  onTemplate,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onBlank: () => void;
  onTemplate: (tpl: GsdTemplate) => void;
}) {
  return (
    <div className="relative">
      <Button variant="primary" size="sm" onClick={onToggle}>
        + New Task ▾
      </Button>
      {open && (
        <>
          {/* click-away */}
          <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
          <div className="absolute right-0 mt-1 z-50 w-72 rounded-xl bg-[var(--bg-secondary)] ring-1 ring-white/10 shadow-xl p-1.5">
            <button
              type="button"
              onClick={onBlank}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50"
            >
              Blank task
            </button>
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
              GSD templates
            </div>
            {GSD_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onTemplate(t)}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)]/50"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--text-primary)]">{t.label}</span>
                  <span className="text-[10px] text-blue-300">{t.cadenceLabel}</span>
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">
                  {t.description}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-[var(--text-muted)] transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M4 2l4 4-4 4" />
    </svg>
  );
}

function ScheduleRow({
  task,
  confirming,
  onClick,
  onEdit,
  onToggle,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  task: ScheduledTask;
  confirming: boolean;
  onClick: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const cronSummary = useMemo(
    () => humanizeCron(task.cron_expr),
    [task.cron_expr],
  );
  const targetSummary = useMemo(() => describeTarget(task), [
    task.target_kind,
    task.target_id,
  ]);
  const next = task.next_fire_at ? new Date(task.next_fire_at) : null;
  const statusPill = lastRunPill(task.last_run_status);

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="cursor-pointer rounded-lg p-3 hover:bg-[var(--bg-tertiary)]/40 transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-sm font-medium text-[var(--text-primary)] truncate">
              {task.name}
            </h4>
            <StatusPill status="info" size="sm" label={task.task_type} />
            {statusPill && (
              <StatusPill
                status={statusPill.status}
                size="sm"
                label={statusPill.label}
              />
            )}
            {!task.enabled && (
              <StatusPill status="idle" size="sm" label="disabled" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
            <span>{cronSummary}</span>
            <span>{targetSummary}</span>
            {next && task.enabled && (
              <span>
                Next:{" "}
                <span className="text-[var(--text-secondary)]">
                  {formatTsInTz(next, task.timezone)}
                </span>
              </span>
            )}
          </div>
        </div>

        <div
          className="flex items-center gap-1 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {confirming ? (
            <>
              <Button variant="danger" size="sm" onClick={onConfirmDelete}>
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancelDelete}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onToggle}>
                {task.enabled ? "Disable" : "Enable"}
              </Button>
              <Button variant="ghost" size="sm" onClick={onEdit}>
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={onDelete}>
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function lastRunPill(
  s: ScheduledTask["last_run_status"] | undefined,
): { status: StatusKind; label: string } | null {
  if (!s) return null;
  switch (s) {
    case "success":
      return { status: "success", label: "ok" };
    case "failure":
      return { status: "error", label: "failed" };
    case "running":
    case "pending":
      return { status: "pending", label: "running" };
    case "skipped":
      return { status: "idle", label: "skipped" };
    default:
      return null;
  }
}

export default ScheduleTab;
