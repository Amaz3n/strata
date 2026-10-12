"use strict"

/**
 * `lib/services/selection-change-orders.ts` — a selection change after cutoff
 * becomes a change order. The catalog's price lookup is replaced at its module
 * seam; how a home prices is decided by the real pricing-scope module.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const HOME = id(1)
const SELECTION = id(2)
const CATEGORY = id(3)
const PACKAGE = id(4)
const PAVERS = id(5)
const WITHDRAWN = id(6)

let catalog = {}
stubModule("@/lib/services/option-catalog", {
  resolveOptionPricing: async ({ items }) => items.map((item) => catalog[item.optionId ?? item.packageId] ?? { available: false, categoryIds: [] }),
})

const { createPostCutoffSelectionChangeOrder } = freshRequire("lib/services/selection-change-orders.ts")

const onSale = (priceCents) => ({ available: true, priceCents, costCents: priceCents / 2, categoryIds: [CATEGORY] })

test("a package change order is refused when one of its options has been withdrawn, even though the package is on sale", async () => {
  catalog = { [PACKAGE]: onSale(9_000_00), [PAVERS]: onSale(4_000_00) }
  const service = createServiceHarness({
    permissions: ["selections.write"],
    tables: {
      project_selections: [{ id: SELECTION, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: PAVERS, group_id: null, locked_at: "2026-09-01T00:00:00Z", category: { name: "Exterior" } }],
      lots: [{ id: id(10), org_id: ORG, project_id: HOME, community: { name: "Ridge", selection_change_fee_cents: 0 } }],
      projects: [{ id: HOME, org_id: ORG, property_type: "residential" }],
      selection_packages: [{
        id: PACKAGE, org_id: ORG, name: "Outdoor living",
        items: [{ option_id: PAVERS, option: { category_id: CATEGORY } }, { option_id: WITHDRAWN, option: { category_id: CATEGORY } }],
      }],
    },
  })

  await assert.rejects(
    service.run(() => createPostCutoffSelectionChangeOrder({ projectId: HOME, changes: [{ selectionId: SELECTION, newPackageId: PACKAGE }] })),
    /An option in Outdoor living is no longer available for this home/,
  )
  assert.deepEqual(service.writes("change_orders"), [])
})
