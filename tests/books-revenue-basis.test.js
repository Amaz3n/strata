require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const { resolveProjectRevenueBasis } = require("../lib/financials/project-revenue-basis")

const project = { id: "project", status: "active", property_type: "production" }
const contract = (overrides = {}) => ({
  id: "contract", project_id: "project", status: "active", parent_contract_id: null,
  effective_date: "2026-01-01", contract_type: "purchase_agreement", ...overrides,
})

test("draft, superseded, child and future contracts cannot reroute earned revenue", () => {
  const primary = contract()
  const ignored = [
    contract({ id: "draft", status: "draft", contract_type: "fixed_price" }),
    contract({ id: "old", status: "superseded", contract_type: "fixed_price" }),
    contract({ id: "amendment", parent_contract_id: primary.id, contract_type: "fixed_price" }),
    contract({ id: "future", effective_date: "2026-10-01", contract_type: "fixed_price" }),
    contract({ id: "other-project", project_id: "other", contract_type: "fixed_price" }),
  ]
  for (const rows of [[primary, ...ignored], [...ignored.reverse(), primary]]) {
    assert.equal(resolveProjectRevenueBasis(project, rows, "2026-09-30"), "closing")
  }
  for (const status of ["amended", "completed", "terminated"]) {
    assert.equal(resolveProjectRevenueBasis(project, [contract({ status })], "2026-09-30"), "closing")
  }
})

test("conflicting primary postures block instead of depending on contract order", () => {
  const rows = [contract(), contract({ id: "build", contract_type: "fixed_price" })]
  for (const ordered of [rows, [...rows].reverse()]) {
    assert.throws(() => resolveProjectRevenueBasis(project, ordered, "2026-09-30"), /Project project has conflicting primary contract revenue bases/)
  }
  assert.equal(resolveProjectRevenueBasis(project, [contract(), contract({ id: "second-sale" })], "2026-09-30"), "closing")
  assert.equal(resolveProjectRevenueBasis(project, [], "2026-09-30"), "percentage_of_completion")
  assert.equal(resolveProjectRevenueBasis(project, [contract({ status: "draft" })], "2026-09-30"), "percentage_of_completion")
  assert.equal(resolveProjectRevenueBasis({ ...project, financial_settings: { billing_model: "time_and_materials" } }, [contract()], "2026-09-30"), "percentage_of_completion")
  assert.throws(() => resolveProjectRevenueBasis(project, [contract(), contract({ id: "later", effective_date: "2026-10-01", contract_type: "fixed_price" })], "2026-10-31"), /conflicting/)
})

test("superseded historical evidence cannot silently fall back to POC", () => {
  const old = contract({ status: "superseded" })
  const replacement = contract({ id: "replacement", effective_date: "2026-10-01" })
  assert.throws(() => resolveProjectRevenueBasis(project, [old, replacement], "2026-09-30"), /Historical revenue-policy evidence is required/)
  assert.equal(resolveProjectRevenueBasis(project, [old, replacement], "2026-10-31"), "closing")
})

test("paged revenue basis reads every primary contract and applies the accounting cutoff", async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => contract({ id: `draft-${index}`, status: "draft", contract_type: "fixed_price" }))
  rows.splice(500, 0, contract())
  rows.push(contract({ id: "future", effective_date: "2026-10-01", contract_type: "fixed_price" }))
  const pages = []
  const service = { from(table) {
    let selected, scoped = false, from, to
    const q = {
      select(value) { selected = value; return q },
      eq(key, value) { assert.equal(key, "org_id"); assert.equal(value, "org"); scoped = true; return q },
      order(key) { assert.equal(key, table === "project_financial_settings" ? "project_id" : "id"); return q },
      range(first, last) { from = first; to = last; return q },
      then(resolve) {
        assert.ok(scoped)
        if (table === "contracts") {
          for (const field of ["id", "status", "parent_contract_id", "effective_date"]) assert.ok(selected.includes(field))
          pages.push(from)
        }
        const data = table === "projects" ? [project] : table === "contracts" ? rows : []
        return Promise.resolve({ data: data.slice(from, to + 1), error: null }).then(resolve)
      },
    }
    return q
  } }
  const original = Module._load
  let load
  try {
    Module._load = function(name, ...args) {
      if (name === "server-only") return {}
      if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => service }
      return original.call(this, name, ...args)
    }
    load = require("../lib/services/books/revenue-basis").loadProjectRevenueBases
  } finally { Module._load = original }
  assert.deepEqual(await load("org", "2026-09-30"), [{ projectId: "project", status: "active", basis: "closing" }])
  assert.deepEqual(pages, [0, 500, 1000])
  await assert.rejects(load("org", "2026-10-31"), /conflicting primary contract/)
})
