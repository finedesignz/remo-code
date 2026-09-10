# Phase 12 — UI Smoke Audit (Code-Only)

**Auditor:** AccessibilityAuditor
**Date:** 2026-05-28
**Branch:** `feat/ui-restructure-and-dry-pass`
**Worktree:** `C:/Users/artic/GitHub/remo-code-ui-restructure`
**Method:** Static read of `web/src/**`. No live browser — production not yet deployed.
**Standard:** WCAG 2.2 AA + project design-tokens (CLAUDE.md "Frontend / CSS Conventions").

---

## Summary

| Severity | Count |
|---|---|
| Blocker | 0 |
| High | 2 |
| Medium | 4 |
| Low | 3 |
| Info | 4 |

**Overall verdict:** PASS WITH FIXES. Restructure is structurally clean — AppShell mounts once per page, URL sync is correct, deep-link redirects all use `replaceState`, design-token compliance is excellent (only one minor surviving `text-white` outside the destructive-button allowance, on a hidden `<select>`), and Wave 5 deletions are complete with zero surviving imports. The two High findings are accessibility gaps in primitive components (`<Tabs>` missing ARIA roles, `<Modal>`/`<Drawer>` missing focus trap + autofocus) that affect ALL Phase 12 pages but are mechanical fixes.

---

## ✅ What's Working Well

- **AppShell renders exactly once** on each of `HomePage` / `TasksPage` / `SettingsPage`. No double-shell, no nested header.
- **URL sync is correct.** `readTabParam`/`writeTabParam` uses `history.replaceState` (no spurious history entries), default tab falls back cleanly when `?tab=` absent, each tab value resolves to the matching module.
- **Deep-link redirects all use `replaceState`** (`web/src/App.tsx:78`) — back-button safe. Coverage matches the spec: `#/schedules`, `#/error-capture`, `#/revanote`, `#/supervisor`, `#/grid`, `#/grid/:tabId` all map correctly.
- **Wave 5 deletions are complete.** `Layout.tsx`, `AppChrome.tsx`, `SettingsPageLegacy.tsx`, `ErrorCapturePage.tsx`, `ErrorSetupModal.tsx`, `ErrorProjectEditor.tsx`, `ErrorDetailDrawer.tsx`, `RevanotePage.tsx` — all gone. No surviving imports anywhere in `web/src/` (only stale doc-comments referencing them by name).
- **Design tokens clean.** Zero `rounded-2xl/3xl`, zero `shadow-2xl/lg/md`, zero hardcoded hex backgrounds, zero `bg-gradient-*`. Only outstanding `rounded-2xl|shadow-2xl` reference is in a comment in `Modal.tsx:24` explaining what NOT to use.
- **`100vh` discipline.** No `100vh` in any Phase 12 page or new primitive (`AppShell` uses `h-[100dvh]`). Login/Privacy/Terms still use `min-h-screen` but those are pre-existing public surfaces, out of phase scope.
- **Loading / empty / error states present** on every fetching tab module (`UpcomingTab`, `ActivityTab`, `ScheduleTab`, `ConnectionsTab`, `UsageTab`, `PromptsTab`, `CredentialsTab`, `ProfileTab`) — all import and use `LoadingState` + `EmptyState` + a `setError` channel.
- **Primitive adoption is consistent.** All eight Phase 12 tab modules import from `../../components/ui` and consume `Card`, `Button`, `Field`, `StatusPill`, `LoadingState`, `EmptyState`, `Drawer` where appropriate.
- **ChatLayout has no header chrome** — Wave 4a fix landed; the header lives only on AppShell, no double-header risk.
- **`outline-none` always paired with `focus:ring-2`** across all new pages — keyboard focus remains visible.

---

## 🚨 Issues Found

### Issue 1: `<Tabs>` primitive has no ARIA role semantics

