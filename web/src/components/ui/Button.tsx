import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/ui/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-blue-600 hover:bg-blue-500 text-[var(--text-on-accent)] disabled:opacity-50",
  secondary:
    "bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)]/70 text-[var(--text-primary)] disabled:opacity-50",
  ghost:
    "bg-transparent hover:bg-[var(--bg-tertiary)]/40 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50",
  danger:
    "bg-red-600/90 hover:bg-red-500 text-white disabled:opacity-50",
};

const SIZE: Record<ButtonSize, string> = {
  // Compact on desktop, but min-h keeps a >=44px mobile tap target.
  sm: "min-h-[44px] sm:min-h-0 px-3 py-1.5 text-sm",
  // >=44px rendered height (py-2.5 + line-height).
  md: "min-h-[44px] px-4 py-2.5 text-sm",
};

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
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
 * Button — variants + sizes from design-prefs. Loading state disables and swaps icon → spinner.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    icon,
    loading = false,
    disabled,
    children,
    className,
    type,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-[var(--bg-primary)]",
        "disabled:cursor-not-allowed",
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export default Button;
