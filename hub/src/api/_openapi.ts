// OpenAPI spec + Scalar UI mount.
//
// Phase 1 of docs standardization: only a single sample route is wired into the
// OpenAPI surface here (the read-only `/api/profile/cost-today` endpoint, re-
// declared with Zod schemas) so that `/openapi.json` and `/docs` come online
// without forcing a wholesale refactor of every plain-Hono router.
//
// Future routes get migrated by being defined on `openapi` here (or in their
// own module that exports an `OpenAPIHono` subrouter), then **removed** from
// their plain-Hono twin so we don't double-mount.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { authMiddleware } from "../auth/middleware.ts";
import { sumTodayCostForUser } from "../db/scheduled-tasks-dal.ts";
import { sql } from "../db/postgres.ts";

export const openapi = new OpenAPIHono();

// Sample documented route: GET /api/profile/cost-today
// This is intentionally a duplicate registration of the plain-Hono route in
// `./profile.ts`. The plain route still serves traffic; this declaration only
// contributes to the OpenAPI spec. When a route is fully migrated, delete the
// plain twin.
const costTodayRoute = createRoute({
  method: "get",
  path: "/api/profile/cost-today",
  tags: ["profile"],
  summary: "Today's spend + daily cost cap",
  description:
    "Returns the authenticated user's scheduled-task spend so far today, their configured daily cap, and percent consumed. Used by the cost-cap UI banner.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Cost snapshot for the current calendar day in the user's timezone",
      content: {
        "application/json": {
          schema: z.object({
            cost_usd: z.number(),
            cap_usd: z.number(),
            percent: z.number(),
            timezone: z.string(),
          }),
        },
      },
    },
    401: {
      description: "Missing or invalid JWT",
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
});

openapi.use("/api/profile/*", authMiddleware);
openapi.openapi(costTodayRoute, async (c) => {
  const userId = c.get("userId") as string;
  const rows = await sql<{ cap: string | null; timezone: string | null }[]>`
    SELECT daily_cost_cap_usd::text AS cap, timezone FROM users WHERE id = ${userId} LIMIT 1
  `;
  const cap = Number(rows[0]?.cap ?? 10);
  const tz = rows[0]?.timezone || "UTC";
  const spent = await sumTodayCostForUser(userId, tz);
  const percent = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  return c.json(
    {
      cost_usd: Number(spent.toFixed(4)),
      cap_usd: Number(cap.toFixed(4)),
      percent: Number(percent.toFixed(2)),
      timezone: tz,
    },
    200,
  );
});

// OpenAPI security scheme registration.
openapi.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// Spec at /openapi.json
openapi.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "remo-code hub",
    version: "0.1.0",
    description:
      "REST API for the remo-code hub. NOTE: Only the sample `/api/profile/cost-today` route is currently in the spec; the rest of the hub is plain Hono and will be migrated incrementally.",
  },
  servers: [
    { url: "https://app.remo-code.com", description: "Production" },
    { url: "http://localhost:3040", description: "Local dev" },
  ],
});

// Scalar UI at /docs
openapi.get("/docs", Scalar({ url: "/openapi.json", theme: "default" }));
