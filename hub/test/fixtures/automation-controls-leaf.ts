/**
 * PTYCAP-04-03: leaf-mock factory for src/dispatch/automation-controls.ts.
 *
 * Tests that mock dispatch/gates.ts (or run a sender with the real pipeline and a
 * stubbed `sql`) now also reach automation-controls through inject.ts / agent.ts /
 * triage.ts. This stand-in keeps those tests about THEIR subject: pass-through gates,
 * a not-halted predicate, a reservation that always succeeds, and a constant resolver.
 * Usage (before the dynamic import of the module under test):
 *
 *   mock.module('../src/dispatch/automation-controls.ts', () => automationControlsLeaf())
 *
 * Not a test file and not itself a mock.module call.
 */
export function automationControlsLeaf(): Record<string, unknown> {
  return {
    AUTOMATION_KILL_SWITCH_GATE_NAME: 'automation_kill_switch',
    LIFETIME_COUNTER_GATE_NAME: 'lifetime_counter',
    automationKillSwitchGate: { name: 'automation_kill_switch', async check() { return { ok: true } } },
    automationLifetimeCounterGate: { name: 'lifetime_counter', async check() { return { ok: true } } },
    isAutomationHalted: async () => ({ halted: false }),
    preSendGuard: async () => ({ ok: true, reserved: false }),
    finalHaltCheck: async () => ({ ok: true }),
    releaseInject: async () => {},
    resolveOrchestratorCounterKey: async () => 'task:LEAF',
  }
}
