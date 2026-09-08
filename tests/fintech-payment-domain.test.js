require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  addBusinessHours,
  assertBalancedLedgerEntries,
  assertDisbursementTransition,
  assertPaymentRunTransition,
  classifyReturnStage,
  decideVendorTransferAction,
  isPaymentRunTerminal,
  isSubmissionRecoveryCandidate,
  MAX_SUBMISSION_ATTEMPTS,
  planDisbursementAdvance,
  requesterMayApprovePaymentRun,
  resolveRunItemStatus,
  resolveRunStatus,
  scheduleTransferRelease,
  submissionRetryAt,
} = require("../lib/payments/payment-domain")
const { createPaymentRunContentHash } = require("../lib/payments/payment-run-content-hash")
const {
  DEFAULT_PAYMENT_FEE_POLICY,
  calculatePaymentFeeQuote,
  quoteApDisbursementFee,
} = require("../lib/payments/fee-engine")
const {
  DEFAULT_PAYMENT_HOLD_POLICY,
  assertJurisdictionEnabled,
  evaluatePaymentHoldFacts,
} = require("../lib/payments/payment-hold-policy")
const { evaluateRunSubmissionReadiness, hashableWaiverSnapshot } = require("../lib/payments/payment-run-approval-policy")
const { normalizeBillNumber } = require("../lib/financials/payable-duplicates")
const {
  addBusinessDays,
  estimateSettlement,
  latestReleaseDateFor,
} = require("../lib/payments/settlement-estimate")
const {
  detectExecutionConfigMismatch,
  isPaymentReconciliationStale,
  paymentOperationsAlertDetails,
} = require("../lib/payments/operations-monitor")
const { classifyStripeSubmissionError, stripeApProvider } = require("../lib/integrations/payments/stripe-ap")
const {
  groupStaleStateByOrg,
  hasStalePaymentState,
  isPaymentRunStale,
  stalePaymentStateCutoff,
  NON_TERMINAL_DISBURSEMENT_STATUSES,
  NON_TERMINAL_RUN_STATUSES,
  STALE_PAYMENT_STATE_HOURS,
} = require("../lib/services/payment-stale-state")

function stripeWebhook(type, object, overrides = {}) {
  return {
    id: overrides.id ?? `evt_${type.replaceAll(".", "_")}`,
    type,
    created: 1_786_534_400,
    account: overrides.account,
    data: { object },
  }
}

test("Stripe adapter normalizes vendor debit events before domain processing", async () => {
  const normalized = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "payment_intent.succeeded",
    { id: "pi_vendor_1", metadata: { arc_product: "vendor_payments", charge_type: "vendor_disbursement", disbursement_id: "d1" } },
  ))
  assert.deepEqual(
    {
      kind: normalized.kind,
      provider: normalized.provider,
      providerPaymentId: normalized.providerPaymentId,
      disbursementId: normalized.disbursementId,
      status: normalized.status,
    },
    {
      kind: "disbursement.status",
      provider: "stripe",
      providerPaymentId: "pi_vendor_1",
      disbursementId: "d1",
      status: "funds_available",
    },
  )
})

test("Stripe adapter distinguishes the platform fee debit from vendor money", async () => {
  const normalized = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "payment_intent.payment_failed",
    { id: "pi_fee_1", metadata: { arc_product: "vendor_payments", charge_type: "platform_fee" } },
  ))
  assert.equal(normalized.kind, "fee_charge.status")
  assert.equal(normalized.status, "failed")
  assert.equal(normalized.providerPaymentId, "pi_fee_1")
})

test("Stripe adapter ignores unrelated receivables payment intents", async () => {
  const normalized = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "payment_intent.succeeded",
    { id: "pi_ar_1", metadata: { arc_product: "receivables" } },
  ))
  assert.equal(normalized, null)
})

test("Stripe ACH authorization warnings open inquiries without reversing the payable", async () => {
  const inquiry = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "charge.dispute.created",
    { id: "dui_warning_1", payment_intent: "pi_vendor_1", status: "warning_needs_response", reason: "bank_cannot_process" },
  ))
  assert.equal(inquiry.kind, "disbursement.authorization_inquiry")
  assert.equal(inquiry.providerPaymentId, "pi_vendor_1")

  const returned = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "charge.dispute.created",
    { id: "du_return_1", payment_intent: "pi_vendor_1", status: "needs_response", reason: "fraudulent" },
  ))
  assert.equal(returned.kind, "disbursement.returned")
  assert.equal(returned.providerReversalId, "du_return_1")
})

test("Stripe blocked-bank updates disable the funding source vocabulary", async () => {
  const normalized = await stripeApProvider.normalizeWebhookEvent(stripeWebhook(
    "payment_method.automatically_updated",
    { id: "pm_bank_1", us_bank_account: { status_details: { blocked: { network_code: "R02" } } } },
  ))
  assert.equal(normalized.kind, "funding_source.updated")
  assert.equal(normalized.providerPaymentMethodId, "pm_bank_1")
  assert.equal(normalized.blocked, true)
})

test("payout holds count US bank-business hours, including observed holidays", () => {
  assert.equal(addBusinessHours("2026-07-02T16:00:00.000Z", 48).toISOString(), "2026-07-07T16:00:00.000Z")
  assert.equal(addBusinessHours("2026-12-31T16:00:00.000Z", 24).toISOString(), "2027-01-04T16:00:00.000Z")
})

