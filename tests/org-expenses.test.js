"use strict"

// Expenses across the company (lib/financials/overhead and lib/services/org-expenses):
// a receipt lives on a job, in overhead under a category, or waits to be sorted,
// and moving it between homes moves its cost.

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const {
  OVERHEAD_CATEGORIES,
  expenseApprovalRefusal,
  expenseHome,
  overheadAccountCode,
  suggestJobFromClock,
} = require("@/lib/financials/overhead")
const { draftFromFact } = require("@/lib/services/books/fact-drafts")
const { CONSTRUCTION_CHART_TEMPLATE } = require("@/lib/services/books/chart-of-accounts")

// Job expenses keep their project workbench rules; this suite only sees that they are handed over.
const handedOver = []
const ledger = []
stubModule("@/lib/services/cost-plus", {
  DUPLICATE_EXPENSE_ERROR_PREFIX: "POSSIBLE_DUPLICATE_EXPENSE:",
  createProjectExpense: async (input) => {
    handedOver.push({ kind: "create", input })
    return { id: id(7001) }
  },
  approveProjectExpense: async (expenseId) => handedOver.push({ kind: "approve", expenseId }),
  rejectProjectExpense: async (expenseId) => handedOver.push({ kind: "reject", expenseId }),
  propagateApprovalToLedger: async (args) => ledger.push({ kind: "post", ...args }),
})
stubModule("@/lib/services/job-cost-actuals", {
  voidJobCostEntryForSource: async (args) => ledger.push({ kind: "void", sourceId: args.sourceId }),
})
stubModule("@/lib/services/cost-plus-files", { uploadCostPlusFile: async ({ file }) => (file ? id(8001) : null) })
stubModule("@/lib/services/accounting-sync", { enqueueProjectExpenseSync: async () => undefined })
stubModule("@/lib/services/books/funding", { validateBooksExpensePaymentAccount: async () => undefined })

const { approveOrgExpense, assignExpenseHome, createOrgExpense, loadOrgExpenseDesk } = freshRequire(
  "lib/services/org-expenses.ts",
)

const JOB_A = id(101)
const JOB_B = id(102)
const STAMP = "2026-10-18T12:00:00.000Z"

const expense = (overrides) => ({
  id: id(501),
  org_id: ORG,
  project_id: null,
  overhead_category: null,
  vendor_name_text: "Shell",
  description: "Truck fuel",
  expense_date: "2026-10-18",
  amount_cents: 6400,
  tax_cents: 0,
  payment_method: "company_card",
  status: "submitted",
  receipt_file_id: id(601),
  billable_cost_id: null,
  submitted_by_user_id: ACTOR,
  created_at: STAMP,
  updated_at: STAMP,
  project: null,
  submitter: { id: ACTOR, full_name: "Sam Field" },
  ...overrides,
})

const harness = (rows, permissions = ["org.member", "project.read", "bill.read", "bill.write", "bill.approve"]) =>
  createServiceHarness({
    tables: {
      project_expenses: rows,
      project_expense_lines: [],
      projects: [
        { id: JOB_A, org_id: ORG, name: "Smith kitchen", phase: "delivery", status: "active" },
        { id: JOB_B, org_id: ORG, name: "Oak St panel", phase: "delivery", status: "active" },
      ],
    },
    permissions,
  })

test("every overhead category posts to an operating-expense account the chart actually has", () => {
  const chart = new Map(CONSTRUCTION_CHART_TEMPLATE.map((account) => [account.code, account.accountType]))
  for (const category of OVERHEAD_CATEGORIES) assert.equal(chart.get(overheadAccountCode(category)), "expense", category)
  assert.equal(overheadAccountCode("fuel_vehicles"), "6200")
})

