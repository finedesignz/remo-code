/**
 * Zero Exposure plugin identity JWT.
 *
 * Mints the short-lived token the browser widget sends as
 * `Authorization: Bearer <token>` to the Zero Exposure ingest endpoint. This is
 * a SEPARATE secret/issuer/audience from the hub's own session JWT
 * (hub/src/auth/jwt.ts) — never reuse `config.jwtSecret` here. A leaked
 * Zero Exposure signing secret must not be forgeable into a hub session, and
 * vice versa.
 *
 * Contract (frozen, Zero Exposure docs/widget-contract.md):
 *   alg HS256, iss "zero-exposure-plugin", aud "zero-exposure-plugin-ingest",
 *   app_id === the provisioned plugin app id, sub = stable user id,
 *   iat + exp both set, exp - iat <= 900s (we use 600s).
 */
import jwt from "jsonwebtoken";
import { config } from "../config.ts";

const TOKEN_TTL_SECONDS = 600;

export interface AgentautofixIdentityFields {
  sub: string;
  email?: string;
  role?: string;
}

/** Throws if Zero Exposure isn't configured — callers must check `config.agentautofix.configured` first. */
export function mintAgentautofixIdentityToken(fields: AgentautofixIdentityFields): string {
  if (!config.agentautofix.configured) {
    throw new Error("agentautofix not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: "zero-exposure-plugin",
      aud: "zero-exposure-plugin-ingest",
      app_id: config.agentautofix.appId,
      sub: fields.sub,
      email: fields.email,
      role: fields.role,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    },
    config.agentautofix.signingSecret,
    { algorithm: "HS256" },
  );
}
