require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const test = require("node:test")

function resolver({ options = [], packages = [], prices = [], categories = null, rowCap = 1000 } = {}) {
  const tables = { selection_categories: categories ?? [...new Set(options.map((row) => row.category_id))].map((id) => ({ id, parent_category_id: null, community_id: null, is_archived: false })), selection_options: options, selection_packages: packages, selection_catalog_prices: prices.map((row,i) => ({ id: `price-${String(i).padStart(5, "0")}`, ...row })) }
  const supabase = { from(table) {
    let rows = tables[table]
    let pageLimit = 1000
    const query = { returns() { return query }, select() { return query }, eq(key, value) { if (key !== "org_id" && key !== "house_plan_version_id") rows = rows.filter((row) => row[key] === value); return query },
      order() { rows = [...rows].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); return query }, limit(value) { pageLimit = value; return query }, gt(key,value) { rows = rows.filter(row => row[key] > value); return query }, range(from, to) { rows = rows.slice(from, to + 1); return query }, in(key, values) { rows = rows.filter((row) => values.includes(row[key])); return query }, or() { return query },
      then(resolve, reject) { return Promise.resolve({ data: rows.slice(0, Math.min(pageLimit, rowCap)), error: null }).then(resolve, reject) },
    }; return query
  } }
  const compiled = { exports: {} }
  const source = fs.readFileSync(require.resolve("../lib/services/option-catalog.ts"), "utf8")
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: compiled.exports, require(id) {
    if (id === "zod") return require("zod")
    if (id === "@/lib/validation/selections") return require("../lib/validation/selections")
    if (id === "@/lib/land/paging") return require("../lib/land/paging")
    if (id === "@/lib/supabase/server") return { createServiceSupabaseClient: () => supabase }
    if (id === "@/lib/selections/catalog-math") return require("../lib/selections/catalog-math")
    return {}
  } })
  return compiled.exports.resolveOptionPricing
}
const option = { id: "option", category_id: "category", community_id: null, price_cents: 100, cost_cents: 60, is_available: true, is_archived: false }

test("archiving an option overrides a stale available plan price", async () => {
  const resolve = resolver({ options: [{ ...option, is_archived: true }], prices: [{ option_id: "option", community_id: null, price_cents: 200, cost_cents: 100, is_available: true }] })
  const [result] = await resolve({ orgId: "org", housePlanVersionId: "plan", items: [{ optionId: "option" }] })
  assert.equal(result.available, false)
})

test("community-only options cannot be selected from another community or without a community", async () => {
  const resolve = resolver({ options: [{ ...option, community_id: "oak" }] })
  for (const communityId of [undefined, "pine"]) {
    const [result] = await resolve({ orgId: "org", communityId, items: [{ optionId: "option" }] })
    assert.equal(result.available, false)
  }
  assert.equal((await resolve({ orgId: "org", communityId: "oak", items: [{ optionId: "option" }] }))[0].available, true)
})

test("archived or out-of-community packages cannot be restored by pricing records", async () => {
  for (const patch of [{ is_archived: true }, { community_id: "other" }]) {
    const resolve = resolver({ packages: [{ id: "package", price_cents: 100, is_available: true, ...patch }] })
    assert.equal((await resolve({ orgId: "org", communityId: "oak", items: [{ packageId: "package" }] }))[0].available, false)
  }
})

test("a community override keeps the selection category and resolves the correct option ID", async () => {
  const override = { ...option, id: "override", parent_option_id: "option", community_id: "oak", price_cents: 250 }
  const resolve = resolver({ options: [option, override] })
  const [result] = await resolve({ orgId: "org", communityId: "oak", items: [{ optionId: "option" }] })
  assert.equal(result.optionId, "override")
  assert.equal(result.categoryId, "category")
  assert.equal(result.priceCents, 250)
  const invalid = resolver({ options: [option, { ...override, category_id: "different" }] })
  await assert.rejects(invalid({ orgId: "org", communityId: "oak", items: [{ optionId: "option" }] }), /different selection category/)
})

function selectionMutation(pricing, lotFailure = false) {
  const writes = []
  const selection = { id: "selection", org_id: "org", project_id: "home", category_id: "category", selected_option_id: "option", group_id: null, locked_at: null }
  const tables = {
    project_selections: [selection], selection_options: [{ id: "option", option_scope: "finish" }],
    lots: [{ community_id: "oak", house_plan_version_id: "plan" }], projects: [{ property_type: "production" }], orgs: [{ product_tier: "production" }],
    selection_package_items: [{ option_id: "option", option: { category_id: "category" } }],
  }
  const supabase = { from(table) {
    const result = () => ({ data: tables[table] ?? [], error: lotFailure && table === "lots" ? { message: "lookup failed" } : null })
    const query = { select() { return query }, eq() { return query }, in() { return query },
      async maybeSingle() { const response = result(); return { ...response, data: response.data[0] } },
      update(payload) { writes.push({ table, payload }); return query },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject) },
    }; return query
  } }
  const compiled = { exports: {} }
  const source = fs.readFileSync(require.resolve("../lib/services/selections.ts"), "utf8")
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: compiled.exports, require(id) {
    if (id === "@/lib/land/paging") return require("../lib/land/paging")
    if (id === "@/lib/supabase/server") return { createServiceSupabaseClient: () => supabase }
    if (id === "@/lib/product-tier") return { getProjectPosture: () => "production", normalizeProductTier: (value) => value, isProductionProjectPosture: () => true }
    if (id === "@/lib/selections/selection-variance") return require("../lib/selections/selection-variance")
    if (id === "@/lib/services/option-catalog") return { resolveOptionPricing: async ({ items }) => items.map((item) => item.packageId ? { available: true, priceCents: 100, costCents: 50 } : pricing), allocatePackageTotal: require("../lib/selections/catalog-math").allocatePackageTotal }
    if (id === "@/lib/services/configuration-rules") return { assertProjectConfiguration: async () => {} }
    if (id === "@/lib/services/events") return { recordEvent: async () => {} }
    return {}
  } })
  return { service: compiled.exports, writes }
}