test("returns are classified by whether vendor funds have left Arc", () => {
  for (const status of ["created", "submitted", "debit_pending", "funds_available"]) {
    assert.equal(classifyReturnStage(status), "pre_transfer", status)
  }
  for (const status of ["transfer_claimed", "transfer_pending", "payout_pending", "returned_after_transfer"]) {
    assert.equal(classifyReturnStage(status), "post_transfer", status)
  }
  assert.equal(classifyReturnStage("paid"), "post_payout")
  assert.throws(() => classifyReturnStage("returned"), /terminal disbursement status/)
})

test("ambiguous submission recovery is bounded to the published schedule", () => {
  const start = "2026-09-01T12:00:00.000Z"
  assert.equal(MAX_SUBMISSION_ATTEMPTS, 5)
  assert.equal(submissionRetryAt(1, start), "2026-09-01T12:02:00.000Z")
  assert.equal(submissionRetryAt(2, start), "2026-09-01T12:05:00.000Z")
  assert.equal(submissionRetryAt(3, start), "2026-09-01T12:15:00.000Z")
  assert.equal(submissionRetryAt(4, start), "2026-09-01T13:00:00.000Z")
  assert.equal(submissionRetryAt(5, start), null)
  assert.equal(isSubmissionRecoveryCandidate({ status: "created", submissionAttempts: 2, nextSubmissionAt: "2026-09-01T11:59:00.000Z", now: start }), true)
  assert.equal(isSubmissionRecoveryCandidate({ status: "created", submissionAttempts: 5, nextSubmissionAt: "2026-09-01T11:59:00.000Z", now: start }), false)
  assert.equal(isSubmissionRecoveryCandidate({ status: "submitted", submissionAttempts: 1, nextSubmissionAt: "2026-09-01T11:59:00.000Z", now: start }), false)
})

test("Stripe submission errors separate definitive rejection from ambiguity", () => {
  assert.equal(classifyStripeSubmissionError({ type: "StripeInvalidRequestError", code: "resource_missing" }), "definitive")
  assert.equal(classifyStripeSubmissionError({ type: "StripeCardError", decline_code: "payment_method_customer_decline" }), "definitive")
  assert.equal(classifyStripeSubmissionError({ type: "StripeConnectionError" }), "ambiguous")
  assert.equal(classifyStripeSubmissionError(new Error("socket timeout")), "ambiguous")
})


test("a payment environment that cannot release names itself, with a remedy", () => {
  const healthy = { executionEnabled: true, reconciliationEnabled: true, liveModeApproved: false, mode: "test" }
  assert.equal(detectExecutionConfigMismatch(healthy), null)

  // Execution off is a deliberate posture, not a fault: nothing is expected to
  // move, so there is nothing to alert about.
  assert.equal(detectExecutionConfigMismatch({ ...healthy, executionEnabled: false, reconciliationEnabled: false }), null)

  // The production state that failed the money tick 5,741 times in twenty days
  // without producing a single alert.
  const stuck = detectExecutionConfigMismatch({ ...healthy, reconciliationEnabled: false })
  assert.equal(stuck.code, "payment_execution_config_mismatch")
  assert.match(stuck.detail, /FINTECH_PAYMENTS_RECONCILIATION_ENABLED/)
  assert.match(stuck.remedy, /Set FINTECH_PAYMENTS_RECONCILIATION_ENABLED=true/)

  const unset = detectExecutionConfigMismatch({ ...healthy, mode: null })
  assert.match(unset.detail, /FINTECH_PAYMENTS_MODE is unset/)
  const nonsense = detectExecutionConfigMismatch({ ...healthy, mode: "sandbox" })
  assert.match(nonsense.detail, /"sandbox"/)

  // Live credentials without the recorded approval: the adapter refuses every
  // submission, so the environment is misconfigured rather than merely cautious.
  const unapprovedLive = detectExecutionConfigMismatch({ ...healthy, mode: "live", liveModeApproved: false })
  assert.match(unapprovedLive.detail, /FINTECH_PAYMENTS_LIVE_MODE_APPROVED/)
  assert.equal(detectExecutionConfigMismatch({ ...healthy, mode: "live", liveModeApproved: true }), null)
})

test("stale payment-operation emails include the state counts", () => {
  assert.deepEqual(paymentOperationsAlertDetails({
    reason: "stale_payment_state",
    stale_disbursements: 1,
    stale_runs: 2,
    threshold_hours: 96,
  }), ["1 disbursement and 2 payment runs have remained in a non-terminal state for more than 96 hours."])
})

test("disbursement state transitions are monotonic with explicit return paths", () => {
  assert.doesNotThrow(() => assertDisbursementTransition("created", "submitted"))
  assert.doesNotThrow(() => assertDisbursementTransition("paid", "returned"))
  assert.throws(() => assertDisbursementTransition("paid", "submitted"), /Invalid disbursement transition/)
  assert.throws(() => assertDisbursementTransition("failed", "paid"), /Invalid disbursement transition/)
})

