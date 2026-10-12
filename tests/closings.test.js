"use strict"

/**
 * `lib/services/closings.ts` — settling a home: who the closing invoice bills,
 * and what stops two settlements from billing it twice.
 *
 * The money services settlement calls (invoices, payments, deposit
 * application, Books) are replaced at their module seams; their own suites
 * cover them. What is asserted here is what settlement hands them and when it
 * refuses to.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const CLOSING = id(1)
const HOME = id(2)
const CONTRACT = id(3)
const BUYER = id(4)
const PROJECT_CLIENT = id(5)
const DEPOSIT_INVOICE = id(6)
const DEPOSIT_PAYMENT = id(7)

let active = null
const calls = { invoices: [], depositApplications: [], payments: [], reversals: [], credits: [] }

stubModule("@/lib/services/closing-readiness", {
  authorizeClosingProject: async () => {},
  assertClosingReadiness: async () => {},
})
stubModule("@/lib/services/invoices", {
  createInvoice: async ({ input }) => {
    calls.invoices.push(input)
    if (active.createInvoice) return active.createInvoice(input)
    const invoice = { id: id(50), org_id: ORG, project_id: input.project_id, total_cents: 400_000_00, metadata: input.metadata }
    active.service.db.invoices.push(invoice)
    return invoice
  },
})
stubModule("@/lib/services/payments", {
  recordPayment: async (payment) => {
    calls.payments.push(payment)
    throw new Error("stop after the balance payment")
  },
  recordPaymentReversal: async (reversal) => {
    calls.reversals.push(reversal)
  },
})
stubModule("@/lib/services/receivable-adjustments", {
  createReceivableAdjustment: async (adjustment) => {
    calls.credits.push(adjustment)
  },
})
stubModule("@/lib/services/books/projector", { projectJournal: async () => ({ failures: [] }) })
stubModule("@/lib/services/books/customer-deposits", {
  applyCustomerDepositWithContext: async (_context, application) => {
    calls.depositApplications.push(application)
  },
})
stubModule("@/lib/services/receivables-writer", { receivablesWriter: () => active.service.client })

const { composePurchaseAgreementPricing } = require("@/lib/financials/purchase-agreement-pricing")
const { buildSettlement, reverseClosing, settleClosing } = freshRequire("lib/services/closings.ts")

/** One signed version of the agreement, as the database's version triggers write it. */
function version(number, row) {
  return { id: id(90 + number), org_id: ORG, project_id: HOME, contract_id: CONTRACT, version_number: number, executed_at: "2026-09-01T00:00:00Z", change_order: null, ...row }
}

/** A change order the buyer signed after the agreement: the next version. */
function amendment(service, { changeOrderId, title, deltaCents, contractId = CONTRACT }) {
  const chain = service.db.purchase_agreement_versions.filter((row) => row.contract_id === contractId)
  const head = chain[chain.length - 1]
  service.db.purchase_agreement_versions.push(version(head.version_number + 1, {
    id: id(100 + service.db.purchase_agreement_versions.length), contract_id: contractId, kind: "amendment", change_order_id: changeOrderId,
    price_delta_cents: deltaCents, authorized_total_cents: head.authorized_total_cents + deltaCents,
    change_order: { id: changeOrderId, title, metadata: {} },
  }))
}

