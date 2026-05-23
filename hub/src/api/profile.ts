import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware.ts";
import { getUserById, updateProfile } from "../db/dal.ts";

export const profileRouter = new Hono();
export { profileRouter as profile };
profileRouter.use("/*", authMiddleware);

profileRouter.get("/", async (c) => {
  const userId = c.get("userId") as string;
  const user = await getUserById(userId);
  if (!user) return c.json({ error: "Not found" }, 404);
  return c.json(user);
});

profileRouter.patch("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ display_name?: string; system_prompt?: string | null }>();
  const fields: { display_name?: string; system_prompt?: string | null } = {};
  if (body.display_name !== undefined) fields.display_name = body.display_name;
  if (body.system_prompt !== undefined) {
    const v = body.system_prompt;
    fields.system_prompt = typeof v === 'string' && v.trim() === '' ? null : v;
  }
  const updated = await updateProfile(userId, fields);
  return c.json(updated);
});
