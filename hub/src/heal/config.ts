// hub/src/heal/config.ts
//
// PTYCAP-07-01 (D-01, SH-07, AM-F1-1, AM-F3-3): the ONLY module under hub/src that reads
// REMO_HEAL_* env. Every reader is call-time (tests toggle process.env). The unified-heal
// flag defaults OFF and only 1|true|yes|on turn it ON; every numeric knob falls back to its
// default on a non-positive / non-finite / non-numeric value so a typo can never mean
// "no dedupe" or "no ceiling".

import { isAutospawnEnabled } from '../orchestrator/controller.ts';

/** REMO_HEAL_UNIFIED: master flag. Unset / empty / anything unrecognized = OFF. */
export function healUnifiedEnabled(): boolean {
  const raw = (process.env.REMO_HEAL_UNIFIED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Positive finite number from env, else the default. */
function positiveKnob(envName: string, def: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function healDedupeWindowMs(): number {
  return positiveKnob('REMO_HEAL_DEDUPE_WINDOW_MS', 900_000);
}

export function healSpawnTimeoutMs(): number {
  return positiveKnob('REMO_HEAL_SPAWN_TIMEOUT_MS', 25_000);
}

export function healMaxClaimsPerUserHour(): number {
  return positiveKnob('REMO_HEAL_MAX_CLAIMS_PER_USER_HOUR', 30);
}

export function healMaxPerRepoHour(): number {
  return positiveKnob('REMO_HEAL_MAX_PER_REPO_HOUR', 4);
}

export function healMaxPerTaskDay(): number {
  return positiveKnob('REMO_HEAL_MAX_PER_TASK_DAY', 3);
}

/** Retention floors at 24h (AM-F3-3): a shorter window would drop dedupe state early. */
export function healRetentionHours(): number {
  return Math.max(24, positiveKnob('REMO_HEAL_RETENTION_HOURS', 48));
}

/**
 * Heal autospawn is armed only when the heal flag AND the autospawn flag are ON. Heal has its
 * own flag (AM-F1-1): it deliberately does not depend on the orchestrator live-path gate.
 */
export function healAutospawnArmed(): boolean {
  return healUnifiedEnabled() && isAutospawnEnabled();
}
