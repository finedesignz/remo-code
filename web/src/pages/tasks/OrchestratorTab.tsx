/**
 * OrchestratorTab — Phase 31 single editor for the one-per-session auto-dev
 * orchestrator task (SPEC §5). Configures (does NOT run) the orchestrator:
 *
 *   - One orchestrator task per session (create if none; otherwise edit).
 *   - Lifecycle-stage selector (development / beta / production-maintenance) +
 *     "Apply preset" → fills default row frequencies (overridable).
 *   - Expandable read-only "standard prompt" panel explaining the structure.
 *   - A table: one command per row — command · FrequencyControl (Never/Once/Custom,
 *     reusing ScheduleRuleRow) · enabled toggle · up/down reorder · delete.
 *     "+ Add command" (known set) and "+ Add micro-prompt" (free text).
 *
 * Blue accent only (CI-guarded by the web accent-guard test).
 */
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Toggle } from "../../components/ui/Toggle";
import {
  FrequencyControl,
  type FrequencyValue,
} from "../../components/orchestrator/FrequencyControl";
import {
  useOrchestrator,
  type LifecycleStage,
  type MacroTaskType,
  type OrchestratorRow,
} from "../../hooks/useOrchestrator";
import { useSessions } from "../../hooks/useSessions";

const STAGES: LifecycleStage[] = ["development", "beta", "production-maintenance"];

// Milestone TMAC: the macro task_type picker. dev is the fully-specified routine;
// the others are documented stubs (labeled "(stub)") until brainstormed (SPEC §6).
const TASK_TYPES: { value: MacroTaskType; label: string }[] = [
  { value: "dev", label: "Dev" },
  { value: "maintenance", label: "Maintenance (stub)" },
  { value: "security", label: "Security (stub)" },
  { value: "brainstorming", label: "Brainstorming (stub)" },
];

// SPEC §3 user-configurable command set (mirrors hub/src/orchestrator/command-set.ts).
const KNOWN_COMMANDS = [
  "gsd-plan-phase",
  "gsd-execute-phase",
  "gsd-audit-fix",
  "gap-scan",
  "gsd-code-review",
  "gsd-verify-work",
  "gsd-complete-milestone",
  "gsd-ship",
  "merge-to-main",
];

// Human-readable summary of how the orchestrator works (gist of SPEC §4
// controller prompt) — explanatory UI text, read-only.
const STANDARD_PROMPT = `When the orchestrator fires for this repo, it first runs an implicit status-check: it reads the run log plus current project state (open roadmap phases, last commits, open PRs, deploy status). It then computes which command rows below are DUE this tick and plans a dependency-aware wave — independent commands run as parallel subagents; dependent ones are sequenced (plan → execute → ship). For each command it runs the matching gsd skill; every unit of work finishes, opens a PR, and dispatches a reviewer to verify it. Nothing is merged to main here (that is the off-hours merge-to-main command). Ship / complete-milestone / tag are PROPOSED to chat. It always ends with a deploy + log-verify tail: redeploy, probe real routes, scan logs, and on failure dispatch a fix agent and re-verify up to 3× before surfacing. The daily cost cap and chain-depth limit are non-bypassable.`;

interface Props {
  token: string;
}

