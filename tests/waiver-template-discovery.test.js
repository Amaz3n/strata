require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), FOREIGN = id(2), folder = '/Templates/Editable waivers'
const draft = { name: 'Original template', title: 'Waiver', body: 'Original body {{project_name}}', waiverType: 'conditional_progress', status: 'published', reviewed: true, applicability: 'outgoing' }
function file(n, family, stamp, overrides = {}, outer = {}) {
  return { id: id(n), org_id: ORG, folder_path: folder, archived_at: null, created_at: stamp, metadata: { editable_waiver: { ...draft, familyId: family, revision: 1, ...overrides } }, ...outer }
}
function harness(files, { cap = 37, failAfter = null, missingBody = false } = {}) {
  const base = createFakeSupabase({ files }), reads = []
  const db = { from: name => {
    const q = base.from(name), limit = q.limit.bind(q), run = q.run.bind(q)
    q.limit = n => limit(Math.min(n, cap))
    q.run = () => { reads.push(q); if (failAfter !== null && reads.length > failAfter) return { data: null, error: { message: 'later page unavailable' } }; if (missingBody) return { data: null, error: null }; return run() }
    return q
  } }
  const exports = {}, code = ts.transpileModule(fs.readFileSync('lib/services/company-waiver-templates.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const modules = { 'server-only': {}, '@/lib/land/paging': require('../lib/land/paging'), '@/lib/templates/waiver-template': require('../lib/templates/waiver-template') }
  new Function('exports', 'require', code)(exports, name => { if (name in modules) return modules[name]; throw Error(`Unstubbed dependency ${name}`) })
  return { list: options => exports.listEditableWaiverTemplates({ orgId: ORG, supabase: db }, options), reads }
}
test('complete family discovery finds older published templates beyond500 revisions under37 row transport caps', async () => {
  const files = Array.from({ length: 700 }, (_, i) => file(100 + i, `family-${i}`, '2026-10-04T00:00:00Z'))
  files.push(file(900, 'old-family', '2020-01-01T00:00:00Z'))
  files.push(file(91, 'foreign', '2027-01-01T00:00:00Z', {}, { org_id: FOREIGN }))
  files.push(file(92, 'wrong-folder', '2027-01-01T00:00:00Z', {}, { folder_path: '/Other' }))
  files.push(file(93, 'archived', '2027-01-01T00:00:00Z', {}, { archived_at: '2027-01-01' }))
  const h = harness(files), templates = await h.list({ publishedOnly: true, direction: 'outgoing' })
  assert.equal(templates.length, 701); assert.equal(new Set(templates.map(t => t.id)).size, 701); assert.ok(templates.some(t => t.familyId === 'old-family'))
  assert.ok(h.reads.length > 19); assert.ok(templates.every(t => !['foreign', 'wrong-folder', 'archived'].includes(t.familyId)))
})
test('draft does not retire published version while published direction change retires its previous matching revision', async () => {
  const files = [file(100, 'draft-family', '2026-01-01T00:00:00Z'), file(101, 'draft-family', '2026-10-01T00:00:00Z', { status: 'draft', revision: 2 }), file(102, 'changed-family', '2026-01-01T00:00:00Z'), file(103, 'changed-family', '2026-10-01T00:00:00Z', { applicability: 'incoming', revision: 2 })]
  const h = harness(files, { cap: 1 })
  const outgoing = await h.list({ publishedOnly: true, direction: 'outgoing' })
  assert.deepEqual(outgoing.map(t => t.id), [id(100)])
  const incoming = await h.list({ publishedOnly: true, direction: 'incoming' }); assert.deepEqual(incoming.map(t => t.id), [id(103)])
  const editable = await h.list(); assert.deepEqual(editable.map(t => t.id), [id(101), id(103)])
})
test('new published jurisdiction retires old jurisdiction before applicability filtering', async () => {
  const h = harness([file(100, 'original-family', '2026-01-01T00:00:00Z', { jurisdiction: 'FL' }), file(101, 'original-family', '2026-10-01T00:00:00Z', { jurisdiction: 'TX', revision: 2 })])
  assert.deepEqual(await h.list({ publishedOnly: true, jurisdiction: 'FL' }), [])
  assert.deepEqual((await h.list({ publishedOnly: true, jurisdiction: 'TX' })).map(t => t.id), [id(101)])
})
for (const args of [{ failAfter: 2 }, { missingBody: true }]) test(`incomplete revision evidence ${JSON.stringify(args)} refuses partial family selection`, async () => {
  const h = harness(Array.from({ length: 300 }, (_, i) => file(100 + i, `family-${i}`, '2026-01-01T00:00:00Z')), args)
  await assert.rejects(h.list(), /Unable to load complete company waiver templates/)
})
test('verified empty library remains empty', async () => { assert.deepEqual(await harness([]).list(), []) })
for (const count of [10000, 10001]) test(`waiver revision supported bound ${count} never returns a truncated family library`, async () => {
  const h = harness(Array.from({ length: count }, (_, i) => file(100 + i, `family-${i}`, '2026-01-01T00:00:00Z')), { cap: 100 })
  if (count === 10000) assert.equal((await h.list()).length, 10000)
  else await assert.rejects(h.list(), /Validation limit exceeded/)
})
