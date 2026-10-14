"use strict"

/**
 * `lib/services/selections.ts` — what a buyer's selection is priced at when it
 * is chosen, and how multi-row changes (a package, a change order) land.
 * (Confirmation is a buyer approval: tests/selection-approvals.test.js.)
 *
 * Catalog pricing and configuration rules are replaced at their module seams.
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
const PACKAGE = id(8)
const COMMUNITY_UPGRADE = id(9)

// How a home prices is decided by the real pricing-scope module; only the
// catalog's price lookup is replaced.
let catalog = {}
const pricingScopes = []
stubModule("@/lib/services/option-catalog", {
  allocatePackageTotal: require("@/lib/selections/catalog-math").allocatePackageTotal,
  resolveOptionPricing: async ({ items, orgId: _orgId, ...scope }) => {
    pricingScopes.push(scope)
    return items.map((item) => catalog[item.optionId ?? item.packageId] ?? { available: false, categoryIds: [] })
  },
})
// The rules themselves have their own suite; here a rejection is injected to
// prove every selection mutation stops on it. `duringValidation` runs while a
// mutation validates — the window another session can publish into.
let configurationFailure = null
let duringValidation = null
stubModule("@/lib/services/configuration-rules", {
  assertProjectConfiguration: async () => {
    duringValidation?.()
    if (configurationFailure) throw new Error(configurationFailure)
  },
})
// The supply facts are what `project_selection_choice_facts` reads in the
// database (its rules are proven in selections-db.test.js); here each test
// says what the home's supply looks like, and which exceptions get opened.
let supply = {}
let databaseRefusal = null
const openedExceptions = []
const utcToday = () => new Date().toISOString().slice(0, 10)
stubModule("@/lib/services/selection-exceptions", {
  readSelectionChoiceFacts: async (_orgId, _projectId, _selectionId, optionIds) => ({
    today: utcToday(), timeZone: "UTC", selectionLocked: false, groupStatus: null, cutoffDate: null, neededBy: null,
    releasedPurchaseOrderId: supply.releasedPurchaseOrderId ?? null, releasedPurchaseOrderTitle: supply.releasedPurchaseOrderTitle ?? null,
    options: optionIds.map((optionId) => ({ optionId, leadTimeDays: supply.orderBy?.[optionId] ? 45 : null, orderBy: supply.orderBy?.[optionId] ?? null, waived: false })),
  }),
  openSelectionException: async (input) => {
    openedExceptions.push(input)
    return { id: id(90), opened: true }
  },
  listSelectionExceptions: async () => ({ exceptions: [], truncated: false }),
  loadSelectionException: async () => { throw new Error("not used") },
  recordAlternateChosen: async () => undefined,
})

const { createProjectSelection, listSelectionOptions, selectProjectOption, selectProjectOptions, selectProjectPackage } = freshRequire("lib/services/selections.ts")

const priced = (optionId, priceCents) => ({ available: true, optionId, priceCents, costCents: priceCents / 2, categoryIds: [CATEGORY] })

function harness({ selections, changeOrder, groups = [], lots = [] } = {}) {
  configurationFailure = null
  duringValidation = null
  pricingScopes.length = 0
  supply = {}
  databaseRefusal = null
  openedExceptions.length = 0
  const applied = []
  // What the database fences a write on: the org catalog revision and the
  // home's selection state, as they stand when the write commits.
  const fence = { catalogRevision: "41", homeState: "0".repeat(32) }
  // A design coordinator: selections.write with the org-wide project read every
  // studio role carries, so the home's own team is not required.
  const service = createServiceHarness({
    permissions: ["selections.write", "project.read"],
    tables: {
      project_selections: selections ?? [
        { id: SELECTION, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: OPTION, status: "selected", group_id: null, package_id: null, price_cents_snapshot: 1_200_00, cost_cents_snapshot: 600_00, locked_at: null, metadata: {} },
      ],
      selection_options: [
        { id: OPTION, org_id: ORG, category_id: CATEGORY, name: "Laminate", option_scope: "design_studio", is_available: true, is_archived: false, parent_option_id: null, sort_order: 1 },
        { id: UPGRADE, org_id: ORG, category_id: CATEGORY, name: "Quartz", option_scope: "design_studio", is_available: true, is_archived: false, parent_option_id: null, sort_order: 2 },
      ],
      projects: [{ id: HOME, org_id: ORG, property_type: "production" }],
      orgs: [{ id: ORG, product_tier: "production" }],
      lots,
      selection_package_items: [{ org_id: ORG, package_id: PACKAGE, option_id: UPGRADE, option: { category_id: CATEGORY } }],
      change_orders: changeOrder ? [changeOrder] : [],
      project_selection_groups: groups,
    },
    rpc: {
      read_project_selection_fence: () => ({ data: { ...fence }, error: null }),
      apply_project_selection_writes: (args, store) => {
        if (databaseRefusal) return { data: null, error: databaseRefusal }
        if (args.p_expected_catalog_revision !== fence.catalogRevision) {
          return { data: null, error: { message: "The catalog changed while you were choosing; review and try again", details: "SELECTION_CATALOG_CHANGED" } }
        }
        if (args.p_expected_home_state !== fence.homeState) {
          return { data: null, error: { message: "This home's selections changed while you were choosing; review and try again", details: "SELECTION_HOME_CHANGED" } }
        }
        applied.push(args)
        for (const write of args.p_writes) {
          Object.assign(store.project_selections.find((row) => row.id === write.id), write)
        }
        return { data: args.p_writes.length, error: null }
      },
    },
  })
  return { service, applied, fence }
}

const stored = (service, selectionId = SELECTION) => service.db.project_selections.find((row) => row.id === selectionId)

describe("selectProjectOptions", () => {
  const two = () => [
    { id: SELECTION, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: OPTION, status: "selected", group_id: null, package_id: null, price_cents_snapshot: 1_200_00, cost_cents_snapshot: 600_00, locked_at: null, metadata: {} },
    { id: SECOND, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: OPTION, status: "selected", group_id: null, package_id: null, price_cents_snapshot: 800_00, cost_cents_snapshot: 400_00, locked_at: null, metadata: {} },
  ]

  test("several choices on a home land in one fenced write", async () => {
    catalog = { [UPGRADE]: priced(UPGRADE, 2_000_00), [OPTION]: priced(OPTION, 1_500_00) }
    const { service, applied, fence } = harness({ selections: two() })
    await service.run(() => selectProjectOptions({ orgId: ORG, projectId: HOME, changes: [{ selectionId: SELECTION, optionId: UPGRADE }, { selectionId: SECOND, optionId: OPTION }] }))
    assert.equal(applied.length, 1)
    assert.equal(applied[0].p_expected_catalog_revision, fence.catalogRevision)
    assert.deepEqual(applied[0].p_writes.map((write) => [write.id, write.selected_option_id, write.price_cents_snapshot]), [
      [SELECTION, UPGRADE, 2_000_00],
      [SECOND, OPTION, 1_500_00],
    ])
  })

  test("a choice that cannot be made stops every other choice in the set", async () => {
    catalog = { [UPGRADE]: priced(UPGRADE, 2_000_00) }
    const { service, applied } = harness({ selections: two() })
    await assert.rejects(
      service.run(() => selectProjectOptions({ orgId: ORG, projectId: HOME, changes: [{ selectionId: SELECTION, optionId: UPGRADE }, { selectionId: SECOND, optionId: id(99) }] })),
      /no longer offered for this home/,
    )
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

describe("an invalid effective configuration", () => {
  const CHAIN = "Chef kitchen requires Electrical upgrade."

  test("stops every selection mutation before it writes", async () => {
    catalog = {
      [OPTION]: priced(OPTION, 1_500_00),
      [UPGRADE]: priced(COMMUNITY_UPGRADE, 2_000_00),
      [PACKAGE]: { available: true, priceCents: 900_00, costCents: 400_00, categoryIds: [] },
    }
    const mutations = {
      "a selection change": (service) => service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE })),
      "a package": (service) => service.run(() => selectProjectPackage({ orgId: ORG, projectId: HOME, packageId: PACKAGE })),
    }
    for (const [name, mutate] of Object.entries(mutations)) {
      const { service, applied } = harness()
      configurationFailure = CHAIN
      await assert.rejects(mutate(service), /requires Electrical upgrade/, name)
      assert.deepEqual(applied, [], name)
      assert.deepEqual(service.writes("project_selections"), [], name)
      assert.equal(stored(service).selected_option_id, OPTION, name)
      assert.equal(stored(service).status, "selected", name)
    }
  })
})

describe("selection cutoffs on mutations", () => {
  const GROUP = id(10)
  const today = () => new Date().toISOString().slice(0, 10)
  const daysFromToday = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  const grouped = (overrides = {}) => ({ id: SELECTION, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: OPTION, status: "selected", group_id: GROUP, package_id: null, price_cents_snapshot: 1_200_00, cost_cents_snapshot: 600_00, locked_at: null, metadata: {}, ...overrides })
  const instance = (overrides = {}) => ({ org_id: ORG, project_id: HOME, group_id: GROUP, status: "open", cutoff_date: daysFromToday(10), group: { name: "Flooring" }, ...overrides })
  const attempts = {
    select: (service) => service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE })),
  }

  test("a selection can change up to and including its cutoff day", async () => {
    catalog = { [OPTION]: priced(OPTION, 1_500_00), [UPGRADE]: priced(UPGRADE, 2_000_00) }
    for (const cutoff of [daysFromToday(10), today()]) {
      for (const [name, attempt] of Object.entries(attempts)) {
        const { service, applied } = harness({ selections: [grouped()], groups: [instance({ cutoff_date: cutoff })] })
        await attempt(service)
        assert.equal(applied.length, 1, `${name} on ${cutoff}`)
      }
    }
  })

  test("a passed or locked cutoff refuses the change with the date it passed, in the builder's and the buyer's words", async () => {
    catalog = { [OPTION]: priced(OPTION, 1_500_00), [UPGRADE]: priced(UPGRADE, 2_000_00) }
    const closed = [
      ["a date in the past", instance({ cutoff_date: daysFromToday(-1) })],
      ["a locked group with a future date", instance({ status: "locked" })],
    ]
    for (const [name, group] of closed) {
      for (const [action, attempt] of Object.entries(attempts)) {
        const { service, applied } = harness({ selections: [grouped()], groups: [group] })
        await assert.rejects(attempt(service), (error) => error.code === "SELECTION_LOCKED_CUTOFF" && /selection deadline for Flooring was/.test(error.message), `${action}: ${name}`)
        assert.deepEqual(applied, [], `${action}: ${name}`)
      }
    }
    const { service } = harness({ selections: [grouped()], groups: [instance({ cutoff_date: daysFromToday(-1) })] })
    await assert.rejects(
      service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE, portalAccess: true })),
      /contact your builder/,
    )
  })

  test("a selection the cutoff sweep locked stays locked even if its group looks open", async () => {
    const { service, applied } = harness({ selections: [grouped({ locked_at: "2026-10-01T00:00:00Z" })], groups: [instance()] })
    await assert.rejects(attempts.select(service), (error) => error.code === "SELECTION_LOCKED_CUTOFF")
    assert.deepEqual(applied, [])
  })

  test("a manual override that moves the cutoff forward reopens a change the schedule had closed", async () => {
    catalog = { [OPTION]: priced(OPTION, 1_500_00), [UPGRADE]: priced(UPGRADE, 2_000_00) }
    const scheduled = harness({ selections: [grouped()], groups: [instance({ cutoff_date: daysFromToday(-3) })] })
    await assert.rejects(attempts.select(scheduled.service), /deadline/)

    const overridden = harness({ selections: [grouped()], groups: [instance({ cutoff_date: daysFromToday(14), cutoff_source: "manual_override" })] })
    await attempts.select(overridden.service)
    assert.equal(overridden.applied.length, 1)
  })
})

describe("a catalog or home that moves while a selection is validated", () => {
  const GROUP = id(10)
  const mutations = {
    "a selection change": (service) => service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE })),
    "a package": (service) => service.run(() => selectProjectPackage({ orgId: ORG, projectId: HOME, packageId: PACKAGE })),
  }
  const moves = {
    "a price, rule or availability published": [(fence) => { fence.catalogRevision = "42" }, /catalog changed while you were choosing/],
    "another session changing the same home": [(fence) => { fence.homeState = "1".repeat(32) }, /selections changed while you were choosing/],
  }

  test("refuses the write instead of landing a configuration nobody validated", async () => {
    for (const [move, [change, message]] of Object.entries(moves)) {
      for (const [name, mutate] of Object.entries(mutations)) {
        catalog = {
          [OPTION]: priced(OPTION, 1_500_00),
          [UPGRADE]: priced(UPGRADE, 2_000_00),
          [PACKAGE]: { available: true, priceCents: 900_00, costCents: 400_00, categoryIds: [] },
        }
        const { service, applied, fence } = harness({
          selections: [{ id: SELECTION, org_id: ORG, project_id: HOME, category_id: CATEGORY, selected_option_id: OPTION, status: "selected", group_id: GROUP, package_id: null, price_cents_snapshot: 1_200_00, cost_cents_snapshot: 600_00, locked_at: null, metadata: {} }],
        })
        duringValidation = () => change(fence)
        await assert.rejects(mutate(service), (error) => error.code === "SELECTION_CONFIGURATION_CHANGED" && message.test(error.message), `${name}: ${move}`)
        assert.deepEqual(applied, [], `${name}: ${move}`)
        assert.deepEqual([stored(service).selected_option_id, stored(service).status], [OPTION, "selected"], `${name}: ${move}`)
      }
    }
  })
})

describe("how a home's selections are priced", () => {
  test("a production home always prices from its plan version, with or without a community", async () => {
    catalog = { [UPGRADE]: priced(UPGRADE, 2_000_00) }
    for (const lots of [[], [{ org_id: ORG, project_id: HOME, community_id: null, house_plan_version_id: id(30) }]]) {
      const { service } = harness({ lots })
      await service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE }))
      assert.deepEqual(pricingScopes.map((scope) => scope.requirePlanVersion), [true])
    }
  })
})

describe("createProjectSelection", () => {
  const DIVISION = id(70)
  const OTHER_DIVISION = id(71)
  const open = (service) => service.run(() => createProjectSelection({ input: { project_id: HOME, category_id: CATEGORY } }))

  test("the design studio opens a selection on a home in its division without being on the home's team", async () => {
    const { service } = harness({ selections: [] })
    service.db.projects[0].division_id = DIVISION
    service.grant(["selections.write"], { divisions: [DIVISION] })

    const created = await open(service)

    assert.equal(created.project_id, HOME)
    assert.equal(service.db.project_selections.length, 1)
  })

  test("a selection opens pending whatever status is asked for: only the approval paths confirm", async () => {
    const { service } = harness({ selections: [] })
    service.grant(["selections.write"])

    const created = await service.run(() => createProjectSelection({ input: { project_id: HOME, category_id: CATEGORY, status: "confirmed" } }))

    assert.equal(created.status, "pending")
    assert.equal(service.db.project_selections[0].status, "pending")
  })

  test("a member limited to another division cannot open a selection on the home", async () => {
    const { service } = harness({ selections: [] })
    service.db.projects[0].division_id = DIVISION
    service.grant(["selections.write"], { divisions: [OTHER_DIVISION] })

    await assert.rejects(open(service))
    assert.equal(service.db.project_selections.length, 0)
  })
})

describe("listSelectionOptions", () => {
  test("a community version of a withdrawn option is not offered", async () => {
    const { service } = harness()
    service.db.selection_options = [
      { id: OPTION, org_id: ORG, category_id: CATEGORY, name: "Pavers", is_available: false, is_archived: false, parent_option_id: null, sort_order: 1 },
      { id: COMMUNITY_UPGRADE, org_id: ORG, category_id: CATEGORY, name: "Pavers (Ridge)", is_available: true, is_archived: false, parent_option_id: OPTION, sort_order: 2 },
      { id: UPGRADE, org_id: ORG, category_id: CATEGORY, name: "Stamped concrete", is_available: true, is_archived: false, parent_option_id: null, sort_order: 3 },
    ]

    const offered = await service.run(() => listSelectionOptions(ORG, CATEGORY))

    assert.deepEqual(offered.map((row) => row.id), [UPGRADE])
  })
})

describe("supply eligibility on a selection change", () => {
  const ORDER_BY_PASSED = new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10)

  test("an option that cannot arrive in time is refused with what can, and an exception is on record", async () => {
    catalog = { [UPGRADE]: priced(UPGRADE, 2_000_00), [OPTION]: priced(OPTION, 1_100_00) }
    const { service, applied } = harness()
    supply.orderBy = { [UPGRADE]: ORDER_BY_PASSED }
    const error = await service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE })).catch((caught) => caught)
    assert.ok(error.code === "SELECTION_LEAD_TIME" && /had to be ordered by/.test(error.message) && error.alternates.map((alternate) => alternate.optionId).join() === OPTION && /Still in time: Laminate/.test(error.message))
    assert.deepEqual(applied, [])
    assert.deepEqual(openedExceptions.map((exception) => [exception.reason, exception.optionId, exception.selectionId]), [["lead_time_exceeded", UPGRADE, SELECTION]])
    // The page gets the refusal alone and the alternates as data, to offer them as choices.
    const failure = require("@/lib/action-result").actionError(error)
    assert.equal(failure.code, "SELECTION_LEAD_TIME")
    assert.match(failure.supply.reason, /had to be ordered by/)
    assert.doesNotMatch(failure.supply.reason, /Still in time/)
    assert.deepEqual(failure.supply.alternates.map((alternate) => alternate.optionId), [OPTION])
  })

  test("a selection already on a released purchase order is refused for buyer and builder alike", async () => {
    catalog = { [UPGRADE]: priced(UPGRADE, 2_000_00), [OPTION]: priced(OPTION, 1_100_00) }
    for (const portalAccess of [false, true]) {
      const { service, applied } = harness()
      supply.releasedPurchaseOrderId = id(91)
      supply.releasedPurchaseOrderTitle = "PO — Countertops — Lot 12"
      await assert.rejects(
        service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE, portalAccess })),
        (error) => error.code === "SELECTION_PROCUREMENT_RELEASED" && /PO — Countertops — Lot 12/.test(error.message) && error.alternates.length === 0,
      )
      assert.deepEqual(applied, [])
      assert.equal(openedExceptions[0].reason, "procurement_released")
    }
  })

  test("the database's own refusal reaches the caller in words when the supply moved after the explanation", async () => {
    catalog = { [UPGRADE]: priced(UPGRADE, 2_000_00) }
    const refusals = [
      [{ message: "This option had to be ordered by 2026-09-01 to arrive in time", details: "SELECTION_LEAD_TIME", hint: "2026-09-01" }, "SELECTION_LEAD_TIME", /ordered by Sep 1, 2026/],
      [{ message: "This selection has already been bought on a released purchase order; changing it needs a change order", details: "SELECTION_PROCUREMENT_RELEASED" }, "SELECTION_PROCUREMENT_RELEASED", /released purchase order/],
      [{ message: "The selection deadline for Kitchen was 2026-10-01; changes now need a change order", details: "SELECTION_LOCKED_CUTOFF" }, "SELECTION_LOCKED_CUTOFF", /deadline for Kitchen/],
    ]
    for (const [refusal, code, words] of refusals) {
      const { service } = harness()
      databaseRefusal = refusal
      await assert.rejects(
        service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE })),
        (error) => error.code === code && words.test(error.message),
      )
    }
  })
})

describe("who may change a home's selections", () => {
  const DIVISION = id(70)
  const OTHER_DIVISION = id(71)

  test("a design coordinator limited to another division cannot choose, or apply a package, on the home", async () => {
    catalog = { [UPGRADE]: priced(UPGRADE, 2_000_00), [PACKAGE]: { available: true, priceCents: 900_00, costCents: 400_00, categoryIds: [] } }
    const { service, applied } = harness()
    service.db.projects[0].division_id = DIVISION
    service.grant(["selections.write", "project.read"], { divisions: [OTHER_DIVISION] })
    await assert.rejects(service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE })), /Missing permission: selections\.write/)
    await assert.rejects(service.run(() => selectProjectPackage({ orgId: ORG, projectId: HOME, packageId: PACKAGE })), /Missing permission: selections\.write/)
    assert.deepEqual(applied, [])

    service.grant(["selections.write", "project.read"], { divisions: [DIVISION] })
    await service.run(() => selectProjectOption({ orgId: ORG, projectId: HOME, selectionId: SELECTION, optionId: UPGRADE }))
    assert.equal(applied.length, 1)
  })
})
