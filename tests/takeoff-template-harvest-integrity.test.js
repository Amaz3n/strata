require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const { createConditionTemplateSchema, saveConditionsAsTemplatesSchema, TEMPLATE_LIST_CAP } = require('../lib/validation/takeoff')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), FOREIGN = id(2), ACTOR = id(3), PROJECT = id(4), VERSION = id(5), PLAN = id(6), DIVISION = id(7), CODE = id(8), A = id(9), B = id(10)
const condition = (conditionId, name, extra = {}) => ({ id: conditionId, org_id: ORG, project_id: PROJECT, house_plan_version_id: null, name, uom: 'sf', depth_in: null, height_ft: '8.5', pitch_rise: null, tons_per_cy: null, cost_code_id: CODE, waste_pct: '8', unit_cost_cents: 12345, share_with_clients: true, notes: 'Original measured source', ...extra })
const input = { condition_ids: [A, B], group_name: ' Finishes ' }
function fixture(options = {}) {
  const source = (fs.readFileSync('lib/services/takeoff-templates.ts', 'utf8') + '\n' + fs.readFileSync('lib/services/takeoff-scope.ts', 'utf8')), ast = ts.createSourceFile('templates.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['numericOrNull', 'mapTemplate', 'verifiedTemplateCount', 'requireTakeoffWriteScope', 'requireTakeoffCostCodes', 'saveConditionsAsTemplates']
  const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(v => v.name.getText(ast) === 'TEMPLATE_SELECT'))).map(n => n.getText(ast)).join('\n')
  const js = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const db = createFakeSupabase({ takeoff_condition_templates: options.library ?? [], takeoff_conditions: options.conditions ?? [condition(A, 'LVP'), condition(B, 'Tile')], cost_codes: options.codes ?? [{ id: CODE, org_id: ORG, is_active: false }], house_plan_versions: options.versions ?? [{ id: VERSION, org_id: ORG, house_plan_id: PLAN }], house_plans: options.plans ?? [{ id: PLAN, org_id: ORG, division_id: DIVISION }] })
  const calls = [], audits = [], scopeCalls = []
  let activeGates = 0, maximumGates = 0
  const supabase = { from: table => {
    const q = db.from(table), run = q.run.bind(q)
    q.run = () => {
      calls.push({ table, action: q.action, payload: q.payload })
      const result = run()
      if (q.action === 'select') {
        if (options.errorTable === table) result.error = { message: 'Unavailable read' }
        if (options.nullTable === table) result.data = null
        if (options.dataTable === table) result.data = options.data
      }
      if (q.action === 'insert' && Object.hasOwn(options, 'insertData')) result.data = options.insertData
      if (q.action === 'insert' && options.rewrite) result.data = result.data.map(options.rewrite)
      return result
    };return q
  } }
  const exports = {}
  new Function('exports', 'requireOrgContext', 'requirePermission', 'requireAuthorization', 'getDivisionAccessForUser', 'recordAudit', 'createConditionTemplateSchema', 'saveConditionsAsTemplatesSchema', 'TEMPLATE_LIST_CAP', js)(exports,
    async () => { calls.push({ context: true });return { supabase, orgId: ORG, userId: ACTOR } },
    async (permission, ctx) => { calls.push({ permission, ctx });if (options.denied) throw Error('Forbidden') },
    async request => {
      scopeCalls.push(request);assert.equal(request.permission, 'takeoff.write');assert.equal(request.orgId, ORG);assert.equal(request.userId, ACTOR);assert.equal(request.supabase, supabase);assert.equal(request.logDecision, true)
      activeGates++;maximumGates = Math.max(maximumGates, activeGates);await new Promise(resolve => setImmediate(resolve));activeGates--
      if (!(options.allowedProjects ?? [PROJECT]).includes(request.projectId)) throw Error('Project unavailable')
    },
    async request => { assert.deepEqual(request, { orgId: ORG, userId: ACTOR });return options.divisions ?? { assignedOnly: false, divisionIds: [] } },
    async args => audits.push(args), createConditionTemplateSchema, saveConditionsAsTemplatesSchema, TEMPLATE_LIST_CAP)
  return { ...exports, calls, audits, scopeCalls, store: db.store, maximumGates: () => maximumGates }
}
function noSuccess(h, noInsert = true) { if (noInsert) assert.ok(!h.calls.some(c => c.action === 'insert'));assert.deepEqual(h.audits, []) }
test('duplicate source IDs refuse before context', async () => { const h = fixture();await assert.rejects(h.saveConditionsAsTemplates({ ...input, condition_ids: [A, A] }), /only once/);assert.deepEqual(h.calls, []) })
test('org-level writer denial prevents source reads and writes', async () => { const h = fixture({ denied: true });await assert.rejects(h.saveConditionsAsTemplates(input), /Forbidden/);assert.ok(!h.calls.some(c => c.table));noSuccess(h) })
for (const options of [{ conditions: [condition(A, 'LVP')] }, { conditions: [condition(A, 'LVP'), condition(B, 'Tile', { org_id: FOREIGN })] }, { nullTable: 'takeoff_conditions' }, { errorTable: 'takeoff_conditions' }, { dataTable: 'takeoff_conditions', data: [condition(A, 'LVP'), condition(A, 'LVP')] }, { dataTable: 'takeoff_conditions', data: [condition(A, 'LVP'), condition(id(99), 'Unexpected')] }, { conditions: [condition(A, 'LVP', { project_id: null }), condition(B, 'Tile')] }, { conditions: [condition(A, 'LVP', { house_plan_version_id: VERSION }), condition(B, 'Tile')] }]) {
  test(`selected source rows must be complete and have exactly one own-org home ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(h.saveConditionsAsTemplates(input), /conditions|Selected/);noSuccess(h) })
}
test('same-org condition in a denied project cannot be harvested', async () => { const h = fixture({ allowedProjects: [] });await assert.rejects(h.saveConditionsAsTemplates(input), /Project unavailable/);noSuccess(h) })
for (const options of [{ versions: [] }, { versions: [{ id: VERSION, org_id: FOREIGN, house_plan_id: PLAN }] }, { plans: [] }, { plans: [{ id: PLAN, org_id: FOREIGN, division_id: DIVISION }] }, { errorTable: 'house_plan_versions' }, { divisions: { assignedOnly: true, divisionIds: [id(99)] } }]) {
  test(`plan source requires exact version/parent and original division authority ${JSON.stringify(options)}`, async () => { const h = fixture({ ...options, conditions: [condition(A, 'LVP', { project_id: null, house_plan_version_id: VERSION }), condition(B, 'Tile')] });await assert.rejects(h.saveConditionsAsTemplates(input), /unavailable/);noSuccess(h) })
}
for (const options of [{ codes: [] }, { codes: [{ id: CODE, org_id: FOREIGN }] }, { nullTable: 'cost_codes' }, { errorTable: 'cost_codes' }]) {
  test(`copied cost code must remain in current organization ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(h.saveConditionsAsTemplates(input), /cost codes unavailable/);noSuccess(h) })
}
for (const extra of [{ unit_cost_cents: 1.5 }, { unit_cost_cents: -1 }, { uom: 'invalid' }, { height_ft: 'not-a-number' }, { height_ft: true }, { share_with_clients: 'true' }]) {
  test(`invalid copied source body cannot be silently normalized or inserted ${JSON.stringify(extra)}`, async () => { const h = fixture({ conditions: [condition(A, 'LVP', extra), condition(B, 'Tile')] });await assert.rejects(h.saveConditionsAsTemplates(input));noSuccess(h) })
}
for (const insertData of [null, [], [{ id: id(90), name: 'LVP' }], [{ id: id(90), name: 'LVP' }, { id: id(90), name: 'Tile' }]]) {
  test(`incomplete insert response cannot produce successful harvest audit ${JSON.stringify(insertData)}`, async () => { const h = fixture({ insertData });await assert.rejects(h.saveConditionsAsTemplates(input), /could not be confirmed/);noSuccess(h, false) })
}
for (const change of [{ org_id: FOREIGN }, { created_by: id(99) }, { name: 'Unknown' }, { unit_cost_cents: 12346 }, { cost_code_id: id(99) }, { height_ft: 9 }, { color: '#FF0000' }, { share_with_clients: false }, { sort_order: 99 }, { notes: 'Changed after source review' }]) {
  test(`returned copied payload must equal requested template ${JSON.stringify(change)}`, async () => { const h = fixture({ rewrite: row => ({ ...row, ...change }) });await assert.rejects(h.saveConditionsAsTemplates(input), /could not be confirmed/);noSuccess(h, false) })
}
test('genuine save preserves requested order, normal numeric values, cents and source flags under exact actor', async () => {
  const h = fixture(), result = await h.saveConditionsAsTemplates({ ...input, condition_ids: [B, A] }), added = h.store.takeoff_condition_templates
  assert.deepEqual(result, { created: 2, skipped: [] });assert.deepEqual(added.map(r => r.name), ['Tile', 'LVP']);assert.deepEqual(added.map(r => r.sort_order), [0, 1])
  assert.ok(added.every(r => r.unit_cost_cents === 12345 && r.height_ft === 8.5 && r.waste_pct === 8 && r.cost_code_id === CODE && r.share_with_clients === true && r.color === null && r.group_name === 'Finishes' && r.created_by === ACTOR && r.org_id === ORG))
  assert.equal(h.scopeCalls.length, 1);assert.equal(h.audits.length, 1);assert.equal(h.audits[0].actorId, ACTOR);assert.equal(h.audits[0].orgId, ORG)
})
test('mixed authorized project and plan sources retain their order without duplicate scope gates', async () => {
  const h = fixture({ conditions: [condition(A, 'LVP', { project_id: null, house_plan_version_id: VERSION }), condition(B, 'Tile')], divisions: { assignedOnly: true, divisionIds: [DIVISION] } })
  assert.deepEqual(await h.saveConditionsAsTemplates(input), { created: 2, skipped: [] });assert.equal(h.scopeCalls.length, 1)
})
test('maximum selection uses each canonical project gate once with at most ten concurrent gates', async () => {
  const conditions = Array.from({ length: 200 }, (_, i) => condition(id(1000 + i), `Condition ${i}`, { project_id: id(2000 + i) })), h = fixture({ conditions, allowedProjects: conditions.map(c => c.project_id) })
  assert.equal((await h.saveConditionsAsTemplates({ condition_ids: conditions.map(c => c.id) })).created, 200);assert.equal(h.scopeCalls.length, 200);assert.equal(h.maximumGates(), 10)
})
