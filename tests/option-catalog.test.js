"use strict"

/** `lib/services/option-catalog.ts` — how a home prices its options. */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { resolveOptionPricing } = freshRequire("lib/services/option-catalog.ts")
const { homePricingScope } = freshRequire("lib/services/home-pricing-scope.ts")

const COMMUNITY = id(3)

describe("resolveOptionPricing context and money", () => {
  const OPTION = id(31)
  const CATEGORY = id(32)
  const VERSION = id(33)
  const option = (overrides = {}) => ({
    id: OPTION, org_id: ORG, category_id: CATEGORY, parent_option_id: null, community_id: null,
    price_cents: 5000, cost_cents: 3000, is_available: true, is_archived: false, ...overrides,
  })
  function pricing(rows, prices = []) {
    return createServiceHarness({
      tables: {
        selection_options: rows,
        selection_packages: [],
        selection_categories: [{ id: CATEGORY, org_id: ORG, parent_category_id: null, community_id: null, is_archived: false }],
        selection_catalog_prices: prices,
      },
    })
  }

  test("a community home without a pinned plan version is refused, not priced at the base price", async () => {
    const service = pricing([option()])
    await assert.rejects(
      service.run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }], communityId: COMMUNITY, requirePlanVersion: true })),
      /no pinned plan version/,
    )
  })

  test("a home with neither community nor plan version gets the base price and says why", async () => {
    const service = pricing([option()])
    const [row] = await service.run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }] }))
    assert.equal(row.priceCents, 5000)
    assert.equal(row.baseReason, "no_plan_version")
  })

  test("a plan-scoped price carries no base-price reason", async () => {
    const service = pricing([option()])
    const [row] = await service.run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }], housePlanVersionId: VERSION }))
    assert.equal(row.baseReason, null)
  })

  test("a production home must have its plan version; a plan row outranks the option's own price", async () => {
    const noLot = homePricingScope({ lot: null, production: true })
    await assert.rejects(
      pricing([option()]).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }], ...noLot })),
      /no pinned plan version/,
    )

    const pinned = homePricingScope({ lot: { community_id: null, house_plan_version_id: VERSION }, production: true })
    // An option priced once for every plan prices at that price, and says so.
    const [own] = await pricing([option()]).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }], ...pinned }))
    assert.deepEqual([own.priceCents, own.source], [5000, "option_base"])

    const planPrice = { id: id(34), org_id: ORG, option_id: OPTION, package_id: null, house_plan_version_id: VERSION, community_id: null, price_cents: 7200, cost_cents: 4000, is_available: true }
    const [row] = await pricing([option()], [planPrice]).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }], ...pinned }))
    assert.deepEqual([row.priceCents, row.source], [7200, "plan"])
  })

  test("a published plan price never puts a withdrawn or archived option back on sale", async () => {
    const pinned = homePricingScope({ lot: { community_id: null, house_plan_version_id: VERSION }, production: true })
    const planPrice = { id: id(34), org_id: ORG, option_id: OPTION, package_id: null, house_plan_version_id: VERSION, community_id: null, price_cents: 7200, cost_cents: 4000, is_available: true }
    for (const withdrawn of [{ is_available: false }, { is_archived: true }]) {
      const [row] = await pricing([option(withdrawn)], [planPrice]).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }], ...pinned }))
      assert.deepEqual([row.source, row.available], ["plan", false], JSON.stringify(withdrawn))
    }
  })

  test("a withdrawn community override takes the option off sale in that community, whatever the plan prices say", async () => {
    const OVERRIDE = id(35)
    const scope = homePricingScope({ lot: { community_id: COMMUNITY, house_plan_version_id: VERSION }, production: true })
    const override = option({ id: OVERRIDE, parent_option_id: OPTION, community_id: COMMUNITY, is_available: false })
    const prices = [
      { id: id(36), org_id: ORG, option_id: OPTION, package_id: null, house_plan_version_id: VERSION, community_id: null, price_cents: 7200, cost_cents: 4000, is_available: true },
      { id: id(37), org_id: ORG, option_id: OVERRIDE, package_id: null, house_plan_version_id: VERSION, community_id: COMMUNITY, price_cents: 7600, cost_cents: 4200, is_available: true },
    ]
    const [row] = await pricing([option(), override], prices).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }], ...scope }))
    assert.deepEqual([row.optionId, row.source, row.available], [OVERRIDE, "plan_community", false])

    const [onSale] = await pricing([option(), { ...override, is_available: true }], prices).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }], ...scope }))
    assert.deepEqual([onSale.priceCents, onSale.available], [7600, true])
  })

  test("a community version named by its own id is off sale when its parent option is withdrawn", async () => {
    const OVERRIDE = id(38)
    const scope = homePricingScope({ lot: { community_id: COMMUNITY, house_plan_version_id: VERSION }, production: true })
    const override = option({ id: OVERRIDE, parent_option_id: OPTION, community_id: COMMUNITY })
    const prices = [{ id: id(39), org_id: ORG, option_id: OVERRIDE, package_id: null, house_plan_version_id: VERSION, community_id: COMMUNITY, price_cents: 7600, cost_cents: 4200, is_available: true }]
    // The community catalog hands out the override's id, and selections store it.
    const [withdrawn] = await pricing([option({ is_available: false }), override], prices).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OVERRIDE }], ...scope }))
    assert.equal(withdrawn.available, false)
    const [archived] = await pricing([option({ is_archived: true }), override], prices).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OVERRIDE }], ...scope }))
    assert.equal(archived.available, false)
    const [onSale] = await pricing([option(), override], prices).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OVERRIDE }], ...scope }))
    assert.deepEqual([onSale.priceCents, onSale.available], [7600, true])
  })

  test("a custom home outside a community still prices at the option's base price", async () => {
    const [row] = await pricing([option()]).run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }], ...homePricingScope({ lot: null, production: false }) }))
    assert.deepEqual([row.priceCents, row.source], [5000, "option_base"])
  })

  test("resolved money must be non-negative whole cents", async () => {
    for (const bad of [{ price_cents: -1 }, { price_cents: 10.5 }, { cost_cents: -5 }, { cost_cents: 1.25 }]) {
      const service = pricing([option(bad)])
      await assert.rejects(
        service.run(() => resolveOptionPricing({ orgId: ORG, items: [{ optionId: OPTION }] })),
        /non-negative whole number of cents/,
      )
    }
  })
})
