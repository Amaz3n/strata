require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { authorizedAgreementTerms } = require("../lib/sales/agreement-versions")

const original = { id: "v1", version_number: 1, kind: "original", change_order_id: null, price_delta_cents: 385_000_00, authorized_total_cents: 385_000_00, executed_at: "2026-09-01" }
const upgrade = { id: "v2", version_number: 2, kind: "amendment", change_order_id: "co-1", price_delta_cents: 12_500_00, authorized_total_cents: 397_500_00, executed_at: "2026-09-20" }
const deletion = { id: "v3", version_number: 3, kind: "amendment", change_order_id: "co-2", price_delta_cents: -3_000_00, authorized_total_cents: 394_500_00, executed_at: "2026-10-02" }

test("the authorized price is the head of the signed chain, with the original and the amendments apart", () => {
  const terms = authorizedAgreementTerms([deletion, original, upgrade])
  assert.equal(terms.current.id, "v3")
  assert.equal(terms.authorizedTotalCents, 394_500_00)
  assert.equal(terms.originalTotalCents, 385_000_00)
  assert.equal(terms.amendmentsCents, 9_500_00)
  assert.deepEqual(terms.amendments.map((row) => row.change_order_id), ["co-1", "co-2"])
})

test("bigint cents read back from the database as strings price the same", () => {
  const terms = authorizedAgreementTerms([{ ...original, price_delta_cents: "38500000", authorized_total_cents: "38500000" }])
  assert.equal(terms.authorizedTotalCents, 385_000_00)
})

test("a chain with a gap, a second original, a running total that drifts or no versions at all is refused", () => {
  assert.throws(() => authorizedAgreementTerms([]), /no recorded version/)
  assert.throws(() => authorizedAgreementTerms([original, deletion]), /history is broken/)
  assert.throws(() => authorizedAgreementTerms([original, { ...upgrade, kind: "original", change_order_id: null }]), /history is broken/)
  assert.throws(() => authorizedAgreementTerms([original, { ...upgrade, authorized_total_cents: 400_000_00 }]), /do not follow/)
  assert.throws(() => authorizedAgreementTerms([original, { ...upgrade, price_delta_cents: -400_000_00, authorized_total_cents: -15_000_00 }]), /do not follow/)
})
