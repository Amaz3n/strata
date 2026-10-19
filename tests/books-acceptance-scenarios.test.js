const test = require("node:test"),
  assert = require("node:assert/strict")
const { runScenario } = require("../scripts/books-acceptance/scenario-runner.cjs")

const expected = (subcases) => ({ reviewedFrom: "unit fixture", subcases })
const scenario = (subcases) => ({ id: "UNIT-01", subcases })

test("incorrect accounting fails the scenario with the exact difference", async () => {
  const result = await runScenario("UNIT-01", {}, {
    expected: expected({ main: { cents: 100 } }),
    scenario: scenario({ main: async (_kit, spec, check) => { check.equal("revenue", spec.cents, 99) } }),
  })
  assert.equal(result.status, "FAILED")
  assert.deepEqual(result.subcases[0].checks[0], { label: "revenue", pass: false, expected: 100, observed: 99 })
})

test("a subcase that needs an outside sandbox is blocked, not skipped, when the run was not given it", async () => {
  let ran = false
  const run = (kit) => runScenario("UNIT-01", kit, {
    expected: expected({ main: { cents: 1 }, sandbox: { requires: "plaid" } }),
    scenario: scenario({ main: async (_kit, spec, check) => { check.equal("main", 1, 1) }, sandbox: async (_kit, _spec, check) => { ran = true; check.equal("sandbox", 1, 1) } }),
  })
  const without = await run({})
  assert.equal(without.status, "INCOMPLETE")
  assert.deepEqual(without.subcases.map((s) => s.status), ["PASSED", "BLOCKED"])
  assert.equal(ran, false)
  assert.equal((await run({ plaid: { env: "sandbox" } })).status, "PASSED")
})

test("subcases of one scenario share its fixtures; the next scenario on the same stack does not inherit them", async () => {
  // A scenario memoises its organisation per kit, as LOT-01's stages do.
  const orgs = new WeakMap()
  const stack = { sql: () => "" }
  const lotsTaken = []
  const takeLot = async (kit, _spec, check) => {
    const org = orgs.get(kit) ?? (orgs.set(kit, { next: 1 }), orgs.get(kit))
    lotsTaken.push(org.next++)
    check.equal("the stack's tools reach the scenario", stack.sql, kit.sql)
  }
  const run = () => runScenario("UNIT-01", stack, { expected: expected({ first: {}, second: {} }), scenario: scenario({ first: takeLot, second: takeLot }) })
  assert.equal((await run()).status, "PASSED")
  assert.equal((await run()).status, "PASSED")
  assert.deepEqual(lotsTaken, [1, 2, 1, 2])
})

test("the core gate reports what waits on the outside without failing; the full gate fails it", () => {
  const { allScenariosVerdict } = require("../scripts/books-acceptance/scenario-runner.cjs")
  const outside = [
    { scenario: "BILL-01", status: "PASSED" },
    { scenario: "SCALE-01", status: "NOT_RUN", disposition: "long_running" },
    { scenario: "STORE-01", status: "NOT_IMPLEMENTED", disposition: "blocked" },
    { scenario: "BANK-01", status: "INCOMPLETE", outsideOnly: true },
  ]
  assert.equal(allScenariosVerdict(outside, { core: true }).verdict, "PASSED")
  assert.equal(allScenariosVerdict(outside).verdict, "INCOMPLETE")
  assert.equal(allScenariosVerdict([...outside, { scenario: "AP-01", status: "INCOMPLETE", outsideOnly: false }], { core: true }).verdict, "INCOMPLETE")
  assert.equal(allScenariosVerdict([...outside, { scenario: "AP-01", status: "FAILED" }], { core: true }).verdict, "INCOMPLETE")
})

test("a required subcase that is not implemented keeps the scenario from passing", async () => {
  const result = await runScenario("UNIT-01", {}, {
    expected: expected({ main: { cents: 100 }, later: { status: "NOT_IMPLEMENTED" } }),
    scenario: scenario({ main: async (_kit, spec, check) => { check.equal("revenue", spec.cents, 100) } }),
  })
  assert.equal(result.status, "INCOMPLETE")
  assert.deepEqual(result.subcases.map((s) => s.status), ["PASSED", "NOT_IMPLEMENTED"])
})

test("a subcase that asserts nothing or throws cannot pass", async () => {
  const silent = await runScenario("UNIT-01", {}, { expected: expected({ main: {} }), scenario: scenario({ main: async () => {} }) })
  assert.equal(silent.status, "FAILED")
  const thrown = await runScenario("UNIT-01", {}, {
    expected: expected({ main: {} }),
    scenario: scenario({ main: async (_kit, _spec, check) => { check.equal("first", 1, 1); throw new Error("close blocked") } }),
  })
  assert.equal(thrown.status, "FAILED")
  assert.equal(thrown.subcases[0].error, "close blocked")
})

test("every golden scenario is either registered as implemented or reported as not implemented", async () => {
  const { GOLDEN_SCENARIOS } = require("../scripts/books-acceptance/runtime.cjs")
  const result = await runScenario("STORE-01", {})
  assert.ok(GOLDEN_SCENARIOS.includes("STORE-01"))
  assert.equal(result.status, "NOT_IMPLEMENTED")
})

