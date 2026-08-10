require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")

const {
  EVEN_FLOW_MIN_SAMPLE,
  comparableSampleSize,
  evaluateEvenFlowCostCode,
  evenFlowFingerprint,
  medianAbsoluteDeviationCents,
  medianCents,
  readEvenFlowAssessment,
  totalComparablesByLot,
} = require("../lib/financials/even-flow-price-anomaly")

const {
  SCHEDULE_LEAD_TOLERANCE_DAYS,
  billScheduleFingerprint,
  crosscheckBillAgainstSchedule,
  daysBetweenIsoDates,
  earliestScheduleWindowPerCostCode,
  formatScheduleDate,
  parseIsoDateToUtcMillis,
  readBillScheduleAssessment,
} = require("../lib/financials/bill-schedule-crosscheck")

// ————————————————————————————————— even-flow —————————————————————————————————

/** N comparable lots, each billed the same amount unless overridden. */
const lots = (amounts) => amounts.map((amountCents, index) => ({ projectId: `lot-${index}`, amountCents }))

const evaluate = (subjectAmountCents, comparables, overrides = {}) =>
  evaluateEvenFlowCostCode({
    costCodeId: "cc-drywall",
    costCodeLabel: "Drywall",
    subjectAmountCents,
    comparables,
    scope: "community",
    scopeLabel: "Sundance Ridge",
    housePlanLabel: "Plan 2840",
    ...overrides,
  })

test("median is robust and stays in whole cents on even samples", () => {
  assert.equal(medianCents([300, 100, 200]), 200)
  assert.equal(medianCents([]), 0)
  // Even count takes the midpoint of the two central values. 367001 and 367002
  // average to 367001.5, which must not leak a half-cent into the arithmetic.
  assert.equal(medianCents([367001, 367002]), 367002)
  assert.equal(medianCents([367001, 367004]), 367003)
  assert.equal(Number.isInteger(medianCents([1, 2, 3, 4])), true)
  // One wild outlier must not move the centre — the whole reason for a median.
  assert.equal(medianCents([100, 100, 100, 100, 4_000_000]), 100)
})

test("MAD measures spread from the median and is zero on an identical sample", () => {
  assert.equal(medianAbsoluteDeviationCents([100, 100, 100, 100, 100], 100), 0)
  assert.equal(medianAbsoluteDeviationCents([100, 200, 300], 200), 100)
})

test("a lot's comparable is the sum of its bills, and credited-out lots drop out", () => {
  const totals = totalComparablesByLot([
    { projectId: "lot-a", amountCents: 200_000 },
    { projectId: "lot-a", amountCents: 167_000 },
    { projectId: "lot-b", amountCents: 367_000 },
    // Fully credited back: not a price this plan was ever built at.
    { projectId: "lot-c", amountCents: 367_000 },
    { projectId: "lot-c", amountCents: -367_000 },
  ])
  assert.deepEqual(totals.sort((a, b) => a - b), [367_000, 367_000])
  assert.equal(comparableSampleSize([{ projectId: "lot-a", amountCents: 1 }]), 1)
})

test("small samples produce no claim at all, however extreme the deviation", () => {
  // Four lots that all billed $3,670 and a bill at triple that. Obvious to the
  // eye, but four is not a distribution — say nothing rather than guess.
  for (let count = 0; count < EVEN_FLOW_MIN_SAMPLE; count += 1) {
    const comparables = lots(new Array(count).fill(367_000))
    assert.equal(evaluate(1_101_000, comparables), null, `sample of ${count} must be silent`)
  }
})

test("the minimum sample is exactly five and the claim states its basis", () => {
  const claim = evaluate(418_000, lots(new Array(EVEN_FLOW_MIN_SAMPLE).fill(367_000)))
  assert.ok(claim)
  assert.equal(claim.sampleCount, 5)
  assert.equal(claim.medianCents, 367_000)
  assert.equal(claim.direction, "above")
  assert.match(claim.claim, /\$4,180 vs \$3,670 median of 5 lots/)
})

test("an obvious outlier is caught against a realistic spread", () => {
  // 23 lots of drywall clustered around $3,670, and one bill at $4,180.
  const spread = [
    365_000, 366_000, 366_500, 367_000, 367_000, 367_000, 367_500, 368_000,
    365_500, 366_800, 367_200, 367_000, 366_000, 368_500, 367_000, 366_200,
    367_800, 367_000, 365_800, 368_200, 367_000, 366_600, 367_400,
  ]
  const claim = evaluate(418_000, lots(spread))
  assert.ok(claim)
  assert.equal(claim.sampleCount, 23)
  assert.equal(claim.medianCents, 367_000)
  assert.ok(claim.madCents > 0)
  assert.ok(Math.abs(claim.robustZ) >= 3.5)
  assert.equal(claim.deviationPercent, 13.9)
  assert.match(claim.claim, /^Drywall is 13\.9% above the median for Plan 2840 in Sundance Ridge/)
  assert.match(claim.claim, /median of 23 lots\.$/)
})

