const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
function load(file, mocks = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const workspaceModule = { exports: {} }
  Function('exports', 'require', 'module', code)(workspaceModule.exports, id => id in mocks ? mocks[id] : require(id), workspaceModule)
  return workspaceModule.exports
}
class MobileAPIError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code } }
const commercial = load('lib/financials/estimate-commercial.ts', { '@/lib/financials/estimate-totals': load('lib/financials/estimate-totals.ts') })
const validation = load('lib/validation/estimates.ts', { '@/lib/financials/estimate-commercial': commercial })
const fields = load('lib/mobile/workspace-estimate-fields.ts')
const api = load('lib/mobile/workspace-estimates.ts', {
  '@/lib/mobile/api': { MobileAPIError }, '@/lib/mobile/workspace-detail': {},
  '@/lib/mobile/workspace-authoring': { parseWorkspaceRows: JSON.parse },
  '@/lib/financials/estimate-commercial': commercial, '@/lib/validation/estimates': validation,
  '@/lib/mobile/workspace-estimate-fields': fields,
})
const line = { description: 'Work', quantity: '2', unit: 'hour', unit_price: '125.25', markup_pct: '10', is_optional: 'false', is_allowance: 'false', notes: 'Test' }
const values = { title: 'Budget test', lines: JSON.stringify([line]), tax_rate: '7', contingency_percent: '5', pricing_basis: 'Concept drawings' }
test('new native estimates are budget drafts without client-supplied source/accounting data', () => {
  const input = api.parseBudgetDraft({ ...values, precon: { purpose: 'construction_agreement' }, lines: JSON.stringify([{ ...line, cost_code_id: 'injected', metadata: { takeoff: 'injected' } }]) })
  assert.equal(input.precon.purpose, 'budget')
  assert.equal(input.precon.maturity, 'conceptual')
  assert.equal(input.lines[0].unit_cost_cents, 12525)
  assert.equal(input.lines[0].cost_code_id, undefined)
  assert.equal(input.lines[0].metadata, undefined)
})
test('budget revisions retain server cost coding, bid provenance, takeoff metadata and presentation', () => {
  const costId = '00000000-0000-4000-8000-000000000001'
  const bidId = '00000000-0000-4000-8000-000000000002'
  const previous = { precon: { ...commercial.DEFAULT_ESTIMATE_COMMERCIAL, purpose: 'budget', billing_model: 'cost_plus_percent' }, terms: 'Existing terms', intro: 'Existing cover', pricing_display: 'subtotals', photos: [{ path: 'org/photo.jpg', caption: 'Photo' }], lines: [{ id: 'line-a', cost_code_id: costId, item_type: 'line', metadata: { takeoff: { condition_id: 'condition-a' }, source_bid_submission_id: bidId } }] }
  const input = api.parseBudgetDraft({ ...values, lines: JSON.stringify([{ ...line, id: 'line-a', cost_code_id: 'injected' }]) }, previous)
  assert.equal(input.lines[0].cost_code_id, costId)
  assert.equal(input.lines[0].source_bid_submission_id, bidId)
  assert.deepEqual(input.lines[0].metadata.takeoff, { condition_id: 'condition-a' })
  assert.equal(input.precon.billing_model, 'cost_plus_percent')
  assert.equal(input.terms, 'Existing terms')
  assert.equal(input.pricing_display, 'subtotals')
  assert.equal(input.photos[0].path, 'org/photo.jpg')
})
test('estimate rows reject foreign or duplicate identities and invalid monetary inputs', () => {
  const previous = { precon: { ...commercial.DEFAULT_ESTIMATE_COMMERCIAL, purpose: 'budget' }, lines: [{ id: 'line-a', item_type: 'line' }] }
  for (const rows of [[{ ...line, id: 'foreign' }], [{ ...line, id: 'line-a' }, { ...line, id: 'line-a' }], [{ ...line, quantity: '-1' }], [{ ...line, unit_price: 'NaN' }], [{ ...line, unit_price: '-5' }]]) assert.throws(() => api.parseBudgetDraft({ ...values, lines: JSON.stringify(rows) }, previous))
  assert.throws(() => api.parseBudgetDraft({ ...values, recipient_email: 'invalid' }))
  assert.throws(() => api.parseBudgetDraft({ ...values, valid_until: '2026-02-30' }))
})
test('preconstruction agreements validate commercial terms and cannot impersonate approved construction budgets', () => {
  const input = api.parseBudgetDraft({ ...values, purpose: 'preconstruction_agreement', billing_model: 'cost_plus_fixed_fee', fixed_fee: '2500.50', payment_terms: 'Due on completion', retainage_percent: '5' })
  assert.equal(input.precon.purpose, 'preconstruction_agreement')
  assert.equal(input.precon.fixed_fee_cents, 250050)
  assert.equal(input.precon.payment_terms, 'Due on completion')
  assert.throws(() => api.parseBudgetDraft({ ...values, purpose: 'construction_agreement' }))
  assert.throws(() => api.parseBudgetDraft({ ...values, retainage_percent: '101' }))
})
test('editing a construction draft retains its document type and switches an explicitly changed recipient to ad hoc', () => {
  const previous = { precon: { ...commercial.DEFAULT_ESTIMATE_COMMERCIAL, purpose: 'construction_agreement', governing_documents: [{ id: '00000000-0000-4000-8000-000000000001', version_id: null, name: 'Plans' }] }, recipient_contact_id: '00000000-0000-4000-8000-000000000002', recipient_name: 'Old', recipient_email: 'old@example.com', lines: [] }
  const input = api.parseBudgetDraft({ ...values, purpose: 'budget', recipient_name: 'New', recipient_email: 'new@example.com' }, previous)
  assert.equal(input.precon.purpose, 'construction_agreement')
  assert.equal(input.precon.governing_documents[0].name, 'Plans')
  assert.equal(input.recipient_contact_id, null)
  assert.equal(input.recipient_email, 'new@example.com')
})
