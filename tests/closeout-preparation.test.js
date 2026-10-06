require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module')
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server')
const { createFakeSupabase } = require('./support/fake-supabase')
const { stubModule, ORG, ACTOR, PROJECT, PACKAGE } = require('./support/starts-harness')
const other = '00000000-0000-4000-8000-000000000099'
function harness({ packages = [], items = [], failure, deny = false, readDeny = false } = {}) {
  const db = createFakeSupabase({ closeout_packages: packages, closeout_items: items, file_links: [] })
  const calls = [], gates = [], from = db.from.bind(db)
  let injected = failure
  db.from = table => {
    const query = from(table), run = query.run.bind(query)
    query.run = () => {
      calls.push({ table, action: query.action, payload: query.payload })
      if (injected === `${table}:${query.action}`) return { data: null, error: { message: 'Source unavailable' } }
      return run()
    }
    return query
  }
  const context = { supabase: db, orgId: ORG, userId: ACTOR }
  stubModule('@/lib/services/context', { requireOrgContext: async () => context })
  stubModule('@/lib/services/permissions', { requirePermission: async key => { gates.push(key); if (deny) throw Error('Org denied') }, requireAnyPermission: async () => {} })
  stubModule('@/lib/services/authorization', { requireAuthorization: async input => { gates.push(input); if ((deny && input.permission === 'closeout.write') || readDeny) throw Error('Home denied') } })
  stubModule('@/lib/services/waiver-register', { getProjectWaiverReadiness: async () => ({ ready: false, missing: ['Final coverage'] }) })
  stubModule('@/lib/services/audit', { recordAudit: async () => {} })
  stubModule('@/lib/services/events', { recordEvent: async () => {} })
  stubModule('@/lib/services/outbox', { enqueueOutboxJob: async () => {} })
  delete require.cache[require.resolve('../lib/services/closeout')]
  return { ...require('../lib/services/closeout'), db, calls, gates, clearFailure: () => { injected = undefined } }
}
const writes = h => h.calls.filter(c => c.action !== 'select')
const legacy = { id: PACKAGE, org_id: ORG, project_id: PROJECT, status: 'in_progress' }
test('opening an unprepared home repeatedly remains read-only and reports preparation required', async () => {
  const h = harness()
  for (let i = 0; i < 2; i++) assert.deepEqual(await h.getCloseoutPackage(PROJECT), { package: null, items: [], preparationRequired: true })
  assert.equal(writes(h).length, 0)
  assert.equal(h.gates[0].permission, 'closeout.read'); assert.equal(h.gates[0].projectId, PROJECT)
})
test('home read denial prevents package queries and preparation', async () => {
  const h = harness({ readDeny: true })
  await assert.rejects(h.getCloseoutPackage(PROJECT), /Home denied/)
  assert.equal(h.calls.length, 0)
})
test('package lookup failure remains an error and never creates replacement evidence', async () => {
  const h = harness({ failure: 'closeout_packages:select' })
  await assert.rejects(h.getCloseoutPackage(PROJECT), /Source unavailable/)
  await assert.rejects(h.prepareCloseoutPackage(PROJECT), /Source unavailable/)
  assert.equal(writes(h).length, 0)
})
test('explicit preparation requires org and actual-home write authorization', async () => {
  const denied = harness({ deny: true })
  await assert.rejects(denied.prepareCloseoutPackage(PROJECT), /denied/)
  assert.equal(denied.calls.length, 0)
  const h = harness(); await h.prepareCloseoutPackage(PROJECT)
  assert.equal(h.gates[0], 'org.member'); assert.equal(h.gates[1].permission, 'closeout.write'); assert.equal(h.gates[1].projectId, PROJECT)
  assert.equal(h.db.store.closeout_packages.length, 1); assert.equal(h.db.store.closeout_items.length, 6)
})
test('retry after failed default insertion repairs preparation without duplicate packages', async () => {
  const h = harness({ failure: 'closeout_items:upsert' })
  await assert.rejects(h.prepareCloseoutPackage(PROJECT), /Retry preparation/)
  assert.equal(h.db.store.closeout_packages.length, 1); assert.equal(h.db.store.closeout_items.length, 0)
  assert.equal((await h.getCloseoutPackage(PROJECT)).preparationRequired, true)
  h.clearFailure(); const result = await h.prepareCloseoutPackage(PROJECT)
  assert.equal(result.id, h.db.store.closeout_packages[0].id)
  assert.equal(h.db.store.closeout_items.length, 6)
  assert.equal((await h.getCloseoutPackage(PROJECT)).preparationRequired, false)
})
test('repeated preparation preserves IDs, completed progress, owners and notes', async () => {
  const h = harness(); await h.prepareCloseoutPackage(PROJECT)
  Object.assign(h.db.store.closeout_items[0], { status: 'complete', notes: 'Reviewed original', responsible_party: 'Trade' })
  const before = JSON.stringify(h.db.store)
  await h.prepareCloseoutPackage(PROJECT)
  assert.equal(JSON.stringify(h.db.store), before)
})
test('existing legacy package and custom checklist remain intact', async () => {
  const items = [{ id: ACTOR, org_id: ORG, project_id: PROJECT, closeout_package_id: PACKAGE, title: 'Customer requirement', status: 'complete' }]
  const h = harness({ packages: [legacy], items }), before = JSON.stringify(h.db.store)
  await h.prepareCloseoutPackage(PROJECT)
  const detail = await h.getCloseoutPackage(PROJECT)
  assert.equal(detail.items.length, 1); assert.equal(detail.preparationRequired, false)
  assert.equal(JSON.stringify(h.db.store), before); assert.equal(writes(h).length, 0)
})
test('read item scope excludes wrong-home children even with matching package identifier', async () => {
  const h = harness({ packages: [legacy], items: [{ id: ACTOR, org_id: ORG, project_id: other, closeout_package_id: PACKAGE, title: 'Foreign' }] })
  assert.equal((await h.getCloseoutPackage(PROJECT)).items.length, 0)
  assert.equal(writes(h).length, 0)
})
test('creating a requirement rejects foreign package ancestry before writing', async () => {
  const h = harness({ packages: [{ ...legacy, project_id: other }] })
  await assert.rejects(h.createCloseoutItem({ input: { project_id: PROJECT, closeout_package_id: PACKAGE, title: 'Requirement' } }), /does not belong/)
  assert.equal(writes(h).length, 0)
  assert.equal(h.gates.at(-1).projectId, PROJECT)
})
test('creating a requirement requires actual-home permission even with a valid package', async () => {
  const h = harness({ packages: [legacy], readDeny: true })
  await assert.rejects(h.createCloseoutItem({ input: { project_id: PROJECT, closeout_package_id: PACKAGE, title: 'Requirement' } }), /Home denied/)
  assert.equal(writes(h).length, 0)
})
function client() {
  const load = Module._load
  try {
    Module._load = function(name, ...rest) {
      if (name === 'next/navigation') return { useRouter: () => ({ refresh() { throw Error('Unexpected refresh while rendering') } }) }
      if (name === '@/app/(app)/closeout/actions') return new Proxy({}, { get: () => () => { throw Error('Unexpected action while rendering') } })
      return load.call(this, name, ...rest)
    }
    delete require.cache[require.resolve('../components/closeout/closeout-client')]
    return require('../components/closeout/closeout-client').CloseoutClient
  } finally { Module._load = load }
}
const readiness = { state: 'ready', sections: [], blockerCount: 0, warningCount: 0, blockingAmountCents: 0 }
test('actual preparation UI gives readers an explanation and writers an explicit action', () => {
  const C = client(), html = canWrite => renderToStaticMarkup(React.createElement(C, { projectId: PROJECT, closeoutPackage: null, items: [], readiness, canWrite }))
  assert.doesNotMatch(html(false), /Prepare checklist<\/button>/)
  assert.match(html(false), /closeout write access/)
  assert.match(html(true), /Prepare checklist<\/button>/)
})
test('actual prepared reader UI exposes evidence without create or status mutation controls', () => {
  const C = client(), html = renderToStaticMarkup(React.createElement(C, { projectId: PROJECT, closeoutPackage: legacy, items: [{ id: ACTOR, title: 'Reviewed drawings', status: 'missing' }], readiness, canWrite: false }))
  assert.match(html, /Reviewed drawings/); assert.match(html, /Export/)
  assert.doesNotMatch(html, /Add requirement|>Add<|Save details/)
  assert.match(html, /disabled=""/)
})
test('close readiness rejects denied actual-home access before querying financial evidence', async () => {
  const h = harness({ readDeny: true })
  delete require.cache[require.resolve('../lib/services/project-close-readiness')]
  const { getProjectCloseReadiness } = require('../lib/services/project-close-readiness')
  await assert.rejects(getProjectCloseReadiness(PROJECT), /Home denied/)
  assert.equal(h.calls.length, 0)
  assert.equal(h.gates.at(-1).permission, 'closeout.read')
  assert.equal(h.gates.at(-1).projectId, PROJECT)
})
test('real Supabase SDK sends conflict-ignore preparation and own-home confirmation without overwriting evidence', async () => {
  const { createClient } = require('@supabase/supabase-js')
  harness()
  const calls = [], rows = []
  const supabase = createClient('https://closeout-fixture.invalid', 'isolated-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url, options) => {
    const endpoint = new URL(url), table = endpoint.pathname.split('/').pop(), method = options.method ?? 'GET'
    calls.push({ endpoint, method, body: options.body ? JSON.parse(options.body) : null, headers: new Headers(options.headers) })
    if (method === 'POST') {
      if (table === 'closeout_packages') rows.push(JSON.parse(options.body))
      return new Response(null, { status: 201 })
    }
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
  } } })
  stubModule('@/lib/services/context', { requireOrgContext: async () => ({ supabase, orgId: ORG, userId: ACTOR }) })
  delete require.cache[require.resolve('../lib/services/closeout')]
  const { prepareCloseoutPackage } = require('../lib/services/closeout')
  const pkg = await prepareCloseoutPackage(PROJECT)
  assert.equal(calls.length, 4)
  for (const call of calls.filter(c => c.method === 'POST')) {
    assert.equal(call.endpoint.searchParams.get('on_conflict'), 'id')
    assert.match(call.headers.get('prefer'), /resolution=ignore-duplicates/)
  }
  for (const call of calls.filter(c => c.method === 'GET')) {
    assert.equal(call.endpoint.searchParams.get('org_id'), `eq.${ORG}`)
    assert.equal(call.endpoint.searchParams.get('project_id'), `eq.${PROJECT}`)
  }
  assert.equal(pkg.id, calls[1].body.id)
  assert.equal(calls[3].body.length, 6)
  assert.equal(calls[3].body.every(row => row.org_id === ORG && row.project_id === PROJECT && row.closeout_package_id === pkg.id), true)
  assert.equal(new Set(calls[3].body.map(row => row.id)).size, 6)
})
test('partial preparation keeps existing requirements visible while protecting unfinished checklist writes', () => {
  const C = client(), html = renderToStaticMarkup(React.createElement(C, { projectId: PROJECT, closeoutPackage: legacy, preparationRequired: true, items: [{ id: ACTOR, title: 'Original retained drawing', status: 'complete' }], readiness, canWrite: true }))
  assert.match(html, /Original retained drawing/)
  assert.match(html, /Prepare checklist<\/button>/)
  assert.doesNotMatch(html, /Add requirement/)
})
