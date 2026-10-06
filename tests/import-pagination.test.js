require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict'), fs = require('node:fs'), test = require('node:test'), ts = require('typescript'), React = require('react')
const { createFakeSupabase } = require('./support/fake-supabase')
const navigation = require('../lib/validation/import-navigation'), definitions = require('../lib/services/import-definitions')
function load(file, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(file, 'utf8') + (file === 'lib/services/imports.ts' ? '\nexport { refreshBatchCounts }' : ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  new Function('exports', 'require', code)(exports, name => modules[name] ?? (name === '@/lib/land/paging' ? require('../lib/land/paging') : ['zod', 'react', 'react/jsx-runtime'].includes(name) ? require(name) : new Proxy({}, { get: (_, key) => String(key) })))
  return exports
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function service(response) {
  const db = createFakeSupabase({
    import_batches: [...Array.from({ length: 60 }, (_, index) => ({ id: id(index + 1), org_id: 'org-a', importer: 'plan_library', status: 'staged', created_at: '2026-10-04T12:00:00Z' })), { id: id(80), org_id: 'org-b', importer: 'plan_library' }],
    import_rows: [...Array.from({ length: 10000 }, (_, index) => ({ id: id(index + 100), org_id: 'org-a', batch_id: id(1), row_number: index + 1, status: (index + 1) % 1999 === 0 ? 'error' : 'valid', parsed: {}, issues: [] })), { id: id(20000), org_id: 'org-b', batch_id: id(1), row_number: 10001, status: 'error', parsed: {} }],
  })
  const from = db.from.bind(db)
  db.from = table => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => {
      if (table === response?.table) return response.result
      const result = run()
      if (query.action === 'update' && query.cardinality && !result.error) {
        if (result.data.length !== 1) return { data: null, error: { message: 'Expected one updated batch' } }
        return { ...result, data: result.data[0] }
      }
      if (Array.isArray(result.data) && response?.transportCap) result.data = result.data.slice(0, response.transportCap)
      return result
    }
    return query
  }
  const reader = load('lib/services/imports.ts', {
    '@/lib/services/context': { requireOrgContext: async () => ({ orgId: 'org-a', userId: 'actor', productTier: 'commercial', supabase: db }) },
    '@/lib/supabase/server': { createServiceSupabaseClient: () => db },
    '@/lib/services/permissions': { requirePermission: async () => {}, requireAnyPermission: async () => {} },
    '@/lib/services/import-definitions': definitions, '@/lib/validation/import-navigation': navigation,
  })
  return { ...reader, db }
}
test('bounded row pages cover all 10000 original batch rows without another org or duplicates', async () => {
  const reader = service(), seen = new Set()
  for (let page = 1; page <= 20; page++) {
    const result = await reader.getImportBatch(id(1), { page, limit: 500 }, { expectedImporter: 'plan_library' })
    assert.equal(result.total, 10000); assert.equal(result.rows.length, 500)
    for (const row of result.rows) { assert.ok(!seen.has(row.id)); seen.add(row.id) }
  }
  assert.equal(seen.size, 10000)
})
test('server status filtering finds all errors beyond the first row page with correct filtered totals', async () => {
  const reader = service(), numbers = []
  for (let page = 1; page <= 3; page++) {
    const result = await reader.getImportBatch(id(1), { page, limit: 2, status: 'error' })
    assert.equal(result.total, 5); assert.equal(result.status, 'error')
    numbers.push(...result.rows.map(row => row.row_number))
  }
  assert.deepEqual(numbers, [1999, 3998, 5997, 7996, 9995])
})
test('history pages preserve a deterministic order for tied timestamps across all 60 batches', async () => {
  const reader = service(), ids = []
  for (let page = 1; page <= 3; page++) {
    const result = await reader.listImportBatches({ importer: 'plan_library', page, limit: 25 })
    assert.equal(result.total, 60); assert.ok(result.batches.length <= 25)
    ids.push(...result.batches.map(batch => batch.id))
  }
  assert.deepEqual(ids, Array.from({ length: 60 }, (_, index) => id(60 - index)))
})
for (const table of ['import_batches', 'import_rows']) test(`missing exact ${table} count is unavailable rather than an empty queue`, async () => {
  const reader = service({ table, result: { data: [], count: null, error: null } })
  await assert.rejects(table === 'import_batches' ? reader.listImportBatches() : reader.getImportBatch(id(1)), /unavailable/)
})
for (const page of [NaN, 0, -1, 1.5, Infinity, 100001]) test(`service rejects invalid page ${page}`, async () => {
  await assert.rejects(service().listImportBatches({ page }))
})
test('navigation normalizes malformed values and retains valid row status and page independently', () => {
  assert.deepEqual(navigation.importNavigationSchema.parse({ batchPage: '-1', rowPage: 'Infinity', rowStatus: 'foreign' }), { batchPage: 1, rowPage: 1, rowStatus: 'all' })
  assert.deepEqual(navigation.importNavigationSchema.parse({ batchPage: '3', rowPage: '20', rowStatus: 'error' }), { batchPage: 3, rowPage: 20, rowStatus: 'error' })
})
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes)
  return React.isValidElement(node) ? [node, ...nodes(node.props.children)] : []
}
test('read-only workbench pagers preserve the selected batch/status and filters request the full server set', () => {
  const pushes = [], leaf = new Proxy({}, { get: (_, key) => String(key) })
  const modules = {
    'next/link': { __esModule: true, default: 'Link' },
    react: { ...React, useState: value => [value, () => {}], useMemo: fn => fn(), useRef: () => ({ current: null }), useTransition: () => [false, () => {}] },
    'next/navigation': { useRouter: () => ({ push: (...args) => pushes.push(args), refresh() {} }) },
    ...Object.fromEntries(['badge', 'button', 'dialog', 'input', 'select', 'switch', 'tabs'].map(name => [`@/components/ui/${name}`, leaf])),
    '@/components/icons': leaf,
  }
  const pager = load('components/layout/queue-pagination.tsx', modules).QueuePagination
  modules['@/components/layout/queue-pagination'] = { QueuePagination: pager }
  const workspace = load('components/admin/import-workspace.tsx', modules).ImportWorkspace
  const shell = workspace({ canManage: false, orgId: 'org-a', importer: 'plan_library', workspaceHref: '/settings/imports/plan_library', backHref: '/settings/imports', batches: [], batchPagination: { page: 3, limit: 25, total: 60 }, columns: [], detail: { batch: { id: id(1), status: 'staged', row_count: 10000, error_count: 7 }, rows: [], total: 7, page: 2, limit: 2, status: 'error' } })
  const tree = nodes(shell.type(shell.props)), pagers = tree.filter(node => node.type === pager)
  assert.equal(pagers.length, 2)
  const rowPager = pagers.find(node => node.props.pageParam === 'rowPage')
  for (const link of nodes(pager(rowPager.props)).filter(node => node.type === 'Link')) {
    const url = new URL(link.props.href, 'https://fixture.test')
    assert.equal(url.searchParams.get('batch'), id(1)); assert.equal(url.searchParams.get('rowStatus'), 'error'); assert.equal(url.searchParams.get('batchPage'), '3')
  }
  tree.find(node => node.type === 'button' && typeof node.props.onClick === 'function').props.onClick()
  const url = new URL(pushes[0][0], 'https://fixture.test')
  assert.equal(url.searchParams.get('rowStatus'), 'all'); assert.equal(url.searchParams.get('rowPage'), '1'); assert.equal(url.searchParams.get('batch'), id(1))
  const filter = tree.find(node => node.type === 'Select' && node.props.value === 'error')
  assert.deepEqual(nodes(filter).filter(node => node.type === 'SelectItem').map(node => node.props.value), ['all', 'pending', 'valid', 'warning', 'error', 'skipped', 'committed'])
  filter.props.onValueChange('skipped')
  const filtered = new URL(pushes[1][0], 'https://fixture.test')
  assert.equal(filtered.searchParams.get('rowStatus'), 'skipped'); assert.equal(filtered.searchParams.get('rowPage'), '1')
})

