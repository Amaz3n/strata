require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict'), fs = require('node:fs'), test = require('node:test'), ts = require('typescript'), React = require('react')
const { createFakeSupabase } = require('./support/fake-supabase')
const definitions = require('../lib/services/import-definitions')
function load(file, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  const leaves = new Proxy({}, { get: (_, key) => { if (key === '__esModule') return true; return () => { throw Error(`Unexpected dependency invocation ${String(key)}`) } } })
  new Function('exports', 'require', code)(exports, name => modules[name] ?? (name === '@/lib/land/paging' ? require('../lib/land/paging') : name === '@/lib/validation/import-navigation' ? require('../lib/validation/import-navigation') : ['zod', 'react', 'react/jsx-runtime'].includes(name) ? require(name) : leaves))
  return exports
}
function service(tier, permissions) {
  const calls = [], db = createFakeSupabase({ import_batches: [
    { id: 'own', org_id: 'org-a', importer: 'plan_library', status: 'staged' },
    { id: 'foreign', org_id: 'org-b', importer: 'plan_library', status: 'staged' },
  ] })
  const from = db.from.bind(db)
  db.from = table => { calls.push({ table }); return from(table) }
  const allowed = key => permissions.includes('*') || permissions.includes(key)
  const importService = load('lib/services/imports.ts', {
    '@/lib/services/context': { requireOrgContext: async () => ({ orgId: 'org-a', userId: 'actor', productTier: tier, supabase: db }) },
    '@/lib/supabase/server': { createServiceSupabaseClient: () => { calls.push('client'); return db } },
    '@/lib/services/permissions': {
      requirePermission: async key => { calls.push({ permission: key }); if (!allowed(key)) throw Error(`Forbidden ${key}`) },
      requireAnyPermission: async keys => { calls.push({ permissions: keys }); if (!keys.some(allowed)) throw Error(`Forbidden ${keys.join(',')}`) },
    },
    '@/lib/services/platform-access': { requireAnyPlatformPermission: async () => { throw Error('Forbidden platform') } },
    '@/lib/product-tier': { normalizeProductTier: value => value },
    '@/lib/services/import-definitions': definitions,
  })
  return { ...importService, calls }
}
const destinations = [
  ['plan_library', 'plan.write'], ['option_catalog', 'selections.catalog.manage'],
  ['price_book', 'price_book.write'],
  ['communities_lots', 'community.write'], ['communities_lots', 'lot.write'], ['team', 'members.manage'],
]
for (const tier of ['residential', 'commercial', 'production']) for (const [importer, permission] of destinations) test(`${tier} org can read ${importer} imports with ${permission}`, async () => {
  const h = service(tier, ['import.manage', permission]), result = await h.listImportBatches({ importer })
  if (importer === 'plan_library') { assert.equal(result.total, 1); assert.equal(result.batches[0].id, 'own') }
  else assert.equal(result.total, 0)
  assert.ok(h.calls.some(call => call.permission === permission || call.permissions?.includes(permission)))
})
for (const [importer] of destinations) test(`import.manage alone cannot read ${importer} destination data`, async () => {
  const h = service('production', ['import.manage'])
  await assert.rejects(h.listImportBatches({ importer }), /Forbidden/)
  assert.ok(!h.calls.some(call => call.table))
})
test('commitment.write does not open price_book imports; the service requires price_book.write', async () => {
  const h = service('production', ['import.manage', 'commitment.write'])
  await assert.rejects(h.listImportBatches({ importer: 'price_book' }), /Forbidden price_book.write/)
  assert.ok(!h.calls.some(call => call.table))
})
test('destination permission alone does not replace import.manage', async () => {
  const h = service('residential', ['plan.write'])
  await assert.rejects(h.listImportBatches({ importer: 'plan_library' }), /Forbidden import.manage/)
  assert.ok(!h.calls.includes('client'))
})
test('tenant wildcard does not open platform-only Open WIP', async () => {
  const h = service('production', ['*'])
  await assert.rejects(h.listImportBatches({ importer: 'open_wip' }), /restricted to the platform/)
  assert.ok(!h.calls.some(call => call.table))
})
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  return React.isValidElement(node) ? [node, ...nodes(node.props.children)] : []
}
for (const permissions of [['plan.write'], ['selections.catalog.manage'], ['commitment.write'], ['price_book.write'], ['lot.write'], ['members.manage'], ['*'], []]) test(`actual importer roster uses destination grants ${permissions.join(',') || 'none'} without tier or existing-data probes`, async () => {
  const page = load('app/(app)/settings/imports/page.tsx', {
    'next/server': { connection: async () => {} }, 'next/link': { __esModule: true, default: 'Link' },
    '@/lib/services/import-definitions': definitions,
    '@/lib/services/imports': { listImportBatches: async () => ({ batches: [] }) },
    '@/lib/services/permissions': { getCurrentUserPermissions: async () => ({ permissions }) },
    '@/components/layout/page-layout': { PageLayout: 'PageLayout' }, '@/components/settings/settings-section': { SettingsGroup: 'SettingsGroup' }, '@/components/icons': { ChevronRight: 'ChevronRight' },
  })
  const shell = page.default(), tree = nodes(await shell.props.children.type(shell.props.children.props))
  const paths = tree.filter(node => node.type === 'Link').map(node => node.props.href)
  assert.ok(!paths.includes('/settings/imports/open_wip'))
  for (const [importer, grant] of [['plan_library', 'plan.write'], ['option_catalog', 'selections.catalog.manage'], ['price_book', 'price_book.write'], ['communities_lots', 'lot.write'], ['team', 'members.manage']]) {
    assert.equal(paths.includes(`/settings/imports/${importer}`), permissions.includes(grant) || permissions.includes('*'))
  }
})

