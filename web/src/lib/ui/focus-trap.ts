/**
 * A11Y-HI-2: minimal focus-trap utilities for Modal + Drawer.
 *
 * `trapFocus(container)` wires a keydown listener that loops Tab / Shift+Tab
 * through focusable descendants of `container`. Returns a cleanup that
 * restores focus to whatever element was active before the trap installed.
 *
 * `autoFocusFirst(container)` synchronously moves focus to the first
 * focusable descendant (or the container itself if none).
 *
 * Intentionally dependency-free — keeps Modal/Drawer primitives lightweight.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusable(container: HTMLElement): HTMLElement[] {
  const els = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return els.filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
}

export function trapFocus(container: HTMLElement): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const handler = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = getFocusable(container);
    if (focusable.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !container.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  document.addEventListener("keydown", handler);
  return () => {
    document.removeEventListener("keydown", handler);
    // Restore focus to opener (best-effort — node may have unmounted).
    try {
      previouslyFocused?.focus?.();
    } catch {
      /* ignore */
    }
  };
}

export function autoFocusFirst(container: HTMLElement): void {
  const focusable = getFocusable(container);
  if (focusable.length > 0) {
    focusable[0].focus();
  } else {
    // Make the container itself focusable as a fallback so screen readers
    // announce the dialog content.
    if (!container.hasAttribute("tabindex")) {
      container.setAttribute("tabindex", "-1");
    }
    container.focus();
  }
}
