/**
 * Phase 12 W4b — Settings → Profile tab.
 *
 * User identity ONLY: email (read-only), display_name, avatar, timezone,
 * notifications.
 *
 * Saves via the Wave 2 PATCH /api/users/me/profile endpoint (extended editor
 * that also accepts the `notifications` JSONB blob). The existing useProfile
 * hook still uses PATCH /api/profile — for fields covered by both, we route
 * through the W2 endpoint and refresh the legacy profile shape afterwards.
 */
import { useEffect, useRef, useState } from "react";
import { hubFetch } from "../../lib/api";
import type { Profile } from "../../hooks/useProfile";
import { useWebPushPermission } from "../../hooks/useWebPushPermission";
import { useSessions, githubOwnerRepo } from "../../hooks/useSessions";
import { Card, Field, Button, StatusPill, Toggle, LoadingState, EmptyState } from "../../components/ui";

interface Props {
  token: string;
  profile: Profile;
  onUpdateProfile: (data: {
    display_name?: string;
    avatar_url?: string | null;
    timezone?: string;
    web_push_enabled?: boolean;
  }) => Promise<any>;
}

export function ProfileTab({ token, profile, onUpdateProfile }: Props) {
  useEffect(() => {
    console.log("[tab:settings:profile] mounted");
    return () => console.log("[tab:settings:profile] unmounted");
  }, []);
  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 w-full max-w-5xl mx-auto space-y-5">
      <IdentityCard token={token} profile={profile} onUpdateProfile={onUpdateProfile} />
      <TimezoneCard token={token} profile={profile} />
      <NotificationsCard profile={profile} onUpdateProfile={onUpdateProfile} />
      <TelegramCard token={token} />
    </div>
  );
}

/* ─────────────────────────── Identity ─────────────────────────── */

function IdentityCard({
  token,
  profile,
  onUpdateProfile,
}: {
  token: string;
  profile: Profile;
  onUpdateProfile: Props["onUpdateProfile"];
}) {
  const [displayName, setDisplayName] = useState(profile.display_name || "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = displayName !== (profile.display_name || "");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Use the W2 endpoint so we exercise it; the hook-level refresh keeps
      // the rest of the app in sync.
      await hubFetch(token, "/api/users/me/profile", {
        method: "PATCH",
        json: { display_name: displayName },
      });
      // Refresh the legacy hook's view so the header avatar/name updates.
      await onUpdateProfile({ display_name: displayName });
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
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Identity
        </h3>
        {savedAt && !dirty && (
          <StatusPill status="success" size="sm" label="Saved" />
        )}
      </div>

      <AvatarUploader profile={profile} onUpdateProfile={onUpdateProfile} />

      <Field label="Email" helper="Change in Titanium.">
        <div className="px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-muted)]">
          {profile.email}
        </div>
      </Field>

      <Field label="Display name" helper="Shown next to your messages.">
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Display name"
          className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        />
      </Field>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <Button
        variant="primary"
        size="sm"
        onClick={save}
        loading={saving}
        disabled={!dirty || saving}
      >
        Save
      </Button>
    </Card>
  );
}

/* ─────────────────────────── Avatar uploader ─────────────────────────── */

function AvatarUploader({
  profile,
  onUpdateProfile,
}: {
  profile: Profile;
  onUpdateProfile: (data: { avatar_url?: string | null }) => Promise<any>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const initial = (
    profile.display_name?.trim()?.[0] ||
    profile.email?.[0] ||
    "?"
  ).toUpperCase();
  const MAX_BYTES = 1_000_000;

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/^image\//.test(f.type)) {
      setError("Pick an image file");
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`Image must be under ${(MAX_BYTES / 1024 / 1024).toFixed(1)} MB`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      });
      await onUpdateProfile({ avatar_url: dataUrl });
    } catch (err: any) {
      setError(err?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="text-xs font-medium text-[var(--text-secondary)] mb-1.5">
        Avatar
      </p>
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 rounded-full bg-indigo-600 flex items-center justify-center text-[var(--text-on-accent)] text-lg font-semibold overflow-hidden shrink-0">
          {profile.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            initial
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => inputRef.current?.click()}
            loading={busy}
          >
            {profile.avatar_url ? "Replace" : "Upload"}
          </Button>
          {profile.avatar_url && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onUpdateProfile({ avatar_url: null })}
              disabled={busy}
            >
              Remove
            </Button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={onFile}
            className="hidden"
          />
        </div>
      </div>
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
      <p className="text-xs text-[var(--text-muted)] mt-1.5">
        PNG/JPEG/WebP, max 1 MB.
      </p>
    </div>
  );
}

/* ─────────────────────────── Timezone ─────────────────────────── */

function TimezoneCard({ token, profile }: { token: string; profile: Profile }) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initial = profile.timezone || browserTz;
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profile.timezone) setValue(profile.timezone);
  }, [profile.timezone]);

  const zones = (Intl as any).supportedValuesOf
    ? ((Intl as any).supportedValuesOf("timeZone") as string[])
    : [browserTz, "UTC"];

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await hubFetch(token, "/api/users/me/profile", {
        method: "PATCH",
        json: { timezone: value },
      });
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const dirty = value !== initial;

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Timezone
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Used for the daily cost-cap window and scheduled-task previews.
          </p>
        </div>
        {savedAt && !dirty && (
          <StatusPill status="success" size="sm" label="Saved" />
        )}
      </div>
      <Field label="IANA zone">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </Field>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <Button
        variant="primary"
        size="sm"
        onClick={save}
        loading={saving}
        disabled={!dirty || saving}
      >
        Save
      </Button>
    </Card>
  );
}

/* ─────────────────────────── Notifications ─────────────────────────── */

