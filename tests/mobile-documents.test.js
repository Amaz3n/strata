require('../scripts/register-ts-node-test')
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
function fixture(permitted = true) {
  const requests = [], signed = [], permissions = []
  const rows = Array.from({ length: 1002 }, (_, i) => ({ id: `file-${i}`, file_name: `${i}.pdf`, folder_path: i === 1001 ? '/Plans2' : i === 1000 ? '/Plans/Nested' : '/', storage_path: `files/${i}`, updated_at: '2026-10-01' }))
  const supabase = { from(table) {
    const filters = [], page = { from: 0, to: 999 }
    const query = new Proxy({}, { get: (_, method) => method === 'then' ? (resolve) => { requests.push({ table, filters, ...page }); resolve({ data: rows.slice(page.from, page.to + 1) }) } : (...args) => { if (method === 'range') { page.from = args[0]; page.to = args[1] } else filters.push([method, ...args]); return query } })
    return query
  } }
  const mocks = {
    '@/lib/mobile/api': { MobileAPIError: class extends Error { constructor(status, code, message) { super(message); this.status = status } } },
    '@/lib/services/projects': { listProjects: async () => [{ id: 'project-a' }] },
    '@/lib/services/authorization': { authorize: async args => { permissions.push(args.permission); return { allowed: permitted } } },
    '@/lib/services/audit': {},
    '@/lib/services/project-file-upload': require('../lib/services/project-file-upload'),
    '@/lib/storage/files-storage': { createFilesDownloadUrl: async args => { signed.push(args.path); return { downloadUrl: 'https://example.com/file' } } },
  }
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../lib/mobile/files.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const loadedModule = { exports: {} }
  Function('exports', 'require', 'module', code)(loadedModule.exports, id => id in mocks ? mocks[id] : require(id), loadedModule)
  return { api: loadedModule.exports, context: { orgId: 'org-a', user: { id: 'user-a' }, serviceSupabase: supabase }, requests, signed, permissions }
}
test('project document manifests include every page with explicit organization and project filters', async () => {
  const f = fixture()
  const result = await f.api.listMobileFiles(f.context, 'project-a', '/', true)
  assert.equal(result.files.length, 1002)
  assert.equal(f.signed.length, 1002)
  assert.deepEqual(f.requests.map(r => r.from), [0, 1000])
  assert.deepEqual(f.permissions, ['docs.read'])
  for (const request of f.requests) {
    assert.ok(request.filters.some(f => f[0] === 'eq' && f[1] === 'project_id' && f[2] === 'project-a'))
    assert.ok(request.filters.some(f => f[0] === 'eq' && f[1] === 'org_id' && f[2] === 'org-a'))
    assert.ok(request.filters.some(f => f[0] === 'is' && f[1] === 'archived_at' && f[2] === null))
  }
})
test('folder browsing signs only direct files and keeps similarly named folder boundaries separate', async () => {
  const f = fixture()
  const result = await f.api.listMobileFiles(f.context, 'project-a', '/Plans')
  assert.deepEqual(result.folders, [{ path: '/Plans/Nested', name: 'Nested', file_count: 1 }])
  assert.deepEqual(result.files, [])
  assert.deepEqual(f.signed, [])
})
test('read, upload and delete enforce distinct permissions before touching documents', async () => {
  const f = fixture(false)
  await assert.rejects(f.api.listMobileFiles(f.context, 'project-a', '/'), e => e.status === 403)
  await assert.rejects(f.api.uploadMobileFile(f.context, 'project-a', new FormData()), e => e.status === 403)
  await assert.rejects(f.api.deleteMobileFile(f.context, 'project-a', 'file-a'), e => e.status === 403)
  assert.deepEqual(f.permissions, ['docs.read', 'docs.upload', 'docs.delete'])
  assert.equal(f.requests.length, 0)
})
