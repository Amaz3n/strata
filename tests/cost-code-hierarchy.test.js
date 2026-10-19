"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

require("../scripts/register-ts-node-test")
const {
  costCodeHierarchyIssues,
  costCodeHierarchyRows,
  costCodeParentOptions,
} = require("@/lib/cost-code-hierarchy")

function code(codeId, parentId = null, extra = {}) {
  return { id: codeId, code: codeId, name: `Code ${codeId}`, org_id: "org", parent_id: parentId, is_active: true, ...extra }
}

const shape = (rows) => rows.map((row) => [row.id, row.depth, row.hierarchyIssue])

test("rows come out in preorder with depth, keeping every field and leaving the input untouched", () => {
  const source = [code("b", "a", { default_unit_cost_cents: 12345 }), code("c", "b"), code("a"), code("d")]
  const original = structuredClone(source)

  const rows = costCodeHierarchyRows(source)

  assert.deepEqual(shape(rows), [
    ["a", 0, null],
    ["b", 1, null],
    ["c", 2, null],
    ["d", 0, null],
  ])
  assert.equal(rows[1].default_unit_cost_cents, 12345)
  assert.deepEqual(source, original)
})

test("cycles and self-parents stay visible exactly once, flagged, with their saved parent", () => {
  const rows = costCodeHierarchyRows([code("a", "b"), code("b", "a"), code("c", "b"), code("d", "d"), code("e")])

  assert.deepEqual(shape(rows), [
    ["a", 0, "cycle"],
    ["b", 0, "cycle"],
    ["c", 0, "cycle"],
    ["d", 0, "cycle"],
    ["e", 0, null],
  ])
  assert.deepEqual(
    rows.slice(0, 2).map((row) => row.parent_id),
    ["b", "a"],
  )
})

test("a missing ancestor is reported, but a filtered-out valid parent is not", () => {
  const source = [code("a"), code("b", "a"), code("c", "missing"), code("d", "c")]
  const issues = costCodeHierarchyIssues(source)

  assert.deepEqual([...issues.entries()].sort(), [
    ["c", "missing_parent"],
    ["d", "missing_parent"],
  ])
  assert.deepEqual(shape(costCodeHierarchyRows([source[1], source[3]], issues)), [
    ["b", 0, null],
    ["d", 0, "missing_parent"],
  ])
})

test("parent options exclude the code, its descendants (archived included) and broken branches", () => {
  const source = [
    code("a"),
    code("b", "a", { is_active: false }),
    code("c", "b"),
    code("d"),
    code("e", "e"),
    code("f", "missing"),
  ]
  assert.deepEqual(costCodeParentOptions(source, "a").map((row) => row.id), ["d"])
  assert.deepEqual(costCodeParentOptions(source).map((row) => row.id), ["a", "c", "d"])
})

test("a 10,000-deep legacy chain is walked without recursion overflow and options are capped", () => {
  const key = (i) => String(i).padStart(5, "0")
  const source = Array.from({ length: 10000 }, (_, i) => code(key(i), i ? key(i - 1) : null))

  const rows = costCodeHierarchyRows(source)
  assert.equal(rows.length, 10000)
  assert.equal(rows[9999].depth, 9999)
  assert.equal(costCodeHierarchyIssues(source).size, 0)
  assert.deepEqual(costCodeParentOptions(source, key(0)), [])
  const options = costCodeParentOptions(source)
  assert.equal(options.length, 1000)
  assert.equal(options.at(-1).id, key(999))
})