test("confirmation revalidates availability and category before writing status or snapshots", async () => {
  for (const pricing of [{ available: false, categoryId: "category", categoryIds: ["category"] }, { available: true, categoryId: "different", categoryIds: ["different"] }]) {
    const { service, writes } = selectionMutation(pricing)
    await assert.rejects(service.confirmSelection({ orgId: "org", projectId: "home", selectionId: "selection", portalAccess: true }), /available|category/)
    assert.equal(writes.length, 0)
  }
})

test("package member eligibility is checked before any package member is updated", async () => {
  const { service, writes } = selectionMutation({ available: false, categoryId: "category", categoryIds: ["category"] })
  await assert.rejects(service.selectProjectPackage({ orgId: "org", projectId: "home", packageId: "package", portalAccess: true }), /no longer available/)
  assert.equal(writes.length, 0)
})

test("failed home lookup cannot fall back to organization-wide package pricing", async () => {
  const { service, writes } = selectionMutation({ available: true, categoryId: "category", categoryIds: ["category"] }, true)
  await assert.rejects(service.selectProjectPackage({ orgId: "org", projectId: "home", packageId: "package", portalAccess: true }), /lookup failed/)
  assert.equal(writes.length, 0)
})


test("pricing a requested item does not truncate behind a large unrelated plan catalog", async () => {
  const prices = Array.from({ length: 1203 }, (_, index) => ({ option_id: `unrelated-${index}`, community_id: null, price_cents: 1, cost_cents: 1, is_available: true }))
  prices.push({ option_id: "option", community_id: null, price_cents: 900, cost_cents: 400, is_available: true })
  const resolve = resolver({ options: [option], prices })
  const [result] = await resolve({ orgId: "org", housePlanVersionId: "plan", items: [{ optionId: "option" }] })
  assert.equal(result.priceCents, 900)
})

test("the resolved community override's plan price takes priority over its parent price", async () => {
  const resolve = resolver({ options: [option, { ...option, id: "override", parent_option_id: "option", community_id: "oak" }], prices: [
    { option_id: "option", community_id: "oak", price_cents: 200, cost_cents: 100, is_available: true },
    { option_id: "override", community_id: "oak", price_cents: 350, cost_cents: 150, is_available: true },
  ] })
  const [result] = await resolve({ orgId: "org", communityId: "oak", housePlanVersionId: "plan", items: [{ optionId: "option" }] })
  assert.equal(result.priceCents, 350)
})


test("large requested catalogs are chunked without losing items after the first thousand", async () => {
  const options = Array.from({ length: 1203 }, (_, index) => ({ ...option, id: `option-${index}` }))
  const resolve = resolver({ options })
  const result = await resolve({ orgId: "org", items: options.map((item) => ({ optionId: item.id })) })
  assert.equal(result.length, 1203)
  assert.equal(result.at(-1).optionId, "option-1202")
})

test("ambiguous override and duplicate price configuration fail instead of picking arbitrary pricing", async () => {
  const override = { ...option, parent_option_id: "option", community_id: "oak" }
  await assert.rejects(resolver({ options: [option, { ...override, id: "one" }, { ...override, id: "two" }] })({ orgId: "org", communityId: "oak", items: [{ optionId: "option" }] }), /Multiple community overrides/)
  const price = { option_id: "option", community_id: null, price_cents: 100, cost_cents: 50, is_available: true }
  await assert.rejects(resolver({ options: [option], prices: [price, { ...price, price_cents: 999 }] })({ orgId: "org", housePlanVersionId: "plan", items: [{ optionId: "option" }] }), /Multiple prices/)
})


test("community category overrides remain compatible with the original home selection category", async () => {
  const resolve = resolver({ options: [option, { ...option, id: "override", parent_option_id: "option", category_id: "community-category", community_id: "oak" }], categories: [
    { id: "category", parent_category_id: null, community_id: null, is_archived: false },
    { id: "community-category", parent_category_id: "category", community_id: "oak", is_archived: false },
  ] })
  const [result] = await resolve({ orgId: "org", communityId: "oak", items: [{ optionId: "option" }] })
  assert.equal(result.available, true)
  assert.ok(result.categoryIds.includes("category"))
  assert.ok(result.categoryIds.includes("community-category"))
})

test("archived categories make their options unavailable", async () => {
  const resolve = resolver({ options: [option], categories: [{ id: "category", parent_category_id: null, community_id: null, is_archived: true }] })
  assert.equal((await resolve({ orgId: "org", items: [{ optionId: "option" }] }))[0].available, false)
})

test("short provider pages preserve every catalog item and plan-specific price", async () => {
  const options = Array.from({ length: 12 }, (_, i) => ({ ...option, id: `option-${String(i).padStart(3, "0")}` }))
  const prices = options.map((row, i) => ({ option_id: row.id, package_id: null, community_id: null, price_cents: 200 + i, cost_cents: 100, is_available: true }))
  const resolve = resolver({ options, prices, rowCap: 3 })
  const result = await resolve({ orgId: "org", housePlanVersionId: "plan", items: options.map(row => ({ optionId: row.id })) })
  assert.equal(result.length, 12)
  assert.equal(result.at(-1).available, true)
  assert.equal(result.at(-1).priceCents, 211)
})