test("payment runs cannot skip approval or reopen terminal states", () => {
  assert.doesNotThrow(() => assertPaymentRunTransition("draft", "pending_approval"))
  assert.doesNotThrow(() => assertPaymentRunTransition("pending_approval", "approved"))
  assert.throws(() => assertPaymentRunTransition("draft", "processing"), /Invalid payment run transition/)
  assert.throws(() => assertPaymentRunTransition("paid", "draft"), /Invalid payment run transition/)
  // Runs are immutable after creation: there is no return to draft. A material
  // change means cancel + rebuild, and the content hash rejects stale copies.
  assert.throws(() => assertPaymentRunTransition("pending_approval", "draft"), /Invalid payment run transition/)
})


test("ledger postings must balance in one currency using integer cents", () => {
  assert.deepEqual(assertBalancedLedgerEntries([
    { accountCode: "vendor_payable", direction: "debit", amountCents: 10_000, currency: "usd" },
    { accountCode: "ach_clearing", direction: "credit", amountCents: 10_000, currency: "usd" },
  ]), { debits: 10_000, credits: 10_000, currency: "usd" })
  assert.throws(() => assertBalancedLedgerEntries([
    { accountCode: "vendor_payable", direction: "debit", amountCents: 10_000, currency: "usd" },
    { accountCode: "ach_clearing", direction: "credit", amountCents: 9_999, currency: "usd" },
  ]), /out of balance/)
})

test("payment-run content hashes are stable across object key order", () => {
  assert.equal(
    createPaymentRunContentHash({ items: [{ amount: 100, bill: "a" }], funding: "x" }),
    createPaymentRunContentHash({ funding: "x", items: [{ bill: "a", amount: 100 }] }),
  )
})

test("existing AR quotes remain unchanged and AP defaults to pass-through only", () => {
  const ach = calculatePaymentFeeQuote({ invoiceBalanceCents: 100_000, method: "ach", policy: DEFAULT_PAYMENT_FEE_POLICY })
  assert.equal(ach.feeCents, 500)
  assert.equal(ach.totalCents, 100_500)

  const card = calculatePaymentFeeQuote({ invoiceBalanceCents: 100_000, method: "card", policy: DEFAULT_PAYMENT_FEE_POLICY })
  assert.equal(card.feeCents, 3_018)
  assert.equal(card.totalCents, 103_018)

  assert.deepEqual(quoteApDisbursementFee({ vendorAmountCents: 100_000, estimatedProcessorFeeCents: 800 }), {
    kind: "ap_disbursement",
    payer: "org",
    vendorAmountCents: 100_000,
    processorFeeCents: 800,
    platformFeeCents: 0,
    debitAmountCents: 100_000,
    accruedFeeCents: 800,
    description: "Provider processing costs passed through at cost, collected once per run",
  })
})


test("a bill only holds on a lien waiver when policy actually requires one", () => {
  const baseFacts = {
    projectId: "11111111-1111-1111-1111-111111111111",
    companyId: "22222222-2222-2222-2222-222222222222",
    complianceCurrent: true,
    insuranceCurrent: true,
    waiverSigned: false,
    retainageRulesMet: true,
    fundingRequired: false,
    fundingReceived: true,
    overrides: {},
    policy: DEFAULT_PAYMENT_HOLD_POLICY,
  }

  // require_lien_waiver off and no sub-tier rule: nothing to sign, nothing to hold.
  const notRequired = evaluatePaymentHoldFacts({ ...baseFacts, waiverRequired: false })
  assert.equal(notRequired.holds.some((hold) => hold.kind === "waiver_signed"), false)
  assert.equal(notRequired.releasable, true)

  // Turn the requirement on and the same unsigned bill blocks.
  const required = evaluatePaymentHoldFacts({ ...baseFacts, waiverRequired: true })
  const waiverHold = required.holds.find((hold) => hold.kind === "waiver_signed")
  assert.ok(waiverHold)
  assert.equal(waiverHold.level, "block")
  assert.equal(required.releasable, false)

  // Signing it clears the hold.
  assert.equal(
    evaluatePaymentHoldFacts({ ...baseFacts, waiverRequired: true, waiverSigned: true }).releasable,
    true,
  )
})


test("settlement estimates skip weekends across both ACH legs", () => {
  // Fri 2026-08-07 + 1 business day is Mon 2026-08-10, not Sat the 8th.
  assert.equal(addBusinessDays("2026-08-07", 1), "2026-08-10")
  // Zero days from a Saturday still lands on the next banking day.
  assert.equal(addBusinessDays("2026-08-08", 0), "2026-08-10")
  assert.equal(addBusinessDays("2026-08-03", 0), "2026-08-03")

  const window = { debitBusinessDays: { min: 4, max: 5 }, payoutBusinessDays: { min: 1, max: 2 } }
  const estimate = estimateSettlement({ initiatedOn: "2026-08-03", window })
  // Mon + 5 business days = Mon the 10th; + 7 = Wed the 12th.
  assert.equal(estimate.vendorReceivesEarliest, "2026-08-10")
  assert.equal(estimate.vendorReceivesLatest, "2026-08-12")
  assert.equal(estimate.maxBusinessDays, 7)
  // The window is always a range, never a single promised date.
  assert.ok(estimate.vendorReceivesEarliest < estimate.vendorReceivesLatest)
})

