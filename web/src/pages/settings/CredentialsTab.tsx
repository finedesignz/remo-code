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
import { useApiKey } from "../../hooks/useApiKey";
import {
  Card,
  Button,
  Field,
  StatusPill,
  LoadingState,
  EmptyState,
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

function ApiKeyCard({ token }: { token: string }) {
  const { activeKey, loading, generateKey, revokeKey } = useApiKey(token);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleGenerate = async () => {
    setOpError(null);
    const result = await generateKey();
    if (result.ok && result.data?.key) {
      setNewKey(result.data.key);
      setConfirming(false);
    } else if (!result.ok) {
      setOpError(result.message);
    }
  };

  const handleRevoke = async () => {
    if (!activeKey) return;
    setOpError(null);
    const result = await revokeKey(activeKey.id);
    if (result.ok) {
      setNewKey(null);
      setConfirming(false);
    } else {
      setOpError(result.message);
    }
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
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          API key
        </h3>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          Authenticates the Remo Code Supervisor / agent. One key connects all
          your projects.
        </p>
      </div>

      {newKey && (
        <div className="bg-emerald-500/10 rounded-lg ring-1 ring-emerald-500/30 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-emerald-300 font-semibold">
              New API key (shown once)
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

      {activeKey ? (
        <div className="flex items-center justify-between gap-3 px-3 py-2 bg-[var(--bg-tertiary)]/40 rounded-lg">
          <div className="flex-1 min-w-0">
            <code className="text-xs text-[var(--text-secondary)] font-mono">
              {(activeKey as any).prefix || "remo_…"}
            </code>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Created {new Date(activeKey.created_at).toLocaleDateString()}
              {activeKey.last_used_at &&
                ` · Last used ${new Date(activeKey.last_used_at).toLocaleDateString()}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status="success" size="sm" label="Active" />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleGenerate}
              title="Rotate key (revokes current, generates new)"
            >
              Rotate
            </Button>
            {confirming ? (
              <Button variant="danger" size="sm" onClick={handleRevoke}>
                Confirm revoke
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(true)}
              >
                Revoke
              </Button>
            )}
          </div>
        </div>
      ) : (
        <EmptyState
          title="No active key"
          description="Generate one to connect a Remo Code Supervisor or agent."
          action={{ label: "Generate key", onClick: handleGenerate }}
        />
      )}
    </Card>
  );
}

/* ─────────────────────────── Coolify webhook ─────────────────────────── */

function CoolifyWebhookCard({ token }: { token: string }) {
  return (
    <WebhookCard
      token={token}
      title="Coolify webhook"
      helper="Paste into Coolify Notifications → Webhook. The URL IS the credential — treat as a secret."
      getEndpoint="/api/account/coolify-webhook-secret"
      rotateEndpoint="/api/account/coolify-webhook-secret/rotate"
    />
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
