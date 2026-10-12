const assert = require("node:assert/strict")
const { test } = require("node:test")

const { freshRequire } = require("./support/modules")

const {
  buildRevisionSet,
  describeReleasedElevations,
  describeRevisionChange,
  describeRevisionSet,
  diffRevisionSets,
  revisionAsOf,
} = freshRequire("lib/plans/product-revisions.ts")

const sold = buildRevisionSet({
  planVersion: { id: "v3", number: 3 },
  elevation: { id: "elev-b", code: "B", revision: 2 },
  options: [{ id: "patio", revision: 1 }, { id: "fans", revision: 4 }],
  packages: [{ id: "outdoor", revision: 1 }],
})

test("a revision set is canonical: one entry per item, ordered by id", () => {
  const set = buildRevisionSet({
    planVersion: null,
    elevation: null,
    options: [{ id: "patio", revision: 1 }, { id: "fans", revision: 4 }, { id: "patio", revision: 2 }],
    packages: [],
  })

  assert.deepEqual(set.options, [{ id: "fans", revision: 4 }, { id: "patio", revision: 2 }])
})

test("a home that still matches its record has no changes", () => {
  assert.deepEqual(diffRevisionSets(sold, buildRevisionSet({ ...sold, options: [...sold.options].reverse() })), [])
})

test("an edited elevation, option or package after release is reported against the recorded revision", () => {
  const today = buildRevisionSet({
    planVersion: { id: "v4", number: 4 },
    elevation: { id: "elev-b", code: "B", revision: 3 },
    options: [{ id: "patio", revision: 2 }],
    packages: [{ id: "outdoor", revision: 1 }, { id: "shade", revision: 1 }],
  })

  const changes = diffRevisionSets(sold, today)

  assert.deepEqual(changes, [
    { kind: "plan_version", id: "v4", change: "changed", from: 3, to: 4 },
    { kind: "elevation", id: "elev-b", change: "changed", from: 2, to: 3 },
    { kind: "option", id: "fans", change: "removed", from: 4, to: null },
    { kind: "option", id: "patio", change: "changed", from: 1, to: 2 },
    { kind: "package", id: "shade", change: "added", from: null, to: 1 },
  ])
  assert.deepEqual(changes.map(describeRevisionChange), [
    "Plan v3 → v4",
    "Elevation r2 → r3",
    "Option no longer in the catalog",
    "Option r1 → r2",
    "Package added at r1",
  ])
})

test("a sale resolves each item to the revision current when it was priced", () => {
  const history = [
    { entityId: "patio", revision: 1, createdAt: "2026-01-01T00:00:00Z" },
    { entityId: "patio", revision: 2, createdAt: "2026-06-01T00:00:00Z" },
    { entityId: "patio", revision: 3, createdAt: "2026-09-01T00:00:00Z" },
    { entityId: "fans", revision: 1, createdAt: "2026-08-01T00:00:00Z" },
  ]

  assert.equal(revisionAsOf(history, "patio", "2026-07-15T00:00:00Z"), 2)
  assert.equal(revisionAsOf(history, "patio", "2026-06-01T00:00:00Z"), 2)
  assert.equal(revisionAsOf(history, "fans", "2026-07-15T00:00:00Z"), null)
})

test("a record and a released version read as one line each", () => {
  assert.equal(describeRevisionSet(sold), "plan v3 · elevation B r2 · 3 options")
  assert.equal(describeReleasedElevations({ elevations: [{ code: "A", revision: 1 }, { code: "B", revision: 2 }] }), "A r1 · B r2")
  assert.equal(describeReleasedElevations({ budget_template: null }), null)
})
