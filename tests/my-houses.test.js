const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { completeMyHouseScheduleItem, listMyHouses } = freshRequire("lib/services/my-houses.ts")

const NORTH = id(1)
const SOUTH = id(2)
const NORTH_HOUSE = id(3)
const SOUTH_HOUSE = id(4)
const SOUTH_ITEM = id(5)

const house = (projectId, divisionId, lotNumber) => ({
  id: projectId,
  org_id: ORG,
  division_id: divisionId,
  superintendent_id: ACTOR,
  phase: "delivery",
  property_type: "production",
  status: "active",
  start_date: "2026-09-01",
  lot: { lot_number: lotNumber, block: null, community_id: id(9), community: { name: "Oak Ridge" } },
})

/** A superintendent still assigned to a South house after moving to North. */
function movedSuperintendent(permissions = ["project.read", "start.read", "schedule.edit"]) {
  return createServiceHarness({
    permissions,
    divisions: [NORTH],
    tables: {
      projects: [house(NORTH_HOUSE, NORTH, "12"), house(SOUTH_HOUSE, SOUTH, "40")],
      schedule_items: [{ id: SOUTH_ITEM, org_id: ORG, project_id: SOUTH_HOUSE, name: "Drywall", status: "in_progress", progress: 50 }],
      punch_items: [],
      tasks: [],
      daily_logs: [],
    },
  })
}

test("a stale assignment outside the superintendent's divisions drops off My Houses", async () => {
  const service = movedSuperintendent()

  const { houses } = await service.run(() => listMyHouses())

  assert.deepEqual(houses.map((row) => row.lotLabel), ["12"])
})

test("being the assigned superintendent does not complete work on a house outside one's divisions", async () => {
  for (const permissions of [["project.read", "start.read"], ["project.read", "start.read", "schedule.edit"]]) {
    const service = movedSuperintendent(permissions)

    await assert.rejects(service.run(() => completeMyHouseScheduleItem(SOUTH_ITEM)), /Missing permission: schedule.edit/)

    assert.equal(service.db.schedule_items[0].status, "in_progress")
    assert.deepEqual(service.writes(), [])
  }
})

test("a house's rollups count every schedule item even when PostgREST caps each response", async () => {
  const items = Array.from({ length: 2500 }, (_, index) => ({
    id: id(100000 + index),
    org_id: ORG,
    project_id: NORTH_HOUSE,
    name: `Task ${index}`,
    status: index < 1000 ? "completed" : "in_progress",
    progress: index < 1000 ? 100 : 0,
    start_date: "2026-09-01",
    end_date: "2026-09-02",
  }))
  const service = createServiceHarness({
    permissions: ["project.read", "start.read"],
    divisions: [NORTH],
    maxRows: 1000,
    tables: {
      projects: [house(NORTH_HOUSE, NORTH, "12")],
      schedule_items: items,
      punch_items: [],
      tasks: [],
      daily_logs: [],
    },
  })

  const { houses } = await service.run(() => listMyHouses())

  assert.equal(houses[0].percentComplete, 40)
  assert.equal(houses[0].lateCount, 1500)
})

test("a house's new photos are those uploaded after the day of its last daily log, within the look-back", async () => {
  const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString()
  const day = (days) => daysAgo(days).slice(0, 10)
  const photo = (project, days, index) => ({ file_id: id(200 + index), org_id: ORG, project_id: project, uploaded_at: daysAgo(days) })
  const service = createServiceHarness({
    permissions: ["project.read", "start.read"],
    divisions: [NORTH],
    tables: {
      projects: [house(NORTH_HOUSE, NORTH, "12"), house(SOUTH_HOUSE, NORTH, "40")],
      schedule_items: [],
      punch_items: [],
      tasks: [],
      daily_logs: [{ id: id(300), org_id: ORG, project_id: NORTH_HOUSE, log_date: day(3) }],
      // 12 logged three days ago: the photo from two days ago is new, the one from four days ago is not.
      // 40 never logged: its three photos inside the week are new; a ten-day-old one is outside the look-back.
      project_photo_entries: [
        photo(NORTH_HOUSE, 2, 1), photo(NORTH_HOUSE, 4, 2),
        photo(SOUTH_HOUSE, 1, 3), photo(SOUTH_HOUSE, 3, 4), photo(SOUTH_HOUSE, 5, 5),
      ],
    },
  })

  const { houses } = await service.run(() => listMyHouses())

  assert.deepEqual(houses.map((row) => [row.lotLabel, row.newPhotoCount]), [["12", 1], ["40", 3]])
})
