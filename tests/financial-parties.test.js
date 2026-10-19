"use strict"

/**
 * A customer's receivables (`getFinancialPartyReceivables`): what they were
 * billed, what they paid and what they still owe, across their projects and
 * their general (no-project) billing.
 *
 * Invoice and project listing are their own services with their own suites, so
 * they are replaced with the rows they would return; everything else — the
 * permission check, the payment and credit reads, and the money arithmetic — is
 * the real service against the fake database.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const CLIENT = id(1)
const OTHER_CUSTOMER = id(2)
const JOB = id(3)

let invoices = []
stubModule("@/lib/services/projects", {
  listProjects: async () => [{ id: JOB, name: "Job", client_id: CLIENT, total_contract_value_cents: 10000 }],
})
stubModule("@/lib/services/invoices", {
  listInvoicePage: async (options) => ({
    hasMore: false,
    invoices: options.projectId
      ? invoices.filter((invoice) => invoice.project_id === options.projectId)
      : invoices.filter(
          (invoice) => !invoice.project_id && options.generalCustomerIds.includes(invoice.metadata.customer_id),
        ),
  }),
})

const { getFinancialPartyReceivables } = freshRequire("lib/services/financial-parties.ts")

const reversal = (overrides) => ({ status: "succeeded", reversal_type: "refund", created_at: "2026-01-04", ...overrides })
const payment = (overrides) => ({ org_id: ORG, status: "succeeded", received_at: "2026-01-03", metadata: {}, payment_reversals: [], ...overrides })

function seed() {
  invoices = [
    // A project invoice belongs to the project's client whatever its bill-to says.
    { id: "job-invoice", project_id: JOB, status: "partial", total_cents: 10000, balance_due_cents: 3000, metadata: { customer_id: OTHER_CUSTOMER }, issue_date: "2026-01-01" },
    { id: "general-invoice", project_id: null, status: "partial", total_cents: 5000, balance_due_cents: 2000, metadata: { customer_id: CLIENT }, issue_date: "2026-01-02" },
    { id: "other-general", project_id: null, status: "sent", total_cents: 9000, balance_due_cents: 9000, metadata: { customer_id: OTHER_CUSTOMER }, issue_date: "2026-01-02" },
  ]
  return createServiceHarness({
    permissions: ["directory.read"],
    tables: {
      contacts: [{ id: CLIENT, org_id: ORG }],
      payments: [
        payment({ id: "p1", invoice_id: "job-invoice", amount_cents: 6000 }),
        payment({ id: "p2", invoice_id: "general-invoice", amount_cents: 4000, payment_reversals: [reversal({ id: "r2", amount_cents: 1000 })] }),
      ],
      receivable_adjustments: [
        { id: "c1", org_id: ORG, invoice_id: "job-invoice", adjustment_type: "credit_memo", status: "posted", amount_cents: 1000, effective_date: "2026-01-03", reason: "Discount" },
      ],
    },
  })
}

const receivables = (service) =>
  service.run(() => getFinancialPartyReceivables({ partyType: "contact", partyId: CLIENT }))

test("a customer's account combines project and general billing, net of refunds, without counting credits as cash", async () => {
  const service = seed()
  const summary = await receivables(service)

  assert.equal(summary.invoiced_cents, 15000)
  assert.equal(summary.collected_cents, 9000)
  assert.equal(summary.outstanding_cents, 5000)
  assert.equal(summary.invoice_count, 2)
  assert.equal(summary.projects[0].collected_cents, 6000)

  const general = summary.activity.find((row) => row.id === "invoice:general-invoice")
  assert.equal(general.project_id, null)
  assert.equal(general.source_href, "/billing?invoice=general-invoice")
  assert.equal(summary.activity.find((row) => row.id === "reversal:r2").amount_cents, -1000)
  assert.ok(!summary.activity.some((row) => row.invoice_id === "other-general"))
  assert.deepEqual(service.writes(), [])
})

test("a deposit is not revenue, and applying it does not collect the cash twice", async () => {
  const service = seed()
  invoices.push({ id: "advance", project_id: null, status: "paid", total_cents: 5000, balance_due_cents: 0, metadata: { customer_id: CLIENT, invoice_kind: "earnest_deposit" }, issue_date: "2026-01-04" })
  invoices[0].balance_due_cents = 1000
  service.db.payments.push(
    payment({ id: "advance-payment", invoice_id: "advance", amount_cents: 5000, received_at: "2026-01-04" }),
    payment({
      id: "application",
      invoice_id: "job-invoice",
      amount_cents: 2000,
      received_at: "2026-01-04",
      metadata: { customer_deposit_application: true, deposit_payment_id: "advance-payment" },
    }),
  )

  const summary = await receivables(service)

  assert.equal(summary.invoiced_cents, 15000)
  assert.equal(summary.collected_cents, 14000)
  assert.equal(summary.available_deposit_cents, 3000)
  assert.equal(summary.invoice_count, 2)
  assert.equal(summary.outstanding_cents, 3000)
  assert.equal(summary.activity.find((row) => row.id === "invoice:advance").kind, "deposit_request")
})

test("an account is refused without directory or org read access", async () => {
  const service = seed()
  service.grant([])
  await assert.rejects(receivables(service))
  assert.equal(service.reads("payments").length, 0)
})
