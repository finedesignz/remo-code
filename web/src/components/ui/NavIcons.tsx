/**
 * NavIcons — the shared inline-SVG glyph set for the primary navigation.
 *
 * Both surfaces render the SAME icons so mobile and desktop stay in lockstep:
 * `MobileTopBar` (large 22px icon buttons) and `AppShell`'s desktop `<nav>`
 * (16px icon left of the text label). Inline SVG matches the codebase
 * convention — no icon dependency.
 *
 * All icons are stroke-based on a 24×24 grid and inherit `currentColor`, so
 * active-state colouring is owned entirely by the caller's classes.
 */

interface IconProps {
  /** Rendered box in px (square). Defaults to the mobile 22px size. */
  size?: number;
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

/** Home — a house. */
export function HomeIcon({ size = 22 }: IconProps = {}) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3.5 10.5 12 3.5l8.5 7" />
      <path d="M5.5 9.8V20h13V9.8" />
      <path d="M10 20v-5h4v5" />
    </svg>
  );
}

/**
 * Sessions / List — an "integrations" glyph: two connected blocks (a node
 * graph), not a bulleted list. Reads clearly at 22px / stroke 1.8.
 */
export function ListIcon({ size = 22 }: IconProps = {}) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="3.5" width="7" height="6" rx="1.5" />
      <rect x="14" y="14.5" width="7" height="6" rx="1.5" />
      <path d="M6.5 9.5v5a3 3 0 0 0 3 3h4.5" />
      <path d="M17.5 14.5v-3a3 3 0 0 0-3-3h-1" />
    </svg>
  );
}

/** Grid — four tiles. */
export function GridIcon({ size = 22 }: IconProps = {}) {
  return (
    <svg {...svgProps(size)}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
    </svg>
  );
}

/** Tasks — a SINGLE checked checkbox (rounded square + checkmark). */
export function TasksIcon({ size = 22 }: IconProps = {}) {
  return (
    <svg {...svgProps(size)}>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M8.5 12.2l2.5 2.5 4.5-5" />
    </svg>
  );
}

/** Settings — gear. */
export function SettingsIcon({ size = 22 }: IconProps = {}) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  );
}
