require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')
const React = require('react')
const { createFakeSupabase } = require('./support/fake-supabase')
const { stubModule, ORG, ACTOR, PACKAGE } = require('./support/starts-harness')
const definitions = require('../lib/services/import-definitions')
const parsers = require('../lib/services/import-parsers')
const readiness = require('../lib/data/onboarding-readiness')

function load(path, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  new Function('exports', 'require', code)(exports, name => {
    if (Object.hasOwn(modules, name)) return modules[name]
    if (name === 'server-only') return {}
    if (name === '@/lib/land/paging') return require('../lib/land/paging')
    if (name === '@/lib/validation/import-navigation') return require('../lib/validation/import-navigation')
    if (name === '@/components/layout/queue-pagination') return { QueuePagination: 'QueuePagination' }
    if (['react', 'react/jsx-runtime', 'zod'].includes(name)) return require(name)
    throw Error(`Unexpected dependency ${name}`)
  })
  return exports
}
function harness(roleKeys = ['platform.support.read']) {
  const db = createFakeSupabase({
    permissions: ['platform.support.read', 'platform.support.write'].map(key => ({ key })),
    platform_memberships: [{ user_id: ACTOR, status: 'active', expires_at: null, role: { permissions: roleKeys.map(permission_key => ({ permission_key })) } }],
    orgs: [{ id: ORG, name: 'Builder', product_tier: 'production' }, { id: PACKAGE, name: 'Other builder', product_tier: 'production' }],
    import_batches: [{ id: PACKAGE, org_id: ORG, importer: 'cost_codes', status: 'staged', row_count: 1, error_count: 0 }],
    import_rows: [{ id: ACTOR, org_id: ORG, batch_id: PACKAGE, row_number: 1, parsed: { code: '1000', name: 'Example' }, status: 'valid' }],
  })
  // The shared fake returns arrays for UPDATE even with single()/maybeSingle().
  // This fixture implements PostgREST's mutation cardinality, retaining filters.
  const from = db.from.bind(db)
  db.from = table => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => {
      const result = run()
      if (query.action === 'update' && query.returning && query.cardinality && !result.error) {
        const rows = result.data
        if (rows.length > 1 || (query.cardinality === 'single' && rows.length !== 1)) return { data: null, error: { message: 'Expected exactly one updated row' } }
        return { ...result, data: rows[0] ?? null }
      }
      return result
    }
    return query
  }
  stubModule('@/lib/supabase/server', { createServiceSupabaseClient: () => db })
  stubModule('@/lib/auth/platform', { isPlatformAdminId: () => false })
  delete require.cache[require.resolve('../lib/services/authorization')]
  const authorization = require('../lib/services/authorization'), calls = []
  const access = load('lib/services/platform-access.ts', {
    '@/lib/auth/context': { requireAuth: async () => ({ user: { id: ACTOR }, orgId: PACKAGE }) },
    '@/lib/auth/platform': { isPlatformAdminId: () => false },
    '@/lib/supabase/server': { createServiceSupabaseClient: () => db },
    '@/lib/services/permissions': {
      requireAnyPermission: async (permissions, ctx) => {
        calls.push(['platformGate', permissions, ctx]); assert.deepEqual(ctx, { userId: ACTOR })
        const decisions = await Promise.all(permissions.map(permission => authorization.authorize({ permission, ...ctx })))
        if (!decisions.some(decision => decision.allowed)) await authorization.requireAuthorization({ permission: permissions[0], ...ctx })
      },
      hasAnyPermission: async (permissions, ctx) => (await Promise.all(permissions.map(permission => authorization.authorize({ permission, ...ctx })))).some(decision => decision.allowed),
    },
  })
  const modules = {
    '@/lib/services/platform-access': access,
    '@/lib/supabase/server': { createServiceSupabaseClient: () => { calls.push('sensitiveClient'); return db } },
    '@/lib/services/audit': { recordAudit: async value => calls.push(['audit', value]) },
    '@/lib/services/events': { recordEvent: async value => calls.push(['event', value]) },
    '@/lib/data/onboarding-readiness': readiness,
    '@/lib/product-tier': { normalizeProductTier: value => value, getProjectPosture: () => 'production' },
    '@/lib/services/price-book': { orgHasPriceAgreements: async () => false },
    '@/lib/services/context': { requireOrgContext: async orgId => { calls.push(['tenantContext', orgId]); return { supabase: db, orgId: orgId ?? ORG, userId: ACTOR, productTier: 'production' } } },
    '@/lib/services/permissions': { requirePermission: async (permission, ctx) => calls.push(['tenantGate', permission, ctx.orgId]), requireAnyPermission: async (permissions, ctx) => calls.push(['tenantAny', permissions, ctx.orgId]) },
    '@/lib/services/team': { createOrgMemberInvite: async () => { calls.push('invite'); throw Error('Invite reached') } },
    '@/lib/services/import-definitions': definitions,
    '@/lib/services/import-parsers': parsers,
  }
  const imports = load('lib/services/imports.ts', modules)
  const onboarding = load('lib/services/onboarding.ts', modules)
  const provenance = load('lib/services/sample-home-provenance.ts', modules)
  const sample = load('lib/services/demo-community-seed.ts', { ...modules, '@/lib/services/imports': imports, '@/lib/services/sample-home-provenance': provenance })
  return { modules, imports, onboarding, sample, access, db, calls }
}
const forbidden = error => error.code === 'AUTH_FORBIDDEN'
function assertWriteDenial(calls) { assert.equal(calls.length, 1); assert.deepEqual(calls[0], ['platformGate', ['platform.support.write'], { userId: ACTOR }]) }
const importWrites = [
  ['stageImportBatch', [{ importer: 'cost_codes', csvText: 'code,name\n1000,Example' }, { platformOrgId: ORG }]],
  ['patchImportRow', [{ batchId: PACKAGE, rowId: ACTOR, patch: { name: 'Changed' } }, { platformOrgId: ORG }]],
  ['setImportUpdateExisting', [PACKAGE, true, { platformOrgId: ORG }]],
  ['discardImportBatch', [PACKAGE, { platformOrgId: ORG }]],
  ['commitImportBatch', [PACKAGE, { platformOrgId: ORG }]],
]
for (const [name, args] of importWrites) {
  test(`read-only platform operator cannot ${name} before sensitive lookup or write`, async () => {
    const h = harness()
    await assert.rejects(h.imports[name](...args), forbidden)
    assertWriteDenial(h.calls)
    assert.equal(h.db.store.import_batches[0].status, 'staged')
    assert.equal(h.db.store.import_rows[0].parsed.name, 'Example')
  })
}
for (const [name, args] of [
  ['createOnboardingRun', [{ orgId: ORG }]], ['updateOnboardingRun', [{ runId: PACKAGE, notes: 'Changed' }]],
  ['completeOnboardingStage', [{ runId: PACKAGE, stageKey: 'org_shell' }]],
  ['skipOnboardingStage', [{ runId: PACKAGE, stageKey: 'accounting', reason: 'Documented skip' }]], ['markRunLive', [PACKAGE]],
]) {
  test(`read-only platform operator cannot ${name} before sensitive lookup or write`, async () => {
    const h = harness(); await assert.rejects(h.onboarding[name](...args), forbidden); assertWriteDenial(h.calls)
  })
}
test('read-only support can inspect original customer run, batch, row and mapping profile', async () => {
  const h = harness()
  assert.equal((await h.onboarding.getOnboardingRun(ORG)).org.id, ORG)
  assert.equal((await h.imports.listImportBatches({}, { platformOrgId: ORG })).batches.length, 1)
  const detail = await h.imports.getImportBatch(PACKAGE, {}, { platformOrgId: ORG })
  assert.equal(detail.batch.id, PACKAGE); assert.equal(detail.rows.length, 1)
  assert.equal(await h.imports.getImportMappingProfile('cost_codes', ['code', 'name'], { platformOrgId: ORG }), null)
  assert.ok(h.calls.filter(Array.isArray).every(call => call[0] === 'platformGate' && call[1][0] === 'platform.support.read'))
  assert.equal((await h.imports.listImportBatches({}, { platformOrgId: PACKAGE })).batches.length, 0)
  await assert.rejects(h.imports.getImportBatch(PACKAGE, {}, { platformOrgId: PACKAGE }), /Import batch not found/)
})
test('tenant billing permission, revoked platform membership and platform lookup failure do not authorize onboarding reads', async () => {
  for (const mode of ['tenant', 'revoked', 'unavailable']) {
    const h = harness(mode === 'tenant' ? [] : ['platform.support.read'])
    h.db.store.memberships = [{ org_id: PACKAGE, user_id: ACTOR, status: 'active', role: { permissions: [{ permission_key: '*' }, { permission_key: 'billing.manage' }] } }]
    if (mode === 'revoked') h.db.store.platform_memberships[0].status = 'revoked'
    if (mode === 'unavailable') { const from = h.db.from.bind(h.db); h.db.from = table => { const q = from(table); if (table === 'platform_memberships') q.run = () => ({ error: { message: 'Platform lookup unavailable' } }); return q } }
    await assert.rejects(h.onboarding.getOnboardingRun(ORG), mode === 'unavailable' ? /Platform lookup unavailable/ : forbidden)
    assert.equal(h.calls.includes('sensitiveClient'), false)
  }
})
test('permitted operator creates original customer run with verified actor; viewer cannot probe write access', async () => {
  const h = harness(['platform.support.read', 'platform.support.write'])
  const run = await h.onboarding.createOnboardingRun({ orgId: ORG, notes: 'Pilot' })
  assert.equal(run.org_id, ORG); assert.equal(run.created_by, ACTOR)
  assert.ok(h.calls.filter(call => Array.isArray(call) && ['audit', 'event'].includes(call[0])).every(call => call[1].actorId === ACTOR && call[1].orgId === ORG))
  assert.equal(await h.access.hasAnyPlatformPermission(['platform.support.write']), true)
  assert.equal(await harness().access.hasAnyPlatformPermission(['platform.support.write']), false)
  await assert.rejects(h.access.hasAnyPlatformPermission(['billing.manage']), /Invalid platform permission/)
})
test('sample seed and delete refuse read-only actors and forged operator identity before data access', async () => {
  for (const role of [['platform.support.read'], ['platform.support.read', 'platform.support.write']]) {
    const h = harness(role), actor = role.length === 1 ? ACTOR : PACKAGE
    for (const [name, args] of [['seedSampleCommunity', [ORG, actor]], ['deleteSampleCommunity', [ORG, PACKAGE, actor]]]) {
      h.calls.length = 0
      await assert.rejects(h.sample[name](...args), role.length === 1 ? forbidden : /Platform actor mismatch/)
      assertWriteDenial(h.calls)
    }
  }
})
test('sample reset server action denies read-only role before onboarding read, data client or sample services', async () => {
  const h = harness()
  const reached = () => { h.calls.push('unexpected'); throw Error('Reached sample mutation') }
  const actions = load('app/(app)/admin/customers/[orgId]/onboarding/actions.ts', {
    ...h.modules, 'next/cache': { revalidatePath: reached },
    '@/lib/services/imports': h.imports,
    '@/lib/services/onboarding': { ...h.onboarding, getOnboardingRun: reached },
    '@/lib/services/demo-community-seed': { seedSampleCommunity: reached, deleteSampleCommunity: reached },
    '@/lib/services/import-mapping': { suggestImportColumnMapping: reached },
    '@/lib/action-result': { actionError: error => ({ success: false, error: error.message }) },
  })
  const form = new FormData(); form.set('orgId', ORG)
  const result = await actions.resetSampleCommunityAction(form)
  assert.equal(result.success, false); assert.match(result.error, /platform.support.write/); assertWriteDenial(h.calls)
})
test('tenant imports still require import.manage and importer capability in their own org, including platform-only WIP denial', async () => {
  const h = harness([])
  await h.imports.listImportBatches({ importer: 'price_book' }, { orgId: ORG })
  assert.deepEqual(h.calls.filter(Array.isArray), [['tenantContext', ORG], ['tenantGate', 'import.manage', ORG], ['tenantAny', ['price_book.write', 'commitment.write'], ORG]])
  await assert.rejects(h.imports.listImportBatches({ importer: 'open_wip' }, { orgId: ORG }), /restricted to the platform/)
  assert.ok(!h.calls.some(call => Array.isArray(call) && call[0] === 'platformGate'))
})

