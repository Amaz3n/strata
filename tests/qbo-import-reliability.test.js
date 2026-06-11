require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  extractLinkedQboAmounts,
  extractLinkedQboIds,
  isUsableQboPaymentMapping,
  qboImportProviderPaymentId,
} = require("../lib/integrations/accounting/qbo-import-rules")

test("credit-only QBO bill payments retain the bill and vendor-credit settlement amounts", () => {
  const payment = {
    TotalAmt: 0,
    Line: [
      { Id: "bill-line", Amount: 125, LinkedTxn: [{ TxnId: "bill-1", TxnType: "Bill" }] },
      { Id: "credit-line", Amount: 125, LinkedTxn: [{ TxnId: "credit-1", TxnType: "VendorCredit" }] },
    ],
  }

  assert.deepEqual(extractLinkedQboIds(payment, "bill"), ["bill-1"])
  assert.deepEqual(extractLinkedQboAmounts(payment, "bill"), [{ qboId: "bill-1", amountCents: 12500 }])
  assert.deepEqual(extractLinkedQboAmounts(payment, "vendorcredit"), [
    { qboId: "credit-1", amountCents: 12500 },
  ])
})

test("webhook placeholder mappings do not count as imported payments", () => {
  const paymentIds = new Set(["real-payment"])

  assert.equal(
    isUsableQboPaymentMapping(
      { entity_type: "bill_payment", entity_id: "random-placeholder", status: "synced" },
      paymentIds,
    ),
    false,
  )
  assert.equal(
    isUsableQboPaymentMapping(
      { entity_type: "bill_payment", entity_id: "real-payment", status: "synced" },
      paymentIds,
    ),
    true,
  )
  assert.equal(
    isUsableQboPaymentMapping(
      { entity_type: "bill_payment", entity_id: "real-payment", status: "conflict" },
      paymentIds,
    ),
    false,
  )
})

test("QBO payment provider ids are stable across retries and distinct for credit portions", () => {
  assert.equal(
    qboImportProviderPaymentId({
      kind: "billpayment",
      qboId: "42",
      split: false,
      lineId: "bill-1",
    }),
    "qbo_billpayment_42",
  )
  assert.equal(
    qboImportProviderPaymentId({
      kind: "billpayment",
      qboId: "42",
      split: true,
      lineId: "line-7",
      vendorCredit: true,
    }),
    "qbo_billpayment_42_line-7_vc",
  )
})
