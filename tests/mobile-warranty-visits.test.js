require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const { ORG, ACTOR, PROJECT, LOT, VERSION, stubModule } = require('./support/starts-harness')
function harness({ enabled = true, allowed = true, orgAllowed = true, status = 'scheduled', serviceDenied = false, revisionDenied = false, receiptConflict = false } = {}) {
  const calls = []
  stubModule('@/lib/mobile/auth', { requireMobileOrg: async () => ({ orgId: ORG, user: { id: ACTOR }, serviceSupabase: {}, serviceContext: { orgId: ORG, userId: ACTOR } }) })
  stubModule('@/lib/services/context', { runWithServiceOrgContext: async (_, work) => work() })
  stubModule('@/lib/services/authorization', { authorize: async input => { calls.push(['authorize', input]); return { allowed: input.projectId ? allowed : orgAllowed } } })
  stubModule('@/lib/services/warranty-completion-transactions', { warrantyCompletionTransactionsEnabled: async () => { calls.push(['rollout']); return enabled } })
  stubModule('@/lib/services/warranty', {
    getWarrantyVisitDetail: async (id, org) => { if (serviceDenied) throw Object.assign(new Error('Denied'), { code: 'AUTH_FORBIDDEN' }); calls.push(['detail', id, org]); return { id, project_id: PROJECT, status } },
    completeWarrantyVisit: async (...args) => { if (receiptConflict) throw Object.assign(new Error('Recorded'), { code: 'WARRANTY_COMPLETION_ALREADY_RECORDED' }); if (revisionDenied) throw Object.assign(new Error('Changed'), { code: 'WARRANTY_COMPLETION_REVISION_CHANGED' }); if (serviceDenied) throw Object.assign(new Error('Denied'), { code: 'AUTH_FORBIDDEN' }); calls.push(['complete', ...args]); return { id: LOT, project_id: PROJECT, status: 'completed' } },
  })
  for (const modulePath of ['../app/api/mobile/v1/service/visits/[visitId]/route', '../app/api/mobile/v1/service/visits/[visitId]/complete/route']) delete require.cache[require.resolve(modulePath)]
  return { calls, GET: require('../app/api/mobile/v1/service/visits/[visitId]/route').GET, POST: require('../app/api/mobile/v1/service/visits/[visitId]/complete/route').POST }
}
const params = { params: Promise.resolve({ visitId: LOT }) }
function request(body) { return new Request('https://local.invalid/service/visits/complete', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) }
test('mobile detail capabilities use actual home authorization and approved transaction rollout', async () => {
  for (const [config, expected] of [[{}, true], [{ enabled: false }, false], [{ allowed: false }, false], [{ orgAllowed: false }, false], [{ status: 'canceled' }, false], [{ status: 'completed' }, false]]) {
    const h = harness(config), response = await h.GET(new Request('https://local.invalid/visit'), params)
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json()).data.can_complete, expected)
    assert.equal(h.calls.find(([name, input]) => name === 'authorize' && input.projectId)[1].projectId, PROJECT)
  }
})
test('mobile completion preserves costs and evidence and forces the transactional service path', async () => {
  const h = harness(), input = { expected_visit_at: '2026-10-03T00:00:00.123456Z', outcome: 'resolved', outcome_note: 'Door repaired', photo_file_ids: [VERSION], labor_hours: 1.25, labor_rate_cents: 5001, material_cents: 37 }
  const response = await h.POST(request(input), params)
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  const call = h.calls.find(([name]) => name === 'complete')
  const { expected_visit_at, ...completion } = input
  assert.deepEqual(call[1], { visit_id: LOT, ...completion }); assert.equal(call[2], ORG); assert.deepEqual(call[3], { requireTransaction: true, expectedVisitAt: expected_visit_at })
})
test('mobile completion rejects malformed input without dropping evidence or cost errors', async () => {
  const h = harness()
  for (const input of ['{', null, [], { outcome: 'unknown' }, { outcome: 'resolved', photo_file_ids: [VERSION, 123] }, { outcome: 'resolved', labor_hours: 25 }, { outcome: 'resolved', material_cents: 0.5 }, { outcome: 'resolved', material_cents: -1 }, { outcome: 'resolved', visit_id: VERSION }, { outcome: 'resolved', unknown: true }]) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? { expected_visit_at: '2026-10-03T00:00:00Z', ...input } : input
    assert.equal((await h.POST(request(body), params)).status, 400)
  }
  assert.equal((await h.POST(request({ outcome: 'resolved', expected_visit_at: 'invalid' }), params)).status, 400)
  assert.equal((await h.POST(request({ outcome: 'resolved', expected_visit_at: undefined }), params)).status, 400)
  assert.equal((await h.POST(request("x".repeat(32_769)), params)).status, 413)
  assert.equal(h.calls.length, 0)
  assert.equal((await h.POST(request({ outcome: 'resolved', expected_visit_at: '2026-10-03T00:00:00Z' }), { params: Promise.resolve({ visitId: 'bad' }) })).status, 400)
})
test('disabled transaction rollout refuses mobile completion before service writes', async () => {
  const h = harness({ enabled: false }), response = await h.POST(request({ outcome: 'resolved', expected_visit_at: '2026-10-03T00:00:00Z' }), params)
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'completion_unavailable')
  assert.deepEqual(h.calls, [['rollout']])
})

test('mobile visit routes report authorization denials as 403', async () => {
  const h = harness({ serviceDenied: true })
  assert.equal((await h.GET(new Request('https://local.invalid/visit'), params)).status, 403)
  assert.equal((await h.POST(request({ outcome: 'resolved', expected_visit_at: '2026-10-03T00:00:00Z' }), params)).status, 403)
})

test('mobile revision rejection returns an actionable uncommitted conflict', async () => {
  const h = harness({ revisionDenied: true })
  const response = await h.POST(request({ outcome: 'resolved', expected_visit_at: '2026-10-03T00:00:00Z' }), params)
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'visit_changed')
})

test('competing completed receipt becomes an actionable mobile conflict', async () => {
  const h = harness({ receiptConflict: true })
  const response = await h.POST(request({ outcome: 'resolved', expected_visit_at: '2026-10-03T00:00:00Z' }), params)
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'completion_already_recorded')
})
