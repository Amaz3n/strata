require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const ts = require("typescript")
const { readAllRows } = require("../lib/land/paging.ts")

// Run the production functions with isolated data adapters. This keeps the
// failure/large-dataset cases deterministic without a live organization.
function functions(file, names, bindings = {}) {
  bindings = { connection: async () => {}, ...bindings }
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  assert.equal(declarations.length, names.length)
  const code = ts.transpileModule(declarations.map(node => node.getText(source)).join("\n") + `\nexport { ${names.join(",")} };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}
  new Function("exports", "require", ...Object.keys(bindings), code)(exports, require, ...Object.values(bindings))
  return exports
}

function database(tables, failure) {
  const calls = []
  return { calls, from(table) {
    const predicates = [], orders = []
    let from = 0, to = Infinity, head = false
    const query = {
      select(_fields, options) { head = !!options?.head; return query },
      eq(key, value) { predicates.push(row => row[key] === value); return query },
      neq(key, value) { predicates.push(row => row[key] !== value); return query },
      is(key, value) { predicates.push(row => (row[key] ?? null) === value); return query },
      in(key, values) { predicates.push(row => values.includes(row[key])); return query },
      or(expression) {
        const match = expression.match(/^(\w+)\.is\.null,\1\.in\.\((.*)\)$/)
        assert.ok(match, expression)
        const [, key, list] = match
        predicates.push(row => row[key] == null || list.split(",").includes(row[key]))
        return query
      },
      order(key, options = {}) { orders.push([key, options.ascending !== false]); return query },
      limit(cap) { to = cap - 1; return query },
      range(start, end) { from = start; to = end; return query },
      maybeSingle() { return query.then(result => ({ ...result, data: result.data?.[0] ?? null })) },
      then(resolve, reject) {
        calls.push({ table, from, to, head })
        if (failure === table) return Promise.resolve({ data: null, count: null, error: { message: "connection lost" } }).then(resolve, reject)
        const rows = (tables[table] ?? []).filter(row => predicates.every(predicate => predicate(row))).slice()
        rows.sort((a, b) => {
          for (const [key, ascending] of orders) {
            const comparison = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0
            if (comparison) return ascending ? comparison : -comparison
          }
          return 0
        })
        return Promise.resolve({ data: head ? null : rows.slice(from, to + 1), count: rows.length, error: null }).then(resolve, reject)
      },
    }
    return query
  } }
}
const context = supabase => ({ supabase, orgId: "org", userId: "user" })
const row = (id, extra = {}) => ({ id: String(id), org_id: "org", ...extra })

test("Safety retains old open incidents behind 600 closed records and counts beyond each page", async () => {
  const db = database({
    safety_incidents: [...Array.from({ length: 600 }, (_, i) => row(i, { status: "closed", occurred_at: 1000 + i })), ...Array.from({ length: 55 }, (_, i) => row(`open-${i}`, { status: "open", occurred_at: i }))],
    observations: [row("observation", { status: "open" })],
    inspections: Array.from({ length: 80 }, (_, i) => row(i, { kind: "safety", result: "fail" })),
  })
  const { getSafetyDesk } = functions("lib/services/safety-desk.ts", ["getSafetyDesk", "projectName"], { requireOrgContext: async () => context(db), requirePermission: async () => {}, PAGE_SIZE: 50 })
  const first = await getSafetyDesk()
  assert.equal(first.incidents.length, 50)
  assert.equal(first.openIncidentCount, 55)
  assert.equal(first.failedInspectionCount, 80)
  const second = await getSafetyDesk(undefined, { incidents: 2 })
  assert.equal(second.incidents.length, 5)
  assert.equal(second.observations.length, 1, "paging incidents must not page observations")
  assert.equal(new Set([...first.incidents, ...second.incidents].map(row => row.id)).size, 55)
})

test("Tasks stops on assignment failure instead of returning an incomplete successful list", async () => {
  const db = database({}, "task_assignments")
  const { listMyTasksAction } = functions("app/(app)/tasks/actions.ts", ["listMyTasksAction"], { requireOrgContext: async () => context(db), TASK_SELECT: "*", mapFullTask: row => row })
  await assert.rejects(listMyTasksAction(), /Failed to load task assignments/)
  assert.deepEqual(db.calls.map(call => call.table), ["task_assignments"])
})

test("Portfolio schedule skips cancelled items and unused dependency reads", async () => {
  const db = database({ schedule_items: [row("active", { project_id: "a", status: "in_progress" }), row("cancelled", { project_id: "a", status: "cancelled" }), row("other", { project_id: "b", status: "in_progress" })] })
  let dependencies = 0
  const { listScheduleItemsWithClient } = functions("lib/services/schedule.ts", ["listScheduleItemsWithClient"], { loadDependencies: async () => { dependencies++; return {} }, mapScheduleItem: row => row })
  const items = await listScheduleItemsWithClient(db, "org", ["a"], { excludeCancelled: true, includeDependencies: false })
  assert.deepEqual(items.map(row => row.id), ["active"])
  assert.equal(dependencies, 0)
  await listScheduleItemsWithClient(db, "org", ["a"])
  assert.equal(dependencies, 1, "project/default callers retain dependencies")
})

test("Banking desktop omits the legacy transaction query while mobile keeps it", async () => {
  const db = database({ books_settings: [row("settings", { workspace_enabled: true })], bank_transactions: [row("transaction", { lifecycle_status: "posted", excluded: false, amount_cents: 100 })] })
  const { getBooksWorkspace } = functions("lib/services/books/workspace.ts", ["getBooksWorkspace", "queryForSection"], {
    requireOrgContext: async () => context(db), requireAuthorization: async () => {}, requireBooksWorkspaceEnabled: async () => {},
    createServiceSupabaseClient: () => db, getUserPermissions: async () => [], RECONCILIATION_ITEM_CAP: 100,
  })
  const desktop = await getBooksWorkspace(undefined, "banking", { includeTransactions: false })
  assert.equal(desktop.bankTransactions.length, 0)
  assert.ok(!db.calls.some(call => call.table === "bank_transactions"))
  const mobile = await getBooksWorkspace(undefined, "banking")
  assert.equal(mobile.bankTransactions.length, 1)
})

test("Scoped Bids finds packages beyond 500 unrelated records without leaking other scopes", async () => {
  const db = database({
    projects: [row("allowed", { division_id: "division", name: "Visible project" })], communities: [],
    bid_packages: [...Array.from({ length: 600 }, (_, i) => row(i, { project_id: "other", due_at: i })), row("visible", { project_id: "allowed", due_at: 900 }), row("org-wide", { project_id: null, due_at: 901 })],
  })
  const { listOrgBidPackages } = functions("lib/services/bids.ts", ["listOrgBidPackages"], {
    requireOrgContext: async () => context(db), requireAnyPermission: async () => {}, getDivisionScopedProjectIds: async () => ["allowed"],
    getDivisionAccessForUser: async () => ({ assignedOnly: true, divisionIds: ["division"] }), readAllRows,
    BID_PACKAGE_COLUMNS: "*", mapBidPackage: row => row, decorateBidPackageSummaries: async (_db, _org, rows) => rows,
  })
  const packages = await listOrgBidPackages(undefined, "division")
  assert.deepEqual(packages.map(row => row.id), ["visible", "org-wide"])
})

test("Plans reads beyond 100 plans and the ladder reuses the collection aggregates", async () => {
  const db = database({ house_plans: Array.from({ length: 520 }, (_, i) => row(i, { code: String(i).padStart(4, "0"), name: `Plan ${i}`, community_ids: [] })) })
  let aggregateCalls = 0
  const { getPlanLadder } = functions("lib/services/house-plans.ts", ["loadHousePlanCollection", "getPlanLadder"], {
    requireOrgContext: async () => context(db), requirePermission: async () => {}, getDivisionAccessForUser: async () => ({ assignedOnly: false }),
    readAllRows, planSelect: "*", mapPlan: row => row,
    loadPlanAggregates: async () => { aggregateCalls++; return { elevations: [], versions: [], lots: [], availability: [] } },
    authorize: async () => ({ allowed: false }), median: () => null, grossMarginPct: () => null, marginBand: () => "unknown", THIN_MARGIN_PCT: 20,
  })
  const result = await getPlanLadder()
  assert.equal(result.rungs.length, 520)
  assert.equal(aggregateCalls, 1)
  assert.equal(db.calls.filter(call => call.table === "house_plans").length, 2)
})

test("Purchasing second-page exceptions do not load unrelated tab data", async () => {
  let input
  const unexpected = async () => { throw new Error("Unrelated tab loaded") }
  const { PurchasingPageContent } = functions("app/(app)/purchasing/page.tsx", ["PurchasingPageContent", "relationName"], {
    getAmbientDeskContext: async () => ({}), listPoExceptions: async args => { input = args; return { items: [], count: 80 } },
    listPriceAgreements: unexpected, getPriceBookHealth: unexpected, listProductionBidQueue: unexpected, listVarianceOrders: unexpected,
    listPoCompletions: unexpected, getVarianceAnalysis: unexpected, listCompanies: unexpected, listCostCodes: unexpected,
    listCommunities: unexpected, listHousePlans: unexpected, PageLayout: "div", PurchasingClient: "div", QueuePagination: "nav",
  })
  const element = await PurchasingPageContent({ searchParams: Promise.resolve({ tab: "exceptions", page: "2", project: "project" }) })
  assert.equal(input.page, 2)
  assert.equal(input.pageSize, 50)
  const pagination = element.props.children.find(child => child?.type === "nav")
  assert.ok(pagination, "The selected queue must expose pagination")
  assert.equal(pagination.props.total, 80)
  assert.match(pagination.props.href, /project=project/)
})

test("Warranty dispatch loads only the selected tab", async () => {
  const unexpected = async () => { throw new Error("unrelated tab loaded") }
  const bindings = Object.fromEntries([
    "getBooksUiAccess", "listCompanies", "getWarrantyCostSummary", "getWarrantyDefectAnalysis",
    "listWarrantyBackcharges", "listWarrantyRequestsForOrg", "listWarrantyTechnicians",
    "listWarrantyVisitsPendingVerification",
  ].map(name => [name, unexpected]))
  let dispatchReads = 0
  const { WarrantyDeskData } = functions("app/(app)/warranty/page.tsx", ["WarrantyDeskData"], {
    ...bindings,
    getAmbientDeskContext: async () => ({ divisionId: "division" }),
    listWarrantyVisitsForDispatch: async options => {
      dispatchReads++
      assert.equal(options.divisionId, "division")
      assert.equal(options.page, 2)
      assert.equal(options.from, "2026-10-04T00:00:00.000Z")
      assert.equal(options.to, "2026-10-11T00:00:00.000Z")
      return { rows: [{ id: "visit" }], total: 251 }
    },
    WarrantyDeskClient: "div", QueuePagination: "nav", Link: "a",
    ...require("../lib/warranty/desk-query"),
  })
  const result = await WarrantyDeskData({ searchParams: Promise.resolve({ tab: "dispatch", page: "2", week: "2026-10-04", division: "division" }) })
  assert.equal(dispatchReads, 1)
  const desk = result.props.children.find(child => child?.props?.initialTab === "dispatch")
  assert.equal(desk.props.initialTab, "dispatch")
  assert.deepEqual(desk.props.visits, [{ id: "visit" }])
  const pagination = result.props.children.find(child => child?.props?.label === "Warranty pages")
  assert.equal(pagination.props.total, 251)
  assert.equal(pagination.props.page, 2)
  assert.match(pagination.props.href, /division=division/)
  assert.match(pagination.props.href, /week=2026-10-04/)
})

test("Production Home scope failures cannot masquerade as no active projects", async () => {
  const db = database({}, "projects")
  const { resolveScopedProjectIds } = functions("lib/services/production-home.ts", ["resolveScopedProjectIds"])
  await assert.rejects(resolveScopedProjectIds(context(db), {}, null), /Failed to scope production Home projects/)
})

test("Queue pagination preserves independent queue pages and scope filters", () => {
  const { QueuePagination } = functions("components/layout/queue-pagination.tsx", ["QueuePagination"], { Link: "a" })
  const result = QueuePagination({ page: 2, pageSize: 50, total: 151, href: "/safety?observationsPage=3&division=d", pageParam: "incidentsPage" })
  const links = result.props.children[1].props.children.filter(Boolean)
  assert.deepEqual(links.map(link => link.props.href), [
    "/safety?observationsPage=3&division=d&incidentsPage=1",
    "/safety?observationsPage=3&division=d&incidentsPage=3",
  ])
})

test("Warranty query changes reset the loading boundary before live desk reads", async () => {
  let query = new URLSearchParams({ tab: "dispatch", week: "2026-10-04" })
  const { WarrantyDeskNavigation } = functions("app/(app)/warranty/warranty-desk-navigation.tsx", ["WarrantyDeskNavigation"], {
    Suspense: require("react").Suspense, useSearchParams: () => query,
  })
  const children = {}, fallback = {}
  const first = WarrantyDeskNavigation({ children, fallback })
  query = new URLSearchParams({ tab: "dispatch", week: "2026-10-11" })
  const next = WarrantyDeskNavigation({ children, fallback })
  assert.notEqual(first.key, next.key)
  assert.equal(first.type, require("react").Suspense)
  assert.equal(next.props.children, children)
  assert.equal(next.props.fallback, fallback)
})

test("Warranty prefetch does not start authorization or desk reads before a live connection", async () => {
  let release, reads = 0
  const connection = new Promise(resolve => { release = resolve })
  const { WarrantyDeskData } = functions("app/(app)/warranty/page.tsx", ["WarrantyDeskData"], {
    connection: () => connection,
    getAmbientDeskContext: async () => { reads++; throw new Error("Live context reached") },
  })
  const result = WarrantyDeskData({ searchParams: Promise.resolve({ tab: "dispatch" }) })
  const rejected = assert.rejects(result, /Live context reached/)
  assert.equal(reads, 0)
  release()
  await rejected
  assert.equal(reads, 1)
})

test("Warranty queue applies normalized search and SLA across the selected database page", async () => {
  const unexpected = async () => { throw new Error("unrelated tab loaded") }
  const bindings = Object.fromEntries([
    "getBooksUiAccess", "getWarrantyCostSummary", "getWarrantyDefectAnalysis", "listWarrantyBackcharges",
    "listWarrantyVisitsForDispatch", "listWarrantyVisitsPendingVerification",
  ].map(name => [name, unexpected]))
  let input
  const { WarrantyDeskData } = functions("app/(app)/warranty/page.tsx", ["WarrantyDeskData"], {
    ...bindings, ...require('../lib/warranty/desk-query'),
    getAmbientDeskContext: async () => ({ divisionId: 'd', communityId: 'c' }),
    listWarrantyRequestsForOrg: async options => { input = options; return { rows: [{ id: 'match' }], total: 1201 } },
    listWarrantyTechnicians: async () => [], listCompanies: async () => [],
    WarrantyDeskClient: 'desk', QueuePagination: 'pagination', Link: 'a',
  })
  const result = await WarrantyDeskData({ searchParams: Promise.resolve({ tab: 'queue', page: '3', search: '  Home  12  ', sla: 'first_response_breached' }) })
  assert.equal(input.search, 'Home 12');assert.equal(input.slaState, 'first_response_breached')
  assert.equal(input.page, 3);assert.equal(input.divisionId, 'd');assert.equal(input.communityId, 'c')
  const desk = result.props.children.find(child => child?.type === 'desk')
  assert.equal(desk.props.initialSearch, 'Home 12');assert.equal(desk.props.initialSla, 'first_response_breached')
  const paging = result.props.children.find(child => child?.type === 'pagination')
  assert.equal(paging.props.total, 1201)
  assert.match(paging.props.href, /sla=first_response_breached/);assert.match(paging.props.href, /search=/)
})

test('warranty dispatch, verification and backcharges all receive the ambient community lens', async () => {
  for (const [tab, selected] of [['dispatch', 'listWarrantyVisitsForDispatch'], ['verify', 'listWarrantyVisitsPendingVerification'], ['backcharges', 'listWarrantyBackcharges']]) {
    let input
    const names = ['getBooksUiAccess', 'getWarrantyCostSummary', 'getWarrantyDefectAnalysis', 'listWarrantyBackcharges', 'listWarrantyRequestsForOrg', 'listWarrantyTechnicians', 'listWarrantyVisitsForDispatch', 'listWarrantyVisitsPendingVerification', 'listCompanies']
    const bindings = Object.fromEntries(names.map(name => [name, async () => { throw new Error('Unrelated tab loaded') }]))
    bindings[selected] = async options => { input = options; return { rows: [], total: 1201 } }
    const { WarrantyDeskData } = functions('app/(app)/warranty/page.tsx', ['WarrantyDeskData'], {
      ...bindings, ...require('../lib/warranty/desk-query'),
      getAmbientDeskContext: async () => ({ divisionId: 'division', communityId: 'community' }),
      WarrantyDeskClient: 'desk', QueuePagination: 'pagination', Link: 'a',
    })
    const result = await WarrantyDeskData({ searchParams: Promise.resolve({ tab, page: '2', week: '2026-10-04' }) })
    assert.equal(input.communityId, 'community', tab);assert.equal(input.divisionId, 'division', tab);assert.equal(input.page, 2, tab)
    const desk = result.props.children.find(child => child?.type === 'desk')
    assert.match(desk.key, /division:community:/, tab)
    const pagination = result.props.children.find(child => child?.type === 'pagination')
    assert.equal(pagination.props.total, 1201, tab)
  }
})

test('unavailable scoped warranty analytics does not fetch broad reports or display empty totals',async()=>{
 const unexpected=async()=>{throw new Error('Broad report loaded')}
 const {WarrantyDeskData}=functions('app/(app)/warranty/page.tsx',['WarrantyDeskData'],{
  ...require('../lib/warranty/desk-query'),getAmbientDeskContext:async()=>({divisionId:'division',communityId:'community'}),
  isWarrantyAnalyticsAvailable:async()=>false,getWarrantyCostSummary:unexpected,getWarrantyDefectAnalysis:unexpected,getBooksUiAccess:async()=>({adjust:false}),
  WarrantyDeskClient:'desk',QueuePagination:'pagination',Link:'a',
 })
 const result=await WarrantyDeskData({searchParams:Promise.resolve({tab:'analytics'})})
 const desk=result.props.children.find(child=>child?.type==='desk')
 assert.equal(desk.props.analyticsAvailable,false)
 assert.deepEqual(desk.props.costs,[]);assert.deepEqual(desk.props.defects,[])
})
