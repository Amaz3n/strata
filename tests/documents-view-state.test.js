require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const { test } = require("node:test")

const {
  appendUniqueFiles,
  folderParent,
  isCurrentViewRequest,
  reconcileFolderChildren,
} = require("../components/documents/view-state")

test("a child listing drops vanished branches and their counts, keeping lookalike siblings", () => {
  const previous = {
    paths: ["/Plans", "/Plans/Old", "/Plans/Old/Nested", "/Plans/Older", "/Other", "/Other/Keep"],
    counts: { "/Plans/Old": 0, "/Plans/Old/Nested": 0, "/Plans/Older": 3, "/Other/Keep": 4 },
  }

  const result = reconcileFolderChildren(previous, "/Plans", [{ path: "/Plans/Older", itemCount: 5 }])

  assert.deepEqual(result.paths, ["/Other", "/Other/Keep", "/Plans", "/Plans/Older"])
  assert.deepEqual(result.counts, { "/Plans/Older": 5, "/Other/Keep": 4 })
  assert.equal(previous.paths.length, 6, "the previous state is not mutated")
})

test("a renamed root folder loses its loaded descendants; other branches stay", () => {
  const result = reconcileFolderChildren(
    { paths: ["/Old", "/Old/Nested", "/Other", "/Other/Keep"], counts: { "/Old": 1, "/Old/Nested": 2, "/Other": 3 } },
    "",
    [
      { path: "/New", itemCount: 1 },
      { path: "/Other", itemCount: 3 },
    ],
  )

  assert.deepEqual(result.paths, ["/New", "/Other", "/Other/Keep"])
  assert.deepEqual(result.counts, { "/New": 1, "/Other": 3 })
})

test("an empty listing clears only the requested parent's descendants", () => {
  const result = reconcileFolderChildren({ paths: ["/A", "/A/Child", "/AB/Keep"], counts: { "/A/Child": 3 } }, "/A", [])

  assert.deepEqual(result.paths, ["/A", "/AB/Keep"])
  assert.deepEqual(result.counts, {})
})

test("a response is current only for the view and generation that requested it", () => {
  const cases = [
    { request: ["/A|all", 1], active: ["/A|all", 1], current: true },
    { request: ["/A|all", 1], active: ["/B|all", 1], current: false }, // navigated away
    { request: ["/A|all", 1], active: ["/A|all", 2], current: false }, // same folder, mutated since
  ]
  for (const { request, active, current } of cases) {
    assert.equal(isCurrentViewRequest(...request, ...active), current, JSON.stringify({ request, active }))
  }
})

test("appended pages keep existing rows and never repeat an id", () => {
  const rows = appendUniqueFiles(
    [{ id: "a", name: "original" }],
    [{ id: "a", name: "duplicate" }, { id: "b" }, { id: "b" }, { id: "c" }],
  )

  assert.deepEqual(rows, [{ id: "a", name: "original" }, { id: "b" }, { id: "c" }])
})

test("a folder's parent is the root for top-level folders", () => {
  assert.equal(folderParent("/Plans"), "")
  assert.equal(folderParent("/Plans/Permits"), "/Plans")
})
