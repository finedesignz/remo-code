/**
 * Phase 12 W4b — Settings → Connections tab.
 *
 * Composes:
 *   1. RootsEditor — Wave 2 PATCH /api/supervisors/:id/roots (NEW capability)
 *   2. SupervisorPage embedded — existing supervisor selection, repo list, scan
 *   3. RevanoteLink — surface the Revanote section under Connections (audit fold)
 *
 * The roots editor lists the active supervisor's `roots` (loaded from
 * `GET /api/supervisors`) as a chips-list + multi-line entry. Save fires
 * the Wave 2 endpoint and reflects `applied: 'live' | 'queued'` returned by
 * the hub.
 */
import { useEffect, useMemo, useState } from "react";
import { hubFetch } from "../../lib/api";
import { Card, Button, Field, StatusPill, LoadingState, EmptyState } from "../../components/ui";
import { SupervisorPage } from "../../components/SupervisorPage";
import { useSupervisors } from "../../hooks/useSupervisors";
import { useWebSocketContext } from "../../hooks/useWebSocket";

interface Props {
  token: string;
}

export function ConnectionsTab({ token }: Props) {
  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 w-full max-w-7xl mx-auto space-y-5">
      <RootsEditor token={token} />
      <SupervisorPage token={token} embedded />
      <RevanoteLink />
    </div>
  );
}

/* ─────────────────────────── Roots editor ─────────────────────────── */

function RootsEditor({ token }: { token: string }) {
  const { subscribe, connectionId } = useWebSocketContext();
  const { supervisors, error: loadError, refetch } = useSupervisors(
    token,
    subscribe,
    connectionId,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [applied, setApplied] = useState<"live" | "queued" | null>(null);
  const [appliedAt, setAppliedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(loadError);
  const [, force] = useState(0);

  // tick once a minute so "applied N min ago" stays fresh
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { setError(loadError) }, [loadError]);

  // Default selection once the hook resolves.
  useEffect(() => {
    if (!selectedId && supervisors && supervisors.length > 0) {
      setSelectedId(supervisors[0].id);
      setDraft((supervisors[0].roots || []).join("\n"));
    }
  }, [supervisors, selectedId]);

  const active = useMemo(
    () => supervisors?.find((s) => s.id === selectedId) ?? null,
    [supervisors, selectedId],
  );

  // when active supervisor changes, sync draft with its current roots
  useEffect(() => {
    if (active) setDraft((active.roots || []).join("\n"));
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const roots = useMemo(
    () =>
      draft
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [draft],
  );

  const dirty =
    active && JSON.stringify(roots) !== JSON.stringify(active.roots || []);

  const save = async () => {
    if (!selectedId) return;
    setSaving(true);
    setError(null);
    setApplied(null);
    try {
      const r = await hubFetch<{ roots: string[]; applied: "live" | "queued" }>(
        token,
        `/api/supervisors/${selectedId}/roots`,
        { method: "PATCH", json: { roots } },
      );
      setApplied(r.applied);
      setAppliedAt(Date.now());
      // Re-fetch so the hook's cache reflects the saved roots; the hub also
      // broadcasts a supervisor_update on a roots-PATCH path eventually, but
      // an explicit refetch makes the chips list update immediately.
      void refetch();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (supervisors === null) {
    return (
      <Card>
        <LoadingState label="Loading supervisors…" />
      </Card>
    );
  }
  if (supervisors.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No supervisor connected"
          description="Connect a supervisor to configure the repo folders it scans."
        />
      </Card>
    );
  }

  const lastApplied =
    appliedAt !== null ? formatAgo(new Date(appliedAt).toISOString()) : null;

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Root repo folder paths
        </h3>
        {applied && (
          <StatusPill
            status={applied === "live" ? "success" : "warning"}
            size="sm"
            label={
              applied === "live"
                ? `Applied live${lastApplied ? ` · ${lastApplied}` : ""}`
                : `Queued (supervisor offline)${lastApplied ? ` · ${lastApplied}` : ""}`
            }
          />
        )}
      </div>

      {supervisors.length > 1 && (
        <Field label="Supervisor" className="mb-3">
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          >
            {supervisors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.hostname || s.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field
        label="Root paths (one per line)"
        helper="Absolute paths the supervisor will scan for repos. No '..', no NUL, max 16 entries."
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.max(4, Math.min(10, roots.length + 1))}
          placeholder={"C:/Users/me/GitHub\nD:/code"}
          className="w-full px-3 py-2 bg-[var(--code-bg)] rounded-lg text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y"
          spellCheck={false}
        />
      </Field>

      <p className="text-xs text-[var(--text-muted)] mt-2">
        {roots.length} of 16 path{roots.length === 1 ? "" : "s"}
        {dirty ? " · unsaved changes" : ""}
      </p>

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}

      <div className="flex items-center gap-2 mt-4">
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          disabled={!dirty || saving}
          loading={saving}
        >
          Save roots
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft((active?.roots || []).join("\n"))}
            disabled={saving}
          >
            Revert
          </Button>
        )}
      </div>
    </Card>
  );
}

/* ─────────────────────────── Revanote link ─────────────────────────── */

function RevanoteLink() {
  // The standalone RevanotePage was removed in the Phase 12 restructure and the
  // `#/revanote` hash now redirects back here, so a button would loop. Revanote
  // is driven entirely by its inbound webhook + app mappings on the hub; this
  // card documents that rather than linking to a page that no longer exists.
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Revanote
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Visual annotations route into the Claude session bound to each page's
            repo via the Revanote webhook. Rotate the webhook secret and manage app
            mappings from the hub API — no separate page to open.
          </p>
        </div>
      </div>
    </Card>
  );
}

/* ─────────────────────────── Utilities ─────────────────────────── */

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default ConnectionsTab;
