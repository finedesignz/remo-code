import type { ReactNode, HTMLAttributes } from "react";
import { cn } from "../../lib/ui/cn";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  className?: string;
  /** Default true → p-5. Set false to omit padding (e.g. when the card wraps a table that owns its own padding). */
  padded?: boolean;
  /** Default 'secondary'. Use 'primary' for cards sitting on already-secondary surfaces. */
  bg?: "primary" | "secondary";
}

/**
 * Card — translucent surface, no border, no shadow. Contrast IS separation.
 * Per design-prefs: bg-[var(--bg-secondary)]/60, rounded-xl, no shadow.
 */
export function Card({
  children,
  className,
  padded = true,
  bg = "secondary",
  ...rest
}: CardProps) {
  const surface =
    bg === "secondary"
      ? "bg-[var(--bg-secondary)]/60"
      : "bg-[var(--bg-primary)]";
  return (
    <div
      {...rest}
      className={cn("rounded-xl", surface, padded && "p-5", className)}
    >
      {children}
    </div>
  );
}

export default Card;
