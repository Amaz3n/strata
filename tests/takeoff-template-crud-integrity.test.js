require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript'), React = require('react')
const { createFakeSupabase } = require('./support/fake-supabase')
const validation = require('../lib/validation/takeoff')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), FOREIGN = id(2), ACTOR = id(3), TEMPLATE = id(4), CODE = id(5), CREATOR = id(6)
const SEEN = '2026-10-04T12:00:00.123456+00:00', LATER = '2026-10-04T13:00:00.654321+00:00'
const original = { id: TEMPLATE, org_id: ORG, name: 'LVP', uom: 'sf', depth_in: null, height_ft: null, pitch_rise: null, tons_per_cy: null, cost_code_id: CODE, color: null, waste_pct: 8, unit_cost_cents: 12345, share_with_clients: true, notes: 'Original template', group_name: 'Finishes', sort_order: 4, created_by: CREATOR, created_at: SEEN, updated_at: SEEN }
const createInput = { name: 'Tile', uom: 'sf', cost_code_id: CODE, unit_cost_cents: 23456 }
function transpile(source) { return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText }
function fixture(options = {}) {
  const source = (fs.readFileSync('lib/services/takeoff-templates.ts', 'utf8') + '\n' + fs.readFileSync('lib/services/takeoff-scope.ts', 'utf8')), ast = ts.createSourceFile('templates.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['numericOrNull', 'mapTemplate', 'verifiedTemplateCount', 'isConfirmedTemplate', 'requireTakeoffCostCodes', 'createConditionTemplate', 'updateConditionTemplate', 'deleteConditionTemplate']
  const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(v => ['TEMPLATE_SELECT', 'TEMPLATE_COPY_FIELDS'].includes(v.name.getText(ast))))).map(n => n.getText(ast)).join('\n')
  const staleAst = ts.createSourceFile('takeoff.ts', fs.readFileSync('lib/services/takeoff.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const stale = staleAst.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(staleAst) === 'STALE_WRITE').initializer.text
  const db = createFakeSupabase({ takeoff_condition_templates: options.templates ?? [original], cost_codes: options.codes ?? [{ id: CODE, org_id: ORG, is_active: false }] })
  const calls = [], audits = []
  const supabase = { from: table => {
    const q = db.from(table), run = q.run.bind(q)
    q.run = () => {
      calls.push({ table, action: q.action, payload: q.payload })
      if (table === 'takeoff_condition_templates' && ['update', 'delete'].includes(q.action) && options.race) {
        if (options.race === 'removed') db.store[table].splice(0)
        else db.store[table][0].updated_at = LATER
      }
      const result = run()
      if (q.action === 'select') {
        if (options.errorTable === table) result.error = { message: 'Unavailable read' }
        if (options.nullTable === table) result.data = null
        if (options.readData && table === 'takeoff_condition_templates' && !q.head) result.data = options.readData
      }
      if (q.action === 'update' && Array.isArray(result.data)) {
        for (const row of result.data) { row.updated_at = LATER;const stored = db.store[table].find(r => r.id === row.id);if (stored) stored.updated_at = LATER }
      }
      if (['update', 'delete'].includes(q.action) && q.cardinality === 'maybe') result.data = result.data?.length === 1 ? result.data[0] : null
      if (['insert', 'update', 'delete'].includes(q.action)) {
        if (Object.hasOwn(options, 'reply')) result.data = options.reply
        if (options.rewrite && result.data) result.data = { ...result.data, ...options.rewrite }
      }
      return result
    };return q
  } }
  const exports = {}
  new Function('exports', 'requireOrgContext', 'requirePermission', 'recordAudit', 'createConditionTemplateSchema', 'updateConditionTemplateSchema', 'conditionTemplateMutationTargetSchema', 'factorRuleViolation', 'STALE_WRITE', 'TEMPLATE_LIST_CAP', transpile(selected))(exports,
    async () => { calls.push({ context: true });return { supabase, orgId: ORG, userId: ACTOR } },
    async (permission, ctx) => { calls.push({ permission, ctx });if (options.denied) throw Error('Forbidden') },
    async args => audits.push(args), validation.createConditionTemplateSchema, validation.updateConditionTemplateSchema, validation.conditionTemplateMutationTargetSchema, validation.factorRuleViolation, stale, validation.TEMPLATE_LIST_CAP)
  return { ...exports, calls, audits, store: db.store, stale }
}
function noWrites(h) { assert.ok(!h.calls.some(c => ['insert', 'update', 'delete'].includes(c.action)));assert.deepEqual(h.audits, []) }
for (const method of ['updateConditionTemplate', 'deleteConditionTemplate']) {
  test(`${method} rejects invalid ID before context`, async () => { const h = fixture();await assert.rejects(method === 'updateConditionTemplate' ? h[method]('invalid', {}) : h[method]('invalid'));assert.deepEqual(h.calls, []) })
  for (const stamp of ['not-a-date', 42]) test(`${method} rejects malformed revision ${String(stamp)} before context`, async () => { const h = fixture();await assert.rejects(method === 'updateConditionTemplate' ? h[method](TEMPLATE, {}, undefined, stamp) : h[method](TEMPLATE, undefined, stamp));assert.deepEqual(h.calls, []) })
  test(`${method} requires takeoff.write before reads`, async () => { const h = fixture({ denied: true });await assert.rejects(method === 'updateConditionTemplate' ? h[method](TEMPLATE, {}) : h[method](TEMPLATE), /Forbidden/);assert.ok(!h.calls.some(c => c.table));noWrites(h) })
  test(`${method} surfaces unavailable existing read before mutation`, async () => { const h = fixture({ errorTable: 'takeoff_condition_templates' });await assert.rejects(method === 'updateConditionTemplate' ? h[method](TEMPLATE, {}) : h[method](TEMPLATE), /Failed to load/);noWrites(h) })
  test(`${method} cannot accept foreign row returned as existing`, async () => { const h = fixture({ readData: { ...original, org_id: FOREIGN } });await assert.rejects(method === 'updateConditionTemplate' ? h[method](TEMPLATE, {}) : h[method](TEMPLATE), /not found/);noWrites(h) })
  test(`${method} rejects stale rendered revision before mutation`, async () => { const h = fixture();await assert.rejects(method === 'updateConditionTemplate' ? h[method](TEMPLATE, { notes: 'Changed' }, undefined, LATER) : h[method](TEMPLATE, undefined, LATER), e => e.message === h.stale);noWrites(h) })
  for (const race of ['changed', 'removed']) test(`${method} fences ${race} between read and write even without caller revision`, async () => {
    const h = fixture({ race });await assert.rejects(method === 'updateConditionTemplate' ? h[method](TEMPLATE, { notes: 'Changed' }) : h[method](TEMPLATE), e => e.message === h.stale);assert.deepEqual(h.audits, [])
    if (race === 'changed') assert.equal(h.store.takeoff_condition_templates[0].notes, original.notes)
  })
}
for (const options of [{ codes: [] }, { codes: [{ id: CODE, org_id: FOREIGN }] }, { errorTable: 'cost_codes' }, { nullTable: 'cost_codes' }]) {
  for (const method of ['createConditionTemplate', 'updateConditionTemplate']) test(`${method} refuses unavailable/foreign code reference ${JSON.stringify(options)}`, async () => { const h = fixture(options);await assert.rejects(method === 'createConditionTemplate' ? h[method](createInput) : h[method](TEMPLATE, { notes: 'Changed' }), /cost codes unavailable/);noWrites(h) })
}
for (const change of [{ org_id: FOREIGN }, { name: 'Changed by driver' }, { unit_cost_cents: 1 }, { cost_code_id: id(99) }, { created_by: id(99) }, { share_with_clients: false }]) {
  test(`create cannot acknowledge divergent returned fields ${JSON.stringify(change)}`, async () => { const h = fixture({ rewrite: change });await assert.rejects(h.createConditionTemplate({ ...createInput, share_with_clients: true }), /could not be confirmed/);assert.deepEqual(h.audits, []) })
  test(`update cannot acknowledge divergent returned fields ${JSON.stringify(change)}`, async () => { const h = fixture({ rewrite: change });await assert.rejects(h.updateConditionTemplate(TEMPLATE, { notes: 'Changed' }), /could not be confirmed/);assert.deepEqual(h.audits, []) })
}
for (const change of [{ id: id(99) }, { org_id: FOREIGN }, { updated_at: LATER }]) test(`delete cannot acknowledge an unexpected removed row ${JSON.stringify(change)}`, async () => { const h = fixture({ rewrite: change });await assert.rejects(h.deleteConditionTemplate(TEMPLATE), /could not be confirmed/);assert.deepEqual(h.audits, []) })
test('verified create retains current org/actor, historical inactive code and exact rate', async () => { const h = fixture(), saved = await h.createConditionTemplate(createInput);assert.equal(saved.unit_cost_cents, 23456);assert.equal(saved.cost_code_id, CODE);assert.equal(saved.org_id, ORG);assert.equal(saved.created_by, ACTOR);assert.equal(h.audits[0].actorId, ACTOR) })
test('verified update preserves creator and copies changed price/group under rendered revision', async () => { const h = fixture(), saved = await h.updateConditionTemplate(TEMPLATE, { unit_cost_cents: 23456, group_name: ' Tile ' }, undefined, SEEN);assert.equal(saved.unit_cost_cents, 23456);assert.equal(saved.group_name, 'Tile');assert.equal(saved.created_by, CREATOR);assert.equal(saved.updated_at, LATER);assert.equal(h.audits[0].actorId, ACTOR);assert.equal(h.audits[0].before.unit_cost_cents, 12345) })
test('clearing a broken cost-code reference permits explicit repair', async () => { const h = fixture({ codes: [] });assert.equal((await h.updateConditionTemplate(TEMPLATE, { cost_code_id: null })).cost_code_id, null) })
test('verified delete reports only the exact removed revision with current actor', async () => { const h = fixture();await h.deleteConditionTemplate(TEMPLATE, undefined, SEEN);assert.equal(h.store.takeoff_condition_templates.length, 0);assert.equal(h.audits.length, 1);assert.equal(h.audits[0].actorId, ACTOR);assert.equal(h.audits[0].before.updated_at, SEEN) })
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [] }
for (const canManage of [true, false]) test(`actual delete confirmation forwards rendered revision and enforces capability ${canManage}`, async () => {
  let stateIndex = 0
  const calls = [], states = [false, null, original], modules = {
    react: { ...React, useState: () => [states[stateIndex++], () => {}], useMemo: fn => fn(), useTransition: () => [false, fn => fn()] },
    'react/jsx-runtime': require('react/jsx-runtime'), 'next/navigation': { useRouter: () => ({ refresh() {} }) }, sonner: { toast: { success() {}, error() {} } },
    '@/lib/action-result': { unwrapAction: value => value.data }, '@/app/(app)/drawings/takeoff-actions': { deleteConditionTemplateAction: async (...args) => { calls.push(args);return { success: true, data: null } } },
  }, leaves = new Proxy({}, { get: (_, key) => String(key) }), exports = {}
  new Function('exports', 'require', transpile(fs.readFileSync('components/settings/takeoff-templates-panel.tsx', 'utf8')))(exports, key => modules[key] ?? leaves)
  const tree = nodes(exports.TakeoffTemplatesPanel({ groups: [{ group: 'Finishes', templates: [original] }], groupNames: [], costCodes: [], total: 1, cap: 500, canManage })), action = tree.find(n => n.type === 'AlertDialogAction')
  assert.equal(action.props.disabled, !canManage);action.props.onClick({ preventDefault() {} });await new Promise(resolve => setImmediate(resolve));assert.deepEqual(calls, canManage ? [[TEMPLATE, SEEN]] : [])
})