test("the latest release date that still pays a bill on time is the estimate run backwards", () => {
  const window = { debitBusinessDays: { min: 4, max: 5 }, payoutBusinessDays: { min: 1, max: 2 } }
  const release = latestReleaseDateFor("2026-08-12", window)
  assert.equal(release, "2026-08-03")
  // Round-tripping must not slip past the due date.
  assert.ok(estimateSettlement({ initiatedOn: release, window }).vendorReceivesLatest <= "2026-08-12")
})


// ---------------------------------------------------------------------------
// Provider-event behaviour.
//
// The QA list in the fintech gameplan (§8, Phase 4) is mostly about what happens
// when provider events arrive wrong: twice, out of order, or after the payment
// already ended. Those decisions are pure, so they are tested as decisions
// rather than mocked round-trips through Supabase and Stripe.
// ---------------------------------------------------------------------------

test("a duplicate provider event advances nothing", () => {
  // Stripe re-delivers on any non-2xx, and the handler is expected to be a no-op.
  assert.deepEqual(planDisbursementAdvance("paid", "paid"), [])
  assert.deepEqual(planDisbursementAdvance("funds_available", "funds_available"), [])
  assert.deepEqual(planDisbursementAdvance("returned", "returned"), [])
})

test("an out-of-order provider event never walks a disbursement backwards", () => {
  // transfer.created arriving after payout.paid is routine, not an error.
  assert.deepEqual(planDisbursementAdvance("paid", "transfer_pending"), [])
  assert.deepEqual(planDisbursementAdvance("payout_pending", "debit_pending"), [])
  assert.deepEqual(planDisbursementAdvance("funds_available", "submitted"), [])
})

test("a payout event fills in the legs its webhooks skipped, in order", () => {
  // Webhooks drop. Jumping submitted -> paid must still pass through every
  // intermediate state so no transition assertion is bypassed.
  assert.deepEqual(planDisbursementAdvance("submitted", "paid"), [
    "debit_pending",
    "funds_available",
    "transfer_claimed",
    "transfer_pending",
    "payout_pending",
    "paid",
  ])
  for (const [index, next] of planDisbursementAdvance("submitted", "paid").entries()) {
    const from = index === 0 ? "submitted" : planDisbursementAdvance("submitted", "paid")[index - 1]
    assert.doesNotThrow(() => assertDisbursementTransition(from, next))
  }
})

test("a return that lands before the paid event makes the payment terminal", () => {
  // Money came back. A late payout.paid must not resurrect it.
  assert.deepEqual(planDisbursementAdvance("returned", "paid"), [])
  assert.deepEqual(planDisbursementAdvance("failed", "paid"), [])
  assert.deepEqual(planDisbursementAdvance("canceled", "funds_available"), [])
  assert.deepEqual(planDisbursementAdvance("reversed", "paid"), [])
})

test("a run item is never reported paid on an absence of payees", () => {
  // `[].every()` is true, so the natural phrasing concludes "paid" from no
  // evidence at all and closes a bill nobody paid.
  assert.equal(resolveRunItemStatus([], "failed"), "processing")
  assert.equal(resolveRunStatus([]), "processing")
})

test("run item status reflects what actually happened to each payee", () => {
  assert.equal(resolveRunItemStatus(["paid", "paid"], "failed"), "paid")
  assert.equal(resolveRunItemStatus(["paid", "failed"], "failed"), "partially_paid")
  assert.equal(resolveRunItemStatus(["failed", "returned"], "returned"), "returned")
  // Still in flight: one payee unresolved means the item is not terminal.
  assert.equal(resolveRunItemStatus(["paid", "processing"], "failed"), "partially_paid")
  assert.equal(resolveRunItemStatus(["processing", "failed"], "failed"), "processing")
})

test("a run that paid some bills and failed others is partially_failed, not paid", () => {
  assert.equal(resolveRunStatus(["paid", "paid"]), "paid")
  assert.equal(resolveRunStatus(["paid", "failed"]), "partially_failed")
  assert.equal(resolveRunStatus(["partially_paid", "returned"]), "partially_failed")
  assert.equal(resolveRunStatus(["failed", "canceled"]), "failed")
  assert.equal(resolveRunStatus(["paid", "processing"]), "partially_paid")
  assert.equal(resolveRunStatus(["processing", "processing"]), "processing")
  assert.equal(isPaymentRunTerminal(["paid", "returned", "failed"]), true)
  assert.equal(isPaymentRunTerminal(["paid", "processing"]), false)
  assert.equal(isPaymentRunTerminal([]), false)
})

test("every planned advance is a legal transition", () => {
  const statuses = [
    "created", "submitted", "debit_pending", "funds_available",
    "transfer_pending", "payout_pending", "paid", "failed", "returned", "reversed", "canceled",
  ]
  for (const from of statuses) {
    for (const to of statuses) {
      const path = planDisbursementAdvance(from, to)
      let cursor = from
      for (const next of path) {
        // A plan that produced an illegal hop would throw here rather than in
        // production, mid-webhook, with money already moved.
        assert.doesNotThrow(
          () => assertDisbursementTransition(cursor, next),
          `${from} -> ${to} planned an illegal hop ${cursor} -> ${next}`,
        )
        cursor = next
      }
      if (path.length > 0) assert.equal(cursor, to, `${from} -> ${to} did not land on its target`)
    }
  }
})


