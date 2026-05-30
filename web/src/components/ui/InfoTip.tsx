import { useId, useState, type ReactNode } from "react";
import { cn } from "../../lib/ui/cn";

export interface InfoTipProps {
  /** Tooltip body shown on hover/focus/tap. */
  content: ReactNode;
  /** Accessible label for the trigger button. Defaults to "More information". */
  label?: string;
  className?: string;
}

/**
 * Info glyph (14px) with a styled (non-native) tooltip. The trigger keeps a
 * >=44x44px tap target via padding while the glyph stays small, per
 * design-prefs "small icon, big hit area". Accent on hover/focus is blue.
 * Revealed on hover + focus (desktop) and toggled on tap (mobile).
 */
export function InfoTip({ content, label = "More information", className }: InfoTipProps) {
  const tipId = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className={cn("relative inline-flex group", className)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={tipId}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center justify-center min-h-[44px] min-w-[44px] p-2.5 -m-2.5",
          "rounded-full text-[var(--text-muted)] transition-colors",
          "hover:text-blue-400 focus:text-blue-400",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        )}
      >
        <svg
          className="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2",
          "w-max max-w-xs rounded-lg border border-[var(--border-color)]/60",
          "bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] shadow-lg",
          "opacity-0 transition-opacity duration-150",
          "group-hover:opacity-100 group-focus-within:opacity-100",
          open && "opacity-100"
        )}
      >
        {content}
      </span>
    </span>
  );
}

export default InfoTip;
