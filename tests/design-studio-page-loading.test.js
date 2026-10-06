const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(route, groupPage = { groups: [], nextCursor: null }) {
  const ambient = deferred(), context = deferred(), permission = deferred(), catalog = deferred()
  const reads = []
  const dependencies = {
    "next/server": { connection: async () => {} },
    "@/lib/services/desk-context": { getAmbientDeskContext: () => { reads.push("ambient"); return ambient.promise } },
    "@/lib/services/context": { requireOrgContext: () => { reads.push("context"); return context.promise } },
    "@/lib/services/permissions": { hasPermission: (name, ctx) => { reads.push(["permission", name, ctx]); return permission.promise } },
    "@/lib/services/option-catalog": {
      listCatalog: scope => { reads.push(["catalog", scope]); return catalog.promise },
      listSelectionGroupPage: async scope => { reads.push(["groups", scope]); return groupPage },
      listPlanPricingMatrix: async scope => { reads.push(["matrix", scope]); return { plans: [], cells: {}, optionIds: scope.optionIds.slice((scope.optionPage - 1) * 20, scope.optionPage * 20), planPage: scope.planPage, optionPage: scope.optionPage, includeOlderVersions: scope.includeOlderVersions, hasMoreOptions: scope.optionIds.length > scope.optionPage * 20, hasMorePlans: false, atomicPricing: false } },
    },
    "@/lib/services/design-studio": {
      getStudioRunway: async scope => { reads.push(["runway", scope]); return [] },
      listBookableHomes: async scope => { reads.push(["homes", scope]); return [] },
    },
  }
  const source = ts.transpileModule(fs.readFileSync(`app/(app)/design-studio/${route}`, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  new Function("exports", "require", source)(exports, name =>
    ["react", "react/jsx-runtime"].includes(name) ? require(name) : dependencies[name] ?? leaf,
  )
  function shell(searchParams) { return exports.default({ searchParams }) }
  return { ambient, context, permission, catalog, reads, shell }
}

const routes = [["page.tsx", "Design Studio"], ["catalog/page.tsx", "Option catalog"], ["rules/page.tsx", "Cutoff rules"]]
function workbenchProps(result) {
  const workbench = React.Children.toArray(result.props.children).find(child => React.isValidElement(child) && "communityId" in child.props)
  assert.ok(workbench, "Missing Design Studio workbench")
  return workbench.props
}
for (const [route, title] of routes) {
  test(`${title} starts desk and org reads while URL parameters are pending`, async () => {
    const f = fixture(route), query = deferred()
    const shell = f.shell(query.promise)
    assert.equal(shell.type, React.Suspense)
    assert.equal(shell.props.fallback.props.title, title)
    assert.equal(shell.props.fallback.props.fullBleed, true)
    const resultPromise = shell.props.children.type(shell.props.children.props)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.reads, ["ambient", "context"])
    query.resolve({ community: "explicit" })
    f.ambient.resolve({ communityId: "ambient", divisionId: "division" })
    f.context.resolve({ orgId: "org", userId: "user" })
    f.permission.resolve(false)
    f.catalog.resolve({ categories: [{ options: [{ id: "option" }] }] })
    const result = await resultPromise
    assert.equal(workbenchProps(result).communityId, "explicit")
    assert.equal(workbenchProps(result).canManage, false)
    for (const read of f.reads.filter(read => Array.isArray(read) && read[0] !== "permission")) {
      assert.equal(read[1].communityId, "explicit")
    }
    if (route === "page.tsx") {
      assert.equal(f.reads.find(read => read[0] === "runway")[1].divisionId, "division")
    }
  })
}

test("catalog pricing begins as soon as catalog IDs resolve, with manage permission still pending", async () => {
  const f = fixture("catalog/page.tsx")
  const shell = f.shell(Promise.resolve({}))
  const resultPromise = shell.props.children.type(shell.props.children.props)
  f.ambient.resolve({ communityId: "ambient" })
  f.context.resolve({ orgId: "org" })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  f.catalog.resolve({ categories: [{ options: [{ id: "first" }, { id: "second" }] }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.reads.find(read => read[0] === "matrix"), ["matrix", { communityId: "ambient", optionIds: ["first", "second"], planPage: 1, optionPage: 1, includeOlderVersions: false }])
  f.permission.resolve(true)
  const result = await resultPromise
  assert.deepEqual(workbenchProps(result).matrix, { plans: [], cells: {}, optionIds: ["first", "second"], planPage: 1, optionPage: 1, includeOlderVersions: false, hasMoreOptions: false, hasMorePlans: false, atomicPricing: false })
  assert.equal(workbenchProps(result).canManage, true)
})

test("catalog query scopes a pricing window without dropping total category counts", async () => {
  const f = fixture("catalog/page.tsx"), options = Array.from({ length: 30 }, (_, index) => ({ id: `option-${index + 1}` }))
  const shell = f.shell(Promise.resolve({ category: "selected", planPage: "3", optionPage: "2", releases: "all", view: "pricing" }))
  const pending = shell.props.children.type(shell.props.children.props)
  f.ambient.resolve({ communityId: "ambient" })
  f.context.resolve({ orgId: "org", userId: "actor" })
  f.permission.resolve(false)
  f.catalog.resolve({ packages: [{ id: "not-in-window" }], categories: [{ id: "other", options: [{ id: "unselected" }] }, { id: "selected", options }] })
  const result = await pending, props = workbenchProps(result)
  assert.deepEqual(f.reads.find(read => read[0] === "matrix"), ["matrix", { communityId: "ambient", optionIds: options.map(option => option.id), planPage: 3, optionPage: 2, includeOlderVersions: true }])
  assert.deepEqual(props.catalog.categories.map(category => category.options), [[], options.slice(20)])
  assert.deepEqual(props.categoryOptionCounts, { other: 1, selected: 30 })
  assert.deepEqual(props.catalog.packages, [])
  assert.equal(props.initialCategoryId, "selected")
  assert.equal(props.initialView, "pricing")
  assert.equal(props.canManage, false)
})

test('cutoff rules omits bootstrap options only when remote member discovery cutover is enabled literally',async()=>{
 const previous=process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED
 try {
  for(const flag of ['true','false','TRUE',undefined]){
   if(flag===undefined)delete process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED;else process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED=flag
   const f=fixture('rules/page.tsx'),shell=f.shell(Promise.resolve({})),pending=shell.props.children.type(shell.props.children.props)
   f.ambient.resolve({communityId:'ambient'});f.context.resolve({orgId:'org',userId:'actor'});f.permission.resolve(true);f.catalog.resolve({categories:[],packages:[]})
   const result=await pending,props=workbenchProps(result);assert.equal(props.atomicPublication,flag==='true');assert.equal(f.reads.find(read=>Array.isArray(read)&&read[0]==='catalog')[1].includeOptions,flag!=='true')
  }
 } finally {if(previous===undefined)delete process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED;else process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED=previous}
})


test('cutoff rules forwards the continuation and bounded page into the workbench',async()=>{
 const group={id:'rule',name:'Frame'},f=fixture('rules/page.tsx',{groups:[group],nextCursor:'next'}),shell=f.shell(Promise.resolve({community:'explicit',groupsAfter:'previous'})),pending=shell.props.children.type(shell.props.children.props)
 f.ambient.resolve({communityId:'ambient'});f.context.resolve({orgId:'org',userId:'actor'});f.permission.resolve(true);f.catalog.resolve({categories:[],packages:[]})
 const props=workbenchProps(await pending);assert.deepEqual(props.groups,[group]);assert.equal(props.groupCursor,'previous');assert.equal(props.nextGroupCursor,'next');assert.deepEqual(f.reads.find(row=>Array.isArray(row)&&row[0]==='groups'),['groups',{communityId:'explicit',cursor:'previous'}])
})