test("ordinary drift inside the plan's own spread is not a claim", () => {
  const spread = [360_000, 365_000, 367_000, 370_000, 375_000, 380_000, 355_000]
  // 4% off the median, and well inside the natural spread: silent.
  assert.equal(evaluate(382_000, lots(spread)), null)
})

test("a wide-but-noisy sample suppresses a claim the percentage alone would make", () => {
  // These lots genuinely vary by a third, so a 20% deviation is unremarkable.
  const noisy = lots([200_000, 250_000, 300_000, 350_000, 400_000, 450_000, 500_000])
  const claim = evaluate(420_000, noisy)
  assert.equal(claim, null)
})

test("an identical sample makes the percentage the whole signal", () => {
  // Twenty-three lots billed to the cent and one that is not: MAD is zero, so
  // there is no spread to scale against and the deviation alone carries it.
  const claim = evaluate(418_000, lots(new Array(23).fill(367_000)))
  assert.ok(claim)
  assert.equal(claim.madCents, 0)
  assert.equal(claim.robustZ, null)
  assert.equal(claim.deviationPercent, 13.9)
})

test("deductive and credit payables are never priced", () => {
  const comparables = lots(new Array(12).fill(367_000))
  assert.equal(evaluate(-418_000, comparables), null)
  assert.equal(evaluate(0, comparables), null)
})

test("odd cents round to one decimal place without drifting", () => {
  // $3,670.01 median against $4,180.07 — the deviation must not carry noise.
  const claim = evaluate(418_007, lots(new Array(9).fill(367_001)))
  assert.ok(claim)
  assert.equal(claim.deviationPercent, 13.9)
  // A whole-number deviation prints without a trailing ".0".
  const round = evaluate(440_400, lots(new Array(9).fill(367_000)))
  assert.ok(round)
  assert.equal(round.deviationPercent, 20)
  assert.match(round.claim, /is 20% above the median/)
})

test("an under-market bill is reported without the alarm of an over-market one", () => {
  const claim = evaluate(300_000, lots(new Array(11).fill(367_000)))
  assert.ok(claim)
  assert.equal(claim.direction, "below")
  assert.match(claim.claim, /18\.3% below the median/)
})

test("even-flow fingerprints ignore order but track every input", () => {
  const base = {
    housePlanId: "plan-2840",
    subjectCosts: [{ costCodeId: "cc-a", amountCents: 418_000 }],
    comparables: [
      { costCodeId: "cc-a", projectId: "lot-1", amountCents: 367_000 },
      { costCodeId: "cc-a", projectId: "lot-2", amountCents: 366_000 },
    ],
  }
  assert.equal(
    evenFlowFingerprint(base),
    evenFlowFingerprint({ ...base, comparables: [...base.comparables].reverse() }),
  )
  assert.notEqual(
    evenFlowFingerprint(base),
    evenFlowFingerprint({ ...base, subjectCosts: [{ costCodeId: "cc-a", amountCents: 418_001 }] }),
  )
  assert.notEqual(
    evenFlowFingerprint(base),
    evenFlowFingerprint({ ...base, comparables: [base.comparables[0]] }),
  )
  assert.notEqual(evenFlowFingerprint(base), evenFlowFingerprint({ ...base, housePlanId: "plan-2900" }))
})

test("stored even-flow assessments are read defensively", () => {
  const good = { version: 1, fingerprint: "abc", housePlanLabel: "Plan 2840", claims: [] }
  assert.deepEqual(readEvenFlowAssessment({ even_flow_price: good }), good)
  assert.equal(readEvenFlowAssessment(null), null)
  assert.equal(readEvenFlowAssessment({}), null)
  assert.equal(readEvenFlowAssessment({ even_flow_price: { ...good, version: 2 } }), null)
  assert.equal(readEvenFlowAssessment({ even_flow_price: { ...good, claims: "nope" } }), null)
})

// ———————————————————————————— bill vs schedule ————————————————————————————

const window = (overrides = {}) => ({
  costCodeId: "cc-drywall",
  costCodeLabel: "Drywall",
  scheduleItemId: "item-1",
  scheduleItemName: "Drywall hang",
  startDate: "2026-03-24",
  ...overrides,
})

test("dates parse at UTC midnight so no timezone moves the day", () => {
  assert.equal(parseIsoDateToUtcMillis("2026-03-24"), Date.UTC(2026, 2, 24))
  assert.equal(parseIsoDateToUtcMillis("2026-03-24T18:00:00Z"), Date.UTC(2026, 2, 24))
  assert.equal(parseIsoDateToUtcMillis("not a date"), null)
  assert.equal(parseIsoDateToUtcMillis("2026-13-01"), null)
  assert.equal(parseIsoDateToUtcMillis(null), null)
})

