require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const commercial = require("../lib/financials/estimate-commercial")
const totals = require("../lib/financials/estimate-totals")
const { estimateInputSchema } = require("../lib/validation/estimates")

function portalHarness(initial, { failEnvelope = false, failActivity = false } = {}) {
  const row = structuredClone(initial)
  const writes = []
  const events = []
  const client = { async rpc() { writes.push({ table: "estimate_review_links", value: {} }); row.status = "sent"; return { data: { id: row.id } } }, from(table) {
    let mutation
    let single = false
    const filters = []
    const chain = {
      select() { return chain }, eq(key, value) { filters.push([key, value]); return chain },
      not() { return chain }, in() { return chain }, is() { return chain }, order() { return chain }, limit() { return chain },
      update(value) { mutation = value; return chain }, insert(value) { mutation = value; return chain },
      maybeSingle() { single = true; return execute() }, single() { single = true; return execute() },
      then(resolve, reject) { return execute().then(resolve, reject) },
    }
    function execute() {
      if (table === "estimates") {
        if (mutation) {
          if (filters.some(([key, value]) => key === "is_current_version" && value !== row[key])) return Promise.resolve({ data: [], error: null })
          writes.push({ table, value: mutation }); Object.assign(row, mutation)
          return Promise.resolve({ data: single ? row : [{ id: row.id }], error: null })
        }
        if (failEnvelope && row.status === "client_signed") return Promise.resolve({ data: null, error: { message: "delivery unavailable" } })
        return Promise.resolve({ data: row, error: null })
      }
      if (table === "org_settings") return Promise.resolve({ data: { settings: {} }, error: null })
      if (table === "app_users") return Promise.resolve({ data: { id: "builder", email: "builder@example.test", full_name: "Builder" }, error: null })
      if (table === "memberships") return Promise.resolve({ data: { id: "member", status: "active" }, error: null })
      if (mutation) {
        if (failActivity) return Promise.reject(new Error("activity unavailable"))
        writes.push({ table, value: mutation })
      }
      return Promise.resolve({ data: single ? { id: "activity" } : [], error: null })
    }
    return chain
  } }
  const exports = {}
  const source = fs.readFileSync(require.resolve("../lib/services/estimate-portal"), "utf8")
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const noop = async () => ({})
  const dependencies = {
    "@/lib/financials/estimate-commercial": commercial,
    "@/lib/financials/estimate-totals": totals,
    "@/lib/services/context": { requireOrgContext: async () => ({ supabase: client, orgId: "org", userId: "builder" }) },
    "@/lib/supabase/server": { createServiceSupabaseClient: () => client },
    "@/lib/services/audit": { recordAudit: noop },
    "@/lib/services/events": { recordEvent: async (value) => events.push(value) },
    "@/lib/services/precon-workspace": { assertPreconDecisionGate: noop },
    "@/lib/services/mailer": { sendEmail: async () => true, renderEmailTemplate: async () => "test email", getOrgSenderEmail: () => "builder@example.test" },
    "@/lib/emails/estimate-email": { EstimateEmail: () => null },
    "@/lib/emails/signature-email": { SignatureEmail: () => null },
    "@/lib/validation/estimates": { PRICING_DISPLAY_MODES: ["itemized"] },
  }
  const issuanceExports = {}
  const issuanceOutput = ts.transpileModule(fs.readFileSync(require.resolve("../lib/services/estimate-issuance"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(issuanceOutput, { exports: issuanceExports, require: (name) => ({
    "@/lib/financials/estimate-commercial": commercial,
    "./estimate-document-authorization": { authorizeEstimateDocumentWrite: async () => ({ service: client, orgId: "org" }) },
    "./precon-workspace": { assertPreconDecisionGate: noop },
  })[name] ?? {}, Date, Map, Set })
  dependencies["./estimate-issuance"] = issuanceExports
  vm.runInNewContext(output, {
    exports, require: (name) => name === "crypto" ? require("crypto") : dependencies[name] ?? {},
    process: { env: { ESTIMATE_SECRET: "local-test-only-signing-key" } },
    console: { error() {} }, Date, Set, Map, Buffer, URL,
  })
  return { service: exports, row, writes, events }
}
const estimate = (overrides = {}) => ({ id: "estimate", org_id: "org", title: "Kitchen", status: "sent", is_current_version: true, created_by: "builder", total_cents: 100000, metadata: {}, items: [], ...overrides })

test("legacy documents preserve agreement intent without retroactively adding terms", () => {
  assert.equal(commercial.normalizeEstimateCommercial({}).purpose, "construction_agreement")
  assert.equal(commercial.estimateDocumentTerms({ terms: "Original terms" }), "Original terms")
})

test("budget approval is nonbinding, records accepted scope and never issues a signature", async () => {
  const h = portalHarness(estimate({ metadata: { precon: { purpose: "budget" } }, items: [{ id: "upgrade", unit_cost_cents: 5000, quantity: 1, metadata: { is_optional: true } }] }))
  const result = await h.service.submitEstimateDecision({ token: "test", decision: "approved", selected_optional_ids: ["upgrade"] })
  assert.equal(result.status, "approved")
  assert.equal(h.row.client_signed_at, undefined)
  assert.equal(h.row.metadata.accepted_options.accepted_total_cents, 105000)
  assert.equal(h.events[0].eventType, "estimate_budget_approved")
  assert.ok(!h.writes.some((write) => /envelope|signing/.test(write.table)))
})

test("signature remains successful when countersignature delivery and activity logging fail", async () => {
  const h = portalHarness(estimate(), { failEnvelope: true, failActivity: true })
  const result = await h.service.submitEstimateDecision({ token: "test", decision: "approved", signature: { signer_name: "Owner", consent_accepted: true } })
  assert.equal(result.status, "client_signed")
  assert.equal(h.row.signature_data.client.signer_name, "Owner")
  assert.ok(h.row.client_signed_at)
})

test("resending a signed or superseded document cannot reopen it", async () => {
  for (const state of [{ status: "executed", executed_at: "2026-09-20" }, { status: "client_signed" }, { is_current_version: false }]) {
    const h = portalHarness(estimate(state))
    await assert.rejects(() => h.service.sendEstimate({ estimateId: "estimate" }), /current unsigned/)
    assert.equal(h.writes.length, 0)
  }
})

test("a superseded builder envelope cannot execute an estimate", async () => {
  const h = portalHarness(estimate({ status: "client_signed", is_current_version: false, signature_document_id: "doc" }))
  await assert.rejects(() => h.service.executeEstimateFromEnvelopeExecution({ orgId: "org", estimateId: "estimate", documentId: "doc", envelopeId: "env", executedFileId: "file", signerName: "Builder", signerEmail: "builder@example.test" }), /current construction agreement/)
  assert.equal(h.writes.length, 0)
})

test("agreement readiness requires documented basis, payments and model-specific fee", () => {
  const value = { ...commercial.DEFAULT_ESTIMATE_COMMERCIAL, billing_model: "cost_plus_fixed_fee", maturity: "conceptual" }
  assert.equal(commercial.estimateCommercialIssues(value).length, 4)
  assert.deepEqual(commercial.estimateCommercialIssues({ ...value, purpose: "budget" }), [])
})

test("accepted deduct and replacement deltas reduce the signed value without double-counting the base", () => {
  const items = [{ id: "replace", quantity: 1, unit_cost_cents: -10000, markup_pct: 10, metadata: { is_optional: true, alternate_kind: "replacement", replacement_scope: "Base countertop" } }]
  const accepted = totals.resolveAcceptedOptions(items, 110000, ["replace"], 0)
  assert.equal(accepted.accepted_total_cents, 99000)
  assert.match(commercial.estimateLineNotes(items[0].metadata), /net change/)
})

test("negative cost needs an explicit optional deduct/replacement and replacement scope", () => {
  const base = { title: "Test", lines: [{ description: "Credit", unit_cost_cents: -100, quantity: 1 }] }
  assert.equal(estimateInputSchema.safeParse(base).success, false)
  base.lines[0].is_optional = true
  base.lines[0].metadata = { alternate_kind: "replacement" }
  assert.equal(estimateInputSchema.safeParse(base).success, false)
  base.lines[0].metadata.replacement_scope = "Base cabinetry"
  assert.equal(estimateInputSchema.safeParse(base).success, true)
})

test("fixed-fee pricing adds the fee once and never stacks line markup", () => {
  const value = { ...commercial.DEFAULT_ESTIMATE_COMMERCIAL, billing_model: "cost_plus_fixed_fee", fixed_fee_cents: 20000 }
  const lines = [{ quantity: 1, unit_cost_cents: 100000, markup_pct: 25 }, { quantity: 1, unit_cost_cents: 10000, markup_pct: 25, is_optional: true }]
  const amounts = commercial.calculateCommercialEstimateTotals(lines, 10, 0, value)
  assert.deepEqual(amounts, { subtotal: 120000, contingency: 0, tax: 12000, total: 132000 })
  const normalized = commercial.normalizeCommercialEstimateLines(lines, value)
  assert.equal(normalized[0].markup_pct, 0)
  assert.equal(normalized[1].markup_pct, 0)
  assert.equal(lines[0].markup_pct, 25, "input remains immutable")
})

test("preconstruction agreement execution retains the pricing opportunity", async () => {
  const h = portalHarness(estimate({ status: "client_signed", prospect_id: "prospect", signature_document_id: "doc", metadata: { precon: { purpose: "preconstruction_agreement" } } }))
  await h.service.executeEstimateFromEnvelopeExecution({ orgId: "org", estimateId: "estimate", documentId: "doc", envelopeId: "env", executedFileId: "file", signerName: "Builder", signerEmail: "builder@example.test" })
  assert.equal(h.row.status, "executed")
  assert.ok(!h.writes.some((write) => write.table === "prospects"))
  assert.match(commercial.estimateDocumentTerms(h.row.metadata), /does not authorize construction/)
})

test("sending and signing services agreements do not advance construction prospect status", async () => {
  const metadata = { precon: { ...commercial.DEFAULT_ESTIMATE_COMMERCIAL, purpose: "preconstruction_agreement", pricing_basis: "Defined planning services", payment_terms: "On completion" }, recipient: { name: "Owner", email: "owner@example.test" } }
  const sent = portalHarness(estimate({ status: "draft", prospect_id: "prospect", metadata }))
  await sent.service.sendEstimate({ estimateId: "estimate" })
  assert.equal(sent.row.status, "sent")
  assert.ok(!sent.writes.some(write => write.table === "prospects"))
  const signed = portalHarness(estimate({ prospect_id: "prospect", metadata }), { failEnvelope: true })
  const result = await signed.service.submitEstimateDecision({ token: "test", decision: "approved", signature: { signer_name: "Owner", consent_accepted: true } })
  assert.equal(result.status, "client_signed")
  assert.ok(!signed.writes.some(write => write.table === "prospects"))
})

test("services change requests stay with the services document while construction pricing still advances", async () => {
  for (const purpose of ["preconstruction_agreement", "budget", "construction_agreement"]) {
    const h = portalHarness(estimate({ prospect_id: "prospect", metadata: { precon: { purpose } } }))
    await h.service.submitEstimateDecision({ token: "test", decision: "changes_requested", note: "Please revise the scope" })
    assert.equal(h.row.status, "changes_requested")
    const prospectWrites = h.writes.filter(write => write.table === "prospects")
    if (purpose === "preconstruction_agreement") assert.equal(prospectWrites.length, 0)
    else assert.equal(prospectWrites[0].value.status, "changes_requested")
  }
})

test("GMP and allowance policies are resolved before agreement issuance", () => {
  const value = { ...commercial.DEFAULT_ESTIMATE_COMMERCIAL, pricing_basis: "Issued drawings revision 4", payment_terms: "Monthly progress", billing_model: "cost_plus_gmp", gmp_cents: 100000 }
  assert.equal(commercial.estimateCommercialIssues(value, { totalCents: 110000, hasAllowances: true }).length, 2)
  assert.deepEqual(commercial.estimateCommercialIssues({ ...value, allowance_policy: "Materials only; unused amounts credited" }, { totalCents: 99000, hasAllowances: true }), [])
})

test("approved-budget credits carry through agreement validation, pricing and execution cost scope", () => {
  const { resolveContractedEstimateItems } = require("../lib/financials/contracted-estimate")
  for (const alternate_kind of ["deduct", "replacement"]) {
    const budgetLines = [
      { id: "base", description: "Base cabinetry", quantity: 1, unit_cost_cents: 100000, markup_pct: 10, is_optional: false, metadata: {} },
      { id: "credit", description: "Cabinet scope credit", quantity: 1, unit_cost_cents: -10000, markup_pct: 10, is_optional: true, metadata: { is_optional: true, alternate_kind, replacement_scope: "Base cabinetry" } },
      { id: "unaccepted", description: "Appliance upgrade", quantity: 1, unit_cost_cents: 50000, markup_pct: 10, is_optional: true, metadata: { is_optional: true } },
    ]
    const draftLines = commercial.carryAcceptedBudgetScope(budgetLines, ["credit"])
    assert.deepEqual(draftLines.map((line) => line.id), ["base", "credit"])
    assert.equal(draftLines[1].is_optional, false)
    const parsed = estimateInputSchema.parse({ title: "Construction agreement", lines: draftLines })
    const amounts = commercial.calculateCommercialEstimateTotals(parsed.lines)
    assert.equal(amounts.total, 99000)
    const persistedLines = parsed.lines.map((line, index) => ({ ...line, id: `agreement-${index}`, metadata: { ...line.metadata, is_optional: line.is_optional } }))
    const costs = resolveContractedEstimateItems(persistedLines, { source_budget: { estimate_id: "budget", version: 2 }, accepted_options: { ids: [] } })
    assert.equal(costs.reduce((sum, item) => sum + item.cost_cents, 0), 90000)
    assert.equal(costs[1].cost_cents, -10000)
    assert.throws(() => resolveContractedEstimateItems(persistedLines, { accepted_options: { ids: [] } }), /accepted deduct/)
  }
})

test("nonbinding budget documents never inherit organization construction terms", () => {
  const metadata = { precon: { purpose: "budget" }, terms: null }
  const terms = commercial.estimateDocumentTerms(metadata, "Binding construction agreement. Deposit due.")
  assert.match(terms, /Nonbinding/)
  assert.doesNotMatch(terms, /Deposit due/)
  assert.match(commercial.estimateDocumentTerms({ ...metadata, terms: "Owner-authored planning qualification" }, "Contract default"), /Owner-authored planning qualification/)
  assert.match(commercial.estimateDocumentTerms({ precon: { purpose: "construction_agreement" } }, "Agreement default"), /Agreement default/)
})
