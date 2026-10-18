"use strict"

/**
 * `lib/services/selection-change-orders.ts` — a selection change the home can
 * no longer take directly (past its cutoff, past an option's order-by date,
 * or already bought) becomes a change order. The catalog's price lookup, the
 * configuration rules and the supply facts are replaced at their module seams;
 * how a home prices is decided by the real pricing-scope module. What the
 * approval then does with the change is proven in selections-db.test.js.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const HOME = id(1)
const SELECTION = id(2)
const CATEGORY = id(3)
const PACKAGE = id(4)
const PAVERS = id(5)
const WITHDRAWN = id(6)
const TRAVERTINE = id(7)
const CHANGE_ORDER = id(8)
const COST_CODE = id(9)

let catalog = {}
stubModule("@/lib/services/option-catalog", {
  resolveOptionPricing: async ({ items }) => items.map((item) => catalog[item.optionId ?? item.packageId] ?? { available: false, categoryIds: [] }),
})
stubModule("@/lib/services/configuration-rules", { assertProjectConfiguration: async () => undefined })
let facts = {}
stubModule("@/lib/services/selection-exceptions", {
  readSelectionChoiceFacts: async (_orgId, _projectId, _selectionId, optionIds) => ({
    today: "2026-10-12", timeZone: "America/New_York", selectionLocked: false, groupStatus: "open", cutoffDate: "2026-10-30",
    neededBy: "2026-11-15", releasedPurchaseOrderId: null, releasedPurchaseOrderTitle: null,
    ...facts,
    options: optionIds.map((optionId) => ({ optionId, leadTimeDays: null, orderBy: null, waived: false, ...(facts.option ?? {}) })),
  }),
  announceSelectionExceptions: async () => undefined,
  notifyPermissionHolders: async () => undefined,
})
// The change order itself is the change-order service's; here it is the
// draft the selection change is attached to.
const raised = []
let current = null
stubModule("@/lib/services/change-orders", {
  createChangeOrder: async ({ input }) => {
    raised.push(input)
    current.db.change_orders.push({ id: CHANGE_ORDER, org_id: ORG, project_id: HOME, status: "draft", metadata: {} })
    return { id: CHANGE_ORDER, metadata: {} }
  },
})

const { createPostCutoffSelectionChangeOrder } = freshRequire("lib/services/selection-change-orders.ts")

const onSale = (priceCents) => ({ available: true, priceCents, costCents: priceCents / 2, costCodeId: COST_CODE, categoryIds: [CATEGORY] })

function harness(permissions = ["selections.write", "project.read"]) {
  raised.length = 0
  facts = {}
  current = createServiceHarness({
    permissions,
    tables: {
      project_selections: [{ id: SELECTION, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: PAVERS, price_cents_snapshot: 4_000_00, cost_cents_snapshot: 2_000_00, group_id: id(20), locked_at: null, category: { name: "Exterior" } }],
      lots: [{ id: id(10), org_id: ORG, project_id: HOME, community: { name: "Ridge", selection_change_fee_cents: 250_00 } }],
      projects: [{ id: HOME, org_id: ORG, property_type: "residential" }],
      selection_options: [{ id: TRAVERTINE, org_id: ORG, name: "Travertine", cost_code_id: COST_CODE }],
      selection_packages: [{
        id: PACKAGE, org_id: ORG, name: "Outdoor living",
        items: [{ option_id: PAVERS, option: { category_id: CATEGORY } }, { option_id: WITHDRAWN, option: { category_id: CATEGORY } }],
      }],
      change_orders: [],
    },
  })
  return current
}

const raise = (service, input = {}) =>
  service.run(() => createPostCutoffSelectionChangeOrder({ projectId: HOME, changes: [{ selectionId: SELECTION, newOptionId: TRAVERTINE }], ...input }))

test("a package change order is refused when one of its options has been withdrawn, even though the package is on sale", async () => {
  catalog = { [PACKAGE]: onSale(9_000_00), [PAVERS]: onSale(4_000_00) }
  const service = harness()
  await assert.rejects(
    service.run(() => createPostCutoffSelectionChangeOrder({ projectId: HOME, changes: [{ selectionId: SELECTION, newPackageId: PACKAGE }] })),
    /An option in Outdoor living is no longer available for this home/,
  )
  assert.deepEqual(service.writes("change_orders"), [])
})

describe("what a selection change order is for", () => {
  test("a selection still open for a direct change is updated directly, not by a change order", async () => {
    catalog = { [TRAVERTINE]: onSale(6_000_00) }
    const service = harness()
    await assert.rejects(raise(service), /still open for changes/)
    assert.deepEqual(raised, [])
  })

  test("an option past its order-by date takes a change order without the post-cutoff fee, carrying the days the late order costs", async () => {
    catalog = { [TRAVERTINE]: onSale(6_000_00) }
    const service = harness()
    facts = { option: { leadTimeDays: 45, orderBy: "2026-10-02" } }
    const created = await raise(service)

    assert.equal(raised[0].days_impact, 10)
    assert.equal(raised[0].title, "Selection change")
    assert.deepEqual(raised[0].lines.map((line) => line.description), ["Selection change: Exterior — Travertine"])
    const [change] = created.metadata.selection_change.changes
    assert.deepEqual(
      [change.old_option_id, change.old_price_cents, change.new_option_id, change.price_delta_cents, change.cost_delta_cents, change.cost_code_id],
      [PAVERS, 4_000_00, TRAVERTINE, 2_000_00, 1_000_00, COST_CODE],
    )
    assert.equal(created.metadata.selection_change.fee_cents, 0)
    assert.deepEqual(service.db.change_orders[0].metadata.selection_change.changes.map((row) => row.selection_id), [SELECTION])
  })

  test("a change past its cutoff carries the community's fee; waiving it needs the override on this home", async () => {
    catalog = { [TRAVERTINE]: onSale(6_000_00) }
    const charged = harness()
    facts = { groupStatus: "locked" }
    const created = await raise(charged)
    assert.equal(created.metadata.selection_change.fee_cents, 250_00)
    assert.deepEqual(raised[0].lines.map((line) => [line.description, line.unit_cost, line.internal_cost_cents]).at(-1), ["Post-cutoff selection change fee", 250, 0])

    const coordinator = harness()
    facts = { groupStatus: "locked" }
    await assert.rejects(raise(coordinator, { waiveFee: true }), /Missing permission: selections\.cutoff\.override/)
    assert.deepEqual(raised, [])

    const manager = harness(["selections.write", "selections.cutoff.override", "project.read"])
    facts = { groupStatus: "locked" }
    const waived = await raise(manager, { waiveFee: true })
    assert.deepEqual([waived.metadata.selection_change.fee_cents, waived.metadata.selection_change.fee_waived], [0, true])
  })

  test("a selection already bought takes a change order whether or not its cutoff passed", async () => {
    catalog = { [TRAVERTINE]: onSale(6_000_00) }
    const service = harness()
    facts = { releasedPurchaseOrderId: id(30), releasedPurchaseOrderTitle: "PO — Pavers" }
    const created = await raise(service)
    assert.equal(created.metadata.selection_change.past_cutoff, false)
    assert.equal(raised[0].days_impact, null)
  })

  test("a selection that already has an open change order is refused, and the draft raised for it is removed", async () => {
    catalog = { [TRAVERTINE]: onSale(6_000_00) }
    const service = harness()
    facts = { groupStatus: "locked" }
    service.tamper("change_orders", (result) => ({
      ...result, data: null,
      error: { message: "Exterior already has an open change order (CO #3); finish or void it first", details: "SELECTION_CHANGE_ALREADY_OPEN" },
    }), { on: "update", times: 1 })
    await assert.rejects(raise(service), /already has an open change order \(CO #3\)/)
    assert.deepEqual(service.db.change_orders, [])
  })
})
