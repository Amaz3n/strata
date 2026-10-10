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
const ownVendorId = "00000000-0000-4000-8000-000000000005"
const asOfDate = "2026-10-02"

function generation({ prior = null, exception = null, configurationError = null, takeoffs = [], candidates = [], companies = [], recordRuns = false } = {}) {
  const writes = []
  const authorizations = []
  const rows = {
    lots: [{ id: "lot", house_plan_id: "plan", house_plan_version_id: "edition", community_id: "community" }],
    house_plan_takeoff_lines: takeoffs, project_selections: [], companies,
    po_generation_exceptions: exception ? [exception] : [],
    po_generation_runs: prior ? [prior] : [],
  }
  // A preview records its run and exceptions; nothing else may be written.
  const write = (table) => {
    writes.push(table)
    if (!recordRuns || !["po_generation_runs", "po_generation_exceptions"].includes(table)) throw new Error("Unexpected write")
    const chain = { select() { return chain }, eq() { return chain }, async single() { return { data: { id: "run-1" }, error: null } }, then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject) } }
    return chain
  }
  const supabase = { from(table) {
    assert.ok(table in rows, `Unexpected table ${table}`)
    const query = {
      select() { return query }, eq() { return query }, in() { return query }, order() { return query }, limit() { return query },
      async maybeSingle() { return { data: rows[table][0] ?? null, error: null } },
      then(resolve, reject) { return Promise.resolve({ data: rows[table], error: null }).then(resolve, reject) },
      insert() { return write(table) },
      update() { return write(table) },
    }
    return query
  } }
  const stubs = {
    "@/lib/services/configuration-rules": { assertProjectConfiguration: async () => { if (configurationError) throw new Error(configurationError) } },
    // Selections are read through the service client once the run is authorized.
    "@/lib/supabase/server": { createServiceSupabaseClient: () => supabase },
    "@/lib/services/context": { requireOrgContext: async () => ({ supabase, orgId: "org-a", userId: "user-a" }) },
    "@/lib/services/authorization": { requireAuthorization: async (input) => authorizations.push(input) },
    "@/lib/services/audit": { recordAudit: async () => {} }, "@/lib/services/events": { recordEvent: async () => {} },
    "@/lib/services/price-book": { loadPriceAgreementCandidates: async () => candidates },
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

test("a preview lists the priced lines, the lines it could not price, and the agreements about to lapse", async () => {
  const line = (id, costCodeId, quantity) => ({ id, cost_code_id: costCodeId, cost_type: null, description: `Line ${id}`, quantity, uom: "sf", elevation_id: null })
  const agreement = { id: agreementId, company_id: ownVendorId, cost_code_id: "framing", cost_type: null, division_id: null, community_id: null, house_plan_id: null, house_plan_version_id: null, pricing_kind: "unit", uom: "sf", unit_cost_cents: 250, lump_sum_cents: null, effective_from: "2026-01-01", effective_to: "2026-10-20", status: "active" }
  const { service, writes } = generation({
    takeoffs: [line("priced", "framing", 100), line("unpriced", "roofing", 40)],
    candidates: [agreement],
    companies: [{ id: ownVendorId, name: "Framing Co" }],
    recordRuns: true,
  })

  const result = await service.generatePurchaseOrders({ projectId, mode: "dry_run", asOfDate })

  assert.equal(result.mode, "dry_run")
  assert.equal(result.purchaseOrders.length, 1)
  assert.equal(result.purchaseOrders[0].companyId, ownVendorId)
  assert.equal(result.purchaseOrders[0].totalCents, 25_000)
  assert.deepEqual(result.exceptions.map((item) => [item.source_ref.takeoff_line_id, item.reason]), [["unpriced", "no_agreement"]])
  assert.deepEqual(result.expiringAgreements.map((item) => [item.agreementId, item.effectiveTo, item.daysRemaining]), [[agreementId, "2026-10-20", 18]])
  assert.equal(result.budgetLinesWritten, 0)
  assert.ok(writes.every((table) => ["po_generation_runs", "po_generation_exceptions"].includes(table)))
})

test("a manual price that is negative, fractional or for a malformed vendor is refused before anything is written", async () => {
  const { service, writes } = generation({ exception: { id: exceptionId, project_id: projectId, status: "open" } })
  for (const resolution of [
    { kind: "manual", company_id: vendorId, unit_cost_cents: -1 },
    { kind: "manual", company_id: vendorId, unit_cost_cents: 10.5 },
    { kind: "manual", company_id: "not-a-vendor", unit_cost_cents: 100 },
    { kind: "agreement", agreement_id: "not-an-agreement" },
  ]) {
    await assert.rejects(service.resolvePoException(exceptionId, resolution))
  }
  assert.equal(writes.length, 0)
})
