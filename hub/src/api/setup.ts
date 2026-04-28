import { Hono } from "hono";
import { countUsers, createUser } from "../db/dal.ts";
import { hashPassword } from "../auth/password.ts";

export const setupRouter = new Hono();
export { setupRouter as setup };

let setupInProgress = false;

setupRouter.get("/status", async (c) => {
  const count = await countUsers();
  return c.json({ needsSetup: count === 0 });
});

setupRouter.post("/create-admin", async (c) => {
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
