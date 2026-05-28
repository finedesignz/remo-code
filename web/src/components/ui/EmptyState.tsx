import type { ReactNode } from "react";
import { cn } from "../../lib/ui/cn";
import { Button } from "./Button";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  className?: string;
}

/**
 * EmptyState — centered, muted, one short sentence + optional CTA.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-10 px-4",
        className
      )}
    >
      {icon && (
        <div className="text-[var(--text-muted)] mb-3" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="text-sm font-semibold text-[var(--text-primary)]">
        {title}
      </div>
      {description && (
        <div className="text-xs text-[var(--text-muted)] mt-1 max-w-md">
          {description}
        </div>
      )}
      {action && (
        <Button
          variant="primary"
          size="sm"
          className="mt-4"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}

export default EmptyState;