test("the catalog verifier reports unknown scenarios, unsaved evidence and altered evidence", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path")
  const { verifyCatalog } = require("../scripts/books-acceptance/verify-catalog.cjs")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"))
  fs.writeFileSync(path.join(dir, "kept.json"), "{}")
  const relative = path.relative(path.join(__dirname, ".."), path.join(dir, "kept.json"))
  const item = (id, extra) => ({ id, title: id, status: "LOCALLY_VERIFIED", scenario_ids: ["BILL-01"], evidence: [{}], ...extra })
  const trackerPath = path.join(dir, "tracker.json")
  fs.writeFileSync(trackerPath, JSON.stringify({ items: [
    item("B02.1", { scenario_ids: ["NOPE-01"], evidence: [{ evidence_dir: "docs" }] }),
    item("B02.2"),
    item("B03.1", { evidence: [{ artifact_paths_and_hashes: [`${relative} sha256:${"0".repeat(64)}`] }] }),
    { id: "B13.1", title: "payroll", status: "PARTIAL" }, { id: "B14.3", title: "x", status: "PARTIAL" }, { id: "B14.4", title: "x", status: "PARTIAL" },
    { id: "B15.1", title: "x", status: "PARTIAL" }, { id: "B15.2", title: "x", status: "PARTIAL" }, { id: "B15.3", title: "x", status: "PARTIAL" },
    { id: "B03.3", title: "x", status: "PARTIAL" }, { id: "B06.4", title: "x", status: "PARTIAL" }, { id: "B01.2", title: "x", status: "PARTIAL" },
  ] }))
  const { findings } = verifyCatalog({ trackerPath, evidenceRoot: dir })
  assert.deepEqual(findings, ["B02.1 names unknown scenario NOPE-01", "B02.2 is verified without saved evidence", `B03.1 evidence ${relative} no longer matches its recorded hash`])
})

test("a subcase held open by a product defect runs only when asked, and passes once the defect is gone", async () => {
  const run = (options) => runScenario("UNIT-01", {}, {
    expected: expected({ main: { cents: 1 }, held: { status: "NOT_IMPLEMENTED", cents: 2 } }),
    scenario: scenario({
      main: async (_kit, spec, check) => { check.equal("main", spec.cents, 1) },
      held: async (_kit, spec, check) => { check.equal("held", spec.cents, 2) },
    }),
  }, null, options)
  const plain = await run()
  assert.equal(plain.status, "INCOMPLETE")
  assert.deepEqual(plain.subcases.map((s) => s.status), ["PASSED", "NOT_IMPLEMENTED"])
  const asked = await run({ includePending: true })
  assert.equal(asked.status, "PASSED")
})

test("LOT-01's reviewed numbers follow from the production fixtures it runs on", () => {
  const seed = require("../scripts/books-acceptance/production-seed.cjs")
  const { subcases } = require("../scripts/books-acceptance/expected/LOT-01.json")
  const plan = seed.PLANS[0]
  const design = Object.values(seed.DESIGN_PICKS).map((sku) => seed.OPTIONS.find((option) => option.sku === sku))
  const garage = seed.OPTIONS.find((option) => option.sku === "ST-GAR")
  const lotPremiumCents = 1500000

  // The agreement: plan price, lot premium, structural option, design choices.
  const priced = plan.basePriceCents + lotPremiumCents + garage.priceCents + design.reduce((sum, option) => sum + option.priceCents, 0)
  assert.equal(subcases["agreement-priced-and-signed"].expected.quote.totalCents, priced)

  // The release buys the plan's trades, the structural option the agreement sold and the design choices, from the trade that supplies each.
  const bought = [garage, ...design]
  const byVendor = Object.fromEntries(seed.TRADES.map((trade) => [trade.vendor, Math.round((trade.uom === "sf" ? plan.heatedSqft : 1) * trade.unitPriceDollars * 100)]))
  for (const option of bought) byVendor[option.vendor] += option.costCents
  const release = subcases["release-creates-the-house"].expected
  assert.deepEqual(release.purchaseOrders, Object.fromEntries(Object.entries(byVendor).sort(([a], [b]) => a.localeCompare(b))))
  assert.equal(release.purchaseOrderCents, seed.planTradeCostCents(plan) + bought.reduce((sum, option) => sum + option.costCents, 0))
  assert.equal(subcases["agreed-options-reach-purchase-orders"].expected.purchaseOrderCents, release.purchaseOrderCents)

  // The books: cost of sales is the land plus what was billed; margin is price less that.
  const closing = subcases["completion-and-closing"].expected
  const landCents = subcases["land-takedown"].inputs.landPerLotCents
  assert.equal(subcases["built-and-billed"].expected.houseInventoryCents, landCents + release.purchaseOrderCents)
  assert.deepEqual(closing.costOfSalesByComponent, { construction: release.purchaseOrderCents, land_and_development: landCents })
  assert.equal(closing.revenue, priced)
  assert.equal(closing.grossMarginCents, priced - landCents - release.purchaseOrderCents)
  assert.equal(closing.settlement.balanceDueCents, priced - closing.settlement.depositsApplied[0])
})

test("the production fixtures keep every month a release dated days from now can land in open", () => {
  const { defaultPeriods } = require("../scripts/books-acceptance/production-seed.cjs")
  const periods = defaultPeriods(new Date("2026-10-10T12:00:00Z"))
  assert.equal(periods[0], "2026-06")
  assert.equal(periods.at(-1), "2026-12")
  assert.equal(new Set(periods).size, periods.length)
})
