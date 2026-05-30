import { useId, type ReactNode } from "react";
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
  // A11Y-HI-1: stable id prefix so each tab button/panel pair can be linked
  // via aria-controls / aria-labelledby.
  const idBase = useId();
  const tabId = (key: string) => `${idBase}-tab-${key}`;
  const panelId = (key: string) => `${idBase}-panel-${key}`;

  return (
    <div className={cn("w-full", className)}>
      {/* Mobile: select dropdown (already accessible) */}
      <div className="md:hidden">
        <select
          className="w-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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

      {/* Desktop: horizontal strip with ARIA tab semantics. */}
      <div
        role="tablist"
        className="hidden md:flex border-b border-[var(--border-color)]/40 gap-1 overflow-x-auto"
      >
        {tabs.map((t) => {
          const isActive = t.key === activeKey;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={tabId(t.key)}
              aria-selected={isActive}
              aria-controls={panelId(t.key)}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange(t.key)}
              className={cn(
                pad,
                "text-sm whitespace-nowrap -mb-px border-b-2 transition-colors",
                isActive
                  ? "text-blue-300 border-blue-500"
                  : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]"
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {renderContent && active?.content !== undefined && (
        <div
          role="tabpanel"
          id={panelId(active.key)}
          aria-labelledby={tabId(active.key)}
          className="mt-4"
        >
          {active.content}
        </div>
      )}
    </div>
  );
}

export default Tabs;
