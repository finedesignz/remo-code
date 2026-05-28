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
import { useCallback, useEffect, useMemo, useState } from "react";
import { hubFetch } from "../../lib/api";
import { Card, Button, Field, StatusPill, LoadingState } from "../../components/ui";
import { SupervisorPage } from "../../components/SupervisorPage";

interface SupervisorRow {
  id: string;
  hostname: string | null;
  roots: string[] | null;
  status?: string;
  last_seen_at?: string | null;
}

interface Props {
  token: string;
}

export function ConnectionsTab({ token }: Props) {
  useEffect(() => {
    console.log("[tab:settings:connections] mounted");
    return () => console.log("[tab:settings:connections] unmounted");
  }, []);
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
  const [supervisors, setSupervisors] = useState<SupervisorRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [applied, setApplied] = useState<"live" | "queued" | null>(null);
  const [appliedAt, setAppliedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);

  // tick once a minute so "applied N min ago" stays fresh
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await hubFetch<SupervisorRow[]>(token, "/api/supervisors");
      setSupervisors(rows);
      if (rows.length > 0 && !selectedId) {
        setSelectedId(rows[0].id);
        setDraft((rows[0].roots || []).join("\n"));
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load supervisors");
    }
  }, [token, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

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
      // optimistically reflect the saved roots in our local copy
      setSupervisors((prev) =>
        prev
          ? prev.map((s) => (s.id === selectedId ? { ...s, roots: r.roots } : s))
          : prev,
      );
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
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
          Root repo folder paths
        </h3>
        <p className="text-xs text-[var(--text-muted)]">
          Connect a supervisor first to configure repo roots.
        </p>
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
          className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y"
          spellCheck={false}
        />
      </Field>

      {roots.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {roots.map((r, i) => (
            <span
              key={`${r}-${i}`}
              className="px-2 py-0.5 rounded bg-[var(--bg-tertiary)]/60 text-[11px] text-[var(--text-secondary)] font-mono"
            >
              {r}
            </span>
          ))}
        </div>
      )}

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
  // RevanotePage owns its own full-page surface (subscribe + onBack); link
  // into it from here rather than embedding so we don't double-wire WS.
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Revanote
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Annotation projects + webhook routing.
          </p>
        </div>
        <a
          href="#/revanote"
          className="px-3 py-1.5 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)]/70 text-sm text-[var(--text-primary)] font-medium transition-colors"
        >
          Open Revanote
        </a>
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
