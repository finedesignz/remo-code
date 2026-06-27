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

// ── Repo grouping (per-user, many-to-many) ──────────────────────────────────
// Spec-only registration. The plain-Hono router in `./repo-groups.ts` serves
// traffic (it owns param-route ordering); these `registerPath` calls only
// contribute to the OpenAPI spec, so there is NO double-mount.
{
  const Err = z.object({ error: z.string() });
  const RepoIdent = z
    .string()
    .openapi({ example: "github://acme/app", description: "github://owner/repo or path://<abs>" });
  const GroupMember = z.object({ repo_ident: RepoIdent, created_at: z.string() });
  const Group = z.object({
    id: z.string().uuid(),
    name: z.string(),
    sort_order: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  });
  const GroupWithMembers = Group.extend({ members: z.array(GroupMember) });
  const json = (schema: any) => ({ content: { "application/json": { schema } } });
  const reg = openapi.openAPIRegistry;
  const base = { tags: ["repo-groups"], security: [{ bearerAuth: [] }] } as const;

  reg.registerPath({
    method: "get",
    path: "/api/repo-groups",
    summary: "List the user's repo groups with members",
    ...base,
    responses: {
      200: { description: "Groups", ...json(z.object({ groups: z.array(GroupWithMembers) })) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "post",
    path: "/api/repo-groups",
    summary: "Create a repo group",
    ...base,
    request: { body: json(z.object({ name: z.string().min(1).max(64) })) },
    responses: {
      201: { description: "Created", ...json(Group) },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      409: { description: "Group name already exists", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "put",
    path: "/api/repo-groups/reorder",
    summary: "Bulk-reorder groups by id",
    ...base,
    request: { body: json(z.object({ ordered_ids: z.array(z.string().uuid()) })) },
    responses: {
      204: { description: "Reordered" },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "patch",
    path: "/api/repo-groups/{id}",
    summary: "Rename and/or reorder a group",
    ...base,
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: json(z.object({ name: z.string().min(1).max(64).optional(), sort_order: z.number().int().optional() })),
    },
    responses: {
      200: { description: "Updated", ...json(Group) },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Not found", ...json(Err) },
      409: { description: "Group name already exists", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "delete",
    path: "/api/repo-groups/{id}",
    summary: "Delete a group (members cascade)",
    ...base,
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      204: { description: "Deleted" },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "post",
    path: "/api/repo-groups/{id}/members",
    summary: "Add a repo to a group (idempotent)",
    ...base,
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: json(z.object({ repo_ident: RepoIdent })),
    },
    responses: {
      204: { description: "Added" },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "put",
    path: "/api/repo-groups/{id}/members",
    summary: "Replace a group's full member set",
    ...base,
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: json(z.object({ repo_idents: z.array(RepoIdent) })),
    },
    responses: {
      204: { description: "Replaced" },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "delete",
    path: "/api/repo-groups/{id}/members/{repo_ident}",
    summary: "Remove a repo from a group (repo_ident URL-encoded)",
    ...base,
    request: { params: z.object({ id: z.string().uuid(), repo_ident: z.string() }) },
    responses: {
      204: { description: "Removed" },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "get",
    path: "/api/repo-groups/collapse-state",
    summary: "Get per-user collapsed group-section ids",
    ...base,
    responses: {
      200: { description: "Collapse state", ...json(z.object({ collapsed_group_ids: z.array(z.string()) })) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "patch",
    path: "/api/repo-groups/collapse-state",
    summary: "Replace per-user collapsed group-section ids",
    ...base,
    request: { body: json(z.object({ collapsed_group_ids: z.array(z.string()) })) },
    responses: {
      200: { description: "Collapse state", ...json(z.object({ collapsed_group_ids: z.array(z.string()) })) },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
    },
  });
}
// ── Auto-dev orchestrator task config (Phase 31) ────────────────────────────
// Spec-only registration. The plain-Hono router in `./orchestrator-tasks.ts`
// serves traffic; these declarations only contribute to the OpenAPI spec.
{
  const Err = z.object({ error: z.string() });
  const json = (schema: any) => ({ content: { "application/json": { schema } } });
  const reg = openapi.openAPIRegistry;
  const base = { tags: ["orchestrator-tasks"], security: [{ bearerAuth: [] }] } as const;
  const Stage = z.enum(["development", "beta", "production-maintenance"]);
  // Milestone TMAC: the macro task_type driving the autonomous routine prompt.
  const MacroType = z.enum(["dev", "maintenance", "security", "brainstorming"]);
  const ScheduleRule = z
    .object({
      interval: z.number().int(),
      unit: z.enum(["minutes", "hours", "days", "weeks", "months"]),
      start_at: z.string(),
    })
    .passthrough()
    .nullable();
  const OrchestratorTask = z.object({
    id: z.string(),
    user_id: z.string(),
    session_id: z.string().nullable(),
    name: z.string(),
    lifecycle_stage: Stage,
    macro_task_type: MacroType,
    enabled: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  });
  const OrchestratorRow = z.object({
    id: z.string(),
    task_id: z.string(),
    command: z.string(),
    enabled: z.boolean(),
    schedule_rule: ScheduleRule,
    frequency_label: z.string().nullable(),
    micro_prompt: z.string().nullable(),
    sort_order: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  });
  const TaskWithRows = z.object({
    task: OrchestratorTask.nullable(),
    rows: z.array(OrchestratorRow),
  });

  reg.registerPath({
    method: "get",
    path: "/api/orchestrator-tasks/{sessionId}",
    summary: "Get a session's orchestrator task + its rows (task null if none)",
    ...base,
    request: { params: z.object({ sessionId: z.string() }) },
    responses: {
      200: { description: "Task + rows", ...json(TaskWithRows) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Session not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "post",
    path: "/api/orchestrator-tasks/{sessionId}",
    summary: "Create the one orchestrator task for a session",
    ...base,
    request: {
      params: z.object({ sessionId: z.string() }),
      body: json(
        z.object({
          lifecycle_stage: Stage.optional(),
          name: z.string().optional(),
          macro_task_type: MacroType.optional(),
        }),
      ),
    },
    responses: {
      201: { description: "Created", ...json(TaskWithRows) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Session not found", ...json(Err) },
      409: { description: "Session already has an orchestrator task", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "patch",
    path: "/api/orchestrator-tasks/{taskId}",
    summary: "Update the task's lifecycle stage and/or macro task type",
    ...base,
    request: {
      params: z.object({ taskId: z.string() }),
      // EITHER field (or both); at least one required (route enforces via .refine).
      body: json(
        z.object({
          lifecycle_stage: Stage.optional(),
          macro_task_type: MacroType.optional(),
        }),
      ),
    },
    responses: {
      200: { description: "Updated", ...json(z.object({ task: OrchestratorTask })) },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Task not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "post",
    path: "/api/orchestrator-tasks/{taskId}/apply-preset",
    summary: "Apply a lifecycle-stage frequency preset to the rows",
    ...base,
    request: {
      params: z.object({ taskId: z.string() }),
      body: json(z.object({ stage: Stage.optional(), overwrite: z.boolean().optional() })),
    },
    responses: {
      200: { description: "Preset applied", ...json(z.object({ result: z.any(), rows: z.array(OrchestratorRow) })) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Task not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "post",
    path: "/api/orchestrator-tasks/{taskId}/rows",
    summary: "Add a command row or a micro-prompt row",
    ...base,
    request: {
      params: z.object({ taskId: z.string() }),
      body: json(
        z.object({
          command: z.string().optional(),
          micro_prompt: z.string().optional(),
          enabled: z.boolean().optional(),
          frequency_label: z.string().optional(),
          schedule_rule: ScheduleRule.optional(),
          sort_order: z.number().int().optional(),
        }),
      ),
    },
    responses: {
      201: { description: "Created", ...json(z.object({ row: OrchestratorRow })) },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Task not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "patch",
    path: "/api/orchestrator-tasks/rows/{rowId}",
    summary: "Update a row (enabled / frequency / schedule_rule / micro_prompt / sort_order)",
    ...base,
    request: {
      params: z.object({ rowId: z.string() }),
      body: json(
        z.object({
          enabled: z.boolean().optional(),
          frequency_label: z.string().nullable().optional(),
          micro_prompt: z.string().nullable().optional(),
          schedule_rule: ScheduleRule.optional(),
          sort_order: z.number().int().optional(),
        }),
      ),
    },
    responses: {
      200: { description: "Updated", ...json(z.object({ row: OrchestratorRow })) },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Row not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "delete",
    path: "/api/orchestrator-tasks/rows/{rowId}",
    summary: "Delete a row",
    ...base,
    request: { params: z.object({ rowId: z.string() }) },
    responses: {
      200: { description: "Deleted", ...json(z.object({ ok: z.boolean() })) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Row not found", ...json(Err) },
    },
  });
  reg.registerPath({
    method: "post",
    path: "/api/orchestrator-tasks/{taskId}/rows/reorder",
    summary: "Bulk-reorder a task's rows by id",
    ...base,
    request: {
      params: z.object({ taskId: z.string() }),
      body: json(z.object({ ordered_ids: z.array(z.string()) })),
    },
    responses: {
      200: { description: "Reordered", ...json(z.object({ rows: z.array(OrchestratorRow) })) },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing or invalid JWT", ...json(Err) },
      404: { description: "Task not found", ...json(Err) },
    },
  });
}
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

// ── Orchestrator run-log (OBSRV-01 / RUNLOG-01/02) ──────────────────────────
// Spec-only registration — the plain-Hono router in `./orchestrator.ts` serves
// traffic. This contributes to the OpenAPI spec without duplicating handler logic.
{
  const RunLogItem = z.object({
    id: z.string(),
    session_id: z.string(),
    repo_key: z.string().nullable(),
    command: z.string(),
    decision_rationale: z.string().nullable(),
    outcome: z.string().nullable(),
    gap_dimension: z.string().nullable(),
    pr_url: z.string().nullable(),
    reviewer_verdict: z.string().nullable(),
    deploy_verify_result: z.string().nullable(),
    created_at: z.string(),
  });
  const reg = openapi.openAPIRegistry;
  reg.registerPath({
    method: "get",
    path: "/api/orchestrator/run-log",
    tags: ["orchestrator"],
    summary: "Paginated run-log for the authenticated user",
    description:
      "Returns routine_run_log rows scoped to the authenticated user, newest first. " +
      "Pass `session_id` to narrow to a single session; omit for all sessions. " +
      "Read-only — zero impact on the dispatch path, gates, or caps.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50).optional()
          .openapi({ description: "Page size (1–200, default 50)" }),
        offset: z.coerce.number().int().min(0).default(0).optional()
          .openapi({ description: "Row offset for pagination (default 0)" }),
        session_id: z.string().optional()
          .openapi({ description: "Filter to a single session (must belong to the authenticated user)" }),
      }),
    },
    responses: {
      200: {
        description: "Paginated run-log entries",
        content: {
          "application/json": {
            schema: z.object({
              items: z.array(RunLogItem),
              limit: z.number(),
              offset: z.number(),
            }),
          },
        },
      },
      400: {
        description: "Invalid query parameters",
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
      },
      401: {
        description: "Missing or invalid session",
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
      },
    },
  });
}

// ── Feedback intake (Option A) — public end-user feedback webhook ───────────
// Spec-only registration. The plain-Hono router in `./feedback-webhook.ts`
// serves traffic (mounted public, BEFORE the JWT catch-all); this only
// contributes to the OpenAPI spec. No security scheme — the URL :token IS the
// credential.
{
  const json = (schema: any) => ({ content: { "application/json": { schema } } });
  const reg = openapi.openAPIRegistry;
  reg.registerPath({
    method: "post",
    path: "/api/feedback/{token}",
    tags: ["feedback"],
    summary: "Submit end-user feedback (screenshot + description) into the bound session",
    description:
      "Public, unauthenticated-by-design. The opaque `fb_` token in the URL IS the credential (SHA-256-hashed lookup against feedback_keys). Accepts a bug description, optional screenshot (base64 data-URI), page URL, and captured console errors, and dispatches them into the app's bound remo-code session via the shared cost-capped dispatch pipeline. Bounded by per-token + per-IP rate limits and the non-bypassable daily cost cap.",
    request: {
      params: z.object({ token: z.string().openapi({ example: "fb_AbC123..." }) }),
      body: json(
        z.object({
          comment: z.string().min(1).max(5000).openapi({ description: "Required bug/feedback description." }),
          screenshot: z.string().optional().openapi({ description: "Optional base64 data-URI image (image/png|jpeg|gif|webp), ≤~10MB." }),
          page_url: z.string().optional(),
          console_errors: z.string().max(20000).optional(),
        }),
      ),
    },
    responses: {
      202: { description: "Accepted + dispatched (fire-and-forget)", ...json(z.object({ ok: z.boolean(), status: z.string() })) },
      400: { description: "Missing/invalid comment or screenshot", ...json(z.object({ error: z.string() })) },
      403: { description: "Feedback key disabled", ...json(z.object({ error: z.string() })) },
      404: { description: "Unknown token", ...json(z.object({ error: z.string() })) },
      413: { description: "Payload too large (comment/screenshot/console_errors cap)", ...json(z.object({ error: z.string() })) },
      429: { description: "Rate limited (per-token or per-IP)", ...json(z.object({ error: z.string() })) },
    },
  });
}

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
