require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  extractLinkedQboAmounts,
  extractLinkedQboIds,
  isUsableQboPaymentMapping,
  qboImportProviderPaymentId,
  qboVendorCreditCents,
} = require("../lib/integrations/accounting/qbo-import-rules")
const {
  isVendorCredit,
  payableOutstandingCents,
  summarizePayables,
} = require("../lib/financials/payables-rules")

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

test("vendor credits are negative exactly once regardless of QBO amount sign", () => {
  assert.equal(qboVendorCreditCents(7.21), -721)
  assert.equal(qboVendorCreditCents(-7.21), -721)
  assert.equal(qboVendorCreditCents("7.21"), -721)
})

test("vendor credits never enter outstanding payables or payment balances", () => {
  const credit = {
    payable_type: "vendor_credit",
    total_cents: -721,
    paid_cents: 0,
    project_amount_cents: -721,
  }
  const bill = {
    payable_type: "bill",
    total_cents: 100000,
    paid_cents: 100000,
  }

  assert.equal(isVendorCredit(credit), true)
  assert.equal(payableOutstandingCents(credit), 0)
  assert.deepEqual(summarizePayables([bill, credit]), {
    outstandingCents: 0,
    settledCents: 100000,
    vendorCreditsCents: 721,
  })
})

test("vendor-credit payables are blocked from outbound bill sync at both guard layers", () => {
  const syncSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../lib/services/qbo-sync.ts"),
    "utf8",
  )

  assert.match(syncSource, /isSyncPushBlocked\(supabase, orgId, "vendor_credit", billId\)/)
  assert.match(syncSource, /metadata[\s\S]*source === "vendor_credit"/)
})
