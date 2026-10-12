"use strict"

/**
 * `lib/services/selection-cutoffs.ts` — moving a buyer's selection deadline.
 *
 * The group and the choices it opens or closes move in one database step
 * (`override_project_selection_group_cutoff`, `restore_…`, `move_…`,
 * `lock_due_selection_groups`; their atomicity and the community-day rules are
 * proven in selections-db.test.js). Here: who may move a home's deadline, what
 * they must say, what the service hands the database, and the record it keeps.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { lockDueGroups, overrideGroupCutoff, recomputeProjectSelectionCutoffs, revertCutoffToSchedule } = freshRequire("lib/services/selection-cutoffs.ts")

const HOME = id(1)
const GROUP = id(2)
const INSTANCE = id(3)
const DIVISION = id(70)
const OTHER_DIVISION = id(71)

const daysFromToday = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const FRAMING = "framing-start"

const instance = (overrides = {}) => ({
  id: INSTANCE, org_id: ORG, project_id: HOME, group_id: GROUP, cutoff_date: "2026-11-30", cutoff_source: "manual_override", status: "open",
  override_reason: "Buyer travelling", overridden_by: id(9),
  group: { name: "Windows", schedule_task_key: FRAMING, cutoff_offset_days: -14, cutoff_anchor: "start" },
  ...overrides,
})
const framing = (startDate) => ({ id: id(20), org_id: ORG, project_id: HOME, name: "Framing Start", start_date: startDate, end_date: startDate, metadata: {} })

/** The database's answer for a cutoff change: the row before and after, and the choices it reopened. */
const cutoffChange = (before, after, reopened = 0) => ({ data: { id: INSTANCE, before, after, reopened }, error: null })

function harness({ groups = [instance()], items = [], rpc = {} } = {}) {
  const calls = []
  const record = (name, answer) => (args) => {
    calls.push([name, args])
    return answer(args)
  }
  const service = createServiceHarness({
    permissions: ["selections.cutoff.override", "project.read"],
    tables: {
      projects: [{ id: HOME, org_id: ORG, name: "Lot 12", division_id: DIVISION }],
      project_selection_groups: groups,
      schedule_items: items,
      selection_groups: [{ id: GROUP, org_id: ORG, name: "Windows" }],
      notifications: [],
    },
    rpc: {
      override_project_selection_group_cutoff: record("override", (args) => cutoffChange(
        { cutoff_date: "2026-11-30", cutoff_source: "schedule", override_reason: null, overridden_by: null, status: "locked" },
        { cutoff_date: args.p_cutoff_date, cutoff_source: "manual_override", override_reason: args.p_reason, overridden_by: args.p_actor_id, status: "open" },
        2,
      )),
      restore_project_selection_group_cutoff: record("restore", (args) => cutoffChange(
        { cutoff_date: "2026-11-30", cutoff_source: "manual_override", override_reason: "Buyer travelling", overridden_by: id(9), status: "open" },
        { cutoff_date: args.p_cutoff_date, cutoff_source: "schedule", status: "open" },
      )),
      move_project_selection_group_cutoff: record("move", (args) => ({ data: { changed: true, reopened: 0, old: "2026-11-30", new: args.p_cutoff_date }, error: null })),
      refresh_project_selection_exceptions: record("refresh", () => ({ data: [], error: null })),
      lock_due_selection_groups: record("lock", () => ({ data: [], error: null })),
      ...rpc,
    },
  })
  return { service, calls }
}

describe("overrideGroupCutoff", () => {
  const override = (service, input = {}) =>
    service.run(() => overrideGroupCutoff({ projectId: HOME, groupId: GROUP, cutoffDate: daysFromToday(21), reason: "Buyer travelling until November", ...input }))

  test("an override moves the home's cutoff in one step, in the actor's name, and records the before and after", async () => {
    const { service, calls } = harness()
    const result = await override(service)

    assert.deepEqual(calls.map(([name, args]) => [name, args.p_project_id, args.p_group_id, args.p_cutoff_date, args.p_reason, args.p_actor_id]), [
      ["override", HOME, GROUP, daysFromToday(21), "Buyer travelling until November", service.userId],
    ])
    assert.equal(result.reopened, 2)
    assert.deepEqual(service.events.map((event) => [event.eventType, event.payload.reason, event.payload.previous_cutoff_date, event.payload.selections_reopened]), [
      ["selection_cutoff_overridden", "Buyer travelling until November", "2026-11-30", 2],
    ])
    const [audit] = service.audits
    assert.deepEqual([audit.entityType, audit.before.cutoff_source, audit.before.status, audit.after.cutoff_source, audit.after.override_reason, audit.after.selections_reopened, audit.critical],
      ["project_selection_group", "schedule", "locked", "manual_override", "Buyer travelling until November", 2, true])
  })

  test("an override needs the override permission on this home and a real reason, or nothing moves", async () => {
    const reader = harness()
    reader.service.grant(["selections.write", "project.read"])
    await assert.rejects(override(reader.service), /Missing permission: selections\.cutoff\.override/)
    assert.deepEqual([reader.calls, reader.service.events, reader.service.audits], [[], [], []])

    for (const reason of ["", "  ", "no"]) {
      const { service, calls } = harness()
      await assert.rejects(override(service, { reason }), undefined, JSON.stringify(reason))
      assert.deepEqual(calls, [], JSON.stringify(reason))
    }
  })

  test("a coordinator limited to another division cannot move this home's deadline", async () => {
    const { service, calls } = harness()
    service.grant(["selections.cutoff.override", "project.read"], { divisions: [OTHER_DIVISION] })
    await assert.rejects(override(service), /Missing permission: selections\.cutoff\.override/)
    assert.deepEqual([calls, service.events, service.audits], [[], [], []])

    service.grant(["selections.cutoff.override", "project.read"], { divisions: [DIVISION] })
    await override(service)
    assert.equal(calls.length, 1)
  })

  test("a refused override leaves no event and no audit", async () => {
    const { service } = harness({ rpc: { override_project_selection_group_cutoff: () => ({ data: null, error: { message: "Selection group not found on this home" } }) } })
    await assert.rejects(override(service), /Failed to override cutoff: Selection group not found/)
    assert.deepEqual([service.events, service.audits], [[], []])
  })
})

