import { wipSourcesCurrent } from "@/lib/services/books/wip-source-evidence"
import { collectBooksRows } from "@/lib/services/books/paging"
import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { loadPocProjectsForPeriod } from "@/lib/services/books/wip-project-scope"
import { loadPocPositionsAsOf } from "@/lib/services/poc"
import { wipSnapshotEvidence, assertReviewedWipUnchanged, type WipSnapshotEvidence } from "@/lib/services/books/wip-period-rules"
import { recordAudit } from "@/lib/services/audit"
import { pocRevenueAllocationSchema } from "@/lib/services/books/poc-revenue-allocations"

async function workspace(periodId: string) {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.close", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "accounting_period", resourceId: z.string().uuid().parse(periodId), logDecision: true })
  const service = createServiceSupabaseClient()
  const { data: period, error } = await service.from("accounting_periods").select("id,period_end,status").eq("org_id", context.orgId).eq("id", periodId).single()
  if (error || !period) throw new Error(`Failed to load accounting period: ${error?.message ?? "not found"}`)
  const projects = await loadPocProjectsForPeriod(context.orgId, period.period_end)
  const positions = await loadPocPositionsAsOf({ orgId: context.orgId, projectIds: projects.map(row => row.projectId), asOf: period.period_end })
  const snapshots = wipSnapshotEvidence(positions, projects.map(row => row.projectId))
  const missing = projects.filter(project => positions.get(project.projectId)?.asOf !== period.period_end).map(row => row.projectId)
  return { context, service, period, snapshots, missing, projects }
}
export async function getWipReviewWorkspace(periodId: string) {
  const { period, snapshots, missing, service, context, projects: scope } = await workspace(periodId)
  const projectNames: Record<string, string> = {}
  const details = []
  for (let start = 0; start < scope.length; start += 200) {
    const slice = scope.slice(start, start + 200)
    const snapshotIds = snapshots.filter(row => slice.some(project => project.projectId === row.projectId)).map(row => row.snapshotId)
    const [projects, inputs] = await Promise.all([
      collectBooksRows((from,to) => service.from("projects").select("id,name").eq("org_id", context.orgId).in("id", slice.map(row => row.projectId)).order("id").range(from,to)),
      collectBooksRows((from,to) => service.from("poc_snapshots").select("id,project_id,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,billed_cents,forecast_gross_profit_cents,preparation,revenue_allocations")
        .eq("org_id", context.orgId).in("id", snapshotIds).order("id").range(from,to)),
    ])
    for (const project of projects) projectNames[project.id] = project.name
    details.push(...inputs.map(row => {
      const { preparation, revenue_allocations, ...financials } = row
      const evidence = preparation && typeof preparation === "object" && !Array.isArray(preparation) ? preparation as Record<string, unknown> : {}
      return { ...financials, revenueAllocationRequired: evidence.revenueAllocationRequired === true && (revenue_allocations ?? []).length === 0, revenueAllocations: z.array(pocRevenueAllocationSchema).parse(revenue_allocations ?? []), revenueAllocationNote: typeof evidence.revenueAllocationNote === "string" ? evidence.revenueAllocationNote : null, preparationNote: typeof evidence.note === "string" ? evidence.note : null, preparedAt: typeof evidence.preparedAt === "string" ? evidence.preparedAt : null }
    }))
  }
  const [incomeAccounts, costCodes, contracts] = await Promise.all([
    collectBooksRows((from,to) => service.from("gl_accounts").select("id,code,name").eq("org_id",context.orgId).eq("account_type","income").eq("active",true).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("cost_codes").select("id,code,name").eq("org_id",context.orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("contracts").select("id,project_id,title,parent_contract_id,status").eq("org_id",context.orgId).in("status",["active","amended","completed","terminated"]).order("id").range(from,to)),
  ])
  return { periodEnd: period.period_end, snapshots, missing, projectNames, details, incomeAccounts, costCodes, contracts: contracts.filter(row => row.parent_contract_id == null), projectIds: scope.map(row => row.projectId), completedProjectIds: scope.filter(row => row.status === "completed").map(row => row.projectId), sourcesCurrent: await wipSourcesCurrent(service, context.orgId, snapshots.map(row => row.snapshotId)) }

}

export async function allocateWipRevenue(input: { periodId: string; snapshotId: string; allocations: Array<{ account_id: string; contract_cents: number; contract_id?: string | null; cost_code_id?: string | null }>; note: string }) {
  const parsed = z.object({ periodId: z.string().uuid(), snapshotId: z.string().uuid(), allocations: z.array(pocRevenueAllocationSchema.omit({ account_code: true })).min(1).max(100), note: z.string().trim().min(10).max(4000) }).parse(input)
  const { context, service, period, snapshots } = await workspace(parsed.periodId)
  if (!snapshots.some(row => row.snapshotId === parsed.snapshotId && row.asOf === period.period_end)) throw new Error("Reload the exact period-end WIP snapshot before allocating revenue")
  const { data, error } = await service.rpc("allocate_books_wip_revenue_atomic", { p_org_id: context.orgId, p_period_id: period.id, p_snapshot_id: parsed.snapshotId, p_actor_id: context.userId, p_allocations: parsed.allocations, p_note: parsed.note })
  if (error) throw new Error(`Failed to allocate WIP revenue: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "poc_snapshot", entityId: String(data), after: { periodId: period.id, sourceSnapshotId: parsed.snapshotId, allocations: parsed.allocations, note: parsed.note }, source: "books.wip_revenue_allocation" })
  return { snapshotId: String(data) }
}
export async function reviewWipSnapshots(input: { periodId: string; snapshots: WipSnapshotEvidence[]; note: string }) {
  const note = z.string().trim().min(10).max(4000).parse(input.note)
  const { context, service, period, snapshots, missing } = await workspace(input.periodId)
  if (missing.length) throw new Error("Capture and review an exact period-end WIP position for every project")
  assertReviewedWipUnchanged(input.snapshots, snapshots)
  const { data, error } = await service.rpc("review_books_wip_atomic", { p_org_id: context.orgId, p_period_id: period.id, p_actor_id: context.userId, p_review: { snapshots, note } })
  if (error) throw new Error(`Failed to approve WIP review: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "accounting_period", entityId: period.id, after: data, source: "books.wip_review" })
  return { reviewed: true }
}

