require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), ACTOR = id(2), CODE = id(3), PARENT = id(4), ROOT = id(5), FOREIGN = id(6)
function harness(rows = [], { denied = false, failureId, missingWrite = false, transportCap = 1000 } = {}) {
  const base = createFakeSupabase({ cost_codes: [{ id: CODE, org_id: ORG, code: 'Existing', name: 'Existing', parent_id: null, is_active: true }, ...rows] })
  const reads = [], mutations = [], audits = [], guards = []
  const db = { from(table) {
    const q = base.from(table), run = q.run.bind(q)
    q.run = () => {
      if (q.action === 'select') {
        reads.push(q)
        const result = run()
        if (failureId && result.data?.id === failureId) return { data: null, error: { message: 'hierarchy unavailable' } }
        if (Array.isArray(result.data)) result.data = result.data.slice(0, transportCap)
        return result
      }
      mutations.push(q)
      if (missingWrite) return { data: null, error: null }
      const result = run()
      if (q.action === 'update' && q.cardinality === 'single') {
        if (!Array.isArray(result.data) || result.data.length !== 1) return { data: null, error: { message: 'expected exactly one row' } }
        result.data = result.data[0]
      }
      return result
    }
    return q
  } }
  const modules = {
    zod: require('zod'),
    '@/lib/land/paging': require('../lib/land/paging'),
    '@/lib/services/audit': { recordAudit: async args => audits.push(args) },
    '@/lib/services/context': { requireOrgContext: async org => { if (org && org !== ORG) throw Error('No membership'); return { orgId: ORG, userId: ACTOR, supabase: db, productTier: 'production' } } },
    '@/lib/services/permissions': { requirePermission: async (permission, context) => { guards.push({ permission, orgId: context.orgId, userId: context.userId }); if (denied) throw Error('Forbidden') } },
    '@/lib/cost-types': require('../lib/cost-types'),
    '@/lib/data/csi-masterformat': require('../lib/data/csi-masterformat'),
    '@/lib/data/nahb-cost-codes': require('../lib/data/nahb-cost-codes'),
  }
  const exports = {}, code = ts.transpileModule(fs.readFileSync('lib/services/cost-codes.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('exports', 'require', code)(exports, name => { if (!(name in modules)) throw Error(`Unstubbed dependency ${name}`); return modules[name] })
  return { service: exports, reads, mutations, audits, guards, store: base.store }
}
const row = (key, parent = null, org = ORG) => ({ id: key, org_id: org, code: key, name: key, parent_id: parent })
for (const kind of ['create', 'update', 'active']) test(`direct ${kind} service requires current org administrator before reads or writes`, async () => {
  const h = harness([], { denied: true })
  const work = kind === 'create' ? h.service.createCostCode({ code: 'New', name: 'New' }) : kind === 'update' ? h.service.updateCostCode({ id: CODE, name: 'Changed' }) : h.service.setCostCodeActive(CODE, false)
  await assert.rejects(work, /Forbidden/); assert.deepEqual(h.reads, []); assert.deepEqual(h.mutations, []); assert.deepEqual(h.audits, [])
  assert.deepEqual(h.guards, [{ permission: 'org.admin', orgId: ORG, userId: ACTOR }])
})
test('valid create traverses only selected ancestry and audits its actual actor', async () => {
  const h = harness([row(PARENT, ROOT), row(ROOT)]), created = await h.service.createCostCode({ code: 'New', name: 'New', parent_id: PARENT })
  assert.equal(created.parent_id, PARENT); assert.equal(h.reads.length, 2)
  assert.equal(h.audits[0].actorId, ACTOR); assert.equal(h.audits[0].orgId, ORG)
})
test('valid reparent preserves unrelated code settings and audits exact before/after', async () => {
  const h = harness([row(PARENT, ROOT), row(ROOT)]), updated = await h.service.updateCostCode({ id: CODE, parent_id: PARENT })
  assert.equal(updated.id, CODE); assert.equal(updated.parent_id, PARENT); assert.equal(updated.name, 'Existing'); assert.equal(updated.is_active, true)
  assert.equal(h.audits[0].actorId, ACTOR); assert.equal(h.audits[0].before.parent_id, null); assert.equal(h.audits[0].after.parent_id, PARENT)
})
test('large truncated catalog cannot hide selected descendants beyond its first thousand rows', async () => {
  const many = Array.from({ length: 2000 }, (_, i) => row(id(100 + i)))
  const deepParent = id(3000); many.push(row(deepParent, CODE))
  const h = harness(many, { transportCap: 1000 })
  await assert.rejects(h.service.updateCostCode({ id: CODE, parent_id: deepParent }), /circular/)
  assert.equal(h.reads.length, 1); assert.deepEqual(h.mutations, [])
  assert.ok(h.reads.every(q => q.filters.length === 2), 'Each ancestry query includes exact org and id')
})
for (const kind of ['create', 'update']) test(`${kind} rejects pre-existing cycle without looping or writing`, async () => {
  const h = harness([row(PARENT, ROOT), row(ROOT, PARENT)])
  const work = kind === 'create' ? h.service.createCostCode({ code: 'New', name: 'New', parent_id: PARENT }) : h.service.updateCostCode({ id: CODE, parent_id: PARENT })
  await assert.rejects(work, /circular/); assert.equal(h.reads.length, 2); assert.deepEqual(h.mutations, [])
})
for (const rows of [[row(PARENT, ROOT), row(ROOT, null, FOREIGN)], [row(PARENT, ROOT)], [row(PARENT, null, FOREIGN)]]) test(`foreign or missing selected ancestry ${JSON.stringify(rows.map(r => r.id))} refuses writes`, async () => {
  const h = harness(rows); await assert.rejects(h.service.updateCostCode({ id: CODE, parent_id: PARENT }), /parent must belong/)
  assert.deepEqual(h.mutations, []); assert.deepEqual(h.audits, [])
})
test('late ancestry query failure cannot become a root', async () => {
  const h = harness([row(PARENT, ROOT), row(ROOT)], { failureId: ROOT })
  await assert.rejects(h.service.updateCostCode({ id: CODE, parent_id: PARENT }), /Unable to validate/); assert.deepEqual(h.mutations, [])
})
test('excessive legacy depth fails within a bounded number of exact reads', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => row(id(5000 + i), i === 1000 ? null : id(5001 + i)))
  const h = harness(rows); await assert.rejects(h.service.updateCostCode({ id: CODE, parent_id: rows[0].id }), /supported depth/)
  assert.equal(h.reads.length, 1000); assert.deepEqual(h.mutations, [])
})
test('direct self-parent is rejected before any query', async () => {
  const h = harness(); await assert.rejects(h.service.updateCostCode({ id: CODE, parent_id: CODE }), /own parent/); assert.deepEqual(h.reads, []); assert.deepEqual(h.mutations, [])
})
test('explicit parent removal can repair malformed old ancestry', async () => {
  const h = harness(); h.store.cost_codes[0].parent_id = id(99)
  const result = await h.service.updateCostCode({ id: CODE, parent_id: null }); assert.equal(result.parent_id, null); assert.equal(h.reads.length, 1)
})
for (const kind of ['create', 'update']) test(`${kind} missing save body never emits an audit or success`, async () => {
  const h = harness([], { missingWrite: true })
  const work = kind === 'create' ? h.service.createCostCode({ code: 'New', name: 'New' }) : h.service.updateCostCode({ id: CODE, name: 'Changed' })
  await assert.rejects(work, /Missing saved cost code/); assert.deepEqual(h.audits, [])
})
test('valid active flag delegates the same guarded and actor-audited mutation', async () => {
  const h = harness(), result = await h.service.setCostCodeActive(CODE, false)
  assert.equal(result.is_active, false); assert.equal(h.guards.length, 1); assert.equal(h.audits[0].actorId, ACTOR)
})
