"use strict"

/**
 * `lib/services/selections.ts` — what a buyer's selection is priced at when it
 * is confirmed, and how multi-row changes (a package, a change order) land.
 *
 * Catalog pricing and configuration rules are replaced at their module seams:
 * the catalog answers with today's price, which is exactly what confirmation
 * must NOT use for a selection that already carries the price it was chosen at.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const HOME = id(1)
const SELECTION = id(2)
const SECOND = id(3)
const OPTION = id(4)
const UPGRADE = id(5)
const CATEGORY = id(6)
const CHANGE_ORDER = id(7)
const PACKAGE = id(8)
const COMMUNITY_UPGRADE = id(9)

let catalog = {}
stubModule("@/lib/services/option-catalog", {
  allocatePackageTotal: require("@/lib/selections/catalog-math").allocatePackageTotal,
  resolveOptionPricing: async ({ items }) =>
    items.map((item) => catalog[item.optionId ?? item.packageId] ?? { available: false, categoryIds: [] }),
})
stubModule("@/lib/services/configuration-rules", { assertProjectConfiguration: async () => {} })
stubModule("@/lib/services/selection-change-orders", {
  createVarianceOrdersForSelectionChange: async () => ({ created: 0, unrouted: 0 }),
})

const { applySelectionChangeFromChangeOrder, confirmSelection, selectProjectPackage } = freshRequire("lib/services/selections.ts")

const priced = (optionId, priceCents) => ({ available: true, optionId, priceCents, costCents: priceCents / 2, categoryIds: [CATEGORY] })

function harness({ selections, changeOrder } = {}) {
  const applied = []
  const service = createServiceHarness({
    permissions: ["selections.write"],
    tables: {
      project_selections: selections ?? [
        { id: SELECTION, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: OPTION, status: "selected", group_id: null, package_id: null, price_cents_snapshot: 1_200_00, cost_cents_snapshot: 600_00, locked_at: null, metadata: {} },
      ],
      selection_options: [
        { id: OPTION, org_id: ORG, option_scope: "design_studio" },
        { id: UPGRADE, org_id: ORG, option_scope: "design_studio" },
      ],
      projects: [{ id: HOME, org_id: ORG, property_type: "production" }],
      orgs: [{ id: ORG, product_tier: "production" }],
      lots: [],
      selection_package_items: [{ org_id: ORG, package_id: PACKAGE, option_id: UPGRADE, option: { category_id: CATEGORY } }],
      change_orders: changeOrder ? [changeOrder] : [],
    },
    rpc: {
      apply_project_selection_writes: (args, store) => {
        applied.push(args)
        for (const write of args.p_writes) {
          Object.assign(store.project_selections.find((row) => row.id === write.id), write)
        }
        return { data: args.p_writes.length, error: null }
      },
    },
  })
  return { service, applied }
}

const stored = (service, selectionId = SELECTION) => service.db.project_selections.find((row) => row.id === selectionId)

describe("confirmSelection", () => {
  test("confirming commits the price the option was chosen at, not today's catalog price", async () => {
    catalog = { [OPTION]: priced(OPTION, 1_500_00) }
    const { service } = harness()
    await service.run(() => confirmSelection({ orgId: ORG, projectId: HOME, selectionId: SELECTION }))
    assert.equal(stored(service).status, "confirmed")
    assert.equal(stored(service).price_cents_snapshot, 1_200_00)
    assert.equal(stored(service).cost_cents_snapshot, 600_00)
  })

  test("a selection chosen before prices were captured confirms at the catalog price", async () => {
    catalog = { [OPTION]: priced(OPTION, 1_500_00) }
    const { service } = harness()
    Object.assign(stored(service), { price_cents_snapshot: null, cost_cents_snapshot: null })
    await service.run(() => confirmSelection({ orgId: ORG, projectId: HOME, selectionId: SELECTION }))
    assert.equal(stored(service).price_cents_snapshot, 1_500_00)
    assert.equal(stored(service).cost_cents_snapshot, 750_00)
  })
})

describe("applySelectionChangeFromChangeOrder", () => {
  const selections = () => [
    { id: SELECTION, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: OPTION, status: "confirmed", group_id: null, locked_at: null, metadata: {} },
    { id: SECOND, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: OPTION, status: "confirmed", group_id: null, locked_at: null, metadata: {} },
  ]
  const changeOrder = (changes) => ({ id: CHANGE_ORDER, org_id: ORG, project_id: HOME, metadata: { selection_change: { changes } } })

  test("every change in the order lands in one write", async () => {
    catalog = { [UPGRADE]: priced(UPGRADE, 2_000_00) }
    const { service, applied } = harness({
      selections: selections(),
      changeOrder: changeOrder([
        { selection_id: SELECTION, new_option_id: UPGRADE, price_cents: 1_900_00 },
        { selection_id: SECOND, new_option_id: UPGRADE },
      ]),
    })
    const result = await service.run(() => applySelectionChangeFromChangeOrder(CHANGE_ORDER, ORG))

    assert.equal(result.applied, 2)
    assert.equal(applied.length, 1)
    assert.deepEqual(applied[0].p_writes.map((write) => [write.id, write.price_cents_snapshot, write.source_change_order_id]), [
      [SELECTION, 1_900_00, CHANGE_ORDER],
      [SECOND, 2_000_00, CHANGE_ORDER],
    ])
    assert.equal(service.events.filter((event) => event.eventType === "selection_changed_post_cutoff").length, 2)
  })

  test("a change that cannot be applied stops the whole order before anything is written", async () => {
    catalog = { [UPGRADE]: priced(UPGRADE, 2_000_00) }
    const { service, applied } = harness({
      selections: selections(),
      changeOrder: changeOrder([
        { selection_id: SELECTION, new_option_id: UPGRADE },
        { selection_id: SECOND, new_option_id: id(99) },
      ]),
    })
    await assert.rejects(service.run(() => applySelectionChangeFromChangeOrder(CHANGE_ORDER, ORG)), /not available/)
    assert.deepEqual(applied, [])
    assert.equal(stored(service).selected_option_id, OPTION)
    assert.deepEqual(service.events, [])
  })
})

describe("selectProjectPackage", () => {
  test("a package lands on the home in one write, at the community's option and the package price", async () => {
    catalog = {
      [PACKAGE]: { available: true, priceCents: 900_00, costCents: 400_00, categoryIds: [] },
      [UPGRADE]: priced(COMMUNITY_UPGRADE, 1_000_00),
    }
    const { service, applied } = harness()
    await service.run(() => selectProjectPackage({ orgId: ORG, projectId: HOME, packageId: PACKAGE }))

    assert.equal(applied.length, 1)
    assert.deepEqual(applied[0].p_writes.map((write) => [write.id, write.selected_option_id, write.price_cents_snapshot, write.cost_cents_snapshot]), [
      [SELECTION, COMMUNITY_UPGRADE, 900_00, 400_00],
    ])
  })
})
