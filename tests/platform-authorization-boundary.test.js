require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const { stubModule, ORG, ACTOR, PROJECT, PACKAGE } = require('./support/starts-harness')

function authorizationHarness() {
  const keys = ['platform.billing.manage', 'platform.support.read', 'platform.feature_flags.manage', 'platform.org.access', 'impersonation.start', 'billing.manage']
  const db = createFakeSupabase({
    permissions: keys.map(key => ({ key })),
    projects: [{ id: PROJECT, org_id: ORG }],
    memberships: [{ id: PACKAGE, org_id: ORG, user_id: ACTOR, status: 'active', project_scope: 'all', division_scope: 'all', role: { permissions: ['*', ...keys].map(permission_key => ({ permission_key })) } }],
    project_members: [{ id: PACKAGE, org_id: ORG, project_id: PROJECT, user_id: ACTOR, status: 'active', role: { permissions: keys.map(permission_key => ({ permission_key })) } }],
    membership_permission_overrides: [{ membership_id: PACKAGE, permission_key: 'platform.billing.manage', effect: 'grant' }],
  })
  const reads = [], from = db.from.bind(db)
  db.from = table => { reads.push(table); return from(table) }
  stubModule('@/lib/supabase/server', { createServiceSupabaseClient: () => db })
  stubModule('@/lib/auth/platform', { isPlatformAdminId: () => false })
  delete require.cache[require.resolve('../lib/services/authorization')]
  const service = require('../lib/services/authorization')
  function role(...keys) { db.store.platform_memberships = [{ user_id: ACTOR, status: 'active', expires_at: null, role: { permissions: keys.map(permission_key => ({ permission_key })) } }] }
  return { service, db, reads, role }
}

for (const permission of ['platform.billing.manage', 'platform.support.read', 'platform.feature_flags.manage', 'impersonation.start']) {
  test(`${permission} cannot be granted by tenant wildcard, explicit org/project grants or overrides`, async () => {
    const h = authorizationHarness()
    for (const scope of [{}, { orgId: ORG }, { orgId: ORG, projectId: PROJECT }]) {
      const decision = await h.service.authorize({ permission, userId: ACTOR, ...scope })
      assert.equal(decision.allowed, false)
      assert.deepEqual(decision.scopesEvaluated, ['platform'])
      await assert.rejects(h.service.requireAuthorization({ permission, userId: ACTOR, ...scope }), e => e.code === 'AUTH_FORBIDDEN')
    }
    assert.ok(!h.reads.includes('memberships'))
    assert.ok(!h.reads.includes('project_members'))
    assert.ok(!h.reads.includes('membership_permission_overrides'))
    assert.equal((await h.service.authorizeMany({ permission, userId: ACTOR, orgId: ORG, projectIds: [PROJECT] })).get(PROJECT), false)
  })
}

test('platform org access does not elevate billing, support or feature capabilities', async () => {
  const h = authorizationHarness(); h.role('platform.org.access')
  for (const permission of ['platform.billing.manage', 'platform.support.read', 'platform.feature_flags.manage', 'impersonation.start']) {
    assert.equal((await h.service.authorize({ permission, userId: ACTOR, orgId: ORG })).allowed, false)
    assert.equal((await h.service.authorizeMany({ permission, userId: ACTOR, orgId: ORG, projectIds: [PROJECT] })).get(PROJECT), false)
  }
  assert.equal((await h.service.authorize({ permission: 'platform.org.access', userId: ACTOR, orgId: ORG })).allowed, true)
})

test('dedicated platform roles permit their capability and still reject foreign or missing home identities', async () => {
  const h = authorizationHarness(); h.role('platform.billing.manage')
  const input = { permission: 'platform.billing.manage', userId: ACTOR, orgId: ORG, projectId: PROJECT }
  assert.equal((await h.service.authorize(input)).allowed, true)
  assert.equal((await h.service.authorize({ ...input, permission: 'platform.support.read' })).allowed, false)
  assert.equal((await h.service.authorizeMany({ ...input, projectIds: [PROJECT, PACKAGE] })).get(PACKAGE), false)
  h.db.store.projects[0].org_id = PACKAGE
  assert.equal((await h.service.authorize(input)).allowed, false)
  assert.equal((await h.service.authorizeMany({ ...input, projectIds: [PROJECT] })).get(PROJECT), false)
})

