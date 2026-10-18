require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict'), test = require('node:test'), fs = require('node:fs'), ts = require('typescript')
const { isDeepStrictEqual } = require('node:util')
const { createFakeSupabase } = require('./support/fake-supabase')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), ACTOR = id(2), COMMUNITY = id(3), BATCH = id(4), OTHER = id(5)
function load(path, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  new Function('exports', 'require', code)(exports, name => modules[name] ?? (name === 'zod' ? require(name) : name === 'server-only' ? {} : (() => { throw Error(`Unexpected dependency ${name}`) })()))
  return exports
}
function harness() {
  const receipts = Array.from({ length: 6 }, (_, i) => ({ id: id(20 + i), org_id: ORG, batch_id: BATCH, row_number: i + 1, status: 'committed', action: 'created', target_entity_type: 'open_wip', target_entity_id: id(40 + i), parsed: { community_id: COMMUNITY, lot_number: String(12 + i) } }))
  const projects = receipts.map(row => ({ id: row.target_entity_id, org_id: ORG, metadata: { imported_open_wip: true, wip_cutover: { batch_id: BATCH, row_id: row.id, as_of_date: '2026-10-04' }, untouched: { customer: 'Original metadata' } } }))
  projects.push({ id: id(99), org_id: ORG, metadata: { imported_open_wip: true, wip_cutover: { batch_id: OTHER, row_id: OTHER }, production: true } })
  const db = createFakeSupabase({ import_batches: [{ id: BATCH, org_id: ORG, created_by: ACTOR, importer: 'open_wip', status: 'committed', context: { is_sample: true, file_kind: 'houses' }, row_count: 6, committed_count: 6, skipped_count: 0, error_count: 0 }], import_rows: receipts, projects, communities: [{ id: COMMUNITY, org_id: ORG, metadata: { is_sample: true } }], lots: receipts.map((row, i) => ({ id: id(60 + i), org_id: ORG, community_id: COMMUNITY, project_id: row.target_entity_id, lot_number: String(12 + i) })) })
  const calls = [], from = db.from.bind(db)
  let beforeUpdate = () => {}
  db.from = table => {
    const q = from(table), eq = q.eq.bind(q), run = q.run.bind(q)
    q.eq = (column, value) => column === 'metadata' ? q.addFilter(row => isDeepStrictEqual(row.metadata, JSON.parse(value))) : eq(column, value)
    q.or = expression => q.addFilter(row => expression.split(',').some(term => { const [column, op, ...value] = term.split('.'); assert.equal(op, 'ilike'); return String(row[column] ?? '').toLowerCase() === value.join('.').toLowerCase() }))
    q.run = () => {
      if (['insert', 'upsert', 'update', 'delete'].includes(q.action)) { calls.push([q.action, table]); if (q.action === 'update') beforeUpdate(table) }
      const result = run()
      if (q.action === 'update' && q.returning && q.cardinality && !result.error) {
        if (result.data.length > 1 || (q.cardinality === 'single' && result.data.length !== 1)) return { data: null, error: { message: 'Mutation cardinality' } }
        return { ...result, data: result.data[0] ?? null }
      }
      return result
    }
    return q
  }
  const modules = { '@/lib/services/platform-access': { requireAnyPlatformPermission: async () => ({ id: ACTOR }) }, '@/lib/supabase/server': { createServiceSupabaseClient: () => db } }
  const service = load('lib/services/sample-home-provenance.ts', modules)
  const input = { orgId: ORG, communityId: COMMUNITY, batchId: BATCH, actorUserId: ACTOR }
  return { db, calls, modules, service, input, beforeUpdate: fn => { beforeUpdate = fn } }
}
test('only six created sample receipts can tag homes; all original source metadata and unrelated WIP remain intact', async () => {
  const h = harness(), before = structuredClone(h.db.store.projects)
  assert.deepEqual(await h.service.tagSampleImportedHomes(h.input), { tagged: 6, batchId: BATCH })
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(h.db.store.projects[i].metadata, { ...before[i].metadata, is_sample: true, sample_community_id: COMMUNITY, sample_import_batch_id: BATCH })
  }
  assert.deepEqual(h.db.store.projects[6], before[6])
  assert.equal(h.calls.length, 6)
})
for (const [name, corrupt] of [
  ['foreign batch', h => { h.db.store.import_batches[0].org_id = OTHER }],
  ['different creator', h => { h.db.store.import_batches[0].created_by = OTHER }],
  ['uncommitted batch', h => { h.db.store.import_batches[0].status = 'committing' }],
  ['non-sample source', h => { h.db.store.import_batches[0].context.is_sample = false }],
  ['missing receipt', h => h.db.store.import_rows.pop()],
  ['reused existing receipt', h => { h.db.store.import_rows[0].action = 'skipped_existing' }],
  ['duplicate target', h => { h.db.store.import_rows[1].target_entity_id = h.db.store.import_rows[0].target_entity_id }],
  ['foreign parent', h => { h.db.store.import_rows[0].parsed.community_id = OTHER }],
  ['wrong lot', h => { h.db.store.lots[0].lot_number = '99' }],
  ['moved lot', h => { h.db.store.lots[0].community_id = OTHER }],
  ['wrong source body', h => { h.db.store.projects[0].metadata.wip_cutover.row_id = OTHER }],
  ['missing home', h => h.db.store.projects.shift()],
  ['foreign home', h => { h.db.store.projects[0].org_id = OTHER }],
]) test(`${name} rejects the entire evidence set before any metadata mutation`, async () => {
  const h = harness(); corrupt(h); const before = structuredClone(h.db.store.projects)
  await assert.rejects(h.service.tagSampleImportedHomes(h.input), /evidence|receipts/)
  assert.deepEqual(h.calls, []); assert.deepEqual(h.db.store.projects, before)
})
test('a concurrent metadata change survives the exact original snapshot comparison', async () => {
  const h = harness(); let first = true
  h.beforeUpdate(table => { if (first && table === 'projects') { first = false; h.db.store.projects[0].metadata.concurrent = 'Keep this change' } })
  await assert.rejects(h.service.tagSampleImportedHomes(h.input), /metadata changed/)
  assert.equal(h.db.store.projects[0].metadata.concurrent, 'Keep this change')
  assert.equal(h.db.store.projects[0].metadata.is_sample, undefined)
})
for (const [table, field, value] of [
  ['house_plans', 'code', 'cl1650'], ['selection_options', 'sku', 'CYP-OPT-01'], ['selection_categories', 'name', 'Cypress Sample — Kitchen'], ['companies', 'name', 'Cypress Sample Trade 1'], ['communities', 'name', 'Cypress Landing'], ['communities', 'code', 'cyp'], ['schedule_templates', 'name', 'Cypress Landing 120-day build'], ['contacts', 'email', 'sample-buyer-1@example.invalid'],
]) test(`sample namespace collision in ${table}.${field} prevents all seed writes and imports`, async () => {
  const h = harness(); h.db.store.communities = []; h.db.store[table] = [{ id: OTHER, org_id: ORG, [field]: value }]
  const reached = () => { h.calls.push('import'); throw Error('Unexpected import') }
  const seed = load('lib/services/demo-community-seed.ts', { ...h.modules, '@/lib/services/imports': { stageImportBatch: reached, commitImportBatch: reached }, '@/lib/services/sample-home-provenance': h.service, '@/lib/services/audit': { recordAudit: reached }, '@/lib/services/events': { recordEvent: reached } })
  await assert.rejects(seed.seedSampleCommunity(ORG, ACTOR), /namespace already exists/)
  assert.deepEqual(h.calls, [])
})
test('legacy or partially seeded community cannot masquerade as completed seeding', async () => {
  const h = harness(), reached = () => { h.calls.push('import'); throw Error('Unexpected import') }
  const seed = load('lib/services/demo-community-seed.ts', { ...h.modules, '@/lib/services/imports': { stageImportBatch: reached }, '@/lib/services/sample-home-provenance': h.service, '@/lib/services/audit': {}, '@/lib/services/events': {} })
  await assert.rejects(seed.seedSampleCommunity(ORG, ACTOR), /completion is unproven/)
  assert.deepEqual(h.calls, [])
})

