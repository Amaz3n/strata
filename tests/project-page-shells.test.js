const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const React = require("react")
const ts = require("typescript")

const projectPages = [
  "bids", "change-orders", "closeout", "closing", "decisions", "expenses", "daily-logs", "meetings", "transmittals", "photos", "safety", "inspections",
  "financials/billing", "financials/budget", "financials/cost-inbox", "financials/payables",
  "financials/inventory", "financials/payables/waivers", "selections", "bids/[packageId]", "reports", "reports/[slug]", "reports/forecast-history",
  "financials/tm-tickets", "punch", "rfis", "schedule", "signatures", "specs", "submittals", "time", "time/certified-payroll", "warranty",
].map(section => `app/(app)/projects/[id]/${section}/page.tsx`)
const pages = [...projectPages, ...["files", "plans"].map(section => `app/(app)/pipeline/[dealId]/${section}/page.tsx`)]

function loadPage(file, exportName = "default") {
  const loaded = {}
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  // Exercise the page entry and URL adapter without database work. React stays
  // real; leaf components and data services are not rendered by this contract.
  const leaf = () => null
  const dependencies = new Proxy({ __esModule: true, default: leaf }, {
    get: (target, key) => key in target ? target[key] : key === "getProjectAction"
      ? async id => ({ id, name: "Fixture project" }) : leaf,
  })
  new Function("exports", "require", code)(loaded, id =>
    id === "react" || id === "react/jsx-runtime" ? require(id) : dependencies,
  )
  return loaded[exportName]
}

test("shared Drawings and Books renderers return shells before data work starts", () => {
  for (const [file, exportName, props] of [
    ["components/drawings/project-drawings-page.tsx", "default", { params: new Promise(() => {}), searchParams: new Promise(() => {}) }],
    ["app/(app)/books/_components/books-section-page.tsx", "BooksSectionPage", { section: "banking" }],
  ]) {
    const tree = loadPage(file, exportName)(props)
    assert.ok(React.isValidElement(tree))
    assert.equal(tree.type, React.Suspense)
    assert.ok(React.isValidElement(tree.props.fallback))
  }
})

function visitElements(node, inspect, insideBoundary = false) {
  if (!React.isValidElement(node)) return
  const boundary = insideBoundary || node.type === React.Suspense
  inspect(node, boundary)
  React.Children.forEach(node.props.children, child => visitElements(child, inspect, boundary))
}

for (const file of pages) {
  test(`${file} returns a useful shell before URL promises resolve`, () => {
    const tree = loadPage(file)({ params: new Promise(() => {}), searchParams: new Promise(() => {}) })
    assert.ok(React.isValidElement(tree), "the page must return UI synchronously")
    let boundaries = 0
    visitElements(tree, (node, insideBoundary) => {
      if (node.type === React.Suspense) {
        boundaries++
        assert.ok(React.isValidElement(node.props.fallback), "the boundary must render a useful fallback")
      }
      if (typeof node.type === "function" && node.type.constructor.name === "AsyncFunction") {
        assert.ok(insideBoundary, "URL/data reads must be contained by Suspense")
      }
    })
    assert.ok(boundaries > 0)
  })
}

async function resolveRoute(section, query) {
  const page = loadPage(`app/(app)/projects/[id]/${section}/page.tsx`)
  const tree = page({ params: Promise.resolve({ id: "project-fixture" }), searchParams: Promise.resolve(query) })
  let route
  visitElements(tree, node => {
    if (typeof node.type === "function" && node.type.constructor.name === "AsyncFunction") route = node
  })
  assert.ok(route)
  return route.type(route.props)
}

test("deferring URL reads preserves prefilled bid and change-order drafts", async () => {
  const bid = await resolveRoute("bids", { title: ["Draft bid", "ignored"], scope: "Roof", amount_cents: "12345", cost_code_id: "cost" })
  assert.deepEqual(bid.props.initialDraft, {
    title: "Draft bid", scope: "Roof", cost_code_id: "cost", budget_line_id: null, amount_cents: 12345,
  })
  const change = await resolveRoute("change-orders", { new: "1", title: "Change", description: "Revised scope" })
  assert.deepEqual(change.props.initialDraft, { title: "Change", notes: "Revised scope" })
  const closed = await resolveRoute("change-orders", { title: "No composer" })
  assert.equal(closed.props.initialDraft, null)
})

test("deferring URL reads preserves the selected record and billing period", async () => {
  for (const [section, query, property, value] of [
    ["rfis", { rfi: "rfi-1" }, "initialRfiId", "rfi-1"],
    ["punch", { item: "item-1" }, "initialItemId", "item-1"],
    ["financials/billing", { period: "period-1" }, "periodId", "period-1"],
  ]) {
    const result = await resolveRoute(section, query)
    assert.equal(result.props.id, "project-fixture")
    assert.equal(result.props[property], value)
  }
  const submittal = await resolveRoute("submittals", { submittal: "submittal-1" })
  assert.equal(submittal.props.children.props.initialSubmittalId, "submittal-1")
})
