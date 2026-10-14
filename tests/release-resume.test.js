"use strict"

/**
 * A release builds a house's budget, schedule and checklists once. Each artifact
 * carries its place on the home (`metadata.release_key`, unique per home), so
 * a step replayed after a crash, a cancel or a lost lease builds only what is
 * missing — `lib/services/budgets.ts`, `lib/services/schedule.ts` and the
 * checklist handler in `lib/services/plan-instantiation.ts`. The transaction that
 * closes a step (`settle_release_step`) is proven in
 * tests/starts-core-write-fences-db.test.js.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const created = []
stubModule("@/lib/services/inspections", {
  createInspectionFromSnapshot: async (input) => {
    created.push(input)
    return { id: `inspection-${created.length}` }
  },
})

const { createReleaseBudget } = freshRequire("lib/services/budgets.ts")
const { applyScheduleTemplateSnapshot } = freshRequire("lib/services/schedule.ts")
const { seedPlanChecklists } = freshRequire("lib/services/plan-instantiation.ts")

const PROJECT = id(1)
const BUDGET = id(2)

function harness(tables = {}) {
  return createServiceHarness({ permissions: ["plan.instantiate"], tables: { budgets: [], budget_lines: [], schedule_items: [], inspections: [], inspection_items: [], ...tables } })
}

describe("createReleaseBudget", () => {
  const lines = [{ description: "Slab", amount_cents: 600_000 }, { description: "Framing", amount_cents: 400_000 }]

  test("builds one approved budget under its release key, with a line at each position", async () => {
    const service = harness()
    const budget = await service.run(() => createReleaseBudget({ project_id: PROJECT, lines }))

    assert.equal(service.db.budgets.length, 1)
    assert.deepEqual({ status: service.db.budgets[0].status, key: service.db.budgets[0].metadata.release_key, total: service.db.budgets[0].total_cents },
      { status: "approved", key: "budget", total: 1_000_000 })
    assert.deepEqual(service.db.budget_lines.map((line) => line.sort_order), [0, 1])
    assert.deepEqual({ id: budget.id, lineCount: budget.lineCount, totalCents: budget.totalCents }, { id: service.db.budgets[0].id, lineCount: 2, totalCents: 1_000_000 })
    assert.deepEqual(service.events.map((event) => event.eventType), ["budget_created"])
  })

  test("a replay after a crash between the budget and its lines adds the missing lines to the same budget", async () => {
    const service = harness({
      budgets: [{ id: BUDGET, org_id: ORG, project_id: PROJECT, version: 1, status: "approved", total_cents: 1_000_000, metadata: { release_key: "budget" } }],
      budget_lines: [{ id: id(10), org_id: ORG, budget_id: BUDGET, description: "Slab", amount_cents: 600_000, sort_order: 0 }],
    })
    const budget = await service.run(() => createReleaseBudget({ project_id: PROJECT, lines }))

    assert.equal(service.db.budgets.length, 1, "no second budget")
    assert.deepEqual(service.db.budget_lines.map((line) => [line.budget_id, line.sort_order]), [[BUDGET, 0], [BUDGET, 1]])
    assert.equal(budget.lineCount, 2)
    assert.deepEqual(service.events, [], "the budget was announced when it was created, not again")
    assert.deepEqual(service.audits, [])
  })

  test("a replay never doubles lines it already has, and totals the budget from what is there", async () => {
    const service = harness({
      budgets: [{ id: BUDGET, org_id: ORG, project_id: PROJECT, version: 1, status: "approved", total_cents: 999, metadata: { release_key: "budget" } }],
      budget_lines: lines.map((line, index) => ({ id: id(20 + index), org_id: ORG, budget_id: BUDGET, ...line, sort_order: index })),
    })
    const budget = await service.run(() => createReleaseBudget({ project_id: PROJECT, lines }))

    assert.equal(service.db.budget_lines.length, 2)
    assert.equal(service.db.budgets[0].total_cents, 1_000_000)
    assert.equal(budget.totalCents, 1_000_000)
  })

  test("a budget with no lines is a budget of zero, recorded as such", async () => {
    const service = harness()
    const budget = await service.run(() => createReleaseBudget({ project_id: PROJECT, lines: [] }))
    assert.deepEqual({ lineCount: budget.lineCount, totalCents: budget.totalCents, rows: service.db.budget_lines.length }, { lineCount: 0, totalCents: 0, rows: 0 })
  })

  test("only the release path may use it", async () => {
    const service = createServiceHarness({ permissions: ["budget.write"], tables: { budgets: [], budget_lines: [] } })
    await assert.rejects(service.run(() => createReleaseBudget({ project_id: PROJECT, lines })), /plan\.instantiate/)
    assert.deepEqual(service.writes(), [])
  })
})

describe("applyScheduleTemplateSnapshot for a release", () => {
  const items = [0, 1, 2].map((n) => ({ name: `Task ${n}`, start_offset_days: n, duration_days: 2 }))
  const keys = (service) => service.db.schedule_items.map((row) => row.metadata.release_key).sort()

  test("numbers each template item and builds it once", async () => {
    const service = harness()
    const built = await service.run(() => applyScheduleTemplateSnapshot(PROJECT, items, "2026-11-02", undefined, "plan.instantiate", { releaseKeyed: true }))
    assert.deepEqual(keys(service), ["schedule:0", "schedule:1", "schedule:2"])
    assert.equal(built.length, 3)
  })

  test("a replay after a crash part way builds only the tail and reports every item", async () => {
    const service = harness({ schedule_items: [0, 1].map((n) => ({ id: id(30 + n), org_id: ORG, project_id: PROJECT, name: `Task ${n}`, status: "planned", metadata: { release_key: `schedule:${n}` } })) })
    const built = await service.run(() => applyScheduleTemplateSnapshot(PROJECT, items, "2026-11-02", undefined, "plan.instantiate", { releaseKeyed: true }))

    assert.deepEqual(keys(service), ["schedule:0", "schedule:1", "schedule:2"])
    assert.equal(service.writes("schedule_items").length, 1, "one insert for the one missing item")
    assert.deepEqual(built.map((item) => item.name).sort(), ["Task 0", "Task 1", "Task 2"])
  })

  test("a complete schedule is left exactly as it is", async () => {
    const service = harness({ schedule_items: [0, 1, 2].map((n) => ({ id: id(30 + n), org_id: ORG, project_id: PROJECT, name: `Task ${n}`, status: "planned", metadata: { release_key: `schedule:${n}` } })) })
    const built = await service.run(() => applyScheduleTemplateSnapshot(PROJECT, items, "2026-11-02", undefined, "plan.instantiate", { releaseKeyed: true }))
    assert.deepEqual(service.writes("schedule_items"), [])
    assert.equal(built.length, 3)
  })

  test("an interactive apply carries no release key", async () => {
    const service = harness()
    await service.run(() => applyScheduleTemplateSnapshot(PROJECT, items, "2026-11-02", undefined, "plan.instantiate"))
    assert.deepEqual(service.db.schedule_items.map((row) => row.metadata.release_key), [undefined, undefined, undefined])
  })
})

describe("seedPlanChecklists for a release", () => {
  const checklist = (name, prompts) => ({ id: `tpl-${name}`, name, kind: "quality", items: prompts.map((prompt) => ({ prompt })) })
  const snapshot = { checklists: [checklist("Framing", ["Studs plumb", "Headers sized"]), checklist("Slab", ["Rebar placed"])] }
  const run = (service, releaseKeyed = true) => service.run(() => seedPlanChecklists(
    { projectId: PROJECT, releaseKeyed },
    { supabase: service.client, orgId: ORG, snapshot },
  ))

  test("keys each checklist by its position on the plan", async () => {
    created.length = 0
    const service = harness()
    const result = await run(service)
    assert.deepEqual(created.map((input) => input.releaseKey), ["checklist:0", "checklist:1"])
    assert.equal(result.inspection_ids.length, 2)
  })

  test("a replay reuses the checklists on the home and completes one a crash left without its items", async () => {
    created.length = 0
    const service = harness({
      inspections: [
        { id: id(40), org_id: ORG, project_id: PROJECT, metadata: { release_key: "checklist:0" } },
        { id: id(41), org_id: ORG, project_id: PROJECT, metadata: { release_key: "checklist:1" } },
      ],
      inspection_items: [
        { id: id(50), org_id: ORG, inspection_id: id(40), prompt: "Studs plumb", sort_order: 0 },
        { id: id(51), org_id: ORG, inspection_id: id(41), prompt: "Rebar placed", sort_order: 0 },
      ],
    })
    const result = await run(service)

    assert.deepEqual(created, [], "no checklist is created twice")
    assert.deepEqual(result.inspection_ids, [id(40), id(41)])
    assert.deepEqual(service.db.inspection_items.filter((item) => item.inspection_id === id(40)).map((item) => [item.prompt, item.sort_order]).sort(),
      [["Headers sized", 1], ["Studs plumb", 0]])
    assert.equal(service.db.inspection_items.filter((item) => item.inspection_id === id(41)).length, 1)
  })

  test("an interactive seed carries no release key", async () => {
    created.length = 0
    await run(harness(), false)
    assert.deepEqual(created.map((input) => input.releaseKey), [undefined, undefined])
  })
})
