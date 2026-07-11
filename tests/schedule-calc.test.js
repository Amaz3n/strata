require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { calculateCriticalPath, wouldCreateDependencyCycle } = require("../lib/utils/schedule-calc")

function item(id, duration) {
  return { id, org_id: "org", project_id: "project", name: id, item_type: "task", status: "planned", start_date: "2026-01-01", end_date: `2026-01-${String(1 + duration).padStart(2, "0")}`, created_at: "", updated_at: "" }
}

function dependency(type, lag) {
  return { id: `${type}-${lag}`, org_id: "org", project_id: "project", depends_on_item_id: "a", item_id: "b", dependency_type: type, lag_days: lag }
}

const items = [item("a", 5), item("b", 5), item("control", 10)]

test("FS forward/backward pass honors positive lag", () => {
  assert.deepEqual([...calculateCriticalPath(items, [dependency("FS", 3)])].sort(), ["a", "b"])
})

test("SS forward/backward pass honors start lag", () => {
  assert.deepEqual([...calculateCriticalPath(items, [dependency("SS", 8)])].sort(), ["a", "b"])
})

test("FF forward/backward pass offsets both durations", () => {
  assert.deepEqual([...calculateCriticalPath(items, [dependency("FF", 8)])].sort(), ["a", "b"])
})

test("SF forward/backward pass constrains successor finish", () => {
  assert.deepEqual([...calculateCriticalPath(items, [dependency("SF", 13)])].sort(), ["a", "b"])
})

test("negative lag can keep an independent path critical", () => {
  assert.deepEqual([...calculateCriticalPath(items, [dependency("FS", -2)])], ["control"])
})

test("dependency cycle guard rejects a path back to the predecessor", () => {
  const existing = [
    { depends_on_item_id: "a", item_id: "b" },
    { depends_on_item_id: "b", item_id: "c" },
  ]
  assert.equal(wouldCreateDependencyCycle(existing, "c", "a"), true)
  assert.equal(wouldCreateDependencyCycle(existing, "c", "d"), false)
})
