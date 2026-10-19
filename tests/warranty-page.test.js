const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")

const { stubModule, freshRequire } = require("./support/modules")

// The desk page is a dispatcher over warranty services and client UI; both are
// stand-ins here, so what is under test is which list it reads, under which
// scope, and how it pages.
const marker = (name) => Object.assign(() => null, { displayName: name })
const WarrantyDeskClient = marker("WarrantyDeskClient")

/** `connection()` resolves when the request is live, not during a prefetch. */
let live = Promise.resolve()
stubModule("next/server", { connection: () => live })
stubModule("@/components/layout/page-layout", { PageLayout: marker("PageLayout") })
stubModule("@/components/ui/skeleton", { Skeleton: marker("Skeleton") })
stubModule("app/(app)/warranty/warranty-desk-client.tsx", { WarrantyDeskClient })

let ambient = {}
const answers = {}
const loaded = []
const service = (name) => async (input) => {
  loaded.push(name)
  if (!answers[name]) throw new Error(`Unrelated tab loaded: ${name}`)
  return answers[name](input)
}
const stubServices = (module, names) => stubModule(module, Object.fromEntries(names.map((name) => [name, service(name)])))

stubServices("@/lib/services/desk-context", ["getAmbientDeskContext"])
stubServices("@/lib/services/books/ui-access", ["getBooksUiAccess"])
stubServices("@/lib/services/companies", ["listCompanies"])
stubServices("@/lib/services/warranty", [
  "isWarrantyAnalyticsAvailable",
  "getWarrantyCostSummary",
  "getWarrantyDeskTimeZone",
  "getWarrantyDefectAnalysis",
  "listWarrantyBackcharges",
  "listWarrantyRequestsForOrg",
  "listWarrantyTechnicians",
  "listWarrantyVisitsForDispatch",
  "listWarrantyVisitsPendingVerification",
])

const { QueuePagination } = require("@/components/layout/queue-pagination")
const { default: WarrantyDeskPage } = freshRequire("app/(app)/warranty/page.tsx")

/** Render the desk's streamed content (the child of its Suspense boundary). */
function renderDesk(searchParams) {
  const page = WarrantyDeskPage({ searchParams: Promise.resolve(searchParams) })
  const content = page.props.children.props.children
  return content.type(content.props)
}

const childOfType = (element, type) => [element.props.children].flat(Infinity).find((child) => child?.type === type)
const linkParams = (element) =>
  new URL(childOfType(element, QueuePagination).props.href, "https://arc.invalid").searchParams

/** Answer one service, remembering what it was asked. */
function answer(name, reply) {
  const calls = []
  answers[name] = async (input) => {
    calls.push(input)
    return reply
  }
  return calls
}

beforeEach(() => {
  live = Promise.resolve()
  loaded.length = 0
  for (const name of Object.keys(answers)) delete answers[name]
  ambient = { divisionId: "division", communityId: "community" }
  answers.getAmbientDeskContext = async () => ambient
})

test("each list tab reads only its own list, under the ambient division and community", async () => {
  for (const [tab, list] of [
    ["dispatch", "listWarrantyVisitsForDispatch"],
    ["verify", "listWarrantyVisitsPendingVerification"],
    ["backcharges", "listWarrantyBackcharges"],
  ]) {
    loaded.length = 0
    const calls = answer(list, { rows: [], total: 1201 })
    answer("getWarrantyDeskTimeZone", "America/New_York")

    const desk = await renderDesk({ tab, page: "2", week: "2026-10-04" })

    // Only the dispatch week is drawn in a zone, so only it asks for the org's.
    assert.deepEqual(loaded, tab === "dispatch" ? ["getAmbientDeskContext", "getWarrantyDeskTimeZone", list] : ["getAmbientDeskContext", list], tab)
    assert.deepEqual(
      { divisionId: calls[0].divisionId, communityId: calls[0].communityId, page: calls[0].page },
      { divisionId: "division", communityId: "community", page: 2 },
      tab,
    )
    assert.equal(childOfType(desk, WarrantyDeskClient).props.initialTab, tab)
    const pagination = childOfType(desk, QueuePagination)
    assert.deepEqual([pagination.props.total, pagination.props.page], [1201, 2], tab)
    delete answers[list]
  }
})

