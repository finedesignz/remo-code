// hub/src/heal/flag.ts
//
// PTYCAP-07-09: the REMO_HEAL_UNIFIED reader, split out of config.ts as a dependency-free leaf.
// config.ts imports the orchestrator controller (for the autospawn predicate), which pulls the ws
// registry, DAL and scheduler graph. A flag-OFF dispatcher must load none of that just to learn the
// flag is off, so the legacy error-capture and feedback dispatchers import this leaf. config.ts
// re-exports it, so `healUnifiedEnabled` still has exactly one definition.

/** REMO_HEAL_UNIFIED: master flag. Unset / empty / anything unrecognized = OFF. Call-time read. */
export function healUnifiedEnabled(): boolean {
  const raw = (process.env.REMO_HEAL_UNIFIED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