test("an expense lives on a job, in overhead, or waits to be sorted, and only a home can be approved", () => {
  assert.deepEqual(expenseHome({ project_id: JOB_A, overhead_category: null }), { kind: "job", projectId: JOB_A })
  assert.deepEqual(expenseHome({ project_id: null, overhead_category: "tools_equipment" }), { kind: "overhead", category: "tools_equipment" })
  assert.deepEqual(expenseHome({ project_id: null, overhead_category: null }), { kind: "unsorted" })
  assert.match(expenseApprovalRefusal({ project_id: null, overhead_category: null }), /job or an overhead category/)
  assert.equal(expenseApprovalRefusal({ project_id: null, overhead_category: "fuel_vehicles" }), null)
})

test("a receipt with no job is proposed the job its buyer was clocked into", () => {
  const sessions = [
    { projectId: JOB_A, startedAt: "2026-10-18T13:00:00Z", endedAt: "2026-10-18T15:00:00Z" },
    { projectId: JOB_B, startedAt: "2026-10-18T15:30:00Z", endedAt: "2026-10-18T22:00:00Z" },
  ]
  const now = "2026-10-18T23:00:00Z"
  assert.equal(suggestJobFromClock({ at: "2026-10-18T14:10:00Z", sessions, now }), JOB_A)
  // Bought between jobs, or no time on the receipt: the job with the most time that day.
  assert.equal(suggestJobFromClock({ at: "2026-10-18T15:15:00Z", sessions, now }), JOB_B)
  assert.equal(suggestJobFromClock({ at: null, sessions, now }), JOB_B)
  assert.equal(suggestJobFromClock({ at: null, sessions: [], now }), null)
})

test("approved overhead posts to its category's account and credits the card, never job cost", () => {
  const draft = draftFromFact({
    sourceType: "expense",
    sourceId: id(501),
    accountingDate: "2026-10-18",
    payload: {
      memo: "Truck fuel",
      amount_cents: 6400,
      project_id: null,
      payment_account_code: "2100",
      cost_lines: [{ amount_cents: 6400, project_id: null, account_code: overheadAccountCode("fuel_vehicles") }],
    },
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  })
  const net = {}
  for (const line of draft.lines) net[line.accountCode] = (net[line.accountCode] ?? 0) + line.debitCents - line.creditCents
  assert.deepEqual(net, { 6200: 6400, 2100: -6400 })
  assert.ok(draft.lines.every((line) => !line.projectId))
})

test("a receipt captured without a job lands in overhead, and with a job it goes to that job", async () => {
  const service = harness([])
  const created = await service.run(() =>
    createOrgExpense(
      { expense_date: "2026-10-18", amount_cents: 6400, vendor_name: "Shell", overhead_category: "fuel_vehicles", payment_method: "company_card" },
      null,
    ),
  )
  const row = service.db.project_expenses.find((item) => item.id === created.id)
  assert.equal(row.project_id, null)
  assert.equal(row.overhead_category, "fuel_vehicles")
  assert.equal(row.is_billable, false)
  assert.equal(row.status, "submitted")
  assert.equal(service.events[0].eventType, "expense_submitted")

  await service.run(() => createOrgExpense({ expense_date: "2026-10-18", amount_cents: 3200, project_id: JOB_A }, null))
  assert.equal(handedOver.at(-1).kind, "create")
  assert.equal(handedOver.at(-1).input.projectId, JOB_A)

  await assert.rejects(
    service.run(() => createOrgExpense({ expense_date: "2026-10-18", amount_cents: 6400, vendor_name: "Shell" }, null)),
    /POSSIBLE_DUPLICATE_EXPENSE/,
  )
  await assert.rejects(
    service.run(() =>
      createOrgExpense({ expense_date: "2026-10-18", amount_cents: 10, project_id: JOB_A, overhead_category: "rent" }, null),
    ),
    /not both/,
  )
})

