require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")

const { payBatchFingerprint, payBatchIdempotencyKey } = require("../lib/payables/batch-idempotency")

const lines = [{ billId: "bill-a", amountCents: 1000 }, { billId: "bill-b", amountCents: 2500 }]

test("a retried submit of the same payments reuses its idempotency key", () => {
  const first = payBatchIdempotencyKey("session", payBatchFingerprint("fund", lines), 0)
  const retry = payBatchIdempotencyKey("session", payBatchFingerprint("fund", [...lines].reverse()), 0)

  assert.equal(first, retry)
  assert.ok(first.length <= 200)
})

test("changing the payments, the funding source or the amount gets a different key", () => {
  const base = payBatchFingerprint("fund", lines)

  assert.notEqual(payBatchFingerprint("other-fund", lines), base)
  assert.notEqual(payBatchFingerprint("fund", [lines[0]]), base)
  assert.notEqual(payBatchFingerprint("fund", [lines[0], { billId: "bill-b", amountCents: 2600 }]), base)
})

test("a discarded run moves the key on so the next attempt gets a fresh run", () => {
  const fingerprint = payBatchFingerprint("fund", lines)

  assert.notEqual(payBatchIdempotencyKey("session", fingerprint, 0), payBatchIdempotencyKey("session", fingerprint, 1))
})
