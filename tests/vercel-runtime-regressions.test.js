require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(relative, mocks) {
  const filename = path.resolve(__dirname, '..', relative)
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', source)((name) => {
    if (name in mocks) return mocks[name]
    if (name.startsWith('@/') || name === 'server-only') return {}
    return require(name)
  }, mod, mod.exports)
  return mod.exports
}

for (const admin of [false, true]) test(`organization resolution works with read-only cookies (admin=${admin})`, async () => {
  const membership = { id: 'membership', org_id: 'org', role_id: 'role', status: 'active', orgs: { product_tier: 'full' } }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) },
    from(table) {
      let orgFilter
      const query = { select: () => query, eq: (key, value) => { if (key === "org_id") orgFilter = value; return query }, order: () => query, limit: () => query,
        or: () => query, maybeSingle: async () => ({ data: table === 'memberships' ? (orgFilter && orgFilter !== 'org' ? null : membership) : table === 'orgs' ? { product_tier: 'full' } : null }) }
      return query
    },
  }
  const context = load('lib/auth/context.ts', {
    react: { cache: (fn) => fn }, 'next/cache': { cacheLife() {} },
    'next/headers': { cookies: async () => ({ get: () => undefined, set: () => { throw Error('Cookies can only be modified in a Server Action') } }) },
    'next/server': { after() {}, connection: async () => {} },
    '@/lib/supabase/server': { createServerSupabaseClient: async () => client, createServiceSupabaseClient: () => client },
    '@/lib/auth/platform': { isPlatformAdminUser: () => admin },
    '@/lib/product-tier': { normalizeProductTier: (v) => v },
  })
  assert.equal((await context.requireOrgMembership()).orgId, 'org')
  if (!admin) await assert.rejects(context.requireOrgMembership('other'), /no longer have access/)
})

test('unrelated Stripe accounts never trigger recipient retrieval; lookup failures remain retryable', async () => {
  let lookupError = null
  let row = null
  let calls = 0
  const providerError = new Error('provider unavailable')
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: lookupError }) }
  const { syncVendorRecipient } = load('lib/services/payment-rail-setup.ts', {
    '@/lib/supabase/server': { createServiceSupabaseClient: () => ({ from: () => query }) },
    '@/lib/integrations/payments/payment-rail-registry': { getPaymentRailProvider: () => ({ retrieveRecipient: async () => { calls++; throw providerError } }) },
  })
  assert.equal(await syncVendorRecipient('platform'), null)
  assert.equal(calls, 0)
  lookupError = { message: 'database unavailable' }
  await assert.rejects(syncVendorRecipient('platform'), /Unable to resolve payment recipient/)
  assert.equal(calls, 0)
  lookupError = null; row = { id: 'recipient' }
  await assert.rejects(syncVendorRecipient('vendor'), providerError)
  assert.equal(calls, 1)
})

test('permission guards suspend before starting authorization during prerender', async () => {
  const suspended = new Error('prerender suspended')
  const guards = load('lib/auth/guards.ts', {
    'next/server': { connection: async () => { throw suspended } },
    'next/navigation': { redirect: () => assert.fail('must not redirect a suspended prerender') },
    '@/lib/auth/context': { requireAuth: () => assert.fail('must not query auth before request time') },
  })
  await assert.rejects(guards.requirePermissionGuard('platform.org.access'), suspended)
  await assert.rejects(guards.requireAnyPermissionGuard(['org.admin']), suspended)
})

test('placeholder email detection preserves real and provider test addresses', () => {
  const { isPlaceholderEmail } = require('../lib/emails/recipient-policy')
  for (const value of ['person@example.com', 'Person <person@EXAMPLE.NET>', 'a@sub.example.org', 'a@demo.test']) assert.equal(isPlaceholderEmail(value), true)
  for (const value of ['delivered@resend.dev', 'person@arcnaples.com', 'a@notexample.com']) assert.equal(isPlaceholderEmail(value), false)
})

test('switching organizations preserves the framework redirect', async () => {
  const redirectError = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/;307;' })
  let selectedOrg
  const actions = load('app/(app)/platform/actions.ts', {
    'next/cache': { revalidatePath() {} },
    'next/navigation': { redirect: () => { throw redirectError }, unstable_rethrow: (error) => { if (error === redirectError) throw error } },
    '@/lib/auth/context': { requireAuth: async () => ({ user: { id: 'user' } }) },
    '@/lib/services/permissions': { requirePermission: async () => {} },
    '@/lib/services/platform-session': { setPlatformOrgContext: async (id) => { selectedOrg = id } },
    '@/lib/services/ai-config': { AI_FEATURE_VALUES: ['test'], AI_PROVIDER_VALUES: ['test'], AI_TIER_VALUES: ['test'] },
    '@/lib/product-tier': { PRODUCT_TIERS: ['residential'] },
    '@/lib/action-result': { actionError: () => assert.fail('a redirect must never become an action error') },
  })
  const form = new FormData()
  form.set('orgId', '00000000-0000-4000-8000-000000000001')
  form.set('reason', 'switch organization')
  await assert.rejects(actions.enterOrgContextAction(form), redirectError)
  assert.equal(selectedOrg, form.get('orgId'))
})
