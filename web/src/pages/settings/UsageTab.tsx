/**
 * Settings → Usage tab (Phase 11 — usage-tab-cleanup).
 *
 * Surfaces GET /api/usage/summary with:
 *   - Three cost cards: Today / Week-to-date / Month-to-date, each showing the
 *     token count beneath the dollar figure.
 *   - Anthropic live limit windows.
 *   - A single merged "Claude Usage and Cost Controls" card holding the daily
 *     cost cap + session% + week% thresholds, laid out compactly. All three
 *     autosave on blur (no Save buttons); helper copy lives in InfoTips.
 *
 * Thresholds use PUT /api/account/claude-thresholds { session_pct, week_pct }.
 * Daily cap uses PATCH /api/profile { daily_cost_cap_usd }.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { hubFetch } from "../../lib/api";
import type { Profile } from "../../hooks/useProfile";
import {
  useProgrammaticLeakAlert,
  type ProgrammaticCredit,
} from "../../hooks/useSubscriptionUsage";
import { Card, Field, InfoTip, StatusPill, LoadingState } from "../../components/ui";

interface UsageSummary {
  timezone: string;
  today_usd: number;
  week_usd: number;
  month_usd: number;
  today_tokens: number;
  week_tokens: number;
  month_tokens: number;
  daily_cap_usd: number;
  thresholds: {
    session_pct: number | null;
    week_pct: number | null;
  };
  claude_window: any | null;
  claude_window_updated_at: string | null;
}

type Subscribe = (handler: (msg: any) => void) => () => void;

interface Props {
  token: string;
  profile: Profile;
  onUpdateProfile: (data: { daily_cost_cap_usd?: number; programmatic_halt_usd?: number | null }) => Promise<any>;
  subscribe: Subscribe;
}

export function UsageTab({ token, profile, onUpdateProfile, subscribe }: Props) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { alert, dismiss } = useProgrammaticLeakAlert(subscribe);

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
      {alert && <LeakAlertBanner alert={alert} onDismiss={dismiss} />}
      <CostCards summary={summary} error={error} />
      <LimitsCard summary={summary} />
      <ProgrammaticCreditCard summary={summary} />
      <ControlsCard
        token={token}
        profile={profile}
        summary={summary}
        onUpdateProfile={onUpdateProfile}
      />
    </div>
  );
}

/* ───────────── Programmatic credit (Phase 18 dual-bucket) ───────────── */

function ProgrammaticCreditCard({ summary }: { summary: UsageSummary | null }) {
  const credit = (summary?.claude_window?.programmatic_credit ?? null) as
    | ProgrammaticCredit
    | null;

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Programmatic credit
        </h3>
        <InfoTip
          content={
            <>
              The Agent-SDK / headless credit pool (separate from the interactive
              subscription limits as of June 15 2026). Automation bills against
              this dollar credit; your interactive sessions do not. Shows an empty
              state until the credit is claimed.
            </>
          }
        />
      </div>

      {!credit || !credit.claimed ? (
        <p className="text-sm text-[var(--text-muted)]">
          Programmatic credit not claimed or unavailable yet.
        </p>
      ) : (
        <ProgrammaticCreditBar credit={credit} />
      )}
    </Card>
  );
}

