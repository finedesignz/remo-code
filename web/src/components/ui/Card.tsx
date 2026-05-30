import type { ReactNode, HTMLAttributes } from "react";
import { cn } from "../../lib/ui/cn";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  className?: string;
  /** Default true → p-5. Set false to omit padding (e.g. when the card wraps a table that owns its own padding). */
  padded?: boolean;
  /** Default 'secondary'. Use 'primary' for cards sitting on already-secondary surfaces. */
  bg?: "primary" | "secondary";
  /** Default false. When true, omits the default hairline border + shadow (e.g. table wrappers). */
  flat?: boolean;
}

/**
 * Card — translucent surface. Default: modern-subtle with a hairline border +
 * soft shadow-sm for clear standalone separation. Use the `flat` variant
 * (border/shadow omitted) when the card merely wraps a table that owns its
 * own chrome.
 */
export function Card({
  children,
  className,
  padded = true,
  bg = "secondary",
  flat = false,
  ...rest
}: CardProps) {
  const surface =
    bg === "secondary"
      ? "bg-[var(--bg-secondary)]/60"
      : "bg-[var(--bg-primary)]";
  return (
    <div
      {...rest}
      className={cn(
        "rounded-xl",
        surface,
        !flat && "border border-[var(--border-color)]/40 shadow-sm",
        padded && "p-5",
        className
      )}
    >
      {children}
    </div>
  );
}

export default Card;
