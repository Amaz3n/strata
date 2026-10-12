const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { captureHomeMarginBaseline } = freshRequire("lib/services/home-margin-baselines.ts")

const HOME = id(1)
const AGREEMENT = id(2)
const STRUCTURAL = id(3)

const signedPricing = {
  basePriceCents: 425_000_00,
  lotPremiumCents: 25_000_00,
  structuralOptions: [{ optionId: STRUCTURAL, label: "Covered patio", priceCents: 25_000_00, source: "community" }],
  designSelections: [],
  incentives: [{ incentiveId: id(4), name: "Closing costs", valueCents: 10_000_00 }],
  structuralOptionsCents: 25_000_00,
  designSelectionsCents: 0,
  incentivesCents: 10_000_00,
  totalCents: 465_000_00,
  quoteHash: "a".repeat(64),
  catalogRevision: "41",
}

function home({ contracts, budgets = [], inventory = [] } = {}) {
  return createServiceHarness({
    tables: {
      contracts: contracts ?? [{
        id: AGREEMENT, org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", status: "active",
        signed_at: "2026-09-01T00:00:00Z", total_cents: 465_000_00, snapshot: { purchase_agreement: { pricing: signedPricing } },
      }],
      budgets,
      project_selections: [
        { id: id(10), org_id: ORG, project_id: HOME, status: "confirmed", selected_option_id: STRUCTURAL, package_id: null, price_cents_snapshot: 25_000_00, cost_cents_snapshot: 14_000_00 },
        { id: id(11), org_id: ORG, project_id: HOME, status: "confirmed", selected_option_id: id(5), package_id: null, price_cents_snapshot: 0, cost_cents_snapshot: null },
        { id: id(12), org_id: ORG, project_id: HOME, status: "removed", selected_option_id: id(6), package_id: null, price_cents_snapshot: 9_000_00, cost_cents_snapshot: null },
      ],
      sellable_lot_inventory: inventory,
      home_margin_baselines: [],
    },
  })
}

const releasedBudget = { id: id(20), org_id: ORG, project_id: HOME, version: 1, status: "approved", total_cents: 360_000_00, metadata: {} }

test("release locks the sale price against the instantiated budget and the options' cost, once", async () => {
  const service = home({ budgets: [releasedBudget] })

  const first = await service.run(() => captureHomeMarginBaseline({ orgId: ORG, projectId: HOME, stage: "release", actorId: ACTOR }))
  const again = await service.run(() => captureHomeMarginBaseline({ orgId: ORG, projectId: HOME, stage: "release", actorId: ACTOR }))

  assert.deepEqual(
    {
      contractId: first.contractId, salePriceCents: first.salePriceCents, incentivesCents: first.incentivesCents,
      lotPremiumCents: first.lotPremiumCents, optionsPriceCents: first.optionsPriceCents, baseCostCents: first.baseCostCents,
      optionsCostCents: first.optionsCostCents, costCents: first.costCents, marginCents: first.marginCents,
      marginBps: first.marginBps, catalogRevision: first.catalogRevision,
    },
    {
      contractId: AGREEMENT, salePriceCents: 465_000_00, incentivesCents: 10_000_00, lotPremiumCents: 25_000_00,
      optionsPriceCents: 25_000_00, baseCostCents: 360_000_00, optionsCostCents: 14_000_00, costCents: 374_000_00,
      // 91,000 / 465,000 = 19.5698…%
      marginCents: 91_000_00, marginBps: 1957, catalogRevision: "41",
    },
  )
  assert.equal(again.id, first.id)
  assert.equal(service.db.home_margin_baselines.length, 1)
  assert.equal(service.events.length, 1)
  assert.equal(service.audits.length, 1)
})

test("a later repricing of the catalog, the budget or a selection does not move a captured baseline", async () => {
  const service = home({ budgets: [releasedBudget] })
  const captured = await service.run(() => captureHomeMarginBaseline({ orgId: ORG, projectId: HOME, stage: "release", actorId: ACTOR }))

  service.db.project_selections[0].cost_cents_snapshot = 30_000_00
  service.db.budgets.push({ ...releasedBudget, id: id(21), version: 2, total_cents: 410_000_00 })
  const recaptured = await service.run(() => captureHomeMarginBaseline({ orgId: ORG, projectId: HOME, stage: "release", actorId: ACTOR }))

  assert.equal(recaptured.marginCents, captured.marginCents)
  assert.equal(recaptured.costCents, 374_000_00)
  assert.equal(service.writes("home_margin_baselines").length, 1)
})

test("a home sold before it has a budget records its sale with the margin unknown", async () => {
  const service = home()

  const baseline = await service.run(() => captureHomeMarginBaseline({ orgId: ORG, projectId: HOME, stage: "agreement" }))

  assert.equal(baseline.stage, "agreement")
  assert.equal(baseline.salePriceCents, 465_000_00)
  assert.equal(baseline.optionsCostCents, 14_000_00)
  assert.equal(baseline.baseCostCents, null)
  assert.equal(baseline.marginCents, null)
  assert.equal(baseline.marginBps, null)
})

test("a spec home released unsold is measured against its asking price", async () => {
  const service = home({
    contracts: [],
    budgets: [{ ...releasedBudget, metadata: { source: "po_generation" }, total_cents: 374_000_00 }],
    inventory: [{ org_id: ORG, project_id: HOME, asking_price_cents: 480_000_00 }],
  })

  const baseline = await service.run(() => captureHomeMarginBaseline({ orgId: ORG, projectId: HOME, stage: "release", actorId: ACTOR }))

  assert.equal(baseline.contractId, null)
  assert.equal(baseline.salePriceCents, 480_000_00)
  assert.equal(baseline.incentivesCents, 0)
  // The generated budget already buys the options.
  assert.equal(baseline.costCents, 374_000_00)
  assert.equal(baseline.baseCostCents, 360_000_00)
  assert.equal(baseline.marginCents, 106_000_00)
})

test("an agreement baseline needs an executed agreement", async () => {
  const service = home({ contracts: [] })

  await assert.rejects(
    service.run(() => captureHomeMarginBaseline({ orgId: ORG, projectId: HOME, stage: "agreement" })),
    /no executed purchase agreement/,
  )
  assert.equal(service.writes("home_margin_baselines").length, 0)
})
