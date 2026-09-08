require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { accountingPushTypeForLedgerType } = require("../lib/services/accounting-enqueue")
const {
  hasAccountingExternalId,
  indexLatestBillPaymentSyncByBillId,
  invoiceIsFromAccountingProvider,
} = require("../lib/services/accounting-sync-state")
const { mapWithConcurrency } = require("../lib/payments/concurrency")
const { disbursementStage, vendorPaymentStage } = require("../lib/payments/disbursement-stage")
const {
  assertIntegerCents,
  canTransitionDisbursement,
  decideVendorTransferAction,
  requesterMayApprovePaymentRun,
  requiredApprovalCount,
  scheduleTransferRelease,
} = require("../lib/payments/payment-domain")
const {
  DEFAULT_PAYMENT_HOLD_POLICY,
  evaluatePaymentHoldFacts,
  parsePaymentHoldPolicy,
} = require("../lib/payments/payment-hold-policy")
const { dailyPaymentExposureCents, tighterPaymentLimit } = require("../lib/payments/payment-limit-policy")
const {
  evaluateRunApprovability,
  evaluateRunSubmissionReadiness,
  hashableWaiverSnapshot,
  selectedApproverIds,
} = require("../lib/payments/payment-run-approval-policy")
const { createPaymentRunContentHash } = require("../lib/payments/payment-run-content-hash")
const {
  approvedReleaseSentence,
  formatReleaseDate,
  paymentRunNotificationCopy,
  paymentRunSubject,
  readReleaseKind,
} = require("../lib/payments/payment-run-notification-copy")
const { resolvePayableDecisionAudience } = require("../lib/payments/payable-notification-audience")
const {
  isVendorCredit,
  payableHeldRetainageCents,
  payableOutstandingCents,
  summarizePayables,
} = require("../lib/financials/payables-rules")

function syncState(overrides = {}) {
  return {
    connectionId: "connection-1",
    provider: "qbo",
    externalId: null,
    externalVersion: null,
    syncedAt: null,
    status: "pending",
    error: null,
    statusReason: null,
    lastAttemptId: null,
    updatedAt: "2026-09-03T00:00:00.000Z",
    pushable: true,
    metadata: {},
    ...overrides,
  }
}

test("H1 finding: sole and dual approval require exactly one and two decisions", () => {
  assert.equal(requiredApprovalCount("sole"), 1)
  assert.equal(requiredApprovalCount("dual"), 2)
  assert.equal(requesterMayApprovePaymentRun({ policy: { requester_may_approve: true } }), true)
  assert.equal(requesterMayApprovePaymentRun({ policy: { requester_may_approve: "true" } }), false)
})

test("H1 hash invalidation: every approved payable fact changes the run hash", () => {
  const base = {
    bill: { id: "bill-1", amount_cents: 10_000, company_id: "vendor-1", project_id: "project-1", currency: "USD", retainage_cents: 1_000, coding: "03-1000", file_id: "file-1", status: "approved" },
    recipient_account_id: "recipient-1",
  }
  const hash = createPaymentRunContentHash(hashableWaiverSnapshot(base))
  for (const [field, value] of [
    ["amount_cents", 10_001],
    ["company_id", "vendor-2"],
    ["project_id", "project-2"],
    ["currency", "CAD"],
    ["retainage_cents", 999],
    ["coding", "03-2000"],
    ["file_id", "file-2"],
    ["status", "rejected"],
  ]) {
    const changed = { ...base, bill: { ...base.bill, [field]: value } }
    assert.notEqual(createPaymentRunContentHash(hashableWaiverSnapshot(changed)), hash, field)
  }
  assert.notEqual(createPaymentRunContentHash({ ...base, recipient_account_id: "recipient-2" }), hash)
})

test("Phase C finding: commitment context is excluded but bill evidence remains hashable", () => {
  const snapshot = { bill: { id: "bill-1", amount_cents: 100 }, commitment: { billed_cents: 90 }, construction: { legacy: true } }
  assert.deepEqual(hashableWaiverSnapshot(snapshot), { bill: snapshot.bill })
  assert.equal(hashableWaiverSnapshot(null), null)
})

test("H1 hold precedence: an override cures only its named blocking hold", () => {
  const result = evaluatePaymentHoldFacts({
    projectId: "project-1",
    companyId: "vendor-1",
    complianceCurrent: false,
    insuranceCurrent: false,
    waiverRequired: true,
    waiverSigned: false,
    retainageRulesMet: true,
    fundingRequired: false,
    fundingReceived: true,
    overrides: { insurance_current: "Risk accepted by Jane" },
    policy: { compliance_docs_approved: "warn" },
  })
  assert.equal(result.holds.find((hold) => hold.kind === "insurance_current").overridden, true)
  assert.equal(result.holds.find((hold) => hold.kind === "compliance_docs_approved").level, "warn")
  assert.equal(result.holds.find((hold) => hold.kind === "waiver_signed").overridden, false)
  assert.equal(result.blockingCount, 1)
  assert.equal(result.releasable, false)
})

