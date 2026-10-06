require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const { createTakeoffConditionSchema } = require('../lib/validation/takeoff')
const { nextConditionColor, CONDITION_COLORS } = require('../lib/drawings/takeoff-palette')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), FOREIGN = id(2), ACTOR = id(3), PROJECT = id(4), VERSION = id(5), PLAN = id(6), DIVISION = id(7), CODE = id(8)
const sibling = (index, extra = {}) => ({ id: id(100 + index), org_id: ORG, project_id: PROJECT, house_plan_version_id: null, color: CONDITION_COLORS[index % CONDITION_COLORS.length], ...extra })
const input = { project_id: PROJECT, name: 'Tile', uom: 'sf', cost_code_id: CODE, unit_cost_cents: 12345, height_ft: 9, waste_pct: 8, share_with_clients: true, notes: 'Reviewed measured item' }
function fixture(options = {}) {
  const source = fs.readFileSync('lib/services/takeoff.ts', 'utf8')+'\n'+fs.readFileSync('lib/services/takeoff-scope.ts', 'utf8'), ast = ts.createSourceFile('takeoff.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['numericOrNull', 'mapCondition', 'scopeFilter', 'listSiblingsForPlacement', 'createTakeoffCondition', 'requireTakeoffWriteScope', 'requireTakeoffCostCodes']
  const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(v => ['CONDITION_SELECT', 'CONDITION_LIST_CAP'].includes(v.name.getText(ast))))).map(n => n.getText(ast)).join('\n')
  const js = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const db = createFakeSupabase({ takeoff_conditions: options.siblings ?? [], cost_codes: options.codes ?? [{ id: CODE, org_id: ORG, is_active: false }], house_plan_versions: options.versions ?? [{ id: VERSION, org_id: ORG, house_plan_id: PLAN }], house_plans: options.plans ?? [{ id: PLAN, org_id: ORG, division_id: DIVISION }] }), calls = [], audits = [], events = []
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
      if (q.action === 'insert') {
        if (Object.hasOwn(options, 'reply')) result.data = options.reply
        if (options.rewrite && result.data) result.data = { ...result.data, ...options.rewrite }
      }
      return result
    };return q
  } }
  const exports = {}
  new Function('exports', 'requireOrgContext', 'requirePermission', 'requireAuthorization', 'getDivisionAccessForUser', 'recordAudit', 'recordEvent', 'createTakeoffConditionSchema', 'nextConditionColor', js)(exports,
    async () => { calls.push({ context: true });return { orgId: ORG, userId: ACTOR, supabase } },
    async (permission, context) => { calls.push({ permission, context });if (options.denied) throw Error('Forbidden') },
    async request => { calls.push({ projectAuthorization: request });assert.equal(request.permission, 'takeoff.write');assert.equal(request.orgId, ORG);assert.equal(request.userId, ACTOR);assert.equal(request.supabase, supabase);assert.equal(request.logDecision, true);if (options.projectDenied || request.projectId !== PROJECT) throw Error('Project unavailable') },
    async request => { assert.deepEqual(request, { orgId: ORG, userId: ACTOR });return options.divisions ?? { assignedOnly: false, divisionIds: [] } },
    async args => audits.push(args), async args => events.push(args), createTakeoffConditionSchema, nextConditionColor)
  return { ...exports, calls, audits, events, store: db.store }
}
function noSuccess(h, noInsert = true) { if (noInsert) assert.ok(!h.calls.some(c => c.action === 'insert'));assert.deepEqual(h.audits, []);assert.deepEqual(h.events, []) }
test('invalid source/home input is rejected before context', async () => { const h = fixture();await assert.rejects(h.createTakeoffCondition({ ...input, project_id: 'invalid' }));assert.deepEqual(h.calls, []) })
test('takeoff.write denial prevents destination lookup', async () => { const h = fixture({ denied: true });await assert.rejects(h.createTakeoffCondition(input), /Forbidden/);assert.ok(!h.calls.some(c => c.table || c.projectAuthorization));noSuccess(h) })
test('canonical project denial prevents body/placement reads and creation', async () => { const h = fixture({ projectDenied: true });await assert.rejects(h.createTakeoffCondition(input), /Project unavailable/);assert.ok(!h.calls.some(c => c.table));noSuccess(h) })
test('foreign project cannot be created under a current organization row', async () => { const h = fixture();await assert.rejects(h.createTakeoffCondition({ ...input, project_id: id(99) }), /Project unavailable/);noSuccess(h) })
for (const options of [{ versions: [] }, { versions: [{ id: VERSION, org_id: FOREIGN, house_plan_id: PLAN }] }, { plans: [] }, { plans: [{ id: PLAN, org_id: FOREIGN, division_id: DIVISION }] }, { errorTable: 'house_plan_versions' }, { errorTable: 'house_plans' }, { divisions: { assignedOnly: true, divisionIds: [id(99)] } }]) test(`plan source requires own version/parent and original division authority ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(h.createTakeoffCondition({ ...input, project_id: null, house_plan_version_id: VERSION }), /unavailable/);noSuccess(h) })
for (const options of [{ codes: [] }, { codes: [{ id: CODE, org_id: FOREIGN }] }, { errorTable: 'cost_codes' }, { nullTable: 'cost_codes' }]) test(`cost-code target remains same-org and available ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(h.createTakeoffCondition(input), /cost codes unavailable/);noSuccess(h) })
for (const options of [{ count: null }, { count: undefined }, { count: -1 }, { count: 0.5 }, { count: '0' }, { count: 1 }, { nullTable: 'takeoff_conditions' }, { errorTable: 'takeoff_conditions' }, { siblings: [sibling(1, { color: 'invalid' })] }, { dataTable: 'takeoff_conditions', data: [sibling(1, { org_id: FOREIGN })], count: 1 }, { dataTable: 'takeoff_conditions', data: [sibling(1, { project_id: id(99) })], count: 1 }, { dataTable: 'takeoff_conditions', data: [sibling(1), sibling(1)], count: 2 }]) test(`unavailable/incomplete/mismatched placement cannot default to zero ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(h.createTakeoffCondition(input), /takeoff placement/);noSuccess(h) })
for (const change of [{ org_id: FOREIGN }, { project_id: id(99) }, { house_plan_version_id: VERSION }, { name: 'Changed' }, { unit_cost_cents: 1 }, { cost_code_id: id(99) }, { created_by: id(99) }, { height_ft: 10 }, { share_with_clients: false }, { sort_order: 99 }, { color: '#000000' }]) test(`divergent created body cannot emit successful event/audit ${JSON.stringify(change)}`, async () => { const h = fixture({ rewrite: change });await assert.rejects(h.createTakeoffCondition(input), /could not be confirmed/);noSuccess(h, false) })
test('missing committed reply cannot emit phantom created event/audit', async () => { const h = fixture({ reply: null });await assert.rejects(h.createTakeoffCondition(input), /Failed to create/);noSuccess(h, false) })
test('genuine empty project creation preserves requested integer money, factors and current actor', async () => { const h = fixture(), saved = await h.createTakeoffCondition(input);assert.equal(saved.unit_cost_cents, 12345);assert.equal(saved.height_ft, 9);assert.equal(saved.share_with_clients, true);assert.equal(saved.cost_code_id, CODE);assert.equal(saved.org_id, ORG);assert.equal(saved.project_id, PROJECT);assert.equal(saved.house_plan_version_id, null);assert.equal(saved.created_by, ACTOR);assert.equal(saved.sort_order, 0);assert.equal(saved.color, CONDITION_COLORS[0]);assert.equal(h.audits[0].actorId, ACTOR);assert.equal(h.events[0].entityId, saved.id) })
test('verified placement preserves original next position and palette allocation', async () => { const h = fixture({ siblings: [sibling(0)] }), saved = await h.createTakeoffCondition(input);assert.equal(saved.sort_order, 1);assert.equal(saved.color, CONDITION_COLORS[1]) })
test('original explicit palette choice and wrap behavior stay available', async () => { const h = fixture({ siblings: CONDITION_COLORS.map((_, i) => sibling(i)) });assert.equal((await h.createTakeoffCondition({ ...input, color: CONDITION_COLORS[0] })).color, CONDITION_COLORS[0]);assert.equal((await h.createTakeoffCondition(input)).color, CONDITION_COLORS[0]) })
for (const count of [200, 201, 250]) test(`verified original full/legacy condition count ${count} prevents another insert`, async () => { const h = fixture({ siblings: Array.from({ length: count }, (_, i) => sibling(i)) });await assert.rejects(h.createTakeoffCondition(input), /at most 200/);noSuccess(h) })
test('allowed production plan division creates exact own version', async () => { const h = fixture({ divisions: { assignedOnly: true, divisionIds: [DIVISION] } }), saved = await h.createTakeoffCondition({ ...input, project_id: null, house_plan_version_id: VERSION });assert.equal(saved.project_id, null);assert.equal(saved.house_plan_version_id, VERSION) })
test('original unscoped plan catalog remains visible under assigned division policy', async () => { const h = fixture({ plans: [{ id: PLAN, org_id: ORG, division_id: null }], divisions: { assignedOnly: true, divisionIds: [] } });assert.equal((await h.createTakeoffCondition({ ...input, project_id: null, house_plan_version_id: VERSION })).house_plan_version_id, VERSION) })
