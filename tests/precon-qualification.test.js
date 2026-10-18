require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const { randomUUID } = require("node:crypto")
const { createProspectInputSchema, assertManualProspectStatus } = require("../lib/validation/prospects")

const orgId = randomUUID(), userId = randomUUID(), prospectId = randomUUID()
const complete = {
  owner_user_id: userId, project_type: "remodel", jobsite_location: { city: "Boston" },
  notes: "Renovate kitchen and adjoining living room", budget_range: "100k_250k",
  timeline_preference: "6_months", primary_contact: { full_name: "Sam Client", email: "sam@example.com" },
}

test("creation and generic stage edits cannot manufacture commercial milestones", () => {
  for (const status of ["pricing", "estimate_sent", "changes_requested", "client_approved", "executed", "won"]) {
    assert.equal(createProspectInputSchema.safeParse({ name: "New lead", status }).success, false, status)
    assert.throws(() => assertManualProspectStatus(status, "new"), /workflow/, status)
    assert.doesNotThrow(() => assertManualProspectStatus(status, status), status)
  }
  assert.equal(createProspectInputSchema.parse({ name: "New lead" }).status, "new")
  for (const status of ["new", "contacted", "qualified", "lost"]) assert.doesNotThrow(() => assertManualProspectStatus(status, "new"))
})

let productTier, row, contacts, writes, permitted
function reset(overrides = {}) {
  productTier = "residential"
  permitted = true
  row = { ...complete, id: prospectId, org_id: orgId, name: "Kitchen remodel", status: "contacted", ...overrides }
  delete row.primary_contact
  contacts = [{ id: randomUUID(), prospect_id: prospectId, org_id: orgId, full_name: "Sam Client", email: "sam@example.com", is_primary: true }]
  writes = []
}
const db = { from(table) {
  const filters = []; let payload, operation
  const q = {
    select() { return q }, eq(key, value) { filters.push([key, value]); return q }, order() { return q },
    update(value) { payload = value; operation = "update"; return q },
    insert(value) { payload = value; operation = "insert"; return q },
    single() { return Promise.resolve(execute(true)) }, maybeSingle() { return Promise.resolve(execute(true)) },
    then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject) },
  }
  function execute(single) {
    if (operation) {
      writes.push({ table, payload, filters })
      row = { ...(operation === "insert" ? { id: prospectId } : row), ...payload }
      return { data: row, error: null }
    }
    const matching = (table === "prospect_contacts" ? contacts : [row]).filter(item => filters.every(([key, value]) => item[key] === value))
    return { data: single ? matching[0] ?? null : matching, error: null }
  }
  return q
} }
const stubs = {
  "@/lib/services/prospect-write-access": {
    assertCanWriteDeals: async () => { if (!permitted) throw Error("Forbidden") },
    assertProspectWriteAccess: async () => {},
    assertProspectOwner: async () => {},
  },
  "@/lib/services/context": { requireOrgContext: async () => ({ supabase: db, orgId, userId, productTier }) },
  "@/lib/services/permissions": { requirePermission: async () => { if (!permitted) throw Error("Forbidden") }, requireAnyPermission: async () => { if (!permitted) throw Error("Forbidden") } },
  "@/lib/services/audit": { recordAudit: async () => {} },
  "@/lib/services/events": { recordEvent: async () => {} },
  "@/lib/services/community-traffic": { recordLeadTraffic: async () => {} },
  "@/lib/services/party-promotion": { promotePersonToDirectoryWithClient: async () => {} },
}
const originalLoad = Module._load
Module._load = function(request, ...args) { return stubs[request] ?? originalLoad.call(this, request, ...args) }
let createProspect, updateProspect
try { ({ createProspect, updateProspect } = require("../lib/services/prospects")) } finally { Module._load = originalLoad }

const update = input => updateProspect({ prospectId, input })

test("qualification is the builder’s judgment and does not require completing intake", async () => {
  reset({ notes: null, budget_range: "undecided" }); contacts = []
  await update({ status: "qualified" })
  assert.equal(row.status, "qualified")
  assert.ok(writes[0].filters.some(([key, value]) => key === "org_id" && value === orgId))
})

test("transactional stages are protected in the service while ordinary edits retain them", async () => {
  reset()
  await assert.rejects(update({ status: "executed" }), /workflow/)
  assert.equal(writes.length, 0)
  reset({ status: "executed", notes: null })
  await update({ status: "executed", name: "Updated project name" })
  assert.equal(row.status, "executed")
  assert.equal(row.name, "Updated project name")
})

test("capture and qualification both allow optional detail, while permissions still apply", async () => {
  reset()
  await createProspect({ input: { name: "New inquiry" } })
  assert.equal(row.status, "new")
  assert.equal(row.owner_user_id, userId)
  reset()
  await createProspect({ input: { name: "Qualified by builder", status: "qualified" } })
  assert.equal(row.status, "qualified")
  reset({ notes: null, project_type: null, budget_range: null, timeline_preference: null, jobsite_location: null })
  productTier = "production"
  await update({ status: "qualified" })
  assert.equal(row.status, "qualified")
  reset(); permitted = false
  await assert.rejects(update({ status: "qualified" }), /Forbidden/)
  await assert.rejects(createProspect({ input: { name: "No deal-write key" } }), /Forbidden/)
  assert.equal(writes.length, 0)
})

test('a stale editor cannot overwrite canonical scope or other deal fields', async () => {
  reset({ updated_at: '2026-10-01T12:00:00+00:00', notes: 'Latest scope' })
  await assert.rejects(update({ notes: 'Old scope', expected_updated_at: '2026-10-01T11:00:00+00:00' }), /changed while you were editing/)
  assert.equal(row.notes, 'Latest scope')
  assert.equal(writes.length, 0)
})
test('accepted deal edits compare the loaded revision again at the write boundary', async () => {
  const revision = '2026-10-01T12:00:00+00:00'
  reset({ updated_at: revision })
  await update({ budget_range: '250k_500k', expected_updated_at: revision })
  assert.ok(writes[0].filters.some(([key, value]) => key === 'updated_at' && value === revision))
  assert.equal(row.notes, complete.notes)
})
test('generic edits cannot regress document-managed stages', async () => {
  reset({ status: 'executed' })
  await assert.rejects(update({ status: 'qualified' }), /document workflow/)
  assert.equal(writes.length, 0)
})

 test("new inquiries cannot be captured as already closed deals", () => { assert.equal(createProspectInputSchema.safeParse({ name: "Closed inquiry", status: "lost" }).success, false) })
