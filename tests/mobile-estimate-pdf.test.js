const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const id = '00000000-0000-4000-8000-000000000001'
const project = '00000000-0000-4000-8000-000000000002'
function fixture({ found = true, executed = false, fileFound = true, permission = true } = {}) {
  const calls = []
  class MobileAPIError extends Error { constructor(status, code, message) { super(message); this.status = status } }
  const query = table => new Proxy({}, { get: (_, method) => method === 'maybeSingle' ? async () => ({ data: table === 'estimates' ? found ? { id, executed_file_id: executed ? 'file-a' : null } : null : fileFound ? { storage_path: 'org/executed.pdf' } : null }) : (...args) => { calls.push([table, method, ...args]); return query(table) } })
  const mocks = {
    '@/lib/mobile/api': { MobileAPIError, mobileRequestId: () => 'request-a', mobileErrorResponse: error => new Response(error.message, { status: error.status ?? 500 }) },
    '@/lib/mobile/auth': { requireMobileOrg: async () => ({ orgId: 'org-a', serviceContext: {}, serviceSupabase: { from: query } }) },
    '@/lib/mobile/workspace': { requireModule: async (...args) => { calls.push(['module', args[1], args[2]]); if (!permission) throw new MobileAPIError(403, 'forbidden', 'Forbidden') } },
    '@/lib/services/context': { runWithServiceOrgContext: (_, fn) => fn() },
    '@/lib/storage/files-storage': { downloadFilesObject: async () => { calls.push(['stored']); return Buffer.from('%PDF-stored') } },
    '@/app/(app)/estimates/[id]/export/route': { GET: async () => { calls.push(['render']); return new Response('%PDF-draft', { headers: { 'Content-Type': 'application/pdf' } }) } },
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../app/api/mobile/v1/workspace/estimates/[recordId]/pdf/route.ts'), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const workspaceModule = { exports: {} }
  Function('exports', 'require', 'module', code)(workspaceModule.exports, name => name in mocks ? mocks[name] : require(name), workspaceModule)
  return { calls, run: () => workspaceModule.exports.GET(new Request(`https://example.com/api/mobile/v1/workspace/estimates/${id}/pdf?project_id=${project}`), { params: Promise.resolve({ recordId: id }) }) }
}
test('draft PDF uses canonical rendering only after module and exact project checks', async () => {
  const f = fixture()
  const response = await f.run()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  assert.equal(await response.text(), '%PDF-draft')
  assert.ok(f.calls.some(c => c[0] === 'estimates' && c[1] === 'eq' && c[2] === 'project_id' && c[3] === project))
  assert.equal(f.calls[0][0], 'module')
})
test('executed PDF serves the immutable stored file and never substitutes a live render', async () => {
  const f = fixture({ executed: true })
  assert.equal(await (await f.run()).text(), '%PDF-stored')
  assert.equal(f.calls.some(c => c[0] === 'render'), false)
  const missing = fixture({ executed: true, fileFound: false })
  assert.equal((await missing.run()).status, 404)
  assert.equal(missing.calls.some(c => c[0] === 'render' || c[0] === 'stored'), false)
})
test('PDF endpoints reject inaccessible or foreign-project estimates without rendering', async () => {
  for (const options of [{ found: false }, { permission: false }]) {
    const f = fixture(options)
    assert.ok([403, 404].includes((await f.run()).status))
    assert.equal(f.calls.some(c => c[0] === 'render' || c[0] === 'stored'), false)
  }
})
