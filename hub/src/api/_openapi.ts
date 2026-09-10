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

// ── /api/ext — external session-ask API (milestone ASK) ─────────────────────
// Spec-only registration; `./ext.ts` (plain Hono) serves traffic. Auth is an
// api_key Bearer (`apiKeyAuth`), NOT the cookie/JWT session. See docs/session-ask.md.
{
  const Err = z.object({ error: z.string(), detail: z.string().optional() });
  const json = (schema: any) => ({ content: { "application/json": { schema } } });
  const reg = openapi.openAPIRegistry;
  const base = { tags: ["ext"], security: [{ apiKeyAuth: [] }] } as const;
  const SessionParam = z.object({
    id: z.string().openapi({
      param: { name: "id", in: "path" },
      description: "Session id, repo_ident (github://owner/repo | path://<abs>), or repo name",
      example: "github://finedesignz/remo-code",
    }),
  });
  const Ask = z.object({
    ask_id: z.string(),
    status: z.enum(["queued", "dispatched", "answered", "timeout", "skipped", "failed"]),
    answer: z.string().nullable(),
    confidence: z.string().nullable(),
    evidence: z.array(z.string()).nullable(),
    reason: z.string().nullable().openapi({
      description:
        "Why a non-answered ask ended that way — e.g. over_daily_cost_cap, over_daily_token_cap, over_ask_rate, automation_blocked_on_pty:external-ask, session_offline, ask_timeout.",
    }),
    raw_reply: z.string().nullable(),
    created_at: z.string(),
    answered_at: z.string().nullable(),
  });

  reg.registerPath({
    method: "get",
    path: "/api/ext/sessions",
    summary: "List the caller's sessions (FREE — zero tokens)",
    ...base,
    responses: {
      200: {
        description: "Sessions",
        ...json(
          z.object({
            sessions: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                repo_ident: z.string().nullable(),
                project_dir: z.string().nullable(),
                runner_type: z.string(),
                active: z.boolean(),
                last_activity: z.string().nullable(),
              }),
            ),
          }),
        ),
      },
      401: { description: "Missing/invalid api key", ...json(Err) },
      403: { description: "Key lacks the ext:read scope", ...json(Err) },
    },
  });

  reg.registerPath({
    method: "get",
    path: "/api/ext/sessions/{id}/transcript",
    summary: "Tail of the session's on-disk CLI transcript (FREE — zero tokens, no PTY write)",
    description:
      "Proxied to the supervisor host's allowlisted READ-ONLY `session_transcript_tail` command. Works for pty-interactive sessions too. Byte-capped.",
    ...base,
    request: {
      params: SessionParam,
      query: z.object({ tail: z.coerce.number().int().min(1).max(200).optional() }),
    },
    responses: {
      200: {
        description: "Transcript tail",
        ...json(
          z.object({
            session_id: z.string(),
            turns: z.array(z.object({ role: z.string(), text: z.string() })),
            truncated: z.boolean(),
          }),
        ),
      },
      401: { description: "Missing/invalid api key", ...json(Err) },
      404: { description: "No such session", ...json(Err) },
      409: { description: "Session has no project_dir", ...json(Err) },
      502: { description: "Supervisor could not read the transcript", ...json(Err) },
      503: { description: "No (or ambiguous) online supervisor for this user", ...json(Err) },
    },
  });

  reg.registerPath({
    method: "get",
    path: "/api/ext/sessions/{id}/memory",
    summary: "The session project's memory files (FREE — zero tokens, no PTY write)",
    ...base,
    request: { params: SessionParam },
    responses: {
      200: {
        description: "Memory files",
        ...json(
          z.object({
            session_id: z.string(),
            files: z.array(z.object({ name: z.string(), content: z.string() })),
            truncated: z.boolean(),
          }),
        ),
      },
      401: { description: "Missing/invalid api key", ...json(Err) },
      404: { description: "No such session", ...json(Err) },
      502: { description: "Supervisor could not read memory", ...json(Err) },
      503: { description: "No (or ambiguous) online supervisor", ...json(Err) },
    },
  });

  reg.registerPath({
    method: "get",
    path: "/api/ext/sessions/{id}/state",
    summary: "Cheap status roll-up for a session (FREE)",
    ...base,
    request: { params: SessionParam },
    responses: {
      200: {
        description: "State",
        ...json(
          z.object({
            session_id: z.string(),
            repo_ident: z.string().nullable(),
            runner_type: z.string(),
            active: z.boolean(),
            status: z.string(),
            last_activity: z.string().nullable(),
            last_assistant_message_at: z.string().nullable(),
            open_session_runs: z.number().int(),
          }),
        ),
      },
      401: { description: "Missing/invalid api key", ...json(Err) },
      404: { description: "No such session", ...json(Err) },
    },
  });

  reg.registerPath({
    method: "post",
    path: "/api/ext/sessions/{id}/ask",
    summary: "Ask the session a question (PAID — spends tokens)",
    description:
      "Dispatches a short-lived stream-json ask-session bound to the target's project_dir (the human's PTY is NEVER written to). Rides the non-bypassable daily cost cap + daily token cap + human-only-PTY guard + per-key ask-rate ceiling. `wait_ms` long-polls up to 120s; on expiry poll the ask endpoint.",
    ...base,
    request: {
      params: SessionParam,
      body: json(
        z.object({
          question: z.string().min(1).max(8000),
          context: z.string().max(8000).optional(),
          wait_ms: z.number().int().min(0).max(120000).optional(),
          include_transcript: z.boolean().optional(),
          include_memory: z.boolean().optional(),
        }),
      ),
    },
    responses: {
      202: { description: "Ask created (answer inline when the long-poll caught it)", ...json(Ask) },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing/invalid api key", ...json(Err) },
      403: { description: "Key lacks the ext:ask scope", ...json(Err) },
      404: { description: "No such session", ...json(Err) },
      409: { description: "No stream-json ask session for this project_dir", ...json(Err) },
    },
  });

  reg.registerPath({
    method: "get",
    path: "/api/ext/sessions/{id}/ask/{ask_id}",
    summary: "Poll an ask (no new tokens)",
    ...base,
    request: {
      params: SessionParam.extend({
        ask_id: z.string().openapi({ param: { name: "ask_id", in: "path" } }),
      }),
    },
    responses: {
      200: { description: "Ask", ...json(Ask) },
      401: { description: "Missing/invalid api key", ...json(Err) },
      404: { description: "No such ask", ...json(Err) },
    },
  });

  // ── Milestone WORK: inbound-email → repo agent → QC → gated publish ────────
  const Work = z
    .object({
      work_id: z.string(),
      session_id: z.string().optional(),
      status: z.enum([
        "queued",
        "dispatched",
        "verifying",
        "completed",
        "qc_failed",
        "needs_human",
        "timeout",
        "skipped",
        "failed",
      ]),
      summary: z.string().nullable(),
      branch: z.string().nullable().openapi({
        description: "The branch the agent pushed. Its authority ends here — it does not deploy, publish or merge.",
      }),
      files_changed: z.array(z.string()).openapi({
        description: "HUB-OBSERVED — derived from the branch diff, not from the agent's claimed file list.",
      }),
      commit_shas: z.array(z.string()),
      hub_qc: z.unknown().nullable().openapi({
        description:
          "HUB-OBSERVED evidence: the diff-scope check (every file under work_sites.site_dir), the real build exit code, and the hub's own HTTPS probe. This — not the agent — gates the publish.",
      }),
      agent_self_check: z.unknown().nullable().openapi({
        description: "The agent's self-report. ADVISORY metadata only; never the basis of a publish decision.",
      }),
      deploy_status: z.string().nullable().openapi({
        description: "not_permitted | qc_failed | branch_moved_after_qc | merge_failed | deploy_failed | live_probe_failed | published",
      }),
      diff_url: z.string().nullable(),
      pr_url: z.string().nullable(),
      preview_url: z.string().nullable(),
      published: z.boolean().openapi({
        description:
          "TRUE only when the HUB ITSELF performed the deploy (site.auto_publish AND hub-verified diff-scope AND hub-verified build AND hub-verified 2xx probe). The agent cannot set it; finalizeWork also ANDs it with the site flag in SQL as a backstop.",
      }),
      live_url: z.string().nullable(),
      blocker: z.string().nullable().openapi({
        description: "e.g. suspected_injection, unparseable_reply, or why a human is needed.",
      }),
      reason: z.string().nullable().openapi({
        description:
          "Why a non-terminal-success work item ended that way — over_daily_cost_cap, over_daily_token_cap, over_work_rate, repo_not_allowlisted, automation_blocked_on_pty:external-work, session_offline, work_timeout.",
      }),
      auto_publish: z.boolean(),
      repo_ident: z.string(),
      site_key: z.string(),
    })
    .openapi("ExtWork");

  reg.registerPath({
    method: "post",
    path: "/api/ext/work",
    summary: "Inbound client request → repo agent → QC → GATED publish (PAID — writes code)",
    description:
      "Points an UNTRUSTED inbound client email at the repo's stream-json session. THE AGENT PROPOSES, THE HUB DISPOSES: the agent's authority ends at a pushed `work/<id>` branch (it has no deploy credentials and is not even told whether the site auto-publishes). The HUB then verifies the branch diff touches ONLY `work_sites.site_dir`, runs the build itself, probes the site over real HTTPS, and performs the merge + deploy itself — only when the site carries `auto_publish=true`. Entry containment (all default-OFF): the repo must be in `work_repo_allowlist` (403 otherwise — no dispatch, no spend); the site must exist in `work_sites`; `source.from` must match that site's `client_emails` (403 `unknown_sender`). Rides the non-bypassable daily cost + token caps, the human-only-PTY guard, and a per-user work-rate ceiling (REMO_WORK_MAX_PER_HOUR, default 4).",
    ...base,
    request: {
      body: json(
        z.object({
          repo: z.string().min(1),
          site: z.string().min(1),
          request_text: z.string().min(1).max(20000),
          source: z.object({
            kind: z.literal("email"),
            from: z.string().min(1).max(320),
            subject: z.string().max(2000).optional(),
            message_id: z.string().max(998).optional(),
          }),
          wait_ms: z.number().int().min(0).max(120000).optional(),
        }),
      ),
    },
    responses: {
      202: { description: "Work item created", ...json(Work) },
      400: { description: "Invalid body", ...json(Err) },
      401: { description: "Missing/invalid api key", ...json(Err) },
      403: {
        description:
          "Key lacks the ext:work scope, OR repo_not_allowlisted, OR unknown_site, OR unknown_sender — no dispatch, no spend.",
        ...json(Err),
      },
      404: { description: "No session for that repo", ...json(Err) },
      409: { description: "No stream-json session for this project_dir", ...json(Err) },
    },
  });

  reg.registerPath({
    method: "get",
    path: "/api/ext/work/{work_id}",
    summary: "Poll a work item (no new tokens)",
    ...base,
    request: {
      params: z.object({
        work_id: z.string().openapi({ param: { name: "work_id", in: "path" } }),
      }),
    },
    responses: {
      200: { description: "Work item", ...json(Work) },
      401: { description: "Missing/invalid api key", ...json(Err) },
      404: { description: "No such work item", ...json(Err) },
    },
  });
}

// OpenAPI security scheme registration.
openapi.openAPIRegistry.registerComponent("securitySchemes", "apiKeyAuth", {
  type: "http",
  scheme: "bearer",
  description:
    "A remo-code api_key (`remokey_…`) from Settings → Credentials. Optional scopes: `ext:read` (free reads) and `ext:ask` (spends tokens). A key with NULL scopes keeps legacy full access.",
});
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