export function OrchestratorTab({ token }: Props) {
  const { sessions } = useSessions(token);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Default to the first session once loaded.
  const effectiveSessionId = sessionId ?? sessions[0]?.id ?? null;

  const orch = useOrchestrator(token, effectiveSessionId);
  const [promptOpen, setPromptOpen] = useState(false);
  const [overwritePreset, setOverwritePreset] = useState(false);

  const sortedRows = useMemo(
    () => [...orch.rows].sort((a, b) => a.sort_order - b.sort_order),
    [orch.rows],
  );

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...sortedRows];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    void orch.reorder(next.map((r) => r.id));
  };

  const addCommand = () => {
    const cmd = window.prompt(
      `Add command. Choose one of:\n${KNOWN_COMMANDS.join(", ")}`,
      KNOWN_COMMANDS[0],
    );
    if (!cmd) return;
    if (!KNOWN_COMMANDS.includes(cmd)) {
      window.alert("Not a known command.");
      return;
    }
    void orch.addRow({ command: cmd, frequency_label: "Never", schedule_rule: null });
  };

  const addMicroPrompt = () => {
    const body = window.prompt("Micro-prompt (free text injected as the turn):");
    if (!body) return;
    void orch.addRow({ micro_prompt: body, frequency_label: "Never", schedule_rule: null });
  };

  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No sessions yet"
        description="Create a session first — the orchestrator is configured per session."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Session + create / stage */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-[var(--text-muted)]">Session</label>
          <select
            value={effectiveSessionId ?? ""}
            onChange={(e) => setSessionId(e.target.value)}
            className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.project_dir || s.id}
              </option>
            ))}
          </select>
        </div>

        {orch.error && <p className="text-xs text-red-300">{orch.error}</p>}

        {!orch.task ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-[var(--text-secondary)]">
              This session has no orchestrator task yet.
            </p>
            <Button onClick={() => void orch.create()} disabled={!effectiveSessionId}>
              Enable orchestrator
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-[var(--text-muted)]">Task type</label>
            <select
              value={orch.task.macro_task_type ?? "dev"}
              onChange={(e) => void orch.setMacroType(e.target.value as MacroTaskType)}
              className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {TASK_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <label className="text-xs text-[var(--text-muted)]">Lifecycle stage</label>
            <select
              value={orch.task.lifecycle_stage}
              onChange={(e) => void orch.setStage(e.target.value as LifecycleStage)}
              className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={overwritePreset}
                onChange={(e) => setOverwritePreset(e.target.checked)}
                className="accent-blue-500"
              />
              overwrite existing rows
            </label>
            <Button
              variant="secondary"
              onClick={() =>
                void orch.applyPreset(orch.task!.lifecycle_stage, overwritePreset)
              }
            >
              Apply preset
            </Button>
          </div>
        )}
      </Card>

      {orch.task && (
        <>
          {/* Standard prompt (expandable, read-only) */}
          <Card className="p-4">
            <button
              type="button"
              onClick={() => setPromptOpen((v) => !v)}
              className="text-sm text-blue-300 hover:text-blue-200"
            >
              {promptOpen ? "▾" : "▸"} How the orchestrator works (standard prompt)
            </button>
            {promptOpen && (
              <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">
                {STANDARD_PROMPT}
              </p>
            )}
          </Card>

          {/* Rows table */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-[var(--text-primary)]">
                Command rows
              </h3>
              <div className="ml-auto flex gap-2">
                <Button variant="secondary" onClick={addCommand}>
                  + Add command
                </Button>
                <Button variant="secondary" onClick={addMicroPrompt}>
                  + Add micro-prompt
                </Button>
              </div>
            </div>

            {sortedRows.length === 0 ? (
              <EmptyState
                title="No rows"
                description="Apply a lifecycle-stage preset, or add commands / micro-prompts."
              />
            ) : (
              <div className="space-y-2">
                {sortedRows.map((row, idx) => (
                  <RowEditor
                    key={row.id}
                    row={row}
                    isFirst={idx === 0}
                    isLast={idx === sortedRows.length - 1}
                    onMoveUp={() => move(idx, -1)}
                    onMoveDown={() => move(idx, 1)}
                    onToggle={(enabled) => void orch.updateRow(row.id, { enabled })}
                    onFrequency={(f) => void orch.updateRow(row.id, f)}
                    onDelete={() => void orch.deleteRow(row.id)}
                  />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

interface RowProps {
  row: OrchestratorRow;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggle: (enabled: boolean) => void;
  onFrequency: (value: FrequencyValue) => void;
  onDelete: () => void;
}

function RowEditor({
  row,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onToggle,
  onFrequency,
  onDelete,
}: RowProps) {
  const isMicro = !!row.micro_prompt;
  return (
    <div className="bg-[var(--bg-primary)]/40 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-mono text-[var(--text-primary)]">
          {isMicro ? "micro-prompt" : row.command}
        </span>
        {isMicro && (
          <span className="text-xs text-[var(--text-muted)] truncate max-w-xs">
            {row.micro_prompt}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Toggle
            checked={row.enabled}
            onChange={onToggle}
            aria-label="Enabled"
          />
          <button
            type="button"
            disabled={isFirst}
            onClick={onMoveUp}
            className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-blue-300 disabled:opacity-30"
            aria-label="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={isLast}
            onClick={onMoveDown}
            className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-blue-300 disabled:opacity-30"
            aria-label="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-red-300 hover:bg-red-500/10 rounded-lg"
            aria-label="Delete row"
          >
            Delete
          </button>
        </div>
      </div>
      <FrequencyControl
        value={{ frequency_label: row.frequency_label, schedule_rule: row.schedule_rule }}
        onChange={onFrequency}
      />
    </div>
  );
}

export default OrchestratorTab;
