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
  let policies = []
  const service = { from(table) {
    let selected, scoped = false, from, to
    const q = {
      select(value) { selected = value; return q },
      eq(key, value) { assert.equal(key, "org_id"); assert.equal(value, "org"); scoped = true; return q },
      in() { return q },
      order(key) { assert.equal(key, table === "project_financial_settings" ? "project_id" : "id"); return q },
      range(first, last) { from = first; to = last; return q },
      then(resolve) {
        assert.ok(scoped)
        if (table === "contracts") {
          for (const field of ["id", "status", "parent_contract_id", "effective_date"]) assert.ok(selected.includes(field))
          pages.push(from)
        }
        const data = table === "projects" ? [project] : table === "contracts" ? rows : table === "books_revenue_policies" ? policies : []
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
  // The one contract in force by the cutoff; later and draft contracts are not.
  // No policy is recorded yet, so it is inferred from the purchase agreement.
  assert.deepEqual(await load("org", "2026-09-30"), [{ projectId: "project", status: "active", basis: "closing", contractIds: ["contract"],
    policies: { "": { method: "closing", billingMethod: "purchase_agreement", source: "unrecorded", policyId: null } } }])
  assert.deepEqual(pages, [0, 500, 1000])
  // In October a fixed-price contract earning over time joins the sale: unreviewed, that is refused.
  await assert.rejects(load("org", "2026-10-31"), /contracts that earn revenue differently .* Approve a revenue policy for each of its contracts/)
  // Approved per contract, the job earns each way and has no single method.
  const approved = (id, contractId, method, billing) => ({ id: `0000000${id}-0000-4000-8000-000000000000`, project_id: "project", contract_id: contractId, method, billing_method: billing, effective_from: "2026-01-01", status: "approved", reviewed_at: "2026-09-01T00:00:00Z" })
  policies = [approved(1, "contract", "closing", "purchase_agreement"), approved(2, "future", "percentage_of_completion", "fixed_price")]
  const mixed = (await load("org", "2026-10-31"))[0]
  assert.equal(mixed.basis, null)
  assert.deepEqual(Object.fromEntries(Object.entries(mixed.policies).map(([id, policy]) => [id, [policy.method, policy.source]])), { contract: ["closing", "approved"], future: ["percentage_of_completion", "approved"] })
})

test("the policy in force: approved by its date before inferred, a contract's before its project's", () => {
  const { policyInForce } = require("../lib/financials/revenue-policy")
  const row = (id, contract_id, method, status, effective_from = "1900-01-01", reviewed_at = status === "approved" ? "2026-01-01T00:00:00Z" : null) =>
    ({ id, project_id: "p", contract_id, method, billing_method: "fixed_price", effective_from, status, reviewed_at })
  const inferredProject = row("a", null, "percentage_of_completion", "inferred")
  const inferredContract = row("b", "k", "closing", "inferred")
  const approvedProject = row("c", null, "closing", "approved", "2026-08-01")
  const approvedContract = row("d", "k", "percentage_of_completion", "approved", "2026-09-01")
  const records = [inferredProject, inferredContract, approvedProject, approvedContract]
  assert.equal(policyInForce(records, "p", null, "2026-07-31").id, "a")
  assert.equal(policyInForce(records, "p", null, "2026-08-01").id, "c")
  assert.equal(policyInForce(records, "p", "k", "2026-07-31").id, "b")
  assert.equal(policyInForce(records, "p", "k", "2026-08-15").id, "c")
  assert.equal(policyInForce(records, "p", "k", "2026-09-30").id, "d")
  // A later approval of the same scope replaces an earlier one only from its own date.
  const later = row("e", null, "percentage_of_completion", "approved", "2026-10-01")
  assert.equal(policyInForce([...records, later], "p", null, "2026-09-30").id, "c")
  assert.equal(policyInForce([...records, later], "p", null, "2026-10-01").id, "e")
  assert.equal(policyInForce(records, "other", null, "2026-09-30"), null)
})
