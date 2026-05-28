import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "../../lib/ui/cn";
import { trapFocus, autoFocusFirst } from "../../lib/ui/focus-trap";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: "right";
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Desktop width. Default '480px'. Mobile is always full-screen. */
  width?: string;
  className?: string;
  /** A11Y-HI-2: caller may supply explicit id for aria-labelledby. */
  titleId?: string;
}

/**
 * Drawer — right slide-in panel. Esc + backdrop closes. Full-screen on mobile.
 */
export function Drawer({
  open,
  onClose,
  side = "right",
  title,
  children,
  footer,
  width = "480px",
  className,
  titleId,
}: DrawerProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const generatedId = useId();
  const resolvedTitleId = titleId ?? (title !== undefined ? generatedId : undefined);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // A11Y-HI-2: focus trap + auto-focus first focusable on open.
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const cleanup = trapFocus(dialogRef.current);
    autoFocusFirst(dialogRef.current);
    return cleanup;
  }, [open]);

  if (!open) return null;

  // side only supports 'right' for now; reserved for future expansion.
  void side;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={resolvedTitleId}
    >
      <div
        ref={dialogRef}
        className={cn(
          "absolute top-0 right-0 h-full w-full md:w-auto",
          "bg-[var(--bg-secondary)] ring-1 ring-white/5",
          "flex flex-col",
          className
        )}
        style={{ maxWidth: "100vw", width: undefined }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="h-full flex flex-col md:!w-[var(--drawer-w)]"
          style={{ ["--drawer-w" as string]: width }}
        >
          {title !== undefined && (
            <div className="px-5 py-4 border-b border-[var(--border-color)]/40 flex items-center justify-between">
              <h2 id={resolvedTitleId} className="text-sm font-semibold text-[var(--text-primary)]">
                {title}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg px-2 py-1"
              >
                ×
              </button>
            </div>
          )}
          <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
          {footer !== undefined && (
            <div className="px-5 py-3 border-t border-[var(--border-color)]/40 flex items-center justify-end gap-2">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Drawer;