test('a capped recent-history preview never reports an older importer as never run', async () => {
  const page = load('app/(app)/settings/imports/page.tsx', {
    'next/server': { connection: async () => {} }, 'next/link': { __esModule: true, default: 'Link' },
    '@/lib/services/import-definitions': definitions,
    '@/lib/services/imports': { listImportBatches: async () => ({ batches: [{ id: id(2), importer: 'team', status: 'committed' }], total: 80 }) },
    '@/lib/services/permissions': { getCurrentUserPermissions: async () => ({ permissions: ['*'] }) },
  })
  const shell = page.default(), tree = await shell.props.children.type(shell.props.children.props)
  function text(node) { return typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : React.isValidElement(node) ? text(node.props.children) : '' }
  const copy = text(tree)
  assert.ok(copy.includes('No batch in recent history'))
  assert.ok(copy.includes('Open an importer to browse its full history'))
  assert.ok(!copy.includes('Never run'))
})

test('platform reader receives independent history/row pages and retains selected importer association', async () => {
  const calls = [], page = load('app/(app)/admin/customers/[orgId]/onboarding/import/[importer]/page.tsx', {
    'next/server': { connection: async () => {} }, 'next/navigation': { notFound() { throw Error('Not found') } },
    '@/lib/validation/import-navigation': navigation, '@/lib/services/import-definitions': definitions,
    '@/lib/services/onboarding': { getOnboardingRun: async () => ({ org: { name: 'Builder' }, run: { id: id(90) } }) },
    '@/lib/services/platform-access': { hasAnyPlatformPermission: async () => false },
    '@/lib/services/imports': {
      listImportBatches: async (...args) => { calls.push(['list', ...args]); return { batches: [], total: 60, page: 3, limit: 25 } },
      getImportBatch: async (...args) => { calls.push(['detail', ...args]); return { batch: { id: id(1) }, rows: [], total: 5, page: 2, limit: 500, status: 'error' } },
    },
  })
  const shell = page.default({ params: Promise.resolve({ orgId: id(80), importer: 'plan_library' }), searchParams: Promise.resolve({ batch: id(1), batchPage: '3', rowPage: '2', rowStatus: 'error' }) })
  const result = await shell.props.children.type(shell.props.children.props), workspace = result.props.children
  assert.deepEqual(calls.find(call => call[0] === 'list'), ['list', { importer: 'plan_library', limit: 25, page: 3 }, { platformOrgId: id(80) }])
  assert.deepEqual(calls.find(call => call[0] === 'detail'), ['detail', id(1), { limit: 500, page: 2, status: 'error' }, { platformOrgId: id(80), expectedImporter: 'plan_library' }])
  assert.equal(workspace.props.canManage, false)
  assert.equal(workspace.props.workspaceHref, `/admin/customers/${id(80)}/onboarding/import/plan_library`)
})

