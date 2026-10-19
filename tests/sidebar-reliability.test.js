const test = require("node:test")
const assert = require("node:assert/strict")
const React = require("react")

const { createServiceHarness, replies, ORG, ACTOR } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

// Neighbouring modules with their own suites, or that only exist inside a
// Next.js request, are stubbed so the desks under test can load in Node.
stubModule("next/link", { __esModule: true, default: "a" })
const connectionGate = { current: async () => {} }
stubModule("next/server", { connection: () => connectionGate.current() })

const row = (id, extra = {}) => ({ id: String(id), org_id: ORG, ...extra })

/** Calls the first async server component under a page element, as Next would once the URL resolves. */
function dataComponent(element) {
  let found = null
  const visit = (node) => {
    if (found || !React.isValidElement(node)) return
    if (typeof node.type === "function" && node.type.constructor.name === "AsyncFunction") found = node
    else React.Children.forEach(node.props.children, visit)
  }
  visit(element)
  assert.ok(found, "the page renders an async data component")
  return found.type(found.props)
}

function childWhere(element, predicate) {
  return React.Children.toArray(element.props.children).find((child) => React.isValidElement(child) && predicate(child))
}

test("Safety retains old open incidents behind 600 closed records and counts beyond each page", async () => {
  const service = createServiceHarness({
    permissions: ["safety.read"],
    tables: {
      safety_incidents: [
        ...Array.from({ length: 600 }, (_, i) => row(`closed-${i}`, { status: "closed", occurred_at: 1000 + i })),
        ...Array.from({ length: 55 }, (_, i) => row(`open-${String(i).padStart(2, "0")}`, { status: "open", occurred_at: i })),
      ],
      observations: [row("observation", { status: "open" })],
      inspections: Array.from({ length: 80 }, (_, i) => row(i, { kind: "safety", result: "fail" })),
    },
  })
  const { getSafetyDesk } = freshRequire("lib/services/safety-desk.ts")

  const first = await service.run(() => getSafetyDesk())
  assert.equal(first.incidents.length, 50)
  assert.equal(first.openIncidentCount, 55)
  assert.equal(first.failedInspectionCount, 80)

  const second = await service.run(() => getSafetyDesk(undefined, { incidents: 2 }))
  assert.equal(second.incidents.length, 5)
  assert.equal(second.observations.length, 1, "paging incidents must not page observations")
  assert.equal(new Set([...first.incidents, ...second.incidents].map((incident) => incident.id)).size, 55)
})

test("Tasks stops on assignment failure instead of returning an incomplete successful list", async () => {
  const service = createServiceHarness({ tables: { tasks: [], task_assignments: [] } })
  service.tamper("task_assignments", replies.error("connection lost"))
  const { listMyTasksAction } = freshRequire("app/(app)/tasks/actions.ts")

  await assert.rejects(service.run(() => listMyTasksAction()), /Failed to load task assignments/)
  assert.deepEqual(service.reads("tasks"), [])
})

test("Portfolio schedule skips cancelled items and unused dependency reads", async () => {
  const service = createServiceHarness({
    tables: {
      schedule_items: [
        row("active", { project_id: "a", status: "in_progress" }),
        row("cancelled", { project_id: "a", status: "cancelled" }),
        row("other", { project_id: "b", status: "in_progress" }),
      ],
      schedule_dependencies: [row("dependency", { project_id: "a", item_id: "active", depends_on_item_id: "other" })],
    },
  })
  const { listScheduleItemsWithClient } = freshRequire("lib/services/schedule.ts")

  const items = await listScheduleItemsWithClient(service.client, ORG, ["a"], { excludeCancelled: true, includeDependencies: false })
  assert.deepEqual(items.map((item) => item.id), ["active"])
  assert.equal(service.reads("schedule_dependencies").length, 0)

  await listScheduleItemsWithClient(service.client, ORG, ["a"])
  assert.equal(service.reads("schedule_dependencies").length, 1, "project/default callers retain dependencies")
})

