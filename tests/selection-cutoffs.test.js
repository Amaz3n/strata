"use strict"

/**
 * `lib/services/selection-cutoffs.ts` — moving a buyer's selection deadline.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { revertCutoffToSchedule } = freshRequire("lib/services/selection-cutoffs.ts")

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
