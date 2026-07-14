/**
 * Phase 12 W4b — Settings → Credentials tab.
 *
 * Composes:
 *   1. ApiKeyCard — supervisor / agent authentication key
 *   2. CoolifyWebhookCard — public webhook URL Coolify pushes events to
 *   3. RevanoteWebhookCard — public webhook URL Revanote calls
 *
 * All endpoints exist on the hub already (see hub/src/api/account.ts +
 * hub/src/api/api-keys.ts). This module just rebuilds the UI on the new
 * primitives.
 */
import { useEffect, useState } from "react";
import { hubFetch } from "../../lib/api";
import { useApiKey, SCOPE_HELP, type Scope } from "../../hooks/useApiKey";
import {
  Card,
  Button,
  Field,
  StatusPill,
  LoadingState,
  EmptyState,
  Toggle,
  InfoTip,
} from "../../components/ui";

interface Props {
  token: string;
}

export function CredentialsTab({ token }: Props) {
  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 w-full max-w-7xl mx-auto space-y-5">
      <ApiKeyCard token={token} />
      <CoolifyWebhookCard token={token} />
      <RevanoteWebhookCard token={token} />
    </div>
  );
}

/* ─────────────────────────── API key ─────────────────────────── */

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: "agent", label: SCOPE_HELP["agent"] },
  { value: "ext:read", label: SCOPE_HELP["ext:read"] },
  { value: "ext:ask", label: SCOPE_HELP["ext:ask"] },
];

function ScopePills({ scopes }: { scopes: Scope[] | null }) {
  if (!scopes || scopes.length === 0) {
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/30"
        title="Legacy key — full access (all scopes). Rotate it with explicit scopes to narrow it."
      >
        full access
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <span
          key={s}
          title={SCOPE_HELP[s]}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-blue-500/10 text-blue-300 ring-1 ring-blue-500/30"
        >
          {s}
        </span>
      ))}
    </span>
  );
}

