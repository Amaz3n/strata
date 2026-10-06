require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const { createClient } = require('@supabase/supabase-js')
const { stubModule, ORG, ACTOR, PROJECT, COMMUNITY, PACKAGE } = require('./support/starts-harness')
const z = require('zod').z

// Actual owners + SDK transport; no live organization. Join/RLS semantics require
// the full-schema and authenticated QA gates and are not claimed by this suite.
function declarations(file, names, bindings) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const selected = source.statements.filter(node => ts.isFunctionDeclaration(node) ? names.includes(node.name?.text) : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.includes(d.name.getText(source))))
  assert.equal(selected.length, names.length, 'Every tested owner declaration must exist')
  const code = ts.transpileModule(selected.map(n => n.getText(source)).join('\n') + `\nexport { ${names.join(',')} };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}
  new Function('exports', 'require', ...Object.keys(bindings), code)(exports, require, ...Object.values(bindings))
  return exports
}
function harness({ scope = { divisionIds: null, projectMembershipRequired: false }, denied = false, failure = false, rows = [] } = {}) {
  const calls = [], gates = []
  const supabase = createClient('https://purchasing.invalid', 'local-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => {
      const parsed = new URL(url)
      calls.push({ table: parsed.pathname.split('/').pop(), params: parsed.searchParams, options })
      if (failure) return new Response(JSON.stringify({ message: 'Queue unavailable' }), { status: 500 })
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json', 'content-range': '100-149/1203' } })
    } },
  })
  const context = { supabase, orgId: ORG, userId: ACTOR }
  stubModule('@/lib/services/authorization', { getProjectReadScopeForUser: async () => scope })
  delete require.cache[require.resolve('../lib/services/purchasing-queue-scope')]
  const helpers = require('../lib/services/purchasing-queue-scope')
  const bindings = { ...helpers, z, requireOrgContext: async () => context, requireAuthorization: async input => { gates.push(input); if (denied) throw new Error('Forbidden') }, hydrate: async data => data }
  const exceptions = declarations('lib/services/po-generation.ts', ['poExceptionStatusSchema', 'poExceptionListSchema', 'authorizeGeneration', 'listPoExceptions'], bindings).listPoExceptions
  const completions = declarations('lib/services/po-completions.ts', ['listPoCompletions'], bindings).listPoCompletions
  const variance = declarations('lib/services/commitment-change-orders.ts', ['listVarianceOrders'], bindings).listVarianceOrders
  return { queues: { exceptions, completions, variance }, calls, gates }
}

for (const queue of ['exceptions', 'completions', 'variance']) {
  test(`${queue}: actual home lens, active membership and tenant filters precede exact page/count`, async () => {
    const h = harness({ scope: { divisionIds: [PACKAGE, COMMUNITY], projectMembershipRequired: true }, rows: [{ id: PROJECT }] })
    const result = await h.queues[queue]({ communityId: COMMUNITY, divisionId: PACKAGE, projectId: PROJECT, page: 3, pageSize: 50 })
    assert.equal(h.calls.length, 1, 'No organization home/lot roster may be enumerated')
    const q = h.calls[0].params
    assert.equal(q.get('org_id'), `eq.${ORG}`)
    assert.equal(q.get('project.org_id'), `eq.${ORG}`)
    assert.equal(q.get('project.division_id'), `in.(${PACKAGE})`)
    assert.equal(q.get('project.lot.community_id'), `eq.${COMMUNITY}`)
    assert.equal(q.get('project.lot.org_id'), `eq.${ORG}`)
    assert.equal(q.get('project.lot.community.org_id'), `eq.${ORG}`)
    assert.equal(q.get('project.access.org_id'), `eq.${ORG}`)
    assert.equal(q.get('project.access.user_id'), `eq.${ACTOR}`)
    assert.equal(q.get('project.access.status'), 'eq.active')
    assert.equal(q.get('project_id'), `eq.${PROJECT}`)
    assert.match(q.get('select'), /project:projects!inner\(/)
    assert.match(q.get('select'), /lot:lots!lots_project_id_fkey!inner\(/)
    assert.match(q.get('select'), /access:project_members!project_members_project_id_fkey!inner\(/)
    assert.equal(q.get('offset'), '100'); assert.equal(q.get('limit'), '50')
    assert.ok(h.calls[0].options.headers.get('prefer').includes('count=exact'))
    assert.equal(result.count, 1203); assert.deepEqual(result.items, [{ id: PROJECT }])
    assert.equal(h.gates[0].permission, 'price_book.read')
  })
  test(`${queue}: selected division cannot widen authority and an empty assignment reads nothing`, async () => {
    for (const divisionIds of [[PACKAGE], []]) {
      const h = harness({ scope: { divisionIds, projectMembershipRequired: false } })
      const result = await h.queues[queue]({ divisionId: COMMUNITY, page: 3 })
      assert.equal(result.count, 0); assert.equal(result.page, 3); assert.equal(h.calls.length, 0)
    }
  })
  test(`${queue}: all-communities view retains assigned divisions and active-home restriction`, async () => {
    const h = harness({ scope: { divisionIds: [PACKAGE, COMMUNITY], projectMembershipRequired: true } })
    await h.queues[queue]()
    const q = h.calls[0].params
    assert.equal(q.get('project.division_id'), `in.(${PACKAGE},${COMMUNITY})`)
    assert.equal(q.get('project.access.user_id'), `eq.${ACTOR}`)
    assert.equal(q.has('project.lot.community_id'), false)
    assert.equal(q.has('project_id'), false)
    assert.equal(q.get('limit'), '50')
  })
  test(`${queue}: unrestricted mixed-organization view adds no posture or membership gate`, async () => {
    const h = harness()
    await h.queues[queue]()
    const q = h.calls[0].params
    assert.equal(q.has('project.division_id'), false)
    assert.equal(q.has('project.access.user_id'), false)
    assert.equal(q.has('property_type'), false)
    assert.equal(q.has('product_tier'), false)
    assert.equal(q.get('project.org_id'), `eq.${ORG}`)
  })
  test(`${queue}: malformed lens, home, status and page fail before reads`, async () => {
    for (const input of [{ communityId: 'bad' }, { divisionId: 'bad' }, { projectId: 'bad' }, { status: 'bad' }, { page: 0 }, { page: 1.5 }, { pageSize: 101 }, { page: 100001 }]) {
      const h = harness()
      await assert.rejects(h.queues[queue](input))
      assert.equal(h.calls.length, 0); assert.equal(h.gates.length, 0)
    }
  })
  test(`${queue}: denied permission and database failure remain errors`, async () => {
    const denied = harness({ denied: true })
    await assert.rejects(denied.queues[queue](), /Forbidden/)
    assert.equal(denied.calls.length, 0)
    const failed = harness({ failure: true })
    await assert.rejects(failed.queues[queue](), /Queue unavailable/)
  })
}
test('original queue-specific filters and stable sort survive scope narrowing', async () => {
  const h = harness()
  await h.queues.exceptions({ status: 'dismissed' })
  await h.queues.completions({ status: 'reported' })
  await h.queues.variance({ status: 'pending', origin: 'field_mobile', reasonCodeId: PACKAGE })
  assert.equal(h.calls[0].params.get('status'), 'eq.dismissed')
  assert.equal(h.calls[0].params.get('order'), 'created_at.asc,id.asc')
  assert.equal(h.calls[1].params.get('status'), 'eq.reported')
  assert.equal(h.calls[1].params.get('order'), 'reported_at.desc,id.desc')
  assert.equal(h.calls[2].params.get('status'), 'in.(draft,sent)')
  assert.deepEqual(h.calls[2].params.getAll('reason_code_id'), ['not.is.null', `eq.${PACKAGE}`])
  assert.equal(h.calls[2].params.get('origin'), 'eq.field_mobile')
  assert.equal(h.calls[2].params.get('order'), 'created_at.desc,id.desc')
})
test('actual Purchasing page forwards the same ambient lens and preserves home/page links on all three queues', async () => {
  const keys = []
  for (const [tab, owner] of [['exceptions', 'listPoExceptions'], ['vpos', 'listVarianceOrders'], ['completions', 'listPoCompletions']]) {
    for (const communityId of [COMMUNITY, PROJECT]) {
      let input
      const forbidden = async () => { throw new Error('Unrelated tab requested') }
      const bindings = Object.fromEntries(['listPoExceptions', 'listVarianceOrders', 'listPoCompletions', 'listPriceAgreements', 'getPriceBookHealth', 'listProductionBidQueue', 'getVarianceAnalysis', 'listCompanies', 'listCostCodes', 'listCommunities', 'listHousePlans'].map(name => [name, forbidden]))
      Object.assign(bindings, { [owner]: async args => { input = args; return { items: [], count: 1203 } }, getAmbientDeskContext: async () => ({ communityId, divisionId: PACKAGE }), connection: async () => {}, PageLayout: 'main', PurchasingClient: 'section', QueuePagination: 'nav' })
      const { PurchasingPageContent } = declarations('app/(app)/purchasing/page.tsx', ['PurchasingPageContent', 'relationName'], bindings)
      const element = await PurchasingPageContent({ searchParams: Promise.resolve({ tab, project: PROJECT, page: '3' }) })
      assert.equal(input.communityId, communityId); assert.equal(input.divisionId, PACKAGE); assert.equal(input.projectId, PROJECT)
      assert.equal(input.page, 3); assert.equal(input.pageSize, 50)
      const client = element.props.children.find(child => child?.type === 'section')
      keys.push(client.key)
      const pagination = element.props.children.find(child => child?.type === 'nav')
      assert.equal(pagination.props.total, 1203)
      assert.equal(pagination.props.page, 3)
      assert.match(pagination.props.href, new RegExp(`project=${PROJECT}`))
      assert.match(pagination.props.href, new RegExp(`tab=${tab}`))
    }
  }
  assert.equal(new Set(keys).size, 6, 'Changed scope remounts local queue state')
})
