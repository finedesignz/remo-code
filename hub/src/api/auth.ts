// JSON logout. The only login is the Titanium hosted login in
// hub/src/api/titanium-auth.ts (mounted at /auth): the user signs in on the
// Titanium Labs page and returns to /auth/callback. This hub has no password,
// own-magic-link or mobile-handoff login routes.
//
// Endpoints:
//   POST /api/auth/logout  - kills session row + clears cookies (JSON; the SPA's
//        explicit sign-out uses POST /auth/logout, which also ends the Titanium
//        portal session).

import { Hono } from "hono";
import { recordAuthEvent } from "../db/dal.ts";
import { destroySession } from "../session.ts";
import { clearCsrfCookie } from "../csrf.ts";
import { setCookie } from "hono/cookie";
import { PENDING_CONFIRM_COOKIE, PENDING_LOGIN_COOKIE, pendingCookieOptions } from "../auth/titanium-login.ts";

export const authRouter = new Hono();

function ipOf(c: any): string | null {
  return c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

// POST /api/auth/logout
authRouter.post("/logout", async (c) => {
  const ip = ipOf(c);
  const ua = c.req.header("user-agent") ?? null;
  // Best-effort: identify user before destroying for the audit row.
  let userId: string | null = null;
  try {
    const { verifyAuthSessionCookie } = await import("../session.ts");
    const ctx = await verifyAuthSessionCookie(c);
    userId = ctx?.userId ?? null;
  } catch {}

  await destroySession(c);
  clearCsrfCookie(c);
  // Any half-finished Titanium login in this browser goes too.
  setCookie(c, PENDING_LOGIN_COOKIE, "", pendingCookieOptions(0));
  setCookie(c, PENDING_CONFIRM_COOKIE, "", pendingCookieOptions(0));

  console.log(`[auth] logout user=${userId ?? "anon"} session_row_deleted=true`);
  try { await recordAuthEvent({ userId, eventType: "logout", ip, userAgent: ua }); } catch {}
  return c.json({ ok: true });
});
