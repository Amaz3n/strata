"use strict"

/**
 * `bulkUpdateScheduleItems` / `previewScheduleReschedule` — a date move is
 * planned on the server, refused loudly, and only written through one
 * transaction. A move that pushes a promised close past its date needs the
 * houses accepted, a reason, and someone who may release starts.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const schedule = freshRequire("lib/services/schedule.ts")

const PROJECT = id(1)
const FOUNDATION = id(11)
const FRAMING = id(12)
const ROOFING = id(13)
const HANDOFF = id(14)
const CLOSING = id(21)
const STAMP = "2026-10-01T12:00:00.000000+00:00"

const item = (itemId, name, start, end, extra = {}) => ({
  id: itemId, org_id: ORG, project_id: PROJECT, name, item_type: "task", status: "planned",
  start_date: start, end_date: end, constraint_type: "asap", updated_at: STAMP, ...extra,
})

/** Foundation and framing both feed roofing, which feeds the handoff; the house closes Nov 20. */
const tables = () => ({
  projects: [{ id: PROJECT, org_id: ORG, name: "Lot 12", property_type: "residential" }],
  schedule_items: [
    item(FOUNDATION, "Foundation", "2026-11-02", "2026-11-04"),
    item(FRAMING, "Framing", "2026-11-02", "2026-11-09"),
    item(ROOFING, "Roofing", "2026-11-09", "2026-11-11"),
    item(HANDOFF, "Handoff", "2026-11-12", "2026-11-12", { item_type: "handoff" }),
  ],
  schedule_dependencies: [
    { id: id(31), org_id: ORG, project_id: PROJECT, item_id: ROOFING, depends_on_item_id: FOUNDATION, dependency_type: "FS", lag_days: 0 },
    { id: id(32), org_id: ORG, project_id: PROJECT, item_id: ROOFING, depends_on_item_id: FRAMING, dependency_type: "FS", lag_days: 0 },
    { id: id(33), org_id: ORG, project_id: PROJECT, item_id: HANDOFF, depends_on_item_id: ROOFING, dependency_type: "FS", lag_days: 0 },
  ],
  closings: [{ id: CLOSING, org_id: ORG, project_id: PROJECT, status: "scheduled", scheduled_date: "2026-11-20" }],
  outbox: [],
})

function harness(permissions, { applied } = {}) {
  return createServiceHarness({
    tables: tables(),
    permissions,
    projects: [PROJECT],
    rpc: {
      apply_schedule_reschedule: (args) => ({
        data: applied ?? args.p_changes.map((change) => ({
          id: change.id, project_id: PROJECT, old_start: null, new_start: change.start_date ?? null,
        })),
        error: null,
      }),
    },
  })
}

const rpcCalls = (service) => service.queries.filter((query) => query.action === "rpc")

// Foundation slips a week: Roofing waits for Foundation AND Framing, then Handoff follows.
const slip = { items: [{ id: FOUNDATION, start_date: "2026-11-09", end_date: "2026-11-16" }] }

describe("planning", () => {
  test("a successor with two predecessors waits for the later one", async () => {
    const service = harness(["schedule.edit", "start.release"])
    const preview = await service.run(() => schedule.previewScheduleReschedule(slip.items))
    const roofing = preview.changes.find((change) => change.id === ROOFING)
    assert.deepEqual([roofing.newStart, roofing.newEnd, roofing.cause], ["2026-11-16", "2026-11-18", "dependency"])
    assert.equal(preview.changes.find((change) => change.id === HANDOFF).newStart, "2026-11-18")
  })

  test("a move that pushes the finish past a promised close reports the house", async () => {
    const service = harness(["schedule.edit", "start.release"])
    const late = [{ id: FOUNDATION, start_date: "2026-11-16", end_date: "2026-11-23" }]
    const preview = await service.run(() => schedule.previewScheduleReschedule(late))
    assert.equal(preview.canApproveCloseImpacts, true)
    assert.equal(preview.closeImpacts.length, 1)
    const [impact] = preview.closeImpacts
    assert.deepEqual([impact.projectId, impact.scheduledDate, impact.projectedFinish, impact.daysLate], [PROJECT, "2026-11-20", "2026-11-25", 5])
  })

  test("without start.release the viewer is told they cannot accept a breach", async () => {
    const service = harness(["schedule.edit"])
    const preview = await service.run(() => schedule.previewScheduleReschedule([{ id: FOUNDATION, start_date: "2026-11-16", end_date: "2026-11-23" }]))
    assert.equal(preview.canApproveCloseImpacts, false)
  })

  test("a move that stays inside the promised close needs no approval", async () => {
    const service = harness(["schedule.edit"])
    const preview = await service.run(() => schedule.previewScheduleReschedule([{ id: FOUNDATION, start_date: "2026-11-03", end_date: "2026-11-05" }]))
    assert.deepEqual(preview.closeImpacts, [])
  })
})