test("Banking desktop omits the legacy transaction query while mobile keeps it", async () => {
  stubModule("@/lib/services/books/access", { requireBooksAuthorization: async () => {} })
  stubModule("@/lib/services/books/module", { requireBooksWorkspaceEnabled: async () => {} })
  const service = createServiceHarness({
    permissions: ["books.read"],
    tables: {
      books_settings: [row("settings", { workspace_enabled: true })],
      bank_transactions: [row("transaction", { lifecycle_status: "posted", excluded: false, amount_cents: 100 })],
    },
  })
  const { getBooksWorkspace } = freshRequire("lib/services/books/workspace.ts")

  const desktop = await service.run(() => getBooksWorkspace(undefined, "banking", { includeTransactions: false }))
  assert.equal(desktop.bankTransactions.length, 0)
  assert.equal(service.reads("bank_transactions").length, 0)

  const mobile = await service.run(() => getBooksWorkspace(undefined, "banking"))
  assert.equal(mobile.bankTransactions.length, 1)
})

test("Scoped Bids finds packages beyond 500 unrelated records without leaking other scopes", async () => {
  const service = createServiceHarness({
    permissions: ["org.member"],
    divisions: ["division"],
    tables: {
      projects: [row("allowed", { division_id: "division", name: "Visible project" })],
      communities: [],
      project_members: [{ org_id: ORG, project_id: "allowed", user_id: ACTOR, status: "active" }],
      bid_packages: [
        ...Array.from({ length: 600 }, (_, i) => row(i, { project_id: "other", due_at: i, status: "open" })),
        row("visible", { project_id: "allowed", due_at: 900, status: "open" }),
        row("org-wide", { project_id: null, due_at: 901, status: "open" }),
      ],
    },
  })
  const { listOrgBidPackages } = freshRequire("lib/services/bids.ts")

  const packages = await service.run(() => listOrgBidPackages(undefined, "division"))
  assert.deepEqual(packages.map((pkg) => pkg.id), ["visible", "org-wide"])
})

test("Plans reads beyond 100 plans and the ladder reuses the collection aggregates", async () => {
  const tables = () => ({ house_plans: Array.from({ length: 520 }, (_, i) => row(i, { code: String(i).padStart(4, "0"), name: `Plan ${i}`, community_ids: [] })) })
  const { getPlanLadder, listHousePlans } = freshRequire("lib/services/house-plans.ts")

  const listed = createServiceHarness({ permissions: ["plan.read"], tables: tables() })
  await listed.run(() => listHousePlans())
  const ladder = createServiceHarness({ permissions: ["plan.read"], tables: tables() })
  const result = await ladder.run(() => getPlanLadder())

  assert.equal(result.rungs.length, 520)
  assert.equal(ladder.reads("house_plans").length, 2)
  assert.equal(ladder.reads("house_plan_versions").length, listed.reads("house_plan_versions").length, "the ladder does not load the aggregates a second time")
})

test("Production Home scope failures cannot masquerade as no active projects", async () => {
  const service = createServiceHarness({ permissions: [] })
  service.tamper("projects", replies.error("connection lost"))
  const { getProductionHomeData } = freshRequire("lib/services/production-home.ts")

  await assert.rejects(service.run(() => getProductionHomeData()), /Failed to scope production Home projects/)
})

test("Queue pagination preserves independent queue pages and scope filters", () => {
  const { QueuePagination } = freshRequire("components/layout/queue-pagination.tsx")
  const nav = QueuePagination({ page: 2, pageSize: 50, total: 151, href: "/safety?observationsPage=3&division=d", pageParam: "incidentsPage" })
  const links = React.Children.toArray(nav.props.children[1].props.children).filter(React.isValidElement)
  assert.deepEqual(links.map((link) => link.props.href), [
    "/safety?observationsPage=3&division=d&incidentsPage=1",
    "/safety?observationsPage=3&division=d&incidentsPage=3",
  ])
})

