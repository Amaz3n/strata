const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, recordingService } = require("./support/mobile")

const punchCalls = []
stubModule(
  "app/(app)/projects/[id]/actions.ts",
  recordingService(punchCalls, {
    updateProjectPunchItemAction: (_project, _item, input) => ({
      success: true,
      data: { id: PUNCH, project_id: PROJECT, title: "Door", status: input.status, updated_at: "2026-10-09T12:00:00+00:00" },
    }),
  }),
)

// Boundaries: the object store and the receipt reader.
const uploads = []
stubModule("lib/services/cost-plus-files.ts", {
  async uploadCostPlusFile(input) {
    uploads.push(input)
    return id(777)
  },
})
let scanned = { vendorName: "Shell", expenseDate: null, totalDollars: 40, taxDollars: 3, paymentMethod: "company_card", description: "Fuel", confidence: "high", notes: [] }
stubModule("lib/services/document-extraction.ts", {
  async extractExpenseReceiptFromFile() {
    return scanned
  },
})

const { updateMobilePunchStatus, updateMobileTaskStatus } = freshRequire("lib/mobile/field.ts")
const { createMobileExpense, scanMobileReceipt } = freshRequire("lib/mobile/expenses.ts")
const { suggestJobFromClock } = freshRequire("lib/financials/overhead.ts")

const PROJECT = id(1)
const TASK = id(2)
const PUNCH = id(3)
const TASK_SAVED = "2026-10-09T10:00:00.5+00:00"
const PUNCH_SAVED = "2026-10-09T11:00:00+00:00"

function harness(permissions = ["project.read", "docs.upload"]) {
  const service = createServiceHarness({
    permissions,
    tables: {
      projects: [{ id: PROJECT, org_id: ORG, name: "Lot 12", phase: "delivery", property_type: "residential", status: "active", created_at: "2026-10-01T00:00:00Z" }],
      tasks: [{ id: TASK, org_id: ORG, project_id: PROJECT, title: "Pour slab", status: "todo", updated_at: TASK_SAVED, created_at: "2026-10-01T00:00:00Z" }],
      punch_items: [{ id: PUNCH, org_id: ORG, project_id: PROJECT, title: "Door", status: "open", updated_at: PUNCH_SAVED }],
    },
  })
  service.context = mobileContext(service)
  punchCalls.length = 0
  return service
}

describe("a queued task status change", () => {
  const change = (service, input) => service.run(() => updateMobileTaskStatus(service.context, PROJECT, TASK, input))

  test("is saved when it names the revision the app read", async () => {
    const service = harness()

    const task = await change(service, { status: "done", expected_revision: TASK_SAVED })

    assert.equal(task.status, "done")
  })

  test("is refused with the current task when someone else changed it first", async () => {
    const service = harness()

    await assert.rejects(change(service, { status: "done", expected_revision: "2026-10-09T09:00:00.000Z" }), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, "stale_revision")
      assert.equal(error.current.id, TASK)
      assert.equal(error.current.status, "todo")
      return true
    })
    assert.deepEqual(service.writes("tasks"), [])
  })

  test("is saved when it names no revision, as older app builds send it", async () => {
    const service = harness()

    const task = await change(service, { status: "in_progress" })

    assert.equal(task.status, "in_progress")
  })
})

describe("a queued punch status change", () => {
  const change = (service, input) => service.run(() => updateMobilePunchStatus(service.context, PROJECT, PUNCH, input))

  test("is handed to the punch lifecycle when it names the current revision", async () => {
    const service = harness()

    const item = await change(service, { status: "closed", expected_revision: PUNCH_SAVED })

    assert.equal(item.status, "closed")
    assert.equal(item.updated_at, "2026-10-09T12:00:00+00:00")
  })

  test("is refused with the current item, and nothing reaches the lifecycle, when the item moved on", async () => {
    const service = harness()

    await assert.rejects(change(service, { status: "closed", expected_revision: "2026-10-09T08:00:00Z" }), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.current.status, "open")
      return true
    })
    assert.deepEqual(punchCalls, [])
  })
})

