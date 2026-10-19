const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const enqueued = []
const tradeNotices = []
stubModule("@/lib/services/outbox", { enqueueOutboxJob: async (job) => enqueued.push(job) })
stubModule("@/lib/services/trade-lookahead", { enqueueTradeScheduleChange: async (notice) => tradeNotices.push(notice) })

const { applyScheduleChangeOrderImpact, listScheduleItems } = freshRequire("lib/services/schedule.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const ACTIVE = id(10)
const CANCELLED = id(11)
const ELSEWHERE = id(12)

const item = (itemId, projectId, status, sortOrder) => ({
  id: itemId,
  org_id: ORG,
  project_id: projectId,
  name: `Item ${sortOrder}`,
  status,
  sort_order: sortOrder,
})

function harness() {
  return createServiceHarness({
    permissions: ["schedule.read"],
    tables: {
      schedule_items: [
        item(ACTIVE, PROJECT, "in_progress", 1),
        item(CANCELLED, PROJECT, "cancelled", 2),
        item(ELSEWHERE, OTHER_PROJECT, "in_progress", 3),
      ],
      schedule_dependencies: [
        { id: id(20), org_id: ORG, project_id: PROJECT, item_id: ACTIVE, depends_on_item_id: CANCELLED },
      ],
    },
  })
}

test("the portfolio view skips cancelled items and never reads dependencies it will not show", async () => {
  const service = harness()
  const items = await service.run(() =>
    listScheduleItems(undefined, [PROJECT], { excludeCancelled: true, includeDependencies: false }),
  )
  assert.deepEqual(items.map((row) => row.id), [ACTIVE])
  assert.deepEqual(items[0].dependencies, [])
  assert.deepEqual(service.reads("schedule_dependencies"), [])
})

test("by default a project's schedule keeps cancelled items and their dependencies", async () => {
  const items = await harness().run(() => listScheduleItems(undefined, [PROJECT]))
  assert.deepEqual(items.map((row) => row.id), [ACTIVE, CANCELLED])
  assert.deepEqual(items[0].dependencies, [CANCELLED])
})

test("applying a schedule impact recomputes the home's selection cutoffs and tells the trade, like any schedule move", async () => {
  const company = id(20)
  const impactId = id(21)
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
  const later = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10)
  enqueued.length = 0
  tradeNotices.length = 0
  const service = createServiceHarness({
    permissions: ["schedule.edit"],
    projects: [PROJECT],
    rpc: {
      apply_schedule_item_change_order: () => ({
        data: {
          schedule_item_id: ACTIVE,
          change_order_id: id(22),
          days_adjusted: 10,
          before: { start_date: soon, end_date: soon },
          after: { start_date: later, end_date: later },
        },
        error: null,
      }),
    },
    tables: {
      projects: [{ id: PROJECT, org_id: ORG, division_id: null, property_type: "production" }],
      schedule_items: [item(ACTIVE, PROJECT, "not_started", 1)],
      schedule_item_change_orders: [{ id: impactId, org_id: ORG, schedule_item_id: ACTIVE, change_order_id: id(22), schedule_item: { project_id: PROJECT } }],
      schedule_assignments: [{ id: id(23), org_id: ORG, schedule_item_id: ACTIVE, company_id: company }],
    },
  })

  await service.run(() => applyScheduleChangeOrderImpact(impactId))

  assert.deepEqual(enqueued.map((job) => [job.jobType, job.payload.project_id]), [["selection_cutoff_recompute", PROJECT]])
  assert.deepEqual(tradeNotices.map((notice) => [notice.companyId, notice.oldStart, notice.newStart]), [[company, soon, later]])
})