test("Purchasing second-page exceptions do not load unrelated tab data", async () => {
  const unexpected = async () => { throw new Error("Unrelated tab loaded") }
  let input
  const stubs = {
    "@/components/ui/button": { Button: "button" },
    "@/components/ui/input": { Input: "input" },
    "@/components/layout/desk-skeletons": { PurchasingSkeleton: "skeleton" },
    "@/components/layout/page-layout": { PageLayout: "page-layout" },
    "@/components/purchasing/purchasing-client": { PurchasingClient: "purchasing-client" },
    "@/components/purchasing/po-position-band": { PoPositionBand: "band" },
    "@/components/purchasing/deliveries-tab": { DeliveriesTab: "deliveries" },
    "@/components/purchasing/po-acknowledgments-tab": { PoAcknowledgmentsTab: "acknowledgments" },
    "@/components/purchasing/sale-cancellation-picks-band": { SaleCancellationPicksBand: "picks" },
    "@/lib/services/production-bid-queue": { listProductionBidQueue: unexpected },
    "@/lib/services/commitment-change-orders": { listVarianceOrders: unexpected },
    "@/lib/services/cost-codes": { listCostCodes: unexpected },
    "@/lib/services/po-completions": { listPoCompletions: unexpected },
    "@/lib/services/po-generation": { listPoExceptions: async (args) => { input = args; return { items: [], count: 80 } } },
    "@/lib/services/price-book": { getPriceBookHealth: unexpected, getRenewalCandidates: unexpected, listPriceAgreements: unexpected },
    "@/lib/services/reports/variance-analysis": { getVarianceAnalysis: unexpected },
    "@/lib/services/po-positions": { listPoPositionExceptions: unexpected },
    "@/lib/services/purchasing-settings": { getPurchasingSettings: unexpected },
    "@/lib/services/desk-context": { getAmbientDeskContext: async () => ({}) },
    "@/lib/services/po-receipts": { listPoDeliveries: unexpected },
    "@/lib/services/permissions": { hasPermission: async () => false },
    "@/lib/services/po-acknowledgments": { listPoAcknowledgmentQueue: unexpected },
    "@/lib/services/sale-cancellation-picks": { listSaleCancellationReviews: unexpected },
  }
  for (const [request, exports] of Object.entries(stubs)) stubModule(request, exports)
  const { default: PurchasingPage } = freshRequire("app/(app)/purchasing/page.tsx")

  const content = await dataComponent(PurchasingPage({ searchParams: Promise.resolve({ tab: "exceptions", page: "2", project: "project" }) }))

  assert.equal(input.page, 2)
  assert.equal(input.pageSize, 50)
  const pagination = childWhere(content, (child) => child.props.pageSize === 50 && child.props.total === 80)
  assert.ok(pagination, "The selected queue must expose pagination")
  assert.match(pagination.props.href, /project=project/)
})

// --- Warranty desk -----------------------------------------------------------

const WARRANTY_SERVICES = [
  "getWarrantyCostSummary", "getWarrantyDefectAnalysis", "isWarrantyAnalyticsAvailable", "listWarrantyBackcharges",
  "listWarrantyRequestsForOrg", "listWarrantyTechnicians", "listWarrantyVisitsForDispatch", "listWarrantyVisitsPendingVerification",
]

/** Loads the warranty page with every service refusing, except the ones the test lets answer. */
function warrantyDesk({ ambient = {}, services = {}, booksAccess = { adjust: false } } = {}) {
  const unexpected = async () => { throw new Error("unrelated tab loaded") }
  stubModule("@/lib/services/warranty", {
    ...Object.fromEntries(WARRANTY_SERVICES.map((name) => [name, unexpected])),
    getWarrantyDeskTimeZone: async () => "UTC",
    ...services,
  })
  stubModule("@/lib/services/books/ui-access", { getBooksUiAccess: async () => booksAccess })
  stubModule("@/lib/services/desk-context", { getAmbientDeskContext: async () => ambient })
  stubModule("@/components/layout/page-layout", { PageLayout: "page-layout" })
  stubModule("@/components/layout/desk-skeletons", { WarrantySkeleton: "skeleton" })
  stubModule("app/(app)/warranty/warranty-desk-client.tsx", { WarrantyDeskClient: "desk" })
  const { default: WarrantyDeskPage } = freshRequire("app/(app)/warranty/page.tsx")
  return (searchParams) => dataComponent(WarrantyDeskPage({ searchParams: Promise.resolve(searchParams) }))
}

const deskOf = (result) => childWhere(result, (child) => child.type === "desk")
const pagingOf = (result) => childWhere(result, (child) => child.props.label === "Warranty pages")

test("Warranty dispatch loads only the selected tab", async () => {
  let dispatchReads = 0
  const render = warrantyDesk({
    ambient: { divisionId: "division" },
    services: {
      listWarrantyVisitsForDispatch: async (options) => {
        dispatchReads++
        assert.equal(options.divisionId, "division")
        assert.equal(options.page, 2)
        assert.equal(options.from, "2026-10-04T00:00:00.000Z")
        assert.equal(options.to, "2026-10-11T00:00:00.000Z")
        return { rows: [{ id: "visit" }], total: 251 }
      },
    },
  })

  const result = await render({ tab: "dispatch", page: "2", week: "2026-10-04", division: "division" })

  assert.equal(dispatchReads, 1)
  assert.equal(deskOf(result).props.initialTab, "dispatch")
  assert.deepEqual(deskOf(result).props.visits, [{ id: "visit" }])
  const paging = pagingOf(result)
  assert.equal(paging.props.total, 251)
  assert.equal(paging.props.page, 2)
  assert.match(paging.props.href, /division=division/)
  assert.match(paging.props.href, /week=2026-10-04/)
})