test('revoked platform membership and failed platform lookup reject; ordinary tenant billing is retained', async () => {
  const h = authorizationHarness(); h.role('platform.billing.manage')
  const input = { permission: 'platform.billing.manage', userId: ACTOR, orgId: ORG }
  assert.equal((await h.service.authorize(input)).allowed, true)
  h.db.store.platform_memberships[0].status = 'revoked'
  assert.equal((await h.service.authorize(input)).allowed, false)
  assert.equal((await h.service.authorize({ ...input, permission: 'billing.manage' })).allowed, true)
  const from = h.db.from.bind(h.db)
  h.db.from = table => { const q = from(table); if (table === 'platform_memberships') q.run = () => ({ error: { message: 'Platform catalog unavailable' } }); return q }
  await assert.rejects(h.service.authorize(input), /Platform catalog unavailable/)
})

// Execute the actual service/action body, substituting only external boundaries.
function load(path, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  new Function('exports', 'require', code)(exports, name => {
    if (Object.hasOwn(modules, name)) return modules[name]
    if (name === 'server-only') return {}
    if (['react', 'react/jsx-runtime', 'zod'].includes(name)) return require(name)
    throw Error(`Unexpected dependency: ${name}`)
  })
  return exports
}
function deniedModules() {
  const calls = [], denied = Error('Platform permission required')
  return { calls, denied, modules: {
    '@/lib/services/platform-access': { requireAnyPlatformPermission: async permissions => { calls.push(['gate', permissions]); throw denied } },
    '@/lib/supabase/server': { createServiceSupabaseClient: () => { calls.push('database'); throw Error('Sensitive client reached') } },
    '@/lib/services/audit': { recordAudit: async () => { calls.push('audit') } },
    '@/lib/product-tier': { normalizeProductTier: value => value, PRODUCT_TIERS: ['residential', 'commercial', 'production'] },
    '@/lib/auth/context': { requireAuth: async () => ({ user: { id: ACTOR, email: 'tenant@example.test' }, orgId: ORG }) },
    '@/lib/services/permissions': {},
    'next/server': { connection: async () => {} },
    'next/cache': { revalidatePath: () => { calls.push('revalidate') } },
    '@/lib/services/events': { recordEvent: async () => { calls.push('event') } },
    '@/lib/services/billing': { activateOrgBilling: async () => { calls.push('provider'); throw Error('Provider reached') }, syncOrgEntitlementsFromPlan: async () => { calls.push('entitlements') } },
    '@/lib/action-result': { actionError: error => ({ success: false, error: error.message }) },
  } }
}

test('all 16 global admin service exports deny before creating a sensitive data client', async () => {
  const h = deniedModules(), service = load('lib/services/admin.ts', h.modules)
  const args = { getCustomers: [{}], getSubscriptions: [{}], getAuditLogs: [{}], toggleFeatureFlag: [PACKAGE, ORG, true, ACTOR], createFeatureFlag: [{}], updateFeatureFlag: [{}], deleteFeatureFlag: [{}] }
  assert.equal(Object.keys(service).length, 16)
  for (const [name, fn] of Object.entries(service)) {
    const before = h.calls.length
    await assert.rejects(fn(...(args[name] ?? [])), error => error === h.denied)
    assert.equal(h.calls.length, before + 1, name)
    assert.equal(h.calls.at(-1)[0], 'gate')
    assert.ok(h.calls.at(-1)[1].every(key => key.startsWith('platform.')))
  }
})

