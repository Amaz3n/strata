const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
function load(file, mocks) {
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const workspaceModule = { exports: {} }
  Function('exports', 'require', 'module', code)(workspaceModule.exports, id => id in mocks ? mocks[id] : require(id), workspaceModule)
  return workspaceModule.exports
}
class MobileAPIError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code } }
const schema = load('lib/validation/invoices.ts', {})
const input = { project_id: '00000000-0000-4000-8000-000000000001', invoice_number: 'INV-1', title: 'Progress billing', issue_date: '2026-10-01', due_date: '2026-10-31', tax_rate: 0, lines: [{ description: 'Work', quantity: 2, unit: 'hour', unit_cost: 125, taxable: false }] }
function fixture(permitted = true) {
  const calls = []
  const context = { orgId: 'org-a', serviceContext: { userId: 'user-a' } }
  const api = load('lib/mobile/workspace-invoices.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => permitted, requireModule: async (...args) => calls.push(['scope', args[2]]) },
    '@/lib/services/context': { runWithServiceOrgContext: (_context, fn) => fn() },
    '@/lib/validation/invoices': schema,
    '@/lib/services/invoices': { createInvoice: async args => { calls.push(['create', args]); return { id: 'invoice-a' } } },
  })
  return { api, calls, context }
}
test('native invoice drafts force manual draft intent and discard arbitrary financial links', async () => {
  const { api, calls, context } = fixture()
  await api.createMobileInvoiceDraft(context, { ...input, issue: true, source_type: 'from_costs', metadata: { injected: true }, lines: [{ ...input.lines[0], billable_cost_ids: ['other-project-cost'], arc_books_gl_account_id: 'untrusted' }] })
  assert.equal(calls[0][1], input.project_id)
  const created = calls.find(call => call[0] === 'create')[1]
  assert.equal(created.input.issue, false)
  assert.equal(created.input.source_type, 'manual')
  assert.equal(created.input.metadata, undefined)
  assert.equal(created.input.lines[0].billable_cost_ids, undefined)
  assert.equal(created.input.lines[0].arc_books_gl_account_id, undefined)
  assert.equal(created.context.userId, 'user-a')
})
test('native invoice permission and invalid line or date failures never create a draft', async () => {
  const denied = fixture(false)
  await assert.rejects(denied.api.createMobileInvoiceDraft(denied.context, input), error => error.status === 403)
  assert.equal(denied.calls.some(call => call[0] === 'create'), false)
  const { api, calls, context } = fixture()
  for (const payload of [{ ...input, lines: [] }, { ...input, due_date: '2026-09-01' }, { ...input, lines: [{ ...input.lines[0], quantity: -1 }] }, { ...input, lines: [{ ...input.lines[0], unit_cost: Infinity }] }]) {
    await assert.rejects(api.createMobileInvoiceDraft(context, payload))
  }
  assert.equal(calls.length, 0)
})

function editFixture(overrides = {}) {
  const calls = []
  const lineId = '00000000-0000-4000-8000-000000000002'
  const accountId = '00000000-0000-4000-8000-000000000003'
  const existing = { id: 'invoice-a', project_id: input.project_id, status: 'draft', updated_at: 'revision-a', source_type: 'manual',
    lines: [{ id: lineId, description: 'Work', quantity: 2, unit: 'hour', unit_cost_cents: 12500, taxable: false, arc_books_gl_account_id: accountId }],
    metadata: { customer_name: 'Customer', accounting_customer_ref: { id: 'qbo-customer', name: 'Customer' }, tax_jurisdiction_id: accountId, tax_jurisdiction: 'Local tax' },
    totals: { discount_type: 'percent', discount_value: 5 }, ...overrides }
  const context = { orgId: 'org-a', serviceContext: {} }
  const api = load('lib/mobile/workspace-invoices.ts', {
    '@/lib/mobile/api': { MobileAPIError }, '@/lib/validation/invoices': schema,
    '@/lib/mobile/workspace': { allowed: async () => true, requireModule: async () => {} },
    '@/lib/services/context': { runWithServiceOrgContext: (_context, fn) => fn() },
    '@/lib/services/invoices': { getInvoiceWithLines: async () => existing, updateInvoice: async args => { calls.push(args); return existing } },
  })
  return { api, context, calls, lineId, accountId }
}

test('draft revision preserves server accounting links, tax jurisdiction and discounts', async () => {
  const { api, context, calls, lineId, accountId } = editFixture()
  await api.updateMobileInvoiceDraft(context, 'invoice-a', { revision: 'revision-a', input: { ...input, lines: [{ ...input.lines[0], id: lineId, unit_cost: 150, arc_books_gl_account_id: 'injected' }] } })
  const update = calls[0]
  assert.equal(update.expectedUpdatedAt, 'revision-a')
  assert.equal(update.input.issue, false)
  assert.equal(update.input.lines[0].arc_books_gl_account_id, accountId)
  assert.equal(update.input.lines[0].unit_cost, 150)
  assert.equal(update.input.qbo_customer_id, 'qbo-customer')
  assert.equal(update.input.tax_jurisdiction_id, accountId)
  assert.equal(update.input.discount_value, 5)
})

test('stale, foreign-project, issued and source-controlled invoices cannot be revised', async () => {
  for (const overrides of [{ updated_at: 'revision-new' }, { project_id: 'another-project' }, { status: 'sent' }, { source_type: 'from_costs' }, { client_visible: true }]) {
    const { api, context, calls } = editFixture(overrides)
    await assert.rejects(api.updateMobileInvoiceDraft(context, 'invoice-a', { revision: 'revision-a', input }))
    assert.equal(calls.length, 0)
  }
})

test('draft lines cannot borrow links from other invoices or repeat an existing line id', async () => {
  const { api, context, calls, lineId } = editFixture()
  for (const lines of [[{ ...input.lines[0], id: input.project_id }], [{ ...input.lines[0], id: lineId }, { ...input.lines[0], id: lineId }]]) {
    await assert.rejects(api.updateMobileInvoiceDraft(context, 'invoice-a', { revision: 'revision-a', input: { ...input, lines } }), e => e.status === 422)
  }
  assert.equal(calls.length, 0)
})
