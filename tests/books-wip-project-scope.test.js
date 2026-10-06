require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const { database } = require("./helpers/report-database")

test("close and recognition scope follows dated activity, not today's project lifecycle", async () => {
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
  const projects = ["completed", "future", "planning", "other-org", "closing", "cancelled", "deposit", "archived"].map(projectId => ({ projectId, status: projectId, basis: projectId === "closing" ? "closing" : "percentage_of_completion" }))
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
    loadScope = require("../lib/services/books/wip-project-scope").loadPocProjectsForPeriod
  } finally { Module._load = original }
  assert.deepEqual((await loadScope("org", "2026-09-30")).map(row => row.projectId), ["completed", "cancelled", "archived"])
})
