const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const React = require("react")
const ts = require("typescript")

function load(file, modules) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const leaves = new Proxy({ __esModule: true }, { get: (target, key) => key in target ? target[key] : () => null })
  new Function("exports", "require", code)(exports, name =>
    name === "react" || name === "react/jsx-runtime" ? require(name) : modules[name] ?? leaves,
  )
  return exports
}

function elements(tree) {
  if (!React.isValidElement(tree)) return []
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)]
}

test("template categories reset their library boundary above the preserved page segment", () => {
  const sections = load("app/(app)/settings/templates/sections.ts", {})
  const segment = React.createElement("div", null, "Live library")
  for (const query of ["estimates", "budgets", "schedules", "checklists", "waivers", "invalid"]) {
    const selected = query === "invalid" ? "waivers" : query
    const { TemplatesNavigation } = load("app/(app)/settings/templates/templates-navigation.tsx", {
      "next/navigation": { useSearchParams: () => new URLSearchParams({ section: query }) },
      "./sections": sections,
    })
    const shell = TemplatesNavigation({ children: segment })
    const boundary = shell.props.children[1].props.children[1].props.children[1]
    assert.equal(boundary.type, React.Suspense)
    assert.equal(boundary.key, selected)
    assert.equal(boundary.props.children, segment)
    const selectedLink = elements(shell).find(node => node.props["aria-current"] === "page")
    assert.equal(selectedLink.props.href, `/settings/templates?section=${selected}`)
  }
})

test("templates layout keeps the destination title and category navigation outside the live page segment", () => {
  const navigation = () => null
  const layout = load("app/(app)/settings/templates/layout.tsx", {
    "./templates-navigation": { TemplatesNavigation: navigation, TemplateLibraryLoading: () => null },
  }).default
  const segment = React.createElement("div", null, "Live library")
  const shell = layout({ children: segment }), boundary = shell.props.children
  assert.equal(shell.props.title, "Templates")
  assert.equal(boundary.type, React.Suspense)
  assert.equal(boundary.props.children.type, navigation)
  assert.equal(boundary.props.children.props.children, segment)
})

test("cost coding resets the roster boundary above the preserved page segment while keeping navigation visible", () => {
  const sections = load("app/(app)/settings/cost-coding/sections.ts", {})
  const segment = React.createElement("div", null, "Live roster")
  for (const [query, selected] of [["codes", "codes"], ["markup", "markup"], ["rates", "rates"], ["invalid", "codes"]]) {
    const { CostCodingNavigation } = load("app/(app)/settings/cost-coding/cost-coding-navigation.tsx", {
      "next/navigation": { useSearchParams: () => new URLSearchParams({ section: query }) },
      "./sections": sections,
    })
    const shell = CostCodingNavigation({ children: segment })
    const nodes = elements(shell), boundary = shell.props.children[1].props.children
    assert.equal(boundary.key, selected)
    assert.equal(boundary.props.children, segment)
    assert.ok(nodes.some(node => node.type === "nav" && node.props["aria-label"] === "Cost coding sections"))
    assert.equal(nodes.filter(node => node.props["aria-current"] === "page")[0].props.href, `/settings/cost-coding?section=${selected}`)
  }
})

test("cost coding layout places query navigation around its child page segment", () => {
  const navigation = () => null
  const layout = load("app/(app)/settings/cost-coding/layout.tsx", {
    "./cost-coding-navigation": { CostCodingNavigation: navigation, CostCodingRosterSkeleton: () => null },
  }).default
  const segment = React.createElement("div", null, "Live roster")
  const shell = layout({ children: segment })
  assert.equal(shell.props.title, "Cost coding")
  const boundary = shell.props.children
  assert.equal(boundary.type, React.Suspense)
  assert.equal(boundary.props.children.type, navigation)
  assert.equal(boundary.props.children.props.children, segment)
})