test("a return arriving before settlement routes through funds_available on its own", () => {
  // The illegal hop this guards against — created -> returned — was previously
  // avoided only by a hand-written pre-walk in the webhook handler. The planner
  // owns it now, so no future call site has to remember.
  assert.deepEqual(planDisbursementAdvance("created", "returned"), [
    "submitted",
    "debit_pending",
    "funds_available",
    "returned",
  ])
  assert.deepEqual(planDisbursementAdvance("debit_pending", "returned"), ["funds_available", "returned"])
  assert.deepEqual(planDisbursementAdvance("paid", "returned"), ["returned"])

  // A failure before settlement is legal directly and must not be padded out.
  assert.deepEqual(planDisbursementAdvance("created", "failed"), ["failed"])

  // Cancelling once funds are available is not reachable without an illegal hop,
  // so the plan is empty rather than a forced transition.
  assert.deepEqual(planDisbursementAdvance("funds_available", "canceled"), [])
})


// ---------------------------------------------------------------------------
// Fees are accrued, never debited.
//
// The debit has to equal what the vendor receives, or the bank feed line and the
// accounting entry disagree on every single payment and a bookkeeper hand-codes
// the remainder forever.
// ---------------------------------------------------------------------------

test("an AP quote debits the vendor amount and accrues the fees separately", () => {
  const quote = quoteApDisbursementFee({ vendorAmountCents: 100_000, estimatedProcessorFeeCents: 800 })
  assert.equal(quote.vendorAmountCents, 100_000)
  assert.equal(quote.debitAmountCents, 100_000, "the debit must equal what the vendor receives")
  assert.equal(quote.processorFeeCents, 800)
  assert.equal(quote.platformFeeCents, 0)
  assert.equal(quote.accruedFeeCents, 800)
  // The lumped total that used to be added to the debit is gone entirely.
  assert.equal("totalDebitCents" in quote, false)
})

test("a platform markup accrues too, and still never reaches the debit", () => {
  const quote = quoteApDisbursementFee({
    vendorAmountCents: 100_000,
    estimatedProcessorFeeCents: 800,
    policy: { passThroughProcessorFees: true, platformFeeFlatCents: 150, platformFeeBps: 0 },
  })
  assert.equal(quote.debitAmountCents, 100_000)
  assert.equal(quote.accruedFeeCents, 950)
})


test("an Arc fee is capped, so a large progress payment cannot be charged without limit", () => {
  const uncapped = quoteApDisbursementFee({
    vendorAmountCents: 50_000_000,
    estimatedProcessorFeeCents: 500,
    policy: { passThroughProcessorFees: true, platformFeeFlatCents: 0, platformFeeBps: 80, platformFeeCapCents: null },
  })
  assert.equal(uncapped.platformFeeCents, 400_000)

  const capped = quoteApDisbursementFee({
    vendorAmountCents: 50_000_000,
    estimatedProcessorFeeCents: 500,
    policy: { passThroughProcessorFees: true, platformFeeFlatCents: 0, platformFeeBps: 80, platformFeeCapCents: 500 },
  })
  assert.equal(capped.platformFeeCents, 500, "an uncapped bps fee on an ACH rail is the bug the cap exists to prevent")
  assert.equal(capped.accruedFeeCents, 1_000)
  assert.equal(capped.debitAmountCents, 50_000_000)
})


// ---------------------------------------------------------------------------
// Construction AP.
// ---------------------------------------------------------------------------

const {
  calculateEarlyPayDiscount,
  discountStillEarnable,
  readEarlyPayTerms,
} = require("../lib/payments/early-pay-discount")

test("an early-pay discount rounds down so a vendor is never underpaid", () => {
  // 2/10 net 30 on $1,000.05 — the discount must not round up, or the payment
  // lands a cent short, the bill stays open, and lien rights stay alive.
  const discount = calculateEarlyPayDiscount({
    billDate: "2026-08-04",
    outstandingCents: 100_005,
    terms: { discountPercent: 2, discountDays: 10 },
  })
  assert.equal(discount.discountCents, 2_000)
  assert.equal(discount.netAmountCents, 98_005)
  assert.equal(discount.discountCents + discount.netAmountCents, 100_005)
  assert.equal(discount.discountByDate, "2026-08-14")
})

test("the discount is earned by the date the vendor receives the money", () => {
  // Releasing on the last discount day misses it: the rail takes days. This is
  // the whole reason the deadline is checked against the settlement estimate
  // rather than against the release date alone.
  assert.equal(
    discountStillEarnable({ discountByDate: "2026-08-14", releaseDate: "2026-08-14", vendorReceivesLatest: "2026-08-20" }),
    false,
  )
  assert.equal(
    discountStillEarnable({ discountByDate: "2026-08-14", releaseDate: "2026-08-05", vendorReceivesLatest: "2026-08-12" }),
    true,
  )
})

test("half a discount term is a bug, not an absent discount", () => {
  assert.equal(readEarlyPayTerms({ early_pay_discount_percent: null, early_pay_discount_days: null }), null)
  assert.deepEqual(readEarlyPayTerms({ early_pay_discount_percent: 2, early_pay_discount_days: 10 }), {
    discountPercent: 2,
    discountDays: 10,
  })
  assert.throws(() => readEarlyPayTerms({ early_pay_discount_percent: 2, early_pay_discount_days: null }), /both a percentage and a number of days/)
})


// ---------------------------------------------------------------------------
// Step-up policy and approval scope.
// ---------------------------------------------------------------------------

