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

const MAX_AVATAR_BYTES = 1_400_000; // ~1MB after base64 overhead (1MB * 1.37)

profileRouter.patch("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ display_name?: string; avatar_url?: string | null; system_prompt?: string | null; timezone?: string; programmatic_halt_usd?: number | null }>();
  const fields: { display_name?: string; avatar_url?: string | null; system_prompt?: string | null; timezone?: string; programmatic_halt_usd?: number | null } = {};
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
  // Phase 18 (R-PTY-18): opt-in programmatic-credit hard-halt bound. null/0 ⇒
  // OFF (the default); a positive number arms the halt at dailyCostCapGate.
  if (body.programmatic_halt_usd !== undefined) {
    const v = body.programmatic_halt_usd;
    if (v === null) {
      fields.programmatic_halt_usd = null;
    } else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return c.json({ error: 'invalid_programmatic_halt_usd' }, 400);
    } else {
      fields.programmatic_halt_usd = v === 0 ? null : v; // 0 means OFF
    }
  }
  const updated = await updateProfile(userId, fields);
  return c.json(updated);
});