describe("capturing an expense without a job", () => {
  const CLIENT = id(50)
  const form = (payload, withReceipt = false) => {
    const data = new FormData()
    data.set("payload", JSON.stringify({ client_id: CLIENT, expense_date: "2026-10-09", amount_dollars: 40, ...payload }))
    if (withReceipt) data.set("receipt", new File(["x"], "r.jpg", { type: "image/jpeg" }))
    return data
  }
  const create = (service, payload, withReceipt) => service.run(() => createMobileExpense(service.context, null, form(payload, withReceipt)))

  test("a member who cannot file documents cannot capture or scan an expense that is on no job", async () => {
    const service = harness(["project.read"])
    await assert.rejects(create(service, { overhead_category: "fuel_vehicles" }), (error) => error.status === 403)
    assert.deepEqual(service.writes(), [])
    const data = new FormData()
    data.set("receipt", new File(["x"], "r.jpg", { type: "image/jpeg" }))
    await assert.rejects(service.run(() => scanMobileReceipt(service.context, null, data)), (error) => error.status === 403)
  })

  test("overhead lands with no job, a category and no billing", async () => {
    const service = harness()
    uploads.length = 0

    const expense = await create(service, { overhead_category: "fuel_vehicles" }, true)

    assert.equal(expense.project_id, null)
    assert.equal(expense.overhead_category, "fuel_vehicles")
    assert.equal(expense.home_label, "Fuel and vehicles")
    assert.equal(uploads[0].projectId, null)
    const row = service.db.project_expenses[0]
    assert.equal(row.project_id, null)
    assert.equal(row.is_billable, false)
    assert.equal(service.events[0].payload.overhead_category, "fuel_vehicles")
  })

  test("a capture with neither job nor category is unsorted for the office", async () => {
    const service = harness()

    const expense = await create(service, {})

    assert.equal(expense.home_label, "Needs a job or category")
  })

  test("a job is billable and is named in the label", async () => {
    const service = harness()

    const expense = await create(service, { project_id: PROJECT })

    assert.equal(expense.project_id, PROJECT)
    assert.equal(expense.home_label, "Lot 12")
    assert.equal(service.db.project_expenses[0].is_billable, true)
  })

  test("a job and a category together are refused and nothing is saved", async () => {
    const service = harness()

    await assert.rejects(create(service, { project_id: PROJECT, overhead_category: "rent" }), (error) => error.status === 422)
    assert.deepEqual(service.writes(), [])
  })

  test("a retry with the same client id returns the saved expense once", async () => {
    const service = harness()

    const first = await create(service, { overhead_category: "software" })
    const retry = await create(service, { overhead_category: "software" })

    assert.equal(retry.id, first.id)
    assert.equal(service.db.project_expenses.length, 1)
  })
})

describe("scanning a receipt without a job", () => {
  const scan = (service) => {
    const data = new FormData()
    data.set("receipt", new File(["x"], "r.jpg", { type: "image/jpeg" }))
    return service.run(() => scanMobileReceipt(service.context, null, data))
  }
  const session = (overrides) => ({ org_id: ORG, worker_user_id: id(900002), project_id: PROJECT, started_at: "2026-10-09T13:00:00Z", ended_at: "2026-10-09T21:00:00Z", ...overrides })

  test("suggests the job the caller clocked into on the receipt's date", async () => {
    const service = harness()
    service.db.time_clock_sessions = [session(), session({ project_id: id(2), started_at: "2026-10-08T13:00:00Z", ended_at: "2026-10-08T21:00:00Z" })]
    scanned = { ...scanned, expenseDate: "2026-10-09" }

    const result = await scan(service)

    assert.equal(result.suggested_project_id, PROJECT)
    assert.equal(result.suggested_project_name, "Lot 12")
    assert.equal(result.total_dollars, 40)
  })

  test("suggests nothing when the caller did not clock that day", async () => {
    const service = harness()
    service.db.time_clock_sessions = [session()]
    scanned = { ...scanned, expenseDate: "2026-10-12" }

    const result = await scan(service)

    assert.equal(result.suggested_project_id, null)
    assert.equal(result.suggested_project_name, null)
  })
})

describe("suggesting a job from the clock", () => {
  const now = "2026-10-09T20:00:00Z"
  const sessions = [
    { projectId: "a", startedAt: "2026-10-09T12:00:00Z", endedAt: "2026-10-09T16:00:00Z" },
    { projectId: "b", startedAt: "2026-10-09T16:30:00Z", endedAt: "2026-10-09T18:00:00Z" },
  ]

  test("the session the receipt falls inside wins over the longer one", () => {
    assert.equal(suggestJobFromClock({ at: "2026-10-09T17:00:00Z", sessions, now }), "b")
  })

  test("otherwise the job with the most time that day wins", () => {
    assert.equal(suggestJobFromClock({ at: "2026-10-09T16:10:00Z", sessions, now }), "a")
    assert.equal(suggestJobFromClock({ sessions, now }), "a")
  })

  test("no sessions suggest nothing", () => {
    assert.equal(suggestJobFromClock({ at: now, sessions: [], now }), null)
  })
})