test("H1 hold policy parsing: malformed values fail back to safe defaults", () => {
  assert.deepEqual(parsePaymentHoldPolicy(null), DEFAULT_PAYMENT_HOLD_POLICY)
  assert.deepEqual(parsePaymentHoldPolicy([]), DEFAULT_PAYMENT_HOLD_POLICY)
  assert.deepEqual(parsePaymentHoldPolicy({ insurance_current: "warn", waiver_signed: "ignore" }), {
    ...DEFAULT_PAYMENT_HOLD_POLICY,
    insurance_current: "warn",
  })
})

test("H1 concurrency: provider fan-out is bounded and preserves input order", async () => {
  let active = 0
  let peak = 0
  const values = await mapWithConcurrency([30, 5, 20, 1], 2, async (delay, index) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, delay))
    active -= 1
    return `item-${index}`
  })
  assert.equal(peak, 2)
  assert.deepEqual(values, ["item-0", "item-1", "item-2", "item-3"])
  await assert.rejects(() => mapWithConcurrency([1], 0, async (value) => value), /positive integer/)
})

test("Phase B transfer recovery adopts provider state and uses the shared hold clock", () => {
  assert.equal(decideVendorTransferAction("tr_existing"), "adopt")
  assert.equal(decideVendorTransferAction(null), "create")
  assert.equal(scheduleTransferRelease("2026-07-02T16:00:00.000Z", 48), "2026-07-07T16:00:00.000Z")
})

test("H1 daily-limit case: a retry excludes its prior reservation", () => {
  assert.equal(dailyPaymentExposureCents({
    reservations: [
      { run_id: "prior", reserved_cents: 4_000 },
      { run_id: "retry", reserved_cents: 6_000 },
    ],
    currentRunId: "retry",
    currentRunCents: 6_000,
  }), 10_000)
  assert.equal(tighterPaymentLimit(50_000, 25_000), 25_000)
  assert.equal(tighterPaymentLimit(25_000, 50_000), 25_000)
  assert.equal(tighterPaymentLimit(null, null), null)
})

test("H1 overpayment and retainage: payable cash never exceeds the open obligation", () => {
  const bill = { payable_type: "bill", total_cents: 100_000, paid_cents: 95_000, retainage_cents: 10_000, retainage_released_cents: 5_000 }
  assert.equal(payableHeldRetainageCents(bill), 5_000)
  assert.equal(payableOutstandingCents(bill), 0, "paid plus held retainage cannot create a negative payable")
  const originalOutstanding = payableOutstandingCents({ ...bill, paid_cents: 80_000 })
  assert.equal(originalOutstanding, 10_000, "released retainage does not become payable again on the original bill")
  const releaseOutstanding = payableOutstandingCents({ payable_type: "bill", total_cents: 5_000, paid_cents: 0, retainage_cents: 0 })
  assert.equal(originalOutstanding + releaseOutstanding + payableHeldRetainageCents(bill), 20_000,
    "original obligation, separate retainage release, and remaining held retainage conserve unpaid principal")
})

test("H1 credits: vendor credits reduce reporting but are never payable cash", () => {
  const credit = { payable_type: "vendor_credit", total_cents: -25_000, project_amount_cents: -25_000 }
  assert.equal(isVendorCredit(credit), true)
  assert.equal(payableOutstandingCents(credit), 0)
  assert.equal(payableHeldRetainageCents({ ...credit, retainage_cents: 5_000 }), 0)
  assert.deepEqual(summarizePayables([
    { payable_type: "bill", total_cents: 100_000, paid_cents: 20_000 },
    credit,
  ]), { outstandingCents: 80_000, settledCents: 20_000, vendorCreditsCents: 25_000 })
})

test("Phase F run routing: the best covering approver entry wins", () => {
  const result = evaluateRunApprovability({
    viewerId: "approver",
    requestedBy: "preparer",
    totalDebitCents: 75_000,
    runDivisionIds: ["east"],
    controlSnapshot: { preferred_approver_ids: ["approver"] },
    routing: {
      viewerMayApprove: true,
      approvers: [
        { userId: "approver", permitted: true, approvalLimitCents: 50_000, divisionId: null },
        { userId: "approver", permitted: true, approvalLimitCents: 100_000, divisionId: "east" },
      ],
    },
  })
  assert.deepEqual(result, { mayDecide: true, blockedReason: null })
  assert.deepEqual(selectedApproverIds({ preferred_approver_ids: ["approver", 42] }), ["approver"])
})

