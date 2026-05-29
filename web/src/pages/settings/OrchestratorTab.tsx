/**
 * Settings → Orchestrator tab.
 *
 * Restored from the orphaned `web/src/components/OrchestratorTab.tsx` (dropped
 * in the Phase-12 nav restructure) and refactored onto the shared `ui/`
 * primitives. Data logic (GET/PUT /api/orchestrator, POST start/stop) is
 * preserved verbatim — only the markup changed.
 */
import { useEffect, useRef, useState } from "react";
import { hubFetch } from "../../lib/api";
import { Card, Button, Field, StatusPill, Modal, EmptyState } from "../../components/ui";

type OrchestratorSnapshot = {
  enabled: boolean;
  name: string;
  custom_instructions: string | null;
  session_id: string | null;
  status: "disabled" | "enabled_idle" | "running";
};

export function OrchestratorTab({ token }: { token: string }) {
  const [snap, setSnap] = useState<OrchestratorSnapshot | null>(null);
  const [name, setName] = useState("Orchestrator");
  const [instructions, setInstructions] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Separate from `err`: set ONLY when the initial load fails so we can render a
  // Retry empty-state instead of an infinite "Loading…" spinner (WR-05).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showEnableModal, setShowEnableModal] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Unmount guards: bail on setState / clear a dangling savedFlash timer if the
  // user swaps settings tabs mid-request (WR-04).
  const aliveRef = useRef(true);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // refresh() reloads the snapshot. `initial` distinguishes the mount load
  // (drives loading/loadError → Retry state) from action-triggered reloads
  // (whose failures surface as `err` so a successful start/stop isn't masked).
  async function refresh(initial = false) {
    try {
      const r = await hubFetch<OrchestratorSnapshot>(token, "/api/orchestrator");
      if (!aliveRef.current) return;
      setSnap(r);
      setName(r.name);
      setInstructions(r.custom_instructions ?? "");
      setLoadError(null);
    } catch (e: any) {
      if (!aliveRef.current) return;
      const msg = e?.message ?? "load failed";
      if (initial) setLoadError(msg);
      else setErr(msg);
    } finally {
      if (aliveRef.current && initial) setLoading(false);
    }
  }

  useEffect(() => {
    aliveRef.current = true;
    void refresh(true);
    return () => {
      aliveRef.current = false;
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function patch(body: Partial<{ enabled: boolean; name: string; custom_instructions: string | null }>) {
    setBusy(true); setErr(null);
    try {
      const r = await hubFetch<OrchestratorSnapshot>(token, "/api/orchestrator", { method: "PUT", json: body });
      if (!aliveRef.current) return;
      setSnap(r);
      setName(r.name);
      setInstructions(r.custom_instructions ?? "");
      setSavedFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => { if (aliveRef.current) setSavedFlash(false); }, 1200);
    } catch (e: any) {
      if (aliveRef.current) setErr(e?.message ?? "save failed");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function start() {
    setBusy(true); setErr(null);
    try {
      await hubFetch(token, "/api/orchestrator/start", { method: "POST", json: {} });
      await refresh();
    } catch (e: any) {
      if (aliveRef.current) setErr(e?.message ?? "start failed");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function stop() {
    setBusy(true); setErr(null);
    try {
      await hubFetch(token, "/api/orchestrator/stop", { method: "POST", json: {} });
      await refresh();
    } catch (e: any) {
      if (aliveRef.current) setErr(e?.message ?? "stop failed");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 w-full max-w-5xl mx-auto space-y-5">
      {!snap && loadError ? (
        <Card>
          <EmptyState
            title="Couldn't load orchestrator"
            description={loadError}
            action={{ label: "Retry", onClick: () => { setLoadError(null); setLoading(true); void refresh(true); } }}
          />
        </Card>
      ) : !snap || loading ? (
        <div className="text-sm text-[var(--text-muted)]">Loading…</div>
      ) : (
        <Card className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Orchestrator session</h3>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                A pinned Claude session that runs in your repos parent folder and is taught how to read state from
                and coordinate your other Claude sessions via the hub API. When enabled it auto-launches as soon as
                your supervisor connects and stays available (it's the default target for Telegram). Disable it any
                time below — once disabled it won't auto-launch again until you turn it back on.
              </p>
            </div>
            <StatusPill
              status={snap.status === "running" ? "success" : snap.status === "enabled_idle" ? "info" : "idle"}
              size="sm"
              label={snap.status === "running" ? "Running" : snap.status === "enabled_idle" ? "Idle" : "Disabled"}
              className="shrink-0"
            />
          </div>

          <div className="flex items-center gap-3">
            {snap.enabled ? (
              <Button variant="danger" size="md" disabled={busy} onClick={() => void patch({ enabled: false })}>
                Disable orchestrator
              </Button>
            ) : (
              <Button variant="primary" size="md" disabled={busy} onClick={() => setShowEnableModal(true)}>
                Enable orchestrator
              </Button>
            )}
            {snap.enabled && snap.status !== "running" && (
              <Button variant="primary" size="md" disabled={busy} onClick={start}>
                Start orchestrator session
              </Button>
            )}
            {snap.status === "running" && (
              <Button variant="danger" size="md" disabled={busy} onClick={stop}>
                Stop session
              </Button>
            )}
            {savedFlash && <StatusPill status="success" size="sm" label="Saved" />}
          </div>

          {snap.enabled && (
            <div className="space-y-3 pt-2 border-t border-[var(--border-color)]/40">
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => { if (name.trim() && name !== snap.name) void patch({ name: name.trim() }); }}
                  placeholder="Orchestrator"
                  maxLength={64}
                  className="w-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                />
              </Field>
              <Field label="Custom instructions" helper="Appended to the built-in seed prompt.">
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  onBlur={() => { if (instructions !== (snap.custom_instructions ?? "")) void patch({ custom_instructions: instructions || null }); }}
                  rows={10}
                  maxLength={8000}
                  placeholder="e.g. Always summarize the state of all repos before suggesting next actions."
                  className="w-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                />
              </Field>
            </div>
          )}

          {err && <p className="text-xs text-red-400">{err}</p>}
        </Card>
      )}

      <Modal
        open={showEnableModal}
        onClose={() => setShowEnableModal(false)}
        title="Enable orchestrator mode?"
        className="ring-red-500/40"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setShowEnableModal(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={async () => { setShowEnableModal(false); await patch({ enabled: true }); }}
            >
              Enable orchestrator
            </Button>
          </>
        }
      >
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          Orchestrator mode gives one Claude session full access to <strong>every repo</strong> under your supervisor's root folder,
          plus a full-power hub API key that can read messages, start sessions, and dispatch tasks for your account.
          Only enable if you trust the system prompt and your machine is secure.
        </p>
      </Modal>
    </div>
  );
}

export default OrchestratorTab;