function harness() {
  calls.invoices = []
  calls.depositApplications = []
  calls.payments = []
  calls.reversals = []
  calls.credits = []
  const pricing = composePurchaseAgreementPricing({ basePriceCents: 400_000_00, lotPremiumCents: 0 })
  const service = createServiceHarness({
    permissions: ["closing.manage", "payment.release", "sales.read"],
    projects: [HOME],
    rpc: { reverse_books_home_closing: (args) => ({ data: { closingId: args.p_closing_id, projectId: HOME, inventoryEntryId: null, warrantyEntryId: null }, error: null }) },
    tables: {
      closings: [
        { id: CLOSING, org_id: ORG, project_id: HOME, status: "cleared_to_close", metadata: {}, project: { name: "Lot 12" }, lot: { lot_number: "12" } },
      ],
      projects: [{ id: HOME, org_id: ORG, client_id: PROJECT_CLIENT }],
      contracts: [
        {
          id: CONTRACT,
          org_id: ORG,
          project_id: HOME,
          contract_type: "purchase_agreement",
          status: "active",
          total_cents: 400_000_00,
          buyer_contact_id: BUYER,
          snapshot: { purchase_agreement: { pricing } },
        },
      ],
      contacts: [
        { id: BUYER, org_id: ORG, full_name: "Signing Buyer", email: "buyer@example.test" },
        { id: PROJECT_CLIENT, org_id: ORG, full_name: "Someone Else", email: "else@example.test" },
      ],
      invoices: [
        { id: DEPOSIT_INVOICE, org_id: ORG, project_id: HOME, title: "Earnest deposit", metadata: { invoice_kind: "earnest_deposit" } },
      ],
      payments: [
        { id: DEPOSIT_PAYMENT, org_id: ORG, invoice_id: DEPOSIT_INVOICE, status: "succeeded", amount_cents: 10_000_00, created_at: "2026-09-01T00:00:00Z", metadata: {} },
      ],
      payment_reversals: [],
      purchase_agreement_versions: [version(1, { kind: "original", change_order_id: null, price_delta_cents: 400_000_00, authorized_total_cents: 400_000_00 })],
    },
  })
  active = { service, createInvoice: null }
  return service
}

const settle = (service) =>
  service.run(() =>
    settleClosing({ closingId: CLOSING, actualDate: "2026-10-09", paymentMethod: "wire", paymentReference: "Wire 0042" }),
  )

describe("settleClosing", () => {
  test("the closing invoice bills the buyer who signed the agreement, not the project's current client", async () => {
    const service = harness()
    await assert.rejects(settle(service), /stop after the balance payment/)

    assert.equal(calls.invoices.length, 1)
    assert.equal(calls.invoices[0].customer_id, BUYER)
    assert.equal(calls.invoices[0].customer_name, "Signing Buyer")
    assert.deepEqual(calls.invoices[0].sent_to_emails, ["buyer@example.test"])
    assert.deepEqual(calls.depositApplications.map((row) => row.depositPaymentId), [DEPOSIT_PAYMENT])
    assert.equal(calls.payments[0].amount_cents, 390_000_00)
  })

  test("a settlement that loses the race to bill the home stops before any money moves", async () => {
    const service = harness()
    active.createInvoice = () => {
      throw new Error('Failed to create invoice: duplicate key value violates unique constraint "invoices_closing_source_unique"')
    }
    await assert.rejects(settle(service), /already being settled/)
    assert.deepEqual(calls.depositApplications, [])
    assert.deepEqual(calls.payments, [])
  })

  test("a deposit that cannot be marked settled stops the settlement before the balance is recorded", async () => {
    const service = harness()
    service.tamper("invoices", replies.error("invoices unavailable"), { on: "update" })
    await assert.rejects(settle(service), /mark deposit invoice .* settled: invoices unavailable/)
    assert.deepEqual(calls.payments, [])
  })
})

