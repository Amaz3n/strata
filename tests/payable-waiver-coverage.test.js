require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const {
  waiverCoverage,
  waiverCoverageBasis,
  coveredWorkDate,
  normalizeWaiverKind,
  requirementCovered,
} = require("../lib/lien-waivers/coverage")
const bill = {
  id: "bill",
  total_cents: 100000,
  paid_cents: 0,
  retainage_cents: 10000,
  metadata: { billing_period_end: "2026-08-31" },
  status: "approved",
}
const signed = {
  id: "waiver",
  waiver_type: "conditional_progress",
  status: "signed",
  amount_cents: 90000,
  through_date: "2026-08-31",
  signed_file_id: "file",
  signed_at: "2026-09-01",
  metadata: { review: { status: "accepted" } },
}
test("only accepted signed evidence clears the hold", () => {
  for (const w of [
    { ...signed, status: "pending" },
    { ...signed, signed_file_id: null },
    { ...signed, signed_at: null },
    { ...signed, metadata: {} },
    { ...signed, metadata: { review: { status: "rejected" } } },
  ])
    assert.equal(waiverCoverage(bill, [w], true).heldCents, 90000)
  assert.equal(waiverCoverage(bill, [signed], true).heldCents, 0)
})
test("work coverage cannot be inferred from due or invoice dates", () => {
  assert.equal(
    coveredWorkDate({ ...bill, metadata: { due_date: "2026-08-31" } }),
    null,
  )
  assert.equal(
    waiverCoverage({ ...bill, metadata: {} }, [signed], true).heldCents,
    90000,
  )
  assert.equal(
    waiverCoverage(bill, [{ ...signed, through_date: "2026-08-30" }], true)
      .heldCents,
    90000,
  )
})
test("undercoverage and overlapping partial waivers do not clear full release", () => {
  assert.equal(
    waiverCoverage(bill, [{ ...signed, amount_cents: 89999 }], true).heldCents,
    90000,
  )
  assert.equal(
    waiverCoverage(
      bill,
      [
        { ...signed, amount_cents: 50000 },
        { ...signed, id: "other", amount_cents: 40000 },
      ],
      true,
    ).heldCents,
    90000,
  )
})
test("changed amount, period, or settled payment invalidates conditional coverage", () => {
  const w = {
    ...signed,
    metadata: { ...signed.metadata, coverage_basis: waiverCoverageBasis(bill) },
  }
  assert.equal(
    waiverCoverage({ ...bill, status: "partial" }, [w], true).heldCents,
    0,
  )
  for (const changed of [
    { ...bill, total_cents: 99000 },
    { ...bill, paid_cents: 40000 },
    { ...bill, metadata: { billing_period_end: "2026-09-01" } },
  ])
    assert.ok(waiverCoverage(changed, [w], true).heldCents > 0)
})
test("unconditional evidence does not authorize an unpaid payment", () => {
  const w = { ...signed, waiver_type: "unconditional_progress" }
  assert.equal(waiverCoverage(bill, [w], true).heldCents, 90000)
  const paid = {
    ...bill,
    retainage_cents: 0,
    paid_cents: 100000,
    status: "paid",
  }
  assert.equal(waiverCoverage(paid, [], true).heldCents, 0)
  assert.equal(waiverCoverage(paid, [], true).postPaymentOutstanding, true)
  assert.equal(
    waiverCoverage(paid, [{ ...w, amount_cents: 100000 }], true)
      .postPaymentOutstanding,
    false,
  )
})
test("payment reversal invalidates unconditional coverage and reinstates the payment hold", () => {
  const paid = {
    ...bill,
    retainage_cents: 0,
    paid_cents: 100000,
    status: "paid",
  }
  const w = {
    ...signed,
    waiver_type: "unconditional_final",
    amount_cents: 100000,
    metadata: { ...signed.metadata, coverage_basis: waiverCoverageBasis(paid) },
  }
  assert.equal(waiverCoverage(paid, [w], true).finalReceived, true)
  assert.equal(
    waiverCoverage({ ...paid, paid_cents: 0, status: "approved" }, [w], true)
      .finalReceived,
    false,
  )
  assert.equal(
    waiverCoverage({ ...paid, paid_cents: 0, status: "approved" }, [w], true)
      .heldCents,
    100000,
  )
})
test("legacy final is ambiguous and cannot satisfy a final requirement", () => {
  assert.equal(normalizeWaiverKind("final"), null)
  assert.equal(
    normalizeWaiverKind("final", { waiver_kind: "conditional_final" }),
    "conditional_final",
  )
  assert.equal(
    waiverCoverage(
      { ...bill, paid_cents: 100000 },
      [{ ...signed, waiver_type: "final", amount_cents: 100000 }],
      true,
    ).finalReceived,
    false,
  )
})
test("final releases require payment completion and no remaining held retainage", () => {
  const w = {
    ...signed,
    waiver_type: "unconditional_final",
    amount_cents: 100000,
  }
  assert.equal(waiverCoverage(bill, [w], true).finalReceived, false)
  assert.equal(
    waiverCoverage({ ...bill, paid_cents: 90000 }, [w], true).finalReceived,
    false,
  )
  assert.equal(
    waiverCoverage(
      { ...bill, retainage_cents: 0, paid_cents: 100000 },
      [w],
      true,
    ).finalReceived,
    true,
  )
})
test("lower-tier requirements keep both missing commitments and missing evidence visible", () => {
  assert.equal(waiverCoverage(bill, [signed], true, 1).heldCents, 90000)
  assert.equal(waiverCoverage(bill, [signed], true, 0, true).heldCents, 90000)
  const req = {
    waiver_type: "conditional_progress",
    amount_cents: 50000,
    period_end: "2026-08-31",
    claimant_company_name: "Supply LLC",
  }
  const w = { ...signed, claimant_name: " supply llc " }
  assert.equal(requirementCovered(req, w), true)
  for (const bad of [
    { ...w, claimant_name: "Another supplier" },
    { ...w, amount_cents: 49999 },
    { ...w, waiver_type: "unconditional_progress" },
    { ...w, through_date: "2026-08-30" },
  ])
    assert.equal(requirementCovered(req, bad), false)
  assert.equal(
    requirementCovered({ ...req, metadata: { amount_needs_review: true } }, w),
    false,
  )
  assert.equal(
    requirementCovered(
      { ...req, waiver_type: "final" },
      { ...w, waiver_type: "final" },
    ),
    false,
  )
})
test("optional waiver policy does not invent a payment hold", () =>
  assert.equal(waiverCoverage(bill, [], false).heldCents, 0))