function ApiKeyCard({ token }: { token: string }) {
  const { keys, loading, createKey, rotateKey, revokeKey } = useApiKey(token);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["ext:read"]);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const toggleScope = (s: Scope) =>
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );

  const handleCreate = async () => {
    setOpError(null);
    if (scopes.length === 0) {
      setOpError("Pick at least one scope.");
      return;
    }
    const result = await createKey(name.trim() || "New key", scopes);
    if (result.ok && result.data?.key) {
      setNewKey(result.data.key);
      setCreating(false);
      setName("");
      setScopes(["ext:read"]);
    } else if (!result.ok) {
      setOpError(result.message);
    }
  };

  const handleRotate = async (id: string) => {
    setOpError(null);
    const result = await rotateKey(id);
    if (result.ok && result.data?.key) setNewKey(result.data.key);
    else if (!result.ok) setOpError(result.message);
  };

  const handleRevoke = async (id: string) => {
    setOpError(null);
    const result = await revokeKey(id);
    if (result.ok) setConfirmId(null);
    else setOpError(result.message);
  };

  if (loading) {
    return (
      <Card>
        <LoadingState label="Loading…" />
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            API keys
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Each key is named and scoped. Only a key with the{" "}
            <code className="font-mono">agent</code> scope can connect a
            Supervisor and spawn CLI processes — give external tools an{" "}
            <code className="font-mono">ext:*</code> key instead.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setCreating((v) => !v);
            setOpError(null);
          }}
        >
          {creating ? "Cancel" : "Create key"}
        </Button>
      </div>

      {creating && (
        <div className="rounded-lg ring-1 ring-[var(--border)] p-3 space-y-3 bg-[var(--bg-tertiary)]/30">
          <Field label="Name">
            <input
              data-testid="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Claude Desktop"
              className="w-full rounded-lg bg-[var(--bg-secondary)] ring-1 ring-[var(--border)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>
          <Field label="Scopes">
            <div className="space-y-2">
              {SCOPE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-start gap-2 text-xs text-[var(--text-secondary)] cursor-pointer"
                >
                  <input
                    type="checkbox"
                    data-testid={`scope-${opt.value}`}
                    checked={scopes.includes(opt.value)}
                    onChange={() => toggleScope(opt.value)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <span>
                    <code className="font-mono text-[var(--text-primary)]">
                      {opt.value}
                    </code>
                    <span className="block text-[11px] text-[var(--text-muted)]">
                      {opt.label}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          <Button
            variant="primary"
            size="sm"
            data-testid="create-key-submit"
            onClick={handleCreate}
          >
            Create key
          </Button>
        </div>
      )}

      {newKey && (
        <div
          data-testid="new-key-banner"
          className="bg-emerald-500/10 rounded-lg ring-1 ring-emerald-500/30 p-3"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-emerald-300 font-semibold">
              New API key — copy it now. You will not see this again.
            </span>
            <Button variant="ghost" size="sm" onClick={() => copy(newKey)}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <code className="block bg-[var(--code-bg)] rounded-lg p-3 text-xs text-emerald-300 font-mono break-all select-all">
            {newKey}
          </code>
        </div>
      )}

      {opError && <p className="text-xs text-red-400">{opError}</p>}

      {keys.length === 0 ? (
        <EmptyState
          title="No active keys"
          description="Create one to connect a Remo Code Supervisor or an external tool."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left" data-testid="api-keys-table">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Scopes</th>
                <th className="py-2 pr-3 font-medium">Prefix</th>
                <th className="py-2 pr-3 font-medium">Created</th>
                <th className="py-2 pr-3 font-medium">Last used</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr
                  key={k.id}
                  data-testid="api-key-row"
                  className="border-t border-[var(--border)] align-middle"
                >
                  <td className="py-2 pr-3 text-sm text-[var(--text-primary)]">
                    {k.name || "Supervisor"}
                  </td>
                  <td className="py-2 pr-3">
                    <ScopePills scopes={k.scopes} />
                  </td>
                  <td className="py-2 pr-3">
                    <code className="text-xs text-[var(--text-secondary)] font-mono">
                      {k.key_prefix ? `${k.key_prefix}…` : "—"}
                    </code>
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--text-muted)]">
                    {new Date(k.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--text-muted)]">
                    {k.last_used_at
                      ? new Date(k.last_used_at).toLocaleDateString()
                      : "never"}
                  </td>
                  <td className="py-2">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRotate(k.id)}
                        title="Rotate key (revokes current secret, issues a new one with the same name + scopes)"
                      >
                        Rotate
                      </Button>
                      {confirmId === k.id ? (
                        <Button
                          variant="danger"
                          size="sm"
                          data-testid="confirm-revoke"
                          onClick={() => handleRevoke(k.id)}
                        >
                          Confirm revoke
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid="revoke"
                          onClick={() => setConfirmId(k.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ─────────────────────────── Coolify webhook ─────────────────────────── */

function CoolifyWebhookCard({ token }: { token: string }) {
  return (
    <div className="space-y-3">
      <WebhookCard
        token={token}
        title="Coolify webhook"
        helper="Paste into Coolify Notifications → Webhook. The URL IS the credential — treat as a secret."
        getEndpoint="/api/account/coolify-webhook-secret"
        rotateEndpoint="/api/account/coolify-webhook-secret/rotate"
      />
      <CoolifyAutoTriageToggle token={token} />
    </div>
  );
}

/* ─────────────────── Coolify auto-triage master switch ─────────────────── */

function CoolifyAutoTriageToggle({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    hubFetch<{ auto_triage_enabled?: boolean }>(
      token,
      "/api/account/coolify-webhook-secret",
    )
      .then((d) => {
        if (!cancelled) setEnabled(d.auto_triage_enabled ?? true);
      })
      .catch((e: any) => {
        if (!cancelled) setError(String(e?.message || e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onChange = async (next: boolean) => {
    setSaving(true);
    setError(null);
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      const data = await hubFetch<{ auto_triage_enabled: boolean }>(
        token,
        "/api/account/coolify-auto-triage",
        { method: "PATCH", json: { enabled: next } },
      );
      setEnabled(data.auto_triage_enabled);
    } catch (e: any) {
      setEnabled(prev); // revert on failure
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Auto-triage failed deploys
          </h3>
          <InfoTip content="When on, a failed Coolify deploy spins up a triage session — unless you already have a live session on that repo (so it won't interrupt active work)." />
        </div>
        <Toggle
          checked={enabled}
          onChange={onChange}
          disabled={loading || saving}
          aria-label="Auto-triage failed deploys"
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

/* ─────────────────────────── Revanote webhook ─────────────────────────── */

function RevanoteWebhookCard({ token }: { token: string }) {
  return (
    <WebhookCard
      token={token}
      title="Revanote webhook"
      helper="Paste into Revanote project → Webhooks. Token in the path IS the credential."
      getEndpoint="/api/account/revanote-webhook-secret"
      rotateEndpoint="/api/account/revanote-webhook-secret/rotate"
    />
  );
}

/* ─────────────────────────── Generic webhook card ─────────────────────────── */

function WebhookCard({
  token,
  title,
  helper,
  getEndpoint,
  rotateEndpoint,
}: {
  token: string;
  title: string;
  helper: string;
  getEndpoint: string;
  rotateEndpoint: string;
}) {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    hubFetch<{ configured: boolean; webhook_url: string }>(token, getEndpoint)
      .then((d) => {
        if (cancelled) return;
        setConfigured(d.configured);
        setWebhookUrl(d.webhook_url);
      })
      .catch((e: any) => {
        if (!cancelled) setError(String(e?.message || e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, getEndpoint]);

  const handleRotate = async () => {
    setRotating(true);
    setError(null);
    try {
      const data = await hubFetch<{ webhook_url: string }>(token, rotateEndpoint, {
        method: "POST",
      });
      setWebhookUrl(data.webhook_url);
      setConfigured(true);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setRotating(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            {title}
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">{helper}</p>
        </div>
        <StatusPill
          status={configured ? "success" : "idle"}
          size="sm"
          label={configured ? "Configured" : "Not configured"}
        />
      </div>

      <Field label="Webhook URL">
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={loading ? "…" : webhookUrl}
            className="flex-1 px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={copy}
            disabled={loading || !webhookUrl}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRotate}
            loading={rotating}
            disabled={rotating || loading}
            title={configured ? "Rotate URL (invalidates old)" : "Generate URL"}
          >
            Rotate
          </Button>
        </div>
      </Field>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

export default CredentialsTab;
