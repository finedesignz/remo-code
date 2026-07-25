---
plan_id: 04-PLAN-010-web-budget-ui
wave: 4
depends_on: [04-PLAN-002-schema-and-migration, 04-PLAN-003-hub-concurrency-gate, 04-PLAN-009-cost-cap-hub-wide]
files_modified:
  - web/src/components/SupervisorCard.tsx
  - web/src/components/SupervisorOverrideSlider.tsx
  - web/src/components/CostBudgetHud.tsx
  - web/src/components/SettingsPage.tsx
  - web/src/lib/api.ts
  - web/src/hooks/useSupervisorBudget.ts
autonomous: false
requirements: [REQ-UI-01, REQ-UI-02, REQ-UI-03]
---

# Plan 04-010 — Web UI: supervisor compute chip, override slider, cost HUD

UI is a **display layer** per ARCHITECTURE-REVIEW §3 — the hub is the cap. This plan renders the budget, lets the user adjust the override, and shows today's cost. Visual signals follow the project frontend conventions (subtle backgrounds, indigo accent, status colors, rounded-xl). Reference `web/src/components/SettingsPage.tsx` as the visual baseline per project CLAUDE.md.

<tasks>

<task id="T1">
<action>Create `web/src/hooks/useSupervisorBudget.ts` exporting `useSupervisorBudget(supervisorId)` returning `{ cpu_cores, total_mem_mb, free_mem_mb, concurrency_budget, concurrency_override, running, cap, source, budget_updated_at, costToday: { cents_spent, cap_cents, pct } }`. Subscribes to the existing WS events (`supervisor_resources_updated` from Plan 002, `supervisor_capacity_changed` from Plan 003, `cost_cap_warning` from Plan 009) and updates state reactively — NO polling. Hydrates initial state from `GET /api/supervisors` + `GET /api/users/me/cost-usage` (add this REST endpoint here if missing; expects to be a small DAL wrapper around `getTodayUsage` from Plan 009).</action>
<read_first>
- web/src/lib/api.ts (existing REST + WS message handling pattern)
- web/src/components/SettingsPage.tsx (visual + state baseline per project CLAUDE.md)
- hub/src/ws/protocol.ts (the WS message variants added in Plans 002/003/009)
</read_first>
<acceptance_criteria>
- Mounting the hook fetches initial state via REST; subsequent updates arrive via WS without re-fetches
- Unsubscribes WS listeners on unmount (no leaks across remounts)
- Returns `costToday.pct` as a number 0–100 (clamps over)
- `running` and `cap` come from `supervisor_capacity_changed` events; UI never holds stale values for > 1 capacity change
</acceptance_criteria>
</task>

<task id="T2">
<action>Create `web/src/components/SupervisorCard.tsx`. Renders one supervisor with: a "Compute" chip showing `{cpu_cores} cores · {total_mem_mb}MB` and a colored status dot (emerald online / gray offline based on `last_seen_at`); a usage row "{running}/{cap} sessions" with a thin progress bar (emerald < 70%, amber 70-95%, red ≥ 95%); the source pill (`cgroup_v2` / `cgroup_v1` / `host_fallback`) as a small muted badge; and a "set as preferred" toggle that PATCHes `/api/users/me/preferred-supervisor`. Visual: `bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3` per project frontend conventions. At-cap state: faint red ring `ring-1 ring-red-500/30`.</action>
<read_first>
- web/src/components/SettingsPage.tsx (canonical card pattern)
- ~/.claude/CLAUDE.md "Frontend / CSS Conventions" section (token usage, rounded-xl, status colors)
</read_first>
<acceptance_criteria>
- No hardcoded hex colors — all colors come from CSS custom properties or Tailwind palette per conventions
- "Set as preferred" toggle reflects current state instantly and PATCHes the API
- At-cap visual treatment is visible (ring + bar color)
- Component is unit-renderable in isolation (no global store deps beyond the hook)
</acceptance_criteria>
</task>

