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
const activity = load('lib/sales/activity.ts'), reasons = load('lib/sales/lost-reasons.ts')
const validation = load('lib/validation/prospects.ts', { '@/lib/sales/activity': activity, '@/lib/sales/lost-reasons': reasons })
function fixture({ status = 'new', phase = 'precon', permitted = true } = {}) {
  const calls = [], revision = '2026-10-01T12:00:00Z'
  const query = new Proxy({}, { get: (_, method) => method === 'maybeSingle' ? async () => ({ data: { id: 'project-a', phase } }) : () => query })
  const api = load('lib/mobile/workspace-precon.ts', {
    '@/lib/mobile/api': { MobileAPIError },
    '@/lib/mobile/workspace': { allowed: async () => permitted },
    '@/lib/mobile/workspace-detail': { field: (key, label, kind, required) => ({ key, label, kind, required }), section: (...args) => args },
    '@/lib/sales/activity': activity, '@/lib/sales/lost-reasons': reasons, '@/lib/validation/prospects': validation,
    '@/lib/services/prospects': { getProspect: async () => ({ id: 'prospect-a', name: 'Test', status, updated_at: revision }), listProspectContacts: async () => [], listProspectActivity: async () => [], updateProspect: async args => calls.push(args), setProspectFollowUp: async args => calls.push(args) },
  })
  return { api, context: { orgId: 'org-a', serviceSupabase: { from: () => query } }, calls, revision }
}
test('closed, delivered and unauthorized opportunities cannot expose edit or follow-up actions', async () => {
  for (const options of [{ status: 'won' }, { phase: 'delivery' }, { permitted: false }]) {
    const f = fixture(options)
    assert.deepEqual((await f.api.loadProspectDetail(f.context, 'prospect-a')).actions, [])
  }
  const lost = fixture({ status: 'lost' })
  assert.deepEqual((await lost.api.loadProspectDetail(lost.context, 'prospect-a')).actions.map(a => a.id), ['reopen-prospect'])
})
test('document-controlled pipeline stages cannot be set manually', async () => {
  const f = fixture({ status: 'pricing' })
  assert.equal((await f.api.loadProspectDetail(f.context, 'prospect-a')).actions.some(a => a.id === 'change-lead-stage'), false)
  for (const status of ['won', 'executed', 'pricing', 'client_approved']) await assert.rejects(f.api.performProspectAction(f.context, 'prospect-a', 'change-lead-stage', { status }, f.revision))
  assert.equal(f.calls.length, 0)
})
test('prospect edits preserve concurrency checks and reject invalid follow-up dates', async () => {
  const f = fixture()
  await f.api.performProspectAction(f.context, 'prospect-a', 'edit-prospect', { name: 'Updated', source: 'Referral' }, f.revision)
  assert.equal(f.calls[0].input.expected_updated_at, f.revision)
  await assert.rejects(f.api.performProspectAction(f.context, 'prospect-a', 'follow-up', { date: '2026-02-30' }))
  await f.api.performProspectAction(f.context, 'prospect-a', 'follow-up', { date: '2026-10-15' })
  assert.equal(f.calls[1].nextFollowUpAt, '2026-10-15T12:00:00.000Z')
})