describe("what a closing bills and collects", () => {
  test("an agreement total the pricing snapshot does not support is refused before anything is billed", async () => {
    const service = harness()
    service.db.contracts[0].total_cents = 410_000_00
    Object.assign(service.db.purchase_agreement_versions[0], { price_delta_cents: 410_000_00, authorized_total_cents: 410_000_00 })
    await assert.rejects(settle(service), /Closing invoice lines total 40000000 but the settlement final price is 41000000/)
    assert.deepEqual(calls.invoices, [])
    assert.deepEqual(calls.depositApplications, [])
    assert.deepEqual(calls.payments, [])
  })

  test("an issued invoice that does not total the final price stops settlement before any deposit or cash moves", async () => {
    const service = harness()
    active.createInvoice = (input) => {
      const invoice = { id: id(50), org_id: ORG, project_id: input.project_id, total_cents: 399_999_99, metadata: input.metadata }
      service.db.invoices.push(invoice)
      return invoice
    }
    await assert.rejects(settle(service), /totals 39999999 cents but the final price is 40000000 cents/)
    assert.deepEqual(calls.depositApplications, [])
    assert.deepEqual(calls.payments, [])
  })

  test("the closing invoice bills the full final price, adjustments and approved changes included, as exact cents", async () => {
    const service = harness()
    amendment(service, { changeOrderId: id(60), title: "Pool prep", deltaCents: 3_000_00 })
    service.db.closings[0].metadata = { adjustments: [{ id: "credit", label: "Closing-cost assistance", kind: "seller_credit", amountCents: -6_000_01 }] }
    active.createInvoice = (input) => {
      const total = input.lines.reduce((sum, line) => sum + Math.round(line.unit_cost * 100), 0)
      const invoice = { id: id(50), org_id: ORG, project_id: input.project_id, total_cents: total, metadata: input.metadata }
      service.db.invoices.push(invoice)
      return invoice
    }
    await assert.rejects(settle(service), /stop after the balance payment/)

    const billed = calls.invoices[0].lines.reduce((sum, line) => sum + Math.round(line.unit_cost * 100), 0)
    assert.equal(billed, 400_000_00 + 3_000_00 - 6_000_01)
    assert.equal(calls.invoices[0].metadata.settlement.finalPriceCents, billed)
    assert.equal(calls.payments[0].amount_cents, billed - 10_000_00)
  })

  test("a retry after an interruption resumes the closing invoice it already issued instead of billing again", async () => {
    const service = harness()
    await assert.rejects(settle(service), /stop after the balance payment/)
    assert.equal(calls.invoices.length, 1)
    assert.equal(service.db.invoices.filter((invoice) => invoice.metadata.invoice_kind === "closing").length, 1)

    await assert.rejects(settle(service), /stop after the balance payment/)
    assert.equal(calls.invoices.length, 1, "no second closing invoice")
    assert.equal(service.db.invoices.filter((invoice) => invoice.metadata.invoice_kind === "closing").length, 1)
  })

  test("a deposit counts at what the buyer still has: refunds and deposits applied elsewhere come off", async () => {
    const service = harness()
    const settlement = () => service.run(() => buildSettlement(CLOSING))
    assert.deepEqual((await settlement()).depositsApplied.map((deposit) => deposit.amountCents), [10_000_00])

    service.db.payment_reversals.push({ id: id(70), org_id: ORG, payment_id: DEPOSIT_PAYMENT, amount_cents: 2_500_00, status: "succeeded" })
    const refunded = await settlement()
    assert.deepEqual(refunded.depositsApplied.map((deposit) => deposit.amountCents), [7_500_00])
    assert.equal(refunded.balanceDueCents, 400_000_00 - 7_500_00)

    service.db.payment_reversals[0].status = "failed"
    assert.deepEqual((await settlement()).depositsApplied.map((deposit) => deposit.amountCents), [10_000_00], "a failed refund returned nothing")

    service.db.payments.push({ id: id(71), org_id: ORG, invoice_id: id(72), status: "succeeded", amount_cents: 4_000_00, created_at: "2026-09-02T00:00:00Z", metadata: { deposit_payment_id: DEPOSIT_PAYMENT, customer_deposit_application: true }, payment_reversals: [] })
    assert.deepEqual((await settlement()).depositsApplied.map((deposit) => deposit.amountCents), [6_000_00])

    service.db.payments.push({ id: id(73), org_id: ORG, invoice_id: id(74), status: "succeeded", amount_cents: 6_000_00, created_at: "2026-09-02T00:00:00Z", metadata: { deposit_payment_id: DEPOSIT_PAYMENT, customer_deposit_application: true }, payment_reversals: [] })
    const spent = await settlement()
    assert.deepEqual(spent.depositsApplied, [])
    assert.equal(spent.balanceDueCents, 400_000_00)
  })
})

describe("the price a closing settles", () => {
  const settlement = (service) => service.run(() => buildSettlement(CLOSING))

  test("is the agreement's signed versions: a prior buyer's amendments and unsigned changes are not this sale's price", async () => {
    const service = harness()
    // A prior buyer's agreement on the same home, voided after its own amendment.
    service.db.purchase_agreement_versions.push(
      version(1, { id: id(120), contract_id: id(121), kind: "original", change_order_id: null, price_delta_cents: 395_000_00, authorized_total_cents: 395_000_00 }),
      version(2, { id: id(122), contract_id: id(121), kind: "amendment", change_order_id: id(123), price_delta_cents: 20_000_00, authorized_total_cents: 415_000_00, change_order: { id: id(123), title: "Prior buyer's pool", metadata: {} } }),
    )
    amendment(service, { changeOrderId: id(60), title: "Upgraded kitchen", deltaCents: 12_500_00 })
    amendment(service, { changeOrderId: id(61), title: "Deleted fireplace", deltaCents: -3_000_00 })

    const result = await settlement(service)
    assert.equal(result.finalPriceCents, 409_500_00)
    assert.deepEqual(result.changeOrders.map((row) => [row.id, row.total_cents]), [[id(60), 12_500_00], [id(61), -3_000_00]])
  })

  test("a version history with a gap or a total that does not follow its changes is refused", async () => {
    const service = harness()
    amendment(service, { changeOrderId: id(60), title: "Upgraded kitchen", deltaCents: 12_500_00 })
    service.db.purchase_agreement_versions[1].authorized_total_cents = 420_000_00
    await assert.rejects(settlement(service), /authorized totals do not follow/)
    service.db.purchase_agreement_versions[1].authorized_total_cents = 412_500_00
    service.db.purchase_agreement_versions[1].version_number = 3
    await assert.rejects(settlement(service), /version history is broken/)
  })

  test("an agreement whose original version disagrees with its signed price is not settled", async () => {
    const service = harness()
    service.db.purchase_agreement_versions[0].authorized_total_cents = 399_000_00
    service.db.purchase_agreement_versions[0].price_delta_cents = 399_000_00
    await assert.rejects(settlement(service), /original version does not match its signed price/)
  })
})

