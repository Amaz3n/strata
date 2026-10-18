require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
let project, projectError, linkError, contactError, authorized, created, estimates, prospect, contacts, productTier
function reset() {
  project = null; projectError = null; linkError = null; authorized = true; created = 0
  contactError = null; productTier = "residential"
  contacts = [{ email: "client@example.com", is_primary: true }]
  prospect = { id: "lead", org_id: "org", name: "Test lead", status: "qualified",
    notes: "Kitchen remodel", project_type: "remodel", jobsite_location: { city: "Austin" },
    owner_user_id: "actor", budget_range: "100k_250k", timeline_preference: "Next spring" }
  estimates = [
    { org_id: "org", prospect_id: "lead", project_id: null },
    { org_id: "other", prospect_id: "lead", project_id: null },
    { org_id: "org", prospect_id: "another", project_id: null },
    { org_id: "org", prospect_id: "lead", project_id: "other-project" },
  ]
}
const db = { from(table) {
  const filters = []; let update
  const q = {
    select() { return q }, eq(k, v) { filters.push(row => row[k] === v); return q },
    is(k, v) { return q.eq(k, v) }, in(k, vs) { filters.push(row => vs.includes(row[k])); return q },
    update(value) { update = value; return q },
    async maybeSingle() { return { data: table === "prospects" ? prospect : project, error: table === "projects" ? projectError : null } },
    then(resolve, reject) {
      if (table === "prospect_contacts") return Promise.resolve({ data: contacts, error: contactError }).then(resolve, reject)
      if (table === "estimates" && linkError) return Promise.resolve({ error: { message: "link failure" } }).then(resolve, reject)
      for (const row of table === "estimates" ? estimates : [prospect]) if (filters.every(f => f(row))) Object.assign(row, update)
      return Promise.resolve({ error: null }).then(resolve, reject)
    },
  }; return q
} }
const originalLoad = Module._load
const stubs = {
  "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
  "@/lib/services/context": { requireOrgContext: async () => ({ supabase: db, orgId: "org", userId: "actor", productTier }) },
  "@/lib/services/permissions": { requirePermission: async () => {} },
  "@/lib/services/authorization": { requireAuthorization: async () => { if (!authorized) throw Error("Forbidden") } },
  "@/lib/services/projects": { createProject: async () => { created++; project = { id: "pricing-project" }; return project } },
  "@/lib/services/audit": { recordAudit: async () => {} },
  "@/lib/services/events": { recordEvent: async () => {} },
}
Module._load = function(request, ...args) { return stubs[request] ?? originalLoad.call(this, request, ...args) }
const { startProspectPricing } = require("../lib/services/conversions")
test.after(() => { Module._load = originalLoad })
const start = () => startProspectPricing({ prospectId: "lead" })

test("starting pricing carries only this prospect's unlinked cost plans into the project", async () => {
  reset(); await start()
  assert.equal(prospect.status, "pricing")
  assert.deepEqual(estimates.map(e => e.project_id), ["pricing-project", null, null, "other-project"])
  await start(); assert.equal(created, 1)
})
test("a partial start can be retried without creating another project", async () => {
  reset(); linkError = true
  await assert.rejects(start, /Retry Start pricing/)
  assert.equal(prospect.status, "qualified")
  linkError = false; await start()
  assert.equal(created, 1); assert.equal(prospect.status, "pricing")
})
test("project lookup failures and missing management access cannot create or relink records", async () => {
  reset(); projectError = { message: "lookup failed" }
  await assert.rejects(start, /lookup failed/); assert.equal(created, 0)
  projectError = null; project = { id: "restricted" }; authorized = false
  await assert.rejects(start, /Forbidden/)
  assert.equal(estimates[0].project_id, null); assert.equal(prospect.status, "qualified")
})

test("new or contacted leads can start pricing without completing intake", async () => {
  for (const status of ["new", "contacted", "qualified"]) {
    reset(); prospect.status = status; prospect.notes = ""; prospect.budget_range = "undecided"; contacts = []
    await start(); assert.equal(created, 1); assert.equal(prospect.status, "pricing")
  }
})
test("existing workspace retries do not demand retrospective qualification", async () => {
  reset(); project = { id: "existing" }; prospect.notes = ""; contacts = []
  const result = await start()
  assert.equal(result.alreadyStarted, true)
  assert.equal(created, 0); assert.equal(estimates[0].project_id, "existing")
})
test("production retains its dedicated qualification flow", async () => {
  reset(); productTier = "production"; prospect.status = "new"; prospect.notes = ""; contacts = []
  await start(); assert.equal(created, 1)
})

test("missing optional intake does not block a first workspace for later-stage leads", async () => {
  reset(); prospect.status = "estimate_sent"; prospect.notes = ""
  await start(); assert.equal(created, 1); assert.equal(prospect.status, "estimate_sent")
})

test("opening resources keeps the original sales stage and reuses the linked project", async () => {
  reset(); prospect.status = "new";
  const first = await startProspectPricing({ prospectId: "lead", resourcesOnly: true });
  const again = await startProspectPricing({ prospectId: "lead", resourcesOnly: true });
  assert.equal(prospect.status, "new"); assert.equal(created, 1);
  assert.equal(first.projectId, again.projectId);
  await start(); assert.equal(prospect.status, "pricing");
});
