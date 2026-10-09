/**
 * rotate-api-key — operator CLI to mint or rotate a user's API key WITHOUT the
 * browser (Settings → Credentials is otherwise the only path).
 *
 * WHY A SCRIPT AND NOT AN ENDPOINT: `/api/api-keys` is cookie-auth ONLY and an
 * api key must NEVER be able to mint an api key (privilege escalation — an
 * `ext:*`-only key could otherwise mint itself an `agent` key and spawn CLI
 * processes on a host; see hub/src/api/api-keys.ts and
 * hub/test/api-keys-scopes.test.ts). This script needs DATABASE_URL, i.e. it is
 * an operator-level action on the hub host, not something a leaked key can reach.
 *
 * It reuses the exact DAL/token/hash helpers the router uses, so the resulting
 * row is indistinguishable from a UI-minted key and the audit trail
 * (`auth_events.token_create`) is preserved.
 *
 * NOTE: the hub's in-process hot-swap (`pushKeyRotatedToUser`) does NOT run from
 * here. A tray app / purpose='host' supervisor that authenticated with the
 * rotated key will be rejected on its next connect — install the printed key on
 * that host yourself.
 *
 * Usage:
 *   bun run hub/scripts/rotate-api-key.ts rotate --user <email> --key-id <uuid>
 *   bun run hub/scripts/rotate-api-key.ts rotate --user <email> --prefix <remokey_…first-14-chars>
 *   bun run hub/scripts/rotate-api-key.ts mint   --user <email> [--name <n>] [--scopes a,b] [--host]
 *   bun run hub/scripts/rotate-api-key.ts list   --user <email>
 *
 * The plaintext key is printed ONCE to stdout and never stored.
 */

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return null
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : null
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const TAG = '[rotate-api-key]'

function usage(): never {
  console.error(
    `${TAG} usage:\n` +
      `  rotate --user <email> (--key-id <uuid> | --prefix <key_prefix>)\n` +
      `  mint   --user <email> [--name <name>] [--scopes agent,ext:read,...] [--host]\n` +
      `  list   --user <email>`,
  )
  process.exit(2)
}

function prefixOf(rawKey: string): string {
  return rawKey.slice(0, 14)
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  const email = arg('user')
  if (!cmd || !email || !['rotate', 'mint', 'list'].includes(cmd)) usage()

  const dal = await import('../src/db/dal.ts')
  const { hashToken } = await import('../src/lib/crypto.ts')
  const { generateToken } = await import('../src/utils/token.ts')
  const { normalizeScopes, hasScope, SCOPE_AGENT } = await import('../src/auth/scopes.ts')

  const user = await dal.getUserByEmail(email!.toLowerCase().trim())
  if (!user) {
    console.error(`${TAG} no user with that email`)
    return 1
  }
  const userId: string = user.id

  if (cmd === 'list') {
    const keys = await dal.listApiKeys(userId)
    for (const k of keys as any[]) {
      console.log(`${k.id}\t${k.purpose}\t${k.key_prefix ?? '—'}\t${JSON.stringify(k.scopes)}\t${k.name}`)
    }
    console.log(`${TAG} ${keys.length} active key(s).`)
    return 0
  }

  if (cmd === 'rotate') {
    let keyId = arg('key-id')
    const prefix = arg('prefix')
    if (!keyId && !prefix) usage()
    if (!keyId) {
      const matches = (await dal.listApiKeys(userId) as any[]).filter((k) => k.key_prefix === prefix)
      if (matches.length !== 1) {
        console.error(`${TAG} prefix matched ${matches.length} active key(s); use --key-id`)
        return 1
      }
      keyId = matches[0].id
    }
    const existing = await dal.getApiKeyById(userId, keyId!)
    if (!existing) {
      console.error(`${TAG} no active key with that id for this user`)
      return 1
    }

    // Same sequence as POST /api/api-keys/:id/rotate: new secret, old revoked,
    // same name/purpose/scopes.
    const rawKey = generateToken('remokey_')
    const keyHash = await hashToken(rawKey)
    await dal.revokeApiKeyById(userId, keyId!)
    const key = await dal.createApiKey(userId, keyHash, existing.name, {
      purpose: existing.purpose,
      scopes: existing.scopes,
      keyPrefix: prefixOf(rawKey),
    })
    try {
      await dal.recordAuthEvent({
        userId,
        eventType: 'token_create',
        ip: null,
        userAgent: 'cli:rotate-api-key',
        metadata: { key_id: key.id, rotated_from: keyId, purpose: existing.purpose, via: 'cli' },
      })
    } catch {}

    console.log(`${TAG} rotated ${keyId} -> ${key.id} (purpose=${existing.purpose})`)
    if (existing.purpose === 'supervisor' || existing.purpose === 'host') {
      console.log(`${TAG} NOTE: no hot-swap from the CLI — install this key on the host that used the old one.`)
    }
    console.log(`${TAG} new key (shown once):`)
    console.log(rawKey)
    return 0
  }

  // mint — mirrors POST /api/api-keys purpose rules.
  const norm = normalizeScopes(arg('scopes') ? arg('scopes')!.split(',').map((s) => s.trim()).filter(Boolean) : null)
  if (!norm.ok) {
    console.error(`${TAG} ${norm.error}`)
    return 1
  }
  const scopes = norm.scopes
  const host = flag('host')
  const agent = hasScope(scopes, SCOPE_AGENT)
  if (host && !agent) {
    console.error(`${TAG} host keys require the agent scope`)
    return 1
  }
  const purpose = host ? 'host' : agent ? 'supervisor' : 'external'
  const name = (arg('name') || (host ? 'Cloud host' : scopes ? 'External key' : 'Supervisor')).slice(0, 64)

  const rawKey = generateToken('remokey_')
  const keyHash = await hashToken(rawKey)
  const key = await dal.createApiKey(userId, keyHash, name, { purpose, scopes, keyPrefix: prefixOf(rawKey) })
  try {
    await dal.recordAuthEvent({
      userId,
      eventType: 'token_create',
      ip: null,
      userAgent: 'cli:rotate-api-key',
      metadata: { key_id: key.id, name, purpose, scopes, via: 'cli' },
    })
  } catch {}

  console.log(`${TAG} minted ${key.id} (purpose=${purpose}, scopes=${JSON.stringify(scopes)})`)
  if (purpose === 'supervisor') {
    console.log(`${TAG} NOTE: the previous supervisor key was revoked (at-most-one-active); no hot-swap from the CLI.`)
  }
  console.log(`${TAG} new key (shown once):`)
  console.log(rawKey)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${TAG} FAILED:`, err?.message ?? err)
    process.exit(1)
  })
