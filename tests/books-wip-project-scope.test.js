require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const { database } = require("./helpers/report-database")

test("close and recognition scope follows dated activity and contracts in force, not today's project lifecycle", async () => {
  const db = database({
    job_cost_entries: [
      { id: "cost", org_id: "org", project_id: "completed", status: "posted", incurred_on: "2026-09-30" },
      { id: "future", org_id: "org", project_id: "future", status: "posted", incurred_on: "2026-10-01" },
      { id: "draft", org_id: "org", project_id: "planning", status: "draft", incurred_on: "2026-09-30" },
      { id: "other", org_id: "other", project_id: "other-org", status: "posted", incurred_on: "2026-09-30" },
      { id: "closing", org_id: "org", project_id: "closing", status: "posted", incurred_on: "2026-09-30" },
    ],
    invoices: [
      { id: "voided-later", org_id: "org", project_id: "cancelled", status: "void", issue_date: "2026-09-15", metadata: { voided_at: "2026-10-01T00:00:00Z" } },
      { id: "deposit", org_id: "org", project_id: "deposit", status: "sent", issue_date: "2026-09-15", metadata: { invoice_kind: "earnest_deposit" } },
    ],
    journal_entries: [{ id: "prior", org_id: "org", source_id: "archived", source_type: "revenue_recognition", status: "reversed", entry_date: "2026-08-31" }],
  })
  // Which projects carry posted cost is answered by the database; its rules are
  // proven against the real function below.
  db.rpc = async (name, args) => {
    assert.equal(name, "books_projects_with_posted_cost")
    assert.equal(args.p_as_of, "2026-09-30")
    return { data: args.p_project_ids.filter(id => id === "completed"), error: null }
  }
  const projects = ["completed", "future", "planning", "other-org", "closing", "cancelled", "deposit", "archived"].map(projectId => ({ projectId, status: projectId, basis: projectId === "closing" ? "closing" : "percentage_of_completion", contractIds: projectId === "completed" ? ["c-1", "c-2"] : [],
    policies: projectId === "completed" ? { "c-1": { method: "percentage_of_completion" }, "c-2": { method: "percentage_of_completion" } } : { "": { method: projectId === "closing" ? "closing" : "percentage_of_completion" } } }))
  const original = Module._load
  let loadScope
  try {
    Module._load = function(name, ...args) {
      if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => db }
      if (name === "@/lib/services/books/revenue-basis") return { loadProjectRevenueBases: async (orgId, asOf) => {
        assert.equal(orgId, "org")
        assert.equal(asOf, "2026-09-30")
        return projects
      } }
      return original.call(this, name, ...args)
    }
    loadScope = require("../lib/services/books/wip-project-scope").loadWipScopesForPeriod
  } finally { Module._load = original }
  // A project with two contracts in force needs a position for each.
  assert.deepEqual((await loadScope("org", "2026-09-30")).map(row => [row.projectId, row.contractId]),
    [["completed", "c-1"], ["completed", "c-2"], ["cancelled", null], ["archived", null]])
})

test("projects with posted cost: posted (not voided) cost, on or before the date, this company only", async (t) => {
  const { createDatabase, insert, rpc, seedMember } = require("./support/pglite")
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const other = await seedMember(db)
  const project = async (orgId, name) => (await insert(db, "projects", { org_id: orgId, name })).id
  const [costed, future, voided, idle] = await Promise.all(["Costed", "Future", "Voided", "Idle"].map(name => project(owner.orgId, name)))
  const elsewhere = await project(other.orgId, "Other company")
  const cost = (orgId, projectId, status, incurredOn, sourceId) => insert(db, "job_cost_entries", {
    org_id: orgId, project_id: projectId, status, incurred_on: incurredOn, cost_cents: 1000, source_type: "project_expense", source_id: sourceId,
  })
  await cost(owner.orgId, costed, "posted", "2026-09-30", "a")
  await cost(owner.orgId, future, "posted", "2026-10-01", "b")
  await cost(owner.orgId, voided, "voided", "2026-09-30", "c")
  await cost(other.orgId, elsewhere, "posted", "2026-09-30", "d")
  const found = await rpc(db, "books_projects_with_posted_cost", { p_org_id: owner.orgId, p_as_of: "2026-09-30", p_project_ids: [costed, future, voided, idle, elsewhere] })
  assert.deepEqual(found.map(row => Object.values(row)[0]), [costed])
})
