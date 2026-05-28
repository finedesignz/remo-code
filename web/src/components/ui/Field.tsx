import { useId, type ReactNode, type ReactElement, cloneElement, isValidElement } from "react";
import { cn } from "../../lib/ui/cn";

export interface FieldProps {
  label: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Field — wraps label + input + helper + error in consistent typography.
 * If `children` is a single React element without an id, we inject one and wire `htmlFor`.
 */
export function Field({ label, helper, error, children, className }: FieldProps) {
  const generatedId = useId();
  let control = children;
  let controlId: string | undefined;

  if (isValidElement(children)) {
    const el = children as ReactElement<{ id?: string }>;
    controlId = el.props.id ?? generatedId;
    if (!el.props.id) {
      control = cloneElement(el, { id: controlId });
    }
  }

  return (
    <div className={cn("w-full", className)}>
      <label
        htmlFor={controlId}
        className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5"
      >
        {label}
      </label>
      {control}
      {error ? (
        <p className="text-xs text-red-400 mt-1">{error}</p>
      ) : helper ? (
        <p className="text-xs text-[var(--text-muted)] mt-1">{helper}</p>
      ) : null}
    </div>
  );
}

export default Field;
