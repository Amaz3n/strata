"use strict"

/**
 * `lib/services/option-catalog.ts` — design studio appointments (who can read
 * the calendar, who can book or move an appointment on a home) and the legacy
 * package save.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { listAppointments, resolveOptionPricing, upsertAppointment, upsertPackage } = freshRequire("lib/services/option-catalog.ts")

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

describe("upsertPackage", () => {
  const PACKAGE = id(20)
  const OPTION = id(21)
  const stored = { id: PACKAGE, org_id: ORG, community_id: null, name: "Bundle", description: null, image_url: null, price_cents: 123, cost_cents: 7777, is_available: true, is_archived: false, sort_order: 0 }

  function packageHarness({ permissions = ["selections.catalog.manage"], rpc } = {}) {
    const saves = []
    const service = createServiceHarness({
      permissions,
      tables: { selection_packages: [stored] },
      rpc: {
        save_selection_package: rpc ?? ((args) => {
          saves.push(args)
          return { data: PACKAGE, error: null }
        }),
      },
    })
    return { service, saves }
  }

  const request = { id: PACKAGE, name: "Bundle", priceCents: 123, optionIds: [OPTION] }

  test("the package row and its members are saved by one database call", async () => {
    const { service, saves } = packageHarness()
    const saved = await service.run(() => upsertPackage(request))
    assert.equal(saves.length, 1)
    assert.deepEqual(saves[0].p_option_ids, [OPTION])
    assert.equal(saved.id, PACKAGE)
    assert.deepEqual(saved.option_ids, [OPTION])
    assert.deepEqual(service.writes("selection_package_items"), [])
  })

  test("a failed save reports the failure and writes nothing else", async () => {
    const { service } = packageHarness({ rpc: () => ({ data: null, error: { message: "member write failed" } }) })
    await assert.rejects(service.run(() => upsertPackage(request)), /member write failed/)
    assert.deepEqual(service.audits, [])
    assert.deepEqual(service.writes("selection_package_items"), [])
  })

  test("a cost left out of the request is not sent, and cost stays hidden from a reader without margin access", async () => {
    const { service, saves } = packageHarness()
    const saved = await service.run(() => upsertPackage(request))
    assert.equal(Object.hasOwn(saves[0].p_fields, "cost_cents"), false)
    assert.equal(Object.hasOwn(saved, "cost_cents"), false)

    const privileged = packageHarness({ permissions: ["selections.catalog.manage", "financials.margin.read"] })
    const visible = await privileged.service.run(() => upsertPackage(request))
    assert.equal(visible.cost_cents, 7777)
  })

  test("assigning or clearing a cost takes margin access, checked before anything is written", async () => {
    for (const costCents of [null, 0, 100]) {
      const { service, saves } = packageHarness()
      await assert.rejects(service.run(() => upsertPackage({ ...request, costCents })), /Missing permission/)
      assert.deepEqual(saves, [])
    }
    const { service, saves } = packageHarness({ permissions: ["selections.catalog.manage", "financials.margin.read"] })
    await service.run(() => upsertPackage({ ...request, costCents: null }))
    assert.equal(saves[0].p_fields.cost_cents, null)
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
  function pricing(rows) {
    return createServiceHarness({
      tables: {
        selection_options: rows,
        selection_packages: [],
        selection_categories: [{ id: CATEGORY, org_id: ORG, parent_category_id: null, community_id: null, is_archived: false }],
        selection_catalog_prices: [],
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
