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
import { getTodayTokenCostUsd } from "../db/token-usage-dal.ts";
import { sql } from "../db/postgres.ts";
import { getUserLicenseFields, getPendingPrompts, dismissLocalSession } from "../db/dal.ts";
import { TASK_TEMPLATES } from "../scheduler/task-templates.ts";

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
    "Returns the authenticated user's real accumulated token spend so far today (the same figure the daily cost cap enforces — interactive, Telegram, webhook and scheduled-run turns), their configured daily cap, and percent consumed. Used by the cost-cap UI banner.",
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
  const spent = await getTodayTokenCostUsd(userId, tz);
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

// GET /api/profile/license — license status snapshot for the authenticated user.
// NOT license-gated (this IS the license-status endpoint — circular dep otherwise).
// Auth-gated only. Reads users row via Plan D's getUserLicenseFields DAL helper.
const licenseStatusRoute = createRoute({
  method: "get",
  path: "/api/profile/license",
  tags: ["profile"],
  summary: "License status for the authenticated user",
  description:
    "Returns the user's current license status (mirrored from Titanium Licensing), license id, and the timestamp of the last sync. Used by the web UI's license badge. Auth-gated; NOT license-gated — needed even when the license is expired so the user can see why.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "License snapshot",
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum([
              "active",
              "expired",
              "suspended",
              "banned",
              "none",
              "unknown",
            ]),
            license_id: z.string().nullable(),
            checked_at: z.string().nullable(),
          }),
        },
      },
    },
    401: {
      description: "Missing or invalid session",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
});

type LicenseStatus =
  | "active"
  | "expired"
  | "suspended"
  | "banned"
  | "none"
  | "unknown";

function normalizeLicenseStatus(raw: string | null | undefined): LicenseStatus {
  if (!raw) return "none";
  const s = String(raw).toLowerCase();
  if (s === "active" || s === "valid") return "active";
  if (s === "expired") return "expired";
  if (s === "suspended") return "suspended";
  if (s === "banned") return "banned";
  if (s === "none") return "none";
  return "unknown";
}

openapi.openapi(licenseStatusRoute, async (c) => {
  const userId = c.get("userId") as string;
  const row = await getUserLicenseFields(userId);
  if (!row) {
    return c.json(
      { status: "none" as const, license_id: null, checked_at: null },
      200,
    );
  }
  return c.json(
    {
      status: normalizeLicenseStatus(row.license_status),
      license_id: row.license_id ?? null,
      checked_at: row.license_checked_at
        ? row.license_checked_at.toISOString()
        : null,
    },
    200,
  );
});

// ── Phase 08 plan 004 — sessions: pending-prompts + dismiss-local ────────────

