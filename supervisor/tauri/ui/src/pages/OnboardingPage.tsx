// Phase 09 — First-run onboarding wizard.
//
// Shown by <App> until the supervisor is fully configured: an API key AND at
// least one root folder. The orchestrator can't launch with zero roots, so the
// wizard REQUIRES ≥1 root before it lets the user finish.
//
// Steps: 1) Connect (hub URL shown, API key entered) → 2) Root folder (add ≥1)
// → done. Uses the existing IPC surface only (set_api_key, add_root,
// get_runtime_status, get_config) — no new Rust commands.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface RuntimeStatus {
  hub_url: string;
  api_key_set: boolean;
}
interface RootsConfig {
  roots: string[];
}

export default function OnboardingPage({ onDone }: { onDone: () => void }) {
  const [hubUrl, setHubUrl] = useState<string>("https://app.remo-code.com");
  const [hubSaving, setHubSaving] = useState(false);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [step, setStep] = useState<1 | 2>(1);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<RuntimeStatus>("get_runtime_status");
      setHubUrl(s.hub_url || "https://app.remo-code.com");
      setApiKeySet(s.api_key_set);
      const c = await invoke<RootsConfig>("get_config");
      setRoots(c.roots || []);
      // If the key is already set, jump straight to the root step.
      if (s.api_key_set) setStep(2);
    } catch (e: any) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Persist the hub URL (on blur). Validation mirrors the Rust `set_hub_url`.
  const saveHubUrl = useCallback(async () => {
    const v = hubUrl.trim();
    if (!isValidHubUrl(v)) return;
    setHubSaving(true); setErr(null);
    try {
      await invoke("set_hub_url", { hubUrl: v });
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setHubSaving(false);
    }
  }, [hubUrl]);

  const saveKey = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      // Make sure the entered hub URL is persisted before the key, so the
      // sidecar restart from set_api_key picks up the right endpoint.
      if (isValidHubUrl(hubUrl.trim())) {
        await invoke("set_hub_url", { hubUrl: hubUrl.trim() });
      }
      await invoke("set_api_key", { apiKey: draftKey.trim() });
      setApiKeySet(true);
      setDraftKey("");
      setStep(2);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [draftKey, hubUrl]);

  const addRoot = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select a root folder to scan for repos" });
      if (!selected || Array.isArray(selected)) return;
      const next = await invoke<RootsConfig>("add_root", { path: selected });
      setRoots(next.roots || []);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const hubUrlValid = isValidHubUrl(hubUrl.trim());
  const canFinish = hubUrlValid && apiKeySet && roots.length > 0;

  return (
    <div className="h-full flex items-center justify-center bg-[var(--bg-primary)] text-[var(--text-primary)] p-6">
      <div className="w-full max-w-md space-y-5">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">Welcome to Remo Code</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Two quick steps to connect this machine and pick the folders Claude can work in.
          </p>
        </header>

        {/* Step indicator */}
        <div className="flex items-center gap-2 text-xs">
          <StepDot n={1} active={step === 1} done={apiKeySet} label="Connect" />
          <span className="h-px flex-1 bg-[var(--border-color)]/40" />
          <StepDot n={2} active={step === 2} done={roots.length > 0} label="Root folder" />
        </div>

        {err && (
          <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg px-3 py-2 text-sm text-red-300 break-all">
            {err}
          </div>
        )}

        {step === 1 ? (
          <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold">Connect to the hub</h2>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Hub URL</label>
              <input
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={hubUrl}
                onChange={(e) => setHubUrl(e.target.value)}
                onBlur={() => { void saveHubUrl(); }}
                placeholder="https://app.remo-code.com"
                className={[
                  "w-full font-mono text-xs px-3 py-2 rounded-lg bg-[var(--bg-tertiary)]/60 text-[var(--text-primary)] outline-none ring-1",
                  hubUrl.trim() && !hubUrlValid ? "ring-red-500/40" : "ring-transparent focus:ring-blue-500/40",
                ].join(" ")}
              />
              {hubUrl.trim() && !hubUrlValid && (
                <p className="text-[11px] text-red-300 pt-1">Enter a full http:// or https:// URL.</p>
              )}
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">
                API key (starts with <span className="font-mono">remo_</span>)
              </label>
              <input
                type="text"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                placeholder="remo_…"
                className="w-full font-mono text-xs px-3 py-2 rounded-lg bg-[var(--bg-tertiary)]/60 text-[var(--text-primary)] outline-none ring-1 ring-transparent focus:ring-blue-500/40"
              />
              <p className="text-[11px] text-[var(--text-muted)] pt-1">
                Create one in the hub at Settings → Credentials, then paste it here.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { void saveKey(); }}
              disabled={busy || hubSaving || !draftKey.trim() || !hubUrlValid}
              className="px-3 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
            >
              {busy ? "Saving…" : "Continue"}
            </button>
          </section>
        ) : (
          <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold">Pick a root folder</h2>
            <p className="text-xs text-[var(--text-muted)]">
              The supervisor scans these folders for git repos. The first root is also where
              the orchestrator session runs — at least one is required.
            </p>
            {roots.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No folders added yet.</p>
            ) : (
              <ul className="space-y-1">
                {roots.map((r) => (
                  <li key={r} className="text-sm font-mono text-[var(--text-secondary)] truncate px-3 py-2 rounded-lg bg-[var(--bg-tertiary)]/30" title={r}>
                    {r}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => { void addRoot(); }}
                disabled={busy}
                className="px-3 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
              >
                {roots.length === 0 ? "Add a folder" : "Add another"}
              </button>
              <button
                type="button"
                onClick={onDone}
                disabled={!canFinish || busy}
                className="px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 disabled:opacity-40"
              >
                Finish setup
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// Mirror of the Rust `set_hub_url` validation: http(s) scheme + non-empty host.
function isValidHubUrl(v: string): boolean {
  const t = v.trim().replace(/\/+$/, "");
  const rest = t.startsWith("https://")
    ? t.slice("https://".length)
    : t.startsWith("http://")
    ? t.slice("http://".length)
    : null;
  if (rest === null) return false;
  const host = rest.split(/[/?#]/)[0];
  return host.length > 0 && !host.includes(" ");
}

function StepDot({ n, active, done, label }: { n: number; active: boolean; done: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={[
          "inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-medium",
          done
            ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30"
            : active
            ? "bg-blue-600/20 text-blue-300 ring-1 ring-blue-500/30"
            : "bg-[var(--bg-tertiary)]/60 text-[var(--text-muted)]",
        ].join(" ")}
      >
        {done ? "✓" : n}
      </span>
      <span className={active || done ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]"}>{label}</span>
    </span>
  );
}
