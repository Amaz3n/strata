"use strict"

/** The late-fee cron (`app/api/jobs/late-fees/route.ts`). */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

process.env.CRON_SECRET = "cron-secret"
const { GET } = freshRequire("app/api/jobs/late-fees/route.ts")

const RULE = id(1)
const OVERDUE = id(2)
const OTHER_OVERDUE = id(3)
const IN_GRACE = id(4)

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

function invoice(invoiceId, dueDaysAgo, balance) {
  return {
    id: invoiceId,
    org_id: ORG,
    project_id: null,
    status: "sent",
    due_date: daysAgo(dueDaysAgo),
    balance_due_cents: balance,
    total_cents: balance,
  }
}

/** A 1.5% rule with a 10-day grace period; `fail` names invoices whose fee the database refuses. */
function lateFees({ fail = [] } = {}) {
  const applied = []
  const service = createServiceHarness({
    tables: {
      late_fees: [{ id: RULE, org_id: ORG, project_id: null, strategy: "percent", percent_rate: 1.5, grace_days: 10 }],
      invoices: [invoice(OVERDUE, 30, 100000), invoice(OTHER_OVERDUE, 20, 50000), invoice(IN_GRACE, 5, 70000)],
      late_fee_applications: [],
      job_runs: [],
    },
    rpc: {
      apply_invoice_late_fee_atomic: (args) => {
        if (fail.includes(args.p_invoice_id)) return { data: null, error: { message: "Invoice is locked" } }
        applied.push([args.p_invoice_id, args.p_amount_cents])
        return { data: null, error: null }
      },
    },
  })
  return { service, applied }
}

function request(token = "cron-secret") {
  return new Request("https://arc.test/api/jobs/late-fees", { headers: { authorization: `Bearer ${token}` } })
}

test("overdue invoices past the grace period are charged their percentage fee", async () => {
  const { service, applied } = lateFees()

  const response = await service.run(() => GET(request()))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { applied: 2, failed: 0, failures: [] })
  assert.deepEqual(applied.sort(), [
    [OVERDUE, 1500],
    [OTHER_OVERDUE, 750],
  ].sort())
})

test("a fee the database refuses is reported per invoice as a partial failure", async () => {
  const { service, applied } = lateFees({ fail: [OVERDUE] })

  const response = await service.run(() => GET(request()))

  assert.equal(response.status, 207)
  const body = await response.json()
  assert.equal(body.applied, 1)
  assert.deepEqual(body.failures, [
    { invoice_id: OVERDUE, rule_id: RULE, amount_cents: 1500, error: "Invoice is locked" },
  ])
  assert.deepEqual(applied, [[OTHER_OVERDUE, 750]])
})

test("a request without the cron secret charges nothing", async () => {
  const { service, applied } = lateFees()
  const response = await service.run(() => GET(request("wrong")))
  assert.equal(response.status, 401)
  assert.deepEqual(applied, [])
})

test.todo("a failed read of prior applications must not charge past max_applications") // route.ts:46 ignores the count error, so count=null→0 and the RPC (no cap of its own) charges again with a 200
test.todo("a failed overdue-invoice read must fail the run, not report 200 with nothing applied") // route.ts:37 ignores the invoices query error
