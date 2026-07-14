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

export const RevanotePayload = z.object({
  source: z.literal('revanote').optional(),
  // Accept both `1` and `'1'` — revanote shipped the number form for a while.
  revanote_version: z.union([z.string(), z.number()]).optional(),
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
  comment_preview: z.string().optional(),
  replies: z.array(Reply).default([]).optional(),
  callback_url: z.string().url(),
  // Optional clock sync field (epoch seconds). When present we enforce a
  // 5-min skew window (mirrors the legacy Coolify HMAC route).
  timestamp: z.number().optional(),
  // Phase 5 batched-secure-dispatch additions (revanote ships these when
  // batched; absent on single-fire dispatch). All optional, all persisted to
  // `payload_raw` so existing code paths still work without touching schema.
  batch_id: z.string().uuid().optional(),
  batch_size: z.number().int().positive().optional(),
  batch_index: z.number().int().min(0).optional(),
  repo_slug: z.string().min(1).max(512).optional(),
  repo_kind: z.enum(['github', 'local_path']).optional(),
}).passthrough()

export type RevanotePayload = z.infer<typeof RevanotePayload>
