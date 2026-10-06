require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const { createConditionTemplateSchema, saveConditionsAsTemplatesSchema, TEMPLATE_LIST_CAP } = require('../lib/validation/takeoff')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), FOREIGN = id(2), ACTOR = id(3), CONDITION = id(4)
const condition = { id: CONDITION, org_id: ORG, name: 'LVP', project_id: id(8), house_plan_version_id: null, uom: 'sf', waste_pct: 8, unit_cost_cents: 12345, cost_code_id: id(5), notes: 'Original measured scope' }
const input = { name: 'LVP', uom: 'sf', unit_cost_cents: 12345 }
const harvest = { condition_ids: [CONDITION], group_name: 'Finishes' }
function fixture(options = {}) {
  const source = (fs.readFileSync('lib/services/takeoff-templates.ts', 'utf8') + '\n' + fs.readFileSync('lib/services/takeoff-scope.ts', 'utf8'))
  const ast = ts.createSourceFile('takeoff-templates.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['numericOrNull', 'mapTemplate', 'verifiedTemplateCount', 'isConfirmedTemplate', 'requireTakeoffWriteScope', 'requireTakeoffCostCodes', 'createConditionTemplate', 'saveConditionsAsTemplates']
  const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(v => ['TEMPLATE_SELECT', 'TEMPLATE_COPY_FIELDS'].includes(v.name.getText(ast))))).map(n => n.getText(ast)).join('\n')
  const js = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const db = createFakeSupabase({ takeoff_condition_templates: options.library ?? [], takeoff_conditions: [condition, { ...condition, id: id(6), org_id: FOREIGN }], cost_codes: [{ id: id(5), org_id: ORG }] })
  const calls = [], audits = []
  const supabase = { from: table => {
    const query = db.from(table), run = query.run.bind(query)
    query.run = () => {
      calls.push({ table, action: query.action, head: query.head, payload: query.payload })
      const result = run()
      if (table === 'takeoff_condition_templates' && query.action === 'select') {
        if (Object.hasOwn(options, 'count')) result.count = options.count
        if (options.readError) result.error = { message: 'Read unavailable' }
        if (!query.head && Object.hasOwn(options, 'data')) result.data = options.data
      }
      return result
    }
    return query
  } }
  const exports = {}
  new Function('exports', 'requireOrgContext', 'requirePermission', 'requireAuthorization', 'getDivisionAccessForUser', 'recordAudit', 'createConditionTemplateSchema', 'saveConditionsAsTemplatesSchema', 'TEMPLATE_LIST_CAP', js)(exports, async () => ({ supabase, orgId: ORG, userId: ACTOR }), async (key, ctx) => { calls.push({ permission: key, ctx }); if (options.denied) throw Error('Forbidden') }, async request => { assert.equal(request.orgId, ORG); assert.equal(request.userId, ACTOR); assert.equal(request.projectId, id(8)); assert.equal(request.permission, 'takeoff.write') }, async () => ({ assignedOnly: false, divisionIds: [] }), async args => audits.push(args), createConditionTemplateSchema, saveConditionsAsTemplatesSchema, TEMPLATE_LIST_CAP)
  return { ...exports, calls, audits, store: db.store }
}
function noWrites(h) { assert.ok(!h.calls.some(c => c.action === 'insert')); assert.deepEqual(h.audits, []) }
const invalid = [null, undefined, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]
for (const count of invalid) {
  test(`create refuses invalid/missing exact count ${String(count)} before insertion`, async () => {
    const h = fixture({ count }); await assert.rejects(h.createConditionTemplate(input), /Unable to verify the template library size/); noWrites(h)
  })
  test(`harvest refuses invalid/missing exact count ${String(count)} before insertion`, async () => {
    const h = fixture({ count }); await assert.rejects(h.saveConditionsAsTemplates(harvest), /Unable to verify the template library size/); noWrites(h)
  })
}
for (const method of ['createConditionTemplate', 'saveConditionsAsTemplates']) {
  test(`${method} refuses errored count even if zero was returned`, async () => {
    const h = fixture({ count: 0, readError: true }); await assert.rejects(h[method](method === 'createConditionTemplate' ? input : harvest), /Unable to verify the template library size/); noWrites(h)
  })
  test(`${method} requires takeoff.write before reads`, async () => {
    const h = fixture({ denied: true }); await assert.rejects(h[method](method === 'createConditionTemplate' ? input : harvest), /Forbidden/)
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].permission, 'takeoff.write'); assert.equal(h.calls[0].ctx.orgId, ORG); assert.equal(h.calls[0].ctx.userId, ACTOR); noWrites(h)
  })
}
for (const data of [null, [], [{ name: null }], [{ name: ' ' }]]) {
  test(`harvest refuses missing, truncated or malformed library names ${JSON.stringify(data)}`, async () => {
    const h = fixture({ count: 1, data }); await assert.rejects(h.saveConditionsAsTemplates(harvest), /Unable to verify the template library names/); noWrites(h)
  })
}
test('harvest refuses an overlong response as well as a truncated one', async () => {
  const h = fixture({ count: 0, data: [{ name: 'Other' }] }); await assert.rejects(h.saveConditionsAsTemplates(harvest), /Unable to verify the template library names/); noWrites(h)
})
test('genuine empty library creates original template with current actor, org and integer cents', async () => {
  const h = fixture({ library: [{ id: id(7), org_id: FOREIGN, name: 'Foreign' }] })
  const result = await h.createConditionTemplate(input)
  assert.equal(result.unit_cost_cents, 12345); assert.equal(result.sort_order, 0)
  assert.equal(result.org_id, ORG); assert.equal(result.created_by, ACTOR)
  assert.equal(h.audits.length, 1); assert.equal(h.audits[0].actorId, ACTOR); assert.equal(h.audits[0].orgId, ORG)
})
test('verified positive count preserves original next sort order', async () => {
  const h = fixture({ library: [{ id: id(7), org_id: ORG, name: 'Existing' }] })
  assert.equal((await h.createConditionTemplate(input)).sort_order, 1)
})
test('create refuses the original verified 500-template capacity', async () => {
  const h = fixture({ count: TEMPLATE_LIST_CAP }); await assert.rejects(h.createConditionTemplate(input), /at most 500 templates/); noWrites(h)
})
test('genuine empty library harvests original condition fields with actor and org', async () => {
  const h = fixture(), result = await h.saveConditionsAsTemplates(harvest), row = h.store.takeoff_condition_templates[0]
  assert.deepEqual(result, { created: 1, skipped: [] }); assert.equal(row.org_id, ORG); assert.equal(row.created_by, ACTOR)
  assert.equal(row.unit_cost_cents, 12345); assert.equal(row.cost_code_id, condition.cost_code_id); assert.equal(row.group_name, 'Finishes'); assert.equal(row.sort_order, 0); assert.equal(row.color, null)
  assert.equal(h.audits.length, 1); assert.equal(h.audits[0].actorId, ACTOR); assert.equal(h.audits[0].orgId, ORG)
})
test('complete verified library preserves case-insensitive duplicate skips', async () => {
  const h = fixture({ library: [{ id: id(7), org_id: ORG, name: ' lVp ' }] })
  assert.deepEqual(await h.saveConditionsAsTemplates(harvest), { created: 0, skipped: ['LVP'] }); assert.ok(!h.calls.some(c => c.action === 'insert'))
})
test('verified full and legacy over-cap libraries preserve no-slot skips without insertion', async () => {
  for (const count of [TEMPLATE_LIST_CAP, TEMPLATE_LIST_CAP + 1]) {
    const h = fixture({ library: Array.from({ length: count }, (_, i) => ({ id: id(100 + i), org_id: ORG, name: `Template ${i}` })) })
    assert.deepEqual(await h.saveConditionsAsTemplates(harvest), { created: 0, skipped: ['LVP'] }); assert.ok(!h.calls.some(c => c.action === 'insert'))
  }
})
