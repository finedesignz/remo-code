import { describe, expect, test } from 'bun:test'

const KEYS = [
  'TITANIUM_KEYGEN_ACCOUNT_ID',
  'TITANIUM_ACCOUNT_ID',
  'TITANIUM_KEYGEN_PRODUCT_ID',
  'TITANIUM_PRODUCT_ID',
  'TITANIUM_KEYGEN_PORTAL_TOKEN',
  'TITANIUM_PORTAL_TOKEN',
  'TITANIUM_KEYGEN_ADMIN_TOKEN',
  'TITANIUM_ADMIN_TOKEN',
  'TITANIUM_BYPASS',
  'ALLOW_LEGACY_LOGIN',
  'LEGACY_MAGIC_LINK_LOGIN',
  'MAGIC_LINK_SECRET',
  'REMO_PUBLIC_URL',
  'REMO_BOOTSTRAP_ADMIN_EMAIL',
] as const

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior = new Map<string, string | undefined>()
  for (const key of KEYS) {
    prior.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function importConfig(caseName: string) {
  return await import(`../src/config.ts?${caseName}-${Date.now()}-${Math.random()}`)
}

describe('Titanium env config', () => {
  test('reads canonical TITANIUM_KEYGEN_* env names', async () => {
    await withEnv(
      {
        TITANIUM_KEYGEN_ACCOUNT_ID: 'acct_keygen',
        TITANIUM_KEYGEN_PRODUCT_ID: 'prod_keygen',
        TITANIUM_KEYGEN_PORTAL_TOKEN: 'portal_keygen',
      },
      async () => {
        const { config } = await importConfig('canonical')
        expect(config.titanium.accountId).toBe('acct_keygen')
        expect(config.titanium.productId).toBe('prod_keygen')
        expect(config.titanium.portalToken).toBe('portal_keygen')
        expect(config.titanium.adminToken).toBe('portal_keygen')
      },
    )
  })

  test('TITANIUM_BYPASS defaults to false; parses true/false correctly', async () => {
    await withEnv({ TITANIUM_BYPASS: undefined } as any, async () => {
      const { config } = await importConfig('bypass-default')
      expect(config.titaniumBypass).toBe(false)
    })
    await withEnv({ TITANIUM_BYPASS: 'true' } as any, async () => {
      const { config } = await importConfig('bypass-true')
      expect(config.titaniumBypass).toBe(true)
    })
    await withEnv({ TITANIUM_BYPASS: 'false' } as any, async () => {
      const { config } = await importConfig('bypass-false')
      expect(config.titaniumBypass).toBe(false)
    })
  })

  test('ignores legacy unprefixed TITANIUM_* names (rename complete)', async () => {
    await withEnv(
      {
        TITANIUM_ACCOUNT_ID: 'acct_legacy',
        TITANIUM_PRODUCT_ID: 'prod_legacy',
        TITANIUM_PORTAL_TOKEN: 'portal_legacy',
        TITANIUM_ADMIN_TOKEN: 'admin_legacy',
      },
      async () => {
        const { config } = await importConfig('legacy')
        expect(config.titanium.accountId).toBe('')
        expect(config.titanium.productId).toBe('')
        expect(config.titanium.portalToken).toBe('')
        expect(config.titanium.adminToken).toBe('')
      },
    )
  })

  test('no password / own-magic-link login switch exists: the legacy env vars are inert', async () => {
    await withEnv({ ALLOW_LEGACY_LOGIN: 'true', LEGACY_MAGIC_LINK_LOGIN: 'on', MAGIC_LINK_SECRET: 'x'.repeat(40), TITANIUM_BYPASS: 'true' }, async () => {
      const { config } = await importConfig('no-legacy-login')
      expect('allowLegacyLogin' in config).toBe(false)
      expect('legacyMagicLinkLogin' in config).toBe(false)
      expect('magicLinkSecret' in config).toBe(false)
    })
  })

  test('REMO_PUBLIC_URL is reduced to an origin; default is the prod app; garbage refuses boot', async () => {
    await withEnv({}, async () => {
      const { config } = await importConfig('pub-default')
      expect(config.publicUrl).toBe('https://app.remo-code.com')
    })
    await withEnv({ REMO_PUBLIC_URL: 'https://staging.remo-code.com/some/path' }, async () => {
      const { config } = await importConfig('pub-path')
      expect(config.publicUrl).toBe('https://staging.remo-code.com')
    })
    await withEnv({ REMO_PUBLIC_URL: 'not a url' }, async () => {
      await expect(importConfig('pub-bad')).rejects.toThrow(/REMO_PUBLIC_URL/)
    })
  })

  test('REMO_BOOTSTRAP_ADMIN_EMAIL is normalized; unset means no login ever creates a user', async () => {
    await withEnv({}, async () => {
      const { config } = await importConfig('boot-unset')
      expect(config.bootstrapAdminEmail).toBe('')
    })
    await withEnv({ REMO_BOOTSTRAP_ADMIN_EMAIL: '  Owner@Example.COM ' }, async () => {
      const { config } = await importConfig('boot-set')
      expect(config.bootstrapAdminEmail).toBe('owner@example.com')
    })
  })
})
