import { useId, useState, type ReactNode } from "react";
import { cn } from "../../lib/ui/cn";

export interface TooltipProps {
  /** Tooltip text shown on hover/focus/tap. */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * Generic styled tooltip wrapper for icon-only controls (per design-prefs:
 * "tooltips must be a styled tooltip component, not bare native title=").
 * Revealed on hover + focus (desktop) and toggled on tap (mobile). The
 * wrapped control still needs its own `aria-label` — this only supplies the
 * visible/role=tooltip affordance.
 */
export function Tooltip({ label, children, className }: TooltipProps) {
  const tipId = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={cn("relative inline-flex group", className)}
      onClick={() => setOpen((v) => !v)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <span
        id={tipId}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap",
          "rounded-lg border border-[var(--border-color)]/60 bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--text-secondary)] shadow-lg",
          "opacity-0 transition-opacity duration-150",
          "group-hover:opacity-100 group-focus-within:opacity-100",
          open && "opacity-100"
        )}
      >
        {label}
      </span>
    </span>
  );
}

export default Tooltip;
