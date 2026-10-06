require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const { createClient } = require('@supabase/supabase-js')
const { inspectionItemResponseSchema } = require('../lib/validation/inspections')
const { readAllRowsById } = require('../lib/land/paging')
const { ORG, ACTOR, PROJECT, PACKAGE } = require('./support/starts-harness')
const ITEM = '00000000-0000-0000-0000-000000000001'
// Execute the original service declarations with the real SDK and paging helper.
// Transport is isolated: this does not establish SQL, RLS or concurrency acceptance.
function harness({ items = [{ id: ITEM, response: 'yes', is_deficient: false, sort_order: 0 }], status = 'draft', result = null, denied = null, childFailure = false, scheduleFailure = false, stale = false } = {}) {
  const calls = [], gates = [], events = []
  const inspection = { id: PACKAGE, org_id: ORG, project_id: PROJECT, schedule_item_id: ACTOR, status, result, kind: 'quality' }
  const state = { inspection, scheduleFailure }
  const supabase = createClient('https://inspection.invalid', 'isolated-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url, options) => {
    const params = new URL(url).searchParams, table = new URL(url).pathname.split('/').pop()
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ table, params, method: options.method, body })
    const error = message => new Response(JSON.stringify({ message }), { status: 409, headers: { 'content-type': 'application/json' } })
    if (table === 'inspection_items') {
      if (childFailure) return error('Checklist unavailable')
      if (params.get('id')?.startsWith('eq.')) {
        const item = { ...items[0], inspection_id: PACKAGE, response_type: 'yes_no' }
        if (options.method === 'PATCH') Object.assign(item, body)
        return new Response(JSON.stringify(item), { headers: { 'content-type': 'application/json' } })
      }
      // Force one-row provider pages despite a requested page of 100.
      const after = params.get('id')?.slice(3)
      return new Response(JSON.stringify(items.filter(i => !after || i.id > after).slice(0, 1)), { headers: { 'content-type': 'application/json' } })
    }
    if (table === 'inspections') {
      if (options.method === 'PATCH') {
        if (stale) return error('Concurrent inspection change')
        Object.assign(inspection, body)
      }
      return new Response(JSON.stringify(inspection), { headers: { 'content-type': 'application/json' } })
    }
    if (table === 'schedule_items') {
      if (state.scheduleFailure) return error('Scheduled item unavailable')
      return new Response(JSON.stringify({ id: ACTOR }), { headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected table ${table}`)
  } } })
  const context = { supabase, orgId: ORG, userId: ACTOR }
  const bindings = { inspectionItemNeedsCorrection: require('../lib/inspections/lifecycle').inspectionItemNeedsCorrection, isInspectionLifecycleEnabled: () => false, inspectionItemResponseSchema, requireOrgContext: async () => context, requirePermission: async () => {}, requireAuthorization: async input => { gates.push(input); if (input.permission === denied) throw new Error('Home denied') }, readAllRowsById, mapInspection: row => row, INSPECTION_SELECT: '*', ITEM_SELECT: '*', recordEvent: async e => events.push(e), recordAudit: async e => events.push(e) }
  const source = ts.createSourceFile('inspections.ts', fs.readFileSync('lib/services/inspections.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const names = ['getInspection', 'updateInspectionItem', 'completeInspectionScheduledWork', 'completeInspection']
  const declarations = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
  assert.equal(declarations.length, names.length)
  const code = ts.transpileModule(declarations.map(n => n.getText(source)).join('\n') + '\nexport { getInspection, updateInspectionItem, completeInspection };', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new Function('exports', ...Object.keys(bindings), code)(exports, ...Object.values(bindings))
  return { ...exports, calls, gates, events, state }
}
const writes = h => h.calls.filter(c => c.method === 'PATCH')
for (const [label, items, expected] of [
  ['deficiency', [{ id: ITEM, response: 'yes', is_deficient: true }], 'fail'],
  ['unanswered', [{ id: ITEM, response: null }], 'partial'],
  ['empty', [], 'partial'],
  ['not applicable', [{ id: ITEM, response: 'n/a' }], 'partial'],
]) test(`${label} inspection is recorded without completing scheduled work`, async () => {
  const h = harness({ items }), result = await h.completeInspection(PACKAGE)
  assert.equal(result.result, expected)
  assert.equal(h.calls.some(c => c.table === 'schedule_items'), false)
  assert.equal(writes(h).length, 1)
})
test('passing inspection completes only its own tenant/home noncancelled scheduled work', async () => {
  const h = harness(), result = await h.completeInspection(PACKAGE)
  assert.equal(result.result, 'pass')
  const root = writes(h)[0], schedule = writes(h)[1]
  assert.equal(root.params.get('status'), 'eq.draft')
  assert.equal(schedule.params.get('org_id'), `eq.${ORG}`)
  assert.equal(schedule.params.get('project_id'), `eq.${PROJECT}`)
  assert.equal(schedule.params.get('id'), `eq.${ACTOR}`)
  assert.equal(schedule.params.get('status'), 'neq.cancelled')
  assert.deepEqual(schedule.body, { status: 'completed', progress: 100 })
  assert.ok(h.gates.some(g => g.permission === 'inspection.write' && g.projectId === PROJECT))
})
test('provider-short pages are exhausted before deriving an inspection pass', async () => {
  const h = harness({ items: [{ id: ITEM, response: 'yes', sort_order: 2 }, { id: '00000000-0000-0000-0000-000000000002', response: null, sort_order: 1 }] })
  const result = await h.completeInspection(PACKAGE)
  assert.equal(result.result, 'partial'); assert.equal(result.items.length, 2)
  assert.equal(h.calls.filter(c => c.table === 'inspection_items').length, 3)
  assert.equal(result.items[0].sort_order, 1)
})
test('unreadable checklist rejects completion with no state writes', async () => {
  const h = harness({ childFailure: true })
  await assert.rejects(h.completeInspection(PACKAGE), /Checklist unavailable/)
  assert.deepEqual(writes(h), [])
})
test('home read denial occurs before checklist exposure; write denial before mutation', async () => {
  for (const denied of ['project.read', 'inspection.write']) {
    const h = harness({ denied })
    await assert.rejects(h.completeInspection(PACKAGE), /Home denied/)
    assert.deepEqual(writes(h), [])
    if (denied === 'project.read') assert.equal(h.calls.some(c => c.table === 'inspection_items'), false)
  }
})
test('recorded pass survives failed handoff and retries without completing inspection twice', async () => {
  const h = harness({ scheduleFailure: true })
  await assert.rejects(h.completeInspection(PACKAGE), /Inspection is recorded; retry/)
  assert.equal(h.state.inspection.status, 'completed'); assert.equal(h.state.inspection.result, 'pass')
  assert.equal(h.events.length, 2, 'Recorded attempt retains its event and audit despite schedule failure')
  h.state.scheduleFailure = false
  await h.completeInspection(PACKAGE)
  assert.equal(writes(h).filter(c => c.table === 'inspections').length, 1)
  assert.equal(writes(h).filter(c => c.table === 'schedule_items').length, 2)
  assert.equal(h.events.length, 2)
})
test('historical failed attempt never completes a linked slot on retry', async () => {
  const h = harness({ status: 'completed', result: 'fail' })
  assert.equal((await h.completeInspection(PACKAGE)).result, 'fail')
  assert.deepEqual(writes(h), [])
})
test('historical passing result with nonpassing live checklist cannot advance work', async () => {
  const h = harness({ status: 'completed', result: 'pass', items: [] })
  await assert.rejects(h.completeInspection(PACKAGE), /no longer matches/)
  assert.deepEqual(writes(h), [])
})
test('concurrent root status change rejects before schedule update', async () => {
  const h = harness({ stale: true })
  await assert.rejects(h.completeInspection(PACKAGE), /Concurrent inspection change/)
  assert.equal(h.calls.some(c => c.table === 'schedule_items'), false)
})

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
function detailComponent() {
  const source = ts.createSourceFile('inspection.tsx', fs.readFileSync('app/(app)/projects/[id]/inspections/inspections-client.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const names = ['InspectionDetailSheet', 'ResultBadge', 'resultStyles', 'statusStyles', 'STATUS_LABELS']
  const nodes = source.statements.filter(n => ts.isFunctionDeclaration(n) ? names.includes(n.name?.text) : ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(source))))
  assert.equal(nodes.length, names.length)
  const bindings = { inspectionItemNeedsCorrection: require('../lib/inspections/lifecycle').inspectionItemNeedsCorrection, useState: React.useState, useTransition: React.useTransition, useRouter: () => ({ refresh() {} }), cn: (...parts) => parts.filter(Boolean).join(' '), ClipboardCheck: () => null }
  for (const name of ['Sheet', 'SheetContent', 'SheetHeader', 'SheetTitle', 'SheetDescription', 'Badge']) bindings[name] = ({ children }) => React.createElement('div', null, children)
  bindings.Button = function StubButton({ children, disabled }) { return React.createElement('button', { disabled }, children) }
  bindings.Textarea = function StubTextarea({ value, disabled }) { return React.createElement('textarea', { value, disabled, readOnly: true }) }
  const code = ts.transpileModule(nodes.map(n => n.getText(source)).join('\n') + '\nexport { InspectionDetailSheet };', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}
  new Function('exports', 'require', ...Object.keys(bindings), code)(exports, require, ...Object.values(bindings))
  return exports.InspectionDetailSheet
}
test('detail renders reader-safe state and authorized passing-handoff recovery', () => {
  const Component = detailComponent()
  for (const canWrite of [false, true]) for (const status of ['draft', 'completed']) for (const result of ['pass', 'fail', 'partial']) {
    const inspection = { id: PACKAGE, inspection_number: 1, status, result: status === 'draft' ? null : result, kind: 'quality', items: [], schedule_item_id: ACTOR }
    const html = renderToStaticMarkup(React.createElement(Component, { projectId: PROJECT, inspection, canWrite, companies: [], open: true, onOpenChange() {} }))
    assert.equal(html.includes('Complete linked scheduled work'), canWrite && status === 'completed' && result === 'pass')
    assert.equal(html.includes('Complete inspection'), canWrite && status === 'draft')
    assert.equal(/<textarea disabled/.test(html), !canWrite || status === 'completed')
    if (!canWrite && status === 'draft') assert.match(html, /Draft/)
  }
})

test('completed attempt evidence is immutable through the original item writer', async () => {
  const h = harness({ status: 'completed', result: 'fail' })
  await assert.rejects(h.updateInspectionItem(ITEM, { response: 'pass' }), /Completed inspection evidence is read-only/)
  assert.deepEqual(writes(h), [])
})
test('open item edits require actual-home write authority and preserve the parent association', async () => {
  const denied = harness({ denied: 'inspection.write' })
  await assert.rejects(denied.updateInspectionItem(ITEM, { response: 'yes' }), /Home denied/)
  assert.deepEqual(writes(denied), [])
  const h = harness()
  await h.updateInspectionItem(ITEM, { response: 'yes' })
  assert.equal(writes(h)[0].params.get('inspection_id'), `eq.${PACKAGE}`)
  assert.equal(writes(h)[0].params.get('org_id'), `eq.${ORG}`)
})
test('original completion action refreshes recorded state after a handoff error', async () => {
  const source = ts.createSourceFile('actions.ts', fs.readFileSync('app/(app)/projects/[id]/inspections/actions.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'completeInspectionAction')
  assert.ok(declaration)
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const refreshed = [], exports = {}
  new Function('exports', 'run', 'completeInspection', 'revalidatePath', code)(exports, async work => { try { return { success: true, data: await work() } } catch (e) { return { success: false, error: e.message } } }, async () => { throw new Error('Inspection is recorded; retry schedule') }, path => refreshed.push(path))
  const result = await exports.completeInspectionAction(PROJECT, PACKAGE)
  assert.equal(result.success, false); assert.match(result.error, /recorded/)
  assert.deepEqual(refreshed, [`/projects/${PROJECT}/inspections`, `/projects/${PROJECT}/schedule`])
})
