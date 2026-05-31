// Shared relative-time helpers. "4m ago" for recent, ISO for the tooltip.

export function formatRelativeAgo(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return "never";
  const t = typeof input === "number" ? input : Date.parse(input);
  if (Number.isNaN(t)) return "never";
  const diff = Date.now() - t;
  if (diff < 5_000) return "just now";
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function isoTooltip(input: string | number | null | undefined): string | undefined {
  if (input === null || input === undefined) return undefined;
  const t = typeof input === "number" ? input : Date.parse(input);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}
