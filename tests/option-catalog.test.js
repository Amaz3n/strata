"use strict"

/**
 * `lib/services/option-catalog.ts` — design studio appointments (who can read
 * the calendar, who can book or move an appointment on a home) and how a home
 * prices its options.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { listAppointments, resolveOptionPricing, upsertAppointment } = freshRequire("lib/services/option-catalog.ts")
const { homePricingScope } = freshRequire("lib/services/home-pricing-scope.ts")

const MINE = id(1)
const THEIRS = id(2)
const COMMUNITY = id(3)
const OTHER_COMMUNITY = id(4)
const BOOKED = id(5)

function harness({ permissions = ["selections.read", "design_studio.manage", "project.read"], projects } = {}) {
  return createServiceHarness({
    permissions,
    projects,
    tables: {
      projects: [
        { id: MINE, org_id: ORG, name: "Lot 1", phase: "delivery" },
        { id: THEIRS, org_id: ORG, name: "Lot 2", phase: "delivery" },
      ],
      lots: [
        { id: id(11), org_id: ORG, project_id: MINE, community_id: COMMUNITY },
        { id: id(12), org_id: ORG, project_id: THEIRS, community_id: COMMUNITY },
      ],
      design_studio_appointments: [
        { id: BOOKED, org_id: ORG, project_id: THEIRS, community_id: COMMUNITY, scheduled_at: "2026-10-20T15:00:00Z", status: "scheduled", group_ids: [] },
        { id: id(6), org_id: ORG, project_id: MINE, community_id: COMMUNITY, scheduled_at: "2026-10-21T15:00:00Z", status: "scheduled", group_ids: [] },
      ],
    },
  })
}

const booking = (overrides = {}) => ({
  projectId: MINE,
  communityId: COMMUNITY,
  scheduledAt: "2026-10-22T15:00:00Z",
  ...overrides,
})

describe("listAppointments", () => {
  test("an org-wide reader sees every home's appointments", async () => {
    const service = harness()
    const rows = await service.run(() => listAppointments())
    assert.deepEqual(rows.map((row) => row.project_id).sort(), [MINE, THEIRS].sort())
  })

  test("a reader assigned to some homes sees only those homes' appointments", async () => {
    const service = harness({ projects: [MINE] })
    const rows = await service.run(() => listAppointments())
    assert.deepEqual(rows.map((row) => row.project_id), [MINE])
  })
})

describe("upsertAppointment", () => {
  test("a coordinator books an appointment on a home they can manage", async () => {
    const service = harness()
    const saved = await service.run(() => upsertAppointment(booking()))
    assert.equal(saved.project_id, MINE)
    assert.equal(saved.status, "scheduled")
    assert.deepEqual(service.events.map((event) => event.eventType), ["design_studio_appointment_created"])
  })

  test("a coordinator scoped to one home cannot book or move appointments on another", async () => {
    const service = harness({ projects: [MINE] })
    await assert.rejects(service.run(() => upsertAppointment(booking({ projectId: THEIRS }))), /Missing permission/)
    // Moving another home's appointment onto their own home is still a change to the other home.
    await assert.rejects(service.run(() => upsertAppointment(booking({ id: BOOKED }))), /Missing permission/)
    assert.deepEqual(service.writes(), [])
  })

  test("an appointment's community is the home's community", async () => {
    const service = harness()
    await assert.rejects(
      service.run(() => upsertAppointment(booking({ communityId: OTHER_COMMUNITY }))),
      /home's community/,
    )
    assert.deepEqual(service.writes(), [])
  })

  test("reading the calendar does not grant booking", async () => {
    const service = harness({ permissions: ["selections.read"] })
    await assert.rejects(service.run(() => upsertAppointment(booking())), /Missing permission/)
    assert.deepEqual(service.writes(), [])
  })
})

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