export async function prepareWipSnapshot(input: { periodId: string; projectId: string; originalContractCents: number; approvedChangeOrdersCents: number; eacCents: number; note: string }) {
  const parsed = z.object({ periodId: z.string().uuid(), projectId: z.string().uuid(), originalContractCents: z.number().int().safe().nonnegative(), approvedChangeOrdersCents: z.number().int().safe(), eacCents: z.number().int().safe().positive(), note: z.string().trim().min(10).max(4000) }).parse(input)
  const { context, service, period, projects } = await workspace(parsed.periodId)
  if (!projects.some(project => project.projectId === parsed.projectId)) throw new Error("Project has no POC activity in this accounting period")
  const { data, error } = await service.rpc("prepare_books_wip_atomic", { p_org_id: context.orgId, p_period_id: period.id, p_project_id: parsed.projectId, p_actor_id: context.userId, p_original_cents: parsed.originalContractCents, p_change_orders_cents: parsed.approvedChangeOrdersCents, p_eac_cents: parsed.eacCents, p_note: parsed.note })
  if (error) throw new Error(`Failed to prepare WIP: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "poc_snapshot", entityId: String(data), after: { periodId: period.id, projectId: parsed.projectId, note: parsed.note }, source: "books.wip_preparation" })
  return { snapshotId: String(data) }
}

export async function carryForwardWipSnapshot(input: { periodId: string; projectId: string; note: string }) {
  const parsed = z.object({ periodId: z.string().uuid(), projectId: z.string().uuid(), note: z.string().trim().min(10).max(3500) }).parse(input)
  const { context, service, period, projects } = await workspace(parsed.periodId)
  if (!projects.some(project => project.projectId === parsed.projectId)) throw new Error("Project has no POC activity in this period")
  const { data, error } = await service.rpc("carry_forward_books_wip_atomic", { p_org_id: context.orgId, p_period_id: period.id, p_project_id: parsed.projectId, p_actor_id: context.userId, p_note: parsed.note })
  if (error) throw new Error(`Failed to carry WIP forward: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "poc_snapshot", entityId: String(data), after: { periodId: period.id, projectId: parsed.projectId, note: parsed.note }, source: "books.wip_carryforward" })
  return { snapshotId: String(data) }
}
