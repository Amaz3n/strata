const assert = require("node:assert/strict")
const { test } = require("node:test")

const { fieldRecordsRows } = require("../lib/field/field-records.ts")
const { compareReleasedSheets, drawingReleaseState } = require("../lib/field/released-drawings.ts")

const TODAY = "2026-10-16"
const house = (projectId, lastDailyLogDate, newPhotoCount) => ({ projectId, lastDailyLogDate, newPhotoCount })

test("the field-records band lists houses missing today's log or holding new photos, worst first", () => {
  const { rows, hidden } = fieldRecordsRows(
    [house("a", TODAY, 0), house("b", "2026-10-15", 0), house("c", TODAY, 4), house("d", null, 2), house("e", "2026-10-15", 5)],
    TODAY,
  )

  assert.deepEqual(rows.map((row) => [row.house.projectId, row.missingLog]), [["e", true], ["d", true], ["b", true], ["c", false]])
  assert.equal(hidden, 0)
})

test("the field-records band states how many houses its cap hid", () => {
  const houses = Array.from({ length: 11 }, (_, index) => house(`h${String(index).padStart(2, "0")}`, null, 0))

  const { rows, hidden } = fieldRecordsRows(houses, TODAY)

  assert.equal(rows.length, 8)
  assert.equal(hidden, 3)
})

test("a sheet's revision is current, superseded or pending review", () => {
  const sheet = (revisionId, revisionStatus) => drawingReleaseState({ revisionId, revisionStatus, sheetCurrentRevisionId: "r2" })

  assert.equal(sheet("r2", "published"), "current")
  assert.equal(sheet("r1", "published"), "superseded")
  assert.equal(sheet("r3", "draft"), "pending_review")
  assert.equal(sheet("r3", "processing"), "pending_review")
})

test("released sheets order by number, then current before pending before superseded", () => {
  const row = (sheetNumber, state, issuedAt = "2026-10-01") => ({ sheetNumber, state, issuedAt })
  const sorted = [row("A-10", "current"), row("A-2", "superseded"), row("A-2", "current"), row("A-2", "pending_review")].sort(compareReleasedSheets)

  assert.deepEqual(sorted.map((entry) => [entry.sheetNumber, entry.state]), [
    ["A-2", "current"], ["A-2", "pending_review"], ["A-2", "superseded"], ["A-10", "current"],
  ])
})
