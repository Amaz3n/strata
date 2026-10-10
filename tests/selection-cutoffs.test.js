"use strict"

/**
 * `lib/services/selection-cutoffs.ts` — moving a buyer's selection deadline.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { lockDueGroups, overrideGroupCutoff, recomputeProjectSelectionCutoffs, revertCutoffToSchedule } = freshRequire("lib/services/selection-cutoffs.ts")

const HOME = id(1)
const GROUP = id(2)
const INSTANCE = id(3)

function harness({ cutoffSource = "manual_override" } = {}) {
  return createServiceHarness({
    permissions: ["selections.cutoff.override"],
    tables: {
      project_selection_groups: [
        { id: INSTANCE, org_id: ORG, project_id: HOME, group_id: GROUP, cutoff_date: "2026-11-30", cutoff_source: cutoffSource, override_reason: "Buyer travelling", overridden_by: id(9), status: "open" },
      ],
      schedule_items: [],
    },
  })
}

const revert = (service, input = {}) =>
  service.run(() => revertCutoffToSchedule({ projectId: HOME, groupId: GROUP, reason: "Buyer is back in town", ...input }))

describe("revertCutoffToSchedule", () => {
  test("reverting records why, and the override it discarded", async () => {
    const service = harness()
    await revert(service)

    assert.equal(service.db.project_selection_groups[0].cutoff_source, "schedule")
    assert.deepEqual(service.events.map((event) => [event.eventType, event.payload.reason]), [["selection_cutoff_reverted", "Buyer is back in town"]])
    assert.equal(service.audits[0].before.override_reason, "Buyer travelling")
    assert.equal(service.audits[0].before.cutoff_date, "2026-11-30")
  })

  test("a revert needs a reason", async () => {
    const service = harness()
    await assert.rejects(revert(service, { reason: "" }))
    assert.deepEqual(service.writes(), [])
  })

  test("a cutoff already on the schedule has nothing to revert", async () => {
    const service = harness({ cutoffSource: "schedule" })
    await assert.rejects(revert(service), /already follows the schedule/)
    assert.deepEqual(service.writes(), [])
  })
})

const daysFromToday = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

describe("overrideGroupCutoff", () => {
  const override = (service, input = {}) =>
    service.run(() => overrideGroupCutoff({ projectId: HOME, groupId: GROUP, cutoffDate: daysFromToday(21), reason: "Buyer travelling until November", ...input }))

  test("a manual cutoff records who moved it and why, and leaves an event and an audit", async () => {
    const service = harness({ cutoffSource: "schedule" })
    await override(service)

    const [row] = service.db.project_selection_groups
    assert.deepEqual([row.cutoff_source, row.cutoff_date, row.override_reason, row.overridden_by, row.status], ["manual_override", daysFromToday(21), "Buyer travelling until November", service.userId, "open"])
    assert.deepEqual(service.events.map((event) => [event.eventType, event.payload.reason]), [["selection_cutoff_overridden", "Buyer travelling until November"]])
    assert.deepEqual(service.audits.map((audit) => [audit.entityType, audit.after.cutoff_source, audit.after.override_reason]), [["project_selection_group", "manual_override", "Buyer travelling until November"]])
  })

  test("an override needs the override permission and a real reason, or nothing changes", async () => {
    const reader = harness({ cutoffSource: "schedule" })
    reader.grant(["selections.write"])
    await assert.rejects(override(reader), /selections\.cutoff\.override/)
    assert.deepEqual([reader.writes(), reader.events, reader.audits], [[], [], []])

    for (const reason of ["", "  ", "no"]) {
      const service = harness({ cutoffSource: "schedule" })
      await assert.rejects(override(service, { reason }), undefined, JSON.stringify(reason))
      assert.deepEqual(service.writes(), [], JSON.stringify(reason))
    }
  })

  test("moving a cutoff into the past closes the group at once; a future date keeps it open", async () => {
    const closed = harness({ cutoffSource: "schedule" })
    await override(closed, { cutoffDate: daysFromToday(-2) })
    assert.equal(closed.db.project_selection_groups[0].status, "locked")
    assert.ok(closed.db.project_selection_groups[0].locked_at)

    const open = harness({ cutoffSource: "schedule" })
    open.db.project_selection_groups[0].status = "locked"
    await override(open)
    assert.deepEqual([open.db.project_selection_groups[0].status, open.db.project_selection_groups[0].locked_at], ["open", null])
  })

  test("a group that is not on this home is not overridden and nothing is recorded", async () => {
    const service = harness()
    await assert.rejects(override(service, { groupId: id(99) }), /Failed to override cutoff/)
    assert.deepEqual([service.events, service.audits], [[], []])
  })
})

describe("schedule-derived cutoffs", () => {
  const FRAMING = "framing-start"
  const instance = (overrides = {}) => ({
    id: INSTANCE, org_id: ORG, project_id: HOME, group_id: GROUP, cutoff_date: null, cutoff_source: "schedule", status: "open", override_reason: null,
    group: { name: "Windows", schedule_task_key: FRAMING, cutoff_offset_days: -14, cutoff_anchor: "start" },
    ...overrides,
  })
  const framing = (startDate) => ({ id: id(20), org_id: ORG, project_id: HOME, name: "Framing Start", start_date: startDate, end_date: startDate, metadata: {} })
  const withSchedule = (groups, items) =>
    createServiceHarness({ permissions: ["selections.cutoff.override"], tables: { project_selection_groups: groups, schedule_items: items, project_selections: [] } })
  const recompute = (service) => service.run(() => recomputeProjectSelectionCutoffs(HOME, ORG))

  test("a group's cutoff follows its schedule task, offset from the anchor", async () => {
    const service = withSchedule([instance()], [framing("2026-12-15")])
    assert.deepEqual(await recompute(service), { changed: 1, unresolved: 0 })
    assert.deepEqual([service.db.project_selection_groups[0].cutoff_date, service.db.project_selection_groups[0].matched_schedule_item_id], ["2026-12-01", id(20)])
    assert.deepEqual(service.events.map((event) => [event.eventType, event.payload.new]), [["selection_cutoff_changed", "2026-12-01"]])
  })

  test("a manual override keeps its date when the schedule moves", async () => {
    const service = withSchedule([instance({ cutoff_source: "manual_override", cutoff_date: "2026-11-30" })], [framing("2026-12-15")])
    assert.deepEqual(await recompute(service), { changed: 0, unresolved: 0 })
    assert.equal(service.db.project_selection_groups[0].cutoff_date, "2026-11-30")
    assert.deepEqual(service.writes(), [])
  })

  test("a schedule that can no longer place the task leaves the cutoff unresolved and says so", async () => {
    const service = withSchedule([instance({ cutoff_date: "2026-12-01" })], [])
    assert.deepEqual(await recompute(service), { changed: 1, unresolved: 1 })
    assert.equal(service.db.project_selection_groups[0].cutoff_date, null)
    assert.deepEqual(service.events.map((event) => event.eventType), ["selection_cutoff_unresolved"])
  })

  test("a schedule slip past today reopens a group the old date had locked", async () => {
    const service = withSchedule([instance({ cutoff_date: daysFromToday(-5), status: "locked", locked_at: "2026-10-01T00:00:00Z" })], [framing(daysFromToday(30))])
    await recompute(service)
    const [row] = service.db.project_selection_groups
    assert.deepEqual([row.status, row.locked_at], ["open", null])
  })

  test("the sweep locks every open group whose cutoff has passed, and its selections", async () => {
    const service = createServiceHarness({
      permissions: [],
      tables: {
        project_selection_groups: [
          instance({ cutoff_date: daysFromToday(-1) }),
          instance({ id: id(4), group_id: id(12), cutoff_date: daysFromToday(0) }),
          instance({ id: id(5), group_id: id(13), cutoff_date: daysFromToday(-30), status: "locked" }),
        ],
        project_selections: [
          { id: id(30), org_id: ORG, project_id: HOME, group_id: GROUP, status: "confirmed", locked_at: null },
          { id: id(31), org_id: ORG, project_id: HOME, group_id: id(12), status: "selected", locked_at: null },
        ],
        memberships: [],
        notifications: [],
      },
    })
    assert.deepEqual(await service.run(() => lockDueGroups(ORG)), { locked: 1 })
    assert.deepEqual(service.db.project_selection_groups.map((row) => row.status), ["locked", "open", "locked"])
    assert.deepEqual(service.db.project_selections.map((row) => Boolean(row.locked_at)), [true, false])
    assert.deepEqual(service.events.map((event) => event.eventType), ["selection_group_locked"])
  })
})
