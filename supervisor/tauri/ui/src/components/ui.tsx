// Shared UI primitives for the supervisor settings window.
//
// Design system (see ~/.claude/design-preferences.md): title-only with
// info-tooltips, density over decoration, click-to-edit inline, icon-only
// buttons with ≥44px hit areas, blue accent, emerald/red/gray status pills.
// Reduced motion respected via `motion-reduce:` utilities.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Copy, Info } from "lucide-react";

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`bg-[var(--bg-secondary)]/60 ring-1 ring-[var(--border-color)]/40 shadow-sm rounded-xl p-5 ${className}`}
    >
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Tooltip + InfoTooltip                                                      */
/* -------------------------------------------------------------------------- */

/** Lightweight styled tooltip — hover/focus reveal, not native `title=`. */
export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 bottom-full z-50 mb-1.5 -translate-x-1/2 whitespace-pre rounded-lg bg-[var(--bg-secondary)] px-2 py-1 text-[11px] font-normal text-[var(--text-secondary)] ring-1 ring-[var(--border-color)]/60 shadow-md max-w-[260px] whitespace-normal text-left"
        >
          {label}
        </span>
      )}
    </span>
  );
}

/** Small (?) icon right of a title; reveals descriptive copy on hover/tap. */
export function InfoTooltip({ label }: { label: string }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-full"
      >
        <Info size={13} />
      </button>
    </Tooltip>
  );
}

/** Card / section heading with an optional info tooltip immediately right. */
export function SectionTitle({
  title,
  info,
  right,
}: {
  title: string;
  info?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        {info && <InfoTooltip label={info} />}
      </div>
      {right}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* StatusPill                                                                  */
/* -------------------------------------------------------------------------- */

type PillTone = "emerald" | "amber" | "red" | "gray";

const TONE: Record<PillTone, string> = {
  emerald: "bg-emerald-500/20 ring-emerald-500/30 text-emerald-300",
  amber: "bg-amber-500/20 ring-amber-500/30 text-amber-300",
  red: "bg-red-500/20 ring-red-500/30 text-red-300",
  gray: "bg-gray-500/20 ring-gray-500/30 text-gray-300",
};

export function StatusPill({
  tone,
  label,
}: {
  tone: PillTone;
  label: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ${TONE[tone]}`}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* IconButton                                                                  */
/* -------------------------------------------------------------------------- */

/** Icon-only action — small glyph, ≥44px hit area via padding, tooltip. */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  tone = "default",
  size = 16,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
  size?: number;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={[
          "inline-flex items-center justify-center w-11 h-11 rounded-lg transition-colors motion-reduce:transition-none",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
          "disabled:opacity-40 disabled:cursor-default",
          tone === "danger"
            ? "text-[var(--text-muted)] hover:text-red-300 hover:bg-red-500/10"
            : "text-[var(--text-muted)] hover:text-blue-300 hover:bg-[var(--bg-tertiary)]/50",
        ].join(" ")}
      >
        <Icon size={size} />
      </button>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* CopyButton                                                                  */
/* -------------------------------------------------------------------------- */

export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [value]);
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? "Copied" : label}
      onClick={onCopy}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* ClickToEditRow                                                              */
/* -------------------------------------------------------------------------- */

/**
 * label + value; click the value to edit in place. Commits on Enter/blur,
 * cancels on Escape. No Save button. `onCommit` returns a rejected promise to
 * surface an error (the caller owns the error banner).
 */
export function ClickToEditRow({
  label,
  value,
  placeholder,
  validate,
  onCommit,
  mono = true,
  info,
}: {
  label: string;
  value: string;
  placeholder?: string;
  validate?: (v: string) => boolean;
  onCommit: (v: string) => Promise<void>;
  mono?: boolean;
  info?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      // focus next tick so the input exists
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [editing, value]);

  const commit = useCallback(async () => {
    const v = draft.trim();
    if (v === value.trim()) {
      setEditing(false);
      return;
    }
    if (validate && !validate(v)) {
      // keep editing; invalid ring shown below
      return;
    }
    setSaving(true);
    try {
      await onCommit(v);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [draft, value, validate, onCommit]);

  const invalid = editing && !!draft.trim() && !!validate && !validate(draft.trim());

  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1.5 items-center">
      <div className="flex items-center gap-1.5">
        <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
          {label}
        </span>
        {info && <InfoTooltip label={info} />}
      </div>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            else if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
          placeholder={placeholder}
          className={[
            "w-full text-xs px-2 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] outline-none ring-1",
            mono ? "font-mono" : "",
            invalid
              ? "ring-red-500/50"
              : "ring-transparent focus:ring-2 focus:ring-blue-500",
          ].join(" ")}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={[
            "text-left text-sm text-[var(--text-secondary)] break-all rounded-md px-2 py-1 -mx-2",
            "hover:bg-[var(--bg-tertiary)]/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
            mono ? "font-mono text-xs" : "",
          ].join(" ")}
          title="Click to edit"
        >
          {value || <span className="text-[var(--text-muted)]">{placeholder ?? "—"}</span>}
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* ReadOnlyRow                                                                 */
/* -------------------------------------------------------------------------- */

export function ReadOnlyRow({
  label,
  children,
  info,
}: {
  label: string;
  children: ReactNode;
  info?: string;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1.5 items-center">
      <div className="flex items-center gap-1.5">
        <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
          {label}
        </span>
        {info && <InfoTooltip label={info} />}
      </div>
      <div className="text-sm text-[var(--text-secondary)] break-all min-w-0">
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* ErrorBanner                                                                 */
/* -------------------------------------------------------------------------- */

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg px-3 py-2 text-sm text-red-300 break-all">
      {message}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Button (primary / ghost)                                                   */
/* -------------------------------------------------------------------------- */

export function Button({
  children,
  onClick,
  disabled,
  variant = "ghost",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost";
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={[
        "px-3 py-2 rounded-lg text-sm transition-colors motion-reduce:transition-none",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
        "disabled:opacity-40 disabled:cursor-default",
        variant === "primary"
          ? "bg-blue-600 hover:bg-blue-500 text-white"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
