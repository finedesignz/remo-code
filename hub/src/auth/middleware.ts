import type { Context, Next } from "hono";
import { verifyJwt } from "./jwt.ts";

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = header.slice(7);
  try {
    const payload = verifyJwt(token);
    c.set("userId", payload.sub);
    c.set("userRole", payload.role);
    c.set("userEmail", payload.email);
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
  await next();
}
