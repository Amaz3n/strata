require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { feePosition, feeRemainingToLinkCents, permitFeeSummary } = require("@/lib/permits/fees")
const { approvalBlockers, permitAging, permitApplicationStage, permitReminderDue, permitReminderKey, rankPermitQueue } = require("@/lib/permits/lifecycle")

const TODAY = "2026-10-12"
const facts = (overrides = {}) => ({ decision: null, supersededAt: null, expiresOn: null, submissionCount: 1, openRounds: 0, ...overrides })

test("an application's stage is read from its facts", () => {
  const cases = [
    [{ submissionCount: 0 }, "draft"],
    [{}, "submitted"],
    [{ openRounds: 2 }, "corrections_requested"],
    [{ decision: "approved" }, "approved"],
    [{ decision: "approved", expiresOn: "2026-10-11" }, "expired"],
    [{ decision: "approved", expiresOn: TODAY }, "approved"],
    [{ decision: "not_required" }, "not_required"],
    [{ decision: "denied" }, "denied"],
    [{ decision: "approved", supersededAt: "2026-10-01T00:00:00Z" }, "superseded"],
  ]
  for (const [input, stage] of cases) assert.equal(permitApplicationStage(facts(input), TODAY), stage, JSON.stringify(input))
})

test("aging names who owes what: the authority its decision, the builder its response", () => {
  const waitingOnAuthority = permitAging({ stage: "submitted", expectedDecisionOn: "2026-10-09", rounds: [] }, TODAY)
  assert.deepEqual(waitingOnAuthority.decision, { state: "overdue", dueOn: "2026-10-09", daysOut: -3 })
  assert.equal(waitingOnAuthority.response, null)
  assert.equal(waitingOnAuthority.attention, "overdue")

  const waitingOnBuilder = permitAging({
    stage: "corrections_requested", expectedDecisionOn: "2026-10-01",
    rounds: [{ status: "open", dueOn: "2026-10-14" }, { status: "open", dueOn: "2026-10-30" }, { status: "resolved", dueOn: "2026-09-01" }],
  }, TODAY)
  assert.equal(waitingOnBuilder.decision, null, "the authority's clock stops while it waits on a response")
  assert.deepEqual(waitingOnBuilder.response, { state: "due_soon", dueOn: "2026-10-14", daysOut: 2 })
  assert.equal(waitingOnBuilder.unresolvedRounds, 2)

  const responded = permitAging({ stage: "submitted", expectedDecisionOn: "2026-11-01", rounds: [{ status: "responded", dueOn: "2026-10-01" }] }, TODAY)
  assert.equal(responded.attention, "on_track")
  assert.equal(responded.unresolvedRounds, 1)

  assert.equal(permitAging({ stage: "approved", expectedDecisionOn: "2026-09-01", rounds: [] }, TODAY).attention, null)
})

test("the coordinator queue holds what is late, coming due or unresolved, latest-starting houses last", () => {
  const row = (id, aging, startTargetWeek = null) => ({ id, aging, startTargetWeek })
  const aging = (stage, expectedDecisionOn, rounds = []) => permitAging({ stage, expectedDecisionOn, rounds }, TODAY)
  const ranked = rankPermitQueue([
    row("fine", aging("submitted", "2026-11-30")),
    row("responded", aging("submitted", "2026-11-30", [{ status: "responded", dueOn: null }])),
    row("late-later-start", aging("submitted", "2026-10-02"), "2026-12-07"),
    row("late-sooner-start", aging("submitted", "2026-10-10"), "2026-10-19"),
    row("response-soon", aging("corrections_requested", null, [{ status: "open", dueOn: "2026-10-13" }])),
  ])
  assert.deepEqual(ranked.map((entry) => entry.id), ["late-sooner-start", "late-later-start", "response-soon", "responded"])
})