test('global release-note publishing and admin reads deny before accessing data', async () => {
  const h = deniedModules(), service = load('lib/services/release-notes.ts', h.modules)
  for (const [name, args] of [['listReleaseNotesForAdmin', []], ['createReleaseNote', [{}]], ['updateReleaseNote', [PACKAGE, {}]], ['deleteReleaseNote', [PACKAGE]]]) {
    await assert.rejects(service[name](...args), error => error === h.denied)
  }
  assert.equal(h.calls.length, 4)
  assert.ok(h.calls.every(call => call[0] === 'gate'))
})

test('cross-org customer actions deny valid requests before database, provider, entitlements, audit or revalidation', async () => {
  const h = deniedModules(), actions = load('app/(app)/admin/customers/actions.ts', h.modules)
  const form = values => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data }
  const requests = [
    ['extendCustomerTrialAction', form({ orgId: PACKAGE, trialDays: '30' })],
    ['activateCustomerBillingAction', form({ orgId: PACKAGE, amountDollars: '1000', interval: 'month', collectionMethod: 'checkout' })],
    ['updateCustomerDetailsAction', form({ orgId: PACKAGE, name: 'Other builder', slug: 'other-builder', status: 'active', billingModel: 'subscription', billingEmail: '', productTier: 'production' })],
    ['updateCustomerSubscriptionAction', form({ orgId: PACKAGE, status: 'active' })],
    ['deleteOrganizationAction', PACKAGE],
  ]
  for (const [name, input] of requests) {
    const before = h.calls.length, result = await actions[name](input)
    assert.equal(result.success, false, name)
    assert.equal(result.error, h.denied.message, name)
    assert.deepEqual(h.calls.slice(before), [['gate', ['platform.billing.manage']]], name)
  }
})

test('platform helper binds the authenticated actor without accepting tenant scope and preserves configured env superadmins', async () => {
  const calls = [], user = { id: ACTOR, email: 'owner@example.test' }; let env = false
  const service = load('lib/services/platform-access.ts', {
    '@/lib/supabase/server': {},
    '@/lib/auth/context': { requireAuth: async () => ({ user, orgId: ORG }) },
    '@/lib/auth/platform': { isPlatformAdminId: (id, email) => env && id === ACTOR && email === user.email },
    '@/lib/services/permissions': { requireAnyPermission: async (...args) => calls.push(args) },
  })
  assert.equal(await service.requireAnyPlatformPermission(['platform.support.read']), user)
  assert.deepEqual(calls, [[['platform.support.read'], { userId: ACTOR }]])
  await assert.rejects(service.requireAnyPlatformPermission(['billing.manage']), /Invalid platform permission/)
  await assert.rejects(service.requireAnyPlatformPermission([]), /Invalid platform permission/)
  env = true
  assert.equal(await service.requireAnyPlatformPermission(['platform.billing.manage']), user)
  assert.equal(calls.length, 1)
})

test('direct platform lifecycle and feature writers reject forged audit actors before data access', async () => {
  const h = deniedModules()
  h.modules['@/lib/services/platform-access'].requireAnyPlatformPermission = async () => ({ id: ACTOR })
  const admin = load('lib/services/admin.ts', h.modules)
  for (const [name, args] of [['toggleFeatureFlag', [PACKAGE, ORG, true, PROJECT]], ['createFeatureFlag', [{ actorId: PROJECT }]], ['updateFeatureFlag', [{ actorId: PROJECT }]], ['deleteFeatureFlag', [{ actorId: PROJECT }]]]) {
    await assert.rejects(admin[name](...args), /Platform actor mismatch/)
  }
  const access = load('lib/services/platform-access.ts', { ...h.modules,
    '@/lib/auth/platform': { isPlatformAdminId: () => true },
  })
  await assert.rejects(access.setPlatformOrganizationStatus({ orgId: ORG, status: 'archived', actorUserId: PROJECT }), /Platform actor mismatch/)
  assert.deepEqual(h.calls, [])
})

