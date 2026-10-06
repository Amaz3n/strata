const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')
const React = require('react')
const navigation = require('next/navigation')
const { DynamicServerError } = require('next/dist/client/components/hooks-server-context')
const { makeDynamicHangingPromise } = require('next/dist/server/dynamic-rendering-utils')

function fixture(failingRead, failure, { production = true, missingProject = false, live = Promise.resolve() } = {}) {
  const calls = [], exports = {}
  const project = missingProject ? null : { id: 'project', name: 'Fixture project', property_type: production ? 'production' : 'residential' }
  const read = (name, value) => async (...args) => {
    calls.push({ name, args })
    if (name === failingRead) throw failure
    return value
  }
  const modules = {
    'next/navigation': navigation,
    'next/server': { connection: read('connection', live) },
    'next/cache': { cacheLife: name => calls.push({ name: 'cacheLife', args: [name] }) },
    '@/lib/services/context': { requireOrgContext: read('context', { orgId: 'org', productTier: 'production' }) },
    '@/lib/product-tier': { getProjectPosture: property => property },
    '@/lib/services/projects': { getProjectIdentity: read('identity', project) },
    '@/lib/services/lots': { getProjectLotContext: read('lot', { communityId: 'community', communityName: 'Fixture community', block: 'B', lotNumber: '7' }) },
    '@/app/(app)/projects/[id]/actions': { getProjectAction: read('project', project), getProjectContractAction: read('contract', { total_cents: 1000 }) },
    '@/lib/services/project-financial-setup': { getProjectFinancialSetupStatusForProject: read('setup', { costCodesEnabled: true }) },
    '@/lib/services/billing-book': {
      getProjectBillingFacts: read('facts', { hasSov: true, hasPayApplications: true }),
      getReceivablesAccountingMode: read('accounting', { ledger: 'books', external: null }),
      getProjectBillingSummary: read('summary', { outstandingCents: 100 }),
      getProjectBillingUpNext: read('upNext', { selectedPeriod: { id: 'period' } }),
    },
    '@/lib/services/invoices': { listInvoicePage: read('invoices', { invoices: [{ id: 'invoice' }], totalCount: 1 }) },
    '@/lib/services/orgs': { getOrgBilling: read('orgBilling', { org: { name: 'Fixture builder' } }) },
    '@/lib/services/owner-billing-packages': { listProjectOwnerBillingPackageSummaries: read('packages', [{ id: 'package' }]) },
    '@/lib/financials/billing-model': { getProjectFinancialFeatureConfig: () => ({}) },
    '@/lib/receivables/policy': { getReceivablesPosturePolicy: () => ({}) },
    '@/lib/financials/billing-profile': { resolveBillingProfile: input => { calls.push({ name: 'profile', args: [input] }); return { costDriven: true, progressBilling: true } } },
  }
  const leaf = new Proxy({}, { get: (_, key) => key })
  const path = failingRead === 'lot' || failingRead === 'identity' || failingRead === 'layout' ? 'app/(app)/projects/[id]/layout.tsx' : 'app/(app)/projects/[id]/financials/billing/page.tsx'
  const source = fs.readFileSync(path, 'utf8') + (path.endsWith('layout.tsx') ? '\nexport { loadProjectContext, ProjectContext }\n' : '\nexport { BillingData }\n')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function('exports', 'require', code)(exports, name => ['react', 'react/jsx-runtime'].includes(name) ? require(name) : modules[name] ?? leaf)
  return { calls, exports, load: () => path.endsWith('layout.tsx') ? exports.loadProjectContext('project') : exports.BillingData({ id: 'project', periodId: null }) }
}
function book(tree) { return tree.props.children.find(child => child.type === 'BillingBook').props }
function thrown(work) { try { work() } catch (error) { return error } throw new Error('Expected Next.js signal') }
async function signals() {
  const controller = new AbortController()
  const hanging = makeDynamicHangingPromise(controller.signal, '/projects/project', 'project data').catch(error => error)
  controller.abort()
  return [thrown(() => navigation.redirect('/auth/signin')), thrown(navigation.notFound), new DynamicServerError('Interrupted project render'), await hanging]
}

