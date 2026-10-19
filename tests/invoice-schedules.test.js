"use strict"

/**
 * Recurring billing (`runDueInvoiceSchedules`): every due schedule produces at
 * most one invoice per occurrence, even when two cron runs overlap, and a
 * failed invoice gives the occurrence back instead of skipping it.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { stubModule, freshRequire } = require("./support/modules")

// Creating the invoice itself is the invoices service's contract; here it is
// the boundary whose calls and failures the runner must handle.
let created = []
let failNextCreate = false
stubModule("@/lib/services/invoices", {
  createInvoice: async ({ input, context }) => {
    await Promise.resolve()
    if (failNextCreate) {
      failNextCreate = false
      throw new Error("Invoice numbering unavailable")
    }
    created.push({ input, context })
    return { id: `invoice-${created.length}` }
  },
  getInvoiceWithLines: async () => null,
})
stubModule("@/lib/services/accounting-target", { resolveAccountingTarget: async () => null })

const { createServiceHarness, id, ORG } = require("./support/service")

const { runDueInvoiceSchedules } = freshRequire("lib/services/invoice-schedules.ts")

const SCHEDULE = id(1)
const CREATOR = id(2)
const TODAY = new Date("2026-10-01T12:00:00")

function schedules() {
  created = []
  failNextCreate = false
  return createServiceHarness({
    tables: {
      invoice_schedules: [
        {
          id: SCHEDULE,
          org_id: ORG,
          project_id: null,
          frequency: "monthly",
          day_of_month: 1,
          next_run_on: "2026-10-01",
          active: true,
          auto_send: false,
          recipient_email: null,
          created_by: CREATOR,
          last_invoice_id: null,
          template: {
            title: "Monthly retainer",
            payment_terms_days: 30,
            lines: [{ description: "Retainer", quantity: 1, unit_cost: 1500 }],
          },
          org: { product_tier: "commercial" },
        },
      ],
      invoices: [{ id: id(3), org_id: ORG, invoice_number: "1041", created_at: "2026-09-01T00:00:00Z" }],
    },
  })
}

const schedule = (service) => service.db.invoice_schedules[0]

test("a due schedule creates one invoice as its creator and moves to the next occurrence", async () => {
  const service = schedules()

  const results = await service.run(() => runDueInvoiceSchedules(TODAY))

  assert.deepEqual(results, [{ scheduleId: SCHEDULE, status: "created", invoiceId: "invoice-1", invoiceNumber: "1042" }])
  const [{ input, context }] = created
  assert.equal(context.userId, CREATOR)
  assert.equal(input.issue_date, "2026-10-01")
  assert.equal(input.due_date, "2026-10-31")
  assert.equal(input.issue, false)
  assert.equal(schedule(service).next_run_on, "2026-11-01")
  assert.equal(schedule(service).last_invoice_id, "invoice-1")
})

test("overlapping runs bill an occurrence once", async () => {
  const service = schedules()

  const [first, second] = await service.run(() =>
    Promise.all([runDueInvoiceSchedules(TODAY), runDueInvoiceSchedules(TODAY)]),
  )

  assert.equal(created.length, 1)
  assert.deepEqual(
    [...first, ...second].map((result) => result.status).sort(),
    ["created", "failed"],
  )
  assert.equal(schedule(service).next_run_on, "2026-11-01")
})

test("a failed invoice gives the occurrence back so the next run bills it", async () => {
  const service = schedules()
  failNextCreate = true

  const [failed] = await service.run(() => runDueInvoiceSchedules(TODAY))
  assert.equal(failed.status, "failed")
  assert.match(failed.error, /numbering unavailable/)
  assert.equal(schedule(service).next_run_on, "2026-10-01")
  assert.equal(schedule(service).last_invoice_id, null)

  const [retried] = await service.run(() => runDueInvoiceSchedules(TODAY))
  assert.equal(retried.status, "created")
  assert.equal(created.length, 1)
})
