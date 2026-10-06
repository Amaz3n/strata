const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')
const React = require('react')
const navigation = require('next/navigation')
const { DynamicServerError } = require('next/dist/client/components/hooks-server-context')
const { makeDynamicHangingPromise } = require('next/dist/server/dynamic-rendering-utils')

const routes = ['page.tsx', 'model/page.tsx', 'punch-list/page.tsx', 'change-orders/[id]/page.tsx', 'decisions/page.tsx', 'selections/page.tsx', 'invoices/[id]/page.tsx', 'warranty/page.tsx']
function fixture(route, failingRead, failure, { live = Promise.resolve(), gateStatus = 'ok', payable = true } = {}) {
  const calls = [], warnings = [], exports = {}
  const access = { id: 'access', org_id: 'org', project_id: 'project', permissions: { can_pay_invoices: payable } }
  const read = (name, value) => async (...args) => {
    calls.push({ name, args })
    if (name === failingRead) throw failure
    return value
  }
  const modules = {
    'next/navigation': navigation,
    'next/server': { connection: read('connection', live) },
    '@/lib/services/portal-access': {
      assertPortalActionAccess: read('access', access),
      recordPortalAccess: read('stamp', undefined),
      loadClientPortalShellContext: read('context', { org: { name: 'Builder' }, project: { name: 'Home' }, counts: {}, hasInvoices: true, hasPayApplications: false }),
    },
    './load-portal': { loadClientPortalPage: read('home', { access, data: {} }) },
    '@/lib/services/invoices': { getInvoiceForPortal: read('invoice', { id: 'invoice', token: 'invoice-token', total_cents: 1000 }) },
    '@/lib/services/receipts': { listReceiptsForInvoice: read('receipts', [{ id: 'receipt' }]) },
    '@/lib/services/cost-plus': { listOpenBookCostDetailsForInvoice: read('costs', [{ id: 'cost' }]) },
    '@/lib/services/owner-billing-packages': { listSharedInvoiceBackupPackagesForPortal: read('packages', [{ id: 'package' }]) },
    '@/lib/payments/fee-engine': { loadPaymentFeePolicy: read('payment', {}), restrictPaymentFeePolicyToInvoice: policy => policy, calculatePaymentFeeQuotes: () => [{ method: 'ach' }] },
    '@/lib/supabase/server': { createServiceSupabaseClient: () => ({}) },
    '@/lib/services/warranty': {
      listWarrantyRequestsForPortal: read('requests', [{ id: 'request' }]),
      getProjectWarrantyCoverageForPortal: read('coverage', { id: 'coverage' }),
      listWarrantyVisitsForBuyerPortal: read('visits', [{ id: 'visit' }]),
    },
    '@/lib/services/floorplan-models': { getPortalFloorplanModel: read('floorplan', { id: 'model' }) },
    '@/lib/portal/gate': { resolvePortalGate: read('gate', { status: gateStatus, access, workspace: null, claim: null, element: 'blocked-gate' }) },
    '@/components/portal/shell/portal-nav-items': { buildClientPortalNav: input => { calls.push({ name: 'nav', args: [input] }); return [] } },
  }
  const leaf = new Proxy({}, { get: (_, key) => key })
  const source = fs.readFileSync(`app/p/[token]/${route}`, 'utf8') + (route === 'layout.tsx' ? '\nexport { ClientPortalLayoutContent }\n' : '')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function('exports', 'require', 'process', 'console', code)(exports, name => ['react', 'react/jsx-runtime'].includes(name) ? require(name) : modules[name] ?? leaf, { env: { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'fixture-public-key' } }, { warn: (...args) => warnings.push(args) })
  const props = { params: Promise.resolve({ token: 'buyer-token', id: 'invoice' }), children: 'page-content' }
  return { calls, warnings, exports, props, load: () => route === 'layout.tsx' ? exports.ClientPortalLayoutContent(props) : route === 'load-portal.ts' ? exports.loadClientPortalPage('buyer-token') : exports.default(props) }
}
function thrown(work) { try { work() } catch (error) { return error } throw new Error('Expected framework signal') }
async function signals() {
  const controller = new AbortController()
  const hanging = makeDynamicHangingPromise(controller.signal, '/p/buyer', 'buyer portal').catch(error => error)
  controller.abort()
  return [thrown(() => navigation.redirect('/auth/signin')), thrown(navigation.notFound), new DynamicServerError('Interrupted portal render'), await hanging]
}
for (const route of routes) {
  test(`buyer ${route} preserves framework signals while refusing ordinary access failures`, async () => {
    const phase = route === 'page.tsx' ? 'stamp' : 'access'
    for (const signal of await signals()) {
      for (const failure of [signal, new Error('Wrapped access failure', { cause: signal })]) {
        await assert.rejects(fixture(route, phase, failure).load(), error => error === signal)
      }
    }
    const denied = fixture(route, phase, new Error('Access denied'))
    await assert.rejects(denied.load(), error => error.digest === 'NEXT_HTTP_ERROR_FALLBACK;404')
    assert.equal(denied.calls.some(call => ['invoice', 'requests', 'coverage', 'visits', 'floorplan'].includes(call.name)), false)
  })
}
for (const [route, phases] of [['invoices/[id]/page.tsx', ['payment', 'receipts', 'costs', 'packages']], ['warranty/page.tsx', ['requests', 'coverage', 'visits']], ['layout.tsx', ['floorplan']]]) {
  for (const phase of phases) {
    test(`buyer ${phase} optional read preserves navigation and prerender control flow`, async () => {
      for (const signal of await signals()) {
        for (const failure of [signal, new Error('Wrapped optional read', { cause: signal })]) {
          const f = fixture(route, phase, failure)
          await assert.rejects(f.load(), error => error === signal)
          assert.deepEqual(f.warnings, [])
        }
      }
    })
  }
}
test('buyer invoice preserves available proof and offline payment on ordinary failures', async () => {
  for (const phase of ['payment', 'receipts', 'costs', 'packages']) {
    const f = fixture('invoices/[id]/page.tsx', phase, new Error('Storage unavailable')), tree = await f.load()
    const props = tree.props.children.find(child => child.type === 'InvoicePortalClient').props
    assert.equal(props.invoice.id, 'invoice')
    assert.deepEqual(props.payment, phase === 'payment' ? null : { publishableKey: 'fixture-public-key', portalToken: 'buyer-token', feeQuotes: [{ method: 'ach' }] })
    assert.equal(props.receipts.length, phase === 'receipts' ? 0 : 1)
    assert.equal(props.costDetails.length, phase === 'costs' ? 0 : 1)
    assert.equal(props.backupPackages.length, phase === 'packages' ? 0 : 1)
    assert.equal(props.proofErrors.length, phase === 'payment' ? 0 : 1)
    if (props.proofErrors.length) assert.match(props.proofErrors[0], /Storage unavailable/)
    assert.equal(f.warnings.length, phase === 'payment' ? 1 : 0)
    const proof = f.calls.filter(call => ['receipts', 'costs', 'packages'].includes(call.name))
    assert.equal(proof.length, 3)
    for (const call of proof) assert.equal(call.args[0].orgId, 'org')
  }
  const readonly = fixture('invoices/[id]/page.tsx', undefined, undefined, { payable: false })
  await readonly.load(); assert.equal(readonly.calls.some(call => call.name === 'payment'), false)
})
test('buyer warranty failures retain the other available sections', async () => {
  for (const phase of ['requests', 'coverage', 'visits']) {
    const f = fixture('warranty/page.tsx', phase, new Error('Storage unavailable')), props = (await f.load()).props
    assert.equal(props.requests.length, phase === 'requests' ? 0 : 1)
    assert.deepEqual(props.coverage, phase === 'coverage' ? null : { id: 'coverage' })
    assert.equal(props.visits.length, phase === 'visits' ? 0 : 1)
    for (const call of f.calls.filter(call => ['requests', 'coverage', 'visits'].includes(call.name))) assert.deepEqual(call.args, ['org', 'project'])
  }
})
test('buyer layout retains its gate and omits unavailable optional model navigation', async () => {
  const f = fixture('layout.tsx', 'floorplan', new Error('Model unavailable'))
  const boundary = f.exports.default(f.props)
  assert.equal(boundary.type, React.Suspense); assert.deepEqual(f.calls, [])
  const tree = await f.load()
  assert.equal(tree.props.children, 'page-content')
  assert.equal(f.calls.find(call => call.name === 'nav').args[0].has3dModel, false)
  for (const gateStatus of ['invalid', 'wrong-portal', 'blocked']) {
    const gated = fixture('layout.tsx', undefined, undefined, { gateStatus })
    if (gateStatus === 'blocked') assert.equal(await gated.load(), 'blocked-gate')
    else await assert.rejects(gated.load(), error => error.digest === 'NEXT_HTTP_ERROR_FALLBACK;404')
    assert.deepEqual(gated.calls.map(call => call.name), ['gate'])
  }
})
test('buyer page reads start only after a live connection', async () => {
  let resolve
  const live = new Promise(done => { resolve = done }), f = fixture('warranty/page.tsx', undefined, undefined, { live }), loaded = f.load()
  await new Promise(done => setImmediate(done)); assert.deepEqual(f.calls.map(call => call.name), ['connection'])
  resolve(); await loaded
  assert.deepEqual(f.calls.map(call => call.name), ['connection', 'access', 'requests', 'coverage', 'visits'])
})
test('all shared buyer loaders preserve access signals before reading portal data', async () => {
  const loaders = ['loadClientPortalPage', 'loadClientPortalPhotosPage', 'loadClientPortalActionsPage', 'loadClientPortalAboutPage', 'loadClientPortalDocumentsPage', 'loadClientPortalPayApplicationsPage', 'loadClientPortalPayApplicationPage']
  for (const loader of loaders) {
    for (const signal of await signals()) {
      for (const failure of [signal, new Error('Wrapped shared-loader failure', { cause: signal })]) {
        const f = fixture('load-portal.ts', 'access', failure)
        await assert.rejects(f.exports[loader]('buyer-token', 'application'), error => error === signal)
        assert.deepEqual(f.calls.map(call => call.name), ['access'])
      }
    }
    const denied = fixture('load-portal.ts', 'access', new Error('Access denied'))
    await assert.rejects(denied.exports[loader]('buyer-token', 'application'), error => error.digest === 'NEXT_HTTP_ERROR_FALLBACK;404')
    assert.deepEqual(denied.calls.map(call => call.name), ['access'])
  }
})