test('recount covers all 10000 staged rows and preserves errors beyond the transport cap', async () => {
  const reader = service(), counts = await reader.refreshBatchCounts({ supabase: reader.db, orgId: 'org-a' }, id(1))
  assert.equal(counts.row_count, 10000); assert.equal(counts.error_count, 5); assert.equal(counts.valid_count, 9995)
  assert.equal(reader.db.store.import_batches.find(batch => batch.id === id(1)).error_count, 5)
})
test('recount refuses to overwrite a batch that has entered commit', async () => {
  const reader = service(), original = reader.db.store.import_batches.find(batch => batch.id === id(1))
  original.status = 'committing'; original.row_count = 10000
  await assert.rejects(reader.refreshBatchCounts({ supabase: reader.db, orgId: 'org-a' }, id(1)), /Failed to save import counts/)
  assert.equal(original.status, 'committing'); assert.equal(original.row_count, 10000)
})

test('an unavailable recount page never replaces original counts with zero', async () => {
  const reader = service({ table: 'import_rows', result: { data: null, error: null } }), original = reader.db.store.import_batches.find(batch => batch.id === id(1))
  original.row_count = 10000; original.error_count = 5
  await assert.rejects(reader.refreshBatchCounts({ supabase: reader.db, orgId: 'org-a' }, id(1)), /unavailable/)
  assert.equal(original.row_count, 10000); assert.equal(original.error_count, 5)
})

test('a lower transport cap cannot silently skip rows or shrink batch counts', async () => {
  const reader = service({ transportCap: 100 }), original = reader.db.store.import_batches.find(batch => batch.id === id(1))
  original.row_count = 10000; original.error_count = 5
  await assert.rejects(reader.getImportBatch(id(1), { limit: 500 }), /page is incomplete/)
  await assert.rejects(reader.refreshBatchCounts({ supabase: reader.db, orgId: 'org-a' }, id(1)), /membership is incomplete/)
  assert.equal(original.row_count, 10000); assert.equal(original.error_count, 5)
})
test('the normal 1000-row transport cap still permits a complete staged-batch recount', async () => {
  const reader = service({ transportCap: 1000 })
  const counts = await reader.refreshBatchCounts({ supabase: reader.db, orgId: 'org-a' }, id(1))
  assert.equal(counts.row_count, 10000); assert.equal(counts.error_count, 5)
})