function ProgrammaticCreditBar({ credit }: { credit: ProgrammaticCredit }) {
  const limit = credit.limit_usd > 0 ? credit.limit_usd : 0;
  const pct = limit > 0 ? Math.max(0, Math.min(100, (credit.used_usd / limit) * 100)) : 0;
  const tone = bandFor(pct);
  const barColor =
    tone === "success" ? "bg-emerald-400" : tone === "warning" ? "bg-amber-400" : "bg-red-400";
  const remaining = Math.max(0, limit - credit.used_usd);
  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center gap-3">
        <span className="text-sm text-[var(--text-primary)] w-32 shrink-0">Credit used</span>
        <span className="flex-1 h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
          <span className={`block h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
        </span>
        <span className="text-sm font-mono text-[var(--text-primary)] w-28 text-right">
          ${credit.used_usd.toFixed(2)} / ${limit.toFixed(2)}
        </span>
      </div>
      <p className="text-xs text-[var(--text-muted)] font-mono">
        ${remaining.toFixed(2)} remaining · resets in {formatResetIn(credit.resets_at)}
      </p>
    </div>
  );
}

/* ───────────── Leak alert banner (Phase 18) ───────────── */

function LeakAlertBanner({
  alert,
  onDismiss,
}: {
  alert: { reason: string; delta_usd: number; used_usd: number; limit_usd: number };
  onDismiss: () => void;
}) {
  const why =
    alert.reason === "drain_without_automation"
      ? "programmatic credit drained with no automation running"
      : "programmatic credit drained faster than your configured rate";
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-start justify-between gap-3">
      <div className="text-sm text-[var(--text-primary)]">
        <span className="font-semibold text-amber-400">Programmatic credit alert — </span>
        {why}: +${alert.delta_usd.toFixed(2)} (now ${alert.used_usd.toFixed(2)} of $
        {alert.limit_usd.toFixed(2)}).
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0"
      >
        Dismiss
      </button>
    </div>
  );
}

/* ─────────────────────────── Cost cards ─────────────────────────── */

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

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
      <CostCard
        label="Today"
        value={summary.today_usd}
        tokens={summary.today_tokens}
        cap={summary.daily_cap_usd}
      />
      <CostCard label="Week-to-date" value={summary.week_usd} tokens={summary.week_tokens} />
      <CostCard label="Month-to-date" value={summary.month_usd} tokens={summary.month_tokens} />
    </div>
  );
}

function CostCard({
  label,
  value,
  tokens,
  cap,
}: {
  label: string;
  value: number;
  tokens: number;
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
      <p className="text-xs text-[var(--text-muted)] mt-0.5 font-mono">
        {formatTokens(tokens)} tokens
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
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Anthropic limit windows
        </h3>
        <InfoTip
          content={
            <>
              Live utilization + reset countdown from the local supervisor's poll of{" "}
              <code>/api/oauth/usage</code> (every 5 min). Opus + OAuth-app rows appear only
              for Claude Max accounts.
            </>
          }
        />
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

/* ───────────────── Claude Usage and Cost Controls ───────────────── */

/** Briefly shows a "Saved" pill after a successful autosave. */
function useSavedFlash(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback(() => {
    setShown(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(false), 2000);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [shown, flash];
}

function ControlsCard({
  token,
  profile,
  summary,
  onUpdateProfile,
}: {
  token: string;
  profile: Profile;
  summary: UsageSummary | null;
  onUpdateProfile: (data: { daily_cost_cap_usd?: number; programmatic_halt_usd?: number | null }) => Promise<any>;
}) {
  // Daily cap
  const initialCap = profile.daily_cost_cap_usd ?? summary?.daily_cap_usd ?? 10;
  const [cap, setCap] = useState<string>(String(initialCap));
  const lastCap = useRef<number>(initialCap);

  // Thresholds
  const [session, setSession] = useState<number>(80);
  const [week, setWeek] = useState<number>(80);
  const lastThresholds = useRef<{ session: number; week: number }>({ session: 80, week: 80 });
  const [bootstrapped, setBootstrapped] = useState(false);

  // Phase 18 (R-PTY-18): opt-in programmatic-credit hard-halt. OFF by default
  // (null/0 bound). Toggling on without a bound is a no-op until a bound is set.
  const initialHalt = profile.programmatic_halt_usd ?? null;
  const [haltEnabled, setHaltEnabled] = useState<boolean>(
    initialHalt != null && initialHalt > 0,
  );
  const [haltBound, setHaltBound] = useState<string>(
    initialHalt != null && initialHalt > 0 ? String(initialHalt) : "",
  );
  const lastHalt = useRef<number | null>(initialHalt && initialHalt > 0 ? initialHalt : null);

  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();

  useEffect(() => {
    if (bootstrapped || !summary) return;
    const s = summary.thresholds.session_pct ?? 80;
    const wk = summary.thresholds.week_pct ?? 80;
    setSession(s);
    setWeek(wk);
    lastThresholds.current = { session: s, week: wk };
    const c = profile.daily_cost_cap_usd ?? summary.daily_cap_usd ?? 10;
    setCap(String(c));
    lastCap.current = c;
    setBootstrapped(true);
  }, [summary, profile.daily_cost_cap_usd, bootstrapped]);

  const saveCap = async () => {
    const n = parseFloat(cap);
    if (!Number.isFinite(n) || n < 0) {
      setError("Daily cap must be a non-negative number");
      return;
    }
    if (n === lastCap.current) return; // no change
    setError(null);
    try {
      await onUpdateProfile({ daily_cost_cap_usd: n });
      lastCap.current = n;
      flashSaved();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    }
  };

  const saveThresholds = async () => {
    if (
      session === lastThresholds.current.session &&
      week === lastThresholds.current.week
    ) {
      return; // no change
    }
    setError(null);
    try {
      await hubFetch(token, "/api/account/claude-thresholds", {
        method: "PUT",
        json: { session_pct: session, week_pct: week },
      });
      lastThresholds.current = { session, week };
      flashSaved();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    }
  };

  // Persist the hard-halt bound. Disabled toggle OR empty/0 bound => null (OFF).
  const saveHalt = async () => {
    let next: number | null = null;
    if (haltEnabled) {
      const n = parseFloat(haltBound);
      if (haltBound.trim() !== "" && (!Number.isFinite(n) || n < 0)) {
        setError("Hard-halt bound must be a non-negative number");
        return;
      }
      next = Number.isFinite(n) && n > 0 ? n : null;
    }
    if (next === lastHalt.current) return; // no change
    setError(null);
    try {
      await onUpdateProfile({ programmatic_halt_usd: next });
      lastHalt.current = next;
      flashSaved();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    }
  };

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Claude Usage and Cost Controls
          </h3>
          <InfoTip content="Set a daily spend ceiling and the utilization thresholds at which scheduled tasks pause. Changes save automatically." />
        </div>
        {saved && <StatusPill status="success" size="sm" label="Saved" />}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
        <Field
          label="Daily cost cap (USD)"
          helper="Scheduled tasks won't fire if today's spend would exceed this. Manual chat is not affected."
        >
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-muted)] text-sm">$</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              onBlur={() => void saveCap()}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
        </Field>

        <Field
          label={`5-hour session — ${session}%`}
          helper="When the 5-hour Anthropic window crosses this utilization, scheduled tasks pause."
        >
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={session}
            onChange={(e) => setSession(parseInt(e.target.value, 10))}
            onMouseUp={() => void saveThresholds()}
            onBlur={() => void saveThresholds()}
            className="w-full accent-blue-500"
          />
        </Field>

        <Field
          label={`7-day window — ${week}%`}
          helper="When the 7-day Anthropic window crosses this utilization, scheduled tasks pause."
        >
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={week}
            onChange={(e) => setWeek(parseInt(e.target.value, 10))}
            onMouseUp={() => void saveThresholds()}
            onBlur={() => void saveThresholds()}
            className="w-full accent-blue-500"
          />
        </Field>
      </div>

      {/* Phase 18 (R-PTY-18): opt-in programmatic-credit hard-halt. */}
      <div className="border-t border-[var(--bg-tertiary)] pt-4 space-y-3">
        <div className="flex items-center gap-1">
          <h4 className="text-sm font-semibold text-[var(--text-primary)]">
            Programmatic credit hard-halt
          </h4>
          <InfoTip content="Optional. When the programmatic (Agent-SDK) credit reaches this dollar bound, automation dispatch is halted. This never affects your own interactive work. Off by default." />
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            checked={haltEnabled}
            onChange={(e) => {
              setHaltEnabled(e.target.checked);
              if (!e.target.checked) void onUpdateProfile({ programmatic_halt_usd: null }).then(() => { lastHalt.current = null; flashSaved(); });
            }}
            className="accent-blue-500"
          />
          Halt automation when programmatic credit crosses a bound
        </label>
        {haltEnabled && (
          <Field
            label="Hard-halt bound (USD)"
            helper="Halts automation only — your interactive sessions keep running. An alert fires before this bound is reached, so it is never a surprise."
          >
            <div className="flex items-center gap-2 max-w-xs">
              <span className="text-[var(--text-muted)] text-sm">$</span>
              <input
                type="number"
                min={0}
                step={1}
                value={haltBound}
                onChange={(e) => setHaltBound(e.target.value)}
                onBlur={() => void saveHalt()}
                className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              />
            </div>
          </Field>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

export default UsageTab;
