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
const projectId = '00000000-0000-4000-8000-000000000001'
const fileId = '00000000-0000-4000-8000-000000000002'
const companyId = '00000000-0000-4000-8000-000000000003'
function fixture({ availableFiles = [fileId], canReadFiles = true } = {}) {
  const calls = [], filters = []
  const query = new Proxy({}, { get: (_, method) => method === 'then' ? (resolve) => resolve({ data: availableFiles.map(id => ({ id })) }) : (...args) => { filters.push([method, ...args]); return query } })
  const api = load('lib/mobile/workspace-authoring.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => canReadFiles },
    '@/lib/mobile/workspace-punch': { punchAssignmentChoices: async () => [{ id: companyId }] },
    '@/lib/validation/transmittals': load('lib/validation/transmittals.ts'),
    '@/lib/validation/change-orders': load('lib/validation/change-orders.ts'),
    '@/lib/validation/commitments': load('lib/validation/commitments.ts'),
    '@/lib/services/transmittals': { createTransmittal: async (input, orgId) => calls.push({ input, orgId }) },
    '@/lib/services/change-orders': { createChangeOrder: async input => calls.push(input) },
    '@/lib/services/commitments': { createCommitment: async input => calls.push(input) },
    '@/lib/services/bids': { createBidPackage: async input => calls.push(input) },
  })
  return { api, calls, filters, context: { orgId: 'org-a', serviceSupabase: { from: () => query } } }
}
const transmittal = { subject: 'Plans for review', purpose: 'for_review', items: JSON.stringify([{ description: 'Plans', copies: '2', file_id: fileId, entity_id: projectId }]), recipients: JSON.stringify([{ display_name: 'Test Recipient', email: 'test@example.com' }]) }
test('transmittal enclosure lookup is organization/project scoped and discards untrusted entity links', async () => {
  const f = fixture()
  await f.api.createWorkspaceDocument(f.context, 'transmittals', projectId, { ...transmittal, status: 'sent', sent_at: 'now' })
  assert.deepEqual(f.filters.filter(filter => filter[0] === 'eq'), [['eq', 'org_id', 'org-a'], ['eq', 'project_id', projectId]])
  assert.equal(f.calls[0].input.items[0].copies, 2)
  assert.equal(f.calls[0].input.items[0].entity_id, undefined)
  assert.equal(f.calls[0].input.sent_at, undefined)
})
test('foreign, archived or unreadable enclosures and invalid recipients cannot create a transmittal', async () => {
  for (const setup of [{ availableFiles: [] }, { canReadFiles: false }]) {
    const f = fixture(setup)
    await assert.rejects(f.api.createWorkspaceDocument(f.context, 'transmittals', projectId, transmittal))
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  await assert.rejects(f.api.createWorkspaceDocument(f.context, 'transmittals', projectId, { ...transmittal, recipients: '[{"email":"invalid","display_name":"Name"}]' }))
  assert.equal(f.calls.length, 0)
})
test('change order authoring forces a private draft and drops source links and workflow injection', async () => {
  const f = fixture()
  await f.api.createWorkspaceDocument(f.context, 'change-orders', projectId, { title: 'Scope change', summary: 'Additional work', status: 'approved', client_visible: true, lines: JSON.stringify([{ description: 'Site visit', quantity: '2', unit_cost: '125.50', budget_line_id: fileId, internal_cost_cents: '1' }]) })
  const input = f.calls[0].input
  assert.equal(input.status, 'draft')
  assert.equal(input.lifecycle, 'draft')
  assert.equal(input.client_visible, false)
  assert.equal(input.lines[0].unit_cost, 125.5)
  assert.equal(input.lines[0].budget_line_id, undefined)
  assert.equal(input.lines[0].internal_cost_cents, undefined)
})
test('structured rows reject malformed, empty, oversized and non-string payloads', () => {
  const { api } = fixture()
  for (const value of ['{', '[]', '[{"quantity":2}]', JSON.stringify(Array(101).fill({ description: 'x' })), ' '.repeat(10001)]) assert.throws(() => api.parseWorkspaceRows(value))
})
test('commitments convert dollars to cents, require project vendors and reject reversed dates', async () => {
  const f = fixture()
  const input = { title: 'Trade contract', company_id: companyId, total: '125.25', status: 'approved', start_date: '2026-10-01', end_date: '2026-10-31' }
  await f.api.createWorkspaceDocument(f.context, 'commitments', projectId, input)
  assert.equal(f.calls[0].input.total_cents, 12525)
  assert.equal(f.calls[0].input.status, 'draft')
  for (const invalid of [{ company_id: fileId }, { end_date: '2026-09-01' }, { total: 'NaN' }]) await assert.rejects(f.api.createWorkspaceDocument(f.context, 'commitments', projectId, { ...input, ...invalid }))
  assert.equal(f.calls.length, 1)
})
test('organization scope cannot create unassigned project documents', async () => {
  const f = fixture()
  for (const moduleId of ['bids', 'commitments', 'transmittals', 'change-orders']) await assert.rejects(f.api.createWorkspaceDocument(f.context, moduleId, undefined, {}), error => error.status === 422)
  assert.equal(f.calls.length, 0)
})
