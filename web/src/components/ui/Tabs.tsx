import type { ReactNode } from "react";
import { cn } from "../../lib/ui/cn";

export interface TabDef {
  key: string;
  label: string;
  content?: ReactNode;
}

export interface TabsProps {
  tabs: TabDef[];
  activeKey: string;
  onChange: (key: string) => void;
  /** Default 'comfortable'. */
  density?: "compact" | "comfortable";
  className?: string;
  /** Render tab content below the strip. If false, caller renders content elsewhere. Default true. */
  renderContent?: boolean;
}

/**
 * Tabs — desktop horizontal strip with bottom border highlight; mobile <select>.
 * URL-syncable: caller drives activeKey from URL and writes back via onChange.
 */
export function Tabs({
  tabs,
  activeKey,
  onChange,
  density = "comfortable",
  className,
  renderContent = true,
}: TabsProps) {
  const active = tabs.find((t) => t.key === activeKey);
  const pad = density === "compact" ? "px-3 py-1.5" : "px-3 py-2";

  return (
    <div className={cn("w-full", className)}>
      {/* Mobile: select dropdown */}
      <div className="md:hidden">
        <select
          className="w-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          value={activeKey}
          onChange={(e) => onChange(e.target.value)}
        >
          {tabs.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop: horizontal strip */}
      <div className="hidden md:flex border-b border-[var(--border-color)]/40 gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const isActive = t.key === activeKey;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onChange(t.key)}
              className={cn(
                pad,
                "text-sm whitespace-nowrap -mb-px border-b-2 transition-colors",
                isActive
                  ? "text-indigo-300 border-indigo-500"
                  : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]"
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {renderContent && active?.content !== undefined && (
        <div className="mt-4">{active.content}</div>
      )}
    </div>
  );
}

export default Tabs;
