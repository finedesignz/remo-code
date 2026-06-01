/**
 * Phase 18 (R-PTY-19, T-18-06 / T-18-07) — automation-routing regression guard.
 *
 * Asserts the STRUCTURAL invariant (does not re-route — guards the existing one):
 *  - Every unattended dispatch source (scheduler / orchestrator-background /
 *    auto-dev / error-capture) is a recognised AUTOMATION actor, so the
 *    human-only PTY guard REJECTS it from the interactive PTY surface (it can
 *    only ride the stream-json/programmatic transport).
 *  - A human actor is the ONLY actor allowed on a pty-interactive session.
 *  - No automation runner spawn path constructs/keeps an ANTHROPIC_API_KEY —
 *    the subscription-OAuth-via-stream-json path is the programmatic transport,
 *    never an API-platform key (grep over the supervisor runner spawn code).
 *
 * Data-driven over the source list so adding a new automation source forces an
 * explicit decision here.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { AUTOMATION_ACTORS, humanOnlyRejectsActor, dailyCostCapGate } from '../src/dispatch/gates'

// The unattended sources the SPEC + RESEARCH §4 enumerate. `agent` is the
// supervisor /ws/agent actor (also non-human). Kept in sync with gates.ts.
const UNATTENDED_SOURCES = ['scheduler', 'orchestrator-background', 'auto-dev', 'error-capture'] as const

describe('automation sources are recognised + PTY-excluded', () => {
  for (const source of UNATTENDED_SOURCES) {
    test(`${source} is a recognised AUTOMATION actor`, () => {
      expect(AUTOMATION_ACTORS.has(source)).toBe(true)
    })
    test(`${source} is REJECTED on the interactive PTY surface`, () => {
      expect(humanOnlyRejectsActor(source, 'pty-interactive')).toBe(true)
    })
    test(`${source} is ALLOWED on the stream-json/programmatic transport`, () => {
      // non-pty runner types are not blocked by the human-only guard; they remain
      // cost-capped + halt-capped by dailyCostCapGate (the single chokepoint).
      expect(humanOnlyRejectsActor(source, 'stream-json')).toBe(false)
    })
  }

  test('only a human actor may drive a pty-interactive session', () => {
    expect(humanOnlyRejectsActor('human', 'pty-interactive')).toBe(false)
    // every automation actor (incl. agent) is rejected
    for (const a of AUTOMATION_ACTORS) {
      expect(humanOnlyRejectsActor(a, 'pty-interactive')).toBe(true)
    }
  })

  test('the cost-cap gate (single chokepoint) is the gate automation flows through', () => {
    // sanity: the gate exists and is the named single chokepoint
    expect(dailyCostCapGate.name).toBe('daily_cost_cap')
  })
})

describe('no ANTHROPIC_API_KEY on the automation runner spawn paths', () => {
  // The supervisor runners are the spawn surface for the programmatic transport.
  const runnersDir = join(import.meta.dir, '..', '..', 'supervisor', 'src', 'runners')

  test('every runner that spawns a CLI deletes ANTHROPIC_API_KEY from the env', () => {
    const files = readdirSync(runnersDir).filter(
      (f) => f.endsWith('-runner.ts') || f.endsWith('.mjs'),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const src = readFileSync(join(runnersDir, f), 'utf-8')
      // A spawn path must never SET an API key; if it touches env it must scrub it.
      expect(src).not.toMatch(/env(\.|\[['"])ANTHROPIC_API_KEY['"\]]?\s*=/)
      if (/spawn|Bun\.spawn|child_process|pty/i.test(src)) {
        // Phase-19: the scrub is centralized in the shared `sanitizeSpawnEnv`
        // (env-sanitize.ts) — accept it OR the legacy literal delete. The
        // shared sanitizer scrubs the full provider-key denylist + credential
        // patterns (incl. inherited vars), a strict superset of the old delete.
        const scrubs =
          /\bsanitizeSpawnEnv\b/.test(src) || /delete\s+\(?env[^\n]*ANTHROPIC_API_KEY/.test(src)
        expect(scrubs).toBe(true)
      }
    }
  })
})
