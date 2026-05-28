import type { ReactNode } from "react";
import { cn } from "../../lib/ui/cn";

export type StatusKind =
  | "success"
  | "pending"
  | "warning"
  | "error"
  | "idle"
  | "info";

export interface StatusPillProps {
  status: StatusKind;
  label: ReactNode;
  size?: "sm" | "md";
  icon?: ReactNode;
  className?: string;
}

const STATUS: Record<StatusKind, string> = {
  success:
    "bg-emerald-500/20 ring-1 ring-emerald-500/30 text-emerald-300",
  pending:
    "bg-blue-500/20 ring-1 ring-blue-500/30 text-blue-300",
  warning:
    "bg-amber-500/20 ring-1 ring-amber-500/30 text-amber-300",
  error:
    "bg-red-500/20 ring-1 ring-red-500/30 text-red-300",
  idle:
    "bg-gray-500/20 ring-1 ring-gray-500/30 text-gray-300",
  info:
    "bg-indigo-500/20 ring-1 ring-indigo-500/30 text-indigo-300",
};

const SIZE = {
  sm: "px-1.5 py-0.5 text-[10px]",
  md: "px-2 py-0.5 text-xs",
} as const;

/**
 * StatusPill — soft tinted background + ring per design-prefs.
 */
export function StatusPill({
  status,
  label,
  size = "md",
  icon,
  className,
}: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap",
        STATUS[status],
        SIZE[size],
        className
      )}
    >
      {icon}
      {label}
    </span>
  );
}

export default StatusPill;
