require('../scripts/register-ts-node-test')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeSupabase } = require('./support/fake-supabase')
const { stubModule, ORG, ACTOR, PROJECT, PACKAGE, LOT, COMMUNITY, VERSION } = require('./support/starts-harness')

function harness() {
  const db = createFakeSupabase({
    projects: [{ id: PROJECT, org_id: ORG }],
    warranty_requests: [{ id: PACKAGE, org_id: ORG, project_id: PROJECT, title: 'Leak', status: 'open', created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z', metadata: {} }],
    warranty_service_visits: [{ id: LOT, org_id: ORG, project_id: PROJECT, request_id: PACKAGE, updated_at: '2026-10-03T00:00:00Z', visit_number: 1, status: 'scheduled', assignee_kind: 'tech', assigned_user_id: ACTOR, window_start: '2026-10-04T10:00:00Z', window_end: '2026-10-04T11:00:00Z', metadata: {} }],
    warranty_backcharges: [{ id: COMMUNITY, org_id: ORG, project_id: PROJECT, warranty_request_id: PACKAGE, company_id: VERSION, status: 'issued', amount_cents: 100, recovered_cents: 0, backcharge_number: 1, cost_basis: [{ label: 'Repair', amount_cents: 100 }], metadata: {} }],
    companies: [{ id: VERSION, org_id: ORG }],
  })
  const calls = { auth: [], events: [], audit: [], money: [], writes: [] }
  let denyPermission, failRead
  const from = db.from.bind(db)
  db.from = table => {
    const q = from(table), run = q.run.bind(q)
    const not = q.not.bind(q)
    // Preserve PostgREST's quoted IN-list behavior; the shared fake does not
    // remove quotes from its string-list parser.
    q.not = (column, operator, value) => not(column, operator,
      column === 'status' && operator === 'in' && value === '("canceled","completed")' ? ['canceled', 'completed'] : value)
    q.run = () => {
      if (table === failRead && (!q.action || q.action === 'select')) return { data: null, error: { message: 'Read unavailable' } }
      if (['insert', 'update', 'upsert', 'delete'].includes(q.action)) calls.writes.push(table)
      const result = run()
      // The shared fake models update filters but not single-row UPDATE returns.
      // Match PostgREST cardinality here so DTOs and missing-row failures are real.
      if (q.action === 'update' && q.returning && q.cardinality && !result.error) {
        const rows = result.data ?? []
        if (rows.length > 1 || (q.cardinality === 'single' && rows.length !== 1)) return { data: null, error: { message: 'Expected one updated row' } }
        return { ...result, data: rows[0] ?? null }
      }
      return result
    }
    return q
  }
  stubModule('@/lib/services/context', { requireOrgContext: async () => ({ supabase: db, orgId: ORG, userId: ACTOR }) })
  stubModule('@/lib/services/permissions', { requirePermission: async () => {} })
  stubModule('@/lib/services/authorization', { authorizeMany: async ({ projectIds, permission }) => new Map(projectIds.map(id => [id, permission !== denyPermission])), requireAuthorization: async input => { calls.auth.push(input); if (input.permission === denyPermission) throw new Error('Home access denied') } })
  stubModule('@/lib/supabase/server', { createServiceSupabaseClient: () => db })
  stubModule('@/lib/services/audit', { recordAudit: async input => calls.audit.push(input) })
  stubModule('@/lib/services/events', { recordEvent: async input => calls.events.push(input) })
  stubModule('@/lib/services/mailer', {})
  stubModule('@/lib/services/vendor-bills', {
    createProjectVendorCredit: async input => { calls.money.push(input); return { id: VERSION } },
    createProjectVendorBill: async input => { calls.money.push(input); return { id: VERSION } },
  })
  delete require.cache[require.resolve('../lib/services/warranty-operations')]
  return { db, calls, service: require('../lib/services/warranty-operations'), deny: p => { denyPermission = p }, failRead: t => { failRead = t } }
}
const window = { window_start: '2026-10-05T10:00:00Z', window_end: '2026-10-05T11:00:00Z' }
const charge = { project_id: PROJECT, warranty_request_id: PACKAGE, company_id: VERSION, amount_cents: 100, reason: 'Repair', cost_basis: [{ label: 'Repair', amount_cents: 100 }] }
const officeActions = [
  ['create request', 'warranty.write', h => h.service.createWarrantyRequest({ input: { project_id: PROJECT, title: 'Leak' } })],
  ['update request', 'warranty.write', h => h.service.updateWarrantyRequest({ requestId: PACKAGE, input: { title: 'Revised' } })],
  ['acknowledge request', 'warranty.write', h => h.service.acknowledgeWarrantyRequest({ request_id: PACKAGE, channel: 'phone' })],
  ['schedule visit', 'warranty.write', h => h.service.scheduleWarrantyVisit({ request_id: PACKAGE, assignee_kind: 'tech', assigned_user_id: ACTOR, ...window })],
  ['reschedule visit', 'warranty.write', h => h.service.rescheduleWarrantyVisit({ visit_id: LOT, ...window })],
  ['cancel visit', 'warranty.write', h => h.service.cancelWarrantyVisit(LOT)],
  ['complete visit', 'warranty.write', h => h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' })],
  ['verify visit', 'warranty.write', h => h.service.verifyWarrantyVisit(LOT)],
  ['create backcharge', 'warranty.backcharge', h => h.service.createWarrantyBackcharge(charge)],
  ['issue backcharge', 'warranty.backcharge', h => h.service.issueWarrantyBackcharge({ backchargeId: COMMUNITY })],
  ['dispute backcharge', 'warranty.backcharge', h => h.service.disputeWarrantyBackcharge({ backchargeId: COMMUNITY, note: 'Disputed' })],
  ['resolve backcharge', 'warranty.backcharge', h => h.service.resolveWarrantyBackcharge({ backchargeId: COMMUNITY, resolution: 'recovered' })],
]

test('every office lifecycle mutation authorizes the actual home before writes or side effects', async () => {
  for (const [label, permission, action] of officeActions) {
    const h = harness(), before = JSON.stringify(h.db.store)
    h.deny(permission)
    await assert.rejects(action(h), /Home access denied/, label)
    assert.equal(h.calls.auth[0].projectId, PROJECT, label)
    assert.equal(h.calls.auth[0].orgId, ORG, label)
    assert.equal(h.calls.auth[0].userId, ACTOR, label)
    assert.equal(h.calls.auth[0].permission, permission, label)
    assert.deepEqual(h.calls.writes, [], label)
    assert.deepEqual(h.calls.money, [], label)
    assert.deepEqual(h.calls.events, [], label)
    assert.equal(JSON.stringify(h.db.store), before, label)
  }
})
test('an already acknowledged request still requires home permission before replay', async () => {
  const h = harness(); h.db.store.warranty_requests[0].first_responded_at = '2026-10-03T10:00:00Z'; h.deny('warranty.write')
  await assert.rejects(h.service.acknowledgeWarrantyRequest({ request_id: PACKAGE, channel: 'phone' }), /Home access denied/)
})
test('visit and backcharge home/request ancestry mismatch and failed reads prevent writes', async () => {
  for (const failure of ['foreign-home', 'missing', 'read-error']) {
    for (const [, , action] of officeActions.filter(([name]) => ['reschedule visit', 'cancel visit', 'complete visit', 'verify visit', 'issue backcharge', 'dispute backcharge', 'resolve backcharge'].includes(name))) {
      const h = harness()
      if (failure === 'foreign-home') h.db.store.warranty_requests[0].project_id = VERSION
      if (failure === 'missing') h.db.store.warranty_requests = []
      if (failure === 'read-error') h.failRead('warranty_requests')
      await assert.rejects(action(h), /another home|unavailable/i)
      assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.money, [])
    }
  }
})
test('vendor credit and reversal require home-level bill.write before monetary side effects', async () => {
  for (const [status, action] of [['draft', h => h.service.issueWarrantyBackcharge({ backchargeId: COMMUNITY })], ['issued', h => h.service.resolveWarrantyBackcharge({ backchargeId: COMMUNITY, resolution: 'waived', note: 'Waived' })]]) {
    const h = harness(); h.deny('bill.write')
    h.db.store.warranty_backcharges[0].status = status
    h.db.store.warranty_backcharges[0].metadata.no_ap_history_confirmed = true
    h.db.store.warranty_backcharges[0].vendor_credit_bill_id = VERSION
    await assert.rejects(action(h), /Home access denied/)
    assert.equal(h.calls.auth.at(-1).permission, 'bill.write')
    assert.deepEqual(h.calls.money, []); assert.deepEqual(h.calls.writes, [])
  }
})
test('backcharge commitment must belong to the same home and trade, and reference errors fail closed', async () => {
  for (const failure of ['wrong-trade', 'read-error']) {
    const h = harness()
    h.db.store.commitments = [{ id: ACTOR, org_id: ORG, project_id: PROJECT, company_id: failure === 'wrong-trade' ? LOT : VERSION }]
    if (failure === 'read-error') h.failRead('commitments')
    await assert.rejects(h.service.createWarrantyBackcharge({ ...charge, commitment_id: ACTOR }), /commitment|references/i)
    assert.deepEqual(h.calls.writes, [])
  }
})
test('request and visit evidence rejects foreign, archived, missing or unreadable home files before mutation', async () => {
  for (const failure of ['foreign-home', 'archived', 'missing', 'read-error']) {
    for (const action of [h => h.service.createWarrantyRequest({ input: { project_id: PROJECT, title: 'Leak', photo_file_ids: [VERSION] } }), h => h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved', photo_file_ids: [VERSION] }), h => h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved', buyer_signature_file_id: VERSION })]) {
      const h = harness()
      h.db.store.files = failure === 'missing' ? [] : [{ id: VERSION, org_id: ORG, project_id: failure === 'foreign-home' ? PACKAGE : PROJECT, archived_at: failure === 'archived' ? '2026-10-03' : null }]
      if (failure === 'read-error') h.failRead('files')
      await assert.rejects(action(h), /evidence files/i)
      assert.deepEqual(h.calls.writes, [])
    }
  }
})
test('authorized request, first response, visit and backcharge writes retain actual home and audit', async () => {
  const h = harness()
  await h.service.updateWarrantyRequest({ requestId: PACKAGE, input: { title: 'Authorized repair' } })
  await h.service.acknowledgeWarrantyRequest({ request_id: PACKAGE, channel: 'phone' })
  await h.service.rescheduleWarrantyVisit({ visit_id: LOT, ...window })
  await h.service.cancelWarrantyVisit(LOT)
  await h.service.disputeWarrantyBackcharge({ backchargeId: COMMUNITY, note: 'Disputed repair' })
  assert.equal(h.db.store.warranty_requests[0].title, 'Authorized repair')
  assert.ok(h.db.store.warranty_requests[0].first_responded_at)
  assert.equal(h.db.store.warranty_service_visits[0].status, 'canceled')
  assert.equal(h.db.store.warranty_backcharges[0].status, 'disputed')
  assert.equal(h.calls.audit.length, 5)
  assert.ok(h.calls.auth.every(input => input.projectId === PROJECT))
})
test('authorized visit completion links evidence once, records cost and resolves its own request', async () => {
  const h = harness()
  h.db.store.files = [{ id: VERSION, org_id: ORG, project_id: PROJECT, archived_at: null }]
  const completed = await h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved', photo_file_ids: [VERSION, VERSION], buyer_signature_file_id: VERSION, labor_hours: 2, labor_rate_cents: 1000, material_cents: 250 })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.internal_labor_cents, 2000)
  assert.equal(h.db.store.warranty_requests[0].status, 'resolved')
  assert.equal(h.db.store.warranty_visit_photos.length, 1)
  assert.equal(h.calls.events[0].eventType, 'warranty_visit_completed')
  assert.equal(h.calls.audit[0].actorId, ACTOR)
})
test('trade portal completion also refuses inconsistent ancestry and foreign evidence', async () => {
  for (const failure of ['ancestry', 'file']) {
    const h = harness()
    Object.assign(h.db.store.warranty_service_visits[0], { assignee_kind: 'trade', assigned_company_id: VERSION })
    if (failure === 'ancestry') h.db.store.warranty_requests[0].project_id = VERSION
    else h.db.store.files = [{ id: ACTOR, org_id: ORG, project_id: VERSION, archived_at: null }]
    await assert.rejects(h.service.completeWarrantyVisitFromPortal({ orgId: ORG, companyId: VERSION, visitId: LOT, outcome: 'resolved', outcomeNote: 'Repaired', photoFileIds: failure === 'file' ? [ACTOR] : [] }), /home|evidence/i)
    assert.deepEqual(h.calls.writes, [])
  }
})
test('a failed request status write after completing a visit surfaces partial completion', async () => {
  const h = harness(), from = h.db.from.bind(h.db)
  h.db.from = table => {
    const q = from(table), run = q.run.bind(q)
    q.run = () => table === 'warranty_requests' && q.action === 'update' ? { data: null, error: { message: 'Request write unavailable' } } : run()
    return q
  }
  await assert.rejects(h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }), /visit was completed but request status could not be saved/i)
  assert.equal(h.db.store.warranty_service_visits[0].status, 'completed')
  assert.equal(h.db.store.warranty_requests[0].status, 'open')
  assert.deepEqual(h.calls.events, [])
})
function beforeUpdate(h, tableName, mutate) {
  const from = h.db.from.bind(h.db)
  let fired = false
  h.db.from = table => {
    const q = from(table), run = q.run.bind(q)
    q.run = () => {
      if (!fired && table === tableName && q.action === 'update') { fired = true; mutate() }
      return run()
    }
    return q
  }
}
test('stale visit updates cannot replace terminal state or a newer same-status schedule', async () => {
  for (const action of [h => h.service.rescheduleWarrantyVisit({ visit_id: LOT, ...window }), h => h.service.cancelWarrantyVisit(LOT), h => h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' })]) {
    for (const status of ['scheduled', 'completed']) {
      const h = harness()
      beforeUpdate(h, 'warranty_service_visits', () => Object.assign(h.db.store.warranty_service_visits[0], { status, updated_at: '2026-10-03T00:00:01Z', window_start: '2026-10-06T10:00:00Z', metadata: { winningCoordinator: true } }))
      await assert.rejects(action(h), /changed concurrently/)
      assert.equal(h.db.store.warranty_service_visits[0].status, status)
      assert.equal(h.db.store.warranty_service_visits[0].window_start, '2026-10-06T10:00:00Z')
      assert.deepEqual(h.db.store.warranty_service_visits[0].metadata, { winningCoordinator: true })
      assert.deepEqual(h.calls.events, []); assert.deepEqual(h.calls.audit, [])
      assert.equal(h.db.store.warranty_requests[0].status, 'open')
    }
  }
})
test('request edits and acknowledgements preserve a concurrent coordinator revision', async () => {
  for (const action of [h => h.service.updateWarrantyRequest({ requestId: PACKAGE, input: { title: 'Losing edit' } }), h => h.service.acknowledgeWarrantyRequest({ request_id: PACKAGE, channel: 'phone' })]) {
    const h = harness()
    beforeUpdate(h, 'warranty_requests', () => Object.assign(h.db.store.warranty_requests[0], { title: 'Winning edit', updated_at: '2026-10-03T00:00:01Z', metadata: { anotherCoordinator: true } }))
    await assert.rejects(action(h), /concurrently|update warranty request/)
    assert.equal(h.db.store.warranty_requests[0].title, 'Winning edit')
    assert.deepEqual(h.db.store.warranty_requests[0].metadata, { anotherCoordinator: true })
    assert.deepEqual(h.calls.events, []); assert.deepEqual(h.calls.audit, [])
  }
})
test('visit completion refuses already resolved requests and preserves a later request revision', async () => {
  const resolved = harness(); resolved.db.store.warranty_requests[0].status = 'resolved'
  await assert.rejects(resolved.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }), /reopen the request/)
  assert.deepEqual(resolved.calls.writes, [])
  const h = harness()
  beforeUpdate(h, 'warranty_requests', () => Object.assign(h.db.store.warranty_requests[0], { status: 'in_progress', updated_at: '2026-10-03T00:00:01Z', metadata: { completed_visit_id: VERSION, pending_verification: true } }))
  await assert.rejects(h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }), /visit was completed but request status could not be saved/)
  assert.equal(h.db.store.warranty_service_visits[0].status, 'completed')
  assert.equal(h.db.store.warranty_requests[0].status, 'in_progress')
  assert.equal(h.db.store.warranty_requests[0].metadata.completed_visit_id, VERSION)
})
test('verification only accepts the current pending visit and cannot overwrite a later completion', async () => {
  for (const failure of ['older-visit', 'already-verified', 'closed-request', 'race', 'none']) {
    const h = harness()
    Object.assign(h.db.store.warranty_service_visits[0], { status: 'completed', outcome: 'resolved' })
    Object.assign(h.db.store.warranty_requests[0], { status: 'in_progress', metadata: { completed_visit_id: LOT, pending_verification: true } })
    if (failure === 'older-visit') h.db.store.warranty_requests[0].metadata.completed_visit_id = VERSION
    if (failure === 'already-verified') h.db.store.warranty_requests[0].metadata.pending_verification = false
    if (failure === 'closed-request') h.db.store.warranty_requests[0].status = 'closed'
    if (failure === 'race') beforeUpdate(h, 'warranty_requests', () => Object.assign(h.db.store.warranty_requests[0], { updated_at: '2026-10-03T00:00:01Z', metadata: { completed_visit_id: VERSION, pending_verification: true } }))
    if (failure === 'none') {
      await h.service.verifyWarrantyVisit(LOT, 'Verified repair')
      assert.equal(h.db.store.warranty_requests[0].status, 'resolved')
      assert.equal(h.db.store.warranty_requests[0].metadata.verified_visit_id, LOT)
      assert.equal(h.calls.events[0].eventType, 'warranty_visit_verified')
    } else {
      await assert.rejects(h.service.verifyWarrantyVisit(LOT), /awaiting verification|Failed to verify/)
      assert.deepEqual(h.calls.events, []); assert.deepEqual(h.calls.audit, [])
      if (failure === 'race') assert.equal(h.db.store.warranty_requests[0].metadata.completed_visit_id, VERSION)
    }
  }
})
test('missing visit/request revisions fail closed and portal confirmation detects reassignment', async () => {
  const missing = harness(); delete missing.db.store.warranty_service_visits[0].updated_at
  await assert.rejects(missing.service.cancelWarrantyVisit(LOT), /revision is unavailable/)
  assert.deepEqual(missing.calls.writes, [])
  const request = harness(); delete request.db.store.warranty_requests[0].updated_at
  await assert.rejects(request.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }), /revision is unavailable/)
  assert.deepEqual(request.calls.writes, [])
  const h = harness()
  Object.assign(h.db.store.warranty_service_visits[0], { assignee_kind: 'trade', assigned_company_id: VERSION })
  beforeUpdate(h, 'warranty_service_visits', () => Object.assign(h.db.store.warranty_service_visits[0], { assigned_company_id: ACTOR, updated_at: '2026-10-03T00:00:01Z' }))
  await assert.rejects(h.service.confirmWarrantyVisitFromPortal({ orgId: ORG, companyId: VERSION, visitId: LOT }), /changed concurrently/)
  assert.equal(h.db.store.warranty_service_visits[0].assigned_company_id, ACTOR)
  assert.equal(h.db.store.warranty_service_visits[0].status, 'scheduled')
  assert.deepEqual(h.calls.events, [])
})
function enableCompletionTransactions(h) {
  h.db.store.feature_flags = [{ org_id: ORG, flag_key: 'warranty_completion_transactions', enabled: true, expires_at: null, updated_at: '2026-10-03T00:00:00Z' }]
}
test('gated office completion uses SQL event ownership and retries unknown response through the original receipt', async () => {
  const h = harness(); enableCompletionTransactions(h)
  const rpcCalls = []; let committed = false, loseResponse = true, sqlEvents = 0
  h.db.rpc = async (name, args) => {
    assert.equal(name, 'complete_warranty_visit_atomic'); rpcCalls.push(args)
    assert.equal(args.p_org_id, ORG); assert.equal(args.p_actor_id, ACTOR); assert.equal(args.p_visit_id, LOT)
    if (!committed) {
      committed = true; sqlEvents++
      Object.assign(h.db.store.warranty_service_visits[0], { status: 'completed', updated_at: '2026-10-03T00:00:01Z' })
      Object.assign(h.db.store.warranty_requests[0], { status: 'resolved', updated_at: '2026-10-03T00:00:01Z' })
    }
    if (loseResponse) { loseResponse = false; return { data: null, error: { message: 'Connection lost after commit' } } }
    return { data: { status: 'existing', receipt_id: VERSION, visit_id: LOT, request_id: PACKAGE, actor_id: ACTOR }, error: null }
  }
  const completion = { visit_id: LOT, outcome: 'resolved', photo_file_ids: [VERSION, VERSION] }
  await assert.rejects(h.service.completeWarrantyVisit(completion), /Retry with the same completion details/)
  const result = await h.service.completeWarrantyVisit(completion)
  assert.equal(result.status, 'completed'); assert.equal(rpcCalls.length, 2); assert.equal(sqlEvents, 1)
  assert.deepEqual(rpcCalls[0].p_input.photo_file_ids, [VERSION])
  assert.equal(rpcCalls[0].p_expected_visit_at, '2026-10-03T00:00:00Z')
  assert.equal(rpcCalls[1].p_expected_visit_at, '2026-10-03T00:00:01Z')
  assert.deepEqual(h.calls.events, []); assert.deepEqual(h.calls.audit, []); assert.deepEqual(h.calls.writes, [])
})
test('missing transaction RPC never falls back to legacy writes and home denial precedes RPC', async () => {
  for (const denied of [false, true]) {
    const h = harness(); enableCompletionTransactions(h); let rpcCalls = 0
    if (denied) h.deny('warranty.write')
    h.db.rpc = async () => { rpcCalls++; return { data: null, error: { code: 'PGRST202', message: 'RPC unavailable' } } }
    await assert.rejects(h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }), denied ? /Home access denied/ : /RPC unavailable/)
    assert.equal(rpcCalls, denied ? 0 : 1); assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.events, [])
  }
})
test('completion rollout rejects expiring/malformed controls, read errors and disabled receipt rollback', async () => {
  for (const kind of ['expiring', 'malformed', 'flag-read', 'history-read', 'rollback']) {
    const h = harness(); enableCompletionTransactions(h)
    if (kind === 'expiring') h.db.store.feature_flags[0].expires_at = '2030-01-01T00:00:00Z'
    if (kind === 'malformed') h.db.store.feature_flags[0].enabled = 'yes'
    if (kind === 'flag-read') h.failRead('feature_flags')
    if (kind === 'history-read' || kind === 'rollback') h.db.store.feature_flags[0].enabled = false
    if (kind === 'history-read') h.failRead('warranty_visit_completion_receipts')
    if (kind === 'rollback') h.db.store.warranty_visit_completion_receipts = [{ id: VERSION, org_id: ORG }]
    h.db.rpc = async () => { throw new Error('Should not call RPC') }
    await assert.rejects(h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }))
    assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.events, [])
  }
})
test('transaction response scope and malformed receipts cannot report another request as completed', async () => {
  for (const data of [null, { status: 'created', receipt_id: VERSION, visit_id: LOT, request_id: VERSION, actor_id: ACTOR }, { status: 'created', receipt_id: 'invalid', visit_id: LOT, request_id: PACKAGE, actor_id: ACTOR }]) {
    const h = harness(); enableCompletionTransactions(h); h.db.rpc = async () => ({ data, error: null })
    await assert.rejects(h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }))
    assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.events, [])
  }
})
test('transaction rollout stays default off and legacy completion tolerates only absent receipt schema', async () => {
  const { FEATURE_FLAGS, FEATURE_FLAG_DEFINITIONS } = require('../lib/feature-flags/registry')
  assert.equal(FEATURE_FLAG_DEFINITIONS[FEATURE_FLAGS.warrantyCompletionTransactions].defaultEnabled, false)
  for (const code of ['42P01', 'PGRST205', '42501']) {
    const h = harness(), from = h.db.from.bind(h.db)
    h.db.from = table => { const q = from(table); if (table === 'warranty_visit_completion_receipts') q.run = () => ({ data: null, error: { code, message: 'Receipt schema unavailable' } }); return q }
    if (code === '42501') await assert.rejects(h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }), /history/)
    else assert.equal((await h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' })).status, 'completed')
  }
})
function availabilityRows(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, '0')}`, org_id: ORG, project_id: PROJECT, request_id: PACKAGE, visit_number: index + 1, status: 'scheduled', assignee_kind: 'tech', assigned_user_id: ACTOR, ...window, updated_at: '2026-10-03T00:00:00Z', metadata: {} }))
}
const availabilityInput = { assignee_kind: 'tech', assigned_user_id: ACTOR, ...window }
test('availability reads all 1251 overlaps in bounded stable pages and isolates org/assignee/status', async () => {
  const h = harness(), calls = [], from = h.db.from.bind(h.db)
  h.db.store.warranty_service_visits = availabilityRows(1251)
  h.db.store.warranty_service_visits.push(...[
    { ...availabilityRows(1)[0], id: VERSION, org_id: VERSION },
    { ...availabilityRows(1)[0], id: LOT, assigned_user_id: VERSION },
    { ...availabilityRows(1)[0], id: ACTOR, status: 'completed' },
    { ...availabilityRows(1)[0], id: PACKAGE, status: 'canceled' },
  ])
  h.db.from = table => { const q = from(table), run = q.run.bind(q); q.run = () => { if (table === 'warranty_service_visits') calls.push({ limit: q.limitValue, order: q.orderings }); return run() }; return q }
  const conflicts = await h.service.findWarrantyVisitConflicts(availabilityInput)
  assert.equal(conflicts.length, 1251)
  assert.equal(calls.length, 13)
  assert.ok(calls.every(q => q.limit === 100 && q.order[0].column === 'id'))
  assert.equal(new Set(conflicts.map(row => row.visit_id)).size, 1251)
})
test('ongoing visits that started days earlier conflict while adjoining boundaries do not', async () => {
  const h = harness()
  h.db.store.warranty_service_visits = [
    { ...availabilityRows(1)[0], id: LOT, window_start: '2026-10-01T10:00:00Z', window_end: '2026-10-07T11:00:00Z' },
    { ...availabilityRows(1)[0], id: VERSION, window_start: '2026-10-05T09:00:00Z', window_end: window.window_start },
    { ...availabilityRows(1)[0], id: PACKAGE, window_start: window.window_end, window_end: '2026-10-05T12:00:00Z' },
  ]
  assert.deepEqual((await h.service.findWarrantyVisitConflicts(availabilityInput)).map(row => row.visit_id), [LOT])
  assert.deepEqual(await h.service.findWarrantyVisitConflicts({ ...availabilityInput, exclude_visit_id: LOT }), [])
})
test('scheduling and rescheduling refuse overlapping availability before writes', async () => {
  for (const action of [h => h.service.scheduleWarrantyVisit({ request_id: PACKAGE, ...availabilityInput }), h => h.service.rescheduleWarrantyVisit({ visit_id: LOT, ...window })]) {
    const h = harness(); h.db.store.warranty_service_visits.push(...availabilityRows(251))
    await assert.rejects(action(h), /already booked|overlapping visit/)
    assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.audit, [])
  }
  const h = harness(); Object.assign(h.db.store.warranty_service_visits[0], window)
  assert.equal((await h.service.rescheduleWarrantyVisit({ visit_id: LOT, ...window })).status, 'scheduled')
})
test('availability page errors, stalled cursors and overflow cannot report a free schedule', async () => {
  for (const kind of ['read-error', 'null-page', 'stalled', 'overflow']) {
    const h = harness(), from = h.db.from.bind(h.db); let reads = 0
    h.db.store.warranty_service_visits = availabilityRows(kind === 'overflow' ? 10001 : 251)
    const first = h.db.store.warranty_service_visits.slice(0, 100)
    h.db.from = table => { const q = from(table), run = q.run.bind(q); q.run = () => {
      if (table === 'warranty_service_visits' && ++reads > 1) {
        if (kind === 'read-error') return { data: null, error: { message: 'Next page failed' } }
        if (kind === 'null-page') return { data: null, error: null }
        if (kind === 'stalled') return { data: first, error: null }
      }
      return run()
    }; return q }
    await assert.rejects(h.service.findWarrantyVisitConflicts(availabilityInput), /availability|cursor|10,000/i)
    assert.deepEqual(h.calls.writes, [])
  }
})
test('availability validates time windows and assignee identity at its own service boundary', async () => {
  for (const input of [{ ...availabilityInput, window_start: 'not-a-date' }, { ...availabilityInput, window_end: '2026-10-05T09:00:00Z' }, { ...availabilityInput, assigned_user_id: null }, { ...availabilityInput, assignee_kind: 'trade', assigned_user_id: null }, { ...availabilityInput, exclude_visit_id: 'invalid' }]) {
    const h = harness()
    await assert.rejects(h.service.findWarrantyVisitConflicts(input))
    assert.deepEqual(h.calls.writes, [])
  }
})

test('conflict preview fails closed on inaccessible homes without returning their identities', async () => {
  const h = harness(); h.db.store.warranty_service_visits = availabilityRows(1); h.deny('warranty.read')
  await assert.rejects(h.service.findWarrantyVisitConflicts(availabilityInput), /outside your home access/)
  assert.deepEqual(h.calls.writes, [])
})

test('availability server action preserves self-exclusion without requiring a new request payload', async () => {
  const h = harness(); Object.assign(h.db.store.warranty_service_visits[0], window)
  stubModule('next/cache', { revalidatePath: () => {} })
  stubModule('@/lib/services/warranty', { findWarrantyVisitConflicts: input => h.service.findWarrantyVisitConflicts(input) })
  delete require.cache[require.resolve('../app/(app)/warranty/actions')]
  const { findWarrantyVisitConflictsAction } = require('../app/(app)/warranty/actions')
  const result = await findWarrantyVisitConflictsAction({ ...availabilityInput, exclude_visit_id: LOT })
  assert.equal(result.success, true); assert.deepEqual(result.data, [])
  assert.equal((await findWarrantyVisitConflictsAction({ ...availabilityInput, exclude_visit_id: 'invalid' })).success, false)
})

test('office home history, coverage, cost basis and visit detail require actual-home read permission', async () => {
  const reads = [
    h => h.service.getProjectWarrantyCoverage(PROJECT),
    h => h.service.listWarrantyRequests(PROJECT),
    h => h.service.listWarrantyVisitsForProject(PROJECT),
    h => h.service.findOriginatingCommitments({ projectId: PROJECT }),
    h => h.service.getWarrantyRequestCostBasis(PACKAGE),
    h => h.service.getWarrantyVisitDetail(LOT),
  ]
  for (const load of reads) {
    const h = harness();h.deny('warranty.read')
    const from = h.db.from.bind(h.db), selects = []
    h.db.from = table => { const q = from(table), select = q.select.bind(q);q.select = (fields, options) => { selects.push({ table, fields });return select(fields, options) };return q }
    await assert.rejects(load(h), /Home access denied/)
    assert.equal(h.calls.auth[0].projectId, PROJECT);assert.equal(h.calls.auth[0].permission, 'warranty.read')
    assert.ok(selects.every(s => ['id,project_id', 'id,project_id,request_id,updated_at'].includes(s.fields)), 'Only minimal parent identity may be read before permission')
    assert.deepEqual(h.calls.writes, []);assert.deepEqual(h.calls.events, []);assert.deepEqual(h.calls.audit, [])
  }
})
test('approved cost basis is complete, scoped to its authorized request home and safe integer evidence', async () => {
  const h = harness(), id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
  h.db.store.warranty_service_visits = Array.from({ length: 1251 }, (_, i) => ({ id: id(i+1), org_id: ORG, project_id: PROJECT, request_id: PACKAGE, visit_number: i+1, books_cost_approved_at: '2026-10-03', books_approved_cost_cents: 100 }))
  h.db.store.warranty_service_visits.push({ id: id(2000), org_id: ORG, project_id: VERSION, request_id: PACKAGE, books_cost_approved_at: '2026-10-03', books_approved_cost_cents: 999 }, { id: id(2001), org_id: ORG, project_id: PROJECT, request_id: LOT, books_cost_approved_at: '2026-10-03', books_approved_cost_cents: 999 })
  const rows = await h.service.getWarrantyRequestCostBasis(PACKAGE)
  assert.equal(rows.length, 1251);assert.equal(rows.reduce((sum, row) => sum+row.amount_cents, 0), 125100)
  assert.equal(rows[1250].label, 'Approved posted costs — Visit 1251')
  for (const invalid of [null, '', -1, 1.25, '1.5', Number.MAX_SAFE_INTEGER+1]) {
    h.db.store.warranty_service_visits[0].books_approved_cost_cents = invalid
    await assert.rejects(h.service.getWarrantyRequestCostBasis(PACKAGE), /Invalid approved/)
  }
})
test('home histories and originating PO candidates read beyond response and old 200-row ceilings', async () => {
  for (const [table, load] of [
    ['warranty_requests', h => h.service.listWarrantyRequests(PROJECT)],
    ['warranty_service_visits', h => h.service.listWarrantyVisitsForProject(PROJECT)],
    ['commitments', h => h.service.findOriginatingCommitments({ projectId: PROJECT })],
  ]) {
    const h = harness(), id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
    h.db.store[table] = Array.from({ length: 1251 }, (_, i) => ({ id: id(i+1), org_id: ORG, project_id: PROJECT, title: 'Repair', status: 'open', created_at: '2026-10-03T00:00:00Z', window_start: '2026-10-03T00:00:00Z', lines: [] }))
    h.db.store[table].push({ id: id(2000), org_id: VERSION, project_id: PROJECT }, { id: id(2001), org_id: ORG, project_id: VERSION })
    const rows = await load(h);assert.equal(rows.length, 1251, table);assert.equal(new Set(rows.map(row => row.id)).size, 1251, table)
  }
})
test('home history fails rather than returning partial data on later errors, stalled cursors or overflow', async () => {
  for (const failure of ['later-error', 'missing-page', 'stalled', 'overflow']) {
    const h = harness(), id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
    h.db.store.warranty_requests = Array.from({ length: failure === 'overflow' ? 10001 : 201 }, (_, i) => ({ id: id(i+1), org_id: ORG, project_id: PROJECT, title: 'Repair' }))
    const from = h.db.from.bind(h.db);let pages = 0
    h.db.from = table => { const q = from(table), run = q.run.bind(q);q.run = () => {
      if (table === 'warranty_requests' && ++pages === 2) {
        if (failure === 'later-error') return { data: null, error: { message: 'Later page unavailable' } }
        if (failure === 'missing-page') return { data: null, error: null }
        if (failure === 'stalled') return { data: h.db.store.warranty_requests.slice(0, 100), error: null }
      }
      return run()
    };return q }
    await assert.rejects(h.service.listWarrantyRequests(PROJECT), /Later page unavailable|page unavailable|cursor did not advance|exceeds supported/)
  }
})
test('visit detail verifies parent ancestry and fences the enriched read against reassignment', async () => {
  for (const failure of ['ancestry', 'revision-race']) {
    const h = harness()
    if (failure === 'ancestry') h.db.store.warranty_requests[0].project_id = VERSION
    else {
      const from = h.db.from.bind(h.db)
      h.db.from = table => { const q = from(table), select = q.select.bind(q);q.select = (fields, options) => {
        if (table === 'warranty_service_visits' && fields.includes('requested_by_contact')) h.db.store.warranty_service_visits[0].updated_at = '2026-10-03T01:00:00Z'
        return select(fields, options)
      };return q }
    }
    await assert.rejects(h.service.getWarrantyVisitDetail(LOT), /another home|changed or could not be loaded/)
  }
})

test('home history remains complete if the server clips requested 100-row pages', async () => {
  const h = harness(), id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
  h.db.store.warranty_requests = Array.from({ length: 1201 }, (_, i) => ({ id: id(i+1), org_id: ORG, project_id: PROJECT, title: 'Repair' }))
  const from = h.db.from.bind(h.db);let pages = 0
  h.db.from = table => { const q = from(table), run = q.run.bind(q);q.run = () => {
    const result = run()
    if (table === 'warranty_requests') { pages++;return { ...result, data: result.data?.slice(0, 37) } }
    return result
  };return q }
  const rows = await h.service.listWarrantyRequests(PROJECT)
  assert.equal(rows.length, 1201);assert.equal(new Set(rows.map(row => row.id)).size, 1201);assert.equal(pages, 34)
})

test('transaction-required completion refuses disabled rollout before any legacy write', async () => {
  const h = harness()
  await assert.rejects(h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }, ORG, { requireTransaction: true }), /Transactional warranty completion is unavailable/)
  assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.events, []); assert.deepEqual(h.calls.audit, [])
})

test('transaction-required mobile completion passes the viewed visit revision to SQL', async () => {
  const h = harness(); enableCompletionTransactions(h)
  const viewed = '2026-10-02T23:59:59.123456Z'
  h.db.rpc = async (name, args) => {
    assert.equal(name, 'complete_warranty_visit_atomic')
    assert.equal(args.p_expected_visit_at, viewed)
    return { data: null, error: { code: 'P0001', message: 'Warranty completion revision changed' } }
  }
  await assert.rejects(h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }, ORG, { requireTransaction: true, expectedVisitAt: viewed }), error => error.code === 'WARRANTY_COMPLETION_REVISION_CHANGED')
  assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.events, [])
})

test('another recorded completion rejects a competing payload without legacy writes', async () => {
  const h = harness(); enableCompletionTransactions(h)
  h.db.rpc = async () => ({ data: null, error: { code: 'P0001', message: 'Warranty completion retry differs from original receipt' } })
  await assert.rejects(h.service.completeWarrantyVisit({ visit_id: LOT, outcome: 'resolved' }, ORG, { requireTransaction: true }), error => error.code === 'WARRANTY_COMPLETION_ALREADY_RECORDED')
  assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.events, [])
})