test("Warranty query changes reset the loading boundary before live desk reads", () => {
  let query = new URLSearchParams({ tab: "dispatch", week: "2026-10-04" })
  stubModule("next/navigation", { useSearchParams: () => query })
  const { WarrantyDeskNavigation } = freshRequire("app/(app)/warranty/warranty-desk-navigation.tsx")
  const children = React.createElement("div")
  const fallback = React.createElement("span")

  const first = WarrantyDeskNavigation({ children, fallback })
  query = new URLSearchParams({ tab: "dispatch", week: "2026-10-11" })
  const next = WarrantyDeskNavigation({ children, fallback })

  assert.notEqual(first.key, next.key)
  assert.equal(next.type, React.Suspense)
  assert.equal(next.props.children, children)
  assert.equal(next.props.fallback, fallback)
})

test("Warranty prefetch does not start authorization or desk reads before a live connection", async () => {
  let release
  let reads = 0
  const gate = new Promise((resolve) => { release = resolve })
  connectionGate.current = () => gate
  try {
    warrantyDesk()
    stubModule("@/lib/services/desk-context", { getAmbientDeskContext: async () => { reads++; throw new Error("Live context reached") } })
    const { default: WarrantyDeskPage } = freshRequire("app/(app)/warranty/page.tsx")
    const pending = dataComponent(WarrantyDeskPage({ searchParams: Promise.resolve({ tab: "dispatch" }) }))
    const rejected = assert.rejects(pending, /Live context reached/)
    assert.equal(reads, 0)
    release()
    await rejected
    assert.equal(reads, 1)
  } finally {
    connectionGate.current = async () => {}
  }
})

test("Warranty queue applies normalized search and SLA across the selected database page", async () => {
  let input
  const render = warrantyDesk({
    ambient: { divisionId: "d", communityId: "c" },
    services: {
      listWarrantyRequestsForOrg: async (options) => { input = options; return { rows: [{ id: "match" }], total: 1201 } },
      listWarrantyTechnicians: async () => [],
    },
  })

  const result = await render({ tab: "queue", page: "3", search: "  Home  12  ", sla: "first_response_breached" })

  assert.equal(input.search, "Home 12")
  assert.equal(input.slaState, "first_response_breached")
  assert.equal(input.page, 3)
  assert.equal(input.divisionId, "d")
  assert.equal(input.communityId, "c")
  assert.equal(deskOf(result).props.initialSearch, "Home 12")
  assert.equal(deskOf(result).props.initialSla, "first_response_breached")
  const paging = pagingOf(result)
  assert.equal(paging.props.total, 1201)
  assert.match(paging.props.href, /sla=first_response_breached/)
  assert.match(paging.props.href, /search=/)
})

test("warranty dispatch, verification and backcharges all receive the ambient community lens", async () => {
  for (const [tab, selected] of [["dispatch", "listWarrantyVisitsForDispatch"], ["verify", "listWarrantyVisitsPendingVerification"], ["backcharges", "listWarrantyBackcharges"]]) {
    let input
    const render = warrantyDesk({
      ambient: { divisionId: "division", communityId: "community" },
      services: { [selected]: async (options) => { input = options; return { rows: [], total: 1201 } } },
    })

    const result = await render({ tab, page: "2", week: "2026-10-04" })

    assert.equal(input.communityId, "community", tab)
    assert.equal(input.divisionId, "division", tab)
    assert.equal(input.page, 2, tab)
    assert.match(deskOf(result).key, /division.*community/, tab)
    assert.equal(pagingOf(result).props.total, 1201, tab)
  }
})

test("unavailable scoped warranty analytics does not fetch broad reports or display empty totals", async () => {
  const render = warrantyDesk({
    ambient: { divisionId: "division", communityId: "community" },
    services: { isWarrantyAnalyticsAvailable: async () => false },
  })

  const result = await render({ tab: "analytics" })

  assert.equal(deskOf(result).props.analyticsAvailable, false)
  assert.deepEqual(deskOf(result).props.costs, [])
  assert.deepEqual(deskOf(result).props.defects, [])
})
