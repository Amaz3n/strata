require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { calculateCriticalPath, planScheduleMove, wouldCreateDependencyCycle } = require("../lib/utils/schedule-calc")

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

function plannable(id, start, end, extra = {}) {
  return { id, start_date: start, end_date: end, status: "planned", constraint_type: "asap", ...extra }
}
function edge(from, to, type = "FS", lag = 0) {
  return { item_id: to, depends_on_item_id: from, dependency_type: type, lag_days: lag }
}
const move = (id, start_date, end_date) => ({ id, start_date, end_date })
const byId = (plan) => Object.fromEntries(plan.changes.map((change) => [change.id, [change.start_date, change.end_date, change.cause]]))

for (const [type, lag, expectedStart, expectedEnd] of [
  ["FS", 2, "2026-01-08", "2026-01-13"],
  ["SS", 2, "2026-01-03", "2026-01-08"],
  ["FF", 2, "2026-01-03", "2026-01-08"],
  ["SF", 20, "2026-01-16", "2026-01-21"],
]) {
  test(`${type} move pushes a late successor by signed lag`, () => {
    const plan = planScheduleMove(
      [plannable("a", "2026-01-01", "2026-01-06"), plannable("b", "2026-01-01", "2026-01-06")],
      [edge("a", "b", type, lag)],
      [move("a", "2026-01-01", "2026-01-06")],
    )
    assert.equal(plan.ok, true)
    assert.deepEqual(byId(plan).b, [expectedStart, expectedEnd, "dependency"])
  })
}

test("a successor with two predecessors starts when the later one finishes, whatever the order", () => {
  const items = [plannable("a", "2026-03-01", "2026-03-05"), plannable("b", "2026-03-01", "2026-03-05"), plannable("c", "2026-03-06", "2026-03-08")]
  for (const edges of [[edge("a", "c"), edge("b", "c")], [edge("b", "c"), edge("a", "c")]]) {
    const plan = planScheduleMove(items, edges, [move("a", "2026-03-10", "2026-03-14"), move("b", "2026-03-02", "2026-03-04")])
    assert.deepEqual(byId(plan).c, ["2026-03-14", "2026-03-16", "dependency"])
  }
})

test("a successor held by an untouched predecessor does not move earlier", () => {
  const items = [plannable("a", "2026-03-01", "2026-03-05"), plannable("b", "2026-03-01", "2026-03-20"), plannable("c", "2026-03-20", "2026-03-22")]
  const plan = planScheduleMove(items, [edge("a", "c"), edge("b", "c")], [move("a", "2026-03-10", "2026-03-12")])
  assert.deepEqual(plan.changes.map((change) => change.id), ["a"])
})

test("changes ripple through a chain, skipping finished work and must-start pins", () => {
  const items = [
    plannable("a", "2026-04-01", "2026-04-02"), plannable("b", "2026-04-02", "2026-04-03"),
    plannable("done", "2026-04-03", "2026-04-04", { status: "completed" }),
    plannable("pinned", "2026-04-03", "2026-04-04", { constraint_type: "must_start_on" }),
    plannable("tail", "2026-04-04", "2026-04-05"),
  ]
  const plan = planScheduleMove(items, [edge("a", "b"), edge("b", "done"), edge("b", "pinned"), edge("b", "tail")], [move("a", "2026-04-10", "2026-04-11")])
  assert.deepEqual(byId(plan), {
    a: ["2026-04-10", "2026-04-11", "requested"],
    b: ["2026-04-11", "2026-04-12", "dependency"],
    tail: ["2026-04-12", "2026-04-13", "dependency"],
  })
})

test("a stored dependency loop is refused instead of looping", () => {
  const items = [plannable("a", "2026-05-01", "2026-05-02"), plannable("b", "2026-05-02", "2026-05-03")]
  const plan = planScheduleMove(items, [edge("a", "b"), edge("b", "a")], [move("a", "2026-05-05", "2026-05-06")])
  assert.equal(plan.ok, false)
})

test("a move must name a known item, real calendar dates and end on or after start", () => {
  const items = [plannable("a", "2026-05-01", "2026-05-02")]
  assert.equal(planScheduleMove(items, [], [move("missing", "2026-05-01", "2026-05-02")]).ok, false)
  assert.equal(planScheduleMove(items, [], [move("a", "2026-02-30", "2026-03-01")]).ok, false)
  assert.equal(planScheduleMove(items, [], [move("a", "2026-05-03", "2026-05-02")]).ok, false)
})

test("planning is calendar-day arithmetic across a daylight-saving change", () => {
  const items = [plannable("a", "2026-03-06", "2026-03-07"), plannable("b", "2026-03-07", "2026-03-09")]
  const plan = planScheduleMove(items, [edge("a", "b")], [move("a", "2026-03-07", "2026-03-09")])
  assert.deepEqual(byId(plan).b, ["2026-03-09", "2026-03-11", "dependency"])
})