test("a change of ambient community remounts the desk instead of keeping stale rows", async () => {
  answer("listWarrantyBackcharges", { rows: [{ id: "charge" }], total: 1 })
  const before = childOfType(await renderDesk({ tab: "backcharges" }), WarrantyDeskClient)
  ambient = { divisionId: "division", communityId: "other-community" }
  const after = childOfType(await renderDesk({ tab: "backcharges" }), WarrantyDeskClient)
  assert.notEqual(before.key, after.key)
})

test("dispatch reads the requested week in the org's time zone and keeps the week and filters in page links", async () => {
  const calls = answer("listWarrantyVisitsForDispatch", { rows: [{ id: "visit" }], total: 251 })
  answer("getWarrantyDeskTimeZone", "America/New_York")

  const desk = await renderDesk({ tab: "dispatch", page: "2", week: "2026-10-04", division: "division" })

  assert.deepEqual({ from: calls[0].from, to: calls[0].to }, {
    from: "2026-10-04T04:00:00.000Z",
    to: "2026-10-11T04:00:00.000Z",
  })
  assert.deepEqual(childOfType(desk, WarrantyDeskClient).props.visits, [{ id: "visit" }])
  assert.equal(childOfType(desk, QueuePagination).props.total, 251)
  const params = linkParams(desk)
  assert.equal(params.get("week"), "2026-10-04")
  assert.equal(params.get("division"), "division")
  assert.equal(params.has("page"), false)
})

test("the request queue searches with normalized text and the SLA filter across the selected page", async () => {
  const calls = answer("listWarrantyRequestsForOrg", { rows: [{ id: "match" }], total: 1201 })
  answer("listWarrantyTechnicians", [])
  answer("listCompanies", [])

  const desk = await renderDesk({ tab: "queue", page: "3", search: "  Home  12  ", sla: "first_response_breached" })

  assert.deepEqual(
    { search: calls[0].search, slaState: calls[0].slaState, page: calls[0].page },
    { search: "Home 12", slaState: "first_response_breached", page: 3 },
  )
  const client = childOfType(desk, WarrantyDeskClient)
  assert.deepEqual([client.props.initialSearch, client.props.initialSla], ["Home 12", "first_response_breached"])
  assert.equal(childOfType(desk, QueuePagination).props.total, 1201)
  const params = linkParams(desk)
  assert.equal(params.get("sla"), "first_response_breached")
  assert.ok(params.has("search"))
})

test("a prefetch starts no authorization or desk reads before the request is live", async () => {
  let goLive
  live = new Promise((resolve) => {
    goLive = resolve
  })
  answer("listWarrantyVisitsForDispatch", { rows: [], total: 0 })
  answer("getWarrantyDeskTimeZone", "America/New_York")

  const rendering = renderDesk({ tab: "dispatch" })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(loaded, [])

  goLive()
  await rendering
  assert.deepEqual(loaded, ["getAmbientDeskContext", "getWarrantyDeskTimeZone", "listWarrantyVisitsForDispatch"])
})

test("unavailable scoped analytics shows no totals rather than broad org-wide reports", async () => {
  answer("isWarrantyAnalyticsAvailable", false)
  answer("getBooksUiAccess", { adjust: false })

  const desk = await renderDesk({ tab: "analytics" })

  assert.ok(!loaded.includes("getWarrantyCostSummary"))
  assert.ok(!loaded.includes("getWarrantyDefectAnalysis"))
  const client = childOfType(desk, WarrantyDeskClient)
  assert.equal(client.props.analyticsAvailable, false)
  assert.deepEqual([client.props.costs, client.props.defects], [[], []])
})
