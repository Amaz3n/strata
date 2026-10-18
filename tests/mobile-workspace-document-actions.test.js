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
const id = '00000000-0000-4000-8000-000000000001'
const accountId = '00000000-0000-4000-8000-000000000002'
function fixture(status = 'draft', permitted = true) {
  const calls = []
  const scope = [{ id, description: 'Work', item_type: 'base', cost_code_id: accountId, quantity: 1, budget_cents: 10000 }]
  const api = load('lib/mobile/workspace-document-actions.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => permitted },
    '@/lib/mobile/workspace-detail': { field: (key, label, kind, required) => ({ key, label, kind, required }), section: (...args) => args },
    '@/lib/mobile/workspace-authoring': { parseWorkspaceRows: JSON.parse },
    '@/lib/validation/commitments': load('lib/validation/commitments.ts'),
    '@/lib/services/bids': { getBidPackage: async () => ({ id: 'bid-a', status, project_id: 'project-a' }), listBidScopeItems: async () => scope, saveBidScopeItems: async args => calls.push(args) },
    '@/lib/services/commitments': { getCommitmentDetail: async () => ({ commitment: { status, project_id: 'project-a' }, lines: [{ id, description: 'Work', quantity: 2, unit: 'hour', unit_cost_cents: 12500, scheduled_value_cents: null }] }), createCommitmentLine: async (...args) => calls.push(args), updateCommitmentLine: async (...args) => calls.push(args) },
  })
  return { api, calls, context: { orgId: 'org-a' }, scope }
}
test('draft scope editing preserves existing cost coding and rejects borrowed or duplicate identities', async () => {
  const f = fixture()
  const row = { id, description: 'Revised work', item_type: 'base', quantity: '2', budget: '300.50', cost_code_id: 'injected' }
  await f.api.performDocumentAction(f.context, 'bids', 'bid-a', 'edit-bid-scope', { items: JSON.stringify([row]) })
  assert.equal(f.calls[0].input.items[0].cost_code_id, accountId)
  assert.equal(f.calls[0].input.items[0].budget_cents, 30050)
  for (const items of [[{ ...row, id: accountId }], [row, row]]) await assert.rejects(f.api.performDocumentAction(f.context, 'bids', 'bid-a', 'edit-bid-scope', { items: JSON.stringify(items) }), error => error.status === 422)
  assert.equal(f.calls.length, 1)
})
test('issued or unauthorized bids and commitments expose no draft-edit actions', async () => {
  for (const [status, permitted] of [['sent', true], ['approved', true], ['draft', false]]) {
    const f = fixture(status, permitted)
    for (const workspaceModule of ['bids', 'commitments']) assert.deepEqual((await f.api.loadDocumentActions(f.context, workspaceModule, 'project-a', 'record-a')).actions, [])
  }
})
test('scope changes produce a new revision and draft commitment lines use dollar inputs', async () => {
  const f = fixture()
  const before = await f.api.loadDocumentActions(f.context, 'bids', 'project-a', 'bid-a')
  f.scope[0].quantity = 3
  const after = await f.api.loadDocumentActions(f.context, 'bids', 'project-a', 'bid-a')
  assert.notEqual(before.actions[0].revision, after.actions[0].revision)
  const commitment = await f.api.loadDocumentActions(f.context, 'commitments', 'project-a', 'record-a')
  assert.equal(commitment.actions[1].fields.find(f => f.key === 'unit_price').value, '125')
  await f.api.performDocumentAction(f.context, 'commitments', 'record-a', 'add-value-line', { description: 'Work', quantity: '1.5', unit: 'hour', unit_price: '125.25', scheduled_value: '', retainage_percent: '10', cost_code_id: accountId })
  assert.equal(f.calls[0][1].unit_cost_cents, 12525)
  assert.equal(f.calls[0][1].cost_code_id, undefined)
})