describe("applying", () => {
  test("a task past the project's schedule.edit is refused before anything is written", async () => {
    const service = harness(["project.read"])
    await assert.rejects(service.run(() => schedule.bulkUpdateScheduleItems(slip)), /schedule\.edit/)
    assert.deepEqual(rpcCalls(service), [])
  })

  test("a move that breaches a promised close is refused until it is accepted, explained and authorised", async () => {
    const late = { items: [{ id: FOUNDATION, start_date: "2026-11-16", end_date: "2026-11-23" }] }
    const service = harness(["schedule.edit"])
    await assert.rejects(service.run(() => schedule.bulkUpdateScheduleItems(late)), /accept each close impact/)
    await assert.rejects(
      service.run(() => schedule.bulkUpdateScheduleItems({ ...late, acknowledge_close_impacts: [PROJECT] })),
      /why the date moves past a promised close/,
    )
    await assert.rejects(
      service.run(() => schedule.bulkUpdateScheduleItems({ ...late, acknowledge_close_impacts: [PROJECT], reason: "Crew delay on foundation" })),
      /start\.release/,
    )
    assert.deepEqual(rpcCalls(service), [])

    const coordinator = harness(["schedule.edit", "start.release"])
    await coordinator.run(() => schedule.bulkUpdateScheduleItems({ ...late, acknowledge_close_impacts: [PROJECT], reason: "Crew delay on foundation" }))
    const [call] = rpcCalls(coordinator)
    assert.deepEqual(call.payload.p_acknowledged, [PROJECT])
    assert.equal(call.payload.p_reason, "Crew delay on foundation")
    assert.deepEqual(call.payload.p_changes.map((change) => change.id).sort(), [FOUNDATION, HANDOFF, ROOFING].sort())
  })

  test("the server recomputes dependents rather than trusting the client", async () => {
    const service = harness(["schedule.edit", "start.release"])
    await service.run(() => schedule.bulkUpdateScheduleItems({
      ...slip, acknowledge_close_impacts: [PROJECT], reason: "Foundation crew slipped a week",
    }))
    const [call] = rpcCalls(service)
    const roofing = call.payload.p_changes.find((change) => change.id === ROOFING)
    assert.deepEqual([roofing.start_date, roofing.end_date, roofing.expected_updated_at], ["2026-11-16", "2026-11-18", STAMP])
  })

  test("the transaction's refusal reaches the caller", async () => {
    const service = createServiceHarness({
      tables: tables(),
      permissions: ["schedule.edit"],
      projects: [PROJECT],
      rpc: { apply_schedule_reschedule: () => ({ data: null, error: { message: "A task was changed by someone else; reload and try again" } }) },
    })
    await assert.rejects(
      service.run(() => schedule.bulkUpdateScheduleItems({ items: [{ id: FOUNDATION, start_date: "2026-11-03", end_date: "2026-11-05" }] })),
      /changed by someone else/,
    )
  })

  test("a reorder with no dates is written as given, after the project check", async () => {
    const service = harness(["schedule.edit"])
    await service.run(() => schedule.bulkUpdateScheduleItems({ items: [{ id: FRAMING, sort_order: 4 }] }))
    const [call] = rpcCalls(service)
    assert.deepEqual(call.payload.p_changes, [{ id: FRAMING, expected_updated_at: STAMP, sort_order: 4 }])
  })

  test("an unknown task fails the whole request", async () => {
    const service = harness(["schedule.edit"])
    await assert.rejects(
      service.run(() => schedule.bulkUpdateScheduleItems({ items: [{ id: FRAMING, sort_order: 1 }, { id: id(99), sort_order: 2 }] })),
      /not found/,
    )
    assert.deepEqual(rpcCalls(service), [])
  })
})
