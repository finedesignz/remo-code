# Grid-View Ship Commit Inventory

Branch: `feat/grid-view-ship` (off `origin/main`)

Foundation already on main (via PR #2 squash):
- `hub/src/db/schema.sql` — `chat_tabs`, `chat_tab_sessions` tables
- `hub/src/ws/protocol.ts` — `session_ids` multi-subscribe overload (cap 12)
- `web/src/components/{GridPage,MobileAccordion,MobileAccordionRow,MobileAccordionShowcase,SessionPicker}.tsx`
- `web/src/lib/{chat-tabs-api,raf-batch}.ts`

## INCLUDE (cherry-pick in chronological order — oldest first)

1. `5bc26fe` fix(grid): mobile accordion uses dvh upper bound + design-token status dot
2. `2187602` refactor(grid): single MAX_CELLS_PER_TAB constant + SessionPicker a11y
3. `3e3626f` feat(grid): keyboard nav + ARIA roles for tabs, grid, and layout picker
4. `3a4a414` fix(grid): tab delete UX — confirm-message detail, last-tab protection, scroll-snap
5. `911f6bc` feat(grid): mobile accordion scrolls expanded row into view
6. `bc17d48` feat(grid): unread badge + polite aria-live for inactive cells
7. `fe84b57` docs(grid-view): accessibility, keyboard nav, unread, and tab-delete UX

All 7 commits touch ONLY:
- `web/src/components/{GridPage,MobileAccordionRow,SessionPicker}.tsx`
- `web/src/lib/chat-tabs-api.ts`
- `docs/grid-view.md`

## EXCLUDE (sister-session / other-phase work)

- `64d940b` feat(05-02): wire cli_kind through REST create — Phase 05
- `d1b830b` feat(hub): host_resources WS schema — Phase 04
- `260db96` docs(05-01) — Phase 05
- `c47bb7a` feat(05-01): DAL cli_kind/is_rootless/hostname — Phase 05
- `7a17715` feat(05-02): cli_kind + rootless_sessions to agent auth — Phase 05
