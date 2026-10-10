require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { createFakeSupabase } = require('./support/fake-supabase')
const { stubModule, ORG, ACTOR, PROJECT, PACKAGE } = require('./support/starts-harness')
const { composePurchaseAgreementPricing } = require('../lib/financials/purchase-agreement-pricing')

function harness({ manage = false, payment = false, deniedRead = false, failure = null } = {}) {
  const pricing = composePurchaseAgreementPricing({ basePriceCents: 100000, lotPremiumCents: 10000 })
  const db = createFakeSupabase({
    closings: [{ id: PACKAGE, org_id: ORG, project_id: PROJECT, status: 'projected', scheduled_date: '2026-10-06', metadata: { adjustments: [{ id: ACTOR, label: 'Lender credit', kind: 'seller_credit', amountCents: -1000 }] }, settlement: { sentinel: 'Original persisted record' }, project: { name: 'Lot 42' }, lot: { lot_number: '42', plan: { name: 'Plan A' } }, community: { name: 'Oak' } }],
    closing_checklist_items: [], contracts: [{ id: ACTOR, org_id: ORG, project_id: PROJECT, contract_type: 'purchase_agreement', status: 'active', total_cents: 110000, snapshot: { purchase_agreement: { pricing } }, number: 'PA-42', signed_at: '2026-10-01T00:00:00Z' }],
    change_orders: [], invoices: [], payments: [],
  })
  const calls = [], gates = []
  const from = db.from.bind(db)
  db.from = table => {
    const q = from(table), run = q.run.bind(q)
    q.run = () => {
      calls.push({ table, action: q.action })
      if (failure === table && q.action === 'select') return { data: null, error: { message: `${table} unavailable` } }
      const result = run()
      // Model the installed PostgREST single-row response for conditional updates.
      if (q.action === 'update' && q.cardinality === 'single') return result.data?.length === 1 ? { ...result, data: result.data[0] } : { data: null, error: { message: 'Expected one updated row' } }
      return result
    }
    return q
  }
  const context = { supabase: db, orgId: ORG, userId: ACTOR }
  stubModule('@/lib/services/context', { requireOrgContext: async () => context })
  stubModule('@/lib/services/permissions', { requirePermission: async permission => {
    gates.push({ permission, level: 'org' })
    if (permission === 'closing.manage' && !manage) throw new Error('Manage denied')
  } })
  stubModule('@/lib/services/authorization', {
    requireAuthorization: async input => { gates.push(input); if (input.permission === 'sales.read' && deniedRead) throw new Error('Home read denied') },
    authorize: async input => { gates.push(input); return { allowed: input.permission === 'closing.manage' ? manage : payment } },
    getDivisionScopedProjectIds: async () => { throw new Error('Read must not enumerate organization homes') },
  })
  stubModule('@/lib/services/events', { recordEvent: async input => calls.push({ event: input }) })
  stubModule('@/lib/services/audit', { recordAudit: async input => calls.push({ audit: input }) })
  stubModule('@/lib/services/closing-readiness', { authorizeClosingProject: async input => { gates.push({ ...input, permission: 'closing.manage' }); if (!manage) throw new Error('Home manage denied') } })
  delete require.cache[require.resolve('../lib/services/closings')]
  return { ...require('../lib/services/closings'), db, calls, gates }
}
const writes = h => h.calls.filter(c => c.action && c.action !== 'select')
test('open closing page inspection and repeated settlement previews never seed or persist records', async () => {
  const h = harness(), original = JSON.stringify(h.db.store.closings[0])
  const detail = await h.getClosing(PROJECT)
  assert.equal(detail.checklist.length, 0)
  assert.equal(detail.settlementPreview.finalPriceCents, 109000)
  assert.equal(detail.canManageClosing, false); assert.equal(detail.canSettleClosing, false)
  await h.buildSettlement(PACKAGE)
  await h.getClosing(PROJECT)
  assert.equal(JSON.stringify(h.db.store.closings[0]), original)
  assert.equal(h.db.store.closing_checklist_items.length, 0)
  assert.deepEqual(writes(h), [])
  assert.equal(h.gates.find(g => g.projectId)?.permission, 'sales.read')
})
test('actual-home denial prevents buyer/financial lookup before any root read', async () => {
  const h = harness({ deniedRead: true })
  await assert.rejects(h.getClosing(PROJECT), /Home read denied/)
  assert.equal(h.calls.length, 0)
  assert.equal(h.gates.at(-1).projectId, PROJECT)
})
test('management/payment capability matrix is derived for the actual home', async () => {
  for (const manage of [false, true]) for (const payment of [false, true]) {
    const h = harness({ manage, payment }), detail = await h.getClosing(PROJECT)
    assert.equal(detail.canManageClosing, manage)
    assert.equal(detail.canRecoverCompletion, manage)
    assert.equal(detail.canSettleClosing, manage && payment)
    assert.ok(h.gates.some(g => g.permission === 'payment.release' && g.projectId === PROJECT))
    assert.deepEqual(writes(h), [])
  }
})
test('closed read preserves recorded evidence without consulting or repairing live monetary sources', async () => {
  const h = harness({ manage: true, payment: true })
  const settlement = await h.buildSettlement(PACKAGE)
  Object.assign(h.db.store.closings[0], { status: 'closed', settlement })
  h.db.store.contracts = []; h.calls.length = 0
  const detail = await h.getClosing(PROJECT)
  assert.equal(detail.settlementPreview.finalPriceCents, 109000)
  assert.equal(detail.agreement.number, 'PA-42')
  assert.equal(h.calls.some(c => ['contracts', 'change_orders', 'invoices', 'payments'].includes(c.table)), false)
  assert.deepEqual(writes(h), [])
})
test('failed closing/checklist/agreement sources remain errors with no repair writes', async () => {
  for (const failure of ['closings', 'closing_checklist_items', 'contracts']) {
    const h = harness({ failure })
    await assert.rejects(h.getClosing(PROJECT), /unavailable|Closing not found/)
    assert.deepEqual(writes(h), [])
  }
})
test('existing Schedule owner prepares checklist only after authorized editable-home lookup', async () => {
  const h = harness({ manage: true })
  const result = await h.scheduleClosing({ closingId: PACKAGE, scheduledDate: '2026-10-07' })
  assert.equal(result.status, 'scheduled')
  assert.equal(h.db.store.closing_checklist_items.length, 9)
  assert.equal(h.db.store.closing_checklist_items.every(row => row.org_id === ORG && row.closing_id === PACKAGE && row.status === 'open' && row.created_by === ACTOR), true)
  const ids = h.db.store.closing_checklist_items.map(row => row.id)
  await h.scheduleClosing({ closingId: PACKAGE, scheduledDate: '2026-10-08' })
  assert.deepEqual(h.db.store.closing_checklist_items.map(row => row.id), ids, 'Retry preserves existing checklist evidence')
  assert.ok(h.gates.some(g => g.projectId === PROJECT && g.permission === 'closing.manage'))
})
test('denied, missing and closed Schedule targets cannot prepare checklist', async () => {
  const denied = harness()
  await assert.rejects(denied.scheduleClosing({ closingId: PACKAGE, scheduledDate: '2026-10-07' }), /Manage denied/)
  assert.deepEqual(writes(denied), [])
  const closed = harness({ manage: true }); closed.db.store.closings[0].status = 'closed'
  await assert.rejects(closed.scheduleClosing({ closingId: PACKAGE, scheduledDate: '2026-10-07' }), /cannot be changed/)
  assert.deepEqual(writes(closed), [])
  const missing = harness({ manage: true }); missing.db.store.closings = []
  await assert.rejects(missing.scheduleClosing({ closingId: PACKAGE, scheduledDate: '2026-10-07' }), /Closing not found/)
  assert.deepEqual(writes(missing), [])
})
function component() {
  const original = Module._load
  try {
    Module._load = function(name, ...args) {
      if (name === '@/app/(app)/projects/[id]/closing/actions') return new Proxy({}, { get: () => () => { throw new Error('Server action executed during render') } })
      return original.call(this, name, ...args)
    }
    delete require.cache[require.resolve('../components/sales/closing-workbench')]
    return require('../components/sales/closing-workbench').ClosingWorkbench
  } finally { Module._load = original }
}
test('actual read-only workbench renders history and statement without management/payment actions', async () => {
  const h = harness(), detail = await h.getClosing(PROJECT)
  detail.closing.status = 'cleared_to_close'
  detail.checklist = [{ id: PACKAGE, title: 'Occupancy evidence', is_gate: true, status: 'open' }]
  const html = renderToStaticMarkup(React.createElement(component(), { projectId: PROJECT, detail }))
  assert.match(html, /Occupancy evidence/); assert.match(html, /Lender credit/)
  assert.doesNotMatch(html, />Schedule<|>Clear to close<|>Complete<|>Remove<|>Add<|>Settle closing<|closing-scheduled-date/)
  assert.match(html, /Scheduled:/)
})
test('actual manager workbench can manage checklist/adjustments but needs payment authority to settle', async () => {
  const h = harness({ manage: true }), detail = await h.getClosing(PROJECT)
  detail.closing.status = 'cleared_to_close'
  detail.checklist = [{ id: PACKAGE, title: 'Occupancy evidence', is_gate: true, status: 'open' }]
  const html = renderToStaticMarkup(React.createElement(component(), { projectId: PROJECT, detail }))
  assert.match(html, /closing-scheduled-date/); assert.match(html, />Complete</); assert.match(html, />Remove</); assert.match(html, />Add</)
  assert.doesNotMatch(html, /id="settlement-reference"|>Settle closing</)
})
test('actual authorized settlement and closed recovery expose only applicable controls', async () => {
  const h = harness({ manage: true, payment: true }), detail = await h.getClosing(PROJECT)
  detail.closing.status = 'cleared_to_close'
  const C = component()
  let html = renderToStaticMarkup(React.createElement(C, { projectId: PROJECT, detail }))
  assert.match(html, /id="settlement-reference"/); assert.match(html, />Settle closing</)
  detail.closing.status = 'closed'
  html = renderToStaticMarkup(React.createElement(C, { projectId: PROJECT, detail }))
  assert.match(html, />Retry completion</)
  assert.doesNotMatch(html, /closing-scheduled-date|id="settlement-reference"|>Complete<|>Add<|>Remove</)
})
test('empty checklist states identify the authorized next step without generating records', async () => {
  for (const manage of [false, true]) {
    const h = harness({ manage }), detail = await h.getClosing(PROJECT)
    const html = renderToStaticMarkup(React.createElement(component(), { projectId: PROJECT, detail }))
    assert.match(html, manage ? /Schedule this closing to prepare its checklist/ : /checklist has not been prepared/)
    assert.deepEqual(writes(h), [])
  }
})
test('settlement statement report follows the read-only path and returns buyer/builder evidence without writes', async () => {
  const h = harness()
  h.db.store.projects = [{ id: PROJECT, org_id: ORG, location: '42 Model Road', client: { full_name: 'Fixture Buyer', email: 'buyer@fixture.invalid' } }]
  h.db.store.orgs = [{ id: ORG, name: 'Fixture Homes', address: {} }]
  delete require.cache[require.resolve('../lib/services/reports/settlement-statement')]
  const { getSettlementStatementReport } = require('../lib/services/reports/settlement-statement')
  const report = await getSettlementStatementReport(PROJECT)
  assert.match(report.file_name, /lot-42\.pdf$/)
  assert.equal(report.data.finalPriceCents, 109000)
  assert.deepEqual(writes(h), [])
  assert.equal(h.db.store.closing_checklist_items.length, 0)
  assert.deepEqual(h.db.store.closings[0].settlement, { sentinel: 'Original persisted record' })
})

