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
const calls = { invoices: [], depositApplications: [], payments: [] }

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
  recordPaymentReversal: async () => {},
})
stubModule("@/lib/services/books/customer-deposits", {
  applyCustomerDepositWithContext: async (_context, application) => {
    calls.depositApplications.push(application)
  },
})
stubModule("@/lib/services/receivables-writer", { receivablesWriter: () => active.service.client })

const { composePurchaseAgreementPricing } = require("@/lib/financials/purchase-agreement-pricing")
const { settleClosing } = freshRequire("lib/services/closings.ts")

function harness() {
  calls.invoices = []
  calls.depositApplications = []
  calls.payments = []
  const pricing = composePurchaseAgreementPricing({ basePriceCents: 400_000_00, lotPremiumCents: 0 })
  const service = createServiceHarness({
    permissions: ["closing.manage", "payment.release", "sales.read"],
    projects: [HOME],
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
      change_orders: [],
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