<task id="T3">
<action>Create `web/src/components/SupervisorOverrideSlider.tsx`. Slider control with range `[1, concurrency_budget * 2]`, current value = `concurrency_override ?? concurrency_budget`. Tick mark + label at `concurrency_budget` so the user sees the "natural" budget. On commit (mouseup/touchend), PATCH `/api/supervisors/:id/override`. Show a small caption: "Setting > {budget} may cause OOM kills on the host." Indigo accent for the slider thumb (`accent-indigo-500`).</action>
<read_first>
- web/src/components/SupervisorCard.tsx (parent component from T2 — slider is embedded)
- hub/src/api/supervisors.ts (the PATCH endpoint from Plan 002, for shape)
</read_first>
<acceptance_criteria>
- Slider min = 1, max = `budget * 2` (server enforces too; client mirrors so UX shows the ceiling)
- Debounces API calls — only PATCHes on commit, not every drag tick
- Reverts on PATCH error (toast surfaces the server's error message)
- Setting `null` (toggle to "auto") is exposed via a small "Reset to auto" button next to the slider
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `web/src/components/CostBudgetHud.tsx` (mounted in the app header per project conventions — same spot as today's nav). Shows `$X.YZ / $A.BC today` with a thin progress bar. Color thresholds: muted < 50%, amber 50-79%, red ≥ 80%. Click opens a popover with: today's input/output token counts, the per-model breakdown if available, a link to Settings → Cost Cap. Cost values come from the hook (`costToday`).</action>
<read_first>
- web/src/components/SettingsPage.tsx (header insertion point + visual baseline)
- web/src/hooks/useSupervisorBudget.ts (or split out a smaller `useCostToday` if cleaner — your call)
</read_first>
<acceptance_criteria>
- HUD reflects WS updates within 200ms of the agent forwarding a `result` event
- Click-to-expand popover shows tokens and per-model breakdown
- Color thresholds match the spec exactly (50% / 80%)
- Mobile: HUD collapses to just `$X.YZ` + colored dot (no progress bar) on narrow viewports
</acceptance_criteria>
</task>

<task id="T5">
<action>Update `web/src/components/SettingsPage.tsx` to add a "Cost Cap" section: input field for `daily_cost_cap_cents` (display as dollars), Save button → PATCH `/api/users/me/cost-cap`. Add a "Preferred Supervisor" section: dropdown listing the user's online supervisors + "Auto (first available)" + "Local agent only" options → PATCH `/api/users/me/preferred-supervisor`. Add a list of all supervisors using the new `<SupervisorCard>` component, each with the `<SupervisorOverrideSlider>` embedded.</action>
<read_first>
- web/src/components/SettingsPage.tsx (existing sections + insertion patterns)
- The four UI components above
</read_first>
<acceptance_criteria>
- Cost cap input accepts $ values, converts to cents server-side, shows server-validation errors inline
- Preferred-supervisor dropdown includes "Auto" + "Local agent only" + each online supervisor
- Supervisor list renders one card per supervisor with override slider working end-to-end against the live hub
</acceptance_criteria>
</task>

<task id="T6" type="checkpoint:human-verify">
<what-built>Full UI: compute chip, override slider, cost HUD, settings sections.</what-built>
<how-to-verify>
1. With the Coolify supervisor running from Plan 006 + Plan 001's `host_resources` reporting active, open https://app.remo-code.com
2. Header: Cost HUD visible with today's spend
3. Settings: Supervisors section shows the Coolify supervisor card with cpu/mem chip, "X/Y sessions" bar, source pill
4. Drag the override slider above `budget`; release → see toast/confirmation; refresh → value persists
5. Set the supervisor as preferred → refresh → still preferred
6. Trigger a heal call (curl `POST /api/sessions/heal` from Plan 008) → watch the "running" count tick up; the bar color changes if you approach cap
7. Watch cost HUD increment as the heal-spawned session does Claude work
8. Set cost cap to a low value ($0.01); try to spawn another session → expect 429 / hub-side rejection with `daily_cost_cap_reached`
</how-to-verify>
<resume-signal>Paste any visual / behavior bugs found. Once clean, I'll proceed to Plan 011 (tests + docs).</resume-signal>
</task>

</tasks>

must_haves:
- Supervisor card shows cpu/mem/source/`running/cap` with at-cap visual treatment
- Override slider hard-limits at `budget * 2` (mirrors server enforcement)
- Cost HUD reflects today's spend in real-time with 50% / 80% color thresholds
- Settings page exposes cost cap, preferred supervisor, and per-supervisor override controls
- All visuals follow project frontend conventions (tokens, rounded-xl, indigo accent, no ad-hoc colors)
- UI is purely display — server is authoritative on caps

rollback_plan:
- Hide the new components from the Settings page (1-line revert); REST/WS plumbing remains harmless.

risks:
- WS event timing: `supervisor_capacity_changed` may race with REST hydration on first mount. Hook should prefer the later-arriving value (last-write-wins by timestamp).
- Cost HUD updates on every `result` event — high-frequency sessions could cause re-render churn. Throttle to 1Hz if needed.