test('mapping-profile preview needs the destination permission before mapping or AI work', async () => {
  const h = service('residential', ['import.manage'])
  await assert.rejects(h.getImportMappingProfile('plan_library', ['plan_code']), /Forbidden plan.write/)
  assert.ok(!h.calls.some(call => call.table))
})
for (const [name, args] of [
  ['getImportBatch', ['own', {}]],
  ['patchImportRow', [{ batchId: 'own', rowId: 'row', patch: {} }]],
  ['setImportUpdateExisting', ['own', true]],
  ['discardImportBatch', ['own']],
  ['commitImportBatch', ['own']],
]) test(`${name} refuses a selected importer that differs from the original batch before row reads or mutation`, async () => {
  const h = service('commercial', ['import.manage', 'plan.write', 'selections.catalog.manage'])
  await assert.rejects(h[name](...args, { expectedImporter: 'option_catalog' }), /does not belong to this importer/)
  assert.ok(!h.calls.some(call => call.table === 'import_rows'))
})
test('selected importer context permits the matching original batch', async () => {
  const h = service('residential', ['import.manage', 'plan.write'])
  const result = await h.getImportBatch('own', {}, { expectedImporter: 'plan_library' })
  assert.equal(result.batch.id, 'own')
  assert.equal(result.batch.importer, 'plan_library')
})
test('tenant batch actions carry validated original importer context to every canonical mutation', async () => {
  const calls = [], fn = name => async (...args) => { calls.push({ name, args }); return {} }
  const actions = load('app/(app)/settings/imports/actions.ts', {
    'next/cache': { revalidatePath() {} }, '@/lib/services/import-definitions': definitions,
    '@/lib/services/imports': Object.fromEntries(['patchImportRow', 'setImportUpdateExisting', 'discardImportBatch', 'commitImportBatch'].map(name => [name, fn(name)])),
    '@/lib/action-result': { actionError: error => ({ success: false, error: error.message }) },
  })
  const batchId = '00000000-0000-4000-8000-000000000001', input = { importer: 'plan_library', batchId }
  for (const [name, value] of [
    ['patchOrgImportRowAction', { ...input, rowId: batchId, patch: {} }],
    ['setOrgImportUpdateExistingAction', { ...input, updateExisting: true }],
    ['commitOrgImportAction', input], ['discardOrgImportAction', input],
  ]) assert.equal((await actions[name](value)).success, true)
  assert.equal(calls.length, 4)
  assert.ok(calls.every(call => call.args.at(-1).expectedImporter === 'plan_library'))
})