test("a partial payment checks its exact amount without overstating the amount held", () => {
  const partial = { ...signed, amount_cents: 30000 }
  assert.equal(
    waiverCoverage(bill, [partial], true, 0, false, 30000).heldCents,
    0,
  )
  assert.equal(
    waiverCoverage(bill, [partial], true, 0, false, 30001).heldCents,
    30001,
  )
  assert.throws(
    () => waiverCoverage(bill, [partial], true, 0, false, 90001),
    /balance/,
  )
})
test("changing the project or claimant cannot reuse accepted coverage", () => {
  const scoped = {
    ...bill,
    project_id: "project",
    company_id: "trade",
    commitment_id: "commit",
  }
  const w = {
    ...signed,
    metadata: {
      ...signed.metadata,
      coverage_basis: waiverCoverageBasis(scoped),
    },
  }
  assert.equal(waiverCoverage(scoped, [w], true).heldCents, 0)
  for (const changed of [
    { ...scoped, company_id: "other" },
    { ...scoped, project_id: "other" },
    { ...scoped, commitment_id: "other" },
  ])
    assert.equal(waiverCoverage(changed, [w], true).heldCents, 90000)
})
test('retained funds moved to a release payable cannot become payable twice',()=>{
 const original={...bill,paid_cents:90000,retainage_released_cents:10000}
 assert.equal(waiverCoverage(original,[],true).outstandingCents,0)
 assert.equal(waiverCoverage({...bill,id:'release',total_cents:10000,retainage_cents:0},[],true).heldCents,10000)
})
