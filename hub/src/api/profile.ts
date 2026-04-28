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
  const { display_name } = await c.req.json<{ display_name: string }>();
  const updated = await updateProfile(userId, display_name);
  return c.json(updated);
});
