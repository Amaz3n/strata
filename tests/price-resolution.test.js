require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { displacedByAward } = require("../lib/financials/award-displacement")
const { bestComparableBid, comparePrice } = require("../lib/financials/renewal-compare")
const { agreementWriteAllowed } = require("../lib/services/price-book")
const { resolvePriceForLinePure, resolveSelectedAgreement, resolvedPriceTotal } = require("../lib/financials/price-resolution")

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


test("explicit agreement choice resolves a tie while preserving eligibility", () => {
  const a = agreement()
  const b = agreement({ id: "b", company_id: "vendor-b" })
  assert.equal(resolvePriceForLinePure(input(), [a, b]).exception.reason, "ambiguous_agreement")
  assert.equal(resolveSelectedAgreement(input(), [a, b], "b").resolved.companyId, "vendor-b")
})

test("explicit agreement choice cannot bypass scope, effective date, status or units", () => {
  for (const overrides of [
    { division_id: "other-division" }, { community_id: "other-community" },
    { house_plan_id: "other-plan" }, { house_plan_version_id: "old-edition" },
    { cost_code_id: "other-code" }, { cost_type: "labor" }, { uom: "lf" },
    { effective_from: "2027-01-01" }, { effective_to: "2026-01-01" }, { status: "void" },
  ]) {
    assert.throws(() => resolveSelectedAgreement(input(), [agreement(overrides)], "a"), /cannot price this line/)
  }
})

test("a missing explicit choice never silently substitutes another vendor", () => {
  assert.throws(() => resolveSelectedAgreement(input(), [agreement()], "deleted"), /no longer available/)
})

test("an award displaces the standing price of its scope, whichever vendor holds it, and ends it the day before", () => {
  const scope = { costCodeId: "cc", communityId: "community", housePlanId: null }
  const rows = [
    agreement({ id: "same-scope", community_id: "community" }),
    agreement({ id: "other-vendor", company_id: "other", community_id: "community", effective_to: "2027-12-31" }),
    agreement({ id: "typed", community_id: "community", cost_type: "labor" }),
    agreement({ id: "other-community", community_id: "elsewhere" }),
    agreement({ id: "lapsed", community_id: "community", effective_to: "2026-02-01" }),
    agreement({ id: "future", community_id: "community", effective_from: "2026-09-01" }),
    agreement({ id: "void", community_id: "community", status: "void" }),
  ]
  const displaced = displacedByAward(rows, scope, "2026-06-15")
  assert.deepEqual(displaced.map((entry) => entry.agreement.id), ["same-scope", "other-vendor"])
  assert.deepEqual(displaced.map((entry) => entry.endsOn), ["2026-06-14", "2026-06-14"])
  const sameDay = displacedByAward([agreement({ id: "today", community_id: "community", effective_from: "2026-06-15" })], scope, "2026-06-15")
  assert.equal(sameDay[0].endsOn, "2026-06-15")
})

test("a bid compares with a standing price only in the same kind and unit", () => {
  const unit = { kind: "unit", uom: "sf", cents: 400 }
  assert.deepEqual(comparePrice(unit, { kind: "unit", uom: "SF", cents: 380 }), { comparable: true, deltaCents: -20, deltaPct: -5 })
  assert.deepEqual(comparePrice(unit, { kind: "unit", uom: "lf", cents: 380 }), { comparable: false })
  assert.deepEqual(comparePrice(unit, { kind: "lump_sum", uom: null, cents: 380 }), { comparable: false })
  assert.equal(comparePrice({ kind: "lump_sum", uom: null, cents: 0 }, { kind: "lump_sum", uom: null, cents: 5 }).deltaPct, null)
  const best = bestComparableBid(unit, [
    { id: "a", price: { kind: "unit", uom: "sf", cents: 410 } },
    { id: "b", price: { kind: "unit", uom: "lf", cents: 1 } },
    { id: "c", price: { kind: "unit", uom: "sf", cents: 390 } },
  ])
  assert.equal(best.bid.id, "c")
  assert.equal(bestComparableBid(unit, [{ price: { kind: "lump_sum", uom: null, cents: 1 } }]), null)
})

test("a division-limited member writes only agreements of their divisions, never an org-wide one", () => {
  const access = { assignedOnly: true, divisionIds: ["gulf"] }
  const scope = (overrides) => ({ divisionId: null, communityId: null, communityDivisionId: null, ...overrides })
  assert.equal(agreementWriteAllowed({ assignedOnly: false, divisionIds: [] }, scope({})), true)
  assert.equal(agreementWriteAllowed(access, scope({})), false)
  assert.equal(agreementWriteAllowed(access, scope({ divisionId: "gulf" })), true)
  assert.equal(agreementWriteAllowed(access, scope({ divisionId: "atlantic" })), false)
  assert.equal(agreementWriteAllowed(access, scope({ communityId: "c1", communityDivisionId: "gulf" })), true)
  assert.equal(agreementWriteAllowed(access, scope({ communityId: "c1", communityDivisionId: "atlantic" })), false)
})
