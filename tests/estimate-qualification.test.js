require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const commercial = require("../lib/financials/estimate-commercial")

function harness(options = {}) {
  const prospect = {
    id: "prospect", org_id: "org", name: "Kitchen remodel", status: "qualified",
    notes: "Kitchen remodel and addition", project_type: "remodel", jobsite_location: { city: "Austin" },
    owner_user_id: "builder", budget_range: "100k_250k", timeline_preference: "Next spring",
    ...options.prospect,
  }
  const writes = [], reads = [], audits = []
  const contacts = options.contacts ?? [{ email: "owner@example.test", is_primary: true }]
  const db = { from(table) {
    const filters = []
    let payload
    const q = {
      select() { return q }, eq(key, value) { filters.push([key, value]); return q },
      insert(value) { payload = value; return q }, update(value) { payload = value; return q },
      single() { return execute() }, maybeSingle() { return execute() },
      then(resolve, reject) { return execute().then(resolve, reject) },
    }
    async function execute() {
      if (payload) {
        writes.push({ table, payload, filters })
        if (table === "prospects") Object.assign(prospect, payload)
        return { data: table === "estimates" ? { id: "estimate", ...payload } : null, error: null }
      }
      reads.push({ table, filters })
      if (table === "projects") return { data: options.project ?? null, error: options.projectError ?? null }
      if (table === "prospects") return { data: options.missingProspect ? null : prospect, error: options.prospectError ?? null }
      if (table === "prospect_contacts") return { data: contacts, error: options.contactError ?? null }
      return { data: null, error: null }
    }
    return q
  } }
  const exports = {}
  const dependencies = {
    zod: require("zod"),
    "@/lib/financials/estimate-commercial": commercial,
    "@/lib/services/context": { requireOrgContext: async () => ({ supabase: db, orgId: "org", userId: "builder", productTier: options.productTier ?? "residential" }) },
    "@/lib/services/permissions": { requirePermission: async () => { if (options.forbidden) throw Error("Forbidden") } },
    "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
    "@/lib/services/audit": { recordAudit: async value => audits.push(value) },
    "@/lib/services/events": { recordEvent: async () => {} },
  }
  const source = fs.readFileSync(require.resolve("../lib/services/estimates"), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(compiled, { exports, require: name => dependencies[name] ?? {}, console, Date })
  const create = (purpose = "construction_agreement", extra = {}) => exports.createEstimate({
    prospect_id: prospect.id, title: "Project pricing", lines: [{ description: "Work", quantity: 1, unit_cost_cents: 100000 }],
    ...(purpose === "legacy" ? {} : { precon: { ...commercial.DEFAULT_ESTIMATE_COMMERCIAL, purpose } }), ...extra,
  })
  return { create, prospect, writes, reads, audits }
}

test("services agreements do not advance early prospects into construction pricing", async () => {
  for (const status of ["new", "contacted", "qualified", "estimate_sent"]) {
    const h = harness({ prospect: { status, notes: "" }, contacts: [] })
    const result = await h.create("preconstruction_agreement")
    assert.equal(result.estimate.metadata.precon.purpose, "preconstruction_agreement")
    assert.equal(h.prospect.status, status)
    assert.equal(h.writes.filter(write => write.table === "prospects").length, 0)
    assert.equal(h.audits.length, 1)
  }
})

test("builders can price a name-only lead without qualification or budget targets", async () => {
  for (const status of ["new", "contacted", "qualified"]) {
    for (const purpose of ["budget", "construction_agreement", "legacy"]) {
      const h = harness({ prospect: { status, notes: "", budget_range: "undecided", timeline_preference: null }, contacts: [] })
      await h.create(purpose)
      assert.ok(h.writes.some(write => write.table === "estimates"))
      assert.equal(h.reads.some(read => read.table === "prospect_contacts"), false)
    }
  }
})

test("existing projects and later-stage revisions do not acquire retrospective intake gates", async () => {
  for (const options of [{ project: { id: "existing-project" }, prospect: { status: "new", notes: "" } }, { prospect: { status: "pricing", notes: "" } }, { prospect: { status: "changes_requested", notes: "" } }]) {
    const h = harness({ ...options, contacts: [] })
    await h.create("budget")
    assert.ok(h.writes.some(write => write.table === "estimates"))
    assert.equal(h.reads.some(read => read.table === "prospect_contacts"), false)
  }
})

test("production retains its own qualification flow and legacy pricing behavior", async () => {
  const h = harness({ productTier: "production", prospect: { status: "new", notes: "" }, contacts: [] })
  await h.create("legacy")
  assert.equal(h.prospect.status, "pricing")
})

test("failed record lookups and permissions fail before any estimate is written", async () => {
  for (const [options, message] of [
    [{ projectError: { message: "Project lookup failed" } }, /pricing workspace/],
    [{ prospectError: { message: "Prospect lookup failed" } }, /Prospect not found/],
    [{ missingProspect: true }, /Prospect not found/],
    [{ forbidden: true }, /Forbidden/],
  ]) {
    const h = harness(options)
    await assert.rejects(h.create("budget"), message)
    assert.equal(h.writes.length, 0)
  }
})