function seedHarness() {
  const h = harness(); h.db.store.communities = []
  h.db.store.cost_codes = Array.from({ length: 5 }, (_, i) => ({ id: id(80 + i), org_id: ORG, code: String(1000 + i), is_active: true }))
  const realPlan = { id: OTHER, org_id: ORG, code: 'REAL', series: 'Cypress Landing Sample', metadata: { real: 'Preserve this plan' }, versions: [{ id: OTHER, status: 'draft', metadata: { real: true } }] }
  h.db.store.house_plans = [realPlan]
  const staged = new Map(); let serial = 0
  const imports = {
    stageImportBatch: async input => { const batchId = input.sourceFilename === 'sample-wip-houses.csv' ? BATCH : id(200 + serial++); staged.set(batchId, input); return { id: batchId, error_count: 0 } },
    commitImportBatch: async batchId => {
      const input = staged.get(batchId)
      if (input.sourceFilename === 'sample-plans.csv') {
        for (let i = 0; i < 3; i++) {
          const version = { id: id(140 + i), org_id: ORG, status: 'draft', metadata: { plan_source: 'Keep original version evidence' } }
          h.db.store.house_plan_versions ??= []; h.db.store.house_plan_versions.push(version)
          h.db.store.house_plans.push({ id: id(120 + i), org_id: ORG, code: ['CL1650', 'CL1900', 'CL2400'][i], series: 'Cypress Landing Sample', metadata: { imported: true, original: 'Keep plan evidence' }, versions: [structuredClone(version)] })
        }
      }
      if (input.sourceFilename === 'sample-lots.csv') h.db.store.communities.push({ id: COMMUNITY, org_id: ORG, name: 'Cypress Landing', metadata: { imported: true, original: 'Keep community evidence' } })
      return { id: batchId, status: 'committed' }
    },
  }
  h.db.rpc = async (name, args) => { assert.equal(name, 'release_house_plan_version'); assert.equal(args.p_actor_id, ACTOR); return { error: null } }
  const seed = load('lib/services/demo-community-seed.ts', { ...h.modules, '@/lib/services/imports': imports, '@/lib/services/sample-home-provenance': h.service, '@/lib/services/audit': { recordAudit: async () => {} }, '@/lib/services/events': { recordEvent: async () => {} } })
  return { ...h, seed, staged, realPlan: structuredClone(realPlan) }
}
test('actual seed consumes original house batch and preserves other WIP, same-series plan and source metadata', async () => {
  const h = seedHarness(), realHome = structuredClone(h.db.store.projects[6])
  assert.deepEqual(await h.seed.seedSampleCommunity(ORG, ACTOR), { communityId: COMMUNITY })
  assert.deepEqual(h.db.store.projects[6], realHome)
  assert.deepEqual(h.db.store.house_plans[0], h.realPlan)
  for (const version of h.db.store.house_plan_versions) assert.equal(version.metadata.plan_source, 'Keep original version evidence')
  assert.equal(h.db.store.communities[0].metadata.original, 'Keep community evidence')
  assert.equal(h.db.store.communities[0].metadata.sample_seed_status, 'seeded')
  assert.equal(h.db.store.communities[0].metadata.sample_home_batch_id, BATCH)
  assert.equal(h.db.store.projects.filter(row => row.metadata.sample_import_batch_id === BATCH).length, 6)
  const companionIds = Object.fromEntries([...h.staged].filter(([, input]) => ['sample-wip-budgets.csv', 'sample-wip-pos.csv'].includes(input.sourceFilename)).map(([batchId, input]) => [input.context.file_kind, batchId]))
  assert.deepEqual(h.staged.get(BATCH).context.companion_batch_ids, companionIds)
})
test('failed original home tagging cannot publish a completed sample marker or silently restart seed', async () => {
  const h = seedHarness(); h.db.store.projects[0].metadata.wip_cutover.row_id = OTHER
  await assert.rejects(h.seed.seedSampleCommunity(ORG, ACTOR), /source evidence/)
  assert.equal(h.db.store.communities[0].metadata.sample_seed_status, 'building')
  const before = structuredClone(h.db.store)
  await assert.rejects(h.seed.seedSampleCommunity(ORG, ACTOR), /completion is unproven/)
  assert.deepEqual(h.db.store, before)
})

test('authorized sample reset fails before data access rather than deleting by mutable markers or names', async () => {
  const h = harness()
  const reached = () => { throw Error('Unexpected data access or mutation') }
  const seed = load('lib/services/demo-community-seed.ts', {
    ...h.modules,
    '@/lib/supabase/server': { createServiceSupabaseClient: reached },
    '@/lib/services/imports': { stageImportBatch: reached, commitImportBatch: reached },
    '@/lib/services/sample-home-provenance': h.service,
    '@/lib/services/audit': { recordAudit: reached }, '@/lib/services/events': { recordEvent: reached },
  })
  await assert.rejects(seed.deleteSampleCommunity(ORG, COMMUNITY, ACTOR), /reset is unavailable.*ownership.*preserved/)
  assert.deepEqual(h.calls, [])
})