const { evaluatePaymentStepUp, PAYMENT_STEP_UP_MAX_AGE_SECONDS } = require("../lib/payments/step-up-policy")

test("step-up requires aal2 and a genuine second factor", () => {
  const now = 1_800_000_000
  assert.equal(evaluatePaymentStepUp({ assuranceLevel: "aal1", methods: [], nowSeconds: now }).reason, "not_aal2")

  // `otp` is Supabase's name for an emailed magic-link code — a primary factor.
  // Counting it would let mailbox access approve payments.
  assert.equal(
    evaluatePaymentStepUp({
      assuranceLevel: "aal2",
      methods: [{ method: "otp", timestamp: now - 5 }, { method: "password", timestamp: now - 5 }],
      nowSeconds: now,
    }).reason,
    "no_second_factor",
  )

  const good = evaluatePaymentStepUp({
    assuranceLevel: "aal2",
    methods: [{ method: "password", timestamp: now - 900 }, { method: "totp", timestamp: now - 60 }],
    nowSeconds: now,
  })
  assert.equal(good.satisfied, true)
  assert.equal(good.verifiedAt, new Date((now - 60) * 1000).toISOString())
})

test("step-up expires, and a future timestamp is not evidence of anything", () => {
  const now = 1_800_000_000
  assert.equal(
    evaluatePaymentStepUp({
      assuranceLevel: "aal2",
      methods: [{ method: "totp", timestamp: now - PAYMENT_STEP_UP_MAX_AGE_SECONDS - 1 }],
      nowSeconds: now,
    }).reason,
    "expired",
  )
  // Clock skew or a forged claim — either way, not proof of a recent challenge.
  assert.equal(
    evaluatePaymentStepUp({ assuranceLevel: "aal2", methods: [{ method: "totp", timestamp: now + 600 }], nowSeconds: now }).reason,
    "expired",
  )
})


// ---------------------------------------------------------------------------
// Certificate-of-insurance reading
//
// The insurance hold blocks payment, so these tests are mostly about the
// degrade paths: every way a reading can be absent, stale or untrustworthy has
// to land back on the status-and-expiry rule that shipped before any model was
// involved. A model failure may not release a payment, and it may not stop one.
// ---------------------------------------------------------------------------

const {
  buildCoiExtractionInputKey,
  evaluateInsuranceCurrency,
  isCoiPolicyCurrent,
  isInsuranceDocumentTypeName,
} = require("../lib/payments/ap-verification")

const TODAY = "2026-08-08"

function reading(overrides = {}) {
  return {
    carrier_name: "Ironshore",
    policy_number: "GL-4417",
    policy_type: "general_liability",
    each_occurrence_cents: 100_000_000,
    aggregate_cents: 200_000_000,
    effective_date: "2026-01-01",
    expiry_date: "2026-12-31",
    additional_insured: true,
    certificate_holder: "Arc Builders",
    confidence: "high",
    notes: [],
    file_id: "file-1",
    model: "gemini-flash",
    extracted_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  }
}

function document(overrides = {}) {
  return { status: "approved", storedExpiry: null, fileId: "file-1", extraction: null, ...overrides }
}

test("a vendor with no insurance document falls through to overall compliance", () => {
  assert.deepEqual(evaluateInsuranceCurrency({ documents: [], todayIso: TODAY, fallbackCompliant: true }), {
    current: true,
    contradiction: null,
    basis: "no_documents",
  })
  assert.equal(
    evaluateInsuranceCurrency({ documents: [], todayIso: TODAY, fallbackCompliant: false }).current,
    false,
  )
})

test("without a reading the insurance fact is exactly the pre-extraction rule", () => {
  const cases = [
    [document(), true, "approved with no recorded expiry passes, as it always has"],
    [document({ storedExpiry: "2026-12-31" }), true, "approved and unexpired passes"],
    [document({ storedExpiry: "2026-01-01" }), false, "approved but expired fails"],
    [document({ status: "pending_review" }), false, "an unapproved certificate is not coverage"],
    [document({ status: "rejected", storedExpiry: "2027-01-01" }), false, "a rejected certificate is not coverage"],
  ]
  for (const [doc, expected, message] of cases) {
    const verdict = evaluateInsuranceCurrency({ documents: [doc], todayIso: TODAY, fallbackCompliant: true })
    assert.equal(verdict.current, expected, message)
    assert.equal(verdict.basis, "stored")
  }
})

test("one current certificate is still enough", () => {
  const verdict = evaluateInsuranceCurrency({
    documents: [document({ storedExpiry: "2026-01-01" }), document({ storedExpiry: "2027-01-01" })],
    todayIso: TODAY,
    fallbackCompliant: false,
  })
  assert.equal(verdict.current, true)
})

test("a lapsed certificate is reported loudly but never blocks on the reading alone", () => {
  // The record says current because nobody typed a date in; the certificate
  // says otherwise. That disagreement is worth a human's attention, but a
  // model must not be able to stop a subcontractor being paid by itself.
  const verdict = evaluateInsuranceCurrency({
    documents: [document({ extraction: reading({ expiry_date: "2026-03-01" }) })],
    todayIso: TODAY,
    fallbackCompliant: true,
  })
  assert.equal(verdict.current, true, "the blocking fact still comes from the compliance record")
  assert.equal(verdict.basis, "extracted")
  assert.match(verdict.contradiction, /expired 2026-03-01/)
})

