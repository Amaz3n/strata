require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const {
  diffAcquisitionSnapshots,
  diligenceDeadlinePressure,
  diligenceSummary,
  landDealStage,
  pendingReminderThreshold,
  readAcquisitionSnapshot,
} = require("../lib/land/diligence")

const deal = (overrides = {}) => ({ droppedAt: null, contractExecutedOn: null, reviews: [], takedowns: [], ...overrides })

test("a deal's stage follows its facts, with closed land and a drop outranking everything else", () => {
  assert.equal(landDealStage(deal()), "screening")
  assert.equal(landDealStage(deal({ contractExecutedOn: "2026-09-01" })), "diligence")
  assert.equal(landDealStage(deal({ reviews: [{ status: "in_review", decision: "acquire" }] })), "in_review")
  assert.equal(landDealStage(deal({ reviews: [{ status: "approved", decision: "acquire" }] })), "approved")
  // A new version under review is the deal being decided again.
  assert.equal(
    landDealStage(deal({ reviews: [{ status: "approved", decision: "acquire" }, { status: "in_review", decision: "acquire" }] })),
    "in_review",
  )
  // An approved termination is not an approved acquisition.
  assert.equal(landDealStage(deal({ contractExecutedOn: "2026-09-01", reviews: [{ status: "approved", decision: "terminate" }] })), "diligence")
  assert.equal(landDealStage(deal({ droppedAt: "2026-10-01T00:00:00Z", reviews: [{ status: "in_review", decision: "acquire" }] })), "dropped")
  assert.equal(landDealStage(deal({ droppedAt: "2026-10-01T00:00:00Z", takedowns: [{ status: "closed" }] })), "acquired")
})

test("the checklist counts an issue as unresolved and only open items as overdue", () => {
  const summary = diligenceSummary(
    [
      { status: "satisfied", dueOn: "2026-09-01" },
      { status: "waived", dueOn: null },
      { status: "issue", dueOn: "2026-09-01" },
      { status: "open", dueOn: "2026-10-01" },
      { status: "open", dueOn: "2026-10-20" },
      { status: "open", dueOn: null },
    ],
    "2026-10-12",
  )
  assert.deepEqual(summary, { total: 6, satisfied: 1, waived: 1, issues: 1, open: 3, overdue: 1, nextDueOn: "2026-10-01" })
})

test("the deposit is at risk once the feasibility period passes without an approved decision", () => {
  const base = { stage: "diligence", diligenceEndsOn: "2026-10-01", depositCents: 250_000_00, reviews: [] }

  assert.deepEqual(diligenceDeadlinePressure(base, "2026-10-12"), { daysToDiligenceEnd: -11, depositAtRiskCents: 250_000_00, tone: "late" })
  assert.equal(diligenceDeadlinePressure({ ...base, reviews: [{ status: "approved" }] }, "2026-10-12").depositAtRiskCents, 0)
  assert.equal(diligenceDeadlinePressure({ ...base, diligenceEndsOn: "2026-10-20" }, "2026-10-12").tone, "aging")
  assert.equal(diligenceDeadlinePressure({ ...base, diligenceEndsOn: "2026-12-20" }, "2026-10-12").tone, "fresh")
  assert.deepEqual(diligenceDeadlinePressure({ ...base, stage: "dropped" }, "2026-10-12"), { daysToDiligenceEnd: null, depositAtRiskCents: 0, tone: "none" })
})

test("two reviewed versions show what moved in the terms, the checklist and the documents", () => {
  const previous = readAcquisitionSnapshot({
    decision: "acquire",
    terms: { purchase_price_cents: 6_000_000_00, planned_lot_count: 120 },
    items: [
      { id: "a", title: "Title", category: "title", status: "open", finding: null, due_on: null, waived_reason: null },
      { id: "b", title: "Survey", category: "survey", status: "open", finding: null, due_on: null, waived_reason: null },
    ],
    evidence: [{ item_id: "a", file_id: "f1", file_name: "commitment.pdf", checksum: "1" }],
    takedowns: [],
  })
  const next = readAcquisitionSnapshot({
    decision: "acquire",
    terms: { purchase_price_cents: 5_800_000_00, planned_lot_count: 120 },
    items: [
      { id: "a", title: "Title", category: "title", status: "satisfied", finding: "Clean", due_on: null, waived_reason: null },
      { id: "c", title: "Phase I", category: "environmental", status: "open", finding: null, due_on: null, waived_reason: null },
    ],
    evidence: [{ item_id: "a", file_id: "f1", file_name: "commitment.pdf", checksum: "2" }],
    takedowns: [],
  })

  assert.deepEqual(diffAcquisitionSnapshots(previous, next), [
    { kind: "term", field: "purchase_price_cents", from: 6_000_000_00, to: 5_800_000_00 },
    { kind: "item_changed", itemId: "a", title: "Title", fields: ["status", "finding"] },
    { kind: "item_added", itemId: "c", title: "Phase I" },
    { kind: "item_removed", itemId: "b", title: "Survey" },
    { kind: "evidence_added", itemId: "a", fileName: "commitment.pdf" },
    { kind: "evidence_removed", itemId: "a", fileName: "commitment.pdf" },
  ])
})

test("a stored snapshot that is not the expected shape reads as empty, not as a crash", () => {
  const snapshot = readAcquisitionSnapshot({ decision: "terminate", terms: { name: "X", nested: { a: 1 } }, items: "nope" })
  assert.equal(snapshot.decision, "terminate")
  assert.deepEqual(snapshot.terms, { name: "X", nested: null })
  assert.deepEqual(snapshot.items, [])
})

test("a reminder fires once at the tightest threshold crossed", () => {
  const key = (days) => `reminded_at_${days}d`
  assert.equal(pendingReminderThreshold([14, 3, 0], 20, {}, key), null)
  assert.equal(pendingReminderThreshold([14, 3, 0], 10, {}, key), 14)
  // Created late: the 3-day warning, not a stale 14-day one first.
  assert.equal(pendingReminderThreshold([14, 3, 0], 2, {}, key), 3)
  assert.equal(pendingReminderThreshold([14, 3, 0], 2, { reminded_at_3d: "x" }, key), null)
  assert.equal(pendingReminderThreshold([14, 3, 0], -4, { reminded_at_3d: "x" }, key), 0)
  assert.equal(pendingReminderThreshold([14, 3, 0], -5, { reminded_at_0d: "x" }, key), null)
})
