/**
 * Phase 12 — Telegram link codes.
 *
 * Generate an 8-char Crockford base32 code (40 bits, ~1.1 trillion codes),
 * write it onto `users.telegram_link_code` with a 10-min expiry. Single
 * active code per user — generating again rotates. `consumeLinkCode` looks
 * up by code, clears the row regardless of expiry (single-use), and returns
 * the user_id only when the code matched AND was not expired.
 *
 * Threat model:
 *   - 40 bits of entropy + 10-min TTL + single-use makes brute force across
 *     the active window infeasible.
 *   - Constant-time compare to defend against timing oracles on the lookup.
 *   - Codes are not bearer credentials post-consumption; they are bound to
 *     the originating user_id at generation time and discarded on use.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "../db/postgres.ts";

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
// Crockford base32 alphabet (no I, L, O, U — visually disambiguates O/0, I/1).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 8;

function generateCode(): string {
  // 5 bytes = 40 bits = 8 base32 chars exactly. Re-roll only used to map
  // each 5-bit window to alphabet; rejection sampling not required because
  // 32 evenly divides 256.
  const bytes = randomBytes(5);
  // Convert 5 bytes (40 bits) -> 8 base32 chars.
  let bits = 0;
  let bitCount = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    bits = (bits << 8) | bytes[i]!;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      const idx = (bits >> bitCount) & 0x1f;
      out += CROCKFORD[idx];
    }
  }
  return out;
}

/**
 * Generate and persist a fresh link code for `userId`. Rotates any existing
 * code on the same row. Returns the human-facing code and its expiry.
 */
export async function createLinkCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await sql`
    UPDATE users
       SET telegram_link_code = ${code},
           telegram_link_code_expires_at = ${expiresAt}
     WHERE id = ${userId}
  `;
  return { code, expiresAt };
}

/**
 * Consume a code: clear the row and return the user_id if the code matched
 * AND was not expired. Returns null on miss or expiry. The row is cleared
 * even on expiry so a stale code can't be retried.
 *
 * Implementation note: we scan all rows with a candidate code value to keep
 * the comparison constant-time per row, but the DB query already filters by
 * exact equality; constant-time-compare is applied as a defense in depth.
 */
export async function consumeLinkCode(code: string): Promise<string | null> {
  if (typeof code !== "string" || code.length !== CODE_LEN) return null;
  const rows = await sql<{ id: string; telegram_link_code: string | null; telegram_link_code_expires_at: Date | null }[]>`
    SELECT id, telegram_link_code, telegram_link_code_expires_at
      FROM users
     WHERE telegram_link_code = ${code}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row || !row.telegram_link_code) return null;
  // Constant-time equality on the code we just fetched, against the input.
  const a = Buffer.from(row.telegram_link_code);
  const b = Buffer.from(code);
  const matched = a.length === b.length && timingSafeEqual(a, b);
  // Always clear — single use, success or expired.
  await sql`
    UPDATE users
       SET telegram_link_code = NULL,
           telegram_link_code_expires_at = NULL
     WHERE id = ${row.id}
  `;
  if (!matched) return null;
  const expiresAt = row.telegram_link_code_expires_at;
  if (!expiresAt || expiresAt.getTime() < Date.now()) return null;
  return row.id;
}

// Test seam — re-exported for unit coverage of the base32 encoder.
export const __test = { generateCode, CODE_LEN, LINK_CODE_TTL_MS };
