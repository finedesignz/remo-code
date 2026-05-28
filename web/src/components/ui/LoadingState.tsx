import type { ReactNode } from "react";
import { cn } from "../../lib/ui/cn";

export interface LoadingStateProps {
  variant?: "spinner" | "skeleton" | "inline";
  label?: ReactNode;
  /** Number of shimmer rows (skeleton only). Default 3. */
  rows?: number;
  className?: string;
}

function SpinnerSvg({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="animate-spin"
      style={{ width: size, height: size }}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        className="opacity-25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        className="opacity-75"
      />
    </svg>
  );
}

/**
 * LoadingState — spinner (centered), skeleton (shimmer rows), or inline (icon + label).
 */
export function LoadingState({
  variant = "spinner",
  label,
  rows = 3,
  className,
}: LoadingStateProps) {
  if (variant === "skeleton") {
    return (
      <div className={cn("flex flex-col gap-2", className)} aria-busy="true">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-4 w-full rounded bg-[var(--bg-tertiary)]/60 animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-2 text-xs text-[var(--text-muted)]",
          className
        )}
        aria-busy="true"
      >
        <SpinnerSvg size={14} />
        {label}
      </span>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-8 text-[var(--text-muted)]",
        className
      )}
      aria-busy="true"
    >
      <SpinnerSvg />
      {label && <div className="mt-2 text-xs">{label}</div>}
    </div>
  );
}

export default LoadingState;