test("standalone settings destinations retain the app header while the panel workspace owns its own header", () => {
  for (const [path, title] of [["/settings", "Settings"], ["/settings/templates", "Templates"], ["/settings/imports", "Data imports"], ["/settings/cost-coding", "Cost coding"]]) {
    const { AppHeader } = load("components/layout/app-header.tsx", {
      "next/navigation": { usePathname: () => path },
      "./page-title-context": { usePageTitle: () => ({ title, projectContext: null }) },
    })
    const header = AppHeader({})
    if (path === "/settings") assert.equal(header, null)
    else {
      assert.equal(header.type, "header")
      assert.ok(elements(header).some(node => node.type === "h1" && node.props.children === title))
    }
  }
})

test("warranty query navigation resets the boundary above the preserved page segment", () => {
  const navigation = () => null
  const layout = load("app/(app)/warranty/layout.tsx", {
    "./warranty-desk-navigation": { WarrantyDeskNavigation: navigation },
  }).default
  const pageSegment = React.createElement("div", null, "Live warranty page")
  const shell = layout({ children: pageSegment })
  assert.equal(shell.type, React.Suspense)
  assert.ok(React.isValidElement(shell.props.fallback))
  assert.equal(shell.props.children.type, navigation)
  assert.equal(shell.props.children.props.children, pageSegment, "the query boundary surrounds the page segment rather than living inside it")
})

test("community identity and child shell render while the runway read is paused", async () => {
  let release
  const connection = new Promise(resolve => { release = resolve })
  let laneReads = 0
  const page = load("app/(app)/communities/[id]/layout.tsx", {
    "next/server": { connection: () => connection },
    "@/lib/services/communities": { getCommunityIdentity: async id => ({ id, name: "Fixture community", status: "active", plannedLotCount: 50 }) },
    "@/lib/services/community-portfolio": { getCommunityLane: async () => { laneReads++; return null } },
  }).default
  const child = React.createElement("p", null, "Inventory shell")
  const shell = page({ params: Promise.resolve({ id: "community" }), children: child })
  assert.equal(shell.type, React.Suspense)
  assert.ok(React.isValidElement(shell.props.fallback))
  const content = await shell.props.children.type(shell.props.children.props)
  assert.equal(content.props.title, "Fixture community")
  assert.ok(elements(content).some(node => node.type === child.type && node.props.children === "Inventory shell"), "the selected child is not gated by the header metrics")
  const metrics = elements(content).find(node => node.type === React.Suspense).props.children
  const live = metrics.type(metrics.props)
  await Promise.resolve()
  assert.equal(laneReads, 0, "live queries wait for request time")
  release()
  await live
  assert.equal(laneReads, 1)
})

test("community identity failures retain their error state instead of becoming a 404", async () => {
  const failure = new Error("Database unavailable")
  const page = load("app/(app)/communities/[id]/layout.tsx", {
    "@/lib/services/communities": { getCommunityIdentity: async () => { throw failure } },
  }).default
  const shell = page({ params: Promise.resolve({ id: "community" }), children: null })
  await assert.rejects(shell.props.children.type(shell.props.children.props), error => error === failure)
})

function identityFixture({ scope = { assignedOnly: false, divisionIds: [] }, denied = false, row = { id: "community", name: "Fixture community", status: "active", planned_lot_count: 50 } } = {}) {
  const calls = []
  const query = {}
  for (const method of ["select", "eq", "is", "in"]) {
    query[method] = (...args) => { calls.push([method, ...args]); return query }
  }
  query.maybeSingle = async () => ({ data: row, error: null })
  const supabase = { from: table => { calls.push(["from", table]); return query } }
  const { resolveDivisionScope } = load("lib/land/scope.ts", {})
  const communityModule = load("lib/services/communities.ts", {
    "@/lib/services/context": { requireOrgContext: async () => ({ orgId: "org", userId: "user", supabase }) },
    "@/lib/services/permissions": { requirePermission: async permission => { calls.push(["permission", permission]); if (denied) throw new Error("Forbidden") } },
    "@/lib/services/authorization": { getDivisionAccessForUser: async () => scope },
    "@/lib/land/scope": { resolveDivisionScope },
  })
  return { read: communityModule.getCommunityIdentity, calls }
}