describe("reverseClosing", () => {
  const CLOSING_INVOICE = id(50)
  const CASH = id(81)
  const APPLIED = id(82)
  const reverse = (service) => service.run(() => reverseClosing({ closingId: CLOSING, reason: "Buyer financing fell through", date: "2026-10-15" }))

  function closedClosing() {
    const service = harness()
    Object.assign(service.db.closings[0], { status: "closed", closing_invoice_id: CLOSING_INVOICE })
    service.db.invoices.push({ id: CLOSING_INVOICE, org_id: ORG, project_id: HOME, total_cents: 400_000_00, metadata: { invoice_kind: "closing" } })
    service.db.payments.push(
      { id: CASH, org_id: ORG, invoice_id: CLOSING_INVOICE, status: "succeeded", amount_cents: 390_000_00, metadata: {}, payment_reversals: [] },
      { id: APPLIED, org_id: ORG, invoice_id: CLOSING_INVOICE, status: "succeeded", amount_cents: 10_000_00, metadata: { customer_deposit_application: true, deposit_payment_id: DEPOSIT_PAYMENT }, payment_reversals: [] },
    )
    service.db.receivable_adjustments = []
    return service
  }

  test("cash is refunded, deposit applications return to the buyer's deposit, and the sale is credited out of revenue", async () => {
    const service = closedClosing()
    await reverse(service)

    assert.deepEqual(
      calls.reversals.map((reversal) => [reversal.paymentId, reversal.amountCents, reversal.reversalType]),
      [[CASH, 390_000_00, "refund"], [APPLIED, 10_000_00, "correction"]],
    )
    assert.deepEqual(calls.credits.map((credit) => [credit.invoiceId, credit.adjustmentType, credit.amountCents]), [[CLOSING_INVOICE, "credit_memo", 400_000_00]])
    assert.deepEqual(service.events.map((event) => event.eventType), ["closing_reversed"])
  })

  test("an interrupted reversal resumes with only what is still open", async () => {
    const service = closedClosing()
    const payment = (paymentId) => service.db.payments.find((row) => row.id === paymentId)
    payment(CASH).payment_reversals = [{ amount_cents: 390_000_00, status: "succeeded" }]
    payment(APPLIED).payment_reversals = [{ amount_cents: 4_000_00, status: "pending" }, { amount_cents: 1_000_00, status: "failed" }]
    service.db.receivable_adjustments.push({ org_id: ORG, invoice_id: CLOSING_INVOICE, adjustment_type: "credit_memo", status: "posted", amount_cents: 150_000_00 })
    await reverse(service)

    assert.deepEqual(calls.reversals.map((reversal) => [reversal.paymentId, reversal.amountCents]), [[APPLIED, 6_000_00]])
    assert.deepEqual(calls.credits.map((credit) => credit.amountCents), [250_000_00])
  })

  test("a closing that was never recorded cannot be reversed, and a reason is required", async () => {
    const open = harness()
    await assert.rejects(reverse(open), /Only a recorded closing/)
    const closed = closedClosing()
    await assert.rejects(closed.run(() => reverseClosing({ closingId: CLOSING, reason: "short", date: "2026-10-15" })), /Say why/)
    assert.deepEqual([calls.reversals, calls.credits], [[], []])
  })
})
