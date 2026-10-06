const assert = require("node:assert/strict")
const test = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")
const { stubModule, freshRequire } = require("./support/modules")

const ORG = "00000000-0000-4000-8000-000000000401"
const USER = "00000000-0000-4000-8000-000000000402"
const APPROVABLE = "00000000-0000-4000-8000-000000000403"
const BILLABLE = "00000000-0000-4000-8000-000000000404"
const ELSEWHERE = "00000000-0000-4000-8000-000000000405"

/** Org-wide grants, plus per-project grants for the review queue. */
const member = { permissions: [], projectGrants: {} }

stubModule("@/lib/services/permissions", {
  hasPermission: async (permission) => member.permissions.includes(permission),
})
stubModule("@/lib/services/authorization", {
  authorizeMany: async ({ permission, projectIds }) =>
    new Map(projectIds.map((projectId) => [projectId, (member.projectGrants[projectId] ?? []).includes(permission)])),
})
stubModule("lib/services/precon-deals.ts", {
  listPipelineDeals: async () => ({ deals: [{ ball: "you" }, { ball: "you" }, { ball: "them" }] }),
})

const { runWithServiceOrgContext } = freshRequire("lib/services/context.ts")
const { getNavigationBadgeCounts } = freshRequire("lib/services/navigation-badges.ts")

function counts() {
  const supabase = createFakeSupabase({
    time_entries: [
      { org_id: ORG, project_id: APPROVABLE, status: "submitted" },
      { org_id: ORG, project_id: BILLABLE, status: "pm_approved" },
      { org_id: ORG, project_id: ELSEWHERE, status: "submitted" },
    ],
    vendor_bills: [{ org_id: ORG, project_id: ELSEWHERE, status: "pending" }],
    draw_schedules: [{ org_id: ORG, project_id: BILLABLE, status: "pending", due_date: "2026-01-01" }],
    project_emails: [{ org_id: ORG, project_id: APPROVABLE, archived_at: null, classified_by: "ai" }],
    task_assignments: [],
  })
  return runWithServiceOrgContext({ supabase, orgId: ORG, userId: USER, productTier: "residential" }, () =>
    getNavigationBadgeCounts(),
  )
}

test.beforeEach(() => {
  member.permissions = []
  member.projectGrants = {}
})

test("review counts include only projects where the member can act on the queue", async () => {
  member.projectGrants = { [APPROVABLE]: ["bill.approve"], [BILLABLE]: ["invoice.write"] }

  const badges = await counts()

  assert.deepEqual(badges.projectReviewBadgeCounts, { [APPROVABLE]: 1, [BILLABLE]: 1 })
  assert.equal(badges.myWorkBadgeCount, 2)
})

test("a member without invoice, pipeline or correspondence access sees none of those counts", async () => {
  const badges = await counts()

  assert.deepEqual(badges, {
    pipelineBadgeCount: 0,
    myWorkBadgeCount: 0,
    readyToBillBadgeCount: 0,
    projectReviewBadgeCounts: {},
    projectCorrespondenceBadgeCounts: {},
  })
})

test("each grant opens only its own count", async () => {
  member.permissions = ["invoice.read", "pipeline.read", "correspondence.read"]

  const badges = await counts()

  assert.equal(badges.readyToBillBadgeCount, 1)
  assert.equal(badges.pipelineBadgeCount, 2)
  assert.deepEqual(badges.projectCorrespondenceBadgeCounts, { [APPROVABLE]: 1 })
  assert.deepEqual(badges.projectReviewBadgeCounts, {})
})
