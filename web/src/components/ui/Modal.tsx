import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "../../lib/ui/cn";
import { trapFocus, autoFocusFirst } from "../../lib/ui/focus-trap";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Max width preset. Default 'lg' (~512px). */
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  /** A11Y-HI-2: caller may supply explicit id for aria-labelledby. */
  titleId?: string;
}

const SIZE_MAP: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
};

/**
 * Modal — centered dialog. Backdrop click + Esc closes.
 * Frame: rounded-xl, ring-1 ring-white/5 (NO shadow-2xl, NO rounded-2xl).
 *
 * A11Y-HI-2: focus trap on Tab/Shift+Tab, auto-focus first focusable on open,
 * role="dialog" + aria-modal="true" + aria-labelledby (when title given).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "lg",
  className,
  titleId,
}: ModalProps) {
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

  // A11Y-HI-2: trap Tab focus inside the dialog while open. Returns the
  // cleanup that restores prior focus to whatever element opened the modal.
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const cleanup = trapFocus(dialogRef.current);
    autoFocusFirst(dialogRef.current);
    return cleanup;
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={resolvedTitleId}
    >
      <div
        ref={dialogRef}
        className={cn(
          "w-full bg-[var(--bg-secondary)] rounded-xl ring-1 ring-white/5",
          "flex flex-col max-h-[90vh]",
          SIZE_MAP[size],
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="px-5 py-4 border-b border-[var(--border-color)]/40">
            <h2 id={resolvedTitleId} className="text-sm font-semibold text-[var(--text-primary)]">
              {title}
            </h2>
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
  );
}

export default Modal;
