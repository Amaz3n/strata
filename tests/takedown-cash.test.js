require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { landObligationsByMonth, takedownCash } = require("../lib/land/takedown-cash")

const TODAY = "2026-10-12"
const takedown = (patch = {}) => ({
  id: "td-1",
  scheduledDate: "2026-12-01",
  lotCount: 10,
  pricePerLotCents: 72_000_00,
  status: "scheduled",
  ...patch,
})
const deposit = (patch = {}) => ({ takedownId: "td-1", dueOn: "2026-10-20", amountCents: 50_000_00, status: "scheduled", ...patch })

test("a takedown closes for its price less the deposits credited against it", () => {
  const cash = takedownCash(takedown(), [
    deposit({ status: "paid" }),
    deposit({ status: "scheduled", amountCents: 25_000_00 }),
    deposit({ takedownId: "other", amountCents: 99_000_00 }),
  ])
  assert.deepEqual(cash, { grossCents: 720_000_00, creditedDepositCents: 75_000_00, netCents: 645_000_00 })
})

test("a refunded or forfeited deposit is no longer a credit", () => {
  const cash = takedownCash(takedown(), [deposit({ status: "refunded" }), deposit({ status: "forfeited" })])
  assert.equal(cash.netCents, 720_000_00)
})

test("deposits and the closing they are credited against never count the same dollars twice", () => {
  const months = landObligationsByMonth({
    takedowns: [takedown()],
    deposits: [deposit({ dueOn: "2026-10-20" })],
    fees: [],
    today: TODAY,
  })
  assert.deepEqual(months, [
    { month: "2026-10", takedownCents: 0, depositCents: 50_000_00, feeCents: 0, totalCents: 50_000_00 },
    { month: "2026-12", takedownCents: 670_000_00, depositCents: 0, feeCents: 0, totalCents: 670_000_00 },
  ])
  assert.equal(months.reduce((sum, row) => sum + row.totalCents, 0), 720_000_00)
})

test("overdue scheduled obligations are owed now; closed and cancelled takedowns and past fees are not", () => {
  const months = landObligationsByMonth({
    takedowns: [
      takedown({ id: "late", scheduledDate: "2026-08-01", lotCount: 1, pricePerLotCents: 10_000_00 }),
      takedown({ id: "closed", status: "closed" }),
      takedown({ id: "cancelled", status: "cancelled" }),
      takedown({ id: "undated", scheduledDate: null }),
    ],
    deposits: [deposit({ takedownId: null, dueOn: "2026-09-01", amountCents: 5_000_00 }), deposit({ takedownId: null, status: "paid" })],
    fees: [{ dueOn: "2026-09-30", feeCents: 1_000_00 }, { dueOn: "2027-01-15", feeCents: 2_500_00 }, { dueOn: null, feeCents: 9_00 }],
    today: TODAY,
  })
  assert.deepEqual(months, [
    { month: "2026-10", takedownCents: 10_000_00, depositCents: 5_000_00, feeCents: 0, totalCents: 15_000_00 },
    { month: "2027-01", takedownCents: 0, depositCents: 0, feeCents: 2_500_00, totalCents: 2_500_00 },
  ])
})

test("deposits beyond the price leave nothing due at closing rather than cash coming back", () => {
  assert.equal(takedownCash(takedown({ lotCount: 1, pricePerLotCents: 10_00 }), [deposit({ amountCents: 50_00 })]).netCents, 0)
})
