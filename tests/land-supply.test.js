require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { buildRunway } = require("../lib/land/runway")
const { lotShortfallByYear, dryDateFrom, compareSupplyUrgency } = require("../lib/land/supply")
const {
  inventoryFilterClauses,
  inventoryWindow,
  isTruncated,
  orderColumns,
  isInventorySort,
  searchPattern,
} = require("../lib/land/inventory-query")

/* -------------------------------------------------------------------------- */
/* Land supply aggregated across communities                                   */
/* -------------------------------------------------------------------------- */

test("a community with lots and no takedowns runs short in the year it empties", () => {
  // 60 sellable lots consumed at 5/month lasts a year. The horizon is two, so
  // the second year is entirely short.
  const shortfall = lotShortfallByYear({
    sellableLots: 60,
    consumptionPerMonth: 5,
    deliveries: [],
    horizonMonths: 24,
    startYear: 2026,
    startMonth: 0,
  })
  assert.deepEqual(shortfall, [{ year: 2027, lotsNeeded: 60 }])
})

test("a takedown inside the horizon covers the shortfall it was bought to cover", () => {
  const withoutTakedown = lotShortfallByYear({
    sellableLots: 60,
    consumptionPerMonth: 5,
    deliveries: [],
    horizonMonths: 24,
    startYear: 2026,
    startMonth: 0,
  })
  const withTakedown = lotShortfallByYear({
    sellableLots: 60,
    consumptionPerMonth: 5,
    deliveries: [{ monthOffset: 12, lotCount: 60 }],
    horizonMonths: 24,
    startYear: 2026,
    startMonth: 0,
  })
  assert.equal(withoutTakedown[0].lotsNeeded, 60)
  assert.deepEqual(withTakedown, [])
})

test("a shortfall is attributed to the calendar year it lands in, not to month zero", () => {
  // Starting in October, a year of supply runs out in the following October, so
  // the buy is a 2027 problem even though the community is short from month 12.
  const shortfall = lotShortfallByYear({
    sellableLots: 15,
    consumptionPerMonth: 5,
    deliveries: [],
    horizonMonths: 12,
    startYear: 2026,
    startMonth: 9,
  })
  // Three months of supply from October covers October, November, and December,
  // so every short month — January through September — falls in 2027.
  assert.deepEqual(shortfall, [{ year: 2027, lotsNeeded: 45 }])
})

test("a community nobody has started a house in reports no shortfall rather than a confident zero", () => {
  // An unknown consumption rate is not a rate of zero. Reporting "fine" for a
  // community with no measured pace would be the loudest wrong number here.
  assert.deepEqual(
    lotShortfallByYear({
      sellableLots: 0,
      consumptionPerMonth: null,
      deliveries: [],
      horizonMonths: 24,
      startYear: 2026,
      startMonth: 0,
    }),
    [],
  )
  assert.deepEqual(
    lotShortfallByYear({
      sellableLots: 10,
      consumptionPerMonth: 0,
      deliveries: [],
      horizonMonths: 24,
      startYear: 2026,
      startMonth: 0,
    }),
    [],
  )
})

test("the aggregate agrees with the per-community runway it is built from", () => {
  // The board says this community goes dry at month 12; the report must not say
  // it is fine through the horizon.
  const { dryAtMonth } = buildRunway(60, 5, [], 24)
  assert.equal(dryAtMonth, 12)
  const shortfall = lotShortfallByYear({
    sellableLots: 60,
    consumptionPerMonth: 5,
    deliveries: [],
    horizonMonths: 24,
    startYear: 2026,
    startMonth: 0,
  })
  assert.equal(shortfall.length, 1)
  assert.equal(shortfall[0].year, 2027)
})

test("a dry month offset becomes a date a land buyer can negotiate against", () => {
  const today = new Date(2026, 7, 17)
  assert.equal(dryDateFrom(today, 0), "2026-08-01")
  assert.equal(dryDateFrom(today, 12), "2027-08-01")
  assert.equal(dryDateFrom(today, 5.8), "2027-01-01")
  assert.equal(dryDateFrom(today, null), null)
})

