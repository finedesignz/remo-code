/**
 * Phase 12 W4b — Settings → Usage tab.
 *
 * Surfaces the Wave 2 GET /api/usage/summary endpoint with:
 *   - Three cost cards: Today / Week-to-date / Month-to-date
 *   - Threshold sliders for the Claude session + week %s (PR #52)
 *   - Daily cost cap editor
 *
 * Thresholds use the existing PUT /api/account/claude-thresholds endpoint
 * (see hub/src/api/account.ts). Daily cap uses the existing
 * PATCH /api/profile { daily_cost_cap_usd } endpoint.
 */
import { useCallback, useEffect, useState } from "react";
import { hubFetch } from "../../lib/api";
import type { Profile } from "../../hooks/useProfile";
import { Card, Field, Button, StatusPill, LoadingState } from "../../components/ui";

interface UsageSummary {
  timezone: string;
  today_usd: number;
  week_usd: number;
  month_usd: number;
  daily_cap_usd: number;
  thresholds: {
    session_pct: number | null;
    week_pct: number | null;
  };
  claude_window: any | null;
  claude_window_updated_at: string | null;
}

interface Props {
  token: string;
  profile: Profile;
  onUpdateProfile: (data: { daily_cost_cap_usd?: number }) => Promise<any>;
}

export function UsageTab({ token, profile, onUpdateProfile }: Props) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await hubFetch<UsageSummary>(token, "/api/usage/summary");
      setSummary(s);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load usage");
    }
  }, [token]);

  useEffect(() => {
    void load();
    // refresh every 60s — matches the server cache TTL
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 w-full max-w-7xl mx-auto space-y-5">
      <CostCards summary={summary} error={error} />
      <LimitsCard summary={summary} />
      <ThresholdsCard token={token} initial={summary?.thresholds} />
      <DailyCapCard
        profile={profile}
        summary={summary}
        onUpdateProfile={onUpdateProfile}
      />
    </div>
  );
}

/* ─────────────────────────── Cost cards ─────────────────────────── */

