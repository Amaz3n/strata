import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import {
  getProjectFinancialReviewBreakdown,
  type ProjectReviewBreakdown,
} from "@/lib/services/navigation-badges"

export interface MyWorkApproval {
  projectId: string
  projectName: string
  count: number
  /** Per-category counts so a row can say *what* is waiting, not just how many. */
  breakdown: Omit<ProjectReviewBreakdown, "total">
  href: string
}

export interface MyApprovalsData {
  approvals: MyWorkApproval[]
  approvalTotal: number
}

async function loadProjectNames(ctx: OrgServiceContext, projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, string>()

  const { data, error } = await ctx.supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", ctx.orgId)
    .in("id", projectIds)

  if (error) return new Map<string, string>()
  return new Map((data ?? []).map((project: any) => [project.id as string, String(project.name ?? "Untitled project")]))
}

/**
 * Financial review items (time, expenses, bills, ready-to-post costs) waiting on
 * the current user across every project they approve for. Surfaced as a band on
 * the Tasks page so approvals and tasks share one personal hub.
 */
export async function loadMyApprovals(): Promise<MyApprovalsData> {
  const ctx = await requireOrgContext()
  const reviewBreakdown = await getProjectFinancialReviewBreakdown(ctx)
  const projectIds = Object.keys(reviewBreakdown)
  const projectNames = await loadProjectNames(ctx, projectIds)

  const approvals: MyWorkApproval[] = projectIds
    .map((projectId) => {
      const entry = reviewBreakdown[projectId]
      return {
        projectId,
        projectName: projectNames.get(projectId) ?? "Project",
        count: entry.total,
        breakdown: { time: entry.time, expenses: entry.expenses, bills: entry.bills, costs: entry.costs },
        href: `/projects/${projectId}/financials/review`,
      }
    })
    .filter((approval) => approval.count > 0)
    .sort((a, b) => b.count - a.count || a.projectName.localeCompare(b.projectName))

  const approvalTotal = approvals.reduce((sum, approval) => sum + approval.count, 0)

  return { approvals, approvalTotal }
}
