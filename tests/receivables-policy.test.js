require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { dollarsToCents } = require("../lib/financials/money")
const { getProjectFinancialFeatureConfig } = require("../lib/financials/billing-model")
const { resolveBillingProfile } = require("../lib/financials/billing-profile")
const {
  readJobReceivablesTerms,
  resolveOrgReceivablesPolicy,
  resolveReceivablesPolicy,
  writeJobReceivablesTerms,
} = require("../lib/receivables/policy")

const BUILDER = { kind: "builder", specialty: "Electrical" }
const TRADE = { kind: "trade", specialty: "Electrical" }
const policyFor = (posture, profile = BUILDER, settingsMetadata) =>
  resolveReceivablesPolicy({ posture, profile, settingsMetadata })

test("invoice dollar inputs never infer cents from magnitude", () => {
  assert.equal(dollarsToCents(150_000), 15_000_000)
  assert.equal(dollarsToCents(1_250_000.75), 125_000_075)
  assert.equal(dollarsToCents(-25_000), -2_500_000)
})

test("receivables policy preserves each construction posture", () => {
  const residential = policyFor("residential")
  const commercial = policyFor("commercial")
  const production = policyFor("production")

  assert.equal(residential.primaryBillingStory, "draw_or_cost")
  assert.equal(residential.customerLabel, "Client")
  assert.equal(commercial.primaryBillingStory, "progress_application")
  assert.equal(commercial.approvalMode, "required_review")
  assert.equal(commercial.certifiesPayApplications, true)
  assert.equal(residential.certifiesPayApplications, false)
  assert.equal(production.primaryBillingStory, "deposit_or_closing")
  assert.equal(production.supportsBuyerDeposits, true)
  assert.equal(production.supportsClosingInvoices, true)
  assert.equal(production.supportsRetainage, false)
})

test("a builder's job keeps its posture policy whatever terms its settings carry", () => {
  const terms = { receivables: writeJobReceivablesTerms({ customerKind: "company", paymentTermsDays: 30, reviewBeforeSend: false, customerCertifies: false }) }
  for (const posture of ["residential", "commercial", "production"]) {
    assert.deepEqual(policyFor(posture, BUILDER, terms), policyFor(posture))
    assert.deepEqual(resolveOrgReceivablesPolicy({ tier: posture, profile: BUILDER }), policyFor(posture))
  }
})

test("a trade job bills by its own terms, not by the building's posture", () => {
  const gc = { receivables: writeJobReceivablesTerms({ customerKind: "company", paymentTermsDays: 30, reviewBeforeSend: false, customerCertifies: true }) }
  const residential = policyFor("residential", TRADE, gc)
  const commercial = policyFor("commercial", TRADE, gc)
  for (const policy of [residential, commercial]) {
    assert.equal(policy.customerLabel, "Builder")
    assert.equal(policy.approvalMode, "direct")
    assert.equal(policy.certifiesPayApplications, true)
    assert.equal(policy.paymentTermsDays, 30)
    assert.equal(policy.supportsRetainage, true)
  }
  assert.equal(residential.posture, "residential")

  const homeowner = policyFor("commercial", TRADE, { receivables: { customer_kind: "homeowner", review_before_send: true } })
  assert.equal(homeowner.customerLabel, "Customer")
  assert.equal(homeowner.approvalMode, "required_review")
  assert.equal(homeowner.certifiesPayApplications, false)
  assert.equal(homeowner.paymentTermsDays, null)

  const org = resolveOrgReceivablesPolicy({ tier: "commercial", profile: TRADE })
  assert.equal(org.customerLabel, "Customer")
  assert.equal(org.workspaceLabel, "Customer receivables")
  assert.equal(org.approvalMode, "direct")
})

test("job terms read back what was written and ignore malformed values", () => {
  const terms = { customerKind: "company", paymentTermsDays: 45, reviewBeforeSend: true, customerCertifies: true }
  assert.deepEqual(readJobReceivablesTerms({ receivables: writeJobReceivablesTerms(terms) }), terms)
  assert.deepEqual(readJobReceivablesTerms({ receivables: { customer_kind: "gc", payment_terms_days: -3, review_before_send: "yes" } }), {
    customerKind: "homeowner", paymentTermsDays: null, reviewBeforeSend: false, customerCertifies: false,
  })
  assert.deepEqual(readJobReceivablesTerms(null), readJobReceivablesTerms({}))
})

test("a residential trade job billed by schedule of values gets pay applications; a residential builder job keeps draws", () => {
  const featureConfig = getProjectFinancialFeatureConfig({
    property_type: "residential",
    financial_settings: { billing_model: "fixed_price", fixed_price_billing_basis: "progress" },
  })
  const terms = { receivables: writeJobReceivablesTerms({ customerKind: "company", paymentTermsDays: 30, reviewBeforeSend: false, customerCertifies: false }) }
  const trade = resolveBillingProfile({ featureConfig, policy: policyFor("residential", TRADE, terms) })
  assert.equal(trade.progressBilling, true)
  assert.equal(trade.primaryAction.kind, "new_pay_application")
  assert.deepEqual(trade.manageSurfaces, ["sov", "retainage"])
  assert.equal(trade.customerLabel, "Builder")
  assert.equal(trade.approvalRequired, false)

  const drawsConfig = getProjectFinancialFeatureConfig({
    property_type: "residential",
    financial_settings: { billing_model: "fixed_price", fixed_price_billing_basis: "draws" },
  })
  const builder = resolveBillingProfile({ featureConfig: drawsConfig, policy: policyFor("residential") })
  assert.equal(builder.progressBilling, false)
  assert.equal(builder.customerLabel, "Client")
})
