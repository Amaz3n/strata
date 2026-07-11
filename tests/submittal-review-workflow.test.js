require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  finalApprovedDecision,
  nextPendingReviewGroup,
  reviewGroupCourtLabel,
  reviewGroupIsComplete,
} = require("../lib/submittal-review-workflow")

const step = (id, order, group, status, decision = null) => ({
  id,
  step_order: order,
  review_group: group,
  status,
  decision,
  role_label: id,
})

test("selects every pending step in the next parallel group", () => {
  const steps = [step("GC", 1, 1, "returned"), step("Structural", 2, 2, "pending"), step("MEP", 3, 2, "pending"), step("Owner", 4, 3, "pending")]
  assert.deepEqual(nextPendingReviewGroup(steps, 1).map((item) => item.id), ["Structural", "MEP"])
})

test("parallel group waits for every reviewer to return", () => {
  const waiting = [step("Structural", 2, 2, "returned"), step("MEP", 3, 2, "in_review")]
  assert.equal(reviewGroupIsComplete(waiting, 2), false)
  assert.equal(reviewGroupIsComplete(waiting.map((item) => ({ ...item, status: "returned" })), 2), true)
})

test("court label names all concurrent reviewers", () => {
  assert.equal(reviewGroupCourtLabel([step("Structural", 2, 2, "in_review"), step("MEP", 3, 2, "in_review")]), "Structural + MEP")
})

test("approved as noted in any branch controls the final decision", () => {
  assert.equal(finalApprovedDecision([step("Structural", 2, 2, "returned", "approved"), step("MEP", 3, 2, "returned", "approved_as_noted")]), "approved_as_noted")
})