function elements(tree) {
  if (!tree) return []
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!React.isValidElement(tree)) return []
  return [tree, ...elements(tree.props.children)]
}
function uiModules() {
  const calls = [], leaves = new Proxy({}, { get: (_, key) => String(key) })
  return { calls, modules: {
    react: { ...React, useState: init => [typeof init === 'function' ? init() : init, () => calls.push('state')], useTransition: () => [false, work => work()], useMemo: work => work(), useRef: () => ({ current: null }) },
    'next/link': { default: 'Link', __esModule: true },
    'next/navigation': { useRouter: () => ({ refresh: () => calls.push('refresh'), push: () => calls.push('push') }) },
    '@tanstack/react-virtual': { useVirtualizer: () => ({ getTotalSize: () => 42, getVirtualItems: () => [{ index: 0, start: 0, size: 42 }] }) },
    sonner: { toast: { success: () => calls.push('toast'), error: () => calls.push('toast') } },
    '@/components/icons': leaves,
    ...Object.fromEntries(['badge', 'button', 'collapsible', 'input', 'textarea', 'dialog', 'select', 'switch', 'tabs'].map(name => [`@/components/ui/${name}`, leaves])),
    '@/lib/action-result': { unwrapAction: value => value.data },
    '@/lib/data/onboarding-readiness': readiness,
  } }
}
test('read-only workbench retains inspectable stages and blocks mutation forms and buttons', async () => {
  const h = uiModules(), workbench = load('components/admin/onboarding-workbench.tsx', h.modules).OnboardingWorkbench
  const action = async () => { h.calls.push('action'); return { success: true } }
  const tree = workbench({ canManage: false, org: { id: ORG, name: 'Builder' }, run: { id: PACKAGE, status: 'active' }, stages: [{ definition: { key: 'accounting', owner: 'both', label: 'Accounting', skippable: true, importer: 'cost_codes' }, state: { status: 'pending' }, gates: [] }], onComplete: action, onSkip: action, onUpdate: action, onMarkLive: action, onResetSample: action })
  const nodes = elements(tree)
  assert.ok(nodes.some(node => node.props.role === 'status'))
  assert.ok(nodes.some(node => node.type === 'CollapsibleTrigger' && !node.props.disabled))
  assert.ok(nodes.some(node => node.type === 'Link' && node.props.href.includes('/import/')))
  for (const node of nodes.filter(node => node.type === 'Button' && !node.props.asChild)) assert.equal(node.props.disabled, true)
  for (const node of nodes.filter(node => node.type === 'form')) await node.props.action(new FormData())
  assert.deepEqual(h.calls, [])
})
test('read-only import workspace leaves inspection filters active and prevents forced edit, commit, discard and update handlers', async () => {
  const h = uiModules(), workspace = load('components/admin/import-workspace.tsx', h.modules).ImportWorkspace
  const action = async () => { h.calls.push('action'); return { success: true } }
  const props = { canManage: false, orgId: ORG, importer: 'cost_codes', columns: [], batches: [], label: 'Cost codes', backHref: '/back', detail: { batch: { id: PACKAGE, status: 'staged', row_count: 1, valid_count: 1 }, rows: [{ id: ACTOR, parsed: {}, issues: [] }], total: 1 }, previewAction: action, stageAction: action, patchAction: action, updateExistingAction: action, commitAction: action, discardAction: action }
  const session = workspace(props), tree = session.type(session.props), nodes = elements(tree)
  assert.ok(nodes.some(node => node.props.role === 'status'))
  const table = nodes.find(node => typeof node.type === 'function' && node.type.name === 'ImportReviewTable')
  assert.equal(table.props.onEdit, undefined)
  const rows = elements(table.type(table.props)); assert.ok(!rows.some(node => node.type === 'Button'))
  for (const node of nodes.filter(node => node.type === 'Button' && ['Discard', 'Stage & validate'].includes(node.props.children))) { assert.equal(node.props.disabled, true); await node.props.onClick() }
  const commit = nodes.find(node => node.type === 'Button' && elements(node.props.children).some(child => child.type === 'CheckCircle2'))
  assert.equal(commit.props.disabled, true); await commit.props.onClick()
  const switchNode = nodes.find(node => node.type === 'Switch'); assert.equal(switchNode.props.disabled, true); await switchNode.props.onCheckedChange(true)
  assert.deepEqual(h.calls, [])
  assert.ok(nodes.filter(node => node.type === 'button').every(node => !node.props.disabled), 'Read-only validation filters remain usable')
})

