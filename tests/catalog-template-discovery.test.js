require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), ACTOR = id(2), FOREIGN = id(3)
function load(file, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('exports', 'require', code)(exports, name => { if (name === 'zod') return require('zod'); if (name in modules) return modules[name]; throw Error(`Unstubbed dependency ${name}`) })
  return exports
}
function harness({ denied = false, cap = 37, failAfter = null, missingBody = false, count = 1500 } = {}) {
  const codes = Array.from({ length: count }, (_, i) => ({ id: id(100 + i), org_id: ORG, code: String(count - i).padStart(5, '0'), name: `Cost ${i}`, is_active: i % 2 === 0 }))
  const templates = Array.from({ length: count }, (_, i) => ({ id: id(100 + i), org_id: ORG, name: `Template ${String(count - i).padStart(5, '0')}`, description: null, lines: [{ description: 'Original', quantity: 1, unit_cost_cents: 100 }], is_default: i === 1499, created_at: '2026-10-04T00:00:00Z' }))
  codes.push({ ...codes[0], id: id(99), org_id: FOREIGN }); templates.push({ ...templates[0], id: id(99), org_id: FOREIGN })
  const base = createFakeSupabase({ cost_codes: codes, estimate_templates: templates }), reads = [], writes = [], guards = []
  const db = { from: table => {
    const q = base.from(table), limit = q.limit.bind(q), run = q.run.bind(q)
    q.limit = n => limit(Math.min(n, cap))
    q.run = () => {
      if (q.action !== 'select') { writes.push(q); return run() }
      reads.push(q)
      if (failAfter !== null && reads.length > failAfter) return { data: null, error: { message: 'later page unavailable' } }
      if (missingBody) return { data: null, error: null }
      return run()
    }
    return q
  } }
  const modules = {
    '@/lib/land/paging': require('../lib/land/paging'),
    '@/lib/services/context': { requireOrgContext: async () => ({ orgId: ORG, userId: ACTOR, supabase: db, productTier: 'production' }) },
    '@/lib/services/permissions': { requirePermission: async (key, context) => { guards.push([key, context.orgId, context.userId]); if (denied) throw Error('Forbidden') } },
    '@/lib/services/audit': { recordAudit: async () => {} },
    '@/lib/cost-types': require('../lib/cost-types'),
    '@/lib/data/csi-masterformat': require('../lib/data/csi-masterformat'),
    '@/lib/data/nahb-cost-codes': require('../lib/data/nahb-cost-codes'),
  }
  return { cost: load('lib/services/cost-codes.ts', modules), estimates: load('lib/services/estimate-templates.ts', modules), reads, writes, guards }
}
for (const includeInactive of [false, true]) test(`cost-code discovery completes all selected ${includeInactive ? 'active and archived' : 'active'} codes under37 row transport caps`, async () => {
  const h = harness(), rows = await h.cost.listCostCodes(undefined, includeInactive)
  assert.equal(rows.length, includeInactive ? 1500 : 750); assert.equal(new Set(rows.map(r => r.id)).size, rows.length)
  assert.ok(rows.every(r => r.org_id === ORG && (includeInactive || r.is_active))); assert.ok(rows.some(r => r.id === id(1598)))
  assert.ok(rows.every((r, i) => i === 0 || r.code.localeCompare(rows[i - 1].code) >= 0))
})
test('raw and mapped estimate libraries share complete scope while preserving original record/DTO fields', async () => {
  const h = harness(), raw = await h.estimates.listEstimateTemplateRecords(), mapped = await h.estimates.listEstimateTemplates()
  assert.equal(raw.length, 1500); assert.equal(mapped.length, 1500); assert.equal(raw[0].is_default, true)
  assert.ok(raw.every(r => r.org_id === ORG)); assert.equal(new Set(raw.map(r => r.id)).size, 1500)
  assert.ok(mapped.every(r => r.lines[0].unit_cost_cents === 100)); assert.equal(mapped[0].name, raw[0].name)
  assert.deepEqual(h.guards, [['org.member', ORG, ACTOR], ['org.member', ORG, ACTOR]])
})
for (const method of ['listEstimateTemplates', 'listEstimateTemplateRecords', 'createEstimateTemplate', 'updateEstimateTemplate', 'deleteEstimateTemplate']) test(`direct ${method} preserves existing estimate-domain member permission and denies before DB work`, async () => {
  const h = harness({ denied: true }), input = { name: 'Original', lines: [{ description: 'Line', unit_cost_cents: 100 }] }
  const args = method === 'createEstimateTemplate' ? [input] : method === 'updateEstimateTemplate' ? [id(100), input] : method === 'deleteEstimateTemplate' ? [id(100)] : []
  await assert.rejects(h.estimates[method](...args), /Forbidden/); assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, [])
  assert.deepEqual(h.guards, [['org.member', ORG, ACTOR]])
})
for (const source of ['cost', 'estimates']) for (const args of [{ failAfter: 2 }, { missingBody: true }]) test(`${source} discovery refuses ${JSON.stringify(args)} instead of partial or empty data`, async () => {
  const h = harness(args); await assert.rejects(source === 'cost' ? h.cost.listCostCodes() : h.estimates.listEstimateTemplates(), /Failed to load complete/)
})
for (const count of [2000, 2001]) test(`estimate template supported library bound ${count}`, async () => {
  const h = harness({ count, cap: 100 })
  if (count === 2000) assert.equal((await h.estimates.listEstimateTemplateRecords()).length, 2000)
  else await assert.rejects(h.estimates.listEstimateTemplateRecords(), /Validation limit exceeded/)
})
test('workbench read action delegates canonical original records and preserves created-date order', async () => {
  const source = fs.readFileSync('app/(app)/estimates/actions.ts', 'utf8'), ast = ts.createSourceFile('actions.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'listEstimateTemplatesAction')
  const compiled = ts.transpileModule(fn.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const execute = records => { const exports = {}; new Function('exports', 'listEstimateTemplateRecords', compiled)(exports, records); return exports.listEstimateTemplatesAction() }
  const rows = await execute(async () => [{ id: id(100), is_default: true, created_at: '2026-01-01' }, { id: id(101), is_default: false, created_at: '2026-10-01' }])
  assert.deepEqual(rows.map(r => r.id), [id(101), id(100)]); assert.equal(rows[1].is_default, true)
  const unavailable = Error('query unavailable'); await assert.rejects(execute(async () => { throw unavailable }), e => e === unavailable)
})
