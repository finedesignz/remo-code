import type { KeyboardEvent } from "react";
import { cn } from "../../lib/ui/cn";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}

/**
 * Toggle — controlled switch primitive. Track ON = blue, OFF = bg-tertiary;
 * knob uses --text-on-accent (NOT bg-white, so it survives light theme).
 * role="switch" + aria-checked; Space/Enter toggle; disabled dims + blocks.
 */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  id,
  "aria-label": ariaLabel,
}: ToggleProps) {
  const toggle = () => {
    if (disabled) return;
    onChange(!checked);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-label={ariaLabel}
      aria-checked={checked}
      disabled={disabled}
      onClick={toggle}
      onKeyDown={onKeyDown}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-[var(--bg-primary)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-blue-600" : "bg-[var(--bg-tertiary)]"
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 transform rounded-full bg-[var(--text-on-accent)] transition-transform",
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

export default Toggle;
