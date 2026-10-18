const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../components/documents/view-state.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const loaded = { exports: {} }
Function('exports', 'require', 'module', code)(loaded.exports, require, loaded)
const { reconcileFolderChildren, appendUniqueFiles, isCurrentViewRequest, folderParent } = loaded.exports

test('deleting a folder removes the entire cached branch and counts, preserving similarly named siblings', () => {
  const previous = {
    paths: ['/Plans', '/Plans/Old', '/Plans/Old/Nested', '/Plans/Older', '/Other', '/Other/Keep'],
    counts: { '/Plans/Old': 0, '/Plans/Old/Nested': 0, '/Plans/Older': 3, '/Other/Keep': 4 },
  }
  const result = reconcileFolderChildren(previous, '/Plans', [{ path: '/Plans/Older', itemCount: 5 }])
  assert.deepEqual(result.paths, ['/Other', '/Other/Keep', '/Plans', '/Plans/Older'])
  assert.deepEqual(result.counts, { '/Plans/Older': 5, '/Other/Keep': 4 })
  assert.equal(previous.paths.length, 6)
})

test('renaming a root folder removes its old loaded descendants while preserving another loaded branch', () => {
  const result = reconcileFolderChildren({
    paths: ['/Old', '/Old/Nested', '/Other', '/Other/Keep'],
    counts: { '/Old': 1, '/Old/Nested': 2, '/Other': 3 },
  }, '', [{ path: '/New', itemCount: 1 }, { path: '/Other', itemCount: 3 }])
  assert.deepEqual(result.paths, ['/New', '/Other', '/Other/Keep'])
  assert.deepEqual(result.counts, { '/New': 1, '/Other': 3 })
})

test('an authoritative empty listing clears only the requested parent descendants', () => {
  const result = reconcileFolderChildren({ paths: ['/A', '/A/Child', '/AB/Keep'], counts: { '/A/Child': 3 } }, '/A', [])
  assert.deepEqual(result.paths, ['/A', '/AB/Keep'])
  assert.deepEqual(result.counts, {})
})

test('late pages cannot write after navigation or mutation, even if the folder stays the same', async () => {
  let activeKey = '/A|all'
  let generation = 1
  let rows = [{ id: 'b' }]
  let resolvePage
  const page = new Promise(resolve => { resolvePage = resolve })
  const requestKey = activeKey
  const requestGeneration = generation
  const pending = page.then(incoming => {
    if (isCurrentViewRequest(requestKey, requestGeneration, activeKey, generation)) rows = appendUniqueFiles(rows, incoming)
  })
  activeKey = '/B|all'
  resolvePage([{ id: 'a' }])
  await pending
  assert.deepEqual(rows, [{ id: 'b' }])
  activeKey = '/A|all'
  generation++
  assert.equal(isCurrentViewRequest(requestKey, requestGeneration, activeKey, generation), false)
  assert.equal(isCurrentViewRequest(activeKey, generation, activeKey, generation), true)
})

test('overlapping pages retain existing rows and do not duplicate IDs within or across pages', () => {
  assert.deepEqual(appendUniqueFiles([{ id: 'a', name: 'original' }], [
    { id: 'a', name: 'duplicate' }, { id: 'b' }, { id: 'b' }, { id: 'c' },
  ]), [{ id: 'a', name: 'original' }, { id: 'b' }, { id: 'c' }])
})

test('folder parents handle both root children and deeper paths', () => {
  assert.equal(folderParent('/Plans'), '')
  assert.equal(folderParent('/Plans/Permits'), '/Plans')
})
