require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { directSettlementEvidence } = require("../lib/services/books/settlement-evidence")
const { draftFromFact, hashableFactPayload, preserveLegacySettlementPayload } = require("../lib/services/books/fact-drafts")
const { booksDigest } = require("../lib/services/books/hash")
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const invoice = directSettlementEvidence({ paymentId: id(1), invoiceId: id(2) })
const bill = directSettlementEvidence({ paymentId: id(1), billId: id(3) })
const common = { sourceId: id(1), accountingDate: "2026-09-30", sourceVersion: 1, projectionVersion: 1, policyVersion: 1 }

test("new payment facts and replayed journal lines retain exact document ownership", () => {
  for (const [sourceType, proof] of [["invoice_payment", invoice], ["bill_payment", bill], ["customer_deposit_receipt", invoice]]) {
    const payload = { amount_cents: 10000, gross_cents: 10000, fee_cents: 100, settlement_evidence: proof }
    assert.deepEqual(hashableFactPayload(sourceType, payload).settlement_evidence, proof)
    const draft = draftFromFact({ ...common, sourceType, payload })
    assert.ok(draft.lines.length >= 2)
    assert.ok(draft.lines.every(line => line.dimensions.payment_id === id(1)))
    assert.ok(draft.lines.every(line => line.dimensions[proof.invoice_id ? "invoice_id" : "bill_id"] === (proof.invoice_id ?? proof.bill_id)))
    assert.deepEqual(draftFromFact({ ...common, sourceType, payload: structuredClone(payload) }), draft)
  }
})

test("reversal evidence points to the original payment and validates the document side", () => {
  for (const [side, proof] of [["invoice_payment", invoice], ["bill_payment", bill]]) {
    const draft = draftFromFact({ ...common, sourceType: "payment_reversal", sourceId: id(4), payload: { amount_cents: 10000, side, settlement_evidence: proof } })
    assert.ok(draft.lines.every(line => line.dimensions.payment_id === id(1)))
  }
  assert.throws(() => draftFromFact({ ...common, sourceType: "bill_payment", payload: { amount_cents: 10000, settlement_evidence: invoice } }), /does not match/)
  assert.throws(() => draftFromFact({ ...common, sourceType: "payment_reversal", payload: { amount_cents: 10000, side: "bill_payment", settlement_evidence: invoice } }), /does not match/)
  assert.throws(() => directSettlementEvidence({ paymentId: id(1) }), /exactly one/)
  assert.throws(() => directSettlementEvidence({ paymentId: id(1), invoiceId: id(2), billId: id(3) }), /exactly one/)
})

test("rollout does not rewrite unchanged legacy history or fabricate its settlement evidence", () => {
  for (const projectDimensions of [undefined, { [id(9)]: { division_id: id(10) } }]) {
    const legacy = { amount_cents: 10000, gross_cents: 10000, fee_cents: 100, ...(projectDimensions ? { project_dimensions: projectDimensions } : {}) }
    const next = { ...legacy, settlement_evidence: invoice }
    for (const payload_hash of [booksDigest(hashableFactPayload("invoice_payment", legacy)), booksDigest({ accountingDate: common.accountingDate, payload: hashableFactPayload("invoice_payment", legacy) })]) {
      const previous = { accounting_date: common.accountingDate, payload: legacy, payload_hash }
      assert.equal(preserveLegacySettlementPayload("invoice_payment", common.accountingDate, next, previous), legacy)
      assert.equal(preserveLegacySettlementPayload("invoice_payment", common.accountingDate, { ...next, amount_cents: 12000 }, previous).settlement_evidence, invoice)
      assert.equal(preserveLegacySettlementPayload("invoice_payment", "2026-10-01", next, previous).settlement_evidence, invoice)
    }
  }
})

test("new settlement reassignment changes the immutable economic payload", () => {
  const original = { amount_cents: 10000, settlement_evidence: invoice }
  const changed = { ...original, settlement_evidence: directSettlementEvidence({ paymentId: id(1), invoiceId: id(5) }) }
  const previous = { accounting_date: common.accountingDate, payload: original, payload_hash: booksDigest(hashableFactPayload("invoice_payment", original)) }
  assert.equal(preserveLegacySettlementPayload("invoice_payment", common.accountingDate, changed, previous), changed)
  assert.notEqual(booksDigest(hashableFactPayload("invoice_payment", original)), booksDigest(hashableFactPayload("invoice_payment", changed)))
})