test('permitted import operator stages CSV in the requested customer org and records the verified actor', async () => {
  const h = harness(['platform.support.read', 'platform.support.write'])
  const batch = await h.imports.stageImportBatch({ importer: 'cost_codes', csvText: 'code,name\n2000,New scope' }, { platformOrgId: ORG })
  assert.equal(batch.status, 'staged'); assert.equal(batch.error_count, 0)
  const stored = h.db.store.import_batches.find(row => row.id === batch.id)
  assert.equal(stored.org_id, ORG); assert.equal(stored.created_by, ACTOR)
  assert.equal(h.db.store.cost_codes?.length ?? 0, 0, 'Staging never publishes domain records')
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'event' && call[1].orgId === ORG && call[1].actorId === ACTOR))
})
test('tenant import and per-importer refusals are enforced before reading or staging domain data', async () => {
  for (const forbiddenKey of ['import.manage', 'plan.write']) {
    const h = harness([]), reads = [], from = h.db.from.bind(h.db)
    h.db.from = table => { reads.push(table); return from(table) }
    const modules = { ...h.modules, '@/lib/services/permissions': {
      ...h.modules['@/lib/services/permissions'],
      requirePermission: async permission => { if (permission === forbiddenKey) throw Error(`Missing ${permission}`) },
    } }
    const imports = load('lib/services/imports.ts', modules)
    await assert.rejects(imports.stageImportBatch({ importer: 'plan_library', csvText: 'plan_code,plan_name\nPL1,Home' }, { orgId: ORG }), new RegExp(`Missing ${forbiddenKey}`))
    assert.deepEqual(reads, [])
  }
})
for (const canManage of [false, true]) {
  test(`actual onboarding page preserves canManage=${canManage} on existing and empty runs`, async () => {
    const h = uiModules(), leaves = new Proxy({}, { get: (_, key) => String(key) })
    for (const run of [null, { id: PACKAGE, status: 'active' }]) {
      const page = load('app/(app)/admin/customers/[orgId]/onboarding/page.tsx', {
        ...h.modules, react: React,
        'next/server': { connection: async () => {} }, 'next/navigation': { notFound: () => { throw Error('Unexpected missing org') } },
        '@/components/layout/page-loading-skeleton': leaves, '@/components/layout/page-layout': leaves,
        '@/components/admin/onboarding-workbench': leaves,
        '@/lib/services/onboarding': { getOnboardingRun: async () => ({ org: { id: ORG, name: 'Builder' }, run, stages: [] }) },
        '@/lib/services/platform-access': { hasAnyPlatformPermission: async permissions => { assert.deepEqual(permissions, ['platform.support.write']); return canManage } },
        './actions': leaves,
      }).default
      const content = page({ params: Promise.resolve({ orgId: ORG }) }).props.children
      const tree = await content.type(content.props), nodes = elements(tree)
      if (run) assert.equal(nodes.find(node => node.type === 'OnboardingWorkbench').props.canManage, canManage)
      else assert.equal(nodes.some(node => node.type === 'form'), canManage)
    }
  })
}

