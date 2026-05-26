// Phase 07-C / C.6: dual-auth shim.
//
// Identity resolves from EITHER:
//   (a) `__Host-remo_sid` cookie → DAL `auth_sessions` (preferred), OR
//   (b) `Authorization: Bearer <jwt>` legacy HS256 (only when
//       config.allowLegacyLogin === true).
//
// Cookie wins if both present. Sets c.var.userId/userEmail/userRole the same
// way regardless of source so downstream handlers don't branch.

import type { Context, Next } from "hono";
import { verifyJwt } from "./jwt.ts";
import { verifyAuthSessionCookie } from "../session.ts";
import { config } from "../config.ts";

export async function authMiddleware(c: Context, next: Next) {
  // (a) cookie path
  const sessionCtx = await verifyAuthSessionCookie(c);
  if (sessionCtx) {
    c.set("userId", sessionCtx.userId);
    c.set("userEmail", sessionCtx.user.email);
    c.set("userRole", sessionCtx.user.role);
    c.set("authMethod", "session_cookie");
    return next();
  }

  // (b) legacy bearer path — only if soak flag is on
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ") && config.allowLegacyLogin) {
    const token = header.slice(7);
    try {
      const payload = verifyJwt(token);
      c.set("userId", payload.sub);
      c.set("userRole", payload.role);
      c.set("userEmail", payload.email);
      c.set("authMethod", "legacy_jwt");
      return next();
    } catch {
      return c.json({ error: "Invalid token" }, 401);
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
}
