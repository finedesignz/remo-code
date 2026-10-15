import { Hono } from "hono";
import { countUsers, createUser } from "../db/dal.ts";
import { hashPassword } from "../auth/password.ts";
import { config } from "../config.ts";

export const setupRouter = new Hono();
export { setupRouter as setup };

let setupInProgress = false;

setupRouter.get("/status", async (c) => {
  const count = await countUsers();
  // `needs_setup` drives the SPA's password SetupForm, which only makes sense
  // while the legacy password bootstrap is enabled. `needsSetup` is kept for
  // existing callers.
  const empty = count === 0;
  return c.json({ needsSetup: empty, needs_setup: empty && config.allowLegacyLogin });
});

// Password bootstrap of the first admin: a LEGACY surface. Under the Titanium
// hosted login the first user is created by a Titanium login whose verified email
// equals REMO_BOOTSTRAP_ADMIN_EMAIL (hub/src/db/titanium-link-dal.ts), so this route
// 404s unless ALLOW_LEGACY_LOGIN=true. Left open, it would let whoever reaches a
// fresh deployment first claim the admin account with a password.
setupRouter.post("/create-admin", async (c) => {
  if (!config.allowLegacyLogin) return c.json({ error: "not_found" }, 404);
  if (setupInProgress) return c.json({ error: "Setup already in progress" }, 409);
  setupInProgress = true;
  try {
    const count = await countUsers();
    if (count > 0) return c.json({ error: "Admin already exists" }, 409);

    const { email, password } = await c.req.json<{ email: string; password: string }>();
    if (!email || !password) return c.json({ error: "Email and password required" }, 400);
    if (password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

    const hash = await hashPassword(password);
    const user = await createUser(email.toLowerCase().trim(), hash, "admin");
    return c.json({ success: true, user: { id: user.id, email: user.email, role: user.role } });
  } finally {
    setupInProgress = false;
  }
});