describe("revertCutoffToSchedule", () => {
  const revert = (service, input = {}) =>
    service.run(() => revertCutoffToSchedule({ projectId: HOME, groupId: GROUP, reason: "Buyer is back in town", ...input }))

  test("reverting hands the database the schedule-derived date, and records why and the override it discarded", async () => {
    const { service, calls } = harness({ items: [framing("2026-12-15")] })
    await revert(service)

    assert.deepEqual(calls.map(([name, args]) => [name, args.p_cutoff_date, args.p_matched_schedule_item_id, args.p_actor_id]), [["restore", "2026-12-01", id(20), service.userId]])
    assert.deepEqual(service.events.map((event) => [event.eventType, event.payload.reason, event.payload.discarded_cutoff_date]), [["selection_cutoff_reverted", "Buyer is back in town", "2026-11-30"]])
    assert.deepEqual([service.audits[0].before.override_reason, service.audits[0].before.cutoff_date, service.audits[0].after.revert_reason], ["Buyer travelling", "2026-11-30", "Buyer is back in town"])
  })

  test("a revert needs a reason and the override permission on this home", async () => {
    const { service, calls } = harness()
    await assert.rejects(revert(service, { reason: "" }))
    service.grant(["selections.write", "project.read"])
    await assert.rejects(revert(service), /selections\.cutoff\.override/)
    assert.deepEqual(calls, [])
  })

  test("a cutoff already on the schedule has nothing to revert", async () => {
    const { service } = harness({
      rpc: { restore_project_selection_group_cutoff: () => ({ data: null, error: { message: "This cutoff already follows the schedule", details: "SELECTION_CUTOFF_NOT_OVERRIDDEN" } }) },
    })
    await assert.rejects(revert(service), /already follows the schedule/)
    assert.deepEqual([service.events, service.audits], [[], []])
  })
})

describe("schedule-derived cutoffs", () => {
  const recompute = (service) => service.run(() => recomputeProjectSelectionCutoffs(HOME, ORG))

  test("a group's cutoff follows its schedule task, offset from the anchor, and supply exceptions are refreshed", async () => {
    const { service, calls } = harness({ groups: [instance({ cutoff_source: "schedule", cutoff_date: null })], items: [framing("2026-12-15")] })
    assert.deepEqual(await recompute(service), { changed: 1, unresolved: 0, exceptionsOpened: 0 })
    assert.deepEqual(calls.map(([name, args]) => [name, args.p_cutoff_date ?? null, args.p_matched_schedule_item_id ?? null]), [["move", "2026-12-01", id(20)], ["refresh", null, null]])
    assert.deepEqual(service.events.map((event) => [event.eventType, event.payload.new]), [["selection_cutoff_changed", "2026-12-01"]])
  })

  test("a manual override is never handed to the schedule move", async () => {
    const { service, calls } = harness({ items: [framing("2026-12-15")] })
    assert.deepEqual(await recompute(service), { changed: 0, unresolved: 0, exceptionsOpened: 0 })
    assert.deepEqual(calls.map(([name]) => name), ["refresh"])
  })

  test("a schedule that can no longer place the task leaves the cutoff unresolved and says so", async () => {
    const { service } = harness({
      groups: [instance({ cutoff_source: "schedule" })],
      rpc: { move_project_selection_group_cutoff: () => ({ data: { changed: true, reopened: 0, old: "2026-11-30", new: null }, error: null }) },
    })
    assert.deepEqual(await recompute(service), { changed: 1, unresolved: 1, exceptionsOpened: 0 })
    assert.deepEqual(service.events.map((event) => event.eventType), ["selection_cutoff_unresolved"])
  })

  test("a move the database found already in place records nothing", async () => {
    const { service } = harness({
      groups: [instance({ cutoff_source: "schedule" })],
      items: [framing("2026-12-14")],
      rpc: { move_project_selection_group_cutoff: () => ({ data: { changed: false, reopened: 0, old: "2026-11-30", new: "2026-11-30" }, error: null }) },
    })
    assert.deepEqual(await recompute(service), { changed: 0, unresolved: 0, exceptionsOpened: 0 })
    assert.deepEqual(service.events, [])
  })
})

describe("lockDueGroups", () => {
  test("the sweep drains the database's due groups and records each lock", async () => {
    let batches = 0
    const { service } = harness({
      rpc: {
        lock_due_selection_groups: (args) => {
          batches += 1
          assert.equal(args.p_org_id, ORG)
          return { data: batches === 1 ? [{ id: INSTANCE, org_id: ORG, project_id: HOME, group_id: GROUP, metadata: { missed_notified: true }, unconfirmed: 2 }] : [], error: null }
        },
      },
    })
    assert.deepEqual(await service.run(() => lockDueGroups(ORG)), { locked: 1 })
    assert.equal(batches, 1)
    assert.deepEqual(service.events.map((event) => [event.eventType, event.entityId]), [["selection_group_locked", INSTANCE]])
  })
})
