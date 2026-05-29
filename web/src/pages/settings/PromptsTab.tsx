/**
 * Phase 12 W4b — Settings → Prompts tab.
 *
 * Combines the legacy Instructions tab + Commands tab + a new
 * "Auto-nudge idle sessions" switch (Wave 2 endpoint).
 *
 * Layout:
 *   1. Auto-nudge switch — PATCH /api/users/me/prompts { auto_nudge_idle_sessions }
 *   2. Three instruction blobs — claude_global_md / codex_agents_md / codex_config_toml
 *      Loaded from GET /api/instructions, saved via PATCH /api/users/me/prompts
 *      (the W2 endpoint accepts the same three fields; server strips
 *      secret-looking lines from codex_config_toml).
 *   3. Commands list — read-only synced commands surfaced from the supervisor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { hubFetch } from "../../lib/api";
import { Card, StatusPill, Toggle } from "../../components/ui";
import { CommandsList } from "../../components/CommandsList";

interface Props {
  token: string;
}

export function PromptsTab({ token }: Props) {
  useEffect(() => {
    console.log("[tab:settings:prompts] mounted");
    return () => console.log("[tab:settings:prompts] unmounted");
  }, []);
  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 w-full max-w-7xl mx-auto space-y-5">
      <AutoNudgeCard token={token} />
      <InstructionsCard token={token} />
      <Card padded={false} className="overflow-hidden">
        <div className="px-5 pt-5 pb-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Commands
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Commands and skills synced from your supervisor on connect.
          </p>
        </div>
        <CommandsList token={token} />
      </Card>
    </div>
  );
}

/* ─────────────────────────── Auto-nudge ─────────────────────────── */

