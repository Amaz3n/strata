require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
test("compatibility pricing selects and returns costs only with margin permission", async () => {
  for (const margin of [false, true]) {
    const calls = [], exports = {}, context = { orgId: id(1), userId: id(2), supabase: { from(table) {
      const query = { table, select(columns) { calls.push([table, columns]); return query } }
      for (const method of ["eq", "in", "order", "limit", "gt", "is", "or"]) query[method] = (...args) => { calls.push([method, ...args]); return query }
      return query
    } } }
    const modules = {
      zod: require("zod"),
      "@/lib/validation/selections": require("../lib/validation/selections"),
      "@/lib/services/context": { requireOrgContext: async () => context },
      "@/lib/services/permissions": { requirePermission: async permission => assert.equal(permission, "selections.read"), hasPermission: async permission => { assert.equal(permission, "financials.margin.read"); return margin } },
      "@/lib/land/paging": { readAllRowsById: async build => {
        const query = build(null, 500)
        return query.table === "house_plan_versions"
          ? [{ id: id(3), house_plan_id: id(4), version_number: 1, label: "Edition", plan: { name: "Fixture" } }]
          : [{ id: id(5), option_id: id(6), house_plan_version_id: id(3), community_id: null, price_cents: 100, cost_cents: 50, is_available: true }]
      } },
    }
    const code = ts.transpileModule(fs.readFileSync("lib/services/option-catalog.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    new Function("exports", "require", "process", code)(exports, name => modules[name] ?? {}, { env: {} })
    const result = await exports.listPlanPricingMatrix({ optionIds: [id(6)] })
    const columns = calls.find(call => call[0] === "selection_catalog_prices")[1]
    assert.equal(columns.split(",").includes("cost_cents"), margin)
    const cell = result.cells[`${id(6)}:${id(3)}`]
    assert.equal(Object.hasOwn(cell, "costCents"), margin)
    if (margin) assert.equal(cell.costCents, 50)
    assert.equal(cell.priceCents, 100)
    assert.ok(calls.some(call => call[0] === "eq" && call[1] === "org_id" && call[2] === context.orgId))
  }
})
