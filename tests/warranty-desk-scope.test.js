require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const { createClient } = require('@supabase/supabase-js')
const { stubModule, ORG, ACTOR, PROJECT, PACKAGE, LOT, COMMUNITY } = require('./support/starts-harness')

// Exercise the actual SDK's select/filter serialization without customer access.
// SQL join semantics and RLS require dedicated full-schema QA separately.
function harness(scope, response = () => [], analytics = {}) {
  const calls = [], gates = []
  const db = createClient('https://warranty.invalid', 'local-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => {
      const parsed = new URL(url), table = parsed.pathname.split('/').pop()
      calls.push({ table, params: parsed.searchParams, options })
      const result = response(table, parsed.searchParams, options)
      if (result instanceof Response) return result
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json', 'content-range': '0-0/1' } })
    } },
  })
  stubModule('@/lib/services/warranty-actor-analytics', { warrantyActorAnalyticsEnabled: async () => analytics.enabled ?? false, readActorWarrantyAnalytics: async input => { if (analytics.read) return analytics.read(input); throw new Error('Scoped RPC unavailable') } })
  stubModule('@/lib/services/context', { requireOrgContext: async () => ({ supabase: db, orgId: ORG, userId: ACTOR }) })
  stubModule('@/lib/services/permissions', { requirePermission: async permission => gates.push(permission) })
  stubModule('@/lib/services/authorization', { getProjectReadScopeForUser: async () => scope, requireAuthorization: async () => {} })
  stubModule('@/lib/supabase/server', { createServiceSupabaseClient: () => db })
  stubModule('@/lib/services/events', { recordEvent: async () => {} })
  stubModule('@/lib/services/audit', { recordAudit: async () => {} })
  stubModule('@/lib/services/mailer', {})
  stubModule('@/lib/services/vendor-bills', {})
  delete require.cache[require.resolve('../lib/services/warranty-operations')]
  return { service: require('../lib/services/warranty-operations'), calls, gates }
}
const desks = [
  ['requests', 'warranty_requests', (h, args) => h.service.listWarrantyRequestsForOrg(args)],
  ['dispatch', 'warranty_service_visits', (h, args) => h.service.listWarrantyVisitsForDispatch({ from: '2026-10-01', to: '2026-11-01', ...args })],
  ['verification', 'warranty_requests', (h, args) => h.service.listWarrantyVisitsPendingVerification(args)],
  ['backcharges', 'warranty_backcharges', (h, args) => h.service.listWarrantyBackcharges(args)],
]
test('all warranty desk transports use inner actual-home division and active actor membership predicates', async () => {
  for (const [label, table, load] of desks) {
    const h = harness({ divisionIds: [PACKAGE, COMMUNITY], projectMembershipRequired: true })
    await load(h, { divisionId: PACKAGE })
    assert.deepEqual(h.gates, ['warranty.read'], label)
    assert.equal(h.calls.length, 1, label)
    const q = h.calls[0]; assert.equal(q.table, table, label)
    assert.equal(q.params.get('org_id'), `eq.${ORG}`, label)
    assert.equal(q.params.get('project.org_id'), `eq.${ORG}`, label)
    assert.equal(q.params.get('project.division_id'), `in.(${PACKAGE})`, label)
    assert.equal(q.params.get('project.access.org_id'), `eq.${ORG}`, label)
    assert.equal(q.params.get('project.access.user_id'), `eq.${ACTOR}`, label)
    assert.equal(q.params.get('project.access.status'), 'eq.active', label)
    assert.match(q.params.get('select'), /project:projects!inner\(/, label)
    assert.match(q.params.get('select'), /access:project_members!project_members_project_id_fkey!inner\(id\)/, label)
    assert.equal(q.params.has('project_id'), false, label)
  }
})
test('out-of-scope division lenses and empty assignments stop before querying desks', async () => {
  for (const [, , load] of desks) {
    for (const divisions of [[PACKAGE], []]) {
      const h = harness({ divisionIds: divisions, projectMembershipRequired: true })
      const result = await load(h, { divisionId: COMMUNITY })
      assert.deepEqual(result.rows, [])
      assert.equal(h.calls.length, 0)
    }
  }
})
test('org-wide desk scope omits membership joins, while explicit division and community lenses stay in SQL', async () => {
  for (const [, , load] of desks) {
    const h = harness({ divisionIds: null, projectMembershipRequired: false })
    await load(h, { divisionId: PACKAGE, communityId: COMMUNITY })
    const q = h.calls[0].params
    assert.equal(q.get('project.division_id'), `in.(${PACKAGE})`)
    assert.equal(q.has('project.access.user_id'), false)
    assert.doesNotMatch(q.get('select'), /project_members/)
    if (h.calls[0].table === 'warranty_requests' && !q.has('metadata->>pending_verification')) {
      assert.equal(q.get('project.lot.community_id'), `eq.${COMMUNITY}`)
      assert.match(q.get('select'), /lots!lots_project_id_fkey!inner/)
    }
  }
})
test('verification does not expose completed visits whose request or home disagrees with scoped request', async () => {
  for (const mismatch of ['request', 'home', 'none']) {
    const h = harness({ divisionIds: [PACKAGE], projectMembershipRequired: false }, table => table === 'warranty_requests'
      ? [{ id: PACKAGE, project_id: PROJECT, metadata: { pending_verification: true, completed_visit_id: LOT }, project: { name: 'Home' } }]
      : [{ id: LOT, org_id: ORG, project_id: mismatch === 'home' ? COMMUNITY : PROJECT, request_id: mismatch === 'request' ? COMMUNITY : PACKAGE, status: 'completed' }])
    const { rows } = await h.service.listWarrantyVisitsPendingVerification()
    assert.equal(rows.length, mismatch === 'none' ? 1 : 0)
    assert.equal(h.calls.length, 2)
  }
})

test('dispatch and verification page ranges are bounded with stable ordering and counted totals', async () => {
  for (const [label, , load] of desks.filter(([name]) => ['dispatch', 'verification'].includes(name))) {
    const h = harness({ divisionIds: null, projectMembershipRequired: false })
    const result = await load(h, { page: 3, pageSize: 50 })
    const q = h.calls[0]
    assert.equal(q.params.get('offset'), '100', label)
    assert.equal(q.params.get('limit'), '50', label)
    assert.match(q.options.headers.get('Prefer'), /count=exact/, label)
    assert.equal(q.params.get('order'), label === 'dispatch' ? 'window_start.asc,id.asc' : 'updated_at.asc,id.asc', label)
    assert.equal(result.total, 1)
  }
})
test('dispatch traverses 1251 visits using finite pages and keeps foreign request details private', async () => {
  const records = Array.from({ length: 1251 }, (_, i) => ({ id: `visit-${i}`, org_id: ORG, project_id: PROJECT, request_id: PACKAGE, window_start: '2026-10-04T00:30:00Z', window_end: '2026-10-04T01:30:00Z', request: { org_id: ORG, project_id: i === 1200 ? COMMUNITY : PROJECT, title: 'Repair' } }))
  const h = harness({ divisionIds: null, projectMembershipRequired: false }, (table, q) => records.slice(Number(q.get('offset')), Number(q.get('offset')) + Number(q.get('limit'))))
  const rows = []
  for (let page = 1; page <= 13; page++) rows.push(...(await h.service.listWarrantyVisitsForDispatch({ from: '2026-10-04', to: '2026-10-11', page })).rows)
  assert.equal(rows.length, 1251); assert.equal(new Set(rows.map(r => r.id)).size, 1251)
  assert.equal(rows[1200].request, null); assert.equal(rows[1201].request.title, 'Repair')
  assert.equal(h.calls.length, 13); assert.ok(h.calls.every(q => q.params.get('limit') === '100'))
})
test('verification preserves request priority order when the visit read comes back in a different order', async () => {
  const h = harness({ divisionIds: null, projectMembershipRequired: false }, table => table === 'warranty_requests'
    ? [{ id: PACKAGE, project_id: PROJECT, metadata: { completed_visit_id: LOT } }, { id: COMMUNITY, project_id: PROJECT, metadata: { completed_visit_id: ACTOR } }]
    : [{ id: ACTOR, request_id: COMMUNITY, project_id: PROJECT }, { id: LOT, request_id: PACKAGE, project_id: PROJECT }])
  assert.deepEqual((await h.service.listWarrantyVisitsPendingVerification()).rows.map(r => r.id), [LOT, ACTOR])
})

test('request search is a scoped root OR across request text, home and community before bounded pagination', async () => {
  const { warrantyDeskSearchPattern, quoteWarrantySearchPattern } = require('../lib/warranty/desk-query')
  const term = 'Home (A), "west"', pattern = warrantyDeskSearchPattern(term)
  const h = harness({ divisionIds: [PACKAGE], projectMembershipRequired: true })
  await h.service.listWarrantyRequestsForOrg({ search: term, slaState: 'first_response_breached', page: 2, pageSize: 50, communityId: COMMUNITY })
  const q = h.calls[0].params
  assert.match(q.get('select'), /search_home:projects\(\)/)
  assert.match(q.get('select'), /search_community:projects\(lot:lots!lots_project_id_fkey!inner\(community:communities!inner\(\)\)\)/)
  assert.equal(q.get('search_home.name'), `imatch.${pattern}`)
  assert.equal(q.get('search_community.lot.community.name'), `imatch.${pattern}`)
  assert.equal(q.get('or'), `(title.imatch.${quoteWarrantySearchPattern(pattern)},description.imatch.${quoteWarrantySearchPattern(pattern)},search_home.not.is.null,search_community.not.is.null)`)
  assert.equal(q.get('project.division_id'), `in.(${PACKAGE})`);assert.equal(q.get('project.lot.community_id'), `eq.${COMMUNITY}`)
  assert.equal(q.get('project.access.user_id'), `eq.${ACTOR}`)
  assert.equal(q.get('first_responded_at'), 'is.null');assert.ok(q.get('first_response_due_at').startsWith('lt.'))
  assert.equal(q.get('offset'), '50');assert.equal(q.get('limit'), '50')
  assert.equal(q.get('order'), 'first_response_due_at.asc.nullslast,id.asc')
})

test('every request SLA filter is applied to the database count and selected page', async () => {
  for (const sla of ['awaiting_first_response', 'first_response_breached', 'breached', 'due_soon', 'first_response_due_soon']) {
    const h = harness({ divisionIds: null, projectMembershipRequired: false })
    await h.service.listWarrantyRequestsForOrg({ slaState: sla, page: 4 })
    const q = h.calls[0].params
    assert.equal(q.get('status'), 'in.(open,in_progress)')
    assert.equal(q.get('offset'), '300');assert.equal(q.get('limit'), '100')
    if (sla.startsWith('first_response') || sla === 'awaiting_first_response') assert.equal(q.get('first_responded_at'), 'is.null')
    if (sla === 'first_response_breached') assert.ok(q.get('first_response_due_at').startsWith('lt.'))
    // A breach recorded before a severity change moved the due date out still counts.
    if (sla === 'breached') assert.match(q.get('or'), /^\(resolution_due_at\.lt\.[^,]+,metadata->>sla_breached_at\.not\.is\.null\)$/)
    if (sla.includes('due_soon')) {
      const bounds = q.getAll(sla.startsWith('first_response') ? 'first_response_due_at' : 'resolution_due_at')
      assert.equal(bounds.length, 2)
      assert.ok(bounds.some(v => v.startsWith('gte.')));assert.ok(bounds.some(v => v.startsWith('lte.')))
    }
  }
})

test('all four desks apply selected community through inner same-org lot and community joins', async () => {
  for (const [label, , load] of desks) {
    const h = harness({ divisionIds: [PACKAGE], projectMembershipRequired: true })
    await load(h, { communityId: COMMUNITY })
    const q = h.calls[0].params
    assert.match(q.get('select'), /lot:lots!lots_project_id_fkey!inner\(/, label)
    assert.match(q.get('select'), /community:communities!inner\(/, label)
    assert.equal(q.get('project.lot.community_id'), `eq.${COMMUNITY}`, label)
    assert.equal(q.get('project.lot.org_id'), `eq.${ORG}`, label)
    assert.equal(q.get('project.lot.community.org_id'), `eq.${ORG}`, label)
    assert.equal(q.get('project.org_id'), `eq.${ORG}`, label)
    assert.equal(q.get('project.division_id'), `in.(${PACKAGE})`, label)
    assert.equal(q.get('project.access.user_id'), `eq.${ACTOR}`, label)
    assert.equal(q.get('project.access.status'), 'eq.active', label)
    assert.equal(h.calls.length, 1, label)
  }
})
test('all-community desks do not exclude homes without lots or force a community catalog scan', async () => {
  for (const [label, , load] of desks) {
    const h = harness({ divisionIds: null, projectMembershipRequired: false })
    await load(h, {})
    const q = h.calls[0].params
    assert.equal(q.has('project.lot.community_id'), false, label)
    assert.doesNotMatch(q.get('select'), /lots!lots_project_id_fkey!inner/, label)
    assert.equal(h.calls.length, 1, label)
  }
})

test('visit detail authorizes minimal identity then constrains both visit revision and embedded parent home', async () => {
  const h = harness({ divisionIds: null, projectMembershipRequired: false }, table => table === 'warranty_requests'
    ? [{ id: PACKAGE, project_id: PROJECT }]
    : [{ id: LOT, org_id: ORG, project_id: PROJECT, request_id: PACKAGE, updated_at: '2026-10-03T00:00:00Z', request: { title: 'Repair' } }])
  await h.service.getWarrantyVisitDetail(LOT)
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[0].params.get('select'), 'id,project_id,request_id,updated_at')
  const q = h.calls[2].params
  assert.match(q.get('select'), /request:warranty_requests!inner\(/)
  assert.equal(q.get('request.org_id'), `eq.${ORG}`);assert.equal(q.get('request.project_id'), `eq.${PROJECT}`)
  assert.equal(q.get('project_id'), `eq.${PROJECT}`);assert.equal(q.get('request_id'), `eq.${PACKAGE}`)
  assert.equal(q.get('updated_at'), 'eq.2026-10-03T00:00:00Z')
})

test('technician cursor pages traverse clipped responses with microsecond ties and retain actor home scope', async () => {
  const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`
  const records = Array.from({length:1251},(_,i)=>({id:id(i+20),org_id:ORG,project_id:PROJECT,request_id:PACKAGE,window_start:'2026-10-03T10:00:00.123456+00:00',request:{org_id:ORG,project_id:i===0?COMMUNITY:PROJECT,title:'Repair'}}))
  const h = harness({divisionIds:[PACKAGE],projectMembershipRequired:true},(table,q)=>{
    const after=q.get('or')?.match(/id.gt.([0-9a-f-]+)/)?.[1]
    const remaining=records.filter(row=>!after||row.id>after),rows=remaining.slice(0,37)
    return new Response(JSON.stringify(rows),{headers:{'content-type':'application/json','content-range':`0-0/${remaining.length}`}})
  })
  const rows=[];let cursor
  do { const result=await h.service.listWarrantyTechVisits({date:'2026-10-03',cursor});rows.push(...result.rows);cursor=result.nextCursor } while(cursor)
  assert.equal(rows.length,1251);assert.equal(new Set(rows.map(row=>row.id)).size,1251)
  assert.equal(rows[0].request,null);assert.equal(h.calls.length,34)
  for(const q of h.calls){assert.equal(q.params.get('project.division_id'),`in.(${PACKAGE})`);assert.equal(q.params.get('project.access.user_id'),`eq.${ACTOR}`);assert.equal(q.params.get('assigned_user_id'),`eq.${ACTOR}`);assert.equal(q.params.get('limit'),'100');assert.equal(q.params.get('order'),'window_start.asc,id.asc')}
  assert.match(h.calls[1].params.get('or'),/123456/)
})
test('technician invalid inputs, foreign cursor scopes and empty division scope do not query visits', async()=>{
  const {encodeWarrantyTechCursor}=require('../lib/warranty/tech-queue')
  const h=harness({divisionIds:[PACKAGE],projectMembershipRequired:true})
  for(const input of [{date:'2026-02-30'},{date:'2026-10-03',pageSize:101},{date:'2026-10-03',cursor:'broken'},{date:'2026-10-03',cursor:encodeWarrantyTechCursor({orgId:COMMUNITY,actorId:ACTOR,userId:ACTOR,date:'2026-10-03'},{id:LOT,window_start:'2026-10-03T10:00:00Z'})}]) await assert.rejects(h.service.listWarrantyTechVisits(input))
  assert.equal(h.calls.length,0)
  const empty=harness({divisionIds:[],projectMembershipRequired:true})
  assert.deepEqual(await empty.service.listWarrantyTechVisits({date:'2026-10-03'}),{rows:[],nextCursor:null});assert.equal(empty.calls.length,0)
})
test('technician count/read failures never report a truncated page as the end of the queue',async()=>{
  for(const kind of ['count','empty','read']){
    const h=harness({divisionIds:null,projectMembershipRequired:false},()=> kind==='read'
      ?new Response(JSON.stringify({message:'Unavailable'}),{status:503})
      :new Response(JSON.stringify([]),{headers:{'content-type':'application/json',...(kind==='empty'?{'content-range':'0-0/5'}:{})}}))
    await assert.rejects(h.service.listWarrantyTechVisits({date:'2026-10-03'}),/Failed to load complete technician/)
  }
})
test('company warranty signal aggregates 1251 charges without a home catalog or partial response sum',async()=>{
  const id=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`
  const records=Array.from({length:1251},(_,i)=>({id:id(i+20),amount_cents:100,recovered_cents:20,status:i%2?'disputed':'recovered'}))
  const h=harness({divisionIds:[PACKAGE],projectMembershipRequired:true},(table,q)=>{
    const after=q.get('id')?.slice(3),rows=table==='warranty_backcharges'?records.filter(row=>!after||row.id>after).slice(0,100):[]
    return new Response(JSON.stringify(rows),{headers:{'content-type':'application/json','content-range':'0-0/1251'}})
  })
  assert.deepEqual(await h.service.getCompanyWarrantySignal(COMMUNITY),{request_count:1251,backcharge_cents:125100,recovered_cents:25020,open_backcharges:625})
  assert.equal(h.calls.length,15)
  for(const q of h.calls){assert.equal(q.params.get('project.org_id'),`eq.${ORG}`);assert.equal(q.params.get('project.division_id'),`in.(${PACKAGE})`);assert.equal(q.params.get('project.access.user_id'),`eq.${ACTOR}`);assert.equal(q.params.get('project.access.status'),'eq.active')}
})
test('company signal rejects missing counts, invalid money, aggregate overflow and late page errors',async()=>{
  for(const kind of ['count','negative','missing','recovery','overflow','late']){
    let pages=0
    const h=harness({divisionIds:null,projectMembershipRequired:false},(table)=>{
      if(table==='warranty_requests')return new Response(JSON.stringify([]),{headers:kind==='count'?{}:{'content-range':'0-0/1'}})
      pages++
      if(kind==='late'&&pages===2)return new Response(JSON.stringify({message:'Later unavailable'}),{status:503})
      if(pages>1)return new Response(JSON.stringify([]),{headers:{'content-type':'application/json','content-range':'0-0/1'}})
      const rows=kind==='late'?Array.from({length:100},(_,i)=>({id:`00000000-0000-4000-8000-${(i+20).toString(16).padStart(12,'0')}`,amount_cents:100,recovered_cents:0,status:'issued'}))
        :[{id:LOT,amount_cents:kind==='negative'?-1:kind==='missing'?null:kind==='overflow'?Number.MAX_SAFE_INTEGER:100,recovered_cents:kind==='recovery'?101:0,status:'issued'},...(kind==='overflow'?[{id:COMMUNITY,amount_cents:1,recovered_cents:0,status:'issued'}]:[])]
      return new Response(JSON.stringify(rows),{headers:{'content-type':'application/json','content-range':'0-0/1'}})
    })
    await assert.rejects(h.service.getCompanyWarrantySignal(COMMUNITY),/Count unavailable|monetary evidence|recovery exceeds|safe integer cents|Later unavailable/)
  }
})

test('restricted analytics cannot fall back to broad legacy aggregates while rollout is off',async()=>{
 for(const scope of [{divisionIds:null,projectMembershipRequired:true},{divisionIds:[PACKAGE],projectMembershipRequired:false}]){
  const h=harness(scope)
  await assert.rejects(h.service.getWarrantyCostSummary(),/broader legacy totals/)
  await assert.rejects(h.service.getWarrantyDefectAnalysis({groupBy:'community'}),/broader legacy totals/)
  assert.equal(h.calls.length,0)
 }
 const h=harness({divisionIds:null,projectMembershipRequired:false})
 await assert.rejects(h.service.getWarrantyCostSummary({communityId:COMMUNITY}),/broader legacy totals/)
 assert.equal(h.calls.length,0)
})
test('enabled cost, defect and company analytics pass trusted actor/scope without legacy fallback',async()=>{
 const inputs=[],h=harness({divisionIds:[PACKAGE],projectMembershipRequired:true},()=>[],{enabled:true,read:async input=>{inputs.push(input);return []}})
 await h.service.getWarrantyCostSummary({divisionId:PACKAGE,communityId:COMMUNITY})
 await h.service.getWarrantyDefectAnalysis({groupBy:'community',divisionId:PACKAGE,communityId:COMMUNITY})
 await h.service.getCompanyWarrantySignal(COMMUNITY)
 assert.deepEqual(inputs.map(input=>input.kind),['cost','defect','company'])
 assert.ok(inputs.every(input=>input.orgId===ORG&&input.actorId===ACTOR))
 assert.equal(inputs[0].communityId,COMMUNITY);assert.equal(inputs[1].communityId,COMMUNITY);assert.equal(inputs[2].companyId,COMMUNITY)
 assert.equal(h.calls.length,0)
 const failed=harness({divisionIds:null,projectMembershipRequired:false},()=>[],{enabled:true})
 await assert.rejects(failed.service.getWarrantyCostSummary(),/Scoped RPC unavailable/);assert.equal(failed.calls.length,0)
})

test('verification counts only requests that have a completed visit to show, so total and rows are the same unit', async () => {
  const h = harness({ divisionIds: null, projectMembershipRequired: false })
  await h.service.listWarrantyVisitsPendingVerification()
  const q = h.calls[0].params
  assert.equal(q.get('metadata->>pending_verification'), 'eq.true')
  assert.equal(q.get('metadata->>completed_visit_id'), 'not.is.null')
})
