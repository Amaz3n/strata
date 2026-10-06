require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const { applyConditionTemplatesSchema } = require('../lib/validation/takeoff')
const { nextConditionColor } = require('../lib/drawings/takeoff-palette')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), FOREIGN = id(2), ACTOR = id(3), PROJECT = id(4), VERSION = id(5), PLAN = id(6), DIVISION = id(7), CODE = id(8), A = id(9), B = id(10)
const template = (templateId, name) => ({ id: templateId, org_id: ORG, name, uom: 'sf', cost_code_id: CODE, waste_pct: 8, unit_cost_cents: 12345, share_with_clients: true, notes: 'Measured template', color: '#000000' })
const sibling = (index, extra = {}) => ({ id: id(100 + index), org_id: ORG, project_id: PROJECT, house_plan_version_id: null, name: `Existing ${index}`, color: '#FF0000', ...extra })
const input = { project_id: PROJECT, template_ids: [A, B] }
function fixture(options = {}) {
  const source = (fs.readFileSync('lib/services/takeoff-templates.ts', 'utf8') + '\n' + fs.readFileSync('lib/services/takeoff-scope.ts', 'utf8')), ast = ts.createSourceFile('templates.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['numericOrNull', 'mapTemplate', 'requireTakeoffWriteScope', 'requireTakeoffCostCodes', 'applyConditionTemplates']
  const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(v => v.name.getText(ast) === 'TEMPLATE_SELECT'))).map(n => n.getText(ast)).join('\n')
  const js = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const db = createFakeSupabase({ takeoff_condition_templates: options.templates ?? [template(A, 'LVP'), template(B, 'Tile')], takeoff_conditions: options.siblings ?? [], cost_codes: options.codes ?? [{ id: CODE, org_id: ORG, is_active: false }], house_plan_versions: options.versions ?? [{ id: VERSION, org_id: ORG, house_plan_id: PLAN }], house_plans: options.plans ?? [{ id: PLAN, org_id: ORG, division_id: DIVISION }] })
  const calls = [], audits = [], events = []
  const supabase = { from: table => {
    const q = db.from(table), run = q.run.bind(q)
    q.run = () => {
      calls.push({ table, action: q.action, payload: q.payload })
      const result = run()
      if (q.action === 'select') {
        if (options.errorTable === table) result.error = { message: 'Unavailable read' }
        if (options.nullTable === table) result.data = null
        if (options.dataTable === table) result.data = options.data
        if (table === 'takeoff_conditions' && Object.hasOwn(options, 'count')) result.count = options.count
      }
      if (q.action === 'insert' && Object.hasOwn(options, 'insertData')) result.data = options.insertData
      return result
    };return q
  } }
  const exports = {}
  new Function('exports', 'requireOrgContext', 'requirePermission', 'requireAuthorization', 'getDivisionAccessForUser', 'recordAudit', 'recordEvent', 'applyConditionTemplatesSchema', 'nextConditionColor', 'CONDITION_LIST_CAP', js)(exports,
    async () => { calls.push({ context: true });return { supabase, orgId: ORG, userId: ACTOR } },
    async (permission, ctx) => { calls.push({ permission, ctx });if (options.denied) throw Error('Forbidden') },
    async request => { calls.push({ projectAuthorization: request });assert.equal(request.permission, 'takeoff.write');assert.equal(request.orgId, ORG);assert.equal(request.userId, ACTOR);assert.equal(request.supabase, supabase);assert.equal(request.logDecision, true);if (options.projectDenied || request.projectId !== PROJECT) throw Error('Project unavailable') },
    async request => { calls.push({ divisionAccess: request });assert.deepEqual(request, { orgId: ORG, userId: ACTOR });return options.divisions ?? { assignedOnly: false, divisionIds: [] } },
    async args => audits.push(args), async args => events.push(args), applyConditionTemplatesSchema, nextConditionColor, 200)
  return { ...exports, calls, audits, events, store: db.store }
}
function noSuccess(h, { noInsert = true } = {}) { if (noInsert) assert.ok(!h.calls.some(c => c.action === 'insert'));assert.deepEqual(h.audits, []);assert.deepEqual(h.events, []) }
test('duplicate selection is rejected before context or any writes', async () => { const h = fixture();await assert.rejects(h.applyConditionTemplates({ ...input, template_ids: [A, A] }), /only once/);assert.deepEqual(h.calls, []) })
test('takeoff.write denial prevents destination lookup and writes', async () => { const h = fixture({ denied: true });await assert.rejects(h.applyConditionTemplates(input), /Forbidden/);assert.equal(h.calls.length, 2);noSuccess(h) })
test('project-scoped authorization denial prevents reads and writes', async () => { const h = fixture({ projectDenied: true });await assert.rejects(h.applyConditionTemplates(input), /Project unavailable/);assert.ok(!h.calls.some(c => c.table));noSuccess(h) })
test('foreign project cannot be accepted via a same-org template', async () => { const h = fixture();await assert.rejects(h.applyConditionTemplates({ ...input, project_id: id(99) }), /Project unavailable/);noSuccess(h) })
for (const options of [{ templates: [template(A, 'LVP')] }, { templates: [{ ...template(A, 'LVP'), org_id: FOREIGN }, template(B, 'Tile')] }, { nullTable: 'takeoff_condition_templates' }, { errorTable: 'takeoff_condition_templates' }, { dataTable: 'takeoff_condition_templates', data: [template(A, 'LVP'), template(A, 'LVP')] }, { dataTable: 'takeoff_condition_templates', data: [template(A, 'LVP'), template(id(99), 'Unexpected')] }]) {
  test(`selected templates must be exact, complete and same-org ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(h.applyConditionTemplates(input), /templates|Selected/);noSuccess(h) })
}
for (const options of [{ codes: [] }, { codes: [{ id: CODE, org_id: FOREIGN }] }, { nullTable: 'cost_codes' }, { errorTable: 'cost_codes' }]) {
  test(`template cost-code target must remain available in current org ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(h.applyConditionTemplates(input), /cost codes unavailable/);noSuccess(h) })
}
for (const options of [{ count: null }, { count: undefined }, { count: -1 }, { count: 0.5 }, { count: '0' }, { count: 1 }, { nullTable: 'takeoff_conditions' }, { errorTable: 'takeoff_conditions' }, { dataTable: 'takeoff_conditions', data: [sibling(1, { org_id: FOREIGN })] }, { dataTable: 'takeoff_conditions', data: [sibling(1, { project_id: id(99) })] }, { siblings: [sibling(1, { name: null })] }, { siblings: [sibling(1, { color: null })] }]) {
  test(`unavailable/incomplete sibling evidence cannot be treated as empty ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(h.applyConditionTemplates(input), /existing takeoff conditions/);noSuccess(h) })
}
for (const options of [{ versions: [] }, { versions: [{ id: VERSION, org_id: FOREIGN, house_plan_id: PLAN }] }, { plans: [] }, { plans: [{ id: PLAN, org_id: FOREIGN, division_id: DIVISION }] }, { errorTable: 'house_plan_versions' }, { errorTable: 'house_plans' }, { divisions: { assignedOnly: true, divisionIds: [id(99)] } }]) {
  test(`house-plan destination validates own version, parent and division ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(h.applyConditionTemplates({ house_plan_version_id: VERSION, template_ids: [A] }), /unavailable/);noSuccess(h) })
}
for (const insertData of [null, [], [{ id: id(90), name: 'LVP' }], [{ id: id(90), name: 'LVP' }, { id: id(90), name: 'Tile' }], [{ id: id(90), name: 'LVP' }, { id: id(91), name: 'Unknown' }]]) {
  test(`uncertain insert response cannot emit success event/audit ${JSON.stringify(insertData)}`, async () => { const h = fixture({ insertData });await assert.rejects(h.applyConditionTemplates(input), /could not be confirmed/);noSuccess(h, { noInsert: false }) })
}
test('project application preserves caller order, original integer rates and independent colors with exact actor evidence', async () => {
  const h = fixture({ siblings: [sibling(1)] }), result = await h.applyConditionTemplates({ ...input, template_ids: [B, A] }), added = h.store.takeoff_conditions.slice(1)
  assert.deepEqual(result, { created: 2, skipped: [], over_cap: [] });assert.deepEqual(added.map(r => r.name), ['Tile', 'LVP']);assert.deepEqual(added.map(r => r.sort_order), [1, 2]);assert.equal(new Set(added.map(r => r.color)).size, 2)
  assert.ok(added.every(r => r.project_id === PROJECT && r.house_plan_version_id === null && r.org_id === ORG && r.created_by === ACTOR && r.unit_cost_cents === 12345 && r.cost_code_id === CODE))
  assert.equal(h.audits[0].actorId, ACTOR);assert.equal(h.audits[0].orgId, ORG);assert.equal(h.events[0].entityId, PROJECT);assert.equal(h.events[0].payload.created, 2)
})
test('allowed plan division applies to the exact version', async () => { const h = fixture({ divisions: { assignedOnly: true, divisionIds: [DIVISION] } });assert.equal((await h.applyConditionTemplates({ house_plan_version_id: VERSION, template_ids: [A] })).created, 1);assert.equal(h.store.takeoff_conditions[0].house_plan_version_id, VERSION);assert.equal(h.store.takeoff_conditions[0].project_id, null) })
test('org-wide plan library retains existing null-division visibility policy', async () => { const h = fixture({ plans: [{ id: PLAN, org_id: ORG, division_id: null }], divisions: { assignedOnly: true, divisionIds: [] } });assert.equal((await h.applyConditionTemplates({ house_plan_version_id: VERSION, template_ids: [A] })).created, 1) })
test('existing names are skipped and verified full capacity is reported', async () => {
  const h = fixture({ siblings: Array.from({ length: 200 }, (_, i) => sibling(i, i === 0 ? { name: ' lVp ' } : {})) })
  assert.deepEqual(await h.applyConditionTemplates(input), { created: 0, skipped: ['LVP'], over_cap: ['Tile'] });assert.ok(!h.calls.some(c => c.action === 'insert'));assert.deepEqual(h.events, [])
})
