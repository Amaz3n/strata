require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")
const test = require("node:test")
const math = require("../lib/financials/po-generation-math")

const projectId = "00000000-0000-4000-8000-000000000001"
const exceptionId = "00000000-0000-4000-8000-000000000002"
const vendorId = "00000000-0000-4000-8000-000000000003"
const agreementId = "00000000-0000-4000-8000-000000000004"
const asOfDate = "2026-10-02"

function generation({ prior = null, exception = null, configurationError = null } = {}) {
  const writes = []
  const authorizations = []
  const rows = {
    lots: [{ id: "lot", house_plan_id: "plan", house_plan_version_id: "edition", community_id: "community" }],
    house_plan_takeoff_lines: [], project_selections: [], companies: [],
    po_generation_exceptions: exception ? [exception] : [],
    po_generation_runs: prior ? [prior] : [],
  }
  const supabase = { from(table) {
    assert.ok(table in rows, `Unexpected table ${table}`)
    const query = {
      select() { return query }, eq() { return query }, in() { return query }, order() { return query }, limit() { return query },
      async maybeSingle() { return { data: rows[table][0] ?? null, error: null } },
      then(resolve, reject) { return Promise.resolve({ data: rows[table], error: null }).then(resolve, reject) },
      insert() { writes.push(table); throw new Error("Unexpected write") },
      update() { writes.push(table); throw new Error("Unexpected write") },
    }
    return query
  } }
  const stubs = {
    "@/lib/services/configuration-rules": { assertProjectConfiguration: async () => { if (configurationError) throw new Error(configurationError) } },
    "@/lib/supabase/server": { createServiceSupabaseClient() { throw new Error("Privileged client must not be reached") } },
    "@/lib/services/context": { requireOrgContext: async () => ({ supabase, orgId: "org-a", userId: "user-a" }) },
    "@/lib/services/authorization": { requireAuthorization: async (input) => authorizations.push(input) },
    "@/lib/services/audit": {}, "@/lib/services/events": {},
    "@/lib/services/price-book": { loadPriceAgreementCandidates: async () => [] },
    "@/lib/services/purchasing-settings": { getExpiringAgreementLeadDays: async () => 30 },
  }
  const filename = path.resolve(__dirname, "../lib/services/po-generation.ts")
  const compiled = new Module(filename, module)
  compiled.filename = filename
  compiled.paths = module.paths
  compiled.require = (id) => stubs[id] ?? require(id)
  compiled._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
  return { service: compiled.exports, writes, authorizations }
}

test("a changed preview is rejected before a generation run or PO is written", async () => {
  const { service, writes, authorizations } = generation()
  await assert.rejects(service.generatePurchaseOrders({ projectId, mode: "commit", asOfDate, expectedFingerprint: "f".repeat(64) }), /changed since the preview/)
  assert.equal(writes.length, 0)
  assert.equal(authorizations[0].permission, "po.generate")
  assert.equal(authorizations[0].projectId, projectId)
})

test("a matching preview can recover a previously committed run without duplicate writes", async () => {
  const fingerprint = math.createPoGenerationFingerprint({ asOfDate, lines: [] })
  const { service, writes } = generation({ prior: { id: "prior-run", input_fingerprint: fingerprint, status: "succeeded" } })
  const result = await service.generatePurchaseOrders({ projectId, mode: "commit", asOfDate, expectedFingerprint: fingerprint })
  assert.equal(result.runId, "prior-run")
  assert.equal(writes.length, 0)
})

test("manual exception pricing rejects a vendor outside the organization before generation", async () => {
  const { service, writes } = generation({ exception: { id: exceptionId, project_id: projectId, status: "open" } })
  await assert.rejects(service.resolvePoException(exceptionId, { kind: "manual", company_id: vendorId, unit_cost_cents: 100 }), /not available in this organization/)
  assert.equal(writes.length, 0)
})

test("a removed selection cannot be marked resolved or create purchase orders", async () => {
  const { service, writes } = generation({ exception: { id: exceptionId, project_id: projectId, status: "open", source_kind: "option", source_ref: { project_selection_id: "removed-selection" } } })
  await assert.rejects(service.resolvePoException(exceptionId, { kind: "agreement", agreement_id: agreementId }), /source is no longer active/)
  assert.equal(writes.length, 0)
})


test("an invalid home configuration blocks PO generation before any writes", async () => {
  const { service, writes } = generation({ configurationError: "Chef kitchen requires electrical upgrade" })
  await assert.rejects(service.generatePurchaseOrders({ projectId, mode: "commit", expectedFingerprint: "f".repeat(64) }), /requires electrical upgrade/)
  assert.equal(writes.length, 0)
})

test("an interactive commit without a preview fingerprint is refused before anything runs", async () => {
  const { service, writes, authorizations } = generation()
  await assert.rejects(service.generatePurchaseOrders({ projectId, mode: "commit", asOfDate }), /Preview the purchase orders/)
  assert.equal(writes.length, 0)
  assert.equal(authorizations.length, 0)
})

test("the starts release commits on its own fingerprint and is authorized for the release org", async () => {
  const fingerprint = math.createPoGenerationFingerprint({ asOfDate: new Date().toISOString().slice(0, 10), lines: [] })
  const { service, writes, authorizations } = generation({ prior: { id: "prior-run", input_fingerprint: fingerprint, status: "succeeded" } })
  const result = await service.generatePurchaseOrdersForStartsRelease({ projectId, orgId: "org-a" })
  assert.equal(result.runId, "prior-run")
  assert.equal(writes.length, 0)
  assert.equal(authorizations[0].permission, "po.generate")
})
