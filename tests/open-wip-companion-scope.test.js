require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict'), test = require('node:test'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), ACTOR = id(2), BUDGET = id(3), PO = id(4), OTHER = id(5), DATE = '2026-10-04'
function harness() {
  const batch = (batchId, kind, extra = {}) => ({ id: batchId, org_id: ORG, importer: 'open_wip', status: 'committed', created_by: ACTOR, onboarding_run_id: null, row_count: 1, committed_count: 1, skipped_count: 0, error_count: 0, context: { file_kind: kind, as_of_date: DATE, is_sample: true }, ...extra })
  const db = createFakeSupabase({ import_batches: [batch(BUDGET, 'budgets'), batch(PO, 'purchase_orders'), batch(OTHER, 'budgets', { context: { file_kind: 'budgets', as_of_date: DATE } })], import_rows: [] })
  const receipt = (batchId, rowId, parsed) => ({ id: rowId, org_id: ORG, batch_id: batchId, row_number: 1, raw: {}, parsed, status: 'committed', issues: [], natural_key: `source:${rowId}`, action: 'created', target_entity_type: 'open_wip', target_entity_id: rowId })
  db.store.import_rows = [receipt(BUDGET, id(20), { community: 'Cypress', lot_number: '12', budget_cents: 100 }), receipt(PO, id(21), { community: 'Cypress', lot_number: '12', remaining_cents: 20 })]
  const calls = [], from = db.from.bind(db)
  db.from = table => { const q = from(table), run = q.run.bind(q); q.run = () => { calls.push({ table, action: q.action }); return run() }; return q }
  const source = fs.readFileSync('lib/services/imports.ts', 'utf8') + '\nexports.companionsForTest = loadOpenWipCompanionBatches; exports.validateForTest = validateOpenWipCompanions; exports.commitForTest = commitOpenWip;'
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  new Function('exports', 'require', code)(exports, name => name === 'zod' ? require('zod') : name === '@/lib/services/import-parsers' ? require('../lib/services/import-parsers') : {})
  const context = { supabase: db, orgId: ORG, userId: ACTOR }
  const request = { file_kind: 'houses', as_of_date: DATE, is_sample: true, companion_batch_ids: { budgets: BUDGET, purchase_orders: PO } }
  return { db, calls, service: exports, context, request }
}
test('explicit sample companions include only original committed budget and PO batches despite other files at the same date', async () => {
  const h = harness()
  const found = await h.service.companionsForTest(h.context, DATE, null, h.request)
  assert.deepEqual(found.map(batch => batch.id).sort(), [BUDGET, PO].sort())
  assert.ok(h.calls.every(call => call.action === 'select'))
})
for (const [name, change] of [
  ['missing original IDs', h => { delete h.request.companion_batch_ids }],
  ['malformed original IDs', h => { h.request.companion_batch_ids.budgets = 'invalid' }],
  ['duplicate original IDs', h => { h.request.companion_batch_ids.purchase_orders = BUDGET }],
  ['partial commit counters', h => { h.db.store.import_batches[0].committed_count = 0 }],
  ['skipped source rows', h => { h.db.store.import_batches[0].skipped_count = 1 }],
  ['failed source rows', h => { h.db.store.import_batches[1].error_count = 1 }],
  ['missing batch', h => { h.db.store.import_batches.splice(0, 1) }],
  ['foreign org', h => { h.db.store.import_batches[0].org_id = OTHER }],
  ['different original creator', h => { h.db.store.import_batches[0].created_by = OTHER }],
  ['different importer', h => { h.db.store.import_batches[0].importer = 'cost_codes' }],
  ['different date', h => { h.db.store.import_batches[0].context.as_of_date = '2026-10-03' }],
  ['different onboarding run', h => { h.db.store.import_batches[0].onboarding_run_id = OTHER }],
  ['swapped kinds', h => { h.request.companion_batch_ids = { budgets: PO, purchase_orders: BUDGET } }],
  ['non-sample budget', h => { h.db.store.import_batches[0].context.is_sample = false }],
  ['staged original budget', h => { h.db.store.import_batches[0].status = 'staged' }],
  ['failed original PO', h => { h.db.store.import_batches[1].status = 'failed' }],
]) test(`${name} rejects staging validation and commit before any domain reads or writes`, async () => {
  const h = harness(); change(h)
  await assert.rejects(h.service.validateForTest([], h.context, h.request))
  await assert.rejects(h.service.commitForTest([{ parsed: {} }], h.context, OTHER, h.request, 'houses'))
  assert.ok(h.calls.every(call => call.table === 'import_batches' && call.action === 'select'))
})
test('ordinary WIP without explicit IDs retains date and onboarding scope discovery', async () => {
  const h = harness()
  const found = await h.service.companionsForTest(h.context, DATE, null)
  assert.equal(found.length, 3)
  h.db.store.import_batches[0].onboarding_run_id = OTHER
  assert.deepEqual((await h.service.companionsForTest(h.context, DATE, OTHER)).map(batch => batch.id), [BUDGET])
})

test('explicit companions consume committed receipts only, excluding uncommitted rows from the same file', async () => {
  const h = harness(), parsed = { community: 'Cypress', lot_number: '12', budget_cents: 100 }
  h.db.store.import_rows.push(...['valid', 'warning'].map((status, i) => ({ id: id(30 + i), org_id: ORG, batch_id: BUDGET, row_number: i + 2, raw: {}, parsed, status, issues: [], natural_key: `budget:${i}` })))
  const houses = [{ id: OTHER, parsed: { community: 'Cypress', lot_number: '12', budget_total_cents: 100 }, issues: [], status: 'valid' }]
  const result = await h.service.validateForTest(houses, h.context, h.request)
  assert.deepEqual(result[0].issues, [])
})

for (const [name, change] of [
  ['missing PO receipt', h => { h.db.store.import_rows.pop() }],
  ['missing budget receipt', h => { h.db.store.import_rows.shift() }],
  ['uncommitted PO receipt', h => { h.db.store.import_rows[1].status = 'valid' }],
  ['foreign receipt', h => { h.db.store.import_rows[1].org_id = OTHER }],
  ['moved receipt batch', h => { h.db.store.import_rows[0].batch_id = OTHER }],
  ['wrong target type', h => { h.db.store.import_rows[0].target_entity_type = 'projects' }],
  ['replaced receipt target', h => { h.db.store.import_rows[1].target_entity_id = OTHER }],
  ['non-created receipt', h => { h.db.store.import_rows[1].action = 'updated' }],
  ['invalid receipt row number', h => { h.db.store.import_rows[1].row_number = 0 }],
  ['duplicate receipt identity', h => { h.db.store.import_rows.push(structuredClone(h.db.store.import_rows[0])); h.db.store.import_batches[0].row_count = h.db.store.import_batches[0].committed_count = 2 }],
  ['duplicate row number', h => { const row = { ...structuredClone(h.db.store.import_rows[0]), id: id(25), target_entity_id: id(25) }; h.db.store.import_rows.push(row); h.db.store.import_batches[0].row_count = h.db.store.import_batches[0].committed_count = 2 }],
]) test(`${name} rejects both original-source validation and commit before any domain access`, async () => {
  const h = harness(); change(h)
  await assert.rejects(h.service.validateForTest([], h.context, h.request), /companion receipts/)
  await assert.rejects(h.service.commitForTest([{ parsed: {} }], h.context, OTHER, h.request, 'houses'), /companion receipts/)
  assert.ok(h.calls.every(call => ['import_batches', 'import_rows'].includes(call.table) && call.action === 'select'))
})