test("Phase F run routing: quorum, self-approval, limits and divisions fail closed", () => {
  const base = { preparerId: "preparer", totalDebitCents: 10_000, requiredApprovals: 2, runDivisionIds: ["east"], controlSnapshot: { policy: { requester_may_approve: false } } }
  assert.equal(evaluateRunSubmissionReadiness({ ...base, routing: { rosterConfigured: false, approvers: [] } }).approvable, false)
  assert.equal(evaluateRunSubmissionReadiness({ ...base, routing: { rosterConfigured: true, approvers: [
    { userId: "one", permitted: true, approvalLimitCents: null, divisionId: "east" },
    { userId: "two", permitted: true, approvalLimitCents: 10_000, divisionId: "east" },
  ] } }).approvable, true)
})

test("Phase F copy: approved money states never collapse into 'sent'", () => {
  assert.equal(readReleaseKind("released"), "released")
  assert.equal(readReleaseKind("executed"), "none")
  assert.equal(formatReleaseDate("2026-09-14"), "September 14, 2026")
  assert.match(approvedReleaseSentence({ eventType: "payment_run_approved", release: "blocked", releaseReason: "risk review" }), /held: risk review/)
  assert.match(approvedReleaseSentence({ eventType: "payment_run_approved", release: "scheduled", releaseScheduledFor: "2026-09-14" }), /September 14, 2026/)
  assert.match(approvedReleaseSentence({ eventType: "payment_run_approved", release: "released" }), /funding started/)
})

test("Phase F copy: batch subjects and exact amounts survive every notification branch", () => {
  const facts = { eventType: "payment_run_submitted", billCount: 5, totalDebitCents: 123_456 }
  assert.equal(paymentRunSubject(facts), "5 vendor bills")
  assert.deepEqual(paymentRunNotificationCopy(facts), {
    title: "Payment needs your approval: $1,234.56",
    message: "5 vendor bills. Open it to review the bill and release the payment.",
  })
  assert.match(paymentRunNotificationCopy({ ...facts, eventType: "payment_run_rejected", reason: "Duplicate" }).message, /Duplicate/)
})

test("Phase F bulk approval: five bills notify exactly their three submitters", () => {
  const bills = ["alice", "bob", "alice", "carol", "bob"]
  const deliveries = bills.flatMap((submitter) => resolvePayableDecisionAudience({
    eligibleRecipients: ["alice", "bob", "carol", "finance"],
    payloadSubmitterId: submitter,
  }))
  assert.deepEqual(deliveries, bills)
  assert.deepEqual(new Set(deliveries), new Set(["alice", "bob", "carol"]))
})

test("Phase D stage vocabulary distinguishes debit, transit, payout and return", () => {
  assert.deepEqual(disbursementStage("debit_pending"), { label: "Builder debited", index: 1, terminal: false })
  assert.deepEqual(disbursementStage("payout_pending"), { label: "Transfer to vendor", index: 3, terminal: false })
  assert.deepEqual(disbursementStage("returned_after_transfer"), { label: "Returned", index: 3, terminal: true })
  assert.deepEqual(vendorPaymentStage({ disbursementStatus: "payout_pending" }), { label: "In transit", settled: false })
  assert.deepEqual(vendorPaymentStage({ method: "credit" }), { label: "Credit applied", settled: true })
})

test("Phase G enqueue mapping is provider-neutral and rejects unknown ledger types", () => {
  assert.equal(accountingPushTypeForLedgerType("bill"), "vendor_bill")
  assert.equal(accountingPushTypeForLedgerType("vendor_credit"), "vendor_bill")
  assert.equal(accountingPushTypeForLedgerType("bill_payment"), "bill_payment")
  assert.equal(accountingPushTypeForLedgerType("mystery"), null)
})

test("Phase G sync truth: only durable external identity reads as synced evidence", () => {
  assert.equal(hasAccountingExternalId(syncState()), false)
  assert.equal(hasAccountingExternalId(syncState({ externalId: "external-1" })), true)
  assert.equal(invoiceIsFromAccountingProvider({ metadata: { source_type: "qbo" } }), true)
  assert.equal(invoiceIsFromAccountingProvider({ metadata: { source_type: "unknown" } }), false)
  assert.equal(invoiceIsFromAccountingProvider({}, syncState({ externalId: "external-1" })), true)
})

test("Phase G bill-payment state follows the latest payment for each bill", () => {
  const first = syncState({ externalId: "pay-1" })
  const second = syncState({ status: "needs_review", statusReason: "connection_unhealthy" })
  assert.deepEqual(indexLatestBillPaymentSyncByBillId(
    { "bill-1": "payment-1", "bill-2": "payment-2", "bill-3": "missing" },
    { "payment-1": first, "payment-2": second },
  ), { "bill-1": first, "bill-2": second })
})

test("money primitives reject fractional and non-positive cents", () => {
  assert.equal(assertIntegerCents(1, "amount"), 1)
  assert.equal(assertIntegerCents(0, "amount", { allowZero: true }), 0)
  assert.throws(() => assertIntegerCents(1.5, "amount"), /integer number of cents/)
  assert.equal(canTransitionDisbursement("funds_available", "transfer_claimed"), true)
  assert.equal(canTransitionDisbursement("paid", "submitted"), false)
})
