---
plan_id: 03-PLAN-005-mobile-accordion
wave: 3
depends_on: [03-PLAN-003-chat-surface-refactor]
files_modified:
  - web/src/components/MobileAccordion.tsx
  - web/src/components/MobileAccordionRow.tsx
  - web/src/components/GridPage.tsx
autonomous: true
requirements: [R06, R07, R11]
---

# Plan 03-005 — Mobile accordion view (below `md` breakpoint)

<tasks>

<task id="T1">
<action>Create `web/src/components/MobileAccordion.tsx`. Props: `{ tab: TabWithSessions; token: string }`. Renders a vertical list of `<MobileAccordionRow>` (one per session in the tab, in `position` order). State: `expandedSessionId: string | null` — only ONE row may be expanded at a time. Tap on a row toggles: if collapsed, expand and collapse any other; if already expanded, collapse. CRITICAL: when collapsing, the `<ChatSurface>` inside the row MUST be UNMOUNTED (conditionally rendered, not just CSS-hidden) — render cost on a phone is the driver, and only one ChatSurface mounts at a time on mobile. On expand, ChatSurface mounts fresh, subscribes via the multi-subscribe path (with itself as the only id in the set for this connection's mobile-accordion scope), and fetches its initial 30 messages.</action>
<read_first>
- web/src/components/Sidebar.tsx (compact row visual baseline)
- web/src/components/ChatSurface.tsx (after PLAN-003)
- web/src/components/SettingsPage.tsx (visual baseline)
</read_first>
<acceptance_criteria>
- Tapping a row expands it; tapping another collapses the first and expands the new one
- After collapse, the row's `<ChatSurface>` is unmounted — verified by React devtools or by a debug `console.log('mount')` / `console.log('unmount')` pair during dev
- Only one `<ChatSurface>` is in the React tree at any time
- Expand re-subscribes; collapse drops the subscription (verified by WS frames in devtools)
</acceptance_criteria>
</task>

<task id="T2">
<action>Create `web/src/components/MobileAccordionRow.tsx`. Two visual states. COLLAPSED: a compact row matching the Sidebar row style — session name, status dot, scheduled-task badge slot, chevron-down icon at the right. Tap target: full row. EXPANDED: shows the row chrome at the top (now with chevron-up), then a square panel below containing `<ChatSurface density="mobile-expanded" sessionId={...} />`. Square sizing: `aspect-ratio: 1 / 1` with `max-height: 100dvh`. NEVER use `100vh` — iOS Safari `vh` includes the keyboard area and collapses the layout when the input is focused. Use `100dvh` (dynamic viewport) or `100svh` (small viewport — safer fallback when `dvh` unsupported); a CSS `@supports` block can provide both. The input inside `<ChatSurface density="mobile-expanded">` is pinned to the bottom via flex column (already part of the density variant from PLAN-003 T4).</action>
<read_first>
- web/src/components/Sidebar.tsx
- web/src/components/ChatSurface.tsx (specifically the `mobile-expanded` density)
- caniuse / MDN for `dvh` and `svh` support (verify via context7 or web docs if uncertain — both ship in current Safari/Chrome/Firefox)
</read_first>
<acceptance_criteria>
- Computed style on the expanded panel includes `aspect-ratio: 1 / 1` and a `max-height` set via `dvh` or `svh` (not `vh`)
- On iOS Safari (or a simulator at 375x812), focusing the input does NOT shrink/collapse the panel — the layout holds while keyboard is open
- Collapsed row visually matches the Sidebar row style
- Expand/collapse uses a CSS transition (no JS height measurement) — pick a tasteful duration (≤200ms)
</acceptance_criteria>
</task>

<task id="T3">
<action>Wire `<MobileAccordion>` into `<GridPage>`: below the `md:` Tailwind breakpoint (768px), `<GridPage>` renders `<MobileAccordion tab={activeTab} token={token} />` instead of `<GridTabBar>` + grid. Above `md:`, the desktop layout renders as in PLAN-004. Use Tailwind's responsive utilities (`md:hidden` / `hidden md:block`) for the toggle — no JS-based viewport detection. The active tab is still derived from `#/grid/:tabId`; if there are multiple tabs and the user is on mobile, the active tab is the only one shown (no mobile tab picker in this phase — that's deferred per CONTEXT).</action>
<read_first>
- web/src/components/GridPage.tsx (after PLAN-004 T3)
- Tailwind 4 docs on `md:` breakpoint (768px default — verify in `web/tailwind.config.*` or the `@import "tailwindcss"` setup)
</read_first>
<acceptance_criteria>
- Resizing the browser below 768px hides the grid and shows the accordion (CSS-only toggle, no JS)
- Above 768px, the grid is shown and the accordion is hidden
- The active tab from `#/grid/:tabId` is the one whose sessions populate the accordion
</acceptance_criteria>
</task>

</tasks>

must_haves:
- Below `md` breakpoint, `<MobileAccordion>` replaces the grid via CSS-only toggle
- Only one `<ChatSurface>` is mounted at a time on mobile (collapsed rows fully unmount their surface)
- Expanded panel sizing uses `dvh` / `svh` and `aspect-ratio: 1/1`; never `100vh`
- The input bar inside the expanded panel stays pinned to the bottom when the iOS keyboard opens
- The collapsed row visually matches the existing Sidebar row style