const PendingPromptSchema = z.object({
  hostname: z.string(),
  project_dir: z.string(),
  is_git_repo: z.boolean(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});

const pendingPromptsRoute = createRoute({
  method: "get",
  path: "/api/sessions/pending-prompts",
  tags: ["Sessions"],
  summary: "List local folders awaiting GitHub classification",
  description:
    "Returns folders the user's agent/supervisor has reported as not-yet-on-GitHub (or not a git repo at all) and that the user has NOT dismissed. Drives the 'Needs attention' section of the sidebar. See Phase 08 ARCHITECTURE §6.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Pending local repos for the authenticated user",
      content: {
        "application/json": {
          schema: z.object({ pending: z.array(PendingPromptSchema) }),
        },
      },
    },
    401: {
      description: "Missing or invalid JWT",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
});

const dismissLocalRoute = createRoute({
  method: "post",
  path: "/api/sessions/dismiss-local",
  tags: ["Sessions"],
  summary: "Dismiss a pending local folder",
  description:
    "Records a user dismissal for `(hostname, project_dir)` and removes the row from `pending_local_repos`. Idempotent — repeated calls return 200 without duplicating dismissals.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            hostname: z.string().min(1).max(255),
            project_dir: z.string().min(1).max(4096),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Dismissed",
      content: {
        "application/json": { schema: z.object({ dismissed: z.literal(true) }) },
      },
    },
    400: {
      description: "Invalid body",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
    401: {
      description: "Missing or invalid JWT",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
});

openapi.use("/api/sessions/*", authMiddleware);

openapi.openapi(pendingPromptsRoute, async (c) => {
  const userId = c.get("userId") as string;
  const pending = await getPendingPrompts(userId);
  // postgres `timestamptz` round-trips as Date — coerce to ISO string for the
  // OpenAPI shape contract.
  const serialized = pending.map((p) => ({
    hostname: p.hostname,
    project_dir: p.project_dir,
    is_git_repo: p.is_git_repo,
    first_seen_at:
      p.first_seen_at instanceof Date ? p.first_seen_at.toISOString() : String(p.first_seen_at),
    last_seen_at:
      p.last_seen_at instanceof Date ? p.last_seen_at.toISOString() : String(p.last_seen_at),
  }));
  return c.json({ pending: serialized }, 200);
});

openapi.openapi(dismissLocalRoute, async (c) => {
  const userId = c.get("userId") as string;
  const body = c.req.valid("json");
  await dismissLocalSession(userId, body.hostname, body.project_dir);
  return c.json({ dismissed: true as const }, 200);
});

// ── Scheduled tasks: GSD template catalog (read-only) ───────────────────────
// Documented twin of the plain-Hono `GET /api/tasks/templates` in `./tasks.ts`.
// The plain route serves traffic; this declaration only contributes to the
// spec. The static catalog lives in `hub/src/scheduler/task-templates.ts`.

const TaskTemplateSchema = z.object({
  id: z.enum(["gsd_run", "gsd_audit", "gsd_review", "gsd_plan"]),
  label: z.string(),
  description: z.string(),
  promptTemplate: z.string(),
  taskType: z.literal("dev"),
  defaultCron: z.string(),
  cadenceLabel: z.string(),
  requiredInputs: z.array(z.enum(["target_session", "cadence"])),
  guardrails: z.object({
    planFirst: z.boolean(),
    autoMerge: z.boolean(),
    inheritCostCap: z.literal(true),
  }),
  defaultPostRunActions: z.array(
    z.object({
      type: z.enum(["notify_telegram", "github_issue"]),
      on: z.enum(["success", "failure", "always"]),
      config: z.record(z.any()),
    }),
  ),
  category: z.literal("gsd"),
});

const taskTemplatesRoute = createRoute({
  method: "get",
  path: "/api/tasks/templates",
  tags: ["Tasks"],
  summary: "Predefined GSD scheduled-task templates",
  description:
    "Returns the static, read-only catalog of GSD task templates (Run dev, Audit, Review PRs, Plan). A template pre-fills a normal scheduled-task CREATE — it is sugar over the existing payload (no new table). Each carries an injected GSD slash prompt, default cadence, guardrails (non-bypassable cost cap, plan-first), and default post-run actions.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "GSD template catalog",
      content: {
        "application/json": {
          schema: z.object({ templates: z.array(TaskTemplateSchema) }),
        },
      },
    },
    401: {
      description: "Missing or invalid session",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
});

openapi.use("/api/tasks/*", authMiddleware);
openapi.openapi(taskTemplatesRoute, (c) => {
  return c.json({ templates: TASK_TEMPLATES }, 200);
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
      "REST API for the remo-code hub. Routes are migrated to the OpenAPI surface incrementally; currently covers `/api/profile/cost-today` and `/api/profile/license`. The rest of the hub is plain Hono.",
  },
  servers: [
    { url: "https://app.remo-code.com", description: "Production" },
    { url: "http://localhost:3040", description: "Local dev" },
  ],
});

// Scalar UI at /docs
openapi.get("/docs", Scalar({ url: "/openapi.json", theme: "default" }));
