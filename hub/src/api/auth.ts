import { Hono } from "hono";
import { getUserByEmail, createUser, countUsers } from "../db/dal.ts";
import { verifyPassword, hashPassword } from "../auth/password.ts";
import { signJwt } from "../auth/jwt.ts";

export const authRouter = new Hono();

authRouter.post("/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: "Email and password required" }, 400);

  const user = await getUserByEmail(email.toLowerCase().trim());
  if (!user) return c.json({ error: "Invalid credentials" }, 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return c.json({ error: "Invalid credentials" }, 401);

  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  return c.json({ token, user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name } });
});

authRouter.post("/register", async (c) => {
  const total = await countUsers();
  if (total > 0) return c.json({ error: "Registration is closed" }, 403);

  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: "Email and password required" }, 400);
  if (password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

  const hash = await hashPassword(password);
  const user = await createUser(email.toLowerCase().trim(), hash, "admin");
  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  return c.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});
