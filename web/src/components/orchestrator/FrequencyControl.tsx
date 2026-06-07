/**
 * FrequencyControl — Phase 31 per-row frequency picker for the orchestrator
 * editor. Adds the **Never** and **Once** modes (SPEC §5) ON TOP of the existing
 * `ScheduleRuleRow` cadence editor — it does NOT fork ScheduleRulesBuilder.
 *
 *   - Never  → frequency_label='Never', schedule_rule=null (row parked/disabled).
 *   - Once   → frequency_label='Once',  schedule_rule=null (run once, then auto-disable).
 *   - Custom → frequency_label=humanizeRule(rule), schedule_rule=rule
 *              (full cron + day/time + active_window + bounds via ScheduleRuleRow).
 *
 * Blue accent only (inherits ScheduleRuleRow's blue focus rings / accent-blue).
 */
import {
  type ScheduleRule,
  defaultRule,
  humanizeRule,
} from "../../lib/schedule-rules";
import { ScheduleRuleRow } from "../ScheduleRulesBuilder";

export type FrequencyMode = "Never" | "Once" | "Custom";

export interface FrequencyValue {
  frequency_label: string | null;
  schedule_rule: ScheduleRule | null;
}

interface Props {
  value: FrequencyValue;
  onChange: (next: FrequencyValue) => void;
}

/** Derive the current mode from the stored frequency_label / schedule_rule. */
export function modeOf(value: FrequencyValue): FrequencyMode {
  if (value.frequency_label === "Never") return "Never";
  if (value.frequency_label === "Once") return "Once";
  return "Custom";
}

const MODE_OPTIONS: FrequencyMode[] = ["Never", "Once", "Custom"];

export function FrequencyControl({ value, onChange }: Props) {
  const mode = modeOf(value);

  const setMode = (next: FrequencyMode) => {
    if (next === "Never") {
      onChange({ frequency_label: "Never", schedule_rule: null });
    } else if (next === "Once") {
      onChange({ frequency_label: "Once", schedule_rule: null });
    } else {
      const rule = value.schedule_rule ?? defaultRule();
      onChange({ frequency_label: humanizeRule(rule), schedule_rule: rule });
    }
  };

  const setRule = (patch: Partial<ScheduleRule>) => {
    const rule = { ...(value.schedule_rule ?? defaultRule()), ...patch } as ScheduleRule;
    onChange({ frequency_label: humanizeRule(rule), schedule_rule: rule });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--text-muted)]">Frequency</label>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as FrequencyMode)}
          className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {MODE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {mode === "Never" && (
          <span className="text-[11px] text-[var(--text-muted)]">parked — never fires</span>
        )}
        {mode === "Once" && (
          <span className="text-[11px] text-[var(--text-muted)]">runs once, then auto-disables</span>
        )}
      </div>

      {mode === "Custom" && (
        <ScheduleRuleRow
          rule={value.schedule_rule ?? defaultRule()}
          canRemove={false}
          onChange={setRule}
          onRemove={() => {}}
        />
      )}
    </div>
  );
}