function NotificationsCard({
  profile,
  onUpdateProfile,
}: {
  profile: Profile;
  onUpdateProfile: Props["onUpdateProfile"];
}) {
  const [webPush, setWebPush] = useState<boolean>(profile.web_push_enabled ?? true);
  const [saving, setSaving] = useState(false);
  const { permission, request, isSupported } = useWebPushPermission();

  const toggleWebPush = async () => {
    if (permission !== "granted") return;
    const next = !webPush;
    setWebPush(next);
    setSaving(true);
    try {
      await onUpdateProfile({ web_push_enabled: next });
    } catch {
      setWebPush(!next);
    } finally {
      setSaving(false);
    }
  };
  const toggleDisabled = saving || permission !== "granted";

  return (
    <Card className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
        Notifications
      </h3>

      <Field label="Default email recipient" helper="Used by email post-run actions when no override is set.">
        <div className="px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-muted)]">
          {profile.email}
        </div>
      </Field>

      {!isSupported && (
        <p className="text-xs text-[var(--text-muted)]">
          Browser doesn't support notifications.
        </p>
      )}

      {isSupported && permission === "denied" && (
        <StatusPill
          status="error"
          size="sm"
          label="Notifications blocked — enable in browser settings"
        />
      )}

      {isSupported && permission === "default" && (
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void request();
          }}
        >
          Enable browser notifications
        </Button>
      )}

      <div
        className="w-full flex items-center justify-between gap-3 pt-2"
        title="Show browser notifications for scheduled-task events when this tab is backgrounded."
      >
        <span className="text-sm text-[var(--text-primary)]">
          Web push (this tab)
        </span>
        <Toggle
          checked={webPush && permission === "granted"}
          onChange={() => void toggleWebPush()}
          disabled={toggleDisabled}
          aria-label="Web push (this tab)"
        />
      </div>
    </Card>
  );
}

/* ─────────────────────────── Telegram ─────────────────────────── */

type TelegramStatus = {
  linked: boolean;
  chat_id: string | null;
  default_session_id: string | null;
  bot_username: string | null;
  bot_configured: boolean;
};

function TelegramCard({ token }: { token: string }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<{ code: string; deepLink: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  // Lightweight read of the user's sessions to populate the default-session
  // select. No `subscribe` passed — a one-shot GET /api/sessions on mount is
  // enough here; the list is array-guarded inside the hook.
  const { sessions } = useSessions(token);
  const safeSessions = Array.isArray(sessions) ? sessions : [];

  const refresh = async () => {
    try {
      const r = await hubFetch<TelegramStatus>(token, "/api/telegram/status");
      setStatus(r);
    } catch (e: any) {
      setError(e?.message || "Failed to load Telegram status");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const startLink = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await hubFetch<{ code: string; deepLink: string; expiresAt: string }>(
        token,
        "/api/telegram/link-code",
        { method: "POST", json: {} },
      );
      setLinkCode(r);
      if (r.deepLink) window.open(r.deepLink, "_blank");
    } catch (e: any) {
      setError(e?.status === 503 ? "Telegram bridge isn't configured on this server." : e?.message || "Failed to start link");
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await hubFetch(token, "/api/telegram/link", { method: "DELETE" });
      setLinkCode(null);
      setConfirmUnlink(false);
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Unlink failed");
    } finally {
      setBusy(false);
    }
  };

  const setDefaultSession = async (sessionId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await hubFetch(token, "/api/telegram/default-session", {
        method: "PUT",
        json: { session_id: sessionId },
      });
      setStatus((prev) => (prev ? { ...prev, default_session_id: sessionId } : prev));
    } catch (e: any) {
      setError(e?.message || "Failed to set default session");
    } finally {
      setBusy(false);
    }
  };

  const sessionLabel = (s: (typeof safeSessions)[number]) =>
    githubOwnerRepo(s) || s.name || s.project_dir || s.id;

  return (
    <Card className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Telegram</h3>

      {loading ? (
        <LoadingState variant="inline" label="Loading Telegram status…" />
      ) : !status?.bot_configured ? (
        <EmptyState
          title="Telegram not configured"
          description="The Telegram bridge isn't configured on this server."
        />
      ) : !status.linked ? (
        <div className="space-y-3">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Link your Telegram account to chat with your sessions from Telegram. Tap below to open Telegram
            and send the code to the bot.
          </p>
          <Button variant="primary" size="sm" onClick={startLink} loading={busy}>
            Link Telegram
          </Button>
          {linkCode && (
            <div className="text-xs text-[var(--text-muted)]">
              If Telegram didn't open, send this code to{" "}
              {status.bot_username ? `@${status.bot_username}` : "the bot"}:{" "}
              <span className="font-mono text-[var(--text-secondary)]">/start {linkCode.code}</span>
              <span className="ml-1">(expires in 10 min)</span>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <StatusPill status="success" size="sm" label="Linked" />
            {status.chat_id && (
              <span className="text-xs text-[var(--text-muted)]">chat {status.chat_id}</span>
            )}
          </div>

          <Field label="Default session" helper="Inbound Telegram messages route to this session.">
            <select
              value={status.default_session_id ?? ""}
              disabled={busy}
              onChange={(e) => void setDefaultSession(e.target.value || null)}
              className="w-full px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            >
              <option value="">None</option>
              {safeSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {sessionLabel(s)}
                </option>
              ))}
            </select>
          </Field>

          {confirmUnlink ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--text-secondary)]">Unlink Telegram?</span>
              <Button variant="danger" size="sm" onClick={unlink} loading={busy}>
                Confirm unlink
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmUnlink(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setConfirmUnlink(true)} disabled={busy}>
              Unlink
            </Button>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

export default ProfileTab;