test("an unsorted receipt cannot be approved until it has a home", async () => {
  const service = harness([expense()])
  await assert.rejects(service.run(() => approveOrgExpense({ expense_id: id(501) })), /job or an overhead category/)
  const moved = await service.run(() =>
    assignExpenseHome({ expense_id: id(501), expected_updated_at: STAMP, project_id: null, overhead_category: "fuel_vehicles" }),
  )
  service.db.project_expenses[0].updated_at = moved.updatedAt
  await service.run(() => approveOrgExpense({ expense_id: id(501) }))
  assert.equal(service.db.project_expenses[0].status, "approved")
  assert.equal(service.events.at(-1).eventType, "expense_approved")
})

test("moving an approved receipt from overhead to a job posts its job cost, and back voids it; the audit keeps both homes", async () => {
  ledger.length = 0
  const service = harness([expense({ status: "approved", overhead_category: "shop_supplies" })])
  const toJob = await service.run(() =>
    assignExpenseHome({ expense_id: id(501), expected_updated_at: STAMP, project_id: JOB_A, overhead_category: null }),
  )
  const row = service.db.project_expenses[0]
  assert.deepEqual([row.project_id, row.overhead_category, row.is_billable], [JOB_A, null, true])
  assert.deepEqual(ledger, [{ kind: "post", source: "project_expense", sourceId: id(501), orgId: ORG }])
  const audit = service.audits.at(-1)
  assert.equal(audit.before.overhead_category, "shop_supplies")
  assert.equal(audit.after.project_id, JOB_A)
  assert.deepEqual(service.events.at(-1).payload.from_overhead_category, "shop_supplies")

  row.updated_at = toJob.updatedAt
  await service.run(() =>
    assignExpenseHome({ expense_id: id(501), expected_updated_at: toJob.updatedAt, project_id: null, overhead_category: "tools_equipment" }),
  )
  assert.deepEqual(ledger.at(-1), { kind: "void", sourceId: id(501) })

  // An approved cost always keeps a home, and a stale screen never overwrites a newer move.
  await assert.rejects(
    service.run(() => assignExpenseHome({ expense_id: id(501), expected_updated_at: row.updated_at, project_id: null, overhead_category: null })),
    /needs a job or an overhead category/,
  )
  await assert.rejects(
    service.run(() => assignExpenseHome({ expense_id: id(501), expected_updated_at: STAMP, project_id: JOB_B, overhead_category: null })),
    /changed since you opened it/,
  )
})

test("an expense already on a customer's cost-plus billing does not move", async () => {
  const service = harness([expense({ status: "approved", project_id: JOB_A, billable_cost_id: id(701) })])
  await assert.rejects(
    service.run(() => assignExpenseHome({ expense_id: id(501), expected_updated_at: STAMP, project_id: JOB_B, overhead_category: null })),
    /cost-plus billing/,
  )
})

test("the office desk queues every submitted receipt and puts this month's overhead beside job cost", async () => {
  const today = new Date().toISOString().slice(0, 10)
  const service = harness([
    expense({ id: id(511) }),
    expense({ id: id(512), status: "approved", overhead_category: "fuel_vehicles", expense_date: today, amount_cents: 6400 }),
    expense({ id: id(513), status: "approved", project_id: JOB_A, expense_date: today, amount_cents: 20000, tax_cents: 1600, project: { id: JOB_A, name: "Smith kitchen" } }),
    expense({ id: id(514), status: "submitted", project_id: JOB_B, project: { id: JOB_B, name: "Oak St panel" } }),
  ])
  const desk = await service.run(() => loadOrgExpenseDesk({ queue: "review" }))
  assert.deepEqual(desk.rows.map((row) => row.homeLabel).sort(), ["Needs a job or category", "Oak St panel"])
  assert.deepEqual(desk.counts, { review: 2, unsorted: 1, overhead: 1 })
  assert.equal(desk.month.overheadCents, 6400)
  assert.equal(desk.month.jobCostCents, 21600)
  assert.deepEqual(desk.month.byCategory, [{ category: "fuel_vehicles", label: "Fuel and vehicles", cents: 6400 }])

  const reader = harness([expense()], ["org.member"])
  await assert.rejects(reader.run(() => loadOrgExpenseDesk({})), /permission/i)
})
