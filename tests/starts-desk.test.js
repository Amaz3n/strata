const assert = require("node:assert/strict")
const { test } = require("node:test")

const { freshRequire, stubModule } = require("./support/modules")

/** 450 houses in precon: every third is ready, every fifth is sold and late. */
const ACTIVE = Array.from({ length: 450 }, (_, index) => ({
  id: `pkg-${index}`,
  status: index % 3 === 0 ? "ready" : "open",
  risk: index % 5 === 0 ? "late" : "on_track",
  sale: { isSold: index % 5 === 0 },
  targetWeek: null,
}))

stubModule("@/lib/services/permissions", {
  getCurrentUserPermissions: async () => ({ permissions: ["start.read"] }),
})
stubModule("@/lib/services/even-flow", {
  getCommunityReleaseSlots: async () => [], getThroughputWeeks: async () => [],
  getMissedStarts: async () => ({ missed: 0, weeks: 4 }),
})
stubModule("@/lib/services/starts", {
  listStartPackageCandidates: async () => [],
  listStartPackages: async ({ status, page = 1, pageSize }) => {
    const rows = status.includes("released") ? [] : ACTIVE
    return { packages: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }
  },
})

const { getStartsDesk } = freshRequire("lib/services/starts-desk.ts")

test("the ribbon counts every package in scope, not the page the lane drew", async () => {
  const desk = await getStartsDesk()

  assert.equal(desk.packages.length, 200)
  assert.equal(desk.truncated, true)
  assert.equal(desk.packageTotal, 450)
  assert.equal(desk.counters.precon, 450)
  assert.equal(desk.counters.ready, 150)
  assert.equal(desk.counters.atRisk, 90)
  assert.equal(desk.counters.soldAtRisk, 90)
})

test("a refused community lens draws an empty desk", async () => {
  const desk = await getStartsDesk({ communityId: undefined, divisionId: "division-1", refused: true })

  assert.deepEqual(desk.packages, [])
  assert.equal(desk.counters.precon, 0)
})

test("a bulk release only acts on selected houses that are still on screen", () => {
  const { selectionOnScreen } = freshRequire("lib/starts/release-selection.ts")
  const visible = [{ id: "a" }, { id: "b" }]

  const onScreen = selectionOnScreen(visible, new Set(["a", "c"]))

  assert.deepEqual(onScreen.map((pkg) => pkg.id), ["a"])
})

test("confirming over-target starts resends only the houses the server held back", () => {
  const { releaseTargetIds } = freshRequire("lib/starts/release-selection.ts")

  assert.deepEqual(releaseTargetIds(["a", "b", "c"], ["b"], true), ["b"])
  assert.deepEqual(releaseTargetIds(["a", "b", "c"], ["b"], false), ["a", "b", "c"])
})

test("a changed filter rebases the selection so hidden homes cannot rejoin it", () => {
  const { rebaseSelection } = freshRequire("lib/starts/release-selection.ts")
  const narrowed = rebaseSelection([{ id: "a" }], new Set(["a", "b"]))

  assert.deepEqual([...narrowed], ["a"])
  assert.deepEqual([...rebaseSelection([{ id: "a" }, { id: "b" }], narrowed)], ["a"])
})

test("a long release goes out in batches, and a run leaves only unreleased homes selected", () => {
  const { releaseBatches, selectionAfterRelease } = freshRequire("lib/starts/release-selection.ts")
  const ids = Array.from({ length: 25 }, (_, index) => `h${index}`)

  assert.deepEqual(releaseBatches(ids).map((batch) => batch.length), [10, 10, 5])
  assert.deepEqual(releaseBatches([]), [])
  assert.deepEqual(selectionAfterRelease(["a", "b", "c"], ["a", "c"]), ["b"])
})