test('new import preview refuses a read-only actor before profile lookup or AI provider work', async () => {
  const h = harness(), reached = () => { h.calls.push('unexpectedProviderOrRead'); throw Error('Unexpected provider/read') }
  const actions = load('app/(app)/admin/customers/[orgId]/onboarding/actions.ts', {
    ...h.modules, 'next/cache': { revalidatePath: reached },
    '@/lib/services/imports': { ...h.imports, getImportMappingProfile: reached },
    '@/lib/services/onboarding': h.onboarding,
    '@/lib/services/demo-community-seed': h.sample,
    '@/lib/services/import-mapping': { suggestImportColumnMapping: reached },
    '@/lib/action-result': { actionError: error => ({ success: false, error: error.message }) },
  })
  const result = await actions.previewImportAction({ orgId: ORG, importer: 'cost_codes', csvText: 'code,name\n2000,Scope' })
  assert.equal(result.success, false); assert.match(result.error, /platform.support.write/); assertWriteDenial(h.calls)
})

test('authorized workbench cannot invoke sample reset while original ownership is unproven', () => {
  const h = uiModules(), workbench = load('components/admin/onboarding-workbench.tsx', h.modules).OnboardingWorkbench
  const action = async () => { h.calls.push('action'); return { success: true } }
  const tree = workbench({ canManage: true, org: { id: ORG, name: 'Builder' }, run: { id: PACKAGE, status: 'active' }, stages: [], onComplete: action, onSkip: action, onUpdate: action, onMarkLive: action })
  const nodes = elements(tree), reset = nodes.find(node => node.type === 'Button' && node.props.children === 'Reset sample community')
  assert.equal(reset.props.disabled, true)
  assert.equal(reset.props.onClick, undefined)
  assert.ok(nodes.some(node => node.props.role === 'status' && String(node.props.children).includes('ownership can be verified')))
  assert.deepEqual(h.calls, [])
})