function CostCards({
  summary,
  error,
}: {
  summary: UsageSummary | null;
  error: string | null;
}) {
  if (error) {
    return (
      <Card>
        <p className="text-sm text-red-400">{error}</p>
      </Card>
    );
  }
  if (!summary) {
    return (
      <Card>
        <LoadingState label="Loading usage…" />
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <CostCard label="Today" value={summary.today_usd} cap={summary.daily_cap_usd} />
      <CostCard label="Week-to-date" value={summary.week_usd} />
      <CostCard label="Month-to-date" value={summary.month_usd} />
    </div>
  );
}

function CostCard({
  label,
  value,
  cap,
}: {
  label: string;
  value: number;
  cap?: number;
}) {
  const pct = cap && cap > 0 ? Math.round((value / cap) * 100) : null;
  const tone =
    pct === null
      ? "info"
      : pct < 50
        ? "success"
        : pct < 80
          ? "warning"
          : "error";
  return (
    <Card>
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="text-2xl font-semibold text-[var(--text-primary)] mt-1 font-mono">
        ${value.toFixed(value < 1 ? 4 : 2)}
      </p>
      {pct !== null && (
        <div className="mt-2">
          <StatusPill
            status={tone}
            size="sm"
            label={`${pct}% of $${cap!.toFixed(2)} cap`}
          />
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────── Limit windows ───────────────────────── */

interface LimitWindow {
  utilization: number;
  resets_at: string;
}

/** resets_at - now → "Nh Mm" (or "Nd Nh" / "Nm"). Mirrors UsageStrip. */
function formatResetIn(resetsAt: string): string {
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return "soon";
  const diff = target - Date.now();
  if (diff <= 0) return "now";
  const totalMin = Math.floor(diff / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

/** Colour band per spec: <50 success / <80 warning / ≥80 error. */
function bandFor(util: number): "success" | "warning" | "error" {
  if (util < 50) return "success";
  if (util < 80) return "warning";
  return "error";
}

function LimitRow({ label, window }: { label: string; window: LimitWindow }) {
  const util = Math.max(0, Math.min(100, window.utilization));
  const tone = bandFor(util);
  const barColor =
    tone === "success"
      ? "bg-emerald-400"
      : tone === "warning"
        ? "bg-amber-400"
        : "bg-red-400";
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-[var(--text-primary)] w-32 shrink-0">{label}</span>
      <span className="flex-1 h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <span className={`block h-full ${barColor} transition-all`} style={{ width: `${util}%` }} />
      </span>
      <span className="text-sm font-mono text-[var(--text-primary)] w-14 text-right">
        {util.toFixed(1)}%
      </span>
      <span className="text-xs text-[var(--text-muted)] w-28 text-right">
        resets in {formatResetIn(window.resets_at)}
      </span>
    </div>
  );
}

function LimitsCard({ summary }: { summary: UsageSummary | null }) {
  const w = summary?.claude_window as
    | {
        five_hour?: LimitWindow;
        seven_day?: LimitWindow;
        seven_day_opus?: LimitWindow | null;
        seven_day_oauth_apps?: LimitWindow | null;
      }
    | null
    | undefined;

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Anthropic limit windows
        </h3>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          Live utilization + reset countdown from the local supervisor's poll of{" "}
          <code className="text-[var(--text-muted)]">/api/oauth/usage</code> (every 5 min).
          Opus + OAuth-app rows appear only for Claude Max accounts.
        </p>
      </div>

      {!w?.five_hour ? (
        <p className="text-sm text-[var(--text-muted)]">
          Waiting for the supervisor to report usage…
        </p>
      ) : (
        <div className="space-y-2.5 pt-1">
          <LimitRow label="5-hour session" window={w.five_hour} />
          {w.seven_day && <LimitRow label="7-day" window={w.seven_day} />}
          {w.seven_day_opus && <LimitRow label="7-day Opus" window={w.seven_day_opus} />}
          {w.seven_day_oauth_apps && (
            <LimitRow label="7-day OAuth apps" window={w.seven_day_oauth_apps} />
          )}
        </div>
      )}
      {summary?.claude_window_updated_at && (
        <p className="text-[10px] text-[var(--text-muted)] pt-1">
          Updated {new Date(summary.claude_window_updated_at).toLocaleTimeString()}
        </p>
      )}
    </Card>
  );
}

/* ─────────────────────────── Thresholds ─────────────────────────── */

function ThresholdsCard({
  token,
  initial,
}: {
  token: string;
  initial: { session_pct: number | null; week_pct: number | null } | undefined;
}) {
  const [session, setSession] = useState<number>(80);
  const [week, setWeek] = useState<number>(80);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    if (!initial || bootstrapped) return;
    setSession(initial.session_pct ?? 80);
    setWeek(initial.week_pct ?? 80);
    setBootstrapped(true);
  }, [initial, bootstrapped]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await hubFetch(token, "/api/account/claude-thresholds", {
        method: "PUT",
        json: { session_pct: session, week_pct: week },
      });
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Claude window thresholds
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Pause scheduled tasks when your Anthropic 5-hour / 7-day window
            crosses these utilization %s.
          </p>
        </div>
        {savedAt && (
          <StatusPill status="success" size="sm" label="Saved" />
        )}
      </div>

      <Field
        label={`5-hour session — ${session}%`}
        helper="When the 5-hour window crosses this, scheduled tasks pause."
      >
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={session}
          onChange={(e) => setSession(parseInt(e.target.value, 10))}
          className="w-full accent-blue-500"
        />
      </Field>

      <Field
        label={`7-day window — ${week}%`}
        helper="When the 7-day window crosses this, scheduled tasks pause."
      >
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={week}
          onChange={(e) => setWeek(parseInt(e.target.value, 10))}
          className="w-full accent-blue-500"
        />
      </Field>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <Button variant="primary" size="sm" onClick={save} loading={saving}>
        Save thresholds
      </Button>
    </Card>
  );
}

/* ─────────────────────────── Daily cap ─────────────────────────── */

function DailyCapCard({
  profile,
  summary,
  onUpdateProfile,
}: {
  profile: Profile;
  summary: UsageSummary | null;
  onUpdateProfile: (data: { daily_cost_cap_usd?: number }) => Promise<any>;
}) {
  const initial = profile.daily_cost_cap_usd ?? summary?.daily_cap_usd ?? 10;
  const [cap, setCap] = useState<string>(String(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const save = async () => {
    const n = parseFloat(cap);
    if (!Number.isFinite(n) || n < 0) {
      setError("Invalid number");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onUpdateProfile({ daily_cost_cap_usd: n });
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Daily cost cap
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Scheduled tasks won't fire if today's spend would exceed this.
            Manual chat is not affected. USD/day.
          </p>
        </div>
        {savedAt && <StatusPill status="success" size="sm" label="Saved" />}
      </div>

      <Field label="Cap (USD/day)">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)] text-sm">$</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            className="w-32 px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          />
          <Button variant="primary" size="sm" onClick={save} loading={saving}>
            Save
          </Button>
        </div>
      </Field>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

export default UsageTab;
