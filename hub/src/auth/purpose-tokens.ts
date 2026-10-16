// Signed, purpose-bound HS256 tokens for the Titanium hosted login.
//
// One secret (SESSION_SECRET), one key per token purpose, derived with
// HKDF-SHA256 (RFC 5869). A token minted for one purpose (the 15-minute
// pending-login cookie, the 5-minute pending-confirm cookie) is signed with a
// different key than any other purpose, AND carries a `purpose` claim that is
// checked on verify, so it can never be presented as another kind of token even
// if one of the two checks were dropped. Verification pins HS256 (no `none`, no
// HS512, no asymmetric confusion).
//
// The dashboard session itself is NOT one of these: it stays the opaque
// `remo_<random>` token stored as a sha-256 hash in `auth_sessions`
// (hub/src/session.ts). The legacy own magic link keeps its own MAGIC_LINK_SECRET.

import { hkdfSync } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export type TokenPurpose = "pending-login" | "pending-confirm";

/** Documented floor for SESSION_SECRET (also enforced at boot in hub/src/session.ts). */
export const MIN_SESSION_SECRET_LENGTH = 32;

const SALT = "remo-code/session-secret/v1";

export class SessionSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionSecretError";
  }
}

/**
 * The 32-byte HS256 key for `purpose`. Fails closed (throws SessionSecretError)
 * when SESSION_SECRET is unset or shorter than 32 characters: callers turn that
 * into a refusal, never a fallback key. Read on every call (env rotation, tests).
 */
export function deriveKey(purpose: TokenPurpose): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new SessionSecretError("SESSION_SECRET is not set");
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new SessionSecretError(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  return new Uint8Array(hkdfSync("sha256", secret, SALT, `remo-code:${purpose}`, 32));
}

export async function signPurposeToken(
  purpose: TokenPurpose,
  claims: Record<string, string>,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...claims, purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(deriveKey(purpose));
}

/**
 * The payload of a live token for `purpose`, or null: bad signature, another
 * purpose's key, expired, any algorithm but HS256 (incl. `none`), a `purpose`
 * claim that does not match, or a misconfigured SESSION_SECRET (fail closed).
 */
export async function verifyPurposeToken(purpose: TokenPurpose, token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, deriveKey(purpose), { algorithms: ["HS256"] });
    return payload.purpose === purpose ? payload : null;
  } catch {
    return null;
  }
}
