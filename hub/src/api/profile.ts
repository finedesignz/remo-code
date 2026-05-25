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
  // Pull cap + timezone in one query.
  const rows = await sql<{ cap: string | null; timezone: string | null }[]>`
    SELECT daily_cost_cap_usd::text AS cap, timezone FROM users WHERE id = ${userId} LIMIT 1
  `;
  const cap = Number(rows[0]?.cap ?? 10);
  const tz = rows[0]?.timezone || "UTC";
  const spent = await sumTodayCostForUser(userId, tz);
  const percent = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  return c.json({
    cost_usd: Number(spent.toFixed(4)),
    cap_usd: Number(cap.toFixed(4)),
    percent: Number(percent.toFixed(2)),
    timezone: tz,
  });
});

function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

const MAX_AVATAR_BYTES = 1_400_000; // ~1MB after base64 overhead (1MB * 1.37)

profileRouter.patch("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ display_name?: string; avatar_url?: string | null; system_prompt?: string | null; timezone?: string }>();
  const fields: { display_name?: string; avatar_url?: string | null; system_prompt?: string | null; timezone?: string } = {};
  if (body.display_name !== undefined) fields.display_name = body.display_name;
  if (body.avatar_url !== undefined) {
    const v = body.avatar_url;
    if (v === null || v === '') {
      fields.avatar_url = null;
    } else if (typeof v !== 'string') {
      return c.json({ error: 'invalid_avatar_url' }, 400);
    } else if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) {
      return c.json({ error: 'invalid_avatar_format', message: 'avatar_url must be a data:image/* URL' }, 400);
    } else if (v.length > MAX_AVATAR_BYTES) {
      return c.json({ error: 'avatar_too_large', max_bytes: MAX_AVATAR_BYTES }, 413);
    } else {
      fields.avatar_url = v;
    }
  }
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
