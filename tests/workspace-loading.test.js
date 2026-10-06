const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")

function load(file, modules = {}) {
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaf)
  return exports
}
const { terminology } = load("lib/terminology.ts")
for (const [productTier, kind, home, projects] of [
  ["residential", "builder", "Control Tower", "Projects"],
  ["commercial", "builder", "Control Tower", "Projects"],
  ["production", "builder", "Home", "Homes"],
  ["residential", "trade", "Today", "Jobs"],
  ["commercial", "trade", "Today", "Jobs"],
  ["production", "trade", "Today", "Jobs"],
]) {
  test(`${productTier} ${kind} destinations identify the workspace from existing shell context`, () => {
    const { WorkspaceLoading } = load("components/layout/workspace-loading.tsx", {
      "./page-title-context": { usePageTitle: () => ({ productTier, businessProfile: { kind } }) },
      "@/lib/terminology": { terminology },
    })
    assert.equal(WorkspaceLoading({ destination: "home" }).props.title, home)
    assert.equal(WorkspaceLoading({ destination: "home" }).props.fullBleed, kind !== "trade")
    assert.equal(WorkspaceLoading({ destination: "projects" }).props.title, projects)
    assert.equal(WorkspaceLoading({ destination: "projects" }).props.fullBleed, false)
  })
}

function elements(tree) {
  return React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)] : []
}
for (const kind of ["builder", "trade"]) {
  test(`${kind} directory reuses the parent's resolved organization and business profile`, async () => {
    const context = { orgId: "org", productTier: "residential" }, profile = { kind }, calls = []
    const page = load("app/(app)/projects/page.tsx", {
      "next/server": { connection: async () => {} },
      "@/lib/services/context": { requireOrgContext: async () => { calls.push("context"); return context } },
      "@/lib/services/business-profile": { getBusinessProfile: async () => { calls.push("profile"); return profile } },
      "@/lib/projects/directory": { projectDirectoryQuerySchema: { parse: raw => raw } },
      "@/lib/services/project-directory": { loadProjectDirectory: async (query, scope) => { assert.equal(scope, context); calls.push(["directory", query]); return { page: [], divisionId: "division", communityId: "community", communities: [], canReadSchedule: true } } },
      "@/lib/services/trade-workspace": { getTradeJobCustomers: async () => { calls.push("customers"); return { contacts: [], contactsTotal: 0, canManage: false } } },
      "@/lib/terminology": { terminology },
    }).default
    const shell = page({ searchParams: Promise.resolve({ q: "test" }) })
    assert.equal(shell.props.fallback.props.destination, "projects")
    const content = await shell.props.children.type(shell.props.children.props)
    const boundary = elements(content).find(node => node.type === React.Suspense)
    const data = await boundary.props.children.type(boundary.props.children.props)
    assert.deepEqual(calls, kind === "trade" ? ["context", "profile", ["directory", { q: "test" }], "customers"] : ["context", "profile", ["directory", { q: "test" }]])
    assert.equal(data.props.businessProfile, profile)
    assert.equal(data.props.productTier, context.productTier)
    assert.equal(data.key, "org:division:community")
    assert.equal(data.props.canReadSchedule, true)
  })
}