test('platform-only route guards redirect on denial before starting tenant permission checks', async () => {
  const calls = [], denied = Error('Denied'), redirected = Error('Redirected')
  const guards = load('lib/auth/guards.ts', {
    'next/server': { connection: async () => {} },
    'next/navigation': { redirect: path => { calls.push(['redirect', path]); throw redirected }, unstable_rethrow: () => {} },
    '@/lib/auth/context': { requireAuth: async () => ({ user: { id: ACTOR }, orgId: ORG }) },
    '@/lib/services/platform-access': { requireAnyPlatformPermission: async permissions => { calls.push(['platform', permissions]); throw denied } },
    '@/lib/services/permissions': { requirePermission: async () => calls.push('tenant'), requireAnyPermission: async () => calls.push('tenant') },
  })
  const old = console.error; console.error = () => {}
  try {
    await assert.rejects(guards.requirePermissionGuard('platform.billing.manage', ORG), error => error === redirected)
    await assert.rejects(guards.requireAnyPermissionGuard(['platform.support.read'], ORG), error => error === redirected)
  } finally { console.error = old }
  assert.deepEqual(calls, [['platform', ['platform.billing.manage']], ['redirect', '/unauthorized'], ['platform', ['platform.support.read']], ['redirect', '/unauthorized']])
})

test('authorized platform and ordinary tenant route guards use their own scopes', async () => {
  const calls = [], guards = load('lib/auth/guards.ts', {
    'next/server': { connection: async () => {} },
    'next/navigation': { redirect: () => { throw Error('Unexpected redirect') }, unstable_rethrow: () => {} },
    '@/lib/auth/context': { requireAuth: async () => ({ user: { id: ACTOR }, orgId: ORG }) },
    '@/lib/services/platform-access': { requireAnyPlatformPermission: async permissions => calls.push(['platform', permissions]) },
    '@/lib/services/permissions': { requirePermission: async (...args) => calls.push(['tenant', ...args]), requireAnyPermission: async (...args) => calls.push(['tenantAny', ...args]) },
  })
  await guards.requirePermissionGuard('platform.billing.manage')
  await guards.requireAnyPermissionGuard(['platform.support.read'])
  await guards.requirePermissionGuard('billing.manage')
  await guards.requireAnyPermissionGuard(['billing.manage'])
  assert.deepEqual(calls, [['platform', ['platform.billing.manage']], ['platform', ['platform.support.read']], ['tenant', 'billing.manage', { orgId: ORG, userId: ACTOR }], ['tenantAny', ['billing.manage'], { orgId: ORG, userId: ACTOR }]])
})

test('platform audit export returns 403 before querying logs for an unauthorized actor', async () => {
  const h = deniedModules(); h.modules['next/server'].NextResponse = { json: (body, options) => ({ body, status: options.status }) }
  h.modules['@/lib/services/admin'] = { getAuditLogs: async () => { h.calls.push('logs'); throw Error('Logs reached') } }
  const route = load('app/api/platform/audit-export/route.ts', h.modules)
  const result = await route.GET({ nextUrl: new URL(`https://arc.example.test/api/platform/audit-export?orgId=${PACKAGE}`) })
  assert.equal(result.status, 403)
  assert.deepEqual(h.calls, [['gate', ['platform.support.read']]])
})

test('permitted feature writer records the authenticated audit actor when an internal caller omits it', async () => {
  const h = deniedModules(), db = createFakeSupabase({ feature_flags: [{ id: PACKAGE, org_id: ORG, flag_key: 'test_flag', enabled: false }] }), audits = []
  h.modules['@/lib/services/platform-access'].requireAnyPlatformPermission = async () => ({ id: ACTOR })
  h.modules['@/lib/supabase/server'].createServiceSupabaseClient = () => db
  h.modules['@/lib/services/audit'].recordAudit = async value => audits.push(value)
  const service = load('lib/services/admin.ts', h.modules)
  await service.toggleFeatureFlag(PACKAGE, ORG, true)
  assert.equal(db.store.feature_flags[0].enabled, true)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].actorId, ACTOR)
  assert.equal(audits[0].orgId, ORG)
})
