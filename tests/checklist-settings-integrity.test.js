require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript'), React = require('react')
const { createFakeSupabase } = require('./support/fake-supabase')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1), ACTOR = id(2), TEMPLATE = id(3)
function transpile(source) { return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText }
function service(options = {}) {
  const { denied = false, countError = null, noRow = false } = options
  const count = Object.hasOwn(options, "count") ? options.count : 1
  const source = fs.readFileSync('lib/services/inspections.ts', 'utf8'), ast = ts.createSourceFile('inspections.ts', source, ts.ScriptTarget.Latest, true)
  const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && ['setChecklistTemplateActive', 'seedChecklistTemplates'].includes(n.name?.text)) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(v => v.name.getText(ast) === 'STARTER_TEMPLATES'))).map(n => n.getText(ast)).join('\n')
  const base = createFakeSupabase({ structured_form_templates: noRow ? [] : [{ id: TEMPLATE, org_id: ORG, is_active: true }], structured_form_items: [] }), calls = [], audits = []
  const db = { from: table => {
    const q = base.from(table), run = q.run.bind(q)
    q.run = () => {
      calls.push(q.action)
      if (q.head) return { data: null, count, error: countError }
      const result = run()
      if (q.action === 'update' && q.cardinality === 'single') return Array.isArray(result.data) && result.data.length === 1 ? { data: result.data[0], error: null } : { data: null, error: { message: 'expected exactly one row' } }
      return result
    }; return q
  } }
  const exports = {}
  new Function('exports', 'requireOrgContext', 'requirePermission', 'recordAudit', 'checklistTemplateActiveSchema', transpile(selected))(exports, async () => ({ orgId: ORG, userId: ACTOR, supabase: db }), async key => { calls.push(key); if (denied) throw Error('Forbidden') }, async args => audits.push(args), require('../lib/validation/inspections').checklistTemplateActiveSchema)
  return { ...exports, calls, audits, store: base.store }
}
for (const flag of ['false', 0, null]) test(`activation invalid ${JSON.stringify(flag)} is rejected before permission or DB calls`, async () => {
  const h = service(); await assert.rejects(h.setChecklistTemplateActive(TEMPLATE, flag)); assert.deepEqual(h.calls, []); assert.deepEqual(h.audits, [])
})
test('activation invalid ID is rejected before DB work', async () => { const h = service(); await assert.rejects(h.setChecklistTemplateActive('invalid', true)); assert.deepEqual(h.calls, []) })
test('activation requires inspection.write before update', async () => { const h = service({ denied: true }); await assert.rejects(h.setChecklistTemplateActive(TEMPLATE, false), /Forbidden/); assert.deepEqual(h.calls, ['inspection.write']) })
test('missing/foreign activation cannot report success or emit a phantom audit', async () => { const h = service({ noRow: true }); await assert.rejects(h.setChecklistTemplateActive(TEMPLATE, false), /unavailable or changed/); assert.deepEqual(h.audits, []) })
for (const flag of [false, true]) test(`confirmed activation ${flag} audits exact actor/org and saved state`, async () => {
  const h = service(); await h.setChecklistTemplateActive(TEMPLATE, flag); assert.equal(h.store.structured_form_templates[0].is_active, flag); assert.equal(h.audits[0].actorId, ACTOR); assert.equal(h.audits[0].orgId, ORG); assert.deepEqual(h.audits[0].after, { is_active: flag })
})
for (const args of [{ count: null }, { count: undefined }, { count: -1 }, { count: 1.5 }, { count: 0, countError: { message: 'unavailable' } }]) test(`seed refuses unavailable/invalid count ${JSON.stringify(args)}`, async () => {
  const h = service({ ...args, count: Object.hasOwn(args, 'count') ? args.count : 1 }); await assert.rejects(h.seedChecklistTemplates(), /Unable to verify/); assert.ok(!h.calls.includes('insert')); assert.deepEqual(h.audits, [])
})
test('verified existing library skips seed without inserts', async () => { const h = service(); assert.equal(await h.seedChecklistTemplates(), 0); assert.ok(!h.calls.includes('insert')) })
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [] }
function copy(node) { return Array.isArray(node) ? node.map(copy).join('') : React.isValidElement(node) ? copy(node.props.children) : typeof node === 'string' ? node : '' }
function render({ canManage = false, canSeed = false, editor = false, empty = false } = {}) {
  let stateIndex = 0, refIndex = 0
  const calls = [], setters = [], template = { id: TEMPLATE, name: 'Original', kind: 'quality', item_count: 1, is_active: true }
  const states = [editor, editor ? template : null, 'Original item', 'Original', '', '', 'quality', null, '', false]
  const refs = [{ current: true }, { current: false }, { current: 0 }]
  const modules = {
    react: { ...React, useState: init => { const slot = stateIndex++; return [states[slot] ?? init, value => setters.push([slot, value])] }, useRef: () => refs[refIndex++], useEffect: () => {}, useTransition: () => [false, fn => fn()] },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'next/navigation': { useRouter: () => ({ refresh: () => calls.push('refresh') }) },
    sonner: { toast: { error() {}, success() {} } },
    '@/lib/action-result': { unwrapAction: value => value.data },
    './checklists-actions': Object.fromEntries(['createChecklistTemplateAction', 'updateChecklistTemplateAction', 'setChecklistTemplateActiveAction', 'seedChecklistTemplatesAction', 'listChecklistTemplateItemsAction'].map(key => [key, async () => { calls.push(key); return { success: true, data: [] } }])),
  }
  const leaves = new Proxy({}, { get: (_, key) => String(key) }), exports = {}
  new Function('exports', 'require', transpile(fs.readFileSync('app/(app)/settings/templates/checklists-client.tsx', 'utf8')))(exports, key => modules[key] ?? leaves)
  return { tree: exports.ChecklistsClient({ templates: empty ? [] : [template], canManage, canSeed }), calls, setters }
}
test('read-only roster permits item inspection while disabling mutation controls and handler calls', async () => {
  const h = render(), tree = nodes(h.tree), create = tree.find(n => n.type === 'Button' && copy(n) === 'New template'), archive = tree.find(n => n.type === 'Button' && copy(n) === 'Archive')
  assert.equal(create.props.disabled, true); assert.equal(archive.props.disabled, true); create.props.onClick(); archive.props.onClick(); assert.deepEqual(h.calls, [])
  const inspect = tree.find(n => n.type === 'button' && copy(n) === 'Original'); assert.equal(inspect.props.disabled, false); inspect.props.onClick({ stopPropagation() {} }); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(h.calls, ['listChecklistTemplateItemsAction'])
})
test('read-only open preview never submits even when submit handler is invoked', () => {
  const h = render({ editor: true }), tree = nodes(h.tree), workspace = tree.find(n => n.type === 'PresetTemplateWorkspace'), form = tree.find(n => n.type === 'form')
  assert.equal(workspace.props.readOnly, true); form.props.onSubmit({ preventDefault() {} }); assert.deepEqual(h.calls, [])
})
for (const permitted of [false, true]) test(`seed ${permitted} is independent of inspection editing permission`, async () => {
  const h = render({ empty: true, canManage: false, canSeed: permitted }), seed = nodes(h.tree).find(n => n.type === 'Button' && copy(n) === 'Seed starter templates')
  assert.equal(seed.props.disabled, !permitted); seed.props.onClick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.includes('seedChecklistTemplatesAction'), permitted)
})
test('verified empty count permits original starter templates and items', async () => {
  const h = service({ count: 0, noRow: true }), seeded = await h.seedChecklistTemplates()
  assert.ok(seeded > 0); assert.equal(h.store.structured_form_templates.length, seeded)
  assert.ok(h.store.structured_form_items.length > seeded)
  assert.ok(h.store.structured_form_items.every(item => h.store.structured_form_templates.some(t => t.id === item.template_id && t.org_id === item.org_id)))
})
for (const allowed of [[], ['inspection.write'], ['org.admin']]) test(`actual settings section supplies independent current actor capabilities ${JSON.stringify(allowed)}`, async () => {
  const source = fs.readFileSync('app/(app)/settings/templates/page.tsx', 'utf8'), ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ChecklistsSection'), calls = [], exports = {}
  new Function('exports', 'require', 'requireOrgContext', 'listChecklistTemplates', 'authorize', 'ChecklistsClient', transpile('export '+fn.getText(ast)))(exports, require, async () => ({ orgId: ORG, userId: ACTOR }), async (_org, options) => { assert.equal(options.includeInactive, true); return [] }, async args => { calls.push(args); return { allowed: allowed.includes(args.permission) } }, 'ChecklistsClient')
  const result = await exports.ChecklistsSection(); assert.equal(result.props.canManage, allowed.includes('inspection.write')); assert.equal(result.props.canSeed, allowed.includes('org.admin')); assert.ok(calls.every(c => c.orgId === ORG && c.userId === ACTOR))
})
for (const readOnly of [true, false]) test(`actual shared workspace readonly=${readOnly} controls save and fieldset without changing preview`, () => {
  const exports = {}, modules = { react: { ...React, useState: init => [init, () => {}], useRef: init => ({ current: init }), useEffect: () => {} }, 'react/jsx-runtime': require('react/jsx-runtime'), 'next/dynamic': { default: () => 'Preview' } }, leaves = new Proxy({}, { get: (_, key) => String(key) })
  new Function('exports', 'require', transpile(fs.readFileSync('components/settings/preset-template-workspace.tsx', 'utf8')))(exports, key => modules[key] ?? leaves)
  const tree = nodes(exports.PresetTemplateWorkspace({ kind: 'Checklist', name: 'Original', rows: [], busy: false, readOnly, saveForm: 'original-form', onClose() {}, children: React.createElement('input') }))
  assert.equal(tree.filter(n => n.type === 'Button' && copy(n) === 'Save template').length, readOnly ? 0 : 1)
  assert.equal(tree.find(n => n.type === 'fieldset').props.disabled, readOnly); assert.ok(tree.some(n => n.type === 'Preview'))
})
