/**
 * origin-guard.ts — Phase 16 (NH-3 / R-PTY-34): CSWSH / forged-Origin guard for
 * the /ws/client WebSocket handshake.
 *
 * The /ws/client `cookie ⇒ human` actor inference treats ANY authenticated
 * browser WS as human, so a cross-site WebSocket handshake riding the user's
 * cookie could drive PTY input as "human". The handshake therefore enforces
 * Origin ∈ HUB_ALLOWED_ORIGINS. HARDENED for CSWSH: a MISSING Origin is also
 * rejected — browsers always send Origin on a WS handshake, so an absent one is
 * not a legitimate browser client and must not be treated as a human actor.
 */
export function isAllowedClientWsOrigin(
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return false // missing Origin → reject (CSWSH hardening)
  return allowedOrigins.includes(origin)
}
