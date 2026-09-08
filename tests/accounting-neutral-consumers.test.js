require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { findDuplicatePayable } = require('../lib/services/payable-duplicate-check')

function database({ bills = [], mappings = [], errorTable } = {}) {
  const calls = []
  return { calls, from(table) {
    const filters = []
    const query = { select(columns) { calls.push({ table, columns, filters }); return query },
      eq(key, value) { filters.push([key, value]); return query }, neq() { return query }, order() { return query }, limit() { return query }, gte() { return query },
      in(key, values) { filters.push([key, values]); return query },
      then(resolve) {
        const source = table === 'vendor_bills' ? bills : mappings
        const data = source.filter(row => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value))
        return Promise.resolve({ data, error: errorTable === table ? { message: 'database unavailable' } : null }).then(resolve)
      } }
    return query
  } }
}
const bill = { id: 'bill-a', org_id: 'org', bill_number: 'INV-1', invoice_number_normalized: 'inv1', company_id: null, accounting_coding: { counterparty: { id: '42', name: 'Vendor A' } }, metadata: {}, total_cents: 100, bill_date: '2026-09-08' }
const input = { orgId: 'org', billNumber: 'INV-1', companyId: null, vendorAliases: { accountingVendorId: '42', connectionId: 'connection-a' } }
test('duplicate vendor identity matches only within the selected accounting connection', async () => {
  const mapping = { org_id: 'org', connection_id: 'connection-a', entity_type: 'bill', entity_id: 'bill-a' }
  const same = database({ bills: [bill], mappings: [mapping] })
  assert.equal((await findDuplicatePayable({ ...input, supabase: same })).billId, 'bill-a')
  const other = database({ bills: [bill], mappings: [{ ...mapping, connection_id: 'connection-b' }] })
  assert.equal(await findDuplicatePayable({ ...input, supabase: other }), null)
  assert.ok(same.calls.every(call => call.filters.some(([key, value]) => key === 'org_id' && value === 'org')))
})
test('a vendor ID without a connection cannot match another book', async () => {
  assert.equal(await findDuplicatePayable({ ...input, vendorAliases: { accountingVendorId: '42' }, supabase: database({ bills: [bill] }) }), null)
})
test('neutral vendor name remains a duplicate signal when there is no company link', async () => {
  const result = await findDuplicatePayable({ ...input, vendorAliases: { vendorName: 'Vendor A' }, supabase: database({ bills: [bill] }) })
  assert.equal(result.billId, bill.id)
})
test('failed neutral identity lookup blocks duplicate-sensitive creation', async () => {
  await assert.rejects(findDuplicatePayable({ ...input, supabase: database({ bills: [bill], errorTable: 'accounting_sync_records' }) }), /Unable to verify payable accounting identity/)
})
test('legacy cached IDs and names do not influence duplicate decisions', async () => {
  const stale = { ...bill, accounting_coding: {}, qbo_vendor_id: '42', qbo_vendor_name: 'Vendor A' }
  assert.equal(await findDuplicatePayable({ ...input, vendorAliases: { vendorName: 'Vendor A' }, supabase: database({ bills: [stale] }) }), null)
})

test('mobile expense reads use the neutral ledger status with dropped columns absent', async () => {
  const fs = require('node:fs')
  const vm = require('node:vm')
  const ts = require('typescript')
  const state = require('../lib/services/accounting-sync-state')
  const code = ts.transpileModule(fs.readFileSync('lib/mobile/expenses.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const compiled = { exports: {} }
  const queries = []
  const rows = {
    project_expenses: [{ id: 'expense', org_id: 'org', project_id: 'project', amount_cents: 1000, status: 'approved', created_at: '2026-09-08', qbo_sync_status: 'synced' }],
    accounting_sync_records: [{ entity_id: 'expense', org_id: 'org', entity_type: 'project_expense', status: 'needs_review', connection_id: 'book', provider: 'qbo', external_id: '42', updated_at: '2026-09-08' }],
  }
  const supabase = { from(table) {
    const query = { select(columns) { assert.doesNotMatch(columns, /qbo_/); queries.push({ table, columns }); return query }, eq() { return query }, order() { return query }, limit() { return query }, in() { return query }, then(resolve) { return Promise.resolve({ data: rows[table], error: null }).then(resolve) } }
    return query
  } }
  vm.runInNewContext(code, { module: compiled, exports: compiled.exports, require(id) {
    if (id === 'zod') return require('zod')
    if (id.endsWith('/accounting-sync-state')) return state
    if (id.endsWith('/projects')) return { listProjects: async () => [{ id: 'project' }] }
    if (id.endsWith('/api')) return { MobileAPIError: class extends Error {} }
    return {}
  } })
  const result = await compiled.exports.listMobileExpenses({ orgId: 'org', serviceSupabase: supabase }, 'project')
  assert.equal(result[0].amount_cents, 1000)
  assert.equal(result[0].accounting_sync_status, 'needs_review')
  assert.equal(queries.filter(item => item.table === 'accounting_sync_records').length, 1)
})