function AutoNudgeCard({ token }: { token: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Source of truth: the Wave 2 endpoint reads/writes `auto_nudge_idle_sessions`
  // on the user row. Bootstrap from /api/profile (already returns it via the
  // extended user row) — but if it's missing in the response, fall back to
  // localStorage to match the legacy behavior until first save.
  useEffect(() => {
    let cancelled = false;
    hubFetch<{ auto_nudge_idle_sessions?: boolean }>(token, "/api/profile")
      .then((p) => {
        if (cancelled) return;
        if (typeof p.auto_nudge_idle_sessions === "boolean") {
          setEnabled(p.auto_nudge_idle_sessions);
        } else {
          try {
            setEnabled(localStorage.getItem("remo:auto-nudge") !== "off");
          } catch {
            setEnabled(true);
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        try {
          setEnabled(localStorage.getItem("remo:auto-nudge") !== "off");
        } catch {
          setEnabled(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const toggle = async () => {
    if (enabled === null) return;
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      await hubFetch(token, "/api/users/me/prompts", {
        method: "PATCH",
        json: { auto_nudge_idle_sessions: next },
      });
      try {
        localStorage.setItem("remo:auto-nudge", next ? "on" : "off");
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      setEnabled(!next); // revert
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div
        className="w-full flex items-center justify-between gap-3"
        title="When you switch to an idle session, automatically send a brief status-update prompt."
      >
        <div className="text-left">
          <span className="block text-sm font-semibold text-[var(--text-primary)]">
            Auto-nudge idle sessions
          </span>
          <span className="block text-xs text-[var(--text-muted)] mt-0.5">
            When you switch to an idle session, send a brief status-update
            prompt automatically.
          </span>
        </div>
        <Toggle
          checked={enabled === true}
          onChange={() => void toggle()}
          disabled={saving || enabled === null}
          aria-label="Auto-nudge idle sessions"
        />
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </Card>
  );
}

/* ─────────────────────────── Instructions ─────────────────────────── */

interface InstructionsData {
  claude_global_md: string;
  codex_agents_md: string;
  codex_config_toml: string;
}

function InstructionsCard({ token }: { token: string }) {
  const [data, setData] = useState<InstructionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [strippedFlash, setStrippedFlash] = useState<number>(0);
  const [statuses, setStatuses] = useState<{
    claude_global_md: SaveStatus;
    codex_agents_md: SaveStatus;
    codex_config_toml: SaveStatus;
  }>({
    claude_global_md: "idle",
    codex_agents_md: "idle",
    codex_config_toml: "idle",
  });
  const initialRef = useRef<InstructionsData | null>(null);
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout> | null>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    hubFetch<{
      claude_global_md: string | null;
      codex_agents_md: string | null;
      codex_config_toml: string | null;
    }>(token, "/api/instructions")
      .then((d) => {
        if (cancelled) return;
        const next: InstructionsData = {
          claude_global_md: d.claude_global_md ?? "",
          codex_agents_md: d.codex_agents_md ?? "",
          codex_config_toml: d.codex_config_toml ?? "",
        };
        setData(next);
        initialRef.current = { ...next };
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const scheduleSave = useCallback(
    (key: keyof InstructionsData, value: string) => {
      // debounce per-field
      if (timersRef.current[key]) clearTimeout(timersRef.current[key]!);
      timersRef.current[key] = setTimeout(async () => {
        setStatuses((s) => ({ ...s, [key]: "saving" }));
        try {
          const r = await hubFetch<{
            claude_global_md?: string | null;
            codex_agents_md?: string | null;
            codex_config_toml?: string | null;
            stripped_secret_lines?: number;
          }>(token, "/api/users/me/prompts", {
            method: "PATCH",
            json: { [key]: value },
          });
          if (key === "codex_config_toml" && r.stripped_secret_lines) {
            setStrippedFlash(r.stripped_secret_lines);
            setTimeout(() => setStrippedFlash(0), 3000);
            // server may have rewritten the field — reflect that
            if (typeof r.codex_config_toml === "string") {
              setData((d) =>
                d ? { ...d, codex_config_toml: r.codex_config_toml ?? "" } : d,
              );
            }
          }
          setStatuses((s) => ({ ...s, [key]: "saved" }));
          setTimeout(
            () =>
              setStatuses((s) =>
                s[key] === "saved" ? { ...s, [key]: "idle" } : s,
              ),
            1500,
          );
        } catch {
          setStatuses((s) => ({ ...s, [key]: "error" }));
        }
      }, 600);
    },
    [token],
  );

  const update = (key: keyof InstructionsData, value: string) => {
    setData((d) => (d ? { ...d, [key]: value } : d));
    scheduleSave(key, value);
  };

  if (error)
    return (
      <Card>
        <p className="text-sm text-red-400">{error}</p>
      </Card>
    );
  if (!data)
    return (
      <Card>
        <p className="text-sm text-[var(--text-muted)]">Loading…</p>
      </Card>
    );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <InstructionField
          title="Claude global"
          helper="~/.claude/CLAUDE.md — synced to agent on connect. Agent writes only if file is absent locally."
          value={data.claude_global_md}
          onChange={(v) => update("claude_global_md", v)}
          status={statuses.claude_global_md}
        />
        <InstructionField
          title="Codex AGENTS"
          helper="~/.codex/AGENTS.md — synced to agent on connect. Agent writes only if file is absent locally."
          value={data.codex_agents_md}
          onChange={(v) => update("codex_agents_md", v)}
          status={statuses.codex_agents_md}
        />
        <InstructionField
          title="Codex config"
          helper="~/.codex/config.toml — lines matching api_key/token/secret/password are stripped server-side."
          value={data.codex_config_toml}
          onChange={(v) => update("codex_config_toml", v)}
          status={statuses.codex_config_toml}
        />
      </div>
      {strippedFlash > 0 && (
        <p className="text-xs text-amber-300">
          Stripped {strippedFlash} secret line(s) on save.
        </p>
      )}
    </div>
  );
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

function InstructionField({
  title,
  helper,
  value,
  onChange,
  status,
}: {
  title: string;
  helper: string;
  value: string;
  onChange: (v: string) => void;
  status: SaveStatus;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">
          {title}
        </h4>
        <SaveBadge status={status} />
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-2">{helper}</p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={12}
        maxLength={100_000}
        className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-xs text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500/50 font-mono resize-y min-h-[280px]"
        spellCheck={false}
      />
      <div className="mt-1.5 text-[10px] text-[var(--text-muted)] text-right">
        {value.length.toLocaleString()} / 100,000
      </div>
    </Card>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  if (status === "idle") return null;
  if (status === "saving")
    return <StatusPill status="pending" size="sm" label="Saving…" />;
  if (status === "saved")
    return <StatusPill status="success" size="sm" label="Saved" />;
  return <StatusPill status="error" size="sm" label="Error" />;
}

export default PromptsTab;