test("day counts span month and year boundaries", () => {
  assert.equal(daysBetweenIsoDates("2026-03-05", "2026-03-24"), 19)
  assert.equal(daysBetweenIsoDates("2026-03-24", "2026-03-05"), -19)
  assert.equal(daysBetweenIsoDates("2026-02-27", "2026-03-01"), 2)
  assert.equal(daysBetweenIsoDates("2025-12-25", "2026-01-05"), 11)
  assert.equal(daysBetweenIsoDates("garbage", "2026-03-24"), null)
})

test("a bill well ahead of its trade's scheduled start is reported once, factually", () => {
  const findings = crosscheckBillAgainstSchedule({ billDate: "2026-03-05", windows: [window()] })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].daysEarly, 19)
  assert.equal(findings[0].claim, "Schedule shows Drywall hang starting Mar 24 — this bill predates it by 19 days.")
})

test("bills inside the lead tolerance, on time, or after the work say nothing", () => {
  const at = crosscheckBillAgainstSchedule({
    billDate: "2026-03-10", // exactly 14 days early
    windows: [window()],
  })
  assert.deepEqual(at, [])
  assert.equal(SCHEDULE_LEAD_TOLERANCE_DAYS, 14)
  assert.deepEqual(crosscheckBillAgainstSchedule({ billDate: "2026-03-24", windows: [window()] }), [])
  // Late invoicing and retainage releases are routine — never a claim.
  assert.deepEqual(crosscheckBillAgainstSchedule({ billDate: "2026-08-01", windows: [window()] }), [])
})

test("the earliest scheduled occurrence of a trade is the one that counts", () => {
  const windows = [
    window({ scheduleItemId: "item-late", startDate: "2026-03-24" }),
    window({ scheduleItemId: "item-early", scheduleItemName: "Drywall hang — garage", startDate: "2026-01-10" }),
  ]
  assert.deepEqual(
    earliestScheduleWindowPerCostCode(windows).map((entry) => entry.scheduleItemId),
    ["item-early"],
  )
  // The bill lands after the first occurrence, so there is nothing to report
  // even though a later occurrence is still weeks out.
  assert.deepEqual(crosscheckBillAgainstSchedule({ billDate: "2026-02-01", windows }), [])
})

test("undated and unparseable schedule rows are dropped rather than guessed at", () => {
  const windows = [window({ startDate: "" }), window({ scheduleItemId: "item-2", startDate: "TBD" })]
  assert.deepEqual(earliestScheduleWindowPerCostCode(windows), [])
  assert.deepEqual(crosscheckBillAgainstSchedule({ billDate: "2026-03-05", windows }), [])
  assert.deepEqual(crosscheckBillAgainstSchedule({ billDate: "", windows: [window()] }), [])
})

test("several trades on one bill each get their own line, worst first", () => {
  const findings = crosscheckBillAgainstSchedule({
    billDate: "2026-03-05",
    windows: [
      window(),
      window({ costCodeId: "cc-paint", costCodeLabel: "Paint", scheduleItemId: "item-2", scheduleItemName: "Interior paint", startDate: "2026-05-01" }),
    ],
  })
  assert.deepEqual(findings.map((finding) => finding.daysEarly), [57, 19])
})

test("a schedule date in another year carries the year", () => {
  assert.equal(formatScheduleDate("2026-03-24", "2026-03-05"), "Mar 24")
  assert.equal(formatScheduleDate("2027-01-04", "2026-12-20"), "Jan 4, 2027")
  const findings = crosscheckBillAgainstSchedule({ billDate: "2026-12-20", windows: [window({ startDate: "2027-01-04" })] })
  assert.match(findings[0].claim, /starting Jan 4, 2027 — this bill predates it by 15 days\./)
})

test("schedule fingerprints ignore order but track dates and items", () => {
  const base = {
    billDate: "2026-03-05",
    windows: [window(), window({ costCodeId: "cc-paint", scheduleItemId: "item-2", startDate: "2026-05-01" })],
  }
  assert.equal(
    billScheduleFingerprint(base),
    billScheduleFingerprint({ ...base, windows: [...base.windows].reverse() }),
  )
  assert.notEqual(billScheduleFingerprint(base), billScheduleFingerprint({ ...base, billDate: "2026-03-06" }))
  assert.notEqual(
    billScheduleFingerprint(base),
    billScheduleFingerprint({ ...base, windows: [window({ startDate: "2026-03-25" }), base.windows[1]] }),
  )
})

test("stored schedule assessments are read defensively", () => {
  const good = { version: 1, fingerprint: "abc", billDate: "2026-03-05", checkedCostCodeCount: 1, findings: [] }
  assert.deepEqual(readBillScheduleAssessment({ bill_schedule: good }), good)
  assert.equal(readBillScheduleAssessment(undefined), null)
  assert.equal(readBillScheduleAssessment({ bill_schedule: { ...good, findings: null } }), null)
  assert.equal(readBillScheduleAssessment({ bill_schedule: { ...good, version: 0 } }), null)
})