test('project billing shell waits for connection before starting authenticated reads', async () => {
  let resolve
  const live = new Promise(done => { resolve = done }), f = fixture(undefined, undefined, { live })
  const boundary = f.exports.default({ params: Promise.resolve({ id: 'project' }) })
  assert.equal(boundary.type, React.Suspense)
  assert.deepEqual(f.calls, [])
  const route = boundary.props.children.type(boundary.props.children.props)
  await new Promise(done => setImmediate(done))
  assert.deepEqual(f.calls.map(call => call.name), ['connection'])
  resolve()
  const data = await route
  const loaded = await data.type(data.props)
  assert.equal(book(loaded).initialTotalCount, 1)
  assert.equal(book(loaded).selectedPeriodId, 'period')
  assert.deepEqual(book(loaded).loadErrors, [])
})
test('billing optional failures retain useful data and report partial query failures', async () => {
  for (const phase of ['facts', 'accounting', 'orgBilling', 'invoices', 'summary', 'upNext', 'packages']) {
    const f = fixture(phase, new Error('Storage unavailable')), props = book(await f.load())
    assert.equal(props.projects[0].id, 'project')
    assert.equal(props.initialTotalCount, phase === 'invoices' ? 0 : 1)
    assert.equal(props.initialSummary.outstandingCents, phase === 'summary' ? 0 : 100)
    assert.deepEqual(props.initialUpNext, phase === 'upNext' ? null : { selectedPeriod: { id: 'period' } })
    assert.equal(props.accounting.ledger, phase === 'accounting' ? 'unavailable' : 'books')
    assert.equal(props.builderInfo.name, phase === 'orgBilling' ? undefined : 'Fixture builder')
    assert.equal(props.ownerBillingPackages.length, phase === 'packages' ? 0 : 1)
    assert.equal(props.loadErrors.length, ['invoices', 'summary', 'upNext', 'packages'].includes(phase) ? 1 : 0)
    if (props.loadErrors.length) assert.match(props.loadErrors[0], /Storage unavailable/)
    if (phase === 'facts') assert.deepEqual(f.calls.find(call => call.name === 'profile').args[0].facts, { hasSov: false, hasPayApplications: false })
  }
})
for (const phase of ['facts', 'accounting', 'orgBilling', 'invoices', 'summary', 'upNext', 'packages', 'lot']) {
  test(`project ${phase} loading preserves Next.js navigation and render control flow`, async () => {
    for (const signal of await signals()) {
      for (const failure of [signal, new Error('Wrapped query failure', { cause: signal })]) {
        await assert.rejects(fixture(phase, failure).load(), error => error === signal)
      }
    }
  })
}
test('project context uses session caching and tolerates ordinary missing lot decoration', async () => {
  const f = fixture('lot', new Error('Lot unavailable'))
  assert.deepEqual(await f.load(), { id: 'project', name: 'Fixture project', posture: 'production', contextLabel: undefined, contextHref: undefined })
  assert.deepEqual(f.calls[0], { name: 'cacheLife', args: ['session'] })
  const success = await fixture('layout').load()
  assert.equal(success.contextLabel, 'Fixture community · Lot B-7')
  assert.equal(success.contextHref, '/communities/community')
  const residential = fixture('layout', undefined, { production: false })
  await residential.load(); assert.equal(residential.calls.some(call => call.name === 'lot'), false)
  const missing = fixture('layout', undefined, { missingProject: true })
  assert.equal(await missing.load(), null)
  await assert.rejects(missing.exports.ProjectContext({ params: Promise.resolve({ id: 'missing' }) }), error => error.digest === 'NEXT_HTTP_ERROR_FALLBACK;404')
})
test('billing authorization and required project failures do not become empty financial data', async () => {
  for (const phase of ['context', 'project', 'contract', 'setup']) {
    const failure = new Error('Required project read denied'), f = fixture(phase, failure)
    await assert.rejects(f.load(), error => error === failure)
    assert.equal(f.calls.some(call => ['summary', 'upNext', 'packages'].includes(call.name)), false)
  }
  const missing = fixture(undefined, undefined, { missingProject: true })
  await assert.rejects(missing.load(), error => error.digest === 'NEXT_HTTP_ERROR_FALLBACK;404')
  assert.equal(missing.calls.some(call => ['summary', 'upNext', 'packages'].includes(call.name)), false)
})
