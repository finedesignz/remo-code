// Identity resolves from EITHER:
//   (a) `__Host-remo_sid` cookie → DAL `auth_sessions` (issued by the Titanium
//       hosted login callback), OR
//   (c) `Authorization: Bearer remokey_<key>` — an api key with an explicit
//       `settings:read` / `settings:write` scope, and ONLY on the settings route
//       allowlist (hub/src/auth/settings-api-key.ts). Every other path → 403.
//
// Cookie wins if both present. Sets c.var.userId/userEmail/userRole the same
// way regardless of source so downstream handlers don't branch.

import type { Context, Next } from "hono";
import { verifyAuthSessionCookie } from "../session.ts";
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

  // (c) settings-scoped api key. 
  if (header?.startsWith("Bearer remokey_")) {
    const denied = await authenticateSettingsApiKey(c, header.slice(7).trim());
    return denied ?? next();
  }

  return c.json({ error: "Unauthorized" }, 401);
}
