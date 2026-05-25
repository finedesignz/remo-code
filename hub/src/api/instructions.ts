import { Hono } from 'hono'
import { z } from 'zod'
import { getUserInstructions, updateUserInstructions } from '../db/dal'

export const instructions = new Hono()

const FieldSchema = z.string().max(100_000).nullable().optional()
const PutBody = z.object({
  claude_global_md: FieldSchema,
  codex_agents_md: FieldSchema,
  codex_config_toml: FieldSchema,
})

// Strip lines that look like secrets from a TOML blob.
// Matches keys: api_key, api-key, apikey, token, secret, password (case-insensitive).
const SECRET_KEY_RE = /^\s*(api[_-]?key|apikey|token|secret|password)\s*=/i
function sanitizeToml(input: string | null | undefined): { sanitized: string | null; stripped: number } {
  if (input == null) return { sanitized: null, stripped: 0 }
  const kept: string[] = []
  let stripped = 0
  for (const line of input.split(/\r?\n/)) {
    if (SECRET_KEY_RE.test(line)) {
      stripped++
      continue
    }
    kept.push(line)
  }
  return { sanitized: kept.join('\n'), stripped }
}

instructions.get('/', async (c) => {
  const userId = c.get('userId') as string
  return c.json(await getUserInstructions(userId))
})

instructions.put('/', async (c) => {
  const userId = c.get('userId') as string
  const json = await c.req.json().catch(() => null)
  const parsed = PutBody.safeParse(json)
  if (!parsed.success) {
    return c.json({ error: 'invalid input', detail: parsed.error.flatten() }, 400)
  }
  const patch = { ...parsed.data }
  let strippedCount = 0
  if (patch.codex_config_toml !== undefined) {
    const { sanitized, stripped } = sanitizeToml(patch.codex_config_toml)
    patch.codex_config_toml = sanitized
    strippedCount = stripped
  }
  const updated = await updateUserInstructions(userId, patch)
  return c.json({ ...updated, stripped_secret_lines: strippedCount })
})