test("a certificate that has not taken effect yet is reported, not enforced", () => {
  const verdict = evaluateInsuranceCurrency({
    documents: [document({ extraction: reading({ effective_date: "2026-10-01", expiry_date: "2027-10-01" }) })],
    todayIso: TODAY,
    fallbackCompliant: true,
  })
  assert.equal(verdict.current, true)
  assert.match(verdict.contradiction, /not effective until 2026-10-01/)
})

test("the compliance record decides blocking and the reading is surfaced beside it", () => {
  // A person looked at the page and committed to a date. The model's date is
  // evidence for them to re-check, never an override in either direction.
  const stillCurrent = evaluateInsuranceCurrency({
    documents: [document({ storedExpiry: "2027-01-01", extraction: reading({ expiry_date: "2026-03-01" }) })],
    todayIso: TODAY,
    fallbackCompliant: true,
  })
  assert.equal(stillCurrent.current, true, "the stored expiry keeps the payment releasable")
  assert.match(stillCurrent.contradiction, /expires 2026-03-01, the recorded expiry is 2027-01-01/)

  const blocked = evaluateInsuranceCurrency({
    documents: [document({ storedExpiry: "2026-03-01", extraction: reading({ expiry_date: "2027-01-01" }) })],
    todayIso: TODAY,
    fallbackCompliant: true,
  })
  assert.equal(blocked.current, false, "the stored expiry blocks even when the model reads a later one")
  assert.match(blocked.contradiction, /expires 2027-01-01, the recorded expiry is 2026-03-01/)
})

test("a reading that cannot be trusted degrades to the stored rule and never blocks", () => {
  const degraded = [
    // The file was replaced; the reading describes a page nobody is looking at.
    document({ extraction: reading({ file_id: "file-2", expiry_date: "2026-03-01" }) }),
    // The model said it was guessing.
    document({ extraction: reading({ confidence: "low", expiry_date: "2026-03-01" }) }),
    // The certificate has no date on it that the model could find.
    document({ extraction: reading({ expiry_date: null }) }),
  ]
  for (const doc of degraded) {
    const verdict = evaluateInsuranceCurrency({ documents: [doc], todayIso: TODAY, fallbackCompliant: true })
    assert.equal(verdict.current, true, "an untrustworthy reading must not turn a passing bill into a blocked one")
  }
})

test("isCoiPolicyCurrent needs a date on both ends of the window", () => {
  assert.equal(isCoiPolicyCurrent({ effective_date: "2026-01-01", expiry_date: "2026-12-31" }, TODAY), true)
  assert.equal(isCoiPolicyCurrent({ effective_date: null, expiry_date: "2026-12-31" }, TODAY), true)
  assert.equal(isCoiPolicyCurrent({ effective_date: null, expiry_date: null }, TODAY), false)
  assert.equal(isCoiPolicyCurrent({ effective_date: null, expiry_date: TODAY }, TODAY), true, "expiring today is still today")
})

test("the extraction cache key moves only when the file does", () => {
  const base = buildCoiExtractionInputKey({ fileId: "file-1", fileUpdatedAt: "2026-08-01T00:00:00.000Z" })
  assert.equal(base, buildCoiExtractionInputKey({ fileId: "file-1", fileUpdatedAt: "2026-08-01T00:00:00.000Z" }))
  assert.notEqual(base, buildCoiExtractionInputKey({ fileId: "file-1", fileUpdatedAt: "2026-08-02T00:00:00.000Z" }))
  assert.notEqual(base, buildCoiExtractionInputKey({ fileId: "file-2", fileUpdatedAt: "2026-08-01T00:00:00.000Z" }))
})

test("the insurance document filter is the same one the hold always used", () => {
  for (const name of ["General Liability Insurance", "Certificate of Insurance", "COI", "workers comp certificate"]) {
    assert.equal(isInsuranceDocumentTypeName(name), true, name)
  }
  for (const name of ["W-9", "Business License", null, undefined, ""]) {
    assert.equal(isInsuranceDocumentTypeName(name), false, String(name))
  }
})


test("a document-derived claim can raise its hand but never stop a payment", () => {
  // Both AI-backed hold kinds are clamped to warn regardless of policy. This is
  // the invariant that keeps a misread certificate or waiver from stranding a
  // subcontractor: the model reports, a human decides.
  const facts = {
    projectId: "p1",
    companyId: "c1",
    complianceCurrent: true,
    insuranceCurrent: true,
    insuranceContradiction: "The scanned certificate expired 2026-03-01 but the record shows insurance as current",
    waiverRequired: true,
    waiverSigned: true,
    waiverVerification: { matches: false, mismatchSummary: "Amount: expected $1,000, found $900", documentHref: null },
    retainageRulesMet: true,
    fundingRequired: false,
    fundingReceived: true,
    overrides: {},
    // Even asked directly to block, these two may not.
    policy: { insurance_verified: "block", waiver_verified: "block" },
  }

  const evaluation = evaluatePaymentHoldFacts(facts)
  const kinds = evaluation.holds.map((hold) => hold.kind)
  assert.ok(kinds.includes("insurance_verified"), "the certificate disagreement is visible")
  assert.ok(kinds.includes("waiver_verified"), "the waiver mismatch is visible")
  for (const kind of ["insurance_verified", "waiver_verified"]) {
    assert.equal(evaluation.holds.find((hold) => hold.kind === kind).level, "warn", `${kind} must never block`)
  }
  assert.equal(evaluation.blockingCount, 0)
  assert.equal(evaluation.releasable, true, "a payment with only document-derived claims still releases")
})

