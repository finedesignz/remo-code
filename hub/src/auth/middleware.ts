// Phase 07-C / C.6: dual-auth shim.
//
// Identity resolves from EITHER:
//   (a) `__Host-remo_sid` cookie → DAL `auth_sessions` (preferred), OR
//   (b) `Authorization: Bearer <jwt>` legacy HS256 (only when
//       config.allowLegacyLogin === true).
//
//   (c) `Authorization: Bearer remokey_<key>` — an api key with an explicit
//       `settings:read` / `settings:write` scope, and ONLY on the settings route
//       allowlist (hub/src/auth/settings-api-key.ts). Every other path → 403.
//
// Cookie wins if both present. Sets c.var.userId/userEmail/userRole the same
// way regardless of source so downstream handlers don't branch.

import type { Context, Next } from "hono";
import { verifyJwt } from "./jwt.ts";
import { verifyAuthSessionCookie } from "../session.ts";
import { config } from "../config.ts";
import { authenticateSettingsApiKey } from "./settings-api-key.ts";

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

  const header = c.req.header("Authorization");

  // (c) settings-scoped api key. Checked before the legacy JWT branch: a
  // `remokey_` token is never a JWT, and must not depend on ALLOW_LEGACY_LOGIN.
  if (header?.startsWith("Bearer remokey_")) {
    const denied = await authenticateSettingsApiKey(c, header.slice(7).trim());
    return denied ?? next();
  }

  // (b) legacy bearer path — only if soak flag is on
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
