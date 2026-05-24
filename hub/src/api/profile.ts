import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware.ts";
import { getUserById, updateProfile } from "../db/dal.ts";
import { sumTodayCostForUser } from "../db/scheduled-tasks-dal.ts";
import { sql } from "../db/postgres.ts";

export const profileRouter = new Hono();
export { profileRouter as profile };
profileRouter.use("/*", authMiddleware);

profileRouter.get("/", async (c) => {
  const userId = c.get("userId") as string;
  const user = await getUserById(userId);
  if (!user) return c.json({ error: "Not found" }, 404);
  return c.json(user);
});

// GET /api/profile/cost-today — daily spend + cap snapshot (W3/T16).
//
// Tradeoff (v1): query-time summation against scheduled_task_runs, no nightly
// reset job. We pay one cheap SUM() per UI request and per dispatcher fire.
// Acceptable until task volume exceeds ~10k runs/day/user; revisit with a
// rolling counter + midnight reset job if that ever happens.
profileRouter.get("/cost-today", async (c) => {
  const userId = c.get("userId") as string;
  // Pull cap + timezone in one query. `users.timezone` does not exist as a
  // column today, so we default to UTC; the field is included for forward
  // compatibility when a user-tz column lands.
  const rows = await sql<{ cap: string | null }[]>`
    SELECT daily_cost_cap_usd::text AS cap FROM users WHERE id = ${userId} LIMIT 1
  `;
  const cap = Number(rows[0]?.cap ?? 10);
  const tz = "UTC";
  const spent = await sumTodayCostForUser(userId, tz);
  const percent = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  return c.json({
    cost_usd: Number(spent.toFixed(4)),
    cap_usd: Number(cap.toFixed(4)),
    percent: Number(percent.toFixed(2)),
    timezone: tz,
  });
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
