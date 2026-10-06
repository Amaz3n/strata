require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const { createFakeSupabase } = require('./support/fake-supabase')
const { readAllRowsById } = require('../lib/land/paging')
const { groupTemplates, templateGroupNames } = require('../lib/drawings/condition-templates')
const { unwrapAction } = require('../lib/action-result')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), FOREIGN = id(2), ACTOR = id(3)
const row = n => ({ id: id(100 + n), org_id: ORG, name: `Template ${String(10000 - n).padStart(5, '0')}`, group_name: n % 3 === 0 ? null : n % 3 === 1 ? 'A' : 'B', sort_order: n % 4, uom: 'sf', unit_cost_cents: 12345, updated_at: '2026-10-04T12:00:00.123456+00:00' })
function transpile(source) { return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText }
function fixture({ count = 501, transportCap = 37, failAfter = null, missingBody = false, denied = false, repeatPage = false, wrongOrg = false } = {}) {
  const source = fs.readFileSync('lib/services/takeoff-templates.ts', 'utf8'), ast = ts.createSourceFile('templates.ts', source, ts.ScriptTarget.Latest, true)
  const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && ['numericOrNull', 'mapTemplate', 'listConditionTemplates'].includes(n.name?.text)) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(v => v.name.getText(ast) === 'TEMPLATE_SELECT'))).map(n => n.getText(ast)).join('\n')
  const db = createFakeSupabase({ takeoff_condition_templates: [...Array.from({ length: count }, (_, i) => row(i)), { ...row(0), id: id(99), org_id: FOREIGN }] }), reads = [], writes = [], guards = []
  let firstPage
  const supabase = { from: table => {
    const q = db.from(table), limit = q.limit.bind(q), run = q.run.bind(q)
    q.limit = n => limit(Math.min(n, transportCap))
    q.run = () => {
      if (q.action !== 'select') { writes.push(q);return run() }
      reads.push(q)
      if (failAfter !== null && reads.length > failAfter) return { data: null, error: { message: 'Later page unavailable' } }
      if (missingBody) return { data: null, error: null }
      const result = run()
      if (wrongOrg && result.data.length) result.data[0].org_id = FOREIGN
      if (repeatPage && firstPage) result.data = firstPage
      else firstPage = result.data
      return result
    };return q
  } }
  const exports = {}
  new Function('exports', 'requireOrgContext', 'requirePermission', 'readAllRowsById', transpile(selected))(exports,
    async () => ({ orgId: ORG, userId: ACTOR, supabase }), async (permission, context) => { guards.push([permission, context.orgId, context.userId]);if (denied) throw Error('Forbidden') }, readAllRowsById)
  return { ...exports, reads, writes, guards }
}
for (const count of [0, 500, 501, 713]) test(`discovery returns complete own-org library ${count}, including inspectable legacy over-cap rows under short transport pages`, async () => {
  const h = fixture({ count }), rows = await h.listConditionTemplates()
  assert.equal(rows.length, count);assert.equal(new Set(rows.map(r => r.id)).size, count);assert.ok(rows.every(r => r.org_id === ORG && r.unit_cost_cents === 12345))
  assert.deepEqual(h.guards, [['takeoff.read', ORG, ACTOR]]);assert.deepEqual(h.writes, [])
  const missingGroupIndex = rows.findIndex(r => r.group_name === null);if (missingGroupIndex >= 0) assert.ok(rows.slice(missingGroupIndex).every(r => r.group_name === null))
  assert.ok(h.reads.every(q => q.orderings[0].column === 'id'));assert.equal(h.reads.at(-1).run().data.length, 0)
})
test('display ordering remains group/null-last, position, name and deterministic ID', async () => {
  const h = fixture(), rows = await h.listConditionTemplates(), groups = groupTemplates(rows)
  assert.deepEqual(groups.map(g => g.group), ['A', 'B', 'Ungrouped'])
  for (const group of groups) for (let i = 1; i < group.templates.length; i++) {
    const before = group.templates[i - 1], after = group.templates[i]
    assert.ok(before.sort_order < after.sort_order || (before.sort_order === after.sort_order && before.name.localeCompare(after.name) <= 0))
  }
  assert.deepEqual(templateGroupNames(rows), ['A', 'B'])
})
for (const options of [{ failAfter: 2 }, { missingBody: true }, { repeatPage: true }, { wrongOrg: true }]) test(`discovery cannot publish partial/empty/foreign/stalled evidence ${JSON.stringify(options)}`, async () => {
  const h = fixture(options);await assert.rejects(h.listConditionTemplates(), /Failed to load complete/);assert.deepEqual(h.writes, [])
})
test('discovery requires current takeoff.read before DB access', async () => { const h = fixture({ denied: true });await assert.rejects(h.listConditionTemplates(), /Forbidden/);assert.deepEqual(h.reads, []);assert.deepEqual(h.writes, []) })
for (const count of [10000, 10001]) test(`complete validation bound ${count} cannot masquerade as complete smaller library`, async () => {
  const h = fixture({ count, transportCap: 100 })
  if (count === 10000) assert.equal((await h.listConditionTemplates()).length, count)
  else await assert.rejects(h.listConditionTemplates(), /Validation limit exceeded/)
})
for (const permissions of [[], ['takeoff.write']]) test(`actual settings page reads one template snapshot and derives headings/count/cap under ${JSON.stringify(permissions)}`, async () => {
  const source = fs.readFileSync('app/(app)/settings/takeoff/page.tsx', 'utf8'), ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'TakeoffSettingsPageContent'), exports = {}, calls = []
  const templates = [row(1), row(2), row(3)]
  new Function('exports', 'require', 'connection', 'listConditionTemplatesAction', 'listTakeoffCostCodesAction', 'getCurrentUserPermissions', 'unwrapAction', 'groupTemplates', 'templateGroupNames', 'TEMPLATE_LIST_CAP', 'PageLayout', 'TakeoffTemplatesPanel', transpile('export '+fn.getText(ast)))(exports, require,
    async () => calls.push('connection'), async () => { calls.push('templates');return { success: true, data: templates } }, async () => { calls.push('codes');return [] }, async () => { calls.push('permissions');return { permissions } }, unwrapAction, groupTemplates, templateGroupNames, 500, 'PageLayout', 'TakeoffTemplatesPanel')
  const page = await exports.TakeoffSettingsPageContent(), panel = page.props.children
  assert.equal(calls.filter(c => c === 'templates').length, 1);assert.deepEqual(panel.props.groupNames, ['A', 'B']);assert.equal(panel.props.total, 3);assert.equal(panel.props.cap, 500);assert.equal(panel.props.canManage, permissions.includes('takeoff.write'));assert.deepEqual(panel.props.groups.flatMap(g => g.templates.map(t => t.id)).sort(), templates.map(t => t.id).sort())
})
