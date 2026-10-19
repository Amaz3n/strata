const assert = require("node:assert/strict")
const { test } = require("node:test")

const { stubModule, freshRequire } = require("./support/modules")

// The page is a dispatcher over services and client UI; both are stand-ins
// here, so what is under test is which queue it reads and how it pages.
const marker = (name) => Object.assign(() => null, { displayName: name })
const PageLayout = marker("PageLayout")
const PurchasingClient = marker("PurchasingClient")

stubModule("next/server", { connection: async () => {} })
stubModule("@/components/ui/button", { Button: marker("Button") })
stubModule("@/components/ui/input", { Input: marker("Input") })
stubModule("@/components/layout/page-loading-skeleton", { PageLoadingSkeleton: marker("PageLoadingSkeleton") })
stubModule("@/components/layout/page-layout", { PageLayout })
stubModule("@/components/purchasing/purchasing-client", { PurchasingClient })
let ambient = {}
stubModule("@/lib/services/desk-context", { getAmbientDeskContext: async () => ambient })
stubModule("@/lib/services/permissions", { hasPermission: async () => false })

/** Every purchasing read refuses unless a test answers it. */
const answers = {}
const loaded = []
const service = (name) => async (input) => {
  loaded.push(name)
  if (!answers[name]) throw new Error(`Unrelated tab loaded: ${name}`)
  return answers[name](input)
}
for (const [module, names] of Object.entries({
  "@/lib/services/production-bid-queue": ["listProductionBidQueue"],
  "@/lib/services/commitment-change-orders": ["listVarianceOrders"],
  "@/lib/services/cost-codes": ["listCostCodes"],
  "@/lib/services/po-completions": ["listPoCompletions"],
  "@/lib/services/po-generation": ["listPoExceptions"],
  "@/lib/services/price-book": ["getPriceBookHealth", "getRenewalCandidates", "listPriceAgreements"],
  "@/lib/services/reports/variance-analysis": ["getVarianceAnalysis"],
  "@/lib/services/po-positions": ["listPoPositionExceptions"],
  "@/lib/services/purchasing-settings": ["getPurchasingSettings"],
})) {
  stubModule(module, Object.fromEntries(names.map((name) => [name, service(name)])))
}

const { QueuePagination } = require("@/components/layout/queue-pagination")
const { default: PurchasingPage } = freshRequire("app/(app)/purchasing/page.tsx")

/** Render the page's streamed content (the child of its Suspense boundary). */
function renderContent(searchParams) {
  const content = PurchasingPage({ searchParams: Promise.resolve(searchParams) }).props.children
  return content.type(content.props)
}

const childOfType = (element, type) => [element.props.children].flat(Infinity).find((child) => child?.type === type)

test("the second page of exceptions reads only that queue and pages within its scope", async () => {
  let input
  answers.listPoExceptions = async (args) => {
    input = args
    return { items: [], count: 80 }
  }

  const page = await renderContent({ tab: "exceptions", page: "2", project: "project-7" })

  assert.deepEqual(loaded, ["listPoExceptions"])
  assert.deepEqual({ page: input.page, pageSize: input.pageSize, projectId: input.projectId }, {
    page: 2,
    pageSize: 50,
    projectId: "project-7",
  })
  assert.equal(childOfType(page, PurchasingClient).props.initialTab, "exceptions")
  const pagination = childOfType(page, QueuePagination)
  assert.equal(pagination.props.total, 80)
  assert.equal(pagination.props.page, 2)
  const href = new URL(pagination.props.href, "https://arc.invalid")
  assert.equal(href.searchParams.get("tab"), "exceptions")
  assert.equal(href.searchParams.get("project"), "project-7")
})

test("the price book loads no vendor, community or plan roster: those are searched on the server", async () => {
  loaded.length = 0
  answers.listPriceAgreements = async () => ({ items: [], count: 0 })
  answers.getPriceBookHealth = async () => ({ active: 0, leadDays: 45 })
  answers.getRenewalCandidates = async () => ({ rows: [], count: 0 })
  answers.listCostCodes = async () => [{ id: "cc-1", name: "Framing", code: "06-100" }]

  const page = await renderContent({ tab: "price-book" })

  assert.deepEqual([...loaded].sort(), ["getPriceBookHealth", "getRenewalCandidates", "listCostCodes", "listPriceAgreements"])
  const props = childOfType(page, PurchasingClient).props
  for (const roster of ["companies", "communities", "plans"]) assert.equal(props[roster], undefined)
  assert.deepEqual(props.costCodes, [{ id: "cc-1", name: "Framing", code: "06-100" }])
})

test("price-book filters reach the server query and the renewals band uses the org's lead days", async () => {
  loaded.length = 0
  const vendor = "11111111-1111-4111-8111-111111111111"
  const calls = {}
  answers.listPriceAgreements = async (input) => { calls.agreements = input; return { items: [], count: 0 } }
  answers.getPriceBookHealth = async () => ({ active: 0, leadDays: 45 })
  answers.getRenewalCandidates = async (input) => { calls.renewals = input; return { rows: [], count: 0 } }
  answers.listCostCodes = async () => []

  const page = await renderContent({ tab: "price-book", vendor, pbstatus: "active", expiring: "1" })

  assert.equal(calls.agreements.companyId, vendor)
  assert.equal(calls.agreements.status, "active")
  assert.equal(calls.agreements.expiringWithinDays, 45)
  assert.equal(calls.renewals.windowDays, 45)
  assert.equal(childOfType(page, PurchasingClient).props.priceBookFilters.expiring, true)
})

test("each home queue reads in the ambient division and community lens, keeps the home and page in its links, and remounts when the lens changes", async () => {
  const keys = new Set()
  answers.listPoPositionExceptions = async () => ({ rows: [], total: 0, truncated: false })
  answers.getPurchasingSettings = async () => ({})
  for (const [tab, owner] of [["exceptions", "listPoExceptions"], ["vpos", "listVarianceOrders"], ["completions", "listPoCompletions"]]) {
    for (const communityId of ["community-1", "community-2"]) {
      let input
      answers[owner] = async (args) => { input = args; return { items: [], count: 1203 } }
      ambient = { divisionId: "division-1", communityId }
      const page = await renderContent({ tab, project: "project-7", page: "3" })
      assert.deepEqual({ divisionId: input.divisionId, communityId: input.communityId, projectId: input.projectId, page: input.page, pageSize: input.pageSize }, {
        divisionId: "division-1", communityId, projectId: "project-7", page: 3, pageSize: 50,
      })
      keys.add(childOfType(page, PurchasingClient).key)
      const pagination = childOfType(page, QueuePagination)
      assert.equal(pagination.props.total, 1203)
      const href = new URL(pagination.props.href, "https://arc.invalid")
      assert.deepEqual([href.searchParams.get("tab"), href.searchParams.get("project")], [tab, "project-7"])
    }
  }
  ambient = {}
  assert.equal(keys.size, 6)
})