test("a genuinely lapsed compliance record still blocks, model or no model", () => {
  const evaluation = evaluatePaymentHoldFacts({
    projectId: "p1",
    companyId: "c1",
    complianceCurrent: true,
    insuranceCurrent: false,
    insuranceContradiction: null,
    waiverRequired: false,
    waiverSigned: false,
    retainageRulesMet: true,
    fundingRequired: false,
    fundingReceived: true,
    overrides: {},
    policy: {},
  })
  const insurance = evaluation.holds.find((hold) => hold.kind === "insurance_current")
  assert.equal(insurance.level, "block")
  assert.equal(evaluation.releasable, false)
})


test("electronic-payment jurisdictions fail closed for other and unknown states", () => {
  const policy = { enabled_jurisdictions: ["FL"] }
  assert.deepEqual(assertJurisdictionEnabled(policy, { location: { state: "fl" } }), { enabled: true, state: "FL" })
  assert.equal(assertJurisdictionEnabled(policy, { location: { state: "GA" } }).reason, "jurisdiction_not_enabled")
  assert.equal(assertJurisdictionEnabled(policy, { location: {} }).reason, "jurisdiction_unknown")
})

test("commitment-wide context is informational while bill facts bind the run hash", () => {
  const base = { jurisdiction: "FL", bill: { bill_id: "b1", amount_cents: 1000 }, commitment: { billedCents: 1000, varianceCents: 9000 } }
  const laterInvoice = { ...base, commitment: { billedCents: 2000, varianceCents: 8000 } }
  assert.equal(createPaymentRunContentHash(hashableWaiverSnapshot(base)), createPaymentRunContentHash(hashableWaiverSnapshot(laterInvoice)))
  assert.notEqual(createPaymentRunContentHash(hashableWaiverSnapshot(base)), createPaymentRunContentHash(hashableWaiverSnapshot({ ...base, bill: { bill_id: "b1", amount_cents: 1001 } })))
})


test("run submission identifies every zero-quorum configuration", () => {
  const base = { preparerId: "preparer", totalDebitCents: 5000, requiredApprovals: 1, runDivisionIds: ["east"], controlSnapshot: { policy: { requester_may_approve: false } } }
  assert.match(evaluateRunSubmissionReadiness({ ...base, routing: { rosterConfigured: false, approvers: [] } }).reason, /No payment approvers/)
  assert.match(evaluateRunSubmissionReadiness({ ...base, routing: { rosterConfigured: true, approvers: [{ userId: "low", permitted: true, approvalLimitCents: 4999, divisionId: null }] } }).reason, /high enough/)
  assert.match(evaluateRunSubmissionReadiness({ ...base, routing: { rosterConfigured: true, approvers: [{ userId: "west", permitted: true, approvalLimitCents: null, divisionId: "west" }] } }).reason, /division/)
  assert.match(evaluateRunSubmissionReadiness({ ...base, routing: { rosterConfigured: true, approvers: [{ userId: "preparer", permitted: true, approvalLimitCents: null, divisionId: null }] } }).reason, /preparer/)
  assert.equal(evaluateRunSubmissionReadiness({ ...base, routing: { rosterConfigured: true, approvers: [{ userId: "approver", permitted: true, approvalLimitCents: 5000, divisionId: "east" }] } }).approvable, true)
})

test("the waiver jurisdiction in a run snapshot comes from the property, not the org policy", () => {
  const { resolveWaiverJurisdiction } = require("../lib/lien-waivers/jurisdiction")
  // A Florida builder's Georgia job is a Georgia waiver. Building the run from
  // the policy and re-verifying from the project is what made every
  // out-of-state payable fail with "waiver or payment facts changed".
  assert.equal(resolveWaiverJurisdiction({ projectLocation: { state: "ga" }, policyDefault: "FL" }), "GA")
  assert.equal(resolveWaiverJurisdiction({ projectLocation: { state: "GA" }, policyDefault: null }), "GA")
  // Only when the property has no state on file does the org default fill in.
  assert.equal(resolveWaiverJurisdiction({ projectLocation: { city: "Naples" }, policyDefault: "FL" }), "FL")
  assert.equal(resolveWaiverJurisdiction({ projectLocation: null, policyDefault: "FL" }), "FL")
  assert.equal(resolveWaiverJurisdiction({ projectLocation: null, policyDefault: null }), null)
  // Both sides of the run therefore hash the same value for the same payable.
  const build = resolveWaiverJurisdiction({ projectLocation: { state: "GA" }, policyDefault: "FL" })
  const reverify = resolveWaiverJurisdiction({ projectLocation: { state: "GA" }, policyDefault: "FL" })
  assert.equal(
    createPaymentRunContentHash(hashableWaiverSnapshot({ jurisdiction: build, bill: { bill_id: "b1" } })),
    createPaymentRunContentHash(hashableWaiverSnapshot({ jurisdiction: reverify, bill: { bill_id: "b1" } })),
  )
})