test("reminders are sent once per threshold, and a recurring scope earns its own", () => {
  assert.equal(permitReminderDue("2026-10-20", TODAY, {}), null)
  assert.equal(permitReminderDue("2026-10-14", TODAY, {}), "due_soon")
  assert.equal(permitReminderDue("2026-10-14", TODAY, { [permitReminderKey("due_soon")]: "2026-10-11" }), null)
  assert.equal(permitReminderDue("2026-10-10", TODAY, { [permitReminderKey("due_soon")]: "2026-10-08" }), "overdue")
  const sent = { [permitReminderKey("overdue", "decision_1")]: "2026-10-10" }
  assert.equal(permitReminderDue("2026-10-01", TODAY, sent, "decision_1"), null)
  assert.equal(permitReminderDue("2026-10-01", TODAY, sent, "decision_2"), "overdue")
})

test("an approval's blockers read in the order someone would clear them", () => {
  assert.deepEqual(approvalBlockers({ submissionCount: 1, missingDocuments: [], openRounds: 0, needsReviewedPlan: false, unpaidPreIssuanceFees: [] }), [])
  assert.deepEqual(approvalBlockers({
    submissionCount: 0, missingDocuments: ["Plot / site plan"], openRounds: 2, needsReviewedPlan: true, unpaidPreIssuanceFees: ["Permit $2180.00"],
  }), [
    "Record the submission to the authority",
    "Attach Plot / site plan",
    "Respond to 2 open correction rounds",
    "Submit with the lot's plan pinned so the approval names the plan reviewed",
    "Pay the fees due before issuance: Permit $2180.00",
  ])
})

test("fees reconcile to what their payables actually paid", () => {
  const fees = [
    { id: "review", kind: "plan_review", amountCents: 45_000, status: "open", dueBefore: "submission" },
    { id: "permit", kind: "permit", amountCents: 218_000, status: "open", dueBefore: "issuance" },
    { id: "impact", kind: "impact", amountCents: 650_000, status: "open", dueBefore: "certificate_of_occupancy" },
    { id: "wrong", kind: "permit", amountCents: 999_000, status: "void", dueBefore: "issuance" },
  ]
  const payments = [
    { feeId: "review", source: "expense", totalCents: 45_000, paidCents: 0, status: "approved" },
    { feeId: "permit", source: "bill", totalCents: 218_000, paidCents: 120_000, status: "partial" },
    { feeId: "impact", source: "expense", totalCents: 650_000, paidCents: 0, status: "submitted" },
  ]
  const summary = permitFeeSummary(fees, payments)
  assert.deepEqual(summary.fees.map((fee) => [fee.feeId, fee.paidCents, fee.varianceCents, fee.reconciled]), [
    ["review", 45_000, 0, true],
    ["permit", 120_000, 98_000, false],
    ["impact", 0, 650_000, false],
    ["wrong", 0, 0, false],
  ])
  assert.deepEqual([summary.obligatedCents, summary.paidCents, summary.varianceCents, summary.reconciled], [913_000, 165_000, 748_000, false])
  assert.deepEqual(summary.unpaidPreIssuance.map((fee) => fee.id), ["permit"], "an impact fee due at certificate of occupancy does not hold issuance")

  const paidInFull = permitFeeSummary(fees.slice(0, 2), [payments[0], { ...payments[1], status: "paid", paidCents: 218_000 }])
  assert.equal(paidInFull.reconciled, true)

  const overpaid = feePosition(fees[0], [payments[0], { feeId: "review", source: "expense", totalCents: 5_000, paidCents: 0, status: "locked" }])
  assert.deepEqual([overpaid.varianceCents, overpaid.reconciled], [-5_000, false])

  const rejected = feePosition(fees[1], [{ ...payments[1], status: "rejected" }])
  assert.deepEqual([rejected.paidCents, rejected.linkedCents], [0, 0], "a rejected bill pays and holds nothing")
  assert.equal(feeRemainingToLinkCents(fees[1], payments), 0)
  assert.equal(feeRemainingToLinkCents(fees[1], [{ ...payments[1], totalCents: 200_000 }]), 18_000)
  assert.equal(feeRemainingToLinkCents(fees[3], []), 0, "a void fee takes no payment")
})
