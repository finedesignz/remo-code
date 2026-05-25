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

// NOTE: `GET /api/profile/cost-today` lives in `./_openapi.ts` as the
// docs-standardization sample route. Do not re-add it here — mounting order
// in `src/index.ts` puts the OpenAPI-aware version ahead of this router.

function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

profileRouter.patch("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ display_name?: string; system_prompt?: string | null; timezone?: string }>();
  const fields: { display_name?: string; system_prompt?: string | null; timezone?: string } = {};
  if (body.display_name !== undefined) fields.display_name = body.display_name;
  if (body.system_prompt !== undefined) {
    const v = body.system_prompt;
    fields.system_prompt = typeof v === 'string' && v.trim() === '' ? null : v;
  }
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || !isValidTimezone(body.timezone)) {
      return c.json({ error: 'invalid_timezone' }, 400);
    }
    fields.timezone = body.timezone;
  }
  const updated = await updateProfile(userId, fields);
  return c.json(updated);
});
