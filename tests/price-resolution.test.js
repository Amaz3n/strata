require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { resolvePriceForLinePure, resolvedPriceTotal } = require("../lib/financials/price-resolution")

const input = (overrides = {}) => ({
  costCodeId: "cc", costType: "material", uom: "sf", quantity: 12,
  housePlanId: "plan", housePlanVersionId: "version", communityId: "community",
  divisionId: "division", asOfDate: "2026-07-18", ...overrides,
})
const agreement = (overrides = {}) => ({
  id: "a", company_id: "vendor", cost_code_id: "cc", cost_type: null,
  division_id: null, community_id: null, house_plan_id: null, house_plan_version_id: null,
  pricing_kind: "unit", uom: "sf", unit_cost_cents: 25, lump_sum_cents: null,
  effective_from: "2026-01-01", effective_to: null, status: "active", ...overrides,
})

test("price resolution honors scope, division, version, and cost-type specificity", () => {
  const rows = [
    agreement({ id: "org" }),
    agreement({ id: "community", community_id: "community" }),
    agreement({ id: "plan", house_plan_id: "plan" }),
    agreement({ id: "both", community_id: "community", house_plan_id: "plan" }),
    agreement({ id: "division", community_id: "community", house_plan_id: "plan", division_id: "division" }),
    agreement({ id: "version", community_id: "community", house_plan_id: "plan", division_id: "division", house_plan_version_id: "version" }),
    agreement({ id: "typed", community_id: "community", house_plan_id: "plan", division_id: "division", house_plan_version_id: "version", cost_type: "material" }),
  ]
  assert.equal(resolvePriceForLinePure(input(), rows).resolved.agreementId, "typed")
})

test("latest effective date wins and an exact tie becomes an exception", () => {
  const latest = agreement({ id: "latest", effective_from: "2026-06-01" })
  assert.equal(resolvePriceForLinePure(input(), [agreement(), latest]).resolved.agreementId, "latest")
  const tie = agreement({ id: "tie", company_id: "vendor-2", effective_from: "2026-06-01" })
  assert.equal(resolvePriceForLinePure(input(), [latest, tie]).exception.reason, "ambiguous_agreement")
})

test("date and uom failures are actionable and pricing math rounds", () => {
  assert.equal(resolvePriceForLinePure(input(), [agreement({ effective_to: "2026-01-31" })]).exception.reason, "expired_agreement")
  assert.equal(resolvePriceForLinePure(input(), [agreement({ uom: "lf" })]).exception.reason, "uom_mismatch")
  assert.equal(resolvePriceForLinePure(input(), []).exception.reason, "no_agreement")
  assert.equal(resolvedPriceTotal(input({ quantity: 2.5 }), { agreementId: "a", companyId: "v", pricingKind: "unit", unitCostCents: 101 }), 253)
  assert.equal(resolvedPriceTotal(input(), { agreementId: "a", companyId: "v", pricingKind: "lump_sum", lumpSumCents: 500 }), 500)
})