**WCAG Criterion:** 4.1.2 Name, Role, Value (Level A)
**Severity:** High
**User Impact:** Screen-reader users hear "button, [label]" three to five times in a row with no indication the controls form a tab strip or that one is currently selected. Affects every Phase 12 page (Home, Tasks, Settings) — i.e. the entire restructure.
**Location:** `web/src/components/ui/Tabs.tsx`
**Evidence:** Grep for `role=|aria-` in the file returns zero matches. Each tab is a plain `<button>` with no `role="tab"`, `aria-selected`, or `aria-controls`. The desktop strip has no surrounding `role="tablist"`. The mobile `<select>` is fine (native semantics).
**Current State (desktop branch, `Tabs.tsx:54-73`):**

    <div className="hidden md:flex border-b ... gap-1 overflow-x-auto">
      {tabs.map((t) => {
        const isActive = t.key === activeKey;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={...}
          >
            {t.label}
          </button>
        );
      })}
    </div>

**Recommended Fix:**

    <div role="tablist" className="hidden md:flex ...">
      {tabs.map((t) => {
        const isActive = t.key === activeKey;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`tabpanel-${t.key}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => {
              // Arrow-key navigation per WAI-ARIA Authoring Practices.
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                const i = tabs.findIndex(x => x.key === activeKey);
                const next = e.key === "ArrowRight"
                  ? tabs[(i + 1) % tabs.length]
                  : tabs[(i - 1 + tabs.length) % tabs.length];
                onChange(next.key);
              }
            }}
            className={...}
          >
            {t.label}
          </button>
        );
      })}
    </div>

Callers should wrap their content in `<div role="tabpanel" id={\`tabpanel-${tab}\`} aria-labelledby={...}>` to complete the binding, but adding the role + aria-selected at the primitive level is the immediate unblocker.

**Testing Verification:** With VoiceOver, the active tab should announce "selected, tab, 1 of 3" instead of "button". Arrow keys should cycle between tabs.

---

### Issue 2: `<Modal>` and `<Drawer>` do not trap focus and do not autofocus on open

**WCAG Criterion:** 2.4.3 Focus Order (A), 2.4.11 Focus Not Obscured (AA, 2.2). Spec'd in WAI-ARIA Authoring Practices "Dialog (Modal)" pattern.
**Severity:** High
**User Impact:** When a Modal/Drawer opens, keyboard focus stays on whatever triggered it (behind the dialog). Tabbing leaves the dialog and roams the underlying page — defeats the purpose of `aria-modal="true"`. Affects: ApiKeyModal, ConnectModal, CloneHereModal, CreateGithubRepoModal, ScheduleEditor (uses Modal), ScheduleRunsDrawer (uses Drawer), ActivityTab drawer.
**Location:**
- `web/src/components/ui/Modal.tsx:35-42` — only Escape is wired; no `useRef` + autofocus, no focus trap.
- `web/src/components/ui/Drawer.tsx:29-36` — same.
**Evidence:** Both files implement `aria-modal="true"` + Escape-to-close but neither contains a `tabIndex`/`useRef` autofocus block or a Tab/Shift+Tab cycle handler.
**Current State (Modal.tsx:35-42):**

    useEffect(() => {
      if (!open) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, [open, onClose]);

**Recommended Fix:** Add a focus-trap using `useRef` + `tabIndex={-1}` on the panel root, focus on open, and a Tab cycle. Minimal version (no library):

    const panelRef = useRef<HTMLDivElement>(null);
    const lastActiveRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
      if (!open) return;
      lastActiveRef.current = document.activeElement as HTMLElement | null;
      panelRef.current?.focus();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") return onClose();
        if (e.key !== "Tab") return;
        const root = panelRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      };
      window.addEventListener("keydown", onKey);
      return () => {
        window.removeEventListener("keydown", onKey);
        lastActiveRef.current?.focus(); // restore focus on close
      };
    }, [open, onClose]);

Apply panelRef + tabIndex={-1} on the inner `<div>`. Also add `aria-labelledby` keyed to a stable `id` on the `<h2>` title.

**Testing Verification:** Open a Modal via keyboard. Pressing Tab cycles only inside the dialog. Pressing Escape returns focus to the trigger.

---

### Issue 3: `<Modal>` uses `max-h-[90vh]` not `90dvh`

**WCAG Criterion:** N/A (project convention — CLAUDE.md "Mobile auto-swap: Use `100dvh`/`100svh` — never `100vh`").
**Severity:** Medium
**User Impact:** iOS Safari with the keyboard open collapses `vh`; on mobile, modal content gets clipped by the URL bar / keyboard.
**Location:** `web/src/components/ui/Modal.tsx:56`
**Evidence:**

    className={cn(
      "w-full bg-[var(--bg-secondary)] rounded-xl ring-1 ring-white/5",
      "flex flex-col max-h-[90vh]",  // ← vh, not dvh
      SIZE_MAP[size],
      className
    )}

**Recommended Fix:** Replace with `max-h-[90dvh]` (or `90svh` for the smaller "stable" viewport in iOS Safari). Tailwind 4 supports both arbitrary values natively.

---

### Issue 4: `<Drawer>` hardcodes `maxWidth: "100vw"` in inline style

**WCAG Criterion:** N/A (project convention).
**Severity:** Medium
**User Impact:** Same as Issue 3 — iOS Safari keyboard collapses vw/vh; a 100vw drawer can overflow the visual viewport slightly on iOS.
**Location:** `web/src/components/ui/Drawer.tsx:57`
**Evidence:** `style={{ maxWidth: "100vw", width: undefined }}`
**Recommended Fix:** Either drop the inline style entirely (the Tailwind `w-full md:w-auto` already handles this), or use `100dvw`. Inline `vh/vw` units bypass the project-wide convention.

---

### Issue 5: `<Modal>` missing `aria-labelledby` even though it renders a title

**WCAG Criterion:** 4.1.2 Name, Role, Value (Level A); WAI-ARIA Dialog pattern.
**Severity:** Medium
**User Impact:** Screen readers announce "dialog" with no accessible name when the user enters the modal. The `<h2>` title is visible but never linked.
**Location:** `web/src/components/ui/Modal.tsx:46-67`
**Evidence:** Outer `<div>` has `role="dialog" aria-modal="true"` but no `aria-labelledby`. The `<h2>` inside has no `id` to point at.
**Recommended Fix:**

    const titleId = useId(); // from "react"
    ...
    <div role="dialog" aria-modal="true" aria-labelledby={title !== undefined ? titleId : undefined}>
      ...
      <h2 id={titleId} className="...">
        {title}
      </h2>

Same fix applies to `Drawer.tsx`.

---

### Issue 6: `AppShell` mobile nav has no compact treatment

**WCAG Criterion:** 1.4.10 Reflow (AA) — content must not require horizontal scrolling at 320px.
**Severity:** Medium
**User Impact:** At ≤375px the header packs brand + 3 nav pills + theme toggle + quota + profile menu all on one row. Likely wraps awkwardly or pushes the right cluster off-screen. There is no `md:hidden` hamburger fallback.
**Location:** `web/src/components/ui/AppShell.tsx:46-67`
**Evidence:**

    <header className="flex items-center gap-4 px-4 md:px-6 h-14 ...">
      {brand && <div className="flex items-center gap-2">{brand}</div>}
      {nav && nav.length > 0 && (
        <nav className="flex items-center gap-1">{nav.map(...)}</nav>
      )}
      <div className="ml-auto flex items-center gap-2">{headerRight}</div>
    </header>

No `md:` breakpoint switch, no hamburger, no overflow scroll on the nav itself. The Tabs primitive correctly switches to `<select>` at `md:`, but AppShell does NOT.

**Recommended Fix:** Either (a) collapse `nav` to a `<select>`-style dropdown below `md`, (b) hide `nav` labels and show icons only below `md`, or (c) add a hamburger that slides the nav into a drawer. Option (a) is the cheapest and matches the Tabs pattern. CLAUDE.md mobile-parity rule: "AppShell mobile nav (hamburger or top bar) covers all 3 root routes" — currently a top-bar but unverified at 320px.

**Testing Verification:** Browser at 320px width — header content should not horizontally scroll, no clipped buttons.

---

### Issue 7: StatusPill light-theme contrast is suspect on 300-tint text over `/20` backgrounds

**WCAG Criterion:** 1.4.3 Contrast (Minimum) (Level AA)
**Severity:** Low (potential — needs measurement with the actual `--bg-primary` light value)
**User Impact:** StatusPill renders `text-emerald-300` on `bg-emerald-500/20` etc. In dark mode (`--bg-primary` ≈ near-black), 20% green tint composites to a usable mid-green and 300-tint text reads cleanly (~4.5:1+). In light mode (`--bg-primary` near-white), the same `/20` tint becomes a faint pastel and `text-emerald-300` likely drops below 4.5:1. Same risk for blue, amber, red, gray, indigo variants.
**Location:** `web/src/components/ui/StatusPill.tsx:20-33`
**Evidence:** All six variants use the same `bg-X-500/20 ring-1 ring-X-500/30 text-X-300` formula. The formula was designed for dark theme; light theme was not measured.
**Recommended Fix:** Either (a) gate the variants on theme (`text-emerald-700` in light, `text-emerald-300` in dark via CSS custom property), or (b) deepen the text shade to `-600`/`-700` for the light theme. Run a contrast check on the deployed light-theme palette before shipping.

**Testing Verification:** Sample each pill in light mode against your `--bg-primary` value with the WebAIM contrast checker. AA requires 4.5:1 for normal text, 3:1 for large.

---

### Issue 8: Lingering `text-white` on the mobile `<select>` in `Tabs.tsx` is allowed but worth confirming

**WCAG Criterion:** N/A (project convention).
**Severity:** Low (Info-leaning)
**User Impact:** None — `text-white` on Tabs `<select>` is fine because the dropdown uses `var(--bg-tertiary)` which is dark in both themes. But it's still a literal color, not a token.
**Location:** Actually — re-grep shows `Tabs.tsx:41` uses `text-[var(--text-primary)]`, not `text-white`. The five surviving `text-white` occurrences are all on red destructive-button backgrounds (`Button.tsx`, `ChatSurface.tsx`, `SchedulesPage.tsx`, `Sidebar.tsx`, `PendingLocalRepoPrompt.tsx`, `LaunchButton.tsx`) which IS the documented allowance.
**Recommended Fix:** None — the destructive-button allowance applies. Listed here only to record that the grep was done and the count is clean.

---

### Issue 9: Phase 12 pages do not pass a `footer` prop to AppShell

**WCAG Criterion:** N/A.
**Severity:** Low
**User Impact:** AppShell supports a desktop footer slot (`AppShell.tsx:71-75`), but `HomePage`, `TasksPage`, `SettingsPage` all omit it. Existing app had a `<Footer>` component (`web/src/components/Footer.tsx` still on disk). Unclear whether this is intentional (Wave 5 deliberately dropped the footer) or an oversight.
**Location:** `HomePage.tsx`, `TasksPage.tsx`, `SettingsPage.tsx` — none pass `footer={...}`.
**Evidence:**

    return (
      <AppShell brand={brand} nav={nav} headerRight={<HeaderRight ... />}>
        ...
      </AppShell>
    );

No `footer` prop on any of the three pages.

**Recommended Fix:** Confirm intent. If footer was intentionally dropped, delete `web/src/components/Footer.tsx`. If oversight, pass `footer={<Footer />}` on all three pages for consistency.

---

### Issue 10: Code comments still reference deleted `Layout.tsx` / `SettingsPageLegacy`

**WCAG Criterion:** N/A.
**Severity:** Info
**User Impact:** None at runtime. Future maintainers will be confused.
**Location:**
- `web/src/components/ChatLayout.tsx:4,10,103`
- `web/src/components/ChatPanel.tsx:23`
- `web/src/components/ChatSurface.tsx:45`
- `web/src/hooks/useChatSurface.ts:12`
- `web/src/pages/HomePage.tsx:4,6` ("Wraps the existing chat experience (Layout) and grid experience...")
- `web/src/pages/SettingsPage.tsx:4-10` ("Wave 3 mounted this shell with `<SettingsPageLegacy initialTab=...>` as a placeholder...")
**Evidence:** Grep `Layout|SettingsPageLegacy` finds 9 hits across docstrings and historical comments referencing the now-deleted files.
**Recommended Fix:** Sweep the comments in a follow-up commit. Not a blocker — these are descriptive history, not active code paths.

---

### Issue 11: `Sidebar.tsx` + `ChatPanel.tsx` survive but are only reached via `ChatLayout`

**Severity:** Info
**Location:** `web/src/components/Sidebar.tsx`, `ChatPanel.tsx`, `SchedulesPage.tsx`, `SupervisorPage.tsx`
**Notes:** These four legacy components were not on the Wave 5 deletion list and they ARE still imported (Sidebar/ChatPanel by ChatLayout; SchedulesPage by UpcomingTab for `describeTarget`/`formatTsInTz` helpers; SupervisorPage by ConnectionsTab). Recording here so the next phase knows which legacy surfaces are intentional dependencies, not orphan code.

---

### Issue 12: ChatLayout `useWebSocket(token)` runs alongside the AppShell's `useWebSocket(token)` inside HomePage

**Severity:** Info / potential perf
**Location:** `HomePage.tsx:38` + `ChatLayout.tsx:49`
**Notes:** When list-view is active, HomePage and ChatLayout both call `useWebSocket(token)`. If the hook memoizes the underlying WS connection per token, this is fine (likely the case — `useWebSocket` is reused from the existing app). If it opens two sockets, that doubles agent load. Not visible from a code read alone; flag for runtime QC. Same pattern in TasksPage / SettingsPage but only one consumer there (the shell), so safe.

---

### Issue 13: No keyboard test plan for nav → tabs → content order

**Severity:** Info
**Notes:** Code review cannot verify tab order — the order depends on render flow + any `tabIndex` overrides. The Phase 12 surfaces have no explicit `tabIndex` overrides outside form fields, so DOM order should match visual order (brand → nav → header-right → tabs → content). Worth a 5-minute manual keyboard pass once production deploys.

---

## 🎯 Remediation Priority

### Immediate (High — fix before merging to main)
1. **Issue 1** — Add `role="tab"`, `aria-selected`, `role="tablist"` to `Tabs.tsx`. ~15 LOC.
2. **Issue 2** — Add focus trap + autofocus + `aria-labelledby` to `Modal.tsx` and `Drawer.tsx`. ~50 LOC across both.

### Short-term (Medium — same sprint)
3. **Issue 3** — `Modal.tsx` swap `90vh` → `90dvh`. 1-line.
4. **Issue 4** — `Drawer.tsx` drop or replace inline `100vw`. 1-line.
5. **Issue 5** — Add `aria-labelledby` + `useId()` to Modal and Drawer titles. Covered together with #2.
6. **Issue 6** — `AppShell` mobile nav fallback. Either `<select>` collapse or hide labels < md. ~20 LOC.

### Backlog (Low / Info)
7. **Issue 7** — Light-theme StatusPill contrast measurement + remediation if any variant fails 4.5:1.
8. **Issue 9** — Confirm footer-drop intent; delete `Footer.tsx` or wire it back.
9. **Issue 10** — Comment sweep (cosmetic).
10. **Issue 12** — Verify `useWebSocket` does not double-open at runtime once deployed.
11. **Issue 13** — 5-minute manual keyboard pass post-deploy.

---

## 📈 Recommended Next Steps

1. Land Issue 1 + Issue 2 as a single follow-up commit on this branch — they're isolated to two primitive files and unblock every Phase 12 page at once.
2. Schedule a 30-minute screen-reader pass with NVDA/VoiceOver on the deployed staging build to confirm the ARIA fixes work in practice (axe-core won't catch the focus-trap regression on its own).
3. Run an axe-core scan against the deployed `/`, `/#/tasks`, `/#/settings` URLs once Coolify deploys — pair with this static audit.
4. Add a Storybook story (or Ladle entry) for each primitive — Modal, Drawer, Tabs — to make these a11y regressions catchable in CI before they reach pages.

---

**Audit complete.** Recommend merge AFTER Issues 1, 2 land. Issues 3–6 can ship in a follow-up patch within the same sprint. Other findings are info / backlog.
