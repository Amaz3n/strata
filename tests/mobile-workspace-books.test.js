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
function fixture({ canWrite = true, proof = {}, system = false } = {}) {
  const calls = []
  const account = { id: 'cash', name: 'Cash', code: '1000', active: true, subtype: 'cash' }
  const workspace = { accounts: [account, { id: 'expense', name: 'Office', code: '6000', active: true, subtype: 'other_expense' }], bankAccounts: [{ id: 'bank', name: 'Bank', gl_account_id: 'cash' }], bankTransactions: [], unmatchedTransactions: [{ id: 'transaction' }], bankReconciliations: [], bankTransactionsTruncated: false }
  const api = load('lib/mobile/workspace-books.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => canWrite },
    '@/lib/mobile/workspace-detail': { field: (key, label, kind = 'text', required = false) => ({ key, label, kind, required }), section: (id, title, rows) => ({ id, title, records: rows }) },
    '@/lib/services/books/workspace': { getBooksWorkspace: async () => workspace },
    '@/lib/services/books/bank-reconciliation': {
      getBankReconciliationDetail: async () => ({ id: 'statement', status: 'draft', differenceCents: 0, bookDifferenceCents: 0, items: [], ...proof }),
      createBankReconciliation: async input => { calls.push(input); return 'created' },
    },
    '@/lib/services/books/bank-rules': {
      getBankCostCodingOptions: async () => ({ projects: [{ id: 'project-a', name: 'Project A' }], costCodes: [{ id: 'cost-a', name: 'Framing', code: '06100' }] }),
      categorizeBankTransaction: async input => { calls.push(input) },
    },
  })
  return { api, calls, context: { orgId: 'org-a' }, row: { id: 'account-a', name: 'Account', is_system: system, active: true } }
}
test('reconciliation close requires complete matching evidence, not only a zero difference', async () => {
  for (const proof of [{ differenceCents: 1 }, { bookDifferenceCents: 1 }, { truncated: true }, { items: [{ status: 'outstanding' }] }, { status: 'closed' }]) {
    const { api, context } = fixture({ proof })
    const result = await api.loadBooksDetail(context, 'bank-reconciliations', { id: 'statement' })
    assert.equal(result.actions.some(action => action.id === 'close-reconciliation'), false)
  }
  const { api, context } = fixture()
  assert.equal((await api.loadBooksDetail(context, 'bank-reconciliations', { id: 'statement' })).actions.some(action => action.id === 'close-reconciliation'), true)
})
test('system chart accounts and readers do not receive editing actions', async () => {
  for (const options of [{ system: true }, { canWrite: false }]) {
    const { api, context, row } = fixture(options)
    assert.equal((await api.loadBooksDetail(context, 'chart', row)).actions.length, 0)
  }
})
test('statement amounts reject extra precision and invalid date ranges before mutation', async () => {
  const { api, context, calls } = fixture()
  const input = { statement_start: '2026-09-01', statement_end: '2026-09-30', beginning_balance: '100.25', ending_balance: '-20.50' }
  await assert.rejects(api.performBooksAction(context, 'banking', 'bank', 'start-reconciliation', { ...input, ending_balance: '1.001' }))
  await assert.rejects(api.performBooksAction(context, 'banking', 'bank', 'start-reconciliation', { ...input, statement_end: '2026-08-31' }))
  assert.equal(calls.length, 0)
  await api.performBooksAction(context, 'banking', 'bank', 'start-reconciliation', input)
  assert.equal(calls[0].orgId, 'org-a')
  assert.equal(calls[0].bankAccountId, 'bank')
  assert.equal(calls[0].beginningBalanceCents, 10025)
  assert.equal(calls[0].endingBalanceCents, -2050)
})
test('categorization excludes the cash account and offers scoped project and cost choices', async () => {
  const { api, context, calls } = fixture()
  const detail = await api.loadBooksDetail(context, 'bank-transactions', { id: 'transaction', bank_account_id: 'bank' })
  const action = detail.actions.find(action => action.id === 'categorize')
  assert.deepEqual(action.fields[0].options, ['expense'])
  assert.deepEqual(action.fields.find(f => f.key === 'project_id').options, ['', 'project-a'])
  await api.performBooksAction(context, 'bank-transactions', 'transaction', 'categorize', { account_id: 'expense', project_id: '', cost_code_id: '', memo: 'Office' })
  assert.equal(calls[0].projectId, null)
  assert.equal(calls[0].learn, false)
  assert.equal(calls[0].orgId, 'org-a')
})

test('Books access rejects assigned-division users even when the role grants books.read', async () => {
  let divisionScope = 'assigned'
  const workspace = load('lib/mobile/workspace.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace-catalog': {},
    '@/lib/services/authorization': { authorize: async () => ({ allowed: true, divisionScope }) },
    '@/lib/services/context': {},
    '@/lib/services/projects': {},
    '@/lib/product-tier': {},
  })
  const context = { user: { id: 'user-a' }, orgId: 'org-a' }
  assert.equal(await workspace.allowed(context, 'books.read'), false)
  assert.equal(await workspace.allowed(context, 'project.read', 'project-a'), true)
  divisionScope = 'all'
  assert.equal(await workspace.allowed(context, 'books.read'), true)
})

test('native thumbnails tolerate incomplete metadata and select a bounded preview', () => {
  const { photoThumbnailPath } = load('lib/mobile/photo-media.ts', { '@/lib/storage/files-storage': {} })
  assert.equal(photoThumbnailPath(null), null)
  assert.equal(photoThumbnailPath({ preview: { sizes: {}, thumbnail_path: 8 } }), null)
  assert.equal(photoThumbnailPath({ preview: { sizes: [null, { path: 'bad', width: -1 }, { path: 'large', width: 2048, content_type: 'image/webp' }, { path: 'thumb', width: 512, content_type: 'image/webp' }] } }), 'thumb')
  assert.equal(photoThumbnailPath({ preview: { thumbnail_path: 'fallback' } }), 'fallback')
})
