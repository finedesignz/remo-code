/**
 * Inbound revanote webhook payload schema (Phase 08).
 *
 * Cross-side contract: revanote sends `source: 'revanote'`,
 * `revanote_version`, and (when configured) `annotation_url`. The rest mirrors
 * the legacy `revanote-hook/server.js` reference impl. See
 * `.planning/phases/08-revanote-integration/08-CONTEXT.md` §"Confirmed
 * cross-side contract".
 *
 * Unknown fields are preserved on the row via `annotations.payload_raw`, so
 * the schema can stay strict-ish without churning when revanote adds new
 * cosmetic fields.
 */
import { z } from 'zod'

const Reply = z.object({
  author: z.string().optional(),
  text: z.string().optional(),
  ts: z.string().optional(),
}).passthrough()

// `.nullable()` alongside `.optional()` throughout this schema: every field
// below is consumed downstream via `?? null` / `?? default` / `typeof x ===`
// / `Array.isArray(x)` guards (revanote-webhook.ts, run-lifecycle.ts,
// merge-gate.ts), which already treat `null` identically to absent — so
// widening the schema to accept an explicit `null` is a pure availability
// fix with no behavior change for existing callers. Fields that already had
// `.nullable()` (annotation_url, screenshot_url, x, y, element_selector) were
// the precedent; the rest had the same gap (05-QC BLOCKER 4 + corroborating
// sibling-field inconsistency finding) — a caller sending `null` for any of
// them got a hard 400 and the whole annotation dropped instead of degrading
// gracefully.
export const RevanotePayload = z.object({
  source: z.literal('revanote').optional().nullable(),
  // Accept both `1` and `'1'` — revanote shipped the number form for a while.
  revanote_version: z.union([z.string(), z.number()]).optional().nullable(),
  annotation_id: z.string().min(1).max(256),
  annotation_url: z.string().url().optional().nullable(),
  page_url: z.string().min(1).max(4096),
  screenshot_url: z.string().optional().nullable(),
  // Coerce: revanote reads these from a Postgres `numeric`, which its driver
  // hands back as a string.
  x: z.coerce.number().optional().nullable(),
  y: z.coerce.number().optional().nullable(),
  element_selector: z.string().optional().nullable(),
  element_meta: z.unknown().optional(),
  capture_viewport: z.unknown().optional(),
  comment: z.string().min(1).max(20_000),
  comment_preview: z.string().optional().nullable(),
  replies: z.array(Reply).default([]).optional().nullable(),
  callback_url: z.string().url(),
  // Optional clock sync field (epoch seconds). When present we enforce a
  // 5-min skew window (mirrors the legacy Coolify HMAC route).
  timestamp: z.number().optional().nullable(),
  // Phase 5 batched-secure-dispatch additions (revanote ships these when
  // batched; absent on single-fire dispatch). All optional, all persisted to
  // `payload_raw` so existing code paths still work without touching schema.
  batch_id: z.string().uuid().optional().nullable(),
  batch_size: z.number().int().positive().optional().nullable(),
  batch_index: z.number().int().min(0).optional().nullable(),
  repo_slug: z.string().min(1).max(512).optional().nullable(),
  repo_kind: z.enum(['github', 'local_path']).optional().nullable(),
  // Phase 5 — best-guess-default fix contract (additive, optional). Already
  // survives via the outer .passthrough() into payload_raw; typed here so
  // prompt.ts gets a typed field instead of an untyped cast, and so this
  // schema regression-tests the shape if revanote ever changes it.
  //
  // BLOCKER 4 (05-QC.md): `fix_contract: null` (e.g. an annotation dispatched
  // for a client with no contract configured) must degrade to the
  // no-contract prompt path in prompt.ts (`fixContract` there is already
  // `?? null`-normalized), not hard-400 and drop the whole annotation.
  fix_contract: z
    .object({
      version: z.number().optional().nullable(),
      default: z.string().optional().nullable(),
      ask_reasons: z.array(z.string()).optional().nullable(),
    })
    .passthrough()
    .optional()
    .nullable(),
}).passthrough()

export type RevanotePayload = z.infer<typeof RevanotePayload>
