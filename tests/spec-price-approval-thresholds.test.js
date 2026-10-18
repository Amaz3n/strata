"use strict"

/** `lib/sales/spec-price-approval-thresholds.ts` — who may move a standing spec's price or incentive. */

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  DEFAULT_SPEC_PRICE_APPROVAL_BANDS,
  parseSpecPriceApprovalBands,
  requiredSpecPricePermission,
  specPriceDecisionBlockReason,
} = require("../lib/sales/spec-price-approval-thresholds")

const required = (moveCents, askingPriceCents, bands = DEFAULT_SPEC_PRICE_APPROVAL_BANDS) =>
  requiredSpecPricePermission({ moveCents, askingPriceCents, bands })

test("a move up to 5% and up to $10,000 applies; past either it needs approval", () => {
  // $400,000 home: 5% is $20,000, so the dollar ceiling binds first.
  assert.equal(required(-10_000_00, 400_000_00), "sales.manage")
  assert.equal(required(-10_000_01, 400_000_00), "sales.price_approve")
  // $150,000 home: 5% is $7,500, so the percent ceiling binds first.
  assert.equal(required(7_500_00, 150_000_00), "sales.manage")
  assert.equal(required(7_500_01, 150_000_00), "sales.price_approve")
})

test("a rise and a cut of the same size need the same permission", () => {
  assert.equal(required(12_000_00, 400_000_00), required(-12_000_00, 400_000_00))
})

test("a home with no price to measure against needs approval for any move", () => {
  assert.equal(required(1_00, null), "sales.price_approve")
  assert.equal(required(1_00, 0), "sales.price_approve")
})

test("an organization's bands are honoured, and a policy that lets anyone apply anything falls back to the default", () => {
  const strict = parseSpecPriceApprovalBands([
    { up_to_percent: null, up_to_cents: null, permission: "sales.price_approve" },
    { up_to_percent: 2, up_to_cents: 2_500_00, permission: "sales.manage" },
  ])
  assert.equal(required(2_500_00, 400_000_00, strict), "sales.manage")
  assert.equal(required(3_000_00, 400_000_00, strict), "sales.price_approve")
  for (const value of [null, "5%", [], [{ up_to_percent: 5, up_to_cents: 1_000_000, permission: "sales.manage" }], [{ up_to_percent: null, up_to_cents: null, permission: "sales.manage" }], [{ up_to_percent: -1, up_to_cents: null, permission: "x" }]]) {
    assert.deepEqual(parseSpecPriceApprovalBands(value), DEFAULT_SPEC_PRICE_APPROVAL_BANDS, JSON.stringify(value))
  }
})

test("the proposer never decides a move, and a decided move stays decided", () => {
  assert.match(specPriceDecisionBlockReason({ status: "proposed", proposedBy: "a", deciderId: "a" }), /someone other than/)
  assert.match(specPriceDecisionBlockReason({ status: "approved", proposedBy: "a", deciderId: "b" }), /already decided/)
  assert.equal(specPriceDecisionBlockReason({ status: "proposed", proposedBy: "a", deciderId: "b" }), null)
})