test("communities triage driest first, then thinnest", () => {
  const rows = [
    { name: "never dry", dryAtMonth: null, monthsOfSupply: 40 },
    { name: "dry in 18", dryAtMonth: 18, monthsOfSupply: 18 },
    { name: "dry in 4", dryAtMonth: 4, monthsOfSupply: 4 },
    { name: "never dry but thin", dryAtMonth: null, monthsOfSupply: 9 },
  ]
  assert.deepEqual(
    [...rows].sort(compareSupplyUrgency).map((row) => row.name),
    ["dry in 4", "dry in 18", "never dry but thin", "never dry"],
  )
})

/* -------------------------------------------------------------------------- */
/* Inventory filter, sort, page, and truncation composition                    */
/* -------------------------------------------------------------------------- */

test("no filters means no clauses, so a bulk edit cannot be handed a stray one", () => {
  assert.deepEqual(inventoryFilterClauses({}), [])
})

test("status, phase, and search compose into the same clauses for every read", () => {
  assert.deepEqual(inventoryFilterClauses({ status: "owned", phaseId: "phase-2", search: "Cypress" }), [
    { kind: "eq", column: "status", value: "owned" },
    { kind: "eq", column: "community_phase_id", value: "phase-2" },
    { kind: "or", filter: "lot_number.ilike.%Cypress%,block.ilike.%Cypress%,address.ilike.%Cypress%" },
  ])
})

test("a search term is bounded and stripped of the characters PostgREST reads as syntax", () => {
  assert.equal(searchPattern("a,b(c)*d"), "a b c  d")
  assert.equal(searchPattern("x".repeat(120)).length, 60)
  // A term that is only punctuation produces no clause at all rather than a
  // pattern that matches the whole community.
  assert.deepEqual(inventoryFilterClauses({ search: "  ,,  " }), [])
})

test("sorting falls back to lot order and carries its tiebreakers", () => {
  assert.deepEqual(orderColumns({}), [
    { name: "block", ascending: true },
    { name: "lot_number", ascending: true },
  ])
  assert.deepEqual(orderColumns({ sort: "status", direction: "desc" }), [
    { name: "status", ascending: false },
    { name: "block", ascending: false },
    { name: "lot_number", ascending: false },
  ])
  assert.equal(isInventorySort("premium"), true)
  assert.equal(isInventorySort("margin"), false)
  assert.equal(isInventorySort(undefined), false)
})

test("the page window is clamped, because page and size arrive off a query string", () => {
  const bounds = { defaultPageSize: 100, maxPageSize: 600 }
  assert.deepEqual(inventoryWindow({}, bounds), { page: 1, pageSize: 100, from: 0, to: 99 })
  assert.deepEqual(inventoryWindow({ page: 4 }, bounds), { page: 4, pageSize: 100, from: 300, to: 399 })
  // Page 0 and a negative page are a URL away.
  assert.equal(inventoryWindow({ page: 0 }, bounds).page, 1)
  assert.equal(inventoryWindow({ page: -3 }, bounds).page, 1)
  // So is asking for the whole 400-lot community in one request.
  assert.equal(inventoryWindow({ pageSize: 10_000 }, bounds).pageSize, 600)
  assert.equal(inventoryWindow({ pageSize: 0 }, bounds).pageSize, 1)
})

test("truncation is reported from the total, not guessed from the page", () => {
  // A 400-lot community read 100 at a time: every page but the last says so.
  assert.equal(isTruncated({ total: 400, from: 0, returned: 100 }), true)
  assert.equal(isTruncated({ total: 400, from: 300, returned: 100 }), false)
  // A short final page must not read as "there is more".
  assert.equal(isTruncated({ total: 350, from: 300, returned: 50 }), false)
  assert.equal(isTruncated({ total: 0, from: 0, returned: 0 }), false)
})
