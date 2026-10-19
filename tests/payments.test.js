"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

const { stubModule, freshRequire } = require("./support/modules")

// Who a customer is (which projects and contacts are theirs) is the
// financial-parties service's answer; this suite only consumes it.
let party = { projects: [], included_contact_ids: [] }
stubModule("@/lib/services/financial-parties", {
  getFinancialPartyReceivables: async () => structuredClone(party),
})

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")

const { getReceivePaymentWorkspace, recordMultiInvoicePayment } = freshRequire("lib/services/payments.ts")

const CUSTOMER = id(1)
const OTHER_CUSTOMER = id(2)
const PROJECT = id(3)
const OTHER_PROJECT = id(4)
const GENERAL = id(10)
const JOB = id(11)
const FOREIGN = id(12)

const invoices = [
  {
    id: GENERAL,
    org_id: ORG,
    project_id: null,
    status: "sent",
    total_cents: 10000,
    balance_due_cents: 10000,
    metadata: { customer_id: CUSTOMER, customer_name: "Customer One" },
  },
  {
    id: JOB,
    org_id: ORG,
    project_id: PROJECT,
    status: "sent",
    total_cents: 10000,
    balance_due_cents: 10000,
    metadata: { customer_name: "Bill-to label" },
    project: { id: PROJECT, name: "Job", client_id: CUSTOMER, client: { full_name: "Customer One" } },
  },
  {
    id: FOREIGN,
    org_id: ORG,
    project_id: null,
    status: "sent",
    total_cents: 10000,
    balance_due_cents: 10000,
    metadata: { customer_id: OTHER_CUSTOMER, customer_name: "Other" },
  },
]

function receivables(options = {}) {
  party = { projects: [{ project_id: PROJECT }], included_contact_ids: [CUSTOMER] }
  return createServiceHarness({
    tables: { invoices, projects: [{ id: PROJECT, org_id: ORG }, { id: OTHER_PROJECT, org_id: ORG }] },
    permissions: ["payment.read", "payment.release", "project.read"],
    rpc: {
      apply_multi_invoice_payment_atomic: () => ({
        data: { group: { id: id(50), total_cents: 200 }, items: [], duplicate: true },
        error: null,
      }),
    },
    ...options,
  })
}

const receipt = (invoiceIds, extra = {}) => ({
  received_at: "2026-10-01T12:00:00.000Z",
  method: "check",
  idempotency_key: id(60),
  allocations: invoiceIds.map((invoiceId) => ({ invoice_id: invoiceId, amount_cents: 100 })),
  ...extra,
})

const rpcCalls = (service) => service.queries.filter((query) => query.table === "rpc:apply_multi_invoice_payment_atomic")

test("a customer's receive-payment workspace includes their general and job invoices, and no one else's", async () => {
  const workspace = await receivables().run(() =>
    getReceivePaymentWorkspace({ partyType: "contact", partyId: CUSTOMER }),
  )

  assert.deepEqual(
    workspace.invoices.map((invoice) => [invoice.id, invoice.projectId, invoice.projectName, invoice.customerName]),
    [
      [GENERAL, null, "General billing", "Customer One"],
      [JOB, PROJECT, "Job", "Customer One"],
    ],
  )
  assert.equal(workspace.invoices[0].customerKey, workspace.invoices[1].customerKey)
})

test("one receipt across a customer's general and job invoices is applied atomically as the actor", async () => {
  const service = receivables()

  await service.run(() => recordMultiInvoicePayment(receipt([GENERAL, JOB])))

  const [call] = rpcCalls(service)
  assert.equal(rpcCalls(service).length, 1)
  assert.equal(call.payload.p_org_id, ORG)
  assert.equal(call.payload.p_created_by, ACTOR)
  assert.deepEqual(
    call.payload.p_allocations.map((allocation) => [allocation.invoice_id, allocation.amount_cents]),
    [
      [GENERAL, 100],
      [JOB, 100],
    ],
  )
})

test("a receipt is refused for mixed customers, another customer's invoice, or an invoice the actor cannot release", async () => {
  const cases = [
    { name: "two customers", input: receipt([GENERAL, FOREIGN]), error: /separate receipt/ },
    {
      name: "invoice outside the named customer",
      input: receipt([FOREIGN], { party_type: "contact", party_id: CUSTOMER }),
      error: /does not belong/,
    },
    {
      name: "job invoice outside the actor's projects",
      options: { projects: [OTHER_PROJECT] },
      input: receipt([JOB]),
      error: /Missing permission/,
    },
    {
      name: "general billing with division-limited access",
      options: { divisions: [id(70)] },
      input: receipt([GENERAL]),
      error: /Organization-wide payment access/,
    },
    { name: "an invoice that does not exist", input: receipt([id(99)]), error: /unavailable/ },
  ]
  for (const { name, options, input, error } of cases) {
    const service = receivables(options)
    await assert.rejects(service.run(() => recordMultiInvoicePayment(input)), error, name)
    assert.deepEqual(rpcCalls(service), [], name)
    assert.deepEqual(service.audits, [], name)
  }
})
