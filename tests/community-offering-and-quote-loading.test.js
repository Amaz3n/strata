const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")

function load(file, dependencies) {
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", source)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : (name === "next/server" ? { connection: async () => {} } : dependencies[name]) ?? leaf)
  return exports.default
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test("quote packages render a shell before route params resolve and reject missing or unrelated records before detail reads", async () => {
  for (const [project, bidPackage, allowed] of [
    [null, { id: "package", project_id: "project" }, false],
    [{ id: "project" }, null, false],
    [{ id: "project" }, { id: "package", project_id: "other" }, false],
    [{ id: "project", prospect_id: "deal" }, { id: "package", project_id: "other", prospect_id: "deal" }, false],
    [{ id: "project" }, { id: "package", project_id: "project" }, true],
    [{ id: "project", prospect_id: "deal" }, { id: "package", project_id: null, prospect_id: "deal" }, true],
  ]) {
    const reads = [], params = deferred()
    const page = load("app/(app)/pipeline/[dealId]/quotes/[packageId]/page.tsx", {
      "next/navigation": { notFound: () => { throw new Error("Not found") } },
      "@/lib/services/prospects": { getProspect: async id => { reads.push(["prospect", id]); return { name: "Fixture", project_id: "project" } } },
      "@/app/(app)/projects/[id]/actions": { getProjectAction: async () => project, getOrgCompaniesAction: async () => [] },
      "@/app/(app)/bids/actions": new Proxy({ getBidPackageAction: async () => bidPackage }, { get: (object, name) => object[name] ?? (async id => { reads.push([name, id]); return [] }) }),
    })
    const shell = page({ params: params.promise })
    assert.equal(shell.type, React.Suspense)
    assert.equal(shell.props.fallback.props.title, "Quote package")
    const result = shell.props.children.type(shell.props.children.props)
    assert.deepEqual(reads, [])
    params.resolve({ dealId: "deal", packageId: "package" })
    if (!allowed) {
      await assert.rejects(result, /Not found/)
      assert.deepEqual(reads, [["prospect", "deal"]])
    } else {
      const workbench = (await result).props.children[1]
      assert.equal(workbench.props.context.projectId, "project")
      assert.equal(workbench.props.bidPackage.id, "package")
      assert.equal(reads.length, 9)
    }
  }
})

function offeringFixture({ failModels = false } = {}) {
  const sheet = deferred(), permissions = deferred(), reads = []
  const page = load("app/(app)/communities/[id]/offering/page.tsx", {
    "@/lib/services/community-sales": {
      getCommunityPriceSheet: () => sheet.promise,
      listSpecInventory: async () => [], getCommunityOfferingCosts: async () => null, listOfferablePlans: async () => [],
    },
    "@/lib/services/permissions": { getCurrentUserPermissions: () => permissions.promise },
    "@/lib/services/community-traffic": { listCommunityTraffic: async () => [] },
    "@/lib/services/community-portfolio": { getCommunityLane: async () => null },
    "@/lib/services/floorplan-models": { listPlansWithPublishedModels: async ids => {
      reads.push(ids)
      if (failModels) throw new Error("Models unavailable")
      return new Set(["plan-one"])
    } },
    "@/lib/sales/offering": { isIncentiveLive: () => true, offeringPrice: cents => ({ netCents: cents, giveCents: 0, designCreditCents: 0 }) },
  })
  return { sheet, permissions, reads, result: page({ params: Promise.resolve({ id: "community" }) }) }
}

test("offering models load as soon as prices arrive while permissions remain pending, with distinct plan IDs", async () => {
  for (const failModels of [false, true]) {
    const f = offeringFixture({ failModels })
    f.sheet.resolve({ rows: [{ planId: "plan-one", basePriceCents: 100 }, { planId: "plan-one", basePriceCents: 200 }], incentives: [], asOfDate: "2026-10-03" })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.reads, [["plan-one"]])
    f.permissions.resolve({ permissions: ["sales.manage"] })
    const priceSheet = (await f.result).props.children[0].props.children[1]
    assert.equal(priceSheet.props.canManage, true)
    assert.deepEqual([...priceSheet.props.plansWith3d], failModels ? [] : ["plan-one"])
  }
})

test("failed price-sheet reads never query model metadata and retain the original failure", async () => {
  const f = offeringFixture()
  const rejection = assert.rejects(f.result, /Prices unavailable/)
  f.sheet.reject(new Error("Prices unavailable"))
  f.permissions.resolve({ permissions: [] })
  await rejection
  assert.deepEqual(f.reads, [])
})