test("community navigation reads only identity and applies org, archive and division scope", async () => {
  const { read, calls } = identityFixture({ scope: { assignedOnly: true, divisionIds: ["division"] } })
  assert.deepEqual(await read("community"), { id: "community", name: "Fixture community", status: "active", plannedLotCount: 50 })
  assert.deepEqual(calls.filter(call => call[0] === "from"), [["from", "communities"]])
  for (const expected of [
    ["permission", "community.read"],
    ["select", "id, name, status, planned_lot_count"],
    ["eq", "org_id", "org"],
    ["eq", "id", "community"],
    ["is", "archived_at", null],
    ["in", "division_id", ["division"]],
  ]) assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(expected)))
})

test("community navigation does not query when permission or division access is absent", async () => {
  for (const config of [{ denied: true }, { scope: { assignedOnly: true, divisionIds: [] } }]) {
    const { read, calls } = identityFixture(config)
    await assert.rejects(read("community"), /Forbidden|Community not found/)
    assert.equal(calls.some(call => call[0] === "from"), false)
  }
})

test("a missing scoped community identity is not found", async () => {
  await assert.rejects(identityFixture({ row: null }).read("community"), /Community not found/)
})

test("Books child shells do not wait for the live workspace redirect check", async () => {
  const child = React.createElement("p", null, "Child shell")
  let release
  const live = new Promise(resolve => { release = resolve })
  let reads = 0
  const layout = load("app/(app)/books/layout.tsx", {
    "next/server": { connection: () => live },
    "@/lib/services/books/module": { isBooksWorkspaceEnabled: async () => { reads++; return true } },
  }).default
  const shell = layout({ children: child })
  assert.equal(shell.type, React.Fragment)
  assert.equal(shell.props.children[1], child)
  const boundary = shell.props.children[0]
  assert.equal(boundary.type, React.Suspense)
  assert.equal(boundary.props.fallback, null)
  const guard = boundary.props.children
  const check = guard.type(guard.props)
  await Promise.resolve()
  assert.equal(reads, 0, "prefetching must not read live workspace availability")
  release()
  assert.equal(await check, null)
  assert.equal(reads, 1)
})

test("Books live workspace guard redirects disabled organizations", async () => {
  const layout = load("app/(app)/books/layout.tsx", {
    "next/server": { connection: async () => {} },
    "@/lib/services/books/module": { isBooksWorkspaceEnabled: async () => false },
    "next/navigation": { redirect: href => { throw new Error(`Redirect: ${href}`) } },
  }).default
  const guard = layout({ children: null }).props.children[0].props.children
  await assert.rejects(guard.type(guard.props), error => error.message === "Redirect: /settings?tab=accounting&returnTo=%2Fbooks")
})

test("Accounting layout retains its availability check", async () => {
  const child = React.createElement("p", null, "Child shell")
  for (const [file, destination] of [
    ["app/(app)/settings/accounting/layout.tsx", "/settings?tab=accounting"],
  ]) {
    let enabled = true
    const layout = load(file, {
      "@/lib/services/books/navigation": { loadBooksNavigationAvailability: async () => enabled },
      "next/navigation": { redirect: href => { throw new Error(`Redirect: ${href}`) } },
    }).default
    const shell = layout({ children: child })
    assert.equal(shell.type, React.Suspense)
    const gate = shell.props.children
    assert.equal(await gate.type(gate.props), child)
    enabled = false
    await assert.rejects(gate.type(gate.props), error => error.message === `Redirect: ${destination}`)
  }
})

test("Chart of Accounts renders its Accounting title outside the live data boundary", () => {
  const page = load("app/(app)/settings/accounting/chart-of-accounts/page.tsx", {}).default
  const shell = page()
  assert.equal(shell.props.title, "Chart of accounts")
  assert.equal(shell.props.children.type, React.Suspense)
  assert.equal(shell.props.children.props.children.type.constructor.name, "AsyncFunction")
})
