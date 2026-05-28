import { useEffect, type ReactNode } from "react";
import { cn } from "../../lib/ui/cn";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Max width preset. Default 'lg' (~512px). */
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
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
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "lg",
  className,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
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
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
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