test('actual adjustment form retains failed/uncertain drafts and clears only a confirmed save', async () => {
  const fs = require('node:fs'), ts = require('typescript')
  const source = ts.createSourceFile('workbench.tsx', fs.readFileSync('components/sales/closing-workbench.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const selected = source.statements.filter(node => ts.isFunctionDeclaration(node) ? node.name?.text === 'SettlementAdjustments' : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ['money', 'ADJUSTMENT_KINDS'].includes(d.name.getText(source))))
  assert.equal(selected.length, 3)
  const code = ts.transpileModule(selected.map(n => n.getText(source)).join('\n') + '\nexport { SettlementAdjustments };', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  for (const mode of ['denied', 'transport', 'success']) {
    const state = []; let index = 0, operation, input
    const bindings = { useState: initial => { const i = index++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value }] },
      upsertClosingAdjustmentAction: async (_project, value) => { input = value; if (mode === 'transport') throw new Error('Reply lost'); return mode === 'success' ? { success: true, data: {} } : { success: false, error: 'Changed scope' } },
      Button: 'button', Label: 'label', Input: 'input', Select: 'select', SelectTrigger: 'span', SelectValue: 'span', SelectContent: 'div', SelectItem: 'option',
    }
    const exports = {}
    new Function('exports', 'require', ...Object.keys(bindings), code)(exports, require, ...Object.values(bindings))
    const props = { projectId: PROJECT, closing: { id: PACKAGE, status: 'scheduled' }, settlement: { adjustments: [] }, canManage: true, pending: false, act: work => { operation = work() } }
    const render = () => { index = 0; return exports.SettlementAdjustments(props) }
    const find = (node, predicate) => { if (Array.isArray(node)) return node.flatMap(n => find(n, predicate)); if (!React.isValidElement(node)) return []; return [...(predicate(node) ? [node] : []), ...find(node.props.children, predicate)] }
    let element = render()
    find(element, n => n.props.id === 'adjustment-label')[0].props.onChange({ target: { value: 'Lender credit' } })
    find(element, n => n.props.id === 'adjustment-amount')[0].props.onChange({ target: { value: '-1200.00' } })
    element = render()
    const add = find(element, n => n.type === 'button' && n.props.children === 'Add')[0]
    assert.equal(add.props.disabled, false)
    add.props.onClick()
    if (mode === 'transport') await assert.rejects(operation, /Reply lost/); else await operation
    assert.equal(input.amountCents, -120000)
    element = render()
    assert.equal(find(element, n => n.props.id === 'adjustment-label')[0].props.value, mode === 'success' ? '' : 'Lender credit')
    assert.equal(find(element, n => n.props.id === 'adjustment-amount')[0].props.value, mode === 'success' ? '' : '-1200.00')
  }
})
test('settlement counts only the agreement buyer\'s earnest deposits', async () => {
  const h = harness()
  const BUYER = '00000000-0000-4000-8000-0000000000b1', OTHER = '00000000-0000-4000-8000-0000000000b2'
  h.db.store.contracts[0].buyer_contact_id = BUYER
  h.db.store.invoices = [
    { id: 'inv-buyer', org_id: ORG, project_id: PROJECT, title: 'Buyer deposit', metadata: { invoice_kind: 'earnest_deposit', customer_id: BUYER } },
    { id: 'inv-other', org_id: ORG, project_id: PROJECT, title: 'Other deposit', metadata: { invoice_kind: 'earnest_deposit', customer_id: OTHER } },
  ]
  h.db.store.payments = [
    { id: 'pay-buyer', org_id: ORG, invoice_id: 'inv-buyer', amount_cents: 5000, status: 'succeeded', created_at: '2026-10-01T00:00:00Z' },
    { id: 'pay-other', org_id: ORG, invoice_id: 'inv-other', amount_cents: 7000, status: 'succeeded', created_at: '2026-10-01T00:00:00Z' },
  ]
  const settlement = await h.buildSettlement(PACKAGE)
  assert.deepEqual(settlement.depositsApplied.map(deposit => deposit.paymentId), ['pay-buyer'])
})
