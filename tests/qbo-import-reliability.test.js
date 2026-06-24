require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  collectPaginatedRows,
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
const { isQboMissingEntityFault } = require("../lib/integrations/accounting/qbo-error-rules")

test("direct lookup classification recognizes QBO fault 610 as a deleted transaction", () => {
  assert.equal(isQboMissingEntityFault({ status: 400, faultCode: "610" }), true)
  assert.equal(isQboMissingEntityFault({ status: 404, faultCode: null }), true)
  assert.equal(isQboMissingEntityFault({ status: 400, faultCode: "5010" }), false)
})

test("invoice void sync treats a missing QBO invoice as success and preserves its tombstone id", () => {
  const syncSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../lib/services/qbo-sync.ts"),
    "utf8",
  )
  const voidBranch = syncSource.slice(
    syncSource.indexOf('if (typedInvoice.status === "void")'),
    syncSource.indexOf("const metadataQboCustomerId"),
  )

  assert.match(voidBranch, /if \(!latestInvoice\)/)
  assert.match(voidBranch, /qbo_id: existingQboId/)
  assert.match(voidBranch, /qbo_sync_status: "synced"/)
  assert.match(voidBranch, /invoice_void_sync_already_deleted/)
  assert.match(voidBranch, /already_deleted: true/)
})

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

test("QBO import dedup pagination loads rows beyond the Supabase response cap", async () => {
  const source = Array.from({ length: 1352 }, (_, index) => ({ id: index + 1 }))
  const requestedRanges = []

  const rows = await collectPaginatedRows(
    async (from, to) => {
      requestedRanges.push([from, to])
      return { data: source.slice(from, to + 1), error: null }
    },
    { pageSize: 1000, label: "test mappings" },
  )

  assert.equal(rows.length, 1352)
  assert.deepEqual(rows.at(-1), { id: 1352 })
  assert.deepEqual(requestedRanges, [
    [0, 999],
    [1000, 1999],
  ])
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

test("outbound vendor bills preserve job costing without creating billable customer charges", () => {
  const syncSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../lib/services/qbo-sync.ts"),
    "utf8",
  )
  const vendorBillSync = syncSource.slice(
    syncSource.indexOf("export async function syncVendorBillToQBO"),
    syncSource.indexOf("export async function syncBillPaymentToQBO"),
  )

  assert.match(vendorBillSync, /CustomerRef:/)
  assert.match(vendorBillSync, /isCostDrivenBillingModel/)
  assert.match(vendorBillSync, /metadata\.billable_to_customer === true/)
  assert.match(vendorBillSync, /BillableStatus: billableToCustomer \? "Billable" : "NotBillable"/)
})

test("QBO-imported payables can split by line project while whole-payable reassign stays guarded", () => {
  const workspaceSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../components/payables/payables-workspace.tsx"),
    "utf8",
  )

  const lineProjectSelect = workspaceSource.slice(
    workspaceSource.indexOf("<Label className=\"mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground\">Project</Label>"),
    workspaceSource.indexOf("<Label className=\"mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground\">Amount</Label>"),
  )

  assert.match(lineProjectSelect, /projectId: value/)
  assert.doesNotMatch(lineProjectSelect, /disabled=\{selectedIsReassignablePayable\}/)
  assert.match(workspaceSource, /const reassignBlockedBySplit = selectedIsReassignablePayable && isSplitAcrossProjects/)
  assert.match(workspaceSource, /disabled=\{isPending \|\| reassignBlockedBySplit \|\| !creditProjectId \|\| creditProjectId === selectedBill\.project_id\}/)
  assert.match(workspaceSource, /project_id: line\.projectId \|\| selectedBill\.project_id/)
})

test("imported vendor credits can be reassigned without deleting their QBO mapping", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../lib/services/vendor-bills.ts"),
    "utf8",
  )
  const reassign = source.slice(source.indexOf("export async function reassignImportedPayable"))

  assert.match(reassign, /const isVendorCredit = metadata\.source === "vendor_credit"/)
  assert.match(reassign, /metadata\.imported_from_qbo !== true \|\| !existing\.qbo_id/)
  assert.match(reassign, /voidJobCostEntriesForVendorBill/)
  assert.match(reassign, /from\("bill_lines"\)[\s\S]*project_id: targetProjectId/)
  assert.match(reassign, /from\("vendor_bills"\)[\s\S]*project_id: targetProjectId/)
  assert.match(reassign, /propagateApprovalToLedger/)
  assert.doesNotMatch(reassign, /from\("qbo_sync_records"\)[\s\S]*delete/)
})
