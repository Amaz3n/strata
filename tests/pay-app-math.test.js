require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  computePayAppLine,
  computePayAppSummary,
  normalizeRetainageSchedule,
  resolveRetainageRatePercent,
  thisPeriodFromPercentComplete,
} = require("../lib/financials/pay-app-math")

test("retainage schedule normalization sorts steps and rejects malformed values", () => {
  const schedule = normalizeRetainageSchedule([
    { until_percent_complete: 100, retainage_percent: 5 },
    { until_percent_complete: 50, retainage_percent: 10 },
  ])
  assert.deepEqual(schedule, [
    { until_percent_complete: 50, retainage_percent: 10 },
    { until_percent_complete: 100, retainage_percent: 5 },
  ])

  assert.equal(normalizeRetainageSchedule(null), null)
  assert.equal(normalizeRetainageSchedule([]), null)
  assert.equal(normalizeRetainageSchedule([{ until_percent_complete: 0, retainage_percent: 10 }]), null)
  assert.equal(normalizeRetainageSchedule([{ until_percent_complete: 50, retainage_percent: 101 }]), null)
  assert.equal(normalizeRetainageSchedule("10"), null)
})

test("retainage rate resolution: override beats schedule beats flat contract rate", () => {
  const schedule = normalizeRetainageSchedule([
    { until_percent_complete: 50, retainage_percent: 10 },
    { until_percent_complete: 100, retainage_percent: 5 },
  ])

  assert.equal(
    resolveRetainageRatePercent({ percentComplete: 30, schedule, lineOverridePercent: 2, contractPercent: 10 }),
    2,
  )
  assert.equal(
    resolveRetainageRatePercent({ percentComplete: 30, schedule, lineOverridePercent: null, contractPercent: 10 }),
    10,
  )
  assert.equal(
    resolveRetainageRatePercent({ percentComplete: 50, schedule, lineOverridePercent: null, contractPercent: 10 }),
    10,
  )
  // Crossing the 50% step bills at the reduced rate.
  assert.equal(
    resolveRetainageRatePercent({ percentComplete: 50.01, schedule, lineOverridePercent: null, contractPercent: 10 }),
    5,
  )
  assert.equal(
    resolveRetainageRatePercent({ percentComplete: 100, schedule, lineOverridePercent: null, contractPercent: 10 }),
    5,
  )
  assert.equal(
    resolveRetainageRatePercent({ percentComplete: 30, schedule: null, lineOverridePercent: null, contractPercent: 10 }),
    10,
  )
})

test("percent-complete entry converts to this-period cents against previous billed", () => {
  assert.equal(
    thisPeriodFromPercentComplete({ scheduledValueCents: 100000, percentComplete: 40, previousBilledCents: 25000 }),
    15000,
  )
  // Reducing percent below previous billed produces a negative correction.
  assert.equal(
    thisPeriodFromPercentComplete({ scheduledValueCents: 100000, percentComplete: 20, previousBilledCents: 25000 }),
    -5000,
  )
})

test("pay app line math: totals, percent, retainage on this-period work and stored delta", () => {
  const line = computePayAppLine({
    scheduledValueCents: 1000000,
    previousBilledCents: 200000,
    thisPeriodCents: 300000,
    storedMaterialsCents: 100000,
    previousStoredMaterialsCents: 40000,
    workRetainagePercent: 10,
    storedMaterialsRetainagePercent: 10,
  })

  assert.equal(line.totalCompletedAndStoredCents, 600000)
  assert.equal(line.percentComplete, 50)
  assert.equal(line.balanceToFinishCents, 400000)
  // 10% of 300,000 work + 10% of 60,000 stored delta.
  assert.equal(line.retainageCents, 36000)
  assert.equal(line.overbilled, false)
})

test("stored materials converting to installed work nets retainage at equal rates", () => {
  // Materials previously stored are installed this period: stored balance drops
  // to zero, the work shows up in this_period; retainage held stays flat.
  const line = computePayAppLine({
    scheduledValueCents: 500000,
    previousBilledCents: 100000,
    thisPeriodCents: 80000,
    storedMaterialsCents: 0,
    previousStoredMaterialsCents: 80000,
    workRetainagePercent: 10,
    storedMaterialsRetainagePercent: 10,
  })
  assert.equal(line.retainageCents, 0)
})

test("overbilling is flagged when completed plus stored exceeds scheduled value", () => {
  const line = computePayAppLine({
    scheduledValueCents: 100000,
    previousBilledCents: 90000,
    thisPeriodCents: 20000,
    storedMaterialsCents: 0,
    previousStoredMaterialsCents: 0,
    workRetainagePercent: 0,
    storedMaterialsRetainagePercent: 0,
  })
  assert.equal(line.overbilled, true)
})

test("G702 summary math reconciles payment due with the invoice amount", () => {
  const lineA = computePayAppLine({
    scheduledValueCents: 600000,
    previousBilledCents: 100000,
    thisPeriodCents: 200000,
    storedMaterialsCents: 50000,
    previousStoredMaterialsCents: 0,
    workRetainagePercent: 10,
    storedMaterialsRetainagePercent: 10,
  })
  const lineB = computePayAppLine({
    scheduledValueCents: 400000,
    previousBilledCents: 50000,
    thisPeriodCents: 100000,
    storedMaterialsCents: 0,
    previousStoredMaterialsCents: 0,
    workRetainagePercent: 10,
    storedMaterialsRetainagePercent: 10,
  })

  // Prior state: 150,000 billed work, 15,000 retainage held, one prior
  // certificate paying 135,000 (150,000 − 15,000).
  const summary = computePayAppSummary({
    originalContractSumCents: 1000000,
    changeOrderSumCents: 0,
    previousRetainageHeldCents: 15000,
    previousCertificatesCents: 135000,
    lines: [lineA, lineB],
  })

  assert.equal(summary.contractSumToDateCents, 1000000)
  assert.equal(summary.totalCompletedStoredCents, 500000)
  // This app withholds 10% of 300,000 work + 10% of 50,000 stored = 35,000.
  assert.equal(summary.currentRetainageCents, 35000)
  assert.equal(summary.retainageCents, 50000)
  assert.equal(summary.totalEarnedLessRetainageCents, 450000)
  assert.equal(summary.currentPaymentDueCents, 315000)
  // Payment due equals this period's gross (350,000) minus this app's retainage.
  assert.equal(summary.currentPaymentDueCents, 350000 - 35000)
  assert.equal(summary.balanceToFinishCents, 500000)
})

test("change orders extend the contract sum to date and balance to finish", () => {
  const summary = computePayAppSummary({
    originalContractSumCents: 1000000,
    changeOrderSumCents: 250000,
    previousRetainageHeldCents: 0,
    previousCertificatesCents: 0,
    lines: [],
  })
  assert.equal(summary.contractSumToDateCents, 1250000)
  assert.equal(summary.balanceToFinishCents, 1250000)
})
