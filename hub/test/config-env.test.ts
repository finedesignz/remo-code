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
  test('prefers canonical TITANIUM_KEYGEN_* env names', async () => {
    await withEnv(
      {
        TITANIUM_KEYGEN_ACCOUNT_ID: 'acct_keygen',
        TITANIUM_ACCOUNT_ID: 'acct_legacy',
        TITANIUM_KEYGEN_PRODUCT_ID: 'prod_keygen',
        TITANIUM_PRODUCT_ID: 'prod_legacy',
        TITANIUM_KEYGEN_PORTAL_TOKEN: 'portal_keygen',
        TITANIUM_PORTAL_TOKEN: 'portal_legacy',
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

  test('keeps legacy unprefixed names as fallback', async () => {
    await withEnv(
      {
        TITANIUM_ACCOUNT_ID: 'acct_legacy',
        TITANIUM_PRODUCT_ID: 'prod_legacy',
        TITANIUM_PORTAL_TOKEN: 'portal_legacy',
        TITANIUM_ADMIN_TOKEN: 'admin_legacy',
      },
      async () => {
        const { config } = await importConfig('legacy')
        expect(config.titanium.accountId).toBe('acct_legacy')
        expect(config.titanium.productId).toBe('prod_legacy')
        expect(config.titanium.portalToken).toBe('portal_legacy')
        expect(config.titanium.adminToken).toBe('admin_legacy')
      },
    )
  })
})
