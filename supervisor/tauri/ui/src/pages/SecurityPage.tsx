// Security tab — API key (masked + reveal + copy + update), host, supervisor ID.
//
// Backend calls reuse existing Tauri commands (get_runtime_status, set_api_key).
// The reveal only surfaces the already-masked value the runtime status exposes;
// the raw key never leaves supervisor.json.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff } from "lucide-react";
import {
  Button,
  Card,
  CopyButton,
  ErrorBanner,
  IconButton,
  ReadOnlyRow,
  SectionTitle,
} from "../components/ui";

interface RuntimeStatus {
  api_key_set: boolean;
  api_key_masked: string;
  hostname: string;
  supervisor_id: string;
}

export default function SecurityPage() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      const s = await invoke<RuntimeStatus>("get_runtime_status");
      setStatus(s);
    } catch (e: any) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    setErr(null);
    try {
      await invoke("set_api_key", { apiKey: draftKey.trim() });
      setSaveMsg("Saved — sidecar restarting");
      setDraftKey("");
      setEditing(false);
      window.setTimeout(() => void refresh(), 600);
      window.setTimeout(() => setSaveMsg(null), 3000);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }, [draftKey, refresh]);

  const masked = status?.api_key_masked ?? "";
  const display = status?.api_key_set
    ? revealed
      ? masked
      : masked.replace(/./g, "•").slice(0, 24)
    : "—";

  return (
    <div className="space-y-5">
      <ErrorBanner message={err} />

      <Card className="space-y-3">
        <SectionTitle
          title="API key"
          info="Only the first 6 and last 4 characters are ever surfaced; the raw key never leaves supervisor.json. Rotate on the hub, then paste the new key here."
        />

        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--text-secondary)] break-all">
            {display}
          </span>
          {status?.api_key_set && (
            <>
              <IconButton
                icon={revealed ? EyeOff : Eye}
                label={revealed ? "Hide" : "Show"}
                onClick={() => setRevealed((v) => !v)}
                size={15}
              />
              <CopyButton value={masked} label="Copy key" />
            </>
          )}
        </div>

        {editing ? (
          <div className="space-y-2 pt-1">
            <input
              type="text"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftKey.trim()) void onSave();
                else if (e.key === "Escape") {
                  setEditing(false);
                  setDraftKey("");
                }
              }}
              placeholder="remo_…"
              className="w-full font-mono text-xs px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] outline-none ring-1 ring-transparent focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void onSave()}
                disabled={saving || !draftKey.trim()}
              >
                {saving ? "Saving…" : "Save & restart"}
              </Button>
              <Button
                onClick={() => {
                  setEditing(false);
                  setDraftKey("");
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="pt-1">
            <Button variant="primary" onClick={() => setEditing(true)}>
              {status?.api_key_set ? "Update API key" : "Set API key"}
            </Button>
          </div>
        )}

        {saveMsg && <div className="text-xs text-emerald-300 pt-1">{saveMsg}</div>}
      </Card>

      <Card>
        <dl>
          <ReadOnlyRow label="Host">
            <span className="font-mono">{status?.hostname ?? "—"}</span>
          </ReadOnlyRow>
          <ReadOnlyRow label="Supervisor ID">
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <span className="font-mono text-xs truncate">
                {status?.supervisor_id ?? "—"}
              </span>
              {status?.supervisor_id && (
                <CopyButton value={status.supervisor_id} label="Copy ID" />
              )}
            </span>
          </ReadOnlyRow>
        </dl>
      </Card>
    </div>
  );
}
