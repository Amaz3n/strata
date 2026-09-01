require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { summarizeBillingCycle } = require("../lib/financials/billing-cycle-summary")

const item = (overrides = {}) => ({
  id: "i1",
  state: "needs-review",
  amountCents: 1_000_00,
  ageDays: 0,
  needsCostCode: false,
  needsReceipt: false,
  needsRate: false,
  isBillableCost: false,
  billingPeriodId: null,
  lateToBillingPeriodId: null,
  ...overrides,
})

const readyCost = (overrides = {}) =>
  item({ state: "ready-to-invoice", isBillableCost: true, ...overrides })

test("ready-to-bill counts only billable costs, not the triage rows feeding them", () => {
  const summary = summarizeBillingCycle([
    readyCost({ id: "c1", amountCents: 500_00 }),
    item({ id: "t1", state: "needs-review", amountCents: 900_00 }),
  ])
  assert.equal(summary.readyToInvoiceCount, 1)
  assert.equal(summary.readyToInvoiceCents, 500_00)
  assert.deepEqual(summary.readyCostIds, ["c1"])
})

test("selecting a period scopes ready-to-bill to that period", () => {
  const items = [
    readyCost({ id: "c1", amountCents: 500_00, billingPeriodId: "p1" }),
    readyCost({ id: "c2", amountCents: 700_00, billingPeriodId: "p2" }),
  ]
  const all = summarizeBillingCycle(items)
  assert.equal(all.readyToInvoiceCents, 1_200_00)

  const scoped = summarizeBillingCycle(items, { billingPeriodId: "p1" })
  assert.equal(scoped.readyToInvoiceCents, 500_00)
  assert.deepEqual(scoped.readyCostIds, ["c1"])
})

test("a cost swept late into the selected period still belongs to it", () => {
  const summary = summarizeBillingCycle(
    [readyCost({ id: "c1", amountCents: 400_00, billingPeriodId: "p0", lateToBillingPeriodId: "p1" })],
    { billingPeriodId: "p1" },
  )
  assert.equal(summary.readyToInvoiceCount, 1)
  assert.equal(summary.lateCostCount, 1)
  assert.equal(summary.lateCostCents, 400_00)
})

test("billed rows drop out of every live count", () => {
  const summary = summarizeBillingCycle([
    item({ id: "t1", state: "billed", needsCostCode: true }),
    readyCost({ id: "c1", state: "billed", amountCents: 900_00 }),
  ])
  assert.equal(summary.reviewItemCount, 0)
  assert.equal(summary.readyToInvoiceCents, 0)
  assert.equal(summary.missingCostCodeCount, 0)
})

test("blocker counts report what is actually holding the cycle up", () => {
  const summary = summarizeBillingCycle([
    item({ id: "t1", state: "blocked", needsRate: true }),
    item({ id: "e1", state: "blocked", needsReceipt: true }),
    item({ id: "b1", state: "blocked", needsCostCode: true }),
    item({ id: "t2", state: "awaiting-client-approval" }),
  ])
  assert.equal(summary.blockedCount, 3)
  assert.equal(summary.missingRateCount, 1)
  assert.equal(summary.missingReceiptCount, 1)
  assert.equal(summary.missingCostCodeCount, 1)
  assert.equal(summary.awaitingOwnerApprovalCount, 1)
  assert.equal(summary.reviewItemCount, 4)
})

test("oldest unbilled age comes from ready costs only", () => {
  const summary = summarizeBillingCycle([
    readyCost({ id: "c1", ageDays: 12 }),
    readyCost({ id: "c2", ageDays: 31 }),
    item({ id: "t1", state: "blocked", ageDays: 99 }),
  ])
  assert.equal(summary.oldestReadyCostDays, 31)
})

test("an empty cycle reports zeroes", () => {
  const summary = summarizeBillingCycle([])
  assert.equal(summary.readyToInvoiceCents, 0)
  assert.equal(summary.oldestReadyCostDays, 0)
  assert.deepEqual(summary.readyCostIds, [])
})
