/**
 * Tiny class-name joiner. Filters falsy. No clsx dep needed for this scope.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
